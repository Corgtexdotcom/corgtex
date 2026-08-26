import { describe, it, expect, vi, beforeEach } from "vitest";
import {
  createAgentIdentity,
  updateAgentIdentity,
  listAgentIdentities,
  deactivateAgentIdentity,
  assignAgentToCircle,
  removeAgentFromCircle,
  updateAgentBehavior,
  getWorkspaceAgentBehavior,
  updateWorkspaceAgentBehavior,
  getOrCreateExternalAgentIdentity,
} from "./agent-identity";
import { prisma } from "@corgtex/shared";

vi.mock("@corgtex/shared", () => ({
  env: { DEPLOYMENT_WORKSPACE_SCOPE_SLUG: undefined },
  prisma: {
    agentIdentity: {
      create: vi.fn(),
      update: vi.fn(),
      findMany: vi.fn(),
      findFirst: vi.fn(),
      findUnique: vi.fn(),
      upsert: vi.fn(),
    },
    circleAgentAssignment: {
      upsert: vi.fn(),
      create: vi.fn(),
      update: vi.fn(),
      updateMany: vi.fn(),
      findUnique: vi.fn(),
      delete: vi.fn(),
    },
    roleHolderHistory: {
      create: vi.fn(),
      updateMany: vi.fn(),
    },
    circle: {
      findFirst: vi.fn(),
    },
    role: {
      findFirst: vi.fn(),
    },
    member: {
      findUnique: vi.fn(),
    },
    workspaceArchiveRecord: {
      create: vi.fn(),
    },
    auditLog: {
      create: vi.fn(),
    },
    event: {
      createMany: vi.fn(),
    },
    $executeRaw: vi.fn(),
    $queryRaw: vi.fn(),
    $transaction: vi.fn(async (cb) => cb(prisma)),
  },
}));

const adminActor: any = {
  kind: "user",
  user: { id: "u1", email: "admin@test.com", displayName: "Admin" },
};

const wsId = "ws-1";

function mockMembership() {
  vi.mocked(prisma.member.findUnique).mockResolvedValue({
    id: "m1",
    workspaceId: wsId,
    userId: "u1",
    role: "ADMIN",
    isActive: true,
    joinedAt: new Date(),
  } as any);
}

