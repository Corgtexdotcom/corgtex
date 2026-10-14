import { createHmac } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { prismaMock, intakeMeetingTranscriptMock } = vi.hoisted(() => ({
  prismaMock: {
    workspaceSupportGrant: { findUnique: vi.fn().mockResolvedValue(null) },
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
      batch: expect.objectContaining({ status: "FAILED", failedCount: 1 }),
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

  it("does not turn a generic bootstrap actor and provider labels into native custody", async () => {
    const { importMeetingTranscriptSourceArtifacts } = await import("./meeting-transcript-sources");
    const result = await importMeetingTranscriptSourceArtifacts(agentActor, { workspaceId: "ws-1", provider: "FIREFLIES", artifacts: [{ externalId: "unreceipted", text: "Exact submitted text", recordedAt: "2026-05-01T10:00:00Z" }] });
    expect(result.batch).toMatchObject({ status: "FAILED", failedCount: 1, importedCount: 0 });
    expect(intakeMeetingTranscriptMock).not.toHaveBeenCalled();
    expect(prismaMock.meetingTranscriptSourceRecord.create).toHaveBeenCalledWith(expect.objectContaining({ data: expect.objectContaining({ status: "FAILED", error: "Manual import requires its authenticated upload receipt." }) }));
    expect(prismaMock.meetingTranscriptSourceRecord.updateMany).not.toHaveBeenCalled();
  });
  it("does not reinterpret a failed receipt as a successful legacy duplicate", async () => {
    prismaMock.meetingTranscriptSourceRecord.findFirst.mockResolvedValue({ id: "legacy", status: "ACTIVE", meetingId: "meeting-1", processedAt: new Date() });
    const { importMeetingTranscriptSourceArtifacts } = await import("./meeting-transcript-sources");
    const result = await importMeetingTranscriptSourceArtifacts(userActor, { workspaceId: "ws-1", provider: "FIREFLIES", artifacts: [{ externalId: "legacy", text: "Exact submitted text", recordedAt: "2026-05-01T10:00:00Z" }] });
    expect(result.batch).toMatchObject({ failedCount: 1, skippedCount: 0, importedCount: 0 });
    expect(prismaMock.meetingTranscriptSourceRecord.update).not.toHaveBeenCalled();
    expect(prismaMock.meetingTranscriptSourceRecord.create).not.toHaveBeenCalled();
  });
  it("appends failed diagnostics instead of mutating a previous failed original", async () => {
    prismaMock.meetingTranscriptSourceRecord.findFirst.mockResolvedValue({ id: "failed-original", status: "FAILED" });
    const { importMeetingTranscriptSourceArtifacts } = await import("./meeting-transcript-sources");
    await importMeetingTranscriptSourceArtifacts(userActor, { workspaceId: "ws-1", provider: "FIREFLIES", artifacts: [{ externalId: "retry", text: "Exact submitted text", recordedAt: "2026-05-01T10:00:00Z" }] });
    expect(prismaMock.meetingTranscriptSourceRecord.create).toHaveBeenCalledWith(expect.objectContaining({ data: expect.objectContaining({ status: "FAILED", transcriptText: "Exact submitted text" }) }));
    expect(prismaMock.meetingTranscriptSourceRecord.update).not.toHaveBeenCalled();
    expect(prismaMock.meetingTranscriptSourceRecord.upsert).not.toHaveBeenCalled();
  });
  it("preserves invalid raw normalization diagnostics without granting publication", async () => {
    const { importMeetingTranscriptSourceArtifacts } = await import("./meeting-transcript-sources");
    await importMeetingTranscriptSourceArtifacts(userActor, { workspaceId: "ws-1", provider: "FIREFLIES", artifacts: [{ fileName: "readme.txt", text: "No meeting date" }] });
    expect(prismaMock.meetingTranscriptSourceRecord.create).toHaveBeenCalledWith(expect.objectContaining({ data: expect.objectContaining({ status: "FAILED", rawMetadataJson: expect.objectContaining({ normalizationFailed: true, originalArtifact: expect.objectContaining({ text: "No meeting date" }) }) }) }));
    expect(intakeMeetingTranscriptMock).not.toHaveBeenCalled();
  });
  it("requires a new original upload for manual failed diagnostics instead of minting a receipt", async () => {
    prismaMock.meetingTranscriptImportBatch.findFirst.mockResolvedValue({ provider: "MANUAL_UPLOAD", records: [{ externalId: "failed" }] });
    const { retryMeetingTranscriptImportBatch } = await import("./meeting-transcript-sources");
    await expect(retryMeetingTranscriptImportBatch(userActor, { workspaceId: "ws-1", batchId: "failed" })).rejects.toMatchObject({ code: "TRANSCRIPT_REUPLOAD_REQUIRED" });
    expect(prismaMock.meetingTranscriptSourceRecord.update).not.toHaveBeenCalled();
    expect(prismaMock.meetingTranscriptImportBatch.create).not.toHaveBeenCalled();
  });

});
