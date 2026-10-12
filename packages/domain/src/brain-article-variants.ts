import { createHash, randomUUID } from "node:crypto";
import { Prisma, type BrainArticle, type BrainSource } from "@prisma/client";
import { prisma, type AppActor } from "@corgtex/shared";
import { requireWorkspaceMembership } from "./auth";
import { lockActiveArticleSources, lockBrainSourceLink } from "./brain-source-links";
import { AppError, invariant } from "./errors";
import { appendEvents } from "./events";
import { ensureWorkspacePermalink, workspaceEntityCanonicalPath } from "./permalinks";
import { lockWorkspaceMembership } from "./workspace-support-access";
import {
  captureArtifactInputProof,
  currentArtifactInputRoots,
  inspectStoredArtifactInputDependencies,
  isArtifactInputProofReadable,
  lineageContentFingerprint,
  readableArtifactIds,
  readableBrainSourceIds,
  recordArtifactInputLineage,
  type LineageRoot,
} from "./source-lineage";

export const BRAIN_ARTICLE_VARIANT_JOB_TYPE = "agent.brain-article-variant";

/** The model receives only this projection of independently permitted sources. */
export type PermittedVariantSource = Pick<BrainSource,
  "id" | "title" | "content" | "sourceType" | "tier" | "ingestionGuidanceMd">;

export type BrainArticleVariantRecipeV1 = {
  version: 1;
  articleId: string;
  memberId: string;
  userId: string;
  targetFingerprint: string;
  inputSetHash: string;
  sources: Array<{ id: string; fingerprint: string }>;
  sourceState: Record<string, string>;
};

type VariantPayload = BrainArticleVariantRecipeV1 & {
  phase: "REQUESTED" | "GENERATING" | "APPLIED" | "STALE";
  generationToken?: string;
  variantArticleId?: string;
};

type PreparedVariant = { recipe: BrainArticleVariantRecipeV1; roots: LineageRoot[]; sources: PermittedVariantSource[] };
type Preparation = PreparedVariant | { unavailable: true } | { original: true };
type UserActor = Extract<AppActor, { kind: "user" }>;

