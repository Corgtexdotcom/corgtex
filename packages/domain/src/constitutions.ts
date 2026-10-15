import { createHash } from "node:crypto";
import type { Prisma } from "@prisma/client";
import { prisma } from "@corgtex/shared";
import type { AppActor } from "@corgtex/shared";
import { requireWorkspaceMembership } from "./auth";
import { invariant } from "./errors";
import { DigestReadRelease } from "./digest-lineage";
import { captureArtifactInputProof, invalidateArtifactInputLineage, readableArtifactIds, recordArtifactInputLineage } from "./source-lineage";
import { finishProducerLineage, prepareProducerLineage, type ProducerLineageParams } from "./producer-lineage";

const CONSTITUTION_VERSION_RETRY_LIMIT = 3;
const INVALID_SOURCE_MESSAGE = "Invalid Constitution source reference.";

export type ConstitutionSourceReferenceInput = {
  pointOrder: number;
  sourceOrder: number;
  policyCorpusId: string;
  sourceKind: "PROPOSAL" | "TENSION";
  proposalId?: string;
  tensionId?: string;
};

const CONSTITUTION_CORPUS_SELECT = {
  id: true,
  title: true,
  bodyMd: true,
  acceptedAt: true,
} as const satisfies Prisma.PolicyCorpusSelect;

export type ConstitutionCorpusFingerprintRow = Prisma.PolicyCorpusGetPayload<{
  select: typeof CONSTITUTION_CORPUS_SELECT;
}>;

type ConstitutionCorpusClient = Prisma.TransactionClient | typeof prisma;

function canonicalizeFingerprintValue(value: unknown): unknown {
  if (value instanceof Date) return value.toISOString();
  if (Array.isArray(value)) {
    return value
      .map(canonicalizeFingerprintValue)
      .sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b)));
  }
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.entries(value)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([key, entry]) => [key, canonicalizeFingerprintValue(entry)]));
  }
  return value;
}

export function fingerprintConstitutionCorpus(corpus: readonly ConstitutionCorpusFingerprintRow[]) {
  const projected = corpus.map((policy) => ({
    id: policy.id,
    title: policy.title,
    bodyMd: policy.bodyMd,
    acceptedAt: policy.acceptedAt,
  }));
  return createHash("sha256")
    .update(JSON.stringify(canonicalizeFingerprintValue(projected)))
    .digest("hex");
}

export async function loadConstitutionCorpusSnapshot(actor: AppActor, client: ConstitutionCorpusClient, workspaceId: string) {
  await requireWorkspaceMembership({ actor, workspaceId });
  const rows = await client.policyCorpus.findMany({ where: { workspaceId } });
  const readable = await readableArtifactIds(actor, workspaceId, "PolicyCorpus", rows, client);
  const corpus = rows.filter((policy) => readable.has(policy.id))
    .sort((left, right) => left.acceptedAt.getTime() - right.acceptedAt.getTime() || left.id.localeCompare(right.id));
  return { corpus, fingerprint: fingerprintConstitutionCorpus(corpus) };
}

