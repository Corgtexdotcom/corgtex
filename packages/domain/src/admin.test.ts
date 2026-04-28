import { describe, it, expect, vi, beforeEach } from "vitest";
import * as admin from "./admin";
import { prisma } from "@corgtex/shared";
import { requireGlobalOperator } from "./auth";

// ── Mocks ──────────────────────────────────────────────────────────

vi.mock("./auth", () => ({
  requireGlobalOperator: vi.fn(),
  requireWorkspaceMembership: vi.fn(),
}));

vi.mock("@corgtex/shared", () => ({
  prisma: {
    workspace: {
      findMany: vi.fn().mockResolvedValue([]),
      count: vi.fn().mockResolvedValue(0),
    },
    user: {
      findMany: vi.fn().mockResolvedValue([]),
      findUnique: vi.fn(),
      count: vi.fn().mockResolvedValue(0),
    },
    member: {
      findMany: vi.fn().mockResolvedValue([]),
      findUniqueOrThrow: vi.fn().mockResolvedValue({
        id: "m_1",
        user: { email: "test@example.com" },
      }),
      count: vi.fn().mockResolvedValue(0),
      delete: vi.fn().mockResolvedValue({}),
      update: vi.fn().mockResolvedValue({}),
    },
    workflowJob: {
      findFirst: vi.fn().mockResolvedValue(null),
      findMany: vi.fn().mockResolvedValue([]),
      count: vi.fn().mockResolvedValue(0),
    },
    communicationInstallation: {
      findMany: vi.fn().mockResolvedValue([]),
    },
    instanceRegistry: {
      findMany: vi.fn().mockResolvedValue([]),
      findUniqueOrThrow: vi.fn().mockResolvedValue({
        id: "inst_1",
        url: "http://fake-instance.com",
        customerSlug: "acme-prod",
        bootstrapBundleUri: "https://private.example/bundle.json",
        bootstrapBundleChecksum: "a".repeat(64),
        bootstrapBundleSchemaVersion: "stable-client-v1",
      }),
      upsert: vi.fn().mockResolvedValue({
        id: "inst_1",
        customerSlug: "acme-prod",
        region: "eu-west4",
        releaseImageTag: "sha-1",
      }),
      create: vi.fn().mockResolvedValue({ id: "inst_new" }),
      delete: vi.fn().mockResolvedValue({}),
      update: vi.fn().mockResolvedValue({}),
    },
    hostedInstanceEvent: {
      findMany: vi.fn().mockResolvedValue([]),
      create: vi.fn().mockResolvedValue({ id: "event_1" }),
    },
  },
}));

vi.mock("./workspaces", () => ({
  createWorkspace: vi.fn().mockResolvedValue({ id: "ws_new" }),
}));

vi.mock("./members", () => ({
  createMember: vi.fn().mockResolvedValue({ id: "member_new" }),
}));

vi.mock("./password-reset", () => ({
  requestPasswordReset: vi
    .fn()
    .mockResolvedValue({ token: "reset_token_123" }),
}));

const dummyActor = { userId: "operator_1" } as any;

// ── Tests ──────────────────────────────────────────────────────────

