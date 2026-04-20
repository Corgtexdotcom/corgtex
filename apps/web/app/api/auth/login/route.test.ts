import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const {
  listActorWorkspaces,
  loginUserWithPassword,
  isDatabaseUnavailableError,
} = vi.hoisted(() => ({
  listActorWorkspaces: vi.fn(),
  loginUserWithPassword: vi.fn(),
  isDatabaseUnavailableError: vi.fn(),
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
  listActorWorkspaces,
  loginUserWithPassword,
}));

vi.mock("@corgtex/shared", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@corgtex/shared")>();
  return {
    ...actual,
    isDatabaseUnavailableError,
    sessionCookieName: () => "corgtex_session",
  };
});

async function clearRateLimits() {
  const { resetAllRateLimits } = await import("@corgtex/shared");
  resetAllRateLimits();
}

beforeEach(async () => {
  vi.resetModules();
  await clearRateLimits();
});

afterEach(async () => {
  vi.clearAllMocks();
  await clearRateLimits();
});

describe("POST /api/auth/login", () => {
  it("returns LOGIN_UNAVAILABLE when the database is down", async () => {
    loginUserWithPassword.mockRejectedValue(new Error("db down"));
    isDatabaseUnavailableError.mockReturnValue(true);

    const { POST } = await import("./route");
    const response = await POST(
      new Request("http://localhost/api/auth/login", {
        method: "POST",
        headers: {
          "content-type": "application/json",
        },
        body: JSON.stringify({
          email: "admin@example.com",
          password: "password123",
        }),
      }) as never,
    );

    expect(response.status).toBe(503);
    await expect(response.json()).resolves.toEqual({
      error: {
        code: "LOGIN_UNAVAILABLE",
        message: "Login is temporarily unavailable. Try again.",
      },
    });
  });

  it("preserves invalid credential failures", async () => {
    loginUserWithPassword.mockRejectedValue(
      new MockAppError(401, "UNAUTHENTICATED", "Invalid email or password."),
    );
    isDatabaseUnavailableError.mockReturnValue(false);

    const { POST } = await import("./route");
    const response = await POST(
      new Request("http://localhost/api/auth/login", {
        method: "POST",
        headers: {
          "content-type": "application/json",
        },
        body: JSON.stringify({
          email: "admin@example.com",
          password: "password123",
        }),
      }) as never,
    );

    expect(response.status).toBe(401);
    await expect(response.json()).resolves.toEqual({
      error: {
        code: "UNAUTHENTICATED",
        message: "Invalid email or password.",
      },
    });
  });

  it("rate limits repeated login attempts from the same IP", async () => {
    loginUserWithPassword.mockRejectedValue(
      new MockAppError(401, "UNAUTHENTICATED", "Invalid email or password."),
    );
    isDatabaseUnavailableError.mockReturnValue(false);

    const { POST } = await import("./route");
    const makeRequest = () =>
      POST(
        new Request("http://localhost/api/auth/login", {
          method: "POST",
          headers: {
            "content-type": "application/json",
            "x-forwarded-for": "203.0.113.9",
          },
          body: JSON.stringify({
            email: "admin@example.com",
            password: "password123",
          }),
        }) as never,
      );

    for (let attempt = 0; attempt < 20; attempt += 1) {
      const response = await makeRequest();
      expect(response.status).toBe(401);
    }

    const response = await makeRequest();

    expect(response.status).toBe(429);
    await expect(response.json()).resolves.toEqual({
      error: "Too many authentication attempts",
    });
    expect(response.headers.get("Retry-After")).toBeTruthy();
  });
});
