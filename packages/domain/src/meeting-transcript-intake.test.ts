import { beforeEach, describe, expect, it, vi } from "vitest";

const { modelGatewayMock, uploadMeetingTranscriptMock } = vi.hoisted(() => ({
  modelGatewayMock: {
    extract: vi.fn(),
  },
  uploadMeetingTranscriptMock: vi.fn(),
}));

vi.mock("@corgtex/models", () => ({
  defaultModelGateway: modelGatewayMock,
}));

vi.mock("./meetings", () => ({
  uploadMeetingTranscript: uploadMeetingTranscriptMock,
}));

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
      transcript: "Jan: We need a follow-up.",
    });

    expect(modelGatewayMock.extract).toHaveBeenCalledTimes(1);
    expect(metadata).toEqual({
      title: "Model Tactical",
      recordedAt: new Date("2026-05-17T11:00:00.000Z"),
      participantEmails: ["model@example.com"],
      source: "chat-transcript-upload",
    });
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
    });

    expect(uploadMeetingTranscriptMock).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({
      meetingUrl: null,
    }));
  });
});
