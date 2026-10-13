import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ExternalMcpConnectionRecord } from "./external-mcp";

const {
  decryptSecretMock,
  encryptSecretMock,
  externalMcpConnectionMock,
  prismaTransactionMock,
  recordAuditMock,
  requireWorkspaceMembershipMock,
  captureExternalMcpResponseInputMock,
  captureArtifactInputProofMock,
  isArtifactInputProofReadableMock,
  mcpOriginState,
  mcpOAuthAccessTokenMock,
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
  captureExternalMcpResponseInputMock: vi.fn(),
  captureArtifactInputProofMock: vi.fn(),
  isArtifactInputProofReadableMock: vi.fn(),
  mcpOriginState: { origin: null as null | Record<string, unknown> },
  mcpOAuthAccessTokenMock: { findUnique: vi.fn() },
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
  getMcpOrigin: () => mcpOriginState.origin,
  parseMcpOrigin: (value: unknown) => value,
  assertMcpOriginActive: vi.fn(async () => {}),
  mcpScopesHash: (scopes: string[]) => [...scopes].sort().join(","),
  prisma: {
    externalMcpConnection: externalMcpConnectionMock,
    member: { findFirst: vi.fn(async () => ({ id: "member-1" })) },
    mcpOAuthAccessToken: mcpOAuthAccessTokenMock,
    $transaction: prismaTransactionMock,
  },
}));

vi.mock("./auth", () => ({
  requireWorkspaceMembership: requireWorkspaceMembershipMock,
}));

