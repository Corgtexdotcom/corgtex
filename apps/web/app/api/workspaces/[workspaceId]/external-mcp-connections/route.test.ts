import { NextRequest, NextResponse } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

const {
  handleRouteError,
  listExternalMcpConnections,
  requireWorkspaceMembership,
  resolveRequestActor,
  upsertExternalMcpConnection,
} = vi.hoisted(() => ({
  handleRouteError: vi.fn((error: unknown) => NextResponse.json({ error: String(error) }, { status: 500 })),
  listExternalMcpConnections: vi.fn(),
  requireWorkspaceMembership: vi.fn(),
  resolveRequestActor: vi.fn(),
  upsertExternalMcpConnection: vi.fn(),
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
  listExternalMcpConnections,
  requireWorkspaceMembership,
  upsertExternalMcpConnection,
}));

vi.mock("@/lib/auth", () => ({
  resolveRequestActor,
}));

vi.mock("@/lib/http", () => ({
  handleRouteError,
  validateBody: async (request: NextRequest, schema: any) => {
    const body = await request.json();
    const parsed = schema.safeParse(body);
    if (!parsed.success) {
      throw new MockAppError(400, "VALIDATION_ERROR", "Request body failed validation.");
    }
    return parsed.data;
  },
}));

function context(workspaceId = "workspace-1") {
  return { params: Promise.resolve({ workspaceId }) };
}

function request(init?: ConstructorParameters<typeof NextRequest>[1]) {
  return new NextRequest("http://localhost/api/workspaces/workspace-1/external-mcp-connections", init);
}

describe("external MCP connection API", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    resolveRequestActor.mockResolvedValue({
      kind: "user",
      user: {
        id: "user-1",
        email: "user@example.com",
        displayName: "User",
      },
    });
    requireWorkspaceMembership.mockResolvedValue({ id: "member-1" });
  });

  it("accepts Box connection metadata while keeping tokens out of the response", async () => {
    upsertExternalMcpConnection.mockResolvedValueOnce({ id: "connection-1" });
    listExternalMcpConnections.mockResolvedValueOnce([
      {
        providerKey: "box",
        displayName: "Box",
        connectionId: "connection-1",
        providerAccountId: "box-user-1",
        providerEmail: "box@example.com",
        status: "connected",
        scopes: ["root_readwrite", "ai.readwrite"],
      },
    ]);
    const { POST } = await import("./route");

    const response = await POST(request({
      method: "POST",
      body: JSON.stringify({
        providerKey: "box",
        accessToken: "box-access-token",
        refreshToken: "box-refresh-token",
        providerAccountId: "box-user-1",
        providerEmail: "box@example.com",
        expiresIn: 3600,
        scopes: ["root_readwrite", "ai.readwrite"],
      }),
    }), context());
    const text = await response.text();

    expect(response.status).toBe(201);
    expect(upsertExternalMcpConnection).toHaveBeenCalledWith(expect.objectContaining({ kind: "user" }), expect.objectContaining({
      workspaceId: "workspace-1",
      providerKey: "box",
      accessToken: "box-access-token",
      refreshToken: "box-refresh-token",
      providerAccountId: "box-user-1",
      providerEmail: "box@example.com",
      expiresIn: 3600,
    }));
    expect(text).toContain("connection-1");
    expect(text).not.toContain("box-access-token");
    expect(text).not.toContain("box-refresh-token");
  });
});
