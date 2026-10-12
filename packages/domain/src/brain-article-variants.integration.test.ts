import { randomUUID } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { prisma, type AppActor } from "@corgtex/shared";
import { defaultModelGateway } from "@corgtex/models";
import { truncateAllTables } from "../../shared/src/db-test-utils";
import { syncBrainArticleKnowledge } from "../../knowledge/src/chunks";
import { fetchReadableKnowledgeChunk, searchIndexedKnowledge } from "../../knowledge/src/retrieval";
import { createArticle, getArticle, listArticles, publishArticle, updateArticle } from "./brain";
import { brainSourceContentFingerprint } from "./brain-derivation";
import { readableArtifactIds, recordArtifactInputLineage } from "./source-lineage";
import { BRAIN_ARTICLE_VARIANT_JOB_TYPE, generateBrainArticleVariant, getReadableBrainArticleVariant,
  requestBrainArticleVariant, type PermittedVariantSource } from "./brain-article-variants";

async function fixture() {
  const workspace = await prisma.workspace.create({ data: { name: "Synthetic variant workspace", slug: `variants-${randomUUID()}` } });
  const foreign = await prisma.workspace.create({ data: { name: "Synthetic foreign workspace", slug: `variants-foreign-${randomUUID()}` } });
  const owner = await prisma.user.create({ data: { email: `variants-owner-${randomUUID()}@example.test`, passwordHash: "synthetic" } });
  const reader = await prisma.user.create({ data: { email: `variants-reader-${randomUUID()}@example.test`, passwordHash: "synthetic" } });
  const ownerMember = await prisma.member.create({ data: { workspaceId: workspace.id, userId: owner.id, role: "ADMIN" } });
  const readerMember = await prisma.member.create({ data: { workspaceId: workspace.id, userId: reader.id, role: "CONTRIBUTOR" } });
  await prisma.member.create({ data: { workspaceId: foreign.id, userId: reader.id, role: "ADMIN" } });
  await prisma.workspaceFeatureFlag.create({ data: { workspaceId: workspace.id, flag: "FINANCE", enabled: true } });
  const ownerActor: AppActor = { kind: "user", user: { id: owner.id, email: owner.email, displayName: null, globalRole: "USER" } };
  const readerActor: AppActor = { kind: "user", user: { id: reader.id, email: reader.email, displayName: null, globalRole: "USER" } };
  const publicSource = await prisma.brainSource.create({ data: { workspaceId: workspace.id, sourceType: "DOC", tier: 1,
    title: "Allowed launch planning", content: "Public launch planning facts for the permitted article.", accessDomain: "WORKSPACE" } });
  const financeOriginal = await createArticle(ownerActor, { workspaceId: workspace.id, slug: "private-finance-original",
    title: "PRIVATE FINANCE ORIGINAL CANARY", bodyMd: "PRIVATE FINANCE FACT CANARY", type: "STRATEGY",
    isPrivate: true, ownerMemberId: ownerMember.id, authority: "DRAFT" });
  // Finance's module defaults permit ordinary members to read the module. This
  // copied Finance source additionally retains the author's private original.
  const financeSource = await prisma.brainSource.create({ data: { workspaceId: workspace.id, sourceType: "CONVERSATION", tier: 3,
    accessDomain: "FINANCE", title: "PRIVATE FINANCE SOURCE CANARY", content: financeOriginal.bodyMd } });
  await prisma.$transaction((tx) => recordArtifactInputLineage({ tx, actor: ownerActor, workspaceId: workspace.id,
    artifact: { kind: "BrainSource", id: financeSource.id }, content: financeSource, origin: "DERIVED",
    inputs: [{ kind: "BrainArticle", id: financeOriginal.id }] }));
  const canonical = await createArticle(ownerActor, { workspaceId: workspace.id, slug: "broad-finance-canonical",
    title: "PRIVATE CANONICAL TITLE CANARY", type: "PROJECT", authority: "REFERENCE", isPrivate: false,
    bodyMd: `${publicSource.content}\n\n${financeOriginal.bodyMd}`, sourceIds: [publicSource.id, financeSource.id],
    frontmatterJson: { also: ["PRIVATE CANONICAL ALIAS CANARY"] } });
  return { workspace, foreign, owner, reader, ownerMember, readerMember, ownerActor, readerActor,
    publicSource, financeSource, financeOriginal, canonical };
}

type Fixture = Awaited<ReturnType<typeof fixture>>;
const previousEncryptionKey = process.env.ENCRYPTION_KEY;

