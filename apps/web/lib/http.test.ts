import { afterEach, describe, expect, it, vi } from "vitest";

const { captureErrorTelemetry } = vi.hoisted(() => ({
  captureErrorTelemetry: vi.fn(),
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

vi.mock("@corgtex/domain", () => ({
  AppError: MockAppError,
}));

vi.mock("@corgtex/shared/telemetry", () => ({
  captureErrorTelemetry,
}));

afterEach(() => {
  vi.clearAllMocks();
});

describe("handleRouteError", () => {
  it("passes AppError responses through unchanged", async () => {
    const { handleRouteError } = await import("./http");

    const response = handleRouteError(new MockAppError(401, "UNAUTHENTICATED", "Invalid email or password."));

    expect(response.status).toBe(401);
    await expect(response.json()).resolves.toEqual({
      error: {
        code: "UNAUTHENTICATED",
        message: "Invalid email or password.",
      },
    });
    expect(captureErrorTelemetry).toHaveBeenCalledWith({
      attributes: expect.objectContaining({
        feature_surface: "api",
        transient: false,
      }),
      code: "UNAUTHENTICATED",
      error: expect.any(MockAppError),
      method: undefined,
      route: undefined,
      status: 401,
      surface: "route",
      workspaceId: undefined,
    });
  });

  it("maps database availability failures to a 503 response", async () => {
    const { handleRouteError } = await import("./http");
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const error = Object.assign(new Error("Can't reach database server"), {
      name: "PrismaClientInitializationError",
    });

    const response = handleRouteError(error);

    expect(response.status).toBe(503);
    await expect(response.json()).resolves.toEqual({
      error: {
        code: "SERVICE_UNAVAILABLE",
        message: "Service is temporarily unavailable. Try again.",
      },
    });
    expect(consoleError).toHaveBeenCalledWith(
      "Route failed because the database is unavailable.",
      expect.any(Error),
    );
    expect(captureErrorTelemetry).toHaveBeenCalledWith({
      attributes: expect.objectContaining({
        feature_surface: "api",
        transient: true,
      }),
      code: "SERVICE_UNAVAILABLE",
      error,
      method: undefined,
      route: undefined,
      status: 503,
      surface: "route",
      workspaceId: undefined,
    });
  });

  it("returns structured duplicate guard confirmations", async () => {
    const { handleRouteError } = await import("./http");
    const error = Object.assign(new MockAppError(409, "DUPLICATE_GUARD_MATCH", "Duplicate."), {
      candidate: { entityId: "action-1" },
      recommendedResolution: "update_existing",
      allowedResolutions: ["use_existing", "update_existing", "create_new"],
    });

    const response = handleRouteError(error);

    expect(response.status).toBe(409);
    await expect(response.json()).resolves.toEqual({
      status: "duplicate_confirmation_required",
      candidate: { entityId: "action-1" },
      recommendedResolution: "update_existing",
      allowedResolutions: ["use_existing", "update_existing", "create_new"],
    });
  });
});
