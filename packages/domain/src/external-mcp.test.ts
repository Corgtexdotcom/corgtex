import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const {
  decryptSecretMock,
  encryptSecretMock,
  externalMcpConnectionMock,
  prismaTransactionMock,
  recordAuditMock,
  requireWorkspaceMembershipMock,
} = vi.hoisted(() => ({
  decryptSecretMock: vi.fn((value: string) => value.replace(/^enc:/, "")),
  encryptSecretMock: vi.fn((value: string) => `enc:${value}`),
  externalMcpConnectionMock: {
    findMany: vi.fn(),
    findFirst: vi.fn(),
    upsert: vi.fn(),
    update: vi.fn(),
  },
  prismaTransactionMock: vi.fn(async (callback: (tx: unknown) => Promise<unknown>) => callback({})),
  recordAuditMock: vi.fn(),
  requireWorkspaceMembershipMock: vi.fn(),
}));

vi.mock("@corgtex/shared", () => ({
  decryptSecret: decryptSecretMock,
  encryptSecret: encryptSecretMock,
  env: {
    get BOX_CLIENT_ID() {
      return process.env.BOX_CLIENT_ID;
    },
    get BOX_CLIENT_SECRET() {
      return process.env.BOX_CLIENT_SECRET;
    },
  },
  prisma: {
    externalMcpConnection: externalMcpConnectionMock,
    $transaction: prismaTransactionMock,
  },
}));

vi.mock("./auth", () => ({
  requireWorkspaceMembership: requireWorkspaceMembershipMock,
}));

vi.mock("./audit-trail", () => ({
  recordAudit: recordAuditMock,
}));

const actor = {
  kind: "user" as const,
  user: {
    id: "user-1",
    email: "user@example.com",
    displayName: "User",
  },
};

function activeNotionConnection() {
  return {
    id: "connection-1",
    workspaceId: "ws-1",
    userId: "user-1",
    providerKey: "notion",
    displayName: "Notion",
    serverUrl: "https://notion.test/mcp",
    accessTokenEnc: "enc:notion-token",
    refreshTokenEnc: null,
    expiresAt: null,
    scopes: ["search"],
    capabilities: null,
    status: "ACTIVE",
    lastError: null,
  };
}

function activeBoxConnection(overrides: Record<string, unknown> = {}) {
  return {
    id: "box-connection-1",
    workspaceId: "ws-1",
    userId: "user-1",
    providerKey: "box",
    displayName: "Box",
    serverUrl: "https://mcp.box.com",
    providerAccountId: "box-user-1",
    providerEmail: "box@example.com",
    accessTokenEnc: "enc:box-token",
    refreshTokenEnc: "enc:box-refresh",
    expiresAt: null,
    scopes: ["root_readwrite", "ai.readwrite"],
    capabilities: null,
    status: "ACTIVE",
    lastError: null,
    ...overrides,
  };
}

