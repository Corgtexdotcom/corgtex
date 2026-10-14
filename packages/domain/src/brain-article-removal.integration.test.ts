import { randomUUID } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { prisma, type AppActor } from "@corgtex/shared";
import { truncateAllTables } from "../../shared/src/db-test-utils";
import { brainSourceContentFingerprint } from "./brain-derivation";
import { confirmBrainArticleRemoval, previewBrainArticleRemoval } from "./brain-article-removal";
import { generateBrainSourceRemovalCandidate, requestBrainSourceRemoval, resolveBrainSourceRemoval, retryBrainSourceRemoval } from "./brain-source-removal";
import { archiveWorkspaceArtifact } from "./archive";
import { rebuildDocumentBrainSource } from "./document-source-rebuild";
import { generateBrainArticleVariant, getReadableBrainArticleVariant, requestBrainArticleVariant } from "./brain-article-variants";
import { advanceHumanArtifactInputLineage, recordArtifactInputLineage } from "./source-lineage";

async function fixture(sourceRemovalEnabled = true) {
  const workspace = await prisma.workspace.create({ data: { name: "Article removal fixture", slug: `article-removal-${randomUUID()}` } });
  if (sourceRemovalEnabled) await prisma.workspaceFeatureFlag.create({ data: {
    workspaceId: workspace.id, flag: "BRAIN_SOURCE_REMOVAL", enabled: true,
  } });
  const admin = await prisma.user.create({ data: { email: `article-admin-${randomUUID()}@example.test`, passwordHash: "fixture" } });
  const owner = await prisma.user.create({ data: { email: `article-owner-${randomUUID()}@example.test`, passwordHash: "fixture" } });
  const outsider = await prisma.user.create({ data: { email: `article-outsider-${randomUUID()}@example.test`, passwordHash: "fixture" } });
  const ownerMember = await prisma.member.create({ data: { workspaceId: workspace.id, userId: owner.id, role: "CONTRIBUTOR" } });
  await prisma.member.create({ data: { workspaceId: workspace.id, userId: admin.id, role: "ADMIN" } });
  const actor = (user: typeof admin): AppActor => ({ kind: "user", user: { id: user.id, email: user.email, displayName: "Fixture" } });
  return { workspace, admin: actor(admin), owner: actor(owner), outsider: actor(outsider), ownerMember };
}

async function sourceWithDocument(actor: AppActor, workspaceId: string, title: string) {
  const document = await prisma.document.create({ data: {
    workspaceId, title: `${title} document`, source: "upload", storageKey: `synthetic/${randomUUID()}`,
    textContent: `${title} source text`,
  } });
  const source = await prisma.brainSource.create({ data: {
    workspaceId, sourceType: "DOC", tier: 1, title, content: `${title} facts`, metadata: { documentId: document.id },
  } });
  await prisma.$transaction(async tx => {
    await recordArtifactInputLineage({ tx, actor, workspaceId, artifact: { kind: "Document", id: document.id },
      content: document, origin: "HUMAN_ORIGINAL", inputs: [] });
    await recordArtifactInputLineage({ tx, actor, workspaceId, artifact: { kind: "BrainSource", id: source.id },
      content: source, origin: "DERIVED", inputs: [{ kind: "Document", id: document.id }] });
  });
  return { document, source };
}

async function authoredSource(actor: AppActor, data: Parameters<typeof prisma.brainSource.create>[0]["data"]) {
  return prisma.$transaction(async tx => {
    const source = await tx.brainSource.create({ data });
    const copiedDocumentId = documentId(source.metadata);
    await recordArtifactInputLineage({ tx, actor, workspaceId: source.workspaceId,
      artifact: { kind: "BrainSource", id: source.id }, content: source,
      origin: copiedDocumentId ? "DERIVED" : "HUMAN_ORIGINAL",
      inputs: copiedDocumentId ? [{ kind: "Document", id: copiedDocumentId }] : [] });
    return source;
  });
}

function confirmParams(workspaceId: string, slug: string, expectedToken: string, mode: "keep_sources" | "remove_sources") {
  return { workspaceId, slug, expectedToken, mode, confirmation: "archive_article" };
}

async function attestArticle(actor: AppActor, article: Awaited<ReturnType<typeof prisma.brainArticle.create>>,
  includeDocuments = false) {
  const sources = await prisma.brainSource.findMany({ where: { workspaceId: article.workspaceId, id: { in: article.sourceIds } } });
  const documentIds = includeDocuments
    ? sources.map((source) => documentId(source.metadata)).filter((id): id is string => !!id) : [];
  await prisma.$transaction(async (tx) => recordArtifactInputLineage({
    tx, actor, workspaceId: article.workspaceId,
    artifact: { kind: "BrainArticle", id: article.id }, content: article,
    origin: "DERIVED", inputs: [
      ...article.sourceIds.map((id) => ({ kind: "BrainSource" as const, id })),
      ...documentIds.map((id) => ({ kind: "Document" as const, id })),
    ],
  }));
}

