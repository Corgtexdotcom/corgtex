import { afterEach, describe, expect, it, vi } from "vitest";

const { capturePostHogEvent } = vi.hoisted(() => ({
  capturePostHogEvent: vi.fn(),
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

vi.mock("@/lib/posthog-server", () => ({
  capturePostHogEvent,
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
    expect(capturePostHogEvent).toHaveBeenCalledWith({
      event: "corgtex_app_route_error",
      distinctId: "route:UNKNOWN:unknown",
      properties: expect.objectContaining({
        code: "UNAUTHENTICATED",
        status: 401,
        surface: "api",
        transient: false,
      }),
      processPersonProfile: false,
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
    expect(capturePostHogEvent).toHaveBeenCalledWith({
      event: "corgtex_app_route_error",
      distinctId: "route:UNKNOWN:unknown",
      properties: expect.objectContaining({
        code: "SERVICE_UNAVAILABLE",
        status: 503,
        transient: true,
      }),
      processPersonProfile: false,
    });
  });
});
