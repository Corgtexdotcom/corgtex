import { beforeEach, describe, expect, it, vi } from "vitest";
import type { AppActor } from "@corgtex/shared";
import { captureArtifactInputProof, readableArtifactIds } from "./source-lineage";
import { AppError } from "./errors";

vi.mock("./source-lineage", () => ({
  captureArtifactInputProof: vi.fn().mockResolvedValue([]),
  readableArtifactIds: vi.fn().mockResolvedValue(new Set()),
  captureArtifactReadHeadObservation: async (read: () => Promise<unknown>) => ({ value: await read(), heads: new Map() }),
  withArtifactCountReleaseSnapshot: async (_actor: unknown, _workspaceId: string, _roots: unknown,
    before: () => Promise<void>, release: (tx: typeof prismaMock) => Promise<unknown>) => { await before(); return release(prismaMock); },
}));

vi.mock("./producer-lineage", () => ({
  prepareProducerLineage: vi.fn().mockResolvedValue({ mode: "HUMAN_ORIGINAL", inputs: [], roots: [] }),
  finishProducerLineage: vi.fn().mockResolvedValue(undefined),
}));

const { prismaMock } = vi.hoisted(() => {
  const prisma = {
    $queryRaw: vi.fn().mockResolvedValue([]),
    workspaceSupportGrant: { findUnique: vi.fn().mockResolvedValue(null) },
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
      findMany: vi.fn(),
    },
    roleAssignment: {
      create: vi.fn(),
      findUnique: vi.fn(),
      upsert: vi.fn(),
      delete: vi.fn(),
      deleteMany: vi.fn(),
      findMany: vi.fn(),
    },
    circleAgentAssignment: {
      updateMany: vi.fn(),
    },
    roleHolderHistory: {
      findMany: vi.fn().mockResolvedValue([]),
      create: vi.fn(),
      updateMany: vi.fn(),
    },
    conversationSession: {
      create: vi.fn(),
    },
    roleOnboardingSession: {
      findMany: vi.fn().mockResolvedValue([]),
      findFirst: vi.fn(),
      create: vi.fn(),
      updateMany: vi.fn(),
    },
    notification: {
      create: vi.fn(),
      findUnique: vi.fn(),
      createMany: vi.fn(),
    },
    notificationPreference: {
      findMany: vi.fn(),
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

vi.mock("./auth", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./auth")>();
  return { ...actual, requireWorkspaceMembership: (params: Parameters<typeof actual.requireWorkspaceMembership>[0]) => {
    // Operator fixtures also have an explicit ADMIN membership.
    if (params.actor.kind === "user" && params.actor.user.globalRole === "OPERATOR") {
      return actual.requireWorkspaceMembership({ ...params, resolvedMembership: {
        id: "fixture-admin", workspaceId: params.workspaceId, userId: params.actor.user.id, role: "ADMIN", isActive: true,
      } });
    }
    return actual.requireWorkspaceMembership(params);
  } };
});

vi.mock("@corgtex/shared", () => ({
  setSupportAuthorizationActor: vi.fn(),
  getMcpOrigin: () => undefined,
  prisma: prismaMock,
  sendEmail: vi.fn(),
  parseAllowedWorkspaceIds: vi.fn(() => new Set<string>()),
  env: {
    APP_URL: "https://app.example.test",
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

// Keep the fixture's per-kind denials while exercising the real release
// orchestration. PostgreSQL regressions exercise the actual proof backend.
async function captureFixtureProof(...[actor, workspaceId, inputs]: Parameters<typeof captureArtifactInputProof>) {
  for (const input of inputs) {
    if (input.kind === "User") continue;
    const visible = await readableArtifactIds(actor, workspaceId, input.kind,
      [input.snapshot as { id: string }]);
    if (!visible.has(input.id)) throw new AppError(409, "SOURCE_RESTRICTED", "Fixture source denied.");
  }
  return [];
}

describe("roles domain", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(readableArtifactIds).mockImplementation(async (_actor, _workspaceId, _kind, rows) => new Set(rows.map((row) => row.id)));
    vi.mocked(captureArtifactInputProof).mockImplementation(captureFixtureProof);
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
    prismaMock.notification.create.mockImplementation(async ({ data }) => ({ id: "notification-1", ...data }));
    prismaMock.notificationPreference.findMany.mockResolvedValue([]);
    prismaMock.member.findMany.mockResolvedValue([{ userId: "user-1" }]);
    prismaMock.roleAssignment.upsert.mockResolvedValue({ id: "assignment-1" });
    prismaMock.roleAssignment.deleteMany.mockResolvedValue({ count: 1 });
    prismaMock.circleAgentAssignment.updateMany.mockResolvedValue({ count: 1 });
  });

  it("listRoles scopes roles by workspace through circles", async () => {
    prismaMock.role.findMany.mockResolvedValue([{ id: "role-1", circleId: "circle-1", circle: { id: "circle-1", name: "Product" } }]);

    const { listRoles } = await import("./roles");
    await expect(listRoles(actor, "workspace-1")).resolves.toMatchObject([{ id: "role-1", circleId: "circle-1", circle: { id: "circle-1", name: "Product" } }]);
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
      circleId: "circle-1",
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

  it.each(["ADMIN", "FACILITATOR"] as const)("updateRole persists a changed description for a %s", async (role) => {
    const editor: AppActor = {
      kind: "user",
      user: { id: "editor-1", email: "editor@example.com", displayName: "Editor", globalRole: "USER" },
    };
    prismaMock.member.findUnique.mockResolvedValue({
      id: "membership-1", workspaceId: "workspace-1", userId: "editor-1", role, isActive: true,
    });
    prismaMock.role.findUnique.mockResolvedValue({
      id: "role-1", circleId: "circle-1", purposeMd: "Old description", archivedAt: null,
      circle: { workspaceId: "workspace-1" },
    });
    prismaMock.role.update.mockResolvedValue({
      id: "role-1", circleId: "circle-1", name: "Lead", purposeMd: "New description",
      accountabilities: [], artifacts: [], metricsMd: null, coreRoleType: null,
      circle: { id: "circle-1", name: "Circle" },
    });

    const { updateRole } = await import("./roles");
    await expect(updateRole(editor, {
      workspaceId: "workspace-1", roleId: "role-1", purposeMd: "  New description  ",
    })).resolves.toMatchObject({ purposeMd: "New description" });
    expect(prismaMock.role.update).toHaveBeenCalledWith(expect.objectContaining({
      data: { purposeMd: "New description" },
    }));
    expect(prismaMock.roleVersion.create).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({ roleId: "role-1", purposeMd: "New description", changeType: "updated" }),
    }));
  });

  it("updateRole rejects a regular member's description change before writing", async () => {
    const member: AppActor = {
      kind: "user",
      user: { id: "member-1", email: "member@example.com", displayName: "Member", globalRole: "USER" },
    };
    prismaMock.member.findUnique.mockResolvedValue({
      id: "membership-1", workspaceId: "workspace-1", userId: "member-1", role: "CONTRIBUTOR", isActive: true,
    });

    const { updateRole } = await import("./roles");
    await expect(updateRole(member, {
      workspaceId: "workspace-1", roleId: "role-1", purposeMd: "Unapproved change",
    })).rejects.toMatchObject({ status: 403, code: "FORBIDDEN" });
    expect(prismaMock.role.findUnique).not.toHaveBeenCalled();
    expect(prismaMock.role.update).not.toHaveBeenCalled();
  });

  it("updateRole moves a role to another workspace circle", async () => {
    prismaMock.role.findUnique.mockResolvedValue({
      id: "role-1",
      circleId: "circle-1",
      name: "Lead",
      purposeMd: null,
      accountabilities: [],
      artifacts: [],
      coreRoleType: null,
      archivedAt: null,
      circle: { workspaceId: "workspace-1" },
    });
    prismaMock.circle.findUnique.mockResolvedValue({
      id: "circle-2",
      workspaceId: "workspace-1",
      archivedAt: null,
    });
    prismaMock.role.count.mockResolvedValue(4);
    prismaMock.role.update.mockResolvedValue({
      id: "role-1",
      circleId: "circle-2",
      name: "Lead",
      purposeMd: null,
      accountabilities: [],
      artifacts: [],
      metricsMd: null,
      coreRoleType: null,
      circle: { id: "circle-2", name: "Target circle" },
    });

    const { updateRole } = await import("./roles");
    await expect(updateRole(actor, {
      workspaceId: "workspace-1",
      roleId: "role-1",
      circleId: " circle-2 ",
    })).resolves.toMatchObject({ id: "role-1", circleId: "circle-2" });

    expect(prismaMock.circle.findUnique).toHaveBeenCalledWith({
      where: { id: "circle-2" },
      select: {
        id: true,
        workspaceId: true,
        archivedAt: true,
      },
    });
    expect(prismaMock.role.count).toHaveBeenCalledWith({ where: { circleId: "circle-2" } });
    expect(prismaMock.role.update).toHaveBeenCalledWith(expect.objectContaining({
      data: {
        circleId: "circle-2",
        sortOrder: 4,
      },
    }));
    expect(prismaMock.roleHolderHistory.updateMany).toHaveBeenCalledWith({
      where: {
        workspaceId: "workspace-1",
        roleId: "role-1",
        holderKind: "AGENT",
        endedAt: null,
      },
      data: {
        endedAt: expect.any(Date),
        endedByUserId: "operator-1",
      },
    });
    expect(prismaMock.circleAgentAssignment.updateMany).toHaveBeenCalledWith({
      where: { roleId: "role-1" },
      data: { roleId: null },
    });
    expect(prismaMock.roleVersion.create).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({
        roleId: "role-1",
        changeType: "updated",
      }),
    }));
  });

  it("updateRole rejects moving a role to a circle outside the workspace", async () => {
    prismaMock.role.findUnique.mockResolvedValue({
      id: "role-1",
      circleId: "circle-1",
      name: "Lead",
      purposeMd: null,
      accountabilities: [],
      artifacts: [],
      coreRoleType: null,
      archivedAt: null,
      circle: { workspaceId: "workspace-1" },
    });
    prismaMock.circle.findUnique.mockResolvedValue({
      id: "circle-2",
      workspaceId: "workspace-2",
      archivedAt: null,
    });

    const { updateRole } = await import("./roles");
    await expect(updateRole(actor, {
      workspaceId: "workspace-1",
      roleId: "role-1",
      circleId: "circle-2",
    })).rejects.toMatchObject({
      status: 404,
      code: "NOT_FOUND",
    });
    expect(prismaMock.role.update).not.toHaveBeenCalled();
  });

  it("updateRole skips audit, events, and version snapshots when normalized fields are unchanged", async () => {
    const existingRole = {
      id: "role-1",
      circleId: "circle-1",
      name: "Lead",
      purposeMd: "Own the operating cadence.",
      accountabilities: ["Run tactical meetings"],
      artifacts: ["Operating dashboard"],
      metricsMd: null,
      coreRoleType: "LEAD_LINK",
      archivedAt: null,
      circle: { workspaceId: "workspace-1" },
    };
    prismaMock.role.findUnique
      .mockResolvedValueOnce(existingRole)
      .mockResolvedValueOnce({
        ...existingRole,
        circle: { id: "circle-1", name: "Circle" },
      });

    const { updateRole } = await import("./roles");
    await expect(updateRole(actor, {
      workspaceId: "workspace-1",
      roleId: "role-1",
      name: " Lead ",
      purposeMd: " Own the operating cadence. ",
      accountabilities: [" Run tactical meetings ", ""],
      artifacts: [" Operating dashboard "],
      coreRoleType: " LEAD_LINK ",
    })).resolves.toMatchObject({ id: "role-1", name: "Lead" });

    expect(prismaMock.role.update).not.toHaveBeenCalled();
    expect(prismaMock.auditLog.create).not.toHaveBeenCalled();
    expect(prismaMock.roleVersion.create).not.toHaveBeenCalled();
    expect(prismaMock.event.createMany).not.toHaveBeenCalled();
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
    expect(prismaMock.roleHolderHistory.updateMany).toHaveBeenCalledWith(expect.objectContaining({
      where: expect.objectContaining({
        workspaceId: "workspace-1",
        roleId: { in: ["role-1"] },
        endedAt: null,
      }),
      data: expect.objectContaining({
        endedAt: expect.any(Date),
        endedByUserId: "operator-1",
      }),
    }));
    expect(prismaMock.roleOnboardingSession.updateMany).toHaveBeenCalledWith(expect.objectContaining({
      where: expect.objectContaining({
        workspaceId: "workspace-1",
        roleId: { in: ["role-1"] },
        status: { in: ["PENDING", "ACTIVE"] },
      }),
      data: expect.objectContaining({
        status: "DISMISSED",
        dismissedAt: expect.any(Date),
      }),
    }));
    expect(prismaMock.roleAssignment.deleteMany).toHaveBeenCalledWith({
      where: { roleId: { in: ["role-1"] } },
    });
    expect(prismaMock.circleAgentAssignment.updateMany).toHaveBeenCalledWith({
      where: { roleId: { in: ["role-1"] } },
      data: { roleId: null },
    });
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
    expect(prismaMock.notification.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        userId: "user-1", entityType: "ConversationSession", entityId: "conversation-1",
        type: "role-onboarding.assigned",
      }),
    });
    expect(prismaMock.roleAssignment.upsert).toHaveBeenCalledWith(expect.objectContaining({
      where: {
        roleId_memberId: {
          roleId: "role-1",
          memberId: "member-1",
        },
      },
      update: {
        expiresAt: null,
        transferReason: null,
      },
      create: {
        roleId: "role-1",
        memberId: "member-1",
        expiresAt: null,
        transferReason: null,
      },
    }));
  });

  it("assignRole writes temporary transfer metadata to assignments, audit, and events", async () => {
    const expiresAt = new Date("2099-01-31T23:59:59.999Z");
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

    const { assignRole } = await import("./roles");
    await expect(assignRole(actor, {
      workspaceId: "workspace-1",
      roleId: "role-1",
      memberId: "member-1",
      expiresAt,
      transferReason: "  Leave coverage  ",
    })).resolves.toEqual({ id: "assignment-1" });

    expect(prismaMock.roleAssignment.upsert).toHaveBeenCalledWith(expect.objectContaining({
      update: {
        expiresAt,
        transferReason: "Leave coverage",
      },
      create: {
        roleId: "role-1",
        memberId: "member-1",
        expiresAt,
        transferReason: "Leave coverage",
      },
    }));
    expect(prismaMock.auditLog.create).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({
        action: "role.assigned",
        meta: expect.objectContaining({
          expiresAt: expiresAt.toISOString(),
          transferReason: "Leave coverage",
        }),
      }),
    }));
    expect(prismaMock.event.createMany).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.arrayContaining([
        expect.objectContaining({
          type: "role.assigned",
          payload: expect.objectContaining({
            expiresAt: expiresAt.toISOString(),
            transferReason: "Leave coverage",
          }),
        }),
      ]),
    }));
  });

  it("assignRole rejects past temporary expiry before writing an assignment", async () => {
    prismaMock.role.findUnique.mockResolvedValue({
      id: "role-1",
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

    const { assignRole } = await import("./roles");
    await expect(assignRole(actor, {
      workspaceId: "workspace-1",
      roleId: "role-1",
      memberId: "member-1",
      expiresAt: new Date("2000-01-01T00:00:00.000Z"),
    })).rejects.toMatchObject({
      status: 400,
      code: "INVALID_INPUT",
    });
    expect(prismaMock.roleAssignment.upsert).not.toHaveBeenCalled();
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
    expect(prismaMock.$executeRaw).toHaveBeenCalled();
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

  it("reassignRole moves a holder through the shared assignment lifecycle in one transaction", async () => {
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
      id: "member-2",
      userId: "user-2",
      workspaceId: "workspace-1",
      isActive: true,
      user: { displayName: "Next holder", email: "next@example.com" },
    });
    prismaMock.roleAssignment.findUnique
      .mockResolvedValueOnce({ id: "source-assignment" })
      .mockResolvedValueOnce(null);
    prismaMock.roleAssignment.upsert.mockResolvedValue({ id: "target-assignment" });
    prismaMock.roleAssignment.delete.mockResolvedValue({ id: "source-assignment" });

    const { reassignRole } = await import("./roles");
    await expect(reassignRole(actor, {
      workspaceId: "workspace-1",
      roleId: "role-1",
      fromMemberId: "member-1",
      toMemberId: "member-2",
    })).resolves.toEqual({
      roleId: "role-1",
      fromMemberId: "member-1",
      toMemberId: "member-2",
      assignedAssignmentId: "target-assignment",
      removedAssignmentId: "source-assignment",
    });

    expect(prismaMock.$transaction).toHaveBeenCalledTimes(1);
    expect(prismaMock.$executeRaw.mock.calls.length).toBeGreaterThanOrEqual(2);
    expect(prismaMock.roleAssignment.upsert).toHaveBeenCalledWith(expect.objectContaining({
      where: {
        roleId_memberId: {
          roleId: "role-1",
          memberId: "member-2",
        },
      },
      create: {
        roleId: "role-1",
        memberId: "member-2",
        expiresAt: null,
        transferReason: null,
      },
    }));
    expect(prismaMock.roleHolderHistory.create).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({
        roleId: "role-1",
        memberId: "member-2",
        assignmentId: "target-assignment",
      }),
    }));
    expect(prismaMock.roleAssignment.delete).toHaveBeenCalledWith({
      where: { id: "source-assignment" },
    });
    expect(prismaMock.roleHolderHistory.updateMany).toHaveBeenCalledWith(expect.objectContaining({
      where: expect.objectContaining({
        roleId: "role-1",
        memberId: "member-1",
        endedAt: null,
      }),
    }));
    expect(prismaMock.roleOnboardingSession.updateMany).toHaveBeenCalledWith(expect.objectContaining({
      where: expect.objectContaining({
        roleId: "role-1",
        memberId: "member-1",
      }),
      data: expect.objectContaining({
        status: "DISMISSED",
      }),
    }));
  });

  it("reassignRole rejects same-member reassignment before mutating", async () => {
    const { reassignRole } = await import("./roles");
    await expect(reassignRole(actor, {
      workspaceId: "workspace-1",
      roleId: "role-1",
      fromMemberId: "member-1",
      toMemberId: "member-1",
    })).rejects.toMatchObject({
      status: 400,
      code: "INVALID_INPUT",
    });
    expect(prismaMock.$transaction).not.toHaveBeenCalled();
  });

  it("listRoleAssignments returns assignments for workspace roles", async () => {
    prismaMock.roleAssignment.findMany.mockResolvedValue([{ id: "assignment-1", roleId: "role-1", role: { id: "role-1", name: "Lead", circleId: "circle-1", circle: { id: "circle-1", name: "Circle" } }, member: { id: "member-1", user: { id: "user-1", email: "member@example.test", displayName: "Member", bio: null } } }]);

    const { listRoleAssignments } = await import("./roles");
    await expect(listRoleAssignments(actor, "workspace-1")).resolves.toMatchObject([{ id: "assignment-1", role: { id: "role-1", circle: { id: "circle-1" } } }]);
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

  function readerRole(id: string, circleId = "circle-public", sortOrder = 0) {
    return {
      id, circleId, name: id, purposeMd: `Purpose for ${id}`, accountabilities: [], artifacts: [],
      sortOrder, createdAt: new Date("2026-10-01T12:00:00Z"), updatedAt: new Date("2026-10-01T12:00:00Z"),
      circle: { id: circleId, name: `Circle ${circleId}`, purposeMd: "Circle purpose", sortOrder: 99 },
    };
  }

  function readerAssignment(id: string, role = readerRole("role-public")) {
    return {
      id, roleId: role.id, memberId: `member-${id}`, assignedAt: new Date("2026-10-01T12:00:00Z"),
      expiresAt: null, role,
      member: { id: `member-${id}`, workspaceId: "workspace-1", userId: `user-${id}`, isActive: true,
        user: { id: `user-${id}`, email: `${id}@example.test`, displayName: id, bio: "Member profile" } },
    };
  }

  it("filters restricted and unknown roles before ranking and redacts withheld circle paths", async () => {
    const hiddenCircleRole = readerRole("role-original", "circle-finance", 0);
    const publicRole = readerRole("role-public", "circle-public", 1);
    publicRole.circle.sortOrder = 0;
    hiddenCircleRole.circle.sortOrder = 1000;
    prismaMock.role.findMany.mockResolvedValue([
      readerRole("role-finance"), readerRole("role-legacy"), publicRole, hiddenCircleRole,
    ]);
    vi.mocked(readableArtifactIds).mockImplementation(async (_actor, _workspaceId, kind, rows) => new Set(rows
      .filter((row) => kind === "Role" ? !["role-finance", "role-legacy"].includes(row.id) : row.id !== "circle-finance")
      .map((row) => row.id)));

    const { listRoles } = await import("./roles");
    const result = await listRoles(actor, "workspace-1");

    expect(result.map((role) => role.id)).toEqual(["role-original", "role-public"]);
    expect(result[0]).toMatchObject({ circleId: null, circle: null });
    expect(result[1]?.circle).toEqual({ id: "circle-public", name: "Circle circle-public" });
    expect(readableArtifactIds).toHaveBeenCalledWith(actor, "workspace-1", "Role", expect.arrayContaining([
      expect.objectContaining({ id: "role-legacy", purposeMd: "Purpose for role-legacy" }),
    ]));
    expect(prismaMock.role.findMany.mock.calls[0]?.[0]).not.toHaveProperty("orderBy");
  });

  it("withholds detail content when the role proof is unknown or no longer readable", async () => {
    prismaMock.role.findFirst.mockResolvedValue({ ...readerRole("role-finance"), assignments: [] });
    vi.mocked(readableArtifactIds).mockResolvedValue(new Set());
    const { getRole } = await import("./roles");
    await expect(getRole(actor, { workspaceId: "workspace-1", roleId: "role-finance" }))
      .rejects.toMatchObject({ status: 404, code: "NOT_FOUND" });
  });

  it("redacts detail circle affiliation and filters assignment profiles before filler counts", async () => {
    const role = readerRole("role-original", "circle-finance");
    const detailAssignment = (id: string) => {
      const row = readerAssignment(id, role);
      return { id: row.id, roleId: row.roleId, memberId: row.memberId, assignedAt: row.assignedAt,
        expiresAt: row.expiresAt, member: row.member };
    };
    prismaMock.role.findFirst.mockResolvedValue({ ...role,
      assignments: [detailAssignment("revoked"), detailAssignment("expired"), detailAssignment("public")],
    });
    vi.mocked(readableArtifactIds).mockImplementation(async (_actor, _workspaceId, kind, rows) => new Set(rows
      .filter((row) => kind === "Circle" ? false
        : kind === "RoleAssignment" ? row.id !== "expired"
          : true)
      .map((row) => row.id)));

    vi.mocked(captureArtifactInputProof).mockImplementation(async (_actor, _workspaceId, inputs) => {
      if (inputs.some((input) => input.id === "user-revoked")) throw new AppError(409, "SOURCE_RESTRICTED", "Profile unavailable.");
      return captureFixtureProof(_actor, _workspaceId, inputs);
    });
    const { getRole } = await import("./roles");
    const result = await getRole(actor, { workspaceId: "workspace-1", roleId: role.id });
    expect(result).toMatchObject({ id: "role-original", circleId: null, circle: null });
    expect(result.assignments.map((assignment) => assignment.id)).toEqual(["public"]);
    expect(readableArtifactIds).toHaveBeenCalledWith(actor, "workspace-1", "Member", expect.arrayContaining([
      expect.objectContaining({ id: "member-public", user: { id: "user-public", email: "public@example.test", displayName: "public" } }),
    ]));
    expect(JSON.stringify(result)).not.toContain("circle-finance");
  });

  it("filters assignment lists by role, association and member proof and hides circle metadata", async () => {
    const visible = readerAssignment("public", readerRole("role-original", "circle-finance"));
    prismaMock.roleAssignment.findMany.mockResolvedValue([
      readerAssignment("hidden-role", readerRole("role-private")), readerAssignment("inactive-member"), visible,
    ]);
    vi.mocked(readableArtifactIds).mockImplementation(async (_actor, _workspaceId, kind, rows) => new Set(rows
      .filter((row) => kind === "Role" ? row.id !== "role-private"
        : kind === "Circle" ? row.id !== "circle-finance"
          : kind === "Member" ? row.id !== "member-inactive-member" : true)
      .map((row) => row.id)));
    const { listRoleAssignments } = await import("./roles");
    const result = await listRoleAssignments(actor, "workspace-1");
    expect(result.map((assignment) => assignment.id)).toEqual(["public"]);
    expect(result[0]?.role).toEqual({ id: "role-original", name: "role-original", circle: null });
    expect(result[0]?.member.user).not.toHaveProperty("bio");
    expect(JSON.stringify(result)).not.toContain("circle-finance");
  });

  it("preserves the stored circle association when a partial role edit omits it", async () => {
    prismaMock.role.findUnique.mockResolvedValue({ ...readerRole("role-1", "circle-hidden"),
      archivedAt: null, circle: { workspaceId: "workspace-1" } });
    prismaMock.role.update.mockResolvedValue({ ...readerRole("role-1", "circle-hidden"), name: "Edited" });
    const { updateRole } = await import("./roles");
    await updateRole(actor, { workspaceId: "workspace-1", roleId: "role-1", name: "Edited" });
    expect(prismaMock.role.update).toHaveBeenCalledWith(expect.objectContaining({ data: { name: "Edited" } }));
    expect(prismaMock.circle.findUnique).not.toHaveBeenCalled();
  });

  it("redacts withheld circle data in role mutation responses without moving the role", async () => {
    prismaMock.role.findUnique.mockResolvedValue({ ...readerRole("role-1", "circle-hidden"),
      archivedAt: null, circle: { workspaceId: "workspace-1" } });
    prismaMock.role.update.mockResolvedValue({ ...readerRole("role-1", "circle-hidden"), name: "Edited" });
    vi.mocked(readableArtifactIds).mockImplementation(async (_actor, _workspaceId, kind, rows) =>
      new Set(kind === "Circle" ? [] : rows.map((row) => row.id)));
    const { updateRole } = await import("./roles");
    await expect(updateRole(actor, { workspaceId: "workspace-1", roleId: "role-1", name: "Edited" }))
      .resolves.toMatchObject({ id: "role-1", name: "Edited", circleId: null, circle: null });
    expect(prismaMock.role.update).toHaveBeenCalledWith(expect.objectContaining({ data: { name: "Edited" } }));
  });

  it("withholds stale body content from updated and unchanged mutation responses", async () => {
    const role = { ...readerRole("role-legacy"), archivedAt: null,
      circle: { ...readerRole("role-legacy").circle, workspaceId: "workspace-1" } };
    prismaMock.role.findUnique.mockResolvedValue(role);
    prismaMock.role.update.mockResolvedValue({ ...role, name: "Edited" });
    vi.mocked(readableArtifactIds).mockResolvedValue(new Set());
    const { updateRole } = await import("./roles");
    await expect(updateRole(actor, { workspaceId: "workspace-1", roleId: role.id, name: "Edited" }))
      .resolves.toEqual({ id: role.id, contentWithheld: true });
    await expect(updateRole(actor, { workspaceId: "workspace-1", roleId: role.id, name: role.name }))
      .resolves.toEqual({ id: role.id, contentWithheld: true });
    expect(prismaMock.role.update).toHaveBeenCalledTimes(1);
  });

  it("captures partial holder labels against the authoritative User without inventing omitted profile fields", async () => {
    const assignment = readerAssignment("partial-label");
    const partialUser = { id: assignment.member.user.id, email: assignment.member.user.email, displayName: assignment.member.user.displayName };
    const row = { ...assignment, member: { ...assignment.member, user: partialUser } };
    const { filterReadableRoleAssignments } = await import("./roles");
    expect(await filterReadableRoleAssignments(actor, "workspace-1", [row])).toEqual([row]);
    expect(captureArtifactInputProof).toHaveBeenCalledWith(actor, "workspace-1", [
      { kind: "User", id: partialUser.id, snapshot: partialUser },
    ]);
    expect(vi.mocked(captureArtifactInputProof).mock.calls.at(-1)?.[2][0]?.snapshot).not.toHaveProperty("bio");
    expect(vi.mocked(readableArtifactIds).mock.calls.some((call) => call[2] === "User")).toBe(false);
  });

  it("withholds only the holder whose observed profile changed or current audience disappeared", async () => {
    const readable = readerAssignment("current");
    const changed = readerAssignment("changed");
    vi.mocked(captureArtifactInputProof).mockImplementation(async (_actor, _workspaceId, inputs) => {
      if (inputs[0]?.id === changed.member.user.id) throw new AppError(409, "SOURCE_CHANGED", "User changed.");
      return captureFixtureProof(_actor, _workspaceId, inputs);
    });
    const { filterReadableRoleAssignments } = await import("./roles");
    expect(await filterReadableRoleAssignments(actor, "workspace-1", [changed, readable])).toEqual([readable]);
  });

});
