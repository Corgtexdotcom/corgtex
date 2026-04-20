import { prisma } from "@corgtex/shared";
import type { AppActor } from "@corgtex/shared";
import { Prisma } from "@prisma/client";
import { requireWorkspaceMembership } from "./auth";

export async function recordAudit(
  tx: Prisma.TransactionClient,
  actor: AppActor,
  params: {
    workspaceId: string;
    action: string;
    entityType: string;
    entityId: string;
    meta?: Record<string, unknown>;
  }
) {
  return tx.auditLog.create({
    data: {
      workspaceId: params.workspaceId,
      actorUserId: actor.kind === "user" ? actor.user.id : null,
      action: params.action,
      entityType: params.entityType,
      entityId: params.entityId,
      meta: params.meta ? (params.meta as Prisma.InputJsonObject) : Prisma.DbNull,
    },
  });
}

export async function listAuditLogs(actor: AppActor, workspaceId: string, opts?: {
  take?: number;
  entityType?: string;
  entityId?: string;
  action?: string;
  actorUserId?: string;
}) {
  await requireWorkspaceMembership({ actor, workspaceId });

  return prisma.auditLog.findMany({
    where: {
      workspaceId,
      ...(opts?.entityType ? { entityType: opts.entityType } : {}),
      ...(opts?.entityId ? { entityId: opts.entityId } : {}),
      ...(opts?.action ? { action: { contains: opts.action } } : {}),
      ...(opts?.actorUserId ? { actorUserId: opts.actorUserId } : {}),
    },
    orderBy: { createdAt: "desc" },
    take: opts?.take ?? 50,
  });
}

export async function getEntityTimeline(actor: AppActor, workspaceId: string, entityType: string, entityId: string) {
  await requireWorkspaceMembership({ actor, workspaceId });

  const [auditLogs, relatedEvents] = await Promise.all([
    prisma.auditLog.findMany({
      where: { workspaceId, entityType, entityId },
      orderBy: { createdAt: "asc" },
    }),
    prisma.event.findMany({
      where: {
        workspaceId,
        aggregateType: entityType,
        aggregateId: entityId,
      },
      select: {
        id: true,
        type: true,
        status: true,
        payload: true,
        createdAt: true,
        jobs: {
          select: {
            id: true,
            type: true,
            status: true,
            completedAt: true,
          },
          orderBy: { createdAt: "asc" },
        },
      },
      orderBy: { createdAt: "asc" },
    }),
  ]);

  return { auditLogs, relatedEvents };
}

export async function getAgentRunTrace(actor: AppActor, workspaceId: string, agentRunId: string) {
  await requireWorkspaceMembership({ actor, workspaceId });

  const run = await prisma.agentRun.findFirst({
    where: { id: agentRunId, workspaceId },
    include: {
      steps: {
        orderBy: { createdAt: "asc" },
      },
      toolCalls: {
        orderBy: { createdAt: "asc" },
      },
      modelUsage: {
        select: {
          id: true,
          provider: true,
          model: true,
          taskType: true,
          inputTokens: true,
          outputTokens: true,
          latencyMs: true,
          estimatedCostUsd: true,
          createdAt: true,
        },
        orderBy: { createdAt: "asc" },
      },
    },
  });

  return run;
}

export async function getModelUsageSummary(actor: AppActor, workspaceId: string, opts?: {
  periodDays?: number;
}) {
  await requireWorkspaceMembership({ actor, workspaceId });

  const periodDays = opts?.periodDays ?? 30;
  const since = new Date(Date.now() - periodDays * 24 * 60 * 60 * 1000);

  const usages = await prisma.modelUsage.findMany({
    where: {
      workspaceId,
      createdAt: { gte: since },
    },
    select: {
      provider: true,
      model: true,
      taskType: true,
      inputTokens: true,
      outputTokens: true,
      latencyMs: true,
      estimatedCostUsd: true,
      createdAt: true,
      agentRun: {
        select: {
          agentKey: true,
        },
      },
    },
    orderBy: { createdAt: "desc" },
  });

  // Aggregate by model
  const byModel = new Map<string, {
    provider: string;
    model: string;
    totalInputTokens: number;
    totalOutputTokens: number;
    totalLatencyMs: number;
    totalCostUsd: number;
    callCount: number;
  }>();

  // Aggregate by agent
  const byAgent = new Map<string, {
    agentKey: string;
    totalInputTokens: number;
    totalOutputTokens: number;
    totalCostUsd: number;
    callCount: number;
  }>();

  // Aggregate by day
  const byDay = new Map<string, {
    date: string;
    totalInputTokens: number;
    totalOutputTokens: number;
    totalCostUsd: number;
    callCount: number;
  }>();

  for (const usage of usages) {
    const costUsd = parseCost(usage.estimatedCostUsd);

    // By model
    const modelKey = `${usage.provider}:${usage.model}`;
    const modelEntry = byModel.get(modelKey) ?? {
      provider: usage.provider,
      model: usage.model,
      totalInputTokens: 0,
      totalOutputTokens: 0,
      totalLatencyMs: 0,
      totalCostUsd: 0,
      callCount: 0,
    };
    modelEntry.totalInputTokens += usage.inputTokens;
    modelEntry.totalOutputTokens += usage.outputTokens;
    modelEntry.totalLatencyMs += usage.latencyMs;
    modelEntry.totalCostUsd += costUsd;
    modelEntry.callCount += 1;
    byModel.set(modelKey, modelEntry);

    // By agent
    const agentKey = usage.agentRun?.agentKey ?? "unknown";
    const agentEntry = byAgent.get(agentKey) ?? {
      agentKey,
      totalInputTokens: 0,
      totalOutputTokens: 0,
      totalCostUsd: 0,
      callCount: 0,
    };
    agentEntry.totalInputTokens += usage.inputTokens;
    agentEntry.totalOutputTokens += usage.outputTokens;
    agentEntry.totalCostUsd += costUsd;
    agentEntry.callCount += 1;
    byAgent.set(agentKey, agentEntry);

    // By day
    const dateKey = usage.createdAt.toISOString().slice(0, 10);
    const dayEntry = byDay.get(dateKey) ?? {
      date: dateKey,
      totalInputTokens: 0,
      totalOutputTokens: 0,
      totalCostUsd: 0,
      callCount: 0,
    };
    dayEntry.totalInputTokens += usage.inputTokens;
    dayEntry.totalOutputTokens += usage.outputTokens;
    dayEntry.totalCostUsd += costUsd;
    dayEntry.callCount += 1;
    byDay.set(dateKey, dayEntry);
  }

  const totalCostUsd = [...byModel.values()].reduce((sum, m) => sum + m.totalCostUsd, 0);
  const totalTokens = [...byModel.values()].reduce((sum, m) => sum + m.totalInputTokens + m.totalOutputTokens, 0);

  return {
    periodDays,
    totalCostUsd,
    totalTokens,
    totalCalls: usages.length,
    byModel: [...byModel.values()].sort((a, b) => b.totalCostUsd - a.totalCostUsd),
    byAgent: [...byAgent.values()].sort((a, b) => b.totalCostUsd - a.totalCostUsd),
    byDay: [...byDay.values()].sort((a, b) => a.date.localeCompare(b.date)),
  };
}

function parseCost(value: unknown): number {
  if (value == null) return 0;
  const num = typeof value === "number" ? value : Number(String(value));
  return Number.isFinite(num) ? num : 0;
}
