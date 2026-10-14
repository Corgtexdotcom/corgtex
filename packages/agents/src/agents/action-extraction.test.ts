import { beforeEach, describe, expect, it, vi } from "vitest";
import { fixture, workspaceId, alpha, beta, resetFixture, known, knownCopiedDocument, sharedEnv, domainExports } from "./model-consumer.test-fixture";
vi.mock("@corgtex/shared", () => ({ prisma: fixture.prisma, env: sharedEnv,
  toInputJson: (value: unknown) => JSON.parse(JSON.stringify(value)) }));
vi.mock("../../../domain/src/auth", () => ({ requireWorkspaceMembership: fixture.membership, isGlobalOperator: () => false }));
vi.mock("../../../domain/src/brain-access", () => ({ resolveKnowledgeAccessDomains: async (actor: any) =>
  actor.kind === "agent" ? ["WORKSPACE", "FINANCE"] : fixture.domains.get(actor.user.id) ?? [] }));
vi.mock("@corgtex/domain", () => domainExports());
vi.mock("@corgtex/models", () => ({ resolveModel: () => "synthetic-model", defaultModelGateway: { chat: fixture.chat } }));
import { readableArtifactIds } from "../../../domain/src/source-lineage";
import { meetingTranscriptInputProjection } from "../../../domain/src/meeting-intelligence-context";
beforeEach(resetFixture);
import { runActionExtractionAgent } from "./action-extraction";

async function meeting(transcript: string | null = "Original transcript body") {
  const row = fixture.add("meeting", { id: "meeting-original", workspaceId, title: "Original transcript", transcript, summaryMd: "UNPROVEN LEGACY SUMMARY",
    source: "upload", status: "COMPLETED", ingestionGuidanceMd: "Original guidance", recordedAt: fixture.timestamp, scheduledEndAt: null,
    seriesId: null, participantIds: ["alpha"], participantEmails: [], archivedAt: null });
  await known("MeetingTranscript", meetingTranscriptInputProjection(row), [], alpha);
  const publicInsight = fixture.add("meetingInsight", { id: "insight-public", workspaceId, meetingId: row.id, type: "ACTION", operation: "CREATE", status: "SUGGESTED", title: "Known insight", bodyMd: "Known insight body", metadataJson: {}, supersededAt: null });
  await known("MeetingInsight", publicInsight);
  const privateDoc = fixture.add("document", { id: "finance-doc", workspaceId, title: "Finance input", textContent: "Finance body", accessDomain: "FINANCE", archivedAt: null });
  await knownCopiedDocument(privateDoc);
  await known("MeetingInsight", fixture.add("meetingInsight", { ...publicInsight, id: "insight-restricted" }), [{ kind: "Document", id: privateDoc.id }]);
  fixture.add("meetingInsight", { ...publicInsight, id: "insight-legacy" });
  fixture.add("meetingInsight", { ...publicInsight, id: "insight-foreign", workspaceId: "ws-b" });
  fixture.add("meetingInsight", { ...publicInsight, id: "insight-superseded", supersededAt: fixture.timestamp });
  return row;
}
describe("Action extraction actual runtime receipts", () => {
  it("captures the native transcript and complete proven insight count without copying legacy summary", async () => {
    const row = await meeting();
    const run = await runActionExtractionAgent({ workspaceId, triggerRef: "extract-trigger", meetingId: row.id, lineageActor: alpha }) as any;
    expect(run).toMatchObject({ status: "COMPLETED", resultJson: { meetingId: row.id, reviewRequired: true, suggested: 1 } });
    expect(JSON.stringify(run.contextJson)).not.toContain("UNPROVEN LEGACY SUMMARY");
    expect(fixture.sources("AgentRun", run.id).has(`MeetingTranscript:${row.id}`)).toBe(true);
    expect(fixture.sources("AgentRun", run.id).has("MeetingInsight:insight-public")).toBe(true);
    expect(fixture.sources("AgentRun", run.id).has("Meeting:meeting-original")).toBe(false);
    expect(fixture.chat).not.toHaveBeenCalled();
    expect(await readableArtifactIds(alpha, workspaceId, "AgentRun", [run])).toEqual(new Set([run.id]));
    expect(fixture.rows.agentToolCall.every((call: any) => fixture.manifest("AgentToolCall", call.id).origin === "DERIVED")).toBe(true);
  });
  it("captures permitted private insight ancestry and makes the result unreadable after revocation", async () => {
    const row = await meeting();
    const run = await runActionExtractionAgent({ workspaceId, triggerRef: "beta-extract", meetingId: row.id, lineageActor: beta }) as any;
    expect(run.resultJson.suggested).toBe(2);
    fixture.domains.set("beta", ["WORKSPACE"]);
    expect(await readableArtifactIds(beta, workspaceId, "AgentRun", [run])).toEqual(new Set());
  });
  it("returns receipted missing meeting/transcript outcomes without foreign text", async () => {
    const missing = await runActionExtractionAgent({ workspaceId, triggerRef: "missing", meetingId: "foreign-meeting", lineageActor: alpha }) as any;
    expect(missing).toMatchObject({ status: "COMPLETED", resultJson: { skipped: true, reason: "missing_meeting" } });
    expect(await readableArtifactIds(alpha, workspaceId, "AgentRun", [missing])).toEqual(new Set([missing.id]));
    const row = await meeting(null);
    const empty = await runActionExtractionAgent({ workspaceId, triggerRef: "empty-transcript", meetingId: row.id, lineageActor: alpha }) as any;
    expect(empty).toMatchObject({ status: "COMPLETED", resultJson: { skipped: true, reason: "missing_transcript", meetingId: row.id } });
    expect(await readableArtifactIds(alpha, workspaceId, "AgentRun", [empty])).toEqual(new Set([empty.id]));
  });
});
