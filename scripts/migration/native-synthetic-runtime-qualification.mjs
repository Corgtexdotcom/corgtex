import { setTimeout as delay } from "node:timers/promises";

const CODE = /^[A-Z][A-Z0-9_]+$/u;
const PHASES = Object.freeze([
  "startup",
  "overlap",
  "baseline-queue-drain",
  "graceful-recovery",
  "forced-recovery",
  "soak",
]);

export const REUSED_PAGE_REACT_418 = Object.freeze({
  status: "UNRESOLVED_REGRESSION",
  lifecycle: "reused-page",
  reactCode: "418",
  freshPagePassingDoesNotResolve: true,
});

function qualificationError(code, details = {}) {
  const error = new Error(code);
  error.code = code;
  Object.assign(error, details);
  return error;
}

export function sanitizeQualificationDiagnostic(value) {
  return String(value ?? "")
    .replace(/https?:\/\/[^\s)]+/gu, raw => {
      try {
        const url = new URL(raw);
        return `${url.origin}${url.pathname}`;
      } catch {
        return "[url]";
      }
    })
    .replace(/Bearer\s+[^\s]+/giu, "Bearer [redacted]")
    .replace(/Basic\s+[^\s]+/giu, "Basic [redacted]")
    .replace(/\b(password|secret|token|key|apiKey|cookie|authorization)\s*([:=])\s*[^\s&,;]+/giu, "$1$2[redacted]")
    .replace(/\b(?:sk|pk)-(?:live|test)-[a-zA-Z0-9_-]+\b/gu, "[redacted]")
    .replace(/\b[a-zA-Z0-9_=-]{32,}\b/gu, "[redacted]")
    .slice(0, 1_000);
}

function diagnosticSignals(error) {
  const raw = String(error?.message ?? "");
  return {
    knownCodes: [...new Set(raw.match(/\b(?:P[0-9]{4}|42[0-9A-Z]{3}|ECONNREFUSED|EACCES|ETIMEDOUT)\b/gu) ?? [])],
    flags: [
      "permission denied",
      "does not exist",
      "connection refused",
      "invalid input",
      "unique constraint",
      "foreign key constraint",
      "unknown argument",
    ].filter(flag => raw.toLowerCase().includes(flag)),
    timedOut: error?.code === "ETIMEDOUT" || error?.name === "TimeoutError",
  };
}

export function failureReceipt(error, { phase, operation, at = new Date().toISOString() }) {
  return {
    status: "FAILED",
    phase,
    operation,
    code: CODE.test(error?.code ?? "") ? error.code : "QUALIFICATION_OPERATION_FAILED",
    diagnostic: diagnosticSignals(error),
    rawOutputRetained: false,
    at,
  };
}

export function validateSyntheticRuntimeConfig(config, now = Date.now()) {
  if (config?.kind !== "native-synthetic-runtime-qualification" || config.syntheticFixture !== true) {
    throw qualificationError("SYNTHETIC_FIXTURE_REQUIRED");
  }
  if (config.externalAiProvidersAvailable !== false) {
    throw qualificationError("SYNTHETIC_AI_OVERRIDE_FORBIDDEN");
  }
  if (config.browser?.pageIsolation !== "fresh-page" || config.browser?.postRenderObservationMs < 500) {
    throw qualificationError("FRESH_PAGE_MEASUREMENT_REQUIRED");
  }
  if (!Number.isInteger(config.browser.samples) || config.browser.samples < 1) {
    throw qualificationError("BROWSER_SAMPLE_COUNT_INVALID");
  }
  if (!/^ops-native-[a-z0-9-]{8,40}$/u.test(config.scope) || !/^[a-f0-9]{40}$/u.test(config.releaseSha)) {
    throw qualificationError("EXACT_RUNTIME_BINDING_REQUIRED");
  }
  if (![config.images?.web, config.images?.worker].every(image => /^sha256:[a-f0-9]{64}$/u.test(image ?? ""))) {
    throw qualificationError("IMMUTABLE_RUNTIME_IMAGES_REQUIRED");
  }
  if (!Number.isFinite(config.startDeadlineMs) || config.startDeadlineMs <= now) {
    throw qualificationError("RUNTIME_START_WINDOW_EXHAUSTED");
  }
  if (!Number.isFinite(config.cleanupDeadlineMs) || config.cleanupDeadlineMs <= config.startDeadlineMs) {
    throw qualificationError("CLEANUP_RESERVE_REQUIRED");
  }
  return config;
}

export function syntheticDailyDigestOverrides(workspaceIds, config) {
  validateSyntheticRuntimeConfig(config, config.nowMs ?? Date.now());
  const unique = [...new Set(workspaceIds)];
  if (!unique.length || unique.some(id => typeof id !== "string" || !id)) {
    throw qualificationError("SYNTHETIC_WORKSPACE_SET_INVALID");
  }
  return unique.map(workspaceId => ({
    workspaceId,
    agentKey: "daily-digest",
    enabled: false,
    reason: "No external AI provider in isolated synthetic qualification",
  }));
}

export function summarizeQueue(jobs) {
  const counts = {};
  let unfinished = 0;
  let failed = 0;
  for (const job of jobs) {
    const key = `${job.type}:${job.status}`;
    counts[key] = (counts[key] ?? 0) + 1;
    if (["PENDING", "RUNNING"].includes(job.status)) unfinished++;
    if (job.status === "FAILED") failed++;
  }
  return { total: jobs.length, unfinished, failed, counts };
}

