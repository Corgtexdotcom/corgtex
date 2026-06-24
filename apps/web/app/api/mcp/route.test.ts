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

vi.mock("@corgtex/domain", () => ({
  ALL_SCOPES: ["workspace:read", "brain:read"],
  AppError: MockAppError,
  getMcpPublicUrl: (origin: string) => `${origin}/mcp`,
}));

vi.mock("@corgtex/mcp", () => ({
  authenticateMcpRequest: authenticateMcpRequestMock,
  createCorgtexMcpServer: createCorgtexMcpServerMock,
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
      'Bearer resource_metadata="https://mcp.corgtex.com/.well-known/oauth-protected-resource"',
    );
    expect(body).toEqual({
      error: {
        code: "UNAUTHENTICATED",
        message: "Missing or invalid Authorization header.",
      },
    });
    expect(createCorgtexMcpServerMock).not.toHaveBeenCalled();
  });
});
