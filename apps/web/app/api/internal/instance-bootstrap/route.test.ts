import { createHash } from "node:crypto";

import { beforeEach, describe, expect, it, vi } from "vitest";

const findFirst = vi.fn();
const upsert = vi.fn();
const update = vi.fn();
const runStableClientSeed = vi.fn();

vi.mock("@corgtex/shared", () => ({
  prisma: {
    instanceBootstrapRun: {
      findFirst,
      upsert,
      update,
    },
  },
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
}));

vi.mock("./bootstrap-runner", () => ({
  runStableClientSeed,
}));

function checksum(value: string) {
  return createHash("sha256").update(value).digest("hex");
}

function request(body: unknown, token = "bootstrap-token") {
  return new Request("http://corgtex.test/api/internal/instance-bootstrap", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(body),
  }) as any;
}

describe("POST /api/internal/instance-bootstrap", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    process.env.CORGTEX_INSTANCE_BOOTSTRAP_TOKEN = "bootstrap-token";
    findFirst.mockResolvedValue(null);
    upsert.mockResolvedValue({ id: "run-1" });
    update.mockResolvedValue({});
    runStableClientSeed.mockResolvedValue(undefined);
  });

  it("rejects invalid bootstrap tokens before touching the database", async () => {
    const { POST } = await import("./route");

    const response = await POST(request({}, "bad-token"));

    expect(response.status).toBe(401);
    expect(findFirst).not.toHaveBeenCalled();
  });

  it("rejects repeated bootstrap after an applied run", async () => {
    const { POST } = await import("./route");
    findFirst.mockResolvedValue({ id: "existing-run" });

    const response = await POST(request({
      customerSlug: "acme-prod",
      bundleUri: "https://private.example/bundle.json",
      checksum: "a".repeat(64),
      schemaVersion: "stable-client-v1",
      expiresAt: new Date(Date.now() + 60_000).toISOString(),
    }));

    expect(response.status).toBe(409);
    expect(upsert).not.toHaveBeenCalled();
  });

  it("rejects a bundle when the checksum does not match", async () => {
    const { POST } = await import("./route");
    global.fetch = vi.fn().mockResolvedValue(new Response("{}", { status: 200 }));

    const response = await POST(request({
      customerSlug: "acme-prod",
      bundleUri: "https://private.example/bundle.json",
      checksum: "b".repeat(64),
      schemaVersion: "stable-client-v1",
      expiresAt: new Date(Date.now() + 60_000).toISOString(),
    }));

    expect(response.status).toBe(400);
    expect(update).toHaveBeenCalledWith({
      where: { id: "run-1" },
      data: expect.objectContaining({ status: "failed" }),
    });
    expect(runStableClientSeed).not.toHaveBeenCalled();
  });

  it("applies a valid private seed bundle and stores only status metadata", async () => {
    const { POST } = await import("./route");
    const bundle = JSON.stringify({
      config: {
        workspace: {
          slug: "acme-prod",
          name: "Acme",
        },
        featureFlags: {},
        circles: [],
        roles: [],
      },
      env: {
        ADMIN_PASSWORD: "runtime-only-password",
      },
    });
    global.fetch = vi.fn().mockResolvedValue(new Response(bundle, { status: 200 }));

    const response = await POST(request({
      customerSlug: "acme-prod",
      bundleUri: "https://private.example/bundle.json",
      checksum: checksum(bundle),
      schemaVersion: "stable-client-v1",
      expiresAt: new Date(Date.now() + 60_000).toISOString(),
    }));

    expect(response.status).toBe(200);
    expect(runStableClientSeed).toHaveBeenCalledWith(
      expect.objectContaining({ workspace: expect.objectContaining({ slug: "acme-prod" }) }),
      { ADMIN_PASSWORD: "runtime-only-password" },
    );
    expect(update).toHaveBeenLastCalledWith({
      where: { id: "run-1" },
      data: expect.objectContaining({
        status: "applied",
        error: null,
      }),
    });
    expect(upsert).toHaveBeenCalledWith(expect.not.objectContaining({
      create: expect.objectContaining({ rawBundle: expect.anything() }),
    }));
  });
});
