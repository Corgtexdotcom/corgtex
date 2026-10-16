import { assertVariantGenerationClaim, variantGenerationClaimStamp, type VariantGenerationControls } from "./variant-model-attempt";
import { startBrainSourceRemovalAttempt } from "./brain-source-removal-attempt";
import { DigestReadRelease } from "./digest-lineage";
import { isArtifactPermissionEpochProofCurrent, type PermissionEpochProof } from "./source-permission-epochs";
import { createHash, randomUUID } from "node:crypto";
import { Prisma } from "@prisma/client";
import { incrementCacheVersion, prisma, type AppActor } from "@corgtex/shared";
import { archiveWorkspaceArtifact } from "./archive";
import { requireWorkspaceMembership } from "./auth";
import { brainSourceContentFingerprint } from "./brain-derivation";
import { requireBrainSourceRemovalEnabled } from "./brain-removal-gate";
import { sourceIdsInDerivation } from "./brain-source-impact";
import { lockActiveArticleSources, lockBrainSourceLink } from "./brain-source-links";
import { AppError, invariant } from "./errors";
import { appendEvents } from "./events";
import { advanceHumanArtifactInputLineage, assertArtifactInputWriteFence, captureArtifactInputProof, captureArtifactPermissionEpochs, lineageContentFingerprint, createBrainArticleHistoryVersion, currentArtifactInputRoots, currentArtifactInputRootsBatch,
  inspectStoredArtifactInputDependencies, isArtifactInputProofReadable,
  readableBrainSourceIds, recordArtifactInputLineage, sealArtifactInputActor, type LineageRoot } from "./source-lineage";
import { commitBrainSourceRemovalCompletion, consumeArchivedBrainSourceRetirement, findBrainSourceRemovalCompletion,
  prepareArchivedBrainSourceRetirement, prepareBrainSourceRemovalControl,
  type ArchivedBrainSourceRetirementToken, type BrainSourceRemovalControlToken } from "./brain-source-removal-outcome";
import { ensureWorkspacePermalink, workspaceEntityCanonicalPath } from "./permalinks";

type RemovalArticle = {
  id: string;
  slug: string;
  title: string;
  hash: string;
  action: "archive" | "regenerate" | "preserve";
  remaining: Array<{ sourceId: string; fingerprint: string }>;
};

type RemovalRequest = {
  version: 1;
  sourceId: string;
  sourceFingerprint: string;
  sourceDocumentId: string | null;
  sourceDocumentControlHash?: string | null;
  sourceArchivedAt?: string | null;
  sourceArchiveStateHash?: string;
  articles: RemovalArticle[];
};

type RemovalPayload = RemovalRequest & {
  phase: "REQUESTED" | "GENERATING" | "READY" | "STALE" | "REJECTED" | "APPLIED";
  generationToken?: string;
  regenerationRunId?: string;
  candidates?: Record<string, string>;
  candidateTitles?: Record<string, string>;
  candidateRoots?: Record<string, LineageRoot[]>;
  archiveDocumentId?: string;
  continuationSourceIds?: string[];
  nextPendingSourceId?: string | null;
  completionPlanIdentityHash?: string;
};

type DeferredCompletion = { token: BrainSourceRemovalControlToken; actor: AppActor; workspaceId: string };
const continuationCompletions = new WeakMap<Prisma.TransactionClient, DeferredCompletion[]>();
function controlPlanIdentity(plan: RemovalRequest) {
  return createHash("sha256").update(JSON.stringify([plan.version, plan.sourceId, plan.sourceFingerprint,
    plan.sourceDocumentId, plan.sourceDocumentControlHash ?? null, plan.sourceArchivedAt ?? null, plan.sourceArchiveStateHash ?? null,
    plan.articles.map(article => [article.id, article.hash, article.action,
      article.remaining.map(source => [source.sourceId, source.fingerprint])])])).digest("hex");
}

function linkedDocumentId(metadata: Prisma.JsonValue | null) {
  return metadata && typeof metadata === "object" && !Array.isArray(metadata)
    && typeof metadata.documentId === "string" ? metadata.documentId : null;
}

async function archiveLinkedDocumentIfResolved(tx: Prisma.TransactionClient, actor: AppActor, workspaceId: string, documentId?: string) {
  if (!documentId) return;
  const activeSources = await tx.brainSource.count({ where: {
    workspaceId, archivedAt: null, metadata: { path: ["documentId"], equals: documentId },
  } });
  if (activeSources > 0) return;
  const document = await tx.document.findFirst({ where: { id: documentId, workspaceId, archivedAt: null } });
  if (document) await archiveWorkspaceArtifact(actor, { workspaceId, entityType: "Document", entityId: documentId,
    reason: "Linked sources removed after reviewed article removal.", _tx: tx });
}

function hashArticle(article: {
  updatedAt: Date; title: string; type: string; authority: string; isPrivate: boolean; publishedAt: Date | null; bodyMd: string;
  sourceIds: string[]; derivationJson: Prisma.JsonValue | null; humanEditedAt: Date | null; archivedAt: Date | null;
}) {
  return createHash("sha256").update(JSON.stringify([
    article.updatedAt, article.title, article.type, article.authority, article.isPrivate, article.publishedAt, article.bodyMd,
    article.sourceIds, article.derivationJson, article.humanEditedAt, article.archivedAt,
  ])).digest("hex");
}

function readPayload(value: Prisma.JsonValue): RemovalPayload {
  const payload = value as Partial<RemovalPayload> | null;
  invariant(payload && payload.version === 1 && typeof payload.sourceId === "string"
    && typeof payload.sourceFingerprint === "string" && Array.isArray(payload.articles)
    && typeof payload.phase === "string", 409, "INVALID_REMOVAL_REQUEST", "Source removal request is invalid.");
  return payload as RemovalPayload;
}

function requestMatches(left: RemovalRequest, right: RemovalRequest) {
  const signature = (request: RemovalRequest) => JSON.stringify([
    request.sourceId, request.sourceFingerprint, request.sourceDocumentId, request.sourceDocumentControlHash ?? null,
    request.sourceArchivedAt ?? null, request.sourceArchiveStateHash ?? null,
    request.articles.map((article) => [
      article.id, article.slug, article.title, article.hash, article.action,
      article.remaining.map((source) => [source.sourceId, source.fingerprint]),
    ]),
  ]);
  return signature(left) === signature(right);
}

async function lockSources(tx: Prisma.TransactionClient, ids: readonly string[]) {
  for (const id of [...new Set(ids)].sort()) {
    await lockBrainSourceLink(tx, id);
    await tx.$queryRaw`SELECT id FROM "BrainSource" WHERE id = ${id} FOR UPDATE`;
  }
}

