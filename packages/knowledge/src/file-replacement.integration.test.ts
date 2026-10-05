import { randomUUID } from "node:crypto";
import { beforeEach, expect, it, vi } from "vitest";
import { prisma, type AppActor } from "@corgtex/shared";
import { truncateAllTables } from "../../shared/src/db-test-utils";
import { lockWorkspaceArchiveArtifact } from "../../domain/src/archive";
import { defaultStorage } from "@corgtex/storage";
import { defaultModelGateway } from "@corgtex/models";
import { ingestFile } from "./file-ingestion";
import { syncDocumentKnowledge } from "./chunks";

beforeEach(truncateAllTables);

async function fixture() {
  const workspace = await prisma.workspace.create({ data: { name: "Replacement race", slug: `replace-${randomUUID()}` } });
  const user = await prisma.user.create({ data: { email: `replace-${randomUUID()}@example.test`, passwordHash: "fixture" } });
  await prisma.member.create({ data: { workspaceId: workspace.id, userId: user.id, role: "ADMIN" } });
  const actor: AppActor = { kind: "user", user: { id: user.id, email: user.email, displayName: "Admin" } };
  const document = await prisma.document.create({ data: {
    workspaceId: workspace.id, title: "Synthetic policy.txt", source: "FILE_UPLOAD", mimeType: "text/plain",
    storageKey: `synthetic/${randomUUID()}`, textContent: "Synthetic policy: prior terms.",
  } });
  const source = await prisma.brainSource.create({ data: {
    workspaceId: workspace.id, sourceType: "FILE_UPLOAD", tier: 2, content: document.textContent!, title: document.title,
    metadata: { documentId: document.id },
  } });
  const replace = () => ingestFile(actor, { workspaceId: workspace.id, fileName: "policy.txt", documentTitle: document.title,
    mimeType: "text/plain", fileBuffer: Buffer.from("Synthetic policy: current terms."), uploadSource: "FILE_UPLOAD",
    duplicateGuard: { resolution: "update_existing", targetEntityId: document.id } });
  return { workspace, document, source, replace };
}

it("rejects an old embedding after replacement and indexes only current document text", async () => {
  const { workspace, document, replace } = await fixture();
  let release!: () => void;
  let entered!: () => void;
  const held = new Promise<void>((resolve) => { release = resolve; });
  const started = new Promise<void>((resolve) => { entered = resolve; });
  const embed = vi.spyOn(defaultModelGateway, "embed").mockImplementation(async () => {
    entered();
    await held;
    return { embeddings: [[0.1]], usage: { provider: "fixture", model: "fixture", inputTokens: 1, outputTokens: 0,
      latencyMs: 0, estimatedCostUsd: "0", rawProviderCostUsd: "0", billableCostUsd: "0" } };
  });
  const put = vi.spyOn(defaultStorage, "put").mockImplementation(async (key, data) => ({ key, size: data.length }));
  const remove = vi.spyOn(defaultStorage, "delete").mockResolvedValue(undefined);
  try {
    const oldSync = syncDocumentKnowledge({ workspaceId: workspace.id, documentId: document.id });
    await started;
    await replace();
    release();
    expect(await oldSync).toBe(0);
    await syncDocumentKnowledge({ workspaceId: workspace.id, documentId: document.id });
    const chunks = await prisma.knowledgeChunk.findMany({ where: { workspaceId: workspace.id, sourceId: document.id } });
    expect(chunks).toHaveLength(1);
    expect(chunks[0].content).toContain("current terms");
    expect(chunks[0].content).not.toContain("prior terms");
  } finally { release(); embed.mockRestore(); put.mockRestore(); remove.mockRestore(); }
});

it("waits for source coordination before acquiring the replacement document row", async () => {
  const { document, source, replace } = await fixture();
  let uploaded!: () => void;
  const stored = new Promise<void>((resolve) => { uploaded = resolve; });
  const put = vi.spyOn(defaultStorage, "put").mockImplementation(async (key, data) => { uploaded(); return { key, size: data.length }; });
  const remove = vi.spyOn(defaultStorage, "delete").mockResolvedValue(undefined);
  let replacement!: ReturnType<typeof replace>;
  try {
    await prisma.$transaction(async (tx) => {
      await lockWorkspaceArchiveArtifact(tx, "BrainSource", source.id);
      replacement = replace();
      await stored;
      await new Promise((resolve) => setTimeout(resolve, 100));
      // Confirmed article removal holds source locks before touching Documents.
      // A replacement waiting for that source must leave this row available.
      await tx.$queryRaw`SELECT id FROM "Document" WHERE id = ${document.id} FOR UPDATE NOWAIT`;
    });
    await replacement;
    expect((await prisma.document.findUniqueOrThrow({ where: { id: document.id } })).textContent).toContain("current terms");
  } finally { await replacement?.catch(() => undefined); put.mockRestore(); remove.mockRestore(); }
});

it.each(["human-authored", "multi-source", "derivation-only"])("preserves %s linked articles and the original file pending review", async (kind) => {
  const { workspace, document, source, replace } = await fixture();
  const other = kind === "multi-source" ? await prisma.brainSource.create({ data: {
    workspaceId: workspace.id, sourceType: "FILE_UPLOAD", tier: 2, content: "Other source terms",
  } }) : null;
  const article = await prisma.brainArticle.create({ data: {
    workspaceId: workspace.id, slug: "retained-article", title: "Retained synthesis", type: "PROJECT",
    bodyMd: "Human-reviewed policy synthesis", sourceIds: kind === "derivation-only" ? [] : [source.id, ...(other ? [other.id] : [])],
    ...(kind === "derivation-only" ? { derivationJson: { version: 1, origin: "brain-absorb", agentRunId: "fixture-run",
      sources: [{ sourceId: source.id, fingerprint: "fixture-fingerprint" }] } } : {}),
  } });
  const put = vi.spyOn(defaultStorage, "put").mockImplementation(async (key, data) => ({ key, size: data.length }));
  const remove = vi.spyOn(defaultStorage, "delete").mockResolvedValue(undefined);
  try {
    await expect(replace()).rejects.toMatchObject({ status: 409, code: "DOCUMENT_REPLACEMENT_REVIEW_REQUIRED" });
    const retained = await prisma.brainArticle.findUniqueOrThrow({ where: { id: article.id } });
    expect(retained.archivedAt).toBeNull();
    expect(retained.bodyMd).toBe(article.bodyMd);
    expect((await prisma.document.findUniqueOrThrow({ where: { id: document.id } })).storageKey).toBe(document.storageKey);
    expect((await prisma.brainSource.findUniqueOrThrow({ where: { id: source.id } })).content).toBe(source.content);
    expect(await prisma.workspaceArchiveRecord.count({ where: { workspaceId: workspace.id } })).toBe(0);
    expect(remove).toHaveBeenCalledWith(put.mock.calls[0][0]);
  } finally { put.mockRestore(); remove.mockRestore(); }
});
