import { beforeEach, describe, expect, it, vi } from "vitest";

const {
  isDatabaseUnavailableError,
  listCustomerDeployments,
  provisionCustomerDeployment,
  resolveRequestActor,
} = vi.hoisted(() => ({
  isDatabaseUnavailableError: vi.fn(),
  listCustomerDeployments: vi.fn(),
  provisionCustomerDeployment: vi.fn(),
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
  listCustomerDeployments,
  provisionCustomerDeployment,
}));

vi.mock("@corgtex/shared", () => ({
  isDatabaseUnavailableError,
}));

describe("customer deployment admin API", () => {
  beforeEach(() => {
    vi.resetModules();
    vi.clearAllMocks();
    resolveRequestActor.mockResolvedValue({ kind: "user", user: { id: "operator_1" } });
    isDatabaseUnavailableError.mockReturnValue(false);
  });

  it("lists customer deployments through the global-operator domain path", async () => {
    listCustomerDeployments.mockResolvedValue([
      { id: "inst_1", customerSlug: "acme-prod", provisioningStatus: "active" },
    ]);

    const { GET } = await import("./route");
    const response = await GET(new Request("http://localhost/api/admin/customer-deployments") as never);

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({
      deployments: [
        { id: "inst_1", customerSlug: "acme-prod", provisioningStatus: "active" },
      ],
    });
    expect(resolveRequestActor).toHaveBeenCalled();
    expect(listCustomerDeployments).toHaveBeenCalledWith({ kind: "user", user: { id: "operator_1" } });
  });

  it("provisions a customer deployment without accepting raw seed content", async () => {
    provisionCustomerDeployment.mockResolvedValue({
      id: "inst_1",
      customerSlug: "acme-prod",
      provisioningStatus: "bootstrapping",
    });

    const { POST } = await import("./route");
    const response = await POST(new Request("http://localhost/api/admin/customer-deployments", {
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
        storageBucketName: "customer-bucket",
        bootstrapBundleUri: "https://private.example/bundle.json",
        bootstrapBundleChecksum: "a".repeat(64),
        bootstrapBundleSchemaVersion: "stable-client-v1",
      }),
    }) as never);

    expect(response.status).toBe(201);
    await expect(response.json()).resolves.toEqual({
      deployment: {
        id: "inst_1",
        customerSlug: "acme-prod",
        provisioningStatus: "bootstrapping",
      },
    });
    expect(provisionCustomerDeployment).toHaveBeenCalledWith(
      { kind: "user", user: { id: "operator_1" } },
      expect.objectContaining({
        storageBucketName: "customer-bucket",
      }),
    );
    expect(provisionCustomerDeployment).toHaveBeenCalledWith(
      expect.anything(),
      expect.not.objectContaining({
        seedContent: expect.anything(),
        bundleContent: expect.anything(),
      }),
    );
  });
});
