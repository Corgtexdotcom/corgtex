import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const {
  configureControlPlaneMeetingRecorderIntegration,
  getControlPlaneIntegrationStatus,
  isDatabaseUnavailableError,
  resolveControlPlaneRequestActor,
  runControlPlaneMeetingRecorderOperation,
} = vi.hoisted(() => ({
  configureControlPlaneMeetingRecorderIntegration: vi.fn(),
  getControlPlaneIntegrationStatus: vi.fn(),
  isDatabaseUnavailableError: vi.fn(),
  resolveControlPlaneRequestActor: vi.fn(),
  runControlPlaneMeetingRecorderOperation: vi.fn(),
}));

class MockAppError extends Error {
  status: number;
  code: string;

  constructor(status: number, code: string, message: string) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

vi.mock("@/lib/auth", () => ({
  resolveControlPlaneRequestActor,
}));

vi.mock("@corgtex/domain", () => ({
  AppError: MockAppError,
  configureControlPlaneMeetingRecorderIntegration,
  getControlPlaneIntegrationStatus,
  runControlPlaneMeetingRecorderOperation,
}));

vi.mock("@corgtex/shared", () => ({
  env: {
    get CONTROL_PLANE_MODE() {
      return process.env.CONTROL_PLANE_MODE === "true" || process.env.CONTROL_PLANE_MODE === "1";
    },
  },
  isDatabaseUnavailableError,
}));

function request(body: unknown) {
  return new Request("http://localhost/api/control-plane/deployments/inst-1/integrations", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

describe("control-plane deployment integrations API", () => {
  beforeEach(() => {
    vi.resetModules();
    vi.stubEnv("CONTROL_PLANE_MODE", "true");
    vi.clearAllMocks();
    resolveControlPlaneRequestActor.mockResolvedValue({ kind: "user", user: { id: "operator-1" } });
    isDatabaseUnavailableError.mockReturnValue(false);
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("rejects overflowed meeting recorder smoke timestamps", async () => {
    const { POST } = await import("./route");

    const response = await POST(request({
      integrationKey: "meeting_recorders",
      operation: "live_smoke",
      meetingUrl: "https://teams.microsoft.com/l/meetup-join/test",
      joinAt: "2026-02-31T10:00:00Z",
      reason: "Run live smoke.",
    }) as never, { params: Promise.resolve({ deploymentId: "inst-1" }) });

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toEqual({
      error: {
        code: "INVALID_INPUT",
        message: "joinAt must be a valid timestamp.",
      },
    });
    expect(runControlPlaneMeetingRecorderOperation).not.toHaveBeenCalled();
  });
});