async function archiveStateHash(tx: Prisma.TransactionClient, workspaceId: string, sourceId: string) {
  const records = await tx.workspaceArchiveRecord.findMany({ where: {
    workspaceId, entityType: "BrainSource", entityId: sourceId,
  }, select: { id: true, archivedAt: true, restoredAt: true, purgedAt: true }, orderBy: { id: "asc" } });
  return createHash("sha256").update(JSON.stringify(records)).digest("hex");
}

async function discoverRemovalArticles(tx: Prisma.TransactionClient, workspaceId: string, sourceId: string) {
  const discovered = [];
  let cursor: string | undefined;
  for (;;) {
    // This metadata-only pass excludes independent/unproved unlinked rows
    // without hydrating every article body or issuing one head query per row.
    // Nonempty ancestry still uses the complete existing dependency inspector,
    // including historical snapshots and encrypted consent/recovery capsules.
    const page = await tx.$queryRaw<Array<{id: string; candidate: boolean}>>(Prisma.sql`
      SELECT a.id, (${sourceId} = ANY(a."sourceIds")
        OR coalesce(a."derivationJson" @> ${JSON.stringify({sources: [{sourceId}]})}::jsonb, false)
        OR CASE WHEN jsonb_typeof(h."rootsJson") = 'array' THEN jsonb_array_length(h."rootsJson") > 0 ELSE false END) AS candidate
      FROM "BrainArticle" a
      LEFT JOIN LATERAL (SELECT "rootsJson" FROM "ArtifactInputLineage"
        WHERE "workspaceId" = ${workspaceId} AND "artifactType" = 'BrainArticle' AND "artifactId" = a.id
        ORDER BY revision DESC LIMIT 1) h ON true
      WHERE a."workspaceId" = ${workspaceId} AND a."archivedAt" IS NULL
        ${cursor ? Prisma.sql`AND a.id > ${cursor}` : Prisma.empty}
      ORDER BY a.id LIMIT 100
    `);
    const ids = page.filter(row => row.candidate).map(row => row.id);
    const articles = ids.length ? await tx.brainArticle.findMany({where: {workspaceId, archivedAt: null, id: {in: ids}}, orderBy: {id: "asc"}}) : [];
    const currentRoots = await currentArtifactInputRootsBatch(tx, workspaceId, "BrainArticle", articles);
    for (const article of articles) {
      const roots = currentRoots.get(article.id) ?? null;
      const dependencies = roots ? await inspectStoredArtifactInputDependencies(tx, workspaceId, roots) : null;
      // An attested original is independent even when it has citation-only links.
      const linked = article.sourceIds.includes(sourceId) || sourceIdsInDerivation(article.derivationJson).includes(sourceId)
        || dependencies?.roots.some(root => root.kind === "BrainSource" && root.id === sourceId);
      if (linked) discovered.push({article, roots, dependencies});
    }
    if (page.length < 100) return discovered;
    cursor = page[page.length - 1].id;
  }
}

async function currentPlan(tx: Prisma.TransactionClient, workspaceId: string, sourceId: string, expected?: RemovalRequest) {
  // Internal ancestry discovery grants no read access. Snapshot and historical
  // manifests identify exclusions even after their old content is unavailable.
  const before = await discoverRemovalArticles(tx, workspaceId, sourceId);
  const beforeIds = before.map(({ article }) => article.id);
  const discoveredSourceIds = [sourceId, ...before.flatMap(({ article, dependencies }) => [
    ...article.sourceIds, ...sourceIdsInDerivation(article.derivationJson),
    ...(dependencies?.roots.filter((root) => root.kind === "BrainSource").map((root) => root.id) ?? []),
  ])];
  const currentSources = await tx.brainSource.findMany({ where: { workspaceId, id: { in: discoveredSourceIds } } });
  const currentDependencies = await Promise.all(currentSources.map((source) => inspectStoredArtifactInputDependencies(tx, workspaceId,
    [{ kind: "BrainSource", id: source.id, fingerprint: brainSourceContentFingerprint(source) }])));
  const allSourceIds = [...discoveredSourceIds, ...currentDependencies.flatMap((dependencies) => dependencies.roots
    .filter((root) => root.kind === "BrainSource").map((root) => root.id))];
  await lockSources(tx, allSourceIds);
  const source = await tx.brainSource.findFirst({ where: { id: sourceId, workspaceId } });
  invariant(source, 404, "NOT_FOUND", "Source exclusion identity not found.");
  const sourceDocumentId = linkedDocumentId(source.metadata);
  let sourceDocumentControlHash: string | null = null;
  if (sourceDocumentId) {
    // Keep the Source -> Document -> Article lock order. The excluded document
    // supplies only current control identity, never model context or old bytes.
    await tx.$queryRaw`SELECT id FROM "Document" WHERE id = ${sourceDocumentId} AND "workspaceId" = ${workspaceId} FOR UPDATE`;
    const document = await tx.document.findFirst({ where: { id: sourceDocumentId, workspaceId }, select: {
      id: true, workspaceId: true, accessDomain: true, archivedAt: true, archivedByUserId: true,
    } });
    invariant(document, 409, "SOURCE_CHANGED", "The exclusion document is unavailable.");
    const archives = await tx.workspaceArchiveRecord.findMany({ where: { workspaceId, entityType: "Document", entityId: sourceDocumentId },
      select: { id: true, archivedAt: true, restoredAt: true, purgedAt: true }, orderBy: { id: "asc" } });
    sourceDocumentControlHash = createHash("sha256").update(JSON.stringify([document.id, document.workspaceId,
      document.accessDomain, document.archivedAt, document.archivedByUserId, archives])).digest("hex");
  }
  for (const id of beforeIds) {
    await tx.$queryRaw`SELECT id FROM "BrainArticle" WHERE id = ${id} AND "workspaceId" = ${workspaceId} FOR UPDATE`;
  }
  const after = await discoverRemovalArticles(tx, workspaceId, sourceId);
  invariant(JSON.stringify(beforeIds) === JSON.stringify(after.map(({ article }) => article.id)),
    409, "SOURCE_CHANGED", "Article links changed; retry source removal.");
  const plans: RemovalArticle[] = [];
  for (const { article, roots, dependencies } of after) {
    if (expected && !roots) invariant(false, 409, "SOURCE_CHANGED", "Article lineage changed; prepare a new candidate.");
    if (roots?.length === 0) {
      plans.push({ id: article.id, slug: article.slug, title: article.title, hash: hashArticle(article), action: "preserve", remaining: [] });
      continue;
    }
    invariant(roots?.length && dependencies?.complete
      && dependencies.roots.some((root) => root.kind === "BrainSource" && root.id === sourceId),
      409, "UNCLASSIFIED_SOURCE_LINK", "An article has a source link with unknown provenance; resolve it manually.");
    const candidateIds = [...new Set(dependencies.roots.filter((root) => root.kind === "BrainSource" && root.id !== sourceId)
      .map((root) => root.id))].sort();
    invariant(candidateIds.every((id) => allSourceIds.includes(id)),
      409, "SOURCE_CHANGED", "Source links changed; retry removal.");
    const candidates = await tx.brainSource.findMany({ where: {
      workspaceId, id: { in: candidateIds }, archivedAt: null, accessDomain: "WORKSPACE",
    }, orderBy: { id: "asc" } });
    const remaining: RemovalArticle["remaining"] = [];
    for (const candidate of candidates) {
      const fingerprint = brainSourceContentFingerprint(candidate);
      const lineage = await inspectStoredArtifactInputDependencies(tx, workspaceId,
        [{ kind: "BrainSource", id: candidate.id, fingerprint }]);
      // Copied sources are not independent simply because their own archive flag
      // is clear. Unknown provenance also cannot be used in the fresh model call.
      if (!lineage.complete || lineage.roots.some((root) => root.kind === "BrainSource" && root.id === sourceId)) continue;
      invariant(lineage.roots.filter((root) => root.kind === "BrainSource").every((root) => allSourceIds.includes(root.id)),
        409, "SOURCE_CHANGED", "Retained source dependencies changed; retry removal.");
      remaining.push({ sourceId: candidate.id, fingerprint });
    }
    plans.push({ id: article.id, slug: article.slug, title: article.title, hash: hashArticle(article),
      action: remaining.length > 0 ? "regenerate" : "archive", remaining });
  }
  const remainingIds = [...new Set(plans.flatMap((article) => article.remaining.map((item) => item.sourceId)))];
  await lockActiveArticleSources(tx, workspaceId, remainingIds);

  const plan: RemovalRequest = {
    version: 1, sourceId, sourceFingerprint: brainSourceContentFingerprint(source),
    sourceDocumentId, sourceDocumentControlHash, sourceArchivedAt: source.archivedAt?.toISOString() ?? null,
    sourceArchiveStateHash: await archiveStateHash(tx, workspaceId, sourceId), articles: plans,
  };
  if (expected) invariant(requestMatches(plan, expected), 409, "SOURCE_CHANGED", "Sources or articles changed; prepare a new candidate.");
  return plan;
}

