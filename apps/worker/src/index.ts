import { randomUUID } from "node:crypto";
import { createServer } from "node:http";
import { captureErrorTelemetry, prisma, logger, resolveReleaseMetadata } from "@corgtex/shared";
import { finalizeExpiredApprovalFlows } from "@corgtex/domain";
import { dispatchPendingEvents, renderWorkflowJobMetrics, runPendingJobs, scheduleDailyJobs, schedulePeriodicJobs, scheduleDripCampaigns } from "@corgtex/workflows";
import * as Sentry from "@sentry/node";
import { getNextPollIntervalMs, getWorkerPollOutcome, type WorkerPollOutcome } from "./polling";

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
const release = resolveReleaseMetadata(process.env, { service: "worker" });

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

// --- Worker tick ---

async function tick(): Promise<WorkerPollOutcome | null> {
  if (tickInFlight || phase === "stopped") return null;
  tickInFlight = true;

  const tickStart = Date.now();
  try {
    const finalized = await finalizeExpiredApprovalFlows();
    const dispatched = await dispatchPendingEvents(workerId, EVENT_BATCH_SIZE);
    const processed = await runPendingJobs(workerId, JOB_BATCH_SIZE, JOB_CONCURRENCY);
    const scheduled = await scheduleDailyJobs();
    const scheduledPeriodic = await schedulePeriodicJobs();
    const scheduledDrip = await scheduleDripCampaigns();

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
      res.end(JSON.stringify({ ready, phase }));
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
    pollIntervalMs: POLL_INTERVAL_MS,
    eventBatchSize: EVENT_BATCH_SIZE,
    jobBatchSize: JOB_BATCH_SIZE,
    healthPort: HEALTH_PORT,
  });

  // Start health server
  startHealthServer();

  // Initial tick
  const initialWork = await tick();
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
