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

function installSharedMock(prismaMock: Record<string, any>, envOverrides: Record<string, string | undefined> = {}) {
  vi.doMock("@corgtex/shared", () => ({
    prisma: prismaMock,
    env: {
      APP_URL: "https://app.test",
      MCP_INSTANCE_REGISTRY: undefined,
      MCP_DEFAULT_INSTANCE_SLUG: undefined,
      MCP_PUBLIC_URL: undefined,
      WORKSPACE_SLUG: undefined,
      AGENT_API_KEY: undefined,
      ...envOverrides,
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
          scopes: ["workspace:read", "tools:read", "tools:write", "members:write", "runtime:write"],
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
    expect(MCP_CONNECTOR_DEFAULT_SCOPES).not.toContain("tools:credentials:read");
    expect(MCP_CONNECTOR_DEFAULT_SCOPES).toContain("runtime:write");
    expect(MCP_CONNECTOR_DEFAULT_SCOPES).not.toContain("support:write");
    expect(prismaMock.mcpOAuthClient.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        scopes: expect.arrayContaining(["tools:read", "tools:write"]),
      }),
    });
    expect(result.scope).not.toContain("tools:credentials:read");
  });

  it("expands legacy default client scopes without expanding intentionally narrow clients", async () => {
    installSharedMock({});

    const {
      MCP_CONNECTOR_LEGACY_DEFAULT_SCOPES,
      resolveMcpClientAllowedScopes,
    } = await import("./mcp-connector");

    expect(resolveMcpClientAllowedScopes(MCP_CONNECTOR_LEGACY_DEFAULT_SCOPES)).toEqual(
      expect.arrayContaining(["tools:write", "runtime:write"]),
    );
    expect(resolveMcpClientAllowedScopes(MCP_CONNECTOR_LEGACY_DEFAULT_SCOPES)).not.toContain("tools:credentials:read");
    expect(resolveMcpClientAllowedScopes(["workspace:read", "brain:read"])).toEqual(["workspace:read", "brain:read"]);
  });

  it("rejects support-only scopes for user OAuth connector registration", async () => {
    const prismaMock = {
      mcpOAuthClient: {
        create: vi.fn(),
      },
    };
    installSharedMock(prismaMock);

    const { registerMcpOAuthClient } = await import("./mcp-connector");
    await expect(registerMcpOAuthClient({
      name: "Corgtex",
      redirectUris: ["https://client.example/callback"],
      scopes: ["workspace:read", "support:write"],
    })).rejects.toMatchObject({
      status: 400,
      code: "INVALID_INPUT",
    });
    expect(prismaMock.mcpOAuthClient.create).not.toHaveBeenCalled();
  });

  it("filters support-only scopes from existing OAuth connector clients", async () => {
    installSharedMock({});

    const { resolveMcpClientAllowedScopes } = await import("./mcp-connector");
    expect(resolveMcpClientAllowedScopes(["workspace:read", "support:write"])).toEqual(["workspace:read"]);
  });

  it("defaults the current deployment to a registered active instance from WORKSPACE_SLUG", async () => {
    installSharedMock({}, {
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
    installSharedMock({}, {
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
    installSharedMock({});

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

describe("MCP OAuth provider classification and connection status", () => {
  const now = new Date("2026-05-20T16:00:00.000Z");

  function token(overrides: Record<string, any> = {}) {
    return {
      userId: "user-1",
      workspaceId: "ws-1",
      instanceSlug: "corgtex",
      refreshHash: "sha:mcp_rt_valid",
      expiresAt: new Date("2026-05-20T17:00:00.000Z"),
      refreshExpiresAt: new Date("2026-06-20T16:00:00.000Z"),
      revokedAt: null,
      createdAt: new Date("2026-05-19T16:00:00.000Z"),
      updatedAt: new Date("2026-05-20T15:00:00.000Z"),
      client: {
        name: "Claude",
        redirectUris: ["https://claude.ai/api/mcp/callback"],
        isActive: true,
      },
      ...overrides,
    };
  }

  it("classifies known MCP clients by client name with a generic fallback", async () => {
    installSharedMock({});

    const { inferMcpOAuthProviderKey } = await import("./mcp-connector");

    expect(inferMcpOAuthProviderKey({ name: "OpenWork MCP", redirectUris: [], isActive: true })).toBe("openwork");
    expect(inferMcpOAuthProviderKey({ name: "ChatGPT Connector", redirectUris: [], isActive: true })).toBe("chatgpt");
    expect(inferMcpOAuthProviderKey({ name: "Claude", redirectUris: [], isActive: true })).toBe("claude");
    expect(inferMcpOAuthProviderKey({ name: "GitHub Copilot", redirectUris: [], isActive: true })).toBe("copilot");
    expect(inferMcpOAuthProviderKey({ name: "Gemini", redirectUris: [], isActive: true })).toBe("gemini");
    expect(inferMcpOAuthProviderKey({ name: "Cursor", redirectUris: [], isActive: true })).toBe("cursor");
    expect(inferMcpOAuthProviderKey({ name: "Custom Desktop MCP", redirectUris: [], isActive: true })).toBe("generic_mcp");
  });

  it("classifies known MCP clients by redirect host when the name is generic", async () => {
    installSharedMock({});

    const { inferMcpOAuthProviderKey } = await import("./mcp-connector");

    expect(inferMcpOAuthProviderKey({ name: "MCP Client", redirectUris: ["https://auth.openworklabs.com/callback"], isActive: true })).toBe("openwork");
    expect(inferMcpOAuthProviderKey({ name: "MCP Client", redirectUris: ["https://chatgpt.com/aip/example/oauth/callback"], isActive: true })).toBe("chatgpt");
    expect(inferMcpOAuthProviderKey({ name: "MCP Client", redirectUris: ["https://claude.ai/api/mcp/callback"], isActive: true })).toBe("claude");
    expect(inferMcpOAuthProviderKey({ name: "MCP Client", redirectUris: ["https://github.com/login/oauth/callback"], isActive: true })).toBe("copilot");
    expect(inferMcpOAuthProviderKey({ name: "MCP Client", redirectUris: ["https://accounts.google.com/oauth/callback"], isActive: true })).toBe("gemini");
    expect(inferMcpOAuthProviderKey({ name: "MCP Client", redirectUris: ["https://cursor.com/oauth/callback"], isActive: true })).toBe("cursor");
  });

  it("aggregates active refreshable OAuth tokens into provider connection statuses", async () => {
    const prismaMock = {
      mcpOAuthAccessToken: {
        findMany: vi.fn().mockResolvedValue([
          token({
            updatedAt: new Date("2026-05-20T15:20:00.000Z"),
            client: {
              clientId: "mcp_client_chatgpt",
              name: "ChatGPT Connector",
              redirectUris: ["https://chatgpt.com/aip/example/oauth/callback"],
              isActive: true,
            },
          }),
          token({
            updatedAt: new Date("2026-05-20T15:10:00.000Z"),
            client: {
              clientId: "mcp_client_cursor",
              name: "Cursor",
              redirectUris: ["https://cursor.com/oauth/callback"],
              isActive: true,
            },
          }),
          token({
            updatedAt: new Date("2026-05-20T15:00:00.000Z"),
            client: {
              clientId: "mcp_client_generic",
              name: "Local MCP Client",
              redirectUris: ["http://127.0.0.1:45837/callback"],
              isActive: true,
            },
          }),
        ]),
      },
    };
    installSharedMock(prismaMock);

    const { listMcpOAuthConnectionStatuses } = await import("./mcp-connector");
    const result = await listMcpOAuthConnectionStatuses({ userId: "user-1", workspaceId: "ws-1", now });

    expect(result).toEqual([
      {
        providerKey: "chatgpt",
        connected: true,
        connectedAt: new Date("2026-05-20T15:20:00.000Z"),
        source: "mcp_oauth",
        clientName: "ChatGPT Connector",
      },
      {
        providerKey: "cursor",
        connected: true,
        connectedAt: new Date("2026-05-20T15:10:00.000Z"),
        source: "mcp_oauth",
        clientName: "Cursor",
      },
      {
        providerKey: "generic_mcp",
        connected: true,
        connectedAt: new Date("2026-05-20T15:00:00.000Z"),
        source: "mcp_oauth",
        clientName: "Local MCP Client",
      },
    ]);
  });

  it("ignores invalid OAuth tokens when aggregating provider statuses", async () => {
    const prismaMock = {
      mcpOAuthAccessToken: {
        findMany: vi.fn().mockResolvedValue([
          token({ revokedAt: new Date("2026-05-20T15:30:00.000Z") }),
          token({ refreshExpiresAt: new Date("2026-05-20T15:30:00.000Z") }),
          token({ refreshHash: null }),
          token({
            client: {
              name: "Claude",
              redirectUris: ["https://claude.ai/api/mcp/callback"],
              isActive: false,
            },
          }),
          token({ userId: "other-user" }),
          token({ workspaceId: "other-workspace" }),
        ]),
      },
    };
    installSharedMock(prismaMock);

    const { listMcpOAuthConnectionStatuses } = await import("./mcp-connector");
    await expect(listMcpOAuthConnectionStatuses({ userId: "user-1", workspaceId: "ws-1", now })).resolves.toEqual([]);
  });

  it("detects an active refreshable Claude OAuth token for the current user and workspace", async () => {
    const prismaMock = {
      mcpOAuthAccessToken: {
        findMany: vi.fn().mockResolvedValue([token()]),
      },
    };
    installSharedMock(prismaMock);

    const { getClaudeMcpConnectionStatus } = await import("./mcp-connector");
    const result = await getClaudeMcpConnectionStatus({ userId: "user-1", workspaceId: "ws-1", now });

    expect(result).toEqual({
      connected: true,
      connectedAt: new Date("2026-05-20T15:00:00.000Z"),
    });
    expect(prismaMock.mcpOAuthAccessToken.findMany).toHaveBeenCalledWith({
      where: {
        userId: "user-1",
        workspaceId: "ws-1",
        revokedAt: null,
        refreshHash: { not: null },
        OR: [
          { refreshExpiresAt: null },
          { refreshExpiresAt: { gt: now } },
        ],
      },
      select: expect.any(Object),
      orderBy: { updatedAt: "desc" },
    });
  });

  it("keeps Claude connected when the access token expired but the refresh grant is valid", async () => {
    const prismaMock = {
      mcpOAuthAccessToken: {
        findMany: vi.fn().mockResolvedValue([
          token({
            expiresAt: new Date("2026-05-20T15:30:00.000Z"),
          }),
        ]),
      },
    };
    installSharedMock(prismaMock);

    const { getClaudeMcpConnectionStatus } = await import("./mcp-connector");

    await expect(getClaudeMcpConnectionStatus({ userId: "user-1", workspaceId: "ws-1", now })).resolves.toEqual({
      connected: true,
      connectedAt: new Date("2026-05-20T15:00:00.000Z"),
    });
  });

  it("ignores active MCP tokens that do not belong to Claude", async () => {
    const prismaMock = {
      mcpOAuthAccessToken: {
        findMany: vi.fn().mockResolvedValue([
          token({
            client: {
              name: "ChatGPT",
              redirectUris: ["https://chatgpt.com/aip/example/oauth/callback"],
              isActive: true,
            },
          }),
        ]),
      },
    };
    installSharedMock(prismaMock);

    const { getClaudeMcpConnectionStatus } = await import("./mcp-connector");

    await expect(getClaudeMcpConnectionStatus({ userId: "user-1", workspaceId: "ws-1", now })).resolves.toEqual({
      connected: false,
      connectedAt: null,
    });
  });

  it("ignores revoked, refresh-expired, or non-refreshable Claude tokens", async () => {
    const prismaMock = {
      mcpOAuthAccessToken: {
        findMany: vi.fn().mockResolvedValue([
          token({ revokedAt: new Date("2026-05-20T15:30:00.000Z") }),
          token({ refreshExpiresAt: new Date("2026-05-20T15:30:00.000Z") }),
          token({ refreshHash: null }),
        ]),
      },
    };
    installSharedMock(prismaMock);

    const { getClaudeMcpConnectionStatus } = await import("./mcp-connector");

    await expect(getClaudeMcpConnectionStatus({ userId: "user-1", workspaceId: "ws-1", now })).resolves.toEqual({
      connected: false,
      connectedAt: null,
    });
  });

  it("does not leak Claude connection state across users or workspaces", async () => {
    const prismaMock = {
      mcpOAuthAccessToken: {
        findMany: vi.fn().mockResolvedValue([
          token({ userId: "other-user" }),
          token({ workspaceId: "other-workspace" }),
        ]),
      },
    };
    installSharedMock(prismaMock);

    const { getClaudeMcpConnectionStatus } = await import("./mcp-connector");

    await expect(getClaudeMcpConnectionStatus({ userId: "user-1", workspaceId: "ws-1", now })).resolves.toEqual({
      connected: false,
      connectedAt: null,
    });
  });
});
