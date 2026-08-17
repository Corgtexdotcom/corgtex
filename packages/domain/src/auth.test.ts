import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AppActor } from "@corgtex/shared";

const { prismaMock, envMock, verifyPasswordMock } = vi.hoisted(() => ({
  prismaMock: {
    user: {
      findUnique: vi.fn(),
      create: vi.fn(),
    },
    session: {
      create: vi.fn(),
      findUnique: vi.fn(),
      updateMany: vi.fn(),
      deleteMany: vi.fn(),
    },
    member: {
      findUnique: vi.fn(),
      findFirst: vi.fn(),
    },
    workspace: {
      findUnique: vi.fn(),
      findFirst: vi.fn(),
      findMany: vi.fn(),
    },
  },
  envMock: {
    SESSION_LAST_SEEN_WRITE_INTERVAL_MS: 5 * 60 * 1000,
    DEPLOYMENT_WORKSPACE_SCOPE_SLUG: undefined as string | undefined,
  },
  verifyPasswordMock: vi.fn(),
}));

vi.mock("@corgtex/shared", () => ({
  env: envMock,
  prisma: prismaMock,
  hashPassword: vi.fn((value: string) => `hash-password:${value}`),
  randomOpaqueToken: vi.fn(() => "plain-token"),
  normalizeWorkspaceSlug: (value: string) => value.trim().toLowerCase().replace(/[^a-z0-9-]/g, "-"),
  sha256: vi.fn((value: string) => `hash:${value}`),
  verifyPassword: verifyPasswordMock,
}));

const userActor: AppActor = {
  kind: "user" as const,
  user: {
    id: "user-1",
    email: "user@example.com",
    displayName: "User",
  },
};

const operatorActor: AppActor = {
  kind: "user" as const,
  user: {
    id: "operator-1",
    email: "operator@example.com",
    displayName: "Operator",
    globalRole: "OPERATOR",
  },
};

const agentActor: AppActor = {
  kind: "agent" as const,
  authProvider: "credential" as const,
  label: "Test Agent",
  workspaceIds: ["workspace-1"],
};

