import type { AssistantOutcome, AssistantScope } from "@corgtex/agents/assistant-harness";

export const CONVERSATION_TURN_JOB_TYPE = "agent.conversation-turn";

export type ConversationTurnClaim = {
  jobId: string;
  owner: string;
  attempt: number;
};

/** Application integration seam. Not registered in outbox until receipt/fencing lands.
 * load must resolve auth from admission, not trust a worker payload as a principal.
 * run uses createAssistantHarness with the admitted input (first segment) or no input
 * (recovery). finish must CAS this claim and atomically persist the outcome/wakeup policy.
 * A waiting result releases the worker slot; errors remain recoverable through existing jobs.
 * Worker drain supplies run's AbortSignal; a subscriber disconnect must not abort it. */
export type ConversationTurnPorts = {
  load(claim: ConversationTurnClaim): Promise<{
    scope: AssistantScope;
    run(): Promise<AssistantOutcome>;
  }>;
  finish(claim: ConversationTurnClaim, outcome: AssistantOutcome): Promise<void>;
};

export async function handleConversationTurn(claim: ConversationTurnClaim, ports: ConversationTurnPorts): Promise<AssistantOutcome> {
  if (!claim.jobId || !claim.owner || !Number.isSafeInteger(claim.attempt) || claim.attempt < 1) throw new Error("Invalid conversation claim");
  const segment = await ports.load(claim);
  if (segment.scope.job.id !== claim.jobId || segment.scope.job.owner !== claim.owner || segment.scope.job.attempt !== claim.attempt) throw new Error("Stale conversation claim");
  const outcome = await segment.run();
  await ports.finish(claim, outcome);
  return outcome;
}
