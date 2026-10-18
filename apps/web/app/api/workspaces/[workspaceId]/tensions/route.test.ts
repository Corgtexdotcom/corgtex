import { NextRequest } from "next/server";
import { afterEach, describe, expect, it, vi } from "vitest";

// Keep real response/release orchestration; only the synthetic proof backend is mocked.
const readBoundary = vi.hoisted(() => ({finish: vi.fn(async (_actor: unknown, _workspaceId: string, _roots: unknown,
  remote: () => Promise<void>, finish: (tx: object) => Promise<unknown>) => {await remote(); return finish({});})}));
vi.mock("../../../../../../../packages/domain/src/auth", () => ({requireWorkspaceMembership: vi.fn(async () => ({id: "member-1", role: "ADMIN"}))}));
vi.mock("../../../../../../../packages/domain/src/source-lineage", () => ({
  captureArtifactInputProof: async (_actor: unknown, _workspaceId: string, inputs: Array<{kind: string; id: string; snapshot?: unknown}>) =>
    inputs.map(input => ({kind: input.kind, id: input.id, fingerprint: JSON.stringify(input.snapshot ?? input.id)})),
  captureReadableWorkItemInputs: async (_actor: unknown, _workspaceId: string, kind: string, rows: Array<{id: string}>) => ({
    ids: new Set(rows.map(row => row.id)), roots: rows.map(row => ({kind, id: row.id, fingerprint: JSON.stringify(row)})), heads: new Map(),
  }),
  captureArtifactReadHeadObservation: async (read: () => Promise<unknown>) => ({value: await read(), heads: new Map()}),
  mergeLineageInputRoot: (_prior: unknown, root: unknown) => root,
  withArtifactCountReleaseSnapshot: (...args: Parameters<typeof readBoundary.finish>) => readBoundary.finish(...args),
}));


const actor = {
  kind: "user" as const,
  user: {
    id: "user-1",
    email: "user@example.com",
    displayName: "User",
    globalRole: "USER" as const,
  },
};

const createTension = vi.fn();
const coerceWorkItemPriorityInput = vi.fn((input: unknown) => {
  if (input === "Urgent" || input === 3) return 3;
  if (input === "Important" || input === 2) return 2;
  if (input === "Medium" || input === 1) return 1;
  if (input === "Low" || input === 0) return 0;
  return undefined;
});
const deleteTension = vi.fn();
const formatWorkItemPriority = vi.fn((priority: number | null | undefined) => {
  if ((priority ?? 0) >= 3) return "Urgent";
  if ((priority ?? 0) >= 2) return "Important";
  if ((priority ?? 0) >= 1) return "Medium";
  return "Low";
});
const getWorkspacePermanentPathForEntity = vi.fn(async () => null);
const loadAdviceRequestCountSummaries = vi.fn();
const listTensions = vi.fn();
const prisma = {
  tension: {
    findFirst: vi.fn(),
  },
};
const requireWorkspaceMembership = vi.fn();
const resolveRequestActor = vi.fn(async () => actor);
const updateTension = vi.fn();