describe("auth domain", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-04-24T12:00:00.000Z"));
    vi.clearAllMocks();
    envMock.DEPLOYMENT_WORKSPACE_SCOPE_SLUG = undefined;
    prismaMock.session.create.mockResolvedValue({});
    prismaMock.session.updateMany.mockResolvedValue({ count: 1 });
    prismaMock.session.deleteMany.mockResolvedValue({ count: 1 });
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  describe("loginUserWithPassword", () => {
    it("creates a session for valid credentials", async () => {
      prismaMock.user.findUnique.mockResolvedValue({
        id: "user-1",
        email: "user@example.com",
        displayName: "User",
        globalRole: null,
        passwordHash: "stored-hash",
      });
      verifyPasswordMock.mockReturnValue(true);

      const { loginUserWithPassword } = await import("./auth");
      const result = await loginUserWithPassword({
        email: " USER@EXAMPLE.COM ",
        password: "password123",
      });

      expect(prismaMock.user.findUnique).toHaveBeenCalledWith({
        where: { email: "user@example.com" },
        select: {
          id: true,
          email: true,
          displayName: true,
          globalRole: true,
          passwordHash: true,
        },
      });
      expect(prismaMock.session.create).toHaveBeenCalledWith({
        data: {
          userId: "user-1",
          tokenHash: "hash:plain-token",
          expiresAt: new Date("2026-05-08T12:00:00.000Z"),
        },
      });
      expect(result).toMatchObject({
        token: "plain-token",
        user: {
          id: "user-1",
          email: "user@example.com",
          displayName: "User",
          globalRole: null,
        },
      });
    });

    it("rejects a wrong password", async () => {
      prismaMock.user.findUnique.mockResolvedValue({
        id: "user-1",
        email: "user@example.com",
        displayName: "User",
        globalRole: null,
        passwordHash: "stored-hash",
      });
      verifyPasswordMock.mockReturnValue(false);

      const { loginUserWithPassword } = await import("./auth");
      await expect(loginUserWithPassword({ email: "user@example.com", password: "password123" })).rejects.toMatchObject({
        status: 401,
        code: "UNAUTHENTICATED",
      });
    });

    it("rejects a missing email", async () => {
      const { loginUserWithPassword } = await import("./auth");
      await expect(loginUserWithPassword({ email: " ", password: "password123" })).rejects.toMatchObject({
        status: 400,
        code: "INVALID_INPUT",
      });
    });

    it("rejects a canonical workspace system identity before password verification", async () => {
      const { loginUserWithPassword } = await import("./auth");
      await expect(loginUserWithPassword({
        email: " System+Workspace-1@Corgtex.Local ",
        password: "password123",
      })).rejects.toMatchObject({ status: 401, code: "UNAUTHENTICATED" });

      expect(prismaMock.user.findUnique).not.toHaveBeenCalled();
      expect(verifyPasswordMock).not.toHaveBeenCalled();
      expect(prismaMock.session.create).not.toHaveBeenCalled();
    });
  });

  describe("registerUser", () => {
    it("creates a user with a normalized email", async () => {
      prismaMock.user.findUnique.mockResolvedValue(null);
      prismaMock.user.create.mockResolvedValue({
        id: "user-1",
        email: "new@example.com",
        displayName: "New User",
      });

      const { registerUser } = await import("./auth");
      await expect(registerUser({ email: " NEW@EXAMPLE.COM ", password: "password123", displayName: " New User " })).resolves.toEqual({
        id: "user-1",
        email: "new@example.com",
        displayName: "New User",
      });
      expect(prismaMock.user.create).toHaveBeenCalledWith({
        data: {
          email: "new@example.com",
          displayName: "New User",
          passwordHash: "hash-password:password123",
        },
        select: {
          id: true,
          email: true,
          displayName: true,
        },
      });
    });

    it("rejects a duplicate user", async () => {
      prismaMock.user.findUnique.mockResolvedValue({ id: "existing-user" });

      const { registerUser } = await import("./auth");
      await expect(registerUser({ email: "user@example.com", password: "password123" })).rejects.toMatchObject({
        status: 409,
        code: "ALREADY_EXISTS",
      });
    });

    it("rejects a short password", async () => {
      const { registerUser } = await import("./auth");
      await expect(registerUser({ email: "user@example.com", password: "short" })).rejects.toMatchObject({
        status: 400,
        code: "INVALID_INPUT",
      });
    });

    it("rejects registration in the canonical workspace system namespace", async () => {
      const { registerUser } = await import("./auth");
      await expect(registerUser({
        email: "system+workspace-1@corgtex.local",
        password: "password123",
      })).rejects.toMatchObject({ code: "CANONICAL_SYSTEM_ACTOR_COLLISION" });
      expect(prismaMock.user.create).not.toHaveBeenCalled();
    });
  });

  describe("createSession", () => {
    it("rejects a canonical workspace system identity before issuing a token", async () => {
      prismaMock.user.findUnique.mockResolvedValue({ email: "system+workspace-1@corgtex.local" });
      const { createSession } = await import("./auth");

      await expect(createSession("system-user-1")).rejects.toMatchObject({ code: "UNAUTHENTICATED" });
      expect(prismaMock.session.create).not.toHaveBeenCalled();
    });
  });

  describe("actorUserIdForWorkspace", () => {
    it("authorizes the agent independently and returns only the exact inactive canonical system administrator", async () => {
      prismaMock.workspace.findUnique.mockResolvedValue({ slug: "workspace-1" });
      prismaMock.member.findFirst.mockResolvedValue({ userId: "system-user-1" });

      const { actorUserIdForWorkspace } = await import("./auth");
      await expect(actorUserIdForWorkspace(agentActor, "workspace-1")).resolves.toBe("system-user-1");

      expect(prismaMock.member.findFirst).toHaveBeenCalledWith({
        where: {
          workspaceId: "workspace-1",
          isActive: false,
          role: "ADMIN",
          kind: "SYSTEM",
          mergedAt: null,
          mergedIntoMemberId: null,
          user: {
            email: "system+workspace-1@corgtex.local",
            globalRole: "USER",
            passwordHash: "disabled$canonical-workspace-system-actor-v1",
            ssoIdentities: { none: {} },
            oauthConnections: { none: {} },
            externalMcpConnections: { none: {} },
            memberships: {
              none: {
                workspaceId: { not: "workspace-1" },
              },
            },
          },
        },
        select: { userId: true },
      });
    });

    it("rejects an unauthorized agent before looking up the attribution principal", async () => {
      const { actorUserIdForWorkspace } = await import("./auth");

      await expect(actorUserIdForWorkspace({
        ...agentActor,
        workspaceIds: ["workspace-other"],
      }, "workspace-1")).rejects.toMatchObject({ status: 403, code: "FORBIDDEN" });

      expect(prismaMock.workspace.findUnique).not.toHaveBeenCalled();
      expect(prismaMock.member.findFirst).not.toHaveBeenCalled();
    });

    it("fails closed instead of falling back to a human administrator", async () => {
      prismaMock.workspace.findUnique.mockResolvedValue({ slug: "workspace-1" });
      prismaMock.member.findFirst.mockResolvedValue(null);

      const { actorUserIdForWorkspace } = await import("./auth");
      await expect(actorUserIdForWorkspace(agentActor, "workspace-1")).rejects.toMatchObject({
        status: 500,
        code: "CONFIG_ERROR",
      });

      expect(prismaMock.member.findFirst).toHaveBeenCalledTimes(1);
    });

    it("returns a human actor directly without a workspace lookup", async () => {
      const { actorUserIdForWorkspace } = await import("./auth");
      await expect(actorUserIdForWorkspace(userActor, "workspace-1")).resolves.toBe("user-1");
      expect(prismaMock.workspace.findUnique).not.toHaveBeenCalled();
      expect(prismaMock.member.findFirst).not.toHaveBeenCalled();
    });
  });

  describe("resolveSessionActor", () => {
    it("returns a user actor for a valid session", async () => {
      prismaMock.session.findUnique.mockResolvedValue({
        id: "session-1",
        expiresAt: new Date("2026-04-25T12:00:00.000Z"),
        lastSeenAt: new Date("2026-04-24T12:00:00.000Z"),
        user: {
          id: "user-1",
          email: "user@example.com",
          displayName: "User",
        },
      });

      const { resolveSessionActor } = await import("./auth");
      await expect(resolveSessionActor("plain-token")).resolves.toEqual(userActor);
    });

    it("returns null for an expired session", async () => {
      prismaMock.session.findUnique.mockResolvedValue({
        id: "session-1",
        expiresAt: new Date("2026-04-24T11:59:00.000Z"),
        lastSeenAt: new Date("2026-04-24T11:00:00.000Z"),
        user: userActor.user,
      });

      const { resolveSessionActor } = await import("./auth");
      await expect(resolveSessionActor("plain-token")).resolves.toBeNull();
    });

    it("returns null for a missing session", async () => {
      prismaMock.session.findUnique.mockResolvedValue(null);

      const { resolveSessionActor } = await import("./auth");
      await expect(resolveSessionActor("plain-token")).resolves.toBeNull();
    });

    it("returns null for a canonical workspace system session without refreshing it", async () => {
      prismaMock.session.findUnique.mockResolvedValue({
        id: "session-1",
        expiresAt: new Date("2026-04-25T12:00:00.000Z"),
        lastSeenAt: new Date("2026-04-24T11:00:00.000Z"),
        user: {
          id: "system-user-1",
          email: "system+workspace-1@corgtex.local",
          displayName: "Workspace System",
        },
      });

      const { resolveSessionActor } = await import("./auth");
      await expect(resolveSessionActor("plain-token")).resolves.toBeNull();
      expect(prismaMock.session.updateMany).not.toHaveBeenCalled();
    });
  });

  describe("requireWorkspaceMembership", () => {
    it("returns an active user membership", async () => {
      const membership = {
        id: "member-1",
        workspaceId: "workspace-1",
        userId: "user-1",
        role: "ADMIN",
        isActive: true,
      };
      prismaMock.member.findUnique.mockResolvedValue(membership);

      const { requireWorkspaceMembership } = await import("./auth");
      await expect(requireWorkspaceMembership({ actor: userActor, workspaceId: "workspace-1" })).resolves.toEqual(membership);
    });

    it("rejects a user with no active membership", async () => {
      prismaMock.member.findUnique.mockResolvedValue(null);

      const { requireWorkspaceMembership } = await import("./auth");
      await expect(requireWorkspaceMembership({ actor: userActor, workspaceId: "workspace-1" })).rejects.toMatchObject({
        status: 403,
        code: "NOT_A_MEMBER",
      });
    });

    it("allows an agent for an allowed workspace", async () => {
      const { requireWorkspaceMembership } = await import("./auth");
      await expect(requireWorkspaceMembership({ actor: agentActor, workspaceId: "workspace-1" })).resolves.toBeNull();
    });

    it("blocks an agent from a disallowed workspace", async () => {
      const { requireWorkspaceMembership } = await import("./auth");
      await expect(requireWorkspaceMembership({ actor: agentActor, workspaceId: "workspace-2" })).rejects.toMatchObject({
        status: 403,
        code: "FORBIDDEN",
      });
    });

    it("fails closed when an agent has no workspace scope", async () => {
      const { requireWorkspaceMembership } = await import("./auth");
      await expect(requireWorkspaceMembership({
        actor: { ...agentActor, workspaceIds: [] },
        workspaceId: "workspace-1",
      })).rejects.toMatchObject({
        status: 403,
        code: "AGENT_WORKSPACE_SCOPE_REQUIRED",
      });
    });

    it("does not let a resolved human membership bypass agent workspace scope", async () => {
      const { requireWorkspaceMembership } = await import("./auth");
      await expect(requireWorkspaceMembership({
        actor: { ...agentActor, workspaceIds: [] },
        workspaceId: "workspace-1",
        resolvedMembership: {
          id: "member-1",
          workspaceId: "workspace-1",
          userId: "user-1",
          role: "ADMIN",
          isActive: true,
        },
      })).rejects.toMatchObject({
        status: 403,
        code: "AGENT_WORKSPACE_SCOPE_REQUIRED",
      });
    });

    it("enforces dedicated deployment scope before user membership authorization", async () => {
      envMock.DEPLOYMENT_WORKSPACE_SCOPE_SLUG = "customer-alpha";
      prismaMock.workspace.findFirst.mockResolvedValue(null);

      const { requireWorkspaceMembership } = await import("./auth");
      await expect(requireWorkspaceMembership({ actor: userActor, workspaceId: "workspace-other" })).rejects.toMatchObject({
        status: 403,
        code: "WORKSPACE_SCOPE_MISMATCH",
      });
      expect(prismaMock.member.findUnique).not.toHaveBeenCalled();
    });

    it("allows the configured dedicated workspace before checking membership", async () => {
      envMock.DEPLOYMENT_WORKSPACE_SCOPE_SLUG = "customer-alpha";
      prismaMock.workspace.findFirst.mockResolvedValue({ id: "workspace-1" });
      const membership = {
        id: "member-1",
        workspaceId: "workspace-1",
        userId: "user-1",
        role: "ADMIN",
        isActive: true,
      };
      prismaMock.member.findUnique.mockResolvedValue(membership);

      const { requireWorkspaceMembership } = await import("./auth");
      await expect(requireWorkspaceMembership({ actor: userActor, workspaceId: "workspace-1" })).resolves.toEqual(membership);
      expect(prismaMock.workspace.findFirst).toHaveBeenCalledWith({
        where: { id: "workspace-1", slug: "customer-alpha" },
        select: { id: true },
      });
    });

    it("returns an admin membership for a global operator", async () => {
      const { requireWorkspaceMembership } = await import("./auth");
      await expect(requireWorkspaceMembership({ actor: operatorActor, workspaceId: "workspace-1" })).resolves.toMatchObject({
        id: "global-operator",
        role: "ADMIN",
        isActive: true,
      });
    });
  });

  it("clears a session by token hash", async () => {
    const { clearSession } = await import("./auth");
    await clearSession("plain-token");
    expect(prismaMock.session.deleteMany).toHaveBeenCalledWith({
      where: {
        tokenHash: "hash:plain-token",
      },
    });
  });

  it("detects global operators", async () => {
    const { isGlobalOperator } = await import("./auth");
    expect(isGlobalOperator(operatorActor)).toBe(true);
    expect(isGlobalOperator(userActor)).toBe(false);
  });

  describe("listActorWorkspaces", () => {
    it("lists workspaces for a user membership", async () => {
      prismaMock.workspace.findMany.mockResolvedValue([{ id: "workspace-1" }]);

      const { listActorWorkspaces } = await import("./auth");
      await listActorWorkspaces(userActor);

      expect(prismaMock.workspace.findMany).toHaveBeenCalledWith({
        where: {
          members: {
            some: {
              userId: "user-1",
              isActive: true,
            },
          },
        },
        select: {
          id: true,
          slug: true,
          name: true,
          description: true,
        },
        orderBy: { name: "asc" },
      });
    });

    it("limits agent workspaces to explicit IDs", async () => {
      prismaMock.workspace.findMany.mockResolvedValue([{ id: "workspace-1" }]);

      const { listActorWorkspaces } = await import("./auth");
      await listActorWorkspaces(agentActor);

      expect(prismaMock.workspace.findMany).toHaveBeenCalledWith(expect.objectContaining({
        where: { id: { in: ["workspace-1"] } },
      }));
    });

    it("returns no workspaces for an unscoped agent", async () => {
      const { listActorWorkspaces } = await import("./auth");
      await expect(listActorWorkspaces({ ...agentActor, workspaceIds: [] })).resolves.toEqual([]);
      expect(prismaMock.workspace.findMany).not.toHaveBeenCalled();
    });

    it("limits workspace listings to the configured dedicated workspace", async () => {
      envMock.DEPLOYMENT_WORKSPACE_SCOPE_SLUG = "customer-alpha";
      prismaMock.workspace.findMany.mockResolvedValue([{ id: "workspace-1", slug: "customer-alpha" }]);

      const { listActorWorkspaces } = await import("./auth");
      await listActorWorkspaces(agentActor);

      expect(prismaMock.workspace.findMany).toHaveBeenCalledWith(expect.objectContaining({
        where: { id: { in: ["workspace-1"] }, slug: "customer-alpha" },
      }));
    });

    it("lists all workspaces for a global operator", async () => {
      prismaMock.workspace.findMany.mockResolvedValue([{ id: "workspace-1" }]);

      const { listActorWorkspaces } = await import("./auth");
      await listActorWorkspaces(operatorActor);

      expect(prismaMock.workspace.findMany).toHaveBeenCalledWith({
        select: {
          id: true,
          slug: true,
          name: true,
          description: true,
        },
        orderBy: { name: "asc" },
      });
    });
  });
});
