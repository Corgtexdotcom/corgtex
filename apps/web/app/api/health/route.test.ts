import { afterEach, describe, expect, it, vi } from "vitest";

const queryRaw = vi.fn();

vi.mock("@corgtex/shared", () => ({
  prisma: {
    $queryRaw: queryRaw,
  },
}));

afterEach(() => {
  vi.clearAllMocks();
});

describe("GET /api/health", () => {
  it("returns the Corgtex fingerprint when the database is reachable", async () => {
    const { GET } = await import("./route");
    queryRaw
      .mockResolvedValueOnce([{ ok: 1 }])
      .mockResolvedValueOnce([{ ready: true }])
      .mockResolvedValueOnce([{ ready: true }])
      .mockResolvedValueOnce([{ count: 0 }]);

    const response = await GET();

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({
      status: "ok",
      service: "web",
      database: "up",
      schema: "ready",
      app: "corgtex",
      auth: "password-session",
      loginPath: "/login",
      apiLoginPath: "/api/auth/login",
    });
  });

  it("returns degraded when the database is reachable but the schema is stale", async () => {
    const { GET } = await import("./route");
    queryRaw
      .mockResolvedValueOnce([{ ok: 1 }])
      .mockResolvedValueOnce([{ ready: false }])
      .mockResolvedValueOnce([{ ready: true }])
      .mockResolvedValueOnce([{ count: 0 }]);

    const response = await GET();

    expect(response.status).toBe(503);
    await expect(response.json()).resolves.toEqual({
      status: "degraded",
      service: "web",
      database: "up",
      schema: "stale",
      app: "corgtex",
      auth: "password-session",
      missing: {
        brainTables: true,
        knowledgeSourceType: false,
        migrations: false,
      },
    });
  });

  it("returns a degraded fingerprint when the database is down", async () => {
    const { GET } = await import("./route");
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => undefined);
    queryRaw.mockRejectedValue(new Error("db down"));

    const response = await GET();

    expect(response.status).toBe(503);
    await expect(response.json()).resolves.toEqual({
      status: "degraded",
      service: "web",
      database: "down",
      schema: "unknown",
      app: "corgtex",
      auth: "password-session",
    });
    expect(consoleError).toHaveBeenCalledWith("Healthcheck failed.", expect.any(Error));
  });
});
