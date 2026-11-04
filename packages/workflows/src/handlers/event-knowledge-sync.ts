import { currentEventKnowledgeSyncLease, withEventKnowledgeSyncLease, type EventKnowledgeSyncClaim } from "./event-knowledge-sync-lease";
export type { EventKnowledgeSyncClaim } from "./event-knowledge-sync-lease";
import { createHash } from "node:crypto";
import type { Prisma } from "@prisma/client";
import { getSharedStateBackend, prisma } from "@corgtex/shared";
import { getKnowledgeSearchProvider, invalidateKnowledgeCache, isAzureKnowledgeSearchConfigured,
  syncAzureKnowledgeSource, syncDocumentKnowledge, syncKnowledgeForSource,
  type AzureKnowledgeAttemptControls } from "@corgtex/knowledge";
import { invariant } from "../../../domain/src/errors";

type Db = typeof prisma | Prisma.TransactionClient;
// Payload JSONB ordering is not part of the claim identity.
function stable(value: unknown): unknown {
  if (value instanceof Date) return value.toISOString();
  if (Array.isArray(value)) return value.map(stable);
  if (value && typeof value === "object") return Object.fromEntries(Object.entries(value).sort(([a], [b]) => a.localeCompare(b)).map(([key, item]) => [key, stable(item)]));
  return value;
}
const stamp = (value: unknown) => createHash("sha256").update(JSON.stringify(stable(value))).digest("hex");
const eventSelect = { id: true, workspaceId: true, type: true, aggregateType: true, aggregateId: true, createdAt: true } as const;
const flowSelect = { id: true, workspaceId: true, subjectType: true, subjectId: true } as const;
const pulseTypes: Record<string, string> = {
  "proposal.submitted": "Proposal", "proposal.opened": "Proposal", "proposal.approved": "Proposal",
  "document.created": "Document", "meeting.created": "Meeting", "meeting.transcript-uploaded": "Meeting",
  "approval.finalized": "ApprovalFlow",
};

/** Events are routing/control records, never content authority for their arbitrary payload. */
export async function handleEventKnowledgeSync(jobId: string, payload: { eventId?: string }, workspaceId: string,
  originalClaim: EventKnowledgeSyncClaim) {
  return withEventKnowledgeSyncLease(originalClaim, () => syncEvent(jobId, payload, workspaceId, originalClaim));
}

