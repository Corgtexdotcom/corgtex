import { beforeEach, describe, expect, it, vi } from "vitest";
import type { AppActor } from "@corgtex/shared";

const { envMock, prismaMock } = vi.hoisted(() => {
  const prisma = {
    $transaction: vi.fn(),
    workspace: {
      findUnique: vi.fn(),
      create: vi.fn(),
      update: vi.fn(),
      upsert: vi.fn(),
      findMany: vi.fn(),
    },
    user: {
      findMany: vi.fn(),
      create: vi.fn(),
      update: vi.fn(),
    },
    member: {
      create: vi.fn(),
      upsert: vi.fn(),
    },
    approvalPolicy: {
      createMany: vi.fn(),
    },
    session: { deleteMany: vi.fn() },
    passwordResetToken: { updateMany: vi.fn() },
    oAuthAuthorizationCode: { updateMany: vi.fn() },
    oAuthAccessToken: { updateMany: vi.fn() },
    mcpOAuthAuthorizationCode: { updateMany: vi.fn() },
    mcpOAuthAccessToken: { updateMany: vi.fn() },
    appSession: { updateMany: vi.fn() },
  };
  return {
    envMock: {
      DEPLOYMENT_WORKSPACE_SCOPE_SLUG: undefined as string | undefined,
    },
    prismaMock: prisma,
  };
});

vi.mock("@corgtex/shared", () => ({
  env: envMock,
  normalizeWorkspaceSlug: (value: string) => value.trim().toLowerCase().replace(/[^a-z0-9-]/g, "-"),
  prisma: prismaMock,
  hashPassword: vi.fn((value: string) => `hash:${value}`),
  randomOpaqueToken: vi.fn(() => "opaque-system-password"),
}));

const actor: AppActor = {
  kind: "user" as const,
  user: {
    id: "user-1",
    email: "user@example.com",
    displayName: "User",
  },
};

