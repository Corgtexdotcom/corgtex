import { createHash } from "node:crypto";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { AppActor } from "@corgtex/shared";
import { AppError } from "./errors";
import { generateBrainArticleVariant, getReadableBrainArticleVariant, requestBrainArticleVariant } from "./brain-article-variants";
import { SOURCE_PERMISSION_POLICY_VERSION } from "./source-permission-epochs";

const { db, state, lineage, requireMembership } = vi.hoisted(() => {
  const state = {
    target: null as any, variant: null as any, manifest: null as any, job: null as any,
    sources: [] as any[], readableSources: new Set<string>(), histories: {} as Record<string, any[]>,
    member: null as any, membershipActive: true, dependenciesComplete: true, variantReadable: true,
    canonicalReadable: false, upstream: null as any,
    versionParents: {} as Record<string, string>, nativeSources: {} as Record<string, any[]>, readableTypedSources: new Set<string>(), originalManifests: {} as Record<string, any>,
  };
  const db = {
    $transaction: vi.fn(), $queryRaw: vi.fn(), $executeRaw: vi.fn(),
    brainArticle: { findFirst: vi.fn(), findMany: vi.fn(), create: vi.fn(), update: vi.fn() },
    brainArticleVersion: { findMany: vi.fn(), findFirst: vi.fn() },
    document: { findMany: vi.fn() }, meeting: { findMany: vi.fn() }, communicationMessage: { findMany: vi.fn() },
    conversationPromptInput: { findMany: vi.fn(), findFirst: vi.fn() }, conversationIngressInput: { findMany: vi.fn() }, agentRequestInput: { findMany: vi.fn() },
    role: { findMany: vi.fn(), findFirst: vi.fn() }, circle: { findMany: vi.fn() }, action: { findMany: vi.fn() }, tension: { findMany: vi.fn() }, goal: { findMany: vi.fn() },
    brainSource: { findMany: vi.fn(), findFirst: vi.fn() }, artifactInputLineage: { findFirst: vi.fn() },
    artifactInputSnapshot: { findFirst: vi.fn() }, nativeTranscriptInput: { findFirst: vi.fn() },
    workflowJob: { findUnique: vi.fn(), findFirst: vi.fn(), create: vi.fn(), update: vi.fn() },
    member: { findFirst: vi.fn() }, workspaceArchiveRecord: { findMany: vi.fn() }, auditLog: { create: vi.fn() },
  };
  const lineage = {
    assertArtifactInputWriteFence: vi.fn(), assertArtifactInputClosureLocallyAdmissible: vi.fn(),
    captureArtifactInputProof: vi.fn(), currentArtifactInputRoots: vi.fn(), inspectStoredArtifactInputDependencies: vi.fn(),
    isArtifactInputProofReadable: vi.fn(), lineageContentFingerprint: vi.fn(), readableArtifactIds: vi.fn(),
    readableBrainSourceIds: vi.fn(), recordArtifactInputLineage: vi.fn(),
  };
  return { db, state, lineage, requireMembership: vi.fn() };
});

vi.mock("@corgtex/shared", () => ({ prisma: db }));
vi.mock("./auth", () => ({ requireWorkspaceMembership: requireMembership }));
vi.mock("./source-lineage", () => lineage);
vi.mock("./artifact-commit-preflight", () => ({
  lockArtifactReadAuthorityRows: vi.fn(async () => undefined),
  prepareArtifactCommitPreflight: vi.fn(async () => ({})),
  withArtifactCommitPreflight: vi.fn(async (_actor, _workspaceId, _tx, _roots, _token, work, options) => {
    await options?.beforeSourceEpochs?.(); return work();
  }),
}));
vi.mock("./workspace-support-access", () => ({ lockWorkspaceMembership: vi.fn() }));
vi.mock("./brain-source-links", () => ({ lockBrainSourceLink: vi.fn(), lockActiveArticleSources: vi.fn() }));
vi.mock("./events", () => ({ appendEvents: vi.fn() }));
vi.mock("./permalinks", () => ({ ensureWorkspacePermalink: vi.fn(), workspaceEntityCanonicalPath: vi.fn(() => "/safe-variant") }));

const actor: AppActor = { kind: "user", user: { id: "user-1", email: "one@example.test", displayName: "One", globalRole: "USER" } };
const params = { workspaceId: "ws-1", articleId: "canonical" };
const lease = { workspaceId: "ws-1", jobId: "job-1", expectedAttempt: 1, expectedOwner: "worker-1" };

function fingerprint(kind: string, row: any) {
  return createHash("sha256").update(JSON.stringify([kind, row.id, row.title, row.content, row.bodyMd, row.textContent, row.transcript, row.text, row.prompt, row.purposeMd, row.domainMd, row.accountabilities, row.artifacts, row.updatedAt])).digest("hex");
}

