import { createHash } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import { Prisma, type WorkflowJob } from "@prisma/client";
import { prisma, toInputJson } from "@corgtex/shared";
import { invariant } from "@corgtex/domain";
import { MAINTENANCE_PAGE_SIZE, MAINTENANCE_PHASES, type MaintenanceState } from "../../agents/src/brain-maintenance-state";

export const BRAIN_MAINTENANCE_JOB = "agent.brain-maintenance";
export class MaintenanceDeferred extends Error {
  constructor(readonly reason: string) { super(`Brain maintenance deferred: ${reason}`); }
}
export type MaintenanceClaimedJob = {id: string; workspaceId: string | null; type: string; payload: unknown; attempts?: number; lockedAt?: Date | null};
type Envelope = {request: MaintenanceState; completion?: {next: MaintenanceState | null; dedupeKey: string | null}};
const isRecord = (value: unknown): value is Record<string, unknown> => !!value && typeof value === "object" && !Array.isArray(value);
function envelope(payload: unknown): Envelope | null {
  if (!isRecord(payload) || payload.maintenance === undefined) return null;
  const value = payload.maintenance;
  invariant(isRecord(value) && isRecord(value.request), 409, "MAINTENANCE_STATE_INVALID", "Maintenance state is invalid.");
  const request = value.request;
  invariant(request.version === 1 && typeof request.cohortId === "string" && typeof request.admittedAt === "string"
    && Number.isFinite(Date.parse(request.admittedAt)) && MAINTENANCE_PHASES.includes(request.phase as MaintenanceState["phase"])
    && (request.upperId === null || typeof request.upperId === "string") && (request.afterId === null || typeof request.afterId === "string")
    && Array.isArray(request.selectedIds) && request.selectedIds.length <= MAINTENANCE_PAGE_SIZE
    && request.selectedIds.every(id => typeof id === "string") && new Set(request.selectedIds).size === request.selectedIds.length
    && typeof request.pageComplete === "boolean" && (request.pageLastId === null || typeof request.pageLastId === "string")
    && typeof request.index === "number" && Number.isInteger(request.index) && request.index >= 0 && request.index <= request.selectedIds.length,
  409, "MAINTENANCE_STATE_INVALID", "Maintenance request is invalid.");
  if (request.source !== undefined) {
    const source = request.source;
    invariant(request.phase === "LINKS" && isRecord(source) && source.id === request.selectedIds[request.index as number]
      && Array.isArray(source.original) && source.original.length > 0
      && typeof source.refOffset === "number" && Number.isSafeInteger(source.refOffset) && source.refOffset >= 0
      && ["REFERENCES", "CLEANUP"].includes(String(source.stage))
      && (source.edgeAfterId === undefined || typeof source.edgeAfterId === "string")
      && (source.lookup === undefined || (isRecord(source.lookup) && [0, 1, 2, 3].includes(Number(source.lookup.priority))
        && typeof source.lookup.priority === "number" && (source.lookup.afterId === undefined || typeof source.lookup.afterId === "string"))),
    409, "MAINTENANCE_STATE_INVALID", "Article continuation is invalid.");
  }
  if (request.comment !== undefined) {
    const comment = request.comment;
    invariant(request.phase === "DISCUSSIONS" && isRecord(comment) && comment.threadId === request.selectedIds[request.index as number]
      && Array.isArray(comment.original) && comment.original.length > 0 && typeof comment.afterId === "string"
      && typeof comment.afterCreatedAt === "string" && Number.isFinite(Date.parse(comment.afterCreatedAt)),
    409, "MAINTENANCE_STATE_INVALID", "Discussion continuation is invalid.");
  }
  return value as unknown as Envelope;
}

