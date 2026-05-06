import { createHash, createHmac } from "node:crypto";

import { beforeEach, describe, expect, it, vi } from "vitest";

const findFirst = vi.fn();
const findUnique = vi.fn();
const create = vi.fn();
const update = vi.fn();
const updateMany = vi.fn();
const runStableClientSeed = vi.fn();

vi.mock("@corgtex/shared", () => ({
  prisma: {
    customerDeploymentBootstrapRun: {
      findFirst,
      findUnique,
      create,
      update,
      updateMany,
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

function signedBody(body: {
  customerSlug: string;
  bundleUri: string;
  checksum: string;
  schemaVersion: string;
  expiresAt: string;
}, token = "bootstrap-token") {
  const tokenHash = checksum(token);
  const payload = JSON.stringify({
    customerSlug: body.customerSlug,
    bundleUri: body.bundleUri,
    checksum: body.checksum.toLowerCase(),
    schemaVersion: body.schemaVersion,
    expiresAt: body.expiresAt,
    tokenHash,
  });
  return {
    ...body,
    tokenHash,
    signature: createHmac("sha256", token).update(payload).digest("hex"),
  };
}

function request(body: unknown, token = "bootstrap-token") {
  return new Request("http://corgtex.test/api/internal/customer-deployment-bootstrap", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(body),
  }) as any;
}

describe("POST /api/internal/customer-deployment-bootstrap", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    delete process.env.CORGTEX_CUSTOMER_DEPLOYMENT_BOOTSTRAP_TOKEN;
    delete process.env.CORGTEX_CUSTOMER_DEPLOYMENT_BOOTSTRAP_TOKEN_HASH;
    process.env.CORGTEX_CUSTOMER_DEPLOYMENT_BOOTSTRAP_TOKEN_HASH = checksum("bootstrap-token");
    findFirst.mockResolvedValue(null);
    findUnique.mockResolvedValue(null);
    create.mockResolvedValue({ id: "run-1" });
    update.mockResolvedValue({});
    updateMany.mockResolvedValue({ count: 1 });
    runStableClientSeed.mockResolvedValue(undefined);
  });

  it("rejects invalid bootstrap tokens before touching the database", async () => {
    const { POST } = await import("./route");

    const response = await POST(request(signedBody({
      customerSlug: "acme-prod",
      bundleUri: "https://private.example/bundle.json",
      checksum: "a".repeat(64),
      schemaVersion: "stable-client-v1",
      expiresAt: new Date(Date.now() + 60_000).toISOString(),
    }), "bad-token"));

    expect(response.status).toBe(401);
    expect(findFirst).not.toHaveBeenCalled();
  });

  it("rejects repeated bootstrap after an applied run", async () => {
    const { POST } = await import("./route");
    findFirst.mockResolvedValue({ id: "existing-run" });

    const response = await POST(request(signedBody({
      customerSlug: "acme-prod",
      bundleUri: "https://private.example/bundle.json",
      checksum: "a".repeat(64),
      schemaVersion: "stable-client-v1",
      expiresAt: new Date(Date.now() + 60_000).toISOString(),
    })));

    expect(response.status).toBe(409);
    expect(create).not.toHaveBeenCalled();
  });

  it("rejects a consumed one-time bootstrap token before fetching the bundle", async () => {
    const { POST } = await import("./route");
    global.fetch = vi.fn();
    findUnique.mockResolvedValue({
      id: "run-1",
      bootstrapTokenHash: checksum("bootstrap-token"),
      bootstrapTokenConsumedAt: new Date(),
    });

    const response = await POST(request(signedBody({
      customerSlug: "acme-prod",
      bundleUri: "https://private.example/bundle.json",
      checksum: "a".repeat(64),
      schemaVersion: "stable-client-v1",
      expiresAt: new Date(Date.now() + 60_000).toISOString(),
    })));

    expect(response.status).toBe(409);
    expect(global.fetch).not.toHaveBeenCalled();
    expect(updateMany).not.toHaveBeenCalled();
  });

  it("rejects a bundle when the checksum does not match", async () => {
    const { POST } = await import("./route");
    global.fetch = vi.fn().mockResolvedValue(new Response("{}", { status: 200 }));

    const response = await POST(request(signedBody({
      customerSlug: "acme-prod",
      bundleUri: "https://private.example/bundle.json",
      checksum: "b".repeat(64),
      schemaVersion: "stable-client-v1",
      expiresAt: new Date(Date.now() + 60_000).toISOString(),
    })));

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

    const response = await POST(request(signedBody({
      customerSlug: "acme-prod",
      bundleUri: "https://private.example/bundle.json",
      checksum: checksum(bundle),
      schemaVersion: "stable-client-v1",
      expiresAt: new Date(Date.now() + 60_000).toISOString(),
    })));

    expect(response.status).toBe(200);
    expect(updateMany).toHaveBeenCalledWith({
      where: expect.objectContaining({
        id: "run-1",
        bootstrapTokenHash: checksum("bootstrap-token"),
        bootstrapTokenConsumedAt: null,
      }),
      data: expect.objectContaining({
        status: "applying",
        bootstrapTokenConsumedAt: expect.any(Date),
      }),
    });
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
    expect(create).toHaveBeenCalledWith(expect.not.objectContaining({
      create: expect.objectContaining({ rawBundle: expect.anything() }),
    }));
    expect(create).toHaveBeenCalledWith({
      data: expect.not.objectContaining({
        bootstrapToken: expect.anything(),
        rawBundle: expect.anything(),
      }),
    });
  });
});
