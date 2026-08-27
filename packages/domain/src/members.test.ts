import { beforeEach, describe, expect, it, vi } from "vitest";
import type { AppActor } from "@corgtex/shared";

const { prismaMock, selfServeOpsMock, sendEmailMock, sharedEnv } = vi.hoisted(() => {
  const prisma = {
    $transaction: vi.fn(),
    member: {
      findMany: vi.fn(),
      findFirst: vi.fn(),
      findUnique: vi.fn(),
      upsert: vi.fn(),
      update: vi.fn(),
      delete: vi.fn(),
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
    roleHolderHistory: {
      updateMany: vi.fn(),
    },
    roleOnboardingSession: {
      updateMany: vi.fn(),
    },
    roleAssignment: {
      deleteMany: vi.fn(),
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
  return {
    prismaMock: prisma,
    selfServeOpsMock: {
      maybeCaptureSelfServeSetupEmail: vi.fn(),
    },
    sendEmailMock: vi.fn(),
    sharedEnv: {
      APP_URL: "https://app.example",
      RESEND_API_KEY: "resend-key",
      SESSION_LAST_SEEN_WRITE_INTERVAL_MS: 5 * 60 * 1000,
    },
  };
});

vi.mock("@corgtex/shared", () => ({
  prisma: prismaMock,
  hashPassword: vi.fn((value: string) => `hash:${value}`),
  randomOpaqueToken: vi.fn(() => "opaque-token"),
  sha256: vi.fn((value: string) => `sha:${value}`),
  normalizeWorkspaceSlug: vi.fn((value: string) => value.trim().toLowerCase().replace(/[^a-z0-9-]/g, "-")),
  sendEmail: sendEmailMock,
  parseAllowedWorkspaceIds: vi.fn(() => new Set<string>()),
  env: sharedEnv,
}));

vi.mock("./self-serve-ops", () => ({
  maybeCaptureSelfServeSetupEmail: selfServeOpsMock.maybeCaptureSelfServeSetupEmail,
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

const tenantAdminActor: AppActor = {
  kind: "user" as const,
  user: {
    id: "tenant-admin-user",
    email: "tenant-admin@example.com",
    displayName: "Tenant Admin",
    globalRole: "USER",
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
    prismaMock.member.findFirst.mockResolvedValue(null);
    prismaMock.user.findUnique.mockResolvedValue(null);
    prismaMock.workspaceFeatureFlag.findUnique.mockResolvedValue(null);
    prismaMock.roleHolderHistory.updateMany.mockResolvedValue({ count: 1 });
    prismaMock.roleOnboardingSession.updateMany.mockResolvedValue({ count: 1 });
    prismaMock.roleAssignment.deleteMany.mockResolvedValue({ count: 1 });
    sharedEnv.APP_URL = "https://app.example";
    sharedEnv.RESEND_API_KEY = "resend-key";
    sendEmailMock.mockResolvedValue({ id: "email-1" });
    selfServeOpsMock.maybeCaptureSelfServeSetupEmail.mockResolvedValue(null);
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
            avatarUrl: true,
            bio: true,
            linkedinUrl: true,
            websiteUrl: true,
          },
        },
      },
      orderBy: {
        joinedAt: "asc",
      },
    });
  });

  it("listHumanMembers uses the persisted server-trusted member kind", async () => {
    prismaMock.member.findMany.mockResolvedValue([{ id: "member-human" }]);

    const { listHumanMembers } = await import("./members");
    await expect(listHumanMembers("workspace-1")).resolves.toEqual([{ id: "member-human" }]);
    expect(prismaMock.member.findMany).toHaveBeenCalledWith(expect.objectContaining({
      where: expect.objectContaining({
        workspaceId: "workspace-1",
        isActive: true,
        kind: "HUMAN",
      }),
    }));
  });

  it("listSystemMembers uses the persisted server-trusted member kind", async () => {
    prismaMock.member.findMany.mockResolvedValue([{ id: "member-system" }]);

    const { listSystemMembers } = await import("./members");
    await expect(listSystemMembers("workspace-1")).resolves.toEqual([{ id: "member-system" }]);
    expect(prismaMock.member.findMany).toHaveBeenCalledWith(expect.objectContaining({
      where: expect.objectContaining({
        workspaceId: "workspace-1",
        isActive: true,
        kind: "SYSTEM",
      }),
    }));
  });

  it("createMember creates or reactivates a member and issues a setup token", async () => {
    prismaMock.user.upsert.mockResolvedValue({ id: "user-1", email: "user@example.com", displayName: "User" });
    prismaMock.member.upsert.mockResolvedValue({ id: "member-1", role: "ADMIN", kind: "HUMAN" });

    const { createMember } = await import("./members");
    await expect(createMember(actor, {
      workspaceId: "workspace-1",
      email: " USER@EXAMPLE.COM ",
      displayName: " User ",
      role: "ADMIN",
    })).resolves.toEqual({
      user: { id: "user-1", email: "user@example.com", displayName: "User" },
      member: { id: "member-1", role: "ADMIN", kind: "HUMAN" },
      token: "opaque-token",
    });

    expect(prismaMock.user.upsert).toHaveBeenCalledWith(expect.objectContaining({
      where: { email: "user@example.com" },
    }));
    expect(prismaMock.member.upsert).toHaveBeenCalledWith(expect.objectContaining({
      update: {
        role: "ADMIN",
        kind: "HUMAN",
        isActive: true,
      },
    }));
  });

  it("createMember rejects workspace A's reserved system address in workspace B before writes or token issuance", async () => {
    const { createMember } = await import("./members");
    await expect(createMember(tenantAdminActor, {
      workspaceId: "workspace-b",
      email: "SYSTEM+WORKSPACE-A@CORGTEX.LOCAL",
      displayName: "Not Human",
      role: "ADMIN",
    })).rejects.toMatchObject({ code: "CANONICAL_SYSTEM_ACTOR_COLLISION" });

    expect(prismaMock.$transaction).not.toHaveBeenCalled();
    expect(prismaMock.user.upsert).not.toHaveBeenCalled();
    expect(prismaMock.member.upsert).not.toHaveBeenCalled();
    expect(prismaMock.passwordResetToken.create).not.toHaveBeenCalled();
  });

  it("createMember rejects caller-controlled SYSTEM kind before writes", async () => {
    const { createMember } = await import("./members");
    await expect(createMember(tenantAdminActor, {
      workspaceId: "workspace-1",
      email: "person@example.com",
      displayName: "Person",
      role: "CONTRIBUTOR",
      kind: "SYSTEM",
    })).rejects.toMatchObject({ code: "INVALID_INPUT" });

    expect(prismaMock.$transaction).not.toHaveBeenCalled();
    expect(prismaMock.member.upsert).not.toHaveBeenCalled();
  });

  it("createMember persists HUMAN despite system-like caller-controlled email and display name", async () => {
    prismaMock.user.upsert.mockResolvedValue({
      id: "user-1",
      email: "support+person@example.com",
      displayName: "Corgtex Support",
    });
    prismaMock.member.upsert.mockResolvedValue({ id: "member-1", role: "CONTRIBUTOR", kind: "HUMAN" });
    const { createMember } = await import("./members");

    await createMember(actor, {
      workspaceId: "workspace-1",
      email: "support+person@example.com",
      displayName: "Corgtex Support",
      role: "CONTRIBUTOR",
    });

    expect(prismaMock.member.upsert).toHaveBeenCalledWith(expect.objectContaining({
      create: expect.objectContaining({ kind: "HUMAN" }),
      update: expect.objectContaining({ kind: "HUMAN" }),
    }));
  });

  it("createMember rejects an existing noncanonical system identity before user, member, or token writes", async () => {
    prismaMock.member.findFirst.mockResolvedValue({ id: "support-member" });
    const { createMember } = await import("./members");

    await expect(createMember(actor, {
      workspaceId: "workspace-1",
      email: "support+existing@corgtex.local",
      displayName: "Existing Support",
      role: "ADMIN",
    })).rejects.toMatchObject({ code: "SYSTEM_MEMBER_PROTECTED" });

    expect(prismaMock.user.upsert).not.toHaveBeenCalled();
    expect(prismaMock.member.upsert).not.toHaveBeenCalled();
    expect(prismaMock.passwordResetToken.updateMany).not.toHaveBeenCalled();
    expect(prismaMock.passwordResetToken.create).not.toHaveBeenCalled();
    expect(prismaMock.member.findFirst).toHaveBeenCalledWith({
      where: {
        kind: "SYSTEM",
        user: {
          email: {
            equals: "support+existing@corgtex.local",
            mode: "insensitive",
          },
        },
      },
      select: { id: true },
    });
  });

  it("bulkInviteMembers preserves valid entries when a reserved entry fails", async () => {
    prismaMock.user.upsert.mockResolvedValue({ id: "user-1", email: "valid@example.com", displayName: "Valid" });
    prismaMock.member.upsert.mockResolvedValue({ id: "member-1", role: "CONTRIBUTOR", kind: "HUMAN" });
    const { bulkInviteMembers } = await import("./members");

    await expect(bulkInviteMembers(actor, {
      workspaceId: "workspace-1",
      members: [
        { email: "system+workspace-1@corgtex.local" },
        { email: "valid@example.com", displayName: "Valid" },
      ],
    })).resolves.toEqual({
      invited: 1,
      details: [{ email: "valid@example.com", displayName: "Valid", token: "opaque-token" }],
      errors: [expect.stringContaining("system+workspace-1@corgtex.local")],
    });
    expect(prismaMock.user.upsert).toHaveBeenCalledTimes(1);
    expect(prismaMock.passwordResetToken.create).toHaveBeenCalledTimes(1);
  });

  it("updateMember rejects changing a human user to any reserved workspace system address before writes", async () => {
    const { updateMember } = await import("./members");

    await expect(updateMember(tenantAdminActor, {
      workspaceId: "workspace-b",
      memberId: "human-member",
      email: "system+workspace-a@corgtex.local",
    })).rejects.toMatchObject({ code: "CANONICAL_SYSTEM_ACTOR_COLLISION" });

    expect(prismaMock.$transaction).not.toHaveBeenCalled();
    expect(prismaMock.user.update).not.toHaveBeenCalled();
    expect(prismaMock.passwordResetToken.create).not.toHaveBeenCalled();
  });

  it("updateMember rejects caller-controlled member-kind changes before a transaction", async () => {
    const { updateMember } = await import("./members");
    await expect(updateMember(tenantAdminActor, {
      workspaceId: "workspace-1",
      memberId: "member-1",
      kind: "SYSTEM",
    })).rejects.toMatchObject({ code: "INVALID_INPUT" });
    expect(prismaMock.$transaction).not.toHaveBeenCalled();
  });

  it("updateMember protects the last active human admin using persisted member kind", async () => {
    prismaMock.member.findUnique.mockResolvedValue({
      id: "member-1",
      workspaceId: "workspace-1",
      userId: "user-1",
      role: "ADMIN",
      kind: "HUMAN",
      isActive: true,
      user: {
        id: "user-1",
        email: "admin@example.com",
        displayName: "Admin",
        ssoIdentities: [],
        _count: { memberships: 1 },
      },
    });
    prismaMock.member.count.mockResolvedValue(0);
    const { updateMember } = await import("./members");

    await expect(updateMember(actor, {
      workspaceId: "workspace-1",
      memberId: "member-1",
      role: "CONTRIBUTOR",
    })).rejects.toMatchObject({ code: "LAST_ADMIN" });

    expect(prismaMock.member.count).toHaveBeenCalledWith({
      where: {
        workspaceId: "workspace-1",
        role: "ADMIN",
        isActive: true,
        kind: "HUMAN",
        id: { not: "member-1" },
      },
    });
    expect(prismaMock.member.update).not.toHaveBeenCalled();
  });

  it("removeMember validates workspace ownership and protects canonical actors", async () => {
    prismaMock.member.findUnique.mockResolvedValue({
      id: "canonical-member",
      workspaceId: "workspace-b",
      userId: "canonical-user",
      role: "ADMIN",
      kind: "SYSTEM",
      isActive: true,
      user: { email: "system+workspace-b@corgtex.local" },
    });
    const { removeMember } = await import("./members");

    await expect(removeMember(actor, {
      workspaceId: "workspace-b",
      memberId: "canonical-member",
    })).rejects.toMatchObject({ code: "CANONICAL_SYSTEM_ACTOR_COLLISION" });
    expect(prismaMock.member.delete).not.toHaveBeenCalled();

    await expect(removeMember(actor, {
      workspaceId: "workspace-a",
      memberId: "canonical-member",
    })).rejects.toMatchObject({ code: "NOT_FOUND" });
    expect(prismaMock.member.delete).not.toHaveBeenCalled();
  });

  it("removeMember keeps normal human removal but protects the last active human admin", async () => {
    prismaMock.member.findUnique.mockResolvedValue({
      id: "member-1",
      workspaceId: "workspace-1",
      userId: "user-1",
      role: "ADMIN",
      kind: "HUMAN",
      isActive: true,
      user: { email: "admin@example.com" },
    });
    prismaMock.member.count.mockResolvedValueOnce(0).mockResolvedValueOnce(1);
    prismaMock.member.delete.mockResolvedValue({ id: "member-1" });
    const { removeMember } = await import("./members");

    await expect(removeMember(actor, {
      workspaceId: "workspace-1",
      memberId: "member-1",
    })).rejects.toMatchObject({ code: "LAST_ADMIN" });
    await expect(removeMember(actor, {
      workspaceId: "workspace-1",
      memberId: "member-1",
    })).resolves.toEqual({ id: "member-1" });
    expect(prismaMock.member.delete).toHaveBeenCalledWith({ where: { id: "member-1" } });
  });

  it("updateMember rejects every mutation of an existing reserved canonical system member", async () => {
    prismaMock.member.findUnique
      .mockResolvedValueOnce({
        id: "tenant-admin-member",
        workspaceId: "workspace-b",
        userId: "tenant-admin-user",
        role: "ADMIN",
        isActive: true,
      })
      .mockResolvedValueOnce({
        id: "canonical-member",
        workspaceId: "workspace-b",
        userId: "canonical-user",
        role: "ADMIN",
        kind: "SYSTEM",
        isActive: true,
        user: {
          id: "canonical-user",
          email: "system+workspace-b@corgtex.local",
          displayName: "Workspace B System",
          ssoIdentities: [],
          _count: { memberships: 1 },
        },
      });
    const { updateMember } = await import("./members");

    await expect(updateMember(tenantAdminActor, {
      workspaceId: "workspace-b",
      memberId: "canonical-member",
      role: "CONTRIBUTOR",
      isActive: false,
      displayName: "Changed",
      email: "human@example.com",
    })).rejects.toMatchObject({ code: "CANONICAL_SYSTEM_ACTOR_COLLISION" });

    expect(prismaMock.member.update).not.toHaveBeenCalled();
    expect(prismaMock.user.update).not.toHaveBeenCalled();
    expect(prismaMock.passwordResetToken.create).not.toHaveBeenCalled();
  });

  it("resendMemberAccessLink rejects a reserved canonical system member before issuing a token", async () => {
    prismaMock.member.findUnique
      .mockResolvedValueOnce({
        id: "tenant-admin-member",
        workspaceId: "workspace-b",
        userId: "tenant-admin-user",
        role: "ADMIN",
        isActive: true,
      })
      .mockResolvedValueOnce({
        id: "canonical-member",
        workspaceId: "workspace-b",
        userId: "canonical-user",
        role: "ADMIN",
        kind: "SYSTEM",
        isActive: true,
        user: {
          id: "canonical-user",
          email: "system+workspace-b@corgtex.local",
          displayName: "Workspace B System",
        },
      });
    const { resendMemberAccessLink } = await import("./members");

    await expect(resendMemberAccessLink(tenantAdminActor, {
      workspaceId: "workspace-b",
      memberId: "canonical-member",
    })).rejects.toMatchObject({ code: "CANONICAL_SYSTEM_ACTOR_COLLISION" });

    expect(prismaMock.passwordResetToken.updateMany).not.toHaveBeenCalled();
    expect(prismaMock.passwordResetToken.create).not.toHaveBeenCalled();
    expect(prismaMock.auditLog.create).not.toHaveBeenCalled();
  });

  it("generic update, deactivate, remove, and resend flows protect noncanonical SYSTEM members", async () => {
    const systemMember = {
      id: "support-member",
      workspaceId: "workspace-1",
      userId: "support-user",
      role: "ADMIN",
      kind: "SYSTEM",
      isActive: true,
      user: {
        id: "support-user",
        email: "support+session@corgtex.local",
        displayName: "Support Session",
        ssoIdentities: [],
        _count: { memberships: 1 },
      },
    };
    prismaMock.member.findUnique.mockResolvedValue(systemMember);
    const {
      deactivateMember,
      removeMember,
      resendMemberAccessLink,
      updateMember,
    } = await import("./members");

    await expect(updateMember(actor, {
      workspaceId: "workspace-1",
      memberId: "support-member",
      displayName: "Changed",
    })).rejects.toMatchObject({ code: "SYSTEM_MEMBER_PROTECTED" });
    await expect(deactivateMember(actor, {
      workspaceId: "workspace-1",
      memberId: "support-member",
    })).rejects.toMatchObject({ code: "SYSTEM_MEMBER_PROTECTED" });
    await expect(removeMember(actor, {
      workspaceId: "workspace-1",
      memberId: "support-member",
    })).rejects.toMatchObject({ code: "SYSTEM_MEMBER_PROTECTED" });
    await expect(resendMemberAccessLink(actor, {
      workspaceId: "workspace-1",
      memberId: "support-member",
    })).rejects.toMatchObject({ code: "SYSTEM_MEMBER_PROTECTED" });

    expect(prismaMock.user.update).not.toHaveBeenCalled();
    expect(prismaMock.member.update).not.toHaveBeenCalled();
    expect(prismaMock.member.delete).not.toHaveBeenCalled();
    expect(prismaMock.passwordResetToken.updateMany).not.toHaveBeenCalled();
    expect(prismaMock.passwordResetToken.create).not.toHaveBeenCalled();
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

  it("captures setup links for smoke domains when the email provider fails", async () => {
    sendEmailMock.mockRejectedValue(new Error("resend unavailable"));
    const { sendMemberSetupEmail } = await import("./members");

    await expect(sendMemberSetupEmail({
      email: " AGENT@SMOKE.EXAMPLE ",
      displayName: "Agent",
      token: "setup-token",
      workspaceName: "Smoke Workspace",
      workspaceId: "workspace-1",
      procurementTrialId: "trial-1",
      runId: "run-1",
    })).resolves.toEqual({
      email: "agent@smoke.example",
      sent: false,
      error: "resend unavailable",
    });

    expect(selfServeOpsMock.maybeCaptureSelfServeSetupEmail).toHaveBeenCalledWith({
      email: "agent@smoke.example",
      subject: "You've been invited to Corgtex",
      setupUrl: "https://app.example/setup-account/setup-token",
      providerStatus: { status: "FAILED", error: "resend unavailable" },
      workspaceId: "workspace-1",
      procurementTrialId: "trial-1",
      runId: "run-1",
      source: "member_setup",
    });
  });

  it("sends account setup emails with workspace onboarding context", async () => {
    const { sendMemberSetupEmail } = await import("./members");

    await expect(sendMemberSetupEmail({
      email: "agent@smoke.example",
      displayName: "Agent",
      token: "setup-token",
      workspaceName: "Smoke Workspace",
      workspaceId: "workspace-1",
      procurementTrialId: "trial-1",
      runId: "run-1",
    })).resolves.toEqual({
      email: "agent@smoke.example",
      sent: true,
    });

    expect(sendEmailMock).toHaveBeenCalledWith(expect.objectContaining({
      to: "agent@smoke.example",
      subject: "You've been invited to Corgtex",
      html: expect.stringContaining("Smoke Workspace is ready"),
    }));
    expect(sendEmailMock).toHaveBeenCalledWith(expect.objectContaining({
      html: expect.stringContaining("workspace newspaper"),
    }));
    expect(selfServeOpsMock.maybeCaptureSelfServeSetupEmail).toHaveBeenCalledWith(expect.objectContaining({
      email: "agent@smoke.example",
      setupUrl: "https://app.example/setup-account/setup-token",
      source: "member_setup",
    }));
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
        kind: "HUMAN",
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

  it("updateMember emits a member lifecycle outbox event", async () => {
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
      role: "CONTRIBUTOR",
      isActive: false,
      user: { id: "user-1", email: "user@example.com", displayName: "User" },
    });

    const { updateMember } = await import("./members");
    await updateMember(actor, {
      workspaceId: "workspace-1",
      memberId: "member-1",
      isActive: false,
    });

    expect(prismaMock.event.createMany).toHaveBeenCalledWith({
      data: [
        expect.objectContaining({
          workspaceId: "workspace-1",
          type: "member.deactivated",
          aggregateType: "Member",
          aggregateId: "member-1",
          payload: expect.objectContaining({ memberId: "member-1" }),
        }),
      ],
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
    expect(prismaMock.roleHolderHistory.updateMany).toHaveBeenCalledWith(expect.objectContaining({
      where: expect.objectContaining({
        workspaceId: "workspace-1",
        memberId: "member-1",
        endedAt: null,
      }),
      data: expect.objectContaining({
        endedAt: expect.any(Date),
        endedByUserId: "admin-user",
      }),
    }));
    expect(prismaMock.roleOnboardingSession.updateMany).toHaveBeenCalledWith(expect.objectContaining({
      where: expect.objectContaining({
        workspaceId: "workspace-1",
        memberId: "member-1",
        status: { in: ["PENDING", "ACTIVE"] },
      }),
      data: expect.objectContaining({
        status: "DISMISSED",
        dismissedAt: expect.any(Date),
      }),
    }));
    expect(prismaMock.roleAssignment.deleteMany).toHaveBeenCalledWith({
      where: {
        memberId: "member-1",
        role: { circle: { workspaceId: "workspace-1" } },
      },
    });
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
      user: { id: "user-1", avatarUrl: "https://example.com/avatar.png", bio: "Operations lead." },
    });
    prismaMock.meeting.findMany.mockResolvedValue([{ id: "meeting-1" }]);
    prismaMock.auditLog.findMany.mockResolvedValue([{ id: "audit-1" }]);
    prismaMock.proposal.findMany.mockResolvedValue([{ id: "proposal-1" }]);
    prismaMock.tension.findMany.mockResolvedValue([{ id: "tension-1" }]);

    const { getMemberProfile } = await import("./members");
    await expect(getMemberProfile(actor, "workspace-1", "member-1")).resolves.toMatchObject({
      member: { id: "member-1" },
      meetings: [{ id: "meeting-1" }],
      recentActivity: [{ id: "audit-1" }],
      proposals: [{ id: "proposal-1" }],
      authoredTensions: [{ id: "tension-1" }],
    });
    expect(prismaMock.member.findUnique).toHaveBeenCalledWith(expect.objectContaining({
      include: expect.objectContaining({
        user: {
          select: {
            id: true,
            email: true,
            displayName: true,
            avatarUrl: true,
            bio: true,
            linkedinUrl: true,
            websiteUrl: true,
          },
        },
        roleAssignments: expect.objectContaining({
          where: {
            role: {
              archivedAt: null,
              circle: {
                archivedAt: null,
              },
            },
          },
        }),
      }),
    }));
  });

  it("getMemberProfile filters recent governance records to what the viewer can open", async () => {
    const viewerActor: AppActor = {
      kind: "user",
      user: {
        id: "viewer-user",
        email: "viewer@example.com",
        displayName: "Viewer",
        globalRole: "USER",
      },
    };
    prismaMock.member.findUnique
      .mockResolvedValueOnce({
        id: "viewer-member",
        workspaceId: "workspace-1",
        userId: "viewer-user",
        role: "CONTRIBUTOR",
        isActive: true,
      })
      .mockResolvedValueOnce({
        id: "member-1",
        workspaceId: "workspace-1",
        user: { id: "profile-user", email: "profile@example.com" },
      });
    prismaMock.meeting.findMany.mockResolvedValue([]);
    prismaMock.auditLog.findMany.mockResolvedValue([]);
    prismaMock.proposal.findMany.mockResolvedValue([]);
    prismaMock.tension.findMany.mockResolvedValue([]);

    const { getMemberProfile } = await import("./members");
    await getMemberProfile(viewerActor, "workspace-1", "member-1");

    const visibleWhere = {
      archivedAt: null,
      OR: [
        { isPrivate: false },
        { isPrivate: true, status: "DRAFT", authorUserId: "viewer-user" },
      ],
    };
    expect(prismaMock.member.findUnique).toHaveBeenNthCalledWith(2, expect.objectContaining({
      include: expect.objectContaining({
        assignedTensions: expect.objectContaining({
          where: expect.objectContaining({
            status: "OPEN",
            ...visibleWhere,
          }),
        }),
      }),
    }));
    expect(prismaMock.proposal.findMany).toHaveBeenCalledWith(expect.objectContaining({
      where: expect.objectContaining({
        workspaceId: "workspace-1",
        authorUserId: "profile-user",
        ...visibleWhere,
      }),
    }));
    expect(prismaMock.tension.findMany).toHaveBeenCalledWith(expect.objectContaining({
      where: expect.objectContaining({
        workspaceId: "workspace-1",
        authorUserId: "profile-user",
        status: "OPEN",
        ...visibleWhere,
      }),
    }));
  });
});
