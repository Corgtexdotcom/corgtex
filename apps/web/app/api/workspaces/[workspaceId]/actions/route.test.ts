import { NextRequest } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

const {
  actor,
  actionRequestSource,
  createAction,
  deleteAction,
  getWorkspacePermanentPathForEntity,
  loadAdviceRequestCountSummaries,
  listActions,
  prisma,
  requireWorkspaceMembership,
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
  actionRequestSource: vi.fn(() => ({ type: "API_REQUEST", id: "request-source-1" })),
  createAction: vi.fn(),
  deleteAction: vi.fn(),
  getWorkspacePermanentPathForEntity: vi.fn(),
  loadAdviceRequestCountSummaries: vi.fn(),
  listActions: vi.fn(),
  prisma: {
    action: {
      findFirst: vi.fn(),
    },
  },
  resolveRequestActor: vi.fn(),
  requireWorkspaceMembership: vi.fn(),
  updateAction: vi.fn(),
}));

resolveRequestActor.mockResolvedValue(actor);
requireWorkspaceMembership.mockResolvedValue({ id: "member-1", role: "ADMIN" });

vi.mock("@corgtex/domain", async () => {
  const { AppError } = await import("../../../../../../../packages/domain/src/errors");
  const { coerceWorkItemPriorityInput, formatWorkItemPriority } = await import("../../../../../../../packages/domain/src/work-item-priority");
  const {
    normalizeActionWorkItem,
    normalizeGoalWorkItem,
    normalizeProposalWorkItem,
    normalizeTensionWorkItem,
    workItemMemberDisplayName,
    workItemUserDisplayName,
  } = await import("../../../../../../../packages/domain/src/work-item-normalization");

  return {
    AppError,
    actionRequestSource,
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
    requireWorkspaceMembership,
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

vi.mock("@corgtex/shared/telemetry-node", () => ({
  captureErrorTelemetry: vi.fn(),
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

function actionCreateRequest(body: unknown, headers: Record<string, string> = {}) {
  return new NextRequest("http://localhost/api/workspaces/workspace-1/actions", {
    method: "POST",
    headers: { "Content-Type": "application/json", ...headers },
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
      webUrl: "https://app.corgtex.com/workspaces/workspace-1/actions/action-1",
      permanentUrl: null,
    });
    expect(loadAdviceRequestCountSummaries).toHaveBeenCalledWith("workspace-1", "ACTION", ["action-1"]);
  });

  it("rejects malformed JSON before creation", async () => {
    const { POST } = await import("./route");
    const response = await POST(new NextRequest("http://localhost/api/workspaces/workspace-1/actions", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: "{",
    }), context());

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toEqual({
      error: { code: "VALIDATION_ERROR", message: "Request body must be valid JSON." },
    });
    expect(createAction).not.toHaveBeenCalled();
  });

  it.each([
    ["null JSON", null],
    ["array JSON", []],
    ["string JSON", "Follow up"],
    ["missing title", {}],
    ["null title", { title: null }],
    ["empty title", { title: "" }],
    ["blank title", { title: " \t\n " }],
    ["object title", { title: { text: "Follow up" } }],
    ["numeric title", { title: 42 }],
    ["boolean title", { title: true }],
    ["fractional priority", { title: "Follow up", priority: 1.8 }],
    ["object priority", { title: "Follow up", priority: {} }],
    ["numeric priorityLabel", { title: "Follow up", priorityLabel: 2 }],
    ["numeric bodyMd", { title: "Follow up", bodyMd: 42 }],
    ["object assigneeMemberId", { title: "Follow up", assigneeMemberId: {} }],
  ])("rejects %s before creation", async (_label, body) => {
    const { POST } = await import("./route");
    const response = await POST(actionCreateRequest(body), context());

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toMatchObject({ error: { code: "VALIDATION_ERROR" } });
    expect(createAction).not.toHaveBeenCalled();
    expect(actionRequestSource).not.toHaveBeenCalled();
    expect(getWorkspacePermanentPathForEntity).not.toHaveBeenCalled();
    expect(prisma.action.findFirst).not.toHaveBeenCalled();
  });

  it.each(["priority", "priorityLabel"])("rejects an unsupported %s with the production priority helper", async (field) => {
    const { POST } = await import("./route");
    const response = await POST(actionCreateRequest({ title: "Follow up", [field]: "Critical" }), context());

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toEqual({
      error: {
        code: "INVALID_INPUT",
        message: `${field} must be Urgent, Important, Medium, Low, or an integer priority.`,
      },
    });
    expect(createAction).not.toHaveBeenCalled();
  });

  it.each([
    [{ priorityLabel: "Low" }, 0],
    [{ priorityLabel: "Medium" }, 1],
    [{ priorityLabel: "Important" }, 2],
    [{ priorityLabel: "Urgent" }, 3],
    [{ priority: 0 }, 0],
    [{ priority: 1 }, 1],
    [{ priority: 2 }, 2],
    [{ priority: 3 }, 3],
    [{ priority: -1 }, 0],
    [{ priority: 4 }, 3],
    [{ priority: " Urgent " }, 3],
    [{ priority: "2" }, 2],
    [{ priority: "1.8" }, 1],
    [{ priority: "0x2" }, 2],
    [{ priority: "1e0" }, 1],
    [{ priority: "" }, undefined],
    [{ priority: null, priorityLabel: "Urgent" }, undefined],
    [{ priorityLabel: null }, undefined],
    [{ priority: 1, priorityLabel: "Urgent" }, 1],
    [{}, undefined],
  ])("preserves priority conversion for %j", async (fields, priority) => {
    const { POST } = await import("./route");
    const response = await POST(actionCreateRequest({ title: "Follow up", ...fields }), context());

    expect(response.status).toBe(201);
    expect(createAction).toHaveBeenCalledWith(actor, expect.objectContaining({ priority }));
  });

  it.each([
    [{}, { bodyMd: null, assigneeMemberId: undefined }],
    [{ bodyMd: null, assigneeMemberId: null }, { bodyMd: null, assigneeMemberId: null }],
    [{ bodyMd: "", assigneeMemberId: "" }, { bodyMd: "", assigneeMemberId: "" }],
  ])("preserves optional fields for %j and ignores unknown create fields", async (fields, expected) => {
    const { POST } = await import("./route");
    const response = await POST(actionCreateRequest({ title: "Follow up", ...fields, unexpected: true }), context());

    expect(response.status).toBe(201);
    expect(createAction).toHaveBeenCalledWith(actor, {
      workspaceId: "workspace-1",
      title: "Follow up",
      ...expected,
      priority: undefined,
      _membership: { id: "member-1", role: "ADMIN" },
      source: undefined,
    });
    expect(actionRequestSource).not.toHaveBeenCalled();
  });

  it("trims valid titles with the sibling schema convention", async () => {
    const { POST } = await import("./route");
    const response = await POST(actionCreateRequest({ title: "  Follow up  " }), context());

    expect(response.status).toBe(201);
    expect(createAction).toHaveBeenCalledWith(actor, expect.objectContaining({ title: "Follow up" }));
  });

  it.each([
    [actor, "user-1"],
    [{ kind: "agent", credentialId: "credential-1", agentIdentityId: "agent-1", label: "Agent" }, "credential-1"],
    [{ kind: "agent", agentIdentityId: "agent-1", label: "Agent" }, "agent-1"],
    [{ kind: "agent", label: "Agent" }, "Agent"],
  ])("binds idempotency to the authenticated principal %j", async (requestActor, principalId) => {
    resolveRequestActor.mockResolvedValueOnce(requestActor);
    getWorkspacePermanentPathForEntity.mockResolvedValueOnce("/p/workspace-1/action-1");
    const { POST } = await import("./route");
    const response = await POST(actionCreateRequest({ title: "Follow up" }, { "Idempotency-Key": "create-action-1" }), context());

    expect(response.status).toBe(201);
    expect(actionRequestSource).toHaveBeenCalledWith("API_REQUEST", principalId, "create-action-1");
    expect(createAction).toHaveBeenCalledWith(requestActor, expect.objectContaining({
      source: { type: "API_REQUEST", id: "request-source-1" },
    }));
    await expect(response.json()).resolves.toMatchObject({
      webUrl: "https://app.corgtex.com/workspaces/workspace-1/actions/action-1",
      permanentUrl: "https://app.corgtex.com/p/workspace-1/action-1",
    });
  });

  it("preserves workspace authorization before creation", async () => {
    requireWorkspaceMembership.mockRejectedValueOnce(routeError(403, "FORBIDDEN", "Workspace membership required."));
    const { POST } = await import("./route");
    const response = await POST(actionCreateRequest({ title: "Follow up" }), context());

    expect(response.status).toBe(403);
    await expect(response.json()).resolves.toEqual({ error: { code: "FORBIDDEN", message: "Workspace membership required." } });
    expect(createAction).not.toHaveBeenCalled();
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
