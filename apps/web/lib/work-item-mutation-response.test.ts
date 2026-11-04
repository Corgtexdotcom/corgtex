import { NextRequest } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  actor: { kind: "user", user: { id: "reader-1", email: "reader@example.test", globalRole: "USER" } },
  createAction: vi.fn(), updateAction: vi.fn(), createTension: vi.fn(), updateTension: vi.fn(),
  loadAction: vi.fn(), loadTension: vi.fn(), resolveRequestActor: vi.fn(), requireGptAuth: vi.fn(),
  permanentPath: vi.fn(),
}));

vi.mock("@corgtex/domain", async () => ({
  ...await import("../../../packages/domain/src/work-item-normalization"),
  ...await import("../../../packages/domain/src/work-item-priority"),
  ...await import("../../../packages/domain/src/errors"),
  createAction: mocks.createAction, updateAction: mocks.updateAction,
  createTension: mocks.createTension, updateTension: mocks.updateTension,
  requireWorkspaceMembership: vi.fn(async () => ({ id: "member-1", role: "ADMIN" })),
  getWorkspacePermanentPathForEntity: mocks.permanentPath,
}));
vi.mock("@corgtex/shared", () => ({ env: { APP_URL: "https://app.example.test" }, isDatabaseUnavailableError: () => false }));
vi.mock("@corgtex/shared/telemetry-node", () => ({ captureErrorTelemetry: vi.fn() }));
vi.mock("@/lib/auth", () => ({ resolveRequestActor: mocks.resolveRequestActor }));
vi.mock("@/lib/gpt-auth", () => ({ requireGptAuth: mocks.requireGptAuth }));
// Keep the production serializers and HTTP/error handling; control only the
// canonical read result after the mutation has already committed.
vi.mock("@/lib/work-item-api", async original => ({
  ...await original<typeof import("./work-item-api")>(),
  loadActionWorkItemResponse: mocks.loadAction,
  loadTensionWorkItemResponse: mocks.loadTension,
}));

const canary = {
  id: "item-1", title: "hidden-title-canary", bodyMd: "hidden-body-canary",
  assigneeMemberId: "hidden-assignee-canary", raisedByMemberId: "hidden-raiser-canary",
  status: "DRAFT", priority: 2, version: 1,
};
const cases = [
  { name: "workspace Action POST", kind: "action", method: "POST", mutation: mocks.createAction, read: mocks.loadAction,
    route: () => import("../app/api/workspaces/[workspaceId]/actions/route"), status: 201, gpt: false },
  { name: "workspace Action PATCH", kind: "action", method: "PATCH", mutation: mocks.updateAction, read: mocks.loadAction,
    route: () => import("../app/api/workspaces/[workspaceId]/actions/[actionId]/route"), status: 200, gpt: false },
  { name: "workspace Tension POST", kind: "tension", method: "POST", mutation: mocks.createTension, read: mocks.loadTension,
    route: () => import("../app/api/workspaces/[workspaceId]/tensions/route"), status: 201, gpt: false },
  { name: "workspace Tension PATCH", kind: "tension", method: "PATCH", mutation: mocks.updateTension, read: mocks.loadTension,
    route: () => import("../app/api/workspaces/[workspaceId]/tensions/[tensionId]/route"), status: 200, gpt: false },
  { name: "GPT Action POST", kind: "action", method: "POST", mutation: mocks.createAction, read: mocks.loadAction,
    route: () => import("../app/api/gpt/v1/actions/route"), status: 200, gpt: true },
  { name: "GPT Tension POST", kind: "tension", method: "POST", mutation: mocks.createTension, read: mocks.loadTension,
    route: () => import("../app/api/gpt/v1/tensions/route"), status: 200, gpt: true },
] as const;

for (const testCase of cases) describe(testCase.name, () => {
  beforeEach(() => {
    vi.resetAllMocks();
    mocks.resolveRequestActor.mockResolvedValue(mocks.actor);
    mocks.requireGptAuth.mockResolvedValue({ actor: mocks.actor, workspaceId: "workspace-1" });
    mocks.permanentPath.mockResolvedValue("/p/item-1");
    testCase.mutation.mockResolvedValue(canary);
  });

  async function call() {
    const route = await testCase.route();
    const handler = (route as unknown as Record<string, (
      request: NextRequest, context: { params: Promise<Record<string, string>> },
    ) => Promise<Response>>)[testCase.method];
    return handler(new NextRequest("https://app.example.test/api/work-items", {
      method: testCase.method, headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ title: "Requested title", expectedVersion: 1 }),
    }), { params: Promise.resolve({ workspaceId: "workspace-1", actionId: "item-1", tensionId: "item-1" }) });
  }

  it.each(["missing", "denied"] as const)("withholds all mutation fields after a %s canonical read", async outcome => {
    const withheld = { id: "item-1", contentWithheld: true };
    testCase.read.mockResolvedValue(outcome === "missing" ? null : withheld);
    const response = await call();
    expect(response.status).toBe(testCase.status);
    const body = await response.json();
    const expected = testCase.gpt ? withheld : {
      [testCase.kind]: withheld,
      ...(testCase.method === "POST" ? {
        webUrl: `https://app.example.test/workspaces/workspace-1/${testCase.kind}s/item-1`,
        permanentUrl: "https://app.example.test/p/item-1",
      } : {}),
    };
    expect(body).toEqual(expected);
    expect(JSON.stringify(body)).not.toContain("canary");
    expect(testCase.mutation).toHaveBeenCalledTimes(1);
    expect(testCase.read).toHaveBeenCalledExactlyOnceWith(mocks.actor, "workspace-1", "item-1");
    if (testCase.gpt) expect(mocks.permanentPath).not.toHaveBeenCalled();
  });

  it("propagates canonical authorization failure without retrying the committed mutation", async () => {
    testCase.read.mockRejectedValue(Object.assign(new Error("Read denied."), { status: 403, code: "FORBIDDEN" }));
    const response = await call();
    expect(response.status).toBe(403);
    expect(await response.json()).toEqual({ error: { code: "FORBIDDEN", message: "Read denied." } });
    expect(testCase.mutation).toHaveBeenCalledTimes(1);
    expect(testCase.read).toHaveBeenCalledTimes(1);
  });

  it("rejects authentication failure before mutation or canonical read", async () => {
    const error = Object.assign(new Error("Authentication required."), { status: 401, code: "UNAUTHENTICATED" });
    (testCase.gpt ? mocks.requireGptAuth : mocks.resolveRequestActor).mockRejectedValue(error);
    const response = await call();
    expect(response.status).toBe(401);
    expect(await response.json()).toEqual({ error: { code: "UNAUTHENTICATED", message: "Authentication required." } });
    expect(testCase.mutation).not.toHaveBeenCalled();
    expect(testCase.read).not.toHaveBeenCalled();
  });
});
