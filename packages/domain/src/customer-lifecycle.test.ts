import { beforeEach, describe, expect, it, vi } from "vitest";

const { prismaMock } = vi.hoisted(() => ({
  prismaMock: {
    $transaction: vi.fn(),
    customerAccount: {
      upsert: vi.fn(),
      findUnique: vi.fn(),
      findFirst: vi.fn(),
      update: vi.fn(),
    },
    customerDeployment: {
      create: vi.fn(),
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
    prismaMock.$transaction.mockImplementation(async (callback) => callback(prismaMock));
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

  it("registers Azure provider metadata without Railway service IDs", async () => {
    const { registerCustomerDeployment } = await import("./customer-lifecycle");

    await registerCustomerDeployment({
      accountSlug: "selfserve",
      accountDisplayName: "Self-Serve",
      accountStatus: "ONBOARDING",
      label: "Self-Serve Azure",
      url: "https://selfserve.corgtex.com/",
      deploymentKind: "SHARED_WORKSPACE",
      deploymentStatus: "PROVISIONING",
      cloudProvider: "AZURE",
      customerSlug: "selfserve",
      region: "westus2",
      dataResidency: "us",
      providerSubscriptionId: "sub-1",
      providerResourceGroup: "rg-corgtex-selfserve-staging",
      providerEnvironmentId: "aca-env-1",
      providerWebServiceId: "aca-web-1",
      providerWorkerServiceId: "aca-worker-1",
      providerPostgresServiceId: "postgres-1",
      providerRedisServiceId: "redis-1",
      providerStorageResourceId: "storage-1",
      providerLogsUrl: "https://portal.azure.com/logs",
      providerCostUrl: "https://portal.azure.com/costs",
    });

    expect(prismaMock.customerDeployment.upsert).toHaveBeenCalledWith(expect.objectContaining({
      where: { url: "https://selfserve.corgtex.com" },
      update: expect.objectContaining({
        cloudProvider: "AZURE",
        providerSubscriptionId: "sub-1",
        providerResourceGroup: "rg-corgtex-selfserve-staging",
        providerEnvironmentId: "aca-env-1",
        providerWebServiceId: "aca-web-1",
        providerWorkerServiceId: "aca-worker-1",
        providerPostgresServiceId: "postgres-1",
        providerRedisServiceId: "redis-1",
        providerStorageResourceId: "storage-1",
        providerLogsUrl: "https://portal.azure.com/logs",
        providerCostUrl: "https://portal.azure.com/costs",
      }),
    }));
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
  describe("remote shared registration", () => {
    const infrastructure = {
      id: "infra-1", customerAccountId: "selfserve-account", deploymentKind: "REMOTE_MANAGED", cloudProvider: "AZURE",
      url: "https://selfserve.test", managedWorkspaceId: null, remoteWorkspaceId: null,
      providerSubscriptionId: "sub-1", providerResourceGroup: "shared-rg", providerEnvironmentId: "shared-env",
      providerWebServiceId: "shared-web", providerWorkerServiceId: "shared-worker", releaseLeaseId: "infra-lease",
    };
    const workspaceId = "00000000-0000-4000-8000-000000000001";
    const input = { customerAccountId: "cust-1", infrastructureDeploymentId: infrastructure.id,
      remoteWorkspaceId: workspaceId, remoteWorkspaceSlug: "acme", workspaceUrl: `https://selfserve.test/workspaces/${workspaceId}`,
      supportMcpUrl: "https://selfserve.test/api/mcp" };
    beforeEach(() => {
      prismaMock.customerAccount.findUnique.mockImplementation(async ({ where }) => ({
        id: where.id, slug: where.id === "cust-1" ? "acme" : "beta", displayName: where.id,
        primaryDeploymentId: `source-${where.id}`,
      }));
      prismaMock.customerDeployment.findUnique.mockImplementation(async ({ where }) => where.id === infrastructure.id ? infrastructure : null);
      prismaMock.customerDeployment.create.mockImplementation(async ({ data }) => ({ id: `destination-${data.customerAccountId}`, ...data }));
    });

    it("registers two account-owned destinations on one infrastructure without primary, lease or local-workspace writes", async () => {
      const { registerRemoteSharedWorkspaceDeployment } = await import("./customer-lifecycle");
      const first = await registerRemoteSharedWorkspaceDeployment(input);
      const secondId = "00000000-0000-4000-8000-000000000002";
      const second = await registerRemoteSharedWorkspaceDeployment({ ...input, customerAccountId: "cust-2",
        remoteWorkspaceId: secondId, remoteWorkspaceSlug: "beta", workspaceUrl: `https://selfserve.test/workspaces/${secondId}` });
      expect(first.deployment).toMatchObject({ customerAccountId: "cust-1", managedWorkspaceId: null, remoteWorkspaceId: workspaceId,
        deploymentKind: "SHARED_WORKSPACE", cloudProvider: "AZURE", deploymentStatus: "DRAFT",
        supportMcpUrl: "https://selfserve.test/api/mcp", providerMetadata: { sharedInfrastructureDeploymentId: "infra-1" } });
      expect(second.deployment).toMatchObject({ customerAccountId: "cust-2", remoteWorkspaceId: secondId,
        url: `https://selfserve.test/workspaces/${secondId}`, providerMetadata: { sharedInfrastructureDeploymentId: "infra-1" } });
      for (const { data } of prismaMock.customerDeployment.create.mock.calls.map(([args]) => args)) {
        expect(data).not.toHaveProperty("releaseLeaseId");
        expect(data).not.toHaveProperty("providerWebServiceId");
        expect(data).not.toHaveProperty("releaseImageTag");
      }
      expect(prismaMock.customerAccount.update).not.toHaveBeenCalled();
      expect(prismaMock.customerAccount.upsert).not.toHaveBeenCalled();
      expect(prismaMock.workspace.findFirst).not.toHaveBeenCalled();
      expect(prismaMock.customerDeployment.upsert).not.toHaveBeenCalled();
    });

    it("reuses an identical destination without changing its status or support credentials", async () => {
      const { registerRemoteSharedWorkspaceDeployment } = await import("./customer-lifecycle");
      const { deployment } = await registerRemoteSharedWorkspaceDeployment(input);
      prismaMock.customerDeployment.create.mockClear();
      prismaMock.customerDeployment.findUnique.mockImplementation(async ({ where }) => where.id === infrastructure.id
        ? infrastructure : { ...deployment, deploymentStatus: "ACTIVE", supportCredentialEnc: "existing-secret" });
      const result = await registerRemoteSharedWorkspaceDeployment(input);
      expect(result.deployment.deploymentStatus).toBe("ACTIVE");
      expect(prismaMock.customerDeployment.create).not.toHaveBeenCalled();
      expect(prismaMock.customerAccount.update).not.toHaveBeenCalled();
    });

    it("rejects another account claiming an already registered remote workspace", async () => {
      const { registerRemoteSharedWorkspaceDeployment } = await import("./customer-lifecycle");
      const { deployment } = await registerRemoteSharedWorkspaceDeployment(input);
      prismaMock.customerDeployment.create.mockClear();
      prismaMock.customerDeployment.findUnique.mockImplementation(async ({ where }) => where.id === infrastructure.id ? infrastructure : deployment);
      await expect(registerRemoteSharedWorkspaceDeployment({ ...input, customerAccountId: "cust-2" })).rejects.toMatchObject({
        code: "REMOTE_SHARED_REGISTRATION_CONFLICT",
      });
      expect(prismaMock.customerDeployment.create).not.toHaveBeenCalled();
      expect(prismaMock.customerAccount.update).not.toHaveBeenCalled();
    });

    it.each([
      { workspaceUrl: `https://ops.test/workspaces/${workspaceId}` },
      { workspaceUrl: "https://selfserve.test/workspaces/00000000-0000-4000-8000-000000000002" },
      { supportMcpUrl: `https://selfserve.test/workspaces/${workspaceId}/api/mcp` },
      { supportMcpUrl: "https://other.test/api/mcp" },
      { workspaceUrl: `http://selfserve.test/workspaces/${workspaceId}` },
      { remoteWorkspaceId: "not-a-uuid" },
    ])("rejects mismatched destination or support identity %j", async (override) => {
      const { registerRemoteSharedWorkspaceDeployment } = await import("./customer-lifecycle");
      await expect(registerRemoteSharedWorkspaceDeployment({ ...input, ...override })).rejects.toMatchObject({ status: 400 });
      expect(prismaMock.customerDeployment.create).not.toHaveBeenCalled();
    });

    it("requires the actual Azure infrastructure web and worker identities", async () => {
      const { registerRemoteSharedWorkspaceDeployment } = await import("./customer-lifecycle");
      prismaMock.customerDeployment.findUnique.mockResolvedValue({ ...infrastructure, providerWorkerServiceId: null });
      await expect(registerRemoteSharedWorkspaceDeployment(input)).rejects.toMatchObject({ code: "SHARED_INFRASTRUCTURE_REQUIRED" });
      expect(prismaMock.customerDeployment.create).not.toHaveBeenCalled();
    });
  });

});
