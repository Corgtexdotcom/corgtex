import { prisma, toInputJson } from "@corgtex/shared";
import type { AppActor } from "@corgtex/shared";
import { requireWorkspaceMembership } from "./auth";
import { invariant } from "./errors";

export async function listAgentMemories(actor: AppActor, workspaceId: string, opts?: {
  agentKey?: string;
  memoryType?: string;
  take?: number;
}) {
  await requireWorkspaceMembership({ actor, workspaceId });

  return prisma.agentMemory.findMany({
    where: {
      workspaceId,
      ...(opts?.agentKey ? { agentKey: opts.agentKey } : {}),
      ...(opts?.memoryType ? { memoryType: opts.memoryType } : {}),
    },
    orderBy: { updatedAt: "desc" },
    take: opts?.take ?? 50,
  });
}

export async function storeAgentMemory(params: {
  workspaceId: string;
  agentKey: string;
  memoryType: string;
  content: string;
  embedding?: number[] | null;
  metadata?: Record<string, unknown> | null;
}) {
  return prisma.agentMemory.create({
    data: {
      workspaceId: params.workspaceId,
      agentKey: params.agentKey,
      memoryType: params.memoryType,
      content: params.content,
      embedding: params.embedding ? toInputJson(params.embedding) : undefined,
      metadata: params.metadata ? toInputJson(params.metadata) : undefined,
    },
  });
}

export async function loadRelevantMemories(params: {
  workspaceId: string;
  agentKey: string;
  limit?: number;
}) {
  return prisma.agentMemory.findMany({
    where: {
      workspaceId: params.workspaceId,
      agentKey: params.agentKey,
    },
    orderBy: { updatedAt: "desc" },
    take: params.limit ?? 10,
  });
}

export async function deleteAgentMemory(actor: AppActor, params: {
  workspaceId: string;
  memoryId: string;
}) {
  await requireWorkspaceMembership({ actor, workspaceId: params.workspaceId });

  const memory = await prisma.agentMemory.findUnique({
    where: { id: params.memoryId },
    select: { workspaceId: true },
  });
  invariant(memory && memory.workspaceId === params.workspaceId, 404, "NOT_FOUND", "Memory not found.");

  return prisma.agentMemory.delete({ where: { id: params.memoryId } });
}
