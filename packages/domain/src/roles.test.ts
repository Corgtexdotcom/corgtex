import { beforeEach, describe, expect, it, vi } from "vitest";
import type { AppActor } from "@corgtex/shared";

const { prismaMock } = vi.hoisted(() => {
  const prisma = {
    $transaction: vi.fn(),
    role: {
      findMany: vi.fn(),
      findFirst: vi.fn(),
      findUnique: vi.fn(),
      count: vi.fn(),
      create: vi.fn(),
      update: vi.fn(),
    },
    roleVersion: {
      aggregate: vi.fn(),
      create: vi.fn(),
    },
    $executeRaw: vi.fn(),
    workspaceArchiveRecord: {
      create: vi.fn(),
    },
    circle: {
      findUnique: vi.fn(),
    },
    member: {
      findUnique: vi.fn(),
    },
    roleAssignment: {
      create: vi.fn(),
      findUnique: vi.fn(),
      delete: vi.fn(),
      findMany: vi.fn(),
    },
    roleHolderHistory: {
      create: vi.fn(),
      updateMany: vi.fn(),
    },
    conversationSession: {
      create: vi.fn(),
    },
    roleOnboardingSession: {
      findFirst: vi.fn(),
      create: vi.fn(),
      updateMany: vi.fn(),
    },
    notification: {
      create: vi.fn(),
    },
    auditLog: {
      create: vi.fn(),
    },
    event: {
      createMany: vi.fn(),
    },
  };
  return { prismaMock: prisma };
});

vi.mock("@corgtex/shared", () => ({
  prisma: prismaMock,
  parseAllowedWorkspaceIds: vi.fn(() => new Set<string>()),
  env: {
    SESSION_LAST_SEEN_WRITE_INTERVAL_MS: 5 * 60 * 1000,
  },
}));

const actor: AppActor = {
  kind: "user" as const,
  user: {
    id: "operator-1",
    email: "operator@example.com",
    displayName: "Operator",
    globalRole: "OPERATOR",
  },
};

