import { NextRequest, NextResponse } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

const {
  handleRouteError,
  listAiWorkspaceToolProviders,
  listMcpOAuthConnectionStatuses,
  requireWorkspaceMembership,
  resolveRequestActor,
  verifyAiWorkspaceProviderConnection,
} = vi.hoisted(() => ({
  handleRouteError: vi.fn((error: unknown) => NextResponse.json({ error: String(error) }, { status: 500 })),
  listAiWorkspaceToolProviders: vi.fn(),
  listMcpOAuthConnectionStatuses: vi.fn(),
  requireWorkspaceMembership: vi.fn(),
  resolveRequestActor: vi.fn(),
  verifyAiWorkspaceProviderConnection: vi.fn(),
}));

class MockAppError extends Error {
  status: number;
  code: string;

  constructor(status: number, code: string, message: string) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

vi.mock("@corgtex/domain", () => ({
  AppError: MockAppError,
  listAiWorkspaceToolProviders,
  listMcpOAuthConnectionStatuses,
  requireWorkspaceMembership,
  verifyAiWorkspaceProviderConnection,
}));

vi.mock("@/lib/auth", () => ({
  resolveRequestActor,
}));

vi.mock("@/lib/http", () => {
  return {
    handleRouteError,
    validateBody: async (request: NextRequest, schema: any) => {
      const body = await request.json();
      const parsed = schema.safeParse(body);
      if (!parsed.success) {
        throw new MockAppError(400, "VALIDATION_ERROR", "Request body failed validation.");
      }
      return parsed.data;
    },
  };
});

function context(workspaceId = "workspace-1") {
  return { params: Promise.resolve({ workspaceId }) };
}

function request(workspaceId = "workspace-1", init?: ConstructorParameters<typeof NextRequest>[1]) {
  return new NextRequest(`http://localhost/api/workspaces/${workspaceId}/mcp-connections`, init);
}

describe("GET /api/workspaces/[workspaceId]/mcp-connections", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    resolveRequestActor.mockResolvedValue({
      kind: "user",
      user: {
        id: "user-1",
        email: "user@example.com",
        displayName: "User",
        globalRole: "USER",
      },
    });
    requireWorkspaceMembership.mockResolvedValue({ id: "member-1" });
    listAiWorkspaceToolProviders.mockReturnValue([
      { key: "openwork" },
      { key: "chatgpt" },
      { key: "claude" },
      { key: "cursor" },
      { key: "generic_mcp" },
    ]);
    listMcpOAuthConnectionStatuses.mockResolvedValue([
      {
        providerKey: "claude",
        connected: true,
        connectedAt: new Date("2026-05-20T16:00:00.000Z"),
        source: "mcp_oauth",
        clientName: "Claude",
      },
      {
        providerKey: "chatgpt",
        connected: true,
        connectedAt: new Date("2026-05-20T15:30:00.000Z"),
        source: "mcp_oauth",
        clientName: "ChatGPT Connector",
      },
    ]);
    verifyAiWorkspaceProviderConnection.mockResolvedValue({
      providerKey: "cursor",
      verified: true,
      connectedAt: new Date("2026-05-20T16:00:00.000Z"),
      message: "Cursor is connected through Corgtex OAuth.",
      state: {
        activeProviderKey: "cursor",
        connections: [{ providerKey: "cursor", healthStatus: "CONNECTED" }],
        providers: [],
      },
    });
  });

  it("returns no-store provider OAuth signals and legacy Claude compatibility after workspace authorization", async () => {
    const { GET } = await import("./route");
    const response = await GET(request(), context());
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(requireWorkspaceMembership).toHaveBeenCalledWith({
      actor: expect.objectContaining({ kind: "user" }),
      workspaceId: "workspace-1",
    });
    expect(listMcpOAuthConnectionStatuses).toHaveBeenCalledWith({
      userId: "user-1",
      workspaceId: "workspace-1",
    });
    expect(body).toEqual({
      claude: {
        connected: true,
        connectedAt: "2026-05-20T16:00:00.000Z",
      },
      connections: [
        {
          providerKey: "openwork",
          connected: false,
          connectedAt: null,
          source: null,
          clientName: null,
        },
        {
          providerKey: "chatgpt",
          connected: true,
          connectedAt: "2026-05-20T15:30:00.000Z",
          source: "mcp_oauth:chatgpt",
          clientName: "ChatGPT Connector",
        },
        {
          providerKey: "claude",
          connected: true,
          connectedAt: "2026-05-20T16:00:00.000Z",
          source: "mcp_oauth:claude",
          clientName: "Claude",
        },
        {
          providerKey: "cursor",
          connected: false,
          connectedAt: null,
          source: null,
          clientName: null,
        },
        {
          providerKey: "generic_mcp",
          connected: false,
          connectedAt: null,
          source: null,
          clientName: null,
        },
      ],
      signals: {
        openwork: {
          connected: false,
          connectedAt: null,
          source: null,
        },
        chatgpt: {
          connected: true,
          connectedAt: "2026-05-20T15:30:00.000Z",
          source: "mcp_oauth:chatgpt",
        },
        claude: {
          connected: true,
          connectedAt: "2026-05-20T16:00:00.000Z",
          source: "mcp_oauth:claude",
        },
        cursor: {
          connected: false,
          connectedAt: null,
          source: null,
        },
        generic_mcp: {
          connected: false,
          connectedAt: null,
          source: null,
        },
      },
    });
  });

  it("returns disconnected provider payloads when no token is active", async () => {
    listMcpOAuthConnectionStatuses.mockResolvedValueOnce([]);

    const { GET } = await import("./route");
    const response = await GET(request(), context());

    await expect(response.json()).resolves.toMatchObject({
      claude: {
        connected: false,
        connectedAt: null,
      },
      signals: {
        chatgpt: {
          connected: false,
          connectedAt: null,
          source: null,
        },
        claude: {
          connected: false,
          connectedAt: null,
          source: null,
        },
      },
    });
  });

  it("does not query user OAuth state for non-user actors after workspace authorization", async () => {
    resolveRequestActor.mockResolvedValueOnce({
      kind: "agent",
      agent: {
        id: "agent-1",
        workspaceId: "workspace-1",
        scopes: ["workspace:read"],
      },
    });

    const { GET } = await import("./route");
    const response = await GET(request(), context());

    expect(response.status).toBe(200);
    expect(listMcpOAuthConnectionStatuses).not.toHaveBeenCalled();
    await expect(response.json()).resolves.toMatchObject({
      claude: {
        connected: false,
        connectedAt: null,
      },
      signals: {
        chatgpt: {
          connected: false,
          connectedAt: null,
          source: null,
        },
        claude: {
          connected: false,
          connectedAt: null,
          source: null,
        },
      },
    });
  });

  it("uses the shared route error handler when workspace authorization fails", async () => {
    requireWorkspaceMembership.mockRejectedValueOnce(new MockAppError(403, "FORBIDDEN", "Forbidden"));

    const { GET } = await import("./route");
    const response = await GET(request(), context());

    expect(response.status).toBe(500);
    expect(handleRouteError).toHaveBeenCalledWith(expect.any(MockAppError));
    expect(listMcpOAuthConnectionStatuses).not.toHaveBeenCalled();
  });

  it("verifies a provider connection through the domain", async () => {
    const { POST } = await import("./route");
    const response = await POST(
      request("workspace-1", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "verify", providerKey: "cursor" }),
      }),
      context(),
    );

    expect(response.status).toBe(200);
    expect(verifyAiWorkspaceProviderConnection).toHaveBeenCalledWith(expect.objectContaining({ kind: "user" }), {
      workspaceId: "workspace-1",
      providerKey: "cursor",
    });
    await expect(response.json()).resolves.toMatchObject({
      providerKey: "cursor",
      verified: true,
      message: "Cursor is connected through Corgtex OAuth.",
    });
  });

  it("rejects the deprecated manual mark-connected action", async () => {
    const { POST } = await import("./route");
    const response = await POST(
      request("workspace-1", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "mark_connected", providerKey: "chatgpt" }),
      }),
      context(),
    );

    expect(response.status).toBe(500);
    expect(verifyAiWorkspaceProviderConnection).not.toHaveBeenCalled();
    expect(handleRouteError).toHaveBeenCalled();
  });

  it("rejects invalid connection actions before calling the domain", async () => {
    const { POST } = await import("./route");
    const response = await POST(
      request("workspace-1", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "connect", providerKey: "claude" }),
      }),
      context(),
    );

    expect(response.status).toBe(500);
    expect(verifyAiWorkspaceProviderConnection).not.toHaveBeenCalled();
    expect(handleRouteError).toHaveBeenCalled();
  });
});
