import { beforeEach, describe, expect, it, vi } from "vitest";
const { db, rebuild, absorb, membership } = vi.hoisted(() => ({ db: {
  informationCategoryPolicy: {findUnique: vi.fn(async () => null)},
  workspace: {findFirst: vi.fn()}, brainArticle: {findMany: vi.fn(), findFirst: vi.fn()}, brainSource: {findMany: vi.fn(), findFirst: vi.fn()},
  brainDiscussionThread: {findMany: vi.fn(), findFirst: vi.fn()}, brainDiscussionComment: {findFirst: vi.fn()},
  knowledgeChunk: {findMany: vi.fn(), findFirst: vi.fn(), deleteMany: vi.fn()},
  artifactInputLineage: {findFirst: vi.fn(), findMany: vi.fn(), create: vi.fn()}, artifactInputSnapshot: {findFirst: vi.fn(), create: vi.fn()}, $transaction: vi.fn(), $queryRaw: vi.fn(), $executeRaw: vi.fn(),
}, rebuild: vi.fn(), absorb: vi.fn(), membership: vi.fn() }));
vi.mock("@corgtex/shared", async original => ({...await original<any>(), prisma: db}));
vi.mock("../../domain/src/auth", () => ({requireWorkspaceMembership: membership}));
vi.mock("../../domain/src/brain-access", () => ({resolveKnowledgeAccessDomains: vi.fn(async () => ["WORKSPACE"])}));
vi.mock("@corgtex/domain", async () => ({...await import("../../domain/src/source-lineage"), ...await import("../../domain/src/errors"),
  WIKILINK_RE: /\[\[([^\]]+)\]\]/g, rebuildBacklinks: rebuild, markThreadAbsorbed: absorb}));
import { runBrainMaintenance } from "./brain-maintenance";
import { recordArtifactInputLineage, isArtifactInputProofReadable, captureArtifactInputProof } from "../../domain/src/source-lineage";
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
    (db as any)[delegate].findMany?.mockImplementation(async () => rows[kind] ?? []);
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
  rebuild.mockResolvedValue({linkCount: 0}); absorb.mockResolvedValue({id: "resolved", status: "ABSORBED"});
});
const actor = {kind: "agent", authProvider: "bootstrap", label: "brain-maintenance", workspaceIds: ["ws-1"]} as any;
const originalAuthor = {kind: "user", user: {id: "author", email: "author@synthetic.test", displayName: "Author"}} as any;
async function certifyOriginals() {
  for (const {kind, row} of originals.splice(0)) await recordArtifactInputLineage({tx: db as any, actor: originalAuthor, workspaceId: "ws-1", artifact: {kind: kind as any, id: row.id}, content: row, origin: "HUMAN_ORIGINAL", inputs: []});
}
const run = async () => {
  await certifyOriginals();
  return runBrainMaintenance({workspaceId: "ws-1", agentRunId: "run", actor});
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
    add("BrainSource", {id: "source", workspaceId: "ws-1", sourceType: "TEXT", accessDomain: "WORKSPACE", archivedAt: null, contentText: "Allowed", createdAt: date});
    add("BrainSource", {id: "finance", workspaceId: "ws-1", sourceType: "TEXT", accessDomain: "FINANCE", archivedAt: null, contentText: "Hidden", createdAt: date});
    add("KnowledgeChunk", {id: "legacy-event", workspaceId: "ws-1", sourceType: "EVENT", accessDomain: "WORKSPACE", content: "Unproved event", createdAt: date}, false);
    absorb.mockImplementation(async (_actor, params) => {
      expect(snapshots.length).toBeGreaterThan(0);
      expect(await isArtifactInputProofReadable(actor, "ws-1", params.expectedInputRoots, db as any)).toBe(true);
      resolved.status = "ABSORBED";
      return resolved;
    });
    const result = await run();
    expect(result).toMatchObject({staleArticleCount: 1, deadLinkCount: 1, orphanCount: 1, tier3CleanupCandidates: 1,
      staleThreadCount: 1, absorbedThreadCount: 1, prunedEventsCount: 0});
    expect(absorb).toHaveBeenCalledOnce();
    expect(absorb.mock.calls[0][1].threadId).toBe("resolved");
    expect(db.knowledgeChunk.deleteMany).not.toHaveBeenCalled();
    expect(snapshots.some(row => row.sourceId === "private-thread" || row.sourceId === "unknown-thread" || row.sourceId === "recent" || row.sourceId === "finance")).toBe(false);
    expect(await isArtifactInputProofReadable(actor, "ws-1", result.lineageRoots, db as any)).toBe(true);
    expect(db.artifactInputLineage.findMany).toHaveBeenCalledWith({
      where: { workspaceId: "ws-1", artifactType: "BrainArticle", artifactId: "public", origin: "HUMAN_ORIGINAL",
        id: expect.any(String), contentHash: expect.any(String) },
      orderBy: { revision: "desc" }, take: 1,
    });
  });

  it("captures the exact additional article revisions consumed by backlink rebuilding", async () => {
    article("public");
    rebuild.mockImplementation(async (_actor, {tx}) => {
      const late = article("newly-visible");
      await certifyOriginals();
      await captureArtifactInputProof(actor, "ws-1", [{kind: "BrainArticle", id: late.id, snapshot: late}], tx);
      return {linkCount: 1};
    });
    const result = await run();
    expect(result.backlinkCount).toBe(1);
    expect(snapshots.some(row => row.sourceKind === "BrainArticle" && row.sourceId === "newly-visible")).toBe(true);
    expect(await isArtifactInputProofReadable(actor, "ws-1", result.lineageRoots, db as any)).toBe(true);
  });

  it("denies a revision change before any status or backlink write", async () => {
    const source = article("public");
    db.$transaction.mockImplementation(async work => {source.bodyMd = "Changed after scan"; return work(db);});
    await expect(run()).rejects.toMatchObject({code: "SOURCE_CHANGED"});
    expect(rebuild).not.toHaveBeenCalled(); expect(absorb).not.toHaveBeenCalled();
  });

  it("rejects an incomplete scan without publishing partial counts", async () => {
    db.brainArticle.findMany.mockResolvedValue(Array.from({length: 5001}, (_, i) => ({id: String(i)})));
    await expect(run()).rejects.toMatchObject({code: "SOURCE_READ_SCAN_LIMIT"});
    expect(rebuild).not.toHaveBeenCalled();
  });
});
