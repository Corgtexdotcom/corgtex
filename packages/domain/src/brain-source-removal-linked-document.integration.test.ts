import { randomUUID } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { prisma, type AppActor } from "@corgtex/shared";
import { truncateAllTables } from "../../shared/src/db-test-utils";
import { archiveWorkspaceArtifact, restoreWorkspaceArtifact } from "./archive";
import { generateBrainSourceRemovalCandidate, requestBrainSourceRemoval, resolveBrainSourceRemoval, retryBrainSourceRemoval } from "./brain-source-removal";
import { readableArtifactIds, recordArtifactInputLineage } from "./source-lineage";

const previousRuntime = process.env.BRAIN_SOURCE_REMOVAL_RUNTIME_ENABLED;
beforeEach(async () => { process.env.BRAIN_SOURCE_REMOVAL_RUNTIME_ENABLED = "true"; await truncateAllTables(); });
afterEach(() => {
  if (previousRuntime === undefined) delete process.env.BRAIN_SOURCE_REMOVAL_RUNTIME_ENABLED;
  else process.env.BRAIN_SOURCE_REMOVAL_RUNTIME_ENABLED = previousRuntime;
});
async function fixture(shared = false) {
  const workspace = await prisma.workspace.create({ data: { slug: `linked-removal-${randomUUID()}`, name: "Synthetic linked removal" } });
  await prisma.workspaceFeatureFlag.create({ data: { workspaceId: workspace.id, flag: "BRAIN_SOURCE_REMOVAL", enabled: true } });
  const user = await prisma.user.create({ data: { email: `linked-removal-${randomUUID()}@example.test`, passwordHash: "synthetic" } });
  await prisma.member.create({ data: { workspaceId: workspace.id, userId: user.id, role: "ADMIN" } });
  const actor: AppActor = { kind: "user", user: { id: user.id, email: user.email, displayName: "Synthetic owner" } };
  const document = await prisma.document.create({ data: { workspaceId: workspace.id, title: "Excluded document title",
    textContent: "Excluded document body", source: "synthetic-native-human", storageKey: `synthetic/${randomUUID()}` } });
  const removed = await prisma.brainSource.create({ data: { workspaceId: workspace.id, sourceType: "DOC", tier: 2,
    title: document.title, content: document.textContent!, metadata: { documentId: document.id } } });
  const remaining = await prisma.brainSource.create({ data: { workspaceId: workspace.id,
    sourceType: shared ? "DOC" : "CONVERSATION", tier: 1, title: "Independent permitted title", content: "Independent permitted body",
    ...(shared ? { metadata: { documentId: document.id } } : {}) } });
  await prisma.$transaction(async tx => {
    await recordArtifactInputLineage({ tx, actor, workspaceId: workspace.id, artifact: { kind: "Document", id: document.id },
      content: document, origin: "HUMAN_ORIGINAL", inputs: [] });
    for (const source of [removed, remaining]) await recordArtifactInputLineage({ tx, actor, workspaceId: workspace.id,
      artifact: { kind: "BrainSource", id: source.id }, content: source, origin: source.sourceType === "DOC" ? "DERIVED" : "HUMAN_ORIGINAL",
      inputs: source.sourceType === "DOC" ? [{ kind: "Document", id: document.id }] : [] });
  });
  return { workspace, actor, document, removed, remaining };
}
async function restoredRetirement() {
  const f = await fixture();
  const article = await prisma.brainArticle.create({ data: { workspaceId: f.workspace.id, slug: `old-composite-${randomUUID()}`,
    // Full consumed inputs exist independently of model citations. This article
    // can be restored structurally while its old source proof remains revoked.
    title: "Excluded composite title", type: "PROJECT", bodyMd: "Excluded composite body", sourceIds: [] } });
  await prisma.$transaction(tx => recordArtifactInputLineage({ tx, actor: f.actor, workspaceId: f.workspace.id,
    artifact: { kind: "BrainArticle", id: article.id }, content: article, origin: "DERIVED",
    inputs: [{ kind: "BrainSource", id: f.removed.id }, { kind: "BrainSource", id: f.remaining.id }] }));
  const request = await requestBrainSourceRemoval(f.actor, { workspaceId: f.workspace.id, sourceId: f.removed.id, archiveLinkedDocument: true });
  if (request.status !== "pending") throw new Error("Expected native removal review");
  await archiveWorkspaceArtifact(f.actor, { workspaceId: f.workspace.id, entityType: "BrainArticle", entityId: article.id });
  await archiveWorkspaceArtifact(f.actor, { workspaceId: f.workspace.id, entityType: "BrainSource", entityId: f.removed.id });
  await archiveWorkspaceArtifact(f.actor, { workspaceId: f.workspace.id, entityType: "Document", entityId: f.document.id });
  await restoreWorkspaceArtifact(f.actor, { workspaceId: f.workspace.id, entityType: "BrainArticle", entityId: article.id });
  const restored = await prisma.brainArticle.findUniqueOrThrow({ where: { id: article.id } });
  expect(await readableArtifactIds(f.actor, f.workspace.id, "BrainArticle", [restored])).toEqual(new Set());
  await prisma.workflowJob.update({ where: { id: request.jobId }, data: { status: "RUNNING", lockedAt: new Date(), startedAt: new Date(), attempts: 1, lockedBy: "fixture-worker" } });
  const obsoleteModel = vi.fn(async () => "Never publish old request");
  expect(await generateBrainSourceRemovalCandidate({ workspaceId: f.workspace.id, jobId: request.jobId,
    expectedAttempt: 1, expectedOwner: "fixture-worker", generate: obsoleteModel })).toEqual({ phase: "STALE" });
  expect(obsoleteModel).not.toHaveBeenCalled();
  await prisma.workflowJob.update({ where: { id: request.jobId }, data: { status: "COMPLETED" } });
  const oldPayload = (await prisma.workflowJob.findUniqueOrThrow({ where: { id: request.jobId } })).payload;
  const fresh = await retryBrainSourceRemoval(f.actor, { workspaceId: f.workspace.id, jobId: request.jobId });
  if (fresh.status !== "pending") throw new Error("Expected fresh native retirement");
  expect(fresh.jobId).not.toBe(request.jobId);
  expect((await prisma.workflowJob.findUniqueOrThrow({ where: { id: request.jobId } })).payload).toEqual(oldPayload);
  await prisma.workflowJob.update({ where: { id: fresh.jobId }, data: { status: "RUNNING", lockedAt: new Date(), startedAt: new Date(), attempts: 1, lockedBy: "fixture-worker" } });
  return { ...f, article, fresh };
}