describe("external MCP gateway", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.stubEnv("BOX_CLIENT_ID", "box-client-id");
    vi.stubEnv("BOX_CLIENT_SECRET", "box-client-secret");
    requireWorkspaceMembershipMock.mockResolvedValue({ id: "member-1" });
    recordAuditMock.mockResolvedValue({ id: "audit-1" });
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.unstubAllEnvs();
  });

  it("lists provider metadata while keeping only implemented providers connectable", async () => {
    externalMcpConnectionMock.findMany.mockResolvedValueOnce([]);
    const { listExternalMcpConnections } = await import("./external-mcp");

    const connections = await listExternalMcpConnections(actor, "ws-1");

    expect(requireWorkspaceMembershipMock).toHaveBeenCalledWith({ actor, workspaceId: "ws-1" });
    expect(connections).toEqual(expect.arrayContaining([
      expect.objectContaining({
        providerKey: "box",
        displayName: "Box",
        connectionEnabled: true,
        status: "needs_connection",
        supportsSearch: true,
        supportsFetch: true,
        searchToolName: "search_files_keyword",
        fetchToolName: "get_file_details",
      }),
      expect.objectContaining({
        providerKey: "notion",
        displayName: "Notion",
        connectionEnabled: true,
        status: "needs_connection",
        connectionId: null,
        supportsSearch: true,
        supportsFetch: true,
        searchToolName: "notion-search",
        fetchToolName: "notion-fetch",
      }),
      expect.objectContaining({
        providerKey: "atlassian",
        connectionEnabled: false,
      }),
      expect.objectContaining({
        providerKey: "miro",
        connectionEnabled: false,
      }),
    ]));
  });

  it("encrypts tokens when upserting a same-user Notion connection", async () => {
    externalMcpConnectionMock.upsert.mockResolvedValueOnce({ id: "connection-1" });
    const { upsertExternalMcpConnection } = await import("./external-mcp");

    await upsertExternalMcpConnection(actor, {
      workspaceId: "ws-1",
      providerKey: "notion",
      accessToken: "notion-access-token",
      refreshToken: "notion-refresh-token",
      scopes: ["search"],
      capabilities: { searchToolName: "notion-search" },
    });

    expect(encryptSecretMock).toHaveBeenCalledWith("notion-access-token");
    expect(encryptSecretMock).toHaveBeenCalledWith("notion-refresh-token");
    expect(externalMcpConnectionMock.upsert).toHaveBeenCalledWith(expect.objectContaining({
      where: {
        workspaceId_userId_providerKey: {
          workspaceId: "ws-1",
          userId: "user-1",
          providerKey: "notion",
        },
      },
      update: expect.objectContaining({
        accessTokenEnc: "enc:notion-access-token",
        refreshTokenEnc: "enc:notion-refresh-token",
      }),
    }));
  });

  it("preserves the stored refresh token when connection updates omit it", async () => {
    externalMcpConnectionMock.upsert.mockResolvedValueOnce({ id: "connection-1" });
    const { upsertExternalMcpConnection } = await import("./external-mcp");

    await upsertExternalMcpConnection(actor, {
      workspaceId: "ws-1",
      providerKey: "notion",
      accessToken: "rotated-access-token",
      scopes: ["search"],
    });

    const upsertArgs = externalMcpConnectionMock.upsert.mock.calls.at(-1)?.[0];
    expect(upsertArgs.update).not.toHaveProperty("refreshTokenEnc");
    expect(upsertArgs.create).toHaveProperty("refreshTokenEnc", null);
  });

  it("upserts a same-user Box connection with expiry and provider identity", async () => {
    externalMcpConnectionMock.upsert.mockResolvedValueOnce({ id: "box-connection-1" });
    const { upsertExternalMcpConnection } = await import("./external-mcp");

    await upsertExternalMcpConnection(actor, {
      workspaceId: "ws-1",
      providerKey: "box",
      accessToken: "box-access-token",
      refreshToken: "box-refresh-token",
      expiresIn: 3600,
      providerAccountId: "box-user-1",
      providerEmail: "box@example.com",
      scopes: ["root_readwrite", "ai.readwrite"],
    });

    expect(encryptSecretMock).toHaveBeenCalledWith("box-access-token");
    expect(encryptSecretMock).toHaveBeenCalledWith("box-refresh-token");
    expect(externalMcpConnectionMock.upsert).toHaveBeenCalledWith(expect.objectContaining({
      update: expect.objectContaining({
        providerAccountId: "box-user-1",
        providerEmail: "box@example.com",
        accessTokenEnc: "enc:box-access-token",
        refreshTokenEnc: "enc:box-refresh-token",
        expiresAt: expect.any(Date),
      }),
    }));
  });

  it("refreshes expired Box tokens before live search", async () => {
    const expired = activeBoxConnection({ expiresAt: new Date(Date.now() - 60_000) });
    externalMcpConnectionMock.findMany.mockResolvedValueOnce([expired]);
    externalMcpConnectionMock.update.mockResolvedValueOnce(activeBoxConnection({
      accessTokenEnc: "enc:box-token-2",
      refreshTokenEnc: "enc:box-refresh-2",
      expiresAt: new Date(Date.now() + 3600_000),
    }));
    vi.stubGlobal("fetch", vi.fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({
        access_token: "box-token-2",
        refresh_token: "box-refresh-2",
        expires_in: 3600,
      }), { status: 200 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({
        result: {
          structuredContent: {
            entries: [
              {
                type: "search_result",
                item: {
                  id: "123",
                  type: "file",
                  name: "Budget.xlsx",
                  shared_link: { url: "https://box.com/s/budget" },
                },
              },
            ],
          },
        },
      }), { status: 200 })));

    const { searchConnectedExternalMcpContext } = await import("./external-mcp");
    const result = await searchConnectedExternalMcpContext(actor, {
      workspaceId: "ws-1",
      providerKey: "box",
      query: "budget",
    });

    expect(fetch).toHaveBeenNthCalledWith(1, "https://api.box.com/oauth2/token", expect.objectContaining({
      method: "POST",
    }));
    expect(encryptSecretMock).toHaveBeenCalledWith("box-token-2");
    expect(encryptSecretMock).toHaveBeenCalledWith("box-refresh-2");
    expect(fetch).toHaveBeenNthCalledWith(2, "https://mcp.box.com", expect.objectContaining({
      headers: expect.objectContaining({
        authorization: "Bearer box-token-2",
      }),
    }));
    expect(result.results).toEqual([
      expect.objectContaining({
        providerKey: "box",
        externalId: "123",
        title: "Budget.xlsx",
        url: "https://box.com/s/budget",
      }),
    ]);
  });

  it("searches live Notion context with provenance and audits without storing raw tokens", async () => {
    externalMcpConnectionMock.findMany.mockResolvedValueOnce([activeNotionConnection()]);
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(JSON.stringify({
      result: {
        structuredContent: {
          results: [
            {
              id: "page-1",
              title: "Launch plan",
              text: "Milestones and owners",
              url: "https://notion.test/page-1",
            },
          ],
        },
      },
    }), { status: 200 })));

    const { searchConnectedExternalMcpContext } = await import("./external-mcp");
    const result = await searchConnectedExternalMcpContext(actor, {
      workspaceId: "ws-1",
      query: "launch plan",
      limit: 5,
    });

    expect(fetch).toHaveBeenCalledWith("https://notion.test/mcp", expect.objectContaining({
      headers: expect.objectContaining({
        authorization: "Bearer notion-token",
      }),
    }));
    expect(result.results).toEqual([
      expect.objectContaining({
        id: "notion:page-1",
        source: "external_mcp",
        providerKey: "notion",
        providerDisplayName: "Notion",
        externalId: "page-1",
        title: "Launch plan",
        text: "Milestones and owners",
        url: "https://notion.test/page-1",
      }),
    ]);
    expect(result.errors).toEqual([]);
    expect(recordAuditMock).toHaveBeenCalledWith(
      expect.anything(),
      actor,
      expect.objectContaining({
        action: "external_mcp.tool_called",
        meta: expect.objectContaining({
          providerKey: "notion",
          toolName: "notion-search",
          policyClass: "read",
        }),
      }),
    );
    expect(JSON.stringify(recordAuditMock.mock.calls)).not.toContain("notion-token");
  });

  it("returns external search errors without throwing", async () => {
    externalMcpConnectionMock.findMany.mockResolvedValueOnce([activeNotionConnection()]);
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response("bad gateway", { status: 502 })));
    const { searchConnectedExternalMcpContext } = await import("./external-mcp");

    const result = await searchConnectedExternalMcpContext(actor, {
      workspaceId: "ws-1",
      query: "launch plan",
      limit: 5,
    });

    expect(result.results).toEqual([]);
    expect(result.errors).toEqual([
      { providerKey: "notion", message: "External MCP call failed with HTTP 502." },
    ]);
  });

  it("executes high-confidence external writes and audits the policy class", async () => {
    externalMcpConnectionMock.findFirst.mockResolvedValueOnce(activeNotionConnection());
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(JSON.stringify({
      result: {
        structuredContent: {
          pageId: "page-2",
          title: "Decision log",
        },
      },
    }), { status: 200 })));

    const { executeExternalMcpTool } = await import("./external-mcp");
    const result = await executeExternalMcpTool(actor, {
      workspaceId: "ws-1",
      providerKey: "notion",
      toolName: "notion-create-page",
      arguments: { title: "Decision log", secret: "should-not-be-stored" },
      confidence: 0.94,
      explicitUserIntent: false,
    });

    expect(result).toEqual(expect.objectContaining({
      skipped: false,
      providerKey: "notion",
      toolName: "notion-create-page",
      policy: expect.objectContaining({
        policyClass: "normal_write",
        autoRunAllowed: true,
      }),
    }));
    expect(recordAuditMock).toHaveBeenCalledWith(
      expect.anything(),
      actor,
      expect.objectContaining({
        meta: expect.objectContaining({
          policyClass: "normal_write",
          confidence: 0.94,
          inputSummary: { type: "object", keys: ["secret", "title"] },
        }),
      }),
    );
    expect(JSON.stringify(recordAuditMock.mock.calls)).not.toContain("should-not-be-stored");
  });

  it("skips medium-confidence external writes when user intent is not explicit", async () => {
    vi.stubGlobal("fetch", vi.fn());
    const { executeExternalMcpTool } = await import("./external-mcp");
    const result = await executeExternalMcpTool(actor, {
      workspaceId: "ws-1",
      providerKey: "notion",
      toolName: "notion-create-page",
      arguments: { title: "Decision log" },
      confidence: 0.7,
      explicitUserIntent: false,
    });

    expect(result).toEqual({
      skipped: true,
      policy: expect.objectContaining({
        policyClass: "draft_or_clarify",
        autoRunAllowed: false,
      }),
    });
    expect(externalMcpConnectionMock.findFirst).not.toHaveBeenCalled();
    expect(fetch).not.toHaveBeenCalled();
  });

  it("does not treat missing explicit user intent as explicit", async () => {
    vi.stubGlobal("fetch", vi.fn());
    const { executeExternalMcpTool } = await import("./external-mcp");
    const result = await executeExternalMcpTool(actor, {
      workspaceId: "ws-1",
      providerKey: "notion",
      toolName: "notion-create-page",
      arguments: { title: "Decision log" },
      confidence: 0.7,
    });

    expect(result).toEqual({
      skipped: true,
      policy: expect.objectContaining({
        policyClass: "draft_or_clarify",
        autoRunAllowed: false,
      }),
    });
    expect(externalMcpConnectionMock.findFirst).not.toHaveBeenCalled();
    expect(fetch).not.toHaveBeenCalled();
  });

  it("classifies unknown external tools as writes without substring matching", async () => {
    vi.stubGlobal("fetch", vi.fn());
    const { executeExternalMcpTool } = await import("./external-mcp");
    const result = await executeExternalMcpTool(actor, {
      workspaceId: "ws-1",
      providerKey: "notion",
      toolName: "notion-targeted-update",
      arguments: { title: "Decision log" },
      confidence: 0.7,
    });

    expect(result).toEqual({
      skipped: true,
      policy: expect.objectContaining({
        policyClass: "draft_or_clarify",
        autoRunAllowed: false,
      }),
    });
    expect(externalMcpConnectionMock.findFirst).not.toHaveBeenCalled();
    expect(fetch).not.toHaveBeenCalled();
  });

  it("auto-runs exact provider read tools at low confidence", async () => {
    externalMcpConnectionMock.findFirst.mockResolvedValueOnce(activeNotionConnection());
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(JSON.stringify({
      result: {
        structuredContent: { results: [] },
      },
    }), { status: 200 })));

    const { executeExternalMcpTool } = await import("./external-mcp");
    const result = await executeExternalMcpTool(actor, {
      workspaceId: "ws-1",
      providerKey: "notion",
      toolName: "notion-search",
      arguments: { query: "decision log" },
      confidence: 0.2,
    });

    expect(result).toEqual(expect.objectContaining({
      skipped: false,
      toolName: "notion-search",
      policy: expect.objectContaining({
        policyClass: "read",
        autoRunAllowed: true,
      }),
    }));
    expect(fetch).toHaveBeenCalled();
  });

  it("blocks generic Box tool execution even for read-like requests", async () => {
    const { executeExternalMcpTool } = await import("./external-mcp");

    await expect(executeExternalMcpTool(actor, {
      workspaceId: "ws-1",
      providerKey: "box",
      toolName: "get_file_details",
      arguments: { file_id: "123" },
      operation: "read",
      confidence: 1,
      explicitUserIntent: true,
    })).rejects.toThrow("Box generic tool execution is disabled in Corgtex v1.");
    expect(externalMcpConnectionMock.findFirst).not.toHaveBeenCalled();
  });
});