function source(id: string, title = `Source ${id}`) {
  return { id, workspaceId: "ws-1", title, content: `Permitted facts from ${id}`, sourceType: "DOCUMENT", tier: 1,
    ingestionGuidanceMd: "Summarize supported facts.", archivedAt: null, metadata: { internal: "not a prompt input" } };
}

beforeEach(() => {
  vi.clearAllMocks();
  lineage.assertArtifactInputWriteFence.mockReset().mockResolvedValue(undefined);
  lineage.assertArtifactInputClosureLocallyAdmissible.mockReset().mockResolvedValue(undefined);
  state.target = { id: "canonical", workspaceId: "ws-1", title: "SECRET CANONICAL TITLE", bodyMd: "SECRET CANONICAL BODY",
    slug: "secret-canonical-slug", frontmatterJson: { secret: "SECRET ALIAS" }, type: "STRATEGY", isPrivate: false,
    ownerMemberId: null, variantOfArticleId: null, archivedAt: null, updatedAt: "2026-10-01" };
  state.sources = [source("public-2"), source("finance"), source("public-1")];
  state.readableSources = new Set(["public-1", "public-2"]);
  state.manifest = { id: "manifest-1", origin: "DERIVED", inputsJson: [], contentHash: fingerprint("BrainArticle", state.target), rootsJson:
    state.sources.map((row) => ({ kind: "BrainSource", id: row.id, fingerprint: fingerprint("BrainSource", row) })),
    epochProofVersion: 1, permissionEpochsJson: { version: 1, policyVersion: SOURCE_PERMISSION_POLICY_VERSION,
      entries: [{ kind: "BrainArticle", id: state.target.id, epoch: "0" },
        ...state.sources.map(row => ({ kind: "BrainSource", id: row.id, epoch: "0" })),
        { kind: "Workspace", id: "ws-1", epoch: "0" }].sort((left, right) =>
          JSON.stringify([left.kind, left.id]) < JSON.stringify([right.kind, right.id]) ? -1 : 1) } };
  state.member = { id: "member-1", workspaceId: "ws-1", userId: "user-1", role: "CONTRIBUTOR", isActive: true,
    user: actor.kind === "user" ? actor.user : null };
  state.variant = null; state.job = null; state.histories = {}; state.upstream = null;
  state.versionParents = {}; state.nativeSources = {}; state.readableTypedSources = new Set(); state.originalManifests = {};
  state.membershipActive = true; state.dependenciesComplete = true; state.variantReadable = true; state.canonicalReadable = false;
  db.$transaction.mockImplementation(async (callback) => callback(db));
  db.$queryRaw.mockResolvedValue([]); db.$executeRaw.mockResolvedValue(1);
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
  db.brainSource.findFirst.mockImplementation(async ({ where }) => state.sources.find(row => row.workspaceId === where.workspaceId
    && row.id === where.id) ?? null);
  db.conversationPromptInput.findFirst.mockImplementation(async ({ where }) => (state.nativeSources.ConversationPromptInput ?? [])
    .find(row => row.workspaceId === where.workspaceId && row.id === where.id) ?? null);
  db.role.findFirst.mockImplementation(async ({ where }) => (state.nativeSources.Role ?? [])
    .find(row => row.workspaceId === where.circle?.workspaceId && row.id === where.id) ?? null);
  db.brainArticleVersion.findFirst.mockImplementation(async ({ where }) => state.versionParents[where.id]
    ? { id: where.id, articleId: state.versionParents[where.id] } : null);
  db.artifactInputSnapshot.findFirst.mockImplementation(async ({ where }) => state.upstream?.id === where.id
    ? { sourceKind: "BrainSource", sourceId: "public-1" } : null);
  for (const [kind, delegate] of [["Document", db.document], ["MeetingTranscript", db.meeting], ["CommunicationMessage", db.communicationMessage],
    ["ConversationPromptInput", db.conversationPromptInput], ["ConversationIngressInput", db.conversationIngressInput], ["AgentRequestInput", db.agentRequestInput],
    ["BrainArticle", db.brainArticle], ["Role", db.role], ["Circle", db.circle], ["Action", db.action], ["Tension", db.tension], ["Goal", db.goal]] as const) {
    delegate.findMany.mockImplementation(async ({ where }) => (state.nativeSources[kind] ?? []).filter((row) =>
      row.workspaceId === (where.workspaceId ?? where.circle?.workspaceId) && where.id.in.includes(row.id) && !row.archivedAt && !row.variantOfArticleId));
  }
  db.brainArticleVersion.findMany.mockImplementation(async ({ where }) => where.id.in.flatMap((id: string) => state.versionParents[id] ? [{ id, articleId: state.versionParents[id] }] : []));
  db.artifactInputLineage.findFirst.mockImplementation(async ({ where }) => where.artifactId === state.target?.id && where.artifactType === "BrainArticle"
    ? state.manifest : state.originalManifests[`${where.artifactType}:${where.artifactId}`] ?? null);
  db.workspaceArchiveRecord.findMany.mockImplementation(async ({ where }) => state.histories[where.entityId] ?? []);
  lineage.lineageContentFingerprint.mockImplementation(fingerprint);
  lineage.currentArtifactInputRoots.mockImplementation(async () => state.manifest?.rootsJson ?? null);
  lineage.inspectStoredArtifactInputDependencies.mockImplementation(async (_db, _workspaceId, roots) => ({ complete: state.dependenciesComplete,
    roots: state.upstream && roots.some((root: any) => root.kind === "BrainSource") ? [...roots, { ...state.upstream }] : roots }));
  lineage.readableBrainSourceIds.mockImplementation(async (_actor, _workspaceId, rows) => new Set(rows
    .filter((row: any) => state.readableSources.has(row.id)).map((row: any) => row.id)));
  lineage.readableArtifactIds.mockImplementation(async (currentActor, _workspaceId, _kind, rows) => new Set(rows
    .filter((row: any) => row.variantOfArticleId ? state.variantReadable && !row.archivedAt && row.isPrivate
      && currentActor.kind === "user" && currentActor.user.id === state.member.userId && row.ownerMemberId === state.member.id
      : state.canonicalReadable).map((row: any) => row.id)));
  lineage.captureArtifactInputProof.mockImplementation(async (_actor, _workspaceId, inputs) => {
    if (inputs.some((input: any) => input.kind === "BrainSource" ? !state.readableSources.has(input.id) : !state.readableTypedSources.has(`${input.kind}:${input.id}`))) {
      throw new AppError(409, "UNKNOWN_LINEAGE", "Current source is not independently permitted.");
    }
    const roots = inputs.map((input: any) => ({ kind: input.kind, id: input.id, fingerprint: fingerprint(input.kind, input.snapshot) }));
    return state.upstream ? [...roots, { ...state.upstream }] : roots;
  });
  lineage.isArtifactInputProofReadable.mockImplementation(async (_actor, _workspaceId, roots) => state.membershipActive
    && roots.every((root: any) => root.kind === "BrainSource" ? state.readableSources.has(root.id)
      && state.sources.some((row) => !row.archivedAt && row.id === root.id && root.fingerprint === fingerprint(root.kind, row))
      : root.kind === "ArtifactInputSnapshot" ? state.upstream && root.fingerprint === state.upstream.fingerprint
        : state.readableTypedSources.has(`${root.kind}:${root.id}`) && (state.nativeSources[root.kind] ?? []).some((row) =>
          !row.archivedAt && row.id === root.id && root.fingerprint === fingerprint(root.kind, row))));
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

function addNative(kind: string, row: any, original = false) {
  const full = { workspaceId: "ws-1", archivedAt: null, ...(kind === "Role" ? { circleId: "circle" } : {}), ...row };
  (state.nativeSources[kind] ??= []).push(full);
  state.readableTypedSources.add(`${kind}:${full.id}`);
  state.manifest.rootsJson.push({ kind, id: full.id, fingerprint: fingerprint(kind, full) });
  if (original) state.originalManifests[`${kind}:${full.id}`] = { id: `original-${full.id}`, origin: "HUMAN_ORIGINAL",
    rootsJson: [], contentHash: fingerprint(kind, full) };
  return full;
}

async function queuedJob() {
  expect(await requestBrainArticleVariant(actor, params)).toEqual({ status: "pending", jobId: "job-1" });
  state.job = { ...state.job, status: "RUNNING", attempts: 1, lockedBy: "worker-1" };
}

describe("permitted-source article variants", () => {
  it.each(["ExternalProviderFetchInput", "ExternalMcpResponseInput", "CommunicationMessageNativeInput"])(
    "prepares a newly copied %s parent from the current candidate before opening its variant transaction", async kind => {
      const current = state.sources.find(row => row.id === "public-1");
      current.content = "Fresh independently permitted copied facts";
      const currentFingerprint = fingerprint("BrainSource", current);
      const native = { id: `fresh-${kind}`, workspaceId: "ws-1", title: "Current native input" };
      const nativeRoot = { kind, id: native.id, fingerprint: fingerprint(kind, native),
        permissionEpochs: state.manifest.permissionEpochsJson };
      state.nativeSources[kind] = [native];
      state.readableTypedSources.add(`${kind}:${native.id}`);
      lineage.currentArtifactInputRoots.mockImplementation(async (_db, _workspaceId, artifact) =>
        artifact.kind === "BrainSource" && artifact.id === current.id ? [nativeRoot] : state.manifest.rootsJson);
      lineage.inspectStoredArtifactInputDependencies.mockImplementation(async (_db, _workspaceId, roots) => ({ complete: true,
        roots: roots.some((root: any) => root.kind === "BrainSource" && root.id === current.id
          && root.fingerprint === currentFingerprint) ? [...roots, nativeRoot] : roots }));
      lineage.captureArtifactInputProof.mockImplementation(async (_actor, _workspaceId, inputs) => {
        if (inputs.some((input: any) => input.kind === "BrainSource" && !state.readableSources.has(input.id)))
          throw new AppError(409, "UNKNOWN_LINEAGE", "Current source is not independently permitted.");
        return [
          ...inputs.map((input: any) => ({ kind: input.kind, id: input.id, fingerprint: fingerprint(input.kind, input.snapshot) })),
          ...(inputs.some((input: any) => input.kind === "BrainSource" && input.id === current.id) ? [nativeRoot] : []),
        ];
      });
      const result = await requestBrainArticleVariant(actor, params);
      const { prepareArtifactCommitPreflight } = await import("./artifact-commit-preflight");
      expect(prepareArtifactCommitPreflight).toHaveBeenCalledWith(actor, params.workspaceId,
        expect.arrayContaining([expect.objectContaining({ kind, id: native.id,
          permissionEpochs: nativeRoot.permissionEpochs })]));
      expect(lineage.captureArtifactInputProof).toHaveBeenCalled();
      expect(result).toEqual({ status: "pending", jobId: "job-1" });
      expect(db.workflowJob.create).toHaveBeenCalledOnce();
    });

  it("does not certify an original that declares unproved inputs", async () => {
    state.manifest.origin = "HUMAN_ORIGINAL";
    state.manifest.rootsJson = [];
    state.manifest.inputsJson = [{ kind: "BrainSource", id: "unproved" }];
    expect(await requestBrainArticleVariant(actor, params)).toEqual({ status: "unavailable" });
    expect(db.workflowJob.create).not.toHaveBeenCalled();
  });

  it("does not expose original status when its current proof is unreadable", async () => {
    state.manifest.origin = "HUMAN_ORIGINAL";
    state.manifest.rootsJson = [];
    expect(await requestBrainArticleVariant(actor, params)).toEqual({ status: "unavailable" });
    expect(db.workflowJob.create).not.toHaveBeenCalled();
  });

  it("rejects a new linked Document before the source proof when the planned lock union changes", async () => {
    db.$transaction.mockImplementationOnce(async callback => {
      state.sources[0].metadata = { documentId: "newly-linked-document" };
      return callback(db);
    });
    expect(await requestBrainArticleVariant(actor, params)).toEqual({ status: "unavailable" });
    expect(lineage.captureArtifactInputProof).not.toHaveBeenCalled();
    expect(db.workflowJob.create).not.toHaveBeenCalled();
  });

  it.each(["ExternalProviderFetchInput", "ExternalMcpResponseInput"])(
    "reuses an enclosing source's saved vector for a %s leaf", async (kind) => {
      const parent = state.sources.find((row) => row.id === "public-1");
      state.sources = [parent];
      const parentRoot = { kind: "BrainSource", id: parent.id, fingerprint: fingerprint("BrainSource", parent),
        permissionEpochs: state.manifest.permissionEpochsJson };
      state.manifest.rootsJson = [parentRoot];
      const native = { kind, id: "native-input", fingerprint: "a".repeat(64) };
      lineage.inspectStoredArtifactInputDependencies.mockImplementation(async (_db, _ws, roots) => ({
        complete: true, roots: roots.some((root: { kind: string }) => root.kind === "BrainSource")
          ? [...roots, native] : roots,
      }));

      expect(await requestBrainArticleVariant(actor, params)).toEqual({ status: "pending", jobId: "job-1" });
      const { prepareArtifactCommitPreflight } = await import("./artifact-commit-preflight");
      expect(prepareArtifactCommitPreflight).toHaveBeenCalledWith(actor, "ws-1", [parentRoot]);
      expect(lineage.assertArtifactInputClosureLocallyAdmissible).toHaveBeenCalledWith(actor, "ws-1", [parentRoot]);
    },
  );

  it("tries another exact saved parent when the first native enclosing source is locally revoked", async () => {
    const stale = state.sources.find(row => row.id === "public-1");
    const remaining = state.sources.find(row => row.id === "public-2");
    state.sources = [stale, remaining];
    state.readableSources = new Set([remaining.id]);
    const staleRoot = { kind: "BrainSource", id: stale.id, fingerprint: fingerprint("BrainSource", stale),
      permissionEpochs: state.manifest.permissionEpochsJson };
    const remainingRoot = { kind: "BrainSource", id: remaining.id, fingerprint: fingerprint("BrainSource", remaining),
      permissionEpochs: state.manifest.permissionEpochsJson };
    state.manifest.rootsJson = [staleRoot, remainingRoot];
    const native = { kind: "ExternalMcpResponseInput", id: "shared-native-leaf", fingerprint: "a".repeat(64) };
    lineage.inspectStoredArtifactInputDependencies.mockImplementation(async (_db, _workspaceId, roots) => ({ complete: true,
      roots: roots.some((root: any) => root.kind === "BrainSource") ? [...roots, native] : roots }));
    lineage.assertArtifactInputClosureLocallyAdmissible.mockImplementation(async (_actor, _workspaceId, roots) => {
      if (roots.some((root: any) => root.id === stale.id)) throw new AppError(409, "SOURCE_CHANGED", "Old vector revoked.");
    });

    expect(await requestBrainArticleVariant(actor, params)).toEqual({ status: "pending", jobId: "job-1" });
    const { prepareArtifactCommitPreflight } = await import("./artifact-commit-preflight");
    expect(prepareArtifactCommitPreflight).toHaveBeenCalledWith(actor, "ws-1", [remainingRoot]);
    expect(lineage.assertArtifactInputClosureLocallyAdmissible).toHaveBeenCalledWith(actor, "ws-1", [staleRoot]);
    expect(lineage.assertArtifactInputClosureLocallyAdmissible).toHaveBeenCalledWith(actor, "ws-1", [remainingRoot]);
    expect(lineage.isArtifactInputProofReadable).not.toHaveBeenCalledWith(actor, "ws-1", [staleRoot]);
  });

  it("rejects a locally revoked native candidate before its provider read", async () => {
    const native = { id: "native-message", workspaceId: "ws-1", content: "synthetic native input" };
    state.manifest.rootsJson = [{ kind: "CommunicationMessageNativeInput", id: native.id,
      fingerprint: fingerprint("CommunicationMessageNativeInput", native),
      permissionEpochs: state.manifest.permissionEpochsJson }];
    lineage.assertArtifactInputClosureLocallyAdmissible.mockRejectedValueOnce(
      new AppError(409, "SOURCE_CHANGED", "Native input grant changed."));

    expect(await requestBrainArticleVariant(actor, params)).toEqual({ status: "unavailable" });
    expect(lineage.assertArtifactInputClosureLocallyAdmissible).toHaveBeenCalledOnce();
    expect(lineage.isArtifactInputProofReadable).not.toHaveBeenCalled();
    expect(db.workflowJob.create).not.toHaveBeenCalled();
  });

  it("enqueues only permitted sources discovered through historical receipts and no canonical content", async () => {
    const result = await requestBrainArticleVariant(actor, params);
    expect(result).toEqual({ status: "pending", jobId: "job-1" });
    expect(state.job.payload.sources.map((row: any) => row.id)).toEqual(["public-1", "public-2"]);
    expect(state.job.payload).toMatchObject({ memberId: "member-1", userId: "user-1", articleId: "canonical", phase: "REQUESTED" });
    expect(JSON.stringify(state.job.payload)).not.toContain("SECRET");
    expect(JSON.stringify(state.job.payload)).not.toContain("finance");
    for (const id of ["public-1", "public-2"]) expect(lineage.captureArtifactInputProof).toHaveBeenCalledWith(actor, "ws-1", [
      expect.objectContaining({ kind: "BrainSource", id, snapshot: expect.objectContaining({ content: `Permitted facts from ${id}` }) }),
    ], db);
    expect(state.job.payload.version).toBe(2);
    expect(state.job.payload.sources.every((input: any) => input.kind === "BrainSource")).toBe(true);
  });

  it("rebuilds from all supported independently permitted source families without canonical or private context", async () => {
    state.sources = [];
    state.manifest.rootsJson = [];
    addNative("Document", { id: "doc", title: "Document facts", textContent: "Public document facts", storageKey: "DO NOT PROMPT STORAGE", metadata: { secret: "DO NOT PROMPT METADATA" } });
    addNative("MeetingTranscript", { id: "meeting", title: "Meeting", transcript: "Actual transcript", summaryMd: "DO NOT PROMPT OLD SUMMARY", source: "UPLOAD" });
    addNative("CommunicationMessage", { id: "message", text: "Public channel message", permalink: "DO NOT PROMPT LINK", raw: { secret: "DO NOT PROMPT RAW" } });
    addNative("ConversationPromptInput", { id: "prompt", content: "Owner's actual request", sessionId: "DO NOT PROMPT SESSION", userId: "user-1" });
    addNative("ConversationIngressInput", { id: "ingress", content: "Owner's authenticated request", userId: "user-1", actorKind: "user" });
    addNative("AgentRequestInput", { id: "request", prompt: "Owner's agent request", userId: "user-1", meetingId: "DO NOT PROMPT RELATED ID" });
    for (const [kind, row] of [["BrainArticle", { id: "original-article", title: "Original article", bodyMd: "Original human facts" }],
      ["Role", { id: "role", name: "Steward", purposeMd: "Human role purpose", accountabilities: ["Review public plans"] }],
      ["Circle", { id: "circle", name: "Operations", purposeMd: "Human circle purpose", domainMd: "Human circle domain" }],
      ["Action", { id: "action", title: "Original action", bodyMd: "Human action facts" }],
      ["Tension", { id: "tension", title: "Original tension", bodyMd: "Human tension facts" }],
      ["Goal", { id: "goal", title: "Original goal", descriptionMd: "Human goal facts" }]] as const) addNative(kind, row, true);
    const privateArticle = addNative("BrainArticle", { id: "private-article", title: "PRIVATE ARTICLE TITLE", bodyMd: "PRIVATE ARTICLE BODY", isPrivate: true, ownerMemberId: "other-member" }, true);
    state.readableTypedSources.delete(`BrainArticle:${privateArticle.id}`);
    // A historical self snapshot never admits the old canonical body as a source.
    state.manifest.rootsJson.push({ kind: "BrainArticle", id: "canonical", fingerprint: "b".repeat(64) });
    await queuedJob();
    const generate = vi.fn(async (sources) => {
      expect(sources).toHaveLength(12);
      expect(sources.map((entry: any) => entry.kind)).toEqual(expect.arrayContaining(["Document", "MeetingTranscript", "CommunicationMessage", "ConversationPromptInput", "ConversationIngressInput", "AgentRequestInput", "BrainArticle", "Role", "Circle", "Action", "Tension", "Goal"]));
      expect(JSON.stringify(sources)).not.toContain("PRIVATE");
      expect(JSON.stringify(sources)).not.toContain("SECRET");
      expect(JSON.stringify(sources)).not.toContain("DO NOT PROMPT");
      return { title: "Permitted facts", bodyMd: "Independent native facts." };
    });
    expect(await generateBrainArticleVariant({ ...lease, generate })).toEqual({ phase: "APPLIED", articleId: "variant-1" });
    expect(state.job.payload.version).toBe(2);
    expect(state.variant.sourceIds).toEqual([]);
    expect(lineage.recordArtifactInputLineage).toHaveBeenCalledWith(expect.objectContaining({ inheritedRoots: expect.arrayContaining([
      expect.objectContaining({ kind: "Document", id: "doc" }), expect.objectContaining({ kind: "ConversationPromptInput", id: "prompt" }),
      expect.objectContaining({ kind: "Goal", id: "goal" }),
    ]) }));
    expect(state.job.payload.sourceState[JSON.stringify(["Meeting", "meeting"])]).toBeTypeOf("string");
    expect(state.target.bodyMd).toBe("SECRET CANONICAL BODY");
  });

  it.each(["snapshot", "version"])("excludes a readable wrapper of the canonical's old %s body", async (kind) => {
    const wrapper = source("self-wrapper", "OLD CANONICAL WRAPPER");
    wrapper.content = "SECRET CANONICAL BODY";
    state.sources.push(wrapper); state.readableSources.add(wrapper.id);
    state.manifest.rootsJson.push({ kind: "BrainSource", id: wrapper.id, fingerprint: fingerprint("BrainSource", wrapper) });
    if (kind === "version") state.versionParents["canonical-version"] = "canonical";
    lineage.inspectStoredArtifactInputDependencies.mockImplementation(async (_db, _ws, roots) => ({ complete: true,
      roots: roots.some((root: any) => root.id === wrapper.id) ? [...roots, { kind: kind === "version" ? "BrainArticleVersion" : "BrainArticle", id: kind === "version" ? "canonical-version" : "canonical", fingerprint: "a".repeat(64) }] : roots,
    }));
    await queuedJob();
    const generate = vi.fn(async (sources) => {
      expect(sources.map((entry: any) => entry.id)).toEqual(["public-1", "public-2"]);
      expect(JSON.stringify(sources)).not.toContain("CANONICAL");
      return { title: "Independent facts", bodyMd: "Independent sources only." };
    });
    expect(await generateBrainArticleVariant({ ...lease, generate })).toEqual({ phase: "APPLIED", articleId: "variant-1" });
    if (kind === "version") expect(db.brainArticleVersion.findMany).toHaveBeenCalledWith({ where: { article: { workspaceId: "ws-1" }, id: { in: ["canonical-version"] } }, select: { id: true, articleId: true } });
  });

  it("tracks other original version parents' restore epochs without reading their body", async () => {
    state.upstream = { kind: "BrainArticleVersion", id: "other-version", fingerprint: "b".repeat(64) };
    state.versionParents["other-version"] = "other-original-article";
    state.readableTypedSources.add("BrainArticleVersion:other-version");
    state.nativeSources.BrainArticleVersion = [{ id: "other-version", title: undefined }];
    lineage.isArtifactInputProofReadable.mockResolvedValue(true);
    await queuedJob();
    expect(state.job.payload.sourceState[JSON.stringify(["BrainArticle", "other-original-article"])]).toBeTypeOf("string");
    expect(db.$executeRaw.mock.calls.some((args) => args.includes("workspace_archive:BrainArticle:other-original-article"))).toBe(true);
    expect(db.$queryRaw.mock.calls.some(([sql]) => Array.isArray(sql?.values) && sql.values.includes("other-original-article")
      && sql.strings.join("").includes('"BrainArticle"'))).toBe(true);
    expect(await generateBrainArticleVariant({ ...lease, generate: async () => {
      state.histories["other-original-article"] = [{ id: "restore", archivedAt: "old", restoredAt: "new", purgedAt: null }];
      return { title: "Candidate", bodyMd: "Never accepted." };
    } })).toEqual({ phase: "STALE" });
    expect(db.brainArticleVersion.findMany.mock.calls.every(([args]) => JSON.stringify(args.select) === JSON.stringify({ id: true, articleId: true }))).toBe(true);
  });

  it("takes the shared write fence after native/canonical locks and rejects changed original authorship", async () => {
    addNative("Role", { id: "original-role", name: "Role", purposeMd: "Human role facts" }, true);
    lineage.assertArtifactInputWriteFence.mockImplementationOnce(async () => {
      state.originalManifests["Role:original-role"].origin = "DERIVED";
    });
    expect(await requestBrainArticleVariant(actor, params)).toEqual({ status: "unavailable" });
    expect(db.$queryRaw.mock.invocationCallOrder.at(-1)).toBeLessThan(lineage.assertArtifactInputWriteFence.mock.invocationCallOrder[0]);
    expect(db.workflowJob.create).not.toHaveBeenCalled();
  });

  it("excludes unknown/derived structured originals and empty native text without citation guesses", async () => {
    addNative("Role", { id: "legacy-role", name: "LEGACY ROLE", purposeMd: "Unknown history" });
    addNative("BrainArticle", { id: "derived-article", title: "DERIVED TITLE", bodyMd: "Previously generated facts" }, true);
    state.originalManifests["BrainArticle:derived-article"].origin = "DERIVED";
    addNative("Document", { id: "empty-doc", title: "Empty document", textContent: null });
    await requestBrainArticleVariant(actor, params);
    expect(state.job.payload.sources.map((entry: any) => entry.id)).toEqual(["public-1", "public-2"]);
  });

  it.each(["REQUESTED", "GENERATING", "APPLIED"])("marks queued v1 %s recipes stale before any model call", async (phase) => {
    await queuedJob();
    state.job.payload = { ...state.job.payload, version: 1, phase,
      sources: state.job.payload.sources.map(({ id, fingerprint }: { id: string; fingerprint: string }) => ({ id, fingerprint })) };
    const generate = vi.fn();
    expect(await generateBrainArticleVariant({ ...lease, generate })).toEqual({ phase: "STALE" });
    expect(state.job.payload.phase).toBe("STALE");
    expect(generate).not.toHaveBeenCalled();
    expect(db.brainArticle.create).not.toHaveBeenCalled();
    expect(db.brainArticle.update).not.toHaveBeenCalled();
  });

  it.each(["body", "permission", "restore"])("rejects an uncited native Document %s change before acceptance", async (change) => {
    const doc = addNative("Document", { id: "native-doc", title: "Doc", textContent: "Independent facts" });
    await queuedJob();
    const generate = vi.fn(async () => {
      if (change === "body") doc.textContent = "Changed uncited facts";
      if (change === "permission") state.readableTypedSources.delete("Document:native-doc");
      if (change === "restore") state.histories[doc.id] = [{ id: "restore", archivedAt: "old", restoredAt: "new", purgedAt: null }];
      return { title: "Candidate", bodyMd: "Never accepted." };
    });
    expect(await generateBrainArticleVariant({ ...lease, generate })).toEqual({ phase: "STALE" });
    expect(db.brainArticle.create).not.toHaveBeenCalled();
  });

  it("uses a fresh recipe for independently remaining native inputs while preserving the old canonical and variant", async () => {
    const doc = addNative("Document", { id: "native-doc", title: "Doc", textContent: "Independent facts" });
    await queuedJob();
    await generateBrainArticleVariant({ ...lease, generate: async () => ({ title: "Initial variant", bodyMd: "Source plus document facts." }) });
    const oldVariant = { ...state.variant };
    doc.archivedAt = new Date();
    expect(await getReadableBrainArticleVariant(actor, params)).toBeNull();
    await queuedJob();
    const generate = vi.fn(async (sources) => {
      expect(sources.map((entry: any) => entry.kind)).toEqual(["BrainSource", "BrainSource"]);
      expect(sources.map((entry: any) => entry.id)).toEqual(["public-1", "public-2"]);
      return { title: "Remaining facts", bodyMd: "Only permitted remaining sources." };
    });
    expect(await generateBrainArticleVariant({ ...lease, generate })).toEqual({ phase: "APPLIED", articleId: "variant-1" });
    expect(state.variant.variantInputSetHash).not.toBe(oldVariant.variantInputSetHash);
    expect(oldVariant.bodyMd).toBe("Source plus document facts.");
    expect(state.target.bodyMd).toBe("SECRET CANONICAL BODY");
    expect(db.brainArticle.update).not.toHaveBeenCalled();
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

  it.each(["missing-version", "null-proof", "empty-vector", "malformed-vector", "obsolete-policy"])("withholds a legacy derived recipe with %s before source capture", async kind => {
    const oldTarget = structuredClone(state.target);
    if (kind === "missing-version") state.manifest.epochProofVersion = null;
    if (kind === "null-proof") state.manifest.permissionEpochsJson = null;
    if (kind === "empty-vector") state.manifest.permissionEpochsJson.entries = [];
    if (kind === "malformed-vector") state.manifest.permissionEpochsJson.entries[0].epoch = "new-current-counter";
    if (kind === "obsolete-policy") state.manifest.permissionEpochsJson.policyVersion = "pun68-permissions-legacy";
    expect(state.manifest.rootsJson.length).toBeGreaterThan(0);
    expect(await requestBrainArticleVariant(actor, params)).toEqual({ status: "unavailable" });
    expect(lineage.inspectStoredArtifactInputDependencies).not.toHaveBeenCalled();
    expect(lineage.captureArtifactInputProof).not.toHaveBeenCalled();
    expect(db.workflowJob.create).not.toHaveBeenCalled();
    expect(db.brainArticle.update).not.toHaveBeenCalled();
    expect(state.target).toEqual(oldTarget);
  });

  it("does not rebuild a certified independent human original with citation-only links", async () => {
    state.target.sourceIds = ["finance"];
    state.manifest = { ...state.manifest, origin: "HUMAN_ORIGINAL", rootsJson: [] };
    state.canonicalReadable = true;
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

  it("fails before generation when newly captured current ancestry exceeds the bounded complete scan", async () => {
    state.upstream = { kind: "ArtifactInputSnapshot", id: "new-current-ancestry", fingerprint: "c".repeat(64) };
    lineage.inspectStoredArtifactInputDependencies.mockImplementation(async (_db, _ws, roots) => ({ complete: true,
      roots: roots.some((root: any) => root.id === "new-current-ancestry")
        ? [...roots, ...Array.from({ length: 5001 }, (_, index) => ({ kind: "Document", id: `ancestor-${index}`, fingerprint: "a".repeat(64) }))] : roots,
    }));
    await expect(requestBrainArticleVariant(actor, params)).rejects.toMatchObject({ code: "INPUT_SCAN_LIMIT" });
    expect(db.workflowJob.create).not.toHaveBeenCalled();
    expect(db.brainArticle.create).not.toHaveBeenCalled();
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
    state.job.payload.sources = state.job.payload.sources.map(({ kind, id, fingerprint }: { kind: string; id: string; fingerprint: string }) => ({ fingerprint, id, kind }));
    expect(await generateBrainArticleVariant({ ...lease, generate: async () => ({ title: "Variant", bodyMd: "Facts." }) }))
      .toEqual({ phase: "APPLIED", articleId: "variant-1" });
    state.variant.variantSourceStateJson = Object.fromEntries(Object.entries(state.variant.variantSourceStateJson).reverse());
    expect(await getReadableBrainArticleVariant(actor, params)).toMatchObject({ id: "variant-1" });
  });

  it("withholds an unplanned snapshot ancestor discovered only during current capture", async () => {
    state.upstream = { kind: "ArtifactInputSnapshot", id: "copied-context", fingerprint: "b".repeat(64) };
    const ancestor = source("public-ancestor");
    state.sources.push(ancestor);
    state.readableSources.add(ancestor.id);
    lineage.inspectStoredArtifactInputDependencies.mockImplementation(async (_db, _workspaceId, roots) => ({ complete: true,
      roots: (roots.length === 1 && roots[0].kind === "BrainSource") || roots.some((root: any) => root.id === "copied-context")
        ? [...roots, { ...state.upstream }, { kind: "BrainSource", id: ancestor.id, fingerprint: fingerprint("BrainSource", ancestor) }] : roots,
    }));
    expect(await requestBrainArticleVariant(actor, params)).toEqual({ status: "unavailable" });
    expect(db.workflowJob.create).not.toHaveBeenCalled();
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
