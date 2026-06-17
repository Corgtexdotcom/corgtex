import { createHmac } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

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
      findMany: vi.fn(),
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
      findMany: vi.fn(),
      upsert: vi.fn(),
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
    prismaMock.meetingTranscriptImportBatch.create.mockImplementation(({ data }) => Promise.resolve({
      id: "batch-1",
      workspaceId: "ws-1",
      provider: "FIREFLIES",
      status: "RUNNING",
      ...data,
    }));
    prismaMock.meetingTranscriptImportBatch.update.mockImplementation(({ data }) => Promise.resolve({
      id: "batch-1",
      workspaceId: "ws-1",
      provider: "FIREFLIES",
      ...data,
    }));
    prismaMock.meetingTranscriptSourceRecord.findUnique.mockResolvedValue(null);
    prismaMock.meetingTranscriptSourceRecord.findFirst.mockResolvedValue(null);
    prismaMock.meetingTranscriptSourceRecord.findMany.mockResolvedValue([]);
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
    prismaMock.workspaceFeatureFlag.findMany.mockResolvedValue([{ flag: "MEETING_TRANSCRIPT_SOURCES", enabled: true }]);
    prismaMock.workspaceFeatureFlag.upsert.mockImplementation(({ create, update }) => Promise.resolve({
      id: "flag-1",
      ...create,
      ...update,
    }));
    prismaMock.auditLog.create.mockResolvedValue({});
    intakeMeetingTranscriptMock.mockResolvedValue({
      status: "meeting_matched",
      meeting: { id: "meeting-1", title: "Weekly" },
      inferred: {},
      message: "saved",
    });
  });

  afterEach(() => {
    vi.unstubAllGlobals();
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

  it("gates transcript imports on transcript-source or legacy recorder feature flags", async () => {
    prismaMock.workspaceFeatureFlag.findMany.mockResolvedValueOnce([]);
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

    prismaMock.workspaceFeatureFlag.findMany.mockResolvedValueOnce([{ flag: "MEETING_RECORDERS", enabled: true }]);
    await expect(importMeetingTranscriptSourceArtifacts(agentActor, {
      workspaceId: "ws-1",
      provider: "FIREFLIES",
      artifacts: [{
        externalId: "ff-legacy",
        recordedAt: "2026-05-01T10:00:00.000Z",
        text: "Jan: Legacy recorder entitlement still allows transcript imports.",
      }],
    })).resolves.toMatchObject({
      batch: expect.objectContaining({ status: "COMPLETED" }),
    });
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

  it("creates a Fathom webhook when connecting with an API key and webhook URL", async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ secret: "whsec_created" }),
    });
    vi.stubGlobal("fetch", fetchMock);
    const { connectMeetingTranscriptSource } = await import("./meeting-transcript-sources");

    await connectMeetingTranscriptSource(userActor, {
      workspaceId: "ws-1",
      provider: "FATHOM",
      apiKey: "fathom-key",
      webhookUrl: "https://app.corgtex.com/api/integrations/meeting-transcripts/fathom/webhook?workspaceId=ws-1",
    });

    expect(fetchMock).toHaveBeenCalledWith("https://api.fathom.ai/external/v1/webhooks", expect.objectContaining({
      method: "POST",
      headers: expect.objectContaining({ "X-Api-Key": "fathom-key" }),
      body: expect.stringContaining("\"include_transcript\":true"),
    }));
    expect(prismaMock.meetingTranscriptSourceConnection.upsert).toHaveBeenCalledWith(expect.objectContaining({
      create: expect.objectContaining({
        provider: "FATHOM",
        apiKeyEnc: "enc:fathom-key",
        webhookSecretEnc: "enc:whsec_created",
      }),
      update: expect.objectContaining({
        webhookSecretEnc: "enc:whsec_created",
      }),
    }));
  });

  it("initializes transcript-source access without touching recorder configuration", async () => {
    const { enableMeetingTranscriptSourcesForWorkspace } = await import("./meeting-transcript-sources");

    await expect(enableMeetingTranscriptSourcesForWorkspace(userActor, {
      workspaceId: "ws-1",
    })).resolves.toEqual({ featureEnabled: true });

    expect(prismaMock.workspaceFeatureFlag.upsert).toHaveBeenCalledWith(expect.objectContaining({
      where: { workspaceId_flag: { workspaceId: "ws-1", flag: "MEETING_TRANSCRIPT_SOURCES" } },
      create: expect.objectContaining({
        workspaceId: "ws-1",
        flag: "MEETING_TRANSCRIPT_SOURCES",
        enabled: true,
      }),
      update: { enabled: true },
    }));
    expect(prismaMock.auditLog.create).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({
        action: "meeting-transcript-sources.feature-updated",
        meta: expect.objectContaining({ flag: "MEETING_TRANSCRIPT_SOURCES", enabled: true }),
      }),
    }));
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
    expect(verifyMeetingTranscriptWebhookSignature({
      provider: "fireflies",
      rawBody,
      secret,
      headers: { "x-hub-signature": signature },
    })).toBe(true);
  });

  it("verifies Fathom webhook signatures with signed id, timestamp, and body", async () => {
    const { verifyMeetingTranscriptWebhookSignature } = await import("./meeting-transcript-sources");
    const rawBody = JSON.stringify({ recording_id: 123456789, title: "QBR" });
    const secret = `whsec_${Buffer.from("fathom-webhook-secret").toString("base64")}`;
    const timestamp = String(Math.floor(Date.now() / 1000));
    const webhookId = "msg_123";
    const signature = createHmac("sha256", Buffer.from(secret.slice("whsec_".length), "base64"))
      .update(`${webhookId}.${timestamp}.${rawBody}`)
      .digest("base64");

    expect(verifyMeetingTranscriptWebhookSignature({
      provider: "fathom",
      rawBody,
      secret,
      headers: {
        "webhook-id": webhookId,
        "webhook-timestamp": timestamp,
        "webhook-signature": `v1,${signature}`,
      },
    })).toBe(true);
    expect(verifyMeetingTranscriptWebhookSignature({
      provider: "fathom",
      rawBody,
      secret,
      headers: {
        "webhook-id": webhookId,
        "webhook-timestamp": String(Number(timestamp) - 600),
        "webhook-signature": `v1,${signature}`,
      },
    })).toBe(false);
  });

  it("verifies Read.ai signatures with the base64 signing key", async () => {
    const { verifyMeetingTranscriptWebhookSignature } = await import("./meeting-transcript-sources");
    const rawBody = JSON.stringify({ trigger: "meeting_end", session_id: "read-session-1" });
    const secret = Buffer.from("read-webhook-secret").toString("base64");
    const signature = createHmac("sha256", Buffer.from(secret, "base64")).update(rawBody).digest("hex");

    expect(verifyMeetingTranscriptWebhookSignature({
      provider: "read-ai",
      rawBody,
      secret,
      headers: { "x-read-signature": signature },
    })).toBe(true);
    expect(verifyMeetingTranscriptWebhookSignature({
      provider: "read-ai",
      rawBody,
      secret: Buffer.from("wrong").toString("base64"),
      headers: { "x-read-signature": signature },
    })).toBe(false);
  });

  it("imports Read.ai meeting_end webhooks for Corgtex processing and action cross-checking", async () => {
    const { processMeetingTranscriptSourceWebhook } = await import("./meeting-transcript-sources");
    const secret = Buffer.from("read-webhook-secret").toString("base64");
    prismaMock.meetingTranscriptSourceConnection.findUnique.mockResolvedValueOnce({
      id: "connection-read",
      workspaceId: "ws-1",
      provider: "READ_AI",
      webhookSecretEnc: `enc:${secret}`,
    });
    const rawBody = JSON.stringify({
      session_id: "read-session-1",
      trigger: "meeting_end",
      title: "Product Weekly",
      start_time: "2026-05-01T10:00:00Z",
      end_time: "2026-05-01T11:00:00Z",
      participants: [{ name: "Jan", email: "jan@example.com" }],
      owner: { name: "Milan", email: "milan@example.com" },
      summary: "The team discussed recorder imports.",
      action_items: [{ text: "Jan will enable the Read.ai webhook." }],
      report_url: "https://app.read.ai/analytics/meetings/read-session-1",
      platform: "meet",
      platform_meeting_id: "abc-defg-hij",
      request_id: "request-1",
      transcript: {
        speaker_blocks: [{
          start_time: "1777639200000",
          end_time: "1777639203000",
          speaker: { name: "Jan" },
          words: "I will enable the Read.ai webhook.",
        }],
      },
    });
    const signature = createHmac("sha256", Buffer.from(secret, "base64")).update(rawBody).digest("hex");

    await processMeetingTranscriptSourceWebhook({
      workspaceId: "ws-1",
      provider: "READ_AI",
      rawBody,
      headers: { "x-read-signature": signature },
    });

    expect(prismaMock.meetingTranscriptSourceRecord.create).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({
        provider: "READ_AI",
        externalId: "read-session-1",
        sourceUrl: "https://app.read.ai/analytics/meetings/read-session-1",
        summaryMd: expect.stringContaining("Jan will enable the Read.ai webhook."),
        rawMetadataJson: expect.objectContaining({
          platformMeetingId: "abc-defg-hij",
          readAiActionItems: ["Jan will enable the Read.ai webhook."],
        }),
      }),
    }));
    expect(intakeMeetingTranscriptMock).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({
      provider: "READ_AI",
      externalId: "meeting-transcript:READ_AI:read-session-1",
      meetingUrl: "https://meet.google.com/abc-defg-hij",
      summaryMd: null,
      ingestionGuidanceMd: expect.stringContaining("cross-check these provider-supplied items"),
      transcript: "Jan: I will enable the Read.ai webhook.",
      participantEmails: ["jan@example.com", "milan@example.com"],
    }));
  });

  it("acknowledges Read.ai meeting_start webhooks without importing a transcript", async () => {
    const { processMeetingTranscriptSourceWebhook } = await import("./meeting-transcript-sources");
    const secret = Buffer.from("read-webhook-secret").toString("base64");
    prismaMock.meetingTranscriptSourceConnection.findUnique.mockResolvedValueOnce({
      id: "connection-read",
      workspaceId: "ws-1",
      provider: "READ_AI",
      webhookSecretEnc: `enc:${secret}`,
    });
    const rawBody = JSON.stringify({
      session_id: "read-session-1",
      trigger: "meeting_start",
      title: "Product Weekly",
      start_time: "2026-05-01T10:00:00Z",
      platform: "meet",
      platform_meeting_id: "abc-defg-hij",
      request_id: "request-start-1",
    });
    const signature = createHmac("sha256", Buffer.from(secret, "base64")).update(rawBody).digest("hex");

    const result = await processMeetingTranscriptSourceWebhook({
      workspaceId: "ws-1",
      provider: "READ_AI",
      rawBody,
      headers: { "x-read-signature": signature },
    });

    expect(result).toMatchObject({ ignored: true, reason: "meeting_start", provider: "READ_AI" });
    expect(intakeMeetingTranscriptMock).not.toHaveBeenCalled();
    expect(prismaMock.meetingTranscriptImportBatch.create).not.toHaveBeenCalled();
  });

  it("links likely duplicate cross-provider transcript sources to the existing meeting", async () => {
    prismaMock.meetingTranscriptSourceRecord.findMany.mockResolvedValueOnce([{
      id: "record-existing",
      meetingId: "meeting-existing",
      title: "Product Weekly",
      recordedAt: new Date("2026-05-01T10:00:00.000Z"),
      contentHash: "other-content",
      participantsJson: { participantEmails: ["jan@example.com"] },
      rawMetadataJson: { platformMeetingId: "abc-defg-hij" },
    }]);
    const { importMeetingTranscriptSourceArtifacts } = await import("./meeting-transcript-sources");

    await importMeetingTranscriptSourceArtifacts(agentActor, {
      workspaceId: "ws-1",
      provider: "READ_AI",
      artifacts: [{
        externalId: "read-session-1",
        title: "Product Weekly",
        recordedAt: "2026-05-01T10:00:00.000Z",
        text: "Jan: This is the same call.",
        participantEmails: ["jan@example.com"],
        metadata: { platformMeetingId: "abc-defg-hij" },
      }],
    });

    expect(prismaMock.meetingTranscriptSourceRecord.create).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({
        meetingId: "meeting-existing",
      }),
    }));
    expect(intakeMeetingTranscriptMock).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({
      meetingId: "meeting-existing",
    }));
  });

  it("backfills recent Fathom meetings with X-Api-Key authentication", async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        items: [{
          recording_id: 123456789,
          title: "QBR",
          recording_start_time: "2026-05-01T10:00:00.000Z",
          recording_end_time: "2026-05-01T11:00:00.000Z",
          share_url: "https://fathom.video/share/qbr",
          meeting_url: "https://us02web.zoom.us/j/123456789",
          transcript: [{
            speaker: { display_name: "Jane Doe", matched_calendar_invitee_email: "jane@example.com" },
            text: "Let's revisit the budget allocations.",
            timestamp: "00:05:32",
          }],
          default_summary: { markdown_formatted: "## Summary\nBudget review." },
        }],
        next_cursor: null,
      }),
    });
    vi.stubGlobal("fetch", fetchMock);
    prismaMock.meetingTranscriptSourceConnection.findUnique.mockResolvedValueOnce({
      id: "connection-fathom",
      workspaceId: "ws-1",
      provider: "FATHOM",
      apiKeyEnc: "enc:fathom-key",
      webhookSecretEnc: "enc:whsec_created",
    });
    const { runMeetingTranscriptSourceBackfill } = await import("./meeting-transcript-sources");

    await runMeetingTranscriptSourceBackfill(userActor, {
      workspaceId: "ws-1",
      provider: "FATHOM",
    });

    const [url, init] = fetchMock.mock.calls[0];
    expect(String(url)).toContain("https://api.fathom.ai/external/v1/meetings");
    expect(String(url)).toContain("include_transcript=true");
    expect(init).toMatchObject({ headers: { "X-Api-Key": "fathom-key" } });
    expect(intakeMeetingTranscriptMock).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({
      provider: "FATHOM",
      externalId: "meeting-transcript:FATHOM:123456789",
      transcript: "Jane Doe: Let's revisit the budget allocations.",
      participantEmails: ["jane@example.com"],
    }));
    expect(prismaMock.meetingTranscriptSourceConnection.update).toHaveBeenCalledWith(expect.objectContaining({
      where: { id: "connection-fathom" },
      data: expect.objectContaining({ lastError: null }),
    }));
  });

  it("backfills recent Fireflies transcripts through GraphQL", async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        data: {
          transcripts: [{
            id: "ff-backfill-1",
            title: "Product Weekly",
            date: "2026-05-01T10:00:00.000Z",
            transcript_url: "https://app.fireflies.ai/view/ff-backfill-1",
            meeting_link: "https://meet.google.com/abc-defg-hij",
            participants: ["jan@example.com"],
            sentences: [{ speaker_name: "Jan", text: "Fireflies backfill works.", start_time: 1, end_time: 3 }],
            summary: { overview: "Backfill overview." },
          }],
        },
      }),
    });
    vi.stubGlobal("fetch", fetchMock);
    prismaMock.meetingTranscriptSourceConnection.findUnique.mockResolvedValueOnce({
      id: "connection-fireflies",
      workspaceId: "ws-1",
      provider: "FIREFLIES",
      apiKeyEnc: "enc:fireflies-key",
      webhookSecretEnc: "enc:secret",
    });
    const { runMeetingTranscriptSourceBackfill } = await import("./meeting-transcript-sources");

    await runMeetingTranscriptSourceBackfill(userActor, {
      workspaceId: "ws-1",
      provider: "FIREFLIES",
    });

    expect(fetchMock).toHaveBeenCalledWith("https://api.fireflies.ai/graphql", expect.objectContaining({
      method: "POST",
      headers: expect.objectContaining({ authorization: "Bearer fireflies-key" }),
      body: expect.stringContaining("BackfillTranscripts"),
    }));
    expect(intakeMeetingTranscriptMock).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({
      provider: "FIREFLIES",
      externalId: "meeting-transcript:FIREFLIES:ff-backfill-1",
      transcript: "Jan: Fireflies backfill works.",
    }));
  });

  it("keeps Read.ai historical backfill deferred to manual export in V1", async () => {
    prismaMock.meetingTranscriptSourceConnection.findUnique.mockResolvedValueOnce({
      id: "connection-read",
      workspaceId: "ws-1",
      provider: "READ_AI",
      apiKeyEnc: null,
      webhookSecretEnc: "enc:read-secret",
    });
    const { runMeetingTranscriptSourceBackfill } = await import("./meeting-transcript-sources");

    const result = await runMeetingTranscriptSourceBackfill(userActor, {
      workspaceId: "ws-1",
      provider: "READ_AI",
    });

    expect(result.batch).toMatchObject({
      provider: "READ_AI",
      status: "FAILED",
      error: expect.stringContaining("deferred until the OAuth/API milestone"),
    });
    expect(intakeMeetingTranscriptMock).not.toHaveBeenCalled();
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