describe("agent-identity", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockMembership();
    vi.mocked(prisma.$executeRaw).mockResolvedValue(0 as any);
    vi.mocked(prisma.$queryRaw).mockResolvedValue([{
      id: "ai-1",
      workspaceId: wsId,
      isActive: true,
      archivedAt: null,
      linkedCredentialId: null,
    }] as any);
    vi.mocked(prisma.roleHolderHistory.create).mockResolvedValue({} as any);
    vi.mocked(prisma.roleHolderHistory.updateMany).mockResolvedValue({ count: 1 } as any);
    vi.mocked(prisma.circleAgentAssignment.updateMany).mockResolvedValue({ count: 1 } as any);
  });

  it("creates an agent identity", async () => {
    const mockIdentity = {
      id: "ai-1",
      workspaceId: wsId,
      agentKey: "test-agent",
      displayName: "Test Agent",
      memberType: "INTERNAL",
      isActive: true,
    };
    vi.mocked(prisma.agentIdentity.create).mockResolvedValue(mockIdentity as any);

    const result = await createAgentIdentity(adminActor, {
      workspaceId: wsId,
      agentKey: "test-agent",
      displayName: "Test Agent",
    });

    expect(result).toEqual(mockIdentity);
    expect(prisma.agentIdentity.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          workspaceId: wsId,
          agentKey: "test-agent",
          displayName: "Test Agent",
          createdByUserId: "u1",
        }),
      }),
    );
    expect(prisma.event.createMany).toHaveBeenCalledWith({
      data: [
        expect.objectContaining({
          workspaceId: wsId,
          type: "agent-identity.created",
          aggregateType: "AgentIdentity",
          aggregateId: "ai-1",
          payload: expect.objectContaining({ agentIdentityId: "ai-1" }),
        }),
      ],
    });
  });

  it("lists agent identities", async () => {
    vi.mocked(prisma.agentIdentity.findMany).mockResolvedValue([]);

    const result = await listAgentIdentities(adminActor, wsId);
    expect(result).toEqual([]);
    expect(prisma.agentIdentity.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { workspaceId: wsId, archivedAt: null },
      }),
    );
  });

  it("updates an agent identity", async () => {
    const existing = { id: "ai-1", workspaceId: wsId, agentKey: "test", displayName: "Old Name" };
    vi.mocked(prisma.agentIdentity.findFirst).mockResolvedValue(existing as any);
    vi.mocked(prisma.agentIdentity.update).mockResolvedValue({ ...existing, displayName: "New Name" } as any);

    const result = await updateAgentIdentity(adminActor, {
      workspaceId: wsId,
      agentIdentityId: "ai-1",
      displayName: "New Name",
    });

    expect(result.displayName).toBe("New Name");
    expect(prisma.event.createMany).toHaveBeenCalledWith({
      data: [
        expect.objectContaining({
          type: "agent-identity.updated",
          payload: expect.objectContaining({ agentIdentityId: "ai-1" }),
        }),
      ],
    });
  });

  it("emits a deactivation event when updating an agent identity to inactive", async () => {
    const existing = { id: "ai-1", workspaceId: wsId, agentKey: "test", displayName: "Agent", isActive: true };
    vi.mocked(prisma.agentIdentity.findFirst).mockResolvedValue(existing as any);
    vi.mocked(prisma.agentIdentity.update).mockResolvedValue({ ...existing, isActive: false } as any);

    await updateAgentIdentity(adminActor, {
      workspaceId: wsId,
      agentIdentityId: "ai-1",
      isActive: false,
    });

    expect(prisma.event.createMany).toHaveBeenCalledWith({
      data: [
        expect.objectContaining({
          type: "agent-identity.deactivated",
          payload: expect.objectContaining({ agentIdentityId: "ai-1" }),
        }),
      ],
    });
  });

  it("deactivates an agent identity", async () => {
    vi.mocked(prisma.agentIdentity.findFirst).mockResolvedValue({ id: "ai-1", workspaceId: wsId, isActive: true } as any);
    vi.mocked(prisma.agentIdentity.update).mockResolvedValue({ id: "ai-1", isActive: false } as any);

    const result = await deactivateAgentIdentity(adminActor, wsId, "ai-1");
    expect(result.isActive).toBe(false);
    expect(prisma.roleHolderHistory.updateMany).toHaveBeenCalledWith(expect.objectContaining({
      where: expect.objectContaining({
        workspaceId: wsId,
        agentIdentityId: "ai-1",
        endedAt: null,
      }),
      data: expect.objectContaining({
        endedAt: expect.any(Date),
        endedByUserId: "u1",
      }),
    }));
    expect(prisma.circleAgentAssignment.updateMany).toHaveBeenCalledWith({
      where: {
        agentIdentityId: "ai-1",
        circle: { workspaceId: wsId },
        roleId: { not: null },
      },
      data: { roleId: null },
    });
  });

  it("rejects deactivation of non-existent identity", async () => {
    vi.mocked(prisma.agentIdentity.findFirst).mockResolvedValue(null);

    await expect(deactivateAgentIdentity(adminActor, wsId, "ai-missing")).rejects.toThrow("Agent identity not found.");
  });

  it("assigns an agent to a circle", async () => {
    vi.mocked(prisma.agentIdentity.findUnique).mockResolvedValue({ id: "ai-1", workspaceId: wsId, linkedCredentialId: null } as any);
    vi.mocked(prisma.circle.findFirst).mockResolvedValue({ id: "c-1", workspaceId: wsId } as any);
    vi.mocked(prisma.circleAgentAssignment.findUnique).mockResolvedValue(null);
    vi.mocked(prisma.circleAgentAssignment.upsert).mockResolvedValue({ id: "ca-1", circleId: "c-1", agentIdentityId: "ai-1", roleId: null } as any);

    const result = await assignAgentToCircle(adminActor, {
      workspaceId: wsId,
      agentIdentityId: "ai-1",
      circleId: "c-1",
    });

    expect(result.circleId).toBe("c-1");
    expect(prisma.circleAgentAssignment.upsert).toHaveBeenCalledWith(expect.objectContaining({
      where: {
        circleId_agentIdentityId: {
          circleId: "c-1",
          agentIdentityId: "ai-1",
        },
      },
      update: { roleId: null },
      create: {
        circleId: "c-1",
        agentIdentityId: "ai-1",
        roleId: null,
      },
    }));
    expect(prisma.event.createMany).toHaveBeenCalledWith({
      data: [
        expect.objectContaining({
          type: "agent-identity.circle-assigned",
          payload: expect.objectContaining({ agentIdentityId: "ai-1", circleId: "c-1" }),
        }),
      ],
    });
  });

  it("assigns an agent to a role in the same circle", async () => {
    vi.mocked(prisma.agentIdentity.findUnique).mockResolvedValue({ id: "ai-1", workspaceId: wsId, linkedCredentialId: null } as any);
    vi.mocked(prisma.circle.findFirst).mockResolvedValue({ id: "c-1", workspaceId: wsId } as any);
    vi.mocked(prisma.role.findFirst).mockResolvedValue({ id: "r-1" } as any);
    vi.mocked(prisma.circleAgentAssignment.findUnique).mockResolvedValue(null);
    vi.mocked(prisma.circleAgentAssignment.upsert).mockResolvedValue({
      id: "ca-1",
      circleId: "c-1",
      agentIdentityId: "ai-1",
      roleId: "r-1",
    } as any);

    const result = await assignAgentToCircle(adminActor, {
      workspaceId: wsId,
      agentIdentityId: "ai-1",
      circleId: "c-1",
      roleId: " r-1 ",
    });

    expect(prisma.role.findFirst).toHaveBeenCalledWith({
      where: {
        id: "r-1",
        circleId: "c-1",
        circle: { workspaceId: wsId },
        archivedAt: null,
      },
      select: { id: true },
    });
    expect(prisma.circleAgentAssignment.upsert).toHaveBeenCalledWith(expect.objectContaining({
      update: { roleId: "r-1" },
      create: expect.objectContaining({ roleId: "r-1" }),
    }));
    expect(prisma.roleHolderHistory.create).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({
        roleId: "r-1",
        agentIdentityId: "ai-1",
      }),
    }));
    expect(result.roleId).toBe("r-1");
  });

  it("rejects assigning an agent to a role outside the circle", async () => {
    vi.mocked(prisma.agentIdentity.findUnique).mockResolvedValue({ id: "ai-1", workspaceId: wsId, linkedCredentialId: null } as any);
    vi.mocked(prisma.circle.findFirst).mockResolvedValue({ id: "c-1", workspaceId: wsId } as any);
    vi.mocked(prisma.role.findFirst).mockResolvedValue(null);

    await expect(assignAgentToCircle(adminActor, {
      workspaceId: wsId,
      agentIdentityId: "ai-1",
      circleId: "c-1",
      roleId: "other-circle-role",
    })).rejects.toMatchObject({
      status: 404,
      code: "NOT_FOUND",
    });

    expect(prisma.circleAgentAssignment.create).not.toHaveBeenCalled();
  });

  it("rejects assigning inactive or archived identities", async () => {
    vi.mocked(prisma.agentIdentity.findUnique).mockResolvedValue({ id: "ai-1", linkedCredentialId: "cred-1" } as any);
    vi.mocked(prisma.$queryRaw).mockResolvedValue([{
      id: "ai-1",
      workspaceId: wsId,
      isActive: false,
      archivedAt: new Date("2026-08-26T00:00:00.000Z"),
      linkedCredentialId: "cred-1",
    }] as any);
    vi.mocked(prisma.circle.findFirst).mockResolvedValue({ id: "c-1", workspaceId: wsId } as any);

    await expect(assignAgentToCircle(adminActor, {
      workspaceId: wsId,
      agentIdentityId: "ai-1",
      circleId: "c-1",
    })).rejects.toMatchObject({
      status: 404,
      code: "NOT_FOUND",
    });

    expect(prisma.$executeRaw).toHaveBeenCalledTimes(1);
    expect(prisma.circleAgentAssignment.upsert).not.toHaveBeenCalled();
    expect(prisma.roleHolderHistory.create).not.toHaveBeenCalled();
  });

  it("removes an agent from a circle", async () => {
    vi.mocked(prisma.circleAgentAssignment.findUnique).mockResolvedValue({ id: "ca-1", circleId: "c-1", agentIdentityId: "ai-1", roleId: "r-1" } as any);
    vi.mocked(prisma.circleAgentAssignment.delete).mockResolvedValue({ id: "ca-1" } as any);

    const result = await removeAgentFromCircle(adminActor, {
      workspaceId: wsId,
      agentIdentityId: "ai-1",
      circleId: "c-1",
    });

    expect(result.id).toBe("ca-1");
    expect(prisma.$executeRaw).toHaveBeenCalled();
    expect(prisma.roleHolderHistory.updateMany).toHaveBeenCalledWith(expect.objectContaining({
      where: expect.objectContaining({
        roleId: "r-1",
        agentIdentityId: "ai-1",
        endedAt: null,
      }),
    }));
    expect(prisma.event.createMany).toHaveBeenCalledWith({
      data: [
        expect.objectContaining({
          type: "agent-identity.circle-unassigned",
          payload: expect.objectContaining({ agentIdentityId: "ai-1", circleId: "c-1" }),
        }),
      ],
    });
  });

  it("updates agent behavior markdown", async () => {
    vi.mocked(prisma.agentIdentity.findFirst).mockResolvedValue({ id: "ai-1", workspaceId: wsId } as any);
    vi.mocked(prisma.agentIdentity.update).mockResolvedValue({ id: "ai-1", behaviorMd: "Be helpful." } as any);

    const result = await updateAgentBehavior(adminActor, {
      workspaceId: wsId,
      agentIdentityId: "ai-1",
      behaviorMd: "Be helpful.",
    });

    expect(result.behaviorMd).toBe("Be helpful.");
  });

  it("returns null for missing workspace behavior", async () => {
    vi.mocked(prisma.agentIdentity.findUnique).mockResolvedValue(null);

    const result = await getWorkspaceAgentBehavior(adminActor, wsId);
    expect(result).toBeNull();
  });

  it("upserts workspace agent behavior", async () => {
    vi.mocked(prisma.agentIdentity.upsert).mockResolvedValue({ id: "ai-ws", behaviorMd: "Global rules." } as any);

    const result = await updateWorkspaceAgentBehavior(adminActor, {
      workspaceId: wsId,
      behaviorMd: "Global rules.",
    });

    expect(result.behaviorMd).toBe("Global rules.");
  });

  describe("getOrCreateExternalAgentIdentity", () => {
    it("returns existing identity if it exists", async () => {
      const existing = { id: "ext-1", linkedCredentialId: "cred-1" };
      vi.mocked(prisma.agentIdentity.findFirst).mockResolvedValue(existing as any);

      const result = await getOrCreateExternalAgentIdentity("ws-1", "cred-1", "Label", null);

      expect(prisma.agentIdentity.findFirst).toHaveBeenCalledWith({
        where: { workspaceId: "ws-1", linkedCredentialId: "cred-1" },
      });
      expect(result).toEqual(existing);
      expect(prisma.agentIdentity.create).not.toHaveBeenCalled();
    });

    it("creates new external identity if it does not exist", async () => {
      vi.mocked(prisma.agentIdentity.findFirst).mockResolvedValue(null);
      const created = { id: "ext-1", linkedCredentialId: "cred-123", agentKey: "ext_cred-123" };
      vi.mocked(prisma.agentIdentity.create).mockResolvedValue(created as any);

      const result = await getOrCreateExternalAgentIdentity("ws-1", "cred-12345678", "My Agent", "user-1");

      expect(prisma.agentIdentity.create).toHaveBeenCalledWith({
        data: {
          workspaceId: "ws-1",
          agentKey: "ext_cred-123",
          memberType: "EXTERNAL",
          displayName: "My Agent",
          linkedCredentialId: "cred-12345678",
          createdByUserId: "user-1",
        },
      });
      expect(result).toEqual(created);
    });
  });
});
