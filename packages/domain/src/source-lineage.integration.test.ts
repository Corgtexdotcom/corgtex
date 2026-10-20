import { randomUUID } from "node:crypto";
import { beforeEach, describe, expect, it } from "vitest";
import { prisma, type AppActor } from "@corgtex/shared";
import { truncateAllTables } from "../../shared/src/db-test-utils";
import { captureArtifactInputProof, readableArtifactIds, recordArtifactInputLineage } from "./source-lineage";
import { ingestSource, listSources } from "./brain";
import { getAction, listActions } from "./actions";
import { getTension, listTensions } from "./tensions";
import { listCompanyDirectionFromBrain } from "./goals";
import { createCheckIn, respondToCheckIn } from "./check-ins";
import { ingestConversationOnDemand } from "./conversation-brain";
import { createConversation, createConversationPromptInput, addConversationTurn } from "./conversations";
import { brainExportHash, exportConversationAnswerToBrain } from "./conversation-brain-consent";

describe("complete input lineage", () => {
  beforeEach(async () => { await truncateAllTables(); });

  it("isolates workspaces, private inputs, revocation, unknown lineage, and original articles", async () => {
    const [workspace, otherWorkspace] = await Promise.all([
      prisma.workspace.create({ data: { name: "Lineage fixture", slug: `lineage-${randomUUID()}` } }),
      prisma.workspace.create({ data: { name: "Other fixture", slug: `lineage-${randomUUID()}` } }),
    ]);
    const [owner, reader] = await Promise.all([
      prisma.user.create({ data: { email: `lineage-owner-${randomUUID()}@example.test`, passwordHash: "synthetic" } }),
      prisma.user.create({ data: { email: `lineage-reader-${randomUUID()}@example.test`, passwordHash: "synthetic" } }),
    ]);
    const [ownerMember] = await Promise.all([
      prisma.member.create({ data: { workspaceId: workspace.id, userId: owner.id, role: "CONTRIBUTOR" } }),
      prisma.member.create({ data: { workspaceId: workspace.id, userId: reader.id, role: "CONTRIBUTOR" } }),
      prisma.member.create({ data: { workspaceId: otherWorkspace.id, userId: reader.id, role: "ADMIN" } }),
    ]);
    const ownerActor: AppActor = { kind: "user", user: { id: owner.id, email: owner.email, displayName: "Owner" } };
    const readerActor: AppActor = { kind: "user", user: { id: reader.id, email: reader.email, displayName: "Reader" } };
    const source = await prisma.brainSource.create({ data: {
      workspaceId: workspace.id, sourceType: "DOC", tier: 1, title: "Private input", content: "Synthetic private fact",
    } });
    await prisma.$transaction(tx => recordArtifactInputLineage({ tx, actor: ownerActor, workspaceId: workspace.id,
      artifact: { kind: "BrainSource", id: source.id }, content: source, origin: "HUMAN_ORIGINAL", inputs: [] }));
    const privateOriginal = await prisma.brainArticle.create({ data: {
      workspaceId: workspace.id, slug: "private-original", title: "Private original", type: "PROJECT",
      bodyMd: "Synthetic owner text", sourceIds: [], authority: "DRAFT", isPrivate: true, ownerMemberId: ownerMember.id,
    } });
    const derived = await prisma.brainArticle.create({ data: {
      workspaceId: workspace.id, slug: "mixed-derived", title: "Mixed derived", type: "PROJECT",
      bodyMd: "Synthetic private fact and owner text", sourceIds: [source.id], authority: "REFERENCE",
    } });
    const unknown = await prisma.brainArticle.create({ data: {
      workspaceId: workspace.id, slug: "unknown-legacy", title: "Unknown legacy", type: "PROJECT",
      bodyMd: "Could contain restricted text", sourceIds: [source.id], authority: "REFERENCE",
    } });
    await prisma.$transaction(async (tx) => {
      await recordArtifactInputLineage({ tx, actor: ownerActor, workspaceId: workspace.id,
        artifact: { kind: "BrainArticle", id: privateOriginal.id }, content: privateOriginal,
        origin: "HUMAN_ORIGINAL", inputs: [],
      });
      await recordArtifactInputLineage({ tx, actor: ownerActor, workspaceId: workspace.id,
        artifact: { kind: "BrainArticle", id: derived.id }, content: derived,
        origin: "DERIVED", inputs: [
          { kind: "BrainSource", id: source.id }, { kind: "BrainArticle", id: privateOriginal.id },
        ],
      });
    });
    const records = [privateOriginal, derived, unknown];
    expect(await readableArtifactIds(ownerActor, workspace.id, "BrainArticle", records))
      .toEqual(new Set([privateOriginal.id, derived.id]));
    expect(await readableArtifactIds(readerActor, workspace.id, "BrainArticle", records)).toEqual(new Set());
    expect(await readableArtifactIds(readerActor, otherWorkspace.id, "BrainArticle", records)).toEqual(new Set());

    // The original remains available when its unrelated source is withdrawn.
    await prisma.brainSource.update({ where: { id: source.id }, data: { archivedAt: new Date() } });
    expect(await readableArtifactIds(ownerActor, workspace.id, "BrainArticle", records))
      .toEqual(new Set([privateOriginal.id]));
    await prisma.brainSource.update({ where: { id: source.id }, data: { archivedAt: null, content: "Replaced fact" } });
    expect(await readableArtifactIds(ownerActor, workspace.id, "BrainArticle", records))
      .toEqual(new Set([privateOriginal.id]));
  });

  it("withholds copied chat sources and their articles unless every upstream permission still holds", async () => {
    const workspace = await prisma.workspace.create({ data: { name: "Chat lineage fixture", slug: `chat-lineage-${randomUUID()}` } });
    const otherWorkspace = await prisma.workspace.create({ data: { name: "Other", slug: `chat-other-${randomUUID()}` } });
    const owner = await prisma.user.create({ data: { email: `chat-owner-${randomUUID()}@example.test`, passwordHash: "synthetic" } });
    const reader = await prisma.user.create({ data: { email: `chat-reader-${randomUUID()}@example.test`, passwordHash: "synthetic" } });
    const ownerMember = await prisma.member.create({ data: { workspaceId: workspace.id, userId: owner.id, role: "CONTRIBUTOR" } });
    await prisma.member.create({ data: { workspaceId: workspace.id, userId: reader.id, role: "CONTRIBUTOR" } });
    await prisma.member.create({ data: { workspaceId: otherWorkspace.id, userId: reader.id, role: "CONTRIBUTOR" } });
    const ownerActor: AppActor = { kind: "user", user: { id: owner.id, email: owner.email, displayName: "Owner" } };
    const readerActor: AppActor = { kind: "user", user: { id: reader.id, email: reader.email, displayName: "Reader" } };
    const privateArticle = await prisma.brainArticle.create({ data: {
      workspaceId: workspace.id, slug: "owner-original", title: "Owner original", type: "PROJECT",
      bodyMd: "Synthetic private canary", sourceIds: [], isPrivate: true, ownerMemberId: ownerMember.id,
    } });
    const copiedChat = await prisma.brainSource.create({ data: {
      workspaceId: workspace.id, sourceType: "CONVERSATION", tier: 3, channel: "daily-batch",
      content: "Assistant: Synthetic private canary",
    } });
    const legacyChat = await prisma.brainSource.create({ data: {
      workspaceId: workspace.id, sourceType: "CONVERSATION_INSIGHT", tier: 3,
      title: "Predictable hidden answer", content: "Synthetic legacy private canary",
    } });
    const rawSource = await prisma.brainSource.create({ data: {
      workspaceId: workspace.id, sourceType: "DOC", tier: 1, content: "Synthetic shared source",
    } });
    await prisma.$transaction(tx => recordArtifactInputLineage({ tx, actor: ownerActor, workspaceId: workspace.id,
      artifact: { kind: "BrainSource", id: rawSource.id }, content: rawSource, origin: "HUMAN_ORIGINAL", inputs: [] }));
    await prisma.$transaction(async (tx) => {
      await recordArtifactInputLineage({ tx, actor: ownerActor, workspaceId: workspace.id,
        artifact: { kind: "BrainArticle", id: privateArticle.id }, content: privateArticle,
        origin: "HUMAN_ORIGINAL", inputs: [],
      });
      await recordArtifactInputLineage({ tx, actor: ownerActor, workspaceId: workspace.id,
        artifact: { kind: "BrainSource", id: copiedChat.id }, content: copiedChat,
        origin: "DERIVED", inputs: [{ kind: "BrainArticle", id: privateArticle.id }],
      });
    });
    await expect(ingestConversationOnDemand(ownerActor, { workspaceId: workspace.id,
      title: "Unproven copied chat", content: "Synthetic private canary",
    })).rejects.toMatchObject({ code: "BRAIN_CONSENT_REQUIRED" });
    await expect(ingestConversationOnDemand(ownerActor, { workspaceId: workspace.id,
      title: "Model-selected copied chat", content: "Synthetic private canary",
      lineageInputs: [{ kind: "BrainArticle", id: privateArticle.id }],
    })).rejects.toMatchObject({ code: "BRAIN_CONSENT_REQUIRED" });
    const session = await createConversation(ownerActor, { workspaceId: workspace.id });
    const prompt = await createConversationPromptInput(ownerActor, { workspaceId: workspace.id,
      conversationId: session.id, content: "Private question about my article" });
    const roots = await captureArtifactInputProof(ownerActor, workspace.id,
      [{ kind: "ConversationPromptInput", id: prompt.id }, { kind: "BrainArticle", id: privateArticle.id }]);
    const turn = await addConversationTurn(ownerActor, { workspaceId: workspace.id,
      conversationId: session.id, userMessage: prompt.content, assistantMessage: "Synthetic private canary",
      promptInputId: prompt.id, lineageRoots: roots });
    const exported = await exportConversationAnswerToBrain(ownerActor, { workspaceId: workspace.id,
      conversationId: session.id, outputTurnId: turn.id, expectedOutputHash: brainExportHash(turn.assistantMessage),
      title: "Proven copied chat", transcriptMode: "NONE", selectedTurns: [], requestId: randomUUID() });
    const savedChat = await prisma.brainSource.findUniqueOrThrow({ where: { id: exported.sourceId } });
    expect(savedChat.content).toBe(turn.assistantMessage);
    expect(savedChat.content).not.toContain(prompt.content);
    expect((await listSources(ownerActor, { workspaceId: workspace.id })).items.map((source) => source.id))
      .toContain(savedChat.id);
    expect((await listSources(readerActor, { workspaceId: workspace.id })).items.map((source) => source.id))
      .not.toContain(savedChat.id);
    const derivedArticle = await prisma.brainArticle.create({ data: {
      workspaceId: workspace.id, slug: "copied-chat-article", title: "Copied chat article", type: "PROJECT",
      bodyMd: copiedChat.content, sourceIds: [copiedChat.id],
    } });
    await prisma.$transaction(async (tx) => {
      await recordArtifactInputLineage({ tx, actor: ownerActor, workspaceId: workspace.id,
        artifact: { kind: "BrainArticle", id: derivedArticle.id }, content: derivedArticle,
        origin: "DERIVED", inputs: [{ kind: "BrainSource", id: copiedChat.id }],
      });
    });
    expect((await listSources(ownerActor, { workspaceId: workspace.id })).items.map((source) => source.id).sort())
      .toEqual([rawSource.id, copiedChat.id, savedChat.id].sort());
    expect((await listSources(readerActor, { workspaceId: workspace.id })).items.map((source) => source.id))
      .toEqual([rawSource.id]);
    expect((await listSources(readerActor, { workspaceId: otherWorkspace.id })).total).toBe(0);
    expect(await readableArtifactIds(readerActor, workspace.id, "BrainArticle", [derivedArticle])).toEqual(new Set());
    await expect(ingestSource(readerActor, { workspaceId: workspace.id, sourceType: "DOC", tier: 1,
      title: legacyChat.title, content: "Unrelated new text",
      duplicateGuard: { resolution: "use_existing", targetEntityId: legacyChat.id },
    })).rejects.toMatchObject({ code: "DUPLICATE_GUARD_TARGET_NOT_FOUND" });
    const newSource = await ingestSource(readerActor, { workspaceId: workspace.id, sourceType: "DOC", tier: 1,
      title: legacyChat.title, content: "Unrelated new text", duplicateGuard: {},
    });
    expect(newSource.id).not.toBe(legacyChat.id);
    const editedCopy = await ingestSource(ownerActor, { workspaceId: workspace.id, sourceType: "CONVERSATION", tier: 3,
      title: "Copied chat", content: copiedChat.content,
      duplicateGuard: { resolution: "update_existing", targetEntityId: copiedChat.id },
    });
    expect(editedCopy.id).toBe(copiedChat.id);
    const retained = await prisma.artifactInputLineage.findFirstOrThrow({ where: { artifactType: "BrainSource", artifactId: copiedChat.id },
      orderBy: { revision: "desc" } });
    expect(retained.origin).toBe("DERIVED");
    expect(retained.rootsJson).toEqual(expect.arrayContaining([expect.objectContaining({ kind: "BrainArticle", id: privateArticle.id })]));
    expect(await readableArtifactIds(readerActor, workspace.id, "BrainSource", [editedCopy])).toEqual(new Set());
    await prisma.brainArticle.update({ where: { id: privateArticle.id }, data: { bodyMd: "Changed owner original" } });
    expect((await listSources(ownerActor, { workspaceId: workspace.id })).items.map((source) => source.id))
      .toEqual(expect.arrayContaining([rawSource.id, newSource.id]));
    const visibleAfterChange = (await listSources(ownerActor, { workspaceId: workspace.id })).items.map(source => source.id);
    expect(visibleAfterChange).not.toContain(copiedChat.id);
    // Consent preserves the exact historical output across body-only revisions,
    // while an actual source permission transition still revokes that copy.
    expect(visibleAfterChange).toContain(savedChat.id);
    expect(await readableArtifactIds(ownerActor, workspace.id, "BrainArticle", [derivedArticle])).toEqual(new Set());
    await prisma.brainArticle.update({ where: { id: privateArticle.id }, data: { archivedAt: new Date() } });
    expect((await listSources(ownerActor, { workspaceId: workspace.id })).items.map(source => source.id))
      .not.toContain(savedChat.id);
  });

  it("does not reveal private or unproven proposal metadata through public linked work items", async () => {
    const workspace = await prisma.workspace.create({ data: { name: "Proposal lineage fixture", slug: `proposal-lineage-${randomUUID()}` } });
    const owner = await prisma.user.create({ data: { email: `proposal-owner-${randomUUID()}@example.test`, passwordHash: "synthetic" } });
    const reader = await prisma.user.create({ data: { email: `proposal-reader-${randomUUID()}@example.test`, passwordHash: "synthetic" } });
    await prisma.member.create({ data: { workspaceId: workspace.id, userId: owner.id, role: "CONTRIBUTOR" } });
    await prisma.member.create({ data: { workspaceId: workspace.id, userId: reader.id, role: "CONTRIBUTOR" } });
    const ownerActor: AppActor = { kind: "user", user: { id: owner.id, email: owner.email, displayName: "Owner" } };
    const readerActor: AppActor = { kind: "user", user: { id: reader.id, email: reader.email, displayName: "Reader" } };
    const privateProposal = await prisma.proposal.create({ data: {
      workspaceId: workspace.id, authorUserId: owner.id, title: "Synthetic private proposal canary",
      bodyMd: "Synthetic private decision", status: "DRAFT", isPrivate: true,
    } });
    const action = await prisma.action.create({ data: {
      workspaceId: workspace.id, authorUserId: owner.id, title: "Public action", status: "OPEN",
      proposalId: privateProposal.id,
    } });
    const tension = await prisma.tension.create({ data: {
      workspaceId: workspace.id, authorUserId: owner.id, title: "Public tension", status: "OPEN",
      proposalId: privateProposal.id,
    } });
    await prisma.$transaction(async (tx) => {
      await recordArtifactInputLineage({ tx, actor: ownerActor, workspaceId: workspace.id,
        artifact: { kind: "Proposal", id: privateProposal.id }, content: privateProposal,
        origin: "HUMAN_ORIGINAL", inputs: [],
      });
      for (const [kind, row] of [["Action", action], ["Tension", tension]] as const) {
        await recordArtifactInputLineage({ tx, actor: ownerActor, workspaceId: workspace.id,
          artifact: { kind, id: row.id }, content: row, origin: "HUMAN_ORIGINAL", inputs: [] });
      }
    });
    expect((await getAction(readerActor, { workspaceId: workspace.id, actionId: action.id })).proposal).toBeNull();
    expect((await getTension(readerActor, { workspaceId: workspace.id, tensionId: tension.id })).proposal).toBeNull();
    expect((await listActions(readerActor, workspace.id)).items[0]).toMatchObject({ proposalId: null, proposal: null });
    expect((await listTensions(readerActor, workspace.id)).items[0]).toMatchObject({ proposalId: null, proposal: null });
    expect((await getAction(ownerActor, { workspaceId: workspace.id, actionId: action.id })).proposal?.title)
      .toBe(privateProposal.title);
    await prisma.proposal.update({ where: { id: privateProposal.id }, data: { title: "Changed unproven title" } });
    expect((await getAction(ownerActor, { workspaceId: workspace.id, actionId: action.id })).proposal).toBeNull();
    expect((await getTension(ownerActor, { workspaceId: workspace.id, tensionId: tension.id })).proposal).toBeNull();
  });

  it("keeps unknown source titles out of company direction and shares consented answers with their upstream limits", async () => {
    const workspace = await prisma.workspace.create({ data: { name: "Direction lineage fixture", slug: `direction-lineage-${randomUUID()}` } });
    const owner = await prisma.user.create({ data: { email: `direction-owner-${randomUUID()}@example.test`, passwordHash: "synthetic" } });
    const reader = await prisma.user.create({ data: { email: `direction-reader-${randomUUID()}@example.test`, passwordHash: "synthetic" } });
    const ownerMember = await prisma.member.create({ data: { workspaceId: workspace.id, userId: owner.id, role: "CONTRIBUTOR" } });
    await prisma.member.create({ data: { workspaceId: workspace.id, userId: reader.id, role: "CONTRIBUTOR" } });
    const ownerActor: AppActor = { kind: "user", user: { id: owner.id, email: owner.email, displayName: "Owner" } };
    const readerActor: AppActor = { kind: "user", user: { id: reader.id, email: reader.email, displayName: "Reader" } };
    const privateArticle = await prisma.brainArticle.create({ data: {
      workspaceId: workspace.id, slug: "direction-private", title: "Private direction", type: "PROJECT",
      bodyMd: "Synthetic private direction", sourceIds: [], isPrivate: true, ownerMemberId: ownerMember.id,
    } });
    await prisma.$transaction(async (tx) => {
      await recordArtifactInputLineage({ tx, actor: ownerActor, workspaceId: workspace.id,
        artifact: { kind: "BrainArticle", id: privateArticle.id }, content: privateArticle,
        origin: "HUMAN_ORIGINAL", inputs: [],
      });
    });
    const unknownSource = await prisma.brainSource.create({ data: {
      workspaceId: workspace.id, sourceType: "CONVERSATION_INSIGHT", tier: 3,
      title: "Synthetic hidden direction canary", content: "Hidden synthetic content",
    } });
    const goal = await prisma.goal.create({ data: {
      workspaceId: workspace.id, authorUserId: owner.id, title: "Visible goal", status: "ACTIVE",
    } });
    const link = await prisma.goalLink.create({ data: {
      goalId: goal.id, entityType: "BrainSource", entityId: unknownSource.id,
      source: "company-understanding", metadata: { label: "Synthetic hidden direction canary" },
    } });
    await prisma.$transaction(async (tx) => {
      await recordArtifactInputLineage({ tx, actor: ownerActor, workspaceId: workspace.id,
        artifact: { kind: "Goal", id: goal.id }, content: goal, origin: "HUMAN_ORIGINAL", inputs: [],
      });
      await recordArtifactInputLineage({ tx, actor: ownerActor, workspaceId: workspace.id,
        artifact: { kind: "GoalLink", id: link.id }, content: link, origin: "HUMAN_ORIGINAL", inputs: [],
      });
    });
    const direction = await listCompanyDirectionFromBrain(readerActor, { workspaceId: workspace.id });
    expect(direction.evidenceLinkCount).toBe(0);
    expect(JSON.stringify(direction)).not.toContain("Synthetic hidden direction canary");

    const sharedQuestion = await createCheckIn(ownerActor, { workspaceId: workspace.id,
      memberId: ownerMember.id, questionText: "Shared company question", questionSource: "human",
      questionType: "COMPANY_UNDERSTANDING",
    });
    await respondToCheckIn(ownerActor, { workspaceId: workspace.id, checkInId: sharedQuestion.id,
      responseMd: "Synthetic shared answer" });
    const restrictedQuestion = await createCheckIn(ownerActor, { workspaceId: workspace.id,
      memberId: ownerMember.id, questionText: "Restricted company question", questionSource: "human",
      questionType: "COMPANY_UNDERSTANDING", lineageInputs: [{ kind: "BrainArticle", id: privateArticle.id }],
    });
    await respondToCheckIn(ownerActor, { workspaceId: workspace.id, checkInId: restrictedQuestion.id,
      responseMd: "Synthetic restricted answer" });
    const readerSources = await listSources(readerActor, { workspaceId: workspace.id });
    expect(readerSources.items.some((source) => source.content.includes("Synthetic shared answer"))).toBe(true);
    expect(JSON.stringify(readerSources)).not.toContain("Synthetic restricted answer");
    const sharedSource = readerSources.items.find((source) => source.content.includes("Synthetic shared answer"));
    expect(sharedSource).toBeDefined();
    const sharedArticle = await prisma.brainArticle.create({ data: {
      workspaceId: workspace.id, slug: "shared-answer-article", title: "Shared answer article", type: "PROJECT",
      bodyMd: "Synthetic shared answer", sourceIds: [sharedSource!.id],
    } });
    await prisma.$transaction(async (tx) => {
      await recordArtifactInputLineage({ tx, actor: ownerActor, workspaceId: workspace.id,
        artifact: { kind: "BrainArticle", id: sharedArticle.id }, content: sharedArticle,
        origin: "DERIVED", inputs: [{ kind: "BrainSource", id: sharedSource!.id }],
      });
    });
    expect(await readableArtifactIds(readerActor, workspace.id, "BrainArticle", [sharedArticle]))
      .toEqual(new Set([sharedArticle.id]));
  });
});
