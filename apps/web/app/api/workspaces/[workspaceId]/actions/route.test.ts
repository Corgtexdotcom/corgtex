import { NextRequest } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

const {
  actor,
  createAction,
  getWorkspacePermanentPathForEntity,
  listActions,
} = vi.hoisted(() => ({
  actor: {
    kind: "user" as const,
    user: {
      id: "user-1",
      email: "user@example.com",
      displayName: "User",
      globalRole: "USER",
    },
  },
  createAction: vi.fn(),
  getWorkspacePermanentPathForEntity: vi.fn(),
  listActions: vi.fn(),
}));

vi.mock("@corgtex/domain", () => ({
  createAction,
  getWorkspacePermanentPathForEntity,
  listActions,
}));

vi.mock("@corgtex/shared", () => ({
  env: {
    APP_URL: "https://app.corgtex.com",
  },
}));

vi.mock("@/lib/route-handler", () => ({
  withWorkspaceRoute: (handler: any) => async (request: NextRequest, context: { params: Promise<Record<string, string>> }) => {
    const params = await context.params;
    return handler(request, {
      actor,
      membership: { id: "member-1", role: "ADMIN" },
      workspaceId: params.workspaceId,
      params,
    });
  },
}));

function context(workspaceId = "workspace-1") {
  return { params: Promise.resolve({ workspaceId }) };
}

function request(path: string) {
  return new NextRequest(path);
}

describe("GET /api/workspaces/[workspaceId]/actions", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    listActions.mockResolvedValue({
      items: [{ id: "action-1", title: "Follow up" }],
      total: 1,
      take: 50,
      skip: 10,
    });
  });

  it("passes page filter query params into the shared action list backend", async () => {
    const { GET } = await import("./route");

    const response = await GET(
      request("http://localhost/api/workspaces/workspace-1/actions?memberId=member-1&memberId=member-2&memberId=member-1&circleId=circle-1&circleId=&status=OPEN&sort=date&take=50&skip=10&archiveFilter=all"),
      context(),
    );

    await expect(response.json()).resolves.toEqual({
      actions: {
        items: [{ id: "action-1", title: "Follow up" }],
        total: 1,
        take: 50,
        skip: 10,
      },
    });
    expect(listActions).toHaveBeenCalledWith(actor, "workspace-1", {
      archiveFilter: "all",
      status: "OPEN",
      circleIds: ["circle-1"],
      memberIds: ["member-1", "member-2"],
      sort: "date",
      take: 50,
      skip: 10,
    });
  });
});
