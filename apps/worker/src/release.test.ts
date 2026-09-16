import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
const mocks = vi.hoisted(() => ({
  read: vi.fn(), health: null as null | ((request: { url: string }, response: { writeHead: ReturnType<typeof vi.fn>; end: ReturnType<typeof vi.fn> }) => void),
}));
vi.mock("node:fs", () => ({ readFileSync: mocks.read }));
vi.mock("node:http", () => ({ createServer: (handler: typeof mocks.health) => {
  mocks.health = handler;
  return { listen: (_port: number, callback: () => void) => callback() };
} }));
vi.mock("@sentry/node", () => ({ init: vi.fn(), captureException: vi.fn() }));
vi.mock("@corgtex/shared", () => ({ prisma: { $disconnect: vi.fn() }, logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() } }));
vi.mock("@corgtex/domain", () => ({ finalizeExpiredApprovalFlows: async () => 0 }));
vi.mock("@corgtex/workflows", () => ({
  dispatchPendingEvents: async () => 0, runPendingJobs: async () => 0,
  scheduleDailyJobs: async () => 0, schedulePeriodicJobs: async () => 0,
  scheduleDripCampaigns: async () => 0, renderWorkflowJobMetrics: () => [],
}));
beforeEach(() => {
  vi.resetModules(); vi.useFakeTimers();
  vi.spyOn(process, "on").mockReturnValue(process);
  vi.stubEnv("SENTRY_DSN", ""); vi.stubEnv("GITHUB_SHA", "b".repeat(40));
  vi.stubEnv("RAILWAY_GIT_COMMIT_SHA", ""); vi.stubEnv("VERCEL_GIT_COMMIT_SHA", "");
  mocks.read.mockReset();
});
afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); vi.unstubAllEnvs(); });
describe("worker health release integration", () => {
  it.each(["worker", "web"])("validates the baked role %s at the actual worker health endpoint", async role => {
    mocks.read.mockReturnValue(JSON.stringify({ schemaVersion: 1, role, gitSha: "a".repeat(40) }));
    await import("./index");
    const response = { writeHead: vi.fn(), end: vi.fn() };
    mocks.health!({ url: "/health" }, response);
    const health = JSON.parse(response.end.mock.calls[0][0]);
    expect(health.release.runtime).toEqual(role === "worker"
      ? { gitSha: "a".repeat(40), source: "baked", evidence: "baked" }
      : { gitSha: "b".repeat(40), source: "github", evidence: "legacy_provider" });
    expect(health.release.service).toBe("worker");
    expect(response.writeHead).toHaveBeenCalledWith(200, expect.any(Object));
  });
});
