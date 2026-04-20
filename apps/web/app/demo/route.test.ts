import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const {
  isDatabaseUnavailableError,
  listActorWorkspaces,
  loginUserWithPassword,
} = vi.hoisted(() => ({
  isDatabaseUnavailableError: vi.fn(),
  listActorWorkspaces: vi.fn(),
  loginUserWithPassword: vi.fn(),
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

const originalAppUrl = process.env.NEXT_PUBLIC_APP_URL;

async function clearRateLimits() {
  const { resetAllRateLimits } = await import("@corgtex/shared");
  resetAllRateLimits();
}

beforeEach(async () => {
  vi.resetModules();
  process.env.NEXT_PUBLIC_APP_URL = "";
  await clearRateLimits();
});

afterEach(async () => {
  vi.clearAllMocks();
  if (originalAppUrl) {
    process.env.NEXT_PUBLIC_APP_URL = originalAppUrl;
  } else {
    delete process.env.NEXT_PUBLIC_APP_URL;
  }
  await clearRateLimits();
});

describe("GET /demo", () => {
  it("creates a demo session cookie and redirects into the demo workspace", async () => {
    loginUserWithPassword.mockResolvedValue({
      token: "demo-token",
      expiresAt: new Date("2026-04-13T00:00:00.000Z"),
      user: {
        id: "user-1",
        email: "demo@jnj-demo.corgtex.app",
      },
    });
    listActorWorkspaces.mockResolvedValue([
      { id: "workspace-1", slug: "jnj-demo" },
      { id: "workspace-2", slug: "other" },
    ]);
    isDatabaseUnavailableError.mockReturnValue(false);

    const { GET } = await import("./route");
    const response = await GET(
      new Request("http://localhost/demo", {
        headers: {
          "x-forwarded-for": "203.0.113.8",
        },
      }) as never,
    );

    expect(response.status).toBe(307);
    expect(response.headers.get("location")).toBe("http://localhost/workspaces/workspace-1");
    expect(response.headers.get("set-cookie")).toContain("corgtex_session=demo-token");
  });

  it("prefers forwarded headers for the demo redirect origin", async () => {
    loginUserWithPassword.mockResolvedValue({
      token: "demo-token",
      expiresAt: new Date("2026-04-13T00:00:00.000Z"),
      user: {
        id: "user-1",
        email: "demo@jnj-demo.corgtex.app",
      },
    });
    listActorWorkspaces.mockResolvedValue([{ id: "workspace-1", slug: "jnj-demo" }]);
    isDatabaseUnavailableError.mockReturnValue(false);

    const { GET } = await import("./route");
    const response = await GET(
      new Request("http://localhost:8080/demo", {
        headers: {
          host: "localhost:8080",
          "x-forwarded-for": "203.0.113.8",
          "x-forwarded-host": "demo.corgtex.app, internal:8080",
          "x-forwarded-proto": "https, http",
        },
      }) as never,
    );

    expect(response.status).toBe(307);
    expect(response.headers.get("location")).toBe("https://demo.corgtex.app/workspaces/workspace-1");
  });

  it("falls back to the host header when the request URL uses an internal origin", async () => {
    loginUserWithPassword.mockResolvedValue({
      token: "demo-token",
      expiresAt: new Date("2026-04-13T00:00:00.000Z"),
      user: {
        id: "user-1",
        email: "demo@jnj-demo.corgtex.app",
      },
    });
    listActorWorkspaces.mockResolvedValue([{ id: "workspace-1", slug: "jnj-demo" }]);
    isDatabaseUnavailableError.mockReturnValue(false);

    const { GET } = await import("./route");
    const response = await GET(
      new Request("http://localhost:8080/demo", {
        headers: {
          host: "localhost:3000",
          "x-forwarded-for": "203.0.113.8",
        },
      }) as never,
    );

    expect(response.status).toBe(307);
    expect(response.headers.get("location")).toBe("http://localhost:3000/workspaces/workspace-1");
  });

  it("returns a service unavailable response when the database is down", async () => {
    loginUserWithPassword.mockRejectedValue(new Error("db down"));
    isDatabaseUnavailableError.mockReturnValue(true);

    const { GET } = await import("./route");
    const response = await GET(
      new Request("http://localhost/demo", {
        headers: {
          "x-forwarded-for": "203.0.113.8",
        },
      }) as never,
    );

    expect(response.status).toBe(503);
    await expect(response.json()).resolves.toEqual({
      error: {
        code: "SERVICE_UNAVAILABLE",
        message: "Service is temporarily unavailable. Try again.",
      },
    });
  });
});
