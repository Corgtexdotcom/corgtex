import { createHash } from "node:crypto";
import type { BrainSource, Prisma } from "@prisma/client";
import { prisma, type AppActor } from "@corgtex/shared";
import { resolveKnowledgeAccessDomains } from "./brain-access";
import { invariant } from "./errors";

type RecoverySource = Pick<BrainSource, "id" | "workspaceId" | "accessDomain" | "sourceType" | "tier" | "title" | "channel" | "content" | "ingestionGuidanceMd" | "absorbedAt" | "archivedAt" | "createdAt">;
const sourceSelect = { id: true, workspaceId: true, accessDomain: true, sourceType: true, tier: true, title: true, channel: true, content: true, ingestionGuidanceMd: true, absorbedAt: true, archivedAt: true, createdAt: true } as const;
const jobSelect = { id: true, type: true, status: true, eventId: true, dedupeKey: true, payload: true } as const;
const recoveryEventTypes = ["brain-article.created", "brain-article.updated", "brain-article.published", "agent.run.completed", "agent.run.waiting_approval", "agent.run.failed"];

// An opaque evidence token, not a content checksum exposed as diagnostic telemetry.
export function brainSourceRecoveryIdentity(source: RecoverySource) {
  return createHash("sha256").update(JSON.stringify([
    "brain-source-recovery-v1", source.id, source.workspaceId, source.accessDomain,
    source.sourceType, source.tier, source.title, source.channel, source.content,
    source.ingestionGuidanceMd, source.absorbedAt, source.archivedAt, source.createdAt,
  ])).digest("hex");
}

function requireRecoverySupport(actor: AppActor, write: boolean) {
  const scopes = ["support:write", "brain:read", "runtime:read", ...(write ? ["runtime:write"] : [])];
  invariant(actor.kind === "agent" && scopes.every((scope) => actor.scopes?.includes(scope)), 403, "FORBIDDEN", "Scoped support credentials are required for source recovery.");
}

async function sourceEvidence(tx: Prisma.TransactionClient, source: RecoverySource) {
  const [events, jobs, articleCount, matchingWebhookCount, priorRunCount] = await Promise.all([
    tx.event.findMany({ where: { workspaceId: source.workspaceId, type: "brain-source.created", OR: [{ aggregateId: source.id }, { payload: { path: ["sourceId"], equals: source.id } }] }, select: { id: true, status: true, aggregateId: true, aggregateType: true, payload: true }, take: 2 }),
    tx.workflowJob.findMany({ where: { workspaceId: source.workspaceId, type: { in: ["agent.brain-absorb", "agent.company-understanding"] }, OR: [{ payload: { path: ["sourceId"], equals: source.id } }, { event: { aggregateId: source.id, workspaceId: source.workspaceId } }] }, select: jobSelect, take: 20 }),
    tx.brainArticle.count({ where: { workspaceId: source.workspaceId, sourceIds: { has: source.id } } }),
    tx.webhookEndpoint.count({ where: { workspaceId: source.workspaceId, status: "ACTIVE", OR: [{ eventTypes: { isEmpty: true } }, { eventTypes: { hasSome: recoveryEventTypes } }] } }),
    tx.agentRun.count({ where: { workspaceId: source.workspaceId, agentKey: "brain-absorb", OR: [{ planJson: { path: ["payload", "sourceId"], equals: source.id } }, { steps: { some: { inputJson: { path: ["sourceId"], equals: source.id } } } }, { toolCalls: { some: { inputJson: { path: ["sourceId"], equals: source.id } } } }] } }),
  ]);
  const original = events.length === 1 ? events[0] : null;
  const payload = original?.payload as Record<string, unknown> | undefined;
  // Ordinary absorption publishes into WORKSPACE knowledge. Do not use this
  // recovery path to move restricted sources across that information boundary.
  const blockReason = source.archivedAt ? "archived"
    : source.absorbedAt ? "already_absorbed"
      : source.accessDomain !== "WORKSPACE" ? "restricted_source"
        : !source.content.trim() ? "empty_content"
          : articleCount > 0 ? "existing_output"
            : events.length > 1 ? "ambiguous_source_events"
              : original && (original.status !== "DISPATCHED" || original.aggregateType !== "BrainSource" || original.aggregateId !== source.id || payload?.sourceId !== source.id) ? "source_event_not_settled"
                : jobs.length > 0 || priorRunCount > 0 ? "existing_counterpart"
                  : matchingWebhookCount > 0 ? "outbound_subscriptions" : null;
  return { events, jobs, articleCount, priorRunCount, matchingWebhookCount, blockReason, original };
}

