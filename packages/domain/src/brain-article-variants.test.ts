import { createHash } from "node:crypto";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { AppActor } from "@corgtex/shared";
import { AppError } from "./errors";
import { generateBrainArticleVariant, getReadableBrainArticleVariant, requestBrainArticleVariant } from "./brain-article-variants";

const { db, state, lineage, requireMembership } = vi.hoisted(() => {
  const state = {
    target: null as any, variant: null as any, manifest: null as any, job: null as any,
    sources: [] as any[], readableSources: new Set<string>(), histories: {} as Record<string, any[]>,
    member: null as any, membershipActive: true, dependenciesComplete: true, variantReadable: true,
    canonicalReadable: false, upstream: null as any,
  };
  const db = {
    $transaction: vi.fn(), $queryRaw: vi.fn(),
    brainArticle: { findFirst: vi.fn(), create: vi.fn(), update: vi.fn() },
    brainSource: { findMany: vi.fn() }, artifactInputLineage: { findFirst: vi.fn() },
    workflowJob: { findUnique: vi.fn(), findFirst: vi.fn(), create: vi.fn(), update: vi.fn() },
    member: { findFirst: vi.fn() }, workspaceArchiveRecord: { findMany: vi.fn() }, auditLog: { create: vi.fn() },
  };
  const lineage = {
    captureArtifactInputProof: vi.fn(), currentArtifactInputRoots: vi.fn(), inspectStoredArtifactInputDependencies: vi.fn(),
    isArtifactInputProofReadable: vi.fn(), lineageContentFingerprint: vi.fn(), readableArtifactIds: vi.fn(),
    readableBrainSourceIds: vi.fn(), recordArtifactInputLineage: vi.fn(),
  };
  return { db, state, lineage, requireMembership: vi.fn() };
});

vi.mock("@corgtex/shared", () => ({ prisma: db }));
vi.mock("./auth", () => ({ requireWorkspaceMembership: requireMembership }));
vi.mock("./source-lineage", () => lineage);
vi.mock("./workspace-support-access", () => ({ lockWorkspaceMembership: vi.fn() }));
vi.mock("./brain-source-links", () => ({ lockBrainSourceLink: vi.fn(), lockActiveArticleSources: vi.fn() }));
vi.mock("./events", () => ({ appendEvents: vi.fn() }));
vi.mock("./permalinks", () => ({ ensureWorkspacePermalink: vi.fn(), workspaceEntityCanonicalPath: vi.fn(() => "/safe-variant") }));

const actor: AppActor = { kind: "user", user: { id: "user-1", email: "one@example.test", displayName: "One", globalRole: "USER" } };
const params = { workspaceId: "ws-1", articleId: "canonical" };
const lease = { workspaceId: "ws-1", jobId: "job-1", expectedAttempt: 1, expectedOwner: "worker-1" };

function fingerprint(kind: string, row: any) {
  return createHash("sha256").update(JSON.stringify([kind, row.id, row.title, row.content, row.bodyMd, row.updatedAt])).digest("hex");
}

function source(id: string, title = `Source ${id}`) {
  return { id, workspaceId: "ws-1", title, content: `Permitted facts from ${id}`, sourceType: "DOCUMENT", tier: 1,
    ingestionGuidanceMd: "Summarize supported facts.", archivedAt: null, metadata: { internal: "not a prompt input" } };
}