async function preserveOriginalWithoutCitation(tx: Prisma.TransactionClient, actor: AppActor,
  workspaceId: string, articleId: string, sourceId: string) {
  const before = await tx.brainArticle.findFirst({ where: { id: articleId, workspaceId, archivedAt: null } });
  invariant(before && (await currentArtifactInputRoots(tx, workspaceId, { kind: "BrainArticle", id: articleId }, before))?.length === 0,
    409, "SOURCE_CHANGED", "The original article changed before source removal.");
  const derivation = before.derivationJson && typeof before.derivationJson === "object" && !Array.isArray(before.derivationJson)
    ? before.derivationJson : null;
  const after = await tx.brainArticle.update({ where: { id: articleId }, data: {
    sourceIds: before.sourceIds.filter((id) => id !== sourceId),
    ...(derivation && Array.isArray(derivation.sources) ? { derivationJson: {
      ...derivation, sources: derivation.sources.filter((entry) => !entry || typeof entry !== "object" || Array.isArray(entry) || entry.sourceId !== sourceId),
    } as Prisma.InputJsonObject } : {}),
  } });
  await advanceHumanArtifactInputLineage({ tx, actor, workspaceId, artifact: { kind: "BrainArticle", id: articleId },
    before, after, allowSystemTransition: true });
  await appendEvents(tx, [{ workspaceId, type: "brain-article.updated", aggregateType: "BrainArticle", aggregateId: articleId,
    payload: { articleId } }]);
  await incrementCacheVersion(`knowledge:${workspaceId}`, tx);
}

async function requireRemovalManager(actor: AppActor, workspaceId: string, tx?: Prisma.TransactionClient) {
  const membership = await requireWorkspaceMembership({ actor, workspaceId, allowedRoles: ["ADMIN"], tx });
  invariant(actor.kind === "agent" || membership?.role === "ADMIN", 403, "FORBIDDEN", "Workspace admin access is required.");
}

async function latestRemovalJob(tx: Prisma.TransactionClient | typeof prisma, workspaceId: string, sourceId: string) {
  return tx.workflowJob.findFirst({
    where: { workspaceId, type: "agent.brain-source-regenerate", payload: { path: ["sourceId"], equals: sourceId } },
    orderBy: { createdAt: "desc" },
  });
}

