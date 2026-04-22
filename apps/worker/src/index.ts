import { randomUUID } from "node:crypto";
import { createServer } from "node:http";
import { prisma } from "@corgtex/shared";
import { finalizeExpiredApprovalFlows, autoApproveProposals } from "@corgtex/domain";
import { dispatchPendingEvents, runPendingJobs, scheduleDailyJobs, schedulePeriodicJobs } from "@corgtex/workflows";
import * as Sentry from "@sentry/node";

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
const HEALTH_PORT = Number(process.env.WORKER_HEALTH_PORT ?? "9090");
const SHUTDOWN_TIMEOUT_MS = Number(process.env.WORKER_SHUTDOWN_TIMEOUT_MS ?? "15000");

// --- State ---

type WorkerPhase = "starting" | "running" | "draining" | "stopped";
let phase: WorkerPhase = "starting";
let tickInFlight = false;
let tickCount = 0;
let totalDispatched = 0;
let totalProcessed = 0;
let totalFinalized = 0;
let lastTickMs = 0;
let lastError: string | null = null;
let pollTimer: ReturnType<typeof setTimeout> | null = null;
let currentPollIntervalMs = POLL_INTERVAL_MS;

// --- Logging ---

function log(level: "info" | "warn" | "error", data: Record<string, unknown>) {
  const entry = {
    ts: new Date().toISOString(),
    level,
    component: "worker",
    workerId,
    ...data,
  };
  if (level === "error") {
    console.error(JSON.stringify(entry));
  } else {
    console.info(JSON.stringify(entry));
  }
}

// --- Worker tick ---

async function tick() {
  if (tickInFlight || phase === "stopped") return;
  tickInFlight = true;

  const tickStart = Date.now();
  try {
    const finalized = await finalizeExpiredApprovalFlows();
    const autoApproved = await autoApproveProposals();
    const dispatched = await dispatchPendingEvents(workerId, EVENT_BATCH_SIZE);
    const processed = await runPendingJobs(workerId, JOB_BATCH_SIZE);
    const scheduled = await scheduleDailyJobs();
    const scheduledPeriodic = await schedulePeriodicJobs();

    tickCount++;
    totalDispatched += dispatched;
    totalProcessed += processed;
    totalFinalized += finalized;
    lastTickMs = Date.now() - tickStart;
    lastError = null;

    if (finalized > 0 || dispatched > 0 || processed > 0 || scheduledPeriodic > 0) {
      log("info", {
        event: "tick",
        finalized,
        dispatched,
        processed,
        scheduledPeriodic,
        durationMs: lastTickMs,
      });
      return true;
    }
    return false;
  } catch (error) {
    lastTickMs = Date.now() - tickStart;
    lastError = error instanceof Error ? error.message : "Unknown error";
    Sentry.captureException(error, {
      tags: { component: "worker", workerId },
      extra: { event: "tick_error", durationMs: lastTickMs },
    });
    log("error", {
      event: "tick_error",
      error: lastError,
      durationMs: lastTickMs,
    });
    return false;
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
        lastTickMs,
        lastError,
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
        `# HELP worker_last_tick_ms Duration of last tick in ms`,
        `# TYPE worker_last_tick_ms gauge`,
        `worker_last_tick_ms{worker="${workerId}"} ${lastTickMs}`,
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
    log("info", { event: "health_server_started", port: HEALTH_PORT });
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
  if (initialWork === false) {
    currentPollIntervalMs = Math.min(MAX_POLL_INTERVAL_MS, currentPollIntervalMs * 2);
  }

  // Start polling
  function scheduleNextTick() {
    if (phase !== "running") return;
    pollTimer = setTimeout(() => {
      tick().then((workDone) => {
        if (workDone === true) {
          currentPollIntervalMs = POLL_INTERVAL_MS;
        } else if (workDone === false) {
          currentPollIntervalMs = Math.min(MAX_POLL_INTERVAL_MS, currentPollIntervalMs * 2);
        }
        scheduleNextTick();
      }).catch((error) => {
        Sentry.captureException(error, {
          tags: { component: "worker", workerId },
          extra: { event: "unhandled_tick_error" },
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
  log("error", { event: "fatal", error: error instanceof Error ? error.message : "Unknown" });
  process.exitCode = 1;
});

process.on("SIGINT", () => void shutdown("SIGINT"));
process.on("SIGTERM", () => void shutdown("SIGTERM"));
