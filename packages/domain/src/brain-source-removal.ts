import { createHash, randomUUID } from "node:crypto";
import { Prisma } from "@prisma/client";
import { prisma, type AppActor } from "@corgtex/shared";
import { archiveWorkspaceArtifact } from "./archive";
import { requireWorkspaceMembership } from "./auth";
import { brainSourceContentFingerprint } from "./brain-derivation";
import { findSourceArticleImpacts, readBrainArticleDerivation, sourceIdsInDerivation } from "./brain-source-impact";
import { lockActiveArticleSources, lockBrainSourceLink } from "./brain-source-links";
import { AppError, invariant } from "./errors";
import { appendEvents } from "./events";

type RemovalArticle = {
  id: string;
  slug: string;
  title: string;
  hash: string;
  action: "archive" | "regenerate";
  remaining: Array<{ sourceId: string; fingerprint: string }>;
};

type RemovalRequest = {
  version: 1;
  sourceId: string;
  sourceFingerprint: string;
  articles: RemovalArticle[];
};

type RemovalPayload = RemovalRequest & {
  phase: "REQUESTED" | "GENERATING" | "READY" | "STALE" | "REJECTED" | "APPLIED";
  generationToken?: string;
  regenerationRunId?: string;
  candidates?: Record<string, string>;
};

