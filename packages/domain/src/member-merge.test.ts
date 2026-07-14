import { beforeEach, describe, expect, it, vi } from "vitest";
import type { AppActor } from "@corgtex/shared";

const { prismaMock, requireWorkspaceMembershipMock } = vi.hoisted(() => {
  function relationModel() {
    return {
      findMany: vi.fn().mockResolvedValue([]),
      findUnique: vi.fn(),
      findFirst: vi.fn(),
      updateMany: vi.fn().mockResolvedValue({ count: 0 }),
      deleteMany: vi.fn().mockResolvedValue({ count: 0 }),
      upsert: vi.fn(),
      update: vi.fn(),
    };
  }

  return {
    requireWorkspaceMembershipMock: vi.fn(),
    prismaMock: {
      $transaction: vi.fn(),
      action: relationModel(),
      adviceProcess: relationModel(),
      adviceRequestRecipient: relationModel(),
      approvalDecision: relationModel(),
      auditLog: {
        create: vi.fn(),
      },
      brainArticle: relationModel(),
      brainDiscussionComment: relationModel(),
      brainDiscussionThread: relationModel(),
      brainSource: relationModel(),
      checkIn: relationModel(),
      communicationExternalUser: relationModel(),
      deliberationEntry: relationModel(),
      event: {
        createMany: vi.fn(),
      },
      goal: relationModel(),
      goalUpdate: relationModel(),
      impactFootprint: relationModel(),
      member: relationModel(),
      memberEmailAlias: relationModel(),
      memberExpertise: relationModel(),
      memberInviteRequest: relationModel(),
      newspaperDelivery: relationModel(),
      proposal: relationModel(),
      recognition: relationModel(),
      roleAssignment: relationModel(),
      roleHolderHistory: relationModel(),
      roleOnboardingSession: relationModel(),
      selfServeSupportSession: relationModel(),
      tension: relationModel(),
    },
  };
});

vi.mock("@corgtex/shared", () => ({
  prisma: prismaMock,
}));

vi.mock("./auth", () => ({
  requireWorkspaceMembership: requireWorkspaceMembershipMock,
}));

const actor: AppActor = {
  kind: "user",
  user: {
    id: "admin-user",
    email: "admin@example.com",
    displayName: "Admin",
    globalRole: "OPERATOR",
  },
};

const sourceMember = {
  id: "member-source",
  workspaceId: "workspace-1",
  userId: "user-source",
  role: "ADMIN",
  kind: "HUMAN",
  isActive: true,
  newspaperCadence: "DAILY",
  mergedIntoMemberId: null,
  user: {
    id: "user-source",
    email: "SOURCE@EXAMPLE.COM",
    displayName: "Source",
  },
  emailAliases: [{ email: "source.alias@example.com", source: "MANUAL" }],
};

const targetMember = {
  id: "member-target",
  workspaceId: "workspace-1",
  userId: "user-target",
  role: "CONTRIBUTOR",
  kind: "HUMAN",
  isActive: true,
  newspaperCadence: null,
  mergedIntoMemberId: null,
  user: {
    id: "user-target",
    email: "target@example.com",
    displayName: "Target",
  },
  emailAliases: [],
};