export async function listBrainSourceRecovery(actor: AppActor, params: { workspaceId: string; sourceId?: string; take?: number; skip?: number }) {
  requireRecoverySupport(actor, false);
  const accessDomains = await resolveKnowledgeAccessDomains(actor, params.workspaceId);
  const take = Math.max(1, Math.min(25, Math.floor(params.take ?? 25)));
  const skip = Math.max(0, Math.floor(params.skip ?? 0));
  const where = { workspaceId: params.workspaceId, accessDomain: { in: accessDomains }, ...(params.sourceId ? { id: params.sourceId } : { absorbedAt: null, archivedAt: null }) };
  const [sources, total, activeJobs] = await Promise.all([
    prisma.brainSource.findMany({ where, select: sourceSelect, take, skip, orderBy: [{ createdAt: "asc" }, { id: "asc" }] }),
    prisma.brainSource.count({ where }),
    prisma.workflowJob.count({ where: { workspaceId: params.workspaceId, status: { in: ["PENDING", "RUNNING"] } } }),
  ]);
  const items = await Promise.all(sources.map(async (source) => {
    const evidence = await sourceEvidence(prisma, source);
    return {
      id: source.id, sourceType: source.sourceType, tier: source.tier, accessDomain: source.accessDomain,
      createdAt: source.createdAt, absorbedAt: source.absorbedAt, archivedAt: source.archivedAt,
      contentLength: source.content.length, sourceIdentity: brainSourceRecoveryIdentity(source),
      events: evidence.events.map(({ id, status }) => ({ id, status })),
      jobs: evidence.jobs.map(({ id, type, status }) => ({ id, type, status })),
      articleCount: evidence.articleCount, priorRunCount: evidence.priorRunCount, matchingWebhookCount: evidence.matchingWebhookCount,
      blockReason: evidence.blockReason ?? (activeJobs > 0 ? "runtime_not_quiet" : null),
    };
  }));
  return { items, total, take, skip, activeJobs };
}

