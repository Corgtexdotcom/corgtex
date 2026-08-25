import { afterEach, describe, expect, it, vi } from "vitest";

const findMany = vi.fn();

vi.mock("@corgtex/shared", () => ({
  env: { DEPLOYMENT_WORKSPACE_SCOPE_SLUG: undefined },
  prisma: {
    workspace: {
      findMany,
    },
  },
  hashPassword: vi.fn(),
  randomOpaqueToken: vi.fn(),
  sha256: vi.fn(),
  verifyPassword: vi.fn(),
}));

afterEach(() => {
  vi.clearAllMocks();
  vi.resetModules();
});

describe("listActorWorkspaces", () => {
  it("uses authenticated agent workspaceIds before the global allowlist", async () => {
    findMany.mockResolvedValue([]);

    const { listActorWorkspaces } = await import("./auth");

    await listActorWorkspaces({
      kind: "agent",
      authProvider: "credential",
      credentialId: "cred-1",
      label: "ops-agent",
      workspaceIds: ["ws-1"],
      scopes: [],
    });

    expect(findMany).toHaveBeenCalledWith(expect.objectContaining({
      where: { id: { in: ["ws-1"] } },
    }));
  });

  it("does not fall back to ambient configuration when the authenticated actor is unscoped", async () => {
    findMany.mockResolvedValue([]);

    const { listActorWorkspaces } = await import("./auth");

    await expect(listActorWorkspaces({
      kind: "agent",
      authProvider: "bootstrap",
      label: "bootstrap-agent",
      workspaceIds: [],
    })).resolves.toEqual([]);

    expect(findMany).not.toHaveBeenCalled();
  });

  it("lists every workspace for global operators", async () => {
    findMany.mockResolvedValue([]);

    const { listActorWorkspaces, requireWorkspaceMembership } = await import("./auth");

    await listActorWorkspaces({
      kind: "user",
      user: {
        id: "user-1",
        email: "operator@example.com",
        displayName: "Operator",
        globalRole: "OPERATOR",
      },
    });

    expect(findMany.mock.calls[0]?.[0].where).toBeUndefined();

    const membership = await requireWorkspaceMembership({
      actor: {
        kind: "user",
        user: {
          id: "user-1",
          email: "operator@example.com",
          displayName: "Operator",
          globalRole: "OPERATOR",
        },
      },
      workspaceId: "ws-1",
      allowedRoles: ["ADMIN"],
    });

    expect(membership).toEqual({
      id: "global-operator",
      workspaceId: "ws-1",
      userId: "user-1",
      role: "ADMIN",
      isActive: true,
    });
  });
});
