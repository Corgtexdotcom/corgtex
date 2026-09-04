import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const queryRaw = vi.fn();
const fsMock = vi.hoisted(() => ({
  existsSync: vi.fn((_filePath?: unknown) => false),
  readFileSync: vi.fn(() => ""),
  readdirSync: vi.fn((): Array<{ name: string; isDirectory: () => boolean }> => []),
}));

vi.mock("@corgtex/shared", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@corgtex/shared")>();
  return {
    ...actual,
    prisma: {
      $queryRaw: queryRaw,
    },
  };
});

vi.mock("node:fs", () => ({
  existsSync: fsMock.existsSync,
  readFileSync: fsMock.readFileSync,
  readdirSync: fsMock.readdirSync,
}));

  beforeEach(() => {
  vi.resetModules();
  delete process.env.CORGTEX_RELEASE_VERSION;
  delete process.env.CORGTEX_RELEASE_IMAGE_TAG;
  delete process.env.CORGTEX_RELEASE_GIT_SHA;
  delete process.env.GITHUB_SHA;
  delete process.env.RAILWAY_GIT_COMMIT_SHA;
  delete process.env.VERCEL_GIT_COMMIT_SHA;
  delete process.env.npm_package_version;
  delete process.env.REDIS_URL;
  delete process.env.R2_ACCOUNT_ID;
  delete process.env.S3_BUCKET_NAME;
  delete process.env.AWS_S3_BUCKET_NAME;
  delete process.env.R2_BUCKET_NAME;
  delete process.env.R2_ACCESS_KEY_ID;
  delete process.env.R2_SECRET_ACCESS_KEY;
  delete process.env.S3_ACCESS_KEY_ID;
  delete process.env.S3_SECRET_ACCESS_KEY;
  delete process.env.S3_ENDPOINT;
  delete process.env.S3_REGION;
  delete process.env.RAILWAY_BUCKET_NAME;
  delete process.env.RAILWAY_BUCKET_ACCESS_KEY_ID;
  delete process.env.RAILWAY_BUCKET_SECRET_ACCESS_KEY;
  delete process.env.RAILWAY_BUCKET_ENDPOINT;
  delete process.env.RAILWAY_BUCKET_REGION;
  delete process.env.STORAGE_PROVIDER;
  delete process.env.AZURE_STORAGE_AUTH_MODE;
  delete process.env.AZURE_STORAGE_ACCOUNT_NAME;
  delete process.env.AZURE_STORAGE_CONTAINER_NAME;
  delete process.env.AZURE_STORAGE_BLOB_ENDPOINT;
  delete process.env.AZURE_STORAGE_CLIENT_ID;
  delete process.env.AZURE_CLIENT_ID;
  delete process.env.AZURE_STORAGE_CONNECTION_STRING;
  delete process.env.WORKSPACE_SLUG;
  delete process.env.CONTROL_PLANE_MODE;
  delete process.env.APP_URL;
  vi.stubEnv("NODE_ENV", "test");
  fsMock.existsSync.mockReturnValue(false);
  fsMock.readFileSync.mockReturnValue("");
  fsMock.readdirSync.mockReturnValue([]);
});

afterEach(() => {
  vi.clearAllMocks();
  vi.unstubAllEnvs();
});

