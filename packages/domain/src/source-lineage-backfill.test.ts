import { createHash } from "node:crypto";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { AppActor } from "@corgtex/shared";
import { AppError } from "./errors";

const fixture = vi.hoisted(() => {
  const state = { rows: new Map<string, any[]>(), manifests: new Map<string, any>(), snapshots: [] as any[], events: new Map<string, any>(), jobs: new Map<string, any>(),
    sourceReadable: true, closureComplete: true, role: "ADMIN", beforeRecord: null as null | (() => void) };
  const membership = vi.fn();
  const capture = vi.fn();
  const readable = vi.fn();
  const closure = vi.fn();
  const record = vi.fn();
  const invalidate = vi.fn();
  const snapshotFindMany = vi.fn();
  const delegates = new Map<string, any>();
  const scoped = (row: any, where: any) => {
    if (where.AND) return where.AND.every((condition: any) => scoped(row, condition));
    const ws = where.workspaceId ?? where.crmWorkspaceId ?? where.circle?.workspaceId ?? where.conversation?.workspaceId
      ?? where.article?.workspaceId ?? where.thread?.article?.workspaceId ?? where.goal?.workspaceId ?? where.agentRun?.workspaceId ?? where.flow?.workspaceId ?? where.mapView?.workspaceId;
    return (!ws || row.workspaceId === ws) && (where.id === undefined || (typeof where.id === "string" ? row.id === where.id : row.id > where.id.gt));
  };
  const base = {
    $transaction: vi.fn(), $queryRawUnsafe: vi.fn(), $executeRaw: vi.fn(),
    artifactInputLineage: { findFirst: vi.fn(async ({ where }) => state.manifests.get(`${where.workspaceId}:${where.artifactType}:${where.artifactId}`) ?? null) },
    artifactInputSnapshot: { findMany: snapshotFindMany },
    event: { upsert: vi.fn(async ({ where, create }) => {
      if (!state.events.has(where.id)) state.events.set(where.id, { ...create });
      return state.events.get(where.id);
    }) },
    workflowJob: { findUnique: vi.fn(async ({ where }) => state.jobs.get(where.dedupeKey) ?? null), upsert: vi.fn(async ({ where, create }) => {
      if (!state.jobs.has(where.dedupeKey)) state.jobs.set(where.dedupeKey, { id: `job-${state.jobs.size}`, ...create });
      return state.jobs.get(where.dedupeKey);
    }) },
  };
  const prisma = new Proxy(base, { get(target, property) {
    if (property in target) return target[property as keyof typeof target];
    if (!delegates.has(String(property))) delegates.set(String(property), {
      findFirst: vi.fn(async ({ where, select }) => {
        const row = (state.rows.get(String(property)) ?? []).find((item) => scoped(item, where));
        if (!row) return null;
        return select ? Object.fromEntries(Object.keys(select).map((key) => [key, row[key]])) : structuredClone(row);
      }),
      findMany: vi.fn(async ({ where, take }) => (state.rows.get(String(property)) ?? []).filter((row) => scoped(row, where))
        .sort((left, right) => left.id.localeCompare(right.id)).slice(0, take).map((row) => ({ id: row.id }))),
    });
    return delegates.get(String(property));
  } });
  return { state, membership, capture, readable, closure, record, invalidate, snapshotFindMany, delegates, prisma, base };
});

function hash(_kind: string, row: unknown) { return createHash("sha256").update(JSON.stringify(row)).digest("hex"); }
vi.mock("@corgtex/shared", () => ({ prisma: fixture.prisma }));
vi.mock("./auth", () => ({ requireWorkspaceMembership: fixture.membership }));
vi.mock("./source-lineage", () => ({
  captureArtifactInputProof: fixture.capture, isArtifactInputProofReadable: fixture.readable, inspectStoredArtifactInputDependencies: fixture.closure,
  recordArtifactInputLineage: fixture.record, invalidateArtifactInputLineage: fixture.invalidate,
  lineageContentFingerprint: (kind: string, row: unknown) => hash(kind, row),
}));
import { assertDisposableSourceLineageBackfillDatabaseUrl, inspectSourceLineageBackfill, runSourceLineageBackfill, SOURCE_LINEAGE_BACKFILL_KINDS } from "./source-lineage-backfill";