async function page(tx: Prisma.TransactionClient, workspaceId: string, state: MaintenanceState, first = false): Promise<MaintenanceState> {
  const asOf = new Date(state.admittedAt);
  const where = state.phase === "LINKS" || state.phase === "ORPHANS" ? {workspaceId, archivedAt: null, createdAt: {lte: asOf}}
    : state.phase === "SOURCES" ? {workspaceId, tier: 3, createdAt: {lt: new Date(asOf.getTime() - 180 * 86400000)}}
      : state.phase === "DISCUSSIONS" ? {article: {workspaceId}, status: {in: ["OPEN", "RESOLVED"]}, createdAt: {lte: asOf}}
        : {workspaceId, sourceType: "EVENT", createdAt: {lt: new Date(asOf.getTime() - 15 * 86400000)}};
  const query = async (bounds: {id?: {gt?: string; lte?: string}}, take: number, direction: "asc" | "desc") => {
    const args = {where: {...where, ...bounds}, select: {id: true}, orderBy: {id: direction}, take};
    if (state.phase === "LINKS" || state.phase === "ORPHANS") return tx.brainArticle.findMany(args as Prisma.BrainArticleFindManyArgs) as Promise<Array<{id: string}>>;
    if (state.phase === "SOURCES") return tx.brainSource.findMany(args as Prisma.BrainSourceFindManyArgs) as Promise<Array<{id: string}>>;
    if (state.phase === "DISCUSSIONS") return tx.brainDiscussionThread.findMany(args as Prisma.BrainDiscussionThreadFindManyArgs) as Promise<Array<{id: string}>>;
    return tx.knowledgeChunk.findMany(args as Prisma.KnowledgeChunkFindManyArgs) as Promise<Array<{id: string}>>;
  };
  const upperId = first ? (await query({}, 1, "desc"))[0]?.id ?? null : state.upperId;
  const rows = upperId ? await query({id: {lte: upperId, ...(state.afterId ? {gt: state.afterId} : {})}}, MAINTENANCE_PAGE_SIZE, "asc") : [];
  return {...state, upperId, selectedIds: rows.map(row => row.id), pageLastId: rows.at(-1)?.id ?? state.afterId,
    pageComplete: rows.length < MAINTENANCE_PAGE_SIZE, index: 0, source: undefined, comment: undefined, orphan: undefined};
}