function hash(value: unknown) {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

function rootSignature(roots: readonly LineageRoot[]) {
  return roots.map(({ kind, id, fingerprint }) => [kind, id, fingerprint]).sort((left, right) =>
    JSON.stringify(left).localeCompare(JSON.stringify(right)));
}

function stateSignature(states: Record<string, string>) {
  return Object.entries(states).sort(([left], [right]) => left.localeCompare(right));
}

function readPayload(value: Prisma.JsonValue): VariantPayload {
  const payload = value as Partial<VariantPayload> | null;
  invariant(payload?.version === 1 && typeof payload.articleId === "string" && typeof payload.memberId === "string"
    && typeof payload.userId === "string" && /^[a-f0-9]{64}$/.test(payload.targetFingerprint ?? "")
    && /^[a-f0-9]{64}$/.test(payload.inputSetHash ?? "") && Array.isArray(payload.sources)
    && payload.sources.length > 0 && payload.sources.every((source) => source && typeof source.id === "string"
      && /^[a-f0-9]{64}$/.test(source.fingerprint))
    && payload.sourceState && typeof payload.sourceState === "object" && !Array.isArray(payload.sourceState)
    && Object.values(payload.sourceState).every((state) => typeof state === "string" && /^[a-f0-9]{64}$/.test(state))
    && ["REQUESTED", "GENERATING", "APPLIED", "STALE"].includes(payload.phase ?? ""),
  409, "INVALID_VARIANT_REQUEST", "The article variant recipe is invalid.");
  return payload as VariantPayload;
}

function sameRecipe(left: BrainArticleVariantRecipeV1, right: BrainArticleVariantRecipeV1) {
  return left.articleId === right.articleId && left.memberId === right.memberId && left.userId === right.userId
    && left.targetFingerprint === right.targetFingerprint && left.inputSetHash === right.inputSetHash
    && hash(left.sources.map(({ id, fingerprint }) => [id, fingerprint])) === hash(right.sources.map(({ id, fingerprint }) => [id, fingerprint]))
    && hash(stateSignature(left.sourceState)) === hash(stateSignature(right.sourceState));
}

async function sourceArchiveStates(tx: Prisma.TransactionClient, workspaceId: string, roots: readonly LineageRoot[]) {
  const states: Record<string, string> = Object.create(null);
  const ids = [...new Set(roots.filter((root) => root.kind === "BrainSource").map((root) => root.id))].sort();
  for (const id of ids) {
    const history = await tx.workspaceArchiveRecord.findMany({ where: {
      workspaceId, entityType: "BrainSource", entityId: id,
    }, select: { id: true, archivedAt: true, restoredAt: true, purgedAt: true }, orderBy: { id: "asc" } });
    states[id] = hash(history);
  }
  return states;
}

/** Internal ancestry inspection supplies identities, never canonical content to the model. */
async function prepareVariant(tx: Prisma.TransactionClient, actor: UserActor, workspaceId: string,
  articleId: string): Promise<Preparation> {
  const membership = await requireWorkspaceMembership({ actor, workspaceId, tx });
  invariant(membership?.isActive, 403, "NOT_A_MEMBER", "Active membership is required.");
  const target = await tx.brainArticle.findFirst({ where: { id: articleId, workspaceId, archivedAt: null } });
  if (!target || target.variantOfArticleId || (target.isPrivate && target.ownerMemberId !== membership.id
    && membership.role !== "ADMIN")) return { unavailable: true };
  const targetFingerprint = lineageContentFingerprint("BrainArticle", target);
  const manifest = await tx.artifactInputLineage.findFirst({ where: {
    workspaceId, artifactType: "BrainArticle", artifactId: articleId,
  }, orderBy: { revision: "desc" } });
  // Empty legacy/UNKNOWN receipts do not establish original authorship.
  if (!manifest || manifest.contentHash !== targetFingerprint || !Array.isArray(manifest.rootsJson)) return { unavailable: true };
  if (manifest.origin === "HUMAN_ORIGINAL" && manifest.rootsJson.length === 0) return { original: true };
  if (manifest.origin !== "DERIVED" || !manifest.rootsJson.length) return { unavailable: true };
  const priorRoots = await currentArtifactInputRoots(tx, workspaceId, { kind: "BrainArticle", id: articleId }, target);
  if (!priorRoots?.length) return { unavailable: true };
  if ((await readableArtifactIds(actor, workspaceId, "BrainArticle", [target], tx)).has(target.id)) return { original: true };
  const dependencies = await inspectStoredArtifactInputDependencies(tx, workspaceId, priorRoots);
  if (!dependencies.complete) return { unavailable: true };
  const candidateIds = [...new Set(dependencies.roots.filter((root) => root.kind === "BrainSource")
    .map((root) => root.id))].sort();
  if (!candidateIds.length) return { unavailable: true };
  const candidates = await tx.brainSource.findMany({ where: { workspaceId, id: { in: candidateIds }, archivedAt: null } });
  const readable = await readableBrainSourceIds(actor, workspaceId, candidates, tx);
  const sources = candidates.filter((source) => readable.has(source.id)).sort((left, right) => left.id.localeCompare(right.id));
  if (!sources.length) return { unavailable: true };
  // Current proof rejects copied sources with inaccessible or unknown upstream context.
  const roots = await captureArtifactInputProof(actor, workspaceId,
    sources.map((source) => ({ kind: "BrainSource", id: source.id, snapshot: source })), tx);
  const sourceDependencies = await inspectStoredArtifactInputDependencies(tx, workspaceId, roots);
  invariant(sourceDependencies.complete, 409, "UNKNOWN_LINEAGE", "A permitted source has incomplete ancestry.");
  const lockedIds = [...new Set([...candidateIds,
    ...sourceDependencies.roots.filter((root) => root.kind === "BrainSource").map((root) => root.id)])].sort();
  for (const id of lockedIds) {
    await lockBrainSourceLink(tx, id);
    await tx.$queryRaw`SELECT id FROM "BrainSource" WHERE id = ${id} AND "workspaceId" = ${workspaceId} FOR UPDATE`;
  }
  await lockActiveArticleSources(tx, workspaceId, sources.map((source) => source.id));
  await tx.$queryRaw`SELECT id FROM "BrainArticle" WHERE id = ${articleId} AND "workspaceId" = ${workspaceId} FOR UPDATE`;
  const lockedTarget = await tx.brainArticle.findFirst({ where: { id: articleId, workspaceId, archivedAt: null } });
  const lockedManifest = await tx.artifactInputLineage.findFirst({ where: {
    workspaceId, artifactType: "BrainArticle", artifactId: articleId,
  }, orderBy: { revision: "desc" } });
  invariant(lockedTarget && lineageContentFingerprint("BrainArticle", lockedTarget) === targetFingerprint
    && lockedManifest?.id === manifest.id && lockedManifest.origin === "DERIVED"
    && await isArtifactInputProofReadable(actor, workspaceId, roots, tx),
  409, "SOURCE_CHANGED", "Article variant inputs changed during preparation.");
  const sourceState = await sourceArchiveStates(tx, workspaceId, sourceDependencies.roots);
  const inputSetHash = hash([rootSignature(roots), stateSignature(sourceState)]);
  return { recipe: { version: 1, articleId, memberId: membership.id, userId: actor.user.id,
    targetFingerprint, inputSetHash, sourceState,
    sources: sources.map((source) => ({ id: source.id, fingerprint: roots.find((root) => root.kind === "BrainSource" && root.id === source.id)!.fingerprint })),
  }, roots, sources: sources.map(({ id, title, content, sourceType, tier, ingestionGuidanceMd }) =>
    ({ id, title, content, sourceType, tier, ingestionGuidanceMd })) };
}

async function existingVariant(tx: Prisma.TransactionClient, actor: UserActor, workspaceId: string,
  recipe: BrainArticleVariantRecipeV1): Promise<{ article: BrainArticle; readable: boolean } | null> {
  const article = await tx.brainArticle.findFirst({ where: { workspaceId, variantOfArticleId: recipe.articleId,
    ownerMemberId: recipe.memberId, variantTargetFingerprint: recipe.targetFingerprint, variantInputSetHash: recipe.inputSetHash,
  } });
  if (!article) return null;
  const readable = article.isPrivate && !article.archivedAt && article.ownerMemberId === recipe.memberId
    && article.variantSourceStateJson !== null && typeof article.variantSourceStateJson === "object" && !Array.isArray(article.variantSourceStateJson)
    && hash(stateSignature(article.variantSourceStateJson as Record<string, string>)) === hash(stateSignature(recipe.sourceState))
    && (await readableArtifactIds(actor, workspaceId, "BrainArticle", [article], tx)).has(article.id);
  return { article, readable };
}

function isStaleError(error: unknown) {
  return error instanceof AppError && ["SOURCE_CHANGED", "UNKNOWN_LINEAGE", "SOURCE_RESTRICTED", "NOT_A_MEMBER", "FORBIDDEN",
    "SUPPORT_CONTENT_RESTRICTED", "SUPPORT_AUTHORIZATION_REVOKED", "WORKSPACE_SCOPE_MISMATCH"].includes(error.code);
}

/** Read fallback can enqueue this without revealing any canonical title, body, source count, or path. */
export async function requestBrainArticleVariant(actor: AppActor, params: { workspaceId: string; articleId: string }) {
  await requireWorkspaceMembership({ actor, workspaceId: params.workspaceId });
  if (actor.kind !== "user") return { status: "unavailable" as const };
  return prisma.$transaction(async (tx) => {
    await lockWorkspaceMembership(tx, params.workspaceId);
    let prepared: Preparation;
    try { prepared = await prepareVariant(tx, actor, params.workspaceId, params.articleId); }
    catch (error) { if (isStaleError(error)) return { status: "unavailable" as const }; throw error; }
    if ("unavailable" in prepared) return { status: "unavailable" as const };
    if ("original" in prepared) return { status: "original" as const };
    const prior = await existingVariant(tx, actor, params.workspaceId, prepared.recipe);
    // An archived/unproven variant is preserved, never overwritten or automatically restored.
    if (prior) return prior.readable ? { status: "available" as const, articleId: prior.article.id } : { status: "unavailable" as const };
    const dedupeKey = `brain-article-variant:${params.workspaceId}:${prepared.recipe.memberId}:${params.articleId}:${prepared.recipe.targetFingerprint}:${prepared.recipe.inputSetHash}`;
    const existing = await tx.workflowJob.findUnique({ where: { dedupeKey } });
    if (existing) {
      if (existing.status === "FAILED" || existing.status === "COMPLETED" || readPayload(existing.payload).phase === "STALE") {
        await tx.workflowJob.update({ where: { id: existing.id }, data: { status: "PENDING",
          payload: { ...prepared.recipe, phase: "REQUESTED" } as Prisma.InputJsonObject,
          lockedAt: null, lockedBy: null, completedAt: null, error: null, runAfter: new Date() } });
      }
      return { status: "pending" as const, jobId: existing.id };
    }
    const job = await tx.workflowJob.create({ data: { workspaceId: params.workspaceId,
      type: BRAIN_ARTICLE_VARIANT_JOB_TYPE, dedupeKey,
      payload: { ...prepared.recipe, phase: "REQUESTED" } as Prisma.InputJsonObject } });
    return { status: "pending" as const, jobId: job.id };
  }, { maxWait: 5_000, timeout: 120_000 });
}

export async function getReadableBrainArticleVariant(actor: AppActor, params: { workspaceId: string; articleId: string }) {
  await requireWorkspaceMembership({ actor, workspaceId: params.workspaceId });
  if (actor.kind !== "user") return null;
  return prisma.$transaction(async (tx) => {
    await lockWorkspaceMembership(tx, params.workspaceId);
    try {
      const prepared = await prepareVariant(tx, actor, params.workspaceId, params.articleId);
      if (!("recipe" in prepared)) return null;
      const prior = await existingVariant(tx, actor, params.workspaceId, prepared.recipe);
      return prior?.readable ? prior.article : null;
    } catch (error) { if (isStaleError(error)) return null; throw error; }
  }, { maxWait: 5_000, timeout: 120_000 });
}

async function ownerActor(tx: Prisma.TransactionClient, workspaceId: string, recipe: BrainArticleVariantRecipeV1): Promise<UserActor> {
  const member = await tx.member.findFirst({ where: { id: recipe.memberId, workspaceId, userId: recipe.userId, isActive: true },
    include: { user: { select: { id: true, email: true, displayName: true, globalRole: true } } } });
  invariant(member?.user && member.id === recipe.memberId && member.userId === recipe.userId,
    403, "NOT_A_MEMBER", "The requesting member is no longer active.");
  const actor: UserActor = { kind: "user", user: member.user };
  const membership = await requireWorkspaceMembership({ actor, workspaceId, tx });
  invariant(membership?.id === recipe.memberId && membership.isActive, 403, "NOT_A_MEMBER", "The requesting member changed.");
  return actor;
}

/** Claim and acceptance both validate the actual worker lease and the requesting member's current proof. */
export async function generateBrainArticleVariant(params: {
  workspaceId: string; jobId: string; expectedAttempt: number; expectedOwner: string;
  generate: (sources: PermittedVariantSource[]) => Promise<{ title: string; bodyMd: string }>;
}) {
  invariant(Number.isInteger(params.expectedAttempt) && params.expectedAttempt > 0
    && typeof params.expectedOwner === "string" && params.expectedOwner.trim().length > 0,
  400, "INVALID_INPUT", "An active worker lease is required.");
  const claim = await prisma.$transaction(async (tx) => {
    await lockWorkspaceMembership(tx, params.workspaceId);
    await tx.$queryRaw`SELECT id FROM "WorkflowJob" WHERE id = ${params.jobId} AND "workspaceId" = ${params.workspaceId} FOR UPDATE`;
    const job = await tx.workflowJob.findFirst({ where: { id: params.jobId, workspaceId: params.workspaceId, type: BRAIN_ARTICLE_VARIANT_JOB_TYPE } });
    invariant(job, 404, "NOT_FOUND", "Article variant job not found.");
    if (job.status !== "RUNNING" || job.attempts !== params.expectedAttempt || job.lockedBy !== params.expectedOwner) return { phase: "SUPERSEDED" as const };
    const payload = readPayload(job.payload);
    if (payload.phase === "STALE") return { phase: "STALE" as const };
    const stale = async () => {
      await tx.workflowJob.update({ where: { id: job.id }, data: { payload: { ...payload, phase: "STALE" } as Prisma.InputJsonObject } });
      return { phase: "STALE" as const };
    };
    try {
      const actor = await ownerActor(tx, params.workspaceId, payload);
      const prepared = await prepareVariant(tx, actor, params.workspaceId, payload.articleId);
      if (!("recipe" in prepared) || !sameRecipe(prepared.recipe, payload)) return stale();
      const prior = await existingVariant(tx, actor, params.workspaceId, payload);
      if (prior) {
        if (!prior.readable) return stale();
        await tx.workflowJob.update({ where: { id: job.id }, data: {
          payload: { ...payload, phase: "APPLIED", variantArticleId: prior.article.id } as Prisma.InputJsonObject } });
        return { phase: "APPLIED" as const, articleId: prior.article.id };
      }
      if (payload.phase === "APPLIED") return stale();
      const token = randomUUID();
      await tx.workflowJob.update({ where: { id: job.id }, data: {
        payload: { ...payload, phase: "GENERATING", generationToken: token } as Prisma.InputJsonObject } });
      return { actor, prepared, token };
    } catch (error) { if (isStaleError(error)) return stale(); throw error; }
  }, { maxWait: 5_000, timeout: 120_000 });
  if ("phase" in claim) return claim;
  // Neither the old body nor its title, type, slug, frontmatter, or index enters this callback.
  const candidate = await params.generate(claim.prepared.sources);
  const title = typeof candidate?.title === "string" ? candidate.title.trim() : "";
  const bodyMd = typeof candidate?.bodyMd === "string" ? candidate.bodyMd.trim() : "";
  invariant(title.length > 0 && title.length <= 300 && bodyMd.length > 0 && bodyMd.length <= 100_000,
    422, "INVALID_CANDIDATE", "The article variant candidate is invalid.");
  return prisma.$transaction(async (tx) => {
    await lockWorkspaceMembership(tx, params.workspaceId);
    await tx.$queryRaw`SELECT id FROM "WorkflowJob" WHERE id = ${params.jobId} AND "workspaceId" = ${params.workspaceId} FOR UPDATE`;
    const job = await tx.workflowJob.findFirst({ where: { id: params.jobId, workspaceId: params.workspaceId, type: BRAIN_ARTICLE_VARIANT_JOB_TYPE } });
    invariant(job, 404, "NOT_FOUND", "Article variant job not found.");
    const payload = readPayload(job.payload);
    if (job.status !== "RUNNING" || job.attempts !== params.expectedAttempt || job.lockedBy !== params.expectedOwner
      || payload.phase !== "GENERATING" || payload.generationToken !== claim.token) return { phase: "SUPERSEDED" as const };
    const stale = async () => {
      await tx.workflowJob.update({ where: { id: job.id }, data: { payload: { ...payload, phase: "STALE" } as Prisma.InputJsonObject } });
      return { phase: "STALE" as const };
    };
    let actor: UserActor;
    let current: Preparation;
    try {
      actor = await ownerActor(tx, params.workspaceId, payload);
      current = await prepareVariant(tx, actor, params.workspaceId, payload.articleId);
      if (!("recipe" in current) || !sameRecipe(current.recipe, claim.prepared.recipe)
        || !sameRecipe(current.recipe, payload)
        || !await isArtifactInputProofReadable(actor, params.workspaceId, claim.prepared.roots, tx)) return stale();
    } catch (error) { if (isStaleError(error)) return stale(); throw error; }
    const prior = await existingVariant(tx, actor, params.workspaceId, payload);
    if (prior) {
      if (!prior.readable) return stale();
      await tx.workflowJob.update({ where: { id: job.id }, data: { payload: { ...payload, phase: "APPLIED", variantArticleId: prior.article.id } as Prisma.InputJsonObject } });
      return { phase: "APPLIED" as const, articleId: prior.article.id };
    }
    const article = await tx.brainArticle.create({ data: {
      workspaceId: params.workspaceId, slug: `member-variant-${randomUUID()}`, title, bodyMd, type: "PROJECT", authority: "DRAFT",
      isPrivate: true, ownerMemberId: payload.memberId, publishedAt: null, lastVerifiedAt: new Date(),
      sourceIds: payload.sources.map((source) => source.id), frontmatterJson: Prisma.DbNull,
      variantOfArticleId: payload.articleId, variantTargetFingerprint: payload.targetFingerprint,
      variantInputSetHash: payload.inputSetHash, variantSourceStateJson: payload.sourceState,
      variantGenerationJobId: job.id,
    } });
    await recordArtifactInputLineage({ tx, actor, workspaceId: params.workspaceId,
      artifact: { kind: "BrainArticle", id: article.id }, content: article, origin: "DERIVED",
      inputs: [], inheritedRoots: claim.prepared.roots });
    await ensureWorkspacePermalink(tx, actor, { workspaceId: params.workspaceId, entityType: "BrainArticle", entityId: article.id,
      canonicalPath: workspaceEntityCanonicalPath(params.workspaceId, "BrainArticle", article) });
    await tx.auditLog.create({ data: { workspaceId: params.workspaceId, actorUserId: actor.user.id,
      action: "brain-article.variant.created", entityType: "BrainArticle", entityId: article.id,
      meta: { jobId: job.id } } });
    await appendEvents(tx, [{ workspaceId: params.workspaceId, type: "brain-article.created",
      aggregateType: "BrainArticle", aggregateId: article.id, payload: { articleId: article.id } }]);
    await tx.workflowJob.update({ where: { id: job.id }, data: { payload: { ...payload, phase: "APPLIED", variantArticleId: article.id } as Prisma.InputJsonObject } });
    return { phase: "APPLIED" as const, articleId: article.id };
  }, { maxWait: 5_000, timeout: 120_000 });
}