describe("member merge domain", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    prismaMock.$transaction.mockImplementation(async (callback: (tx: typeof prismaMock) => Promise<unknown>) => callback(prismaMock));
    requireWorkspaceMembershipMock.mockResolvedValue({ id: "admin-member", role: "ADMIN", isActive: true });
    prismaMock.auditLog.create.mockResolvedValue({});
    prismaMock.event.createMany.mockResolvedValue({ count: 1 });
    prismaMock.member.findMany.mockResolvedValue([]);
    prismaMock.member.findFirst.mockResolvedValue(null);
    prismaMock.memberEmailAlias.findUnique.mockResolvedValue(null);
    prismaMock.memberEmailAlias.upsert.mockImplementation(async ({ create, update }: { create: Record<string, unknown>; update: Record<string, unknown> }) => ({
      id: "alias-1",
      ...create,
      ...update,
    }));
    for (const model of Object.values(prismaMock)) {
      if (model && typeof model === "object" && "findMany" in model) {
        vi.mocked((model as { findMany: () => unknown }).findMany).mockResolvedValue([]);
      }
      if (model && typeof model === "object" && "updateMany" in model) {
        vi.mocked((model as { updateMany: () => unknown }).updateMany).mockResolvedValue({ count: 0 });
      }
      if (model && typeof model === "object" && "deleteMany" in model) {
        vi.mocked((model as { deleteMany: () => unknown }).deleteMany).mockResolvedValue({ count: 0 });
      }
    }
  });

  it("adds a normalized alias for a workspace member", async () => {
    prismaMock.member.findUnique.mockResolvedValue({
      id: "member-1",
      workspaceId: "workspace-1",
      user: { email: "member@example.com" },
    });
    prismaMock.memberEmailAlias.upsert.mockResolvedValue({ id: "alias-1", email: "alias@example.com" });

    const { addMemberEmailAlias } = await import("./member-merge");
    await expect(addMemberEmailAlias(actor, {
      workspaceId: "workspace-1",
      memberId: "member-1",
      email: " Alias@Example.COM ",
    })).resolves.toEqual({ id: "alias-1", email: "alias@example.com" });

    expect(requireWorkspaceMembershipMock).toHaveBeenCalledWith({
      actor,
      workspaceId: "workspace-1",
      allowedRoles: ["ADMIN"],
    });
    expect(prismaMock.memberEmailAlias.upsert).toHaveBeenCalledWith(expect.objectContaining({
      where: {
        workspaceId_email: {
          workspaceId: "workspace-1",
          email: "alias@example.com",
        },
      },
      create: expect.objectContaining({
        memberId: "member-1",
        source: "MANUAL",
        createdByUserId: "admin-user",
      }),
    }));
  });

  it("rejects aliases already used by another member primary email", async () => {
    prismaMock.member.findUnique.mockResolvedValue({
      id: "member-1",
      workspaceId: "workspace-1",
      user: { email: "member@example.com" },
    });
    prismaMock.member.findFirst.mockResolvedValue({ id: "member-2" });

    const { addMemberEmailAlias } = await import("./member-merge");
    await expect(addMemberEmailAlias(actor, {
      workspaceId: "workspace-1",
      memberId: "member-1",
      email: "other@example.com",
    })).rejects.toMatchObject({
      status: 409,
      code: "ALIAS_EMAIL_CONFLICT",
    });
    expect(prismaMock.memberEmailAlias.upsert).not.toHaveBeenCalled();
  });

  it("resolves aliases before falling back to primary user email", async () => {
    const aliasMember = {
      id: "member-alias",
      isActive: true,
      user: { email: "primary@example.com", displayName: "Primary" },
    };
    prismaMock.memberEmailAlias.findUnique.mockResolvedValue({
      id: "alias-1",
      member: aliasMember,
    });

    const { resolveWorkspaceMemberByEmail } = await import("./member-merge");
    await expect(resolveWorkspaceMemberByEmail({
      workspaceId: "workspace-1",
      email: " alias@example.com ",
    })).resolves.toBe(aliasMember);
    expect(prismaMock.member.findFirst).not.toHaveBeenCalled();
  });

  it("falls back to active primary member email when no alias exists", async () => {
    const primaryMember = {
      id: "member-primary",
      isActive: true,
      user: { email: "primary@example.com", displayName: "Primary" },
    };
    prismaMock.member.findFirst.mockResolvedValue(primaryMember);

    const { resolveWorkspaceMemberByEmail } = await import("./member-merge");
    await expect(resolveWorkspaceMemberByEmail({
      workspaceId: "workspace-1",
      email: "PRIMARY@example.com",
    })).resolves.toBe(primaryMember);
    expect(prismaMock.member.findFirst).toHaveBeenCalledWith(expect.objectContaining({
      where: expect.objectContaining({
        workspaceId: "workspace-1",
        isActive: true,
        user: { email: "primary@example.com" },
      }),
    }));
  });

  it("merges a source member into a target and rewires direct member relations", async () => {
    prismaMock.member.findUnique.mockImplementation(async ({ where }: { where: { id: string } }) => {
      if (where.id === "member-source") return sourceMember;
      if (where.id === "member-target") return targetMember;
      return {
        id: "member-target",
        workspaceId: "workspace-1",
        user: { email: "target@example.com" },
      };
    });
    prismaMock.member.findFirst.mockImplementation(async ({ where }: { where: { user?: { email?: string } } }) => {
      if (where.user?.email === "source@example.com") return { id: "member-source" };
      if (where.user?.email === "source.alias@example.com") return null;
      if (where.user?.email === "extra@example.com") return null;
      return null;
    });
    prismaMock.roleAssignment.findMany
      .mockResolvedValueOnce([{ roleId: "role-1" }])
      .mockResolvedValueOnce([{ roleId: "role-1" }]);
    prismaMock.roleAssignment.deleteMany.mockResolvedValue({ count: 1 });
    prismaMock.roleAssignment.updateMany.mockResolvedValue({ count: 2 });
    prismaMock.action.updateMany.mockResolvedValue({ count: 3 });
    prismaMock.tension.updateMany.mockResolvedValueOnce({ count: 1 }).mockResolvedValueOnce({ count: 0 });
    prismaMock.proposal.updateMany.mockResolvedValue({ count: 2 });
    prismaMock.member.update.mockResolvedValueOnce({
      ...targetMember,
      role: "ADMIN",
      newspaperCadence: "DAILY",
      user: targetMember.user,
    }).mockResolvedValueOnce({
      ...sourceMember,
      isActive: false,
      mergedIntoMemberId: "member-target",
    });

    const { mergeWorkspaceMembers } = await import("./member-merge");
    const result = await mergeWorkspaceMembers(actor, {
      workspaceId: "workspace-1",
      sourceMemberId: "member-source",
      targetMemberId: "member-target",
      aliasEmails: [" Extra@Example.com "],
      reason: "Duplicate member",
    });

    expect(result.aliasEmails).toEqual(["source@example.com", "source.alias@example.com", "extra@example.com"]);
    expect(result.rewired).toMatchObject({
      "roleAssignment.duplicatesDeleted": 1,
      "roleAssignment.memberId": 2,
      "action.assigneeMemberId": 3,
      "tension.assigneeMemberId": 1,
      "proposal.ownerMemberId": 2,
    });
    expect(prismaMock.memberEmailAlias.upsert).toHaveBeenCalledWith(expect.objectContaining({
      update: expect.objectContaining({
        memberId: "member-target",
        source: "MERGE",
      }),
    }));
    expect(prismaMock.member.update).toHaveBeenCalledWith(expect.objectContaining({
      where: { id: "member-target" },
      data: expect.objectContaining({
        role: "ADMIN",
        newspaperCadence: "DAILY",
      }),
    }));
    expect(prismaMock.member.update).toHaveBeenCalledWith(expect.objectContaining({
      where: { id: "member-source" },
      data: expect.objectContaining({
        isActive: false,
        mergedIntoMemberId: "member-target",
        mergedByUserId: "admin-user",
        mergeReason: "Duplicate member",
      }),
    }));
    expect(prismaMock.auditLog.create).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({
        action: "member.merged",
        entityId: "member-target",
      }),
    }));
    expect(prismaMock.event.createMany).toHaveBeenCalledWith({
      data: [
        expect.objectContaining({
          type: "member.merged",
          aggregateId: "member-target",
        }),
      ],
    });
  });

  it("blocks a merge when unique member-owned rows would collide", async () => {
    prismaMock.member.findUnique.mockImplementation(async ({ where }: { where: { id: string } }) => {
      if (where.id === "member-source") return sourceMember;
      if (where.id === "member-target") return targetMember;
      return null;
    });
    prismaMock.approvalDecision.findMany
      .mockResolvedValueOnce([{ flowId: "flow-1" }])
      .mockResolvedValueOnce([{ flowId: "flow-1" }]);

    const { mergeWorkspaceMembers } = await import("./member-merge");
    await expect(mergeWorkspaceMembers(actor, {
      workspaceId: "workspace-1",
      sourceMemberId: "member-source",
      targetMemberId: "member-target",
    })).rejects.toMatchObject({
      status: 409,
      code: "MEMBER_MERGE_CONFLICT",
    });
    expect(prismaMock.member.update).not.toHaveBeenCalled();
    expect(prismaMock.auditLog.create).not.toHaveBeenCalled();
  });
});
