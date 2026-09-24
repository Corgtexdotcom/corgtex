import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  finalize: vi.fn(), dispatch: vi.fn(), process: vi.fn(), daily: vi.fn(), periodic: vi.fn(), drip: vi.fn(),
  disconnect: vi.fn(), closeRedis: vi.fn(), logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
  releaseMetadata: {
    version: "main-aaaaaaaaaaaa", imageTag: "sha-" + "a".repeat(40),
    runtime: { gitSha: "a".repeat(40), evidence: "baked" },
    drift: { version: false, imageTag: false, gitSha: false, details: [] as string[] },
  },
  createServer: vi.fn(), acquire: vi.fn(), release: vi.fn(), disconnectLock: vi.fn(),
}));
vi.mock("@corgtex/shared", () => ({ env: { DATABASE_URL: "postgresql://localhost/synthetic" }, prisma: { $disconnect: mocks.disconnect }, closeRedisClient: mocks.closeRedis, logger: mocks.logger }));
vi.mock("@corgtex/shared/telemetry-node", () => ({ captureErrorTelemetry: vi.fn() }));
vi.mock("@corgtex/shared/release-metadata-node", () => ({ resolveNodeReleaseMetadata: () => mocks.releaseMetadata }));
vi.mock("@corgtex/domain", () => ({ finalizeExpiredApprovalFlows: mocks.finalize }));
vi.mock("@corgtex/workflows", () => ({ dispatchPendingEvents: mocks.dispatch, runPendingJobs: mocks.process, scheduleDailyJobs: mocks.daily, schedulePeriodicJobs: mocks.periodic, scheduleDripCampaigns: mocks.drip, renderWorkflowJobMetrics: vi.fn() }));
vi.mock("@sentry/node", () => ({ init: vi.fn(), captureException: vi.fn() }));
vi.mock("node:http", () => ({ createServer: mocks.createServer }));
vi.mock("./scheduler", async (importOriginal) => ({
  ...await importOriginal<typeof import("./scheduler")>(),
  createSchedulerLock: () => ({ acquire: mocks.acquire, release: mocks.release, disconnect: mocks.disconnectLock }),
}));

