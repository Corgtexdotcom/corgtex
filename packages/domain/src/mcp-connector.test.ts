import { afterEach, describe, expect, it, vi } from "vitest";

const ORIGINAL_ENV = { ...process.env };

function restoreEnv() {
  for (const key of Object.keys(process.env)) {
    delete process.env[key];
  }
  Object.assign(process.env, ORIGINAL_ENV);
}

afterEach(() => {
  restoreEnv();
  vi.doUnmock("@corgtex/shared");
  vi.clearAllMocks();
  vi.resetModules();
});

function installSharedMock(prismaMock: Record<string, any>) {
  vi.doMock("@corgtex/shared", () => ({
    prisma: prismaMock,
    env: {
      APP_URL: "https://app.test",
      MCP_INSTANCE_REGISTRY: undefined,
      MCP_DEFAULT_INSTANCE_SLUG: undefined,
      MCP_PUBLIC_URL: undefined,
      WORKSPACE_SLUG: undefined,
      AGENT_API_KEY: undefined,
    },
    hashPassword: vi.fn((value: string) => `hash:${value}`),
    parseAllowedWorkspaceIds: vi.fn(() => new Set<string>()),
    randomOpaqueToken: vi.fn(() => "opaque-token"),
    sha256: vi.fn((value: string) => `sha:${value}`),
    verifyPassword: vi.fn(() => true),
  }));
}

describe("MCP connector registry", () => {
  it("uses delegated defaults for new OAuth connector clients", async () => {
    const prismaMock = {
      mcpOAuthClient: {
        create: vi.fn().mockResolvedValue({
          clientId: "mcp_client_test",
          name: "Corgtex",
          redirectUris: ["https://client.example/callback"],
          scopes: ["workspace:read", "tools:read", "tools:write", "tools:credentials:read", "members:write", "runtime:write"],
          tokenEndpointAuthMethod: "none",
        }),
      },
    };
    installSharedMock(prismaMock);

    const { MCP_CONNECTOR_DEFAULT_SCOPES, registerMcpOAuthClient } = await import("./mcp-connector");
    const result = await registerMcpOAuthClient({
      name: "Corgtex",
      redirectUris: ["https://client.example/callback"],
    });

    expect(MCP_CONNECTOR_DEFAULT_SCOPES).toContain("tools:write");
    expect(MCP_CONNECTOR_DEFAULT_SCOPES).toContain("tools:credentials:read");
    expect(MCP_CONNECTOR_DEFAULT_SCOPES).toContain("runtime:write");
    expect(MCP_CONNECTOR_DEFAULT_SCOPES).not.toContain("support:write");
    expect(prismaMock.mcpOAuthClient.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        scopes: expect.arrayContaining(["tools:read", "tools:write", "tools:credentials:read"]),
      }),
    });
    expect(result.scope).toContain("tools:credentials:read");
  });

  it("expands legacy default client scopes without expanding intentionally narrow clients", async () => {
    const {
      MCP_CONNECTOR_LEGACY_DEFAULT_SCOPES,
      resolveMcpClientAllowedScopes,
    } = await import("./mcp-connector");

    expect(resolveMcpClientAllowedScopes(MCP_CONNECTOR_LEGACY_DEFAULT_SCOPES)).toEqual(
      expect.arrayContaining(["tools:write", "tools:credentials:read", "runtime:write"]),
    );
    expect(resolveMcpClientAllowedScopes(["workspace:read", "brain:read"])).toEqual(["workspace:read", "brain:read"]);
  });

  it("defaults the current deployment to a registered active instance from WORKSPACE_SLUG", async () => {
    restoreEnv();
    Object.assign(process.env, {
      APP_URL: "https://client-a.example.com",
      WORKSPACE_SLUG: "client-a",
    });

    const { listMcpConnectorInstances } = await import("./mcp-connector");
    expect(listMcpConnectorInstances()).toEqual([
      expect.objectContaining({
        slug: "client-a",
        displayName: "Client-a",
        baseUrl: "https://client-a.example.com",
        workspaceSlugs: ["client-a"],
        status: "active",
      }),
    ]);
  });

  it("reads explicitly registered instances from MCP_INSTANCE_REGISTRY", async () => {
    restoreEnv();
    Object.assign(process.env, {
      APP_URL: "https://app.corgtex.com",
      MCP_INSTANCE_REGISTRY: JSON.stringify([
        {
          slug: "client-a",
          displayName: "Client A",
          baseUrl: "https://client-a.example.com/",
          workspaceSlugs: ["client-a"],
          status: "active",
        },
      ]),
    });

    const { listMcpConnectorInstances } = await import("./mcp-connector");
    expect(listMcpConnectorInstances()).toEqual([
      expect.objectContaining({
        slug: "client-a",
        displayName: "Client A",
        baseUrl: "https://client-a.example.com",
        workspaceSlugs: ["client-a"],
      }),
    ]);
  });

  it("treats /mcp and /api/mcp on the same origin as the same audience", async () => {
    const { areEquivalentMcpResources } = await import("./mcp-connector");

    expect(areEquivalentMcpResources("https://mcp.corgtex.com/mcp", "https://mcp.corgtex.com/api/mcp")).toBe(true);
    expect(areEquivalentMcpResources("https://mcp.corgtex.com/mcp", "https://other.example.com/mcp")).toBe(false);
  });
});

