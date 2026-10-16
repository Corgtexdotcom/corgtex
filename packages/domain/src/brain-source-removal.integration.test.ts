import { randomUUID } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Prisma } from "@prisma/client";
import { mcpCredentialVersion, prisma, type AppActor } from "@corgtex/shared";
import { defaultModelGateway } from "@corgtex/models";
import { truncateAllTables } from "../../shared/src/db-test-utils";
import { searchIndexedKnowledge } from "../../knowledge/src/retrieval";
import { syncBrainArticleKnowledge } from "../../knowledge/src/chunks";
import { createArticle, deleteSource, updateArticle } from "./brain";
import { brainSourceContentFingerprint } from "./brain-derivation";
import { archiveWorkspaceArtifact, restoreWorkspaceArtifact } from "./archive";
import { advanceHumanArtifactInputLineage, captureArtifactInputProof, captureArtifactInputSnapshotProof, currentArtifactInputRoots, currentArtifactInputRootsBatch, readableArtifactIds, recordArtifactInputLineage } from "./source-lineage";
import {
  generateBrainSourceRemovalCandidate,
  listBrainSourceRemovalReviews,
  resolveBrainSourceRemoval,
  retryBrainSourceRemoval,
  requestBrainSourceRemoval,
} from "./brain-source-removal";

async function fixture(sourceRemovalEnabled = true) {
  const workspace = await prisma.workspace.create({ data: { name: "Removal fixture", slug: `removal-${randomUUID()}` } });
  if (sourceRemovalEnabled) await prisma.workspaceFeatureFlag.create({ data: {
    workspaceId: workspace.id, flag: "BRAIN_SOURCE_REMOVAL", enabled: true,
  } });
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
  await prisma.$transaction(async tx => {
    for (const source of [removed, remaining]) await recordArtifactInputLineage({ tx, actor, workspaceId: workspace.id,
      artifact: { kind: "BrainSource", id: source.id }, content: source, origin: "HUMAN_ORIGINAL", inputs: [] });
  });
  return { workspace, actor, member, removed, remaining };
}

async function updateAuthoredSource(actor: AppActor, id: string, data: Prisma.BrainSourceUpdateInput) {
  return prisma.$transaction(async tx => {
    const before = await tx.brainSource.findUniqueOrThrow({ where: { id } });
    const after = await tx.brainSource.update({ where: { id }, data });
    await advanceHumanArtifactInputLineage({ tx, actor, workspaceId: after.workspaceId,
      artifact: { kind: "BrainSource", id }, before, after });
    return after;
  });
}

async function attestArticle(actor: AppActor, workspaceId: string, articleId: string, sourceIds: string[]) {
  await prisma.$transaction(async (tx) => {
    const article = await tx.brainArticle.findUniqueOrThrow({ where: { id: articleId } });
    await recordArtifactInputLineage({ tx, actor, workspaceId,
      artifact: { kind: "BrainArticle", id: article.id }, content: article, origin: "DERIVED",
      inputs: sourceIds.map((id) => ({ kind: "BrainSource", id })),
    });
  });
}

const runtimeOptIn = "BRAIN_SOURCE_REMOVAL_RUNTIME_ENABLED";
const previousRuntimeOptIn = process.env[runtimeOptIn];

