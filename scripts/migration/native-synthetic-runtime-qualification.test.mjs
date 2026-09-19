import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import reusedPageReact418Fixture from "./fixtures/reused-page-react418.json" with { type: "json" };
import {
  REUSED_PAGE_REACT_418,
  assertRuntimeLaunchReady,
  failureReceipt,
  measureFreshPages,
  runNativeSyntheticRuntimeQualification,
  sanitizeQualificationDiagnostic,
  syntheticDailyDigestOverrides,
  validateSyntheticRuntimeConfig,
  waitForBaselineQueueDrain,
} from "./native-synthetic-runtime-qualification.mjs";

const FIXED_NOW = 1_700_000_000_000;

function validConfig(overrides = {}) {
  return {
    kind: "native-synthetic-runtime-qualification",
    syntheticFixture: true,
    externalAiProvidersAvailable: false,
    browser: {
      pageIsolation: "fresh-page",
      postRenderObservationMs: 500,
      samples: 2,
    },
    startDeadlineMs: FIXED_NOW + 60_000,
    cleanupDeadlineMs: FIXED_NOW + 120_000,
    scope: "ops-native-synthetic-qualification",
    releaseSha: "a".repeat(40),
    images: { web: `sha256:${"b".repeat(64)}`, worker: `sha256:${"c".repeat(64)}` },
    nowMs: FIXED_NOW,
    ...overrides,
  };
}

function validBootstrap(config) {
  return {
    status: "BOOTSTRAP_ORCHESTRATION_PASS",
    runtimeNonDdl: true,
    scope: config.scope,
    releaseSha: config.releaseSha,
  };
}

describe("sanitizeQualificationDiagnostic", () => {
  it("redacts urls, bearer tokens, query secrets, and long opaque strings", () => {
    const syntheticApiKey = ["sk", "live", "example-value"].join("-");
    const raw =
      "GET https://api.example.com/v1/workspaces?token=super-secret-value Bearer eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.abc " +
      "password=plain-text secret=another-one key=short ok=1 " +
      `apiKey: ${syntheticApiKey} password: hunter2 cookie: session-value ` +
      "Authorization: Basic dXNlcjpwYXNz opaque=abcdefghijklmnopqrstuvwxyz0123456789ABCDEF";

    const sanitized = sanitizeQualificationDiagnostic(raw);

    expect(sanitized).toContain("https://api.example.com/v1/workspaces");
    expect(sanitized).not.toContain("super-secret-value");
    expect(sanitized).not.toContain("plain-text");
    expect(sanitized).not.toContain("another-one");
    expect(sanitized).not.toContain("hunter2");
    expect(sanitized).not.toContain("session-value");
    expect(sanitized).not.toContain("dXNlcjpwYXNz");
    expect(sanitized).not.toContain("abcdefghijklmnopqrstuvwxyz0123456789ABCDEF");
    expect(sanitized).toContain("Bearer [redacted]");
    expect(sanitized).toContain("=[redacted]");
    expect(sanitized).toMatch(/\[redacted\]/u);
    expect(sanitized).not.toMatch(/Bearer\s+eyJ/u);
  });

  it("truncates oversized diagnostics", () => {
    const sanitized = sanitizeQualificationDiagnostic("word ".repeat(400));
    expect(sanitized).toHaveLength(1_000);
  });
});

describe("failureReceipt", () => {
  it("never retains raw secret material in diagnostics", () => {
    const receipt = failureReceipt(
      Object.assign(new Error("Bearer leaked-token password=leaked"), { code: "BASELINE_JOB_FAILED" }),
      { phase: "baseline-queue-drain", operation: "wait-for-existing-maintenance", at: "2026-01-01T00:00:00.000Z" },
    );

    expect(receipt.rawOutputRetained).toBe(false);
    expect(JSON.stringify(receipt.diagnostic)).not.toContain("leaked-token");
    expect(JSON.stringify(receipt.diagnostic)).not.toContain("password");
    expect(receipt.diagnostic).toEqual({ knownCodes: [], flags: [], timedOut: false });
  });
});