const actor = { kind: "user", user: { id: "synthetic-a", email: "a@example.test", displayName: null } } as AppActor;
const workspaceId = "synthetic-ws-a";
const asOf = new Date("2026-10-12T12:00:00Z");
const base = { actor, workspaceId, asOf };
const input = { kind: "BrainArticle" as const, id: "article-a" };
const sourceRoot = { kind: "BrainSource" as const, id: "source-a", fingerprint: "a".repeat(64) };

function row(id = input.id, ws = workspaceId) { return { id, workspaceId: ws, title: "Synthetic original title", bodyMd: "Synthetic original body", sourceIds: [sourceRoot.id] }; }
function seed(delegate = "brainArticle", item: ReturnType<typeof row> & Record<string, unknown> = row()) { fixture.state.rows.set(delegate, [...(fixture.state.rows.get(delegate) ?? []), item]); return item; }
function manifest(kind = input.kind as string, item = row(), origin = "DERIVED") {
  const result = { revision: 1, origin, contentHash: hash(kind, item), rootsJson: origin === "HUMAN_ORIGINAL" ? [] : [sourceRoot] };
  fixture.state.manifests.set(`${item.workspaceId}:${kind}:${item.id}`, result);
  return result;
}
function snapshot(item = row(), origin = "DERIVED", kind = input.kind as string) {
  const result = { id: `snapshot-${fixture.state.snapshots.length}`, workspaceId: item.workspaceId, sourceKind: kind, sourceId: item.id,
    sourceFingerprint: hash(kind, item), contentJson: structuredClone(item), origin,
    accessEnvelopeJson: { isPrivate: false }, rootsJson: origin === "HUMAN_ORIGINAL" ? [] : [sourceRoot], createdAt: asOf };
  fixture.state.snapshots.push(result);
  return result;
}

beforeEach(() => {
  vi.clearAllMocks();
  fixture.state.rows = new Map(); fixture.state.manifests = new Map(); fixture.state.snapshots = [];
  fixture.state.events = new Map(); fixture.state.jobs = new Map(); fixture.state.sourceReadable = true; fixture.state.closureComplete = true;
  fixture.state.role = "ADMIN"; fixture.state.beforeRecord = null;
  fixture.membership.mockImplementation(async ({ actor: requester, workspaceId: ws }) => {
    if (requester.kind === "user" && requester.user.id === "synthetic-a" && ws !== workspaceId) throw new AppError(403, "NOT_A_MEMBER", "Synthetic tenant mismatch");
    return { id: "synthetic-member", role: fixture.state.role };
  });
  fixture.readable.mockImplementation(async () => fixture.state.sourceReadable);
  fixture.closure.mockImplementation(async (_db, _ws, roots) => ({ complete: fixture.state.closureComplete, roots }));
  fixture.capture.mockImplementation(async (_actor, ws, inputs) => {
    if (!fixture.state.sourceReadable) throw new AppError(409, "SOURCE_CHANGED", "Synthetic input revoked");
    return inputs.flatMap((item: any) => {
      if (item.kind === "ArtifactInputSnapshot") return [{ kind: item.kind, id: item.id, fingerprint: hash(item.kind, item.snapshot) }];
      const current = fixture.state.manifests.get(`${ws}:${item.kind}:${item.id}`);
      if (!current || current.origin === "UNKNOWN") throw new AppError(409, "UNKNOWN_LINEAGE", "Synthetic unknown input");
      return [{ kind: item.kind, id: item.id, fingerprint: current.contentHash }, ...current.rootsJson];
    });
  });
  fixture.snapshotFindMany.mockImplementation(async ({ where, take }) => fixture.state.snapshots.filter((item) => item.workspaceId === where.workspaceId
    && item.sourceKind === where.sourceKind && item.sourceId === where.sourceId && item.sourceFingerprint === where.sourceFingerprint
    && (!where.OR || +item.createdAt < +where.OR[1].createdAt || (+item.createdAt === +where.OR[1].createdAt && item.id < where.OR[1].id.lt)))
    .sort((left, right) => +right.createdAt - +left.createdAt || right.id.localeCompare(left.id)).slice(0, take));
  fixture.record.mockImplementation(async (params) => {
    fixture.state.beforeRecord?.();
    if (!fixture.state.sourceReadable) throw new AppError(409, "SOURCE_CHANGED", "Synthetic input revoked before commit");
    fixture.state.manifests.set(`${params.workspaceId}:${params.artifact.kind}:${params.artifact.id}`, {
      revision: 1, origin: params.origin, contentHash: hash(params.artifact.kind, params.content), rootsJson: params.inheritedRoots,
    });
  });
  fixture.invalidate.mockImplementation(async (params) => {
    const key = `${params.workspaceId}:${params.artifact.kind}:${params.artifact.id}`;
    fixture.state.manifests.set(key, { revision: (fixture.state.manifests.get(key)?.revision ?? 0) + 1, origin: "UNKNOWN",
      contentHash: hash(params.artifact.kind, params.content), rootsJson: null });
  });
  fixture.base.$transaction.mockImplementation(async (callback) => {
    const before = structuredClone({ rows: fixture.state.rows, manifests: fixture.state.manifests, events: fixture.state.events, jobs: fixture.state.jobs });
    try { return await callback(fixture.prisma); }
    catch (error) { Object.assign(fixture.state, before); throw error; }
  });
});

