import { NextRequest } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

const {
  actor,
  coerceWorkItemPriorityInput,
  createAction,
  deleteAction,
  formatWorkItemPriority,
  getWorkspacePermanentPathForEntity,
  listActions,
  prisma,
  updateAction,
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
  coerceWorkItemPriorityInput: vi.fn((input: unknown) => {
    if (input === "Urgent" || input === 3) return 3;
    if (input === "Important" || input === 2) return 2;
    if (input === "Medium" || input === 1) return 1;
    if (input === "Low" || input === 0) return 0;
    return undefined;
  }),
  createAction: vi.fn(),
  deleteAction: vi.fn(),
  formatWorkItemPriority: vi.fn((priority: number | null | undefined) => {
    if ((priority ?? 0) >= 3) return "Urgent";
    if ((priority ?? 0) >= 2) return "Important";
    if ((priority ?? 0) >= 1) return "Medium";
    return "Low";
  }),
  getWorkspacePermanentPathForEntity: vi.fn(),
  listActions: vi.fn(),
  prisma: {
    action: {
      findFirst: vi.fn(),
    },
  },
  updateAction: vi.fn(),
}));

vi.mock("@corgtex/domain", async () => {
  const {
    normalizeActionWorkItem,
    normalizeGoalWorkItem,
    normalizeProposalWorkItem,
    normalizeTensionWorkItem,
    workItemMemberDisplayName,
    workItemUserDisplayName,
  } = await import("../../../../../../../packages/domain/src/work-item-normalization");

  return {
    AppError: class AppError extends Error {
      status: number;
      code: string;

      constructor(status: number, code: string, message: string) {
        super(message);
        this.status = status;
        this.code = code;
      }
    },
    coerceWorkItemPriorityInput,
    createAction,
    deleteAction,
    formatWorkItemPriority,
    getWorkspacePermanentPathForEntity,
    listActions,
    normalizeActionWorkItem,
    normalizeGoalWorkItem,
    normalizeProposalWorkItem,
    normalizeTensionWorkItem,
    updateAction,
    workItemMemberDisplayName,
    workItemUserDisplayName,
  };
});

vi.mock("@corgtex/shared", () => ({
  env: {
    APP_URL: "https://app.corgtex.com",
  },
  prisma,
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

vi.mock("@/lib/auth", () => ({
  resolveRequestActor: vi.fn(async () => actor),
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
      items: [{
        id: "action-1",
        title: "Follow up",
        priority: 2,
        assigneeMemberId: "member-2",
        assigneeMember: { id: "member-2", user: { displayName: "Assignee", email: "assignee@example.test" } },
      }],
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
        items: [{
          id: "action-1",
          title: "Follow up",
          priority: 2,
          priorityLabel: "Important",
          assigneeMemberId: "member-2",
          assigneeMemberName: "Assignee",
          assignee: "Assignee",
          responsibleMemberId: "member-2",
          responsibleMemberName: "Assignee",
          responsiblePerson: "Assignee",
          ownerMemberId: "member-2",
          ownerMemberName: "Assignee",
          owner: "Assignee",
          adviceRequestCount: null,
          activeAdviceRequestCount: null,
          inputRequestCount: null,
          activeInputRequestCount: null,
          assigneeMember: { id: "member-2", user: { displayName: "Assignee", email: "assignee@example.test" } },
        }],
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

describe("POST /api/workspaces/[workspaceId]/actions", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    getWorkspacePermanentPathForEntity.mockResolvedValue(null);
    createAction.mockResolvedValue({
      id: "action-1",
      title: "Follow up",
      status: "DRAFT",
      priority: 2,
      assigneeMemberId: "member-2",
    });
    prisma.action.findFirst.mockResolvedValue({
      id: "action-1",
      title: "Follow up",
      status: "DRAFT",
      priority: 2,
      assigneeMemberId: "member-2",
      assigneeMember: { id: "member-2", user: { displayName: "Assignee", email: "assignee@example.test" } },
    });
  });

  it("passes assignee and labeled priority into the action create backend", async () => {
    const { POST } = await import("./route");

    const response = await POST(
      new NextRequest("http://localhost/api/workspaces/workspace-1/actions", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          title: "Follow up",
          bodyMd: "Call the client",
          assigneeMemberId: "member-2",
          priorityLabel: "Important",
        }),
      }),
      context(),
    );

    expect(response.status).toBe(201);
    expect(createAction).toHaveBeenCalledWith(actor, expect.objectContaining({
      workspaceId: "workspace-1",
      title: "Follow up",
      bodyMd: "Call the client",
      assigneeMemberId: "member-2",
      priority: 2,
    }));
    await expect(response.json()).resolves.toMatchObject({
      action: {
        id: "action-1",
        priority: 2,
        priorityLabel: "Important",
        assigneeMemberId: "member-2",
        assigneeMemberName: "Assignee",
        assignee: "Assignee",
      },
    });
  });
});

describe("PATCH /api/workspaces/[workspaceId]/actions/[actionId]", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    updateAction.mockResolvedValue({
      id: "action-1",
      status: "OPEN",
      priority: 3,
      assigneeMemberId: "member-2",
    });
    prisma.action.findFirst.mockResolvedValue({
      id: "action-1",
      status: "OPEN",
      priority: 3,
      assigneeMemberId: "member-2",
      assigneeMember: { id: "member-2", user: { displayName: "Assignee", email: "assignee@example.test" } },
    });
  });

  it("passes assignee and labeled priority into the action update backend", async () => {
    const { PATCH } = await import("./[actionId]/route");

    const response = await PATCH(
      new NextRequest("http://localhost/api/workspaces/workspace-1/actions/action-1", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          assigneeMemberId: "member-2",
          priority: "Urgent",
        }),
      }),
      { params: Promise.resolve({ workspaceId: "workspace-1", actionId: "action-1" }) },
    );

    expect(updateAction).toHaveBeenCalledWith(actor, expect.objectContaining({
      workspaceId: "workspace-1",
      actionId: "action-1",
      assigneeMemberId: "member-2",
      priority: 3,
    }));
    await expect(response.json()).resolves.toMatchObject({
      action: {
        id: "action-1",
        priorityLabel: "Urgent",
        assigneeMemberId: "member-2",
        assigneeMemberName: "Assignee",
        assignee: "Assignee",
      },
    });
  });
});