async function claim(f: Fixture, expectedAttempt = 1, expectedOwner = "fixture-worker") {
  const requested = await requestBrainArticleVariant(f.readerActor, { workspaceId: f.workspace.id, articleId: f.canonical.id });
  if (requested.status !== "pending") throw new Error(`Expected a pending variant: ${requested.status}`);
  await prisma.workflowJob.update({ where: { id: requested.jobId }, data: {
    status: "RUNNING", attempts: expectedAttempt, lockedBy: expectedOwner,
  } });
  return { workspaceId: f.workspace.id, jobId: requested.jobId, expectedAttempt, expectedOwner };
}

async function generateVariant(f: Fixture) {
  const lease = await claim(f);
  const generate = vi.fn(async (sources: PermittedVariantSource[]) => {
    expect(sources.map((source) => source.id)).toEqual([f.publicSource.id]);
    expect(JSON.stringify(sources)).not.toContain("PRIVATE");
    return { title: "Permitted launch planning", bodyMd: "Public launch planning facts for the permitted article." };
  });
  const generated = await generateBrainArticleVariant({ ...lease, generate });
  if (generated.phase !== "APPLIED" || !generated.articleId) throw new Error(`Expected an applied variant: ${generated.phase}`);
  const variant = await prisma.brainArticle.findUniqueOrThrow({ where: { id: generated.articleId } });
  return { lease, variant, generate };
}

async function archiveAndRestoreSource(f: Fixture) {
  const archivedAt = new Date();
  const history = await prisma.$transaction(async (tx) => {
    await tx.brainSource.update({ where: { id: f.publicSource.id }, data: { archivedAt } });
    return tx.workspaceArchiveRecord.create({ data: { workspaceId: f.workspace.id, entityType: "BrainSource",
      entityId: f.publicSource.id, archivedAt, archivedByUserId: f.owner.id, archiveReason: "Synthetic restore regression" } });
  });
  await prisma.$transaction(async (tx) => {
    await tx.brainSource.update({ where: { id: f.publicSource.id }, data: { archivedAt: null } });
    await tx.workspaceArchiveRecord.update({ where: { id: history.id }, data: { restoredAt: new Date(), restoredByUserId: f.owner.id } });
  });
}

