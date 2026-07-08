import { NextRequest, NextResponse } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

const {
  authenticateMcpRequestMock,
  createCorgtexMcpServerMock,
  handleRouteErrorMock,
} = vi.hoisted(() => ({
  authenticateMcpRequestMock: vi.fn(),
  createCorgtexMcpServerMock: vi.fn(),
  handleRouteErrorMock: vi.fn((error: unknown) => NextResponse.json({ error: String(error) }, { status: 500 })),
}));

class MockAppError extends Error {
  constructor(public status: number, public code: string, message: string) {
    super(message);
  }
}

class MockMcpInsufficientScopeError extends MockAppError {
  requiredScope: string;
  grantedScopes: string[];

  constructor(params: { requiredScope: string; grantedScopes?: string[] }) {
    super(403, "MCP_INSUFFICIENT_SCOPE", `Missing required permission: ${params.requiredScope}`);
    this.requiredScope = params.requiredScope;
    this.grantedScopes = params.grantedScopes ?? [];
  }
}

vi.mock("@corgtex/domain", () => ({
  ALL_SCOPES: ["workspace:read", "brain:read"],
  MCP_CONNECTOR_DEFAULT_SCOPES: ["workspace:read", "brain:read"],
  MCP_TOOL_CAPABILITIES: {
    create_action: { scopes: ["actions:write"] },
  },
  AppError: MockAppError,
  getMcpPublicUrl: (origin: string) => `${origin}/mcp`,
}));

vi.mock("@corgtex/mcp", () => ({
  authenticateMcpRequest: authenticateMcpRequestMock,
  createCorgtexMcpServer: createCorgtexMcpServerMock,
  McpInsufficientScopeError: MockMcpInsufficientScopeError,
}));

vi.mock("@/lib/http", () => ({
  handleRouteError: handleRouteErrorMock,
}));

describe("MCP route OAuth discovery", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("returns protected-resource OAuth metadata", async () => {
    const { GET } = await import("../../.well-known/oauth-protected-resource/route");
    const response = await GET(new NextRequest("https://internal.test/.well-known/oauth-protected-resource", {
      headers: { host: "mcp.corgtex.com" },
    }));
    const body = await response.json();

    expect(response.headers.get("cache-control")).toBe("public, max-age=300");
    expect(body).toMatchObject({
      resource: "https://mcp.corgtex.com/mcp",
      authorization_servers: ["https://mcp.corgtex.com"],
      bearer_methods_supported: ["header"],
      scopes_supported: ["workspace:read", "brain:read"],
    });
  });

  it("returns path-suffixed protected-resource OAuth metadata", async () => {
    const { GET: getMcpMetadata } = await import("../../.well-known/oauth-protected-resource/mcp/route");
    const mcpResponse = await getMcpMetadata(new NextRequest("https://internal.test/.well-known/oauth-protected-resource/mcp", {
      headers: { host: "mcp.corgtex.com" },
    }));
    await expect(mcpResponse.json()).resolves.toMatchObject({
      resource: "https://mcp.corgtex.com/mcp",
      scopes_supported: ["workspace:read", "brain:read"],
    });

    const { GET: getApiMcpMetadata } = await import("../../.well-known/oauth-protected-resource/api/mcp/route");
    const apiResponse = await getApiMcpMetadata(new NextRequest("https://internal.test/.well-known/oauth-protected-resource/api/mcp", {
      headers: { host: "mcp.corgtex.com" },
    }));
    await expect(apiResponse.json()).resolves.toMatchObject({
      resource: "https://mcp.corgtex.com/mcp",
      scopes_supported: ["workspace:read", "brain:read"],
    });
  });

  it("returns authorization-server OAuth metadata with PKCE and dynamic registration", async () => {
    const { GET } = await import("../../.well-known/oauth-authorization-server/route");
    const response = await GET(new NextRequest("https://internal.test/.well-known/oauth-authorization-server", {
      headers: { host: "mcp.corgtex.com" },
    }));
    const body = await response.json();

    expect(response.headers.get("cache-control")).toBe("public, max-age=300");
    expect(body).toMatchObject({
      issuer: "https://mcp.corgtex.com",
      authorization_endpoint: "https://mcp.corgtex.com/api/oauth/authorize",
      token_endpoint: "https://mcp.corgtex.com/api/oauth/token",
      registration_endpoint: "https://mcp.corgtex.com/api/oauth/register",
      grant_types_supported: ["authorization_code", "refresh_token"],
      code_challenge_methods_supported: ["S256"],
      token_endpoint_auth_methods_supported: ["none", "client_secret_basic", "client_secret_post"],
      client_id_metadata_document_supported: true,
      scopes_supported: ["workspace:read", "brain:read"],
    });
  });

  it("returns a resource_metadata challenge before MCP transport handling when auth is missing", async () => {
    authenticateMcpRequestMock.mockRejectedValueOnce(
      new MockAppError(401, "UNAUTHENTICATED", "Missing or invalid Authorization header."),
    );

    const { POST } = await import("./route");
    const response = await POST(new NextRequest("https://internal.test/api/mcp", {
      method: "POST",
      headers: { host: "mcp.corgtex.com" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: {} }),
    }));
    const body = await response.json();

    expect(response.status).toBe(401);
    expect(response.headers.get("www-authenticate")).toBe(
      'Bearer error="invalid_token", resource_metadata="https://mcp.corgtex.com/.well-known/oauth-protected-resource", scope="workspace:read brain:read"',
    );
    expect(body).toEqual({
      error: {
        code: "UNAUTHENTICATED",
        message: "Missing or invalid Authorization header.",
      },
    });
    expect(createCorgtexMcpServerMock).not.toHaveBeenCalled();
  });

  it("returns an insufficient_scope challenge when an OAuth tool call needs a missing scope", async () => {
    authenticateMcpRequestMock.mockResolvedValueOnce({
      actor: { kind: "user", user: { id: "user-1", email: "user@example.com", displayName: "User" } },
      authKind: "oauth",
      workspaceId: "ws-1",
      scopes: ["workspace:read"],
    });

    const { POST } = await import("./route");
    const response = await POST(new NextRequest("https://internal.test/api/mcp", {
      method: "POST",
      headers: { host: "mcp.corgtex.com" },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "tools/call",
        params: { name: "create_action", arguments: {} },
      }),
    }));
    const body = await response.json();

    expect(response.status).toBe(403);
    expect(response.headers.get("www-authenticate")).toBe(
      'Bearer error="insufficient_scope", resource_metadata="https://mcp.corgtex.com/.well-known/oauth-protected-resource", scope="workspace:read actions:write"',
    );
    expect(body).toEqual({
      error: {
        code: "MCP_INSUFFICIENT_SCOPE",
        message: "Missing required permission: actions:write",
      },
    });
    expect(createCorgtexMcpServerMock).not.toHaveBeenCalled();
  });
});