beforeEach(() => {
  vi.clearAllMocks();
  state.target = { id: "canonical", workspaceId: "ws-1", title: "SECRET CANONICAL TITLE", bodyMd: "SECRET CANONICAL BODY",
    slug: "secret-canonical-slug", frontmatterJson: { secret: "SECRET ALIAS" }, type: "STRATEGY", isPrivate: false,
    ownerMemberId: null, variantOfArticleId: null, archivedAt: null, updatedAt: "2026-10-01" };
  state.sources = [source("public-2"), source("finance"), source("public-1")];
  state.readableSources = new Set(["public-1", "public-2"]);
  state.manifest = { id: "manifest-1", origin: "DERIVED", contentHash: fingerprint("BrainArticle", state.target), rootsJson:
    state.sources.map((row) => ({ kind: "BrainSource", id: row.id, fingerprint: fingerprint("BrainSource", row) })) };
  state.member = { id: "member-1", workspaceId: "ws-1", userId: "user-1", role: "CONTRIBUTOR", isActive: true,
    user: actor.kind === "user" ? actor.user : null };
  state.variant = null; state.job = null; state.histories = {}; state.upstream = null;
  state.membershipActive = true; state.dependenciesComplete = true; state.variantReadable = true; state.canonicalReadable = false;
  db.$transaction.mockImplementation(async (callback) => callback(db));
  db.$queryRaw.mockResolvedValue([]);
  db.auditLog.create.mockResolvedValue({});
  requireMembership.mockImplementation(async ({ actor: currentActor, workspaceId }) => {
    if (!state.membershipActive || workspaceId !== state.member.workspaceId || currentActor.kind !== "user"
      || currentActor.user.id !== state.member.userId) throw new AppError(403, "NOT_A_MEMBER", "Not a member.");
    return { ...state.member };
  });
  db.member.findFirst.mockImplementation(async ({ where }) => state.membershipActive && where.id === state.member.id
    && where.userId === state.member.userId && where.workspaceId === state.member.workspaceId ? { ...state.member } : null);
  db.brainArticle.findFirst.mockImplementation(async ({ where }) => {
    if ("variantOfArticleId" in where) return state.variant && state.variant.workspaceId === where.workspaceId
      && state.variant.variantOfArticleId === where.variantOfArticleId && state.variant.ownerMemberId === where.ownerMemberId
      && state.variant.variantTargetFingerprint === where.variantTargetFingerprint
      && state.variant.variantInputSetHash === where.variantInputSetHash ? { ...state.variant } : null;
    return state.target?.id === where.id && state.target.workspaceId === where.workspaceId && !state.target.archivedAt ? { ...state.target } : null;
  });
  db.brainSource.findMany.mockImplementation(async ({ where }) => state.sources
    .filter((row) => row.workspaceId === where.workspaceId && where.id.in.includes(row.id) && !row.archivedAt).map((row) => ({ ...row })));
  db.artifactInputLineage.findFirst.mockImplementation(async () => state.manifest);
  db.workspaceArchiveRecord.findMany.mockImplementation(async ({ where }) => state.histories[where.entityId] ?? []);
  lineage.lineageContentFingerprint.mockImplementation(fingerprint);
  lineage.currentArtifactInputRoots.mockImplementation(async () => state.manifest?.rootsJson ?? null);
  lineage.inspectStoredArtifactInputDependencies.mockImplementation(async (_db, _workspaceId, roots) => ({ complete: state.dependenciesComplete,
    roots }));
  lineage.readableBrainSourceIds.mockImplementation(async (_actor, _workspaceId, rows) => new Set(rows
    .filter((row: any) => state.readableSources.has(row.id)).map((row: any) => row.id)));
  lineage.readableArtifactIds.mockImplementation(async (currentActor, _workspaceId, _kind, rows) => new Set(rows
    .filter((row: any) => row.variantOfArticleId ? state.variantReadable && !row.archivedAt && row.isPrivate
      && currentActor.kind === "user" && currentActor.user.id === state.member.userId && row.ownerMemberId === state.member.id
      : state.canonicalReadable).map((row: any) => row.id)));
  lineage.captureArtifactInputProof.mockImplementation(async (_actor, _workspaceId, inputs) => {
    const roots = inputs.map((input: any) => ({ kind: input.kind, id: input.id, fingerprint: fingerprint(input.kind, input.snapshot) }));
    return state.upstream ? [...roots, { ...state.upstream }] : roots;
  });
  lineage.isArtifactInputProofReadable.mockImplementation(async (_actor, _workspaceId, roots) => state.membershipActive
    && roots.every((root: any) => root.kind === "BrainSource" ? state.readableSources.has(root.id)
      && state.sources.some((row) => !row.archivedAt && row.id === root.id && root.fingerprint === fingerprint(root.kind, row))
      : state.upstream && root.fingerprint === state.upstream.fingerprint));
  lineage.recordArtifactInputLineage.mockResolvedValue({});
  db.brainArticle.create.mockImplementation(async ({ data }) => {
    state.variant = { id: "variant-1", archivedAt: null, createdAt: new Date(), updatedAt: new Date(), ...data };
    return { ...state.variant };
  });
  db.workflowJob.findUnique.mockImplementation(async ({ where }) => state.job?.dedupeKey === where.dedupeKey ? { ...state.job } : null);
  db.workflowJob.findFirst.mockImplementation(async ({ where }) => state.job?.id === where.id && state.job.workspaceId === where.workspaceId
    && state.job.type === where.type ? { ...state.job } : null);
  db.workflowJob.create.mockImplementation(async ({ data }) => {
    state.job = { id: "job-1", status: "PENDING", attempts: 0, lockedBy: null, ...data };
    return { ...state.job };
  });
  db.workflowJob.update.mockImplementation(async ({ data }) => { state.job = { ...state.job, ...data }; return { ...state.job }; });
});

