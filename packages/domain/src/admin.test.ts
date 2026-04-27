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
      }),
      create: vi.fn().mockResolvedValue({ id: "inst_new" }),
      delete: vi.fn().mockResolvedValue({}),
      update: vi.fn().mockResolvedValue({}),
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

  // ── registerExternalInstance ──────────────────────────────────────

  it("registerExternalInstance creates a new registry entry", async () => {
    await admin.registerExternalInstance(dummyActor, {
      label: "Acme",
      url: "https://acme.corgtex.com",
      environment: "staging",
      notes: "Test note",
    });

    expect(requireGlobalOperator).toHaveBeenCalledWith(dummyActor);
    expect(prisma.instanceRegistry.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        label: "Acme",
        url: "https://acme.corgtex.com",
        environment: "staging",
        notes: "Test note",
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
    global.fetch = vi.fn().mockResolvedValue({ ok: true });

    await admin.probeExternalInstanceHealth(dummyActor, "inst_1");

    expect(requireGlobalOperator).toHaveBeenCalledWith(dummyActor);
    expect(prisma.instanceRegistry.update).toHaveBeenCalledWith({
      where: { id: "inst_1" },
      data: expect.objectContaining({
        lastHealthStatus: "ok",
        lastHealthError: null,
      }),
    });
  });

  it("probeExternalInstanceHealth marks instance as degraded on non-ok response", async () => {
    global.fetch = vi
      .fn()
      .mockResolvedValue({ ok: false, status: 503 });

    await admin.probeExternalInstanceHealth(dummyActor, "inst_1");

    expect(prisma.instanceRegistry.update).toHaveBeenCalledWith({
      where: { id: "inst_1" },
      data: expect.objectContaining({
        lastHealthStatus: "degraded",
        lastHealthError: "Status 503",
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
      }),
    });
  });
});
