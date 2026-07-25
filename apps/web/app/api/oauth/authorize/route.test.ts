import { NextRequest } from "next/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const {
  getMcpOAuthClientByClientId,
  getMcpPublicUrl,
  getOAuthAppByClientId,
  isAllowedMcpRedirectUri,
  isAllowedOAuthRedirectUri,
  issueAuthorizationCode,
  issueMcpAuthorizationCode,
  listActorWorkspaces,
  requirePageActor,
} = vi.hoisted(() => ({
  getMcpOAuthClientByClientId: vi.fn(),
  getMcpPublicUrl: vi.fn(),
  getOAuthAppByClientId: vi.fn(),
  isAllowedMcpRedirectUri: vi.fn(),
  isAllowedOAuthRedirectUri: vi.fn(),
  issueAuthorizationCode: vi.fn(),
  issueMcpAuthorizationCode: vi.fn(),
  listActorWorkspaces: vi.fn(),
  requirePageActor: vi.fn(),
}));

vi.mock("@/lib/auth", () => ({
  requirePageActor,
}));

vi.mock("@corgtex/domain", () => ({
  getMcpOAuthClientByClientId,
  getMcpPublicUrl,
  getOAuthAppByClientId,
  isAllowedMcpRedirectUri,
  isAllowedOAuthRedirectUri,
  issueAuthorizationCode,
  issueMcpAuthorizationCode,
  listActorWorkspaces,
}));

vi.mock("@/lib/http", () => ({
  handleRouteError: (error: Error & { status?: number; code?: string }) => Response.json({
    error: { code: error.code ?? "INTERNAL_ERROR", message: error.message },
  }, { status: error.status ?? 500 }),
}));

function authorizePost(body: Record<string, string>) {
  return new NextRequest("https://customer-alpha.corgtex.test/api/oauth/authorize", {
    method: "POST",
    headers: {
      accept: "application/json",
      "content-type": "application/json",
    },
    body: JSON.stringify(body),
  });
}

beforeEach(() => {
  vi.resetModules();
  vi.stubEnv("APP_URL", "https://customer-alpha.corgtex.test");
  vi.stubEnv("WORKSPACE_SLUG", "customer-alpha");
  requirePageActor.mockResolvedValue({
    kind: "user",
    user: { id: "user-1", email: "user@example.com" },
  });
  listActorWorkspaces.mockResolvedValue([
    { id: "ws-hidden", slug: "corgtex-validation", name: "Corgtex Internal Validation" },
    { id: "ws-customer-alpha", slug: "customer-alpha", name: "Customer Alpha" },
  ]);
  getMcpPublicUrl.mockReturnValue("https://customer-alpha.corgtex.test/mcp");
});

afterEach(() => {
  vi.clearAllMocks();
  vi.unstubAllEnvs();
});

describe("POST /api/oauth/authorize", () => {
  it("rejects direct MCP authorization for hidden workspaces on dedicated deployments", async () => {
    getMcpOAuthClientByClientId.mockResolvedValueOnce({ id: "client-db-1" });

    const { POST } = await import("./route");
    const response = await POST(authorizePost({
      clientId: "mcp-client",
      redirectUri: "https://client.example.test/callback",
      workspaceId: "ws-hidden",
      codeChallenge: "challenge",
      codeChallengeMethod: "S256",
    }));

    expect(response.status).toBe(403);
    await expect(response.json()).resolves.toEqual({
      error: "access_denied",
      message: "This workspace is not available on this deployment.",
    });
    expect(issueMcpAuthorizationCode).not.toHaveBeenCalled();
  });

  it("rejects OAuth app authorization when the app workspace is hidden on dedicated deployments", async () => {
    getMcpOAuthClientByClientId.mockResolvedValueOnce(null);
    getOAuthAppByClientId.mockResolvedValueOnce({
      workspaceId: "ws-hidden",
      scopes: ["workspace:read"],
    });

    const { POST } = await import("./route");
    const response = await POST(authorizePost({
      clientId: "oauth-app",
      redirectUri: "https://client.example.test/callback",
    }));

    expect(response.status).toBe(403);
    await expect(response.json()).resolves.toEqual({
      error: "access_denied",
      message: "This workspace is not available on this deployment.",
    });
    expect(issueAuthorizationCode).not.toHaveBeenCalled();
  });
});
