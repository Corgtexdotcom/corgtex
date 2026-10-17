import { beforeEach, describe, expect, it, vi } from "vitest";
const { db, rebuild, absorb, membership } = vi.hoisted(() => ({ db: {
  informationCategoryPolicy: {findUnique: vi.fn(async () => null)},
  workspace: {findFirst: vi.fn()}, brainArticle: {findMany: vi.fn(), findFirst: vi.fn()}, brainSource: {findMany: vi.fn(), findFirst: vi.fn()},
  brainDiscussionThread: {findMany: vi.fn(), findFirst: vi.fn()}, brainDiscussionComment: {findFirst: vi.fn(), findMany: vi.fn()},
  brainBacklink: {findFirst: vi.fn(), findMany: vi.fn(), createMany: vi.fn(), deleteMany: vi.fn()},
  knowledgeChunk: {findMany: vi.fn(), findFirst: vi.fn(), deleteMany: vi.fn()},
  artifactInputLineage: {findFirst: vi.fn(), findMany: vi.fn(), create: vi.fn()}, artifactInputSnapshot: {findFirst: vi.fn(), create: vi.fn()}, $transaction: vi.fn(), $queryRaw: vi.fn(), $executeRaw: vi.fn(),
}, rebuild: vi.fn(), absorb: vi.fn(), membership: vi.fn() }));
vi.mock("@corgtex/shared", async original => ({...await original<any>(), prisma: db}));
vi.mock("../../domain/src/auth", () => ({requireWorkspaceMembership: membership}));
vi.mock("../../domain/src/brain-access", () => ({resolveKnowledgeAccessDomains: vi.fn(async () => ["WORKSPACE"])}));
vi.mock("@corgtex/domain", async () => ({...await import("../../domain/src/source-lineage"), ...await import("../../domain/src/errors"), ...await import("../../domain/src/digest-lineage"),
  WIKILINK_RE: /\[\[([^\]]+)\]\]/g, rebuildBacklinks: rebuild, markThreadAbsorbed: absorb}));
