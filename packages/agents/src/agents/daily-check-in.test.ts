import { beforeEach, describe, expect, it, vi } from "vitest";
import { fixture, workspaceId, alpha, beta, resetFixture, known, knownCopiedDocument, sharedEnv, domainExports } from "./model-consumer.test-fixture";
vi.mock("@corgtex/shared", () => ({ prisma: fixture.prisma, env: sharedEnv,
  toInputJson: (value: unknown) => JSON.parse(JSON.stringify(value)) }));
vi.mock("../../../domain/src/auth", () => ({ requireWorkspaceMembership: fixture.membership, isGlobalOperator: () => false }));
vi.mock("../../../domain/src/brain-access", () => ({ resolveKnowledgeAccessDomains: async (actor: any) =>
  actor.kind === "agent" ? ["WORKSPACE", "FINANCE"] : fixture.domains.get(actor.user.id) ?? [] }));
vi.mock("@corgtex/domain", () => domainExports());
vi.mock("@corgtex/models", () => ({ resolveModel: () => "synthetic-model", defaultModelGateway: { chat: fixture.chat } }));
import { captureArtifactInputProof, readableArtifactIds } from "../../../domain/src/source-lineage";
import { createCheckInGenerationActor } from "../../../domain/src/internal-source-principal";
beforeEach(resetFixture);
import { runDailyCheckInAgent } from "./daily-check-in";
import { createDailyCompanyUnderstandingQuestions, respondToCheckIn, skipCompanyUnderstandingQuestion, startCompanyUnderstandingQuestionConversation } from "../../../domain/src/check-ins";

async function previousQuestion() {
  const row = fixture.add("checkIn", { id: "question-prior", workspaceId, memberId: "member-alpha", questionType: "COMPANY_UNDERSTANDING", status: "OPEN",
    questionText: "What document, customer note, or working file would give CORGTEX the most useful company context today?", questionSource: "human", createdAt: fixture.timestamp });
  await known("CheckIn", row, [], alpha);
  return row;
}
describe("Daily check-in actual runtime and producer receipts", () => {
  it("captures target identity and quota inputs before persisting receipted questions and outcome", async () => {
    const prior = await previousQuestion();
    const run = await runDailyCheckInAgent({ workspaceId, triggerRef: "daily-trigger", memberId: "member-alpha", triggerType: "SCHEDULE", lineageActor: alpha }) as any;
    expect(run).toMatchObject({ status: "COMPLETED", resultJson: { created: 2, cap: 3 } });
    const questions = fixture.rows.checkIn.filter((row: any) => row.id !== prior.id);
    expect(questions).toHaveLength(2);
    for (const question of questions) {
      expect(fixture.manifest("CheckIn", question.id).origin).toBe("DERIVED");
      expect(fixture.sources("CheckIn", question.id).has(`CheckIn:${prior.id}`)).toBe(true);
    }
    expect(await readableArtifactIds(alpha, workspaceId, "CheckIn", questions)).toEqual(new Set(questions.map((row: any) => row.id)));
    expect(await readableArtifactIds(alpha, workspaceId, "AgentRun", [run])).toEqual(new Set([run.id]));
    expect(fixture.rows.agentStep.every((step: any) => fixture.manifest("AgentStep", step.id).origin === "DERIVED")).toBe(true);
    expect(fixture.sources("AgentRun", run.id).has("Member:member-alpha")).toBe(true);
    expect(fixture.sources("AgentRun", run.id).has("User:alpha")).toBe(true);
    expect(fixture.chat).not.toHaveBeenCalled();
    const second = await runDailyCheckInAgent({ workspaceId, triggerRef: "daily-second", memberId: "member-alpha", triggerType: "SCHEDULE", lineageActor: alpha }) as any;
    expect(second).toMatchObject({ status: "COMPLETED", resultJson: { created: 0, cap: 3 } });
  });
  it("does not let broader service-only private questions or unknown history influence the recipient's quotas", async () => {
    const privateDoc = fixture.add("document", { id: "finance-doc", workspaceId, title: "Private finance", textContent: "Private finance body", accessDomain: "FINANCE", archivedAt: null });
    await knownCopiedDocument(privateDoc);
    const actor = createCheckInGenerationActor(workspaceId, "member-alpha");
    for (let index = 0; index < 3; index++) {
      const row = fixture.add("checkIn", { id: `private-prior-${index}`, workspaceId, memberId: "member-alpha", questionType: "COMPANY_UNDERSTANDING", status: "OPEN", questionText: `Private prior ${index}`, questionSource: "daily-check-in", createdAt: fixture.timestamp });
      await known("CheckIn", row, [{ kind: "Document", id: privateDoc.id }], actor);
    }
    fixture.add("checkIn", { id: "question-legacy", workspaceId, memberId: "member-alpha", questionType: "COMPANY_UNDERSTANDING", status: "OPEN", questionText: "Unknown prior body", questionSource: "daily-check-in", createdAt: fixture.timestamp });
    const result = await createDailyCompanyUnderstandingQuestions(actor, { workspaceId, memberId: "member-alpha" });
    expect(result.created).toBe(3);
    const created = fixture.rows.checkIn.filter((row: any) => row.id.startsWith("checkIn-"));
    expect(await readableArtifactIds(alpha, workspaceId, "CheckIn", created)).toEqual(new Set(created.map((row: any) => row.id)));
    expect(created.every((row: any) => !fixture.sources("CheckIn", row.id).has("Document:finance-doc"))).toBe(true);
  });
  it("uses an internal target-scoped service capability for scheduled runtime outcomes", async () => {
    const run = await runDailyCheckInAgent({ workspaceId, triggerRef: "trusted-schedule", memberId: "member-alpha", triggerType: "SCHEDULE" }) as any;
    expect(run).toMatchObject({ status: "COMPLETED", resultJson: { created: 3, cap: 3 } });
    expect(await readableArtifactIds(alpha, workspaceId, "AgentRun", [run])).toEqual(new Set([run.id]));
    expect(await readableArtifactIds(beta, workspaceId, "AgentRun", [run])).toEqual(new Set());
    const capability = createCheckInGenerationActor(workspaceId, "member-alpha");
    const question = fixture.rows.checkIn[0];
    expect(await readableArtifactIds(capability, workspaceId, "CheckIn", [question])).toEqual(new Set([question.id]));
    expect(await readableArtifactIds({ ...capability }, workspaceId, "CheckIn", [question])).toEqual(new Set());
    expect(await readableArtifactIds(createCheckInGenerationActor(workspaceId, "member-beta"), workspaceId, "CheckIn", [question])).toEqual(new Set());
    fixture.rows.member.find((row: any) => row.id === "member-alpha").isActive = false;
    await expect(captureArtifactInputProof(capability, workspaceId, [{ kind: "CheckIn", id: question.id }])).rejects.toMatchObject({ code: "UNKNOWN_LINEAGE" });
  });
  it("denies a departed or foreign target before creating a runtime or question", async () => {
    fixture.rows.member.find((row: any) => row.id === "member-beta").isActive = false;
    await expect(runDailyCheckInAgent({ workspaceId, triggerRef: "departed", memberId: "member-beta", triggerType: "SCHEDULE", lineageActor: alpha })).rejects.toMatchObject({ code: "NOT_FOUND" });
    await expect(runDailyCheckInAgent({ workspaceId, triggerRef: "foreign", memberId: "missing-member", triggerType: "SCHEDULE", lineageActor: alpha })).rejects.toMatchObject({ code: "NOT_FOUND" });
    expect(fixture.rows.agentRun).toHaveLength(0); expect(fixture.rows.checkIn).toHaveLength(0);
  });
});