let signals: Map<string, () => void>;
let exit: ReturnType<typeof vi.spyOn>;
let previousExitCode: typeof process.exitCode;
beforeEach(() => {
  vi.resetModules();
  vi.clearAllMocks();
  for (const operation of [mocks.finalize, mocks.dispatch, mocks.process, mocks.daily, mocks.periodic, mocks.drip]) operation.mockResolvedValue(0);
  mocks.acquire.mockResolvedValue(true);
  mocks.release.mockResolvedValue(undefined);
  mocks.disconnectLock.mockResolvedValue(undefined);
  mocks.disconnect.mockResolvedValue(undefined);
  mocks.closeRedis.mockResolvedValue(undefined);
  vi.stubEnv("WORKER_EXECUTION_MODE", "scheduler-once");
  vi.stubEnv("WORKER_SCHEDULER_PROOF_NONCE", undefined);
  mocks.releaseMetadata.runtime.evidence = "baked";
  mocks.releaseMetadata.drift.gitSha = false;
  signals = new Map();
  const on = process.on.bind(process);
  vi.spyOn(process, "on").mockImplementation(((signal: string, listener: () => void) => {
    if (signal === "SIGTERM" || signal === "SIGINT") { signals.set(signal, listener); return process; }
    return on(signal, listener);
  }) as typeof process.on);
  exit = vi.spyOn(process, "exit").mockImplementation(() => undefined as never);
  previousExitCode = process.exitCode;
  process.exitCode = undefined;
});
afterEach(() => {
  process.exitCode = previousExitCode;
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

describe("worker entrypoint modes", () => {
  it("reports queue-only mode in both health and readiness", async () => {
    vi.stubEnv("WORKER_EXECUTION_MODE", "queue-only");
    let handler!: (request: { url: string }, response: { writeHead: ReturnType<typeof vi.fn>; end: ReturnType<typeof vi.fn> }) => void;
    mocks.createServer.mockImplementation((listener) => { handler = listener; return { listen: vi.fn() }; });
    await import("./index");
    await vi.waitFor(() => expect(mocks.logger.info).toHaveBeenCalledWith(expect.stringContaining('"event":"running"')));
    for (const url of ["/health", "/ready"]) {
      const response = { writeHead: vi.fn(), end: vi.fn() };
      handler({ url }, response);
      expect(JSON.parse(response.end.mock.calls[0][0])).toMatchObject({ executionMode: "queue-only", phase: "running" });
      expect(response.writeHead).toHaveBeenCalledWith(200, expect.any(Object));
    }
    expect(mocks.finalize).not.toHaveBeenCalled();
    expect(mocks.daily).not.toHaveBeenCalled();
    expect(mocks.dispatch).toHaveBeenCalledOnce();
    expect(mocks.process).toHaveBeenCalledOnce();
    signals.get("SIGTERM")!();
    await vi.waitFor(() => expect(exit).toHaveBeenCalledWith(0));
  });
  it("exits successfully after one scheduling cycle without health server, poller or queue consumption", async () => {
    await import("./index");
    await vi.waitFor(() => expect(exit).toHaveBeenCalledWith(0));
    const receipt = mocks.logger.info.mock.calls.map(([entry]) => JSON.parse(entry)).find((entry) => entry.event === "scheduler_complete");
    expect(receipt).toMatchObject({ executionMode: "scheduler-once", proofNonce: null, skipped: false, release: { gitSha: "a".repeat(40), evidence: "baked" }, counts: { finalized: 0, dispatched: 0, processed: 0, scheduled: 0, scheduledPeriodic: 0, scheduledDrip: 0 } });
    expect(mocks.createServer).not.toHaveBeenCalled();
    expect(mocks.dispatch).not.toHaveBeenCalled();
    expect(mocks.process).not.toHaveBeenCalled();
    for (const operation of [mocks.finalize, mocks.daily, mocks.periodic, mocks.drip, mocks.release, mocks.disconnectLock, mocks.disconnect, mocks.closeRedis]) expect(operation).toHaveBeenCalledOnce();
  });
  it("binds a manual proof nonce to the baked release and actual scheduling counts", async () => {
    const nonce = "manual-proof-" + "b".repeat(32);
    vi.stubEnv("WORKER_SCHEDULER_PROOF_NONCE", nonce);
    mocks.finalize.mockResolvedValue(2);
    mocks.daily.mockResolvedValue(3);
    mocks.periodic.mockResolvedValue(4);
    mocks.drip.mockResolvedValue(5);
    await import("./index");
    await vi.waitFor(() => expect(exit).toHaveBeenCalledWith(0));
    const receipts = mocks.logger.info.mock.calls.map(([entry]) => JSON.parse(entry)).filter((entry) => entry.event === "scheduler_complete");
    expect(receipts).toHaveLength(1);
    expect(receipts[0]).toMatchObject({ proofNonce: nonce, skipped: false, release: { version: mocks.releaseMetadata.version, imageTag: mocks.releaseMetadata.imageTag, drift: mocks.releaseMetadata.drift, gitSha: "a".repeat(40), evidence: "baked" }, counts: { finalized: 2, dispatched: 0, processed: 0, scheduled: 3, scheduledPeriodic: 4, scheduledDrip: 5 } });
  });
  it.each(["legacy", "drift"])("fails manual proof before work for %s release identity", async (condition) => {
    vi.stubEnv("WORKER_SCHEDULER_PROOF_NONCE", "c".repeat(32));
    if (condition === "legacy") mocks.releaseMetadata.runtime.evidence = "legacy_provider";
    else mocks.releaseMetadata.drift.gitSha = true;
    await import("./index");
    await vi.waitFor(() => expect(exit).toHaveBeenCalledWith(1));
    expect(mocks.acquire).not.toHaveBeenCalled();
    expect(mocks.finalize).not.toHaveBeenCalled();
    expect(JSON.stringify(mocks.logger.info.mock.calls)).not.toContain("scheduler_complete");
  });
  it("skips overlap successfully without executing scheduling operations", async () => {
    mocks.acquire.mockResolvedValue(false);
    await import("./index");
    await vi.waitFor(() => expect(exit).toHaveBeenCalledWith(0));
    expect(mocks.finalize).not.toHaveBeenCalled();
    expect(mocks.release).not.toHaveBeenCalled();
    expect(mocks.disconnectLock).toHaveBeenCalledOnce();
    expect(mocks.logger.info).toHaveBeenCalledWith(expect.stringContaining("scheduler_skipped"));
    expect(JSON.stringify(mocks.logger.info.mock.calls)).not.toContain("scheduler_complete");
  });
  it("drains an in-flight cycle on SIGTERM and never converts a later failure into success", async () => {
    let fail!: (error: Error) => void;
    mocks.daily.mockImplementation(() => new Promise((_resolve, reject) => { fail = reject; }));
    await import("./index");
    await vi.waitFor(() => expect(fail).toBeTypeOf("function"));
    signals.get("SIGTERM")!();
    expect(exit).not.toHaveBeenCalled();
    expect(mocks.release).not.toHaveBeenCalled();
    expect(mocks.disconnect).not.toHaveBeenCalled();
    fail(new Error("private provider diagnostic"));
    await vi.waitFor(() => expect(exit).toHaveBeenCalledWith(1));
    expect(mocks.release).toHaveBeenCalledOnce();
    expect(mocks.disconnectLock).toHaveBeenCalledOnce();
    expect(JSON.stringify(mocks.logger.error.mock.calls)).not.toContain("private provider diagnostic");
    expect(JSON.stringify(mocks.logger.info.mock.calls)).not.toContain("scheduler_complete");
  });
  it("waits for successful in-flight work on SIGTERM before exiting nonzero", async () => {
    let finish!: (value: number) => void;
    mocks.daily.mockImplementation(() => new Promise<number>((resolve) => { finish = resolve; }));
    await import("./index");
    await vi.waitFor(() => expect(finish).toBeTypeOf("function"));
    signals.get("SIGTERM")!();
    expect(exit).not.toHaveBeenCalled();
    finish(1);
    await vi.waitFor(() => expect(exit).toHaveBeenCalledWith(143));
    expect(mocks.drip).toHaveBeenCalledOnce();
    expect(mocks.release).toHaveBeenCalledOnce();
    expect(mocks.disconnect).toHaveBeenCalledOnce();
    expect(JSON.stringify(mocks.logger.info.mock.calls)).not.toContain("scheduler_complete");
  });
  it("treats cleanup failure as a failed execution without logging private diagnostics", async () => {
    mocks.closeRedis.mockRejectedValue(new Error("private Redis diagnostic"));
    await import("./index");
    await vi.waitFor(() => expect(exit).toHaveBeenCalledWith(1));
    expect(mocks.disconnect).toHaveBeenCalledOnce();
    expect(JSON.stringify(mocks.logger.error.mock.calls)).not.toContain("private Redis diagnostic");
    expect(JSON.stringify(mocks.logger.info.mock.calls)).not.toContain("scheduler_complete");
  });
  it.each(["", "sensitive\nvalue", "a".repeat(129)])("rejects an invalid proof nonce without logging it", async (nonce) => {
    vi.stubEnv("WORKER_SCHEDULER_PROOF_NONCE", nonce);
    await expect(import("./index")).rejects.toThrow("Invalid WORKER_SCHEDULER_PROOF_NONCE");
    expect(mocks.acquire).not.toHaveBeenCalled();
    expect(mocks.logger.info).not.toHaveBeenCalled();
  });
  it("rejects invalid mode before any work or health listener", async () => {
    vi.stubEnv("WORKER_EXECUTION_MODE", "invalid-sensitive-value");
    await expect(import("./index")).rejects.toThrow("Invalid WORKER_EXECUTION_MODE");
    expect(mocks.acquire).not.toHaveBeenCalled();
    expect(mocks.finalize).not.toHaveBeenCalled();
    expect(mocks.createServer).not.toHaveBeenCalled();
  });
});
