import { describe, expect, it, vi, beforeEach } from "vitest";

const resolveAgentActorFromBearerMock = vi.fn();
const resolveMcpOAuthAccessTokenMock = vi.fn();
const requireTrialMcpAccessMock = vi.fn();
const requireWorkspaceMembershipMock = vi.fn();

vi.mock("@corgtex/domain", () => {
  class AppError extends Error {
    constructor(public status: number, public code: string, message: string) {
      super(message);
    }
  }

  return {
    AppError,
    describeScope: (scope: string) => `Description for ${scope}`,
    resolveAgentActorFromBearer: resolveAgentActorFromBearerMock,
    resolveMcpOAuthAccessToken: resolveMcpOAuthAccessTokenMock,
    requireTrialMcpAccess: requireTrialMcpAccessMock,
    requireWorkspaceMembership: requireWorkspaceMembershipMock,
  };
});

vi.mock("@corgtex/shared", () => ({
  env: { APP_URL: "https://app.test" },
}));

describe("authenticateMcpRequest", () => {
  beforeEach(() => {
    resolveAgentActorFromBearerMock.mockReset();
    resolveMcpOAuthAccessTokenMock.mockReset();
    requireTrialMcpAccessMock.mockReset().mockResolvedValue(null);
    requireWorkspaceMembershipMock.mockReset().mockResolvedValue(null);
  });

  it("resolves MCP OAuth bearer tokens with workspace, scopes, and instance binding", async () => {
    resolveAgentActorFromBearerMock.mockResolvedValue(null);
    resolveMcpOAuthAccessTokenMock.mockResolvedValue({
      actor: { kind: "user", user: { id: "user-1", email: "user@example.com", displayName: "User" } },
      workspaceId: "ws-1",
      scopes: ["brain:read"],
      instanceSlug: "client-a",
      resource: "https://mcp.corgtex.com/mcp",
      clientId: "client-1",
      clientName: "Claude",
      providerKey: "claude",
    });

    const { authenticateMcpRequest } = await import("./auth");
    const ctx = await authenticateMcpRequest("Bearer mcp_at_token", {
      resourceUrl: "https://mcp.corgtex.com/mcp",
    });

    expect(resolveMcpOAuthAccessTokenMock).toHaveBeenCalledWith("mcp_at_token", "https://mcp.corgtex.com/mcp");
    expect(requireWorkspaceMembershipMock).toHaveBeenCalledWith({
      actor: expect.objectContaining({ kind: "user" }),
      workspaceId: "ws-1",
    });
    expect(requireTrialMcpAccessMock).toHaveBeenCalledWith("ws-1");
    expect(ctx).toMatchObject({
      authKind: "oauth",
      workspaceId: "ws-1",
      scopes: ["brain:read"],
      instanceSlug: "client-a",
      clientId: "client-1",
      clientName: "Claude",
      providerKey: "claude",
    });
  });

  it("accepts a single-workspace agent credential and authorizes that exact workspace", async () => {
    const actor = {
      kind: "agent",
      authProvider: "bootstrap",
      label: "bootstrap-agent",
      workspaceIds: ["ws-1"],
    };
    resolveAgentActorFromBearerMock.mockResolvedValue(actor);

    const { authenticateMcpRequest } = await import("./auth");
    await expect(authenticateMcpRequest("Bearer agent-token")).resolves.toMatchObject({
      actor,
      authKind: "agent",
      workspaceId: "ws-1",
    });
    expect(requireWorkspaceMembershipMock).toHaveBeenCalledWith({ actor, workspaceId: "ws-1" });
  });

  it("rejects an agent credential with no workspace scope", async () => {
    resolveAgentActorFromBearerMock.mockResolvedValue({
      kind: "agent",
      authProvider: "bootstrap",
      label: "bootstrap-agent",
      workspaceIds: [],
    });

    const { authenticateMcpRequest } = await import("./auth");
    await expect(authenticateMcpRequest("Bearer agent-token")).rejects.toMatchObject({
      status: 403,
      code: "MCP_WORKSPACE_SCOPE_REQUIRED",
    });
    expect(requireWorkspaceMembershipMock).not.toHaveBeenCalled();
  });

  it("rejects a multi-workspace agent credential instead of choosing the first workspace", async () => {
    resolveAgentActorFromBearerMock.mockResolvedValue({
      kind: "agent",
      authProvider: "bootstrap",
      label: "bootstrap-agent",
      workspaceIds: ["ws-1", "ws-2"],
    });

    const { authenticateMcpRequest } = await import("./auth");
    await expect(authenticateMcpRequest("Bearer agent-token")).rejects.toMatchObject({
      status: 403,
      code: "MCP_WORKSPACE_SCOPE_REQUIRED",
    });
    expect(requireWorkspaceMembershipMock).not.toHaveBeenCalled();
  });

  it("enforces scopes for OAuth connector sessions", async () => {
    const { McpInsufficientScopeError, requireScope } = await import("./auth");

    expect(() => requireScope({
      actor: { kind: "user", user: { id: "user-1", email: "user@example.com", displayName: "User" } },
      authKind: "oauth",
      workspaceId: "ws-1",
      scopes: ["brain:read"],
      instanceSlug: "client-a",
    }, "actions:write")).toThrow("Missing required permission: actions:write");
    try {
      requireScope({
        actor: { kind: "user", user: { id: "user-1", email: "user@example.com", displayName: "User" } },
        authKind: "oauth",
        workspaceId: "ws-1",
        scopes: ["brain:read"],
        instanceSlug: "client-a",
      }, "actions:write");
      throw new Error("Expected scope error");
    } catch (error) {
      expect(error).toBeInstanceOf(McpInsufficientScopeError);
      expect(error).toMatchObject({
        code: "MCP_INSUFFICIENT_SCOPE",
        requiredScope: "actions:write",
        grantedScopes: ["brain:read"],
      });
    }
  });

  it("OAuth scope errors point users at the workspace MCP setup page for self-service reconnect", async () => {
    const { requireScope } = await import("./auth");

    expect(() => requireScope({
      actor: { kind: "user", user: { id: "user-1", email: "user@example.com", displayName: "User" } },
      authKind: "oauth",
      workspaceId: "ws-1",
      scopes: ["brain:read"],
      instanceSlug: "client-a",
    }, "actions:write")).toThrow("https://app.test/workspaces/ws-1/tools?type=CONNECTOR&q=corgtex%20mcp");
  });

  it("allows sensitive tool credentials only when the OAuth session has the delegated scope", async () => {
    const { requireScope } = await import("./auth");
    const ctx = {
      actor: { kind: "user" as const, user: { id: "user-1", email: "user@example.com", displayName: "User" } },
      authKind: "oauth" as const,
      workspaceId: "ws-1",
      scopes: ["tools:read", "tools:credentials:read"],
      instanceSlug: "client-a",
    };

    expect(() => requireScope(ctx, "tools:credentials:read")).not.toThrow();
    expect(() => requireScope({ ...ctx, scopes: ["tools:read"] }, "tools:credentials:read")).toThrow("Missing required permission: tools:credentials:read");
  });

  it("keeps bootstrap agent credentials unrestricted", async () => {
    const { requireScope } = await import("./auth");

    expect(() => requireScope({
      actor: { kind: "agent", authProvider: "bootstrap", label: "bootstrap-agent" },
      authKind: "agent",
      workspaceId: "ws-1",
    }, "actions:write")).not.toThrow();
  });
});
