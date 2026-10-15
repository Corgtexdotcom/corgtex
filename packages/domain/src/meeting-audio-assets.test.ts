import { beforeEach, describe, expect, it, vi } from "vitest";
import type { AppActor } from "@corgtex/shared";
import { createHash } from "node:crypto";
import { markAsUntransferable } from "node:worker_threads";

const { prismaMock, defaultStorageMock, defaultModelGatewayMock, intakeMeetingTranscriptMock,
  captureAudioUploadInputMock, createAudioWorkerMock, captureAudioTranscriptReceiptMock,
  revokeAudioWorkerMock, readableProofMock, captureArtifactInputProofMock, getMeetingMock,
  withArtifactInputWriteFenceMock, recordArtifactInputLineageMock,
  readableArtifactIdsMock } = vi.hoisted(() => ({
  prismaMock: {
    $queryRaw: vi.fn().mockResolvedValue([{ id: "job-1" }]),
    workspaceSupportGrant: { findUnique: vi.fn().mockResolvedValue(null) },
    $transaction: vi.fn(),
    meeting: {
      findFirst: vi.fn(),
    },
    member: {
      findUnique: vi.fn(),
    },
    meetingAudioAsset: {
      create: vi.fn(),
      findFirst: vi.fn(),
      update: vi.fn(),
    },
    workflowJob: {
      upsert: vi.fn(),
      findFirst: vi.fn(),
    },
    auditLog: {
      create: vi.fn(),
    },
  },
  defaultStorageMock: {
    put: vi.fn(),
    get: vi.fn(),
    delete: vi.fn(),
  },
  defaultModelGatewayMock: {
    transcribeAudio: vi.fn(),
  },
  intakeMeetingTranscriptMock: vi.fn(),
  captureAudioUploadInputMock: vi.fn(),
  createAudioWorkerMock: vi.fn(),
  captureAudioTranscriptReceiptMock: vi.fn(),
  revokeAudioWorkerMock: vi.fn(),
  readableProofMock: vi.fn(),
  captureArtifactInputProofMock: vi.fn(),
  getMeetingMock: vi.fn(),
  withArtifactInputWriteFenceMock: vi.fn((_fence, work) => work()),
  recordArtifactInputLineageMock: vi.fn(),
  readableArtifactIdsMock: vi.fn(),
}));

vi.mock("@corgtex/shared", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@corgtex/shared")>();
  return {
    ...actual,
    prisma: prismaMock,
    toInputJson: (value: unknown) => value,
  };
});

vi.mock("@corgtex/storage", () => ({
  defaultStorage: defaultStorageMock,
}));

vi.mock("@corgtex/models", () => ({
  defaultModelGateway: defaultModelGatewayMock,
}));

vi.mock("./meeting-transcript-intake", () => ({
  intakeMeetingTranscript: intakeMeetingTranscriptMock,
}));
vi.mock("./meetings", () => ({ getMeeting: getMeetingMock }));
vi.mock("./native-transcript-input", () => ({
  captureAudioUploadInput: captureAudioUploadInputMock,
  createAudioTranscriptWorkerActor: createAudioWorkerMock,
  captureAudioTranscriptIntakeReceipt: captureAudioTranscriptReceiptMock,
  revokeAudioTranscriptWorkerActor: revokeAudioWorkerMock,
}));
vi.mock("./source-lineage", () => ({ isArtifactInputProofReadable: readableProofMock,
  captureArtifactInputProof: captureArtifactInputProofMock,
  withArtifactInputWriteFence: withArtifactInputWriteFenceMock,
  recordArtifactInputLineage: recordArtifactInputLineageMock,
  readableArtifactIds: readableArtifactIdsMock }));

const actor: AppActor = {
  kind: "user",
  user: {
    id: "user-1",
    email: "jan@example.com",
    displayName: "Jan",
  },
};