async function queuedJob() {
  expect(await requestBrainArticleVariant(actor, params)).toEqual({ status: "pending", jobId: "job-1" });
  state.job = { ...state.job, status: "RUNNING", attempts: 1, lockedBy: "worker-1" };
}

describe("permitted-source article variants", () => {
  it("enqueues only permitted sources discovered through historical receipts and no canonical content", async () => {
    const result = await requestBrainArticleVariant(actor, params);
    expect(result).toEqual({ status: "pending", jobId: "job-1" });
    expect(state.job.payload.sources.map((row: any) => row.id)).toEqual(["public-1", "public-2"]);
    expect(state.job.payload).toMatchObject({ memberId: "member-1", userId: "user-1", articleId: "canonical", phase: "REQUESTED" });
    expect(JSON.stringify(state.job.payload)).not.toContain("SECRET");
    expect(JSON.stringify(state.job.payload)).not.toContain("finance");
    expect(lineage.captureArtifactInputProof).toHaveBeenCalledWith(actor, "ws-1", [
      expect.objectContaining({ kind: "BrainSource", id: "public-1", snapshot: expect.objectContaining({ content: "Permitted facts from public-1" }) }),
      expect.objectContaining({ kind: "BrainSource", id: "public-2", snapshot: expect.objectContaining({ content: "Permitted facts from public-2" }) }),
    ], db);
  });

  it.each(["missing", "unknown", "malformed"])("preserves an unprovable canonical (%s) without using citation guesses", async (kind) => {
    state.target.sourceIds = ["public-1"];
    if (kind === "missing") state.manifest = null;
    if (kind === "unknown") state.manifest = { ...state.manifest, origin: "UNKNOWN", rootsJson: [] };
    if (kind === "malformed") lineage.currentArtifactInputRoots.mockResolvedValue(null);
    expect(await requestBrainArticleVariant(actor, params)).toEqual({ status: "unavailable" });
    expect(db.workflowJob.create).not.toHaveBeenCalled();
    expect(db.brainArticle.update).not.toHaveBeenCalled();
    expect(lineage.captureArtifactInputProof).not.toHaveBeenCalled();
  });

  it("does not rebuild a certified independent human original with citation-only links", async () => {
    state.target.sourceIds = ["finance"];
    state.manifest = { ...state.manifest, origin: "HUMAN_ORIGINAL", rootsJson: [] };
    expect(await requestBrainArticleVariant(actor, params)).toEqual({ status: "original" });
    expect(db.workflowJob.create).not.toHaveBeenCalled();
    expect(lineage.inspectStoredArtifactInputDependencies).not.toHaveBeenCalled();
  });

  it("does not rebuild a broader canonical already readable by this member", async () => {
    state.canonicalReadable = true;
    expect(await requestBrainArticleVariant(actor, params)).toEqual({ status: "original" });
    expect(db.workflowJob.create).not.toHaveBeenCalled();
  });

  it.each(["private", "other-workspace", "archived", "variant"])("rejects an intrinsically unavailable target (%s)", async (kind) => {
    if (kind === "private") state.target = { ...state.target, isPrivate: true, ownerMemberId: "other-member" };
    if (kind === "other-workspace") state.target.workspaceId = "other-workspace";
    if (kind === "archived") state.target.archivedAt = new Date();
    if (kind === "variant") state.target.variantOfArticleId = "other-target";
    expect(await requestBrainArticleVariant(actor, params)).toEqual({ status: "unavailable" });
    expect(db.workflowJob.create).not.toHaveBeenCalled();
    expect(lineage.captureArtifactInputProof).not.toHaveBeenCalled();
  });

  it("excludes copied sources whose private context or unknown lineage is not independently readable", async () => {
    state.sources.push(source("copied-finance"), source("legacy-copy"));
    state.manifest.rootsJson.push(...state.sources.slice(-2).map((row) => ({ kind: "BrainSource", id: row.id, fingerprint: fingerprint("BrainSource", row) })));
    await requestBrainArticleVariant(actor, params);
    expect(state.job.payload.sources.map((row: any) => row.id)).toEqual(["public-1", "public-2"]);
  });

  it("withholds incomplete dependency recipes or recipes with no permitted current sources", async () => {
    state.dependenciesComplete = false;
    expect(await requestBrainArticleVariant(actor, params)).toEqual({ status: "unavailable" });
    state.dependenciesComplete = true; state.readableSources.clear();
    expect(await requestBrainArticleVariant(actor, params)).toEqual({ status: "unavailable" });
    expect(db.workflowJob.create).not.toHaveBeenCalled();
  });

  it("deduplicates pending recipes and retries failed workers without copying candidate bodies", async () => {
    await requestBrainArticleVariant(actor, params);
    const key = state.job.dedupeKey;
    expect(await requestBrainArticleVariant(actor, params)).toEqual({ status: "pending", jobId: "job-1" });
    expect(db.workflowJob.create).toHaveBeenCalledTimes(1);
    state.job.status = "FAILED"; state.job.payload.phase = "GENERATING"; state.job.payload.generationToken = "old-token";
    await requestBrainArticleVariant(actor, params);
    expect(state.job).toMatchObject({ dedupeKey: key, status: "PENDING", payload: { phase: "REQUESTED" }, lockedBy: null });
    expect(state.job.payload).not.toHaveProperty("generationToken");
  });

  it("captures all inputs before the model and atomically publishes an immutable private owner variant", async () => {
    await queuedJob();
    state.upstream = { kind: "ArtifactInputSnapshot", id: "upstream-snapshot", fingerprint: "a".repeat(64) };
    // The full context changed after request; the previous recipe cannot be expanded silently.
    expect(await generateBrainArticleVariant({ ...lease, generate: vi.fn() })).toEqual({ phase: "STALE" });
    state.job = null;
    await queuedJob();
    const generate = vi.fn(async (sources) => {
      expect(lineage.captureArtifactInputProof).toHaveBeenCalled();
      expect(sources.map((row: any) => row.id)).toEqual(["public-1", "public-2"]);
      expect(JSON.stringify(sources)).not.toContain("SECRET");
      expect(JSON.stringify(sources)).not.toContain("internal");
      expect(sources[0]).not.toHaveProperty("articleId");
      return { title: "Permitted knowledge", bodyMd: "Supported public facts." };
    });
    expect(await generateBrainArticleVariant({ ...lease, generate })).toEqual({ phase: "APPLIED", articleId: "variant-1" });
    expect(state.variant).toMatchObject({ title: "Permitted knowledge", bodyMd: "Supported public facts.", isPrivate: true,
      ownerMemberId: "member-1", variantOfArticleId: "canonical", variantGenerationJobId: "job-1", sourceIds: ["public-1", "public-2"] });
    expect(state.variant.slug).toMatch(/^member-variant-/);
    expect(lineage.recordArtifactInputLineage).toHaveBeenCalledWith(expect.objectContaining({ tx: db, actor,
      origin: "DERIVED", inputs: [], inheritedRoots: expect.arrayContaining([state.upstream,
        expect.objectContaining({ kind: "BrainSource", id: "public-2" })]) }));
    expect(state.job.payload.phase).toBe("APPLIED");
    expect(state.job.payload).not.toHaveProperty("bodyMd");
    expect(state.target.bodyMd).toBe("SECRET CANONICAL BODY");
    expect(db.brainArticle.update).not.toHaveBeenCalled();
  });

  it.each(["source", "target", "archive-restore", "membership", "member-replacement", "proof"])
    ("rejects model output when %s changes before acceptance", async (change) => {
      await queuedJob();
      const generate = vi.fn(async () => {
        if (change === "source") state.sources[0].content = "Changed uncited second source";
        if (change === "target") state.target.updatedAt = "2026-10-02";
        if (change === "archive-restore") state.histories["public-1"] = [{ id: "archive-1", archivedAt: "old", restoredAt: "new", purgedAt: null }];
        if (change === "membership") state.membershipActive = false;
        if (change === "member-replacement") state.member.id = "reinvited-member";
        if (change === "proof") lineage.isArtifactInputProofReadable.mockResolvedValue(false);
        return { title: "Candidate", bodyMd: "Never accepted." };
      });
      expect(await generateBrainArticleVariant({ ...lease, generate })).toEqual({ phase: "STALE" });
      expect(generate).toHaveBeenCalledOnce();
      expect(db.brainArticle.create).not.toHaveBeenCalled();
      expect(lineage.recordArtifactInputLineage).not.toHaveBeenCalled();
      expect(JSON.stringify(state.job.payload)).not.toContain("Never accepted");
    });

  it("uses a new inputset and dedupe identity after source restore even if source text is unchanged", async () => {
    await requestBrainArticleVariant(actor, params);
    const originalKey = state.job.dedupeKey;
    const originalHash = state.job.payload.inputSetHash;
    state.histories["public-1"] = [{ id: "archive-1", archivedAt: "old", restoredAt: "new", purgedAt: null }];
    await requestBrainArticleVariant(actor, params);
    expect(state.job.dedupeKey).not.toBe(originalKey);
    expect(state.job.payload.inputSetHash).not.toBe(originalHash);
  });

  it.each(["attempt", "owner", "status", "token"])("supersedes stale worker %s without output writes", async (change) => {
    await queuedJob();
    if (change === "attempt") state.job.attempts = 2;
    if (change === "owner") state.job.lockedBy = "worker-2";
    if (change === "status") state.job.status = "COMPLETED";
    const generate = vi.fn(async () => {
      if (change === "token") state.job.payload = { ...state.job.payload, generationToken: "replacement-token" };
      return { title: "Candidate", bodyMd: "Candidate facts." };
    });
    expect(await generateBrainArticleVariant({ ...lease, generate })).toEqual({ phase: "SUPERSEDED" });
    expect(generate).toHaveBeenCalledTimes(change === "token" ? 1 : 0);
    expect(db.brainArticle.create).not.toHaveBeenCalled();
  });

  it("checks membership before invoking a delayed model job", async () => {
    await queuedJob(); state.membershipActive = false;
    const generate = vi.fn();
    expect(await generateBrainArticleVariant({ ...lease, generate })).toEqual({ phase: "STALE" });
    expect(generate).not.toHaveBeenCalled();
  });

  it.each([{ expectedAttempt: 0 }, { expectedOwner: "" }])("requires a real worker lease before claiming generation", async (invalid) => {
    const generate = vi.fn();
    await expect(generateBrainArticleVariant({ ...lease, ...invalid, generate })).rejects.toMatchObject({ code: "INVALID_INPUT" });
    expect(db.workflowJob.findFirst).not.toHaveBeenCalled();
    expect(generate).not.toHaveBeenCalled();
  });

  it("rejects invalid model output instead of creating a guessed title or body", async () => {
    await queuedJob();
    await expect(generateBrainArticleVariant({ ...lease, generate: async () => ({ title: "", bodyMd: "" }) }))
      .rejects.toMatchObject({ code: "INVALID_CANDIDATE" });
    expect(db.brainArticle.create).not.toHaveBeenCalled();
  });

  it("reads/reuses only the exact current owned variant and never recertifies archived or unproven variants", async () => {
    await queuedJob();
    await generateBrainArticleVariant({ ...lease, generate: async () => ({ title: "Visible variant", bodyMd: "Public-only facts." }) });
    expect(await requestBrainArticleVariant(actor, params)).toEqual({ status: "available", articleId: "variant-1" });
    expect(await getReadableBrainArticleVariant(actor, params)).toMatchObject({ id: "variant-1", bodyMd: "Public-only facts." });
    expect(await generateBrainArticleVariant({ ...lease, generate: vi.fn() })).toEqual({ phase: "APPLIED", articleId: "variant-1" });
    expect(db.brainArticle.create).toHaveBeenCalledOnce();
    state.variant.archivedAt = new Date();
    expect(await getReadableBrainArticleVariant(actor, params)).toBeNull();
    expect(await requestBrainArticleVariant(actor, params)).toEqual({ status: "unavailable" });
    state.variant.archivedAt = null; state.variantReadable = false;
    expect(await requestBrainArticleVariant(actor, params)).toEqual({ status: "unavailable" });
    expect(db.brainArticle.create).toHaveBeenCalledOnce();
  });

  it("does not return an older variant after source restoration or target changes", async () => {
    await queuedJob();
    await generateBrainArticleVariant({ ...lease, generate: async () => ({ title: "Variant", bodyMd: "Facts." }) });
    state.histories["public-2"] = [{ id: "archive-2", archivedAt: "old", restoredAt: "new", purgedAt: null }];
    expect(await getReadableBrainArticleVariant(actor, params)).toBeNull();
    state.histories = {}; state.target.updatedAt = "later";
    expect(await getReadableBrainArticleVariant(actor, params)).toBeNull();
  });

  it("accepts unchanged recipes when JSON storage reorders map and source object keys", async () => {
    await queuedJob();
    state.job.payload.sourceState = Object.fromEntries(Object.entries(state.job.payload.sourceState).reverse());
    state.job.payload.sources = state.job.payload.sources.map(({ id, fingerprint }: { id: string; fingerprint: string }) => ({ fingerprint, id }));
    expect(await generateBrainArticleVariant({ ...lease, generate: async () => ({ title: "Variant", bodyMd: "Facts." }) }))
      .toEqual({ phase: "APPLIED", articleId: "variant-1" });
    state.variant.variantSourceStateJson = Object.fromEntries(Object.entries(state.variant.variantSourceStateJson).reverse());
    expect(await getReadableBrainArticleVariant(actor, params)).toMatchObject({ id: "variant-1" });
  });

  it("includes snapshot source ancestors in restore state without showing their content to the model", async () => {
    state.upstream = { kind: "ArtifactInputSnapshot", id: "copied-context", fingerprint: "b".repeat(64) };
    const ancestor = source("public-ancestor");
    state.sources.push(ancestor);
    state.readableSources.add(ancestor.id);
    lineage.inspectStoredArtifactInputDependencies.mockImplementation(async (_db, _workspaceId, roots) => ({ complete: true,
      roots: roots.some((root: any) => root.id === "copied-context")
        ? [...roots, { kind: "BrainSource", id: ancestor.id, fingerprint: fingerprint("BrainSource", ancestor) }] : roots,
    }));
    await queuedJob();
    expect(state.job.payload.sourceState).toHaveProperty("public-ancestor");
    const generate = vi.fn(async (sources) => {
      expect(sources.map((row: any) => row.id)).toEqual(["public-1", "public-2"]);
      state.histories[ancestor.id] = [{ id: "ancestor-archive", archivedAt: "old", restoredAt: "new", purgedAt: null }];
      return { title: "Candidate", bodyMd: "Unsupported stale snapshot." };
    });
    expect(await generateBrainArticleVariant({ ...lease, generate })).toEqual({ phase: "STALE" });
    expect(db.brainArticle.create).not.toHaveBeenCalled();
  });

  it("does not grant another member or admin access to an existing owner-only variant", async () => {
    await queuedJob();
    await generateBrainArticleVariant({ ...lease, generate: async () => ({ title: "Member one variant", bodyMd: "Owner-only facts." }) });
    const admin: AppActor = { kind: "user", user: { id: "admin-2", email: "two@example.test", displayName: "Two", globalRole: "USER" } };
    state.member = { ...state.member, id: "member-2", userId: "admin-2", role: "ADMIN", user: admin.user };
    expect(await getReadableBrainArticleVariant(admin, params)).toBeNull();
    expect(state.variant.ownerMemberId).toBe("member-1");
    expect(state.variant.bodyMd).toBe("Owner-only facts.");
  });

  it("withholds a variant immediately when any permitted source loses its current permission", async () => {
    await queuedJob();
    await generateBrainArticleVariant({ ...lease, generate: async () => ({ title: "Variant", bodyMd: "Source-dependent facts." }) });
    state.readableSources.delete("public-2");
    expect(await getReadableBrainArticleVariant(actor, params)).toBeNull();
    expect(db.brainArticle.create).toHaveBeenCalledOnce();
    expect(db.brainArticle.update).not.toHaveBeenCalled();
  });
});
