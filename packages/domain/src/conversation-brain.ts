import { prisma } from "@corgtex/shared";
import type { AppActor } from "@corgtex/shared";
import type { BrainSourceType } from "@prisma/client";
import { requireWorkspaceMembership } from "./auth";
import { appendEvents } from "./events";
import { getUningestedConversations } from "./conversations";
import { invariant } from "./errors";
import { recordArtifactInputLineage, type LineageInput, type LineageRoot } from "./source-lineage";

export async function ingestConversationOnDemand(actor: AppActor, params: {
  workspaceId: string;
  title: string;
  content: string;
  sourceType?: string;
  lineageInputs?: LineageInput[];
  lineageRoots?: LineageRoot[];
}) {
  const membership = await requireWorkspaceMembership({
    actor,
    workspaceId: params.workspaceId,
  });

  const finalSourceType = (params.sourceType as BrainSourceType) || "CONVERSATION";
  invariant(Boolean(params.lineageInputs?.length || params.lineageRoots?.length),
    409, "UNKNOWN_LINEAGE", "Conversation content cannot be saved until all its input permissions are verified.");

  return prisma.$transaction(async (tx) => {
    const source = await tx.brainSource.create({
      data: {
        workspaceId: params.workspaceId,
        sourceType: finalSourceType,
        tier: 2, // user prompted
        content: params.content,
        title: params.title,
        authorMemberId: membership?.id || null,
        channel: "chat-demand",
      },
    });

    await recordArtifactInputLineage({
      tx, actor, workspaceId: params.workspaceId,
      artifact: { kind: "BrainSource", id: source.id }, content: source,
      origin: "DERIVED", inputs: params.lineageInputs ?? [], inheritedRoots: params.lineageRoots,
    });

    await tx.auditLog.create({
      data: {
        workspaceId: params.workspaceId,
        actorUserId: actor.kind === "user" ? actor.user.id : null,
        action: "brain-source.created",
        entityType: "BrainSource",
        entityId: source.id,
        meta: { sourceType: source.sourceType, tier: source.tier, onDemand: true },
      },
    });

    await appendEvents(tx, [
      {
        workspaceId: params.workspaceId,
        type: "brain-source.created",
        aggregateType: "BrainSource",
        aggregateId: source.id,
        payload: { sourceId: source.id },
      },
    ]);

    return source;
  });
}

export async function batchIngestDailyConversations(params: {
  workspaceId: string;
  since: Date;
}) {
  const sessions = await getUningestedConversations(params.workspaceId, params.since);

  if (sessions.length === 0) {
    return { ingestedCount: 0, sourceIds: [] };
  }

  const sourceIds: string[] = [];

  for (const session of sessions) {
    if (session.turns.length < 2) continue; // Skip very short sessions

    const content = session.turns
      .map((t) => `User: ${t.userMessage}\nAssistant: ${t.assistantMessage}`)
      .join("\n\n---\n\n");

    const title = session.topic ? `Chat: ${session.topic}` : `Conversation on ${params.since.toISOString().split("T")[0]}`;

    const source = await prisma.$transaction(async (tx) => {
      const src = await tx.brainSource.create({
        data: {
          workspaceId: params.workspaceId,
          sourceType: "CONVERSATION",
          tier: 3,
          content,
          title,
          channel: "daily-batch",
          metadata: {
            conversationId: session.id,
            turnCount: session.turns.length,
            userId: session.userId,
            date: params.since.toISOString(),
          },
        },
      });

      const lineageActor: AppActor = { kind: "agent", authProvider: "bootstrap", label: "conversation-batch", workspaceIds: [params.workspaceId] };
      await recordArtifactInputLineage({ tx, actor: lineageActor, workspaceId: params.workspaceId,
        artifact: { kind: "BrainSource", id: src.id }, content: src, origin: "DERIVED", inputs: [], inheritedRoots: session.lineageRoots });
      await appendEvents(tx, [
        {
          workspaceId: params.workspaceId,
          type: "brain-source.created",
          aggregateType: "BrainSource",
          aggregateId: src.id,
          payload: { sourceId: src.id },
        },
      ]);

      return src;
    });

    sourceIds.push(source.id);
  }

  return { ingestedCount: sourceIds.length, sourceIds };
}