describe("strict source lineage backfill", () => {
  it("scans generated legacy chunks but never recovers an original from matching parent metadata", async () => {
    const chunk = seed("knowledgeChunk", { id: "legacy-chunk", workspaceId, title: "Unproved generated body", bodyMd: "",
      sourceIds: [], sourceType: "DOCUMENT", sourceId: "source", content: "Arbitrary historical text", embedding: [99, 99],
      metadata: { sourceContentHash: "a".repeat(64) } });
    snapshot(chunk, "HUMAN_ORIGINAL", "KnowledgeChunk");
    expect(SOURCE_LINEAGE_BACKFILL_KINDS).toContain("KnowledgeChunk");
    const result = await runSourceLineageBackfill({ ...base, artifacts: [{ kind: "KnowledgeChunk", id: chunk.id }], mode: "apply" });
    expect(result.certified).toBe(0); expect(result.counts.WITHHELD).toBe(1);
    expect(fixture.record).not.toHaveBeenCalled(); expect(fixture.state.rows.get("knowledgeChunk")).toEqual([chunk]);
  });

  it("defaults to a dry run, reports incomplete history, and never certifies citations or audit guesses", async () => {
    seed();
    const result = await runSourceLineageBackfill({ ...base, artifacts: [input] });
    expect(result.mode).toBe("dry-run");
    expect(result.counts.WITHHELD).toBe(1);
    expect(result.entries[0]).toMatchObject({ reason: "NO_COMPLETE_HISTORICAL_EVIDENCE", blockers: ["NO_SAFE_AUTOMATIC_REBUILD_RECIPE"] });
    expect(fixture.record).not.toHaveBeenCalled(); expect(fixture.invalidate).not.toHaveBeenCalled();
    expect(fixture.base.$transaction).not.toHaveBeenCalled();
    expect(JSON.stringify(result)).not.toContain("Synthetic original body");
    expect(JSON.stringify(result)).not.toContain("Synthetic original title");
    expect(JSON.stringify(result)).not.toContain(sourceRoot.id);
  });

  it("keeps a complete current receipt without rewriting or rescheduling it", async () => {
    const existing = seed(); manifest(input.kind, existing);
    const result = await runSourceLineageBackfill({ ...base, artifacts: [input], mode: "apply" });
    expect(result.counts.VERIFIED_CURRENT).toBe(1);
    expect(result).toMatchObject({ certified: 0, markedUnknown: 0, scheduled: 0 });
    expect(fixture.record).not.toHaveBeenCalled(); expect(fixture.invalidate).not.toHaveBeenCalled();
  });

  it("recovers only an exact recorded complete DERIVED snapshot and preserves original content", async () => {
    const existing = seed(); const proof = snapshot(existing);
    const result = await runSourceLineageBackfill({ ...base, artifacts: [input], mode: "apply" });
    expect(result.certified).toBe(1);
    expect(fixture.record).toHaveBeenCalledWith(expect.objectContaining({ artifact: input, content: existing, origin: "DERIVED",
      inheritedRoots: [{ kind: "ArtifactInputSnapshot", id: proof.id, fingerprint: hash("ArtifactInputSnapshot", proof) }] }));
    expect(fixture.state.rows.get("brainArticle")).toEqual([existing]);
    const retry = await runSourceLineageBackfill({ ...base, artifacts: [input], mode: "apply" });
    expect(retry.certified).toBe(0); expect(retry.counts.VERIFIED_CURRENT).toBe(1);
  });

  it("can recover an expressly recorded exact human original, without interpreting its empty citations as proof", async () => {
    const existing = seed(); snapshot(existing, "HUMAN_ORIGINAL");
    const result = await runSourceLineageBackfill({ ...base, artifacts: [input], mode: "apply" });
    expect(result.certified).toBe(1);
    expect(fixture.record).toHaveBeenCalledWith(expect.objectContaining({ origin: "HUMAN_ORIGINAL", inputs: [], inheritedRoots: [] }));
  });

  it("does not restore a snapshot over a later UNKNOWN receipt", async () => {
    const existing = seed(); snapshot(existing); manifest(input.kind, existing, "UNKNOWN");
    const result = await runSourceLineageBackfill({ ...base, artifacts: [input], mode: "apply" });
    expect(result.entries[0]?.reason).toBe("LATEST_UNKNOWN_RECEIPT"); expect(result.certified).toBe(0);
    expect(fixture.snapshotFindMany).not.toHaveBeenCalled(); expect(fixture.record).not.toHaveBeenCalled(); expect(fixture.invalidate).not.toHaveBeenCalled();
  });

  it("marks an unreceipted later edit UNKNOWN and retains the prior history", async () => {
    const existing = seed(); const earlier = manifest(input.kind, existing); earlier.contentHash = "f".repeat(64); snapshot(existing);
    const result = await runSourceLineageBackfill({ ...base, artifacts: [input], mode: "apply" });
    expect(result).toMatchObject({ certified: 0, markedUnknown: 1 }); expect(result.entries[0]?.reason).toBe("UNRECEIPTED_CONTENT_CHANGE");
    expect(fixture.record).not.toHaveBeenCalled(); expect(fixture.state.rows.get("brainArticle")).toEqual([existing]);
  });

  it.each(["UNKNOWN", "DERIVED_EMPTY", "HUMAN_WITH_ROOTS", "CORRUPT_CONTENT", "WRONG_WORKSPACE", "WRONG_KIND", "WRONG_ID"])("rejects incomplete or mismatched immutable evidence: %s", async (condition) => {
    const existing = seed(); const proof = snapshot(existing);
    if (condition === "UNKNOWN") proof.origin = "UNKNOWN";
    if (condition === "DERIVED_EMPTY") proof.rootsJson = [];
    if (condition === "HUMAN_WITH_ROOTS") proof.origin = "HUMAN_ORIGINAL";
    if (condition === "CORRUPT_CONTENT") proof.contentJson.bodyMd = "Unrecorded replacement";
    if (condition === "WRONG_WORKSPACE") proof.workspaceId = "synthetic-ws-b";
    if (condition === "WRONG_KIND") proof.sourceKind = "Proposal";
    if (condition === "WRONG_ID") proof.sourceId = "other-article";
    const result = await runSourceLineageBackfill({ ...base, artifacts: [input], mode: "apply" });
    expect(result).toMatchObject({ certified: 0, markedUnknown: 1 }); expect(fixture.record).not.toHaveBeenCalled();
  });

  it("does not certify generated memory from a claimed human-original empty-root snapshot", async () => {
    const existing = seed("agentMemory", row("memory-a")); snapshot(existing, "HUMAN_ORIGINAL", "AgentMemory");
    const result = await runSourceLineageBackfill({ ...base, artifacts: [{ kind: "AgentMemory", id: existing.id }], mode: "apply" });
    expect(result.certified).toBe(0); expect(result.counts.WITHHELD).toBe(1);
  });

  it("finds complete immutable evidence beyond an initial page of invalid snapshots", async () => {
    const existing = seed(); const valid = snapshot(existing); valid.createdAt = new Date("2026-10-01T00:00:00Z");
    for (let index = 0; index < 105; index += 1) snapshot(existing, "UNKNOWN");
    const result = await runSourceLineageBackfill({ ...base, artifacts: [input] });
    expect(result.entries[0]).toMatchObject({ status: "RECOVERABLE_SNAPSHOT", snapshotId: valid.id });
    expect(fixture.snapshotFindMany).toHaveBeenCalledTimes(2);
  });

  it("reports evidence-budget exhaustion explicitly rather than claiming complete evidence does not exist", async () => {
    const existing = seed();
    const valid = snapshot(existing); valid.createdAt = new Date("2026-10-01T00:00:00Z");
    for (let index = 0; index < 1_001; index += 1) snapshot(existing, "UNKNOWN");
    const result = await runSourceLineageBackfill({ ...base, artifacts: [input], mode: "apply" });
    expect(result.entries[0]?.reason).toBe("SNAPSHOT_EVIDENCE_SCAN_LIMIT");
    expect(result.entries[0]?.blockers).toContain("SNAPSHOT_EVIDENCE_SCAN_LIMIT");
    expect(fixture.snapshotFindMany).toHaveBeenCalledTimes(11);
    expect(result.markedUnknown).toBe(0);
    expect(fixture.state.manifests.size).toBe(0);
    const expanded = await runSourceLineageBackfill({ ...base, artifacts: [input], snapshotScanLimit: 1_100, mode: "apply" });
    expect(expanded.certified).toBe(1);
  });

  it("withholds snapshots with unknown transitive dependencies or revoked current permissions", async () => {
    const existing = seed(); snapshot(existing); fixture.state.closureComplete = false;
    expect((await inspectSourceLineageBackfill({ ...base, artifacts: [input] })).counts.WITHHELD).toBe(1);
    fixture.state.closureComplete = true; fixture.state.sourceReadable = false;
    expect((await inspectSourceLineageBackfill({ ...base, artifacts: [input] })).counts.WITHHELD).toBe(1);
    expect(fixture.record).not.toHaveBeenCalled();
  });

  it("never invalidates a still-correct manifest merely because its current sources are restricted", async () => {
    const existing = seed(); const proof = manifest(input.kind, existing); fixture.state.sourceReadable = false;
    const result = await runSourceLineageBackfill({ ...base, artifacts: [input], mode: "apply" });
    expect(result.entries[0]?.reason).toBe("CURRENT_RECEIPT_RESTRICTED_OR_INCOMPLETE");
    expect(result.markedUnknown).toBe(0); expect(fixture.state.manifests.get(`${workspaceId}:${input.kind}:${input.id}`)).toEqual(proof);
  });

  it("queues only supported fresh recipes, without original content, and repeats without duplicate jobs", async () => {
    const existing = seed("workspaceBriefing", row("briefing-a"));
    const artifacts = [{ kind: "WorkspaceBriefing" as const, id: existing.id }];
    const first = await runSourceLineageBackfill({ ...base, artifacts, mode: "apply" });
    expect(first).toMatchObject({ markedUnknown: 1, scheduled: 2 });
    expect([...fixture.state.jobs.values()].map((job) => job.type)).toEqual(["brain.daily-digest", "brain.daily-digest"]);
    expect([...fixture.state.jobs.values()].every((job) => job.payload.regenerationOnly === true)).toBe(true);
    expect([...fixture.state.jobs.values()].every((job) => job.payload.dateISO === "2026-10-12T00:00:00.000Z")).toBe(true);
    expect(JSON.stringify([...fixture.state.jobs.values()])).not.toContain(existing.bodyMd);
    expect(first.entries[0]?.blockers).toEqual(["ORIGINAL_REMAINS_WITHHELD_UNTIL_FRESH_OUTPUT"]);
    const retry = await runSourceLineageBackfill({ ...base, artifacts, mode: "apply" });
    expect(retry).toMatchObject({ markedUnknown: 0, scheduled: 0 }); expect(retry.rebuild?.event.id).toBe(first.rebuild?.event.id);
    expect(fixture.state.events.size).toBe(1); expect(fixture.state.jobs.size).toBe(2);
  });

  it("supports selected company and native graph recipes without claiming arbitrary proposals or manual graphs are rebuildable", async () => {
    const question = seed("checkIn", { ...row("question-a"), questionSource: "company-understanding" });
    const native = seed("contextGraphObject", { ...row("native-a"), sourceEntityType: "BrainArticle", sourceEntityId: "known-source-article" });
    const manual = seed("contextGraphObject", { ...row("manual-a"), sourceEntityType: null });
    const proposal = seed("proposal", row("proposal-a"));
    const result = await runSourceLineageBackfill({ ...base, artifacts: [{ kind: "CheckIn", id: question.id }, { kind: "ContextGraphObject", id: native.id },
      { kind: "ContextGraphObject", id: manual.id }, { kind: "Proposal", id: proposal.id }], mode: "apply" });
    expect(result.scheduled).toBe(2);
    expect([...fixture.state.jobs.values()].map((job) => job.type)).toEqual(["agent.company-understanding", "context-graph.reconcile"]);
    expect(result.entries.filter((entry) => entry.id === manual.id || entry.id === proposal.id).every((entry) => entry.blockers.includes("NO_SAFE_AUTOMATIC_REBUILD_RECIPE"))).toBe(true);
  });

  it("can explicitly leave scheduling to the local operator", async () => {
    const existing = seed("workspaceBriefing", row("briefing-a"));
    const result = await runSourceLineageBackfill({ ...base, artifacts: [{ kind: "WorkspaceBriefing", id: existing.id }], mode: "apply", scheduleRebuilds: false });
    expect(result.scheduled).toBe(0); expect(result.markedUnknown).toBe(1); expect(fixture.state.jobs.size).toBe(0);
  });

  it("rolls back the batch when source access changes during certification", async () => {
    const unknown = seed("action", row("action-a")); const existing = seed(); snapshot(existing);
    fixture.state.beforeRecord = () => { fixture.state.sourceReadable = false; };
    await expect(runSourceLineageBackfill({ ...base, artifacts: [{ kind: "Action", id: unknown.id }, input], mode: "apply" })).rejects.toMatchObject({ code: "SOURCE_CHANGED" });
    expect(fixture.state.manifests.size).toBe(0); expect(fixture.state.jobs.size).toBe(0);
    expect(fixture.state.rows.get("brainArticle")).toEqual([existing]);
  });

  it("requires current operator membership, rejects ordinary members, and preserves tenant selection", async () => {
    seed(); fixture.state.role = "CONTRIBUTOR";
    await expect(runSourceLineageBackfill({ ...base, artifacts: [input], mode: "apply" })).rejects.toMatchObject({ code: "ADMIN_REQUIRED" });
    fixture.state.role = "ADMIN";
    await expect(inspectSourceLineageBackfill({ ...base, workspaceId: "synthetic-ws-b", artifacts: [input] })).rejects.toMatchObject({ code: "NOT_A_MEMBER" });
    const bob = { kind: "user", user: { id: "synthetic-b", email: "b@example.test", displayName: null } } as AppActor;
    expect((await inspectSourceLineageBackfill({ ...base, actor: bob, workspaceId: "synthetic-ws-b", artifacts: [input] })).counts.MISSING).toBe(1);
    expect(fixture.record).not.toHaveBeenCalled();
  });

  it("inventories all scoped keyset batches and rejects an exceeded limit before applying anything", async () => {
    fixture.state.rows.set("brainArticle", Array.from({ length: 105 }, (_, index) => row(`article-${String(index).padStart(3, "0")}`)));
    const result = await inspectSourceLineageBackfill({ ...base, kinds: ["BrainArticle"] });
    expect(result.counts.WITHHELD).toBe(105);
    expect(fixture.delegates.get("brainArticle").findMany).toHaveBeenLastCalledWith(expect.objectContaining({ where: { AND: [{ workspaceId }, { id: { gt: "article-099" } }] } }));
    await expect(runSourceLineageBackfill({ ...base, kinds: ["BrainArticle"], scanLimit: 100, mode: "apply" })).rejects.toMatchObject({ code: "BACKFILL_SCAN_LIMIT" });
    expect(fixture.record).not.toHaveBeenCalled(); expect(fixture.invalidate).not.toHaveBeenCalled();
  });

  it("deduplicates selected IDs and reports unsupported kinds without raw SQL interpolation", async () => {
    seed();
    const result = await runSourceLineageBackfill({ ...base, artifacts: [input, input, { kind: "unrecognized\";DROP" as any, id: "unsafe" }], mode: "apply" });
    expect(result.entries).toHaveLength(2); expect(result.counts.UNSUPPORTED).toBe(1);
    expect(fixture.base.$queryRawUnsafe).toHaveBeenCalledTimes(1);
    expect(fixture.base.$queryRawUnsafe).toHaveBeenCalledWith('SELECT id FROM "BrainArticle" WHERE id = $1 FOR UPDATE', input.id);
  });

  it("does not let an explicit Workspace ID override the selected tenant scope", async () => {
    seed("workspace", row("synthetic-ws-b", "synthetic-ws-b"));
    const result = await inspectSourceLineageBackfill({ ...base, artifacts: [{ kind: "Workspace", id: "synthetic-ws-b" }] });
    expect(result.counts.MISSING).toBe(1);
    expect(fixture.capture).not.toHaveBeenCalled();
  });

  it("scopes Brain discussion comments through their thread's article workspace", async () => {
    seed("brainDiscussionComment", row("comment-a", "synthetic-ws-b"));
    const result = await inspectSourceLineageBackfill({ ...base, artifacts: [{ kind: "BrainDiscussionComment", id: "comment-a" }] });
    expect(result.counts.MISSING).toBe(1);
    expect(fixture.delegates.get("brainDiscussionComment").findFirst).toHaveBeenCalledWith({
      where: { AND: [{ thread: { article: { workspaceId } } }, { id: "comment-a" }] },
    });
  });

  it("rejects blank IDs before inventory or mutations", async () => {
    seed();
    await expect(runSourceLineageBackfill({ ...base, artifacts: [{ ...input, id: "" }], mode: "apply" })).rejects.toMatchObject({ code: "INVALID_INPUT" });
    expect(fixture.base.$transaction).not.toHaveBeenCalled();
  });

  it.each([
    "postgresql://postgres:synthetic@db.example.test/corgtex_test", "postgresql://postgres:synthetic@localhost/corgtex",
    "https://localhost/corgtex_test", "not-a-database-url",
  ])("refuses a nondisposable local runner target without exposing credentials: %s", (url) => {
    expect(() => assertDisposableSourceLineageBackfillDatabaseUrl(url)).toThrow(expect.objectContaining({ code: "UNSAFE_BACKFILL_TARGET" }));
  });

  it("accepts the isolated local test target and returns only nonsecret identity", () => {
    expect(assertDisposableSourceLineageBackfillDatabaseUrl("postgresql://postgres:synthetic@127.0.0.1:55468/corgtex_test?schema=public"))
      .toEqual({ hostname: "127.0.0.1", port: "55468", database: "corgtex_test" });
  });
});
