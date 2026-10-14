import { randomUUID } from "node:crypto";
import { beforeEach, describe, expect, it } from "vitest";
import { getPrismaClient, type AppActor } from "@corgtex/shared";
import { truncateAllTables } from "../../shared/src/db-test-utils";
import { createConversation, createConversationPromptInput, addConversationTurn } from "./conversations";
import { brainExportHash, exportConversationAnswerToBrain } from "./conversation-brain-consent";
import { captureArtifactInputProof, isArtifactInputProofReadable, recordArtifactInputLineage, lineageContentFingerprint } from "./source-lineage";
const db = getPrismaClient();
beforeEach(async () => { await truncateAllTables(); });
async function fixture() {
  const workspace = await db.workspace.create({data: {slug: "consent-test", name: "Synthetic consent"}});
  const users = await Promise.all(["owner", "reader"].map(name => db.user.create({data: {email: `${name}@consent.test`, displayName: name, passwordHash: "synthetic"}})));
  await db.member.createMany({data: users.map(user => ({workspaceId: workspace.id, userId: user.id, role: "ADMIN"}))});
  const owner: AppActor = {kind: "user", user: users[0]}, reader: AppActor = {kind: "user", user: users[1]};
  const session = await createConversation(owner, {workspaceId: workspace.id});
  async function turn(promptText: string, answer: string, extra: Awaited<ReturnType<typeof captureArtifactInputProof>> = []) {
    const prompt = await createConversationPromptInput(owner, {workspaceId: workspace.id, conversationId: session.id, content: promptText});
    const roots = await captureArtifactInputProof(owner, workspace.id, [{kind: "ConversationPromptInput", id: prompt.id}]);
    return addConversationTurn(owner, {workspaceId: workspace.id, conversationId: session.id, userMessage: promptText,
      assistantMessage: answer, promptInputId: prompt.id, lineageRoots: [...roots, ...extra]});
  }
  const first = await turn("Private original question", "Shareable answer");
  const request = {workspaceId: workspace.id, conversationId: session.id, outputTurnId: first.id, expectedOutputHash: brainExportHash(first.assistantMessage),
    title: "Selected answer", transcriptMode: "NONE" as const, selectedTurns: [], requestId: randomUUID()};
  return {workspace, owner, reader, session, first, turn, request};
}
describe("authenticated output-specific Brain consent", () => {
  it("shares only the exact selected answer while raw prompts and turns remain private", async () => {
    const {owner, reader, workspace, first, request} = await fixture();
    const result = await exportConversationAnswerToBrain(owner, request);
    const source = await db.brainSource.findUniqueOrThrow({where: {id: result.sourceId}});
    expect(source.content).toBe(first.assistantMessage);
    expect(source.metadata).toMatchObject({transcriptMode: "NONE", transcript: []});
    const proof = await captureArtifactInputProof(owner, workspace.id, [{kind: "BrainSource", id: source.id}]);
    expect(await isArtifactInputProofReadable(reader, workspace.id, proof)).toBe(true);
    const turnProof = await captureArtifactInputProof(owner, workspace.id, [{kind: "ConversationTurn", id: first.id}]);
    expect(await isArtifactInputProofReadable(reader, workspace.id, turnProof)).toBe(false);
    const prompt = await db.conversationPromptInput.findUniqueOrThrow({where: {id: first.promptInputId!}});
    expect(prompt.content).toBe(first.userMessage);
    await expect(exportConversationAnswerToBrain(reader, {...request, requestId: randomUUID()})).rejects.toMatchObject({code: "NOT_FOUND"});
    await expect(exportConversationAnswerToBrain(owner, {...request, expectedOutputHash: "0".repeat(64), requestId: randomUUID()})).rejects.toMatchObject({code: "BRAIN_EXPORT_STALE"});
    await expect(exportConversationAnswerToBrain(owner, request)).resolves.toEqual(result);
    expect(await db.brainSource.count({where: {workspaceId: workspace.id}})).toBe(1);
    const native = await db.conversationOperationOutcome.findUniqueOrThrow({where: {id: result.receiptId}});
    const receiptProof = [{kind: "ConversationOperationOutcome" as const, id: native.id, fingerprint: lineageContentFingerprint("ConversationOperationOutcome", native)}];
    await db.brainSource.update({where: {id: source.id}, data: {informationCategory: "RESTRICTED"}});
    expect(await isArtifactInputProofReadable(reader, workspace.id, receiptProof)).toBe(false);
    await db.brainSource.update({where: {id: source.id}, data: {informationCategory: "GENERAL"}});
    expect(await isArtifactInputProofReadable(reader, workspace.id, receiptProof)).toBe(false);
  }, 120_000);
  it("replays concurrent exact requests once and rejects conflicting or no-longer-authorized replay", async () => {
    const {owner, workspace, request} = await fixture();
    const [first, second] = await Promise.all([exportConversationAnswerToBrain(owner, request), exportConversationAnswerToBrain(owner, request)]);
    expect(second).toEqual(first);
    expect(await db.brainSource.count({where: {workspaceId: workspace.id}})).toBe(1);
    expect(await db.conversationOperationOutcome.count({where: {workspaceId: workspace.id, operation: "BRAIN_EXPORT_CONSENT"}})).toBe(1);
    expect(await db.event.count({where: {workspaceId: workspace.id, type: "brain-source.created"}})).toBe(1);
    expect(await db.auditLog.count({where: {workspaceId: workspace.id, action: "brain-source.created"}})).toBe(1);
    const before = await db.conversationOperationOutcome.findUniqueOrThrow({where: {id: first.receiptId}});
    await expect(exportConversationAnswerToBrain(owner, {...request, title: "A different choice"})).rejects.toMatchObject({code: "BRAIN_EXPORT_CONFLICT"});
    await db.brainSource.update({where: {id: first.sourceId}, data: {archivedAt: new Date()}});
    await expect(exportConversationAnswerToBrain(owner, request)).rejects.toMatchObject({code: "SOURCE_CHANGED"});
    await db.brainSource.update({where: {id: first.sourceId}, data: {archivedAt: null}});
    await expect(exportConversationAnswerToBrain(owner, request)).rejects.toMatchObject({code: "SOURCE_CHANGED"});
    expect(await db.conversationOperationOutcome.findUniqueOrThrow({where: {id: first.receiptId}})).toEqual(before);
    expect(await db.event.count({where: {workspaceId: workspace.id, type: "brain-source.created"}})).toBe(1);
  }, 120_000);
  it("does not revive an exact request after exporter membership loss and restoration", async () => {
    const {owner, workspace, request} = await fixture();
    if (owner.kind !== "user") throw new Error("Expected human exporter");
    const exported = await exportConversationAnswerToBrain(owner, request);
    const member = await db.member.findFirstOrThrow({where: {workspaceId: workspace.id, userId: owner.user.id}});
    await db.member.update({where: {id: member.id}, data: {isActive: false}});
    await expect(exportConversationAnswerToBrain(owner, request)).rejects.toThrow();
    await db.member.update({where: {id: member.id}, data: {isActive: true}});
    await expect(exportConversationAnswerToBrain(owner, request)).rejects.toMatchObject({code: "SOURCE_CHANGED"});
    expect(await db.brainSource.count({where: {workspaceId: workspace.id}})).toBe(1);
    expect((await db.conversationOperationOutcome.findUniqueOrThrow({where: {id: exported.receiptId}})).operation).toBe("BRAIN_EXPORT_CONSENT");
  }, 120_000);
  it("binds partial/full metadata to exact selected turns and rejects stale, foreign and forged consent", async () => {
    const {owner, reader, workspace, first, turn, request} = await fixture();
    const second = await turn("Second private question", "Second answer");
    const choose = (row: typeof first) => ({id: row.id, hash: brainExportHash([row.id, row.userMessage, row.assistantMessage])});
    const partial = await exportConversationAnswerToBrain(owner, {...request, transcriptMode: "PARTIAL", selectedTurns: [choose(second)], requestId: randomUUID()});
    const partialSource = await db.brainSource.findUniqueOrThrow({where: {id: partial.sourceId}});
    expect(partialSource.content).toBe(first.assistantMessage);
    expect(partialSource.metadata).toMatchObject({transcriptMode: "PARTIAL", transcript: [{turnId: second.id, userMessage: second.userMessage, assistantMessage: second.assistantMessage}]});
    const full = await exportConversationAnswerToBrain(owner, {...request, transcriptMode: "FULL", selectedTurns: [choose(first), choose(second)], requestId: randomUUID()});
    const source = await db.brainSource.findUniqueOrThrow({where: {id: full.sourceId}});
    expect((source.metadata as {transcript: unknown[]}).transcript).toHaveLength(2);
    const proof = await captureArtifactInputProof(owner, workspace.id, [{kind: "BrainSource", id: full.sourceId}]);
    expect(await isArtifactInputProofReadable(reader, workspace.id, proof)).toBe(true);
    await expect(exportConversationAnswerToBrain(owner, {...request, transcriptMode: "FULL", selectedTurns: [choose(first)], requestId: randomUUID()})).rejects.toMatchObject({code: "BRAIN_EXPORT_STALE"});
    await expect(exportConversationAnswerToBrain(owner, {...request, transcriptMode: "PARTIAL", selectedTurns: [{...choose(second), hash: "0".repeat(64)}], requestId: randomUUID()})).rejects.toMatchObject({code: "BRAIN_EXPORT_STALE"});
    const foreign = await db.workspace.create({data: {slug: "foreign-consent", name: "Foreign synthetic"}});
    if (owner.kind !== "user") throw new Error("Expected user");
    await db.member.create({data: {workspaceId: foreign.id, userId: owner.user.id, role: "ADMIN"}});
    await expect(exportConversationAnswerToBrain(owner, {...request, workspaceId: foreign.id, requestId: randomUUID()})).rejects.toMatchObject({code: "NOT_FOUND"});
    const native = await db.conversationOperationOutcome.findUniqueOrThrow({where: {id: full.receiptId}});
    const fake = await db.conversationOperationOutcome.create({data: {...native, id: randomUUID(), requestKey: brainExportHash(randomUUID()), controlJson: native.controlJson!}});
    expect(await isArtifactInputProofReadable(reader, workspace.id, [{kind: "ConversationOperationOutcome", id: fake.id,
      fingerprint: lineageContentFingerprint("ConversationOperationOutcome", fake)}])).toBe(false);
    await expect(db.conversationOperationOutcome.update({where: {id: native.id}, data: {userId: reader.kind === "user" ? reader.user.id : null}})).rejects.toThrow();
    const ownerMembership = await db.member.findFirstOrThrow({where: {workspaceId: workspace.id, userId: owner.user.id}});
    await db.member.update({where: {id: ownerMembership.id}, data: {isActive: false}});
    expect(await isArtifactInputProofReadable(reader, workspace.id, proof)).toBe(false);
    await db.member.update({where: {id: ownerMembership.id}, data: {isActive: true}});
    expect(await isArtifactInputProofReadable(reader, workspace.id, proof)).toBe(false);
  }, 120_000);
  it("shares a bounded answer and partial selection beyond 100 turns without exporting unrelated history", async () => {
    const {owner, reader, workspace, session, first, turn, request} = await fixture();
    // Unselected historical rows deliberately lack input receipts. They must not
    // be loaded into, or acquire authority through, this selected output export.
    await db.conversationTurn.createMany({data: Array.from({length: 100}, (_, index) => ({conversationId: session.id,
      sequenceNumber: index + 2, userMessage: `Unselected private ${index}`, assistantMessage: `Unselected answer ${index}`}))});
    const output = await turn("Late selected question", "Late selected answer");
    expect(output.sequenceNumber).toBe(102);
    const late = {...request, outputTurnId: output.id, expectedOutputHash: brainExportHash(output.assistantMessage)};
    const none = await exportConversationAnswerToBrain(owner, late);
    expect(await db.brainSource.findUniqueOrThrow({where: {id: none.sourceId}})).toMatchObject({content: output.assistantMessage,
      metadata: {transcriptMode: "NONE", transcript: []}});
    const choice = {id: first.id, hash: brainExportHash([first.id, first.userMessage, first.assistantMessage])};
    const partial = await exportConversationAnswerToBrain(owner, {...late, transcriptMode: "PARTIAL", selectedTurns: [choice], requestId: randomUUID()});
    const source = await db.brainSource.findUniqueOrThrow({where: {id: partial.sourceId}});
    expect(source.content).toBe(output.assistantMessage);
    expect((source.metadata as {transcript: unknown[]}).transcript).toEqual([{turnId: first.id, userMessage: first.userMessage, assistantMessage: first.assistantMessage}]);
    const proof = await captureArtifactInputProof(owner, workspace.id, [{kind: "BrainSource", id: source.id}]);
    expect(await isArtifactInputProofReadable(reader, workspace.id, proof)).toBe(true);
    const foreignSession = await createConversation(reader, {workspaceId: workspace.id});
    const foreign = await db.conversationTurn.create({data: {conversationId: foreignSession.id, sequenceNumber: 1, userMessage: "Other member private", assistantMessage: "Other answer"}});
    for (const selectedTurns of [[{...choice, hash: "0".repeat(64)}], [{id: foreign.id, hash: brainExportHash([foreign.id, foreign.userMessage, foreign.assistantMessage])}]]) {
      await expect(exportConversationAnswerToBrain(owner, {...late, transcriptMode: "PARTIAL", selectedTurns, requestId: randomUUID()})).rejects.toMatchObject({code: "BRAIN_EXPORT_STALE"});
    }
    await expect(exportConversationAnswerToBrain(owner, {...late, transcriptMode: "FULL", selectedTurns: [choice], requestId: randomUUID()})).rejects.toMatchObject({code: "BRAIN_EXPORT_LIMIT"});
    expect(await db.brainSource.count({where: {workspaceId: workspace.id}})).toBe(2);
  }, 120_000);
  it("keeps other restricted contributors restricted after explicit export", async () => {
    const {owner, reader, workspace, turn, request} = await fixture();
    const member = await db.member.findFirstOrThrow({where: {workspaceId: workspace.id, userId: owner.kind === "user" ? owner.user.id : ""}});
    const circle = await db.circle.create({data: {workspaceId: workspace.id, name: "Personnel"}});
    const role = await db.role.create({data: {circleId: circle.id, name: "Personnel reader", accountabilities: [], artifacts: []}});
    await db.roleAssignment.create({data: {roleId: role.id, memberId: member.id}});
    await db.informationCategoryPolicy.create({data: {workspaceId: workspace.id, category: "SALARY", isRestricted: true, allowedRoleIds: [role.id]}});
    const source = await db.brainSource.create({data: {workspaceId: workspace.id, sourceType: "ARTICLE", tier: 1, content: "Synthetic restricted contributor", informationCategory: "SALARY"}});
    await db.$transaction(tx => recordArtifactInputLineage({tx, actor: owner, workspaceId: workspace.id, artifact: {kind: "BrainSource", id: source.id}, content: source, origin: "HUMAN_ORIGINAL", inputs: []}));
    const second = await turn("Use the contributor", "Answer derived from restricted contributor", await captureArtifactInputProof(owner, workspace.id, [{kind: "BrainSource", id: source.id}]));
    const result = await exportConversationAnswerToBrain(owner, {...request, outputTurnId: second.id, expectedOutputHash: brainExportHash(second.assistantMessage)});
    const proof = await captureArtifactInputProof(owner, workspace.id, [{kind: "BrainSource", id: result.sourceId}]);
    expect(await isArtifactInputProofReadable(reader, workspace.id, proof)).toBe(false);
    await db.informationCategoryPolicy.update({where: {workspaceId_category: {workspaceId: workspace.id, category: "SALARY"}}, data: {isRestricted: false}});
    expect(await isArtifactInputProofReadable(reader, workspace.id, proof)).toBe(false);
  }, 120_000);
});
