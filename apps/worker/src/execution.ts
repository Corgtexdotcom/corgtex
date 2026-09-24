import type { ReleaseMetadata } from "@corgtex/shared";

export type WorkerExecutionMode = "continuous" | "queue-only" | "scheduler-once";

export function parseWorkerExecutionMode(value = process.env.WORKER_EXECUTION_MODE): WorkerExecutionMode {
  if (value === undefined) return "continuous";
  if (value === "continuous" || value === "queue-only" || value === "scheduler-once") return value;
  throw new Error("Invalid WORKER_EXECUTION_MODE");
}

export interface WorkerOperations {
  finalize: () => Promise<number>;
  dispatch: () => Promise<number>;
  process: () => Promise<number>;
  daily: () => Promise<number>;
  periodic: () => Promise<number>;
  drip: () => Promise<number>;
}

export async function runWorkerCycle(mode: WorkerExecutionMode, operations: WorkerOperations) {
  // Keep the existing continuous ordering, including queue consumption before scheduling.
  const finalized = mode === "queue-only" ? 0 : await operations.finalize();
  const dispatched = mode === "scheduler-once" ? 0 : await operations.dispatch();
  const processed = mode === "scheduler-once" ? 0 : await operations.process();
  const scheduled = mode === "queue-only" ? 0 : await operations.daily();
  const scheduledPeriodic = mode === "queue-only" ? 0 : await operations.periodic();
  const scheduledDrip = mode === "queue-only" ? 0 : await operations.drip();
  return { finalized, dispatched, processed, scheduled, scheduledPeriodic, scheduledDrip };
}

export function parseSchedulerProofNonce(value: string | undefined) {
  if (value === undefined) return null;
  if (!/^[A-Za-z0-9_-]{32,128}$/.test(value)) throw new Error("Invalid WORKER_SCHEDULER_PROOF_NONCE");
  return value;
}

export function assertSchedulerProofRelease(nonce: string | null, release: ReleaseMetadata) {
  if (nonce && (release.runtime.evidence !== "baked" || !/^[a-f0-9]{40}$/i.test(release.runtime.gitSha ?? "")
    || release.drift.gitSha || release.drift.version || release.drift.imageTag || release.drift.details.length > 0)) {
    throw new Error("Scheduler proof requires a matching baked release");
  }
}

export function schedulerCompletionReceipt(nonce: string | null, release: ReleaseMetadata, counts: Awaited<ReturnType<typeof runWorkerCycle>>) {
  return {
    event: "scheduler_complete",
    executionMode: "scheduler-once",
    proofNonce: nonce,
    skipped: false,
    release: {
      gitSha: release.runtime.evidence === "baked" ? release.runtime.gitSha : null,
      evidence: release.runtime.evidence,
      version: release.version,
      imageTag: release.imageTag,
      drift: release.drift,
    },
    counts,
  };
}