export async function waitForBaselineQueueDrain({
  readJobs,
  readWorkerHealth,
  record,
  deadlineMs,
  pollMs = 5_000,
  now = Date.now,
  wait = delay,
}) {
  for (;;) {
    const summary = summarizeQueue(await readJobs());
    const worker = await readWorkerHealth();
    const receipt = {
      at: new Date(now()).toISOString(),
      ...summary,
      worker: {
        phase: worker.phase,
        tickCount: worker.tickCount,
        lastTickMs: worker.lastTickMs,
      },
    };
    await record(receipt);
    if (summary.failed) throw qualificationError("BASELINE_JOB_FAILED", { receipt });
    if (!summary.unfinished) return { status: "BASELINE_QUEUE_DRAINED", ...receipt };
    if (now() >= deadlineMs) throw qualificationError("BASELINE_QUEUE_DRAIN_TIMEOUT", { receipt });
    await wait(pollMs);
  }
}

export async function measureFreshPages({
  context,
  samples,
  postRenderObservationMs,
  configurePage,
  measurePage,
  observePage,
  wait = delay,
}) {
  const results = [];
  for (let index = 0; index < samples; index++) {
    const page = await context.newPage();
    try {
      const pageSetup = await configurePage(page, index);
      if (pageSetup?.cacheDisabled !== true) throw qualificationError("BROWSER_CACHE_DISABLE_UNPROVEN");
      const result = await measurePage(page, index);
      await wait(postRenderObservationMs);
      const observation = await observePage(page, index);
      const sample = { ...result, observation, index, postRenderObservationMs };
      results.push(sample);
      if (result.ok !== true || observation?.ok !== true) {
        throw qualificationError("FRESH_PAGE_SAMPLE_FAILED", { index, result: sample });
      }
    } finally {
      await page.close();
    }
  }
  return {
    status: "FRESH_PAGE_MEASUREMENT_PASS",
    pageIsolation: "fresh page per full navigation; same authenticated context; cache disabled",
    postRenderObservationMs,
    samples: results,
    regression: REUSED_PAGE_REACT_418,
  };
}

export function assertRuntimeLaunchReady({ config, bootstrap, now = Date.now() }) {
  validateSyntheticRuntimeConfig(config, now);
  if (bootstrap?.status !== "BOOTSTRAP_ORCHESTRATION_PASS" || bootstrap.runtimeNonDdl !== true) {
    throw qualificationError("BOOTSTRAP_ACCEPTANCE_REQUIRED");
  }
  if (bootstrap.scope !== config.scope || bootstrap.releaseSha !== config.releaseSha) {
    throw qualificationError("BOOTSTRAP_RUNTIME_BINDING_MISMATCH");
  }
}

function codeOf(error) {
  return CODE.test(error?.code ?? "") ? error.code : "QUALIFICATION_OPERATION_FAILED";
}

export async function runNativeSyntheticRuntimeQualification({ config, bootstrap, adapter, now = Date.now }) {
  assertRuntimeLaunchReady({ config, bootstrap, now: now() });
  const receipts = [];
  let phase = PHASES[0];
  let operation = "startup";
  let primaryFailure;
  let result;
  try {
    receipts.push(await adapter.startup());
    const startup = receipts.at(-1);
    if (startup?.status !== "RUNTIME_STARTUP_PASS" || startup.scope !== config.scope
      || startup.releaseSha !== config.releaseSha || startup.images?.web !== config.images.web
      || startup.images?.worker !== config.images.worker) {
      throw qualificationError("RUNTIME_STARTUP_BINDING_MISMATCH");
    }
    phase = PHASES[1];
    operation = "overlap";
    receipts.push(await adapter.overlap());
    phase = PHASES[2];
    operation = "wait-for-existing-maintenance";
    receipts.push(await waitForBaselineQueueDrain({
      ...adapter.queueDrain,
      deadlineMs: Math.min(adapter.queueDrain.deadlineMs, config.startDeadlineMs),
    }));
    phase = PHASES[3];
    operation = "restart-graceful";
    receipts.push(await adapter.gracefulRecovery());
    phase = PHASES[4];
    operation = "restart-forced";
    receipts.push(await adapter.forcedRecovery());
    phase = PHASES[5];
    operation = "soak-browser-and-metrics";
    receipts.push(await adapter.soak());
    result = { status: "SYNTHETIC_RUNTIME_QUALIFICATION_PASS", receipts, regression: REUSED_PAGE_REACT_418 };
  } catch (error) {
    primaryFailure = error;
    result = failureReceipt(error, { phase, operation });
  }

  let cleanup;
  try {
    cleanup = await adapter.cleanup();
    if (cleanup?.ownedResourcesAbsent !== true || cleanup?.credentialsRemoved !== true || now() > config.cleanupDeadlineMs) {
      throw qualificationError("QUALIFICATION_CLEANUP_UNPROVEN");
    }
  } catch (error) {
    const cleanupFailure = failureReceipt(error, { phase: "cleanup", operation: "owned-resource-cleanup" });
    if (primaryFailure) {
      throw qualificationError("QUALIFICATION_AND_CLEANUP_FAILED", {
        primaryCode: codeOf(primaryFailure),
        primary: result,
        cleanup: cleanupFailure,
      });
    }
    throw Object.assign(error, { receipt: cleanupFailure });
  }

  if (primaryFailure) throw Object.assign(primaryFailure, { receipt: result, cleanup });
  return { ...result, cleanup };
}
