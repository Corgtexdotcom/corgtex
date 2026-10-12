import { prisma } from "@corgtex/shared";
import { contextGraphSystemActor, markStaleContextGraphFacts } from "@corgtex/domain";
import { enqueueJob } from "../outbox";

type StalenessSweepPayload = {
  staleAfterDays?: number;
};

type ReconcilePayload = {
  dateISO?: string;
};

const RECONCILE_BATCH_LIMIT = 1000;

function configuredStaleAfterDays(payload: StalenessSweepPayload) {
  if (payload.staleAfterDays !== undefined) return payload.staleAfterDays;
  const envDays = Number(process.env.CONTEXT_GRAPH_STALE_AFTER_DAYS ?? "");
  return Number.isFinite(envDays) && envDays > 0 ? envDays : undefined;
}

export async function handleContextGraphStalenessSweep(
  _jobId: string,
  payload: StalenessSweepPayload,
  workspaceId: string,
) {
  return markStaleContextGraphFacts(contextGraphSystemActor(workspaceId), {
    workspaceId,
    staleAfterDays: configuredStaleAfterDays(payload),
  });
}

export async function handleContextGraphReconcile(
  _jobId: string,
  payload: ReconcilePayload,
  workspaceId: string,
) {
  const dateISO = payload.dateISO ?? new Date().toISOString().split("T")[0];
  const families = [
    { sourceType: "MEMBER", fetch: (after?: string) => prisma.member.findMany({ where: { workspaceId, ...(after ? { id: { gt: after } } : {}) }, select: { id: true }, orderBy: { id: "asc" }, take: RECONCILE_BATCH_LIMIT }) },
    { sourceType: "GOAL", fetch: (after?: string) => prisma.goal.findMany({ where: { workspaceId, ...(after ? { id: { gt: after } } : {}) }, select: { id: true }, orderBy: { id: "asc" }, take: RECONCILE_BATCH_LIMIT }) },
    { sourceType: "AGENT_IDENTITY", fetch: (after?: string) => prisma.agentIdentity.findMany({ where: { workspaceId, ...(after ? { id: { gt: after } } : {}) }, select: { id: true }, orderBy: { id: "asc" }, take: RECONCILE_BATCH_LIMIT }) },
    { sourceType: "BRAIN_ARTICLE", fetch: (after?: string) => prisma.brainArticle.findMany({ where: { workspaceId, ...(after ? { id: { gt: after } } : {}) }, select: { id: true }, orderBy: { id: "asc" }, take: RECONCILE_BATCH_LIMIT }) },
    { sourceType: "PROPOSAL", fetch: (after?: string) => prisma.proposal.findMany({ where: { workspaceId, ...(after ? { id: { gt: after } } : {}) }, select: { id: true }, orderBy: { id: "asc" }, take: RECONCILE_BATCH_LIMIT }) },
    { sourceType: "ACTION", fetch: (after?: string) => prisma.action.findMany({ where: { workspaceId, ...(after ? { id: { gt: after } } : {}) }, select: { id: true }, orderBy: { id: "asc" }, take: RECONCILE_BATCH_LIMIT }) },
    { sourceType: "TENSION", fetch: (after?: string) => prisma.tension.findMany({ where: { workspaceId, ...(after ? { id: { gt: after } } : {}) }, select: { id: true }, orderBy: { id: "asc" }, take: RECONCILE_BATCH_LIMIT }) },
    { sourceType: "CIRCLE", fetch: (after?: string) => prisma.circle.findMany({ where: { workspaceId, ...(after ? { id: { gt: after } } : {}) }, select: { id: true }, orderBy: { id: "asc" }, take: RECONCILE_BATCH_LIMIT }) },
    { sourceType: "ROLE", fetch: (after?: string) => prisma.role.findMany({ where: { circle: { workspaceId }, ...(after ? { id: { gt: after } } : {}) }, select: { id: true }, orderBy: { id: "asc" }, take: RECONCILE_BATCH_LIMIT }) },
    { sourceType: "DOCUMENT", fetch: (after?: string) => prisma.document.findMany({ where: { workspaceId, ...(after ? { id: { gt: after } } : {}) }, select: { id: true }, orderBy: { id: "asc" }, take: RECONCILE_BATCH_LIMIT }) },
  ];
  let enqueued = 0;
  for (const family of families) {
    let after: string | undefined;
    while (true) {
      const page = await family.fetch(after);
      if (!page.length) break;
      await prisma.$transaction(async (tx) => {
        for (const record of page) await enqueueJob(tx, {
          workspaceId, type: "context-graph.sync", payload: { sourceType: family.sourceType, sourceId: record.id },
          dedupeKey: `${workspaceId}:context-graph-reconcile:${family.sourceType}:${record.id}:${dateISO}`,
        });
      });
      enqueued += page.length;
      if (page.length < RECONCILE_BATCH_LIMIT) break;
      after = page[page.length - 1].id;
    }
  }
  return { enqueued };
}
