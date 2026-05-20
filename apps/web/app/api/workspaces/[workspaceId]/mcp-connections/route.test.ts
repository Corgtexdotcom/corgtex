import { NextRequest, NextResponse } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

const {
  getClaudeMcpConnectionStatus,
  handleRouteError,
  requireWorkspaceMembership,
  resolveRequestActor,
} = vi.hoisted(() => ({
  getClaudeMcpConnectionStatus: vi.fn(),
  handleRouteError: vi.fn((error: unknown) => NextResponse.json({ error: String(error) }, { status: 500 })),
  requireWorkspaceMembership: vi.fn(),
  resolveRequestActor: vi.fn(),
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
  requireWorkspaceMembership,
}));

vi.mock("@/lib/auth", () => ({
  resolveRequestActor,
}));

vi.mock("@/lib/http", () => {
  return {
    handleRouteError,
  };
});

function context(workspaceId = "workspace-1") {
  return { params: Promise.resolve({ workspaceId }) };
}

function request(workspaceId = "workspace-1") {
  return new NextRequest(`http://localhost/api/workspaces/${workspaceId}/mcp-connections`);
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
});