describe("workspaces domain", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    envMock.DEPLOYMENT_WORKSPACE_SCOPE_SLUG = undefined;
    prismaMock.$transaction.mockImplementation(async (callback: (tx: typeof prismaMock) => Promise<unknown>) => callback(prismaMock));
    prismaMock.user.findMany.mockResolvedValue([]);
    prismaMock.user.create.mockResolvedValue({ id: "system-user-1" });
    prismaMock.user.update.mockResolvedValue({ id: "system-user-1" });
    prismaMock.member.create.mockResolvedValue({});
    prismaMock.member.upsert.mockResolvedValue({});
    prismaMock.approvalPolicy.createMany.mockResolvedValue({ count: 2 });
  });

  it("createWorkspace creates a workspace with owner membership and default policies", async () => {
    prismaMock.workspace.findUnique.mockResolvedValue(null);
    prismaMock.workspace.create.mockResolvedValue({ id: "workspace-1", slug: "new-workspace", name: "New Workspace" });

    const { createWorkspace } = await import("./workspaces");
    await expect(createWorkspace(actor, {
      name: " New Workspace ",
      slug: "New Workspace!",
      description: " Description ",
    })).resolves.toEqual({ id: "workspace-1", slug: "new-workspace", name: "New Workspace" });

    expect(prismaMock.workspace.create).toHaveBeenCalledWith({
      data: {
        name: "New Workspace",
        slug: "new-workspace-",
        description: "Description",
      },
    });
    expect(prismaMock.member.create).toHaveBeenCalledWith({
      data: {
        workspaceId: "workspace-1",
        userId: "user-1",
        role: "ADMIN",
        isActive: true,
      },
    });
    expect(prismaMock.user.create).toHaveBeenCalledWith({
      data: {
        email: "system+new-workspace@corgtex.local",
        displayName: "New Workspace System",
        passwordHash: "disabled$canonical-workspace-system-actor-v1",
      },
      select: { id: true },
    });
    expect(prismaMock.member.upsert).toHaveBeenCalledWith(expect.objectContaining({
      update: { role: "ADMIN", kind: "SYSTEM", isActive: true },
      create: expect.objectContaining({ role: "ADMIN", kind: "SYSTEM", isActive: true }),
    }));
    expect(prismaMock.approvalPolicy.createMany).toHaveBeenCalledWith({
      data: [expect.objectContaining({ workspaceId: "workspace-1", subjectType: "PROPOSAL" })],
      skipDuplicates: true,
    });
  });

  it("reconciles only an existing exact canonical system identity", async () => {
    prismaMock.user.findMany.mockResolvedValue([{
      id: "system-user-1",
      email: "system+new-workspace@corgtex.local",
      globalRole: "USER",
      passwordHash: "legacy-known-hash",
      ssoIdentities: [],
      oauthConnections: [],
      externalMcpConnections: [],
      memberships: [{
        workspaceId: "workspace-1",
        role: "ADMIN",
        kind: "SYSTEM",
        isActive: true,
        mergedAt: null,
        mergedIntoMemberId: null,
      }],
    }]);

    const { ensureCanonicalWorkspaceBaseline } = await import("./workspaces");
    await ensureCanonicalWorkspaceBaseline(prismaMock as never, {
      id: "workspace-1",
      slug: "new-workspace",
      name: "New Workspace",
    });

    expect(prismaMock.user.create).not.toHaveBeenCalled();
    expect(prismaMock.user.update).toHaveBeenCalledWith({
      where: { id: "system-user-1" },
      data: { passwordHash: "disabled$canonical-workspace-system-actor-v1" },
      select: { id: true },
    });
    expect(prismaMock.session.deleteMany).toHaveBeenCalledWith({ where: { userId: "system-user-1" } });
    expect(prismaMock.passwordResetToken.updateMany).toHaveBeenCalledWith({
      where: { userId: "system-user-1", usedAt: null },
      data: { usedAt: expect.any(Date) },
    });
    expect(prismaMock.oAuthAccessToken.updateMany).toHaveBeenCalledWith({
      where: { userId: "system-user-1", revokedAt: null },
      data: { revokedAt: expect.any(Date) },
    });
    expect(prismaMock.mcpOAuthAccessToken.updateMany).toHaveBeenCalledWith({
      where: { userId: "system-user-1", revokedAt: null },
      data: { revokedAt: expect.any(Date) },
    });
    expect(prismaMock.appSession.updateMany).toHaveBeenCalledWith({
      where: { actorUserId: "system-user-1", revokedAt: null },
      data: { revokedAt: expect.any(Date) },
    });
    expect(prismaMock.member.upsert).toHaveBeenCalledWith(expect.objectContaining({
      where: {
        workspaceId_userId: {
          workspaceId: "workspace-1",
          userId: "system-user-1",
        },
      },
    }));
  });

  it("does not churn an already-disabled canonical password marker", async () => {
    prismaMock.user.findMany.mockResolvedValue([{
      id: "system-user-1",
      email: "system+new-workspace@corgtex.local",
      globalRole: "USER",
      passwordHash: "disabled$canonical-workspace-system-actor-v1",
      ssoIdentities: [],
      oauthConnections: [],
      externalMcpConnections: [],
      memberships: [{
        workspaceId: "workspace-1",
        role: "ADMIN",
        kind: "SYSTEM",
        isActive: true,
        mergedAt: null,
        mergedIntoMemberId: null,
      }],
    }]);

    const { ensureCanonicalWorkspaceBaseline } = await import("./workspaces");
    await ensureCanonicalWorkspaceBaseline(prismaMock as never, {
      id: "workspace-1",
      slug: "new-workspace",
      name: "New Workspace",
    });

    expect(prismaMock.user.update).not.toHaveBeenCalled();
    expect(prismaMock.session.deleteMany).toHaveBeenCalledWith({ where: { userId: "system-user-1" } });
  });

  it.each([
    {
      label: "case-insensitive alias",
      users: [{ id: "alias", email: "System+new-workspace@corgtex.local", memberships: [] }],
    },
    {
      label: "orphaned exact user",
      users: [{
        id: "orphan",
        email: "system+new-workspace@corgtex.local",
        globalRole: "USER",
        passwordHash: "legacy-known-hash",
        ssoIdentities: [],
        oauthConnections: [],
        externalMcpConnections: [],
        memberships: [],
      }],
    },
    {
      label: "foreign member",
      users: [{
        id: "foreign",
        email: "system+new-workspace@corgtex.local",
        globalRole: "USER",
        passwordHash: "legacy-known-hash",
        ssoIdentities: [],
        oauthConnections: [],
        externalMcpConnections: [],
        memberships: [{
          workspaceId: "foreign-workspace",
          role: "ADMIN",
          kind: "SYSTEM",
          isActive: true,
          mergedAt: null,
          mergedIntoMemberId: null,
        }],
      }],
    },
    {
      label: "human member",
      users: [{
        id: "human",
        email: "system+new-workspace@corgtex.local",
        globalRole: "USER",
        passwordHash: "legacy-known-hash",
        ssoIdentities: [],
        oauthConnections: [],
        externalMcpConnections: [],
        memberships: [{
          workspaceId: "workspace-1",
          role: "ADMIN",
          kind: "HUMAN",
          isActive: true,
          mergedAt: null,
          mergedIntoMemberId: null,
        }],
      }],
    },
    {
      label: "merged system member",
      users: [{
        id: "merged",
        email: "system+new-workspace@corgtex.local",
        globalRole: "USER",
        passwordHash: "legacy-known-hash",
        ssoIdentities: [],
        oauthConnections: [],
        externalMcpConnections: [],
        memberships: [{
          workspaceId: "workspace-1",
          role: "ADMIN",
          kind: "SYSTEM",
          isActive: true,
          mergedAt: new Date("2026-08-01T00:00:00.000Z"),
          mergedIntoMemberId: "replacement-member",
        }],
      }],
    },
    {
      label: "global operator",
      users: [{
        id: "operator",
        email: "system+new-workspace@corgtex.local",
        globalRole: "OPERATOR",
        passwordHash: "legacy-known-hash",
        ssoIdentities: [],
        oauthConnections: [],
        externalMcpConnections: [],
        memberships: [{
          workspaceId: "workspace-1",
          role: "ADMIN",
          kind: "SYSTEM",
          isActive: true,
          mergedAt: null,
          mergedIntoMemberId: null,
        }],
      }],
    },
    {
      label: "SSO-linked canonical user",
      users: [{
        id: "sso-linked",
        email: "system+new-workspace@corgtex.local",
        globalRole: "USER",
        passwordHash: "legacy-known-hash",
        ssoIdentities: [{ id: "sso-identity" }],
        oauthConnections: [],
        externalMcpConnections: [],
        memberships: [{
          workspaceId: "workspace-1",
          role: "ADMIN",
          kind: "SYSTEM",
          isActive: true,
          mergedAt: null,
          mergedIntoMemberId: null,
        }],
      }],
    },
    {
      label: "OAuth-connected canonical user",
      users: [{
        id: "oauth-linked",
        email: "system+new-workspace@corgtex.local",
        globalRole: "USER",
        passwordHash: "legacy-known-hash",
        ssoIdentities: [],
        oauthConnections: [{ id: "oauth-connection" }],
        externalMcpConnections: [],
        memberships: [{
          workspaceId: "workspace-1",
          role: "ADMIN",
          kind: "SYSTEM",
          isActive: true,
          mergedAt: null,
          mergedIntoMemberId: null,
        }],
      }],
    },
    {
      label: "outbound MCP-connected canonical user",
      users: [{
        id: "mcp-linked",
        email: "system+new-workspace@corgtex.local",
        globalRole: "USER",
        passwordHash: "legacy-known-hash",
        ssoIdentities: [],
        oauthConnections: [],
        externalMcpConnections: [{ id: "external-mcp-connection" }],
        memberships: [{
          workspaceId: "workspace-1",
          role: "ADMIN",
          kind: "SYSTEM",
          isActive: true,
          mergedAt: null,
          mergedIntoMemberId: null,
        }],
      }],
    },
  ])("fails closed for an incompatible canonical identity: $label", async ({ users }) => {
    prismaMock.user.findMany.mockResolvedValue(users);

    const { ensureCanonicalWorkspaceBaseline } = await import("./workspaces");
    await expect(ensureCanonicalWorkspaceBaseline(prismaMock as never, {
      id: "workspace-1",
      slug: "new-workspace",
      name: "New Workspace",
    })).rejects.toMatchObject({ code: "CANONICAL_SYSTEM_ACTOR_COLLISION" });

    expect(prismaMock.user.create).not.toHaveBeenCalled();
    expect(prismaMock.member.upsert).not.toHaveBeenCalled();
    expect(prismaMock.approvalPolicy.createMany).not.toHaveBeenCalled();
  });

  it("createWorkspace allows the normalized configured dedicated workspace slug", async () => {
    envMock.DEPLOYMENT_WORKSPACE_SCOPE_SLUG = "customer-alpha";
    prismaMock.workspace.findUnique.mockResolvedValue(null);
    prismaMock.workspace.create.mockResolvedValue({ id: "workspace-1", slug: "customer-alpha", name: "Customer Alpha" });

    const { createWorkspace } = await import("./workspaces");
    await expect(createWorkspace(actor, {
      name: "Customer Alpha",
      slug: " Customer Alpha ",
    })).resolves.toMatchObject({ id: "workspace-1", slug: "customer-alpha" });

    expect(prismaMock.$transaction).toHaveBeenCalledTimes(1);
  });

  it("createWorkspace rejects a foreign slug before starting a transaction", async () => {
    envMock.DEPLOYMENT_WORKSPACE_SCOPE_SLUG = "customer-alpha";

    const { createWorkspace } = await import("./workspaces");
    await expect(createWorkspace(actor, {
      name: "Foreign Workspace",
      slug: "foreign-workspace",
    })).rejects.toMatchObject({
      status: 403,
      code: "WORKSPACE_SCOPE_MISMATCH",
    });

    expect(prismaMock.$transaction).not.toHaveBeenCalled();
  });

  it("createWorkspace rejects another workspace's reserved system address as its human owner", async () => {
    const { createWorkspace } = await import("./workspaces");
    await expect(createWorkspace({
      kind: "user",
      user: {
        id: "system-user",
        email: "SYSTEM+OTHER-WORKSPACE@CORGTEX.LOCAL",
        displayName: "Not Human",
      },
    }, {
      name: "Workspace",
      slug: "workspace",
    })).rejects.toMatchObject({ code: "CANONICAL_SYSTEM_ACTOR_COLLISION" });

    expect(prismaMock.$transaction).not.toHaveBeenCalled();
  });

  it("reserves the entire workspace system email namespace case-insensitively", async () => {
    const { assertNonReservedWorkspaceSystemEmail } = await import("./workspaces");

    expect(() => assertNonReservedWorkspaceSystemEmail(" System+foreign@Corgtex.Local "))
      .toThrow("Reserved workspace system identity cannot be used as a human member.");
    expect(() => assertNonReservedWorkspaceSystemEmail("system+not.a.normalized_slug@corgtex.local"))
      .toThrow("Reserved workspace system identity cannot be used as a human member.");
    expect(() => assertNonReservedWorkspaceSystemEmail("system+@corgtex.local"))
      .toThrow("Reserved workspace system identity cannot be used as a human member.");
    expect(() => assertNonReservedWorkspaceSystemEmail("human@corgtex.local")).not.toThrow();
  });

  it("createWorkspace rejects a missing name", async () => {
    const { createWorkspace } = await import("./workspaces");
    await expect(createWorkspace(actor, {
      name: " ",
      slug: "workspace",
    })).rejects.toMatchObject({
      status: 400,
      code: "INVALID_INPUT",
    });
  });

  it("ensures a workspace through one atomic upsert before establishing the baseline", async () => {
    prismaMock.workspace.upsert.mockResolvedValue({ id: "workspace-1", slug: "new-workspace", name: "New Workspace" });

    const { ensureCanonicalWorkspace } = await import("./workspaces");
    await expect(ensureCanonicalWorkspace(prismaMock as never, {
      name: " New Workspace ",
      slug: "New Workspace",
      description: " Description ",
    })).resolves.toMatchObject({ id: "workspace-1" });

    expect(prismaMock.workspace.upsert).toHaveBeenCalledWith({
      where: { slug: "new-workspace" },
      update: { slug: "new-workspace" },
      create: {
        name: "New Workspace",
        slug: "new-workspace",
        description: "Description",
      },
    });
    expect(prismaMock.workspace.findUnique).not.toHaveBeenCalled();
  });

  it("listWorkspaces returns active user workspaces", async () => {
    prismaMock.workspace.findMany.mockResolvedValue([{ id: "workspace-1" }]);

    const { listWorkspaces } = await import("./workspaces");
    await expect(listWorkspaces(actor)).resolves.toEqual([{ id: "workspace-1" }]);
    expect(prismaMock.workspace.findMany).toHaveBeenCalledWith({
      where: {
        members: {
          some: {
            userId: "user-1",
            isActive: true,
          },
        },
      },
      orderBy: { createdAt: "desc" },
    });
  });
});