export async function requestBrainSourceRemoval(actor: AppActor, params: {
  workspaceId: string; sourceId: string; archiveLinkedDocument?: boolean; _tx?: Prisma.TransactionClient;
  /** Internal opaque retry capability; never reconstructed from request JSON. */
  _archivedExclusion?: ArchivedBrainSourceRetirementToken;
}): Promise<{ id: string; status: "archived"; jobId?: never } | { id: string; status: "pending"; jobId: string }> {
  sealArtifactInputActor(actor);
  params = Object.freeze({ ...params });
  await requireWorkspaceMembership({ actor, workspaceId: params.workspaceId, tx: params._tx });
  const request = async (tx: Prisma.TransactionClient) => {
    const completed = await findBrainSourceRemovalCompletion(actor, { workspaceId: params.workspaceId, sourceId: params.sourceId,
      archiveLinkedDocument: params.archiveLinkedDocument }, tx);
    if (completed) {
      invariant(completed.status === "archived", 409, "INVALID_REMOVAL_REQUEST", "Canonical source completion is invalid.");
      return completed;
    }
    await lockBrainSourceLink(tx, params.sourceId);
    await tx.$queryRaw`SELECT id FROM "BrainSource" WHERE id = ${params.sourceId} AND "workspaceId" = ${params.workspaceId} FOR UPDATE`;
    await assertArtifactInputWriteFence(tx);
    await requireWorkspaceMembership({ actor, workspaceId: params.workspaceId, tx });
    if (params._archivedExclusion) await consumeArchivedBrainSourceRetirement(params._archivedExclusion, actor, params, tx);
    // An archived exclusion is used only for internal identity/ancestry checks.
    // Its bytes never enter the fresh model or become a readable source proof.
    const existingSource = await tx.brainSource.findFirst({ where: { id: params.sourceId, workspaceId: params.workspaceId,
      ...(params._archivedExclusion ? {} : { archivedAt: null }) } });
    invariant(existingSource, 404, "NOT_FOUND", "Source not found.");
    const archiveDocumentId = params.archiveLinkedDocument ? linkedDocumentId(existingSource.metadata) : null;
    invariant(Boolean(params._archivedExclusion && existingSource.archivedAt)
      || (await readableBrainSourceIds(actor, params.workspaceId, [existingSource], tx)).has(existingSource.id),
      404, "NOT_FOUND", "Source not found.");
    if (params.archiveLinkedDocument) {
      invariant(archiveDocumentId, 409, "SOURCE_CHANGED", "The source no longer belongs to a document.");
      invariant(Boolean(params._archivedExclusion) || await tx.document.count({ where: { id: archiveDocumentId, workspaceId: params.workspaceId, archivedAt: null } }) === 1,
        409, "SOURCE_CHANGED", "The linked document is unavailable.");
    }
    const plan = await currentPlan(tx, params.workspaceId, params.sourceId);
    invariant(!params._archivedExclusion || plan.articles.some(article => article.action === "regenerate"),
      409, "RETIREMENT_REBUILD_REQUIRED", "An archived exclusion retry requires independently permitted replacement inputs.");
    invariant(!archiveDocumentId || plan.sourceDocumentId === archiveDocumentId,
      409, "SOURCE_CHANGED", "The source document changed; review it again.");
    if (plan.articles.length > 0) await requireRemovalManager(actor, params.workspaceId, tx);
    if (plan.articles.length > 0) await requireBrainSourceRemovalEnabled(tx, params.workspaceId);
    if (plan.articles.every((article) => article.action !== "regenerate")) {
      const token = await prepareBrainSourceRemovalControl(actor, { workspaceId: params.workspaceId, sourceId: params.sourceId,
        mode: "DIRECT", planIdentityHash: controlPlanIdentity(plan), archiveLinkedDocument: Boolean(archiveDocumentId) }, tx);
      for (const article of plan.articles) {
        if (article.action === "preserve") {
          await preserveOriginalWithoutCitation(tx, actor, params.workspaceId, article.id, params.sourceId);
          continue;
        }
        await archiveWorkspaceArtifact(actor, {
          workspaceId: params.workspaceId, entityType: "BrainArticle", entityId: article.id,
          reason: "No verified sources remain after source removal.", _tx: tx,
        });
      }
      if (!existingSource.archivedAt) await archiveWorkspaceArtifact(actor, {
        workspaceId: params.workspaceId, entityType: "BrainSource", entityId: params.sourceId,
        reason: "Removed after linked articles were archived.", _tx: tx,
      });
      await archiveLinkedDocumentIfResolved(tx, actor, params.workspaceId, archiveDocumentId ?? undefined);
      if (plan.articles.length > 0) await requireRemovalManager(actor, params.workspaceId, tx);
      const deferred = continuationCompletions.get(tx);
      if (deferred) {
        deferred.push({ token, actor, workspaceId: params.workspaceId });
        return { id: params.sourceId, status: "archived" as const };
      }
      const result = await commitBrainSourceRemovalCompletion(token, { actor, workspaceId: params.workspaceId }, tx);
      invariant(result.status === "archived", 409, "INVALID_REMOVAL_REQUEST", "Canonical source completion is invalid.");
      return result;
    }
    const latest = await latestRemovalJob(tx, params.workspaceId, params.sourceId);
    if (latest) {
      const payload = readPayload(latest.payload);
      if (requestMatches(plan, payload) && (latest.status === "PENDING" || latest.status === "RUNNING"
        || (latest.status === "COMPLETED" && (payload.phase === "READY" || payload.phase === "APPLIED")))) {
        if (archiveDocumentId && payload.archiveDocumentId !== archiveDocumentId) {
          invariant(false, 409, "REMOVAL_ALREADY_PENDING", "Finish the existing source review before removing its document.");
        }
        return { id: params.sourceId, status: "pending" as const, jobId: latest.id };
      }
    }
    const job = await tx.workflowJob.create({ data: {
      workspaceId: params.workspaceId, type: "agent.brain-source-regenerate",
      dedupeKey: `brain-source-removal:${params.workspaceId}:${params.sourceId}:${randomUUID()}`,
      payload: { ...plan, phase: "REQUESTED", ...(archiveDocumentId ? { archiveDocumentId } : {}) } as Prisma.InputJsonObject,
    } });
    return { id: params.sourceId, status: "pending" as const, jobId: job.id };
  };
  return params._tx ? request(params._tx) : prisma.$transaction(request, { maxWait: 5_000, timeout: 120_000 });
}

/** Continue a confirmed multi-source removal only after each shared-source review is accepted. */
export async function continueBrainSourceRemovals(tx: Prisma.TransactionClient, actor: AppActor, workspaceId: string, sourceIds: string[]) {
  const previous = continuationCompletions.get(tx);
  const deferred = previous ?? [];
  continuationCompletions.set(tx, deferred);
  sourceIds = [...new Set(sourceIds)];
  let completed = false;
  try {
    for (let index = 0; index < sourceIds.length; index++) {
      const sourceId = sourceIds[index];
      const source = await tx.brainSource.findFirst({ where: { id: sourceId, workspaceId }, select: { id: true, metadata: true } });
      invariant(source, 409, "SOURCE_CHANGED", "A selected source is unavailable.");
      const result = await requestBrainSourceRemoval(actor, {
        workspaceId, sourceId, archiveLinkedDocument: !!linkedDocumentId(source.metadata), _tx: tx,
      });
      if (result.status !== "pending") continue;
      const job = await tx.workflowJob.findUniqueOrThrow({ where: { id: result.jobId } });
      const payload = readPayload(job.payload);
      invariant(!payload.continuationSourceIds, 409, "REMOVAL_ALREADY_PENDING", "A source already has a removal sequence in progress.");
      await tx.workflowJob.update({ where: { id: job.id }, data: {
        payload: { ...payload, continuationSourceIds: sourceIds.slice(index + 1) } as Prisma.InputJsonObject,
      } });
      completed = true;
      return { pendingJobId: job.id, pendingSourceId: sourceId };
    }
    completed = true;
    return { pendingJobId: null, pendingSourceId: null };
  } finally {
    if (!previous) {
      continuationCompletions.delete(tx);
      if (completed) for (const completion of deferred) await commitBrainSourceRemovalCompletion(completion.token,
        { actor: completion.actor, workspaceId: completion.workspaceId }, tx);
    }
  }
}