describe("native linked document removal and retirement", () => {
  it("replays the archive-if-resolved option while another source keeps the shared document active", async () => {
    const f = await fixture(true);
    const params = { workspaceId: f.workspace.id, sourceId: f.removed.id, archiveLinkedDocument: true };
    const first = await requestBrainSourceRemoval(f.actor, params);
    expect(first).toEqual({ id: f.removed.id, status: "archived" });
    expect((await prisma.document.findUniqueOrThrow({ where: { id: f.document.id } })).archivedAt).toBeNull();
    expect(await requestBrainSourceRemoval(f.actor, params)).toEqual(first);
    expect(await prisma.conversationOperationOutcome.count()).toBe(1);
    const outcome = await prisma.conversationOperationOutcome.findFirstOrThrow();
    expect(outcome.controlJson).toMatchObject({ archiveLinkedDocumentRequested: true, documentId: f.document.id, documentArchiveRecordId: null });
    expect((await prisma.brainSource.findUniqueOrThrow({ where: { id: f.remaining.id } })).archivedAt).toBeNull();
  });
  it("rebuilds a restored derived article from independent sources with an already archived linked document", async () => {
    const f = await restoredRetirement();
    const generate = vi.fn(async () => "Fresh independent body");
    expect(await generateBrainSourceRemovalCandidate({ workspaceId: f.workspace.id, jobId: f.fresh.jobId,
      expectedAttempt: 1, expectedOwner: "fixture-worker", generate })).toEqual({ phase: "READY", candidateCount: 1 });
    expect(generate).toHaveBeenCalledWith({ id: f.article.id, title: f.remaining.title }, [expect.objectContaining({ id: f.remaining.id })],
      expect.objectContaining({ authorizeAttempt: expect.any(Function), signal: expect.any(AbortSignal) }));
    expect(JSON.stringify(generate.mock.calls)).not.toContain("Excluded");
    await prisma.workflowJob.update({ where: { id: f.fresh.jobId }, data: { status: "COMPLETED" } });
    expect(await resolveBrainSourceRemoval(f.actor, { workspaceId: f.workspace.id, jobId: f.fresh.jobId, decision: "accept" }))
      .toMatchObject({ status: "applied" });
    const current = await prisma.brainArticle.findUniqueOrThrow({ where: { id: f.article.id }, include: { versions: true } });
    expect(current).toMatchObject({ bodyMd: "Fresh independent body", sourceIds: [f.remaining.id], title: f.remaining.title });
    expect(current.versions).toMatchObject([{ bodyMd: "Excluded composite body" }]);
    expect(await readableArtifactIds(f.actor, f.workspace.id, "BrainArticleVersion", current.versions)).toEqual(new Set());
    expect((await prisma.document.findUniqueOrThrow({ where: { id: f.document.id } })).archivedAt).not.toBeNull();
  });
  it("rejects the fresh candidate when the excluded document is restored during generation", async () => {
    const f = await restoredRetirement();
    expect(await generateBrainSourceRemovalCandidate({ workspaceId: f.workspace.id, jobId: f.fresh.jobId,
      expectedAttempt: 1, expectedOwner: "fixture-worker", generate: async () => {
        await restoreWorkspaceArtifact(f.actor, { workspaceId: f.workspace.id, entityType: "Document", entityId: f.document.id });
        return "Never publish across document restoration";
      } })).toEqual({ phase: "STALE" });
    expect((await prisma.brainArticle.findUniqueOrThrow({ where: { id: f.article.id } })).bodyMd).toBe("Excluded composite body");
  });
});