describe("permitted article variants across real read/write boundaries", () => {
  beforeEach(async () => {
    // A synthetic key enables disposable cache fixtures without external credentials.
    process.env.ENCRYPTION_KEY ??= "1".repeat(64);
    await truncateAllTables();
  });
  afterEach(() => {
    vi.restoreAllMocks();
    if (previousEncryptionKey === undefined) delete process.env.ENCRYPTION_KEY;
    else process.env.ENCRYPTION_KEY = previousEncryptionKey;
  });

  it("enqueues denied canonicals automatically, serves a separate owned variant, and redacts internal recipe metadata", async () => {
    const f = await fixture();
    await expect(getArticle(f.readerActor, { workspaceId: f.workspace.id, slug: f.canonical.slug }))
      .rejects.toMatchObject({ status: 404, code: "NOT_FOUND" });
    const initialList = await listArticles(f.readerActor, { workspaceId: f.workspace.id, take: 1 });
    expect(initialList).toMatchObject({ items: [], total: 0 });
    expect(await prisma.workflowJob.count({ where: { workspaceId: f.workspace.id, type: BRAIN_ARTICLE_VARIANT_JOB_TYPE } })).toBe(1);
    const { variant, lease } = await generateVariant(f);
    const body = await getArticle(f.readerActor, { workspaceId: f.workspace.id, slug: f.canonical.slug });
    expect(body).toMatchObject({ id: variant.id, title: "Permitted launch planning", isPrivate: true,
      ownerMemberId: f.readerMember.id, isPermissionVariant: true,
      variantOfArticleId: null, variantTargetFingerprint: null, variantInputSetHash: null,
      variantSourceStateJson: null, variantGenerationJobId: null });
    expect(JSON.stringify(body)).not.toContain("PRIVATE");
    expect(body.slug).not.toBe(f.canonical.slug);
    const list = await listArticles(f.readerActor, { workspaceId: f.workspace.id, take: 1 });
    expect(list.total).toBe(1);
    expect(list.items.map((article) => article.id)).toEqual([variant.id]);
    expect(JSON.stringify(list)).not.toContain(f.financeSource.id);
    expect(JSON.stringify(list)).not.toContain("PRIVATE");
    const broad = await getArticle(f.ownerActor, { workspaceId: f.workspace.id, slug: f.canonical.slug });
    expect(broad.id).toBe(f.canonical.id);
    expect(broad.bodyMd).toContain("PRIVATE FINANCE FACT CANARY");
    await expect(getArticle(f.ownerActor, { workspaceId: f.workspace.id, slug: variant.slug }))
      .rejects.toMatchObject({ status: 404 });
    expect((await listArticles(f.ownerActor, { workspaceId: f.workspace.id })).items.map((article) => article.id)).not.toContain(variant.id);
    expect((await listArticles(f.readerActor, { workspaceId: f.foreign.id })).total).toBe(0);
    expect(await requestBrainArticleVariant(f.readerActor, { workspaceId: f.foreign.id, articleId: f.canonical.id }))
      .toEqual({ status: "unavailable" });
    expect(await prisma.brainArticle.findUniqueOrThrow({ where: { id: f.canonical.id } })).toMatchObject({
      title: f.canonical.title, bodyMd: f.canonical.bodyMd, frontmatterJson: f.canonical.frontmatterJson, sourceIds: f.canonical.sourceIds,
    });
    expect(await prisma.artifactInputLineage.findFirst({ where: { artifactId: variant.id }, orderBy: { revision: "desc" } }))
      .toMatchObject({ origin: "DERIVED", rootsJson: [{ kind: "BrainSource", id: f.publicSource.id,
        fingerprint: brainSourceContentFingerprint(f.publicSource) }] });
    const job = await prisma.workflowJob.findUniqueOrThrow({ where: { id: lease.jobId } });
    expect(JSON.stringify(job.payload)).not.toContain("PRIVATE");
    expect(JSON.stringify(job.payload)).not.toContain("Public launch planning facts");
    await expect(updateArticle(f.readerActor, { workspaceId: f.workspace.id, slug: variant.slug, bodyMd: "Changed" }))
      .rejects.toMatchObject({ code: "IMMUTABLE_VARIANT" });
    await expect(publishArticle(f.readerActor, { workspaceId: f.workspace.id, slug: variant.slug }))
      .rejects.toMatchObject({ code: "IMMUTABLE_VARIANT" });
  });

  it("preserves unknown legacy bodies and independently authored originals without guessing citation receipts", async () => {
    const f = await fixture();
    const unknown = await prisma.brainArticle.create({ data: { workspaceId: f.workspace.id, slug: "unknown-original",
      title: "Unknown original", bodyMd: "Unclassified historical body", type: "PROJECT", sourceIds: [f.publicSource.id] } });
    const original = await createArticle(f.ownerActor, { workspaceId: f.workspace.id, slug: "known-original", title: "Known original",
      bodyMd: "Independent original body", type: "PROJECT", authority: "REFERENCE", isPrivate: false });
    expect(await requestBrainArticleVariant(f.readerActor, { workspaceId: f.workspace.id, articleId: unknown.id }))
      .toEqual({ status: "unavailable" });
    expect(await requestBrainArticleVariant(f.readerActor, { workspaceId: f.workspace.id, articleId: original.id }))
      .toEqual({ status: "original" });
    expect(await prisma.workflowJob.count({ where: { workspaceId: f.workspace.id, type: BRAIN_ARTICLE_VARIANT_JOB_TYPE } })).toBe(0);
    expect(await prisma.brainArticle.findUniqueOrThrow({ where: { id: unknown.id } })).toMatchObject({ bodyMd: "Unclassified historical body" });
    expect(await prisma.artifactInputLineage.count({ where: { artifactId: unknown.id } })).toBe(0);
  });

  it("rejects generation after source privacy changes and after membership revocation", async () => {
    const f = await fixture();
    const lease = await claim(f);
    expect(await generateBrainArticleVariant({ ...lease, generate: async () => {
      await prisma.brainSource.update({ where: { id: f.publicSource.id }, data: { accessDomain: "FINANCE" } });
      return { title: "Stale source candidate", bodyMd: "Never accepted." };
    } })).toEqual({ phase: "STALE" });
    expect(await prisma.brainArticle.count({ where: { variantOfArticleId: f.canonical.id } })).toBe(0);
    await prisma.brainSource.update({ where: { id: f.publicSource.id }, data: { accessDomain: "WORKSPACE" } });
    const retry = await claim(f, 2);
    expect(await generateBrainArticleVariant({ ...retry, generate: async () => {
      await prisma.member.update({ where: { id: f.readerMember.id }, data: { isActive: false } });
      return { title: "Revoked member candidate", bodyMd: "Never accepted." };
    } })).toEqual({ phase: "STALE" });
    expect(await prisma.brainArticle.count({ where: { variantOfArticleId: f.canonical.id } })).toBe(0);
    await expect(getArticle(f.readerActor, { workspaceId: f.workspace.id, slug: f.canonical.slug }))
      .rejects.toMatchObject({ code: "NOT_A_MEMBER" });
  });

  it("withholds an old variant after source restore and creates a new immutable recipe instead of resurrecting it", async () => {
    const f = await fixture();
    const before = await generateVariant(f);
    await archiveAndRestoreSource(f);
    expect(await getReadableBrainArticleVariant(f.readerActor, { workspaceId: f.workspace.id, articleId: f.canonical.id })).toBeNull();
    await expect(getArticle(f.readerActor, { workspaceId: f.workspace.id, slug: before.variant.slug }))
      .rejects.toMatchObject({ status: 404 });
    expect((await listArticles(f.readerActor, { workspaceId: f.workspace.id })).total).toBe(0);
    const after = await generateVariant(f);
    expect(after.variant.id).not.toBe(before.variant.id);
    expect(after.lease.jobId).not.toBe(before.lease.jobId);
    expect(after.variant.variantInputSetHash).not.toBe(before.variant.variantInputSetHash);
    expect((await listArticles(f.readerActor, { workspaceId: f.workspace.id })).items.map((article) => article.id)).toEqual([after.variant.id]);
    expect(await prisma.brainArticle.findUniqueOrThrow({ where: { id: before.variant.id } })).toMatchObject({
      bodyMd: before.variant.bodyMd, archivedAt: null, variantInputSetHash: before.variant.variantInputSetHash,
    });
  });

  it("does not let an obsolete worker accept content over a later successful attempt", async () => {
    const f = await fixture();
    const lease = await claim(f);
    let entered!: () => void;
    let release!: () => void;
    const waiting = new Promise<void>((resolve) => { entered = resolve; });
    const held = new Promise<void>((resolve) => { release = resolve; });
    const old = generateBrainArticleVariant({ ...lease, generate: async () => {
      entered(); await held; return { title: "Old attempt", bodyMd: "Obsolete output" };
    } });
    await waiting;
    await prisma.workflowJob.update({ where: { id: lease.jobId }, data: { attempts: 2, lockedBy: "worker-new" } });
    const current = await generateBrainArticleVariant({ ...lease, expectedAttempt: 2, expectedOwner: "worker-new",
      generate: async () => ({ title: "Current attempt", bodyMd: "Current permitted facts" }) });
    release();
    expect(await old).toEqual({ phase: "SUPERSEDED" });
    expect(current.phase).toBe("APPLIED");
    expect(await prisma.brainArticle.findMany({ where: { variantOfArticleId: f.canonical.id } }))
      .toMatchObject([{ title: "Current attempt", bodyMd: "Current permitted facts" }]);
  });

  it("indexes an owner-only variant and gates search cache and chunk redemption after source and member changes", async () => {
    const f = await fixture();
    const { variant } = await generateVariant(f);
    vi.spyOn(defaultModelGateway, "embed").mockImplementation(async ({ input }) => ({
      embeddings: (Array.isArray(input) ? input : [input]).map(() => [1, 0]), usage: { provider: "fixture", model: "fixture-embed" },
    }));
    vi.spyOn(defaultModelGateway, "rerank").mockImplementation(async ({ documents }) => ({
      results: documents.map((document, index) => ({ index, score: 1, document })), usage: { provider: "fixture", model: "fixture-rerank" },
    }));
    expect(await syncBrainArticleKnowledge({ workspaceId: f.workspace.id, articleId: variant.id })).toBe(1);
    expect(await syncBrainArticleKnowledge({ workspaceId: f.workspace.id, articleId: f.canonical.id })).toBe(1);
    const query = { actor: f.readerActor, workspaceId: f.workspace.id, query: "public launch planning", sourceTypes: ["BRAIN_ARTICLE" as const] };
    const results = await searchIndexedKnowledge(query);
    expect(results.map((result) => result.sourceId)).toEqual([variant.id]);
    expect(JSON.stringify(results)).not.toContain("PRIVATE");
    expect((await searchIndexedKnowledge({ ...query, actor: f.ownerActor })).map((result) => result.sourceId)).toEqual([f.canonical.id]);
    expect(await searchIndexedKnowledge({ ...query, workspaceId: f.foreign.id })).toEqual([]);
    const chunk = await prisma.knowledgeChunk.findFirstOrThrow({ where: { sourceId: variant.id } });
    expect(await fetchReadableKnowledgeChunk(f.readerActor, f.workspace.id, chunk.id)).toMatchObject({ id: chunk.id });
    expect(await fetchReadableKnowledgeChunk(f.ownerActor, f.workspace.id, chunk.id)).toBeNull();
    await archiveAndRestoreSource(f);
    expect(await searchIndexedKnowledge(query)).toEqual([]);
    expect(await fetchReadableKnowledgeChunk(f.readerActor, f.workspace.id, chunk.id)).toBeNull();
    const row = await prisma.brainArticle.findUniqueOrThrow({ where: { id: variant.id } });
    expect(await readableArtifactIds(f.readerActor, f.workspace.id, "BrainArticle", [row])).toEqual(new Set());
    await prisma.member.update({ where: { id: f.readerMember.id }, data: { isActive: false } });
    await expect(searchIndexedKnowledge(query)).rejects.toMatchObject({ code: "NOT_A_MEMBER" });
  });
});
