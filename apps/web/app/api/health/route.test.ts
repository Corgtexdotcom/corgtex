import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const queryRaw = vi.fn();

vi.mock("@corgtex/shared", () => ({
  prisma: {
    $queryRaw: queryRaw,
  },
}));

beforeEach(() => {
  delete process.env.CORGTEX_RELEASE_VERSION;
  delete process.env.CORGTEX_RELEASE_IMAGE_TAG;
  delete process.env.GITHUB_SHA;
  delete process.env.RAILWAY_GIT_COMMIT_SHA;
  delete process.env.npm_package_version;
  delete process.env.REDIS_URL;
  delete process.env.S3_BUCKET_NAME;
  delete process.env.AWS_S3_BUCKET_NAME;
  delete process.env.R2_BUCKET_NAME;
});

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
      release: {
        version: "development",
        imageTag: null,
        gitSha: null,
      },
      runtime: {
        redis: "missing",
        storage: "missing",
      },
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
      release: {
        version: "development",
        imageTag: null,
        gitSha: null,
      },
      runtime: {
        redis: "missing",
        storage: "missing",
      },
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
      release: {
        version: "development",
        imageTag: null,
        gitSha: null,
      },
      runtime: {
        redis: "missing",
        storage: "missing",
      },
    });
    expect(consoleError).toHaveBeenCalledWith("Healthcheck failed.", expect.any(Error));
  });

  it("reports release and runtime configuration for fleet probes", async () => {
    const { GET } = await import("./route");
    process.env.CORGTEX_RELEASE_VERSION = "0.1.0";
    process.env.CORGTEX_RELEASE_IMAGE_TAG = "sha-abc";
    process.env.RAILWAY_GIT_COMMIT_SHA = "abc";
    process.env.REDIS_URL = "redis://redis:6379";
    process.env.S3_BUCKET_NAME = "customer-bucket";
    queryRaw
      .mockResolvedValueOnce([{ ok: 1 }])
      .mockResolvedValueOnce([{ ready: true }])
      .mockResolvedValueOnce([{ ready: true }])
      .mockResolvedValueOnce([{ count: 0 }]);

    const response = await GET();

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      release: {
        version: "0.1.0",
        imageTag: "sha-abc",
        gitSha: "abc",
      },
      runtime: {
        redis: "configured",
        storage: "configured",
      },
    });
  });
});
