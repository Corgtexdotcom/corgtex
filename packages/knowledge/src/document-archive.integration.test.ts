import { randomUUID } from "node:crypto";
import { beforeEach, expect, it, vi } from "vitest";
import { getCacheVersion, prisma, type AppActor } from "@corgtex/shared";
import { truncateAllTables } from "../../shared/src/db-test-utils";
import { archiveWorkspaceArtifact } from "../../domain/src/archive";
import { syncDocumentKnowledge } from "./chunks";
import { defaultModelGateway } from "@corgtex/models";

beforeEach(truncateAllTables);

it("does not let an in-flight document sync restore chunks after archive", async () => {
  const workspace = await prisma.workspace.create({ data: { name: "Document index race", slug: `doc-index-${randomUUID()}` } });
  const user = await prisma.user.create({ data: { email: `doc-index-${randomUUID()}@example.test`, passwordHash: "fixture" } });
  await prisma.member.create({ data: { workspaceId: workspace.id, userId: user.id, role: "ADMIN" } });
  const actor: AppActor = { kind: "user", user: { id: user.id, email: user.email, displayName: "Admin" } };
  const document = await prisma.document.create({ data: {
    workspaceId: workspace.id, title: "Synthetic document", source: "upload",
    storageKey: `synthetic/${randomUUID()}`, textContent: "Synthetic indexed content",
  } });
  let releaseEmbed!: () => void;
  let embedEntered!: () => void;
  const held = new Promise<void>((resolve) => { releaseEmbed = resolve; });
  const entered = new Promise<void>((resolve) => { embedEntered = resolve; });
  const embed = vi.spyOn(defaultModelGateway, "embed").mockImplementation(async () => {
    embedEntered();
    await held;
    return { embeddings: [[0.1]], usage: {
      provider: "fixture", model: "fixture-embed", inputTokens: 1, outputTokens: 0,
      latencyMs: 0, estimatedCostUsd: "0", rawProviderCostUsd: "0", billableCostUsd: "0",
    } };
  });
  try {
    const oldSync = syncDocumentKnowledge({ workspaceId: workspace.id, documentId: document.id });
    await entered;
    let archiveSettled = false;
    const cacheVersionBefore = await getCacheVersion(`knowledge:${workspace.id}`);
    const archive = archiveWorkspaceArtifact(actor, {
      workspaceId: workspace.id, entityType: "Document", entityId: document.id,
    }).finally(() => { archiveSettled = true; });
    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(archiveSettled).toBe(false);
    releaseEmbed();
    await oldSync;
    await archive;
    expect(await getCacheVersion(`knowledge:${workspace.id}`)).toBeGreaterThan(cacheVersionBefore);
    await syncDocumentKnowledge({ workspaceId: workspace.id, documentId: document.id });
    expect(await prisma.knowledgeChunk.count({ where: {
      workspaceId: workspace.id, sourceType: "DOCUMENT", sourceId: document.id,
    } })).toBe(0);
  } finally {
    releaseEmbed();
    embed.mockRestore();
  }
});
