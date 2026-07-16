import { afterEach, describe, expect, it, vi } from "vitest";

const { uploadMeetingTranscript, intakeMeetingTranscript, extractTextFromFileBuffer, resolveRequestActor, handleRouteError } = vi.hoisted(() => ({
  uploadMeetingTranscript: vi.fn(),
  intakeMeetingTranscript: vi.fn(),
  extractTextFromFileBuffer: vi.fn(),
  resolveRequestActor: vi.fn(),
  handleRouteError: vi.fn(),
}));

class MockAppError extends Error {
  status: number;
  code: string;

  constructor(status: number, code: string, message: string) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

vi.mock("@corgtex/domain", () => ({
  AppError: MockAppError,
  intakeMeetingTranscript,
  uploadMeetingTranscript,
}));

vi.mock("@corgtex/knowledge", () => ({
  extractTextFromFileBuffer,
}));

vi.mock("@/lib/auth", () => ({
  resolveRequestActor,
}));

vi.mock("@/lib/http", () => ({
  handleRouteError,
}));

afterEach(() => {
  vi.clearAllMocks();
});

describe("POST /api/workspaces/[workspaceId]/meetings/transcript", () => {
  it("returns matching candidates as a conflict when transcript auto-match is ambiguous", async () => {
    resolveRequestActor.mockResolvedValue({ kind: "user", user: { id: "user-1" } });
    intakeMeetingTranscript.mockResolvedValue({
      status: "needs_clarification",
      requiredFields: ["meetingId"],
      candidates: [{ meetingId: "meeting-1", score: 0.72 }],
      inferred: {},
      message: "I found multiple scheduled meetings that could match this transcript. Choose one or create a new meeting to continue.",
    });

    const { POST } = await import("./route");
    const response = await POST(
      new Request("http://localhost/api/workspaces/ws-1/meetings/transcript", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          title: "Weekly Tactical",
          recordedAt: "2026-04-30T17:10:00.000Z",
          transcript: "Transcript text",
          ingestionGuidanceMd: "Highlight decisions.",
          participantEmails: ["jan@example.com"],
        }),
      }) as never,
      { params: Promise.resolve({ workspaceId: "ws-1" }) },
    );

    expect(response.status).toBe(409);
    expect(intakeMeetingTranscript).toHaveBeenCalledWith(
      { kind: "user", user: { id: "user-1" } },
      expect.objectContaining({
        workspaceId: "ws-1",
        title: "Weekly Tactical",
        recordedAt: new Date("2026-04-30T17:10:00.000Z"),
        transcript: "Transcript text",
        ingestionGuidanceMd: "Highlight decisions.",
        participantEmails: ["jan@example.com"],
      }),
    );
    expect(uploadMeetingTranscript).not.toHaveBeenCalled();
    expect(handleRouteError).not.toHaveBeenCalled();
  });

  it("accepts multipart transcript files", async () => {
    resolveRequestActor.mockResolvedValue({ kind: "user", user: { id: "user-1" } });
    extractTextFromFileBuffer.mockResolvedValue({
      textContent: "Jan: We agreed Milan will own onboarding.",
      supported: true,
      truncated: false,
    });
    intakeMeetingTranscript.mockResolvedValue({
      status: "meeting_created",
      meeting: { id: "meeting-1", title: "Weekly Tactical" },
      message: "Transcript saved as meeting.",
      inferred: {},
    });

    const { POST } = await import("./route");
    const formData = new FormData();
    formData.set("file", new File(["ignored"], "weekly.txt", { type: "text/plain" }));
    formData.set("recordedAt", "2026-06-11T14:07");
    formData.set("timeZone", "America/Los_Angeles");
    formData.set("title", "Weekly Tactical");
    formData.set("ingestionGuidanceMd", "Track onboarding follow-ups.");

    const response = await POST(
      new Request("http://localhost/api/workspaces/ws-1/meetings/transcript", {
        method: "POST",
        body: formData,
      }) as never,
      { params: Promise.resolve({ workspaceId: "ws-1" }) },
    );

    expect(response.status).toBe(201);
    expect(intakeMeetingTranscript).toHaveBeenCalledWith(
      { kind: "user", user: { id: "user-1" } },
      expect.objectContaining({
        workspaceId: "ws-1",
        transcript: "Jan: We agreed Milan will own onboarding.",
        fileName: "weekly.txt",
        title: "Weekly Tactical",
        recordedAt: new Date("2026-06-11T21:07:00.000Z"),
        ingestionGuidanceMd: "Track onboarding follow-ups.",
      }),
    );
    expect(uploadMeetingTranscript).not.toHaveBeenCalled();
  });
});