describe("roles domain", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    prismaMock.$transaction.mockImplementation(async (callback: (tx: typeof prismaMock) => Promise<unknown>) => callback(prismaMock));
    prismaMock.auditLog.create.mockResolvedValue({});
    prismaMock.event.createMany.mockResolvedValue({ count: 1 });
    prismaMock.$executeRaw.mockResolvedValue(0);
    prismaMock.roleVersion.aggregate.mockResolvedValue({ _max: { version: null } });
    prismaMock.roleVersion.create.mockResolvedValue({});
    prismaMock.roleHolderHistory.create.mockResolvedValue({});
    prismaMock.roleHolderHistory.updateMany.mockResolvedValue({ count: 1 });
    prismaMock.conversationSession.create.mockResolvedValue({ id: "conversation-1" });
    prismaMock.roleOnboardingSession.findFirst.mockResolvedValue(null);
    prismaMock.roleOnboardingSession.create.mockResolvedValue({
      id: "onboarding-1",
      conversationId: "conversation-1",
      conversation: { id: "conversation-1" },
    });
    prismaMock.roleOnboardingSession.updateMany.mockResolvedValue({ count: 1 });
    prismaMock.notification.create.mockResolvedValue({});
  });

  it("listRoles scopes roles by workspace through circles", async () => {
    prismaMock.role.findMany.mockResolvedValue([{ id: "role-1" }]);

    const { listRoles } = await import("./roles");
    await expect(listRoles("workspace-1")).resolves.toEqual([{ id: "role-1" }]);
    expect(prismaMock.role.findMany).toHaveBeenCalledWith(expect.objectContaining({
      where: {
        archivedAt: null,
        circle: {
          workspaceId: "workspace-1",
          archivedAt: null,
        },
      },
    }));
  });

  it("getRole returns a workspace-scoped role with assigned member profiles", async () => {
    prismaMock.role.findFirst.mockResolvedValue({
      id: "role-1",
      name: "Lead",
      circle: { id: "circle-1", name: "Circle" },
      assignments: [
        {
          id: "assignment-1",
          member: {
            id: "member-1",
            user: {
              id: "user-1",
              email: "member@example.com",
              displayName: "Member",
              avatarUrl: "https://example.com/avatar.png",
              bio: "Leads delivery.",
            },
          },
        },
      ],
    });

    const { getRole } = await import("./roles");
    await expect(getRole(actor, {
      workspaceId: "workspace-1",
      roleId: "role-1",
    })).resolves.toMatchObject({
      id: "role-1",
      assignments: [
        {
          member: {
            user: {
              avatarUrl: "https://example.com/avatar.png",
              bio: "Leads delivery.",
            },
          },
        },
      ],
    });
    expect(prismaMock.role.findFirst).toHaveBeenCalledWith(expect.objectContaining({
      where: {
        id: "role-1",
        archivedAt: null,
        circle: {
          workspaceId: "workspace-1",
          archivedAt: null,
        },
      },
      include: expect.objectContaining({
        assignments: expect.objectContaining({
          include: {
            member: {
              include: {
                user: {
                  select: {
                    id: true,
                    email: true,
                    displayName: true,
                    avatarUrl: true,
                    bio: true,
                  },
                },
              },
            },
          },
        }),
      }),
    }));
  });

  it("createRole creates a role with trimmed fields", async () => {
    prismaMock.circle.findUnique.mockResolvedValue({ id: "circle-1", workspaceId: "workspace-1", archivedAt: null });
    prismaMock.role.count.mockResolvedValue(2);
    prismaMock.role.create.mockResolvedValue({
      id: "role-1",
      circleId: "circle-1",
      name: "Lead",
      purposeMd: "Purpose",
      accountabilities: ["A"],
      artifacts: ["Artifact"],
      metricsMd: null,
      coreRoleType: "Core",
      circle: { id: "circle-1", name: "Circle" },
    });

    const { createRole } = await import("./roles");
    await expect(createRole(actor, {
      workspaceId: "workspace-1",
      circleId: "circle-1",
      name: " Lead ",
      purposeMd: " Purpose ",
      accountabilities: [" A ", " "],
      artifacts: [" Artifact "],
      coreRoleType: " Core ",
    })).resolves.toMatchObject({ id: "role-1", name: "Lead" });

    expect(prismaMock.role.create).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({
        name: "Lead",
        purposeMd: "Purpose",
        accountabilities: ["A"],
        artifacts: ["Artifact"],
        coreRoleType: "Core",
        sortOrder: 2,
      }),
    }));
    expect(prismaMock.roleVersion.create).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({
        roleId: "role-1",
        version: 1,
        changeType: "created",
      }),
    }));
    expect(prismaMock.$executeRaw).toHaveBeenCalled();
  });

  it("createRole rejects a blank name", async () => {
    const { createRole } = await import("./roles");
    await expect(createRole(actor, {
      workspaceId: "workspace-1",
      circleId: "circle-1",
      name: " ",
    })).rejects.toMatchObject({
      status: 400,
      code: "INVALID_INPUT",
    });
  });

  it("createRole rejects a circle outside the workspace", async () => {
    prismaMock.circle.findUnique.mockResolvedValue(null);

    const { createRole } = await import("./roles");
    await expect(createRole(actor, {
      workspaceId: "workspace-1",
      circleId: "missing-circle",
      name: "Lead",
    })).rejects.toMatchObject({
      status: 404,
      code: "NOT_FOUND",
    });
  });

  it("updateRole updates provided fields", async () => {
    prismaMock.role.findUnique.mockResolvedValue({ id: "role-1", archivedAt: null, circle: { workspaceId: "workspace-1" } });
    prismaMock.role.update.mockResolvedValue({
      id: "role-1",
      circleId: "circle-1",
      name: "Updated",
      purposeMd: null,
      accountabilities: [],
      artifacts: [],
      metricsMd: null,
      coreRoleType: null,
      circle: { id: "circle-1", name: "Circle" },
    });

    const { updateRole } = await import("./roles");
    await expect(updateRole(actor, {
      workspaceId: "workspace-1",
      roleId: "role-1",
      name: " Updated ",
    })).resolves.toMatchObject({ id: "role-1", name: "Updated" });
    expect(prismaMock.role.update).toHaveBeenCalledWith(expect.objectContaining({
      data: { name: "Updated" },
    }));
    expect(prismaMock.roleVersion.create).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({
        roleId: "role-1",
        changeType: "updated",
      }),
    }));
  });

  it("deleteRole archives an existing role", async () => {
    prismaMock.role.findFirst.mockResolvedValue({ id: "role-1", name: "Lead", archivedAt: null, circle: { workspaceId: "workspace-1" } });
    prismaMock.role.update.mockResolvedValue({ id: "role-1", archivedAt: new Date("2026-04-25T12:00:00.000Z") });
    prismaMock.workspaceArchiveRecord.create.mockResolvedValue({});

    const { deleteRole } = await import("./roles");
    await expect(deleteRole(actor, {
      workspaceId: "workspace-1",
      roleId: "role-1",
    })).resolves.toEqual({ id: "role-1" });
    expect(prismaMock.role.update).toHaveBeenCalledWith(expect.objectContaining({
      where: { id: "role-1" },
      data: expect.objectContaining({ archivedAt: expect.any(Date) }),
    }));
  });

  it("deleteRole rejects a missing role", async () => {
    prismaMock.role.findFirst.mockResolvedValue(null);

    const { deleteRole } = await import("./roles");
    await expect(deleteRole(actor, {
      workspaceId: "workspace-1",
      roleId: "missing-role",
    })).rejects.toMatchObject({
      status: 404,
      code: "NOT_FOUND",
    });
  });

  it("assignRole creates an assignment, holder history, onboarding, and a targeted notification", async () => {
    prismaMock.role.findUnique.mockResolvedValue({
      id: "role-1",
      circleId: "circle-1",
      name: "Lead",
      purposeMd: "Lead the work.",
      accountabilities: ["Coordinate"],
      artifacts: [],
      metricsMd: null,
      coreRoleType: null,
      archivedAt: null,
      circle: {
        id: "circle-1",
        workspaceId: "workspace-1",
        name: "Circle",
        purposeMd: null,
        domainMd: null,
      },
    });
    prismaMock.member.findUnique.mockResolvedValue({
      id: "member-1",
      userId: "user-1",
      workspaceId: "workspace-1",
      isActive: true,
      user: { displayName: "Member", email: "member@example.com" },
    });
    prismaMock.roleAssignment.findUnique.mockResolvedValue(null);
    prismaMock.roleAssignment.create.mockResolvedValue({ id: "assignment-1" });

    const { assignRole } = await import("./roles");
    await expect(assignRole(actor, {
      workspaceId: "workspace-1",
      roleId: "role-1",
      memberId: "member-1",
    })).resolves.toEqual({ id: "assignment-1" });
    expect(prismaMock.roleHolderHistory.create).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({
        roleId: "role-1",
        memberId: "member-1",
      }),
    }));
    expect(prismaMock.conversationSession.create).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({
        userId: "user-1",
        agentKey: "role-onboarding",
        topic: "Onboarding: Lead",
      }),
    }));
    expect(prismaMock.notification.create).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({
        userId: "user-1",
        entityType: "ConversationSession",
        entityId: "conversation-1",
      }),
    }));
  });

  it("assignRole emits the onboarding intro event when an existing assignment gets a new onboarding session", async () => {
    prismaMock.role.findUnique.mockResolvedValue({
      id: "role-1",
      circleId: "circle-1",
      name: "Lead",
      purposeMd: "Lead the work.",
      accountabilities: ["Coordinate"],
      artifacts: [],
      metricsMd: null,
      coreRoleType: null,
      archivedAt: null,
      circle: {
        id: "circle-1",
        workspaceId: "workspace-1",
        name: "Circle",
        purposeMd: null,
        domainMd: null,
      },
    });
    prismaMock.member.findUnique.mockResolvedValue({
      id: "member-1",
      userId: "user-1",
      workspaceId: "workspace-1",
      isActive: true,
      user: { displayName: "Member", email: "member@example.com" },
    });
    prismaMock.roleAssignment.findUnique.mockResolvedValue({ id: "assignment-1" });

    const { assignRole } = await import("./roles");
    await expect(assignRole(actor, {
      workspaceId: "workspace-1",
      roleId: "role-1",
      memberId: "member-1",
    })).resolves.toEqual({ id: "assignment-1" });

    expect(prismaMock.roleHolderHistory.create).not.toHaveBeenCalled();
    expect(prismaMock.event.createMany).toHaveBeenCalledWith(expect.objectContaining({
      data: [expect.objectContaining({
        type: "role.assigned",
        payload: expect.objectContaining({
          onboardingSessionId: "onboarding-1",
          conversationId: "conversation-1",
        }),
      })],
    }));
  });

  it("assignRole rejects a missing member", async () => {
    prismaMock.role.findUnique.mockResolvedValue({ id: "role-1", archivedAt: null, circle: { workspaceId: "workspace-1" } });
    prismaMock.member.findUnique.mockResolvedValue(null);

    const { assignRole } = await import("./roles");
    await expect(assignRole(actor, {
      workspaceId: "workspace-1",
      roleId: "role-1",
      memberId: "missing-member",
    })).rejects.toMatchObject({
      status: 404,
      code: "NOT_FOUND",
    });
  });

  it("unassignRole deletes an existing assignment", async () => {
    prismaMock.role.findUnique.mockResolvedValue({ id: "role-1", archivedAt: null, circle: { workspaceId: "workspace-1" } });
    prismaMock.roleAssignment.findUnique.mockResolvedValue({ id: "assignment-1" });
    prismaMock.roleAssignment.delete.mockResolvedValue({ id: "assignment-1" });

    const { unassignRole } = await import("./roles");
    await expect(unassignRole(actor, {
      workspaceId: "workspace-1",
      roleId: "role-1",
      memberId: "member-1",
    })).resolves.toEqual({ id: "assignment-1" });
    expect(prismaMock.roleHolderHistory.updateMany).toHaveBeenCalledWith(expect.objectContaining({
      where: expect.objectContaining({
        roleId: "role-1",
        memberId: "member-1",
        endedAt: null,
      }),
    }));
    expect(prismaMock.roleOnboardingSession.updateMany).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({
        status: "DISMISSED",
      }),
    }));
  });

  it("listRoleAssignments returns assignments for workspace roles", async () => {
    prismaMock.roleAssignment.findMany.mockResolvedValue([{ id: "assignment-1" }]);

    const { listRoleAssignments } = await import("./roles");
    await expect(listRoleAssignments("workspace-1")).resolves.toEqual([{ id: "assignment-1" }]);
    expect(prismaMock.roleAssignment.findMany).toHaveBeenCalledWith(expect.objectContaining({
      where: {
        role: {
          archivedAt: null,
          circle: {
            workspaceId: "workspace-1",
            archivedAt: null,
          },
        },
      },
    }));
  });
});