vi.mock("./audit-trail", () => ({
  recordAudit: recordAuditMock,
}));
vi.mock("./source-lineage", () => ({
  captureArtifactInputProof: captureArtifactInputProofMock,
  isArtifactInputProofReadable: isArtifactInputProofReadableMock,
}));
vi.mock("./external-mcp-response-input", () => ({
  captureExternalMcpResponseInput: captureExternalMcpResponseInputMock,
  registerExternalMcpResponseOutput: (_actor: unknown, _workspaceId: string, value: object) => value,
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
    mcpOriginState.origin = null;
    captureArtifactInputProofMock.mockImplementation(async (_actor, _workspaceId, inputs) => inputs.map((input: any) => ({
      kind: input.kind, id: input.id, fingerprint: "verified", permissionEpochs: { version: 1, entries: [] },
    })));
    isArtifactInputProofReadableMock.mockResolvedValue(true);
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

  it("refreshes expired Box tokens before capturing the native search authority", async () => {
    const expired = activeBoxConnection({ expiresAt: new Date(Date.now() - 60_000) });
    externalMcpConnectionMock.findFirst.mockResolvedValueOnce(expired).mockResolvedValueOnce(activeBoxConnection({
      accessTokenEnc: "enc:box-token-2", refreshTokenEnc: "enc:box-refresh-2", expiresAt: new Date(Date.now() + 3600_000),
    }));
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
      }), { status: 200 })));

    const { loadExternalMcpNativeConnection } = await import("./external-mcp");
    const connection = await loadExternalMcpNativeConnection(actor, "ws-1", "box-connection-1");

    expect(fetch).toHaveBeenNthCalledWith(1, "https://api.box.com/oauth2/token", expect.objectContaining({
      method: "POST",
    }));
    expect(encryptSecretMock).toHaveBeenCalledWith("box-token-2");
    expect(encryptSecretMock).toHaveBeenCalledWith("box-refresh-2");
    expect(connection.accessTokenEnc).toBe("enc:box-token-2");
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it("searches Notion only through a complete native response receipt and audits without tokens", async () => {
    externalMcpConnectionMock.findMany.mockResolvedValueOnce([activeNotionConnection()]);
    captureExternalMcpResponseInputMock.mockResolvedValueOnce({ input: { id: "native-1", toolName: "notion-search" },
      payload: { structuredContent: { results: [{ id: "page-1", title: "Launch plan", text: "Milestones and owners",
        url: "https://notion.test/page-1" }] } } });

    const { searchConnectedExternalMcpContext } = await import("./external-mcp");
    const result = await searchConnectedExternalMcpContext(actor, {
      workspaceId: "ws-1",
      query: "launch plan",
      limit: 5,
    });

    expect(captureExternalMcpResponseInputMock).toHaveBeenCalledWith(actor, { workspaceId: "ws-1",
      connectionId: "connection-1", mode: "SEARCH", query: "launch plan", limit: 5 });
    expect(captureArtifactInputProofMock).toHaveBeenCalledWith(actor, "ws-1", [
      { kind: "ExternalMcpResponseInput", id: "native-1", snapshot: { id: "native-1", toolName: "notion-search" } },
    ]);
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
    captureExternalMcpResponseInputMock.mockRejectedValueOnce(new Error("provider secret text"));
    const { searchConnectedExternalMcpContext } = await import("./external-mcp");

    const result = await searchConnectedExternalMcpContext(actor, {
      workspaceId: "ws-1",
      query: "launch plan",
      limit: 5,
    });

    expect(result.results).toEqual([]);
    expect(result.errors).toEqual([
      { providerKey: "notion", message: "External MCP search is unavailable." },
    ]);
    expect(JSON.stringify(result)).not.toContain("provider secret text");
  });

  it("fetches a fixed Notion item only through its full native response proof", async () => {
    externalMcpConnectionMock.findFirst.mockResolvedValueOnce(activeNotionConnection());
    vi.stubGlobal("fetch", vi.fn());
    captureExternalMcpResponseInputMock.mockResolvedValueOnce({ input: { id: "native-fetch", toolName: "notion-fetch" },
      payload: { structuredContent: { id: "page-1", title: "Synthetic page" } } });
    const { fetchConnectedExternalMcpContext } = await import("./external-mcp");
    const result = await fetchConnectedExternalMcpContext(actor, { workspaceId: "ws-1", providerKey: "notion", externalId: "page-1" });
    expect(captureExternalMcpResponseInputMock).toHaveBeenCalledWith(actor, { workspaceId: "ws-1",
      connectionId: "connection-1", mode: "FETCH", externalId: "page-1" });
    expect(captureArtifactInputProofMock).toHaveBeenCalledWith(actor, "ws-1", [
      { kind: "ExternalMcpResponseInput", id: "native-fetch", snapshot: { id: "native-fetch", toolName: "notion-fetch" } },
    ]);
    expect(result.content).toEqual({ id: "page-1", title: "Synthetic page" });
    expect(fetch).not.toHaveBeenCalled();
  });

  it("withholds unproved Notion fetch errors without echoing provider text", async () => {
    externalMcpConnectionMock.findFirst.mockResolvedValueOnce(activeNotionConnection());
    captureExternalMcpResponseInputMock.mockRejectedValueOnce(new Error("remote secret error"));
    const { fetchConnectedExternalMcpContext } = await import("./external-mcp");
    await expect(fetchConnectedExternalMcpContext(actor, { workspaceId: "ws-1", providerKey: "notion", externalId: "page-1" }))
      .rejects.toMatchObject({ code: "SOURCE_RESTRICTED", message: "External MCP fetch is unavailable." });
    expect(JSON.stringify(recordAuditMock.mock.calls)).not.toContain("remote secret error");
  });

  it("uses only the fixed live search/fetch vocabulary and retains the complete Box tool result", async () => {
    const { externalMcpNativeReadRequest, externalMcpConnectionGrantHash, readExternalMcpNativeToolResult } = await import("./external-mcp");
    expect(externalMcpNativeReadRequest("box", "SEARCH", { query: "budget", limit: 1 })).toMatchObject({
      toolName: "search_files_keyword", arguments: { query: "budget", limit: 1 },
    });
    expect(externalMcpNativeReadRequest("box", "FETCH", { externalId: "folder:123" })).toMatchObject({
      toolName: "get_folder_details", arguments: { folder_id: "123" },
    });
    expect(() => externalMcpNativeReadRequest("box", "FETCH", { externalId: "folder:123:other" })).toThrow();
    expect(() => externalMcpNativeReadRequest("atlassian", "SEARCH", { query: "budget", limit: 1 })).toThrow();
    const connection = activeBoxConnection() as ExternalMcpConnectionRecord;
    externalMcpConnectionMock.findFirst.mockResolvedValue(connection);
    const full = { content: [{ type: "text", text: JSON.stringify({ results: [{ id: "first" }, { id: "second" }] }) }],
      structuredContent: { results: [{ id: "first" }, { id: "second" }] } };
    vi.stubGlobal("fetch", vi.fn().mockImplementation(async (_url: string, options: { body: string }) => {
      const request = JSON.parse(options.body);
      return new Response(JSON.stringify({ jsonrpc: "2.0", id: request.id,
        result: request.params.name === "who_am_i" ? { structuredContent: { id: "box-user-1" } } : full }), { status: 200 });
    }));
    await expect(readExternalMcpNativeToolResult(actor, { workspaceId: "ws-1", connectionId: connection.id,
      connectionGrantHash: externalMcpConnectionGrantHash(connection), providerKey: "box", serverUrl: connection.serverUrl,
      providerAccountId: "box-user-1", mode: "SEARCH", toolName: "search_files_keyword",
      arguments: externalMcpNativeReadRequest("box", "SEARCH", { query: "budget", limit: 1 }).arguments })).resolves.toEqual(full);
    expect(fetch).toHaveBeenCalledTimes(2);
  });

  it("checks the actual OAuth token subject and external read consent before a native provider call", async () => {
    mcpOriginState.origin = { kind: "oauth", id: "token-1", workspaceId: "ws-1",
      scopeHash: "external-tools:read", grantEpoch: "0", requiredScopes: [] };
    mcpOAuthAccessTokenMock.findUnique.mockResolvedValue({ userId: "user-1", workspaceId: "ws-1", scopes: ["brain:read"] });
    const { assertExternalMcpNativeReadOrigin, readExternalMcpNativeToolResult, externalMcpConnectionGrantHash } = await import("./external-mcp");
    externalMcpConnectionMock.findFirst.mockResolvedValue(activeBoxConnection());
    vi.stubGlobal("fetch", vi.fn());
    await expect(assertExternalMcpNativeReadOrigin(actor, "ws-1")).rejects.toMatchObject({ code: "MCP_AUTHORIZATION_REVOKED" });
    await expect(readExternalMcpNativeToolResult(actor, { workspaceId: "ws-1", connectionId: "box-connection-1",
      connectionGrantHash: externalMcpConnectionGrantHash(activeBoxConnection() as ExternalMcpConnectionRecord),
      providerKey: "box", serverUrl: "https://mcp.box.com", providerAccountId: "box-user-1",
      mode: "FETCH", toolName: "get_file_details", arguments: { file_id: "123" } })).rejects.toBeDefined();
    expect(fetch).not.toHaveBeenCalled();
    mcpOAuthAccessTokenMock.findUnique.mockResolvedValue({ userId: "user-1", workspaceId: "ws-1", scopes: ["external-tools:read"] });
    await expect(assertExternalMcpNativeReadOrigin(actor, "ws-1")).resolves.toContain("token-1");
  });

  it("withholds a native provider call when its connection owner is no longer an active member", async () => {
    externalMcpConnectionMock.findFirst.mockResolvedValue(activeBoxConnection());
    const { prisma } = await import("@corgtex/shared");
    vi.mocked(prisma.member.findFirst).mockResolvedValueOnce(null);
    vi.stubGlobal("fetch", vi.fn());
    const { loadExternalMcpNativeConnection } = await import("./external-mcp");
    await expect(loadExternalMcpNativeConnection(actor, "ws-1", "box-connection-1"))
      .rejects.toMatchObject({ code: "SOURCE_RESTRICTED" });
    expect(fetch).not.toHaveBeenCalled();
  });

  it("rejects ambiguous streamed MCP completions instead of choosing the final frame", async () => {
    const { externalMcpNativeReadRequest, externalMcpConnectionGrantHash, readExternalMcpNativeToolResult } = await import("./external-mcp");
    const connection = activeBoxConnection() as ExternalMcpConnectionRecord;
    externalMcpConnectionMock.findFirst.mockResolvedValue(connection);
    const streamed = [
      'data: {"jsonrpc":"2.0","result":{"structuredContent":{"results":[{"id":"first"}]}}}',
      '',
      'data: {"jsonrpc":"2.0","result":{"structuredContent":{"results":[]}}}',
      '',
    ].join("\n");
    vi.stubGlobal("fetch", vi.fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({ result: { structuredContent: { id: "box-user-1" } } }), { status: 200 }))
      .mockResolvedValueOnce(new Response(streamed, { status: 200, headers: { "content-type": "text/event-stream" } })));
    await expect(readExternalMcpNativeToolResult(actor, { workspaceId: "ws-1", connectionId: connection.id,
      connectionGrantHash: externalMcpConnectionGrantHash(connection), providerKey: "box", serverUrl: connection.serverUrl,
      providerAccountId: "box-user-1", mode: "SEARCH", toolName: "search_files_keyword",
      arguments: externalMcpNativeReadRequest("box", "SEARCH", { query: "budget", limit: 1 }).arguments }))
      .rejects.toMatchObject({ code: "EXTERNAL_MCP_ERROR" });
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

  it("allows selected Box file content reads through the server-side connection helper", async () => {
    externalMcpConnectionMock.findFirst.mockResolvedValue(activeBoxConnection());
    vi.stubGlobal("fetch", vi.fn().mockImplementation(async (_url: string, options: any) => new Response(JSON.stringify({
      result: {
        structuredContent: JSON.parse(options.body).params.name === "who_am_i" ? { id: "box-user-1" } : { text: "Selected file content" },
      },
    }), { status: 200 })));
    const { callBoxExternalMcpReadToolForConnection } = await import("./external-mcp");

    const result = await callBoxExternalMcpReadToolForConnection(actor, {
      workspaceId: "ws-1",
      connectionId: "box-connection-1",
      toolName: "get_file_content",
      arguments: { file_id: "123" },
    });

    expect(result).toEqual({ text: "Selected file content" });
    expect(externalMcpConnectionMock.findFirst).toHaveBeenCalledWith({
      where: {
        id: "box-connection-1",
        userId: "user-1",
        workspaceId: "ws-1",
        providerKey: "box",
        status: "ACTIVE",
      },
    });
    expect(fetch).toHaveBeenCalledWith("https://mcp.box.com", expect.objectContaining({
      body: expect.stringContaining("\"name\":\"get_file_content\""),
    }));
    expect(JSON.stringify(recordAuditMock.mock.calls)).not.toContain("box-token");
  });

  it("withholds another user's selected connection before a provider call", async () => {
    externalMcpConnectionMock.findFirst.mockResolvedValue(activeBoxConnection({ userId: "other-user" }));
    vi.stubGlobal("fetch", vi.fn());
    const { callBoxExternalMcpReadToolForConnection } = await import("./external-mcp");
    await expect(callBoxExternalMcpReadToolForConnection(actor, { workspaceId: "ws-1", connectionId: "box-connection-1",
      toolName: "get_file_content", arguments: { file_id: "123" } })).rejects.toMatchObject({ code: "SOURCE_RESTRICTED" });
    expect(fetch).not.toHaveBeenCalled();
  });
  it("withholds content when the real provider principal changed under a stored connection", async () => {
    externalMcpConnectionMock.findFirst.mockResolvedValue(activeBoxConnection());
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(JSON.stringify({ result: { structuredContent: { id: "other-box-user" } } }), { status: 200 })));
    const { callBoxExternalMcpReadToolForConnection } = await import("./external-mcp");
    await expect(callBoxExternalMcpReadToolForConnection(actor, { workspaceId: "ws-1", connectionId: "box-connection-1",
      toolName: "get_file_content", arguments: { file_id: "123" } })).rejects.toMatchObject({ code: "SOURCE_RESTRICTED" });
    expect(fetch).toHaveBeenCalledTimes(1);
  });
  it("withholds MCP error payloads instead of materializing provider error text", async () => {
    externalMcpConnectionMock.findFirst.mockResolvedValue(activeBoxConnection());
    vi.stubGlobal("fetch", vi.fn().mockImplementation(async (_url: string, options: any) => new Response(JSON.stringify({ result:
      JSON.parse(options.body).params.name === "who_am_i" ? { structuredContent: { id: "box-user-1" } }
        : { isError: true, content: [{ type: "text", text: "Restricted provider error bytes" }] } }), { status: 200 })));
    const { callBoxExternalMcpReadToolForConnection } = await import("./external-mcp");
    await expect(callBoxExternalMcpReadToolForConnection(actor, { workspaceId: "ws-1", connectionId: "box-connection-1",
      toolName: "get_file_content", arguments: { file_id: "123" } })).rejects.toMatchObject({ code: "SOURCE_RESTRICTED" });
    expect(JSON.stringify(recordAuditMock.mock.calls)).not.toContain("Restricted provider error bytes");
  });
  it("rejects non-allowlisted Box write tools before loading the connection", async () => {
    vi.stubGlobal("fetch", vi.fn());
    const { callBoxExternalMcpReadToolForConnection } = await import("./external-mcp");

    await expect(callBoxExternalMcpReadToolForConnection(actor, {
      workspaceId: "ws-1",
      connectionId: "box-connection-1",
      toolName: "update_file_properties",
      arguments: { file_id: "123", name: "New name" },
    })).rejects.toThrow("Box write tools are disabled in Corgtex v1.");
    expect(externalMcpConnectionMock.findFirst).not.toHaveBeenCalled();
    expect(fetch).not.toHaveBeenCalled();
  });
});
