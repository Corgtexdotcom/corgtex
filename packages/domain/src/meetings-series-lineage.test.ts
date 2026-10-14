import { beforeEach, describe, expect, it, vi } from "vitest";
import { fixture, workspaceId, alpha, beta, resetFixture } from "../../agents/src/agents/model-consumer.test-fixture";
import { captureImmutableArtifactInputProof, isArtifactInputProofReadable, lineageContentFingerprint,
  recordArtifactInputLineage, type LineageRoot } from "./source-lineage";
import { prepareProducerLineage } from "./producer-lineage";

vi.mock("@corgtex/shared", () => ({ prisma: fixture.prisma }));
vi.mock("./auth", () => ({ requireWorkspaceMembership: fixture.membership, isGlobalOperator: () => false }));
vi.mock("./brain-access", () => ({ resolveKnowledgeAccessDomains: async (actor: typeof alpha) =>
  actor.kind === "user" ? fixture.domains.get(actor.user.id) ?? [] : ["WORKSPACE"] }));

beforeEach(async () => {
  await resetFixture();
  fixture.rows.meetingSeries = [];
  fixture.prisma.meetingSeries = { findFirst: vi.fn(async ({ where }: { where: { id: string; workspaceId: string } }) =>
    fixture.rows.meetingSeries.find((row) => row.id === where.id && row.workspaceId === where.workspaceId) ?? null) };
});

function rows() {
  const series = fixture.add("meetingSeries", { id: "series-1", workspaceId, title: "Synthetic planning",
    description: null, source: "internal", recurrenceRule: "FREQ=WEEKLY", meetingUrl: "https://meet.google.com/old",
    startsAt: new Date("2026-10-20T09:00:00Z"), defaultDurationMinutes: 60,
    participantIds: [], participantEmails: [], archivedAt: null });
  const meeting = fixture.add("meeting", { id: "occurrence-1", workspaceId, seriesId: series.id,
    title: series.title, source: "internal", status: "SCHEDULED", transcript: null, summaryMd: null,
    meetingUrl: series.meetingUrl, meetingUrlHash: "old-hash", recordedAt: series.startsAt,
    scheduledEndAt: new Date("2026-10-20T10:00:00Z"), participantIds: [], participantEmails: [], archivedAt: null });
  return { series, meeting };
}

describe("MeetingSeries mutable writer proof", () => {
  it("freezes the old series and occurrence before a URL edit and retains live revocation", async () => {
    const { series, meeting } = rows();
    await recordArtifactInputLineage({ tx: fixture.prisma, actor: alpha, workspaceId,
      artifact: { kind: "MeetingSeries", id: series.id }, content: series, origin: "HUMAN_ORIGINAL", inputs: [] });
    await recordArtifactInputLineage({ tx: fixture.prisma, actor: alpha, workspaceId,
      artifact: { kind: "Meeting", id: meeting.id }, content: meeting, origin: "DERIVED",
      inputs: [{ kind: "MeetingSeries", id: series.id }] });
    const oldSeriesRoot: LineageRoot = { kind: "MeetingSeries", id: series.id,
      fingerprint: lineageContentFingerprint("MeetingSeries", series) };
    const oldMeetingRoot: LineageRoot = { kind: "Meeting", id: meeting.id,
      fingerprint: lineageContentFingerprint("Meeting", meeting) };
    const seriesProof = await captureImmutableArtifactInputProof(alpha, workspaceId, [oldSeriesRoot], fixture.prisma);
    const meetingProof = await captureImmutableArtifactInputProof(alpha, workspaceId, [oldMeetingRoot], fixture.prisma);
    series.meetingUrl = "https://meet.google.com/new";
    await recordArtifactInputLineage({ tx: fixture.prisma, actor: alpha, workspaceId,
      artifact: { kind: "MeetingSeries", id: series.id }, content: series, origin: "DERIVED", inputs: [],
      inheritedRoots: seriesProof });
    meeting.meetingUrl = series.meetingUrl;
    meeting.meetingUrlHash = "new-hash";
    await recordArtifactInputLineage({ tx: fixture.prisma, actor: alpha, workspaceId,
      artifact: { kind: "Meeting", id: meeting.id }, content: meeting, origin: "DERIVED", inputs: [],
      inheritedRoots: [...meetingProof, { kind: "MeetingSeries", id: series.id,
        fingerprint: lineageContentFingerprint("MeetingSeries", series) }] });
    const nextRoot: LineageRoot = { kind: "Meeting", id: meeting.id,
      fingerprint: lineageContentFingerprint("Meeting", meeting) };
    expect(await isArtifactInputProofReadable(beta, workspaceId, [nextRoot], fixture.prisma)).toBe(true);
    series.archivedAt = new Date();
    expect(await isArtifactInputProofReadable(beta, workspaceId, [nextRoot], fixture.prisma)).toBe(false);
  });

  it("cannot freeze a child after its series revision has already changed", async () => {
    const { series, meeting } = rows();
    await recordArtifactInputLineage({ tx: fixture.prisma, actor: alpha, workspaceId,
      artifact: { kind: "MeetingSeries", id: series.id }, content: series, origin: "HUMAN_ORIGINAL", inputs: [] });
    await recordArtifactInputLineage({ tx: fixture.prisma, actor: alpha, workspaceId,
      artifact: { kind: "Meeting", id: meeting.id }, content: meeting, origin: "DERIVED",
      inputs: [{ kind: "MeetingSeries", id: series.id }] });
    const oldMeetingRoot: LineageRoot = { kind: "Meeting", id: meeting.id,
      fingerprint: lineageContentFingerprint("Meeting", meeting) };
    series.meetingUrl = "https://meet.google.com/new";
    await expect(captureImmutableArtifactInputProof(alpha, workspaceId, [oldMeetingRoot], fixture.prisma))
      .rejects.toMatchObject({ code: "SOURCE_CHANGED" });
  });

  it("rejects materialization from a stale series field snapshot before writing a child", async () => {
    const { series } = rows();
    await recordArtifactInputLineage({ tx: fixture.prisma, actor: alpha, workspaceId,
      artifact: { kind: "MeetingSeries", id: series.id }, content: series, origin: "HUMAN_ORIGINAL", inputs: [] });
    const selected = structuredClone(series);
    series.title = "A changed planning title";
    await recordArtifactInputLineage({ tx: fixture.prisma, actor: alpha, workspaceId,
      artifact: { kind: "MeetingSeries", id: series.id }, content: series, origin: "HUMAN_ORIGINAL", inputs: [] });
    await expect(prepareProducerLineage({ tx: fixture.prisma, actor: alpha, workspaceId,
      dependencies: [{ kind: "MeetingSeries", id: series.id, snapshot: selected }], completeCopy: true }))
      .rejects.toMatchObject({ code: "SOURCE_CHANGED" });
  });
});