vi.mock("@/lib/auth", () => ({
  resolveRequestActor,
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
    ...await import("../../../../../../../packages/domain/src/work-item-readable-page"),
    ...await import("../../../../../../../packages/domain/src/digest-lineage"),
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
    createTension,
    deleteTension,
    formatWorkItemPriority,
    getWorkspacePermanentPathForEntity,
    loadAdviceRequestCountSummaries: async (...args: unknown[]) => {
      const summaries = await loadAdviceRequestCountSummaries(...args);
      const observe = args[4] as ((rows: Array<{id: string}>) => Promise<void>) | undefined;
      const requests = [...summaries.entries()].flatMap(([id, summary]) =>
        Array.from({length: summary.inputRequestCount ?? 0}, (_, index) => ({id: `${id}-request-${index}`})));
      await observe?.(requests);
      return summaries;
    },
    readableArtifactIds: vi.fn(async (_actor, _workspaceId, _kind, rows) => new Set(rows.map((row: { id: string }) => row.id))),
    listTensions,
    normalizeActionWorkItem,
    normalizeGoalWorkItem,
    normalizeProposalWorkItem,
    normalizeTensionWorkItem,
    requireWorkspaceMembership,
    updateTension,
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

function context(workspaceId = "workspace-1") {
  return { params: Promise.resolve({ workspaceId }) };
}

function tensionPatchRequest(body: unknown) {
  return new NextRequest("http://localhost/api/workspaces/workspace-1/tensions/tension-1", {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}

function routeError(status: number, code: string, message: string) {
  return Object.assign(new Error(message), { status, code });
}

afterEach(() => {
  vi.clearAllMocks();
  getWorkspacePermanentPathForEntity.mockResolvedValue(null);
});

describe("GET /api/workspaces/[workspaceId]/tensions", () => {
  it("caps pagination and passes archive filters into tension listing", async () => {
    listTensions.mockResolvedValue({
      items: [],
      total: 0,
      take: 100,
      skip: 20,
    });

    const { GET } = await import("./route");
    const response = await GET(
      new NextRequest("http://localhost/api/workspaces/workspace-1/tensions?archiveFilter=active&take=5000&skip=20"),
      context(),
    );

    expect(response.status).toBe(200);
    expect(listTensions).toHaveBeenCalledWith(actor, "workspace-1", {
      archiveFilter: "active",
      take: 100,
      skip: 20,
    });
  });
});

describe("POST /api/workspaces/[workspaceId]/tensions", () => {
  it("passes responsible person and labeled priority into tension creation", async () => {
    createTension.mockResolvedValue({
      id: "tension-1",
      title: "Clarify owner",
      status: "DRAFT",
      priority: 3,
      assigneeMemberId: "member-responsible",
      raisedByMemberId: "member-raiser",
    });
    prisma.tension.findFirst.mockResolvedValue({
      id: "tension-1",
      title: "Clarify owner",
      status: "DRAFT",
      priority: 3,
      assigneeMemberId: "member-responsible",
      raisedByMemberId: "member-raiser",
      assigneeMember: { id: "member-responsible", userId: "user-member-responsible", user: { displayName: "Responsible", email: "responsible@example.test" } },
      upvotes: [],
      raisedByMember: { id: "member-raiser", userId: "user-member-raiser", user: { displayName: "Raiser", email: "raiser@example.test" } },
    });
    loadAdviceRequestCountSummaries.mockResolvedValueOnce(new Map([
      ["tension-1", {
        adviceRequestCount: 0,
        activeAdviceRequestCount: 0,
        inputRequestCount: 0,
        activeInputRequestCount: 0,
      }],
    ]));

    const { POST } = await import("./route");
    const response = await POST(
      new NextRequest("http://localhost/api/workspaces/workspace-1/tensions", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          title: "Clarify owner",
          bodyMd: "Need clear responsibility.",
          assigneeMemberId: "member-responsible",
          raisedByMemberId: "member-raiser",
          priorityLabel: "Urgent",
        }),
      }),
      context(),
    );

    expect(response.status).toBe(201);
    expect(createTension).toHaveBeenCalledWith(actor, expect.objectContaining({
      workspaceId: "workspace-1",
      assigneeMemberId: "member-responsible",
      raisedByMemberId: "member-raiser",
      priority: 3,
    }));
    await expect(response.json()).resolves.toMatchObject({
      tension: {
        id: "tension-1",
        priorityLabel: "Urgent",
        inputRequestCount: 0,
        activeInputRequestCount: 0,
        responsibleMemberId: "member-responsible",
        responsibleMemberName: "Responsible",
        responsiblePerson: "Responsible",
        raisedByMemberId: "member-raiser",
        raisedByMemberName: "Raiser",
        raisedBy: "Raiser",
      },
    });
    expect(loadAdviceRequestCountSummaries).toHaveBeenCalledWith(actor, "workspace-1", "TENSION", ["tension-1"], expect.any(Function));
    expect(readBoundary.finish).toHaveBeenCalledWith(actor, "workspace-1", expect.arrayContaining([
      expect.objectContaining({kind: "Tension", id: "tension-1"}),
      expect.objectContaining({kind: "Member", id: "member-responsible"}),
      expect.objectContaining({kind: "User", id: "user-member-responsible"}),
    ]), expect.any(Function), expect.any(Function), expect.any(Map));
  });
});

describe("PATCH /api/workspaces/[workspaceId]/tensions/[tensionId]", () => {
  it("passes responsible person and labeled priority into tension updates", async () => {
    updateTension.mockResolvedValue({
      id: "tension-1",
      status: "OPEN",
      priority: 2,
      assigneeMemberId: "member-responsible",
      version: 3,
    });
    prisma.tension.findFirst.mockResolvedValue({
      id: "tension-1",
      status: "OPEN",
      priority: 2,
      assigneeMemberId: "member-responsible",
      version: 3,
      raisedByMember: null,
      upvotes: [],
      assigneeMember: { id: "member-responsible", userId: "user-member-responsible", user: { displayName: "Responsible", email: "responsible@example.test" } },
    });
    loadAdviceRequestCountSummaries.mockResolvedValueOnce(new Map([
      ["tension-1", {
        adviceRequestCount: 3,
        activeAdviceRequestCount: 1,
        inputRequestCount: 3,
        activeInputRequestCount: 1,
      }],
    ]));

    const { PATCH } = await import("./[tensionId]/route");
    const response = await PATCH(
      tensionPatchRequest({
        assigneeMemberId: "member-responsible",
        priority: "Important",
        expectedVersion: 2,
      }),
      { params: Promise.resolve({ workspaceId: "workspace-1", tensionId: "tension-1" }) },
    );

    expect(updateTension).toHaveBeenCalledWith(actor, expect.objectContaining({
      workspaceId: "workspace-1",
      tensionId: "tension-1",
      assigneeMemberId: "member-responsible",
      priority: 2,
      expectedVersion: 2,
    }));
    await expect(response.json()).resolves.toMatchObject({
      tension: {
        id: "tension-1",
        priorityLabel: "Important",
        inputRequestCount: 3,
        activeInputRequestCount: 1,
        responsibleMemberId: "member-responsible",
        responsibleMemberName: "Responsible",
        responsiblePerson: "Responsible",
        version: 3,
      },
    });
  });

  it.each([
    ["missing", { title: "Updated tension" }],
    ["zero", { title: "Updated tension", expectedVersion: 0 }],
    ["negative", { title: "Updated tension", expectedVersion: -1 }],
    ["fractional", { title: "Updated tension", expectedVersion: 1.5 }],
    ["non-numeric", { title: "Updated tension", expectedVersion: "2" }],
  ])("rejects a %s expectedVersion before mutation", async (_label, body) => {
    const { PATCH } = await import("./[tensionId]/route");
    const response = await PATCH(tensionPatchRequest(body), {
      params: Promise.resolve({ workspaceId: "workspace-1", tensionId: "tension-1" }),
    });

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toMatchObject({ error: { code: "VALIDATION_ERROR" } });
    expect(updateTension).not.toHaveBeenCalled();
  });

  it("returns the shared safe conflict response for a stale edit", async () => {
    updateTension.mockRejectedValueOnce(routeError(
      409,
      "VERSION_CONFLICT",
      "The record changed before this update could be applied. Please refresh and try again.",
    ));
    const { PATCH } = await import("./[tensionId]/route");
    const response = await PATCH(tensionPatchRequest({ title: "Stale title", expectedVersion: 1 }), {
      params: Promise.resolve({ workspaceId: "workspace-1", tensionId: "tension-1" }),
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
    const { PATCH } = await import("./[tensionId]/route");
    const response = await PATCH(tensionPatchRequest({ title: "Updated", expectedVersion: 2 }), {
      params: Promise.resolve({ workspaceId: "workspace-1", tensionId: "tension-1" }),
    });

    expect(response.status).toBe(401);
    await expect(response.json()).resolves.toEqual({
      error: { code: "UNAUTHENTICATED", message: "Authentication required." },
    });
    expect(updateTension).not.toHaveBeenCalled();
  });

  it.each([
    ["wrong-workspace, deleted, or missing records", 404, "NOT_FOUND", "Tension not found."],
    ["unauthorized or private records", 403, "FORBIDDEN", "You do not have permission to edit this tension."],
    ["archived records", 400, "INVALID_STATE", "Archived tensions cannot be edited."],
    ["terminal lifecycle states", 400, "INVALID_STATE", "Only draft or open tensions can be edited."],
  ])("preserves %s errors", async (_label, status, code, message) => {
    updateTension.mockRejectedValueOnce(routeError(status as number, code as string, message as string));
    const { PATCH } = await import("./[tensionId]/route");
    const response = await PATCH(tensionPatchRequest({ title: "Updated", expectedVersion: 2 }), {
      params: Promise.resolve({ workspaceId: "workspace-1", tensionId: "tension-1" }),
    });

    expect(response.status).toBe(status);
    await expect(response.json()).resolves.toEqual({ error: { code, message } });
  });
});

it("withholds the tension response when its final release rejects", async () => {
  prisma.tension.findFirst.mockResolvedValue({id: "tension-release", assigneeMember: null, raisedByMember: null, upvotes: []});
  loadAdviceRequestCountSummaries.mockResolvedValue(new Map());
  readBoundary.finish.mockRejectedValueOnce(new Error("Synthetic final release denied"));
  const {loadTensionWorkItemResponse} = await import("@/lib/work-item-api");
  await expect(loadTensionWorkItemResponse(actor, "workspace-1", "tension-release")).rejects.toThrow("Synthetic final release denied");
});
