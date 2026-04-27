import { describe, expect, it, vi, beforeEach } from "vitest";

const resolveAgentActorFromBearerMock = vi.fn();
const resolveMcpOAuthAccessTokenMock = vi.fn();

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
  };
});

vi.mock("@corgtex/shared", () => ({
  env: { APP_URL: "https://app.test" },
}));

describe("authenticateMcpRequest", () => {
  beforeEach(() => {
    resolveAgentActorFromBearerMock.mockReset();
    resolveMcpOAuthAccessTokenMock.mockReset();
  });

  it("resolves MCP OAuth bearer tokens with workspace, scopes, and instance binding", async () => {
    resolveAgentActorFromBearerMock.mockResolvedValue(null);
    resolveMcpOAuthAccessTokenMock.mockResolvedValue({
      actor: { kind: "user", user: { id: "user-1", email: "user@example.com", displayName: "User" } },
      workspaceId: "ws-1",
      scopes: ["brain:read"],
      instanceSlug: "crina",
      resource: "https://mcp.corgtex.com/mcp",
    });

    const { authenticateMcpRequest } = await import("./auth");
    const ctx = await authenticateMcpRequest("Bearer mcp_at_token", {
      resourceUrl: "https://mcp.corgtex.com/mcp",
    });

    expect(resolveMcpOAuthAccessTokenMock).toHaveBeenCalledWith("mcp_at_token", "https://mcp.corgtex.com/mcp");
    expect(ctx).toMatchObject({
      authKind: "oauth",
      workspaceId: "ws-1",
      scopes: ["brain:read"],
      instanceSlug: "crina",
    });
  });

  it("enforces scopes for OAuth connector sessions", async () => {
    const { requireScope } = await import("./auth");

    expect(() => requireScope({
      actor: { kind: "user", user: { id: "user-1", email: "user@example.com", displayName: "User" } },
      authKind: "oauth",
      workspaceId: "ws-1",
      scopes: ["brain:read"],
      instanceSlug: "crina",
    }, "actions:write")).toThrow("MCP credential is missing the required scope");
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
