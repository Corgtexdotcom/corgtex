import { randomUUID } from "node:crypto";
import { createServer } from "node:http";
import { closeRedisClient, env, prisma, logger } from "@corgtex/shared";
import { captureErrorTelemetry } from "@corgtex/shared/telemetry-node";
import { resolveNodeReleaseMetadata } from "@corgtex/shared/release-metadata-node";
import { finalizeExpiredApprovalFlows } from "@corgtex/domain";
import { dispatchPendingEvents, renderWorkflowJobMetrics, runPendingJobs, scheduleDailyJobs, schedulePeriodicJobs, scheduleDripCampaigns } from "@corgtex/workflows";
import * as Sentry from "@sentry/node";
import { getNextPollIntervalMs, getWorkerPollOutcome, type WorkerPollOutcome } from "./polling";

import { assertSchedulerProofRelease, parseSchedulerProofNonce, parseWorkerExecutionMode, runWorkerCycle, schedulerCompletionReceipt, type WorkerOperations } from "./execution";
import { createSchedulerLock, withSchedulerLock } from "./scheduler";

// Validate before initializing telemetry, a health listener, or any database work.
const executionMode = parseWorkerExecutionMode();
const schedulerProofNonce = parseSchedulerProofNonce(process.env.WORKER_SCHEDULER_PROOF_NONCE);

if (process.env.SENTRY_DSN) {
  Sentry.init({
    dsn: process.env.SENTRY_DSN,
    tracesSampleRate: 0.0, // No APM, just unhandled exceptions
  });
}

// --- Configuration ---

const workerId = `worker-${randomUUID().slice(0, 8)}`;
const POLL_INTERVAL_MS = Number(process.env.WORKER_POLL_INTERVAL_MS ?? "5000");
const MAX_POLL_INTERVAL_MS = Number(process.env.WORKER_MAX_POLL_INTERVAL_MS ?? "30000");
const EVENT_BATCH_SIZE = Number(process.env.WORKER_EVENT_BATCH_SIZE ?? "25");
const JOB_BATCH_SIZE = Number(process.env.WORKER_JOB_BATCH_SIZE ?? "25");
const JOB_CONCURRENCY = Number(process.env.WORKER_JOB_CONCURRENCY ?? "5");
const HEALTH_PORT = Number(process.env.WORKER_HEALTH_PORT ?? process.env.PORT ?? "9090");
const SHUTDOWN_TIMEOUT_MS = Number(process.env.WORKER_SHUTDOWN_TIMEOUT_MS ?? "15000");
const release = resolveNodeReleaseMetadata("worker");

// --- State ---

type WorkerPhase = "starting" | "running" | "draining" | "stopped";
let phase: WorkerPhase = "starting";
let tickInFlight = false;
let tickCount = 0;
let totalDispatched = 0;
let totalProcessed = 0;
let totalFinalized = 0;
let totalScheduledDaily = 0;
let totalScheduledPeriodic = 0;
let lastTickMs = 0;
let lastError: string | null = null;
let lastSuccessfulTickAt: string | null = null;
let lastWorkAt: string | null = null;
let pollTimer: ReturnType<typeof setTimeout> | null = null;
let currentPollIntervalMs = POLL_INTERVAL_MS;

// --- Logging ---

function log(level: "info" | "warn" | "error", data: Record<string, unknown>) {
  const entry = {
    ts: new Date().toISOString(),
    component: "worker",
    workerId,
    ...data,
  };
  if (level === "error") {
    logger.error(JSON.stringify(entry));
  } else if (level === "warn") {
    logger.warn(JSON.stringify(entry));
  } else {
    logger.info(JSON.stringify(entry));
  }
}

const operations: WorkerOperations = {
  finalize: () => finalizeExpiredApprovalFlows(),
  dispatch: () => dispatchPendingEvents(workerId, EVENT_BATCH_SIZE),
  process: () => runPendingJobs(workerId, JOB_BATCH_SIZE, JOB_CONCURRENCY),
  daily: () => scheduleDailyJobs(),
  periodic: () => schedulePeriodicJobs(),
  drip: () => scheduleDripCampaigns(),
};

// --- Worker tick ---

