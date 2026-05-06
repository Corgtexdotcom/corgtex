import { beforeEach, describe, expect, it, vi } from "vitest";

const { prismaMock } = vi.hoisted(() => ({
  prismaMock: {
    customerAccount: {
      upsert: vi.fn(),
      findUnique: vi.fn(),
      findFirst: vi.fn(),
      update: vi.fn(),
    },
    instanceRegistry: {
      upsert: vi.fn(),
    },
    workspace: {
      findFirst: vi.fn(),
    },
  },
}));

vi.mock("@corgtex/shared", () => ({
  env: {
    APP_URL: "https://app.test",
  },
  prisma: prismaMock,
}));

describe("customer lifecycle", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    prismaMock.customerAccount.upsert.mockResolvedValue({
      id: "cust-1",
      slug: "acme",
      displayName: "Acme",
      primaryDeploymentId: null,
    });
    prismaMock.customerAccount.findUnique.mockResolvedValue({
      id: "cust-1",
      primaryDeploymentId: null,
    });
    prismaMock.customerAccount.findFirst.mockResolvedValue({
      id: "cust-1",
      slug: "acme",
      displayName: "Acme",
      status: "ACTIVE",
      primaryDeployment: null,
      deployments: [{ id: "inst-1", deploymentStatus: "ACTIVE" }],
    });
    prismaMock.customerAccount.update.mockResolvedValue({
      id: "cust-1",
      primaryDeploymentId: "inst-1",
    });
    prismaMock.instanceRegistry.upsert.mockResolvedValue({
      id: "inst-1",
      customerSlug: "acme",
      deploymentStatus: "ACTIVE",
    });
    prismaMock.workspace.findFirst.mockResolvedValue({
      id: "ws-1",
      slug: "acme",
      name: "Acme",
      description: "Acme workspace",
    });
  });

  it("ensures customer accounts idempotently by normalized slug", async () => {
    const { ensureCustomerAccount } = await import("./customer-lifecycle");

    await ensureCustomerAccount({
      slug: " Acme ",
      displayName: "Acme Inc",
      status: "ACTIVE",
      supportOwnerEmail: "ops@corgtex.com",
    });

    expect(prismaMock.customerAccount.upsert).toHaveBeenCalledWith({
      where: { slug: "acme" },
      update: expect.objectContaining({
        displayName: "Acme Inc",
        status: "ACTIVE",
        supportOwnerEmail: "ops@corgtex.com",
      }),
      create: expect.objectContaining({
        slug: "acme",
        displayName: "Acme Inc",
        status: "ACTIVE",
        managementAuthority: "CORGTEX",
      }),
    });
  });

  it("registers deployments under the canonical customer account", async () => {
    const { registerCustomerDeployment } = await import("./customer-lifecycle");

    const result = await registerCustomerDeployment({
      accountSlug: "acme",
      accountDisplayName: "Acme",
      accountStatus: "ONBOARDING",
      label: "Acme Production",
      url: "https://acme.test/",
      deploymentKind: "HOSTED_DEDICATED",
      deploymentStatus: "PROVISIONING",
      customerSlug: "acme",
      region: "eu-west4",
      dataResidency: "eu",
      primary: true,
    });

    expect(result.deployment.id).toBe("inst-1");
    expect(prismaMock.instanceRegistry.upsert).toHaveBeenCalledWith({
      where: { customerSlug: "acme" },
      update: expect.objectContaining({
        customerAccountId: "cust-1",
        deploymentKind: "HOSTED_DEDICATED",
        deploymentStatus: "PROVISIONING",
        provisioningStatus: "provisioning",
        url: "https://acme.test",
      }),
      create: expect.objectContaining({
        customerAccountId: "cust-1",
        deploymentKind: "HOSTED_DEDICATED",
        deploymentStatus: "PROVISIONING",
      }),
    });
    expect(prismaMock.customerAccount.update).toHaveBeenCalledWith({
      where: { id: "cust-1" },
      data: { primaryDeploymentId: "inst-1" },
    });
  });

  it("links selected managed workspaces as shared workspace deployments", async () => {
    const { linkManagedWorkspaceDeployment } = await import("./customer-lifecycle");

    await linkManagedWorkspaceDeployment({ workspaceSlug: "acme" });

    expect(prismaMock.workspace.findFirst).toHaveBeenCalledWith({
      where: { slug: "acme" },
      select: { id: true, slug: true, name: true, description: true },
    });
    expect(prismaMock.instanceRegistry.upsert).toHaveBeenCalledWith(expect.objectContaining({
      create: expect.objectContaining({
        url: "https://app.test/workspaces/ws-1",
        deploymentKind: "SHARED_WORKSPACE",
        deploymentStatus: "ACTIVE",
        managedWorkspaceId: "ws-1",
      }),
    }));
  });

  it("resolves the primary deployment for a customer account", async () => {
    const { resolvePrimaryCustomerDeployment } = await import("./customer-lifecycle");

    const result = await resolvePrimaryCustomerDeployment({ customerSlug: "acme" });

    expect(result.deployment).toMatchObject({ id: "inst-1" });
    expect(prismaMock.customerAccount.findFirst).toHaveBeenCalledWith(expect.objectContaining({
      where: { slug: "acme" },
    }));
  });
});
