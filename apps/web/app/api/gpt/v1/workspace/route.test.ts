import { beforeEach, expect, it, vi } from "vitest";
const state = vi.hoisted(() => ({ auth: vi.fn(), readable: vi.fn(), workspace: vi.fn(),
  proposals: vi.fn(), actions: vi.fn(), tensions: vi.fn(), members: vi.fn(), release: vi.fn() }));
vi.mock("@/lib/gpt-auth", () => ({ requireGptAuth: state.auth }));
vi.mock("@/lib/http", () => ({ handleRouteError: (error: unknown) => { throw error; } }));
vi.mock("../../../../../../../packages/domain/src/source-lineage", () => ({
  readableArtifactIds: state.readable,
  captureArtifactInputProof: async (actor: unknown, workspaceId: string, inputs: Array<{kind: string; id: string; snapshot: {id: string}}>) => {
    for (const input of inputs) if (!(await state.readable(actor, workspaceId, input.kind, [input.snapshot])).has(input.id)) {
      const {AppError} = await import("../../../../../../../packages/domain/src/errors");
      throw new AppError(409, "SOURCE_RESTRICTED", "Synthetic denied input");
    }
    return inputs.map(input => ({kind: input.kind, id: input.id, fingerprint: JSON.stringify(input.snapshot)}));
  },
  captureArtifactReadHeadObservation: async (read: () => Promise<unknown>) => ({value: await read(), heads: new Map()}),
  mergeLineageInputRoot: (_prior: unknown, root: unknown) => root,
  withArtifactCountReleaseSnapshot: (...args: unknown[]) => state.release(...args),
  invalidateArtifactInputLineage: vi.fn(), recordArtifactInputLineage: vi.fn(),
}));
vi.mock("../../../../../../../packages/domain/src/auth", () => ({requireWorkspaceMembership: vi.fn()}));
vi.mock("@corgtex/domain", async () => ({...await import("../../../../../../../packages/domain/src/digest-lineage"), ...await import("../../../../../../../packages/domain/src/errors")}));
vi.mock("@corgtex/shared", () => ({ env: { APP_URL: "https://selfserve.corgtex.com" }, prisma: {
  workspace: { findUnique: state.workspace }, proposal: { findMany: state.proposals },
  action: { findMany: state.actions }, tension: { findMany: state.tensions }, member: { count: state.members },
} }));
import { GET } from "./route";

beforeEach(() => {
  vi.resetAllMocks();
  state.release.mockImplementation(async (_actor, _workspaceId, _roots, remote, finish) => {await remote(); return finish({});});
  state.auth.mockResolvedValue({ workspaceId: "ws", actor: { kind: "user", user: { id: "viewer" } } });
  state.workspace.mockResolvedValue({ id: "ws", name: "Workspace" });
  state.members.mockResolvedValue(4);
  state.readable.mockImplementation(async (_actor, _ws, _kind, rows) => new Set(rows.filter((row: { hidden?: boolean }) => !row.hidden).map((row: { id: string }) => row.id)));
});
it("reports only permitted Action, Tension and Proposal counts from complete canonical records", async () => {
  state.proposals.mockResolvedValue([{ id: "p1", title: "allowed" }, { id: "p2", title: "restricted", hidden: true }]);
  state.actions.mockResolvedValue([{ id: "a1", title: "private", hidden: true }]);
  state.tensions.mockResolvedValue([{ id: "t1", title: "allowed" }, { id: "t2", title: "allowed2" }]);
  const response = await GET(new Request("http://localhost/api/gpt/v1/workspace") as never);
  const body = await response.json();
  expect(body.counts).toEqual({ proposals: 1, actions: 0, tensions: 2, members: 4 });
  expect(body.countWindows).toEqual({
    proposals: { count: 1, complete: true, nextCursor: null, scope: "WINDOW" },
    actions: { count: 0, complete: true, nextCursor: null, scope: "WINDOW" },
    tensions: { count: 2, complete: true, nextCursor: null, scope: "WINDOW" },
  });
  expect(state.release).toHaveBeenCalledOnce();
  expect(state.release.mock.calls[0][2].map((root: {kind: string; id: string}) => `${root.kind}:${root.id}`).sort())
    .toEqual(["Proposal:p1", "Tension:t1", "Tension:t2"]);
  for (const query of [state.proposals, state.actions, state.tensions]) {
    expect(query).toHaveBeenCalledWith(expect.objectContaining({ take: 100, orderBy: { id: "asc" } }));
    expect(query.mock.calls[0][0]).not.toHaveProperty("select");
  }
});

it("withholds the response when the final original-proof release rejects", async () => {
  state.release.mockRejectedValueOnce(new Error("Synthetic final release denied"));
  state.proposals.mockResolvedValue([]); state.actions.mockResolvedValue([]); state.tensions.mockResolvedValue([]);
  await expect(GET(new Request("http://localhost/api/gpt/v1/workspace") as never)).rejects.toThrow("Synthetic final release denied");
});


