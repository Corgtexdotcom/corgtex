import { beforeEach, describe, expect, it, vi } from "vitest";
import type { AppActor } from "@corgtex/shared";

const { prismaMock } = vi.hoisted(() => {
  const prisma = {
    $transaction: vi.fn(),
    member: {
      findMany: vi.fn(),
      findFirst: vi.fn(),
      findUnique: vi.fn(),
      upsert: vi.fn(),
      update: vi.fn(),
      count: vi.fn(),
    },
    user: {
      findUnique: vi.fn(),
      upsert: vi.fn(),
      update: vi.fn(),
    },
    session: {
      deleteMany: vi.fn(),
    },
    workspaceFeatureFlag: {
      findUnique: vi.fn(),
      upsert: vi.fn(),
    },
    memberInviteRequest: {
      create: vi.fn(),
      findFirst: vi.fn(),
      findMany: vi.fn(),
      findUnique: vi.fn(),
      update: vi.fn(),
    },
    auditLog: {
      create: vi.fn(),
      findMany: vi.fn(),
    },
    event: {
      createMany: vi.fn(),
    },
    passwordResetToken: {
      updateMany: vi.fn(),
      create: vi.fn(),
    },
    meeting: {
      findMany: vi.fn(),
    },
    proposal: {
      findMany: vi.fn(),
    },
    tension: {
      findMany: vi.fn(),
    },
  };
  return { prismaMock: prisma };
});

vi.mock("@corgtex/shared", () => ({
  prisma: prismaMock,
  hashPassword: vi.fn((value: string) => `hash:${value}`),
  randomOpaqueToken: vi.fn(() => "opaque-token"),
  sha256: vi.fn((value: string) => `sha:${value}`),
  parseAllowedWorkspaceIds: vi.fn(() => new Set<string>()),
  env: {
    SESSION_LAST_SEEN_WRITE_INTERVAL_MS: 5 * 60 * 1000,
  },
}));

const actor: AppActor = {
  kind: "user" as const,
  user: {
    id: "admin-user",
    email: "admin@example.com",
    displayName: "Admin",
    globalRole: "OPERATOR",
  },
};

