import { randomUUID } from "node:crypto";
import { beforeEach, describe, expect, it } from "vitest";
import { prisma, type AppActor } from "@corgtex/shared";
import { truncateAllTables } from "../../shared/src/db-test-utils";
import { createArticle, listArticleVersions, updateArticle } from "./brain";
import { captureArtifactInputProof, captureArtifactInputSnapshotProof, readableArtifactIds, recordArtifactInputLineage } from "./source-lineage";
import { captureReadableDigestInputs, mergeArtifactInputProofs } from "./digest-lineage";
import { buildWorkspaceBriefingFromCandidates, collectWorkspaceBriefingCandidates, upsertWorkspaceBriefing } from "./workspace-briefing";
import { instrumentNewspaperHtmlLinks, listNewspaperDeliveryDetails, listNewspaperDeliverySummaries, listNewspaperEditions,
  recordNewspaperDelivery, recordNewspaperLinkClick, upsertNewspaperEdition } from "./newspaper-delivery";

async function fixture() {
  const workspace = await prisma.workspace.create({ data: { name: "Synthetic digest", slug: `digest-${randomUUID()}` } });
  const other = await prisma.workspace.create({ data: { name: "Other synthetic workspace", slug: `other-${randomUUID()}` } });
  const owner = await prisma.user.create({ data: { email: `owner-${randomUUID()}@example.test`, passwordHash: "synthetic" } });
  const reader = await prisma.user.create({ data: { email: `reader-${randomUUID()}@example.test`, passwordHash: "synthetic" } });
  const ownerMember = await prisma.member.create({ data: { workspaceId: workspace.id, userId: owner.id, role: "ADMIN" } });
  const readerMember = await prisma.member.create({ data: { workspaceId: workspace.id, userId: reader.id, role: "CONTRIBUTOR" } });
  await prisma.member.create({ data: { workspaceId: other.id, userId: reader.id, role: "ADMIN" } });
  const ownerActor: AppActor = { kind: "user", user: { id: owner.id, email: owner.email, displayName: "Owner" } };
  const readerActor: AppActor = { kind: "user", user: { id: reader.id, email: reader.email, displayName: "Reader" } };
  const agent: AppActor = { kind: "agent", authProvider: "bootstrap", label: "daily-digest-agent", workspaceIds: [workspace.id] };
  return { workspace, other, owner, reader, ownerMember, readerMember, ownerActor, readerActor, agent };
}

