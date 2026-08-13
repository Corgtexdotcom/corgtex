import { NextRequest } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

const {
  actor,
  coerceWorkItemPriorityInput,
  createAction,
  deleteAction,
  formatWorkItemPriority,
  getWorkspacePermanentPathForEntity,
  loadAdviceRequestCountSummaries,
  listActions,
  prisma,
  resolveRequestActor,
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
  loadAdviceRequestCountSummaries: vi.fn(),
  listActions: vi.fn(),
  prisma: {
    action: {
      findFirst: vi.fn(),
    },
  },
  resolveRequestActor: vi.fn(),
  updateAction: vi.fn(),
}));

resolveRequestActor.mockResolvedValue(actor);

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
    loadAdviceRequestCountSummaries,
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
  captureErrorTelemetry: vi.fn(),
  env: {
    APP_URL: "https://app.corgtex.com",
  },
  isDatabaseUnavailableError: vi.fn(() => false),
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
  resolveRequestActor,
}));

function context(workspaceId = "workspace-1") {
  return { params: Promise.resolve({ workspaceId }) };
}

function request(path: string) {
  return new NextRequest(path);
}

function actionPatchRequest(body: unknown) {
  return new NextRequest("http://localhost/api/workspaces/workspace-1/actions/action-1", {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}

function routeError(status: number, code: string, message: string) {
  return Object.assign(new Error(message), { status, code });
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
      request("http://localhost/api/workspaces/workspace-1/actions?memberId=member-1&memberId=member-2&memberId=member-1&assigneeMemberId=member-2&assigneeMemberId=member-3&assigneeMemberId=member-2&circleId=circle-1&circleId=&status=OPEN&sort=date&take=50&skip=10&archiveFilter=all"),
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
      assigneeMemberIds: ["member-2", "member-3"],
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
    loadAdviceRequestCountSummaries.mockResolvedValue(new Map([
      ["action-1", {
        adviceRequestCount: 0,
        activeAdviceRequestCount: 0,
        inputRequestCount: 0,
        activeInputRequestCount: 0,
      }],
    ]));
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
        inputRequestCount: 0,
        activeInputRequestCount: 0,
        assigneeMemberId: "member-2",
        assigneeMemberName: "Assignee",
        assignee: "Assignee",
      },
    });
    expect(loadAdviceRequestCountSummaries).toHaveBeenCalledWith("workspace-1", "ACTION", ["action-1"]);
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
      version: 3,
    });
    prisma.action.findFirst.mockResolvedValue({
      id: "action-1",
      status: "OPEN",
      priority: 3,
      assigneeMemberId: "member-2",
      version: 3,
      assigneeMember: { id: "member-2", user: { displayName: "Assignee", email: "assignee@example.test" } },
    });
    loadAdviceRequestCountSummaries.mockResolvedValue(new Map([
      ["action-1", {
        adviceRequestCount: 2,
        activeAdviceRequestCount: 1,
        inputRequestCount: 2,
        activeInputRequestCount: 1,
      }],
    ]));
  });

  it("passes assignee and labeled priority into the action update backend", async () => {
    const { PATCH } = await import("./[actionId]/route");

    const response = await PATCH(
      actionPatchRequest({
        assigneeMemberId: "member-2",
        priority: "Urgent",
        expectedVersion: 2,
      }),
      { params: Promise.resolve({ workspaceId: "workspace-1", actionId: "action-1" }) },
    );

    expect(updateAction).toHaveBeenCalledWith(actor, expect.objectContaining({
      workspaceId: "workspace-1",
      actionId: "action-1",
      assigneeMemberId: "member-2",
      priority: 3,
      expectedVersion: 2,
    }));
    await expect(response.json()).resolves.toMatchObject({
      action: {
        id: "action-1",
        priorityLabel: "Urgent",
        inputRequestCount: 2,
        activeInputRequestCount: 1,
        assigneeMemberId: "member-2",
        assigneeMemberName: "Assignee",
        assignee: "Assignee",
        version: 3,
      },
    });
  });

  it("preserves date-only due date updates", async () => {
    const { PATCH } = await import("./[actionId]/route");
    const response = await PATCH(actionPatchRequest({
      dueAt: "2026-08-12",
      expectedVersion: 2,
    }), {
      params: Promise.resolve({ workspaceId: "workspace-1", actionId: "action-1" }),
    });

    expect(response.status).toBe(200);
    expect(updateAction).toHaveBeenCalledWith(actor, expect.objectContaining({
      workspaceId: "workspace-1",
      actionId: "action-1",
      dueAt: new Date("2026-08-12"),
      expectedVersion: 2,
    }));
  });

  it.each([
    ["missing", { title: "Updated action" }],
    ["zero", { title: "Updated action", expectedVersion: 0 }],
    ["negative", { title: "Updated action", expectedVersion: -1 }],
    ["fractional", { title: "Updated action", expectedVersion: 1.5 }],
    ["non-numeric", { title: "Updated action", expectedVersion: "2" }],
  ])("rejects a %s expectedVersion before mutation", async (_label, body) => {
    const { PATCH } = await import("./[actionId]/route");
    const response = await PATCH(actionPatchRequest(body), {
      params: Promise.resolve({ workspaceId: "workspace-1", actionId: "action-1" }),
    });

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toMatchObject({ error: { code: "VALIDATION_ERROR" } });
    expect(updateAction).not.toHaveBeenCalled();
  });

  it("rejects unknown request fields before mutation", async () => {
    const { PATCH } = await import("./[actionId]/route");
    const response = await PATCH(actionPatchRequest({
      title: "Updated action",
      expectedVersion: 2,
      unexpected: true,
    }), {
      params: Promise.resolve({ workspaceId: "workspace-1", actionId: "action-1" }),
    });

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toMatchObject({ error: { code: "VALIDATION_ERROR" } });
    expect(updateAction).not.toHaveBeenCalled();
  });

  it("returns the shared safe conflict response for a stale edit", async () => {
    updateAction.mockRejectedValueOnce(routeError(
      409,
      "VERSION_CONFLICT",
      "The record changed before this update could be applied. Please refresh and try again.",
    ));
    const { PATCH } = await import("./[actionId]/route");
    const response = await PATCH(actionPatchRequest({ title: "Stale title", expectedVersion: 1 }), {
      params: Promise.resolve({ workspaceId: "workspace-1", actionId: "action-1" }),
    });

    expect(response.status).toBe(409);
    await expect(response.json()).resolves.toEqual({
      error: {
        code: "VERSION_CONFLICT",
        message: "The record changed before this update could be applied. Please refresh and try again.",
      },
    });
  });

  it("preserves unauthenticated behavior before domain mutation", async () => {
    resolveRequestActor.mockRejectedValueOnce(routeError(401, "UNAUTHENTICATED", "Authentication required."));
    const { PATCH } = await import("./[actionId]/route");
    const response = await PATCH(actionPatchRequest({ title: "Updated", expectedVersion: 2 }), {
      params: Promise.resolve({ workspaceId: "workspace-1", actionId: "action-1" }),
    });

    expect(response.status).toBe(401);
    await expect(response.json()).resolves.toEqual({
      error: { code: "UNAUTHENTICATED", message: "Authentication required." },
    });
    expect(updateAction).not.toHaveBeenCalled();
  });

  it.each([
    ["wrong-workspace, deleted, or missing records", 404, "NOT_FOUND", "Action not found."],
    ["unauthorized or private records", 403, "FORBIDDEN", "You do not have permission to edit this action."],
    ["archived records", 400, "INVALID_STATE", "Archived actions cannot be edited."],
    ["terminal lifecycle states", 400, "INVALID_STATE", "Only draft, open, or in-progress actions can be edited."],
  ])("preserves %s errors", async (_label, status, code, message) => {
    updateAction.mockRejectedValueOnce(routeError(status as number, code as string, message as string));
    const { PATCH } = await import("./[actionId]/route");
    const response = await PATCH(actionPatchRequest({ title: "Updated", expectedVersion: 2 }), {
      params: Promise.resolve({ workspaceId: "workspace-1", actionId: "action-1" }),
    });

    expect(response.status).toBe(status);
    await expect(response.json()).resolves.toEqual({ error: { code, message } });
  });
});