export async function retryBrainSourceRemoval(actor: AppActor, params: { workspaceId: string; jobId: string }) {
  sealArtifactInputActor(actor);
  params = Object.freeze({ ...params });
  await requireRemovalManager(actor, params.workspaceId);
  return prisma.$transaction(async (tx) => {
    await assertArtifactInputWriteFence(tx);
    await requireRemovalManager(actor, params.workspaceId, tx);
    await tx.$queryRaw`SELECT id FROM "WorkflowJob" WHERE id = ${params.jobId} AND "workspaceId" = ${params.workspaceId} FOR UPDATE`;
    const oldJob = await tx.workflowJob.findFirst({ where: {
      id: params.jobId, workspaceId: params.workspaceId, type: "agent.brain-source-regenerate",
    } });
    invariant(oldJob, 404, "NOT_FOUND", "Source removal job not found.");
    const old = readPayload(oldJob.payload);
    invariant(oldJob.status === "FAILED" || (oldJob.status === "COMPLETED" && (old.phase === "STALE" || old.phase === "REJECTED")),
      409, "INVALID_STATE", "This source review is not ready to retry.");
    const latest = await latestRemovalJob(tx, params.workspaceId, old.sourceId);
    invariant(latest?.id === oldJob.id, 409, "INVALID_STATE", "A newer source review already exists.");
    const source = await tx.brainSource.findFirst({ where: { id: old.sourceId, workspaceId: params.workspaceId } });
    const restoredSinceRequest = await tx.workspaceArchiveRecord.count({ where: {
      workspaceId: params.workspaceId, entityType: "BrainSource", entityId: old.sourceId,
      restoredAt: { gt: oldJob.createdAt },
    } });
    invariant(!restoredSinceRequest, 409, "SOURCE_CHANGED", "The source was restored; prepare a new removal request.");
    invariant(source && (!old.sourceArchivedAt || source.archivedAt?.toISOString() === old.sourceArchivedAt)
      && (!old.archiveDocumentId || linkedDocumentId(source.metadata) === old.archiveDocumentId),
      409, "SOURCE_CHANGED", "The source document changed; review it again.");
    const result = await requestBrainSourceRemoval(actor, {
      workspaceId: params.workspaceId, sourceId: old.sourceId,
      archiveLinkedDocument: !!old.archiveDocumentId, _tx: tx,
      ...(source.archivedAt ? { _archivedExclusion: await prepareArchivedBrainSourceRetirement(actor,
        { workspaceId: params.workspaceId, sourceId: old.sourceId }, tx) } : {}),
    });
    if (result.status === "pending") {
      const newJob = await tx.workflowJob.findUniqueOrThrow({ where: { id: result.jobId } });
      const payload = readPayload(newJob.payload);
      await tx.workflowJob.update({ where: { id: newJob.id }, data: {
        payload: { ...payload, continuationSourceIds: old.continuationSourceIds ?? [] } as Prisma.InputJsonObject,
      } });
    } else {
      const continued = old.continuationSourceIds?.length
        ? await continueBrainSourceRemovals(tx, actor, params.workspaceId, old.continuationSourceIds)
        : { pendingSourceId: null };
      return { ...result, pendingSourceId: continued.pendingSourceId };
    }
    return result;
  }, { maxWait: 5_000, timeout: 120_000 });
}