describe("digest input receipts", () => {
  beforeEach(async () => { await truncateAllTables(); });

  it("completely counts 20 delivery runs of 251 recipients in PostgreSQL", async () => {
    const { workspace, ownerActor, ownerMember } = await fixture();
    const roots = await captureArtifactInputProof(ownerActor, workspace.id,
      [{kind: "Workspace", id: workspace.id}, {kind: "Member", id: ownerMember.id}]);
    for (let run = 0; run < 20; run++) {
      for (let recipient = 0; recipient < 251; recipient++) {
        await recordNewspaperDelivery({workspaceId: workspace.id, runKey: `synthetic-scale-${run}`,
          kind: "MEMBER_NEWSPAPER", memberId: ownerMember.id, recipientEmail: `recipient-${recipient}@example.test`,
          subject: "Synthetic scale", status: "SENT", actor: ownerActor, lineageRoots: roots});
      }
    }
    expect(await prisma.newspaperDelivery.count({where: {workspaceId: workspace.id}})).toBe(5020);
    const result = await listNewspaperDeliverySummaries(ownerActor, workspace.id);
    expect(result).toHaveLength(20);
    expect(result.every(run => run.recipientCount === 251 && run.sentCount === 251)).toBe(true);
  }, 300_000);

  it("keeps the former owner's private article body out of the new owner's history", async () => {
    const { workspace, ownerActor, readerActor, readerMember } = await fixture();
    const original = await createArticle(ownerActor, { workspaceId: workspace.id, title: "Private synthetic original",
      type: "PROJECT", bodyMd: "Former owner's private text" });
    const transferred = await updateArticle(ownerActor, { workspaceId: workspace.id, slug: original.slug,
      ownerMemberId: readerMember.id, bodyMd: "New owner's independently supplied body" });
    expect(await readableArtifactIds(readerActor, workspace.id, "BrainArticle", [transferred])).toEqual(new Set([transferred.id]));
    expect(await listArticleVersions(readerActor, { workspaceId: workspace.id, slug: transferred.slug })).toEqual([]);
    const version = await prisma.brainArticleVersion.findFirstOrThrow({ where: { articleId: transferred.id } });
    expect(await listArticleVersions(ownerActor, { workspaceId: workspace.id, slug: transferred.slug }))
      .toEqual([expect.objectContaining({ id: version.id, bodyMd: "Former owner's private text" })]);
    expect(version.bodyMd).toBe("Former owner's private text");
    expect(version.accessEnvelopeJson).toMatchObject({ isPrivate: true, ownerMemberId: original.ownerMemberId });
    const currentRoots = await captureArtifactInputProof(readerActor, workspace.id, [{ kind: "BrainArticle", id: transferred.id }]);
    const fresh = await createArticle(readerActor, { workspaceId: workspace.id, title: "New owner's permitted copy", type: "PROJECT",
      bodyMd: transferred.bodyMd, isPrivate: true, ownerMemberId: readerMember.id, completeInputRoots: currentRoots });
    expect(await readableArtifactIds(readerActor, workspace.id, "BrainArticle", [fresh])).toEqual(new Set([fresh.id]));
    expect(fresh.bodyMd).not.toContain("Former owner's private text");
    expect((await prisma.brainArticleVersion.findUniqueOrThrow({ where: { id: version.id } })).bodyMd).toBe(version.bodyMd);
  });

  it("preserves a mutable graph input exactly while enforcing its live source visibility", async () => {
    const { workspace, ownerActor, readerActor, agent } = await fixture();
    const object = await prisma.contextGraphObject.create({ data: { workspaceId: workspace.id,
      objectType: "project", title: "Original synthetic graph fact", summary: "Exact original body" } });
    await prisma.$transaction(async (tx) => {
      await recordArtifactInputLineage({ tx, actor: ownerActor, workspaceId: workspace.id,
        artifact: { kind: "ContextGraphObject", id: object.id }, content: object, origin: "HUMAN_ORIGINAL", inputs: [] });
    });
    const receipt = await prisma.$transaction(async (tx) => {
      const roots = await captureArtifactInputSnapshotProof(ownerActor, workspace.id,
        { kind: "ContextGraphObject", id: object.id }, tx);
      await tx.contextGraphObject.update({ where: { id: object.id }, data: { title: "Edited synthetic fact" } });
      return roots;
    });
    const article = await createArticle(agent, { workspaceId: workspace.id, title: "Copied graph fact", type: "PROJECT",
      bodyMd: "Exact original body", authority: "REFERENCE", isPrivate: false, completeInputRoots: receipt });
    const snapshot = await prisma.artifactInputSnapshot.findFirstOrThrow({ where: { sourceId: object.id } });
    expect(snapshot.contentJson).toMatchObject({ title: "Original synthetic graph fact", summary: "Exact original body" });
    expect(await readableArtifactIds(readerActor, workspace.id, "BrainArticle", [article])).toEqual(new Set([article.id]));
    await prisma.contextGraphObject.update({ where: { id: object.id }, data: { status: "archived" } });
    expect(await readableArtifactIds(readerActor, workspace.id, "BrainArticle", [article])).toEqual(new Set());
    const restored = await prisma.contextGraphObject.update({ where: { id: object.id }, data: { status: "active" } });
    expect(await readableArtifactIds(readerActor, workspace.id, "BrainArticle", [article])).toEqual(new Set());
    // A new generation consumes only the independently permitted current
    // original, never the old copied article or its restored receipt.
    await prisma.$transaction(tx => recordArtifactInputLineage({ tx, actor: ownerActor, workspaceId: workspace.id,
      artifact: { kind: "ContextGraphObject", id: restored.id }, content: restored, origin: "HUMAN_ORIGINAL", inputs: [] }));
    const freshRoots = await captureArtifactInputProof(ownerActor, workspace.id, [{ kind: "ContextGraphObject", id: restored.id }]);
    const rebuilt = await createArticle(agent, { workspaceId: workspace.id, title: restored.title, type: "PROJECT",
      bodyMd: restored.summary ?? "", authority: "REFERENCE", isPrivate: false, completeInputRoots: freshRoots });
    expect(await readableArtifactIds(readerActor, workspace.id, "BrainArticle", [rebuilt])).toEqual(new Set([rebuilt.id]));
    expect((await prisma.brainArticle.findUniqueOrThrow({ where: { id: article.id } })).bodyMd).toBe("Exact original body");
  });

  it("keeps proven failure outcomes visible without requiring an edition, and finds safe editions past unknown history", async () => {
    const { workspace, ownerActor, readerActor, readerMember } = await fixture();
    const roots = await captureArtifactInputProof(ownerActor, workspace.id,
      [{ kind: "Workspace", id: workspace.id }, { kind: "Member", id: readerMember.id }]);
    await recordNewspaperDelivery({ workspaceId: workspace.id, runKey: "synthetic-failed-no-edition", kind: "MEMBER_NEWSPAPER",
      memberId: readerMember.id, recipientEmail: "reader@example.test", subject: "Workspace briefing", status: "FAILED",
      error: "Synthetic provider failure", actor: ownerActor, lineageRoots: roots });
    expect(await listNewspaperDeliveryDetails(readerActor, workspace.id)).toHaveLength(1);
    expect(await listNewspaperDeliverySummaries(readerActor, workspace.id)).toMatchObject([{ failedCount: 1, recipientCount: 1 }]);
    const otherRoots = await captureArtifactInputProof(ownerActor, workspace.id,
      [{ kind: "Workspace", id: workspace.id }, { kind: "Member", id: (await prisma.member.findFirstOrThrow({ where: { userId: ownerActor.kind === "user" ? ownerActor.user.id : "", workspaceId: workspace.id } })).id }]);
    await recordNewspaperDelivery({ workspaceId: workspace.id, runKey: "other-recipient", kind: "MEMBER_NEWSPAPER",
      memberId: (otherRoots.find((root) => root.kind === "Member"))!.id, recipientEmail: "other@example.test",
      subject: "Other recipient", status: "FAILED", error: "Other synthetic outcome", actor: ownerActor, lineageRoots: otherRoots });
    expect(await listNewspaperDeliveryDetails(readerActor, workspace.id)).toHaveLength(1);
    expect(await listNewspaperDeliverySummaries(readerActor, workspace.id)).toHaveLength(1);
    expect(await listNewspaperDeliveryDetails(ownerActor, workspace.id)).toHaveLength(2);
    const edition = await upsertNewspaperEdition({ workspaceId: workspace.id, cadence: "DAILY", dateKey: "2026-10-12",
      runKey: "synthetic-safe", title: "Safe edition", slug: "safe", digestJson: {}, bodyMd: "Safe original name",
      sourceCounts: {}, actor: ownerActor, lineageRoots: roots });
    await prisma.newspaperEdition.createMany({ data: Array.from({ length: 55 }, (_, index) => ({ workspaceId: workspace.id,
      cadence: "DAILY" as const, dateKey: `unknown-${index}`, runKey: `unknown-${index}`, title: "Unknown history", slug: `unknown-${index}`,
      digestJson: {}, bodyMd: "Unknown contents", sourceCounts: {}, generatedAt: new Date(Date.now() + index + 100),
    })) });
    expect((await listNewspaperEditions(readerActor, workspace.id, { take: 1 })).map((row) => row.id)).toEqual([edition.id]);
  });

  it("captures uncited contributors and regenerates from remaining inputs while preserving article history", async () => {
    const { workspace, ownerActor, readerActor, agent } = await fixture();
    const first = await prisma.brainSource.create({ data: { workspaceId: workspace.id, sourceType: "DOC", tier: 1, content: "Synthetic first fact" } });
    const second = await prisma.brainSource.create({ data: { workspaceId: workspace.id, sourceType: "DOC", tier: 1, content: "Synthetic second fact" } });
    await prisma.$transaction(async tx => {
      for (const source of [first, second]) await recordArtifactInputLineage({ tx, actor: ownerActor, workspaceId: workspace.id,
        artifact: { kind: "BrainSource", id: source.id }, content: source, origin: "HUMAN_ORIGINAL", inputs: [] });
    });
    const roots = await captureArtifactInputProof(ownerActor, workspace.id, [
      { kind: "Workspace", id: workspace.id }, { kind: "BrainSource", id: first.id }, { kind: "BrainSource", id: second.id },
    ]);
    const briefingJson = buildWorkspaceBriefingFromCandidates({ workspaceId: workspace.id, period: "DAILY",
      dateKey: "2026-10-12", title: "Synthetic newspaper", candidates: [], generatedAt: new Date() });
    const before = await upsertWorkspaceBriefing({ workspaceId: workspace.id, period: "DAILY", dateKey: "2026-10-12",
      runKey: "synthetic-run", title: "Synthetic newspaper", briefing: briefingJson, bodyMd: "First and second facts",
      sourceCounts: { sources: 2 }, actor: ownerActor, lineageRoots: roots });
    const briefingRoots = await captureArtifactInputProof(ownerActor, workspace.id, [{ kind: "WorkspaceBriefing", id: before.id, snapshot: before }]);
    const edition = await upsertNewspaperEdition({ workspaceId: workspace.id, cadence: "DAILY", dateKey: "2026-10-12",
      runKey: "synthetic-run", title: "Synthetic newspaper", slug: "synthetic-newspaper", digestJson: { citedSourceId: first.id },
      bodyMd: before.bodyMd, sourceCounts: { sources: 2 }, actor: ownerActor, lineageRoots: briefingRoots });
    const article = await createArticle(agent, { workspaceId: workspace.id, title: edition.title, type: "DIGEST", authority: "DRAFT",
      isPrivate: false, bodyMd: edition.bodyMd, frontmatterJson: { generatedBy: "daily-digest" }, completeInputRoots: briefingRoots });
    const manifest = await prisma.artifactInputLineage.findFirstOrThrow({ where: { artifactType: "NewspaperEdition", artifactId: edition.id } });
    expect((manifest.rootsJson as Array<{ id: string }>).map((root) => root.id)).toEqual(expect.arrayContaining([first.id, second.id]));
    expect(await readableArtifactIds(readerActor, workspace.id, "NewspaperEdition", [edition])).toEqual(new Set([edition.id]));

    await prisma.brainSource.update({ where: { id: second.id }, data: { archivedAt: new Date() } });
    expect(await readableArtifactIds(readerActor, workspace.id, "WorkspaceBriefing", [before])).toEqual(new Set());
    expect(await readableArtifactIds(readerActor, workspace.id, "NewspaperEdition", [edition])).toEqual(new Set());
    expect(await readableArtifactIds(readerActor, workspace.id, "BrainArticle", [article])).toEqual(new Set());
    await expect(upsertWorkspaceBriefing({ workspaceId: workspace.id, period: "DAILY", dateKey: "2026-10-12",
      runKey: "synthetic-run", title: "Stale retry", briefing: briefingJson, bodyMd: "Stale restricted candidate",
      actor: ownerActor, lineageRoots: roots })).rejects.toMatchObject({ code: "SOURCE_CHANGED" });
    expect((await prisma.workspaceBriefing.findUniqueOrThrow({ where: { id: before.id } })).bodyMd).toBe("First and second facts");

    const remaining = await captureArtifactInputProof(ownerActor, workspace.id, [{ kind: "Workspace", id: workspace.id }, { kind: "BrainSource", id: first.id }]);
    const rebuilt = await upsertWorkspaceBriefing({ workspaceId: workspace.id, period: "DAILY", dateKey: "2026-10-12",
      runKey: "synthetic-run", title: "Remaining source", briefing: briefingJson, bodyMd: "First fact only",
      sourceCounts: { sources: 1 }, actor: ownerActor, lineageRoots: remaining });
    const rebuiltRoots = await captureArtifactInputProof(ownerActor, workspace.id, [{ kind: "WorkspaceBriefing", id: rebuilt.id }]);
    const updated = await updateArticle(agent, { workspaceId: workspace.id, slug: article.slug, title: "Remaining source", type: "DIGEST",
      bodyMd: "First fact only", frontmatterJson: { generatedBy: "daily-digest" }, sourceIds: [], completeInputRoots: rebuiltRoots });
    expect(await readableArtifactIds(readerActor, workspace.id, "BrainArticle", [updated])).toEqual(new Set([updated.id]));
    expect((await prisma.brainArticleVersion.findFirstOrThrow({ where: { articleId: article.id } })).bodyMd).toBe("First and second facts");
    expect((await prisma.brainSource.findUniqueOrThrow({ where: { id: first.id } })).content).toBe("Synthetic first fact");
    const humanEdited = await updateArticle(ownerActor, { workspaceId: workspace.id, slug: updated.slug, bodyMd: "Independent human revision" });
    expect(humanEdited.humanEditedAt).not.toBeNull();
    await expect(updateArticle(agent, { workspaceId: workspace.id, slug: updated.slug, title: "Replacement", type: "DIGEST",
      bodyMd: "Replacement body", frontmatterJson: { generatedBy: "daily-digest" }, sourceIds: [], completeInputRoots: rebuiltRoots }))
      .rejects.toMatchObject({ code: "MANUAL_REBUILD_REQUIRED" });
    expect((await prisma.brainArticle.findUniqueOrThrow({ where: { id: article.id } })).bodyMd).toBe("Independent human revision");
  });

  it("filters over 5000 unknown and private contributors before the editorial limit and rejects another workspace", async () => {
    const { workspace, other, ownerActor, readerActor } = await fixture();
    const safe = await createArticle(ownerActor, { workspaceId: workspace.id, slug: "safe", title: "Safe synthetic input", type: "PROJECT",
      authority: "REFERENCE", isPrivate: false, bodyMd: "Permitted text" });
    const privateOriginal = await createArticle(ownerActor, { workspaceId: workspace.id, title: "Private synthetic canary", type: "PROJECT", bodyMd: "Private body" });
    const privateRoots = await captureArtifactInputProof(ownerActor, workspace.id, [{ kind: "BrainArticle", id: privateOriginal.id }]);
    const mixed = await createArticle(ownerActor, { workspaceId: workspace.id, title: "Copied private canary", type: "PROJECT",
      authority: "REFERENCE", isPrivate: false, bodyMd: "Private body copied", completeInputRoots: privateRoots });
    await prisma.brainArticle.createMany({ data: Array.from({ length: 5001 }, (_, index) => ({ workspaceId: workspace.id,
      slug: `unknown-${index}`, title: `Unknown ${index}`, type: "PROJECT" as const, authority: "REFERENCE" as const,
      bodyMd: "Unknown synthetic input", updatedAt: new Date(Date.now() + index),
    })) });
    const candidates = await collectWorkspaceBriefingCandidates({ workspaceId: workspace.id, actor: ownerActor,
      audience: [ownerActor, readerActor], since: new Date(Date.now() - 60_000), until: new Date(Date.now() + 60_000) });
    expect(candidates.map((candidate) => candidate.sourceId)).toEqual([safe.id]);
    expect(JSON.stringify(candidates)).not.toContain("Private body");
    const common = await captureReadableDigestInputs({ actor: ownerActor, audience: [ownerActor, readerActor],
      workspaceId: workspace.id, kind: "BrainArticle", records: [safe, mixed] });
    expect(common.records.map((record) => record.id)).toEqual([safe.id]);
    await expect(captureArtifactInputProof(readerActor, other.id, [{ kind: "BrainArticle", id: safe.id }]))
      .rejects.toMatchObject({ code: "SOURCE_CHANGED" });
  }, 180_000);

  it("gates personalized redirects and delivery counts separately from a readable shared edition", async () => {
    const { workspace, ownerActor, readerActor } = await fixture();
    const privateArticle = await createArticle(ownerActor, { workspaceId: workspace.id, title: "Private supplement", type: "PROJECT", bodyMd: "Owner text" });
    const workspaceRoots = await captureArtifactInputProof(ownerActor, workspace.id, [{ kind: "Workspace", id: workspace.id }]);
    await upsertNewspaperEdition({ workspaceId: workspace.id, cadence: "DAILY", dateKey: "2026-10-12", runKey: "synthetic-personal",
      title: "Shared edition", slug: "shared", digestJson: {}, bodyMd: "Shared text", sourceCounts: {}, actor: ownerActor, lineageRoots: workspaceRoots });
    const privateRoots = mergeArtifactInputProofs(workspaceRoots,
      await captureArtifactInputProof(ownerActor, workspace.id, [{ kind: "BrainArticle", id: privateArticle.id }]));
    const html = await instrumentNewspaperHtmlLinks({ workspaceId: workspace.id, runKey: "synthetic-personal",
      html: '<a href="https://example.test/private-subject">Synthetic</a>', actor: ownerActor, lineageRoots: privateRoots });
    const token = html.match(/\/click\/([^"<]+)/)?.[1];
    expect(token).toBeTruthy();
    await expect(recordNewspaperLinkClick(readerActor, token!)).rejects.toMatchObject({ status: 404 });
    await expect(recordNewspaperLinkClick(ownerActor, token!)).resolves.toMatchObject({ targetUrl: "https://example.test/private-subject" });
    await expect(recordNewspaperLinkClick(ownerActor, token!)).resolves.toMatchObject({ targetUrl: "https://example.test/private-subject" });
    await recordNewspaperDelivery({ workspaceId: workspace.id, runKey: "synthetic-personal", kind: "MEMBER_NEWSPAPER",
      recipientEmail: "owner@example.test", subject: "Private supplement", status: "SENT", actor: ownerActor, lineageRoots: privateRoots });
    expect(await listNewspaperDeliveryDetails(readerActor, workspace.id)).toEqual([]);
    expect(await listNewspaperDeliverySummaries(readerActor, workspace.id)).toEqual([]);
    expect((await listNewspaperDeliverySummaries(ownerActor, workspace.id))[0]).toMatchObject({ recipientCount: 1, totalClickCount: 2 });
  });

  it("retains requester ownership through conversation copies and refuses unknown turn provenance", async () => {
    const { workspace, owner, ownerActor, readerActor } = await fixture();
    const session = await prisma.conversationSession.create({ data: { workspaceId: workspace.id, userId: owner.id } });
    const turn = await prisma.conversationTurn.create({ data: { conversationId: session.id, sequenceNumber: 1,
      userMessage: "Synthetic personal input", assistantMessage: "Synthetic personal answer" } });
    await expect(captureArtifactInputProof(ownerActor, workspace.id, [{ kind: "ConversationTurn", id: turn.id }]))
      .rejects.toMatchObject({ code: "UNKNOWN_LINEAGE" });
    await prisma.$transaction(async (tx) => {
      await recordArtifactInputLineage({ tx, actor: ownerActor, workspaceId: workspace.id,
        artifact: { kind: "ConversationTurn", id: turn.id }, content: turn, origin: "DERIVED", inputs: [{ kind: "User", id: owner.id }] });
    });
    const roots = await captureArtifactInputProof(ownerActor, workspace.id, [{ kind: "ConversationTurn", id: turn.id }]);
    const source = await prisma.$transaction(async (tx) => {
      const source = await tx.brainSource.create({ data: { workspaceId: workspace.id, sourceType: "CONVERSATION_INSIGHT", tier: 3, content: "Synthetic copied answer" } });
      await recordArtifactInputLineage({ tx, actor: ownerActor, workspaceId: workspace.id, artifact: { kind: "BrainSource", id: source.id },
        content: source, origin: "DERIVED", inputs: [], inheritedRoots: roots });
      return source;
    });
    expect(await readableArtifactIds(ownerActor, workspace.id, "BrainSource", [source])).toEqual(new Set([source.id]));
    expect(await readableArtifactIds(readerActor, workspace.id, "BrainSource", [source])).toEqual(new Set());
  });
});