import { runBrainMaintenance } from "./brain-maintenance";
import { recordArtifactInputLineage, isArtifactInputProofReadable } from "../../domain/src/source-lineage";
import { installSourcePermissionEpochFixture } from "../../domain/src/source-permission-epochs.test-fixture";
const date = new Date("2025-01-01T00:00:00Z");
let rows: Record<string, any[]>, manifests: any[], snapshots: any[], originals: Array<{kind: string; row: any}>;
function add(kind: string, row: any, proven = true) {
  if (["BrainSource", "Document", "Meeting"].includes(kind)) row.informationCategory ??= "GENERAL";
  (rows[kind] ??= []).push(row);
  if (proven) originals.push({kind, row});
  return row;
}
beforeEach(() => {
  vi.resetAllMocks(); rows = {Workspace: [{id: "ws-1", name: "Workspace", createdAt: date}]}; manifests = []; snapshots = []; originals = [];
  membership.mockResolvedValue(null);
  db.$transaction.mockImplementation(async work => work(db));
  for (const [kind, delegate] of [["Workspace", "workspace"], ["BrainArticle", "brainArticle"], ["BrainSource", "brainSource"],
    ["BrainDiscussionThread", "brainDiscussionThread"], ["BrainDiscussionComment", "brainDiscussionComment"], ["KnowledgeChunk", "knowledgeChunk"]]) {
    (db as any)[delegate].findFirst.mockImplementation(async ({where}: any) => (rows[kind] ?? []).find(row => row.id === where.id) ?? null);
    (db as any)[delegate].findMany?.mockImplementation(async ({where, take, orderBy}: any = {}) => {
      const matches = (row: any, filter: any): boolean => Object.entries(filter ?? {}).every(([key, value]: any) => {
        if (key === "OR") return value.some((part: any) => matches(row, part));
        if (key === "article") return matches(rows.BrainArticle?.find(item => item.id === row.articleId), value);
        const actual = row?.[key];
        if (value && typeof value === "object" && !(value instanceof Date)) {
          if (value.in && !value.in.includes(actual)) return false;
          if (value.gt !== undefined && !(actual > value.gt)) return false;
          if (value.lt !== undefined && !(actual < value.lt)) return false;
          if (value.lte !== undefined && !(actual <= value.lte)) return false;
          if (value.equals !== undefined && String(actual).toLowerCase() !== String(value.equals).toLowerCase()) return false;
          return true;
        }
        return actual instanceof Date && value instanceof Date ? +actual === +value : actual === value;
      });
      const found = (rows[kind] ?? []).filter(row => matches(row, where));
      const orders = Array.isArray(orderBy) ? orderBy : orderBy ? [orderBy] : [];
      found.sort((a,b) => { for (const order of orders) for (const [key, direction] of Object.entries(order)) {
        if (a[key] !== b[key]) return (a[key] < b[key] ? -1 : 1) * (direction === "desc" ? -1 : 1);
      } return 0; });
      return found.slice(0, take ?? found.length);
    });
  }
  const selectManifests = ({where, orderBy, take}: any) => {
    const matches = (actual: unknown, expected: any) => expected && typeof expected === "object" && "in" in expected
      ? expected.in.includes(actual) : actual === expected;
    const found = manifests.filter(row => Object.entries(where ?? {}).every(([key, value]) => matches(row[key], value)));
    if (orderBy?.revision) found.sort((a, b) => (a.revision - b.revision) * (orderBy.revision === "desc" ? -1 : 1));
    return found.slice(0, take ?? found.length);
  };
  db.artifactInputLineage.findFirst.mockImplementation(async args => selectManifests(args)[0] ?? null);
  db.artifactInputLineage.findMany.mockImplementation(async args => selectManifests(args));
  db.artifactInputSnapshot.findFirst.mockImplementation(async ({where}) => snapshots.find(row => row.id === where.id) ?? null);
  db.artifactInputSnapshot.create.mockImplementation(async ({data}) => {const row = {id: `snapshot-${snapshots.length}`, ...data, createdAt: new Date()}; snapshots.push(row); return row;});
  db.artifactInputLineage.create.mockImplementation(async ({data}) => {const row = {id: `manifest-${manifests.length}`, ...data}; manifests.push(row); return row;});
  installSourcePermissionEpochFixture(db);
  const query = db.$queryRaw.getMockImplementation();
  db.$queryRaw.mockImplementation(async (...args) => String(args[0]?.strings ?? args[0]).includes("jsonb_array_elements") ? [] : query?.(...args));
  db.brainBacklink.findFirst.mockResolvedValue(null);
  db.brainBacklink.findMany.mockResolvedValue([]);
  db.brainBacklink.createMany.mockResolvedValue({count: 1});
  db.brainBacklink.deleteMany.mockResolvedValue({count: 0});
  rebuild.mockResolvedValue({linkCount: 0}); absorb.mockResolvedValue({id: "resolved", status: "ABSORBED"});
});
const actor = {kind: "agent", authProvider: "bootstrap", label: "brain-maintenance", workspaceIds: ["ws-1"]} as any;
const originalAuthor = {kind: "user", user: {id: "author", email: "author@synthetic.test", displayName: "Author"}} as any;
async function certifyOriginals() {
  for (const {kind, row} of originals.splice(0)) await recordArtifactInputLineage({tx: db as any, actor: originalAuthor, workspaceId: "ws-1", artifact: {kind: kind as any, id: row.id}, content: row, origin: "HUMAN_ORIGINAL", inputs: []});
}
const run = async (phase: "LINKS" | "ORPHANS" | "SOURCES" | "DISCUSSIONS" | "RETENTION" = "LINKS") => {
  await certifyOriginals();
  const kind = {LINKS: "BrainArticle", ORPHANS: "BrainArticle", SOURCES: "BrainSource", DISCUSSIONS: "BrainDiscussionThread", RETENTION: "KnowledgeChunk"}[phase];
  const selectedIds = (rows[kind] ?? []).map(row => row.id);
  return runBrainMaintenance({workspaceId: "ws-1", actor, state: {version: 1, cohortId: "cohort", admittedAt: new Date().toISOString(), phase,
    upperId: selectedIds.at(-1) ?? null, afterId: null, selectedIds, pageLastId: selectedIds.at(-1) ?? null, pageComplete: true, index: 0}});
};
function article(id: string, isPrivate = false) { return add("BrainArticle", {id, workspaceId: "ws-1", title: id, slug: id, bodyMd: "Public [[missing]]",
  isPrivate, authority: "DRAFT", staleAfterDays: 1, lastVerifiedAt: null, createdAt: date, archivedAt: null}); }

