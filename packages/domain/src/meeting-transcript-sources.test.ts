import { createHmac } from "node:crypto";
import { beforeEach, describe, expect, it, vi } from "vitest";

const { prismaMock, intakeMeetingTranscriptMock } = vi.hoisted(() => ({
  prismaMock: {
    $transaction: vi.fn(),
    meetingTranscriptImportBatch: {
      create: vi.fn(),
      update: vi.fn(),
      findFirst: vi.fn(),
    },
    meetingTranscriptSourceRecord: {
      findUnique: vi.fn(),
      findFirst: vi.fn(),
      create: vi.fn(),
      upsert: vi.fn(),
      update: vi.fn(),
      updateMany: vi.fn(),
    },
    meetingTranscriptSourceConnection: {
      upsert: vi.fn(),
      findUnique: vi.fn(),
      update: vi.fn(),
    },
    member: {
      findUnique: vi.fn(),
    },
    workspaceFeatureFlag: {
      findUnique: vi.fn(),
    },
    auditLog: {
      create: vi.fn(),
    },
  },
  intakeMeetingTranscriptMock: vi.fn(),
}));

vi.mock("@corgtex/shared", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@corgtex/shared")>();
  return {
    ...actual,
    prisma: prismaMock,
    encryptSecret: (value: string) => `enc:${value}`,
    decryptSecret: (value: string) => value.replace(/^enc:/, ""),
    toInputJson: (value: unknown) => value,
  };
});

vi.mock("./meeting-transcript-intake", () => ({
  intakeMeetingTranscript: intakeMeetingTranscriptMock,
}));

const agentActor = {
  kind: "agent" as const,
  authProvider: "bootstrap" as const,
  label: "test-agent",
  workspaceIds: ["ws-1"],
};

const userActor = {
  kind: "user" as const,
  user: { id: "user-1", email: "jan@example.com", displayName: "Jan" },
};

