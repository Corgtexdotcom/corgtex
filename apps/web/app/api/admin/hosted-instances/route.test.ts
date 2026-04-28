import { beforeEach, describe, expect, it, vi } from "vitest";

const {
  isDatabaseUnavailableError,
  listExternalInstances,
  provisionHostedCustomerInstance,
  resolveRequestActor,
} = vi.hoisted(() => ({
  isDatabaseUnavailableError: vi.fn(),
  listExternalInstances: vi.fn(),
  provisionHostedCustomerInstance: vi.fn(),
  resolveRequestActor: vi.fn(),
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

vi.mock("@/lib/auth", () => ({
  resolveRequestActor,
}));

vi.mock("@corgtex/domain", () => ({
  AppError: MockAppError,
  listExternalInstances,
  provisionHostedCustomerInstance,
}));

vi.mock("@corgtex/shared", () => ({
  isDatabaseUnavailableError,
}));

describe("hosted instance admin API", () => {
  beforeEach(() => {
    vi.resetModules();
    vi.clearAllMocks();
    resolveRequestActor.mockResolvedValue({ kind: "user", user: { id: "operator_1" } });
    isDatabaseUnavailableError.mockReturnValue(false);
  });

  it("lists hosted instances through the global-operator domain path", async () => {
    listExternalInstances.mockResolvedValue([
      { id: "inst_1", customerSlug: "acme-prod", provisioningStatus: "active" },
    ]);

    const { GET } = await import("./route");
    const response = await GET(new Request("http://localhost/api/admin/hosted-instances") as never);

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({
      instances: [
        { id: "inst_1", customerSlug: "acme-prod", provisioningStatus: "active" },
      ],
    });
    expect(resolveRequestActor).toHaveBeenCalled();
    expect(listExternalInstances).toHaveBeenCalledWith({ kind: "user", user: { id: "operator_1" } });
  });

  it("provisions a hosted instance without accepting raw seed content", async () => {
    provisionHostedCustomerInstance.mockResolvedValue({
      id: "inst_1",
      customerSlug: "acme-prod",
      provisioningStatus: "bootstrapping",
    });

    const { POST } = await import("./route");
    const response = await POST(new Request("http://localhost/api/admin/hosted-instances", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        label: "Acme Production",
        customerSlug: "acme-prod",
        region: "eu-west4",
        dataResidency: "eu",
        releaseImageTag: "sha-1",
        webImage: "ghcr.io/corgtex/web:sha-1",
        workerImage: "ghcr.io/corgtex/worker:sha-1",
        bootstrapBundleUri: "https://private.example/bundle.json",
        bootstrapBundleChecksum: "a".repeat(64),
        bootstrapBundleSchemaVersion: "stable-client-v1",
      }),
    }) as never);

    expect(response.status).toBe(201);
    await expect(response.json()).resolves.toEqual({
      instance: {
        id: "inst_1",
        customerSlug: "acme-prod",
        provisioningStatus: "bootstrapping",
      },
    });
    expect(provisionHostedCustomerInstance).toHaveBeenCalledWith(
      { kind: "user", user: { id: "operator_1" } },
      expect.not.objectContaining({
        seedContent: expect.anything(),
        bundleContent: expect.anything(),
      }),
    );
  });
});
