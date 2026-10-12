import { prisma, toInputJson } from "@corgtex/shared";
import type { AppActor } from "@corgtex/shared";
import type { AgentMemory } from "@prisma/client";
import { requireWorkspaceMembership } from "./auth";
import { invariant } from "./errors";
import { loadReadableDigestQuery } from "./digest-lineage";
import { finishProducerLineage, prepareProducerLineage } from "./producer-lineage";
import { captureArtifactInputProof, invalidateArtifactInputLineage, isArtifactInputProofReadable, type LineageInput, type LineageRoot } from "./source-lineage";

export async function listAgentMemories(actor: AppActor, workspaceId: string, opts?: {
  agentKey?: string;
  memoryType?: string;
  take?: number;
}) {
  await requireWorkspaceMembership({ actor, workspaceId });

  const limit = opts?.take ?? 50;
  invariant(Number.isInteger(limit) && limit >= 0 && limit <= 1_000,
    400, "INVALID_INPUT", "Memory limit must be between 0 and 1000.");
  if (limit === 0) return [];
  const memories = await loadReadableDigestQuery<AgentMemory>({
    actor, workspaceId, kind: "AgentMemory", limit, keyset: true,
    loadBatch: ({ take, after }) => prisma.agentMemory.findMany({
      where: {
        workspaceId,
        ...(opts?.agentKey ? { agentKey: opts.agentKey } : {}),
        ...(opts?.memoryType ? { memoryType: opts.memoryType } : {}),
        ...(after ? { OR: [{ updatedAt: { lt: after.updatedAt } }, { updatedAt: after.updatedAt, id: { lt: after.id } }] } : {}),
      },
      orderBy: [{ updatedAt: "desc" }, { id: "desc" }],
      take,
    }),
  });
  if (memories.length) {
    const roots = await captureArtifactInputProof(actor, workspaceId, memories.map((memory) => ({ kind: "AgentMemory", id: memory.id, snapshot: memory })));
    invariant(await isArtifactInputProofReadable(actor, workspaceId, roots),
      409, "SOURCE_CHANGED", "Memory source access changed. Please retry.");
  }
  return memories;
}

export async function storeAgentMemory(params: {
  workspaceId: string;
  agentKey: string;
  memoryType: string;
  content: string;
  embedding?: number[] | null;
  metadata?: Record<string, unknown> | null;
  actor?: AppActor;
  lineageRoots?: LineageRoot[];
  lineageInputs?: LineageInput[];
}) {
  if (params.actor) await requireWorkspaceMembership({ actor: params.actor, workspaceId: params.workspaceId });
  return prisma.$transaction(async (tx) => {
    if (params.actor) await requireWorkspaceMembership({ actor: params.actor, workspaceId: params.workspaceId, tx });
    const receipt = params.actor ? await prepareProducerLineage({
      tx, actor: params.actor, workspaceId: params.workspaceId, copied: true,
      capture: { lineageRoots: params.lineageRoots, lineageInputs: params.lineageInputs },
    }) : null;
    const memory = await tx.agentMemory.create({
      data: {
        workspaceId: params.workspaceId,
        agentKey: params.agentKey,
        memoryType: params.memoryType,
        content: params.content,
        embedding: params.embedding ? toInputJson(params.embedding) : undefined,
        metadata: params.metadata ? toInputJson(params.metadata) : undefined,
      },
    });
    const artifact = { kind: "AgentMemory" as const, id: memory.id };
    if (params.actor && receipt) await finishProducerLineage({
      tx, actor: params.actor, workspaceId: params.workspaceId, artifact, content: memory, receipt,
    });
    else await invalidateArtifactInputLineage({ tx, workspaceId: params.workspaceId, artifact, content: memory });
    return memory;
  });
}

export async function loadRelevantMemories(params: {
  workspaceId: string;
  agentKey: string;
  limit?: number;
  actor?: AppActor;
}) {
  // Legacy callers have no requester whose current grants can be checked.
  if (!params.actor) return [];
  return listAgentMemories(params.actor, params.workspaceId, { agentKey: params.agentKey, take: params.limit ?? 10 });
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
