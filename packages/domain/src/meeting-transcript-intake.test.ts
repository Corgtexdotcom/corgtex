import { beforeEach, describe, expect, it, vi } from "vitest";

const { createMeetingMock, getMeetingMock, directRootsMock, modelGatewayMock, uploadMeetingTranscriptMock,
  prismaMock, captureArtifactInputProofMock, captureArtifactInputSnapshotProofMock } = vi.hoisted(() => ({
  createMeetingMock: vi.fn(),
  modelGatewayMock: {
    extract: vi.fn(),
  },
  getMeetingMock: vi.fn(),
  directRootsMock: vi.fn(),
  uploadMeetingTranscriptMock: vi.fn(),
  prismaMock: { $transaction: vi.fn() },
  captureArtifactInputProofMock: vi.fn(),
  captureArtifactInputSnapshotProofMock: vi.fn(),
}));

vi.mock("@corgtex/shared", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@corgtex/shared")>()), prisma: prismaMock,
}));
vi.mock("./source-lineage", () => ({ captureArtifactInputProof: captureArtifactInputProofMock,
  captureArtifactInputSnapshotProof: captureArtifactInputSnapshotProofMock }));

vi.mock("@corgtex/models", () => ({
  defaultModelGateway: modelGatewayMock,
}));

vi.mock("./meetings", () => ({
  createMeeting: createMeetingMock,
  getMeeting: getMeetingMock,
  uploadMeetingTranscript: uploadMeetingTranscriptMock,
}));

vi.mock("./native-transcript-input", async importOriginal => ({
  ...await importOriginal<typeof import("./native-transcript-input")>(),
  directMemberTranscriptRoots: directRootsMock,
}));

const USER_ACTOR = { kind: "user" as const, user: { id: "user-1", email: "owner@example.test", displayName: "Owner" } };
const RECEIPT = { inputId: "native-1" };
const TEST_NOW = new Date("2026-07-16T12:00:00.000Z");

