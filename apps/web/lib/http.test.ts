import { afterEach, describe, expect, it, vi } from "vitest";

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
  });
});