describe("members domain", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    prismaMock.$transaction.mockImplementation(async (callback: (tx: typeof prismaMock) => Promise<unknown>) => callback(prismaMock));
    prismaMock.auditLog.create.mockResolvedValue({});
    prismaMock.event.createMany.mockResolvedValue({ count: 1 });
    prismaMock.passwordResetToken.updateMany.mockResolvedValue({ count: 0 });
    prismaMock.passwordResetToken.create.mockResolvedValue({});
    prismaMock.session.deleteMany.mockResolvedValue({ count: 0 });
    prismaMock.workspaceFeatureFlag.findUnique.mockResolvedValue(null);
  });

  it("listMembers returns active members ordered by join date", async () => {
    prismaMock.member.findMany.mockResolvedValue([{ id: "member-1" }]);

    const { listMembers } = await import("./members");
    await expect(listMembers("workspace-1")).resolves.toEqual([{ id: "member-1" }]);
    expect(prismaMock.member.findMany).toHaveBeenCalledWith({
      where: { workspaceId: "workspace-1", isActive: true },
      include: {
        user: {
          select: {
            id: true,
            email: true,
            displayName: true,
          },
        },
      },
      orderBy: {
        joinedAt: "asc",
      },
    });
  });

  it("createMember creates or reactivates a member and issues a setup token", async () => {
    prismaMock.user.upsert.mockResolvedValue({ id: "user-1", email: "user@example.com", displayName: "User" });
    prismaMock.member.upsert.mockResolvedValue({ id: "member-1", role: "ADMIN" });

    const { createMember } = await import("./members");
    await expect(createMember(actor, {
      workspaceId: "workspace-1",
      email: " USER@EXAMPLE.COM ",
      displayName: " User ",
      role: "ADMIN",
    })).resolves.toEqual({
      user: { id: "user-1", email: "user@example.com", displayName: "User" },
      member: { id: "member-1", role: "ADMIN" },
      token: "opaque-token",
    });

    expect(prismaMock.user.upsert).toHaveBeenCalledWith(expect.objectContaining({
      where: { email: "user@example.com" },
    }));
    expect(prismaMock.member.upsert).toHaveBeenCalledWith(expect.objectContaining({
      update: {
        role: "ADMIN",
        isActive: true,
      },
    }));
  });

  it("createMember rejects a blank email before writing", async () => {
    const { createMember } = await import("./members");
    await expect(createMember(actor, {
      workspaceId: "workspace-1",
      email: " ",
      role: "CONTRIBUTOR",
    })).rejects.toMatchObject({
      status: 400,
      code: "INVALID_INPUT",
    });
    expect(prismaMock.$transaction).not.toHaveBeenCalled();
  });

  it("inviteMember uses the contributor role and the existing user/member path", async () => {
    prismaMock.user.upsert.mockResolvedValue({ id: "user-1", email: "user@example.com", displayName: null });
    prismaMock.member.upsert.mockResolvedValue({ id: "member-1", role: "CONTRIBUTOR" });

    const { inviteMember } = await import("./members");
    await inviteMember(actor, {
      workspaceId: "workspace-1",
      email: "user@example.com",
    });

    expect(prismaMock.member.upsert).toHaveBeenCalledWith(expect.objectContaining({
      update: {
        role: "CONTRIBUTOR",
        isActive: true,
      },
    }));
  });

  it("updateMember changes role and display name", async () => {
    prismaMock.member.findUnique.mockResolvedValue({
      id: "member-1",
      workspaceId: "workspace-1",
      userId: "user-1",
      role: "CONTRIBUTOR",
      isActive: true,
      user: {
        id: "user-1",
        email: "user@example.com",
        displayName: "User",
        ssoIdentities: [],
        _count: { memberships: 1 },
      },
    });
    prismaMock.member.update.mockResolvedValue({
      id: "member-1",
      role: "ADMIN",
      isActive: true,
      user: { id: "user-1", email: "user@example.com", displayName: "Renamed" },
    });
    prismaMock.user.update.mockResolvedValue({});

    const { updateMember } = await import("./members");
    await expect(updateMember(actor, {
      workspaceId: "workspace-1",
      memberId: "member-1",
      role: "ADMIN",
      displayName: " Renamed ",
    })).resolves.toEqual({
      id: "member-1",
      role: "ADMIN",
      isActive: true,
      user: { id: "user-1", email: "user@example.com", displayName: "Renamed" },
      setupToken: undefined,
    });

    expect(prismaMock.member.update).toHaveBeenCalledWith(expect.objectContaining({
      data: { role: "ADMIN" },
    }));
    expect(prismaMock.user.update).toHaveBeenCalledWith({
      where: { id: "user-1" },
      data: { displayName: "Renamed" },
    });
  });

  it("updateMember rejects a missing member", async () => {
    prismaMock.member.findUnique.mockResolvedValue(null);

    const { updateMember } = await import("./members");
    await expect(updateMember(actor, {
      workspaceId: "workspace-1",
      memberId: "missing-member",
      role: "ADMIN",
    })).rejects.toMatchObject({
      status: 404,
      code: "NOT_FOUND",
    });
  });

  it("deactivateMember marks an active member inactive", async () => {
    prismaMock.member.findUnique.mockResolvedValue({
      id: "member-1",
      workspaceId: "workspace-1",
      userId: "user-1",
      role: "CONTRIBUTOR",
      isActive: true,
      user: {
        id: "user-1",
        email: "user@example.com",
        displayName: "User",
        ssoIdentities: [],
        _count: { memberships: 1 },
      },
    });
    prismaMock.member.update.mockResolvedValue({
      id: "member-1",
      isActive: false,
      role: "CONTRIBUTOR",
      user: { id: "user-1", email: "user@example.com", displayName: "User" },
    });

    const { deactivateMember } = await import("./members");
    await expect(deactivateMember(actor, {
      workspaceId: "workspace-1",
      memberId: "member-1",
    })).resolves.toMatchObject({ id: "member-1", isActive: false });
  });

  it("deactivateMember rejects an already deactivated member", async () => {
    prismaMock.member.findUnique.mockResolvedValue({
      id: "member-1",
      workspaceId: "workspace-1",
      userId: "user-1",
      role: "CONTRIBUTOR",
      isActive: false,
      user: {
        id: "user-1",
        email: "user@example.com",
        displayName: "User",
        ssoIdentities: [],
        _count: { memberships: 1 },
      },
    });

    const { deactivateMember } = await import("./members");
    await expect(deactivateMember(actor, {
      workspaceId: "workspace-1",
      memberId: "member-1",
    })).rejects.toMatchObject({
      status: 400,
      code: "INVALID_STATE",
    });
  });

  it("inviteMember rejects non-admin direct invites when policy is admins-only", async () => {
    const memberActor: AppActor = {
      kind: "user",
      user: {
        id: "member-user",
        email: "member@example.com",
        displayName: "Member",
        globalRole: "USER",
      },
    };
    prismaMock.member.findUnique.mockResolvedValueOnce({
      id: "requester-member",
      workspaceId: "workspace-1",
      userId: "member-user",
      role: "CONTRIBUTOR",
      isActive: true,
    });

    const { inviteMember } = await import("./members");
    await expect(inviteMember(memberActor, {
      workspaceId: "workspace-1",
      email: "new@example.com",
    })).rejects.toMatchObject({
      status: 403,
      code: "FORBIDDEN",
    });
  });

  it("inviteMember allows contributor invites when workspace policy allows member invites", async () => {
    const memberActor: AppActor = {
      kind: "user",
      user: {
        id: "member-user",
        email: "member@example.com",
        displayName: "Member",
        globalRole: "USER",
      },
    };
    prismaMock.member.findUnique.mockResolvedValueOnce({
      id: "requester-member",
      workspaceId: "workspace-1",
      userId: "member-user",
      role: "CONTRIBUTOR",
      isActive: true,
    });
    prismaMock.workspaceFeatureFlag.findUnique.mockResolvedValueOnce({
      config: { policy: "MEMBERS_CAN_INVITE" },
    });
    prismaMock.user.upsert.mockResolvedValue({ id: "user-1", email: "new@example.com", displayName: null });
    prismaMock.member.upsert.mockResolvedValue({ id: "member-1", role: "CONTRIBUTOR" });

    const { inviteMember } = await import("./members");
    await inviteMember(memberActor, {
      workspaceId: "workspace-1",
      email: "new@example.com",
    });

    expect(prismaMock.member.upsert).toHaveBeenCalledWith(expect.objectContaining({
      create: expect.objectContaining({ role: "CONTRIBUTOR" }),
    }));
  });

  it("requestMemberInvite creates a pending request when policy requires requests", async () => {
    const memberActor: AppActor = {
      kind: "user",
      user: {
        id: "member-user",
        email: "member@example.com",
        displayName: "Member",
        globalRole: "USER",
      },
    };
    prismaMock.member.findUnique.mockResolvedValueOnce({
      id: "requester-member",
      workspaceId: "workspace-1",
      userId: "member-user",
      role: "CONTRIBUTOR",
      isActive: true,
    });
    prismaMock.workspaceFeatureFlag.findUnique.mockResolvedValueOnce({
      config: { policy: "MEMBERS_CAN_REQUEST" },
    });
    prismaMock.member.findFirst.mockResolvedValue(null);
    prismaMock.memberInviteRequest.findFirst.mockResolvedValue(null);
    prismaMock.memberInviteRequest.create.mockResolvedValue({ id: "request-1" });

    const { requestMemberInvite } = await import("./members");
    await expect(requestMemberInvite(memberActor, {
      workspaceId: "workspace-1",
      email: " NEW@EXAMPLE.COM ",
      displayName: " New Person ",
    })).resolves.toEqual({ id: "request-1" });

    expect(prismaMock.memberInviteRequest.create).toHaveBeenCalledWith({
      data: {
        workspaceId: "workspace-1",
        requesterMemberId: "requester-member",
        email: "new@example.com",
        displayName: "New Person",
      },
    });
  });

  it("approveMemberInviteRequest creates a contributor and marks the request approved", async () => {
    prismaMock.memberInviteRequest.findUnique.mockResolvedValue({
      id: "request-1",
      workspaceId: "workspace-1",
      email: "new@example.com",
      displayName: "New",
      status: "PENDING",
    });
    prismaMock.user.upsert.mockResolvedValue({ id: "user-1", email: "new@example.com", displayName: "New" });
    prismaMock.member.upsert.mockResolvedValue({ id: "member-1", role: "CONTRIBUTOR" });
    prismaMock.memberInviteRequest.update.mockResolvedValue({ id: "request-1", status: "APPROVED" });

    const { approveMemberInviteRequest } = await import("./members");
    await expect(approveMemberInviteRequest(actor, {
      workspaceId: "workspace-1",
      requestId: "request-1",
    })).resolves.toMatchObject({
      user: { id: "user-1", email: "new@example.com" },
      member: { id: "member-1", role: "CONTRIBUTOR" },
      token: "opaque-token",
    });

    expect(prismaMock.memberInviteRequest.update).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({ status: "APPROVED" }),
    }));
  });

  it("updateMember changes email, invalidates sessions, and issues setup token", async () => {
    prismaMock.member.findUnique.mockResolvedValue({
      id: "member-1",
      workspaceId: "workspace-1",
      userId: "user-1",
      role: "CONTRIBUTOR",
      isActive: true,
      user: {
        id: "user-1",
        email: "old@example.com",
        displayName: "User",
        ssoIdentities: [],
        _count: { memberships: 1 },
      },
    });
    prismaMock.user.findUnique.mockResolvedValue(null);
    prismaMock.user.update.mockResolvedValue({});
    prismaMock.member.findUnique.mockResolvedValueOnce({
      id: "member-1",
      workspaceId: "workspace-1",
      userId: "user-1",
      role: "CONTRIBUTOR",
      isActive: true,
      user: {
        id: "user-1",
        email: "old@example.com",
        displayName: "User",
        ssoIdentities: [],
        _count: { memberships: 1 },
      },
    }).mockResolvedValueOnce({
      id: "member-1",
      role: "CONTRIBUTOR",
      isActive: true,
      user: { id: "user-1", email: "new@example.com", displayName: "User" },
    });

    const { updateMember } = await import("./members");
    await expect(updateMember(actor, {
      workspaceId: "workspace-1",
      memberId: "member-1",
      email: "NEW@EXAMPLE.COM",
    })).resolves.toMatchObject({
      id: "member-1",
      setupToken: "opaque-token",
      user: { email: "new@example.com" },
    });

    expect(prismaMock.user.update).toHaveBeenCalledWith({
      where: { id: "user-1" },
      data: { email: "new@example.com" },
    });
    expect(prismaMock.session.deleteMany).toHaveBeenCalledWith({ where: { userId: "user-1" } });
  });

  it("updateMember rejects duplicate target emails", async () => {
    prismaMock.member.findUnique.mockResolvedValue({
      id: "member-1",
      workspaceId: "workspace-1",
      userId: "user-1",
      role: "CONTRIBUTOR",
      isActive: true,
      user: {
        id: "user-1",
        email: "old@example.com",
        displayName: "User",
        ssoIdentities: [],
        _count: { memberships: 1 },
      },
    });
    prismaMock.user.findUnique.mockResolvedValue({ id: "user-2" });

    const { updateMember } = await import("./members");
    await expect(updateMember(actor, {
      workspaceId: "workspace-1",
      memberId: "member-1",
      email: "taken@example.com",
    })).rejects.toMatchObject({
      status: 409,
      code: "ALREADY_EXISTS",
    });
  });

  it("updateMember rejects workspace-admin email edits for shared or SSO accounts", async () => {
    const adminActor: AppActor = {
      kind: "user",
      user: {
        id: "admin-user",
        email: "admin@example.com",
        displayName: "Admin",
        globalRole: "USER",
      },
    };
    prismaMock.member.findUnique.mockResolvedValueOnce({
      id: "admin-member",
      workspaceId: "workspace-1",
      userId: "admin-user",
      role: "ADMIN",
      isActive: true,
    }).mockResolvedValueOnce({
      id: "member-1",
      workspaceId: "workspace-1",
      userId: "user-1",
      role: "CONTRIBUTOR",
      isActive: true,
      user: {
        id: "user-1",
        email: "old@example.com",
        displayName: "User",
        ssoIdentities: [{ id: "sso-1" }],
        _count: { memberships: 1 },
      },
    });
    prismaMock.user.findUnique.mockResolvedValue(null);

    const { updateMember } = await import("./members");
    await expect(updateMember(adminActor, {
      workspaceId: "workspace-1",
      memberId: "member-1",
      email: "new@example.com",
    })).rejects.toMatchObject({
      status: 400,
      code: "SSO_ACCOUNT",
    });
  });

  it("getMemberProfile returns member context collections", async () => {
    prismaMock.member.findUnique.mockResolvedValue({
      id: "member-1",
      workspaceId: "workspace-1",
      user: { id: "user-1" },
    });
    prismaMock.meeting.findMany.mockResolvedValue([{ id: "meeting-1" }]);
    prismaMock.auditLog.findMany.mockResolvedValue([{ id: "audit-1" }]);
    prismaMock.proposal.findMany.mockResolvedValue([{ id: "proposal-1" }]);
    prismaMock.tension.findMany.mockResolvedValue([{ id: "tension-1" }]);

    const { getMemberProfile } = await import("./members");
    await expect(getMemberProfile("workspace-1", "member-1")).resolves.toMatchObject({
      member: { id: "member-1" },
      meetings: [{ id: "meeting-1" }],
      recentActivity: [{ id: "audit-1" }],
      proposals: [{ id: "proposal-1" }],
      authoredTensions: [{ id: "tension-1" }],
    });
  });
});
