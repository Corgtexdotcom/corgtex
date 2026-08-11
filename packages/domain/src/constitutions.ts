import { createHash } from "node:crypto";
import type { Prisma } from "@prisma/client";
import { prisma } from "@corgtex/shared";
import type { AppActor } from "@corgtex/shared";
import { requireWorkspaceMembership } from "./auth";
import { invariant } from "./errors";

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
  proposalId: true,
  title: true,
  bodyMd: true,
  circleId: true,
  acceptedAt: true,
  circle: { select: { id: true, name: true } },
  proposal: {
    select: {
      id: true,
      title: true,
      isPrivate: true,
      publishedAt: true,
      tensions: {
        where: { isPrivate: false, publishedAt: { not: null }, archivedAt: null },
        select: { id: true, title: true, publishedAt: true },
        orderBy: { id: "asc" },
      },
    },
  },
} as const satisfies Prisma.PolicyCorpusSelect;

export type ConstitutionCorpusFingerprintRow = Prisma.PolicyCorpusGetPayload<{
  select: typeof CONSTITUTION_CORPUS_SELECT;
}>;

type ConstitutionCorpusClient = Pick<Prisma.TransactionClient, "policyCorpus">;

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
    proposalId: policy.proposalId,
    title: policy.title,
    bodyMd: policy.bodyMd,
    circleId: policy.circleId,
    acceptedAt: policy.acceptedAt,
    circle: policy.circle && { id: policy.circle.id, name: policy.circle.name },
    proposal: {
      id: policy.proposal.id,
      title: policy.proposal.title,
      isPrivate: policy.proposal.isPrivate,
      publishedAt: policy.proposal.publishedAt,
      tensions: policy.proposal.tensions.map((tension) => ({
        id: tension.id,
        title: tension.title,
        publishedAt: tension.publishedAt,
      })),
    },
  }));
  return createHash("sha256")
    .update(JSON.stringify(canonicalizeFingerprintValue(projected)))
    .digest("hex");
}

export async function loadConstitutionCorpusSnapshot(client: ConstitutionCorpusClient, workspaceId: string) {
  const corpus = await client.policyCorpus.findMany({
    where: { workspaceId },
    select: CONSTITUTION_CORPUS_SELECT,
    orderBy: [{ acceptedAt: "asc" }, { id: "asc" }],
  });

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
) {
  const policyIds = [...new Set(references.map((reference) => reference.policyCorpusId))];
  const policies = await tx.policyCorpus.findMany({
    where: { workspaceId, id: { in: policyIds } },
    select: {
      id: true,
      acceptedAt: true,
      proposal: {
        select: {
          id: true,
          title: true,
          isPrivate: true,
          publishedAt: true,
          tensions: {
            where: { isPrivate: false, publishedAt: { not: null }, archivedAt: null },
            select: { id: true, title: true },
          },
        },
      },
    },
  });
  const policiesById = new Map(policies.map((policy) => [policy.id, policy]));
  const orders = new Set<string>();
  const targets = new Set<string>();

  return references.map((reference) => {
    const policy = policiesById.get(reference.policyCorpusId);
    const validPoint = Number.isInteger(reference.pointOrder)
      && reference.pointOrder >= 1 && reference.pointOrder <= 10;
    const validOrder = Number.isInteger(reference.sourceOrder) && reference.sourceOrder >= 1;
    const proposalSource = reference.sourceKind === "PROPOSAL"
      && reference.proposalId === policy?.proposal.id && !reference.tensionId
      && !policy?.proposal.isPrivate && policy?.proposal.publishedAt != null;
    const tension = reference.sourceKind === "TENSION" && !reference.proposalId
      ? policy?.proposal.tensions.find((candidate) => candidate.id === reference.tensionId)
      : undefined;
    const labelSnapshot = proposalSource ? policy?.proposal.title : tension?.title;
    const orderKey = `${reference.pointOrder}:${reference.sourceOrder}`;
    const targetKey = `${reference.pointOrder}:${reference.policyCorpusId}:${reference.sourceKind}:${reference.proposalId ?? reference.tensionId}`;

    if (!policy || !validPoint || !validOrder || !labelSnapshot?.trim()
      || orders.has(orderKey) || targets.has(targetKey)) {
      throw new Error(INVALID_SOURCE_MESSAGE);
    }
    orders.add(orderKey);
    targets.add(targetKey);

    return {
      pointKey: `point-${reference.pointOrder}`,
      pointOrder: reference.pointOrder,
      sourceOrder: reference.sourceOrder,
      policyCorpusId: policy.id,
      sourceKind: reference.sourceKind,
      proposalId: proposalSource ? policy.proposal.id : null,
      tensionId: tension?.id ?? null,
      labelSnapshot,
      acceptedAtSnapshot: policy.acceptedAt,
    };
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

  const [items, total] = await Promise.all([
    prisma.constitution.findMany({
      where: { workspaceId },
      orderBy: { version: "desc" },
      take,
      skip,
    }),
    prisma.constitution.count({ where: { workspaceId } }),
  ]);

  return { items, total, take, skip };
}

export async function getCurrentConstitution(workspaceId: string) {
  return prisma.constitution.findFirst({
    where: { workspaceId },
    orderBy: { version: "desc" },
  });
}

export async function createConstitutionVersion(params: {
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
  for (let attempt = 0; attempt < CONSTITUTION_VERSION_RETRY_LIMIT; attempt += 1) {
    try {
      return await prisma.$transaction(async (tx) => {
        await acquireConstitutionCorpusAdvisoryLock(tx, params.workspaceId);
        if (params.expectedCorpusFingerprint != null) {
          const snapshot = await loadConstitutionCorpusSnapshot(tx, params.workspaceId);
          if (snapshot.fingerprint !== params.expectedCorpusFingerprint) {
            throw new Error("Constitution policy corpus changed during synthesis.");
          }
        }
        const sourceReferences = params.references === undefined
          ? undefined
          : await resolveSourceReferences(tx, params.workspaceId, params.references);
        const latest = await tx.constitution.findFirst({
          where: { workspaceId: params.workspaceId },
          orderBy: { version: "desc" },
        });

        return tx.constitution.create({
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
            ...(sourceReferences?.length ? { sourceReferences: { create: sourceReferences } } : {}),
          },
        });
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

  return prisma.policyCorpus.findMany({
    where: { workspaceId },
    include: {
      proposal: {
        select: { id: true, title: true, status: true },
      },
      circle: {
        select: { id: true, name: true },
      },
    },
    orderBy: { acceptedAt: "desc" },
  });
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
