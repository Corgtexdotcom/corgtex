import { beforeEach, describe, expect, it, vi } from "vitest";

const buildSelfServeRegistrySyncPayload = vi.fn();
const recordSelfServeRegistrySync = vi.fn();
const verifySelfServeRegistrySyncSignature = vi.fn();
const sharedEnv = {
  APP_URL: "https://selfserve.example",
  SELF_SERVE_REGISTRY_SYNC_SECRET: "sync-secret",
};

vi.mock("@corgtex/shared", () => ({
  env: sharedEnv,
}));

vi.mock("@corgtex/domain", () => ({
  AppError: class AppError extends Error {
    status: number;
    code: string;

    constructor(status: number, code: string, message: string) {
      super(message);
      this.status = status;
      this.code = code;
    }
  },
  buildSelfServeRegistrySyncPayload,
  recordSelfServeRegistrySync,
  verifySelfServeRegistrySyncSignature,
}));

vi.mock("@/lib/http", () => ({
  handleRouteError: (error: Error & { status?: number; code?: string }) => Response.json({
    error: {
      code: error.code ?? "INTERNAL_ERROR",
      message: error.message,
    },
  }, { status: error.status ?? 500 }),
}));

function getRequest(token = "sync-secret") {
  return new Request("https://selfserve.example/api/internal/self-serve/registry-sync?sourceId=azure&take=25", {
    headers: {
      authorization: `Bearer ${token}`,
    },
  }) as any;
}

function postRequest(body: unknown) {
  return new Request("https://ops.example/api/internal/self-serve/registry-sync", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-corgtex-registry-sync-timestamp": "2026-06-09T12:00:00.000Z",
      "x-corgtex-registry-sync-signature": "sha256=signature",
    },
    body: JSON.stringify(body),
  }) as any;
}

describe("/api/internal/self-serve/registry-sync", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    sharedEnv.SELF_SERVE_REGISTRY_SYNC_SECRET = "sync-secret";
    buildSelfServeRegistrySyncPayload.mockResolvedValue({
      schemaVersion: "self-serve-registry-sync-v1",
      sourceId: "azure",
      sourceUrl: "https://selfserve.example",
      generatedAt: "2026-06-09T12:00:00.000Z",
      summary: { total: 0 },
      items: [],
    });
    recordSelfServeRegistrySync.mockResolvedValue({
      eventId: "event-1",
      itemCount: 0,
    });
  });

  it("exports a sanitized registry payload only with the internal bearer token", async () => {
    const { GET } = await import("./route");

    const rejected = await GET(getRequest("bad-token"));
    expect(rejected.status).toBe(401);
    expect(buildSelfServeRegistrySyncPayload).not.toHaveBeenCalled();

    const accepted = await GET(getRequest());
    await expect(accepted.json()).resolves.toMatchObject({
      schemaVersion: "self-serve-registry-sync-v1",
      sourceId: "azure",
    });
    expect(buildSelfServeRegistrySyncPayload).toHaveBeenCalledWith(expect.objectContaining({
      kind: "agent",
      label: "self-serve-registry-sync",
    }), expect.objectContaining({
      sourceId: "azure",
      take: 25,
      sourceUrl: "https://selfserve.example",
    }));
  });

  it("verifies signed imports before recording the sync event", async () => {
    const { POST } = await import("./route");
    const body = {
      schemaVersion: "self-serve-registry-sync-v1",
      sourceId: "azure",
      sourceUrl: "https://selfserve.example",
      generatedAt: "2026-06-09T12:00:00.000Z",
      summary: { total: 1 },
      items: [{ trialId: "trial-1" }],
    };

    const response = await POST(postRequest(body));

    expect(response.status).toBe(202);
    expect(verifySelfServeRegistrySyncSignature).toHaveBeenCalledWith(expect.objectContaining({
      secret: "sync-secret",
      timestamp: "2026-06-09T12:00:00.000Z",
      signature: "sha256=signature",
      body: JSON.stringify(body),
    }));
    expect(recordSelfServeRegistrySync).toHaveBeenCalledWith(body);
  });

  it("does not record imports when signature verification fails", async () => {
    const { AppError } = await import("@corgtex/domain");
    verifySelfServeRegistrySyncSignature.mockImplementationOnce(() => {
      throw new AppError(401, "REGISTRY_SYNC_SIGNATURE_INVALID", "Registry sync signature is invalid.");
    });
    const { POST } = await import("./route");

    const response = await POST(postRequest({
      schemaVersion: "self-serve-registry-sync-v1",
      sourceId: "azure",
      sourceUrl: "https://selfserve.example",
      generatedAt: "2026-06-09T12:00:00.000Z",
      summary: { total: 0 },
      items: [],
    }));

    expect(response.status).toBe(401);
    expect(recordSelfServeRegistrySync).not.toHaveBeenCalled();
  });
});
