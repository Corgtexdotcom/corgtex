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
  },
  prismaTransactionMock: vi.fn(async (callback: (tx: unknown) => Promise<unknown>) => callback({})),
  recordAuditMock: vi.fn(),
  requireWorkspaceMembershipMock: vi.fn(),
}));

vi.mock("@corgtex/shared", () => ({
  decryptSecret: decryptSecretMock,
  encryptSecret: encryptSecretMock,
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
    scopes: ["search"],
    capabilities: null,
    status: "ACTIVE",
    lastError: null,
  };
}

describe("external MCP gateway", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    requireWorkspaceMembershipMock.mockResolvedValue({ id: "member-1" });
    recordAuditMock.mockResolvedValue({ id: "audit-1" });
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("lists Notion as connectable when the user has no connection", async () => {
    externalMcpConnectionMock.findMany.mockResolvedValueOnce([]);
    const { listExternalMcpConnections } = await import("./external-mcp");

    const connections = await listExternalMcpConnections(actor, "ws-1");

    expect(requireWorkspaceMembershipMock).toHaveBeenCalledWith({ actor, workspaceId: "ws-1" });
    expect(connections).toEqual([
      expect.objectContaining({
        providerKey: "notion",
        displayName: "Notion",
        status: "needs_connection",
        connectionId: null,
        supportsSearch: true,
        supportsFetch: true,
        searchToolName: "notion-search",
        fetchToolName: "notion-fetch",
      }),
    ]);
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
});
