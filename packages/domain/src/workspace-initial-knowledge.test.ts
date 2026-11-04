import { beforeEach, expect, it, vi } from "vitest";
import type { AppActor } from "@corgtex/shared";
const f = vi.hoisted(() => ({
  rows: new Map<string, Array<Record<string, any>>>(), allowed: new Set<string>(), versions: new Map<string, number>(), active: true,
  document: vi.fn(), brainSource: vi.fn(), meeting: vi.fn(), membership: vi.fn(), beforeRelease: vi.fn(), release: vi.fn(),
}));
vi.mock("@corgtex/shared", () => ({ prisma: { document: { findMany: f.document }, brainSource: { findMany: f.brainSource }, meeting: { findMany: f.meeting } } }));
vi.mock("./auth", () => ({ requireWorkspaceMembership: f.membership }));
vi.mock("./brain-access", () => ({ resolveKnowledgeAccessDomains: async () => ["WORKSPACE"] }));
vi.mock("./source-lineage", async () => ({
  sealArtifactInputActor: (await import("./artifact-input-actor")).sealArtifactInputActor,
  captureArtifactInputProof: async (_actor: unknown, _ws: string, inputs: Array<{ kind: string; id: string }>) => {
    if (inputs.some(row => !f.allowed.has(row.id))) throw new (await import("./errors")).AppError(409, "UNKNOWN_LINEAGE", "Synthetic denied input");
    return inputs.map(row => ({ kind: row.kind, id: row.id, fingerprint: String(f.versions.get(row.id) ?? 1) }));
  },
  captureArtifactReadHeadObservation: async (read: () => Promise<unknown>) => ({ value: await read(), heads: new Map() }),
  mergeLineageInputRoot: (_prior: unknown, root: unknown) => root,
  withArtifactCountReleaseSnapshot: async (_actor: unknown, _ws: string, roots: Array<{ id: string; fingerprint: string }>, remote: () => Promise<void>, finish: (tx: unknown) => Promise<unknown>) => {
    f.release(roots); await f.beforeRelease();
    if (roots.some(row => !f.allowed.has(row.id) || row.fingerprint !== String(f.versions.get(row.id) ?? 1))) {
      throw new (await import("./errors")).AppError(409, "SOURCE_CHANGED", "Original changed");
    }
    await remote(); return finish({});
  },
}));
import { getWorkspaceInitialKnowledgeSummary } from "./workspace-initial-knowledge";
const actor: AppActor = { kind: "user", user: { id: "user-1", email: "synthetic@example.test", displayName: null } };
function add(kind: string, count: number) {
  const rows = Array.from({ length: count }, (_, index) => ({ id: `${kind}-${String(index).padStart(3, "0")}`,
    workspaceId: "ws-1", archivedAt: null, accessDomain: "WORKSPACE", sourceType: "DOC", transcript: "Synthetic transcript" as string | null, summaryMd: null }));
  f.rows.set(kind, rows); return rows;
}
beforeEach(() => {
  vi.clearAllMocks(); f.rows.clear(); f.allowed.clear(); f.versions.clear(); f.active = true; f.beforeRelease.mockReset();
  f.membership.mockImplementation(async () => {
    if (!f.active) throw new (await import("./errors")).AppError(403, "NOT_A_MEMBER", "Synthetic caller departed");
    return { id: "member-1", isActive: true };
  });
  for (const [kind, query] of [["Document", f.document], ["BrainSource", f.brainSource], ["Meeting", f.meeting]] as const) {
    query.mockImplementation(async ({ where, take }) => (f.rows.get(kind) ?? []).filter(row => row.workspaceId === where.workspaceId && row.archivedAt === null
      && (!where.accessDomain || where.accessDomain.in.includes(row.accessDomain)) && (!where.sourceType || where.sourceType.in.includes(row.sourceType))
      && (!where.OR || row.transcript !== null || row.summaryMd !== null) && (!where.id || row.id > where.id.gt))
      .sort((a, b) => a.id.localeCompare(b.id)).slice(0, take));
  }
});

it("stops at 200 denied documents instead of treating the next readable source as absent", async () => {
  const rows = add("Document", 201); f.allowed.add(rows[200].id);
  expect(await getWorkspaceInitialKnowledgeSummary(actor, "ws-1")).toEqual({ found: false, complete: false });
  expect(f.document.mock.calls.map(([query]) => query.take)).toEqual([100, 100]);
  expect(f.brainSource).not.toHaveBeenCalled(); expect(f.meeting).not.toHaveBeenCalled();
});
it("shares the 200 examined budget across all three families", async () => {
  add("Document", 70); add("BrainSource", 70); const rows = add("Meeting", 61); f.allowed.add(rows[60].id);
  expect(await getWorkspaceInitialKnowledgeSummary(actor, "ws-1")).toEqual({ found: false, complete: false });
  expect(f.document.mock.calls.map(([query]) => query.take)).toEqual([100]);
  expect(f.brainSource.mock.calls.map(([query]) => query.take)).toEqual([100]);
  expect(f.meeting.mock.calls.map(([query]) => query.take)).toEqual([60]);
});
it.each(["Document", "BrainSource", "Meeting"])("returns a proved %s positive through original final release", async kind => {
  const row = add(kind, 1)[0]; f.allowed.add(row.id);
  expect(await getWorkspaceInitialKnowledgeSummary(actor, "ws-1")).toEqual({ found: true, complete: true });
  expect(f.release).toHaveBeenCalledWith([{ kind, id: row.id, fingerprint: "1" }]);
  expect(f.membership).toHaveBeenCalledTimes(2);
});
it("reports complete empty only after exhausting eligible workspace/domain/content families", async () => {
  const docs = add("Document", 2); docs[0].workspaceId = "ws-2"; docs[1].accessDomain = "FINANCE";
  const sources = add("BrainSource", 1); sources[0].sourceType = "CONVERSATION";
  const meetings = add("Meeting", 1); meetings[0].transcript = null;
  for (const row of [...docs, ...sources, ...meetings]) f.allowed.add(row.id);
  expect(await getWorkspaceInitialKnowledgeSummary(actor, "ws-1")).toEqual({ found: false, complete: true });
  expect(f.release).toHaveBeenCalledWith([]);
});
it("withholds an originally admitted source after revoke-restore before release", async () => {
  const row = add("Document", 1)[0]; f.allowed.add(row.id);
  f.beforeRelease.mockImplementation(async () => { f.versions.set(row.id, 3); });
  await expect(getWorkspaceInitialKnowledgeSummary(actor, "ws-1")).rejects.toMatchObject({ code: "SOURCE_CHANGED" });
  expect(f.release).toHaveBeenCalledWith([{ kind: "Document", id: row.id, fingerprint: "1" }]);
});
it("rechecks current membership even when there are no admitted sources", async () => {
  f.beforeRelease.mockImplementation(async () => { f.active = false; });
  await expect(getWorkspaceInitialKnowledgeSummary(actor, "ws-1")).rejects.toMatchObject({ code: "NOT_A_MEMBER" });
});
