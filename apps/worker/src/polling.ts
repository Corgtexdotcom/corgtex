export type WorkerPollOutcome = {
  workDone: boolean;
  fastDrain: boolean;
};

export function getWorkerPollOutcome(params: {
  dispatched: number;
  eventBatchSize: number;
  processed: number;
  jobBatchSize: number;
  scheduled: number;
  scheduledPeriodic: number;
  scheduledDrip: number;
  finalized: number;
}): WorkerPollOutcome {
  const workDone = params.finalized > 0
    || params.dispatched > 0
    || params.processed > 0
    || params.scheduled > 0
    || params.scheduledPeriodic > 0
    || params.scheduledDrip > 0;
  const fullEventBatch = params.eventBatchSize > 0 && params.dispatched >= params.eventBatchSize;
  const fullJobBatch = params.jobBatchSize > 0 && params.processed >= params.jobBatchSize;

  return {
    workDone,
    fastDrain: fullEventBatch || fullJobBatch,
  };
}

export function getNextPollIntervalMs(params: {
  outcome: WorkerPollOutcome;
  pollIntervalMs: number;
  maxPollIntervalMs: number;
  currentPollIntervalMs: number;
}) {
  if (params.outcome.fastDrain) {
    return 0;
  }
  if (params.outcome.workDone) {
    return params.pollIntervalMs;
  }
  const backoffBaseMs = Math.max(params.pollIntervalMs, params.currentPollIntervalMs * 2);
  return Math.min(params.maxPollIntervalMs, backoffBaseMs);
}