async function tick(): Promise<WorkerPollOutcome | null> {
  if (tickInFlight || phase === "stopped") return null;
  tickInFlight = true;

  const tickStart = Date.now();
  try {
    const { finalized, dispatched, processed, scheduled, scheduledPeriodic, scheduledDrip } = await runWorkerCycle(executionMode, operations);

    tickCount++;
    totalDispatched += dispatched;
    totalProcessed += processed;
    totalFinalized += finalized;
    totalScheduledDaily += scheduled;
    totalScheduledPeriodic += scheduledPeriodic;
    // not tracking scheduledDrip in prometheus metrics for now to avoid boilerplate
    lastTickMs = Date.now() - tickStart;
    lastError = null;
    lastSuccessfulTickAt = new Date().toISOString();
    const outcome = getWorkerPollOutcome({
      finalized,
      dispatched,
      eventBatchSize: EVENT_BATCH_SIZE,
      processed,
      jobBatchSize: JOB_BATCH_SIZE,
      scheduled,
      scheduledPeriodic,
      scheduledDrip,
    });

    if (outcome.workDone) {
      lastWorkAt = lastSuccessfulTickAt;
      log("info", {
        event: "tick",
        finalized,
        dispatched,
        processed,
        scheduled,
        scheduledPeriodic,
        fastDrain: outcome.fastDrain,
        durationMs: lastTickMs,
      });
      return outcome;
    }
    return outcome;
  } catch (error) {
    lastTickMs = Date.now() - tickStart;
    lastError = error instanceof Error ? error.message : "Unknown error";
    Sentry.captureException(error, {
      tags: { component: "worker", workerId },
      extra: { event: "tick_error", durationMs: lastTickMs },
    });
    void captureErrorTelemetry({
      action: "tick",
      attributes: {
        duration_ms: lastTickMs,
        worker_id: workerId,
      },
      code: "WORKER_TICK_ERROR",
      error,
      status: 500,
      surface: "worker",
    });
    log("error", {
      event: "tick_error",
      error: lastError,
      durationMs: lastTickMs,
    });
    return { workDone: false, fastDrain: false };
  } finally {
    tickInFlight = false;
  }
}

// --- Health endpoint ---

function startHealthServer() {
  const server = createServer((req, res) => {
    if (req.url === "/health" || req.url === "/healthz") {
      const healthy = phase === "running" || phase === "starting";
      const status = {
        status: healthy ? "ok" : "draining",
        workerId,
        executionMode,
        phase,
        tickCount,
        totalDispatched,
        totalProcessed,
        totalFinalized,
        totalScheduledDaily,
        totalScheduledPeriodic,
        lastTickMs,
        lastSuccessfulTickAt,
        lastWorkAt,
        lastError,
        release,
        uptime: process.uptime(),
        memoryMB: Math.round(process.memoryUsage().heapUsed / 1024 / 1024),
      };
      res.writeHead(healthy ? 200 : 503, { "Content-Type": "application/json" });
      res.end(JSON.stringify(status));
      return;
    }

    if (req.url === "/ready") {
      const ready = phase === "running" && !tickInFlight;
      res.writeHead(ready ? 200 : 503, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ ready, phase, executionMode }));
      return;
    }

    if (req.url === "/metrics") {
      const lines = [
        `# HELP worker_tick_count Total number of poll ticks`,
        `# TYPE worker_tick_count counter`,
        `worker_tick_count{worker="${workerId}"} ${tickCount}`,
        `# HELP worker_dispatched_total Total events dispatched`,
        `# TYPE worker_dispatched_total counter`,
        `worker_dispatched_total{worker="${workerId}"} ${totalDispatched}`,
        `# HELP worker_processed_total Total jobs processed`,
        `# TYPE worker_processed_total counter`,
        `worker_processed_total{worker="${workerId}"} ${totalProcessed}`,
        `# HELP worker_scheduled_daily_total Total daily jobs scheduled`,
        `# TYPE worker_scheduled_daily_total counter`,
        `worker_scheduled_daily_total{worker="${workerId}"} ${totalScheduledDaily}`,
        `# HELP worker_scheduled_periodic_total Total periodic jobs scheduled`,
        `# TYPE worker_scheduled_periodic_total counter`,
        `worker_scheduled_periodic_total{worker="${workerId}"} ${totalScheduledPeriodic}`,
        `# HELP worker_last_tick_ms Duration of last tick in ms`,
        `# TYPE worker_last_tick_ms gauge`,
        `worker_last_tick_ms{worker="${workerId}"} ${lastTickMs}`,
        ...renderWorkflowJobMetrics(workerId),
        `# HELP worker_memory_bytes Heap memory used`,
        `# TYPE worker_memory_bytes gauge`,
        `worker_memory_bytes{worker="${workerId}"} ${process.memoryUsage().heapUsed}`,
      ];
      res.writeHead(200, { "Content-Type": "text/plain; charset=utf-8" });
      res.end(lines.join("\n") + "\n");
      return;
    }

    res.writeHead(404);
    res.end("Not found");
  });

  server.listen(HEALTH_PORT, () => {
    log("info", {
      event: "health_server_started",
      port: HEALTH_PORT,
      release: {
        gitSha: release.gitSha,
        version: release.version,
        source: release.source.gitSha,
        drift: release.drift,
      },
    });
  });

  return server;
}

// --- Graceful shutdown ---

