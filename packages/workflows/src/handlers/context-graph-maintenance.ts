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
  return markStaleContextGraphFacts(contextGraphSystemActor(), {
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
  const [members, goals, agentIdentities] = await Promise.all([
    prisma.member.findMany({ where: { workspaceId }, select: { id: true }, take: RECONCILE_BATCH_LIMIT }),
    prisma.goal.findMany({ where: { workspaceId }, select: { id: true }, take: RECONCILE_BATCH_LIMIT }),
    prisma.agentIdentity.findMany({ where: { workspaceId }, select: { id: true }, take: RECONCILE_BATCH_LIMIT }),
  ]);

  const sources = [
    ...members.map((record) => ({ sourceType: "MEMBER", sourceId: record.id })),
    ...goals.map((record) => ({ sourceType: "GOAL", sourceId: record.id })),
    ...agentIdentities.map((record) => ({ sourceType: "AGENT_IDENTITY", sourceId: record.id })),
  ];

  await prisma.$transaction(async (tx) => {
    for (const source of sources) {
      await enqueueJob(tx, {
        workspaceId,
        type: "context-graph.sync",
        payload: source,
        dedupeKey: `${workspaceId}:context-graph-reconcile:${source.sourceType}:${source.sourceId}:${dateISO}`,
      });
    }
  });

  return { enqueued: sources.length };
}