describe("Brain source removal review", () => {
  beforeEach(async () => {
    process.env[runtimeOptIn] = "true";
    await truncateAllTables();
  });
  afterEach(() => {
    if (previousRuntimeOptIn === undefined) delete process.env[runtimeOptIn];
    else process.env[runtimeOptIn] = previousRuntimeOptIn;
  });

  it.each(["source", "claim", "none"].flatMap(change => [0, 1].map(priorSends => ({ change, priorSends }))))(
    "provider attempt guards removal $change after $priorSends sends", async ({ change, priorSends }) => {
      const { workspace, actor, removed, remaining } = await fixture();
      const article = await prisma.brainArticle.create({ data: { workspaceId: workspace.id, slug: "attempt-guard",
        title: "Two sources", type: "PROJECT", bodyMd: "Original facts", sourceIds: [removed.id, remaining.id],
        derivationJson: { version: 1, origin: "brain-absorb", agentRunId: "synthetic-run", sources: [
          { sourceId: removed.id, fingerprint: brainSourceContentFingerprint(removed) },
          { sourceId: remaining.id, fingerprint: brainSourceContentFingerprint(remaining) }] } } });
      await attestArticle(actor, workspace.id, article.id, [removed.id, remaining.id]);
      const request = await deleteSource(actor, { workspaceId: workspace.id, sourceId: removed.id });
      if (request.status !== "pending") throw new Error("Expected pending regeneration");
      await prisma.workflowJob.update({ where: { id: request.jobId }, data: {
        status: "RUNNING", attempts: 1, lockedBy: "worker", lockedAt: new Date(), startedAt: new Date() } });
      let sends = 0;
      const result = await generateBrainSourceRemovalCandidate({ workspaceId: workspace.id, jobId: request.jobId,
        expectedAttempt: 1, expectedOwner: "worker", generate: async (_article, _sources, controls) => {
          if (priorSends) { await controls?.authorizeAttempt({ signal: controls.signal }); sends++; }
          if (change === "source") {
            await prisma.brainSource.update({ where: { id: remaining.id }, data: { archivedAt: new Date() } });
            await prisma.brainSource.update({ where: { id: remaining.id }, data: { archivedAt: null } });
          }
          if (change === "claim") await prisma.workflowJob.update({ where: { id: request.jobId }, data: { attempts: 2, lockedBy: "replacement" } });
          await controls?.authorizeAttempt({ signal: controls.signal }); sends++;
          return "Remaining source facts";
        } }).catch(error => error);
      expect(sends).toBe(priorSends + (change === "none" ? 1 : 0));
      if (change === "none") expect(result).toEqual({ phase: "READY", candidateCount: 1 });
      else {
        expect(result).toBeInstanceOf(Error);
        expect(await prisma.agentRun.count({ where: { workspaceId: workspace.id, agentKey: "brain-source-regenerate" } })).toBe(0);
      }
      if (change === "claim") expect(await prisma.workflowJob.findUniqueOrThrow({ where: { id: request.jobId } }))
        .toMatchObject({ status: "RUNNING", attempts: 2, lockedBy: "replacement" });
    });

  it("batch discovery preserves canonical mismatch, latest same-body heads and snapshot tamper rejection", async () => {
    const {workspace, actor, removed, remaining} = await fixture();
    const article = await prisma.brainArticle.create({data: {workspaceId: workspace.id, slug: "batch-heads",
      title: "Head changes", type: "PROJECT", bodyMd: "Exact original body", sourceIds: [removed.id]}});
    await attestArticle(actor, workspace.id, article.id, [removed.id]);
    const read = async () => (await currentArtifactInputRootsBatch(prisma, workspace.id, "BrainArticle", [article])).get(article.id);
    expect(await read()).toEqual(await currentArtifactInputRoots(prisma, workspace.id, {kind: "BrainArticle", id: article.id}, article));
    await attestArticle(actor, workspace.id, article.id, [remaining.id]);
    expect((await read())?.some(root => root.kind === "BrainSource" && root.id === remaining.id)).toBe(true);
    const edited = await prisma.brainArticle.update({where: {id: article.id}, data: {bodyMd: "Unattested body"}});
    expect((await currentArtifactInputRootsBatch(prisma, workspace.id, "BrainArticle", [edited])).get(article.id)).toBeNull();
    await prisma.brainArticle.update({where: {id: article.id}, data: {bodyMd: article.bodyMd}});
    const snapshot = await prisma.$transaction(async tx => {
      const roots = await captureArtifactInputSnapshotProof(actor, workspace.id, {kind: "BrainSource", id: removed.id}, tx);
      await recordArtifactInputLineage({tx, actor, workspaceId: workspace.id, artifact: {kind: "BrainArticle", id: article.id},
        content: article, origin: "DERIVED", inputs: [], inheritedRoots: roots});
      return roots.find(root => root.kind === "ArtifactInputSnapshot")!;
    });
    await prisma.artifactInputSnapshot.update({where: {id: snapshot.id}, data: {rootsJson: []}});
    await expect(deleteSource(actor, {workspaceId: workspace.id, sourceId: removed.id})).rejects.toMatchObject({code: "UNCLASSIFIED_SOURCE_LINK"});
    expect((await prisma.brainSource.findUniqueOrThrow({where: {id: removed.id}})).archivedAt).toBeNull();
    expect((await prisma.brainArticle.findUniqueOrThrow({where: {id: article.id}})).archivedAt).toBeNull();
  });

  it("discovers one affected article among unrelated legacy and derived rows with bounded body/head queries", async () => {
    const {workspace, actor, removed, remaining} = await fixture();
    for (let offset = 0; offset < 5001; offset += 100) await prisma.brainArticle.createMany({data:
      Array.from({length: Math.min(100, 5001 - offset)}, (_, i) => ({workspaceId: workspace.id, slug: `unrelated-${offset+i}`,
        title: "Unrelated old original", bodyMd: "Unproved preserved historical bytes", type: "PROJECT"}))});
    for (let index = 0; index < 100; index++) {
      const article = await prisma.brainArticle.create({data: {workspaceId: workspace.id, slug: `derived-${index}`,
        title: "Independent derived article", bodyMd: "Remaining source facts", type: "PROJECT"}});
      await attestArticle(actor, workspace.id, article.id, [remaining.id]);
    }
    const affected = await prisma.brainArticle.create({data: {workspaceId: workspace.id, slug: "affected",
      title: "Affected article", bodyMd: "Removed facts", type: "PROJECT"}});
    await attestArticle(actor, workspace.id, affected.id, [removed.id]);
    let canonicalBodies = 0, articleHeads = 0;
    const start = performance.now();
    const result = await prisma.$transaction(async tx => {
      const instrumented = new Proxy(tx, {get(target, property) {
        if (property === "brainArticle") return new Proxy(target.brainArticle, {get(delegate, operation) {
          if (operation === "findMany") return async (query: Prisma.BrainArticleFindManyArgs) => {
            expect(query.where?.id).toHaveProperty("in");
            const filter = query.where?.id;
            if (!filter || typeof filter !== "object" || !Array.isArray(filter.in)) throw new Error("Expected bounded canonical article IDs");
            expect(filter.in.length).toBeLessThanOrEqual(100);
            const rows = await delegate.findMany(query); canonicalBodies += rows.length; return rows;
          };
          const value = Reflect.get(delegate, operation); return typeof value === "function" ? value.bind(delegate) : value;
        }});
        if (property === "artifactInputLineage") return new Proxy(target.artifactInputLineage, {get(delegate, operation) {
          if (operation === "findFirst") return async (query: Prisma.ArtifactInputLineageFindFirstArgs) => {
            if (query.where?.artifactType === "BrainArticle") articleHeads++;
            return delegate.findFirst(query);
          };
          const value = Reflect.get(delegate, operation); return typeof value === "function" ? value.bind(delegate) : value;
        }});
        const value = Reflect.get(target, property); return typeof value === "function" ? value.bind(target) : value;
      }});
      return requestBrainSourceRemoval(actor, {workspaceId: workspace.id, sourceId: removed.id, _tx: instrumented});
    }, {timeout: 120_000});
    expect(result.status).toBe("archived");
    expect(canonicalBodies).toBeLessThanOrEqual(302);
    expect(articleHeads).toBeLessThan(20);
    expect(await prisma.brainArticle.count({where: {workspaceId: workspace.id, archivedAt: null}})).toBe(5101);
    expect((await prisma.brainArticle.findUniqueOrThrow({where: {id: affected.id}})).archivedAt).not.toBeNull();
    console.info("removal-discovery", JSON.stringify({milliseconds: performance.now()-start, canonicalBodies, articleHeads, unrelatedLegacy: 5001, unrelatedDerived: 100}));
  });

  it("archives the derived composite while preserving its independently authored original version", async () => {
    const { workspace, actor, removed } = await fixture();
    const agent: AppActor = { kind: "agent", authProvider: "bootstrap", label: "brain-absorb", workspaceIds: [workspace.id] };
    const original = await createArticle(actor, { workspaceId: workspace.id, slug: "human-original",
      title: "Human original", type: "PROJECT", bodyMd: "Independently written body", authority: "DRAFT" });
    await expect(updateArticle(agent, { workspaceId: workspace.id, slug: original.slug,
      bodyMd: "Independently written body plus source", absorbedSource: {
        sourceId: removed.id, sourceFingerprint: brainSourceContentFingerprint(removed), agentRunId: "synthetic-run",
      }, agentRunId: "synthetic-run" })).rejects.toMatchObject({ code: "NOT_FOUND" });
    const completePromptInputs = await prisma.$transaction(async tx => [
      ...await captureArtifactInputSnapshotProof(actor, workspace.id, { kind: "BrainArticle", id: original.id }, tx),
      ...await captureArtifactInputSnapshotProof(actor, workspace.id, { kind: "BrainSource", id: removed.id }, tx),
    ]);
    // The actual owner approves the copied candidate with all pre-generation inputs.
    await updateArticle(actor, { workspaceId: workspace.id, slug: original.slug,
      bodyMd: "Independently written body plus source", sourceIds: [removed.id], additionalInputRoots: completePromptInputs });
    expect(await prisma.artifactInputLineage.findFirst({ where: { artifactType: "BrainArticle", artifactId: original.id },
      orderBy: { revision: "desc" } })).toMatchObject({ origin: "DERIVED" });
    await expect(deleteSource(actor, { workspaceId: workspace.id, sourceId: removed.id }))
      .resolves.toEqual({ id: removed.id, status: "archived" });
    const archived = await prisma.brainArticle.findUniqueOrThrow({ where: { id: original.id }, include: { versions: true } });
    expect(archived.archivedAt).toBeInstanceOf(Date);
    const originalVersion = archived.versions.find((version) => version.bodyMd === "Independently written body");
    expect(originalVersion).toBeDefined();
    expect(await prisma.artifactInputLineage.findFirst({ where: { artifactType: "BrainArticleVersion", artifactId: originalVersion!.id },
      orderBy: { revision: "desc" } })).toMatchObject({ origin: "HUMAN_ORIGINAL", rootsJson: [] });
    expect((await prisma.brainSource.findUniqueOrThrow({ where: { id: removed.id } })).archivedAt).toBeInstanceOf(Date);
  });

  it("defaults off for linked sources while generic archive stays guarded and unlinked archiving works", async () => {
    const { workspace, actor, removed, remaining } = await fixture(false);
    const article = await prisma.brainArticle.create({ data: {
      workspaceId: workspace.id, slug: "gated-source", title: "Gated source", type: "PROJECT",
      bodyMd: "Current body", sourceIds: [removed.id, remaining.id],
      derivationJson: { version: 1, origin: "brain-absorb", agentRunId: "synthetic-run", sources: [
        { sourceId: removed.id, fingerprint: brainSourceContentFingerprint(removed) },
        { sourceId: remaining.id, fingerprint: brainSourceContentFingerprint(remaining) },
      ] },
    } });
    await attestArticle(actor, workspace.id, article.id, [removed.id, remaining.id]);
    await expect(deleteSource(actor, { workspaceId: workspace.id, sourceId: removed.id }))
      .rejects.toMatchObject({ status: 409, code: "BRAIN_SOURCE_REMOVAL_DISABLED" });
    await expect(archiveWorkspaceArtifact(actor, { workspaceId: workspace.id, entityType: "BrainSource", entityId: removed.id }))
      .rejects.toMatchObject({ status: 409, code: "SOURCE_ARTICLE_IMPACT_REVIEW_REQUIRED" });
    const mcpActor: AppActor = { kind: "agent", authProvider: "credential", label: "Synthetic MCP caller",
      workspaceIds: [workspace.id], scopes: ["archive:write", "brain:write"] };
    await expect(archiveWorkspaceArtifact(mcpActor, { workspaceId: workspace.id, entityType: "BrainSource", entityId: removed.id }))
      .rejects.toMatchObject({ status: 409, code: "SOURCE_ARTICLE_IMPACT_REVIEW_REQUIRED" });
    expect(await prisma.workflowJob.count({ where: { workspaceId: workspace.id, type: "agent.brain-source-regenerate" } })).toBe(0);
    expect(await prisma.workspaceArchiveRecord.count({ where: { workspaceId: workspace.id } })).toBe(0);
    expect((await prisma.brainArticle.findUniqueOrThrow({ where: { id: article.id } })).archivedAt).toBeNull();
    expect((await prisma.brainSource.findUniqueOrThrow({ where: { id: removed.id } })).archivedAt).toBeNull();
    const unlinked = await prisma.brainSource.create({ data: {
      workspaceId: workspace.id, sourceType: "DOC", tier: 1, content: "Unlinked facts",
    } });
    await prisma.$transaction(tx => recordArtifactInputLineage({ tx, actor, workspaceId: workspace.id,
      artifact: { kind: "BrainSource", id: unlinked.id }, content: unlinked, origin: "HUMAN_ORIGINAL", inputs: [] }));
    expect(await deleteSource(actor, { workspaceId: workspace.id, sourceId: unlinked.id }))
      .toEqual({ id: unlinked.id, status: "archived" });
    await prisma.workspaceFeatureFlag.create({ data: {
      workspaceId: workspace.id, flag: "BRAIN_SOURCE_REMOVAL", enabled: true,
    } });
    const readCredential = await prisma.agentCredential.create({ data: { workspaceId: workspace.id,
      createdByUserId: actor.kind === "user" ? actor.user.id : null, label: "Brain-only reader", tokenHash: randomUUID(), scopes: ["brain:read"] } });
    const reader: AppActor = { kind: "agent", authProvider: "credential", label: readCredential.label,
      credentialId: readCredential.id, credentialVersion: mcpCredentialVersion(readCredential.tokenHash),
      workspaceIds: [workspace.id], scopes: readCredential.scopes };
    await expect(deleteSource(reader, { workspaceId: workspace.id, sourceId: removed.id }))
      .rejects.toMatchObject({ status: 403 });
    expect(await prisma.workflowJob.count({ where: { workspaceId: workspace.id, type: "agent.brain-source-regenerate" } })).toBe(0);
    delete process.env[runtimeOptIn];
    await expect(deleteSource(actor, { workspaceId: workspace.id, sourceId: removed.id }))
      .rejects.toMatchObject({ status: 409, code: "BRAIN_SOURCE_REMOVAL_DISABLED" });
    expect(await prisma.workflowJob.count({ where: { workspaceId: workspace.id, type: "agent.brain-source-regenerate" } })).toBe(0);
    process.env[runtimeOptIn] = "true";
    const requested = await deleteSource(actor, { workspaceId: workspace.id, sourceId: removed.id });
    expect(requested.status).toBe("pending");
    expect(await prisma.workflowJob.count({ where: { workspaceId: workspace.id, type: "agent.brain-source-regenerate" } })).toBe(1);
  });

  it("recoverably archives an article when its only verified source is removed, including a repeat request", async () => {
    const { workspace, actor, removed } = await fixture();
    const agent: AppActor = { kind: "agent", authProvider: "bootstrap", label: "brain-absorb", workspaceIds: [workspace.id] };
    const article = await createArticle(agent, {
      workspaceId: workspace.id, title: "One source article", type: "PROJECT", bodyMd: "Human reviewed body", isPrivate: false,
      completeInputRoots: await captureArtifactInputProof(agent, workspace.id, [{ kind: "BrainSource", id: removed.id }]),
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
    await attestArticle(actor, workspace.id, article.id, [removed.id, remaining.id]);
    const currentRemaining = await updateAuthoredSource(actor, remaining.id, { content: "Current remaining facts" });
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
    expect(review.articles).toMatchObject([{ id: article.id, title: "Article unavailable", currentBodyMd: null,
      candidateBodyMd: "Facts from remaining source only" }]);
    await updateAuthoredSource(actor, remaining.id, { content: "Changed after candidate generation" });
    const [staleReview] = await listBrainSourceRemovalReviews(actor, { workspaceId: workspace.id, sourceIds: [removed.id] });
    expect(staleReview.articles).toEqual([]);
    await updateAuthoredSource(actor, remaining.id, { content: "Current remaining facts" });
    process.env[runtimeOptIn] = "false";
    await expect(resolveBrainSourceRemoval(actor, { workspaceId: workspace.id, jobId: requested.jobId, decision: "accept" }))
      .rejects.toMatchObject({ status: 409, code: "BRAIN_SOURCE_REMOVAL_DISABLED" });
    expect((await prisma.brainArticle.findUniqueOrThrow({ where: { id: article.id } })).bodyMd).toBe("Human revised facts");
    process.env[runtimeOptIn] = "true";
    await prisma.workspaceFeatureFlag.update({ where: { workspaceId_flag: {
      workspaceId: workspace.id, flag: "BRAIN_SOURCE_REMOVAL",
    } }, data: { enabled: false } });
    await expect(resolveBrainSourceRemoval(actor, { workspaceId: workspace.id, jobId: requested.jobId, decision: "accept" }))
      .rejects.toMatchObject({ status: 409, code: "BRAIN_SOURCE_REMOVAL_DISABLED" });
    expect((await prisma.brainArticle.findUniqueOrThrow({ where: { id: article.id } })).bodyMd).toBe("Human revised facts");
    await prisma.workspaceFeatureFlag.update({ where: { workspaceId_flag: {
      workspaceId: workspace.id, flag: "BRAIN_SOURCE_REMOVAL",
    } }, data: { enabled: true } });
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
      const query = { actor, workspaceId: workspace.id, query: "Human revised facts", sourceTypes: ["BRAIN_ARTICLE" as const] };
      // Legacy manually written content and receipts have no complete lineage.
      expect(await searchIndexedKnowledge(query)).toEqual([]);
      expect(await resolveBrainSourceRemoval(actor, { workspaceId: workspace.id, jobId: requested.jobId, decision: "accept" }))
        .toEqual({ status: "applied", sourceId: removed.id, pendingSourceId: null });
      expect(await prisma.knowledgeChunk.count({ where: {
        workspaceId: workspace.id, sourceType: "BRAIN_ARTICLE", sourceId: article.id,
      } })).toBe(0);
      expect(await searchIndexedKnowledge(query)).toEqual([]);
      embed.mockRejectedValueOnce(new Error("synthetic indexing failure"));
      await expect(syncBrainArticleKnowledge({ workspaceId: workspace.id, articleId: article.id, lineageActor: actor }))
        .rejects.toThrow("synthetic indexing failure");
      expect(await searchIndexedKnowledge(query)).toEqual([]);
      expect(await syncBrainArticleKnowledge({ workspaceId: workspace.id, articleId: article.id, lineageActor: actor })).toBe(1);
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
    await attestArticle(actor, workspace.id, article.id, [removed.id, remaining.id]);
    const requested = await deleteSource(actor, { workspaceId: workspace.id, sourceId: removed.id });
    if (requested.status !== "pending") throw new Error("Expected a regeneration job.");
    await prisma.workflowJob.update({ where: { id: requested.jobId }, data: { status: "RUNNING" } });
    const stale = await generateBrainSourceRemovalCandidate({ workspaceId: workspace.id, jobId: requested.jobId, expectedAttempt: 0, expectedOwner: null,
      generate: async () => {
        await updateAuthoredSource(actor, remaining.id, { content: "Revised remaining facts" });
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

    await prisma.brainArticle.update({ where: { id: article.id }, data: { derivationJson: Prisma.JsonNull, bodyMd: "Unattested rewrite" } });
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
    await attestArticle(actor, workspace.id, article.id, [removed.id, remaining.id]);
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
    await attestArticle(actor, workspace.id, article.id, [removed.id, remaining.id]);
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
    await expect(deleteSource(actor, { workspaceId: workspace.id, sourceId: removed.id }))
      .rejects.toMatchObject({ status: 409, code: "UNCLASSIFIED_SOURCE_LINK" });
  });

  it("does not let an obsolete worker overwrite a rejected candidate", async () => {
    const { workspace, actor, removed, remaining } = await fixture();
    const article = await prisma.brainArticle.create({ data: {
      workspaceId: workspace.id, slug: "reclaim", title: "Reclaim article", type: "PROJECT", bodyMd: "Original",
      sourceIds: [removed.id, remaining.id], derivationJson: {
        version: 1, origin: "brain-absorb", agentRunId: "synthetic-run", sources: [
          { sourceId: removed.id, fingerprint: brainSourceContentFingerprint(removed) },
          { sourceId: remaining.id, fingerprint: brainSourceContentFingerprint(remaining) },
        ],
      },
    } });
    await attestArticle(actor, workspace.id, article.id, [removed.id, remaining.id]);
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
  it("preserves a proven human original while detaching citation-only source metadata", async () => {
    const { workspace, actor, removed } = await fixture();
    const article = await prisma.brainArticle.create({ data: { workspaceId: workspace.id,
      slug: "independent-original", title: "Human original", type: "PROJECT", bodyMd: "Original human work", sourceIds: [removed.id] } });
    await prisma.$transaction((tx) => recordArtifactInputLineage({ tx, actor, workspaceId: workspace.id,
      artifact: { kind: "BrainArticle", id: article.id }, content: article, origin: "HUMAN_ORIGINAL", inputs: [] }));
    await expect(deleteSource(actor, { workspaceId: workspace.id, sourceId: removed.id }))
      .resolves.toEqual({ id: removed.id, status: "archived" });
    expect(await prisma.brainArticle.findUniqueOrThrow({ where: { id: article.id } }))
      .toMatchObject({ bodyMd: "Original human work", archivedAt: null, sourceIds: [] });
    expect(await prisma.artifactInputLineage.findFirst({ where: { artifactId: article.id }, orderBy: { revision: "desc" } }))
      .toMatchObject({ origin: "HUMAN_ORIGINAL", rootsJson: [] });
  });

  it("rebuilds snapshot-derived content after exclusion archive without copying contaminated retained sources", async () => {
    const { workspace, actor, removed, remaining } = await fixture();
    const copied = await prisma.brainSource.create({ data: { workspaceId: workspace.id, sourceType: "CONVERSATION", tier: 3,
      title: "Contaminated copy", content: "Copied removed facts" } });
    await prisma.$transaction((tx) => recordArtifactInputLineage({ tx, actor, workspaceId: workspace.id,
      artifact: { kind: "BrainSource", id: copied.id }, content: copied, origin: "DERIVED", inputs: [{ kind: "BrainSource", id: removed.id }] }));
    const article = await prisma.brainArticle.create({ data: { workspaceId: workspace.id,
      slug: "snapshot-derived", title: "Withdrawn title", type: "PROJECT", bodyMd: "Old edited composite", humanEditedAt: new Date(), sourceIds: [] } });
    await prisma.$transaction(async (tx) => {
      const snapshot = await captureArtifactInputSnapshotProof(actor, workspace.id,
        { kind: "BrainSource", id: copied.id, fingerprint: brainSourceContentFingerprint(copied) }, tx);
      await recordArtifactInputLineage({ tx, actor, workspaceId: workspace.id,
        artifact: { kind: "BrainArticle", id: article.id }, content: article, origin: "DERIVED",
        inputs: [{ kind: "BrainSource", id: remaining.id }], inheritedRoots: snapshot });
    });
    const request = await deleteSource(actor, { workspaceId: workspace.id, sourceId: removed.id });
    if (request.status !== "pending") throw new Error("Expected candidate review");
    await archiveWorkspaceArtifact(actor, { workspaceId: workspace.id, entityType: "BrainArticle", entityId: article.id });
    await archiveWorkspaceArtifact(actor, { workspaceId: workspace.id, entityType: "BrainSource", entityId: removed.id });
    await restoreWorkspaceArtifact(actor, { workspaceId: workspace.id, entityType: "BrainArticle", entityId: article.id });
    await prisma.workflowJob.update({ where: { id: request.jobId }, data: { status: "RUNNING" } });
    const generate = vi.fn(async () => "Independent replacement");
    await expect(generateBrainSourceRemovalCandidate({ workspaceId: workspace.id, jobId: request.jobId,
      expectedAttempt: 0, expectedOwner: null, generate })).resolves.toEqual({ phase: "STALE" });
    expect(generate).not.toHaveBeenCalled();
    const oldJob = await prisma.workflowJob.update({ where: { id: request.jobId }, data: { status: "COMPLETED" } });
    const restoredArticle = await prisma.brainArticle.findUniqueOrThrow({ where: { id: article.id } });
    expect(await readableArtifactIds(actor, workspace.id, "BrainArticle", [restoredArticle])).toEqual(new Set());
    const fresh = await retryBrainSourceRemoval(actor, { workspaceId: workspace.id, jobId: request.jobId });
    if (fresh.status !== "pending") throw new Error("Expected a fresh canonical archived-exclusion recipe");
    expect(fresh.jobId).not.toBe(request.jobId);
    await prisma.workflowJob.update({ where: { id: fresh.jobId }, data: { status: "RUNNING" } });
    await expect(generateBrainSourceRemovalCandidate({ workspaceId: workspace.id, jobId: fresh.jobId,
      expectedAttempt: 0, expectedOwner: null, generate })).resolves.toEqual({ phase: "READY", candidateCount: 1 });
    expect(generate).toHaveBeenCalledWith({ id: article.id, title: remaining.title }, [expect.objectContaining({ id: remaining.id })]);
    await prisma.workflowJob.update({ where: { id: fresh.jobId }, data: { status: "COMPLETED" } });
    expect((await prisma.workflowJob.findUniqueOrThrow({ where: { id: request.jobId } })).payload).toEqual(oldJob.payload);
    const [review] = await listBrainSourceRemovalReviews(actor, { workspaceId: workspace.id, sourceIds: [removed.id] });
    expect(review.articles).toMatchObject([{ id: article.id, title: "Article unavailable", currentBodyMd: null,
      candidateTitle: remaining.title, candidateBodyMd: "Independent replacement" }]);
    expect(JSON.stringify(review)).not.toContain("Withdrawn title");
    await expect(resolveBrainSourceRemoval(actor, { workspaceId: workspace.id, jobId: fresh.jobId, decision: "accept" }))
      .resolves.toMatchObject({ status: "applied" });
    const updated = await prisma.brainArticle.findUniqueOrThrow({ where: { id: article.id }, include: { versions: true } });
    expect(updated).toMatchObject({ bodyMd: "Independent replacement", sourceIds: [remaining.id], title: remaining.title });
    expect(updated.versions).toMatchObject([{ bodyMd: "Old edited composite" }]);
    expect(await readableArtifactIds(actor, workspace.id, "BrainArticleVersion", updated.versions)).toEqual(new Set());
  });

  it("discovers historical manifest ancestry and uses only current independent retained content", async () => {
    const { workspace, actor, removed, remaining } = await fixture();
    const copied = await prisma.brainSource.create({ data: { workspaceId: workspace.id, sourceType: "CONVERSATION", tier: 3,
      title: "Old copy", content: "Old removed copy" } });
    await prisma.$transaction((tx) => recordArtifactInputLineage({ tx, actor, workspaceId: workspace.id,
      artifact: { kind: "BrainSource", id: copied.id }, content: copied, origin: "DERIVED", inputs: [{ kind: "BrainSource", id: removed.id }] }));
    const article = await prisma.brainArticle.create({ data: { workspaceId: workspace.id, slug: "historical-derived",
      title: "Old title", type: "PROJECT", bodyMd: "Historical generated body", sourceIds: [] } });
    await attestArticle(actor, workspace.id, article.id, [copied.id, remaining.id]);
    const fresh = await prisma.brainSource.update({ where: { id: copied.id }, data: { title: "Fresh copy", content: "Clean retained facts" } });
    await prisma.$transaction((tx) => recordArtifactInputLineage({ tx, actor, workspaceId: workspace.id,
      artifact: { kind: "BrainSource", id: copied.id }, content: fresh, origin: "DERIVED", inputs: [{ kind: "BrainSource", id: remaining.id }] }));
    const request = await deleteSource(actor, { workspaceId: workspace.id, sourceId: removed.id });
    if (request.status !== "pending") throw new Error("Expected candidate review");
    await prisma.workflowJob.update({ where: { id: request.jobId }, data: { status: "RUNNING" } });
    const generate = vi.fn(async (_article: { id: string; title: string }, _sources: Array<{ id: string; title: string | null; content: string }>) => "Clean output");
    await generateBrainSourceRemovalCandidate({ workspaceId: workspace.id, jobId: request.jobId, expectedAttempt: 0, expectedOwner: null, generate });
    expect(generate.mock.calls[0]?.[1]).toEqual(expect.arrayContaining([expect.objectContaining({ id: copied.id, content: "Clean retained facts" })]));
    expect(JSON.stringify(generate.mock.calls)).not.toContain("Old removed copy");
  });

  it("makes an archived exclusion stale on restore and refuses an implicit retry of the restored source", async () => {
    const { workspace, actor, removed, remaining } = await fixture();
    const article = await prisma.brainArticle.create({ data: { workspaceId: workspace.id, slug: "restore-race",
      title: "Derived", type: "PROJECT", bodyMd: "Before", sourceIds: [removed.id, remaining.id] } });
    await attestArticle(actor, workspace.id, article.id, [removed.id, remaining.id]);
    const request = await deleteSource(actor, { workspaceId: workspace.id, sourceId: removed.id });
    if (request.status !== "pending") throw new Error("Expected candidate review");
    await prisma.brainSource.update({ where: { id: removed.id }, data: { archivedAt: new Date() } });
    await prisma.workflowJob.update({ where: { id: request.jobId }, data: { status: "RUNNING" } });
    await expect(generateBrainSourceRemovalCandidate({ workspaceId: workspace.id, jobId: request.jobId,
      expectedAttempt: 0, expectedOwner: null, generate: async () => {
        await prisma.brainSource.update({ where: { id: removed.id }, data: { archivedAt: null } });
        return "Never commit";
      } })).resolves.toEqual({ phase: "STALE" });
    await prisma.workflowJob.update({ where: { id: request.jobId }, data: { status: "COMPLETED" } });
    await expect(retryBrainSourceRemoval(actor, { workspaceId: workspace.id, jobId: request.jobId }))
      .rejects.toMatchObject({ code: "SOURCE_CHANGED" });
    expect(await prisma.brainArticle.findUniqueOrThrow({ where: { id: article.id } })).toMatchObject({ bodyMd: "Before" });
  });

});
