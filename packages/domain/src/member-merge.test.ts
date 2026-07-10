import { beforeEach, describe, expect, it, vi } from "vitest";
import type { AppActor } from "@corgtex/shared";

const { prismaMock, requireWorkspaceMembershipMock } = vi.hoisted(() => {
  function relationModel() {
    return {
      findUnique: vi.fn(),
      findFirst: vi.fn(),
      upsert: vi.fn(),
    };
  }

  return {
    requireWorkspaceMembershipMock: vi.fn(),
    prismaMock: {
      $transaction: vi.fn(),
      member: relationModel(),
      memberEmailAlias: relationModel(),
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

describe("member alias domain", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    prismaMock.$transaction.mockImplementation(async (callback: (tx: typeof prismaMock) => Promise<unknown>) => callback(prismaMock));
    requireWorkspaceMembershipMock.mockResolvedValue({ id: "admin-member", role: "ADMIN", isActive: true });
    prismaMock.member.findUnique.mockResolvedValue({
      id: "member-1",
      workspaceId: "workspace-1",
      user: { email: "member@example.com" },
    });
    prismaMock.member.findFirst.mockResolvedValue(null);
    prismaMock.memberEmailAlias.findUnique.mockResolvedValue(null);
    prismaMock.memberEmailAlias.upsert.mockResolvedValue({ id: "alias-1", email: "alias@example.com" });
  });

  it("adds a normalized alias for a workspace member", async () => {
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
});
