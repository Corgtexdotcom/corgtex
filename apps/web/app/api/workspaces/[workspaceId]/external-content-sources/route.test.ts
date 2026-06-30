import { NextRequest, NextResponse } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

const {
  handleRouteError,
  listExternalContentSources,
  requireWorkspaceMembership,
  resolveRequestActor,
  selectExternalContentSource,
} = vi.hoisted(() => ({
  handleRouteError: vi.fn((error: unknown) => NextResponse.json({ error: String(error) }, { status: 500 })),
  listExternalContentSources: vi.fn(),
  requireWorkspaceMembership: vi.fn(),
  resolveRequestActor: vi.fn(),
  selectExternalContentSource: vi.fn(),
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
  EXTERNAL_CONTENT_SOURCE_KINDS: ["HUB", "FOLDER", "FILE"],
  listExternalContentSources,
  requireWorkspaceMembership,
  selectExternalContentSource,
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

function request(path = "http://localhost/api/workspaces/workspace-1/external-content-sources", init?: ConstructorParameters<typeof NextRequest>[1]) {
  return new NextRequest(path, init);
}

describe("external content source API", () => {
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

  it("lists selected Box sources after workspace authorization", async () => {
    listExternalContentSources.mockResolvedValueOnce([
      {
        id: "source-1",
        providerKey: "box",
        sourceKind: "HUB",
        title: "Client Hub",
      },
    ]);
    const { GET } = await import("./route");

    const response = await GET(request("http://localhost/api/workspaces/workspace-1/external-content-sources?providerKey=box"), context());
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(requireWorkspaceMembership).toHaveBeenCalledWith({
      actor: expect.objectContaining({ kind: "user" }),
      workspaceId: "workspace-1",
    });
    expect(listExternalContentSources).toHaveBeenCalledWith(expect.objectContaining({ kind: "user" }), {
      workspaceId: "workspace-1",
      providerKey: "box",
    });
    expect(body).toEqual({
      items: [
        expect.objectContaining({
          id: "source-1",
          providerKey: "box",
        }),
      ],
    });
  });

  it("selects a Box source without exposing connection tokens", async () => {
    selectExternalContentSource.mockResolvedValueOnce({
      id: "source-1",
      providerKey: "box",
      sourceKind: "FILE",
      externalId: "file-1",
      title: "Launch plan",
      status: "SYNCING",
    });
    const { POST } = await import("./route");

    const response = await POST(request(undefined, {
      method: "POST",
      body: JSON.stringify({
        providerKey: "box",
        sourceKind: "FILE",
        externalId: "file-1",
        title: "Launch plan",
        connectionId: "connection-1",
      }),
    }), context());
    const text = await response.text();

    expect(response.status).toBe(201);
    expect(selectExternalContentSource).toHaveBeenCalledWith(expect.objectContaining({ kind: "user" }), expect.objectContaining({
      workspaceId: "workspace-1",
      providerKey: "box",
      sourceKind: "FILE",
      externalId: "file-1",
      connectionId: "connection-1",
    }));
    expect(text).toContain("source-1");
    expect(text).not.toContain("accessToken");
    expect(text).not.toContain("refreshToken");
  });
});