export async function generateBrainSourceRemovalCandidate(params: {
  workspaceId: string;
  jobId: string;
  expectedAttempt: number;
  expectedOwner: string | null;
  generate: (article: { id: string; title: string }, sources: Array<{ id: string; title: string | null; content: string }>, controls: VariantGenerationControls) => Promise<string>;
}) {
  const claim = await prisma.$transaction(async (tx) => {
    await tx.$queryRaw`SELECT id FROM "WorkflowJob" WHERE id = ${params.jobId} AND "workspaceId" = ${params.workspaceId} FOR UPDATE`;
    const job = await tx.workflowJob.findFirst({ where: { id: params.jobId, workspaceId: params.workspaceId, type: "agent.brain-source-regenerate" } });
    invariant(job, 404, "NOT_FOUND", "Regeneration job not found.");
    let payload = readPayload(job.payload);
    if (job.status !== "RUNNING" || job.attempts !== params.expectedAttempt || job.lockedBy !== params.expectedOwner) {
      return { done: "SUPERSEDED" } as const;
    }
    if (payload.phase !== "REQUESTED" && payload.phase !== "GENERATING") return { done: payload.phase } as const;
    assertVariantGenerationClaim(variantGenerationClaimStamp(job), job);
    const excluded = await tx.brainSource.findFirst({ where: { id: payload.sourceId, workspaceId: params.workspaceId } });
    if (!payload.sourceArchivedAt && excluded?.archivedAt
      && brainSourceContentFingerprint(excluded) === payload.sourceFingerprint) {
      // Archive removes read eligibility immediately; it need not prevent a
      // source-only replacement whose exclusion request was already authorized.
      const restoredSinceRequest = await tx.workspaceArchiveRecord.count({ where: {
        workspaceId: params.workspaceId, entityType: "BrainSource", entityId: payload.sourceId,
        restoredAt: { gt: job.createdAt },
      } });
      if (!restoredSinceRequest) payload = { ...payload, sourceArchivedAt: excluded.archivedAt.toISOString(),
        sourceArchiveStateHash: await archiveStateHash(tx, params.workspaceId, payload.sourceId) };
    }
    const token = randomUUID();
    const generationJob = await tx.workflowJob.update({ where: { id: job.id }, data: {
      payload: { ...payload, phase: "GENERATING", generationToken: token } as Prisma.InputJsonObject,
    } });
    return { payload, token, attempts: job.attempts, generationJob } as const;
  });
  if ("done" in claim) return { phase: claim.done };
  const { payload, token, attempts } = claim;

  const generationActor: AppActor = { kind: "agent", authProvider: "bootstrap", label: "brain-source-regenerate",
    workspaceIds: [params.workspaceId] };
  let attempt: ReturnType<typeof startBrainSourceRemovalAttempt> | undefined;
  const finish = async (candidates: Record<string, string> | null, candidateTitles: Record<string, string> = {},
    candidateRoots: Record<string, LineageRoot[]> = {}) => {
    await attempt?.stop();
    return prisma.$transaction(async (tx) => {
    await tx.$queryRaw`SELECT id FROM "WorkflowJob" WHERE id = ${params.jobId} AND "workspaceId" = ${params.workspaceId} FOR UPDATE`;
    const current = await tx.workflowJob.findFirst({ where: { id: params.jobId, workspaceId: params.workspaceId, type: "agent.brain-source-regenerate" } });
    invariant(current, 404, "NOT_FOUND", "Regeneration job not found.");
    const livePayload = readPayload(current.payload);
    if (current.status !== "RUNNING" || current.attempts !== attempts || current.lockedBy !== params.expectedOwner
      || livePayload.phase !== "GENERATING" || livePayload.generationToken !== token) {
      return { phase: "SUPERSEDED" as const };
    }
    attempt?.assertCurrent(current);
    let stale = candidates === null;
    if (!stale) {
      try {
        await currentPlan(tx, params.workspaceId, payload.sourceId, payload);
      } catch (error) {
        if (!(error instanceof AppError) || !["SOURCE_CHANGED", "NOT_FOUND", "UNCLASSIFIED_SOURCE_LINK", "RESTRICTED_SOURCE"].includes(error.code)) throw error;
        stale = true;
      }
      for (const roots of Object.values(candidateRoots)) {
        if (!await isArtifactInputProofReadable(generationActor, params.workspaceId, roots, tx)) stale = true;
      }
    }
    if (stale) {
      await tx.workflowJob.update({ where: { id: current.id }, data: {
        payload: { ...payload, phase: "STALE" } as Prisma.InputJsonObject,
      } });
      return { phase: "STALE" as const };
    }
    const run = await tx.agentRun.create({ data: {
      workspaceId: params.workspaceId, agentKey: "brain-source-regenerate", triggerType: "EVENT", triggerRef: current.id,
      status: "COMPLETED", goal: "Prepare reviewed Brain article replacements from remaining verified sources.",
      planJson: { sourceId: payload.sourceId, articleIds: payload.articles.map((article) => article.id) },
      resultJson: { sourceId: payload.sourceId, candidateArticleIds: Object.keys(candidates!) },
      startedAt: current.startedAt ?? new Date(), completedAt: new Date(),
    } });
    await tx.workflowJob.update({ where: { id: current.id }, data: {
      payload: { ...payload, phase: "READY", candidates, candidateTitles, candidateRoots, regenerationRunId: run.id } as Prisma.InputJsonObject,
    } });
    return { phase: "READY" as const, candidateCount: Object.keys(candidates!).length };
    });
  };

  try {
    await prisma.$transaction((tx) => currentPlan(tx, params.workspaceId, payload.sourceId, payload));
  } catch (error) {
    if (!(error instanceof AppError) || !["SOURCE_CHANGED", "NOT_FOUND", "UNCLASSIFIED_SOURCE_LINK", "RESTRICTED_SOURCE"].includes(error.code)) throw error;
    return finish(null);
  }
  const candidates: Record<string, string> = {};
  const candidateTitles: Record<string, string> = {};
  const candidateRoots: Record<string, LineageRoot[]> = {};
  attempt = startBrainSourceRemovalAttempt(claim.generationJob, async () => {
    await prisma.$transaction((tx) => currentPlan(tx, params.workspaceId, payload.sourceId, payload));
    for (const roots of Object.values(candidateRoots)) invariant(
      await isArtifactInputProofReadable(generationActor, params.workspaceId, roots),
      409, "SOURCE_CHANGED", "The original remaining sources are no longer readable.");
  });
  try {
  for (const article of payload.articles.filter((item) => item.action === "regenerate")) {
    const ids = article.remaining.map((item) => item.sourceId);
    const sources = await prisma.brainSource.findMany({
      where: { workspaceId: params.workspaceId, id: { in: ids }, archivedAt: null },
    });
    invariant(sources.length === ids.length, 409, "SOURCE_CHANGED", "A remaining source changed before regeneration.");
    try {
      const roots = await captureArtifactInputProof(generationActor, params.workspaceId,
        sources.map((source) => ({ kind: "BrainSource", id: source.id, snapshot: source })));
      // A copied source depending on the excluded input is not an independent
      // retained source, even when its own archive flag is still clear.
      const dependencies = await inspectStoredArtifactInputDependencies(prisma, params.workspaceId, roots);
      if (!dependencies.complete || dependencies.roots.some((root) => root.kind === "BrainSource" && root.id === payload.sourceId)) return finish(null);
      candidateRoots[article.id] = roots;
    } catch (error) {
      if (error instanceof AppError && ["UNKNOWN_LINEAGE", "SOURCE_CHANGED", "SOURCE_RESTRICTED"].includes(error.code)) return finish(null);
      throw error;
    }
    // The removed article's old title may itself contain withdrawn information.
    // Give the model only a title from the independently retained sources.
    const safeTitle = sources[0]?.title?.trim() || "Remaining-source article";
    await attempt.controls.authorizeAttempt({ signal: attempt.controls.signal });
    const generated = await params.generate({ id: article.id, title: safeTitle }, sources, attempt.controls);
    attempt.assertActive();
    const bodyMd = generated.trim();
    invariant(bodyMd.length > 0 && bodyMd.length <= 100_000, 422, "INVALID_CANDIDATE", "Regeneration produced an invalid candidate.");
    candidates[article.id] = bodyMd;
    candidateTitles[article.id] = safeTitle;
  }
  return await finish(candidates, candidateTitles, candidateRoots);
  } finally { await attempt.stop(); }
}

