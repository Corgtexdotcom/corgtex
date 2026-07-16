import { beforeEach, describe, expect, it, vi } from "vitest";

const { createMeetingMock, modelGatewayMock, uploadMeetingTranscriptMock } = vi.hoisted(() => ({
  createMeetingMock: vi.fn(),
  modelGatewayMock: {
    extract: vi.fn(),
  },
  uploadMeetingTranscriptMock: vi.fn(),
}));

vi.mock("@corgtex/models", () => ({
  defaultModelGateway: modelGatewayMock,
}));

vi.mock("./meetings", () => ({
  createMeeting: createMeetingMock,
  uploadMeetingTranscript: uploadMeetingTranscriptMock,
}));

const TEST_NOW = new Date("2026-07-16T12:00:00.000Z");

describe("meeting transcript intake", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("skips model metadata extraction when title and recordedAt are explicit", async () => {
    const { inferMeetingTranscriptMetadata } = await import("./meeting-transcript-intake");

    const metadata = await inferMeetingTranscriptMetadata({
      workspaceId: "workspace-1",
      title: " Weekly Tactical ",
      recordedAt: "2026-05-17T10:00:00.000Z",
      now: TEST_NOW,
      source: " production-smoke ",
      transcript: [
        "Meeting title: Weekly Tactical",
        "Date: 2026-05-17T10:00:00.000Z",
        "Jan: Andy@example.com owns the follow-up.",
      ].join("\n"),
    });

    expect(modelGatewayMock.extract).not.toHaveBeenCalled();
    expect(metadata).toEqual({
      title: "Weekly Tactical",
      recordedAt: new Date("2026-05-17T10:00:00.000Z"),
      participantEmails: ["andy@example.com"],
      source: "production-smoke",
    });
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
      transcript: "Jan: We need a follow-up.", allowInferredRecordedAt: true, now: TEST_NOW,
    });

    expect(modelGatewayMock.extract).toHaveBeenCalledTimes(1);
    expect(metadata).toEqual({
      title: "Model Tactical",
      recordedAt: new Date("2026-05-17T11:00:00.000Z"),
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

    await expect(intakeMeetingTranscript({
      kind: "agent",
      authProvider: "bootstrap",
      label: "test-agent",
      workspaceIds: ["workspace-1"],
    }, {
      workspaceId: "workspace-1",
      source: "meeting-transcript:fireflies", provider: "FIREFLIES",
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

    await expect(intakeMeetingTranscript({
      kind: "agent",
      authProvider: "bootstrap",
      label: "test-agent",
      workspaceIds: ["workspace-1"],
    }, {
      workspaceId: "workspace-1",
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

  it("allows trusted provider imports to keep historical recordedAt values", async () => {
    uploadMeetingTranscriptMock.mockResolvedValueOnce({
      status: "created",
      meeting: { id: "meeting-provider" },
      candidates: [],
    });
    const { intakeMeetingTranscript } = await import("./meeting-transcript-intake");

    await expect(intakeMeetingTranscript({
      kind: "agent",
      authProvider: "bootstrap",
      label: "test-agent",
      workspaceIds: ["workspace-1"],
    }, {
      workspaceId: "workspace-1",
      title: "Historical provider transcript",
      recordedAt: new Date("2001-07-15T11:00:00.000Z"),
      source: "meeting-transcript:fireflies",
      provider: "FIREFLIES", sourceRecordId: "source-record-1",
      transcript: "Jan: Provider imported this historical meeting.",
      now: TEST_NOW,
    })).resolves.toMatchObject({
      status: "meeting_created",
      meeting: { id: "meeting-provider" },
    });
    expect(uploadMeetingTranscriptMock).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({
      recordedAt: new Date("2001-07-15T11:00:00.000Z"),
    }));
  });

  it("keeps source URLs out of meeting join URL matching", async () => {
    uploadMeetingTranscriptMock.mockResolvedValueOnce({
      status: "created",
      meeting: { id: "meeting-1" },
      candidates: [],
    });
    const { intakeMeetingTranscript } = await import("./meeting-transcript-intake");

    await intakeMeetingTranscript({
      kind: "agent",
      authProvider: "bootstrap",
      label: "test-agent",
      workspaceIds: ["workspace-1"],
    }, {
      workspaceId: "workspace-1",
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

    await expect(intakeMeetingTranscript({
      kind: "agent",
      authProvider: "bootstrap",
      label: "test-agent",
      workspaceIds: ["workspace-1"],
    }, {
      workspaceId: "workspace-1",
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

    await expect(intakeMeetingTranscript({
      kind: "agent",
      authProvider: "bootstrap",
      label: "test-agent",
      workspaceIds: ["workspace-1"],
    }, {
      workspaceId: "workspace-1",
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