export async function reconcileBrainSource(actor: AppActor, params: { workspaceId: string; sourceId: string; expectedSourceIdentity: string; reason: string }) {
  requireRecoverySupport(actor, true);
  const accessDomains = await resolveKnowledgeAccessDomains(actor, params.workspaceId);
  invariant(/^[a-f0-9]{64}$/.test(params.expectedSourceIdentity), 400, "INVALID_INPUT", "A caller-observed source identity is required.");
  const reason = params.reason.trim();
  invariant(reason.length > 0 && reason.length <= 1000, 400, "INVALID_INPUT", "A bounded support reason is required.");
  return prisma.$transaction(async (tx) => {
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${`brain_source_recovery:${params.workspaceId}`}, 0))`;
    await tx.$queryRaw`SELECT id FROM "BrainSource" WHERE id = ${params.sourceId} AND "workspaceId" = ${params.workspaceId} FOR UPDATE`;
    const source = await tx.brainSource.findFirst({ where: { id: params.sourceId, workspaceId: params.workspaceId, accessDomain: { in: accessDomains } }, select: sourceSelect });
    invariant(source, 404, "NOT_FOUND", "Source not found.");
    const evidence = await sourceEvidence(tx, source);
    const prior = evidence.jobs.find((job) => {
      const payload = job.payload as Record<string, unknown>;
      return job.type === "agent.brain-absorb" && payload.supportRecovery === true && payload.expectedSourceIdentity === params.expectedSourceIdentity;
    });
    if (prior) return { id: prior.id, status: prior.status, sourceId: source.id, eventId: prior.eventId, created: false };
    invariant(brainSourceRecoveryIdentity(source) === params.expectedSourceIdentity, 409, "SOURCE_CHANGED", "Source changed; refresh recovery evidence.");
    invariant(!evidence.blockReason, 409, "RECOVERY_NOT_ELIGIBLE", `Source recovery blocked: ${evidence.blockReason}.`);
    const activeJobs = await tx.workflowJob.count({ where: { workspaceId: params.workspaceId, status: { in: ["PENDING", "RUNNING"] } } });
    invariant(activeJobs === 0, 409, "RUNTIME_NOT_QUIET", "Drain active runtime work before source recovery.");
    const eventId = evidence.original?.id ?? null;
    const dedupeKey = eventId ? `${eventId}:brain-absorb` : `brain-source-recovery:${params.workspaceId}:${source.id}`;
    const occupiedKey = await tx.workflowJob.findUnique({ where: { dedupeKey }, select: { id: true } });
    invariant(!occupiedKey, 409, "RECOVERY_IDENTITY_CONFLICT", "Recovery key already belongs to a different processing attempt.");
    const job = await tx.workflowJob.create({
      data: { workspaceId: params.workspaceId, eventId, type: "agent.brain-absorb", dedupeKey, payload: { sourceId: source.id, expectedSourceIdentity: params.expectedSourceIdentity, supportRecovery: true } },
      select: { id: true, status: true },
    });
    await tx.auditLog.create({ data: {
      workspaceId: params.workspaceId, actorUserId: null, action: "brain-source.reconciled", entityType: "BrainSource", entityId: source.id,
      meta: { actorLabel: actor.kind === "agent" ? actor.label ?? "Corgtex Support" : "Corgtex Support", reason, workflowJobId: job.id, originalEventId: eventId, provenance: eventId ? "existing_event" : "source_without_event" },
    } });
    return { ...job, sourceId: source.id, eventId, created: true };
  });
}

// Called only by the trusted worker, before agent runtime/budget/model activity.
// This is a fresh admission check, not a persistent pause of other producers.
export async function assertBrainSourceRecoveryJob(params: { workspaceId: string; sourceId: string; workflowJobId: string; expectedSourceIdentity: string }) {
  const source = await prisma.brainSource.findFirst({ where: { id: params.sourceId, workspaceId: params.workspaceId }, select: sourceSelect });
  invariant(source && brainSourceRecoveryIdentity(source) === params.expectedSourceIdentity, 409, "SOURCE_CHANGED", "Source changed; refresh recovery evidence.");
  const evidence = await sourceEvidence(prisma, source);
  const ownJob = evidence.jobs.find((job) => job.id === params.workflowJobId);
  invariant(ownJob?.type === "agent.brain-absorb", 409, "RECOVERY_NOT_ELIGIBLE", "Recovery job does not match source.");
  const otherJobs = evidence.jobs.filter((job) => job.id !== params.workflowJobId);
  invariant(otherJobs.length === 0 && evidence.priorRunCount === 0, 409, "RECOVERY_NOT_ELIGIBLE", "Source has another processing attempt.");
  invariant(!evidence.blockReason || evidence.blockReason === "existing_counterpart", 409, "RECOVERY_NOT_ELIGIBLE", "Source is no longer eligible for recovery.");
  invariant(evidence.matchingWebhookCount === 0, 409, "RECOVERY_NOT_ELIGIBLE", "Outbound subscriptions changed before recovery execution.");
}