describe("MCP OAuth workspace membership revalidation", () => {
  it("rejects access tokens when the bound user is no longer an active workspace member", async () => {
    const prismaMock = {
      mcpOAuthAccessToken: {
        findUnique: vi.fn().mockResolvedValue({
          id: "token-1",
          clientId: "client-db-1",
          userId: "user-1",
          workspaceId: "ws-1",
          instanceSlug: "corgtex",
          scopes: ["brain:read"],
          resource: "https://app.test/mcp",
          expiresAt: new Date(Date.now() + 60_000),
          revokedAt: null,
          client: {
            clientId: "mcp_client_test",
            isActive: true,
          },
          user: {
            id: "user-1",
            email: "user@example.com",
            displayName: "User",
            globalRole: "USER",
          },
        }),
      },
      member: {
        findUnique: vi.fn().mockResolvedValue({ id: "member-1", isActive: false }),
      },
    };
    installSharedMock(prismaMock);

    const { resolveMcpOAuthAccessToken } = await import("./mcp-connector");

    await expect(resolveMcpOAuthAccessToken("mcp_at_valid", "https://app.test/mcp")).resolves.toBeNull();
    expect(prismaMock.member.findUnique).toHaveBeenCalledWith({
      where: {
        workspaceId_userId: {
          workspaceId: "ws-1",
          userId: "user-1",
        },
      },
      select: {
        id: true,
        isActive: true,
      },
    });
  });

  it("rejects refresh tokens when the bound user is no longer an active workspace member", async () => {
    const updateMock = vi.fn();
    const prismaMock = {
      mcpOAuthClient: {
        findUnique: vi.fn().mockResolvedValue({
          id: "client-db-1",
          clientId: "mcp_client_test",
          isActive: true,
        }),
      },
      mcpOAuthAccessToken: {
        findUnique: vi.fn().mockResolvedValue({
          id: "token-1",
          clientId: "client-db-1",
          userId: "user-1",
          workspaceId: "ws-1",
          instanceSlug: "corgtex",
          scopes: ["brain:read"],
          refreshExpiresAt: new Date(Date.now() + 60_000),
          revokedAt: null,
        }),
        update: updateMock,
      },
      member: {
        findUnique: vi.fn().mockResolvedValue(null),
      },
    };
    installSharedMock(prismaMock);

    const { refreshMcpAccessToken } = await import("./mcp-connector");

    await expect(refreshMcpAccessToken({
      refreshToken: "mcp_rt_valid",
      clientId: "mcp_client_test",
    })).rejects.toMatchObject({
      status: 403,
      code: "NOT_A_MEMBER",
    });
    expect(updateMock).not.toHaveBeenCalled();
  });
});