describe("meeting transcript sources", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    prismaMock.$transaction.mockImplementation((callback) => callback(prismaMock));
    prismaMock.meetingTranscriptImportBatch.create.mockResolvedValue({
      id: "batch-1",
      workspaceId: "ws-1",
      provider: "FIREFLIES",
      status: "RUNNING",
    });
    prismaMock.meetingTranscriptImportBatch.update.mockImplementation(({ data }) => Promise.resolve({
      id: "batch-1",
      workspaceId: "ws-1",
      provider: "FIREFLIES",
      ...data,
    }));
    prismaMock.meetingTranscriptSourceRecord.findUnique.mockResolvedValue(null);
    prismaMock.meetingTranscriptSourceRecord.findFirst.mockResolvedValue(null);
    prismaMock.meetingTranscriptSourceRecord.create.mockImplementation(({ data }) => Promise.resolve({
      id: `record-${prismaMock.meetingTranscriptSourceRecord.create.mock.calls.length}`,
      ...data,
    }));
    prismaMock.meetingTranscriptSourceRecord.upsert.mockImplementation(({ create, update }) => Promise.resolve({
      id: "record-upserted",
      ...create,
      ...update,
    }));
    prismaMock.meetingTranscriptSourceRecord.update.mockResolvedValue({});
    prismaMock.meetingTranscriptSourceRecord.updateMany.mockResolvedValue({ count: 1 });
    prismaMock.meetingTranscriptSourceConnection.upsert.mockImplementation(({ create, update }) => Promise.resolve({
      id: "connection-1",
      ...create,
      ...update,
    }));
    prismaMock.meetingTranscriptSourceConnection.findUnique.mockResolvedValue({
      id: "connection-1",
      workspaceId: "ws-1",
      provider: "FIREFLIES",
      webhookSecretEnc: "enc:secret",
    });
    prismaMock.meetingTranscriptSourceConnection.update.mockResolvedValue({});
    prismaMock.member.findUnique.mockResolvedValue({
      id: "member-1",
      workspaceId: "ws-1",
      userId: "user-1",
      role: "ADMIN",
      isActive: true,
    });
    prismaMock.workspaceFeatureFlag.findUnique.mockResolvedValue({ enabled: true });
    prismaMock.auditLog.create.mockResolvedValue({});
    intakeMeetingTranscriptMock.mockResolvedValue({
      status: "meeting_matched",
      meeting: { id: "meeting-1", title: "Weekly" },
      inferred: {},
      message: "saved",
    });
  });

  it("ranks ready providers and keeps manual export guidance in the catalog", async () => {
    const { getMeetingTranscriptProviderCatalog } = await import("./meeting-transcript-sources");

    const catalog = getMeetingTranscriptProviderCatalog();

    expect(catalog[0]).toMatchObject({ provider: "FIREFLIES", connectionStatus: "ready" });
    expect(catalog[1]).toMatchObject({ provider: "FATHOM", connectionStatus: "ready" });
    expect(catalog.find((entry) => entry.provider === "OTTER")?.manualExportInstructions.join(" ")).toContain("bulk export");
  });

  it("normalizes JSON and VTT transcript artifacts with speaker segments", async () => {
    const { normalizeMeetingTranscriptSourceArtifact } = await import("./meeting-transcript-sources");

    const json = normalizeMeetingTranscriptSourceArtifact("FIREFLIES", {
      fileName: "fireflies.json",
      json: {
        id: "ff-1",
        title: "Product Weekly",
        date: "2026-05-01T10:00:00.000Z",
        participants: [{ name: "Jan", email: "Jan@Example.com" }],
        sentences: [
          { speaker_name: "Jan", text: "We should import recorders first.", start_time: 1, end_time: 4 },
        ],
      },
    });
    const stringTranscriptJson = normalizeMeetingTranscriptSourceArtifact("OTTER", {
      fileName: "otter.json",
      json: {
        id: "otter-1",
        title: "Customer Call",
        date: "2026-05-03T10:00:00.000Z",
        transcript: "Jan: This transcript field is already plain text.",
      },
    });
    const vtt = normalizeMeetingTranscriptSourceArtifact("FATHOM", {
      fileName: "2026-05-02-fathom.vtt",
      text: [
        "WEBVTT",
        "00:00:01.000 --> 00:00:04.000",
        "Milan: Newer transcript evidence should win.",
      ].join("\n"),
    });

    expect(json).toMatchObject({
      externalId: "ff-1",
      title: "Product Weekly",
      transcript: "Jan: We should import recorders first.",
      participantEmails: ["jan@example.com"],
    });
    expect(json.segments[0]).toMatchObject({ speaker: "Jan", startMs: 1000 });
    expect(stringTranscriptJson.transcript).toBe("Jan: This transcript field is already plain text.");
    expect(vtt.recordedAt).toEqual(new Date("2026-05-02T00:00:00.000Z"));
    expect(vtt.transcript).toContain("Milan: Newer transcript evidence should win.");
  });

  it("requires a recorded date when the artifact does not expose one", async () => {
    const { normalizeMeetingTranscriptSourceArtifact } = await import("./meeting-transcript-sources");

    expect(() => normalizeMeetingTranscriptSourceArtifact("FIREFLIES", {
      fileName: "unknown.txt",
      text: "Jan: No date here.",
    })).toThrow("Recorded date is required");
  });

  it("gates transcript imports on the meeting recorder feature flag", async () => {
    prismaMock.workspaceFeatureFlag.findUnique.mockResolvedValueOnce(null);
    const { importMeetingTranscriptSourceArtifacts } = await import("./meeting-transcript-sources");

    await expect(importMeetingTranscriptSourceArtifacts(agentActor, {
      workspaceId: "ws-1",
      provider: "FIREFLIES",
      artifacts: [{
        externalId: "ff-disabled",
        recordedAt: "2026-05-01T10:00:00.000Z",
        text: "Jan: This should not import while disabled.",
      }],
    })).rejects.toMatchObject({
      code: "FEATURE_DISABLED",
    });

    expect(prismaMock.meetingTranscriptImportBatch.create).not.toHaveBeenCalled();
  });

  it("restricts provider credential writes to workspace admins", async () => {
    prismaMock.member.findUnique.mockResolvedValueOnce({
      id: "member-1",
      workspaceId: "ws-1",
      userId: "user-1",
      role: "FACILITATOR",
      isActive: true,
    });
    const { connectMeetingTranscriptSource } = await import("./meeting-transcript-sources");

    await expect(connectMeetingTranscriptSource(userActor, {
      workspaceId: "ws-1",
      provider: "FIREFLIES",
      apiKey: "fireflies-key",
    })).rejects.toMatchObject({
      code: "FORBIDDEN",
    });

    expect(prismaMock.meetingTranscriptSourceConnection.upsert).not.toHaveBeenCalled();
  });

  it("includes the meeting date in fallback external IDs", async () => {
    const { normalizeMeetingTranscriptSourceArtifact } = await import("./meeting-transcript-sources");

    const first = normalizeMeetingTranscriptSourceArtifact("FIREFLIES", {
      fileName: "transcript.txt",
      recordedAt: "2026-05-01T10:00:00.000Z",
      text: "Jan: Same export body.",
    });
    const second = normalizeMeetingTranscriptSourceArtifact("FIREFLIES", {
      fileName: "transcript.txt",
      recordedAt: "2026-05-02T10:00:00.000Z",
      text: "Jan: Same export body.",
    });
    const corrected = normalizeMeetingTranscriptSourceArtifact("FIREFLIES", {
      fileName: "transcript.txt",
      recordedAt: "2026-05-01T10:00:00.000Z",
      text: "Jan: Corrected export body.",
    });

    expect(first.externalId).not.toBe(second.externalId);
    expect(corrected.externalId).toBe(first.externalId);
  });

  it("imports batches oldest-to-newest and replaces a newer source revision", async () => {
    prismaMock.meetingTranscriptSourceRecord.findFirst
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce({
        id: "record-old",
        meetingId: "meeting-1",
        contentHash: "previous",
        recordedAt: new Date("2026-05-01T10:00:00.000Z"),
        sourceUpdatedAt: new Date("2026-05-01T11:00:00.000Z"),
      });
    const { importMeetingTranscriptSourceArtifacts } = await import("./meeting-transcript-sources");

    const result = await importMeetingTranscriptSourceArtifacts(agentActor, {
      workspaceId: "ws-1",
      provider: "FIREFLIES",
      artifacts: [
        {
          externalId: "ff-1",
          title: "Later revision",
          recordedAt: "2026-05-02T10:00:00.000Z",
          sourceUpdatedAt: "2026-05-02T11:00:00.000Z",
          text: "Jan: Later source.",
        },
        {
          externalId: "ff-0",
          title: "Earlier meeting",
          recordedAt: "2026-05-01T10:00:00.000Z",
          sourceUpdatedAt: "2026-05-01T11:00:00.000Z",
          text: "Jan: Earlier source.",
        },
      ],
    });

    expect(result.batch).toMatchObject({ status: "COMPLETED", importedCount: 2, skippedCount: 0, failedCount: 0 });
    expect(intakeMeetingTranscriptMock.mock.calls[0][1]).toMatchObject({ externalId: "meeting-transcript:FIREFLIES:ff-0" });
    expect(intakeMeetingTranscriptMock.mock.calls[1][1]).toMatchObject({
      meetingId: "meeting-1",
      externalId: "meeting-transcript:FIREFLIES:ff-1",
      replaceTranscript: true,
    });
    expect(prismaMock.meetingTranscriptSourceRecord.updateMany).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({ status: "SUPERSEDED" }),
    }));
    expect(prismaMock.meetingTranscriptSourceRecord.updateMany.mock.invocationCallOrder[0])
      .toBeLessThan(intakeMeetingTranscriptMock.mock.invocationCallOrder[1]);
  });

  it("imports changed revisions when providers omit updated-at timestamps", async () => {
    prismaMock.meetingTranscriptSourceRecord.findFirst.mockResolvedValueOnce({
      id: "record-active",
      meetingId: "meeting-1",
      contentHash: "previous-hash",
      recordedAt: new Date("2026-05-01T10:00:00.000Z"),
      sourceUpdatedAt: new Date("2026-05-02T11:00:00.000Z"),
    });
    const { importMeetingTranscriptSourceArtifacts } = await import("./meeting-transcript-sources");

    const result = await importMeetingTranscriptSourceArtifacts(agentActor, {
      workspaceId: "ws-1",
      provider: "FIREFLIES",
      artifacts: [{
        externalId: "ff-1",
        title: "Corrected transcript",
        recordedAt: "2026-05-01T10:00:00.000Z",
        text: "Jan: Corrected transcript body.",
      }],
    });

    expect(result.batch).toMatchObject({ status: "COMPLETED", importedCount: 1, skippedCount: 0 });
    expect(prismaMock.meetingTranscriptSourceRecord.create).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({
        status: "ACTIVE",
        supersededByRecordId: null,
        sourceUpdatedAt: null,
      }),
    }));
    expect(intakeMeetingTranscriptMock).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({
      meetingId: "meeting-1",
      replaceTranscript: true,
    }));
  });

  it("reuses a failed same-hash source row when retrying the artifact", async () => {
    prismaMock.meetingTranscriptSourceRecord.findUnique.mockResolvedValueOnce({
      id: "failed-record",
      status: "FAILED",
      provider: "FIREFLIES",
      externalId: "ff-failed",
      contentHash: "same-hash",
    });
    prismaMock.meetingTranscriptSourceRecord.update.mockImplementation(({ where, data }) => Promise.resolve({
      id: where.id,
      ...data,
    }));
    const { importMeetingTranscriptSourceArtifacts } = await import("./meeting-transcript-sources");

    const result = await importMeetingTranscriptSourceArtifacts(agentActor, {
      workspaceId: "ws-1",
      provider: "FIREFLIES",
      artifacts: [{
        externalId: "ff-failed",
        title: "Retry me",
        recordedAt: "2026-05-01T10:00:00.000Z",
        text: "Jan: Retry this failed transcript.",
      }],
    });

    expect(result.batch).toMatchObject({ status: "COMPLETED", importedCount: 1 });
    expect(prismaMock.meetingTranscriptSourceRecord.create).not.toHaveBeenCalled();
    expect(prismaMock.meetingTranscriptSourceRecord.update).toHaveBeenCalledWith(expect.objectContaining({
      where: { id: "failed-record" },
      data: expect.objectContaining({ status: "ACTIVE", error: null }),
    }));
  });

  it("treats active same-hash import races as duplicate skips", async () => {
    prismaMock.meetingTranscriptSourceRecord.findUnique
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce({
        id: "active-record",
        status: "ACTIVE",
        meetingId: "meeting-1",
        processedAt: new Date("2026-05-01T10:05:00.000Z"),
      });
    prismaMock.meetingTranscriptSourceRecord.create.mockRejectedValueOnce(new Error("Unique constraint failed"));
    const { importMeetingTranscriptSourceArtifacts } = await import("./meeting-transcript-sources");

    const result = await importMeetingTranscriptSourceArtifacts(agentActor, {
      workspaceId: "ws-1",
      provider: "FIREFLIES",
      artifacts: [{
        externalId: "ff-race",
        title: "Duplicate webhook",
        recordedAt: "2026-05-01T10:00:00.000Z",
        text: "Jan: Duplicate delivery.",
      }],
    });

    expect(result.batch).toMatchObject({ status: "COMPLETED", importedCount: 0, skippedCount: 1, failedCount: 0 });
    expect(prismaMock.meetingTranscriptSourceRecord.update).not.toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({ status: "FAILED" }),
    }));
  });

  it("preserves matching metadata when retrying failed batches", async () => {
    prismaMock.meetingTranscriptImportBatch.findFirst.mockResolvedValueOnce({
      id: "batch-failed",
      workspaceId: "ws-1",
      provider: "FIREFLIES",
      connectionId: "connection-1",
      records: [{
        externalId: "ff-retry",
        title: "Retry with metadata",
        recordedAt: new Date("2026-05-01T10:00:00.000Z"),
        sourceUpdatedAt: new Date("2026-05-01T11:00:00.000Z"),
        sourceUrl: "https://fireflies.ai/transcripts/ff-retry",
        transcriptText: "Jan: Retry with full matching context.",
        summaryMd: null,
        rawMetadataJson: {
          meetingUrl: "https://meet.google.com/abc-defg-hij",
          calendarExternalId: "calendar-event-1",
        },
        participantsJson: {
          participantEmails: ["Jan@Example.com"],
          participants: [{ name: "Jan" }],
        },
        segmentsJson: [],
      }],
    });
    const { retryMeetingTranscriptImportBatch } = await import("./meeting-transcript-sources");

    await retryMeetingTranscriptImportBatch(agentActor, {
      workspaceId: "ws-1",
      batchId: "batch-failed",
    });

    expect(intakeMeetingTranscriptMock).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({
      meetingUrl: "https://meet.google.com/abc-defg-hij",
      calendarExternalId: "calendar-event-1",
      participantEmails: ["jan@example.com"],
    }));
  });

  it("imports valid artifacts when another batch file cannot be normalized", async () => {
    const { importMeetingTranscriptSourceArtifacts } = await import("./meeting-transcript-sources");

    const result = await importMeetingTranscriptSourceArtifacts(agentActor, {
      workspaceId: "ws-1",
      provider: "FIREFLIES",
      artifacts: [
        {
          fileName: "readme.txt",
          text: "This ZIP sidecar has no meeting date.",
        },
        {
          externalId: "ff-valid",
          title: "Valid transcript",
          recordedAt: "2026-05-01T10:00:00.000Z",
          text: "Jan: This valid meeting should still import.",
        },
      ],
    });

    expect(result.batch).toMatchObject({ status: "PARTIAL", importedCount: 1, failedCount: 1 });
    expect(prismaMock.meetingTranscriptSourceRecord.upsert).toHaveBeenCalledWith(expect.objectContaining({
      create: expect.objectContaining({
        status: "FAILED",
        rawMetadataJson: expect.objectContaining({
          normalizationFailed: true,
        }),
      }),
    }));
    expect(intakeMeetingTranscriptMock).toHaveBeenCalledTimes(1);
    expect(intakeMeetingTranscriptMock).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({
      externalId: "meeting-transcript:FIREFLIES:ff-valid",
    }));
  });

  it("verifies provider webhook signatures before accepting payloads", async () => {
    const { verifyMeetingTranscriptWebhookSignature } = await import("./meeting-transcript-sources");
    const rawBody = JSON.stringify({ event: "meeting.transcribed", transcript_id: "ff-1" });
    const secret = "webhook-secret";
    const signature = `sha256=${createHmac("sha256", secret).update(rawBody).digest("hex")}`;

    expect(verifyMeetingTranscriptWebhookSignature({
      provider: "fireflies",
      rawBody,
      secret,
      headers: { "x-fireflies-signature": signature },
    })).toBe(true);
    expect(verifyMeetingTranscriptWebhookSignature({
      provider: "fireflies",
      rawBody,
      secret: "wrong",
      headers: { "x-fireflies-signature": signature },
    })).toBe(false);
  });

  it("imports nested transcript bodies from signed webhooks without fetching provider APIs", async () => {
    const { processMeetingTranscriptSourceWebhook } = await import("./meeting-transcript-sources");
    const rawBody = JSON.stringify({
      data: {
        id: "webhook-event-1",
        title: "Nested webhook",
        recordedAt: "2026-05-01T10:00:00.000Z",
      },
      transcript: {
        id: "ff-nested",
        text: "Jan: Nested webhook text.",
      },
    });
    const signature = `sha256=${createHmac("sha256", "secret").update(rawBody).digest("hex")}`;

    await processMeetingTranscriptSourceWebhook({
      workspaceId: "ws-1",
      provider: "FIREFLIES",
      rawBody,
      headers: { "x-fireflies-signature": signature },
    });

    expect(intakeMeetingTranscriptMock).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({
      externalId: "meeting-transcript:FIREFLIES:ff-nested",
      transcript: "Jan: Nested webhook text.",
    }));
  });
});