export async function listBrainSourceRemovalReviews(actor: AppActor, params: { workspaceId: string; sourceIds: string[] }) {
  sealArtifactInputActor(actor);
  params = structuredClone(params);
  await requireRemovalManager(actor, params.workspaceId);
  const membership = await requireWorkspaceMembership({ actor, workspaceId: params.workspaceId });
  const release = new DigestReadRelease(actor, params.workspaceId);
  const epochs: PermissionEpochProof[] = [await prisma.$transaction(tx => captureArtifactPermissionEpochs(actor, params.workspaceId, [], tx))];
  const jobs: Array<{ id: string; stamp: string }> = [];
  const envelopes = new Map<string, string>();
  const envelopeStamp = (row: { id: string; isPrivate: boolean; ownerMemberId: string | null; archivedAt: Date | null }) =>
    JSON.stringify([row.id, row.isPrivate, row.ownerMemberId, row.archivedAt]);
  const entries = await Promise.all(params.sourceIds.map(async (sourceId) => {
    const source = await prisma.brainSource.findFirst({ where: { id: sourceId, workspaceId: params.workspaceId } });
    if (!source) return null;
    const job = await latestRemovalJob(prisma, params.workspaceId, sourceId);
    if (!job) return null;
    jobs.push({ id: job.id, stamp: variantGenerationClaimStamp(job) });
    const payload = readPayload(job.payload);
    const exclusionMatches = payload.sourceFingerprint === brainSourceContentFingerprint(source)
      && (payload.sourceArchivedAt ?? null) === (source.archivedAt?.toISOString() ?? null);
    if (!exclusionMatches) return null;
    const remainingIds = [...new Set(payload.articles.flatMap((item) => item.remaining.map((root) => root.sourceId)))];
    const remainingSources = await prisma.brainSource.findMany({
      where: { workspaceId: params.workspaceId, id: { in: remainingIds }, archivedAt: null },
    });
    const remainingById = new Map(remainingSources.map((item) => [item.id, item]));
    const readableRemaining = new Set((await release.capture("BrainSource", remainingSources)).records.map(row => row.id));
    const articles = await prisma.brainArticle.findMany({
      where: { workspaceId: params.workspaceId, id: { in: payload.articles.map((item) => item.id) } },
    });
    epochs.push(await prisma.$transaction(tx => captureArtifactPermissionEpochs(actor, params.workspaceId,
      articles.map(row => ({ kind: "BrainArticle", id: row.id, fingerprint: lineageContentFingerprint("BrainArticle", row) })), tx)));
    for (const article of articles) envelopes.set(article.id, envelopeStamp(article));
    const readableIds = new Set((await release.capture("BrainArticle", articles)).records.map(row => row.id));
    const candidatePermissions = new Map(await Promise.all(payload.articles.map(async (item) => [item.id,
      Boolean(payload.candidateRoots?.[item.id]?.length
        && await release.observeRead(() => isArtifactInputProofReadable(actor, params.workspaceId, payload.candidateRoots![item.id]))),
    ] as const)));
    return { sourceId, jobId: job.id, status: job.status, phase: payload.phase,
      articles: payload.articles.flatMap((item) => {
        const candidateReadable = item.action === "regenerate" && item.remaining.length > 0
          && candidatePermissions.get(item.id)
          && item.remaining.every((root) => {
            const current = remainingById.get(root.sourceId);
            return current && readableRemaining.has(current.id)
              && brainSourceContentFingerprint(current) === root.fingerprint;
          });
        const target = articles.find((article) => article.id === item.id);
        const envelopePermits = target && !target.archivedAt && (actor.kind === "agent" || membership?.role === "ADMIN"
          || !target.isPrivate || target.ownerMemberId === membership?.id);
        if (item.action === "preserve" || !envelopePermits || (!readableIds.has(item.id) && !candidateReadable)) return [];
        // The manager may review an independent candidate for an authorized job
        // without receiving any metadata or body from its now-hidden predecessor.
        if (candidateReadable) release.add(payload.candidateRoots![item.id]);
        return [{
          id: item.id, title: readableIds.has(item.id) ? target.title : "Article unavailable", action: item.action,
          currentBodyMd: readableIds.has(item.id) ? articles.find((article) => article.id === item.id)?.bodyMd ?? null : null,
          candidateBodyMd: payload.phase === "READY" && candidateReadable ? payload.candidates?.[item.id] ?? null : null,
          candidateTitle: payload.phase === "READY" && candidateReadable ? payload.candidateTitles?.[item.id] ?? null : null,
        }];
      }),
    };
  }));
  return release.finish(entries.filter((entry): entry is NonNullable<typeof entry> => entry !== null), async tx => {
    await requireRemovalManager(actor, params.workspaceId, tx);
    for (const proof of epochs) invariant(await isArtifactPermissionEpochProofCurrent(params.workspaceId, proof, tx),
      409, "SOURCE_CHANGED", "Removal review permissions changed.");
    for (const job of jobs) {
      const current = await tx.workflowJob.findFirst({ where: { id: job.id, workspaceId: params.workspaceId, type: "agent.brain-source-regenerate" } });
      invariant(current && variantGenerationClaimStamp(current) === job.stamp, 409, "SOURCE_CHANGED", "Removal review job changed.");
    }
    for (const [id, stamp] of envelopes) {
      const current = await tx.brainArticle.findFirst({ where: { id, workspaceId: params.workspaceId },
        select: { id: true, isPrivate: true, ownerMemberId: true, archivedAt: true } });
      invariant(current && envelopeStamp(current) === stamp, 409, "SOURCE_CHANGED", "Removal review target changed.");
    }
  });
}