it("excludes readable archived records from active workspace totals", async () => {
  const activeAndArchived = [{ id: "active", archivedAt: null }, { id: "archived", archivedAt: new Date() }];
  for (const query of [state.proposals, state.actions, state.tensions]) {
    query.mockImplementation(async ({ where }) => activeAndArchived.filter(row => where.archivedAt !== null || row.archivedAt === null));
  }
  const response = await GET(new Request("http://localhost/api/gpt/v1/workspace") as never);
  expect((await response.json()).counts).toEqual({ proposals: 1, actions: 1, tensions: 1, members: 4 });
  for (const query of [state.proposals, state.actions, state.tensions]) {
    expect(query.mock.calls[0][0].where).toEqual({ workspaceId: "ws", archivedAt: null });
  }
  expect(state.release.mock.calls[0][2].every((root: { id: string }) => root.id === "active")).toBe(true);
});


it("bounds a denied prefix and returns a continuation instead of a false global zero", async () => {
  const rows = Array.from({ length: 205 }, (_, index) => ({ id: `p${String(index).padStart(3, "0")}`, hidden: index < 200 }));
  state.proposals.mockImplementation(async ({ where, take }) => rows.filter(row => !where.id || row.id > where.id.gt).slice(0, take));
  state.actions.mockResolvedValue([]); state.tensions.mockResolvedValue([]);
  const response = await GET(new Request("http://localhost/api/gpt/v1/workspace") as never);
  const body = await response.json();
  expect(body.counts).toEqual({ proposals: null, actions: 0, tensions: 0, members: 4 });
  expect(body.countWindows.proposals).toEqual({ count: 0, complete: false, nextCursor: "p199", scope: "WINDOW" });
  expect(state.proposals).toHaveBeenCalledTimes(2);
  expect(state.proposals.mock.calls[1][0]).toEqual({ where: { workspaceId: "ws", archivedAt: null, id: { gt: "p099" } }, orderBy: { id: "asc" }, take: 100 });
  expect(state.release).toHaveBeenCalledOnce();
});

it("reports cursor results only as window counts and keeps each family tenant-scoped", async () => {
  state.proposals.mockResolvedValue([{ id: "p201" }]);
  state.actions.mockResolvedValue([{ id: "a301" }]);
  state.tensions.mockResolvedValue([{ id: "t1" }]);
  const response = await GET(new Request("http://localhost/api/gpt/v1/workspace?proposalCursor=p200&actionCursor=a300") as never);
  const body = await response.json();
  expect(body.counts).toEqual({ proposals: null, actions: null, tensions: 1, members: 4 });
  expect(body.countWindows.proposals).toEqual({ count: 1, complete: true, nextCursor: null, scope: "WINDOW" });
  expect(body.countWindows.actions).toEqual({ count: 1, complete: true, nextCursor: null, scope: "WINDOW" });
  expect(state.proposals.mock.calls[0][0].where).toEqual({ workspaceId: "ws", archivedAt: null, id: { gt: "p200" } });
  expect(state.actions.mock.calls[0][0].where).toEqual({ workspaceId: "ws", archivedAt: null, id: { gt: "a300" } });
  expect(state.tensions.mock.calls[0][0].where).toEqual({ workspaceId: "ws", archivedAt: null });
  expect(state.release).toHaveBeenCalledOnce();
  expect(state.release.mock.calls[0][2].map((root: { id: string }) => root.id).sort()).toEqual(["a301", "p201", "t1"]);
});

it.each(["proposalCursor=", `actionCursor=${"x".repeat(257)}`, "tensionCursor=x%0Ay", "proposalCursor=a&proposalCursor=b"])(
  "rejects malformed continuation before reading data: %s", async query => {
    await expect(GET(new Request(`http://localhost/api/gpt/v1/workspace?${query}`) as never)).rejects.toMatchObject({ code: "INVALID_INPUT" });
    for (const call of [state.workspace, state.proposals, state.actions, state.tensions, state.members, state.release]) expect(call).not.toHaveBeenCalled();
  });

it("withholds partial count windows if their original proof release fails", async () => {
  state.proposals.mockResolvedValue([{ id: "p201" }]);
  state.actions.mockResolvedValue([]); state.tensions.mockResolvedValue([]);
  state.release.mockRejectedValue(new Error("Synthetic original window proof changed"));
  await expect(GET(new Request("http://localhost/api/gpt/v1/workspace?proposalCursor=p200") as never))
    .rejects.toThrow("Synthetic original window proof changed");
  expect(state.release.mock.calls[0][2]).toEqual([{ kind: "Proposal", id: "p201", fingerprint: JSON.stringify({ id: "p201" }) }]);
});


it("documents nullable global totals and independent cursor windows in OpenAPI", async () => {
  const { GET: schema } = await import("../openapi.json/route");
  const body = await (await schema()).json();
  const workspace = body.paths["/workspace"].get;
  expect(workspace.parameters.map((parameter: { name: string }) => parameter.name))
    .toEqual(["proposalCursor", "actionCursor", "tensionCursor"]);
  const response = workspace.responses["200"].content["application/json"].schema;
  expect(response.properties.counts.properties.proposals.type).toEqual(["integer", "null"]);
  expect(response.properties.countWindows.properties.proposals.properties.scope.enum).toEqual(["WINDOW"]);
  expect(response.properties.countWindows.properties.proposals.properties.nextCursor.type).toEqual(["string", "null"]);
});