describe("GET /api/health", () => {
  it("returns the Corgtex fingerprint when the database is reachable", async () => {
    process.env.WORKSPACE_SLUG = "corporate-rebels";
    process.env.APP_URL = "https://corporate-rebels.corgtex.com";
    const { GET } = await import("./route");
    queryRaw
      .mockResolvedValueOnce([{ ok: 1 }])
      .mockResolvedValueOnce([{ ready: true }])
      .mockResolvedValueOnce([{ ready: true }])
      .mockResolvedValueOnce([{ count: 0 }]);

    const response = await GET();

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
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
        source: {
          version: "development",
          imageTag: "missing",
          gitSha: "missing",
        },
        configured: {
          version: null,
          imageTag: null,
          gitSha: null,
        },
      },
      runtime: {
        redis: "missing",
        storage: "missing",
        workspaceScopeSlug: "corporate-rebels",
        workspaceScopeValid: true,
      },
      loginPath: "/login",
      apiLoginPath: "/api/auth/login",
    });
  });

  it("returns structured degraded health for invalid dedicated scope configuration", async () => {
    const { GET } = await import("./route");
    process.env.WORKSPACE_SLUG = "corporate-rebels";
    process.env.APP_URL = "not-an-absolute-url";
    queryRaw
      .mockResolvedValueOnce([{ ok: 1 }])
      .mockResolvedValueOnce([{ ready: true }])
      .mockResolvedValueOnce([{ ready: true }])
      .mockResolvedValueOnce([{ count: 0 }]);

    const response = await GET();

    expect(response.status).toBe(503);
    await expect(response.json()).resolves.toMatchObject({
      status: "degraded",
      runtime: { workspaceScopeSlug: null, workspaceScopeValid: false },
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
    await expect(response.json()).resolves.toMatchObject({
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
        source: {
          version: "development",
          imageTag: "missing",
          gitSha: "missing",
        },
        configured: {
          version: null,
          imageTag: null,
          gitSha: null,
        },
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

  it("returns degraded when bundled migrations are not applied", async () => {
    const { GET } = await import("./route");
    fsMock.existsSync.mockReturnValue(true);
    fsMock.readdirSync.mockReturnValue([
      { name: "20260624000000_pending_migration", isDirectory: () => true },
    ]);
    queryRaw
      .mockResolvedValueOnce([{ ok: 1 }])
      .mockResolvedValueOnce([{ ready: true }])
      .mockResolvedValueOnce([{ ready: true }])
      .mockResolvedValueOnce([]);

    const response = await GET();

    expect(response.status).toBe(503);
    await expect(response.json()).resolves.toMatchObject({
      status: "degraded",
      database: "up",
      schema: "stale",
      missing: {
        brainTables: false,
        knowledgeSourceType: false,
        migrations: true,
      },
    });
  });

  it("returns a degraded fingerprint when the database is down", async () => {
    const { GET } = await import("./route");
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => undefined);
    queryRaw.mockRejectedValue(new Error("db down"));

    const response = await GET();

    expect(response.status).toBe(503);
    await expect(response.json()).resolves.toMatchObject({
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
        source: {
          version: "development",
          imageTag: "missing",
          gitSha: "missing",
        },
        configured: {
          version: null,
          imageTag: null,
          gitSha: null,
        },
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
    const gitSha = "a".repeat(40);
    process.env.CORGTEX_RELEASE_VERSION = "0.1.0";
    process.env.CORGTEX_RELEASE_IMAGE_TAG = `sha-${gitSha}`;
    process.env.CORGTEX_RELEASE_GIT_SHA = gitSha;
    process.env.REDIS_URL = "redis://redis:6379";
    process.env.S3_BUCKET_NAME = "customer-bucket";
    process.env.S3_ACCESS_KEY_ID = "access";
    process.env.S3_SECRET_ACCESS_KEY = "secret";
    process.env.S3_ENDPOINT = "https://storage.example";
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
        imageTag: `sha-${gitSha}`,
        gitSha,
        source: {
          version: "configured",
          imageTag: "configured",
          gitSha: "configured",
        },
        configured: {
          version: "0.1.0",
          imageTag: `sha-${gitSha}`,
          gitSha,
        },
      },
      runtime: {
        redis: "configured",
        storage: "configured",
      },
    });
  });

  it("reports a validated immutable image SHA stamp when present", async () => {
    const { GET } = await import("./route");
    const gitSha = "a".repeat(40);
    fsMock.existsSync.mockImplementation((filePath?: unknown) => String(filePath).endsWith(".corgtex-release-git-sha"));
    fsMock.readFileSync.mockReturnValue(`${gitSha}\n`);
    process.env.CORGTEX_RELEASE_VERSION = `main-${gitSha.slice(0, 12)}`;
    process.env.CORGTEX_RELEASE_IMAGE_TAG = `sha-${gitSha}`;
    process.env.CORGTEX_RELEASE_GIT_SHA = gitSha;
    process.env.RAILWAY_GIT_COMMIT_SHA = gitSha;
    queryRaw
      .mockResolvedValueOnce([{ ok: 1 }])
      .mockResolvedValueOnce([{ ready: true }])
      .mockResolvedValueOnce([{ ready: true }])
      .mockResolvedValueOnce([]);

    const response = await GET();

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      release: {
        gitSha,
        runtime: { gitSha, source: "railway" },
        image: { gitSha, source: "image_stamp", valid: true },
        drift: { imageGitSha: false },
      },
    });
  });

  it("fails closed when the image SHA stamp is present but configured release SHA is missing", async () => {
    const { GET } = await import("./route");
    const gitSha = "a".repeat(40);
    fsMock.existsSync.mockImplementation((filePath?: unknown) => String(filePath).endsWith(".corgtex-release-git-sha"));
    fsMock.readFileSync.mockReturnValue(`${gitSha}\n`);
    process.env.RAILWAY_GIT_COMMIT_SHA = gitSha;
    queryRaw
      .mockResolvedValueOnce([{ ok: 1 }])
      .mockResolvedValueOnce([{ ready: true }])
      .mockResolvedValueOnce([{ ready: true }])
      .mockResolvedValueOnce([]);

    const response = await GET();

    expect(response.status).toBe(503);
    await expect(response.json()).resolves.toMatchObject({
      status: "degraded",
      release: {
        configured: { gitSha: null },
        image: { gitSha, source: "image_stamp", valid: false },
        drift: {
          imageGitSha: true,
          details: expect.arrayContaining([
            `configured.gitSha=missing does not match image.gitSha=${gitSha}`,
          ]),
        },
      },
    });
  });

  it("looks for the image SHA stamp at the container root when running from the web app cwd", async () => {
    const { GET } = await import("./route");
    queryRaw
      .mockResolvedValueOnce([{ ok: 1 }])
      .mockResolvedValueOnce([{ ready: true }])
      .mockResolvedValueOnce([{ ready: true }])
      .mockResolvedValueOnce([]);

    await GET();

    expect(fsMock.existsSync).toHaveBeenCalledWith(expect.stringMatching(/\/\.corgtex-release-git-sha$/));
    expect(fsMock.existsSync).not.toHaveBeenCalledWith(expect.stringMatching(/apps\/web\/\.corgtex-release-git-sha$/));
  });

  it("fails closed when the production image SHA stamp is missing", async () => {
    const { GET } = await import("./route");
    vi.stubEnv("NODE_ENV", "production");
    process.env.CORGTEX_RELEASE_GIT_SHA = "a".repeat(40);
    fsMock.existsSync.mockReturnValue(false);
    queryRaw
      .mockResolvedValueOnce([{ ok: 1 }])
      .mockResolvedValueOnce([{ ready: true }])
      .mockResolvedValueOnce([{ ready: true }])
      .mockResolvedValueOnce([]);

    const response = await GET();

    expect(response.status).toBe(503);
    await expect(response.json()).resolves.toMatchObject({
      status: "degraded",
      release: {
        image: { gitSha: null, source: "missing", valid: false },
        drift: {
          details: expect.arrayContaining(["image git SHA stamp is missing in production"]),
        },
      },
    });
  });

  it("fails closed when configured release SHA drifts from the image stamp", async () => {
    const { GET } = await import("./route");
    const imageSha = "a".repeat(40);
    const configuredSha = "b".repeat(40);
    fsMock.existsSync.mockImplementation((filePath?: unknown) => String(filePath).endsWith(".corgtex-release-git-sha"));
    fsMock.readFileSync.mockReturnValue(`${imageSha}\n`);
    process.env.CORGTEX_RELEASE_GIT_SHA = configuredSha;
    process.env.RAILWAY_GIT_COMMIT_SHA = imageSha;
    queryRaw
      .mockResolvedValueOnce([{ ok: 1 }])
      .mockResolvedValueOnce([{ ready: true }])
      .mockResolvedValueOnce([{ ready: true }])
      .mockResolvedValueOnce([]);

    const response = await GET();

    expect(response.status).toBe(503);
    await expect(response.json()).resolves.toMatchObject({
      status: "degraded",
      release: {
        image: { gitSha: imageSha, source: "image_stamp", valid: false },
        drift: {
          imageGitSha: true,
          details: expect.arrayContaining([
            `configured.gitSha=${configuredSha} does not match image.gitSha=${imageSha}`,
          ]),
        },
      },
    });
  });

  it("fails closed when the image SHA stamp is invalid", async () => {
    const { GET } = await import("./route");
    fsMock.existsSync.mockImplementation((filePath?: unknown) => String(filePath).endsWith(".corgtex-release-git-sha"));
    fsMock.readFileSync.mockReturnValue("not-a-git-sha\n");
    queryRaw
      .mockResolvedValueOnce([{ ok: 1 }])
      .mockResolvedValueOnce([{ ready: true }])
      .mockResolvedValueOnce([{ ready: true }])
      .mockResolvedValueOnce([]);

    const response = await GET();

    expect(response.status).toBe(503);
    await expect(response.json()).resolves.toMatchObject({
      status: "degraded",
      release: {
        image: { gitSha: null, source: "invalid", valid: false },
        drift: {
          imageGitSha: false,
          details: expect.arrayContaining(["image git SHA stamp is missing or invalid"]),
        },
      },
    });
  });

  it("does not report storage as configured for a bucket-only placeholder", async () => {
    const { GET } = await import("./route");
    process.env.REDIS_URL = "redis://redis:6379";
    process.env.R2_BUCKET_NAME = "corgtex";
    queryRaw
      .mockResolvedValueOnce([{ ok: 1 }])
      .mockResolvedValueOnce([{ ready: true }])
      .mockResolvedValueOnce([{ ready: true }])
      .mockResolvedValueOnce([{ count: 0 }]);

    const response = await GET();

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      runtime: {
        redis: "configured",
        storage: "missing",
      },
    });
  });

  it("reports Azure Blob storage as configured when managed identity settings are present", async () => {
    const { GET } = await import("./route");
    process.env.REDIS_URL = "redis://redis:6379";
    process.env.STORAGE_PROVIDER = "azure_blob";
    process.env.AZURE_STORAGE_AUTH_MODE = "managed_identity";
    process.env.AZURE_STORAGE_ACCOUNT_NAME = "corgtexstorage";
    process.env.AZURE_STORAGE_CONTAINER_NAME = "selfserve-artifacts";
    process.env.AZURE_STORAGE_BLOB_ENDPOINT = "https://corgtexstorage.blob.core.windows.net";
    process.env.AZURE_CLIENT_ID = "managed-identity-client-id";
    queryRaw
      .mockResolvedValueOnce([{ ok: 1 }])
      .mockResolvedValueOnce([{ ready: true }])
      .mockResolvedValueOnce([{ ready: true }])
      .mockResolvedValueOnce([{ count: 0 }]);

    const response = await GET();

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      runtime: {
        redis: "configured",
        storage: "configured",
      },
    });
  });

  it("prefers runtime deployment metadata over stale configured release variables", async () => {
    const { GET } = await import("./route");
    process.env.CORGTEX_RELEASE_VERSION = "main-older";
    process.env.CORGTEX_RELEASE_IMAGE_TAG = "older-sha";
    process.env.CORGTEX_RELEASE_GIT_SHA = "older-sha";
    process.env.RAILWAY_GIT_COMMIT_SHA = "current-sha";
    queryRaw
      .mockResolvedValueOnce([{ ok: 1 }])
      .mockResolvedValueOnce([{ ready: true }])
      .mockResolvedValueOnce([{ ready: true }])
      .mockResolvedValueOnce([{ count: 0 }]);

    const response = await GET();

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      release: {
        version: "main-current-sha",
        imageTag: "sha-current-sha",
        gitSha: "current-sha",
        source: {
          version: "railway",
          imageTag: "railway",
          gitSha: "railway",
        },
        configured: {
          version: "main-older",
          imageTag: "older-sha",
          gitSha: "older-sha",
        },
      },
    });
  });
});
