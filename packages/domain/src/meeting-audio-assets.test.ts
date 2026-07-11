import { beforeEach, describe, expect, it, vi } from "vitest";
import type { AppActor } from "@corgtex/shared";

const { prismaMock, defaultStorageMock, defaultModelGatewayMock, intakeMeetingTranscriptMock } = vi.hoisted(() => ({
  prismaMock: {
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
    prismaMock.meetingAudioAsset.create.mockImplementation(({ data }) => Promise.resolve({
      id: "audio-1",
      ...data,
    }));
    prismaMock.workflowJob.upsert.mockResolvedValue({ id: "job-1" });
    prismaMock.auditLog.create.mockResolvedValue({});
    prismaMock.meetingAudioAsset.update.mockImplementation(({ data }) => Promise.resolve({
      id: "audio-1",
      ...data,
    }));
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
    expect(result.workflowJobId).toBe("job-1");
  });

  it("transcribes stored audio and feeds existing meeting transcript intake", async () => {
    prismaMock.meetingAudioAsset.findFirst.mockResolvedValue({
      id: "audio-1",
      workspaceId: "ws-1",
      meetingId: "meeting-1",
      fileName: "Team Sync.m4a",
      mimeType: "audio/mp4",
      storageKey: "stored/audio",
      title: "Team Sync",
      recordedAt: new Date("2026-07-10T18:00:00.000Z"),
      participantEmails: ["dana@example.com"],
      transcriptText: null,
      status: "UPLOADED",
      intakeMeetingId: null,
    });
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
});
