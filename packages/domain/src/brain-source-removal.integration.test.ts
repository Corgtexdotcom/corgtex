import { randomUUID } from "node:crypto";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { Prisma } from "@prisma/client";
import { prisma, type AppActor } from "@corgtex/shared";
import { defaultModelGateway } from "@corgtex/models";
import { truncateAllTables } from "../../shared/src/db-test-utils";
import { searchIndexedKnowledge } from "../../knowledge/src/retrieval";
import { syncBrainArticleKnowledge } from "../../knowledge/src/chunks";
import { createArticle, deleteSource } from "./brain";
import { brainSourceContentFingerprint } from "./brain-derivation";
import {
  generateBrainSourceRemovalCandidate,
  listBrainSourceRemovalReviews,
  resolveBrainSourceRemoval,
} from "./brain-source-removal";

async function fixture() {
  const workspace = await prisma.workspace.create({ data: { name: "Removal fixture", slug: `removal-${randomUUID()}` } });
  const admin = await prisma.user.create({ data: { email: `removal-admin-${randomUUID()}@example.test`, passwordHash: "fixture" } });
  const contributor = await prisma.user.create({ data: { email: `removal-member-${randomUUID()}@example.test`, passwordHash: "fixture" } });
  await prisma.member.create({ data: { workspaceId: workspace.id, userId: admin.id, role: "ADMIN" } });
  await prisma.member.create({ data: { workspaceId: workspace.id, userId: contributor.id, role: "CONTRIBUTOR" } });
  const actor: AppActor = { kind: "user", user: { id: admin.id, email: admin.email, displayName: "Admin" } };
  const member: AppActor = { kind: "user", user: { id: contributor.id, email: contributor.email, displayName: "Member" } };
  const removed = await prisma.brainSource.create({ data: {
    workspaceId: workspace.id, sourceType: "DOC", tier: 1, title: "Removed source", content: "Removed facts",
  } });
  const remaining = await prisma.brainSource.create({ data: {
    workspaceId: workspace.id, sourceType: "DOC", tier: 1, title: "Remaining source", content: "Remaining facts",
  } });
  return { workspace, actor, member, removed, remaining };
}