function documentId(metadata: unknown) {
  return metadata && typeof metadata === "object" && !Array.isArray(metadata)
    && "documentId" in metadata && typeof metadata.documentId === "string" ? metadata.documentId : null;
}

const runtimeOptIn = "BRAIN_SOURCE_REMOVAL_RUNTIME_ENABLED";
const previousRuntimeOptIn = process.env[runtimeOptIn];

describe("confirmed Brain article removal", () => {
  beforeEach(async () => {
    process.env[runtimeOptIn] = "true";
    await truncateAllTables();
  });
  afterEach(() => {
    if (previousRuntimeOptIn === undefined) delete process.env[runtimeOptIn];
    else process.env[runtimeOptIn] = previousRuntimeOptIn;
  });

  it("withholds a legacy target whose inputs cannot be proven", async () => {
    const { workspace, admin } = await fixture();
    const { source } = await sourceWithDocument(admin, workspace.id, "Unproven legacy");
    const article = await prisma.brainArticle.create({ data: {
      workspaceId: workspace.id, slug: "legacy-unproven-target", title: "Legacy target", type: "PROJECT",
      bodyMd: "Could contain unknown inputs", sourceIds: [source.id],
    } });
    await expect(previewBrainArticleRemoval(admin, { workspaceId: workspace.id, slug: article.slug }))
      .rejects.toMatchObject({ status: 404, code: "NOT_FOUND" });
    expect((await prisma.brainArticle.findUniqueOrThrow({ where: { id: article.id } })).archivedAt).toBeNull();
    expect((await prisma.brainSource.findUniqueOrThrow({ where: { id: source.id } })).archivedAt).toBeNull();
  });

  it("keeps linked sources when a stored true flag has no runtime opt-in", async () => {
    const { workspace, admin, outsider } = await fixture();
    const { document, source } = await sourceWithDocument(admin, workspace.id, "Runtime paused");
    const article = await prisma.brainArticle.create({ data: {
      workspaceId: workspace.id, slug: "runtime-paused", title: "Runtime paused", type: "PROJECT",
      bodyMd: "Original", sourceIds: [source.id],
    } });
    await attestArticle(admin, article);
    delete process.env[runtimeOptIn];
    await expect(previewBrainArticleRemoval(outsider, { workspaceId: workspace.id, slug: article.slug }))
      .rejects.toMatchObject({ status: 403, code: "NOT_A_MEMBER" });
    const preview = await previewBrainArticleRemoval(admin, { workspaceId: workspace.id, slug: article.slug });
    expect(preview.canRemoveSources).toBe(false);
    expect(preview.blockReasons).toContain("feature_disabled");
    await expect(confirmBrainArticleRemoval(admin, confirmParams(workspace.id, article.slug, preview.token, "remove_sources")))
      .rejects.toMatchObject({ status: 409, code: "BRAIN_SOURCE_REMOVAL_DISABLED" });
    expect((await prisma.brainSource.findUniqueOrThrow({ where: { id: source.id } })).archivedAt).toBeNull();
    expect((await prisma.document.findUniqueOrThrow({ where: { id: document.id } })).archivedAt).toBeNull();
    expect(await confirmBrainArticleRemoval(admin, confirmParams(workspace.id, article.slug, preview.token, "keep_sources")))
      .toMatchObject({ id: article.id, pendingJobId: null });
    expect((await prisma.brainSource.findUniqueOrThrow({ where: { id: source.id } })).archivedAt).toBeNull();
  });

  it("hides linked source removal while disabled but permits article-only archive", async () => {
    const { workspace, admin } = await fixture(false);
    const { document, source } = await sourceWithDocument(admin, workspace.id, "Paused");
    const article = await prisma.brainArticle.create({ data: {
      workspaceId: workspace.id, slug: "paused", title: "Paused", type: "PROJECT", bodyMd: "Original", sourceIds: [source.id],
    } });
    await attestArticle(admin, article);
    const preview = await previewBrainArticleRemoval(admin, { workspaceId: workspace.id, slug: article.slug });
    expect(preview.canRemoveSources).toBe(false);
    expect(preview.blockReasons).toContain("feature_disabled");
    await expect(confirmBrainArticleRemoval(admin, confirmParams(workspace.id, article.slug, preview.token, "remove_sources")))
      .rejects.toMatchObject({ status: 409, code: "BRAIN_SOURCE_REMOVAL_DISABLED" });
    await expect(archiveWorkspaceArtifact(admin, { workspaceId: workspace.id, entityType: "Document", entityId: document.id }))
      .rejects.toMatchObject({ status: 409, code: "SOURCE_ARTICLE_IMPACT_REVIEW_REQUIRED" });
    expect(await prisma.workflowJob.count({ where: { workspaceId: workspace.id, type: "agent.brain-source-regenerate" } })).toBe(0);
    expect((await prisma.brainArticle.findUniqueOrThrow({ where: { id: article.id } })).archivedAt).toBeNull();
    expect(await confirmBrainArticleRemoval(admin, confirmParams(workspace.id, article.slug, preview.token, "keep_sources")))
      .toMatchObject({ id: article.id, pendingJobId: null });
    expect((await prisma.brainSource.findUniqueOrThrow({ where: { id: source.id } })).archivedAt).toBeNull();
    expect((await prisma.document.findUniqueOrThrow({ where: { id: document.id } })).archivedAt).toBeNull();
  });

  it("redacts restricted source and document previews for a brain-only credential", async () => {
    const { workspace, admin } = await fixture();
    const { document, source } = await sourceWithDocument(admin, workspace.id, "Finance confidential");
    const article = await prisma.brainArticle.create({ data: {
      workspaceId: workspace.id, slug: "restricted-preview", title: "Article", type: "PROJECT", bodyMd: "Body", sourceIds: [source.id],
    } });
    await attestArticle(admin, article, true);
    await prisma.brainSource.update({ where: { id: source.id }, data: { accessDomain: "FINANCE" } });
    const credential: AppActor = { kind: "agent", authProvider: "credential", label: "Brain reader",
      workspaceIds: [workspace.id], scopes: ["brain:read"] };
    await expect(previewBrainArticleRemoval(credential, { workspaceId: workspace.id, slug: article.slug }))
      .rejects.toMatchObject({ status: 404, code: "NOT_FOUND" });
    await prisma.brainSource.update({ where: { id: source.id }, data: { accessDomain: "WORKSPACE" } });
    await prisma.document.update({ where: { id: document.id }, data: { accessDomain: "FINANCE" } });
    await expect(previewBrainArticleRemoval(credential, { workspaceId: workspace.id, slug: article.slug }))
      .rejects.toMatchObject({ status: 404, code: "NOT_FOUND" });
    expect(await prisma.workspaceArchiveRecord.count()).toBe(0);
  });

  it("keeps sources for an owner, leaves preview/cancel read-only, and rejects stale or repeated confirmation", async () => {
    const { workspace, admin, owner, outsider, ownerMember } = await fixture();
    const { document, source } = await sourceWithDocument(admin, workspace.id, "Keep");
    const article = await prisma.brainArticle.create({ data: {
      workspaceId: workspace.id, slug: "keep-article", title: "Keep article", type: "PROJECT", bodyMd: "Original",
      ownerMemberId: ownerMember.id, sourceIds: [source.id],
    } });
    await attestArticle(admin, article);
    await expect(previewBrainArticleRemoval(outsider, { workspaceId: workspace.id, slug: article.slug }))
      .rejects.toMatchObject({ status: 403, code: "NOT_A_MEMBER" });
    const preview = await previewBrainArticleRemoval(owner, { workspaceId: workspace.id, slug: article.slug });
    expect(preview.hasSources).toBe(true);
    expect(preview.canRemoveSources).toBe(false);
    expect(preview.sources).toEqual([]);
    expect(preview.documents).toEqual([]);
    for (const key of ["sourceIds", "lockIds", "documentIds", "lockDocumentIds"]) {
      expect(preview).not.toHaveProperty(key);
    }
    expect((await prisma.brainArticle.findUniqueOrThrow({ where: { id: article.id } })).archivedAt).toBeNull();
    await expect(confirmBrainArticleRemoval(owner, { ...confirmParams(workspace.id, article.slug, preview.token, "keep_sources"),
      confirmation: "" })).rejects.toMatchObject({ status: 400, code: "INVALID_CONFIRMATION" });
    await expect(confirmBrainArticleRemoval(owner, confirmParams(workspace.id, article.slug, preview.token, "remove_sources")))
      .rejects.toMatchObject({ status: 409, code: "SOURCE_ARTICLE_IMPACT_REVIEW_REQUIRED" });
    const revised = await prisma.brainArticle.update({ where: { id: article.id }, data: { bodyMd: "Human revision" } });
    await prisma.$transaction(async (tx) => advanceHumanArtifactInputLineage({ tx, actor: owner,
      workspaceId: workspace.id, artifact: { kind: "BrainArticle", id: article.id }, before: article, after: revised,
    }));
    await expect(confirmBrainArticleRemoval(owner, confirmParams(workspace.id, article.slug, preview.token, "keep_sources")))
      .rejects.toMatchObject({ status: 409, code: "REMOVAL_PREVIEW_CHANGED" });
    const refreshed = await previewBrainArticleRemoval(owner, { workspaceId: workspace.id, slug: article.slug });
    expect(await confirmBrainArticleRemoval(owner, confirmParams(workspace.id, article.slug, refreshed.token, "keep_sources")))
      .toMatchObject({ id: article.id, pendingJobId: null });
    await expect(confirmBrainArticleRemoval(owner, confirmParams(workspace.id, article.slug, refreshed.token, "keep_sources")))
      .rejects.toMatchObject({ status: 409, code: "ALREADY_ARCHIVED" });
    expect((await prisma.brainSource.findUniqueOrThrow({ where: { id: source.id } })).archivedAt).toBeNull();
    expect((await prisma.document.findUniqueOrThrow({ where: { id: document.id } })).archivedAt).toBeNull();
    await expect(archiveWorkspaceArtifact(outsider, { workspaceId: workspace.id, entityType: "BrainArticle", entityId: article.id }))
      .rejects.toMatchObject({ status: 403 });
    expect(await prisma.workspaceArchiveRecord.count({ where: { workspaceId: workspace.id } })).toBe(1);
    expect(admin).toBeDefined();
  });

  it("restores source access through a fresh owner variant while preserving the denied canonical article", async () => {
    const { workspace, admin, owner, ownerMember } = await fixture();
    const { document, source } = await sourceWithDocument(admin, workspace.id, "Independent");
    const article = await prisma.brainArticle.create({ data: { workspaceId: workspace.id, slug: "restored-canonical", title: "Denied old title",
      type: "PROJECT", bodyMd: "DENIED old composite body", ownerMemberId: ownerMember.id, sourceIds: [source.id] } });
    await attestArticle(admin, article);
    const oldManifest = await prisma.artifactInputLineage.findFirstOrThrow({ where: { artifactType: "BrainArticle", artifactId: article.id } });
    await prisma.brainSource.update({ where: { id: source.id }, data: { accessDomain: "FINANCE" } });
    await expect(previewBrainArticleRemoval(owner, { workspaceId: workspace.id, slug: article.slug })).rejects.toMatchObject({ code: "NOT_FOUND" });
    await prisma.brainSource.update({ where: { id: source.id }, data: { accessDomain: "WORKSPACE" } });
    await rebuildDocumentBrainSource(admin, { workspaceId: workspace.id, sourceId: source.id });
    await expect(previewBrainArticleRemoval(owner, { workspaceId: workspace.id, slug: article.slug })).rejects.toMatchObject({ code: "NOT_FOUND" });
    const request = await requestBrainArticleVariant(owner, { workspaceId: workspace.id, articleId: article.id });
    if (request.status !== "pending") throw new Error("Expected a fresh permitted-source variant recipe");
    await prisma.workflowJob.update({ where: { id: request.jobId }, data: { status: "RUNNING", attempts: 1, lockedBy: "variant-fixture-worker" } });
    await expect(generateBrainArticleVariant({ workspaceId: workspace.id, jobId: request.jobId,
      expectedAttempt: 1, expectedOwner: "variant-fixture-worker", generate: async inputs => {
        expect(JSON.stringify(inputs)).not.toContain("DENIED old composite body");
        expect(JSON.stringify(inputs)).not.toContain("Denied old title");
        expect(inputs.some(input => input.kind === "Document" && input.id === document.id)).toBe(true);
        return { title: "Fresh permitted variant", bodyMd: "Independent current document facts" };
      } })).resolves.toMatchObject({ phase: "APPLIED" });
    const variant = await getReadableBrainArticleVariant(owner, { workspaceId: workspace.id, articleId: article.id });
    if (!variant) throw new Error("Expected the independently generated private owner variant");
    expect(variant).toMatchObject({ isPrivate: true, ownerMemberId: ownerMember.id, variantOfArticleId: article.id });
    const preview = await previewBrainArticleRemoval(owner, { workspaceId: workspace.id, slug: variant.slug });
    expect(preview).toMatchObject({ article: { id: variant.id }, canRemoveSources: false, hasSources: true });
    expect(await confirmBrainArticleRemoval(owner, confirmParams(workspace.id, variant.slug, preview.token, "keep_sources")))
      .toMatchObject({ id: variant.id, pendingJobId: null });
    await expect(confirmBrainArticleRemoval(owner, confirmParams(workspace.id, variant.slug, preview.token, "keep_sources")))
      .rejects.toMatchObject({ code: "ALREADY_ARCHIVED" });
    expect(await prisma.brainArticle.findUniqueOrThrow({ where: { id: article.id } })).toEqual(article);
    expect(await prisma.artifactInputLineage.findUniqueOrThrow({ where: { id: oldManifest.id } })).toEqual(oldManifest);
    expect((await prisma.brainSource.findUniqueOrThrow({ where: { id: source.id } })).archivedAt).toBeNull();
    expect(await prisma.document.findUniqueOrThrow({ where: { id: document.id } })).toEqual(document);
  });

  it("removes an article, every representation of its source document, and the document recoverably", async () => {
    const { workspace, admin } = await fixture();
    const { document, source } = await sourceWithDocument(admin, workspace.id, "Remove");
    const extra = await authoredSource(admin, {
      workspaceId: workspace.id, sourceType: "DOC", tier: 1, title: "Another representation", content: "Same document",
      metadata: { documentId: document.id },
    });
    const article = await prisma.brainArticle.create({ data: {
      workspaceId: workspace.id, slug: "remove-all", title: "Remove all", type: "PROJECT", bodyMd: "Body",
      sourceIds: [source.id],
    } });
    await attestArticle(admin, article);
    const preview = await previewBrainArticleRemoval(admin, { workspaceId: workspace.id, slug: article.slug });
    expect(preview.canRemoveSources).toBe(true);
    expect(preview.sources.map((item) => item.id).sort()).toEqual([source.id, extra.id].sort());
    expect(preview.documents).toMatchObject([{ id: document.id }]);
    expect(await confirmBrainArticleRemoval(admin, confirmParams(workspace.id, article.slug, preview.token, "remove_sources")))
      .toMatchObject({ id: article.id, pendingJobId: null });
    expect((await prisma.brainArticle.findUniqueOrThrow({ where: { id: article.id } })).archivedAt).toBeInstanceOf(Date);
    for (const id of [source.id, extra.id]) {
      expect((await prisma.brainSource.findUniqueOrThrow({ where: { id } })).archivedAt).toBeInstanceOf(Date);
    }
    expect((await prisma.document.findUniqueOrThrow({ where: { id: document.id } })).archivedAt).toBeInstanceOf(Date);
    expect(await prisma.workspaceArchiveRecord.count({ where: { workspaceId: workspace.id } })).toBe(4);
  });

  it("reviews a shared derived article before removing its document and preserves its prior body", async () => {
    const { workspace, admin } = await fixture();
    const { document, source: removed } = await sourceWithDocument(admin, workspace.id, "Shared");
    const remaining = await authoredSource(admin, {
      workspaceId: workspace.id, sourceType: "DOC", tier: 1, title: "Remaining", content: "Remaining verified facts",
    });
    const target = await prisma.brainArticle.create({ data: {
      workspaceId: workspace.id, slug: "target", title: "Target", type: "PROJECT", bodyMd: "Target text", sourceIds: [removed.id],
    } });
    const shared = await prisma.brainArticle.create({ data: {
      workspaceId: workspace.id, slug: "shared", title: "Shared", type: "PROJECT", bodyMd: "Human edited old claims",
      sourceIds: [removed.id, remaining.id], humanEditedAt: new Date("2026-09-01T12:00:00.000Z"),
      derivationJson: { version: 1, origin: "brain-absorb", agentRunId: "synthetic-run", sources: [
        { sourceId: removed.id, fingerprint: brainSourceContentFingerprint(removed) },
        { sourceId: remaining.id, fingerprint: brainSourceContentFingerprint(remaining) },
      ] },
    } });
    await attestArticle(admin, target);
    await attestArticle(admin, shared);
    const preview = await previewBrainArticleRemoval(admin, { workspaceId: workspace.id, slug: target.slug });
    expect(preview.sources[0].sharedArticles).toMatchObject([{ id: shared.id, action: "regenerate" }]);
    const requested = await confirmBrainArticleRemoval(admin, confirmParams(workspace.id, target.slug, preview.token, "remove_sources"));
    expect(requested.pendingJobId).toBeTruthy();
    expect((await prisma.brainArticle.findUniqueOrThrow({ where: { id: target.id } })).archivedAt).toBeInstanceOf(Date);
    expect((await prisma.brainSource.findUniqueOrThrow({ where: { id: removed.id } })).archivedAt).toBeNull();
    expect((await prisma.document.findUniqueOrThrow({ where: { id: document.id } })).archivedAt).toBeNull();
    await prisma.workflowJob.update({ where: { id: requested.pendingJobId! }, data: { status: "FAILED" } });
    const retried = await retryBrainSourceRemoval(admin, { workspaceId: workspace.id, jobId: requested.pendingJobId! });
    expect(retried.status).toBe("pending");
    if (retried.status !== "pending") throw new Error("Expected a retried source job.");
    expect(retried.jobId).not.toBe(requested.pendingJobId);
    await prisma.workflowJob.update({ where: { id: retried.jobId }, data: { status: "RUNNING", attempts: 1, lockedBy: "fixture-worker" } });
    let input: string[] = [];
    await expect(generateBrainSourceRemovalCandidate({ workspaceId: workspace.id, jobId: retried.jobId,
      expectedAttempt: 1, expectedOwner: "fixture-worker",
      generate: async (_article, sources) => { input = sources.map((item) => item.content); return "Verified replacement"; },
    })).resolves.toMatchObject({ phase: "READY" });
    expect(input).toEqual(["Remaining verified facts"]);
    await prisma.workflowJob.update({ where: { id: retried.jobId }, data: { status: "COMPLETED" } });
    const otherDocument = await prisma.document.create({ data: { workspaceId: workspace.id, title: "New source document",
      source: "upload", storageKey: `synthetic/${randomUUID()}`, textContent: "Different document" } });
    await prisma.brainSource.update({ where: { id: removed.id }, data: { metadata: { documentId: otherDocument.id } } });
    await expect(resolveBrainSourceRemoval(admin, { workspaceId: workspace.id, jobId: retried.jobId, decision: "accept" }))
      .rejects.toMatchObject({ status: 409, code: "SOURCE_CHANGED" });
    expect((await prisma.document.findUniqueOrThrow({ where: { id: document.id } })).archivedAt).toBeNull();
    expect((await prisma.brainSource.findUniqueOrThrow({ where: { id: removed.id } })).archivedAt).toBeNull();
    expect((await prisma.brainArticle.findUniqueOrThrow({ where: { id: shared.id } })).bodyMd).toBe("Human edited old claims");
    const rejectedJob = await prisma.workflowJob.findUniqueOrThrow({ where: { id: retried.jobId } });
    await prisma.brainSource.update({ where: { id: removed.id }, data: { metadata: { documentId: document.id } } });
    await expect(resolveBrainSourceRemoval(admin, { workspaceId: workspace.id, jobId: retried.jobId, decision: "accept" }))
      .rejects.toMatchObject({ code: "SOURCE_CHANGED" });
    await rebuildDocumentBrainSource(admin, { workspaceId: workspace.id, sourceId: removed.id });
    const fresh = await requestBrainSourceRemoval(admin, { workspaceId: workspace.id, sourceId: removed.id, archiveLinkedDocument: true });
    if (fresh.status !== "pending") throw new Error("Expected a fresh source recipe after restoration");
    expect(fresh.jobId).not.toBe(retried.jobId);
    await prisma.workflowJob.update({ where: { id: fresh.jobId }, data: { status: "RUNNING", attempts: 1, lockedBy: "fresh-fixture-worker" } });
    await expect(generateBrainSourceRemovalCandidate({ workspaceId: workspace.id, jobId: fresh.jobId,
      expectedAttempt: 1, expectedOwner: "fresh-fixture-worker", generate: async (_article, sources) => {
        expect(sources.map(source => source.content)).toEqual(["Remaining verified facts"]);
        return "Verified replacement";
      } })).resolves.toMatchObject({ phase: "READY" });
    await prisma.workflowJob.update({ where: { id: fresh.jobId }, data: { status: "COMPLETED" } });
    await resolveBrainSourceRemoval(admin, { workspaceId: workspace.id, jobId: fresh.jobId, decision: "accept" });
    const oldPayload = (await prisma.workflowJob.findUniqueOrThrow({ where: { id: retried.jobId } })).payload as Record<string, unknown>;
    expect(oldPayload).toEqual(rejectedJob.payload);
    expect((await prisma.brainArticle.findUniqueOrThrow({ where: { id: shared.id } })).bodyMd).toBe("Verified replacement");
    expect((await prisma.brainArticleVersion.findFirstOrThrow({ where: { articleId: shared.id } })).bodyMd).toBe("Human edited old claims");
    expect((await prisma.brainSource.findUniqueOrThrow({ where: { id: removed.id } })).archivedAt).toBeInstanceOf(Date);
    expect((await prisma.document.findUniqueOrThrow({ where: { id: document.id } })).archivedAt).toBeInstanceOf(Date);
  });

  it("blocks unknown shared links without archiving the target, source, or document", async () => {
    const { workspace, admin } = await fixture();
    const { document, source } = await sourceWithDocument(admin, workspace.id, "Legacy");
    const target = await prisma.brainArticle.create({ data: {
      workspaceId: workspace.id, slug: "legacy-target", title: "Target", type: "PROJECT", bodyMd: "Target", sourceIds: [source.id],
    } });
    await attestArticle(admin, target);
    await prisma.brainArticle.create({ data: {
      workspaceId: workspace.id, slug: "legacy-shared", title: "Legacy shared", type: "PROJECT", bodyMd: "Citation only", sourceIds: [source.id],
    } });
    const preview = await previewBrainArticleRemoval(admin, { workspaceId: workspace.id, slug: target.slug });
    expect(preview.canRemoveSources).toBe(false);
    expect(preview.blockReasons).toContain("unclassified");
    await expect(confirmBrainArticleRemoval(admin, confirmParams(workspace.id, target.slug, preview.token, "remove_sources")))
      .rejects.toMatchObject({ status: 409, code: "SOURCE_ARTICLE_IMPACT_REVIEW_REQUIRED" });
    expect((await prisma.brainArticle.findUniqueOrThrow({ where: { id: target.id } })).archivedAt).toBeNull();
    expect((await prisma.brainSource.findUniqueOrThrow({ where: { id: source.id } })).archivedAt).toBeNull();
    expect((await prisma.document.findUniqueOrThrow({ where: { id: document.id } })).archivedAt).toBeNull();
  });

  it("blocks mixed derived and legacy source links in the preview", async () => {
    const { workspace, admin } = await fixture();
    const { source } = await sourceWithDocument(admin, workspace.id, "Mixed");
    const citation = await authoredSource(admin, {
      workspaceId: workspace.id, sourceType: "DOC", tier: 1, content: "Citation only",
    });
    const target = await prisma.brainArticle.create({ data: {
      workspaceId: workspace.id, slug: "mixed-target", title: "Target", type: "PROJECT", bodyMd: "Target", sourceIds: [source.id],
    } });
    await attestArticle(admin, target);
    await prisma.brainArticle.create({ data: {
      workspaceId: workspace.id, slug: "mixed-shared", title: "Mixed shared", type: "PROJECT", bodyMd: "Mixed",
      sourceIds: [source.id, citation.id], derivationJson: {
        version: 1, origin: "brain-absorb", agentRunId: "synthetic-run",
        sources: [{ sourceId: source.id, fingerprint: brainSourceContentFingerprint(source) }],
      },
    } });
    const preview = await previewBrainArticleRemoval(admin, { workspaceId: workspace.id, slug: target.slug });
    expect(preview.canRemoveSources).toBe(false);
    expect(preview.sources[0].sharedArticles).toEqual([]);
    expect(preview.blockReasons).toContain("unclassified");
    await expect(confirmBrainArticleRemoval(admin, confirmParams(workspace.id, target.slug, preview.token, "remove_sources")))
      .rejects.toMatchObject({ status: 409, code: "SOURCE_ARTICLE_IMPACT_REVIEW_REQUIRED" });
    expect((await prisma.brainArticle.findUniqueOrThrow({ where: { id: target.id } })).archivedAt).toBeNull();
  });

  it("blocks a shared article whose remaining source is restricted, archived, or missing", async () => {
    const { workspace, admin } = await fixture();
    for (const condition of ["restricted", "archived", "missing"] as const) {
      const { source: removed } = await sourceWithDocument(admin, workspace.id, condition);
      const remaining = await authoredSource(admin, {
        workspaceId: workspace.id, sourceType: "DOC", tier: 1, content: `${condition} remaining facts`,
      });
      const target = await prisma.brainArticle.create({ data: {
        workspaceId: workspace.id, slug: `${condition}-target`, title: "Target", type: "PROJECT", bodyMd: "Target",
        sourceIds: [removed.id],
      } });
      await attestArticle(admin, target);
      const shared = await prisma.brainArticle.create({ data: {
        workspaceId: workspace.id, slug: `${condition}-shared`, title: "Shared", type: "PROJECT", bodyMd: "Shared",
        sourceIds: [removed.id, remaining.id], derivationJson: {
          version: 1, origin: "brain-absorb", agentRunId: "synthetic-run", sources: [
            { sourceId: removed.id, fingerprint: brainSourceContentFingerprint(removed) },
            { sourceId: remaining.id, fingerprint: brainSourceContentFingerprint(remaining) },
          ],
        },
      } });
      await attestArticle(admin, shared);
      if (condition === "restricted") {
        await prisma.brainSource.update({ where: { id: remaining.id }, data: { accessDomain: "FINANCE" } });
      } else if (condition === "archived") {
        await prisma.brainSource.update({ where: { id: remaining.id }, data: { archivedAt: new Date() } });
      } else {
        await prisma.brainSource.delete({ where: { id: remaining.id } });
      }
      const preview = await previewBrainArticleRemoval(admin, { workspaceId: workspace.id, slug: target.slug });
      expect(preview.canRemoveSources).toBe(false);
      expect(preview.blockReasons).toContain(condition === "restricted" ? "restricted" : "source_missing");
      await expect(confirmBrainArticleRemoval(admin, confirmParams(workspace.id, target.slug, preview.token, "remove_sources")))
        .rejects.toMatchObject({ status: 409, code: "SOURCE_ARTICLE_IMPACT_REVIEW_REQUIRED" });
      expect((await prisma.brainArticle.findUniqueOrThrow({ where: { id: target.id } })).archivedAt).toBeNull();
      expect((await prisma.brainSource.findUniqueOrThrow({ where: { id: removed.id } })).archivedAt).toBeNull();
    }
  });

  it("sequences overlapping shared sources so stale parallel candidates cannot be accepted", async () => {
    const { workspace, admin } = await fixture();
    const first = await sourceWithDocument(admin, workspace.id, "First");
    const second = await sourceWithDocument(admin, workspace.id, "Second");
    const target = await prisma.brainArticle.create({ data: {
      workspaceId: workspace.id, slug: "multi-target", title: "Multi target", type: "PROJECT", bodyMd: "Target",
      sourceIds: [first.source.id, second.source.id],
    } });
    const shared = await prisma.brainArticle.create({ data: {
      workspaceId: workspace.id, slug: "multi-shared", title: "Multi shared", type: "PROJECT", bodyMd: "Shared old",
      sourceIds: [first.source.id, second.source.id], derivationJson: {
        version: 1, origin: "brain-absorb", agentRunId: "synthetic-run", sources: [
          { sourceId: first.source.id, fingerprint: brainSourceContentFingerprint(first.source) },
          { sourceId: second.source.id, fingerprint: brainSourceContentFingerprint(second.source) },
        ],
      },
    } });
    await attestArticle(admin, target);
    await attestArticle(admin, shared);
    const preview = await previewBrainArticleRemoval(admin, { workspaceId: workspace.id, slug: target.slug });
    expect(preview.sources.flatMap((item) => item.sharedArticles).map((item) => item.action)).toEqual(["archive", "archive"]);
    const result = await confirmBrainArticleRemoval(admin, confirmParams(workspace.id, target.slug, preview.token, "remove_sources"));
    expect(result.pendingJobId).toBeTruthy();
    await prisma.workflowJob.update({ where: { id: result.pendingJobId! }, data: { status: "RUNNING", attempts: 1, lockedBy: "fixture-worker" } });
    await generateBrainSourceRemovalCandidate({ workspaceId: workspace.id, jobId: result.pendingJobId!,
      expectedAttempt: 1, expectedOwner: "fixture-worker", generate: async () => "Intermediate verified body",
    });
    await prisma.workflowJob.update({ where: { id: result.pendingJobId! }, data: { status: "COMPLETED" } });
    await resolveBrainSourceRemoval(admin, { workspaceId: workspace.id, jobId: result.pendingJobId!, decision: "reject" });
    for (const item of [first, second]) {
      expect((await prisma.brainSource.findUniqueOrThrow({ where: { id: item.source.id } })).archivedAt).toBeNull();
    }
    const retried = await retryBrainSourceRemoval(admin, { workspaceId: workspace.id, jobId: result.pendingJobId! });
    expect(retried.status).toBe("pending");
    if (retried.status !== "pending") throw new Error("Expected a retried source job.");
    await prisma.workflowJob.update({ where: { id: retried.jobId }, data: { status: "RUNNING", attempts: 1, lockedBy: "fixture-worker" } });
    await generateBrainSourceRemovalCandidate({ workspaceId: workspace.id, jobId: retried.jobId,
      expectedAttempt: 1, expectedOwner: "fixture-worker", generate: async () => "Reviewed intermediate body",
    });
    await prisma.workflowJob.update({ where: { id: retried.jobId }, data: { status: "COMPLETED" } });
    const accepted = await resolveBrainSourceRemoval(admin, { workspaceId: workspace.id, jobId: retried.jobId, decision: "accept" });
    expect(accepted.status).toBe("applied");
    expect(await resolveBrainSourceRemoval(admin, { workspaceId: workspace.id, jobId: retried.jobId, decision: "accept" }))
      .toEqual(accepted);
    expect((await prisma.brainArticle.findUniqueOrThrow({ where: { id: shared.id } })).archivedAt).toBeInstanceOf(Date);
    for (const item of [first, second]) {
      expect((await prisma.brainSource.findUniqueOrThrow({ where: { id: item.source.id } })).archivedAt).toBeInstanceOf(Date);
      expect((await prisma.document.findUniqueOrThrow({ where: { id: item.document.id } })).archivedAt).toBeInstanceOf(Date);
    }
  });

  it("continues to the next review when a failed first review no longer needs regeneration", async () => {
    const { workspace, admin } = await fixture();
    const first = await sourceWithDocument(admin, workspace.id, "First retry");
    const second = await sourceWithDocument(admin, workspace.id, "Second retry");
    const other = await authoredSource(admin, {
      workspaceId: workspace.id, sourceType: "DOC", tier: 1, content: "Remaining verified facts",
    });
    const target = await prisma.brainArticle.create({ data: {
      workspaceId: workspace.id, slug: "retry-target", title: "Retry target", type: "PROJECT", bodyMd: "Target",
      sourceIds: [first.source.id, second.source.id],
    } });
    await attestArticle(admin, target);
    const shared = [];
    for (const [index, source] of [first.source, second.source].entries()) {
      shared.push(await prisma.brainArticle.create({ data: {
        workspaceId: workspace.id, slug: `retry-shared-${index}`, title: "Shared", type: "PROJECT", bodyMd: "Shared",
        sourceIds: [source.id, other.id], derivationJson: {
          version: 1, origin: "brain-absorb", agentRunId: "synthetic-run", sources: [
            { sourceId: source.id, fingerprint: brainSourceContentFingerprint(source) },
            { sourceId: other.id, fingerprint: brainSourceContentFingerprint(other) },
          ],
        },
      } }));
      await attestArticle(admin, shared[shared.length - 1]);
    }
    const preview = await previewBrainArticleRemoval(admin, { workspaceId: workspace.id, slug: target.slug });
    const requested = await confirmBrainArticleRemoval(admin, confirmParams(workspace.id, target.slug, preview.token, "remove_sources"));
    expect(requested.pendingJobId).toBeTruthy();
    const firstSourceId = requested.pendingSourceId!;
    await prisma.workflowJob.update({ where: { id: requested.pendingJobId! }, data: { status: "FAILED" } });
    const firstShared = shared[[first.source.id, second.source.id].indexOf(firstSourceId)];
    await archiveWorkspaceArtifact(admin, { workspaceId: workspace.id, entityType: "BrainArticle", entityId: firstShared.id });
    const retried = await retryBrainSourceRemoval(admin, { workspaceId: workspace.id, jobId: requested.pendingJobId! });
    expect(retried).toMatchObject({ status: "archived" });
    if (retried.status !== "archived") throw new Error("Expected the first source to archive.");
    expect(retried.pendingSourceId).toBe([first.source.id, second.source.id].find((id) => id !== firstSourceId));
    expect((await prisma.brainSource.findUniqueOrThrow({ where: { id: firstSourceId } })).archivedAt).toBeInstanceOf(Date);
    const pending = await prisma.workflowJob.findFirst({ where: {
      workspaceId: workspace.id, type: "agent.brain-source-regenerate",
      payload: { path: ["sourceId"], equals: retried.pendingSourceId! },
    } });
    expect(pending?.status).toBe("PENDING");
  });
});