describe("meeting audio assets", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    prismaMock.$transaction.mockImplementation((callback) => callback(prismaMock));
    prismaMock.member.findUnique.mockResolvedValue({
      id: "member-1",
      workspaceId: "ws-1",
      userId: "user-1",
      role: "ADMIN",
      isActive: true,
    });
    prismaMock.meeting.findFirst.mockResolvedValue({ id: "meeting-1" });
    getMeetingMock.mockResolvedValue({ id: "meeting-1" });
    prismaMock.meetingAudioAsset.create.mockImplementation(({ data }) => Promise.resolve({
      id: "audio-1",
      ...data,
    }));
    prismaMock.workflowJob.upsert.mockResolvedValue({ id: "job-1" });
    prismaMock.workflowJob.findFirst.mockResolvedValue({ id: "job-1", workspaceId: "ws-1",
      type: "meeting-audio.transcribe", status: "RUNNING", attempts: 1,
      lockedBy: "worker-1", lockedAt: new Date("2026-10-13T10:00:00.000Z"),
      payload: { audioAssetId: "audio-1" } });
    prismaMock.auditLog.create.mockResolvedValue({});
    prismaMock.meetingAudioAsset.update.mockImplementation(({ data }) => Promise.resolve({
      id: "audio-1",
      ...data,
    }));
    captureAudioUploadInputMock.mockImplementation(async (_actor, params) => ({ input: { id: "native-1",
      fileHash: createHash("sha256").update(params.fileBuffer).digest("hex") }, roots: [] }));
    defaultStorageMock.put.mockResolvedValue(undefined);
    defaultStorageMock.delete.mockResolvedValue(undefined);
    captureAudioTranscriptReceiptMock.mockResolvedValue({ inputId: "native-1" });
    readableProofMock.mockResolvedValue(true);
    readableArtifactIdsMock.mockResolvedValue(new Set(["audio-1"]));
    prismaMock.meeting.findFirst.mockResolvedValue({ id: "meeting-1" });
  });

  it("stores audio separately and enqueues a transcription job", async () => {
    const { createMeetingAudioAsset } = await import("./meeting-audio-assets");

    const result = await createMeetingAudioAsset(actor, {
      workspaceId: "ws-1",
      meetingId: "meeting-1",
      fileName: " Team Sync.m4a ",
      mimeType: "audio/mp4",
      fileBuffer: Buffer.from("audio"),
      recordedAt: new Date("2026-07-10T18:00:00.000Z"),
      participantEmails: ["Dana@Example.com", "dana@example.com"],
    });

    expect(defaultStorageMock.put).toHaveBeenCalledWith(
      expect.stringMatching(/^workspaces\/ws-1\/meeting-audio\/.+\/Team Sync\.m4a$/),
      Buffer.from("audio"),
      { contentType: "audio/mp4" },
    );
    expect(prismaMock.meetingAudioAsset.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        workspaceId: "ws-1",
        meetingId: "meeting-1",
        uploadedByUserId: "user-1",
        fileName: "Team Sync.m4a",
        status: "UPLOADED",
        participantEmails: ["dana@example.com"],
      }),
    });
    expect(prismaMock.workflowJob.upsert).toHaveBeenCalledWith(expect.objectContaining({
      where: { dedupeKey: "meeting-audio:audio-1:transcribe" },
      create: expect.objectContaining({
        workspaceId: "ws-1",
        type: "meeting-audio.transcribe",
        payload: { audioAssetId: "audio-1" },
      }),
    }));
    expect(captureAudioUploadInputMock).toHaveBeenCalledWith(actor, expect.objectContaining({
      workspaceId: "ws-1", fileBuffer: Buffer.from("audio"), tx: prismaMock,
      asset: expect.objectContaining({ id: "audio-1", storageKey: expect.any(String) }),
    }));
    expect(result.workflowJobId).toBe("job-1");
    expect(prismaMock.meetingAudioAsset.update).toHaveBeenCalledWith({
      where: { id: "audio-1" }, data: { workflowJobId: "job-1" },
    });
    expect(recordArtifactInputLineageMock).toHaveBeenCalledWith(expect.objectContaining({
      artifact: { kind: "MeetingAudioAsset", id: "audio-1" }, origin: "DERIVED",
    }));
  });

  it("rejects oversized bytes before making a copy or contacting storage", async () => {
    const { createMeetingAudioAsset, MAX_AUDIO_FILE_BYTES } = await import("./meeting-audio-assets");
    const oversized = Buffer.from("small synthetic allocation");
    Object.defineProperty(oversized, "byteLength", { value: MAX_AUDIO_FILE_BYTES + 1 });
    const copy = vi.spyOn(Buffer, "from");
    try {
      await expect(createMeetingAudioAsset(actor, { workspaceId: "ws-1", fileName: "large.m4a", fileBuffer: oversized }))
        .rejects.toMatchObject({ code: "AUDIO_TOO_LARGE" });
      expect(copy.mock.calls.some(args => args[0] === oversized)).toBe(false);
      expect(defaultStorageMock.put).not.toHaveBeenCalled();
      expect(prismaMock.meetingAudioAsset.create).not.toHaveBeenCalled();
    } finally { copy.mockRestore(); }
  });

  it("transfers owned audio without a full-file copy and detaches every uploader alias before admission", async () => {
    const { createMeetingAudioAsset } = await import("./meeting-audio-assets");
    const size = 64 * 1024;
    const bytes = Buffer.from(new ArrayBuffer(size)).fill(73); // Same dedicated backing as File.arrayBuffer().
    const alias = new Uint8Array(bytes.buffer);
    const expectedHash = createHash("sha256").update(bytes).digest("hex");
    const from = vi.spyOn(Buffer, "from");
    const clone = vi.spyOn(globalThis, "structuredClone");
    try {
      prismaMock.member.findUnique.mockImplementationOnce(async () => {
        expect(alias.byteLength).toBe(0);
        alias[0] = 0;
        return { id: "member-1", workspaceId: "ws-1", userId: "user-1", role: "ADMIN", isActive: true };
      });
      const pending = createMeetingAudioAsset(actor, { workspaceId: "ws-1", fileName: "owned.m4a", fileBuffer: bytes });
      expect.soft(bytes.byteLength).toBe(0);
      expect.soft(alias.byteLength).toBe(0);
      await pending;
      const stored = defaultStorageMock.put.mock.calls[0][1] as Buffer;
      expect(stored.byteLength).toBe(size);
      expect(createHash("sha256").update(stored).digest("hex")).toBe(expectedHash);
      expect(from.mock.calls.filter(args => ArrayBuffer.isView(args[0]))).toHaveLength(0);
      expect(clone).toHaveBeenCalledOnce();
      expect(stored.buffer).toBe(clone.mock.results[0].value);
      expect(prismaMock.meetingAudioAsset.create).toHaveBeenCalledWith({ data: expect.objectContaining({ sizeBytes: size }) });
      expect(captureAudioUploadInputMock.mock.calls[0][1].fileBuffer).toBe(stored);
    } finally { from.mockRestore(); clone.mockRestore(); }
  });

  it.each(["slice", "shared", "untransferable"] as const)("isolates %s backing with exactly one fallback copy", async kind => {
    const { createMeetingAudioAsset } = await import("./meeting-audio-assets");
    const backing = kind === "shared" ? new SharedArrayBuffer(64 * 1024) : new ArrayBuffer(64 * 1024);
    const whole = Buffer.from(backing).fill(73);
    const bytes = kind === "slice" ? whole.subarray(512, 4096) : whole;
    if (kind === "untransferable") markAsUntransferable(backing);
    const size = bytes.byteLength;
    const expectedHash = createHash("sha256").update(bytes).digest("hex");
    const from = vi.spyOn(Buffer, "from");
    try {
      const pending = createMeetingAudioAsset(actor, { workspaceId: "ws-1", fileName: "fallback.m4a", fileBuffer: bytes });
      whole.fill(0);
      await pending;
      const stored = defaultStorageMock.put.mock.calls[0][1] as Buffer;
      expect(stored.byteLength).toBe(size);
      expect(createHash("sha256").update(stored).digest("hex")).toBe(expectedHash);
      expect(from.mock.calls.filter(args => args[0] === bytes)).toHaveLength(1);
      expect(whole.byteLength).toBe(64 * 1024);
      expect(captureAudioUploadInputMock.mock.calls[0][1].fileBuffer).toBe(stored);
    } finally { from.mockRestore(); }
  });

  it("keeps one isolated storage copy across uploader mutation", async () => {
    const { createMeetingAudioAsset } = await import("./meeting-audio-assets");
    const bytes = Buffer.from("audio");
    const copy = vi.spyOn(Buffer, "from");
    try {
      const pending = createMeetingAudioAsset(actor, { workspaceId: "ws-1", fileName: "audio.m4a", fileBuffer: bytes });
      bytes.write("other");
      await pending;
      const stored = defaultStorageMock.put.mock.calls[0][1];
      expect(stored).not.toBe(bytes);
      expect(stored.toString()).toBe("audio");
      expect(copy.mock.calls.filter(args => args[0] === bytes)).toHaveLength(1);
      expect(captureAudioUploadInputMock.mock.calls[0][1].fileBuffer).toBe(stored);
    } finally { copy.mockRestore(); }
  });

  it("rejects storage mutation before publishing an audio job or lineage", async () => {
    const { createMeetingAudioAsset } = await import("./meeting-audio-assets");
    defaultStorageMock.put.mockImplementationOnce(async (_key, bytes) => { bytes.write("other"); });
    await expect(createMeetingAudioAsset(actor, { workspaceId: "ws-1", fileName: "audio.m4a", fileBuffer: Buffer.from("audio") }))
      .rejects.toMatchObject({ code: "SOURCE_CHANGED" });
    expect(prismaMock.workflowJob.upsert).not.toHaveBeenCalled();
    expect(recordArtifactInputLineageMock).not.toHaveBeenCalled();
    expect(defaultStorageMock.delete).toHaveBeenCalledOnce();
  });

  it("rejects an unreadable selected Meeting before storing audio", async () => {
    getMeetingMock.mockResolvedValueOnce(null);
    const { createMeetingAudioAsset } = await import("./meeting-audio-assets");
    await expect(createMeetingAudioAsset(actor, { workspaceId: "ws-1", meetingId: "hidden",
      fileName: "audio.m4a", fileBuffer: Buffer.from("audio") }))
      .rejects.toMatchObject({ code: "NOT_FOUND" });
    expect(defaultStorageMock.put).not.toHaveBeenCalled();
    expect(captureAudioUploadInputMock).not.toHaveBeenCalled();
  });

  it("transcribes stored audio and feeds existing meeting transcript intake", async () => {
    const asset = {
      id: "audio-1",
      workspaceId: "ws-1",
      meetingId: "meeting-1",
      fileName: "Team Sync.m4a",
      mimeType: "audio/mp4",
      storageKey: "stored/audio",
      sizeBytes: 5,
      title: "Team Sync",
      recordedAt: new Date("2026-07-10T18:00:00.000Z"),
      participantEmails: ["dana@example.com"],
      transcriptText: null,
      status: "UPLOADED",
      intakeMeetingId: null,
    };
    prismaMock.meetingAudioAsset.findFirst.mockResolvedValue(asset);
    prismaMock.meeting.findFirst.mockResolvedValue(null);
    createAudioWorkerMock.mockResolvedValue({ actor: { kind: "agent", label: "meeting-audio-transcription-worker" },
      asset, input: { id: "native-1", fileHash: createHash("sha256").update("audio").digest("hex") },
      roots: [{ kind: "NativeTranscriptInput", id: "native-1", fingerprint: "a".repeat(64) }] });
    defaultStorageMock.get.mockResolvedValue({
      data: Buffer.from("audio"),
      contentType: "audio/mp4",
    });
    defaultModelGatewayMock.transcribeAudio.mockResolvedValue({
      text: "Dana: We agreed on the next step.",
      usage: {
        provider: "fake",
        model: "fake-transcribe",
        inputTokens: 0,
        outputTokens: 8,
        latencyMs: 12,
        estimatedCostUsd: "0.000000",
        rawProviderCostUsd: "0.000000",
        billableCostUsd: "0.000000",
      },
    });
    intakeMeetingTranscriptMock.mockResolvedValue({
      status: "meeting_matched",
      meeting: { id: "meeting-1" },
      message: "Transcript saved.",
      inferred: {},
    });

    const { runMeetingAudioAssetTranscription } = await import("./meeting-audio-assets");
    const result = await runMeetingAudioAssetTranscription({
      workspaceId: "ws-1",
      audioAssetId: "audio-1",
      workflowJobId: "job-1",
      expectedLease: { attempts: 1, lockedBy: "worker-1", lockedAt: new Date("2026-10-13T10:00:00.000Z") },
    });

    expect(defaultModelGatewayMock.transcribeAudio).toHaveBeenCalledWith(expect.objectContaining({
      workspaceId: "ws-1",
      workflowJobId: "job-1",
      fileName: "Team Sync.m4a",
      mimeType: "audio/mp4",
      data: Buffer.from("audio"),
      prompt: "Meeting title: Team Sync",
    }));
    expect(intakeMeetingTranscriptMock).toHaveBeenCalledWith(expect.objectContaining({
      kind: "agent",
      label: "meeting-audio-transcription-worker",
    }), expect.objectContaining({
      workspaceId: "ws-1",
      meetingId: "meeting-1",
      source: "meeting-audio-upload",
      provider: "MANUAL_UPLOAD",
      externalId: "meeting-audio:audio-1",
      transcript: "Dana: We agreed on the next step.",
    }));
    expect(prismaMock.meetingAudioAsset.update).toHaveBeenLastCalledWith({
      where: { id: "audio-1" },
      data: expect.objectContaining({
        status: "INGESTED",
        intakeMeetingId: "meeting-1",
        workflowJobId: "job-1",
      }),
    });
    expect(result).toEqual({ status: "ingested", meetingId: "meeting-1" });
  });

  it("recovers a committed matching transcript after a crash before the asset status update", async () => {
    const transcript = "Dana: Synthetic prior transcript.";
    const fileHash = createHash("sha256").update("audio").digest("hex");
    const asset = { id: "audio-1", workspaceId: "ws-1", meetingId: null,
      fileName: "Team Sync.m4a", mimeType: "audio/mp4", storageKey: "stored/audio",
      title: "Team Sync", recordedAt: new Date("2026-07-10T18:00:00.000Z"),
      participantEmails: [], transcriptText: transcript, status: "TRANSCRIBED", intakeMeetingId: null,
      transcriptMetadata: { nativeTranscriptInputId: "native-1", audioFileHash: fileHash,
        transcriptHash: createHash("sha256").update(transcript).digest("hex"),
        preModelRoots: [{ kind: "NativeTranscriptInput", id: "native-1", fingerprint: "a".repeat(64),
          permissionEpochs: { entries: [], version: 1 } }] } };
    prismaMock.meetingAudioAsset.findFirst.mockResolvedValue(asset);
    prismaMock.meeting.findFirst.mockResolvedValue({ id: "meeting-1", workspaceId: "ws-1",
      transcript, status: "COMPLETED", recordedAt: asset.recordedAt });
    createAudioWorkerMock.mockResolvedValue({ actor: { kind: "agent", label: "meeting-audio-transcription-worker" },
      asset, input: { id: "native-1", fileHash },
      roots: [{ kind: "NativeTranscriptInput", id: "native-1", fingerprint: "a".repeat(64) }] });
    captureArtifactInputProofMock.mockResolvedValue([{ kind: "MeetingTranscript", id: "meeting-1", fingerprint: "b".repeat(64) },
      { kind: "NativeTranscriptInput", id: "native-1", fingerprint: "a".repeat(64) }]);

    const { runMeetingAudioAssetTranscription } = await import("./meeting-audio-assets");
    await expect(runMeetingAudioAssetTranscription({ workspaceId: "ws-1", audioAssetId: "audio-1",
      workflowJobId: "job-1", expectedLease: { attempts: 1, lockedBy: "worker-1",
        lockedAt: new Date("2026-10-13T10:00:00.000Z") } })).resolves.toEqual({ status: "ingested", meetingId: "meeting-1" });
    expect(defaultModelGatewayMock.transcribeAudio).not.toHaveBeenCalled();
    expect(intakeMeetingTranscriptMock).not.toHaveBeenCalled();
    expect(prismaMock.meetingAudioAsset.update).toHaveBeenCalledWith({ where: { id: "audio-1" },
      data: expect.objectContaining({ status: "INGESTED", intakeMeetingId: "meeting-1" }) });
  });

  it("withholds status writes and model calls after another worker reclaims the lease", async () => {
    const asset = { id: "audio-1", workspaceId: "ws-1", status: "UPLOADED", transcriptText: null,
      fileName: "meeting.m4a", mimeType: "audio/mp4", storageKey: "stored/audio", title: null };
    prismaMock.meetingAudioAsset.findFirst.mockResolvedValue(asset);
    createAudioWorkerMock.mockResolvedValue({ actor: { kind: "agent", label: "meeting-audio-transcription-worker" },
      asset, input: { id: "native-1", fileHash: "a".repeat(64) },
      roots: [{ kind: "NativeTranscriptInput", id: "native-1", fingerprint: "b".repeat(64) }] });
    prismaMock.workflowJob.findFirst.mockResolvedValue({ id: "job-1", workspaceId: "ws-1",
      type: "meeting-audio.transcribe", status: "RUNNING", attempts: 2,
      lockedBy: "worker-new", lockedAt: new Date("2026-10-13T11:00:00.000Z"),
      payload: { audioAssetId: "audio-1" } });
    const { runMeetingAudioAssetTranscription } = await import("./meeting-audio-assets");
    await expect(runMeetingAudioAssetTranscription({ workspaceId: "ws-1", audioAssetId: "audio-1",
      workflowJobId: "job-1", expectedLease: { attempts: 1, lockedBy: "worker-old",
        lockedAt: new Date("2026-10-13T10:00:00.000Z") } }))
      .rejects.toMatchObject({ code: "SOURCE_CHANGED" });
    expect(prismaMock.meetingAudioAsset.update).not.toHaveBeenCalled();
    expect(defaultModelGatewayMock.transcribeAudio).not.toHaveBeenCalled();
  });

  it("does not re-certify a legacy cached transcript using the current lease", async () => {
    const transcript = "Synthetic cached text";
    const asset = { id: "audio-1", workspaceId: "ws-1", status: "TRANSCRIBED",
      transcriptText: transcript, transcriptMetadata: { nativeTranscriptInputId: "native-1",
        audioFileHash: "a".repeat(64), transcriptHash: createHash("sha256").update(transcript).digest("hex") },
      fileName: "meeting.m4a", mimeType: "audio/mp4", storageKey: "stored/audio", title: null };
    prismaMock.meetingAudioAsset.findFirst.mockResolvedValue(asset);
    createAudioWorkerMock.mockResolvedValue({ actor: { kind: "agent", label: "meeting-audio-transcription-worker" },
      asset, input: { id: "native-1", fileHash: "a".repeat(64) },
      roots: [{ kind: "NativeTranscriptInput", id: "native-1", fingerprint: "b".repeat(64) }] });
    const { runMeetingAudioAssetTranscription } = await import("./meeting-audio-assets");
    await expect(runMeetingAudioAssetTranscription({ workspaceId: "ws-1", audioAssetId: "audio-1",
      workflowJobId: "job-1", expectedLease: { attempts: 1, lockedBy: "worker-1",
        lockedAt: new Date("2026-10-13T10:00:00.000Z") } }))
      .rejects.toMatchObject({ code: "UNKNOWN_LINEAGE" });
    expect(prismaMock.meetingAudioAsset.update).not.toHaveBeenCalled();
    expect(recordArtifactInputLineageMock).not.toHaveBeenCalled();
    expect(defaultModelGatewayMock.transcribeAudio).not.toHaveBeenCalled();
  });
});