describe("Question state and linked conversation actual lineage", () => {
  it("advances known answer/skip receipts and preserves company contribution semantics", async () => {
    const prior = await previousQuestion();
    const answered = await respondToCheckIn(alpha, { workspaceId, checkInId: prior.id, responseMd: "Synthetic company answer" });
    expect(answered.status).toBe("ANSWERED");
    expect(await readableArtifactIds(alpha, workspaceId, "CheckIn", [answered])).toEqual(new Set([prior.id]));
    const source = fixture.rows.brainSource.find((row: any) => !row.id.startsWith("original-"));
    expect(fixture.manifest("BrainSource", source.id).origin).toBe("HUMAN_ORIGINAL");
    expect(await readableArtifactIds(beta, workspaceId, "BrainSource", [source])).toEqual(new Set([source.id]));
    const skipped = fixture.add("checkIn", { ...prior, id: "question-skip", status: "OPEN" });
    await known("CheckIn", skipped, [], alpha);
    const result = await skipCompanyUnderstandingQuestion(alpha, { workspaceId, checkInId: skipped.id });
    expect(result.status).toBe("SKIPPED");
    expect(await readableArtifactIds(alpha, workspaceId, "CheckIn", [result])).toEqual(new Set([result.id]));
  });
  it("keeps unknown history unknown through a human response and rejects unknown company chat", async () => {
    const legacy = fixture.add("checkIn", { id: "legacy-wellbeing", workspaceId, memberId: "member-alpha", questionType: "WELLBEING", status: "OPEN", questionText: "Unproven old text" });
    expect(await respondToCheckIn(alpha, { workspaceId, checkInId: legacy.id, responseMd: "New response" }))
      .toEqual({ id: legacy.id, status: "ANSWERED", contentWithheld: true });
    expect(fixture.manifest("CheckIn", legacy.id).origin).toBe("UNKNOWN");
    const company = fixture.add("checkIn", { ...legacy, id: "legacy-company", questionType: "COMPANY_UNDERSTANDING", status: "OPEN" });
    await expect(startCompanyUnderstandingQuestionConversation(alpha, { workspaceId, checkInId: company.id })).rejects.toMatchObject({ code: "NOT_FOUND" });
    expect(fixture.rows.conversationSession).toHaveLength(0);
  });
  it("copies proven question content into immutable session/prompt/turn receipts and filters legacy turns", async () => {
    const prior = await previousQuestion();
    const conversation = await startCompanyUnderstandingQuestionConversation(alpha, { workspaceId, checkInId: prior.id });
    expect(conversation.turns).toHaveLength(1);
    expect(conversation.turns[0].assistantMessage).toContain(prior.questionText);
    for (const [kind, row] of [["ConversationSession", conversation], ["ConversationPromptInput", fixture.rows.conversationPromptInput[0]], ["ConversationTurn", conversation.turns[0]]] as const) {
      expect(fixture.manifest(kind, row.id).origin).toBe("DERIVED");
      expect(fixture.sources(kind, row.id).has(`CheckIn:${prior.id}`)).toBe(true);
      expect(await readableArtifactIds(alpha, workspaceId, kind, [row])).toEqual(new Set([row.id]));
      expect(await readableArtifactIds(beta, workspaceId, kind, [row])).toEqual(new Set());
    }
    expect(await readableArtifactIds(alpha, workspaceId, "CheckIn", [fixture.rows.checkIn[0]])).toEqual(new Set([prior.id]));
    fixture.add("conversationTurn", { id: "legacy-turn", conversationId: conversation.id, sequenceNumber: 2, userMessage: "Unknown private history", assistantMessage: "Unknown answer" });
    const second = await startCompanyUnderstandingQuestionConversation(alpha, { workspaceId, checkInId: prior.id });
    expect(second.turns).toHaveLength(1);
    expect(JSON.stringify(second)).not.toContain("Unknown private history");
    expect(second.turns[0].sequenceNumber).toBe(1);
  });
  it("rolls back a chat copy when a captured source changes before the atomic receipt", async () => {
    const doc = fixture.add("document", { id: "race-input", workspaceId, title: "Public source", textContent: "Original body", accessDomain: "WORKSPACE", archivedAt: null });
    await known("Document", doc, [], alpha);
    const question = await previousQuestion();
    await known("CheckIn", question, [{ kind: "Document", id: doc.id }], alpha);
    const create = fixture.prisma.conversationSession.create.getMockImplementation();
    fixture.prisma.conversationSession.create.mockImplementationOnce(async (args: any) => {
      const session = await create(args);
      fixture.rows.document[0].archivedAt = fixture.timestamp;
      return session;
    });
    await expect(startCompanyUnderstandingQuestionConversation(alpha, { workspaceId, checkInId: question.id })).rejects.toMatchObject({ code: "SOURCE_CHANGED" });
    expect(fixture.rows.conversationSession).toHaveLength(0);
    expect(fixture.rows.conversationTurn).toHaveLength(0);
    expect(fixture.rows.conversationPromptInput).toHaveLength(0);
    expect(fixture.rows.checkIn[0].relatedConversationId).toBeNull();
  });
  it("does not recertify an existing linked conversation with unknown history", async () => {
    const question = await previousQuestion();
    fixture.add("conversationSession", { id: "unknown-session", workspaceId, userId: "alpha", topic: "Unknown private topic", systemPrompt: "Unproven generated instructions" });
    question.relatedConversationId = "unknown-session";
    await known("CheckIn", question, [], alpha);
    await expect(startCompanyUnderstandingQuestionConversation(alpha, { workspaceId, checkInId: question.id })).rejects.toMatchObject({ code: "NOT_FOUND" });
    expect(fixture.manifest("ConversationSession", "unknown-session")).toBeUndefined();
  });
  it("preserves restricted question ancestry in contributed answers and revokes linked history live", async () => {
    const doc = fixture.add("document", { id: "private-question-input", workspaceId, title: "Finance", textContent: "Finance body", accessDomain: "FINANCE", archivedAt: null });
    await knownCopiedDocument(doc);
    const question = fixture.add("checkIn", { id: "beta-question", workspaceId, memberId: "member-beta", questionType: "COMPANY_UNDERSTANDING", status: "OPEN", questionText: "Finance question", questionSource: "AI" });
    await known("CheckIn", question, [{ kind: "Document", id: doc.id }], beta);
    await startCompanyUnderstandingQuestionConversation(beta, { workspaceId, checkInId: question.id });
    fixture.domains.set("beta", ["WORKSPACE"]);
    await expect(startCompanyUnderstandingQuestionConversation(beta, { workspaceId, checkInId: question.id })).rejects.toMatchObject({ code: "NOT_FOUND" });
    fixture.domains.set("beta", ["WORKSPACE", "FINANCE"]);
    await respondToCheckIn(beta, { workspaceId, checkInId: question.id, responseMd: "Finance answer" });
    const source = fixture.rows.brainSource.find((row: any) => !row.id.startsWith("original-"));
    expect(fixture.manifest("BrainSource", source.id).origin).toBe("DERIVED");
    expect(fixture.sources("BrainSource", source.id).has(`Document:${doc.id}`)).toBe(true);
    expect(await readableArtifactIds(alpha, workspaceId, "BrainSource", [source])).toEqual(new Set());
  });
});
