import { randomUUID } from "node:crypto";
import { beforeEach, expect, it, vi } from "vitest";
import { prisma, type AppActor } from "@corgtex/shared";
import { truncateAllTables } from "../../shared/src/db-test-utils";
import { archiveWorkspaceArtifact } from "../../domain/src/archive";
import { syncBrainArticleKnowledge } from "./chunks";
import { defaultModelGateway } from "@corgtex/models";

beforeEach(truncateAllTables);

it("does not let an in-flight Brain index job restore archived chunks", async () => {
  const workspace = await prisma.workspace.create({ data: { name: "Index race", slug: `index-race-${randomUUID()}` } });
  const user = await prisma.user.create({ data: { email: `index-race-${randomUUID()}@example.test`, passwordHash: "fixture" } });
  await prisma.member.create({ data: { workspaceId: workspace.id, userId: user.id, role: "ADMIN" } });
  const actor: AppActor = { kind: "user", user: { id: user.id, email: user.email, displayName: "Admin" } };
  const article = await prisma.brainArticle.create({ data: {
    workspaceId: workspace.id, slug: "index-race", title: "Index race", type: "PROJECT", bodyMd: "Synthetic indexed article",
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
    const staleSync = syncBrainArticleKnowledge({ workspaceId: workspace.id, articleId: article.id });
    await entered;
    let archiveSettled = false;
    const archive = archiveWorkspaceArtifact(actor, {
      workspaceId: workspace.id, entityType: "BrainArticle", entityId: article.id,
    }).finally(() => { archiveSettled = true; });
    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(archiveSettled).toBe(false);
    releaseEmbed();
    await staleSync;
    await archive;
    expect(await prisma.knowledgeChunk.count({ where: {
      workspaceId: workspace.id, sourceType: "BRAIN_ARTICLE", sourceId: article.id,
    } })).toBe(0);
    await syncBrainArticleKnowledge({ workspaceId: workspace.id, articleId: article.id });
    expect(await prisma.knowledgeChunk.count({ where: {
      workspaceId: workspace.id, sourceType: "BRAIN_ARTICLE", sourceId: article.id,
    } })).toBe(0);
  } finally {
    releaseEmbed();
    embed.mockRestore();
  }
});
