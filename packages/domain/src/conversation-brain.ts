import { prisma } from "@corgtex/shared";
import type { AppActor } from "@corgtex/shared";
import type { BrainSource, Prisma } from "@prisma/client";
import { invariant } from "./errors";
import type { LineageInput, LineageRoot } from "./source-lineage";

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