/** Exact current claim, not authority supplied in a job payload. */
export async function prepareMaintenanceClaim(job: MaintenanceClaimedJob, owner: string) {
  invariant(job.workspaceId && owner && job.attempts && job.lockedAt, 409, "MAINTENANCE_JOB_LOST", "Maintenance requires a claimed job.");
  const workspaceId = job.workspaceId;
  let expectedPayload = job.payload;
  let initial: WorkflowJob | undefined;
  let completedPayload: unknown;
  const assertCurrent = async (tx: Prisma.TransactionClient) => {
    const rows = await tx.$queryRaw<WorkflowJob[]>(Prisma.sql`SELECT * FROM "WorkflowJob" WHERE id = ${job.id} FOR UPDATE`);
    const row = rows[0];
    invariant(row && row.workspaceId === workspaceId && row.type === BRAIN_MAINTENANCE_JOB && row.status === "RUNNING"
      && row.lockedBy === owner && row.attempts === job.attempts && row.lockedAt?.getTime() === job.lockedAt!.getTime()
      && row.lockedAt.getTime() > Date.now() - 5 * 60_000 && isDeepStrictEqual(row.payload, expectedPayload),
    409, "MAINTENANCE_JOB_LOST", "Maintenance claim is no longer current.");
    initial ??= row;
    return row;
  };
  const admitted = await prisma.$transaction(async tx => {
    const row = await assertCurrent(tx);
    const stored = envelope(row.payload);
    if (stored) return {state: stored.request, payload: row.payload};
    const request = await page(tx, workspaceId, {version: 1, cohortId: job.id, admittedAt: new Date().toISOString(), phase: "LINKS",
      upperId: null, afterId: null, selectedIds: [], pageLastId: null, pageComplete: false, index: 0}, true);
    const payload = toInputJson({...isRecord(row.payload) ? row.payload : {}, maintenance: {request}});
    await tx.workflowJob.update({where: {id: job.id}, data: {payload}});
    return {state: request, payload};
  });
  const {state} = admitted;
  expectedPayload = admitted.payload; job.payload = admitted.payload;
  const childBase = () => Object.fromEntries(Object.entries(isRecord(expectedPayload) ? expectedPayload : {}).filter(([key]) => key !== "maintenance"));
  const verifyChild = async (tx: Prisma.TransactionClient, completion: NonNullable<Envelope["completion"]>) => {
    const children = await tx.workflowJob.findMany({where: {dependsOnJobId: job.id}, take: 2});
    if (!completion.next) {
      invariant(children.length === 0 && completion.dedupeKey === null, 409, "MAINTENANCE_STATE_INVALID", "Unexpected maintenance continuation.");
      return;
    }
    invariant(children.length === 1, 409, "MAINTENANCE_STATE_INVALID", "Maintenance handoff is missing or ambiguous.");
    const child = children[0];
    const saved = envelope(child.payload);
    const base = Object.fromEntries(Object.entries(isRecord(child.payload) ? child.payload : {}).filter(([key]) => key !== "maintenance"));
    invariant(child.workspaceId === workspaceId && child.type === BRAIN_MAINTENANCE_JOB && child.dependsOnJobId === job.id
      && child.dedupeKey === completion.dedupeKey && saved && isDeepStrictEqual(saved.request, completion.next)
      && isDeepStrictEqual(base, childBase()) && isDeepStrictEqual(child.mcpOrigin, initial!.mcpOrigin)
      && child.supportOriginUserId === initial!.supportOriginUserId && child.supportGrantVersion === initial!.supportGrantVersion,
    409, "MAINTENANCE_STATE_INVALID", "Maintenance continuation changed.");
  };
  return {state, assertCurrent,
    acknowledgeCommit() { if (completedPayload !== undefined) { expectedPayload = completedPayload; job.payload = completedPayload; } },
    async recoverOrVerifyExisting() {
      return prisma.$transaction(async tx => {
        const current = await assertCurrent(tx);
        const previous = await tx.agentRun.findFirst({where: {workspaceId, agentKey: "brain-maintenance", triggerRef: job.id}, orderBy: {createdAt: "desc"}});
        if (!previous) return false;
        if (previous.status === "COMPLETED") {
          const completion = envelope(current.payload)?.completion;
          invariant(completion, 409, "MAINTENANCE_STATE_INVALID", "Completed maintenance run has no committed handoff.");
          await verifyChild(tx, completion);
          return true;
        }
        if (previous.status === "RUNNING" || previous.status === "PENDING") {
          invariant(previous.createdAt < job.lockedAt!, 409, "MAINTENANCE_JOB_LOST", "The same maintenance attempt is still running.");
          await tx.agentRun.update({where: {id: previous.id}, data: {status: "FAILED", failedAt: new Date()}});
        }
        return false;
      });
    },
    async finish(tx: Prisma.TransactionClient, progressed: MaintenanceState) {
      await assertCurrent(tx);
      invariant(progressed.cohortId === state.cohortId && progressed.admittedAt === state.admittedAt && progressed.phase === state.phase
        && isDeepStrictEqual(progressed.selectedIds, state.selectedIds) && progressed.index >= state.index,
      409, "MAINTENANCE_STATE_INVALID", "Maintenance progress is not monotonic.");
      let next: MaintenanceState | null = progressed;
      if (progressed.index === progressed.selectedIds.length) {
        if (!progressed.pageComplete) next = await page(tx, workspaceId, {...progressed, afterId: progressed.pageLastId});
        else {
          const following = MAINTENANCE_PHASES[MAINTENANCE_PHASES.indexOf(progressed.phase) + 1];
          next = following ? await page(tx, workspaceId, {...progressed, phase: following, afterId: null}, true) : null;
        }
      }
      // JSON removes absent optional fields, matching the exact persisted shape.
      const canonical = next ? JSON.parse(JSON.stringify(next)) as MaintenanceState : null;
      const dedupeKey = canonical ? `brain-maintenance:${job.id}:${createHash("sha256").update(JSON.stringify(canonical)).digest("hex")}` : null;
      if (canonical && dedupeKey) {
        const {enqueueJob} = await import("./outbox");
        await enqueueJob(tx, {workspaceId, type: BRAIN_MAINTENANCE_JOB, dependsOnJobId: job.id, dedupeKey,
          payload: toInputJson({...childBase(), maintenance: {request: canonical}}) as Prisma.InputJsonObject});
      }
      const completion = {next: canonical, dedupeKey};
      await verifyChild(tx, completion);
      const payload = toInputJson({...childBase(), maintenance: {request: state, completion}});
      await tx.workflowJob.update({where: {id: job.id}, data: {payload}});
      completedPayload = payload;
    },
  };
}
