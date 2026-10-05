import { randomUUID } from "node:crypto";
import { beforeEach, describe, expect, it } from "vitest";
import { prisma, type AppActor } from "@corgtex/shared";
import { truncateAllTables } from "../../shared/src/db-test-utils";
import { brainSourceContentFingerprint } from "./brain-derivation";
import { confirmBrainArticleRemoval, previewBrainArticleRemoval } from "./brain-article-removal";
import { generateBrainSourceRemovalCandidate, resolveBrainSourceRemoval, retryBrainSourceRemoval } from "./brain-source-removal";
import { archiveWorkspaceArtifact } from "./archive";

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

async function sourceWithDocument(workspaceId: string, title: string) {
  const document = await prisma.document.create({ data: {
    workspaceId, title: `${title} document`, source: "upload", storageKey: `synthetic/${randomUUID()}`,
    textContent: `${title} source text`,
  } });
  const source = await prisma.brainSource.create({ data: {
    workspaceId, sourceType: "DOC", tier: 1, title, content: `${title} facts`, metadata: { documentId: document.id },
  } });
  return { document, source };
}

function confirmParams(workspaceId: string, slug: string, expectedToken: string, mode: "keep_sources" | "remove_sources") {
  return { workspaceId, slug, expectedToken, mode, confirmation: "archive_article" };
}

