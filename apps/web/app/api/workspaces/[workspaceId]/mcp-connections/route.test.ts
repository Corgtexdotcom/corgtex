import { NextRequest, NextResponse } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

const {
  getClaudeMcpConnectionStatus,
  handleRouteError,
  markAiWorkspaceProviderConnected,
  requireWorkspaceMembership,
  resolveRequestActor,
  verifyAiWorkspaceProviderConnection,
} = vi.hoisted(() => ({
  getClaudeMcpConnectionStatus: vi.fn(),
  handleRouteError: vi.fn((error: unknown) => NextResponse.json({ error: String(error) }, { status: 500 })),
  markAiWorkspaceProviderConnected: vi.fn(),
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
  getClaudeMcpConnectionStatus,
  markAiWorkspaceProviderConnected,
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
    getClaudeMcpConnectionStatus.mockResolvedValue({
      connected: true,
      connectedAt: new Date("2026-05-20T16:00:00.000Z"),
    });
    verifyAiWorkspaceProviderConnection.mockResolvedValue({
      providerKey: "claude",
      verified: true,
      connectedAt: new Date("2026-05-20T16:00:00.000Z"),
      message: "Claude is connected.",
      state: {
        activeProviderKey: "claude",
        connections: [{ providerKey: "claude", healthStatus: "CONNECTED" }],
        providers: [],
      },
    });
    markAiWorkspaceProviderConnected.mockResolvedValue({
      activeProviderKey: "chatgpt",
      connections: [{ providerKey: "chatgpt", healthStatus: "CONNECTED" }],
      providers: [],
    });
  });

  it("returns no-store Claude connection status after workspace authorization", async () => {
    const { GET } = await import("./route");
    const response = await GET(request(), context());
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(requireWorkspaceMembership).toHaveBeenCalledWith({
      actor: expect.objectContaining({ kind: "user" }),
      workspaceId: "workspace-1",
    });
    expect(getClaudeMcpConnectionStatus).toHaveBeenCalledWith({
      userId: "user-1",
      workspaceId: "workspace-1",
    });
    expect(body).toEqual({
      claude: {
        connected: true,
        connectedAt: "2026-05-20T16:00:00.000Z",
      },
      signals: {
        claude: {
          connected: true,
          connectedAt: "2026-05-20T16:00:00.000Z",
          source: "claude_oauth",
        },
      },
    });
  });

  it("returns a disconnected Claude payload when no token is active", async () => {
    getClaudeMcpConnectionStatus.mockResolvedValueOnce({
      connected: false,
      connectedAt: null,
    });

    const { GET } = await import("./route");
    const response = await GET(request(), context());

    await expect(response.json()).resolves.toEqual({
      claude: {
        connected: false,
        connectedAt: null,
      },
      signals: {
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
    expect(getClaudeMcpConnectionStatus).not.toHaveBeenCalled();
    await expect(response.json()).resolves.toEqual({
      claude: {
        connected: false,
        connectedAt: null,
      },
      signals: {
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
    expect(getClaudeMcpConnectionStatus).not.toHaveBeenCalled();
  });

  it("verifies a provider connection through the domain", async () => {
    const { POST } = await import("./route");
    const response = await POST(
      request("workspace-1", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "verify", providerKey: "claude" }),
      }),
      context(),
    );

    expect(response.status).toBe(200);
    expect(verifyAiWorkspaceProviderConnection).toHaveBeenCalledWith(expect.objectContaining({ kind: "user" }), {
      workspaceId: "workspace-1",
      providerKey: "claude",
    });
    await expect(response.json()).resolves.toMatchObject({
      providerKey: "claude",
      verified: true,
      message: "Claude is connected.",
    });
  });

  it("marks a manually completed provider connected", async () => {
    const { POST } = await import("./route");
    const response = await POST(
      request("workspace-1", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "mark_connected", providerKey: "chatgpt" }),
      }),
      context(),
    );

    expect(response.status).toBe(200);
    expect(markAiWorkspaceProviderConnected).toHaveBeenCalledWith(expect.objectContaining({ kind: "user" }), {
      workspaceId: "workspace-1",
      providerKey: "chatgpt",
      source: "manual",
    });
    await expect(response.json()).resolves.toMatchObject({
      providerKey: "chatgpt",
      verified: true,
      message: "Connection marked as complete.",
      state: {
        activeProviderKey: "chatgpt",
      },
    });
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
    expect(markAiWorkspaceProviderConnected).not.toHaveBeenCalled();
    expect(handleRouteError).toHaveBeenCalled();
  });
});