describe("Brain source removal review", () => {
  beforeEach(truncateAllTables);

  it("recoverably archives an article when its only verified source is removed, including a repeat request", async () => {
    const { workspace, actor, removed } = await fixture();
    const agent: AppActor = { kind: "agent", authProvider: "bootstrap", label: "brain-absorb", workspaceIds: [workspace.id] };
    const article = await createArticle(agent, {
      workspaceId: workspace.id, title: "One source article", type: "PROJECT", bodyMd: "Human reviewed body",
      sourceIds: [removed.id], derivation: {
        sourceId: removed.id, sourceFingerprint: brainSourceContentFingerprint(removed), agentRunId: "synthetic-run",
      },
    });
    const first = await deleteSource(actor, { workspaceId: workspace.id, sourceId: removed.id });
    const repeat = await deleteSource(actor, { workspaceId: workspace.id, sourceId: removed.id });
    expect(first).toEqual({ id: removed.id, status: "archived" });
    expect(repeat).toEqual(first);
    expect((await prisma.brainArticle.findUniqueOrThrow({ where: { id: article.id } })).archivedAt).toBeInstanceOf(Date);
    expect((await prisma.brainSource.findUniqueOrThrow({ where: { id: removed.id } })).archivedAt).toBeInstanceOf(Date);
    expect(await prisma.workspaceArchiveRecord.count({ where: { workspaceId: workspace.id } })).toBe(2);
    expect(await prisma.event.count({ where: { workspaceId: workspace.id, type: "brain-article.updated", aggregateId: article.id } })).toBe(1);
  });

  it("prepares and applies a reviewed candidate from remaining verified sources while preserving the prior body", async () => {
    const { workspace, actor, member, removed, remaining } = await fixture();
    const editedAt = new Date("2026-09-01T12:00:00.000Z");
    const article = await prisma.brainArticle.create({ data: {
      workspaceId: workspace.id, slug: "two-source", title: "Two source article", type: "PROJECT", authority: "REFERENCE",
      bodyMd: "Human revised facts", sourceIds: [removed.id, remaining.id], humanEditedAt: editedAt,
      derivationJson: { version: 1, origin: "brain-absorb", agentRunId: "synthetic-run", sources: [
        { sourceId: removed.id, fingerprint: brainSourceContentFingerprint(removed) },
        { sourceId: remaining.id, fingerprint: brainSourceContentFingerprint(remaining) },
      ] },
    } });
    const currentRemaining = await prisma.brainSource.update({
      where: { id: remaining.id }, data: { content: "Current remaining facts" },
    });
    await expect(deleteSource(member, { workspaceId: workspace.id, sourceId: removed.id }))
      .rejects.toMatchObject({ status: 403, code: "FORBIDDEN" });
    const requested = await deleteSource(actor, { workspaceId: workspace.id, sourceId: removed.id });
    expect(requested.status).toBe("pending");
    if (requested.status !== "pending") throw new Error("Expected a regeneration job.");
    expect(await deleteSource(actor, { workspaceId: workspace.id, sourceId: removed.id })).toEqual(requested);
    expect((await prisma.brainArticle.findUniqueOrThrow({ where: { id: article.id } })).bodyMd).toBe("Human revised facts");
    expect((await prisma.brainSource.findUniqueOrThrow({ where: { id: removed.id } })).archivedAt).toBeNull();
    await prisma.workflowJob.update({ where: { id: requested.jobId }, data: { status: "RUNNING" } });
    let inputs: string[] = [];
    const staged = await generateBrainSourceRemovalCandidate({ workspaceId: workspace.id, jobId: requested.jobId, expectedAttempt: 0, expectedOwner: null,
      generate: async (_target, sources) => { inputs = sources.map((source) => source.content); return "Facts from remaining source only"; },
    });
    expect(staged).toEqual({ phase: "READY", candidateCount: 1 });
    expect(inputs).toEqual(["Current remaining facts"]);
    await prisma.workflowJob.update({ where: { id: requested.jobId }, data: { status: "COMPLETED" } });
    await expect(listBrainSourceRemovalReviews(member, { workspaceId: workspace.id, sourceIds: [removed.id] }))
      .rejects.toMatchObject({ status: 403, code: "FORBIDDEN" });
    const [review] = await listBrainSourceRemovalReviews(actor, { workspaceId: workspace.id, sourceIds: [removed.id] });
    expect(review.articles[0]).toMatchObject({ currentBodyMd: "Human revised facts", candidateBodyMd: "Facts from remaining source only" });
    await prisma.knowledgeChunk.create({ data: {
      workspaceId: workspace.id, sourceType: "BRAIN_ARTICLE", sourceId: article.id,
      content: "Human revised facts", sourceTitle: article.title, embedding: [0.1],
    } });
    const embed = vi.spyOn(defaultModelGateway, "embed").mockImplementation(async ({ input }) => ({
      embeddings: (Array.isArray(input) ? input : [input]).map(() => [0.1]),
      usage: { provider: "fixture", model: "fixture-embed" },
    }));
    const rerank = vi.spyOn(defaultModelGateway, "rerank").mockImplementation(async ({ documents }) => ({
      results: documents.map((document, index) => ({ index, score: 1, document })),
      usage: { provider: "fixture", model: "fixture-rerank" },
    }));
    try {
      const query = { workspaceId: workspace.id, query: "Human revised facts", sourceTypes: ["BRAIN_ARTICLE" as const] };
      expect((await searchIndexedKnowledge(query))[0]?.snippet).toBe("Human revised facts");
      expect(await resolveBrainSourceRemoval(actor, { workspaceId: workspace.id, jobId: requested.jobId, decision: "accept" }))
        .toEqual({ status: "applied", sourceId: removed.id, pendingSourceId: null });
      expect(await prisma.knowledgeChunk.count({ where: {
        workspaceId: workspace.id, sourceType: "BRAIN_ARTICLE", sourceId: article.id,
      } })).toBe(0);
      expect(await searchIndexedKnowledge(query)).toEqual([]);
      embed.mockRejectedValueOnce(new Error("synthetic indexing failure"));
      await expect(syncBrainArticleKnowledge({ workspaceId: workspace.id, articleId: article.id }))
        .rejects.toThrow("synthetic indexing failure");
      expect(await searchIndexedKnowledge(query)).toEqual([]);
      expect(await syncBrainArticleKnowledge({ workspaceId: workspace.id, articleId: article.id })).toBe(1);
      expect((await searchIndexedKnowledge(query))[0]?.snippet).toBe("Facts from remaining source only");
    } finally {
      embed.mockRestore();
      rerank.mockRestore();
    }
    expect(await resolveBrainSourceRemoval(actor, { workspaceId: workspace.id, jobId: requested.jobId, decision: "accept" }))
      .toEqual({ status: "applied", sourceId: removed.id, pendingSourceId: null });
    const updated = await prisma.brainArticle.findUniqueOrThrow({ where: { id: article.id }, include: { versions: true } });
    expect(updated.bodyMd).toBe("Facts from remaining source only");
    expect(updated.sourceIds).toEqual([remaining.id]);
    expect(updated.derivationJson).toMatchObject({
      sources: [{ sourceId: remaining.id, fingerprint: brainSourceContentFingerprint(currentRemaining) }],
    });
    const updatedDerivation = updated.derivationJson as { agentRunId: string };
    expect(await prisma.agentRun.findUniqueOrThrow({ where: { id: updatedDerivation.agentRunId } }))
      .toMatchObject({ agentKey: "brain-source-regenerate", triggerRef: requested.jobId, status: "COMPLETED" });
    expect(updated.humanEditedAt).toEqual(editedAt);
    expect(updated.versions).toMatchObject([{ bodyMd: "Human revised facts" }]);
    expect((await prisma.brainSource.findUniqueOrThrow({ where: { id: removed.id } })).archivedAt).toBeInstanceOf(Date);
  });

  it("rejects stale candidates, permits a fresh request, and leaves unknown legacy links unresolved", async () => {
    const { workspace, actor, removed, remaining } = await fixture();
    const article = await prisma.brainArticle.create({ data: {
      workspaceId: workspace.id, slug: "stale-two-source", title: "Stale article", type: "PROJECT", bodyMd: "Original body",
      sourceIds: [removed.id, remaining.id], derivationJson: {
        version: 1, origin: "brain-absorb", agentRunId: "synthetic-run", sources: [
          { sourceId: removed.id, fingerprint: brainSourceContentFingerprint(removed) },
          { sourceId: remaining.id, fingerprint: brainSourceContentFingerprint(remaining) },
        ],
      },
    } });
    const requested = await deleteSource(actor, { workspaceId: workspace.id, sourceId: removed.id });
    if (requested.status !== "pending") throw new Error("Expected a regeneration job.");
    await prisma.workflowJob.update({ where: { id: requested.jobId }, data: { status: "RUNNING" } });
    const stale = await generateBrainSourceRemovalCandidate({ workspaceId: workspace.id, jobId: requested.jobId, expectedAttempt: 0, expectedOwner: null,
      generate: async () => {
        await prisma.brainSource.update({ where: { id: remaining.id }, data: { content: "Revised remaining facts" } });
        return "Old candidate";
      },
    });
    expect(stale).toEqual({ phase: "STALE" });
    await prisma.workflowJob.update({ where: { id: requested.jobId }, data: { status: "COMPLETED" } });
    await expect(resolveBrainSourceRemoval(actor, { workspaceId: workspace.id, jobId: requested.jobId, decision: "accept" }))
      .rejects.toMatchObject({ status: 409, code: "INVALID_STATE" });
    const retry = await deleteSource(actor, { workspaceId: workspace.id, sourceId: removed.id });
    expect(retry.status).toBe("pending");
    expect(retry.jobId).not.toBe(requested.jobId);
    if (retry.status !== "pending") throw new Error("Expected a retry job.");
    await prisma.workflowJob.update({ where: { id: retry.jobId }, data: { status: "FAILED" } });
    const afterFailure = await deleteSource(actor, { workspaceId: workspace.id, sourceId: removed.id });
    expect(afterFailure.status).toBe("pending");
    expect(afterFailure.jobId).not.toBe(retry.jobId);
    expect((await prisma.brainArticle.findUniqueOrThrow({ where: { id: article.id } })).bodyMd).toBe("Original body");

    const foreign = await prisma.workspace.create({ data: { name: "Foreign", slug: `foreign-${randomUUID()}` } });
    const foreignSource = await prisma.brainSource.create({ data: {
      workspaceId: foreign.id, sourceType: "DOC", tier: 1, content: "Private foreign text",
    } });
    await expect(deleteSource(actor, { workspaceId: workspace.id, sourceId: foreignSource.id }))
      .rejects.toMatchObject({ status: 404, code: "NOT_FOUND" });
    await expect(resolveBrainSourceRemoval(actor, { workspaceId: foreign.id, jobId: requested.jobId, decision: "accept" }))
      .rejects.toMatchObject({ status: 403, code: "NOT_A_MEMBER" });

    await prisma.brainArticle.update({ where: { id: article.id }, data: { derivationJson: Prisma.JsonNull } });
    await expect(deleteSource(actor, { workspaceId: workspace.id, sourceId: removed.id }))
      .rejects.toMatchObject({ status: 409, code: "UNCLASSIFIED_SOURCE_LINK" });
    expect((await prisma.brainSource.findUniqueOrThrow({ where: { id: removed.id } })).archivedAt).toBeNull();
  });

  it("serializes competing accept and reject decisions for one candidate", async () => {
    const { workspace, actor, removed, remaining } = await fixture();
    const article = await prisma.brainArticle.create({ data: {
      workspaceId: workspace.id, slug: "decision-race", title: "Decision race", type: "PROJECT", bodyMd: "Original",
      sourceIds: [removed.id, remaining.id], derivationJson: {
        version: 1, origin: "brain-absorb", agentRunId: "synthetic-run", sources: [
          { sourceId: removed.id, fingerprint: brainSourceContentFingerprint(removed) },
          { sourceId: remaining.id, fingerprint: brainSourceContentFingerprint(remaining) },
        ],
      },
    } });
    const request = await deleteSource(actor, { workspaceId: workspace.id, sourceId: removed.id });
    if (request.status !== "pending") throw new Error("Expected a regeneration job.");
    await prisma.workflowJob.update({ where: { id: request.jobId }, data: { status: "RUNNING" } });
    await generateBrainSourceRemovalCandidate({ workspaceId: workspace.id, jobId: request.jobId,
      expectedAttempt: 0, expectedOwner: null, generate: async () => "Reviewed candidate",
    });
    await prisma.workflowJob.update({ where: { id: request.jobId }, data: { status: "COMPLETED" } });

    const decisions = await Promise.allSettled([
      resolveBrainSourceRemoval(actor, { workspaceId: workspace.id, jobId: request.jobId, decision: "accept" }),
      resolveBrainSourceRemoval(actor, { workspaceId: workspace.id, jobId: request.jobId, decision: "reject" }),
    ]);
    expect(decisions.filter((decision) => decision.status === "fulfilled")).toHaveLength(1);
    expect(decisions.filter((decision) => decision.status === "rejected")).toMatchObject([
      { reason: { status: 409, code: "INVALID_STATE" } },
    ]);
    const phase = ((await prisma.workflowJob.findUniqueOrThrow({ where: { id: request.jobId } })).payload as { phase: string }).phase;
    const archived = (await prisma.brainSource.findUniqueOrThrow({ where: { id: removed.id } })).archivedAt;
    const body = (await prisma.brainArticle.findUniqueOrThrow({ where: { id: article.id } })).bodyMd;
    if (phase === "APPLIED") {
      expect(archived).toBeInstanceOf(Date);
      expect(body).toBe("Reviewed candidate");
    } else {
      expect(phase).toBe("REJECTED");
      expect(archived).toBeNull();
      expect(body).toBe("Original");
    }
  });

  it("refuses to apply a ready candidate after a human article edit", async () => {
    const { workspace, actor, removed, remaining } = await fixture();
    const article = await prisma.brainArticle.create({ data: {
      workspaceId: workspace.id, slug: "human-edit", title: "Human edit", type: "PROJECT", bodyMd: "Original body",
      sourceIds: [removed.id, remaining.id], derivationJson: {
        version: 1, origin: "brain-absorb", agentRunId: "synthetic-run", sources: [
          { sourceId: removed.id, fingerprint: brainSourceContentFingerprint(removed) },
          { sourceId: remaining.id, fingerprint: brainSourceContentFingerprint(remaining) },
        ],
      },
    } });
    const request = await deleteSource(actor, { workspaceId: workspace.id, sourceId: removed.id });
    if (request.status !== "pending") throw new Error("Expected a regeneration job.");
    await prisma.workflowJob.update({ where: { id: request.jobId }, data: { status: "RUNNING" } });
    await generateBrainSourceRemovalCandidate({ workspaceId: workspace.id, jobId: request.jobId, expectedAttempt: 0, expectedOwner: null,
      generate: async () => "Proposed replacement",
    });
    await prisma.workflowJob.update({ where: { id: request.jobId }, data: { status: "COMPLETED" } });
    await prisma.brainArticle.update({ where: { id: article.id }, data: { bodyMd: "New human revision", humanEditedAt: new Date() } });
    await expect(resolveBrainSourceRemoval(actor, { workspaceId: workspace.id, jobId: request.jobId, decision: "accept" }))
      .rejects.toMatchObject({ status: 409, code: "SOURCE_CHANGED" });
    expect((await prisma.brainArticle.findUniqueOrThrow({ where: { id: article.id } })).bodyMd).toBe("New human revision");
    expect((await prisma.brainSource.findUniqueOrThrow({ where: { id: removed.id } })).archivedAt).toBeNull();
    const refreshed = await deleteSource(actor, { workspaceId: workspace.id, sourceId: removed.id });
    expect(refreshed.jobId).not.toBe(request.jobId);
  });

  it("does not let an obsolete worker overwrite a rejected candidate", async () => {
    const { workspace, actor, removed, remaining } = await fixture();
    await prisma.brainArticle.create({ data: {
      workspaceId: workspace.id, slug: "reclaim", title: "Reclaim article", type: "PROJECT", bodyMd: "Original",
      sourceIds: [removed.id, remaining.id], derivationJson: {
        version: 1, origin: "brain-absorb", agentRunId: "synthetic-run", sources: [
          { sourceId: removed.id, fingerprint: brainSourceContentFingerprint(removed) },
          { sourceId: remaining.id, fingerprint: brainSourceContentFingerprint(remaining) },
        ],
      },
    } });
    const request = await deleteSource(actor, { workspaceId: workspace.id, sourceId: removed.id });
    if (request.status !== "pending") throw new Error("Expected a regeneration job.");
    await prisma.workflowJob.update({ where: { id: request.jobId }, data: { status: "RUNNING", attempts: 1, lockedBy: "worker-old" } });
    let releaseFirst!: () => void;
    let firstEntered!: () => void;
    const holdFirst = new Promise<void>((resolve) => { releaseFirst = resolve; });
    const entered = new Promise<void>((resolve) => { firstEntered = resolve; });
    const first = generateBrainSourceRemovalCandidate({ workspaceId: workspace.id, jobId: request.jobId, expectedAttempt: 1, expectedOwner: "worker-old",
      generate: async () => { firstEntered(); await holdFirst; return "Old proposal"; },
    });
    await entered;
    await prisma.workflowJob.update({ where: { id: request.jobId }, data: { attempts: 2, lockedBy: "worker-new" } });
    expect(await generateBrainSourceRemovalCandidate({ workspaceId: workspace.id, jobId: request.jobId,
      expectedAttempt: 1, expectedOwner: "worker-old", generate: async () => { throw new Error("Obsolete worker reached the model"); },
    })).toEqual({ phase: "SUPERSEDED" });
    expect(await generateBrainSourceRemovalCandidate({ workspaceId: workspace.id, jobId: request.jobId, expectedAttempt: 2, expectedOwner: "worker-new",
      generate: async () => "New proposal",
    })).toEqual({ phase: "READY", candidateCount: 1 });
    await prisma.workflowJob.update({ where: { id: request.jobId }, data: { status: "COMPLETED" } });
    await resolveBrainSourceRemoval(actor, { workspaceId: workspace.id, jobId: request.jobId, decision: "reject" });
    releaseFirst();
    expect(await first).toEqual({ phase: "SUPERSEDED" });
    const payload = (await prisma.workflowJob.findUniqueOrThrow({ where: { id: request.jobId } })).payload as { phase: string; candidates: Record<string, string> };
    expect(payload.phase).toBe("REJECTED");
    expect(Object.values(payload.candidates)).toEqual(["New proposal"]);
  });
});