describe("confirmed Brain article removal", () => {
  beforeEach(truncateAllTables);

  it("hides linked source removal while disabled but permits article-only archive", async () => {
    const { workspace, admin } = await fixture(false);
    const { document, source } = await sourceWithDocument(workspace.id, "Paused");
    const article = await prisma.brainArticle.create({ data: {
      workspaceId: workspace.id, slug: "paused", title: "Paused", type: "PROJECT", bodyMd: "Original", sourceIds: [source.id],
    } });
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
    const { workspace } = await fixture();
    const { document, source } = await sourceWithDocument(workspace.id, "Finance confidential");
    await prisma.brainSource.update({ where: { id: source.id }, data: { accessDomain: "FINANCE" } });
    const article = await prisma.brainArticle.create({ data: {
      workspaceId: workspace.id, slug: "restricted-preview", title: "Article", type: "PROJECT", bodyMd: "Body", sourceIds: [source.id],
    } });
    const credential: AppActor = { kind: "agent", authProvider: "credential", label: "Brain reader",
      workspaceIds: [workspace.id], scopes: ["brain:read"] };
    expect(await previewBrainArticleRemoval(credential, { workspaceId: workspace.id, slug: article.slug }))
      .toMatchObject({ sources: [], documents: [], canRemoveSources: false, blockReasons: expect.arrayContaining(["restricted"]) });
    await prisma.brainSource.update({ where: { id: source.id }, data: { accessDomain: "WORKSPACE" } });
    await prisma.document.update({ where: { id: document.id }, data: { accessDomain: "FINANCE" } });
    expect(await previewBrainArticleRemoval(credential, { workspaceId: workspace.id, slug: article.slug }))
      .toMatchObject({ sources: [], documents: [], canRemoveSources: false, blockReasons: expect.arrayContaining(["restricted"]) });
    expect(await prisma.workspaceArchiveRecord.count()).toBe(0);
  });

  it("keeps sources for an owner, leaves preview/cancel read-only, and rejects stale or repeated confirmation", async () => {
    const { workspace, admin, owner, outsider, ownerMember } = await fixture();
    const { document, source } = await sourceWithDocument(workspace.id, "Keep");
    const article = await prisma.brainArticle.create({ data: {
      workspaceId: workspace.id, slug: "keep-article", title: "Keep article", type: "PROJECT", bodyMd: "Original",
      ownerMemberId: ownerMember.id, sourceIds: [source.id],
    } });
    await expect(previewBrainArticleRemoval(outsider, { workspaceId: workspace.id, slug: article.slug }))
      .rejects.toMatchObject({ status: 403, code: "NOT_A_MEMBER" });
    await prisma.brainSource.update({ where: { id: source.id }, data: { accessDomain: "FINANCE" } });
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
    await prisma.brainArticle.update({ where: { id: article.id }, data: { bodyMd: "Human revision" } });
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

  it("removes an article, every representation of its source document, and the document recoverably", async () => {
    const { workspace, admin } = await fixture();
    const { document, source } = await sourceWithDocument(workspace.id, "Remove");
    const extra = await prisma.brainSource.create({ data: {
      workspaceId: workspace.id, sourceType: "DOC", tier: 1, title: "Another representation", content: "Same document",
      metadata: { documentId: document.id },
    } });
    const article = await prisma.brainArticle.create({ data: {
      workspaceId: workspace.id, slug: "remove-all", title: "Remove all", type: "PROJECT", bodyMd: "Body",
      sourceIds: [source.id],
    } });
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
    const { document, source: removed } = await sourceWithDocument(workspace.id, "Shared");
    const remaining = await prisma.brainSource.create({ data: {
      workspaceId: workspace.id, sourceType: "DOC", tier: 1, title: "Remaining", content: "Remaining verified facts",
    } });
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
    await prisma.brainSource.update({ where: { id: removed.id }, data: { metadata: { documentId: document.id } } });
    await resolveBrainSourceRemoval(admin, { workspaceId: workspace.id, jobId: retried.jobId, decision: "accept" });
    expect((await prisma.brainArticle.findUniqueOrThrow({ where: { id: shared.id } })).bodyMd).toBe("Verified replacement");
    expect((await prisma.brainArticleVersion.findFirstOrThrow({ where: { articleId: shared.id } })).bodyMd).toBe("Human edited old claims");
    expect((await prisma.brainSource.findUniqueOrThrow({ where: { id: removed.id } })).archivedAt).toBeInstanceOf(Date);
    expect((await prisma.document.findUniqueOrThrow({ where: { id: document.id } })).archivedAt).toBeInstanceOf(Date);
  });

  it("blocks unknown shared links without archiving the target, source, or document", async () => {
    const { workspace, admin } = await fixture();
    const { document, source } = await sourceWithDocument(workspace.id, "Legacy");
    const target = await prisma.brainArticle.create({ data: {
      workspaceId: workspace.id, slug: "legacy-target", title: "Target", type: "PROJECT", bodyMd: "Target", sourceIds: [source.id],
    } });
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
    const { source } = await sourceWithDocument(workspace.id, "Mixed");
    const citation = await prisma.brainSource.create({ data: {
      workspaceId: workspace.id, sourceType: "DOC", tier: 1, content: "Citation only",
    } });
    const target = await prisma.brainArticle.create({ data: {
      workspaceId: workspace.id, slug: "mixed-target", title: "Target", type: "PROJECT", bodyMd: "Target", sourceIds: [source.id],
    } });
    await prisma.brainArticle.create({ data: {
      workspaceId: workspace.id, slug: "mixed-shared", title: "Mixed shared", type: "PROJECT", bodyMd: "Mixed",
      sourceIds: [source.id, citation.id], derivationJson: {
        version: 1, origin: "brain-absorb", agentRunId: "synthetic-run",
        sources: [{ sourceId: source.id, fingerprint: brainSourceContentFingerprint(source) }],
      },
    } });
    const preview = await previewBrainArticleRemoval(admin, { workspaceId: workspace.id, slug: target.slug });
    expect(preview.canRemoveSources).toBe(false);
    expect(preview.sources[0].sharedArticles).toMatchObject([{ action: "manual_review" }]);
    await expect(confirmBrainArticleRemoval(admin, confirmParams(workspace.id, target.slug, preview.token, "remove_sources")))
      .rejects.toMatchObject({ status: 409, code: "SOURCE_ARTICLE_IMPACT_REVIEW_REQUIRED" });
    expect((await prisma.brainArticle.findUniqueOrThrow({ where: { id: target.id } })).archivedAt).toBeNull();
  });

  it("blocks a shared article whose remaining source is restricted, archived, or missing", async () => {
    const { workspace, admin } = await fixture();
    for (const condition of ["restricted", "archived", "missing"] as const) {
      const { source: removed } = await sourceWithDocument(workspace.id, condition);
      const remaining = await prisma.brainSource.create({ data: {
        workspaceId: workspace.id, sourceType: "DOC", tier: 1, content: `${condition} remaining facts`,
      } });
      const target = await prisma.brainArticle.create({ data: {
        workspaceId: workspace.id, slug: `${condition}-target`, title: "Target", type: "PROJECT", bodyMd: "Target",
        sourceIds: [removed.id],
      } });
      await prisma.brainArticle.create({ data: {
        workspaceId: workspace.id, slug: `${condition}-shared`, title: "Shared", type: "PROJECT", bodyMd: "Shared",
        sourceIds: [removed.id, remaining.id], derivationJson: {
          version: 1, origin: "brain-absorb", agentRunId: "synthetic-run", sources: [
            { sourceId: removed.id, fingerprint: brainSourceContentFingerprint(removed) },
            { sourceId: remaining.id, fingerprint: brainSourceContentFingerprint(remaining) },
          ],
        },
      } });
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
    const first = await sourceWithDocument(workspace.id, "First");
    const second = await sourceWithDocument(workspace.id, "Second");
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
    const first = await sourceWithDocument(workspace.id, "First retry");
    const second = await sourceWithDocument(workspace.id, "Second retry");
    const other = await prisma.brainSource.create({ data: {
      workspaceId: workspace.id, sourceType: "DOC", tier: 1, content: "Remaining verified facts",
    } });
    const target = await prisma.brainArticle.create({ data: {
      workspaceId: workspace.id, slug: "retry-target", title: "Retry target", type: "PROJECT", bodyMd: "Target",
      sourceIds: [first.source.id, second.source.id],
    } });
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