describe("meeting transcript intake", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    getMeetingMock.mockResolvedValue(null);
    directRootsMock.mockResolvedValue([{ kind: "NativeTranscriptInput", id: "native-1", fingerprint: "a".repeat(64) }]);
    prismaMock.$transaction.mockImplementation(callback => callback(prismaMock));
    captureArtifactInputProofMock.mockResolvedValue([{ kind: "Meeting", id: "meeting-1", fingerprint: "b".repeat(64) }]);
    captureArtifactInputSnapshotProofMock.mockResolvedValue([{ kind: "ArtifactInputSnapshot", id: "snapshot-1", fingerprint: "c".repeat(64) }]);
  });

  it("skips model metadata extraction when title and recordedAt are explicit", async () => {
    const { inferMeetingTranscriptMetadata, isPlausibleMeetingRecordedAt } = await import("./meeting-transcript-intake");

    const metadata = await inferMeetingTranscriptMetadata({
      workspaceId: "workspace-1",
      title: " Weekly Tactical ",
      recordedAt: "2016-07-16T12:00:00.000Z",
      validateExplicitRecordedAt: true,
      now: TEST_NOW,
      source: " production-smoke ",
      transcript: [
        "Meeting title: Weekly Tactical",
        "Date: 2016-07-16T12:00:00.000Z",
        "Jan: Andy@example.com owns the follow-up.",
      ].join("\n"),
    });

    expect(modelGatewayMock.extract).not.toHaveBeenCalled();
    expect(metadata).toEqual({
      title: "Weekly Tactical",
      recordedAt: new Date("2016-07-16T12:00:00.000Z"),
      participantEmails: ["andy@example.com"],
      source: "production-smoke",
    });
    expect(isPlausibleMeetingRecordedAt(new Date("2018-02-28T12:00:00.000Z"), new Date("2028-02-29T12:00:00.000Z"))).toBe(true);
  });

  it("uses model metadata when required fields are missing", async () => {
    modelGatewayMock.extract.mockResolvedValueOnce({
      output: {
        title: "Model Tactical",
        recordedAt: "2026-05-17T11:00:00.000Z",
        participantEmails: ["model@example.com"],
      },
    });
    const { inferMeetingTranscriptMetadata } = await import("./meeting-transcript-intake");

    const metadata = await inferMeetingTranscriptMetadata({
      workspaceId: "workspace-1",
      transcript: "Jan: We need a follow-up.",
    });

    expect(modelGatewayMock.extract).toHaveBeenCalledTimes(1);
    expect(metadata).toEqual({
      title: "Model Tactical",
      recordedAt: null,
      participantEmails: ["model@example.com"],
      source: "chat-transcript-upload",
    });
  });

  it("does not accept model-inferred dates as canonical manual upload dates", async () => {
    modelGatewayMock.extract.mockResolvedValueOnce({
      output: {
        title: "Model Tactical",
        recordedAt: "2001-07-15T11:00:00.000Z",
        participantEmails: ["model@example.com"],
      },
    });
    const { intakeMeetingTranscript } = await import("./meeting-transcript-intake");

    await expect(intakeMeetingTranscript(USER_ACTOR, {
      workspaceId: "workspace-1",
      nativeReceipt: RECEIPT,
      source: "transcript-upload",
      transcript: "Date: 2001-07-15\nJan: We need a follow-up.",
      now: TEST_NOW,
    })).resolves.toMatchObject({
      status: "needs_clarification",
      requiredFields: ["recordedAt"],
      inferred: {
        title: "Model Tactical",
        recordedAt: null,
      },
    });
    expect(createMeetingMock).not.toHaveBeenCalled();
    expect(uploadMeetingTranscriptMock).not.toHaveBeenCalled();
  });

  it("rejects implausible explicit manual upload dates", async () => {
    const { intakeMeetingTranscript } = await import("./meeting-transcript-intake");

    await expect(intakeMeetingTranscript(USER_ACTOR, {
      workspaceId: "workspace-1",
      nativeReceipt: RECEIPT,
      title: "Weekly Tactical",
      recordedAt: new Date("2001-07-15T11:00:00.000Z"),
      source: "transcript-upload",
      transcript: "Jan: We need a follow-up.",
      now: TEST_NOW,
    })).resolves.toMatchObject({
      status: "needs_clarification",
      requiredFields: ["recordedAt"],
      inferred: {
        title: "Weekly Tactical",
        recordedAt: null,
      },
    });
    expect(createMeetingMock).not.toHaveBeenCalled();
    expect(uploadMeetingTranscriptMock).not.toHaveBeenCalled();
  });

  it("rejects a provider label and source record id before any model or meeting read", async () => {
    const { intakeMeetingTranscript } = await import("./meeting-transcript-intake");

    await expect(intakeMeetingTranscript(USER_ACTOR, {
      workspaceId: "workspace-1",
      nativeReceipt: RECEIPT,
      title: "Historical provider transcript",
      recordedAt: new Date("2001-07-15T11:00:00.000Z"),
      source: "meeting-transcript:fireflies",
      provider: "FIREFLIES", sourceRecordId: "source-record-1",
      transcript: "Jan: Provider imported this historical meeting.",
      now: TEST_NOW,
    })).rejects.toMatchObject({ code: "UNKNOWN_LINEAGE" });
    expect(directRootsMock).not.toHaveBeenCalled();
    expect(getMeetingMock).not.toHaveBeenCalled();
    expect(modelGatewayMock.extract).not.toHaveBeenCalled();
    expect(uploadMeetingTranscriptMock).not.toHaveBeenCalled();
  });

  it("rejects an unproved model tool submission even when its actor is a human", async () => {
    directRootsMock.mockRejectedValueOnce(Object.assign(new Error("unproved"), { code: "UNKNOWN_LINEAGE" }));
    const { intakeMeetingTranscript } = await import("./meeting-transcript-intake");

    await expect(intakeMeetingTranscript(USER_ACTOR, {
      workspaceId: "workspace-1",
      meetingId: "meeting-1",
      source: "agent-upload",
      transcript: "Jan: Model tool invented this transcript.",
      now: TEST_NOW,
    })).rejects.toMatchObject({ code: "UNKNOWN_LINEAGE" });
    expect(getMeetingMock).not.toHaveBeenCalled();
    expect(modelGatewayMock.extract).not.toHaveBeenCalled();
    expect(uploadMeetingTranscriptMock).not.toHaveBeenCalled();
  });

  it("does not use an unreadable selected Meeting as metadata input", async () => {
    getMeetingMock.mockResolvedValueOnce(null);
    const { intakeMeetingTranscript } = await import("./meeting-transcript-intake");
    await expect(intakeMeetingTranscript(USER_ACTOR, {
      workspaceId: "workspace-1", nativeReceipt: RECEIPT, meetingId: "hidden-meeting",
      transcript: "Jan: Synthetic content.",
    })).rejects.toMatchObject({ code: "NOT_FOUND" });
    expect(getMeetingMock).toHaveBeenCalledWith(USER_ACTOR, "workspace-1", "hidden-meeting");
    expect(modelGatewayMock.extract).not.toHaveBeenCalled();
    expect(uploadMeetingTranscriptMock).not.toHaveBeenCalled();
  });

  it("captures selected Meeting metadata and freezes its revision before model inference", async () => {
    const recordedAt = new Date("2026-05-17T10:00:00.000Z");
    getMeetingMock.mockResolvedValueOnce({ id: "meeting-1", title: null, recordedAt,
      participantEmails: ["owner@example.test"] });
    modelGatewayMock.extract.mockResolvedValueOnce({ output: { title: "Inferred title", recordedAt: null,
      participantEmails: [] } });
    uploadMeetingTranscriptMock.mockResolvedValueOnce({ status: "matched",
      meeting: { id: "meeting-1", title: "Inferred title" } });
    const { intakeMeetingTranscript } = await import("./meeting-transcript-intake");
    await intakeMeetingTranscript(USER_ACTOR, { workspaceId: "workspace-1", nativeReceipt: RECEIPT,
      meetingId: "meeting-1", transcript: "Jan: A synthetic update.", now: TEST_NOW });
    expect(captureArtifactInputProofMock).toHaveBeenCalledWith(USER_ACTOR, "workspace-1", [{
      kind: "Meeting", id: "meeting-1", snapshot: { title: null, recordedAt,
        participantEmails: ["owner@example.test"] },
    }], prismaMock);
    expect(captureArtifactInputSnapshotProofMock).toHaveBeenCalledWith(USER_ACTOR, "workspace-1",
      { kind: "Meeting", id: "meeting-1", fingerprint: "b".repeat(64) }, prismaMock);
    expect(captureArtifactInputSnapshotProofMock.mock.invocationCallOrder[0])
      .toBeLessThan(modelGatewayMock.extract.mock.invocationCallOrder[0]!);
    expect(uploadMeetingTranscriptMock).toHaveBeenCalledWith(USER_ACTOR, expect.objectContaining({
      lineageRoots: [
        { kind: "NativeTranscriptInput", id: "native-1", fingerprint: "a".repeat(64) },
        { kind: "ArtifactInputSnapshot", id: "snapshot-1", fingerprint: "c".repeat(64) },
      ],
    }));
  });

  it("rejects an unproved selected Meeting before metadata inference", async () => {
    getMeetingMock.mockResolvedValueOnce({ id: "meeting-1", title: "Unknown", recordedAt: TEST_NOW,
      participantEmails: [] });
    captureArtifactInputProofMock.mockRejectedValueOnce(Object.assign(new Error("unknown"), { code: "UNKNOWN_LINEAGE" }));
    const { intakeMeetingTranscript } = await import("./meeting-transcript-intake");
    await expect(intakeMeetingTranscript(USER_ACTOR, { workspaceId: "workspace-1", nativeReceipt: RECEIPT,
      meetingId: "meeting-1", transcript: "Jan: A synthetic update." }))
      .rejects.toMatchObject({ code: "UNKNOWN_LINEAGE" });
    expect(modelGatewayMock.extract).not.toHaveBeenCalled();
    expect(uploadMeetingTranscriptMock).not.toHaveBeenCalled();
  });

  it("reports duplicate use-existing transcript uploads as existing meeting matches", async () => {
    uploadMeetingTranscriptMock.mockResolvedValueOnce({
      status: "created",
      meeting: { id: "meeting-existing", title: "Existing meeting" },
      candidates: [],
    });
    const { intakeMeetingTranscript } = await import("./meeting-transcript-intake");

    await expect(intakeMeetingTranscript(USER_ACTOR, {
      workspaceId: "workspace-1",
      nativeReceipt: RECEIPT,
      title: "Existing meeting",
      recordedAt: new Date("2026-05-17T10:00:00.000Z"),
      source: "transcript-upload",
      transcript: "Jan: Follow up next week.",
      duplicateGuard: {
        resolution: "use_existing",
        targetEntityId: "meeting-existing",
      },
      now: TEST_NOW,
    })).resolves.toMatchObject({
      status: "meeting_matched",
      meeting: { id: "meeting-existing" },
      message: "Using existing meeting \"Existing meeting\". No new transcript was saved.",
    });
  });

  it("keeps source URLs out of meeting join URL matching", async () => {
    uploadMeetingTranscriptMock.mockResolvedValueOnce({
      status: "created",
      meeting: { id: "meeting-1" },
      candidates: [],
    });
    const { intakeMeetingTranscript } = await import("./meeting-transcript-intake");

    await intakeMeetingTranscript(USER_ACTOR, {
      workspaceId: "workspace-1",
      nativeReceipt: RECEIPT,
      title: "Weekly Tactical",
      recordedAt: new Date("2026-05-17T10:00:00.000Z"),
      source: "meeting-transcript:fireflies",
      sourceUrl: "https://app.fireflies.ai/view/transcript-123",
      transcript: "Jan: Follow up next week.",
      now: TEST_NOW,
    });

    expect(uploadMeetingTranscriptMock).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({
      meetingUrl: null,
    }));
  });

  it("uses single-candidate clarification copy when auto-match confidence is too low", async () => {
    uploadMeetingTranscriptMock.mockResolvedValueOnce({
      status: "needs_selection",
      meeting: null,
      candidates: [{
        meetingId: "meeting-1",
        title: "Weekly Tactical",
        recordedAt: new Date("2026-05-17T10:00:00.000Z"),
        score: 0.52,
        reason: "time",
      }],
    });
    const { intakeMeetingTranscript } = await import("./meeting-transcript-intake");

    await expect(intakeMeetingTranscript(USER_ACTOR, {
      workspaceId: "workspace-1",
      nativeReceipt: RECEIPT,
      title: "Weekly Tactical",
      recordedAt: new Date("2026-05-17T10:00:00.000Z"),
      source: "transcript-upload",
      transcript: "Jan: Follow up next week.",
      now: TEST_NOW,
    })).resolves.toMatchObject({
      status: "needs_clarification",
      requiredFields: ["meetingId"],
      message: "I found a scheduled meeting that may match this transcript, but it was not confident enough to auto-match. Choose it or create a new meeting to continue.",
      candidates: [{
        meetingId: "meeting-1",
        score: 0.52,
      }],
    });
  });

  it("creates a new meeting when candidate matches are explicitly rejected", async () => {
    createMeetingMock.mockResolvedValueOnce({
      id: "meeting-new",
      title: "Weekly Tactical",
    });
    const { intakeMeetingTranscript } = await import("./meeting-transcript-intake");

    await expect(intakeMeetingTranscript(USER_ACTOR, {
      workspaceId: "workspace-1",
      nativeReceipt: RECEIPT,
      title: "Weekly Tactical",
      recordedAt: new Date("2026-05-17T10:00:00.000Z"),
      source: "transcript-upload",
      transcript: "Jan: Follow up next week.",
      createNewMeeting: true,
      now: TEST_NOW,
    })).resolves.toMatchObject({
      status: "meeting_created",
      meeting: { id: "meeting-new" },
    });
    expect(uploadMeetingTranscriptMock).not.toHaveBeenCalled();
    expect(createMeetingMock).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({
      workspaceId: "workspace-1",
      title: "Weekly Tactical",
      transcript: "Jan: Follow up next week.",
    }));
  });
});