describe("maintenance actual input lineage", () => {
  it("filters hidden discussions, comments, sources and articles before every metric and status transition", async () => {
    article("public"); article("private", true);
    const resolved = add("BrainDiscussionThread", {id: "resolved", articleId: "public", status: "RESOLVED", createdAt: date, comments: []});
    add("BrainDiscussionThread", {id: "private-thread", articleId: "private", status: "RESOLVED", createdAt: date, comments: []});
    add("BrainDiscussionThread", {id: "unknown-thread", articleId: "public", status: "RESOLVED", createdAt: date, comments: []}, false);
    const old = add("BrainDiscussionComment", {id: "old", threadId: "open", bodyMd: "Known older comment", createdAt: date});
    const recent = add("BrainDiscussionComment", {id: "recent", threadId: "open", bodyMd: "Unknown recent comment", createdAt: new Date()}, false);
    add("BrainDiscussionThread", {id: "open", articleId: "public", status: "OPEN", createdAt: date, comments: [recent, old]});
    add("BrainSource", {id: "source", workspaceId: "ws-1", sourceType: "TEXT", accessDomain: "WORKSPACE", tier: 3, archivedAt: null, contentText: "Allowed", createdAt: date});
    add("BrainSource", {id: "finance", workspaceId: "ws-1", sourceType: "TEXT", accessDomain: "FINANCE", tier: 3, archivedAt: null, contentText: "Hidden", createdAt: date});
    add("KnowledgeChunk", {id: "legacy-event", workspaceId: "ws-1", sourceType: "EVENT", accessDomain: "WORKSPACE", content: "Unproved event", createdAt: date}, false);
    absorb.mockImplementation(async (_actor, params) => {
      expect(snapshots.length).toBeGreaterThan(0);
      expect(await isArtifactInputProofReadable(actor, "ws-1", params.expectedInputRoots, db as any)).toBe(true);
      resolved.status = "ABSORBED";
      return resolved;
    });
    const results = [];
    for (const phase of ["LINKS", "ORPHANS", "SOURCES", "DISCUSSIONS", "RETENTION"] as const) {
      const result = await run(phase); await result.apply(db as any); results.push(result);
    }
    expect(results.map(result => result.report)).toMatchObject([
      {scope: "BATCH", staleArticleCount: 1, unresolvedReferenceCount: 1}, {orphanCount: 1},
      {tier3CleanupCandidates: 1}, {staleThreadCount: 1, absorbedThreadCount: 1}, {status: "RETAINED_UNSUPPORTED_CUSTODY"},
    ]);
    expect(results[4].report).not.toHaveProperty("prunedEventsCount");
    // Only mutation preparation needs its own snapshots. The observation-only
    // source phase is frozen once by its enclosing agent runtime, not by apply.
    expect(snapshots.some(row => row.sourceKind === "BrainSource")).toBe(false);
    expect(absorb).toHaveBeenCalledOnce();
    expect(absorb.mock.calls[0][1].threadId).toBe("resolved");
    expect(db.knowledgeChunk.deleteMany).not.toHaveBeenCalled();
    expect(snapshots.some(row => row.sourceId === "private-thread" || row.sourceId === "unknown-thread" || row.sourceId === "recent" || row.sourceId === "finance")).toBe(false);
    expect(await isArtifactInputProofReadable(actor, "ws-1", results[0].lineageRoots, db as any)).toBe(true);
    expect(db.artifactInputLineage.findMany).toHaveBeenCalledWith({
      where: { workspaceId: "ws-1", artifactType: "BrainDiscussionThread", artifactId: "resolved", origin: "HUMAN_ORIGINAL",
        id: expect.any(String), contentHash: expect.any(String) },
      orderBy: { revision: "desc" }, take: 1,
    });
  });

  it("captures the exact admitted target used by scoped backlink resolution", async () => {
    const source = article("public"); source.bodyMd = "[[target]]";
    const target = article("target"); target.bodyMd = "Original target";
    const result = await run(); await result.apply(db as any);
    expect(result.report.backlinksWritten).toBe(1);
    expect(db.brainBacklink.createMany).toHaveBeenCalledWith({data: [{workspaceId: "ws-1", fromArticleId: "public", toArticleId: "target"}], skipDuplicates: true});
    expect(snapshots.some(row => row.sourceKind === "BrainArticle" && row.sourceId === "target")).toBe(true);
    expect(await isArtifactInputProofReadable(actor, "ws-1", result.lineageRoots, db as any)).toBe(true);
  });

  it("denies a revision change before any status or backlink write", async () => {
    const source = article("public");
    const prepared = await run(); source.bodyMd = "Changed after scan";
    await expect(prepared.apply(db as any)).rejects.toMatchObject({code: "SOURCE_CHANGED"});
    expect(db.brainBacklink.createMany).not.toHaveBeenCalled(); expect(absorb).not.toHaveBeenCalled();
  });

  it("bounds reference work and preserves the original source proof for continuation", async () => {
    const source = article("public"); source.bodyMd = Array.from({length: 100}, (_, i) => `[[missing-${i}]]`).join(" ");
    const prepared = await run();
    expect(prepared.next.index).toBe(0);
    expect(prepared.next.source?.refOffset).toBeGreaterThan(0);
    expect(prepared.report.unresolvedReferenceCount).toBe(2);
    source.bodyMd = "changed after the first reference batch";
    await expect(runBrainMaintenance({workspaceId: "ws-1", actor, state: prepared.next})).rejects.toMatchObject({code: "SOURCE_CHANGED"});
  });
});