describe("syntheticDailyDigestOverrides", () => {
  it("refuses non-synthetic config", () => {
    const config = validConfig({ syntheticFixture: false });
    expect(() => syntheticDailyDigestOverrides(["ws-a"], config)).toThrowError(
      expect.objectContaining({ code: "SYNTHETIC_FIXTURE_REQUIRED" }),
    );
    expect(() =>
      syntheticDailyDigestOverrides(["ws-a"], validConfig({ kind: "other-kind" })),
    ).toThrowError(expect.objectContaining({ code: "SYNTHETIC_FIXTURE_REQUIRED" }));
  });

  it("refuses provider-available config", () => {
    expect(() =>
      syntheticDailyDigestOverrides(["ws-a"], validConfig({ externalAiProvidersAvailable: true })),
    ).toThrowError(expect.objectContaining({ code: "SYNTHETIC_AI_OVERRIDE_FORBIDDEN" }));
  });

  it("deduplicates workspace ids and disables daily digest", () => {
    const overrides = syntheticDailyDigestOverrides(["ws-a", "ws-b", "ws-a", "ws-b"], validConfig());

    expect(overrides).toHaveLength(2);
    expect(overrides.map(entry => entry.workspaceId)).toEqual(["ws-a", "ws-b"]);
    expect(overrides.every(entry => entry.enabled === false && entry.agentKey === "daily-digest")).toBe(true);
  });
});

describe("waitForBaselineQueueDrain", () => {
  let nowMs;

  beforeEach(() => {
    nowMs = FIXED_NOW;
  });

  function drainDeps({ jobsSequence, worker = { phase: "idle", tickCount: 3, lastTickMs: FIXED_NOW } }) {
    let readCount = 0;
    return {
      readJobs: vi.fn(async () => jobsSequence[Math.min(readCount++, jobsSequence.length - 1)]),
      readWorkerHealth: vi.fn(async () => worker),
      record: vi.fn(async () => {}),
      deadlineMs: FIXED_NOW + 30_000,
      pollMs: 5_000,
      now: () => nowMs,
      wait: vi.fn(async () => {
        nowMs += 5_000;
      }),
    };
  }

  it("returns when the queue is fully drained", async () => {
    const deps = drainDeps({
      jobsSequence: [
        [{ type: "maintenance", status: "RUNNING" }],
        [{ type: "maintenance", status: "COMPLETED" }],
      ],
    });

    const result = await waitForBaselineQueueDrain(deps);

    expect(result.status).toBe("BASELINE_QUEUE_DRAINED");
    expect(result.unfinished).toBe(0);
    expect(deps.wait).toHaveBeenCalledTimes(1);
    expect(deps.record).toHaveBeenCalledTimes(2);
  });

  it("fails fast when a baseline job failed", async () => {
    const deps = drainDeps({
      jobsSequence: [[{ type: "maintenance", status: "FAILED" }]],
    });

    await expect(waitForBaselineQueueDrain(deps)).rejects.toMatchObject({
      code: "BASELINE_JOB_FAILED",
      receipt: expect.objectContaining({ failed: 1 }),
    });
    expect(deps.wait).not.toHaveBeenCalled();
  });

  it("times out when unfinished work remains past the deadline", async () => {
    const deps = drainDeps({
      jobsSequence: [[{ type: "maintenance", status: "PENDING" }]],
    });
    deps.deadlineMs = FIXED_NOW;

    await expect(waitForBaselineQueueDrain(deps)).rejects.toMatchObject({
      code: "BASELINE_QUEUE_DRAIN_TIMEOUT",
      receipt: expect.objectContaining({ unfinished: 1 }),
    });
  });
});

describe("measureFreshPages", () => {
  it("creates and closes a distinct page per sample and preserves the React 418 marker", async () => {
    const pages = [];
    const context = {
      newPage: vi.fn(async () => {
        const page = {
          id: `page-${pages.length + 1}`,
          close: vi.fn(async () => {}),
        };
        pages.push(page);
        return page;
      }),
    };
    const wait = vi.fn(async () => {});

    const result = await measureFreshPages({
      context,
      samples: 2,
      postRenderObservationMs: 500,
      configurePage: vi.fn(async () => ({ cacheDisabled: true })),
      measurePage: vi.fn(async (page, index) => ({ ok: true, pageId: page.id, index })),
      observePage: vi.fn(async () => ({ ok: true, pageErrors: 0, resourceErrors: 0 })),
      wait,
    });

    expect(context.newPage).toHaveBeenCalledTimes(2);
    expect(pages.map(page => page.id)).toEqual(["page-1", "page-2"]);
    expect(pages.every(page => page.close.mock.calls.length === 1)).toBe(true);
    expect(wait).toHaveBeenCalledTimes(2);
    expect(wait.mock.calls.every(([ms]) => ms === 500)).toBe(true);
    expect(result.regression).toEqual(REUSED_PAGE_REACT_418);
    expect(result.regression.reactCode).toBe(reusedPageReact418Fixture.reactCode);
    expect(result.regression.status).toBe(reusedPageReact418Fixture.status);
    expect(result.regression.lifecycle).toBe(reusedPageReact418Fixture.lifecycle);
    expect(result.regression.freshPagePassingDoesNotResolve).toBe(true);
  });

  it("fails and closes the fresh page when the post-render observation sees an error", async () => {
    const page = { close: vi.fn(async () => {}) };
    await expect(measureFreshPages({
      context: { newPage: vi.fn(async () => page) },
      samples: 1,
      postRenderObservationMs: 500,
      configurePage: vi.fn(async () => ({ cacheDisabled: true })),
      measurePage: vi.fn(async () => ({ ok: true })),
      observePage: vi.fn(async () => ({ ok: false, pageErrors: 1, reactCode: "418" })),
      wait: vi.fn(async () => {}),
    })).rejects.toMatchObject({ code: "FRESH_PAGE_SAMPLE_FAILED" });
    expect(page.close).toHaveBeenCalledTimes(1);
  });
});

