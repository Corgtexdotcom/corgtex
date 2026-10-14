import { prisma } from "@corgtex/shared";
import type { AppActor } from "@corgtex/shared";
import type { BrainSource, Prisma } from "@prisma/client";
import { appendEvents } from "./events";
import { getUningestedConversations } from "./conversations";
import { invariant } from "./errors";
import { recordArtifactInputLineage, type LineageInput, type LineageRoot } from "./source-lineage";

export type ConversationBrainIngestParams = {
  workspaceId: string;
  title: string;
  content: string;
  sourceType?: string;
  lineageInputs?: LineageInput[];
  lineageRoots?: LineageRoot[];
};

/** Model-originated content is not an authenticated choice to share a conversation. */
export async function ingestConversationOnDemandInTransaction(
  _tx: Prisma.TransactionClient, _actor: AppActor, _submission: ConversationBrainIngestParams,
): Promise<BrainSource> {
  invariant(false, 409, "BRAIN_CONSENT_REQUIRED", "Use Save to Brain on a persisted answer and confirm the transcript selection.");
}

/** Standalone callers retain an owned transaction; foundation callers can supply theirs. */
export async function ingestConversationOnDemand(actor: AppActor,
  params: ConversationBrainIngestParams & { tx?: Prisma.TransactionClient },
) {
  const { tx, ...submission } = params;
  const captured = structuredClone(submission);
  return tx ? ingestConversationOnDemandInTransaction(tx, actor, captured)
    : prisma.$transaction(callerTx => ingestConversationOnDemandInTransaction(callerTx, actor, captured));
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
