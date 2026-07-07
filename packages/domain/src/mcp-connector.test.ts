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
  vi.unstubAllGlobals();
  vi.doUnmock("@corgtex/shared");
  vi.doUnmock("node:dns/promises");
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
  it("uses baseline public defaults for new OAuth connector clients", async () => {
    const prismaMock = {
      mcpOAuthClient: {
        create: vi.fn().mockResolvedValue({
          clientId: "mcp_client_test",
          name: "Corgtex",
          redirectUris: ["https://client.example/callback"],
          scopes: ["workspace:read", "brain:read", "tools:read", "conversations:write"],
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

    expect(MCP_CONNECTOR_DEFAULT_SCOPES).toContain("workspace:read");
    expect(MCP_CONNECTOR_DEFAULT_SCOPES).toContain("tools:read");
    expect(MCP_CONNECTOR_DEFAULT_SCOPES).toContain("conversations:write");
    expect(MCP_CONNECTOR_DEFAULT_SCOPES).not.toContain("tools:write");
    expect(MCP_CONNECTOR_DEFAULT_SCOPES).not.toContain("tools:credentials:read");
    expect(MCP_CONNECTOR_DEFAULT_SCOPES).not.toContain("runtime:write");
    expect(MCP_CONNECTOR_DEFAULT_SCOPES).not.toContain("support:write");
    expect(prismaMock.mcpOAuthClient.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        scopes: expect.arrayContaining(["workspace:read", "tools:read", "conversations:write"]),
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
      expect.arrayContaining(["context-graph:read", "goals:read", "tools:read"]),
    );
    expect(resolveMcpClientAllowedScopes(MCP_CONNECTOR_LEGACY_DEFAULT_SCOPES)).not.toContain("tools:write");
    expect(resolveMcpClientAllowedScopes(MCP_CONNECTOR_LEGACY_DEFAULT_SCOPES)).not.toContain("runtime:write");
    expect(resolveMcpClientAllowedScopes(MCP_CONNECTOR_LEGACY_DEFAULT_SCOPES)).not.toContain("tools:credentials:read");
    expect(resolveMcpClientAllowedScopes(["workspace:read", "brain:read"])).toEqual(["workspace:read", "brain:read"]);
  });

  it("grants baseline scopes when DCR omits scope", async () => {
    const prismaMock = {
      mcpOAuthClient: {
        create: vi.fn().mockResolvedValue({
          clientId: "mcp_client_test",
          name: "Corgtex",
          redirectUris: ["https://client.example/callback"],
          scopes: ["workspace:read", "brain:read", "tools:read", "conversations:write"],
          tokenEndpointAuthMethod: "none",
        }),
      },
    };
    installSharedMock(prismaMock);

    const { registerMcpOAuthClient } = await import("./mcp-connector");
    const result = await registerMcpOAuthClient({
      name: "Corgtex",
      redirectUris: ["https://client.example/callback"],
    });

    expect(prismaMock.mcpOAuthClient.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        scopes: expect.arrayContaining(["workspace:read", "brain:read", "tools:read", "conversations:write"]),
      }),
    });
    expect(result.scope).toContain("workspace:read");
    expect(result.scope).toContain("tools:read");
  });

  it("accepts OAuth protocol scopes without persisting them for DCR clients", async () => {
    const prismaMock = {
      mcpOAuthClient: {
        create: vi.fn().mockResolvedValue({
          clientId: "mcp_client_test",
          name: "Corgtex",
          redirectUris: ["https://client.example/callback"],
          scopes: ["workspace:read", "brain:read", "tools:read", "conversations:write"],
          tokenEndpointAuthMethod: "none",
        }),
      },
    };
    installSharedMock(prismaMock);

    const { registerMcpOAuthClient } = await import("./mcp-connector");
    await registerMcpOAuthClient({
      name: "Corgtex",
      redirectUris: ["https://client.example/callback"],
      scopes: ["openid", "profile", "email", "offline_access"],
    });

    expect(prismaMock.mcpOAuthClient.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        scopes: expect.arrayContaining(["workspace:read", "brain:read"]),
      }),
    });
    const persistedScopes = prismaMock.mcpOAuthClient.create.mock.calls[0][0].data.scopes;
    expect(persistedScopes).not.toEqual(expect.arrayContaining(["openid", "profile", "email", "offline_access"]));
  });

  it("accepts mixed OAuth protocol and Corgtex scopes for DCR clients", async () => {
    const prismaMock = {
      mcpOAuthClient: {
        create: vi.fn().mockResolvedValue({
          clientId: "mcp_client_test",
          name: "Corgtex",
          redirectUris: ["https://client.example/callback"],
          scopes: ["workspace:read", "brain:read"],
          tokenEndpointAuthMethod: "none",
        }),
      },
    };
    installSharedMock(prismaMock);

    const { registerMcpOAuthClient } = await import("./mcp-connector");
    await registerMcpOAuthClient({
      name: "Corgtex",
      redirectUris: ["https://client.example/callback"],
      scopes: ["openid", "workspace:read", "profile", "brain:read"],
    });

    expect(prismaMock.mcpOAuthClient.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        scopes: ["workspace:read", "brain:read"],
      }),
    });
  });

  it("rejects unknown scopes for user OAuth connector registration", async () => {
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
      scopes: ["workspace:read", "unknown:read"],
    })).rejects.toMatchObject({
      status: 400,
      code: "INVALID_INPUT",
    });
    expect(prismaMock.mcpOAuthClient.create).not.toHaveBeenCalled();
  });

  it("rejects sensitive scopes for user OAuth connector registration", async () => {
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

  it("rejects sensitive scopes from existing OAuth connector clients", async () => {
    installSharedMock({});

    const { resolveMcpClientAllowedScopes } = await import("./mcp-connector");
    expect(() => resolveMcpClientAllowedScopes(["workspace:read", "support:write"])).toThrow("sensitive/support-only");
  });

  it("allows baseline OAuth clients to step up to safe Corgtex scopes during authorization", async () => {
    const createAuthorizationCodeMock = vi.fn().mockResolvedValue({});
    const prismaMock = {
      mcpOAuthClient: {
        findUnique: vi.fn().mockResolvedValue({
          id: "client-db-1",
          clientId: "mcp_client_test",
          isActive: true,
          redirectUris: ["https://client.example/callback"],
          scopes: ["workspace:read", "brain:read", "governance:read", "context-graph:read", "proposals:read", "actions:read", "tensions:read", "goals:read", "members:read", "meetings:read", "cycles:read", "circles:read", "tools:read", "conversations:write"],
        }),
      },
      member: {
        findUnique: vi.fn().mockResolvedValue({ id: "member-1", isActive: true }),
      },
      workspace: {
        findUnique: vi.fn().mockResolvedValue({ id: "ws-1", slug: "corgtex" }),
      },
      mcpOAuthAuthorizationCode: {
        create: createAuthorizationCodeMock,
      },
    };
    installSharedMock(prismaMock);

    const { issueMcpAuthorizationCode } = await import("./mcp-connector");
    await issueMcpAuthorizationCode({
      kind: "user",
      user: { id: "user-1", email: "user@example.com", displayName: "User" },
    }, {
      clientId: "mcp_client_test",
      workspaceId: "ws-1",
      redirectUri: "https://client.example/callback",
      scopes: ["workspace:read", "actions:write"],
      codeChallenge: "challenge",
      codeChallengeMethod: "S256",
      resource: "https://app.test/mcp",
    });

    expect(createAuthorizationCodeMock).toHaveBeenCalledWith({
      data: expect.objectContaining({
        scopes: ["workspace:read", "actions:write"],
      }),
    });
  });

  it("keeps intentionally narrow OAuth clients from stepping up beyond registered scopes", async () => {
    const prismaMock = {
      mcpOAuthClient: {
        findUnique: vi.fn().mockResolvedValue({
          id: "client-db-1",
          clientId: "mcp_client_test",
          isActive: true,
          redirectUris: ["https://client.example/callback"],
          scopes: ["workspace:read"],
        }),
      },
      member: {
        findUnique: vi.fn().mockResolvedValue({ id: "member-1", isActive: true }),
      },
      workspace: {
        findUnique: vi.fn().mockResolvedValue({ id: "ws-1", slug: "corgtex" }),
      },
    };
    installSharedMock(prismaMock);

    const { issueMcpAuthorizationCode } = await import("./mcp-connector");
    await expect(issueMcpAuthorizationCode({
      kind: "user",
      user: { id: "user-1", email: "user@example.com", displayName: "User" },
    }, {
      clientId: "mcp_client_test",
      workspaceId: "ws-1",
      redirectUri: "https://client.example/callback",
      scopes: ["workspace:read", "actions:write"],
      codeChallenge: "challenge",
      codeChallengeMethod: "S256",
      resource: "https://app.test/mcp",
    })).rejects.toMatchObject({
      status: 400,
      code: "INVALID_INPUT",
    });
  });

  it("upserts HTTPS URL client_ids from CIMD metadata documents", async () => {
    const lookupMock = vi.fn().mockResolvedValue([{ address: "93.184.216.34", family: 4 }]);
    vi.doMock("node:dns/promises", () => ({ lookup: lookupMock }));
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(JSON.stringify({
      client_id: "https://client.example/oauth/client.json",
      client_name: "Claude Code",
      redirect_uris: ["http://localhost:3456/callback"],
      scope: "openid profile workspace:read brain:read",
      grant_types: ["authorization_code"],
      response_types: ["code"],
      token_endpoint_auth_method: "none",
    }), {
      headers: { "content-type": "application/json" },
    })));

    const prismaMock = {
      mcpOAuthClient: {
        findUnique: vi.fn().mockResolvedValue(null),
        upsert: vi.fn().mockResolvedValue({
          id: "client-db-1",
          clientId: "https://client.example/oauth/client.json",
          name: "Claude Code",
          redirectUris: ["http://localhost:3456/callback"],
          scopes: ["workspace:read", "brain:read"],
          tokenEndpointAuthMethod: "none",
          isActive: true,
        }),
      },
    };
    installSharedMock(prismaMock);

    const { getMcpOAuthClientByClientId } = await import("./mcp-connector");
    const client = await getMcpOAuthClientByClientId("https://client.example/oauth/client.json");

    expect(client.clientId).toBe("https://client.example/oauth/client.json");
    expect(fetch).toHaveBeenCalledWith(expect.any(URL), expect.objectContaining({
      redirect: "manual",
      method: "GET",
    }));
    expect(prismaMock.mcpOAuthClient.upsert).toHaveBeenCalledWith({
      where: { clientId: "https://client.example/oauth/client.json" },
      create: expect.objectContaining({
        clientId: "https://client.example/oauth/client.json",
        name: "Claude Code",
        redirectUris: ["http://localhost:3456/callback"],
        scopes: ["workspace:read", "brain:read"],
        tokenEndpointAuthMethod: "none",
        isActive: true,
      }),
      update: expect.objectContaining({
        name: "Claude Code",
        redirectUris: ["http://localhost:3456/callback"],
        scopes: ["workspace:read", "brain:read"],
        tokenEndpointAuthMethod: "none",
      }),
    });
  });

  it("does not treat non-HTTPS client IDs as CIMD clients", async () => {
    installSharedMock({});

    const { isCimdMcpClientId } = await import("./mcp-connector");
    expect(isCimdMcpClientId("http://client.example/oauth/client.json")).toBe(false);
    expect(isCimdMcpClientId("https://client.example")).toBe(false);
    expect(isCimdMcpClientId("https://client.example/oauth/client.json")).toBe(true);
  });

  it("rejects CIMD metadata URLs that target localhost or private networks", async () => {
    const prismaMock = {
      mcpOAuthClient: {
        findUnique: vi.fn().mockResolvedValue(null),
        upsert: vi.fn(),
      },
    };
    installSharedMock(prismaMock);

    const { getMcpOAuthClientByClientId } = await import("./mcp-connector");
    await expect(getMcpOAuthClientByClientId("https://127.0.0.1/oauth/client.json")).rejects.toMatchObject({
      status: 400,
      code: "INVALID_INPUT",
    });
    expect(prismaMock.mcpOAuthClient.upsert).not.toHaveBeenCalled();
  });

  it("rejects CIMD metadata hosts that resolve to private networks", async () => {
    vi.doMock("node:dns/promises", () => ({
      lookup: vi.fn().mockResolvedValue([{ address: "10.0.0.8", family: 4 }]),
    }));
    vi.stubGlobal("fetch", vi.fn());
    const prismaMock = {
      mcpOAuthClient: {
        findUnique: vi.fn().mockResolvedValue(null),
        upsert: vi.fn(),
      },
    };
    installSharedMock(prismaMock);

    const { getMcpOAuthClientByClientId } = await import("./mcp-connector");
    await expect(getMcpOAuthClientByClientId("https://client.example/oauth/client.json")).rejects.toMatchObject({
      status: 400,
      code: "INVALID_INPUT",
    });
    expect(fetch).not.toHaveBeenCalled();
  });

  it("rejects oversized CIMD metadata documents", async () => {
    vi.doMock("node:dns/promises", () => ({
      lookup: vi.fn().mockResolvedValue([{ address: "93.184.216.34", family: 4 }]),
    }));
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(JSON.stringify({
      padding: "x".repeat(70 * 1024),
    }), {
      headers: { "content-type": "application/json" },
    })));
    const prismaMock = {
      mcpOAuthClient: {
        findUnique: vi.fn().mockResolvedValue(null),
        upsert: vi.fn(),
      },
    };
    installSharedMock(prismaMock);

    const { getMcpOAuthClientByClientId } = await import("./mcp-connector");
    await expect(getMcpOAuthClientByClientId("https://client.example/oauth/client.json")).rejects.toMatchObject({
      status: 400,
      code: "INVALID_INPUT",
    });
    expect(prismaMock.mcpOAuthClient.upsert).not.toHaveBeenCalled();
  });

  it("rejects CIMD metadata whose client_id or redirect metadata is invalid", async () => {
    vi.doMock("node:dns/promises", () => ({
      lookup: vi.fn().mockResolvedValue([{ address: "93.184.216.34", family: 4 }]),
    }));
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(JSON.stringify({
      client_id: "https://client.example/other.json",
      client_name: "Bad Client",
      redirect_uris: ["http://192.168.1.10/callback"],
      token_endpoint_auth_method: "none",
    }), {
      headers: { "content-type": "application/json" },
    })));
    const prismaMock = {
      mcpOAuthClient: {
        findUnique: vi.fn().mockResolvedValue(null),
        upsert: vi.fn(),
      },
    };
    installSharedMock(prismaMock);

    const { getMcpOAuthClientByClientId } = await import("./mcp-connector");
    await expect(getMcpOAuthClientByClientId("https://client.example/oauth/client.json")).rejects.toMatchObject({
      status: 400,
      code: "INVALID_INPUT",
    });
    expect(prismaMock.mcpOAuthClient.upsert).not.toHaveBeenCalled();
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