describe("assertRuntimeLaunchReady", () => {
  it("rejects bootstrap binding mismatches", () => {
    const config = validConfig();

    expect(() =>
      assertRuntimeLaunchReady({
        config,
        bootstrap: validBootstrap(config),
        now: FIXED_NOW,
      }),
    ).not.toThrow();

    expect(() =>
      assertRuntimeLaunchReady({
        config,
        bootstrap: { ...validBootstrap(config), scope: "other-scope" },
        now: FIXED_NOW,
      }),
    ).toThrowError(expect.objectContaining({ code: "BOOTSTRAP_RUNTIME_BINDING_MISMATCH" }));

    expect(() =>
      assertRuntimeLaunchReady({
        config,
        bootstrap: { ...validBootstrap(config), releaseSha: "other-release" },
        now: FIXED_NOW,
      }),
    ).toThrowError(expect.objectContaining({ code: "BOOTSTRAP_RUNTIME_BINDING_MISMATCH" }));

    expect(() =>
      assertRuntimeLaunchReady({
        config,
        bootstrap: { ...validBootstrap(config), status: "BOOTSTRAP_FAILED" },
        now: FIXED_NOW,
      }),
    ).toThrowError(expect.objectContaining({ code: "BOOTSTRAP_ACCEPTANCE_REQUIRED" }));
  });
});