describe("Platform Admin Tools", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  // ── listAllWorkspaces ────────────────────────────────────────────

  it("listAllWorkspaces calls requireGlobalOperator and returns mapped data", async () => {
    (prisma.workspace.findMany as any).mockResolvedValue([
      {
        id: "ws_1",
        slug: "ws-1",
        name: "WS 1",
        createdAt: new Date(),
        _count: { members: 5 },
      },
    ]);

    const result = await admin.listAllWorkspaces(dummyActor);

    expect(requireGlobalOperator).toHaveBeenCalledWith(dummyActor);
    expect(prisma.workspace.findMany).toHaveBeenCalled();
    expect(result).toHaveLength(1);
    expect(result[0]).toEqual(
      expect.objectContaining({ id: "ws_1", memberCount: 5 })
    );
  });

  // ── listAllUsers ─────────────────────────────────────────────────

  it("listAllUsers calls requireGlobalOperator and queries users", async () => {
    (prisma.user.findMany as any).mockResolvedValue([
      { id: "u_1", email: "a@b.com" },
    ]);

    const result = await admin.listAllUsers(dummyActor);

    expect(requireGlobalOperator).toHaveBeenCalledWith(dummyActor);
    expect(prisma.user.findMany).toHaveBeenCalled();
    expect(result).toHaveLength(1);
  });

  // ── getOperatorOverview ──────────────────────────────────────────

  it("getOperatorOverview aggregates system stats", async () => {
    (prisma.workspace.count as any).mockResolvedValue(10);
    (prisma.user.count as any).mockResolvedValue(50);
    (prisma.member.count as any).mockResolvedValue(45);
    (prisma.workflowJob.findFirst as any).mockResolvedValue({
      createdAt: new Date(),
    });
    (prisma.workflowJob.count as any).mockImplementation(
      ({ where }: any) => {
        if (where.status === "PENDING") return 2;
        if (where.status === "FAILED") return 1;
        return 0;
      }
    );

    const result = await admin.getOperatorOverview(dummyActor);

    expect(requireGlobalOperator).toHaveBeenCalledWith(dummyActor);
    expect(result.workspacesCount).toBe(10);
    expect(result.usersCount).toBe(50);
    expect(result.activeMembersCount).toBe(45);
    expect(result.worker.failedJobs).toBe(1);
    expect(result.worker.pendingJobs).toBe(2);
    expect(result.worker.isHealthy).toBe(true);
  });

  // ── listAllWorkspacesEnriched ────────────────────────────────────

  it("listAllWorkspacesEnriched returns enriched workspace data", async () => {
    (prisma.workspace.findMany as any).mockResolvedValue([
      {
        id: "ws_1",
        slug: "ws-1",
        name: "WS 1",
        createdAt: new Date(),
        members: [
          { isActive: true, role: "ADMIN" },
          { isActive: false, role: "CONTRIBUTOR" },
        ],
        _count: { members: 2, workflowJobs: 3 },
      },
    ]);

    const result = await admin.listAllWorkspacesEnriched(dummyActor);

    expect(requireGlobalOperator).toHaveBeenCalledWith(dummyActor);
    expect(result).toHaveLength(1);
    expect(result[0]).toEqual(
      expect.objectContaining({
        activeMemberCount: 1,
        adminCount: 1,
        failedJobsCount: 3,
      })
    );
  });

  // ── getWorkspaceAdminDetail ──────────────────────────────────────

  it("getWorkspaceAdminDetail returns members, jobs, and comm data", async () => {
    (prisma.member.findMany as any).mockResolvedValue([{ id: "m_1" }]);
    (prisma.workflowJob.findMany as any).mockResolvedValue([{ id: "j_1" }]);
    (prisma.communicationInstallation.findMany as any).mockResolvedValue([
      { id: "ci_1" },
    ]);

    const result = await admin.getWorkspaceAdminDetail(dummyActor, "ws_1");

    expect(requireGlobalOperator).toHaveBeenCalledWith(dummyActor);
    expect(result.members).toHaveLength(1);
    expect(result.failedJobs).toHaveLength(1);
    expect(result.commInstallations).toHaveLength(1);
  });

  // ── adminTriggerPasswordReset ────────────────────────────────────

  it("adminTriggerPasswordReset returns the reset token", async () => {
    const token = await admin.adminTriggerPasswordReset(
      dummyActor,
      "test@example.com"
    );

    expect(requireGlobalOperator).toHaveBeenCalledWith(dummyActor);
    expect(token).toBe("reset_token_123");
  });

  // ── adminAddToWorkspace ──────────────────────────────────────────

  it("adminAddToWorkspace looks up user and creates member", async () => {
    (prisma.user.findUnique as any).mockResolvedValue({
      id: "u_1",
      email: "user@test.com",
      displayName: "Test User",
    });
    const { createMember } = await import("./members");

    await admin.adminAddToWorkspace(dummyActor, {
      userId: "u_1",
      workspaceId: "ws_1",
      role: "CONTRIBUTOR",
    });

    expect(requireGlobalOperator).toHaveBeenCalledWith(dummyActor);
    expect(prisma.user.findUnique).toHaveBeenCalledWith({
      where: { id: "u_1" },
    });
    expect(createMember).toHaveBeenCalledWith(
      dummyActor,
      expect.objectContaining({
        workspaceId: "ws_1",
        email: "user@test.com",
        role: "CONTRIBUTOR",
      })
    );
  });

  // ── adminRemoveFromWorkspace ─────────────────────────────────────

  it("adminRemoveFromWorkspace deletes the member", async () => {
    await admin.adminRemoveFromWorkspace(dummyActor, { memberId: "m_1" });

    expect(requireGlobalOperator).toHaveBeenCalledWith(dummyActor);
    expect(prisma.member.delete).toHaveBeenCalledWith({
      where: { id: "m_1" },
    });
  });

  // ── adminCreateMember ────────────────────────────────────────────

  it("adminCreateMember bypasses normal admin check via skipAdminCheck", async () => {
    const { createMember } = await import("./members");

    await admin.adminCreateMember(dummyActor, {
      workspaceId: "ws_1",
      email: "new@example.com",
      displayName: "New User",
      role: "CONTRIBUTOR",
    });

    expect(requireGlobalOperator).toHaveBeenCalledWith(dummyActor);
    expect(createMember).toHaveBeenCalledWith(
      dummyActor,
      expect.objectContaining({
        email: "new@example.com",
        skipAdminCheck: true,
      })
    );
  });

  // ── adminUpdateMember ────────────────────────────────────────────

  it("adminUpdateMember updates the member role", async () => {
    await admin.adminUpdateMember(dummyActor, {
      workspaceId: "ws_1",
      memberId: "m_1",
      role: "ADMIN",
    });

    expect(requireGlobalOperator).toHaveBeenCalledWith(dummyActor);
    expect(prisma.member.update).toHaveBeenCalledWith({
      where: { id: "m_1" },
      data: { role: "ADMIN" },
    });
  });

  // ── adminDeactivateMember ────────────────────────────────────────

  it("adminDeactivateMember sets isActive to false", async () => {
    await admin.adminDeactivateMember(dummyActor, {
      workspaceId: "ws_1",
      memberId: "m_1",
    });

    expect(requireGlobalOperator).toHaveBeenCalledWith(dummyActor);
    expect(prisma.member.update).toHaveBeenCalledWith({
      where: { id: "m_1" },
      data: { isActive: false },
    });
  });

  // ── adminBulkInvite ──────────────────────────────────────────────

  it("adminBulkInvite creates members for each entry", async () => {
    const { createMember } = await import("./members");

    await admin.adminBulkInvite(dummyActor, {
      workspaceId: "ws_1",
      members: [
        { email: "a@test.com", role: "CONTRIBUTOR" },
        { email: "b@test.com", displayName: "Bob", role: "ADMIN" },
      ],
    });

    expect(requireGlobalOperator).toHaveBeenCalledWith(dummyActor);
    expect(createMember).toHaveBeenCalledTimes(2);
    expect(createMember).toHaveBeenCalledWith(
      dummyActor,
      expect.objectContaining({
        email: "a@test.com",
        skipAdminCheck: true,
      })
    );
  });

  // ── adminResendAccessLink ────────────────────────────────────────

  it("adminResendAccessLink looks up member and triggers password reset", async () => {
    (prisma.member.findUniqueOrThrow as any).mockResolvedValue({
      id: "m_1",
      user: { email: "member@test.com" },
    });
    const { requestPasswordReset } = await import("./password-reset");

    await admin.adminResendAccessLink(dummyActor, {
      workspaceId: "ws_1",
      memberId: "m_1",
    });

    expect(requireGlobalOperator).toHaveBeenCalledWith(dummyActor);
    expect(prisma.member.findUniqueOrThrow).toHaveBeenCalledWith(
      expect.objectContaining({ where: { id: "m_1" } })
    );
    expect(requestPasswordReset).toHaveBeenCalledWith("member@test.com");
  });

  // ── adminCreateWorkspace ─────────────────────────────────────────

  it("adminCreateWorkspace delegates to createWorkspace", async () => {
    const { createWorkspace } = await import("./workspaces");

    await admin.adminCreateWorkspace(dummyActor, {
      name: "New WS",
      slug: "new-ws",
      description: null,
    });

    expect(requireGlobalOperator).toHaveBeenCalledWith(dummyActor);
    expect(createWorkspace).toHaveBeenCalledWith(
      dummyActor,
      expect.objectContaining({ name: "New WS", slug: "new-ws" })
    );
  });

  // ── listExternalInstances ────────────────────────────────────────

  it("listExternalInstances queries instance registry", async () => {
    (prisma.instanceRegistry.findMany as any).mockResolvedValue([
      { id: "inst_1", label: "Acme" },
    ]);

    const result = await admin.listExternalInstances(dummyActor);

    expect(requireGlobalOperator).toHaveBeenCalledWith(dummyActor);
    expect(prisma.instanceRegistry.findMany).toHaveBeenCalled();
    expect(result).toHaveLength(1);
  });

  it("listHostedInstanceEvents returns recent audit events", async () => {
    (prisma.hostedInstanceEvent.findMany as any).mockResolvedValue([
      { id: "event_1", action: "hosted_instance.provisioned" },
    ]);

    const result = await admin.listHostedInstanceEvents(dummyActor, "inst_1");

    expect(requireGlobalOperator).toHaveBeenCalledWith(dummyActor);
    expect(prisma.hostedInstanceEvent.findMany).toHaveBeenCalledWith({
      where: { instanceId: "inst_1" },
      orderBy: { createdAt: "desc" },
      take: 50,
    });
    expect(result).toHaveLength(1);
  });

  // ── registerExternalInstance ──────────────────────────────────────

  it("registerExternalInstance creates a new registry entry", async () => {
    (prisma.instanceRegistry.create as any).mockResolvedValue({
      id: "inst_new",
      customerSlug: "acme",
      region: "eu-west4",
      releaseImageTag: "sha-1",
      bootstrapBundleUri: null,
    });

    await admin.registerExternalInstance(dummyActor, {
      label: "Acme",
      url: "https://acme.corgtex.com",
      environment: "staging",
      notes: "Test note",
      customerSlug: "acme",
      region: "eu-west4",
      releaseImageTag: "sha-1",
    });

    expect(requireGlobalOperator).toHaveBeenCalledWith(dummyActor);
    expect(prisma.instanceRegistry.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        label: "Acme",
        url: "https://acme.corgtex.com",
        environment: "staging",
        notes: "Test note",
        customerSlug: "acme",
        region: "eu-west4",
        releaseImageTag: "sha-1",
      }),
    });
    expect(prisma.hostedInstanceEvent.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        instanceId: "inst_new",
        action: "hosted_instance.registered",
      }),
    });
  });

  // ── removeExternalInstance ───────────────────────────────────────

  it("removeExternalInstance deletes the registry entry", async () => {
    await admin.removeExternalInstance(dummyActor, "inst_1");

    expect(requireGlobalOperator).toHaveBeenCalledWith(dummyActor);
    expect(prisma.instanceRegistry.delete).toHaveBeenCalledWith({
      where: { id: "inst_1" },
    });
  });

  // ── probeExternalInstanceHealth ──────────────────────────────────

  it("probeExternalInstanceHealth marks instance as ok on success", async () => {
    global.fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: vi.fn().mockResolvedValue({
        release: { imageTag: null },
      }),
    });

    await admin.probeExternalInstanceHealth(dummyActor, "inst_1");

    expect(requireGlobalOperator).toHaveBeenCalledWith(dummyActor);
    expect(prisma.instanceRegistry.update).toHaveBeenCalledWith({
      where: { id: "inst_1" },
      data: expect.objectContaining({
        lastHealthStatus: "ok",
        lastHealthError: null,
        provisioningStatus: "active",
      }),
    });
  });

  it("probeExternalInstanceHealth marks instance as degraded on non-ok response", async () => {
    global.fetch = vi
      .fn()
      .mockResolvedValue({
        ok: false,
        status: 503,
        json: vi.fn().mockResolvedValue({}),
      });

    await admin.probeExternalInstanceHealth(dummyActor, "inst_1");

    expect(prisma.instanceRegistry.update).toHaveBeenCalledWith({
      where: { id: "inst_1" },
      data: expect.objectContaining({
        lastHealthStatus: "degraded",
        lastHealthError: "Status 503",
        provisioningStatus: "degraded",
      }),
    });
  });

  it("probeExternalInstanceHealth marks instance as down on fetch error", async () => {
    global.fetch = vi
      .fn()
      .mockRejectedValue(new Error("Network Error"));

    await admin.probeExternalInstanceHealth(dummyActor, "inst_1");

    expect(requireGlobalOperator).toHaveBeenCalledWith(dummyActor);
    expect(prisma.instanceRegistry.update).toHaveBeenCalledWith({
      where: { id: "inst_1" },
      data: expect.objectContaining({
        lastHealthStatus: "down",
        lastHealthError: "Network Error",
        provisioningStatus: "degraded",
      }),
    });
  });

  it("probeExternalInstanceHealth marks release drift as degraded", async () => {
    (prisma.instanceRegistry.findUniqueOrThrow as any).mockResolvedValueOnce({
      id: "inst_1",
      url: "http://fake-instance.com",
      releaseImageTag: "sha-expected",
    });
    global.fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: vi.fn().mockResolvedValue({
        release: { imageTag: "sha-actual" },
      }),
    });

    await admin.probeExternalInstanceHealth(dummyActor, "inst_1");

    expect(prisma.instanceRegistry.update).toHaveBeenCalledWith({
      where: { id: "inst_1" },
      data: expect.objectContaining({
        lastHealthStatus: "degraded",
        lastHealthError: "Release drift: expected sha-expected, got sha-actual",
        provisioningStatus: "degraded",
        lastReleaseCheck: expect.any(Date),
      }),
    });
  });

  it("provisionHostedCustomerInstance records Railway resources without storing secrets", async () => {
    (prisma.instanceRegistry.update as any).mockResolvedValue({
      id: "inst_1",
      customerSlug: "acme-prod",
      provisioningStatus: "awaiting_dns",
    });
    const railwayClient = {
      graphql: vi.fn()
        .mockResolvedValueOnce({ projectCreate: { id: "project-1", defaultEnvironment: { id: "env-1" } } })
        .mockResolvedValueOnce({
          web: { id: "web-1" },
          worker: { id: "worker-1" },
          postgres: { id: "postgres-1" },
          redis: { id: "redis-1" },
        })
        .mockResolvedValueOnce({})
        .mockResolvedValueOnce({})
        .mockResolvedValueOnce({ customDomainCreate: { domain: "acme.corgtex.com" } }),
    } as any;

    await admin.provisionHostedCustomerInstance(dummyActor, {
      label: "Acme Production",
      customerSlug: "acme-prod",
      region: "eu-west4",
      dataResidency: "eu",
      customDomain: "acme.corgtex.com",
      supportOwnerEmail: "ops@corgtex.com",
      releaseImageTag: "sha-1",
      webImage: "ghcr.io/corgtex/web:sha-1",
      workerImage: "ghcr.io/corgtex/worker:sha-1",
      bootstrapBundleUri: "https://private.example/bundle.json",
      bootstrapBundleChecksum: "a".repeat(64),
      bootstrapBundleSchemaVersion: "stable-client-v1",
      variables: {
        MODEL_PROVIDER: "openrouter",
      },
    }, railwayClient);

    expect(requireGlobalOperator).toHaveBeenCalledWith(dummyActor);
    expect(prisma.instanceRegistry.upsert).toHaveBeenCalledWith(expect.objectContaining({
      where: { customerSlug: "acme-prod" },
      create: expect.objectContaining({
        provisioningStatus: "provisioning",
        bootstrapStatus: "pending",
        bootstrapBundleUri: "https://private.example/bundle.json",
        bootstrapBundleChecksum: "a".repeat(64),
      }),
    }));
    expect(prisma.instanceRegistry.update).toHaveBeenCalledWith({
      where: { id: "inst_1" },
      data: expect.objectContaining({
        railwayProjectId: "project-1",
        railwayWebServiceId: "web-1",
        railwayWorkerServiceId: "worker-1",
        railwayPostgresServiceId: "postgres-1",
        railwayRedisServiceId: "redis-1",
        provisioningStatus: "awaiting_dns",
      }),
    });
    expect(prisma.instanceRegistry.upsert).toHaveBeenCalledWith(expect.not.objectContaining({
      create: expect.objectContaining({ railwayApiToken: expect.anything() }),
    }));
  });

  it("provisionHostedCustomerInstance rejects EU data residency outside EU regions", async () => {
    await expect(admin.provisionHostedCustomerInstance(dummyActor, {
      label: "Acme Production",
      customerSlug: "acme-prod",
      region: "us-west1",
      dataResidency: "eu",
      releaseImageTag: "sha-1",
      webImage: "ghcr.io/corgtex/web:sha-1",
      workerImage: "ghcr.io/corgtex/worker:sha-1",
    }, { graphql: vi.fn() } as any)).rejects.toMatchObject({
      code: "DATA_RESIDENCY_REGION_MISMATCH",
    });
    expect(prisma.instanceRegistry.upsert).not.toHaveBeenCalled();
  });

  it("buildHostedCustomerRuntimeVariables returns non-secret customer runtime metadata", () => {
    expect(admin.buildHostedCustomerRuntimeVariables({
      customerSlug: "acme-prod",
      url: "https://acme.corgtex.com",
      releaseImageTag: "sha-1",
      releaseVersion: "0.1.0",
      overrides: {
        MODEL_PROVIDER: "openrouter",
      },
    })).toEqual({
      APP_URL: "https://acme.corgtex.com",
      WORKSPACE_SLUG: "acme-prod",
      REDIS_KEY_PREFIX: "acme-prod-prod",
      CORGTEX_RELEASE_IMAGE_TAG: "sha-1",
      CORGTEX_RELEASE_VERSION: "0.1.0",
      MODEL_PROVIDER: "openrouter",
    });
  });

  it("upgradeHostedInstanceRelease updates Railway service images and records the target release", async () => {
    (prisma.instanceRegistry.findUniqueOrThrow as any).mockResolvedValueOnce({
      id: "inst_1",
      customerSlug: "acme-prod",
      railwayProjectId: "project-1",
      railwayEnvironmentId: "env-1",
      railwayWebServiceId: "web-1",
      railwayWorkerServiceId: "worker-1",
    });
    (prisma.instanceRegistry.update as any).mockResolvedValue({
      id: "inst_1",
      provisioningStatus: "active",
      releaseImageTag: "sha-2",
    });
    const railwayClient = {
      graphql: vi.fn()
        .mockResolvedValueOnce({})
        .mockResolvedValueOnce({})
        .mockResolvedValueOnce({ web: "deploy-web", worker: "deploy-worker" }),
    } as any;

    await admin.upgradeHostedInstanceRelease(dummyActor, {
      instanceId: "inst_1",
      releaseVersion: "0.2.0",
      releaseImageTag: "sha-2",
      webImage: "ghcr.io/corgtex/web:sha-2",
      workerImage: "ghcr.io/corgtex/worker:sha-2",
    }, railwayClient);

    expect(requireGlobalOperator).toHaveBeenCalledWith(dummyActor);
    expect(prisma.instanceRegistry.update).toHaveBeenCalledWith({
      where: { id: "inst_1" },
      data: expect.objectContaining({
        provisioningStatus: "provisioning",
        releaseVersion: "0.2.0",
        releaseImageTag: "sha-2",
      }),
    });
    expect(prisma.instanceRegistry.update).toHaveBeenCalledWith({
      where: { id: "inst_1" },
      data: expect.objectContaining({
        provisioningStatus: "active",
        releaseVersion: "0.2.0",
        releaseImageTag: "sha-2",
        lastReleaseCheck: expect.any(Date),
      }),
    });
    expect(railwayClient.graphql).toHaveBeenCalledTimes(3);
    expect(prisma.hostedInstanceEvent.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        instanceId: "inst_1",
        action: "hosted_instance.upgrade_succeeded",
      }),
    });
  });

  it("upgradeHostedInstanceRelease requires Railway service IDs before deployment", async () => {
    (prisma.instanceRegistry.findUniqueOrThrow as any).mockResolvedValueOnce({
      id: "inst_1",
      customerSlug: "acme-prod",
      railwayProjectId: null,
      railwayEnvironmentId: "env-1",
      railwayWebServiceId: "web-1",
      railwayWorkerServiceId: "worker-1",
    });

    await expect(admin.upgradeHostedInstanceRelease(dummyActor, {
      instanceId: "inst_1",
      releaseImageTag: "sha-2",
      webImage: "ghcr.io/corgtex/web:sha-2",
      workerImage: "ghcr.io/corgtex/worker:sha-2",
    }, { graphql: vi.fn() } as any)).rejects.toMatchObject({
      code: "INVALID_INPUT",
      message: "Instance is missing a Railway project ID.",
    });
  });

  it("suspendHostedInstance marks an instance suspended and audits the action", async () => {
    (prisma.instanceRegistry.update as any).mockResolvedValue({
      id: "inst_1",
      provisioningStatus: "suspended",
    });

    await admin.suspendHostedInstance(dummyActor, "inst_1");

    expect(prisma.instanceRegistry.update).toHaveBeenCalledWith({
      where: { id: "inst_1" },
      data: { provisioningStatus: "suspended" },
    });
    expect(prisma.hostedInstanceEvent.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        instanceId: "inst_1",
        action: "hosted_instance.suspended",
      }),
    });
  });
});
