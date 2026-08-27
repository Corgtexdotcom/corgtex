import { beforeEach, describe, expect, it, vi } from "vitest";
import type { AppActor } from "@corgtex/shared";

const {
  prismaMock,
  randomOpaqueTokenMock,
  requireWorkspaceMembershipMock,
  sha256Mock,
} = vi.hoisted(() => ({
  prismaMock: {
    oAuthApp: {
      findUnique: vi.fn(),
    },
    oAuthAuthorizationCode: {
      create: vi.fn(),
      findUnique: vi.fn(),
      update: vi.fn(),
    },
    oAuthAccessToken: {
      findFirst: vi.fn(),
      findUnique: vi.fn(),
      update: vi.fn(),
      create: vi.fn(),
    },
    user: {
      findUnique: vi.fn(),
    },
  },
  randomOpaqueTokenMock: vi.fn(),
  requireWorkspaceMembershipMock: vi.fn(),
  sha256Mock: vi.fn((value: string) => `hash:${value}`),
}));

vi.mock("@corgtex/shared", () => ({
  prisma: prismaMock,
  randomOpaqueToken: randomOpaqueTokenMock,
  sha256: sha256Mock,
}));

vi.mock("./auth", () => ({
  requireWorkspaceMembership: requireWorkspaceMembershipMock,
}));

vi.mock("./workspaces", () => ({
  isCanonicalWorkspaceSystemEmail: (email: string) => /^system\+[a-z0-9-]+@corgtex\.local$/i.test(email.trim()),
}));

const actor: AppActor = {
  kind: "user",
  user: {
    id: "user-1",
    email: "user@example.com",
    displayName: "User",
    globalRole: "USER",
  },
};

describe("OAuth server domain", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    randomOpaqueTokenMock.mockReturnValue("authorization-token");
    requireWorkspaceMembershipMock.mockResolvedValue({
      id: "member-1",
      workspaceId: "workspace-1",
      userId: "user-1",
      role: "MEMBER",
      isActive: true,
    });
    prismaMock.oAuthApp.findUnique.mockResolvedValue({
      id: "oauth-app-1",
      workspaceId: "workspace-1",
      clientId: "client-1",
      clientSecret: "hash:client-secret",
      redirectUris: ["https://chatgpt.com/aip/g-example/oauth/callback"],
      scopes: ["chat", "read"],
      isActive: true,
      archivedAt: null,
    });
    prismaMock.oAuthAuthorizationCode.create.mockResolvedValue({
      id: "authorization-code-1",
    });
  });

  it("persists a hashed authorization code and returns the raw code once", async () => {
    const { issueAuthorizationCode } = await import("./oauth-server");

    await expect(issueAuthorizationCode(actor, {
      clientId: "client-1",
      workspaceId: "workspace-1",
      redirectUri: "https://chatgpt.com/aip/g-example/oauth/callback",
      scopes: ["chat"],
    })).resolves.toBe("code_authorization-token");

    expect(requireWorkspaceMembershipMock).toHaveBeenCalledWith({
      actor,
      workspaceId: "workspace-1",
    });
    expect(prismaMock.oAuthAuthorizationCode.create).toHaveBeenCalledWith({
      data: {
        appId: "oauth-app-1",
        userId: "user-1",
        workspaceId: "workspace-1",
        code: "hash:code_authorization-token",
        redirectUri: "https://chatgpt.com/aip/g-example/oauth/callback",
        scopes: ["chat"],
        expiresAt: expect.any(Date),
      },
    });
  });

  it("rejects canonical identities before issuing authorization codes", async () => {
    const { issueAuthorizationCode } = await import("./oauth-server");
    const canonicalActor = {
      ...actor,
      user: { ...actor.user, email: "system+workspace-1@corgtex.local" },
    };

    await expect(issueAuthorizationCode(canonicalActor, {
      clientId: "client-1",
      workspaceId: "workspace-1",
      redirectUri: "https://chatgpt.com/aip/g-example/oauth/callback",
      scopes: ["chat"],
    })).rejects.toMatchObject({ code: "FORBIDDEN" });
    expect(prismaMock.oAuthApp.findUnique).not.toHaveBeenCalled();
    expect(prismaMock.oAuthAuthorizationCode.create).not.toHaveBeenCalled();
  });

  it("rejects a canonical authorization code before consuming it or issuing tokens", async () => {
    prismaMock.oAuthAuthorizationCode.findUnique.mockResolvedValue({
      id: "authorization-code-1",
      appId: "oauth-app-1",
      userId: "system-user-1",
      workspaceId: "workspace-1",
      redirectUri: "https://chatgpt.com/aip/g-example/oauth/callback",
      scopes: ["chat"],
      usedAt: null,
      expiresAt: new Date(Date.now() + 60_000),
    });
    prismaMock.user.findUnique.mockResolvedValue({ email: "system+workspace-1@corgtex.local" });
    const { exchangeAuthorizationCode } = await import("./oauth-server");

    await expect(exchangeAuthorizationCode({
      code: "code",
      clientId: "client-1",
      clientSecret: "client-secret",
      redirectUri: "https://chatgpt.com/aip/g-example/oauth/callback",
    })).rejects.toMatchObject({ code: "INVALID_INPUT" });
    expect(prismaMock.oAuthAuthorizationCode.update).not.toHaveBeenCalled();
    expect(prismaMock.oAuthAccessToken.create).not.toHaveBeenCalled();
  });

  it("rejects canonical refresh tokens before rotation", async () => {
    prismaMock.oAuthAccessToken.findUnique.mockResolvedValue({
      id: "access-token-1",
      appId: "oauth-app-1",
      userId: "system-user-1",
      scopes: ["chat"],
      revokedAt: null,
      refreshExpiresAt: new Date(Date.now() + 60_000),
    });
    prismaMock.user.findUnique.mockResolvedValue({ email: "system+workspace-1@corgtex.local" });
    const { refreshAccessToken } = await import("./oauth-server");

    await expect(refreshAccessToken({
      refreshToken: "refresh-token",
      clientId: "client-1",
      clientSecret: "client-secret",
    })).rejects.toMatchObject({ code: "UNAUTHENTICATED" });
    expect(prismaMock.oAuthAccessToken.update).not.toHaveBeenCalled();
  });

  it("resolves canonical access tokens to null", async () => {
    prismaMock.oAuthAccessToken.findFirst.mockResolvedValue({
      id: "access-token-1",
      appId: "oauth-app-1",
      userId: "system-user-1",
      workspaceId: "workspace-1",
      scopes: ["chat"],
      revokedAt: null,
      expiresAt: new Date(Date.now() + 60_000),
    });
    prismaMock.user.findUnique.mockResolvedValue({
      id: "system-user-1",
      email: "system+workspace-1@corgtex.local",
      displayName: "Workspace System",
      globalRole: "USER",
    });
    const { resolveOAuthAccessToken } = await import("./oauth-server");

    await expect(resolveOAuthAccessToken("access-token")).resolves.toBeNull();
  });
});