describe("runNativeSyntheticRuntimeQualification", () => {
  let config;
  let bootstrap;
  let nowMs;
  let phaseLog;

  beforeEach(() => {
    config = validConfig();
    bootstrap = validBootstrap(config);
    nowMs = FIXED_NOW;
    phaseLog = [];
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  function buildAdapter(overrides = {}) {
    const queueDrain = {
      readJobs: vi.fn(async () => [{ type: "maintenance", status: "COMPLETED" }]),
      readWorkerHealth: vi.fn(async () => ({ phase: "idle", tickCount: 1, lastTickMs: nowMs })),
      record: vi.fn(async receipt => {
        phaseLog.push(`queue:${receipt.unfinished}`);
      }),
      deadlineMs: config.startDeadlineMs,
      pollMs: 5_000,
      now: () => nowMs,
      wait: vi.fn(async () => {
        nowMs += 5_000;
      }),
      ...(overrides.queueDrain ?? {}),
    };

    return {
      startup: vi.fn(async () => {
        phaseLog.push("startup");
        return { phase: "startup", status: "RUNTIME_STARTUP_PASS", scope: config.scope,
          releaseSha: config.releaseSha, images: config.images };
      }),
      overlap: vi.fn(async () => {
        phaseLog.push("overlap");
        return { phase: "overlap", status: "OK" };
      }),
      queueDrain,
      gracefulRecovery: vi.fn(async () => {
        phaseLog.push("graceful-recovery");
        return { phase: "graceful-recovery", status: "OK" };
      }),
      forcedRecovery: vi.fn(async () => {
        phaseLog.push("forced-recovery");
        return { phase: "forced-recovery", status: "OK" };
      }),
      soak: vi.fn(async () => {
        phaseLog.push("soak");
        return { phase: "soak", status: "OK" };
      }),
      cleanup: vi.fn(async () => {
        phaseLog.push("cleanup");
        return { ownedResourcesAbsent: true, credentialsRemoved: true };
      }),
      ...overrides,
    };
  }

  it("runs adapter phases in order and returns cleanup proof on success", async () => {
    const adapter = buildAdapter();
    const result = await runNativeSyntheticRuntimeQualification({
      config,
      bootstrap,
      adapter,
      now: () => nowMs,
    });

    expect(phaseLog).toEqual(["startup", "overlap", "queue:0", "graceful-recovery", "forced-recovery", "soak", "cleanup"]);
    expect(adapter.startup.mock.invocationCallOrder[0]).toBeLessThan(adapter.overlap.mock.invocationCallOrder[0]);
    expect(adapter.overlap.mock.invocationCallOrder[0]).toBeLessThan(adapter.gracefulRecovery.mock.invocationCallOrder[0]);
    expect(adapter.gracefulRecovery.mock.invocationCallOrder[0]).toBeLessThan(
      adapter.forcedRecovery.mock.invocationCallOrder[0],
    );
    expect(adapter.forcedRecovery.mock.invocationCallOrder[0]).toBeLessThan(adapter.soak.mock.invocationCallOrder[0]);
    expect(adapter.soak.mock.invocationCallOrder[0]).toBeLessThan(adapter.cleanup.mock.invocationCallOrder[0]);
    expect(adapter.cleanup).toHaveBeenCalledTimes(1);
    expect(result.status).toBe("SYNTHETIC_RUNTIME_QUALIFICATION_PASS");
    expect(result.cleanup).toEqual({ ownedResourcesAbsent: true, credentialsRemoved: true });
    expect(result.regression).toEqual(REUSED_PAGE_REACT_418);
  });

  it("always runs cleanup after a primary failure", async () => {
    const adapter = buildAdapter({
      overlap: vi.fn(async () => {
        phaseLog.push("overlap");
        throw Object.assign(new Error("overlap failed"), { code: "OVERLAP_FAILED" });
      }),
    });

    await expect(
      runNativeSyntheticRuntimeQualification({
        config,
        bootstrap,
        adapter,
        now: () => nowMs,
      }),
    ).rejects.toMatchObject({
      code: "OVERLAP_FAILED",
      receipt: expect.objectContaining({
        phase: "overlap",
        operation: "overlap",
        status: "FAILED",
      }),
      cleanup: { ownedResourcesAbsent: true, credentialsRemoved: true },
    });

    expect(adapter.cleanup).toHaveBeenCalledTimes(1);
    expect(phaseLog.at(-1)).toBe("cleanup");
  });

  it("stops after cleanup when startup does not attest the exact runtime binding", async () => {
    const adapter = buildAdapter({
      startup: vi.fn(async () => ({ status: "RUNTIME_STARTUP_PASS", scope: config.scope,
        releaseSha: config.releaseSha, images: { ...config.images, worker: `sha256:${"d".repeat(64)}` } })),
    });
    await expect(runNativeSyntheticRuntimeQualification({ config, bootstrap, adapter, now: () => nowMs }))
      .rejects.toMatchObject({ code: "RUNTIME_STARTUP_BINDING_MISMATCH" });
    expect(adapter.overlap).not.toHaveBeenCalled();
    expect(adapter.cleanup).toHaveBeenCalledTimes(1);
  });

  it("fails when cleanup proof is missing", async () => {
    const adapter = buildAdapter({
      cleanup: vi.fn(async () => {
        phaseLog.push("cleanup");
        return { ownedResourcesAbsent: false, credentialsRemoved: true };
      }),
    });

    await expect(
      runNativeSyntheticRuntimeQualification({
        config,
        bootstrap,
        adapter,
        now: () => nowMs,
      }),
    ).rejects.toMatchObject({
      code: "QUALIFICATION_CLEANUP_UNPROVEN",
      receipt: expect.objectContaining({
        phase: "cleanup",
        operation: "owned-resource-cleanup",
        status: "FAILED",
      }),
    });
  });

  it("reports combined primary and cleanup failures", async () => {
    const adapter = buildAdapter({
      soak: vi.fn(async () => {
        phaseLog.push("soak");
        throw Object.assign(new Error("soak failed"), { code: "SOAK_FAILED" });
      }),
      cleanup: vi.fn(async () => {
        phaseLog.push("cleanup");
        throw Object.assign(new Error("cleanup failed"), { code: "CLEANUP_FAILED" });
      }),
    });

    await expect(
      runNativeSyntheticRuntimeQualification({
        config,
        bootstrap,
        adapter,
        now: () => nowMs,
      }),
    ).rejects.toMatchObject({
      code: "QUALIFICATION_AND_CLEANUP_FAILED",
      primaryCode: "SOAK_FAILED",
      primary: expect.objectContaining({
        phase: "soak",
        operation: "soak-browser-and-metrics",
        status: "FAILED",
      }),
      cleanup: expect.objectContaining({
        phase: "cleanup",
        operation: "owned-resource-cleanup",
        status: "FAILED",
      }),
    });

    expect(adapter.cleanup).toHaveBeenCalledTimes(1);
  });
});

describe("validateSyntheticRuntimeConfig", () => {
  it("accepts a valid synthetic runtime config", () => {
    expect(validateSyntheticRuntimeConfig(validConfig(), FIXED_NOW)).toEqual(validConfig());
  });
});
