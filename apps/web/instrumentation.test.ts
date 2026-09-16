import { afterEach, describe, expect, it, vi } from "vitest";
const mocks = vi.hoisted(() => ({ edge: vi.fn(), node: vi.fn(), sentry: vi.fn() }));
vi.mock("@sentry/nextjs", () => ({ captureRequestError: mocks.sentry, init: vi.fn() }));
vi.mock("@corgtex/shared/telemetry", () => ({ captureErrorTelemetry: mocks.edge }));
vi.mock("@corgtex/shared/telemetry-node", () => ({ captureErrorTelemetry: mocks.node }));
import { onRequestError } from "./instrumentation";
afterEach(() => { vi.unstubAllEnvs(); vi.clearAllMocks(); });
describe("instrumentation runtime boundary", () => {
  it.each(["edge", "nodejs"])("uses only the %s telemetry adapter", async runtime => {
    vi.stubEnv("NEXT_RUNTIME", runtime);
    await onRequestError(new Error("synthetic"), { method: "POST" }, { routeType: "action" });
    expect(runtime === "edge" ? mocks.edge : mocks.node).toHaveBeenCalledWith(expect.objectContaining({ surface: "server_action" }));
    expect(runtime === "edge" ? mocks.node : mocks.edge).not.toHaveBeenCalled();
  });
});