export async function resolveBrainSourceRemoval(actor: AppActor, params: {
  workspaceId: string; jobId: string; decision: "accept" | "reject";
}) {
  sealArtifactInputActor(actor);
  params = Object.freeze({ ...params });
  await requireRemovalManager(actor, params.workspaceId);
  return prisma.$transaction(async (tx) => {
    await requireRemovalManager(actor, params.workspaceId, tx);
    if (params.decision === "accept") {
      const completed = await findBrainSourceRemovalCompletion(actor, { workspaceId: params.workspaceId, jobId: params.jobId }, tx);
      if (completed) {
        invariant(completed.status === "applied", 409, "INVALID_REMOVAL_REQUEST", "Canonical review completion is invalid.");
        return completed;
      }
      const phases = await tx.$queryRaw<Array<{ phase: string | null }>>`SELECT payload->>'phase' AS phase
        FROM "WorkflowJob" WHERE id = ${params.jobId} AND "workspaceId" = ${params.workspaceId} AND type = 'agent.brain-source-regenerate'`;
      invariant(phases[0]?.phase !== "APPLIED", 409, "UNKNOWN_LINEAGE", "Completed review has no current canonical control receipt.");
    }
    await tx.$queryRaw`SELECT id FROM "WorkflowJob" WHERE id = ${params.jobId} AND "workspaceId" = ${params.workspaceId} FOR UPDATE`;
    const job = await tx.workflowJob.findFirst({ where: { id: params.jobId, workspaceId: params.workspaceId, type: "agent.brain-source-regenerate" } });
    invariant(job, 404, "NOT_FOUND", "Regeneration candidate not found.");
    const payload = readPayload(job.payload);
    invariant(job.status === "COMPLETED" && payload.phase === "READY", 409, "INVALID_STATE", "Candidate is not ready for review.");
    if (params.decision === "reject") {
      await tx.workflowJob.update({ where: { id: job.id }, data: { payload: { ...payload, phase: "REJECTED" } as Prisma.InputJsonObject } });
      return { status: "rejected" as const, sourceId: payload.sourceId, pendingSourceId: null };
    }
    await requireBrainSourceRemovalEnabled(tx, params.workspaceId);
    const source = await tx.brainSource.findFirst({ where: { id: payload.sourceId, workspaceId: params.workspaceId } });
    invariant(source && (source.archivedAt
      ? payload.sourceArchivedAt === source.archivedAt.toISOString()
        && payload.sourceFingerprint === brainSourceContentFingerprint(source)
      : !payload.sourceArchivedAt && (await readableBrainSourceIds(actor, params.workspaceId, [source], tx)).has(source.id)),
      409, "SOURCE_CHANGED", "The source exclusion changed; prepare a new removal request.");
    await currentPlan(tx, params.workspaceId, payload.sourceId, payload);
    const completionPlanIdentityHash = controlPlanIdentity(payload);
    const token = await prepareBrainSourceRemovalControl(actor, { workspaceId: params.workspaceId, sourceId: payload.sourceId,
      mode: "REVIEWED", jobId: job.id, planIdentityHash: completionPlanIdentityHash,
      archiveLinkedDocument: Boolean(payload.archiveDocumentId) }, tx);
    invariant(payload.candidates && payload.candidateTitles && payload.candidateRoots && payload.regenerationRunId,
      409, "INVALID_STATE", "Candidate provenance is missing.");
    const generationRun = await tx.agentRun.findFirst({ where: {
      id: payload.regenerationRunId, workspaceId: params.workspaceId,
      agentKey: "brain-source-regenerate", triggerRef: job.id, status: "COMPLETED",
    }, select: { id: true } });
    invariant(generationRun, 409, "INVALID_STATE", "Candidate provenance is invalid.");
    for (const article of payload.articles) {
      if (article.action === "preserve") {
        await preserveOriginalWithoutCitation(tx, actor, params.workspaceId, article.id, payload.sourceId);
        continue;
      }
      if (article.action === "archive") {
        await archiveWorkspaceArtifact(actor, { workspaceId: params.workspaceId, entityType: "BrainArticle", entityId: article.id,
          reason: "No verified sources remain after source removal.", _tx: tx });
        continue;
      }
      const bodyMd = payload.candidates[article.id];
      const title = payload.candidateTitles[article.id];
      const roots = payload.candidateRoots[article.id];
      invariant(roots?.length && await isArtifactInputProofReadable(actor, params.workspaceId, roots, tx),
        409, "SOURCE_CHANGED", "Candidate inputs changed before review.");
      invariant(typeof bodyMd === "string" && bodyMd.trim(), 409, "INVALID_STATE", "Candidate body is missing.");
      invariant(typeof title === "string" && title.trim(), 409, "INVALID_STATE", "Candidate title is missing.");
      const record = await tx.brainArticle.findFirst({ where: { id: article.id, workspaceId: params.workspaceId, archivedAt: null } });
      invariant(record, 409, "SOURCE_CHANGED", "Article changed before review.");
      const prior = await tx.brainArticleVersion.findFirst({ where: { articleId: record.id }, orderBy: { version: "desc" }, select: { version: true } });
      await createBrainArticleHistoryVersion({tx, workspaceId: params.workspaceId,
        article: record, version: (prior?.version ?? 0) + 1,
        reason: "REVIEWED_SOURCE_REGENERATION", preserveKnownHistory: true});
      const slug = `regenerated-${record.id}`;
      const updated = await tx.brainArticle.update({ where: { id: record.id }, data: {
        title, slug, bodyMd, type: "PROJECT", frontmatterJson: Prisma.DbNull,
        sourceIds: article.remaining.map((item) => item.sourceId),
        derivationJson: { version: 1, origin: "brain-absorb", agentRunId: generationRun.id, sources: article.remaining },
        lastVerifiedAt: new Date(),
      } });
      await recordArtifactInputLineage({ tx, actor, workspaceId: params.workspaceId,
        artifact: { kind: "BrainArticle", id: updated.id }, content: updated, origin: "DERIVED",
        inputs: [], inheritedRoots: roots,
      });
      await ensureWorkspacePermalink(tx, actor, { workspaceId: params.workspaceId,
        entityType: "BrainArticle", entityId: updated.id,
        canonicalPath: workspaceEntityCanonicalPath(params.workspaceId, "BrainArticle", updated),
      });
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${`brain_article_index:${params.workspaceId}:${record.id}`}, 0))`;
      // The reviewed body is authoritative immediately. Remove old SQL receipts
      // in the same commit; a queued index job may be paused or fail.
      await tx.knowledgeChunk.deleteMany({ where: {
        workspaceId: params.workspaceId, sourceType: "BRAIN_ARTICLE", sourceId: record.id,
      } });
      await tx.auditLog.create({ data: { workspaceId: params.workspaceId,
        actorUserId: actor.kind === "user" ? actor.user.id : null, action: "brain-article.regenerated",
        entityType: "BrainArticle", entityId: record.id, meta: { sourceId: payload.sourceId, jobId: job.id },
      } });
      await appendEvents(tx, [{ workspaceId: params.workspaceId, type: "brain-article.updated",
        aggregateType: "BrainArticle", aggregateId: record.id, payload: { articleId: record.id } }]);
      await incrementCacheVersion(`knowledge:${params.workspaceId}`, tx);
    }
    if (!source.archivedAt) await archiveWorkspaceArtifact(actor, { workspaceId: params.workspaceId, entityType: "BrainSource", entityId: payload.sourceId,
      reason: "Removed after reviewed article regeneration.", _tx: tx });
    await archiveLinkedDocumentIfResolved(tx, actor, params.workspaceId, payload.archiveDocumentId);
    const continued = payload.continuationSourceIds?.length
      ? await continueBrainSourceRemovals(tx, actor, params.workspaceId, payload.continuationSourceIds)
      : { pendingSourceId: null };
    await tx.workflowJob.update({ where: { id: job.id }, data: {
      payload: { ...payload, phase: "APPLIED", nextPendingSourceId: continued.pendingSourceId, completionPlanIdentityHash } as Prisma.InputJsonObject,
    } });
    await requireRemovalManager(actor, params.workspaceId, tx);
    const result = await commitBrainSourceRemovalCompletion(token, { actor, workspaceId: params.workspaceId, pendingSourceId: continued.pendingSourceId }, tx);
    invariant(result.status === "applied", 409, "INVALID_REMOVAL_REQUEST", "Canonical review completion is invalid.");
    return result;
  }, { maxWait: 5_000, timeout: 120_000 });
}
