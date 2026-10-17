import { beforeEach, describe, expect, it, vi } from "vitest";
import { fixture, workspaceId, alpha, beta, resetFixture, known } from "../../agents/src/agents/model-consumer.test-fixture";
import { captureArtifactInputSnapshotProof, isArtifactInputProofReadable, lineageContentFingerprint,
  recordArtifactInputLineage, type LineageRoot } from "./source-lineage";
import { meetingTranscriptInputProjection } from "./meeting-intelligence-context";

vi.mock("@corgtex/shared", () => ({ prisma: fixture.prisma }));
vi.mock("./auth", () => ({ requireWorkspaceMembership: fixture.membership, isGlobalOperator: () => false }));
vi.mock("./brain-access", () => ({ resolveKnowledgeAccessDomains: async (actor: typeof alpha) =>
  actor.kind === "user" ? fixture.domains.get(actor.user.id) ?? [] : ["WORKSPACE"] }));

beforeEach(resetFixture);

function originalMeeting(id = "meeting-original") {
  return fixture.add("meeting", { id, workspaceId, title: "Synthetic meeting", source: "manual",
    transcript: "Exact directly submitted transcript", ingestionGuidanceMd: null,
    recordedAt: new Date("2026-10-12T09:00:00Z"), scheduledEndAt: null, seriesId: null,
    participantIds: [], participantEmails: [], archivedAt: null });
}

describe("MeetingTranscript source proof", () => {
  it("withholds a legacy transcript until its exact directly submitted revision has a human receipt", async () => {
    const meeting = originalMeeting();
    const content = meetingTranscriptInputProjection(meeting);
    const root: LineageRoot = { kind: "MeetingTranscript", id: meeting.id,
      fingerprint: lineageContentFingerprint("MeetingTranscript", content) };
    expect(await isArtifactInputProofReadable(alpha, workspaceId, [root], fixture.prisma)).toBe(false);
    await recordArtifactInputLineage({ tx: fixture.prisma, actor: alpha, workspaceId,
      artifact: { kind: "MeetingTranscript", id: meeting.id }, content,
      origin: "HUMAN_ORIGINAL", inputs: [] });
    expect(await isArtifactInputProofReadable(alpha, workspaceId, [root], fixture.prisma)).toBe(true);

    const [saved] = await captureArtifactInputSnapshotProof(alpha, workspaceId, root, fixture.prisma);
    meeting.transcript = "Later transcript edit";
    expect(await isArtifactInputProofReadable(alpha, workspaceId, [root], fixture.prisma)).toBe(false);
    expect(await isArtifactInputProofReadable(alpha, workspaceId, [saved], fixture.prisma)).toBe(true);
    meeting.archivedAt = new Date();
    expect(await isArtifactInputProofReadable(alpha, workspaceId, [saved], fixture.prisma)).toBe(false);
  });

  it("requires every live source behind a copied transcript", async () => {
    const source = fixture.add("document", { id: "source-document", workspaceId, title: "Synthetic source",
      textContent: "Synthetic exact input", accessDomain: "WORKSPACE", archivedAt: null });
    await known("Document", source, [], alpha);
    const meeting = originalMeeting("copied-meeting");
    const content = meetingTranscriptInputProjection(meeting);
    const root: LineageRoot = { kind: "MeetingTranscript", id: meeting.id,
      fingerprint: lineageContentFingerprint("MeetingTranscript", content) };
    await recordArtifactInputLineage({ tx: fixture.prisma, actor: alpha, workspaceId,
      artifact: { kind: "MeetingTranscript", id: meeting.id }, content,
      origin: "DERIVED", inputs: [{ kind: "Document", id: source.id }] });
    expect(await isArtifactInputProofReadable(alpha, workspaceId, [root], fixture.prisma)).toBe(true);
    fixture.domains.set("alpha", []);
    expect(await isArtifactInputProofReadable(alpha, workspaceId, [root], fixture.prisma)).toBe(false);
    expect(await isArtifactInputProofReadable(beta, workspaceId, [root], fixture.prisma)).toBe(true);
    source.archivedAt = new Date();
    expect(await isArtifactInputProofReadable(beta, workspaceId, [root], fixture.prisma)).toBe(false);
  });

  it("keeps a newly attached transcript tied to the exact prior scheduled meeting", async () => {
    const meeting = originalMeeting("scheduled-then-transcribed");
    meeting.transcript = null;
    meeting.title = "Human scheduled title";
    const scheduledRoot: LineageRoot = { kind: "Meeting", id: meeting.id,
      fingerprint: lineageContentFingerprint("Meeting", meeting) };
    await recordArtifactInputLineage({ tx: fixture.prisma, actor: alpha, workspaceId,
      artifact: { kind: "Meeting", id: meeting.id }, content: meeting,
      origin: "HUMAN_ORIGINAL", inputs: [] });
    const [prior] = await captureArtifactInputSnapshotProof(alpha, workspaceId, scheduledRoot, fixture.prisma);
    meeting.transcript = "Directly submitted synthetic transcript";
    const content = meetingTranscriptInputProjection(meeting);
    await recordArtifactInputLineage({ tx: fixture.prisma, actor: alpha, workspaceId,
      artifact: { kind: "MeetingTranscript", id: meeting.id }, content,
      origin: "DERIVED", inputs: [], inheritedRoots: [prior] });
    const transcriptRoot: LineageRoot = { kind: "MeetingTranscript", id: meeting.id,
      fingerprint: lineageContentFingerprint("MeetingTranscript", content) };
    expect(await isArtifactInputProofReadable(beta, workspaceId, [transcriptRoot], fixture.prisma)).toBe(true);
    meeting.archivedAt = new Date();
    expect(await isArtifactInputProofReadable(beta, workspaceId, [transcriptRoot], fixture.prisma)).toBe(false);
  });
});