async function shutdown(signal: string) {
  if (phase === "draining" || phase === "stopped") return;

  log("info", { event: "shutdown_initiated", signal });
  phase = "draining";

  if (executionMode === "scheduler-once") {
    // Let the in-flight cycle release its advisory lock and disconnect normally.
    // A signaled scheduled execution is not silently promoted to successful completion.
    process.exitCode = signal === "SIGINT" ? 130 : 143;
    return;
  }

  // Stop polling
  if (pollTimer) {
    clearTimeout(pollTimer);
    pollTimer = null;
  }

  // Wait for in-flight tick to complete
  const deadline = Date.now() + SHUTDOWN_TIMEOUT_MS;
  while (tickInFlight && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 200));
  }

  if (tickInFlight) {
    log("warn", { event: "shutdown_timeout", message: "Tick still in flight at deadline" });
  }

  phase = "stopped";
  log("info", {
    event: "shutdown_complete",
    tickCount,
    totalDispatched,
    totalProcessed,
    totalFinalized,
    totalScheduledDaily,
    totalScheduledPeriodic,
  });

  await prisma.$disconnect();
  process.exit(0);
}

// --- Main ---

async function main() {
  log("info", {
    event: "starting",
    executionMode,
    pollIntervalMs: POLL_INTERVAL_MS,
    eventBatchSize: EVENT_BATCH_SIZE,
    jobBatchSize: JOB_BATCH_SIZE,
    healthPort: HEALTH_PORT,
  });

  if (executionMode === "scheduler-once") {
    let completed: Awaited<ReturnType<typeof runWorkerCycle>> | null = null;
    let skipped = false;
    try {
      assertSchedulerProofRelease(schedulerProofNonce, release);
      const result = await withSchedulerLock(createSchedulerLock(env.DATABASE_URL), () => runWorkerCycle("scheduler-once", operations));
      skipped = result.skipped;
      if (!result.skipped) completed = result.result;
    } catch {
      // Provider errors can include connection details. Keep scheduled-job diagnostics bounded.
      log("error", { event: "scheduler_failed", code: "SCHEDULER_EXECUTION_FAILED" });
      process.exitCode = 1;
    } finally {
      const cleanup = await Promise.allSettled([
        Promise.resolve().then(() => prisma.$disconnect()),
        Promise.resolve().then(() => closeRedisClient()),
      ]);
      if (cleanup.some((result) => result.status === "rejected")) {
        log("error", { event: "scheduler_failed", code: "SCHEDULER_DISCONNECT_FAILED" });
        process.exitCode = 1;
      }
      phase = "stopped";
    }
    if (!process.exitCode) {
      if (completed) log("info", schedulerCompletionReceipt(schedulerProofNonce, release, completed));
      else if (skipped) log("info", { event: "scheduler_skipped", executionMode, proofNonce: schedulerProofNonce, skipped: true, reason: "lock_held" });
    }
    // This is a finite container job: do not remain alive on SDK or telemetry sockets.
    process.exit(Number(process.exitCode) || 0);
    return;
  }

  // Start health server
  startHealthServer();

  // Initial tick
  const initialWork = await tick();
  if (phase === "draining" || phase === "stopped") return;
  phase = "running";
  if (initialWork) {
    currentPollIntervalMs = getNextPollIntervalMs({
      outcome: initialWork,
      pollIntervalMs: POLL_INTERVAL_MS,
      maxPollIntervalMs: MAX_POLL_INTERVAL_MS,
      currentPollIntervalMs,
    });
  }

  // Start polling
  function scheduleNextTick() {
    if (phase !== "running") return;
    pollTimer = setTimeout(() => {
      tick().then((outcome) => {
        if (outcome) {
          currentPollIntervalMs = getNextPollIntervalMs({
            outcome,
            pollIntervalMs: POLL_INTERVAL_MS,
            maxPollIntervalMs: MAX_POLL_INTERVAL_MS,
            currentPollIntervalMs,
          });
        }
        scheduleNextTick();
      }).catch((error) => {
        Sentry.captureException(error, {
          tags: { component: "worker", workerId },
          extra: { event: "unhandled_tick_error" },
        });
        void captureErrorTelemetry({
          action: "scheduleNextTick",
          attributes: {
            worker_id: workerId,
          },
          code: "WORKER_UNHANDLED_TICK_ERROR",
          error,
          status: 500,
          surface: "worker",
        });
        log("error", {
          event: "unhandled_tick_error",
          error: error instanceof Error ? error.message : "Unknown",
        });
        scheduleNextTick();
      });
    }, currentPollIntervalMs);
  }
  scheduleNextTick();

  log("info", { event: "running" });
}

main().catch((error) => {
  Sentry.captureException(error, {
    tags: { component: "worker", workerId },
    extra: { event: "fatal" },
  });
  void captureErrorTelemetry({
    action: "main",
    attributes: {
      worker_id: workerId,
    },
    code: "WORKER_FATAL",
    error,
    status: 500,
    surface: "worker",
  });
  log("error", { event: "fatal", error: error instanceof Error ? error.message : "Unknown" });
  process.exitCode = 1;
});

process.on("SIGINT", () => void shutdown("SIGINT"));
process.on("SIGTERM", () => void shutdown("SIGTERM"));