export async function acquireConstitutionCorpusAdvisoryLock(
  tx: Pick<Prisma.TransactionClient, "$executeRaw">,
  workspaceId: string,
) {
  await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext('constitution_corpus'), hashtext(${workspaceId}))`;
}

async function resolveSourceReferences(
  tx: Prisma.TransactionClient,
  workspaceId: string,
  references: readonly ConstitutionSourceReferenceInput[],
  actor?: AppActor,
) {
  const policyIds = [...new Set(references.map((reference) => reference.policyCorpusId))];
  const policies = await tx.policyCorpus.findMany({
    where: { workspaceId, id: { in: policyIds } },
    include: {
      proposal: {
        include: {
          tensions: {
            where: { workspaceId, isPrivate: false, publishedAt: { not: null }, archivedAt: null },
          },
        },
      },
    },
  });
  const readablePolicies = actor ? await readableArtifactIds(actor, workspaceId, "PolicyCorpus", policies, tx) : null;
  const readableProposals = actor ? await readableArtifactIds(actor, workspaceId, "Proposal", policies.map((policy) => policy.proposal), tx) : null;
  const readableTensions = actor ? await readableArtifactIds(actor, workspaceId, "Tension", policies.flatMap((policy) => policy.proposal.tensions), tx) : null;
  const policiesById = new Map(policies.map((policy) => [policy.id, policy]));
  const orders = new Set<string>();
  const targets = new Set<string>();

  return references.map((reference) => {
    const policy = policiesById.get(reference.policyCorpusId);
    const validPoint = Number.isInteger(reference.pointOrder)
      && reference.pointOrder >= 1 && reference.pointOrder <= 10;
    const validOrder = Number.isInteger(reference.sourceOrder) && reference.sourceOrder >= 1;
    const policyProposalEligible = policy?.proposal.workspaceId === workspaceId
      && !policy.proposal.isPrivate && policy.proposal.publishedAt != null;
    const proposalSource = reference.sourceKind === "PROPOSAL"
      && (reference.proposalId === undefined || reference.proposalId === policy?.proposal.id)
      && !reference.tensionId
      && policyProposalEligible;
    const tension = reference.sourceKind === "TENSION" && !reference.proposalId && policyProposalEligible
      ? policy?.proposal.tensions.find((candidate) => candidate.id === reference.tensionId)
      : undefined;
    const labelSnapshot = proposalSource ? policy?.proposal.title : tension?.title;
    const orderKey = `${reference.pointOrder}:${reference.sourceOrder}`;
    const targetKey = `${reference.pointOrder}:${reference.policyCorpusId}:${reference.sourceKind}:${reference.proposalId ?? reference.tensionId}`;

    if (!policy || !validPoint || !validOrder || !labelSnapshot?.trim()
      || (readablePolicies && !readablePolicies.has(policy.id))
      || (proposalSource && readableProposals && !readableProposals.has(policy.proposal.id))
      || (tension && readableTensions && !readableTensions.has(tension.id))
      || orders.has(orderKey) || targets.has(targetKey)) {
      throw new Error(INVALID_SOURCE_MESSAGE);
    }
    orders.add(orderKey);
    targets.add(targetKey);

    return { inputs: [
      { kind: "PolicyCorpus" as const, id: policy.id, snapshot: policy },
      proposalSource ? { kind: "Proposal" as const, id: policy.proposal.id, snapshot: policy.proposal }
        : { kind: "Tension" as const, id: tension!.id, snapshot: tension! },
    ], data: {
      pointKey: `point-${reference.pointOrder}`,
      pointOrder: reference.pointOrder,
      sourceOrder: reference.sourceOrder,
      policyCorpusId: policy.id,
      sourceKind: reference.sourceKind,
      proposalId: proposalSource ? policy.proposal.id : null,
      tensionId: tension?.id ?? null,
      labelSnapshot,
      acceptedAtSnapshot: policy.acceptedAt,
    } };
  });
}

function isConstitutionVersionConflict(error: unknown) {
  if (!error || typeof error !== "object") {
    return false;
  }

  const prismaError = error as {
    code?: string;
    meta?: {
      target?: string[] | string;
    };
  };

  if (prismaError.code === "P2034") return true;
  if (prismaError.code !== "P2002") {
    return false;
  }

  const target = prismaError.meta?.target;
  if (Array.isArray(target)) {
    return target.includes("workspaceId") && target.includes("version");
  }

  return typeof target !== "string" || target.includes("workspaceId") || target.includes("version");
}

export async function listConstitutionVersions(actor: AppActor, workspaceId: string, opts?: {
  take?: number;
  skip?: number;
}) {
  await requireWorkspaceMembership({ actor, workspaceId });
  const take = opts?.take ?? 20;
  const skip = opts?.skip ?? 0;

  const rows = await prisma.constitution.findMany({ where: { workspaceId } });
  const readable = await readableArtifactIds(actor, workspaceId, "Constitution", rows);
  const visible = rows.filter((row) => readable.has(row.id)).sort((left, right) => right.version - left.version);
  return { items: visible.slice(skip, skip + take), total: visible.length, take, skip };
}

export async function getCurrentConstitution(actor: AppActor, workspaceId: string) {
  await requireWorkspaceMembership({ actor, workspaceId });
  const release = new DigestReadRelease(actor, workspaceId);
  let after: { version: number; id: string } | undefined;
  // Current reads do not need the history endpoint's exact readable total.
  // Replenish denied pages without imposing a maximum history length.
  while (true) {
    const rows = await prisma.constitution.findMany({
      where: { workspaceId, ...(after ? { OR: [
        { version: { lt: after.version } }, { version: after.version, id: { lt: after.id } },
      ] } : {}) },
      orderBy: [{ version: "desc" }, { id: "desc" }], take: 100,
    });
    for (const row of rows) {
      const captured = await release.capture("Constitution", [row]);
      if (captured.records.length) return release.finish(captured.records[0]);
    }
    if (rows.length < 100) return release.finish(null);
    const last = rows[rows.length - 1]!;
    after = { version: last.version, id: last.id };
  }
}

export async function createConstitutionVersion(params: ProducerLineageParams & {
  lineageActor?: AppActor;
  workspaceId: string;
  bodyMd: string;
  diffSummary?: string | null;
  triggerType?: string | null;
  triggerRef?: string | null;
  modelUsed: string;
  promptTokens?: number | null;
  completionTokens?: number | null;
  references?: readonly ConstitutionSourceReferenceInput[];
  expectedCorpusFingerprint?: string | null;
}) {
  if (params.lineageActor) await requireWorkspaceMembership({ actor: params.lineageActor, workspaceId: params.workspaceId });
  for (let attempt = 0; attempt < CONSTITUTION_VERSION_RETRY_LIMIT; attempt += 1) {
    try {
      return await prisma.$transaction(async (tx) => {
        await acquireConstitutionCorpusAdvisoryLock(tx, params.workspaceId);
        if (params.expectedCorpusFingerprint != null) {
          const snapshot = params.lineageActor
            ? await loadConstitutionCorpusSnapshot(params.lineageActor, tx, params.workspaceId)
            : { fingerprint: fingerprintConstitutionCorpus(await tx.policyCorpus.findMany({ where: { workspaceId: params.workspaceId }, select: CONSTITUTION_CORPUS_SELECT })) };
          if (snapshot.fingerprint !== params.expectedCorpusFingerprint) {
            throw new Error("Constitution policy corpus changed during synthesis.");
          }
        }
        const sourceReferences = params.references === undefined
          ? undefined
          : await resolveSourceReferences(tx, params.workspaceId, params.references, params.lineageActor);
        const latest = await tx.constitution.findFirst({
          where: { workspaceId: params.workspaceId },
          orderBy: { version: "desc" },
        });

        if (params.lineageActor && params.lineageRoots?.length) {
          // Captured roots attest every model input, while citations only govern display.
          await captureArtifactInputProof(params.lineageActor, params.workspaceId, params.lineageInputs ?? [], tx);
        }
        const constitution = await tx.constitution.create({
          data: {
            workspaceId: params.workspaceId,
            version: (latest?.version ?? 0) + 1,
            bodyMd: params.bodyMd,
            diffSummary: params.diffSummary ?? null,
            triggerType: params.triggerType ?? null,
            triggerRef: params.triggerRef ?? null,
            modelUsed: params.modelUsed,
            promptTokens: params.promptTokens ?? null,
            completionTokens: params.completionTokens ?? null,
            ...(sourceReferences?.length ? { sourceReferences: { create: sourceReferences.map((reference) => reference.data) } } : {}),
          },
          include: { sourceReferences: true },
        });
        if (params.lineageActor && params.lineageRoots?.length) {
          await recordArtifactInputLineage({ tx, actor: params.lineageActor, workspaceId: params.workspaceId,
            artifact: { kind: "Constitution", id: constitution.id }, content: constitution, origin: "DERIVED",
            inputs: params.lineageInputs ?? [], inheritedRoots: params.lineageRoots, transitiveOnlyKinds: ["Constitution"] });
        } else {
          await invalidateArtifactInputLineage({ tx, workspaceId: params.workspaceId,
            artifact: { kind: "Constitution", id: constitution.id }, content: constitution });
        }
        for (const reference of constitution.sourceReferences) {
          if (!params.lineageActor) {
            await invalidateArtifactInputLineage({ tx, workspaceId: params.workspaceId,
              artifact: { kind: "ConstitutionSourceReference", id: reference.id }, content: reference });
            continue;
          }
          const source = sourceReferences!.find((candidate) => candidate.data.pointOrder === reference.pointOrder
            && candidate.data.sourceOrder === reference.sourceOrder)!;
          const receipt = await prepareProducerLineage({ tx, actor: params.lineageActor, workspaceId: params.workspaceId,
            copied: true, completeCopy: true, dependencies: [
              { kind: "Constitution", id: constitution.id, snapshot: constitution }, ...source.inputs,
            ] });
          await finishProducerLineage({ tx, actor: params.lineageActor, workspaceId: params.workspaceId,
            artifact: { kind: "ConstitutionSourceReference", id: reference.id }, content: reference, receipt });
        }
        if (!params.lineageActor || !(await readableArtifactIds(params.lineageActor, params.workspaceId, "Constitution", [constitution], tx)).has(constitution.id)) {
          return { id: constitution.id, version: constitution.version, contentWithheld: true as const };
        }
        const visibleReferences = await readableArtifactIds(params.lineageActor, params.workspaceId, "ConstitutionSourceReference", constitution.sourceReferences, tx);
        return { ...constitution, sourceReferences: constitution.sourceReferences.filter((reference) => visibleReferences.has(reference.id)) };
      }, { isolationLevel: "ReadCommitted" });
    } catch (error) {
      if (attempt === CONSTITUTION_VERSION_RETRY_LIMIT - 1 || !isConstitutionVersionConflict(error)) {
        throw error;
      }
    }
  }

  throw new Error("Failed to create constitution version.");
}

export async function listPolicyCorpus(actor: AppActor, workspaceId: string) {
  await requireWorkspaceMembership({ actor, workspaceId });

  const policies = await prisma.policyCorpus.findMany({ where: { workspaceId }, include: { proposal: true, circle: true } });
  const readable = await readableArtifactIds(actor, workspaceId, "PolicyCorpus", policies);
  const visible = policies.filter((policy) => readable.has(policy.id));
  const readableProposals = await readableArtifactIds(actor, workspaceId, "Proposal", visible.map((policy) => policy.proposal));
  const readableCircles = await readableArtifactIds(actor, workspaceId, "Circle", visible.flatMap((policy) => policy.circle ? [policy.circle] : []));
  return visible.sort((left, right) => right.acceptedAt.getTime() - left.acceptedAt.getTime()).map((policy) => ({ ...policy,
    proposalId: readableProposals.has(policy.proposalId) ? policy.proposalId : null,
    proposal: readableProposals.has(policy.proposalId) ? { id: policy.proposal.id, title: policy.proposal.title, status: policy.proposal.status } : null,
    circleId: policy.circleId && readableCircles.has(policy.circleId) ? policy.circleId : null,
    circle: policy.circle && readableCircles.has(policy.circle.id) ? { id: policy.circle.id, name: policy.circle.name } : null,
  }));
}

export async function getApprovalPolicies(actor: AppActor, workspaceId: string) {
  await requireWorkspaceMembership({ actor, workspaceId });

  return prisma.approvalPolicy.findMany({
    where: { workspaceId },
    orderBy: { subjectType: "asc" },
  });
}

export async function updateApprovalPolicy(actor: AppActor, params: {
  workspaceId: string;
  subjectType: string;
  mode?: string;
  quorumPercent?: number;
  minApproverCount?: number;
  decisionWindowHours?: number;
  requireProposalLink?: boolean;
}) {
  await requireWorkspaceMembership({
    actor,
    workspaceId: params.workspaceId,
    allowedRoles: ["FACILITATOR", "ADMIN"],
  });

  const policy = await prisma.approvalPolicy.findUnique({
    where: {
      workspaceId_subjectType: {
        workspaceId: params.workspaceId,
        subjectType: params.subjectType,
      },
    },
  });
  invariant(policy, 404, "NOT_FOUND", "Approval policy not found.");

  const data: Record<string, unknown> = {};
  if (params.mode !== undefined) data.mode = params.mode;
  if (params.quorumPercent !== undefined) data.quorumPercent = params.quorumPercent;
  if (params.minApproverCount !== undefined) data.minApproverCount = params.minApproverCount;
  if (params.decisionWindowHours !== undefined) data.decisionWindowHours = params.decisionWindowHours;
  if (params.requireProposalLink !== undefined) data.requireProposalLink = params.requireProposalLink;

  return prisma.approvalPolicy.update({
    where: { id: policy.id },
    data,
  });
}
