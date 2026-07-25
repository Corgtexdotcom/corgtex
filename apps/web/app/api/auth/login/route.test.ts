import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { randomUUID } from "node:crypto";

const {
  capturePostHogEvent,
  listActorWorkspaces,
  loginUserWithPassword,
  isDatabaseUnavailableError,
} = vi.hoisted(() => ({
  capturePostHogEvent: vi.fn(),
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

vi.mock("@/lib/posthog-server", () => ({
  capturePostHogEvent,
}));

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
  vi.unstubAllEnvs();
  await clearRateLimits();
});

describe("POST /api/auth/login", () => {
  beforeEach(() => {
    capturePostHogEvent.mockResolvedValue({ status: "disabled" });
  });

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
    expect(capturePostHogEvent).toHaveBeenCalledWith({
      event: "corgtex_auth_login_failed",
      distinctId: expect.stringMatching(/^login:/),
      properties: expect.objectContaining({
        code: "LOGIN_UNAVAILABLE",
        method: "password",
        status: 503,
        surface: "auth",
        transient: true,
      }),
      processPersonProfile: false,
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
    expect(capturePostHogEvent).toHaveBeenCalledWith({
      event: "corgtex_auth_login_failed",
      distinctId: expect.stringMatching(/^login:/),
      properties: expect.objectContaining({
        code: "UNAUTHENTICATED",
        method: "password",
        status: 401,
        surface: "auth",
        transient: false,
      }),
      processPersonProfile: false,
    });
  });

  it("returns only the configured workspace on dedicated customer deployments", async () => {
    const expiresAt = new Date("2026-07-24T12:00:00.000Z");
    vi.stubEnv("APP_URL", "https://crina.corgtex.com");
    vi.stubEnv("WORKSPACE_SLUG", "crina");
    loginUserWithPassword.mockResolvedValue({
      token: "session-token",
      expiresAt,
      user: {
        id: "operator-1",
        email: "operator@example.com",
        displayName: "Operator",
        globalRole: "OPERATOR",
      },
    });
    listActorWorkspaces.mockResolvedValue([
      {
        id: "ws-validation",
        slug: "corgtex-validation",
        name: "Corgtex Internal Validation",
      },
      {
        id: "ws-crina",
        slug: "crina",
        name: "CRINA",
      },
    ]);

    const { POST } = await import("./route");
    const response = await POST(
      new Request("https://crina.corgtex.com/api/auth/login", {
        method: "POST",
        headers: {
          "content-type": "application/json",
        },
        body: JSON.stringify({
          email: "operator@example.com",
          password: "password123",
        }),
      }) as never,
    );

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({
      user: {
        id: "operator-1",
        email: "operator@example.com",
        displayName: "Operator",
        globalRole: "OPERATOR",
      },
      workspaces: [
        {
          id: "ws-crina",
          slug: "crina",
          name: "CRINA",
        },
      ],
    });
    expect(response.headers.get("set-cookie")).toContain("corgtex_session=session-token");
    expect(capturePostHogEvent).toHaveBeenCalledWith({
      event: "corgtex_auth_login_succeeded",
      distinctId: "user:operator-1",
      properties: expect.objectContaining({
        workspace_count: 1,
      }),
      processPersonProfile: false,
    });
  });

  it("rate limits repeated login attempts from the same IP", async () => {
    loginUserWithPassword.mockRejectedValue(
      new MockAppError(401, "UNAUTHENTICATED", "Invalid email or password."),
    );
    isDatabaseUnavailableError.mockReturnValue(false);

    const { POST } = await import("./route");
    const clientAddress = `203.0.113.9-${randomUUID()}`;
    const makeRequest = () =>
      POST(
        new Request("http://localhost/api/auth/login", {
          method: "POST",
          headers: {
            "content-type": "application/json",
            "x-forwarded-for": clientAddress,
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