function hashArticle(article: {
  updatedAt: Date; title: string; type: string; authority: string; bodyMd: string;
  sourceIds: string[]; derivationJson: Prisma.JsonValue | null; humanEditedAt: Date | null; archivedAt: Date | null;
}) {
  return createHash("sha256").update(JSON.stringify([
    article.updatedAt, article.title, article.type, article.authority, article.bodyMd,
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
    request.sourceId, request.sourceFingerprint,
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

async function currentPlan(tx: Prisma.TransactionClient, workspaceId: string, sourceId: string, expected?: RemovalRequest) {
  // Discover first, then acquire source locks in one stable order. A changed
  // article set after locking is rejected, never silently omitted.
  const before = await findSourceArticleImpacts(tx, workspaceId, [sourceId]);
  const beforeIds = (before.get(sourceId)?.articles ?? []).map((article) => article.id).sort();
  const preliminary = await tx.brainArticle.findMany({
    where: { workspaceId, id: { in: beforeIds }, archivedAt: null },
  });
  const allSourceIds = [sourceId, ...preliminary.flatMap((article) => [
    ...article.sourceIds, ...sourceIdsInDerivation(article.derivationJson),
  ])];
  await lockSources(tx, allSourceIds);
  for (const id of beforeIds) {
    await tx.$queryRaw`SELECT id FROM "BrainArticle" WHERE id = ${id} AND "workspaceId" = ${workspaceId} FOR UPDATE`;
  }
  const after = await findSourceArticleImpacts(tx, workspaceId, [sourceId]);
  const links = after.get(sourceId)?.articles ?? [];
  const afterIds = links.map((article) => article.id).sort();
  invariant(JSON.stringify(beforeIds) === JSON.stringify(afterIds), 409, "SOURCE_CHANGED", "Article links changed; retry source removal.");

  const source = await tx.brainSource.findFirst({ where: { id: sourceId, workspaceId, archivedAt: null } });
  invariant(source, 404, "NOT_FOUND", "Active source not found.");
  const articles = await tx.brainArticle.findMany({ where: { workspaceId, id: { in: afterIds }, archivedAt: null } });
  invariant(articles.length === afterIds.length, 409, "SOURCE_CHANGED", "Article links changed; retry source removal.");
  const plans: RemovalArticle[] = [];
  for (const article of articles.sort((a, b) => a.id.localeCompare(b.id))) {
    const link = links.find((item) => item.id === article.id);
    const derivation = readBrainArticleDerivation(article.derivationJson);
    const explicitIds = new Set(derivation?.sources.map((item) => item.sourceId) ?? []);
    invariant(link?.kind === "derived" && derivation && explicitIds.has(sourceId)
      && article.sourceIds.every((id) => explicitIds.has(id))
      && derivation.sources.every((item) => article.sourceIds.includes(item.sourceId)),
    409, "UNCLASSIFIED_SOURCE_LINK", "An article has a source link with unknown provenance; resolve it manually.");
    const remaining = derivation.sources.filter((item) => item.sourceId !== sourceId);
    plans.push({
      id: article.id, slug: article.slug, title: article.title, hash: hashArticle(article),
      action: remaining.length > 0 ? "regenerate" : "archive", remaining,
    });
  }
  if (plans.length > 0) {
    invariant(source.accessDomain === "WORKSPACE", 409, "RESTRICTED_SOURCE", "Restricted sources require manual review.");
  }
  const remainingIds = [...new Set(plans.flatMap((article) => article.remaining.map((item) => item.sourceId)))];
  // The preliminary read must have covered every remaining source lock.
  invariant(remainingIds.every((id) => allSourceIds.includes(id)), 409, "SOURCE_CHANGED", "Source links changed; retry removal.");
  await lockActiveArticleSources(tx, workspaceId, remainingIds);
  const remainingSources = await tx.brainSource.findMany({ where: { workspaceId, id: { in: remainingIds }, archivedAt: null } });
  invariant(remainingSources.length === remainingIds.length, 409, "SOURCE_CHANGED", "A remaining source is unavailable.");
  invariant(remainingSources.every((item) => item.accessDomain === "WORKSPACE"),
    409, "RESTRICTED_SOURCE", "Restricted sources require manual review.");
  const fingerprints = new Map(remainingSources.map((item) => [item.id, brainSourceContentFingerprint(item)]));
  for (const article of plans) {
    article.remaining = article.remaining.map((item) => ({ sourceId: item.sourceId, fingerprint: fingerprints.get(item.sourceId)! }));
  }
  const plan: RemovalRequest = {
    version: 1, sourceId, sourceFingerprint: brainSourceContentFingerprint(source), articles: plans,
  };
  if (expected) invariant(requestMatches(plan, expected), 409, "SOURCE_CHANGED", "Sources or articles changed; prepare a new candidate.");
  return plan;
}

async function requireRemovalManager(actor: AppActor, workspaceId: string) {
  const membership = await requireWorkspaceMembership({ actor, workspaceId, allowedRoles: ["ADMIN"] });
  invariant(actor.kind === "agent" || membership?.role === "ADMIN", 403, "FORBIDDEN", "Workspace admin access is required.");
}

async function latestRemovalJob(tx: Prisma.TransactionClient | typeof prisma, workspaceId: string, sourceId: string) {
  return tx.workflowJob.findFirst({
    where: { workspaceId, type: "agent.brain-source-regenerate", payload: { path: ["sourceId"], equals: sourceId } },
    orderBy: { createdAt: "desc" },
  });
}

export async function requestBrainSourceRemoval(actor: AppActor, params: { workspaceId: string; sourceId: string }) {
  await requireWorkspaceMembership({ actor, workspaceId: params.workspaceId });
  return prisma.$transaction(async (tx) => {
    const existingSource = await tx.brainSource.findFirst({ where: { id: params.sourceId, workspaceId: params.workspaceId } });
    invariant(existingSource, 404, "NOT_FOUND", "Source not found.");
    if (existingSource.archivedAt) return { id: existingSource.id, status: "archived" as const };
    const plan = await currentPlan(tx, params.workspaceId, params.sourceId);
    if (plan.articles.length > 0) await requireRemovalManager(actor, params.workspaceId);
    if (plan.articles.every((article) => article.action === "archive")) {
      for (const article of plan.articles) {
        await archiveWorkspaceArtifact(actor, {
          workspaceId: params.workspaceId, entityType: "BrainArticle", entityId: article.id,
          reason: "No verified sources remain after source removal.", _tx: tx,
        });
      }
      await archiveWorkspaceArtifact(actor, {
        workspaceId: params.workspaceId, entityType: "BrainSource", entityId: params.sourceId,
        reason: "Removed after linked articles were archived.", _tx: tx,
      });
      return { id: params.sourceId, status: "archived" as const };
    }
    const latest = await latestRemovalJob(tx, params.workspaceId, params.sourceId);
    if (latest) {
      const payload = readPayload(latest.payload);
      if (requestMatches(plan, payload) && (latest.status === "PENDING" || latest.status === "RUNNING"
        || (latest.status === "COMPLETED" && (payload.phase === "READY" || payload.phase === "APPLIED")))) {
        return { id: params.sourceId, status: "pending" as const, jobId: latest.id };
      }
    }
    const job = await tx.workflowJob.create({ data: {
      workspaceId: params.workspaceId, type: "agent.brain-source-regenerate",
      dedupeKey: `brain-source-removal:${params.workspaceId}:${params.sourceId}:${randomUUID()}`,
      payload: { ...plan, phase: "REQUESTED" } as Prisma.InputJsonObject,
    } });
    return { id: params.sourceId, status: "pending" as const, jobId: job.id };
  }, { maxWait: 5_000, timeout: 120_000 });
}

export async function generateBrainSourceRemovalCandidate(params: {
  workspaceId: string;
  jobId: string;
  expectedAttempt: number;
  expectedOwner: string | null;
  generate: (article: { id: string; title: string }, sources: Array<{ id: string; title: string | null; content: string }>) => Promise<string>;
}) {
  const claim = await prisma.$transaction(async (tx) => {
    await tx.$queryRaw`SELECT id FROM "WorkflowJob" WHERE id = ${params.jobId} AND "workspaceId" = ${params.workspaceId} FOR UPDATE`;
    const job = await tx.workflowJob.findFirst({ where: { id: params.jobId, workspaceId: params.workspaceId, type: "agent.brain-source-regenerate" } });
    invariant(job, 404, "NOT_FOUND", "Regeneration job not found.");
    const payload = readPayload(job.payload);
    if (job.status !== "RUNNING" || job.attempts !== params.expectedAttempt || job.lockedBy !== params.expectedOwner) {
      return { done: "SUPERSEDED" } as const;
    }
    if (payload.phase !== "REQUESTED" && payload.phase !== "GENERATING") return { done: payload.phase } as const;
    const token = randomUUID();
    await tx.workflowJob.update({ where: { id: job.id }, data: {
      payload: { ...payload, phase: "GENERATING", generationToken: token } as Prisma.InputJsonObject,
    } });
    return { payload, token, attempts: job.attempts } as const;
  });
  if ("done" in claim) return { phase: claim.done };
  const { payload, token, attempts } = claim;

  const finish = async (candidates: Record<string, string> | null) => prisma.$transaction(async (tx) => {
    await tx.$queryRaw`SELECT id FROM "WorkflowJob" WHERE id = ${params.jobId} AND "workspaceId" = ${params.workspaceId} FOR UPDATE`;
    const current = await tx.workflowJob.findFirst({ where: { id: params.jobId, workspaceId: params.workspaceId, type: "agent.brain-source-regenerate" } });
    invariant(current, 404, "NOT_FOUND", "Regeneration job not found.");
    const livePayload = readPayload(current.payload);
    if (current.status !== "RUNNING" || current.attempts !== attempts || current.lockedBy !== params.expectedOwner
      || livePayload.phase !== "GENERATING" || livePayload.generationToken !== token) {
      return { phase: "SUPERSEDED" as const };
    }
    let stale = candidates === null;
    if (!stale) {
      try {
        await currentPlan(tx, params.workspaceId, payload.sourceId, payload);
      } catch (error) {
        if (!(error instanceof AppError) || !["SOURCE_CHANGED", "NOT_FOUND", "UNCLASSIFIED_SOURCE_LINK", "RESTRICTED_SOURCE"].includes(error.code)) throw error;
        stale = true;
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
      payload: { ...payload, phase: "READY", candidates, regenerationRunId: run.id } as Prisma.InputJsonObject,
    } });
    return { phase: "READY" as const, candidateCount: Object.keys(candidates!).length };
  });

  try {
    await prisma.$transaction((tx) => currentPlan(tx, params.workspaceId, payload.sourceId, payload));
  } catch (error) {
    if (!(error instanceof AppError) || !["SOURCE_CHANGED", "NOT_FOUND", "UNCLASSIFIED_SOURCE_LINK", "RESTRICTED_SOURCE"].includes(error.code)) throw error;
    return finish(null);
  }
  const candidates: Record<string, string> = {};
  for (const article of payload.articles.filter((item) => item.action === "regenerate")) {
    const ids = article.remaining.map((item) => item.sourceId);
    const sources = await prisma.brainSource.findMany({
      where: { workspaceId: params.workspaceId, id: { in: ids }, archivedAt: null },
      select: { id: true, title: true, content: true },
    });
    invariant(sources.length === ids.length, 409, "SOURCE_CHANGED", "A remaining source changed before regeneration.");
    const bodyMd = (await params.generate({ id: article.id, title: article.title }, sources)).trim();
    invariant(bodyMd.length > 0 && bodyMd.length <= 100_000, 422, "INVALID_CANDIDATE", "Regeneration produced an invalid candidate.");
    candidates[article.id] = bodyMd;
  }
  return finish(candidates);
}

export async function listBrainSourceRemovalReviews(actor: AppActor, params: { workspaceId: string; sourceIds: string[] }) {
  await requireRemovalManager(actor, params.workspaceId);
  const entries = await Promise.all(params.sourceIds.map(async (sourceId) => {
    const job = await latestRemovalJob(prisma, params.workspaceId, sourceId);
    if (!job) return null;
    const payload = readPayload(job.payload);
    const articles = await prisma.brainArticle.findMany({
      where: { workspaceId: params.workspaceId, id: { in: payload.articles.map((item) => item.id) } },
      select: { id: true, bodyMd: true },
    });
    return { sourceId, jobId: job.id, status: job.status, phase: payload.phase,
      articles: payload.articles.map((item) => ({
        id: item.id, title: item.title, action: item.action,
        currentBodyMd: articles.find((article) => article.id === item.id)?.bodyMd ?? null,
        candidateBodyMd: payload.phase === "READY" ? payload.candidates?.[item.id] ?? null : null,
      })),
    };
  }));
  return entries.filter((entry): entry is NonNullable<typeof entry> => entry !== null);
}

export async function resolveBrainSourceRemoval(actor: AppActor, params: {
  workspaceId: string; jobId: string; decision: "accept" | "reject";
}) {
  await requireRemovalManager(actor, params.workspaceId);
  return prisma.$transaction(async (tx) => {
    await tx.$queryRaw`SELECT id FROM "WorkflowJob" WHERE id = ${params.jobId} AND "workspaceId" = ${params.workspaceId} FOR UPDATE`;
    const job = await tx.workflowJob.findFirst({ where: { id: params.jobId, workspaceId: params.workspaceId, type: "agent.brain-source-regenerate" } });
    invariant(job, 404, "NOT_FOUND", "Regeneration candidate not found.");
    const payload = readPayload(job.payload);
    if (payload.phase === "APPLIED" && params.decision === "accept") return { status: "applied" as const, sourceId: payload.sourceId };
    invariant(job.status === "COMPLETED" && payload.phase === "READY", 409, "INVALID_STATE", "Candidate is not ready for review.");
    if (params.decision === "reject") {
      await tx.workflowJob.update({ where: { id: job.id }, data: { payload: { ...payload, phase: "REJECTED" } as Prisma.InputJsonObject } });
      return { status: "rejected" as const, sourceId: payload.sourceId };
    }
    await currentPlan(tx, params.workspaceId, payload.sourceId, payload);
    invariant(payload.candidates && payload.regenerationRunId, 409, "INVALID_STATE", "Candidate provenance is missing.");
    const generationRun = await tx.agentRun.findFirst({ where: {
      id: payload.regenerationRunId, workspaceId: params.workspaceId,
      agentKey: "brain-source-regenerate", triggerRef: job.id, status: "COMPLETED",
    }, select: { id: true } });
    invariant(generationRun, 409, "INVALID_STATE", "Candidate provenance is invalid.");
    for (const article of payload.articles) {
      if (article.action === "archive") {
        await archiveWorkspaceArtifact(actor, { workspaceId: params.workspaceId, entityType: "BrainArticle", entityId: article.id,
          reason: "No verified sources remain after source removal.", _tx: tx });
        continue;
      }
      const bodyMd = payload.candidates[article.id];
      invariant(typeof bodyMd === "string" && bodyMd.trim(), 409, "INVALID_STATE", "Candidate body is missing.");
      const record = await tx.brainArticle.findFirst({ where: { id: article.id, workspaceId: params.workspaceId, archivedAt: null } });
      invariant(record, 409, "SOURCE_CHANGED", "Article changed before review.");
      const derivation = readBrainArticleDerivation(record.derivationJson);
      invariant(derivation, 409, "SOURCE_CHANGED", "Article provenance changed before review.");
      const prior = await tx.brainArticleVersion.findFirst({ where: { articleId: record.id }, orderBy: { version: "desc" }, select: { version: true } });
      await tx.brainArticleVersion.create({ data: {
        articleId: record.id, version: (prior?.version ?? 0) + 1, bodyMd: record.bodyMd,
        changeSummary: "Previous body before reviewed source regeneration.",
      } });
      await tx.brainArticle.update({ where: { id: record.id }, data: {
        bodyMd, sourceIds: record.sourceIds.filter((id) => id !== payload.sourceId),
        derivationJson: { ...derivation, agentRunId: generationRun.id, sources: article.remaining },
        lastVerifiedAt: new Date(),
      } });
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${`brain_article_index:${params.workspaceId}:${record.id}`}, 0))`;
      await tx.auditLog.create({ data: { workspaceId: params.workspaceId,
        actorUserId: actor.kind === "user" ? actor.user.id : null, action: "brain-article.regenerated",
        entityType: "BrainArticle", entityId: record.id, meta: { sourceId: payload.sourceId, jobId: job.id },
      } });
      await appendEvents(tx, [{ workspaceId: params.workspaceId, type: "brain-article.updated",
        aggregateType: "BrainArticle", aggregateId: record.id, payload: { articleId: record.id } }]);
    }
    await archiveWorkspaceArtifact(actor, { workspaceId: params.workspaceId, entityType: "BrainSource", entityId: payload.sourceId,
      reason: "Removed after reviewed article regeneration.", _tx: tx });
    await tx.workflowJob.update({ where: { id: job.id }, data: { payload: { ...payload, phase: "APPLIED" } as Prisma.InputJsonObject } });
    return { status: "applied" as const, sourceId: payload.sourceId };
  }, { maxWait: 5_000, timeout: 120_000 });
}
