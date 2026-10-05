import { randomUUID } from "node:crypto";
import { beforeEach, describe, expect, it } from "vitest";
import { prisma, type AppActor } from "@corgtex/shared";
import { truncateAllTables } from "../../shared/src/db-test-utils";
import { archiveWorkspaceArtifact, restoreWorkspaceArtifact } from "./archive";
import { createArticle, publishArticle, updateArticle } from "./brain";
import { brainSourceContentFingerprint } from "./brain-derivation";
import { listBrainSourceArchiveImpacts } from "./brain-source-impact";
import { deleteDocument } from "./documents";

describe("Brain source archive impact", () => {
  beforeEach(truncateAllTables);

  it("blocks every archive entry point for linked articles without guessing legacy derivation", async () => {
    const workspace = await prisma.workspace.create({ data: { name: "Synthetic impact", slug: `impact-${randomUUID()}` } });
    const user = await prisma.user.create({ data: { email: `impact-${randomUUID()}@example.test`, passwordHash: "fixture" } });
    const member = await prisma.member.create({ data: { workspaceId: workspace.id, userId: user.id, role: "ADMIN" } });
    const editor: AppActor = { kind: "user", user: { id: user.id, email: user.email, displayName: "Editor" } };
    const agent: AppActor = { kind: "agent", authProvider: "bootstrap", label: "brain-absorb", workspaceIds: [workspace.id] };
    const document = await prisma.document.create({ data: {
      workspaceId: workspace.id, title: "Source document", source: "upload", storageKey: `synthetic/${randomUUID()}`,
    } });
    const source = await prisma.brainSource.create({ data: {
      workspaceId: workspace.id, sourceType: "DOC", tier: 1, title: "Source document", content: "Source text",
      authorMemberId: member.id, metadata: { documentId: document.id },
    } });
    await createArticle(agent, {
      workspaceId: workspace.id, title: "Generated article", type: "PROJECT", bodyMd: "Generated body",
      sourceIds: [source.id], derivation: { sourceId: source.id,
        sourceFingerprint: brainSourceContentFingerprint(source), agentRunId: "synthetic-run" },
    });
    const legacyArticle = await createArticle(editor, {
      workspaceId: workspace.id, title: "Legacy linked article", type: "PROJECT", bodyMd: "Human body", sourceIds: [source.id],
    });

    const [impact] = await listBrainSourceArchiveImpacts(editor, { workspaceId: workspace.id, sourceIds: [source.id] });
    expect(impact).toMatchObject({ sourceId: source.id, blocked: true });
    expect(impact.visibleArticles.map((article) => article.kind).sort()).toEqual(["derived", "unclassified"]);

    const viewerUser = await prisma.user.create({ data: { email: `impact-viewer-${randomUUID()}@example.test`, passwordHash: "fixture" } });
    await prisma.member.create({ data: { workspaceId: workspace.id, userId: viewerUser.id, role: "CONTRIBUTOR" } });
    const viewer: AppActor = { kind: "user", user: { id: viewerUser.id, email: viewerUser.email, displayName: "Viewer" } };
    const [redacted] = await listBrainSourceArchiveImpacts(viewer, { workspaceId: workspace.id, sourceIds: [source.id] });
    expect(redacted).toEqual({ sourceId: source.id, blocked: true, visibleArticles: [], hasHiddenArticles: true });

    for (const [entityType, entityId] of [["BrainSource", source.id], ["Document", document.id]] as const) {
      await expect(archiveWorkspaceArtifact(editor, { workspaceId: workspace.id, entityType, entityId }))
        .rejects.toMatchObject({ code: "SOURCE_ARTICLE_IMPACT_REVIEW_REQUIRED", status: 409 });
    }
    expect((await prisma.brainSource.findUniqueOrThrow({ where: { id: source.id } })).archivedAt).toBeNull();
    expect((await prisma.document.findUniqueOrThrow({ where: { id: document.id } })).archivedAt).toBeNull();
    expect(await prisma.workspaceArchiveRecord.count()).toBe(0);

    const otherWorkspace = await prisma.workspace.create({ data: { name: "Other", slug: `impact-other-${randomUUID()}` } });
    const otherSource = await prisma.brainSource.create({ data: {
      workspaceId: otherWorkspace.id, sourceType: "DOC", tier: 1, content: "Other text",
    } });
    await expect(listBrainSourceArchiveImpacts(editor, { workspaceId: workspace.id, sourceIds: [otherSource.id] }))
      .rejects.toMatchObject({ status: 404, code: "NOT_FOUND" });

    const unlinked = await prisma.brainSource.create({ data: {
      workspaceId: workspace.id, sourceType: "DOC", tier: 1, content: "Unlinked text", authorMemberId: member.id,
    } });
    const first = await archiveWorkspaceArtifact(editor, { workspaceId: workspace.id, entityType: "BrainSource", entityId: unlinked.id });
    const repeated = await archiveWorkspaceArtifact(editor, { workspaceId: workspace.id, entityType: "BrainSource", entityId: unlinked.id });
    expect(first.id).toBe(unlinked.id);
    expect(repeated.id).toBe(unlinked.id);
    expect(await prisma.workspaceArchiveRecord.count({ where: { entityType: "BrainSource", entityId: unlinked.id } })).toBe(1);
    await expect(createArticle(editor, {
      workspaceId: workspace.id, title: "Late link", type: "PROJECT", bodyMd: "Late body", sourceIds: [unlinked.id],
    })).rejects.toMatchObject({ code: "SOURCE_CHANGED", status: 409 });
    await expect(updateArticle(editor, {
      workspaceId: workspace.id, slug: legacyArticle.slug, sourceIds: [source.id, unlinked.id],
    })).rejects.toMatchObject({ code: "SOURCE_CHANGED", status: 409 });
  });

  it("serializes article links with source archive before document archive", async () => {
    const workspace = await prisma.workspace.create({ data: { name: "Archive race", slug: `impact-race-${randomUUID()}` } });
    const user = await prisma.user.create({ data: { email: `impact-race-${randomUUID()}@example.test`, passwordHash: "fixture" } });
    await prisma.member.create({ data: { workspaceId: workspace.id, userId: user.id, role: "ADMIN" } });
    const editor: AppActor = { kind: "user", user: { id: user.id, email: user.email, displayName: "Editor" } };
    const document = await prisma.document.create({ data: {
      workspaceId: workspace.id, title: "Race document", source: "upload", storageKey: `synthetic/${randomUUID()}`,
    } });
    const source = await prisma.brainSource.create({ data: {
      workspaceId: workspace.id, sourceType: "DOC", tier: 1, content: "Race text", metadata: { documentId: document.id },
    } });

    let releaseArchive!: () => void;
    let archiveReady!: () => void;
    const archiveHeld = new Promise<void>((resolve) => { releaseArchive = resolve; });
    const archiveEntered = new Promise<void>((resolve) => { archiveReady = resolve; });
    const archiveTransaction = prisma.$transaction(async (tx) => {
      await archiveWorkspaceArtifact(editor, { workspaceId: workspace.id, entityType: "BrainSource", entityId: source.id, _tx: tx });
      archiveReady();
      await archiveHeld;
    });
    await archiveEntered;

    let articleSettled = false;
    const articleOutcome = createArticle(editor, {
      workspaceId: workspace.id, title: "Late citation", type: "PROJECT", bodyMd: "Late body", sourceIds: [source.id],
    }).then((article) => article, (error: unknown) => error).finally(() => { articleSettled = true; });
    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(articleSettled).toBe(false);
    releaseArchive();
    await archiveTransaction;
    expect(await articleOutcome).toMatchObject({ code: "SOURCE_CHANGED", status: 409 });
    expect(await prisma.brainArticle.count({ where: { workspaceId: workspace.id } })).toBe(0);
    await archiveWorkspaceArtifact(editor, { workspaceId: workspace.id, entityType: "Document", entityId: document.id });
  });

  it("does not commit an in-flight edit or publication after article archive commits", async () => {
    const workspace = await prisma.workspace.create({ data: { name: "Draft archive race", slug: `draft-race-${randomUUID()}` } });
    const user = await prisma.user.create({ data: { email: `draft-race-${randomUUID()}@example.test`, passwordHash: "fixture" } });
    await prisma.member.create({ data: { workspaceId: workspace.id, userId: user.id, role: "ADMIN" } });
    const actor: AppActor = { kind: "user", user: { id: user.id, email: user.email, displayName: "Admin" } };
    const article = await createArticle(actor, { workspaceId: workspace.id, title: "Draft", type: "PROJECT",
      bodyMd: "Original", authority: "DRAFT" });
    let releaseArchive!: () => void;
    let archiveReady!: () => void;
    const held = new Promise<void>((resolve) => { releaseArchive = resolve; });
    const ready = new Promise<void>((resolve) => { archiveReady = resolve; });
    const archiving = prisma.$transaction(async (tx) => {
      await archiveWorkspaceArtifact(actor, { workspaceId: workspace.id, entityType: "BrainArticle", entityId: article.id, _tx: tx });
      archiveReady();
      await held;
    });
    await ready;
    const editing = updateArticle(actor, { workspaceId: workspace.id, slug: article.slug, bodyMd: "Stale edit" })
      .then(() => null, (error: unknown) => error);
    const publishing = publishArticle(actor, { workspaceId: workspace.id, slug: article.slug })
      .then(() => null, (error: unknown) => error);
    await new Promise((resolve) => setTimeout(resolve, 100));
    releaseArchive();
    await archiving;
    expect(await editing).toMatchObject({ status: 409, code: "ARTICLE_CHANGED" });
    expect(await publishing).toMatchObject({ status: 404, code: "NOT_FOUND" });
    const final = await prisma.brainArticle.findUniqueOrThrow({ where: { id: article.id } });
    expect(final.bodyMd).toBe("Original");
    expect(final.isPrivate).toBe(true);
    expect(final.archivedAt).toBeInstanceOf(Date);
  });

  it("routes direct document deletion through linked source removal first", async () => {
    const workspace = await prisma.workspace.create({ data: { name: "Document source entry", slug: `doc-entry-${randomUUID()}` } });
    const user = await prisma.user.create({ data: { email: `doc-entry-${randomUUID()}@example.test`, passwordHash: "fixture" } });
    await prisma.member.create({ data: { workspaceId: workspace.id, userId: user.id, role: "ADMIN" } });
    const actor: AppActor = { kind: "user", user: { id: user.id, email: user.email, displayName: "Admin" } };
    const document = await prisma.document.create({ data: { workspaceId: workspace.id, title: "Document", source: "upload",
      storageKey: `synthetic/${randomUUID()}` } });
    const source = await prisma.brainSource.create({ data: { workspaceId: workspace.id, sourceType: "DOC", tier: 1,
      content: "Source text", metadata: { documentId: document.id } } });
    await expect(deleteDocument(actor, { workspaceId: workspace.id, documentId: document.id }))
      .rejects.toMatchObject({ status: 409, code: "DOCUMENT_SOURCE_REMOVAL_REQUIRED" });
    expect((await prisma.document.findUniqueOrThrow({ where: { id: document.id } })).archivedAt).toBeNull();
    await archiveWorkspaceArtifact(actor, { workspaceId: workspace.id, entityType: "BrainSource", entityId: source.id });
    await deleteDocument(actor, { workspaceId: workspace.id, documentId: document.id });
    expect((await prisma.document.findUniqueOrThrow({ where: { id: document.id } })).archivedAt).toBeInstanceOf(Date);
  });

  it("requires source recovery before restoring an article that links to it", async () => {
    const workspace = await prisma.workspace.create({ data: { name: "Article recovery", slug: `impact-recovery-${randomUUID()}` } });
    const user = await prisma.user.create({ data: { email: `impact-recovery-${randomUUID()}@example.test`, passwordHash: "fixture" } });
    await prisma.member.create({ data: { workspaceId: workspace.id, userId: user.id, role: "ADMIN" } });
    const editor: AppActor = { kind: "user", user: { id: user.id, email: user.email, displayName: "Editor" } };
    const source = await prisma.brainSource.create({ data: {
      workspaceId: workspace.id, sourceType: "DOC", tier: 1, content: "Recovery text",
    } });
    const article = await createArticle(editor, {
      workspaceId: workspace.id, title: "Recoverable article", type: "PROJECT", bodyMd: "Body", sourceIds: [source.id],
    });
    await archiveWorkspaceArtifact(editor, { workspaceId: workspace.id, entityType: "BrainArticle", entityId: article.id });
    await archiveWorkspaceArtifact(editor, { workspaceId: workspace.id, entityType: "BrainSource", entityId: source.id });
    await expect(restoreWorkspaceArtifact(editor, {
      workspaceId: workspace.id, entityType: "BrainArticle", entityId: article.id,
    })).rejects.toMatchObject({ code: "SOURCE_CHANGED", status: 409 });
    await restoreWorkspaceArtifact(editor, { workspaceId: workspace.id, entityType: "BrainSource", entityId: source.id });
    await restoreWorkspaceArtifact(editor, { workspaceId: workspace.id, entityType: "BrainArticle", entityId: article.id });
    expect((await prisma.brainArticle.findUniqueOrThrow({ where: { id: article.id } })).archivedAt).toBeNull();
  });
});
