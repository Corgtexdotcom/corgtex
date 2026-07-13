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
});
