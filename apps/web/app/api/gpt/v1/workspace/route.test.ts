import { beforeEach, expect, it, vi } from "vitest";
const state = vi.hoisted(() => ({ auth: vi.fn(), readable: vi.fn(), workspace: vi.fn(),
  proposals: vi.fn(), actions: vi.fn(), tensions: vi.fn(), members: vi.fn() }));
vi.mock("@/lib/gpt-auth", () => ({ requireGptAuth: state.auth }));
vi.mock("@/lib/http", () => ({ handleRouteError: (error: unknown) => { throw error; } }));
vi.mock("@corgtex/domain", () => ({ readableArtifactIds: state.readable }));
vi.mock("@corgtex/shared", () => ({ env: { APP_URL: "https://selfserve.corgtex.com" }, prisma: {
  workspace: { findUnique: state.workspace }, proposal: { findMany: state.proposals },
  action: { findMany: state.actions }, tension: { findMany: state.tensions }, member: { count: state.members },
} }));
import { GET } from "./route";

beforeEach(() => {
  vi.resetAllMocks();
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
  expect((await response.json()).counts).toEqual({ proposals: 1, actions: 0, tensions: 2, members: 4 });
  for (const query of [state.proposals, state.actions, state.tensions]) {
    expect(query).toHaveBeenCalledWith(expect.objectContaining({ take: 100, orderBy: { id: "asc" } }));
    expect(query.mock.calls[0][0]).not.toHaveProperty("select");
  }
});
