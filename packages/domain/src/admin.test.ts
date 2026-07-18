import { createHash, createHmac } from "node:crypto";

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
  env: {
    APP_URL: "https://app.test",
  },
  prisma: {
    workspace: {
      findMany: vi.fn().mockResolvedValue([]),
      findUnique: vi.fn().mockResolvedValue(null),
      findFirst: vi.fn().mockResolvedValue({
        id: "ws_new",
        slug: "new-ws",
        name: "New WS",
        description: null,
      }),
      count: vi.fn().mockResolvedValue(0),
    },
    customerAccount: {
      upsert: vi.fn().mockResolvedValue({
        id: "cust_1",
        slug: "acme",
        displayName: "Acme",
        primaryDeploymentId: null,
      }),
      findUnique: vi.fn().mockResolvedValue({
        id: "cust_1",
        primaryDeploymentId: null,
      }),
      update: vi.fn().mockResolvedValue({
        id: "cust_1",
        primaryDeploymentId: "inst_1",
      }),
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
    notificationDelivery: {
      findMany: vi.fn().mockResolvedValue([]),
    },
    communicationInstallation: {
      findMany: vi.fn().mockResolvedValue([]),
    },
    customerDeployment: {
      findMany: vi.fn().mockResolvedValue([]),
      findUnique: vi.fn().mockResolvedValue(null),
      findFirst: vi.fn().mockResolvedValue(null),
      findUniqueOrThrow: vi.fn().mockResolvedValue({
        id: "inst_1",
        url: "http://fake-deployment.com",
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
    customerDeploymentEvent: {
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

function sha256Hex(value: string) {
  return createHash("sha256").update(value).digest("hex");
}

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
    (prisma.notificationDelivery.findMany as any).mockResolvedValue([
      {
        channel: "EMAIL",
        status: "PENDING",
        notification: { type: "deliberation.mention" },
      },
      {
        channel: "EMAIL",
        status: "SENT",
        notification: { type: "deliberation.mention" },
      },
      {
        channel: "SLACK",
        status: "FAILED",
        notification: { type: "role-onboarding.assigned" },
      },
      {
        channel: "SLACK",
        status: "SKIPPED",
        notification: { type: "role-onboarding.assigned" },
      },
    ]);

    const result = await admin.getOperatorOverview(dummyActor);

    expect(requireGlobalOperator).toHaveBeenCalledWith(dummyActor);
    expect(result.workspacesCount).toBe(10);
    expect(result.usersCount).toBe(50);
    expect(result.activeMembersCount).toBe(45);
    expect(result.worker.failedJobs).toBe(1);
    expect(result.worker.pendingJobs).toBe(2);
    expect(result.worker.isHealthy).toBe(true);
    expect(prisma.notificationDelivery.findMany).toHaveBeenCalledWith({
      where: {
        createdAt: { gte: expect.any(Date) },
      },
      select: {
        channel: true,
        status: true,
        notification: {
          select: {
            type: true,
          },
        },
      },
    });
    expect(result.notificationDeliveryHealth).toMatchObject({
      windowDays: 30,
      totals: {
        pending: 1,
        sent: 1,
        failed: 1,
        skipped: 1,
      },
      byChannel: [
        {
          channel: "EMAIL",
          pending: 1,
          sent: 1,
          failed: 0,
          skipped: 0,
        },
        {
          channel: "SLACK",
          pending: 0,
          sent: 0,
          failed: 1,
          skipped: 1,
        },
      ],
      byType: [
        {
          type: "deliberation.mention",
          channel: "EMAIL",
          pending: 1,
          sent: 1,
          failed: 0,
          skipped: 0,
        },
        {
          type: "role-onboarding.assigned",
          channel: "SLACK",
          pending: 0,
          sent: 0,
          failed: 1,
          skipped: 1,
        },
      ],
    });
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

  // ── listCustomerDeployments ────────────────────────────────────────

  it("listCustomerDeployments queries customer deployments", async () => {
    (prisma.customerDeployment.findMany as any).mockResolvedValue([
      { id: "inst_1", label: "Acme" },
    ]);

    const result = await admin.listCustomerDeployments(dummyActor);

    expect(requireGlobalOperator).toHaveBeenCalledWith(dummyActor);
    expect(prisma.customerDeployment.findMany).toHaveBeenCalled();
    expect(result).toHaveLength(1);
  });

  it("buildCustomerDeploymentProviderReadModel exposes Railway IDs through provider-neutral fields", () => {
    expect(admin.buildCustomerDeploymentProviderReadModel({
      railwayProjectId: "railway-project",
      railwayEnvironmentId: "railway-env",
      railwayWebServiceId: "railway-web",
      railwayWorkerServiceId: "railway-worker",
      railwayPostgresServiceId: "railway-postgres",
      railwayRedisServiceId: "railway-redis",
      storageBucketName: "railway-bucket",
    })).toEqual(expect.objectContaining({
      cloudProvider: "RAILWAY",
      providerLabel: "Railway",
      providerProjectId: "railway-project",
      providerEnvironmentId: "railway-env",
      providerWebServiceId: "railway-web",
      providerWorkerServiceId: "railway-worker",
      providerPostgresServiceId: "railway-postgres",
      providerRedisServiceId: "railway-redis",
      providerStorageResourceId: "railway-bucket",
    }));
  });

  it("listCustomerDeploymentEvents returns recent audit events", async () => {
    (prisma.customerDeploymentEvent.findMany as any).mockResolvedValue([
      { id: "event_1", action: "customer_deployment.provisioned" },
    ]);

    const result = await admin.listCustomerDeploymentEvents(dummyActor, "inst_1");

    expect(requireGlobalOperator).toHaveBeenCalledWith(dummyActor);
    expect(prisma.customerDeploymentEvent.findMany).toHaveBeenCalledWith({
      where: { deploymentId: "inst_1" },
      orderBy: { createdAt: "desc" },
      take: 50,
    });
    expect(result).toHaveLength(1);
  });

  // ── registerCustomerDeploymentRecord ────────────────────────────────

  it("registerCustomerDeploymentRecord creates a new customer deployment record", async () => {
    (prisma.workspace.findUnique as any).mockResolvedValueOnce({
      id: "ws_acme",
    });
    (prisma.customerAccount.upsert as any).mockResolvedValueOnce({
      id: "cust_acme",
      slug: "acme",
      displayName: "Acme",
      primaryDeploymentId: null,
    });
    (prisma.customerAccount.findUnique as any).mockResolvedValueOnce({
      id: "cust_acme",
      primaryDeploymentId: null,
    });
    (prisma.customerDeployment.upsert as any).mockResolvedValueOnce({
      id: "inst_new",
      customerSlug: "acme",
      region: "eu-west4",
      releaseImageTag: "sha-1",
      bootstrapBundleUri: null,
    });

    await admin.registerCustomerDeploymentRecord(dummyActor, {
      label: "Acme",
      url: "https://acme.corgtex.com",
      environment: "staging",
      notes: "Test note",
      customerSlug: "acme",
      region: "eu-west4",
      releaseImageTag: "sha-1",
      storageBucketName: "customer-bucket",
    });

    expect(requireGlobalOperator).toHaveBeenCalledWith(dummyActor);
    expect(prisma.customerAccount.upsert).toHaveBeenCalledWith(expect.objectContaining({
      where: { slug: "acme" },
      create: expect.objectContaining({
        slug: "acme",
        displayName: "Acme",
        status: "ACTIVE",
        managementAuthority: "CORGTEX",
      }),
    }));
    expect(prisma.customerDeployment.upsert).toHaveBeenCalledWith({
      where: { url: "https://acme.corgtex.com" },
      update: expect.objectContaining({
        label: "Acme",
        url: "https://acme.corgtex.com",
        environment: "staging",
        notes: "Test note",
        customerSlug: "acme",
        customerAccountId: "cust_acme",
        deploymentKind: "SHARED_WORKSPACE",
        deploymentStatus: "ACTIVE",
        managedWorkspaceId: "ws_acme",
        region: "eu-west4",
        releaseImageTag: "sha-1",
        storageBucketName: "customer-bucket",
      }),
      create: expect.objectContaining({
        customerSlug: "acme",
        customerAccountId: "cust_acme",
        deploymentKind: "SHARED_WORKSPACE",
        deploymentStatus: "ACTIVE",
      }),
    });
    expect(prisma.customerDeploymentEvent.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        deploymentId: "inst_new",
        action: "customer_deployment.registered",
      }),
    });
  });

  // ── removeCustomerDeployment ───────────────────────────────────────

  it("removeCustomerDeployment deletes the customer deployment record", async () => {
    await admin.removeCustomerDeployment(dummyActor, "inst_1");

    expect(requireGlobalOperator).toHaveBeenCalledWith(dummyActor);
    expect(prisma.customerDeployment.delete).toHaveBeenCalledWith({
      where: { id: "inst_1" },
    });
  });

  // ── probeCustomerDeploymentHealth ──────────────────────────────────

  it("probeCustomerDeploymentHealth marks deployment as ok on success", async () => {
    global.fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: vi.fn().mockResolvedValue({
        release: { imageTag: null },
      }),
    });

    await admin.probeCustomerDeploymentHealth(dummyActor, "inst_1");

    expect(requireGlobalOperator).toHaveBeenCalledWith(dummyActor);
    expect(prisma.customerDeployment.update).toHaveBeenCalledWith({
      where: { id: "inst_1" },
      data: expect.objectContaining({
        lastHealthStatus: "ok",
        lastHealthError: null,
        provisioningStatus: "active",
      }),
    });
  });

  it("probeCustomerDeploymentHealth marks deployment as degraded on non-ok response", async () => {
    global.fetch = vi
      .fn()
      .mockResolvedValue({
        ok: false,
        status: 503,
        json: vi.fn().mockResolvedValue({}),
      });

    await admin.probeCustomerDeploymentHealth(dummyActor, "inst_1");

    expect(prisma.customerDeployment.update).toHaveBeenCalledWith({
      where: { id: "inst_1" },
      data: expect.objectContaining({
        lastHealthStatus: "degraded",
        lastHealthError: "Status 503",
        provisioningStatus: "degraded",
      }),
    });
  });

  it("probeCustomerDeploymentHealth marks deployment as down on fetch error", async () => {
    global.fetch = vi
      .fn()
      .mockRejectedValue(new Error("Network Error"));

    await admin.probeCustomerDeploymentHealth(dummyActor, "inst_1");

    expect(requireGlobalOperator).toHaveBeenCalledWith(dummyActor);
    expect(prisma.customerDeployment.update).toHaveBeenCalledWith({
      where: { id: "inst_1" },
      data: expect.objectContaining({
        lastHealthStatus: "down",
        lastHealthError: "Network Error",
        provisioningStatus: "degraded",
      }),
    });
  });

  it("probeCustomerDeploymentHealth marks release drift as degraded", async () => {
    (prisma.customerDeployment.findUniqueOrThrow as any).mockResolvedValueOnce({
      id: "inst_1",
      url: "http://fake-deployment.com",
      releaseImageTag: "sha-expected",
    });
    global.fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: vi.fn().mockResolvedValue({
        release: { imageTag: "sha-actual" },
      }),
    });

    await admin.probeCustomerDeploymentHealth(dummyActor, "inst_1");

    expect(prisma.customerDeployment.update).toHaveBeenCalledWith({
      where: { id: "inst_1" },
      data: expect.objectContaining({
        lastHealthStatus: "degraded",
        lastHealthError: "Release drift: expected sha-expected, got sha-actual",
        provisioningStatus: "degraded",
        lastReleaseCheck: expect.any(Date),
      }),
    });
  });

  it("probeCustomerDeploymentHealth accepts release gitSha when imageTag is not reported", async () => {
    (prisma.customerDeployment.findUniqueOrThrow as any).mockResolvedValueOnce({
      id: "inst_1",
      url: "http://fake-deployment.com",
      releaseImageTag: "sha-expected",
    });
    global.fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: vi.fn().mockResolvedValue({
        database: "up",
        schema: "ready",
        runtime: {
          redis: "configured",
          storage: "configured",
        },
        release: { imageTag: null, gitSha: "sha-expected" },
      }),
    });

    await admin.probeCustomerDeploymentHealth(dummyActor, "inst_1");

    expect(prisma.customerDeployment.update).toHaveBeenCalledWith({
      where: { id: "inst_1" },
      data: expect.objectContaining({
        lastHealthStatus: "ok",
        lastHealthError: null,
        provisioningStatus: "active",
        lastReleaseCheck: expect.any(Date),
      }),
    });
  });

  it("probeCustomerDeploymentHealth accepts matching release gitSha when imageTag metadata is stale", async () => {
    (prisma.customerDeployment.findUniqueOrThrow as any).mockResolvedValueOnce({
      id: "inst_1",
      url: "http://fake-deployment.com",
      releaseImageTag: "sha-expected",
    });
    global.fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: vi.fn().mockResolvedValue({
        database: "up",
        schema: "ready",
        runtime: {
          redis: "configured",
          storage: "configured",
        },
        release: { imageTag: "stale-image-tag", gitSha: "sha-expected" },
      }),
    });

    await admin.probeCustomerDeploymentHealth(dummyActor, "inst_1");

    expect(prisma.customerDeployment.update).toHaveBeenCalledWith({
      where: { id: "inst_1" },
      data: expect.objectContaining({
        lastHealthStatus: "ok",
        lastHealthError: null,
        provisioningStatus: "active",
        lastReleaseCheck: expect.any(Date),
      }),
    });
  });

  it("probeCustomerDeploymentHealth marks missing runtime dependencies as degraded", async () => {
    global.fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: vi.fn().mockResolvedValue({
        database: "up",
        schema: "ready",
        runtime: {
          redis: "configured",
          storage: "missing",
        },
        release: { imageTag: null },
      }),
    });

    await admin.probeCustomerDeploymentHealth(dummyActor, "inst_1");

    expect(prisma.customerDeployment.update).toHaveBeenCalledWith({
      where: { id: "inst_1" },
      data: expect.objectContaining({
        lastHealthStatus: "degraded",
        lastHealthError: "Storage missing",
        provisioningStatus: "degraded",
      }),
    });
  });

  it("provisionCustomerDeployment records Railway resources without storing secrets", async () => {
    (prisma.workspace.findUnique as any).mockResolvedValueOnce({
      id: "ws_acme_prod",
    });
    (prisma.customerDeployment.update as any).mockResolvedValue({
      id: "inst_1",
      customerSlug: "acme-prod",
      provisioningStatus: "awaiting_dns",
    });
    const railwayClient = {
      graphql: vi.fn()
        .mockResolvedValueOnce({ projectCreate: { id: "project-1" } })
        .mockResolvedValueOnce({ environments: { edges: [{ node: { id: "env-1", name: "production" } }] } })
        .mockResolvedValueOnce({
          web: { id: "web-1" },
          worker: { id: "worker-1" },
          postgres: { id: "postgres-1" },
          redis: { id: "redis-1" },
        })
        .mockResolvedValueOnce({})
        .mockResolvedValueOnce({})
        .mockResolvedValueOnce({})
        .mockResolvedValueOnce({})
        .mockResolvedValueOnce({})
        .mockResolvedValueOnce({ customDomainCreate: { domain: "acme.corgtex.com" } }),
    } as any;

    await admin.provisionCustomerDeployment(dummyActor, {
      label: "Acme Production",
      customerSlug: "acme-prod",
      region: "eu-west4",
      dataResidency: "eu",
      customDomain: "acme.corgtex.com",
      supportOwnerEmail: "ops@corgtex.com",
      releaseGitSha: "abc123",
      releaseImageTag: "sha-1",
      webImage: "ghcr.io/corgtex/web:sha-1",
      workerImage: "ghcr.io/corgtex/worker:sha-1",
      storageBucketName: "customer-bucket",
      bootstrapBundleUri: "https://private.example/bundle.json",
      bootstrapBundleChecksum: "a".repeat(64),
      bootstrapBundleSchemaVersion: "stable-client-v1",
      variables: {
        MODEL_PROVIDER: "openrouter",
      },
    }, railwayClient);

    expect(requireGlobalOperator).toHaveBeenCalledWith(dummyActor);
    expect(prisma.customerDeployment.upsert).toHaveBeenCalledWith(expect.objectContaining({
      where: { url: "https://acme.corgtex.com" },
      create: expect.objectContaining({
        provisioningStatus: "provisioning",
        bootstrapStatus: "pending",
        managedWorkspaceId: null,
        storageBucketName: "customer-bucket",
        bootstrapBundleUri: "https://private.example/bundle.json",
        bootstrapBundleChecksum: "a".repeat(64),
      }),
    }));
    expect(prisma.customerDeployment.update).toHaveBeenCalledWith({
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
    expect(prisma.customerDeployment.upsert).toHaveBeenCalledWith(expect.not.objectContaining({
      create: expect.objectContaining({ railwayApiToken: expect.anything() }),
    }));
    expect(railwayClient.graphql).toHaveBeenNthCalledWith(
      7,
      expect.any(String),
      expect.objectContaining({
        variables: expect.objectContaining({
          CORGTEX_RELEASE_GIT_SHA: "abc123",
          CORGTEX_RELEASE_IMAGE_TAG: "sha-1",
          MODEL_PROVIDER: "openrouter",
        }),
      }),
    );
    expect(railwayClient.graphql).toHaveBeenCalledTimes(9);
  });

  it("provisionCustomerDeployment rejects retries for partial Railway stacks", async () => {
    (prisma.customerDeployment.findFirst as any).mockResolvedValueOnce({
      id: "inst_partial",
      customerSlug: "acme-prod",
      deploymentKind: "HOSTED_DEDICATED",
      environment: "production",
      railwayProjectId: "project-1",
      railwayEnvironmentId: null,
      railwayWebServiceId: null,
      railwayWorkerServiceId: null,
      railwayPostgresServiceId: null,
      railwayRedisServiceId: null,
    });
    const railwayClient = { graphql: vi.fn() } as any;

    await expect(admin.provisionCustomerDeployment(dummyActor, {
      label: "Acme Production",
      customerSlug: "acme-prod",
      region: "eu-west4",
      dataResidency: "eu",
      releaseImageTag: "sha-1",
      webImage: "ghcr.io/corgtex/web:sha-1",
      workerImage: "ghcr.io/corgtex/worker:sha-1",
    }, railwayClient)).rejects.toMatchObject({
      status: 409,
      code: "RAILWAY_STACK_RECONCILIATION_REQUIRED",
    });
    expect(railwayClient.graphql).not.toHaveBeenCalled();
  });

  it("provisionCustomerDeployment rejects retries for existing hosted rows without saved Railway IDs", async () => {
    (prisma.customerDeployment.findFirst as any).mockResolvedValueOnce({
      id: "inst_existing",
      customerSlug: "acme-prod",
      deploymentKind: "HOSTED_DEDICATED",
      environment: "production",
      railwayProjectId: null,
      railwayEnvironmentId: null,
      railwayWebServiceId: null,
      railwayWorkerServiceId: null,
      railwayPostgresServiceId: null,
      railwayRedisServiceId: null,
    });
    const railwayClient = { graphql: vi.fn() } as any;

    await expect(admin.provisionCustomerDeployment(dummyActor, {
      label: "Acme Production",
      customerSlug: "acme-prod",
      region: "eu-west4",
      dataResidency: "eu",
      releaseImageTag: "sha-1",
      webImage: "ghcr.io/corgtex/web:sha-1",
      workerImage: "ghcr.io/corgtex/worker:sha-1",
    }, railwayClient)).rejects.toMatchObject({
      status: 409,
      code: "RAILWAY_STACK_RECONCILIATION_REQUIRED",
    });
    expect(railwayClient.graphql).not.toHaveBeenCalled();
  });

  it("provisionCustomerDeployment rejects EU data residency outside EU regions", async () => {
    await expect(admin.provisionCustomerDeployment(dummyActor, {
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
    expect(prisma.customerDeployment.upsert).not.toHaveBeenCalled();
  });

  it("buildCustomerDeploymentRuntimeVariables returns non-secret customer runtime metadata", () => {
    expect(admin.buildCustomerDeploymentRuntimeVariables({
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
      CORGTEX_RELEASE_GIT_SHA: "1",
      CORGTEX_RELEASE_IMAGE_TAG: "sha-1",
      CORGTEX_RELEASE_VERSION: "0.1.0",
      MODEL_PROVIDER: "openrouter",
    });
  });

  it("buildCustomerDeploymentRuntimeVariables can propagate explicit release SHA and Application Insights settings", () => {
    vi.stubEnv("APPLICATIONINSIGHTS_CONNECTION_STRING", "InstrumentationKey=ikey;IngestionEndpoint=https://example.monitor.azure.com/");

    try {
      expect(admin.buildCustomerDeploymentRuntimeVariables({
        customerSlug: "acme-prod",
        releaseGitSha: "abc123",
        releaseImageTag: "image-tag",
        url: "https://acme.corgtex.com",
      })).toEqual(expect.objectContaining({
        APPLICATIONINSIGHTS_CONNECTION_STRING: "InstrumentationKey=ikey;IngestionEndpoint=https://example.monitor.azure.com/",
        CORGTEX_RELEASE_GIT_SHA: "abc123",
        CORGTEX_RELEASE_IMAGE_TAG: "image-tag",
      }));
    } finally {
      vi.unstubAllEnvs();
    }
  });

  it("buildCustomerDeploymentRuntimeVariables includes capped PostHog settings when control-plane capture is enabled", () => {
    vi.stubEnv("POSTHOG_ENABLED", "true");
    vi.stubEnv("POSTHOG_PROJECT_TOKEN", "phc_test");
    vi.stubEnv("POSTHOG_API_HOST", "https://us.i.posthog.com");

    try {
      expect(admin.buildCustomerDeploymentRuntimeVariables({
        customerSlug: "acme-prod",
        url: "https://acme.corgtex.com",
        releaseImageTag: "sha-1",
      })).toEqual(expect.objectContaining({
        POSTHOG_ENABLED: "true",
        POSTHOG_CAPTURE_KILL_SWITCH: "false",
        POSTHOG_PROJECT_TOKEN: "phc_test",
        POSTHOG_API_HOST: "https://us.i.posthog.com",
        POSTHOG_INSTANCE_ID: "client-acme-prod-production",
        POSTHOG_ENVIRONMENT: "production",
        POSTHOG_EVENT_SAMPLE_RATE: "1",
        POSTHOG_CAPTURE_TIMEOUT_MS: "1500",
        POSTHOG_CAPTURE_DEBUG: "false",
      }));
    } finally {
      vi.unstubAllEnvs();
    }
  });

  it("buildCustomerDeploymentReadiness returns ready only when Ops has complete customer deployment metadata", () => {
    const result = admin.buildCustomerDeploymentReadiness({
      url: "https://acme.corgtex.com",
      customDomain: "acme.corgtex.com",
      region: "us-west2",
      dataResidency: "us",
      supportOwnerEmail: "ops@corgtex.com",
      provisioningStatus: "active",
      bootstrapStatus: "applied",
      releaseImageTag: "sha-1",
      railwayProjectId: "project-1",
      railwayEnvironmentId: "env-1",
      railwayWebServiceId: "web-1",
      railwayWorkerServiceId: "worker-1",
      railwayPostgresServiceId: "postgres-1",
      railwayRedisServiceId: "redis-1",
      storageBucketName: "customer-bucket",
      lastHealthStatus: "ok",
      lastHealthError: null,
      lastHealthCheck: new Date(),
      lastReleaseCheck: new Date(),
    });

    expect(result.status).toBe("ready");
    expect(result.checks.every((check) => check.status === "ok")).toBe(true);
  });

  it("buildCustomerDeploymentReadiness uses Azure resource checks for Azure deployments", () => {
    const result = admin.buildCustomerDeploymentReadiness({
      cloudProvider: "AZURE",
      url: "https://selfserve.corgtex.com",
      customDomain: "selfserve.corgtex.com",
      region: "westus2",
      dataResidency: "us",
      supportOwnerEmail: "ops@corgtex.com",
      provisioningStatus: "active",
      bootstrapStatus: "applied",
      releaseImageTag: "sha-1",
      providerSubscriptionId: "sub-1",
      providerResourceGroup: "rg-corgtex-selfserve-staging",
      providerEnvironmentId: "aca-env-1",
      providerWebServiceId: "aca-web-1",
      providerWorkerServiceId: "aca-worker-1",
      providerPostgresServiceId: "postgres-1",
      providerRedisServiceId: "redis-1",
      providerStorageResourceId: "storage-1",
      lastHealthStatus: "ok",
      lastHealthError: null,
      lastHealthCheck: new Date(),
      lastReleaseCheck: new Date(),
    });

    expect(result.status).toBe("ready");
    expect(result.checks).toEqual(expect.arrayContaining([
      expect.objectContaining({ key: "azure_resources", label: "Azure resources", status: "ok" }),
      expect.objectContaining({ key: "storage", label: "Azure Blob storage", status: "ok" }),
    ]));
  });

  it("buildCustomerDeploymentReadiness flags incomplete customer deployment metadata", () => {
    const result = admin.buildCustomerDeploymentReadiness({
      url: "https://acme.corgtex.com",
      provisioningStatus: "draft",
      bootstrapStatus: "not_started",
    });

    expect(result.status).toBe("attention");
    expect(result.checks).toEqual(expect.arrayContaining([
      expect.objectContaining({ key: "railway_project", status: "missing" }),
      expect.objectContaining({ key: "storage", status: "missing" }),
      expect.objectContaining({ key: "bootstrap", status: "missing" }),
    ]));
  });

  it("upgradeCustomerDeploymentRelease updates Railway service images and records the target release", async () => {
    (prisma.customerDeployment.findUniqueOrThrow as any).mockResolvedValueOnce({
      id: "inst_1",
      url: "https://acme.corgtex.com",
      customerSlug: "acme-prod",
      railwayProjectId: "project-1",
      railwayEnvironmentId: "env-1",
      railwayWebServiceId: "web-1",
      railwayWorkerServiceId: "worker-1",
    });
    (prisma.customerDeployment.update as any).mockResolvedValue({
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

    vi.stubEnv("APPLICATIONINSIGHTS_CONNECTION_STRING", "InstrumentationKey=ikey;IngestionEndpoint=https://example.monitor.azure.com/");

    try {
      await admin.upgradeCustomerDeploymentRelease(dummyActor, {
        deploymentId: "inst_1",
        releaseVersion: "0.2.0",
        releaseGitSha: "abc456",
        releaseImageTag: "sha-2",
        webImage: "ghcr.io/corgtex/web:sha-2",
        workerImage: "ghcr.io/corgtex/worker:sha-2",
      }, railwayClient);
    } finally {
      vi.unstubAllEnvs();
    }

    expect(requireGlobalOperator).toHaveBeenCalledWith(dummyActor);
    expect(prisma.customerDeployment.update).toHaveBeenCalledWith({
      where: { id: "inst_1" },
      data: expect.objectContaining({
        provisioningStatus: "provisioning",
        releaseVersion: "0.2.0",
        releaseImageTag: "sha-2",
      }),
    });
    expect(prisma.customerDeployment.update).toHaveBeenCalledWith({
      where: { id: "inst_1" },
      data: expect.objectContaining({
        provisioningStatus: "active",
        releaseVersion: "0.2.0",
        releaseImageTag: "sha-2",
        lastReleaseCheck: expect.any(Date),
      }),
    });
    expect(railwayClient.graphql).toHaveBeenCalledTimes(3);
    expect(railwayClient.graphql).toHaveBeenNthCalledWith(
      2,
      expect.any(String),
      expect.objectContaining({
        variables: expect.objectContaining({
          APP_URL: "https://acme.corgtex.com",
          WORKSPACE_SLUG: "acme-prod",
          APPLICATIONINSIGHTS_CONNECTION_STRING: "InstrumentationKey=ikey;IngestionEndpoint=https://example.monitor.azure.com/",
          CORGTEX_RELEASE_GIT_SHA: "abc456",
          CORGTEX_RELEASE_IMAGE_TAG: "sha-2",
          CORGTEX_RELEASE_VERSION: "0.2.0",
        }),
      }),
    );
    expect(prisma.customerDeploymentEvent.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        deploymentId: "inst_1",
        action: "customer_deployment.upgrade_succeeded",
      }),
    });
  });

  it("upgradeCustomerDeploymentRelease requires Railway service IDs before deployment", async () => {
    (prisma.customerDeployment.findUniqueOrThrow as any).mockResolvedValueOnce({
      id: "inst_1",
      customerSlug: "acme-prod",
      railwayProjectId: null,
      railwayEnvironmentId: "env-1",
      railwayWebServiceId: "web-1",
      railwayWorkerServiceId: "worker-1",
    });

    await expect(admin.upgradeCustomerDeploymentRelease(dummyActor, {
      deploymentId: "inst_1",
      releaseImageTag: "sha-2",
      webImage: "ghcr.io/corgtex/web:sha-2",
      workerImage: "ghcr.io/corgtex/worker:sha-2",
    }, { graphql: vi.fn() } as any)).rejects.toMatchObject({
      code: "INVALID_INPUT",
      message: "Customer deployment is missing a Railway project ID.",
    });
  });

  it("triggerCustomerDeploymentBootstrap signs a one-time token without storing the raw token", async () => {
    (prisma.customerDeployment.findUniqueOrThrow as any).mockResolvedValueOnce({
      id: "inst_1",
      url: "https://acme.corgtex.com",
      customerSlug: "acme-prod",
      bootstrapBundleUri: "https://private.example/bundle.json",
      bootstrapBundleChecksum: "a".repeat(64),
      bootstrapBundleSchemaVersion: "stable-client-v1",
    });
    (prisma.customerDeployment.update as any).mockResolvedValue({
      id: "inst_1",
      bootstrapStatus: "bootstrapping",
    });
    global.fetch = vi.fn().mockResolvedValue({ ok: true, status: 200 });

    const expiresAt = new Date("2026-05-01T10:00:00.000Z");
    await admin.triggerCustomerDeploymentBootstrap(dummyActor, {
      deploymentId: "inst_1",
      token: "one-time-bootstrap-token",
      expiresAt,
    });

    const [, request] = (global.fetch as any).mock.calls[0];
    const body = JSON.parse(request.body);
    const tokenHash = sha256Hex("one-time-bootstrap-token");
    const expectedPayload = JSON.stringify({
      customerSlug: "acme-prod",
      bundleUri: "https://private.example/bundle.json",
      checksum: "a".repeat(64),
      schemaVersion: "stable-client-v1",
      expiresAt: expiresAt.toISOString(),
      tokenHash,
    });

    expect(request.headers.Authorization).toBe("Bearer one-time-bootstrap-token");
    expect(body).toMatchObject({
      customerSlug: "acme-prod",
      tokenHash,
      signature: createHmac("sha256", "one-time-bootstrap-token").update(expectedPayload).digest("hex"),
    });
    expect(JSON.stringify(body)).not.toContain("one-time-bootstrap-token");
    expect(prisma.customerDeploymentEvent.create).toHaveBeenCalledWith({
      data: expect.not.objectContaining({
        meta: expect.objectContaining({ token: expect.anything() }),
      }),
    });
  });

  it("suspendCustomerDeployment marks a deployment suspended and audits the action", async () => {
    (prisma.customerDeployment.update as any).mockResolvedValue({
      id: "inst_1",
      provisioningStatus: "suspended",
    });

    await admin.suspendCustomerDeployment(dummyActor, "inst_1");

    expect(prisma.customerDeployment.update).toHaveBeenCalledWith({
      where: { id: "inst_1" },
      data: { provisioningStatus: "suspended", deploymentStatus: "SUSPENDED" },
    });
    expect(prisma.customerDeploymentEvent.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        deploymentId: "inst_1",
        action: "customer_deployment.suspended",
      }),
    });
  });
});
