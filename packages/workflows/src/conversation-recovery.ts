export type ConversationRecoveryCandidate = {
  runId: string;
  generation: number;
  status: "RUNNABLE" | "WAITING" | "COMPLETED" | "CANCELLED" | "UNKNOWN";
  decisionReady: boolean;
  checkpointWaiting: boolean;
  resultMissing: boolean;
};

export type ConversationRecoveryPort = {
  /** Scoped server query with stable ordering. Never scan private checkpoint contents. */
  candidates(limit: number): Promise<ConversationRecoveryCandidate[]>;
  /** Re-read/CAS generation, claim, decision and status in the domain transaction.
   * Add only to the existing WorkflowJob/outbox, using a new generation dedupe key.
   * Early decisions must retain a retryable wakeup until the interrupt consumes them.
   * Reconcile committed receipts without another effect. UNKNOWN requires separate
   * authoritative reconciliation, never a blind execution retry. */
  repair(candidate: ConversationRecoveryCandidate, intent: "EXECUTE" | "RESUME" | "RECONCILE_RESULT" | "WAIT_FOR_CHECKPOINT"): Promise<"repaired" | "unchanged">;
};

/** One bounded sweep for the existing scheduler; this is not a queue or polling service. */
export async function recoverConversationTurns(port: ConversationRecoveryPort, limit = 25) {
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100) throw new Error("Invalid conversation recovery limit");
  const candidates = await port.candidates(limit);
  if (candidates.length > limit) throw new Error("Conversation recovery exceeded its bound");
  let repaired = 0;
  for (const candidate of candidates) {
    if (!Number.isSafeInteger(candidate.generation) || candidate.generation < 0 || !candidate.runId) throw new Error("Invalid conversation recovery candidate");
    if (candidate.status === "CANCELLED" || candidate.status === "UNKNOWN") continue;
    const intent = candidate.status === "COMPLETED"
      ? (candidate.resultMissing ? "RECONCILE_RESULT" : null)
      : candidate.status === "RUNNABLE" ? "EXECUTE"
        : candidate.decisionReady ? (candidate.checkpointWaiting ? "RESUME" : "WAIT_FOR_CHECKPOINT") : null;
    if (intent && await port.repair(candidate, intent) === "repaired") repaired++;
  }
  return { inspected: candidates.length, repaired };
}
