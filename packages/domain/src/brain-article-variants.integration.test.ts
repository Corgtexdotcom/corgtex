import { randomUUID } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { prisma, type AppActor } from "@corgtex/shared";
import { defaultModelGateway } from "@corgtex/models";
import { truncateAllTables } from "../../shared/src/db-test-utils";
import { syncBrainArticleKnowledge } from "../../knowledge/src/chunks";
import { fetchReadableKnowledgeChunk, searchIndexedKnowledge } from "../../knowledge/src/retrieval";
import { createArticle, getArticle, listArticles, publishArticle, updateArticle } from "./brain";
import { brainSourceContentFingerprint } from "./brain-derivation";
import { captureArtifactInputProof, captureImmutableArtifactInputProof, readableArtifactIds, recordArtifactInputLineage, type LineageKind } from "./source-lineage";
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
  await prisma.$transaction((tx) => recordArtifactInputLineage({ tx, actor: ownerActor, workspaceId: workspace.id,
    artifact: { kind: "BrainSource", id: publicSource.id }, content: publicSource, origin: "HUMAN_ORIGINAL", inputs: [] }));
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

async function mixedFixture() {
  const f = await fixture();
  const document = await prisma.document.create({ data: { workspaceId: f.workspace.id, title: "Public native document",
    source: "SYNTHETIC", storageKey: "DO NOT PROMPT STORAGE KEY", textContent: "Public native document facts", metadata: { secret: "DO NOT PROMPT DOCUMENT METADATA" } } });
  const meeting = await prisma.meeting.create({ data: { workspaceId: f.workspace.id, title: "Public native meeting", source: "SYNTHETIC",
    recordedAt: new Date(), participantIds: [], transcript: "Public native transcript facts", summaryMd: "DO NOT PROMPT UNPROVEN SUMMARY" } });
  const installation = await prisma.communicationInstallation.create({ data: { workspaceId: f.workspace.id, provider: "SLACK",
    externalWorkspaceId: `synthetic-${randomUUID()}`, status: "ACTIVE" } });
  const channel = await prisma.communicationChannel.create({ data: { workspaceId: f.workspace.id, installationId: installation.id,
    provider: "SLACK", externalChannelId: "synthetic-public", name: "DO NOT PROMPT CHANNEL LABEL", kind: "PUBLIC", isIngestEnabled: true } });
  const message = await prisma.communicationMessage.create({ data: { workspaceId: f.workspace.id, installationId: installation.id,
    provider: "SLACK", externalChannelId: channel.externalChannelId, externalMessageId: `synthetic-${randomUUID()}`,
    text: "Public original communication facts", raw: { secret: "DO NOT PROMPT RAW PROVIDER" } } });
  const session = await prisma.conversationSession.create({ data: { workspaceId: f.workspace.id, userId: f.owner.id,
    topic: "DO NOT PROMPT SESSION TOPIC", systemPrompt: "DO NOT PROMPT UNKNOWN SYSTEM" } });
  const prompt = await prisma.conversationPromptInput.create({ data: { workspaceId: f.workspace.id, sessionId: session.id, userId: f.owner.id,
    content: "PRIVATE OWNER PROMPT CANARY" } });
  const ingress = await prisma.conversationIngressInput.create({ data: { workspaceId: f.workspace.id, actorKind: "user", userId: f.owner.id,
    content: "PRIVATE OWNER INGRESS CANARY" } });
  const request = await prisma.agentRequestInput.create({ data: { workspaceId: f.workspace.id, userId: f.owner.id, agentKey: "synthetic-original-request",
    prompt: "PRIVATE OWNER AGENT REQUEST CANARY" } });
  const original = await createArticle(f.ownerActor, { workspaceId: f.workspace.id, slug: "public-original-mixed",
    title: "Public human original article", bodyMd: "Public human original article facts", type: "STRATEGY", authority: "REFERENCE", isPrivate: false });
  const circle = await prisma.circle.create({ data: { workspaceId: f.workspace.id, name: "Public human circle", purposeMd: "Public human circle purpose", domainMd: "Public human circle domain" } });
  const role = await prisma.role.create({ data: { circleId: circle.id, name: "Public human role", purposeMd: "Public human role purpose",
    accountabilities: ["Public human accountability"], artifacts: ["Public human artifact"] } });
  const action = await prisma.action.create({ data: { workspaceId: f.workspace.id, authorUserId: f.owner.id, title: "Public human action",
    bodyMd: "Public human action facts", status: "OPEN", isPrivate: false, publishedAt: new Date() } });
  const tension = await prisma.tension.create({ data: { workspaceId: f.workspace.id, authorUserId: f.owner.id, title: "Public human tension",
    bodyMd: "Public human tension facts", status: "OPEN", isPrivate: false, publishedAt: new Date() } });
  const goal = await prisma.goal.create({ data: { workspaceId: f.workspace.id, authorUserId: f.owner.id, title: "Public human goal",
    descriptionMd: "Public human goal facts", status: "ACTIVE", isPrivate: false, publishedAt: new Date() } });
  for (const [kind, row] of [["Circle", circle], ["Role", role], ["Action", action], ["Tension", tension], ["Goal", goal]] as const) {
    // These records are freshly authored synthetic originals; there is no legacy or model body to certify.
    await prisma.$transaction((tx) => recordArtifactInputLineage({ tx, actor: f.ownerActor, workspaceId: f.workspace.id,
      artifact: { kind, id: row.id }, content: row, origin: "HUMAN_ORIGINAL", inputs: [] }));
  }
  const inputs: Array<{ kind: LineageKind; id: string }> = [
    { kind: "Document", id: document.id }, { kind: "MeetingTranscript", id: meeting.id }, { kind: "CommunicationMessage", id: message.id },
    { kind: "ConversationPromptInput", id: prompt.id }, { kind: "ConversationIngressInput", id: ingress.id }, { kind: "AgentRequestInput", id: request.id },
    { kind: "BrainArticle", id: original.id }, { kind: "BrainArticle", id: f.financeOriginal.id }, { kind: "Circle", id: circle.id },
    { kind: "Role", id: role.id }, { kind: "Action", id: action.id }, { kind: "Tension", id: tension.id }, { kind: "Goal", id: goal.id },
  ];
  const completeInputRoots = await captureArtifactInputProof(f.ownerActor, f.workspace.id, inputs);
  const canonical = await createArticle(f.ownerActor, { workspaceId: f.workspace.id, slug: "mixed-broad-canonical", type: "PROJECT", authority: "REFERENCE",
    isPrivate: false, title: "PRIVATE MIXED CANONICAL TITLE CANARY", bodyMd: "PRIVATE MIXED CANONICAL BODY CANARY",
    sourceIds: [f.publicSource.id], completeInputRoots });
  return { ...f, canonical, document, meeting, message, original, circle, role, action, tension, goal, prompt, ingress, request };
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

  it("excludes a readable source copied from the canonical's historical original body", async () => {
    const f = await fixture();
    const original = await createArticle(f.ownerActor, { workspaceId: f.workspace.id, slug: "historical-canonical",
      title: "OLD CANONICAL TITLE CANARY", bodyMd: "OLD CANONICAL BODY CANARY", type: "PROJECT", authority: "DRAFT", isPrivate: false });
    const historicalProof = await prisma.$transaction(async (tx) => {
      const roots = await captureArtifactInputProof(f.ownerActor, f.workspace.id, [{ kind: "BrainArticle", id: original.id }], tx);
      return captureImmutableArtifactInputProof(f.ownerActor, f.workspace.id, roots, tx);
    });
    const wrapper = await prisma.$transaction(async (tx) => {
      const source = await tx.brainSource.create({ data: { workspaceId: f.workspace.id, sourceType: "CONVERSATION", tier: 3,
        accessDomain: "WORKSPACE", title: original.title, content: original.bodyMd } });
      await recordArtifactInputLineage({ tx, actor: f.ownerActor, workspaceId: f.workspace.id,
        artifact: { kind: "BrainSource", id: source.id }, content: source, origin: "DERIVED", inputs: [], inheritedRoots: historicalProof });
      return source;
    });
    const canonical = await updateArticle(f.ownerActor, { workspaceId: f.workspace.id, slug: original.slug,
      title: "CURRENT PRIVATE CANONICAL TITLE CANARY", bodyMd: "CURRENT PRIVATE CANONICAL BODY CANARY",
      sourceIds: [f.publicSource.id, f.financeSource.id, wrapper.id] });
    // A historical human original remains legitimately readable through its immutable snapshot.
    // It still cannot supply this target's old body to the variant generator.
    expect((await readableArtifactIds(f.readerActor, f.workspace.id, "BrainSource", [wrapper])).has(wrapper.id)).toBe(true);
    expect((await readableArtifactIds(f.readerActor, f.workspace.id, "BrainArticle", [canonical])).has(canonical.id)).toBe(false);
    const { variant, generate } = await generateVariant({ ...f, canonical });
    expect(generate).toHaveBeenCalledOnce();
    expect(JSON.stringify(generate.mock.calls)).not.toContain("OLD CANONICAL");
    expect(variant.sourceIds).toEqual([f.publicSource.id]);
    expect(await prisma.brainSource.findUniqueOrThrow({ where: { id: wrapper.id } })).toMatchObject({
      title: original.title, content: original.bodyMd,
    });
    expect(await prisma.brainArticle.findUniqueOrThrow({ where: { id: canonical.id } })).toMatchObject({
      title: canonical.title, bodyMd: canonical.bodyMd, sourceIds: canonical.sourceIds,
    });
  });

  it("rebuilds a mixed canonical from current public native/original content while keeping owner prompts private", async () => {
    const f = await mixedFixture();
    const lease = await claim(f);
    const generate = vi.fn(async (sources: PermittedVariantSource[]) => {
      expect(sources.map((source) => source.kind).sort()).toEqual(["BrainSource", "Document", "MeetingTranscript", "CommunicationMessage", "BrainArticle", "Role", "Circle", "Action", "Tension", "Goal"].sort());
      expect(JSON.stringify(sources)).not.toContain("PRIVATE");
      expect(JSON.stringify(sources)).not.toContain("DO NOT PROMPT");
      expect(sources.find((source) => source.kind === "MeetingTranscript")?.content).toBe("Public native transcript facts");
      return { title: "Mixed permitted facts", bodyMd: "Public native document, transcript, message and original governance facts." };
    });
    const generated = await generateBrainArticleVariant({ ...lease, generate });
    expect(generated.phase).toBe("APPLIED");
    if (generated.phase !== "APPLIED") throw new Error("Expected applied mixed variant");
    const variant = await prisma.brainArticle.findUniqueOrThrow({ where: { id: generated.articleId } });
    expect(variant.sourceIds).toEqual([f.publicSource.id]);
    expect(variant.sourceIds).not.toContain(f.document.id);
    const manifest = await prisma.artifactInputLineage.findFirstOrThrow({ where: { artifactId: variant.id }, orderBy: { revision: "desc" } });
    expect(manifest.origin).toBe("DERIVED");
    expect(manifest.rootsJson).toEqual(expect.arrayContaining([
      expect.objectContaining({ kind: "Document", id: f.document.id }), expect.objectContaining({ kind: "MeetingTranscript", id: f.meeting.id }),
      expect.objectContaining({ kind: "CommunicationMessage", id: f.message.id }), expect.objectContaining({ kind: "Role", id: f.role.id }),
    ]));
    const job = await prisma.workflowJob.findUniqueOrThrow({ where: { id: lease.jobId } });
    expect(job.payload).toMatchObject({ version: 2, sources: expect.arrayContaining([{ kind: "Document", id: f.document.id, fingerprint: expect.any(String) }]) });
    const visible = await getArticle(f.readerActor, { workspaceId: f.workspace.id, slug: f.canonical.slug });
    expect(visible.id).toBe(variant.id);
    expect(JSON.stringify(visible)).not.toContain("PRIVATE");
    await expect(getArticle(f.ownerActor, { workspaceId: f.workspace.id, slug: variant.slug })).rejects.toMatchObject({ status: 404 });
    expect((await getArticle(f.ownerActor, { workspaceId: f.workspace.id, slug: f.canonical.slug })).id).toBe(f.canonical.id);
    expect(await prisma.brainArticle.findUniqueOrThrow({ where: { id: f.canonical.id } })).toMatchObject({ title: f.canonical.title, bodyMd: f.canonical.bodyMd, sourceIds: [f.publicSource.id] });
  });

  it("regenerates separate member variants from remaining native inputs after Document removal and restoration", async () => {
    const f = await mixedFixture();
    const firstLease = await claim(f);
    const first = await generateBrainArticleVariant({ ...firstLease, generate: async () => ({ title: "Initial mixed variant", bodyMd: "Public document and remaining facts." }) });
    if (first.phase !== "APPLIED") throw new Error("Expected initial variant");
    const firstVariant = await prisma.brainArticle.findUniqueOrThrow({ where: { id: first.articleId } });
    const history = await prisma.$transaction(async (tx) => {
      await tx.document.update({ where: { id: f.document.id }, data: { archivedAt: new Date() } });
      return tx.workspaceArchiveRecord.create({ data: { workspaceId: f.workspace.id, entityType: "Document", entityId: f.document.id,
        archivedByUserId: f.owner.id, archiveReason: "Synthetic native Document removal" } });
    });
    await expect(getArticle(f.readerActor, { workspaceId: f.workspace.id, slug: firstVariant.slug })).rejects.toMatchObject({ status: 404 });
    const remainingLease = await claim(f);
    const remaining = await generateBrainArticleVariant({ ...remainingLease, generate: async (sources) => {
      expect(sources.some((source) => source.kind === "Document")).toBe(false);
      expect(sources.some((source) => source.kind === "MeetingTranscript")).toBe(true);
      expect(JSON.stringify(sources)).not.toContain("PRIVATE");
      return { title: "Remaining public facts", bodyMd: "Public transcript, message and original facts." };
    } });
    if (remaining.phase !== "APPLIED") throw new Error("Expected remaining-source variant");
    expect(remaining.articleId).not.toBe(first.articleId);
    const ownerRequested = await requestBrainArticleVariant(f.ownerActor, { workspaceId: f.workspace.id, articleId: f.canonical.id });
    if (ownerRequested.status !== "pending") throw new Error("Expected independent owner recipe");
    await prisma.workflowJob.update({ where: { id: ownerRequested.jobId }, data: { status: "RUNNING", attempts: 1, lockedBy: "owner-worker" } });
    const ownerVariant = await generateBrainArticleVariant({ workspaceId: f.workspace.id, jobId: ownerRequested.jobId, expectedAttempt: 1, expectedOwner: "owner-worker", generate: async (sources) => {
      expect(sources.some((source) => source.kind === "Document")).toBe(false);
      expect(sources.map((source) => source.kind)).toEqual(expect.arrayContaining(["ConversationPromptInput", "ConversationIngressInput", "AgentRequestInput"]));
      expect(JSON.stringify(sources)).toContain("PRIVATE OWNER PROMPT CANARY");
      expect(JSON.stringify(sources)).not.toContain("PRIVATE MIXED CANONICAL");
      expect(JSON.stringify(sources)).not.toContain("DO NOT PROMPT SESSION");
      return { title: "Owner-only remaining facts", bodyMd: "PRIVATE OWNER FACTS" };
    } });
    expect(ownerVariant.phase).toBe("APPLIED");
    if (ownerVariant.phase !== "APPLIED") throw new Error("Expected owner variant");
    const ownerRow = await prisma.brainArticle.findUniqueOrThrow({ where: { id: ownerVariant.articleId } });
    await expect(getArticle(f.readerActor, { workspaceId: f.workspace.id, slug: ownerRow.slug })).rejects.toMatchObject({ status: 404 });
    await prisma.$transaction(async (tx) => {
      await tx.document.update({ where: { id: f.document.id }, data: { archivedAt: null } });
      await tx.workspaceArchiveRecord.update({ where: { id: history.id }, data: { restoredAt: new Date(), restoredByUserId: f.owner.id } });
    });
    await expect(getArticle(f.readerActor, { workspaceId: f.workspace.id, slug: firstVariant.slug })).rejects.toMatchObject({ status: 404 });
    const restoredLease = await claim(f);
    expect(restoredLease.jobId).not.toBe(firstLease.jobId);
    const restored = await generateBrainArticleVariant({ ...restoredLease, generate: async (sources) => {
      expect(sources.some((source) => source.kind === "Document")).toBe(true);
      return { title: "Fresh restored facts", bodyMd: "Public restored document and remaining facts." };
    } });
    expect(restored.phase).toBe("APPLIED");
    if (restored.phase !== "APPLIED") throw new Error("Expected restored variant");
    expect(restored.articleId).not.toBe(first.articleId);
    expect((await getArticle(f.readerActor, { workspaceId: f.workspace.id, slug: f.canonical.slug })).id).toBe(restored.articleId);
    expect(await prisma.brainArticle.findUniqueOrThrow({ where: { id: first.articleId } })).toMatchObject({ bodyMd: firstVariant.bodyMd, archivedAt: null });
    expect(await prisma.brainArticle.findUniqueOrThrow({ where: { id: f.canonical.id } })).toMatchObject({ bodyMd: "PRIVATE MIXED CANONICAL BODY CANARY" });
  });

  it("rejects mixed native source edits during generation and makes v1 queued jobs stale before generation", async () => {
    const f = await mixedFixture();
    const lease = await claim(f);
    const changed = await generateBrainArticleVariant({ ...lease, generate: async () => {
      await prisma.document.update({ where: { id: f.document.id }, data: { textContent: "Changed uncited Document facts" } });
      return { title: "Stale native candidate", bodyMd: "Never persisted." };
    } });
    expect(changed).toEqual({ phase: "STALE" });
    expect(await prisma.brainArticle.count({ where: { variantOfArticleId: f.canonical.id } })).toBe(0);
    const next = await claim(f);
    const job = await prisma.workflowJob.findUniqueOrThrow({ where: { id: next.jobId } });
    const payload = job.payload as any;
    await prisma.workflowJob.update({ where: { id: job.id }, data: { payload: { ...payload, version: 1,
      sources: payload.sources.filter((source: any) => source.kind === "BrainSource").map(({ id, fingerprint }: any) => ({ id, fingerprint })) } } });
    const generate = vi.fn();
    expect(await generateBrainArticleVariant({ ...next, generate })).toEqual({ phase: "STALE" });
    expect(generate).not.toHaveBeenCalled();
    expect(await prisma.brainArticle.count({ where: { variantOfArticleId: f.canonical.id } })).toBe(0);
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
