import { beforeEach, describe, expect, it, vi } from "vitest";

const { prismaMock } = vi.hoisted(() => ({
  prismaMock: {
    customerAccount: {
      upsert: vi.fn(),
      findUnique: vi.fn(),
      findFirst: vi.fn(),
      update: vi.fn(),
    },
    customerDeployment: {
      findUnique: vi.fn(),
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
    prismaMock.customerDeployment.findUnique.mockResolvedValue(null);
    prismaMock.customerDeployment.upsert.mockResolvedValue({
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
    expect(prismaMock.customerDeployment.upsert).toHaveBeenCalledWith({
      where: { url: "https://acme.test" },
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

  it("rejects deployment URL reuse across customer accounts", async () => {
    const { registerCustomerDeployment } = await import("./customer-lifecycle");
    prismaMock.customerDeployment.findUnique.mockResolvedValueOnce({
      id: "inst-other",
      customerAccountId: "cust-other",
      customerSlug: "other",
    });

    await expect(registerCustomerDeployment({
      accountSlug: "acme",
      accountDisplayName: "Acme",
      accountStatus: "ONBOARDING",
      label: "Acme Production",
      url: "https://acme.test/",
      deploymentKind: "HOSTED_DEDICATED",
      deploymentStatus: "PROVISIONING",
      customerSlug: "acme",
    })).rejects.toMatchObject({
      status: 409,
      code: "CUSTOMER_DEPLOYMENT_URL_CONFLICT",
    });
    expect(prismaMock.customerDeployment.upsert).not.toHaveBeenCalled();
  });

  it("rejects deployment URL reuse from unowned legacy rows", async () => {
    const { registerCustomerDeployment } = await import("./customer-lifecycle");
    prismaMock.customerDeployment.findUnique.mockResolvedValueOnce({
      id: "inst-legacy",
      customerAccountId: null,
      customerSlug: null,
    });

    await expect(registerCustomerDeployment({
      accountSlug: "acme",
      accountDisplayName: "Acme",
      accountStatus: "ONBOARDING",
      label: "Acme Production",
      url: "https://acme.test/",
      deploymentKind: "HOSTED_DEDICATED",
      deploymentStatus: "PROVISIONING",
      customerSlug: "acme",
    })).rejects.toMatchObject({
      status: 409,
      code: "CUSTOMER_DEPLOYMENT_URL_CONFLICT",
    });
    expect(prismaMock.customerDeployment.upsert).not.toHaveBeenCalled();
  });

  it("does not replace an existing primary deployment unless explicitly forced", async () => {
    const { registerCustomerDeployment } = await import("./customer-lifecycle");
    prismaMock.customerAccount.findUnique.mockResolvedValueOnce({
      id: "cust-1",
      primaryDeploymentId: "inst-existing",
    });

    await registerCustomerDeployment({
      accountSlug: "acme",
      accountDisplayName: "Acme",
      accountStatus: "ONBOARDING",
      label: "Acme Hosted",
      url: "https://acme-hosted.test/",
      deploymentKind: "HOSTED_DEDICATED",
      deploymentStatus: "PROVISIONING",
      customerSlug: "acme",
      primary: false,
    });

    expect(prismaMock.customerAccount.update).not.toHaveBeenCalled();
  });

  it("does not set a missing primary when primary is explicitly false", async () => {
    const { registerCustomerDeployment } = await import("./customer-lifecycle");
    prismaMock.customerAccount.findUnique.mockResolvedValueOnce({
      id: "cust-1",
      primaryDeploymentId: null,
    });

    await registerCustomerDeployment({
      accountSlug: "acme",
      accountDisplayName: "Acme",
      accountStatus: "ONBOARDING",
      label: "Acme Hosted",
      url: "https://acme-hosted.test/",
      deploymentKind: "HOSTED_DEDICATED",
      deploymentStatus: "PROVISIONING",
      customerSlug: "acme",
      primary: false,
    });

    expect(prismaMock.customerAccount.update).not.toHaveBeenCalled();
  });

  it("links selected managed workspaces as shared workspace deployments", async () => {
    const { linkManagedWorkspaceDeployment } = await import("./customer-lifecycle");

    await linkManagedWorkspaceDeployment({ workspaceSlug: "acme" });

    expect(prismaMock.workspace.findFirst).toHaveBeenCalledWith({
      where: { slug: "acme" },
      select: { id: true, slug: true, name: true, description: true },
    });
    expect(prismaMock.customerDeployment.upsert).toHaveBeenCalledWith(expect.objectContaining({
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