async function syncEvent(jobId: string, payload: {eventId?: string}, workspaceId: string, originalClaim: EventKnowledgeSyncClaim) {
  const claim = structuredClone(originalClaim);
  const lease = currentEventKnowledgeSyncLease(claim);
  const recipe = claim.payload && typeof claim.payload === "object" && !Array.isArray(claim.payload)
    ? claim.payload as Record<string, unknown> : {};
  invariant(payload.eventId && claim.id === jobId && claim.workspaceId === workspaceId
    && claim.type === "knowledge.sync.event" && recipe.eventId === payload.eventId,
  409, "SOURCE_CHANGED", "Event indexing requires its original claimed recipe.");
  const eventId = payload.eventId;
  const event = await prisma.event.findFirst({ where: { id: eventId, workspaceId }, select: eventSelect });
  invariant(event, 404, "NOT_FOUND", "Event indexing source is unavailable.");
  // Explicit selects deliberately exclude Event.payload, including from all replays.
  const eventStamp = stamp(event);
  const controller = new AbortController();
  const signal = AbortSignal.any([controller.signal, lease.signal]);
  let flow: Awaited<ReturnType<typeof loadFlow>> | undefined;
  async function loadFlow(db: Db = prisma) {
    return db.approvalFlow.findFirst({ where: { id: event!.aggregateId ?? "", workspaceId }, select: flowSelect });
  }
  const checkCurrent = async (transaction?: Prisma.TransactionClient) => {
    const db = transaction ?? prisma;
    signal.throwIfAborted();
    try {
      if (transaction) {
        lease.assertTransactionOwner();
        await transaction.$queryRaw`SELECT id FROM "WorkflowJob" WHERE id=${jobId} AND "workspaceId"=${workspaceId} FOR SHARE`;
        await transaction.$queryRaw`SELECT id FROM "Event" WHERE id=${eventId} AND "workspaceId"=${workspaceId} FOR SHARE`;
        if (flow) await transaction.$queryRaw`SELECT id FROM "ApprovalFlow" WHERE id=${flow.id} AND "workspaceId"=${workspaceId} FOR SHARE`;
      }
      const currentEvent = await db.event.findFirst({ where: { id: eventId, workspaceId }, select: eventSelect });
      invariant(currentEvent && stamp(currentEvent) === eventStamp, 409, "SOURCE_CHANGED", "Event routing changed during indexing.");
      if (flow) invariant(stamp(await loadFlow(db)) === stamp(flow), 409, "SOURCE_CHANGED", "Event approval target changed during indexing.");
      // Read the live claim last, including freshness after all other awaits.
      const job = await db.workflowJob.findFirst({ where: { id: jobId, workspaceId } });
      lease.assertCurrentRow(job);
      invariant(job?.status === "RUNNING",
      409, "SOURCE_CHANGED", "Event indexing claim expired or changed.");
      signal.throwIfAborted();
    } catch (error) { controller.abort(error); throw error; }
  };
  const assertCurrent = (tx?: Prisma.TransactionClient) => tx ? checkCurrent(tx) : lease.readGuard(() => checkCurrent());
  await assertCurrent();

  // Retire only derived EVENT copies, even when their former aggregate is now
  // archived or denied. This control grant never admits old event payload bytes.
  await lease.sourceTransactionGuard(() => prisma.$transaction(async tx => {
    await assertCurrent(tx);
    await tx.knowledgeChunk.deleteMany({ where: { workspaceId, sourceType: "EVENT", sourceId: eventId } });
    if (getSharedStateBackend() === "postgres") await invalidateKnowledgeCache(workspaceId, tx);
    await assertCurrent(tx);
  }));
  const cleanupControls: AzureKnowledgeAttemptControls = {
    signal,
    authorizeAttempt: async ({ signal }) => {
      try { signal.throwIfAborted(); await assertCurrent(); signal.throwIfAborted(); }
      catch (error) { controller.abort(error); throw error; }
    },
  };
  if (getKnowledgeSearchProvider() === "azure") invariant(isAzureKnowledgeSearchConfigured("admin"),
    503, "KNOWLEDGE_INDEX_UNAVAILABLE", "Azure indexing cleanup is not configured.");
  await syncAzureKnowledgeSource({ workspaceId, sourceType: "EVENT", sourceId: eventId, chunks: [] }, cleanupControls);
  signal.throwIfAborted();
  await assertCurrent();
  if (getSharedStateBackend() !== "postgres") await invalidateKnowledgeCache(workspaceId);

  invariant(event.aggregateId && pulseTypes[event.type] === event.aggregateType,
    409, "EVENT_KNOWLEDGE_TARGET_UNSUPPORTED", "Event indexing requires a supported canonical aggregate.");
  let kind = event.aggregateType;
  let id = event.aggregateId;
  if (kind === "ApprovalFlow") {
    flow = await loadFlow();
    invariant(flow?.subjectType === "PROPOSAL", 409, "EVENT_KNOWLEDGE_TARGET_UNSUPPORTED", "Event approval target is unavailable.");
    kind = "Proposal";
    id = flow.subjectId;
    await assertCurrent();
  }
  const row = kind === "Proposal" ? await prisma.proposal.findFirst({ where: { id, workspaceId, archivedAt: null } })
    : kind === "Meeting" ? await prisma.meeting.findFirst({ where: { id, workspaceId, archivedAt: null } })
      : await prisma.document.findFirst({ where: { id, workspaceId, archivedAt: null } });
  await assertCurrent();
  if (!row) return { retiredEventCopies: true, canonical: "UNAVAILABLE" as const };
  let indexed: number;
  if (kind === "Document") {
    indexed = await syncDocumentKnowledge({ workspaceId, documentId: id, workflowJobId: jobId, sourceGuard: assertCurrent, sourceTransactionGuard: lease.sourceTransactionGuard });
  } else {
    const source = row as unknown as Record<string, unknown>;
    const content = (kind === "Proposal" ? [source.title, source.summary, source.bodyMd]
      : [source.title, source.summaryMd, source.transcript]).filter(Boolean).join("\n\n");
    indexed = await syncKnowledgeForSource({ workspaceId, sourceType: kind === "Proposal" ? "PROPOSAL" : "MEETING",
      accessDomain: "WORKSPACE", sourceId: id, sourceTitle: row.title, content, sourceUpdatedAt: row.updatedAt,
      workflowJobId: jobId, sourceGuard: assertCurrent, sourceTransactionGuard: lease.sourceTransactionGuard });
  }
  signal.throwIfAborted();
  await assertCurrent();
  invariant(indexed > 0, 409, "SOURCE_CHANGED", "Event canonical source could not be safely indexed.");
  return { retiredEventCopies: true, canonical: kind, indexed };
}
