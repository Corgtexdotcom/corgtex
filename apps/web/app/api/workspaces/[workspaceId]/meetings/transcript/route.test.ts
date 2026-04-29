import { afterEach, describe, expect, it, vi } from "vitest";

const { uploadMeetingTranscript, resolveRequestActor, handleRouteError } = vi.hoisted(() => ({
  uploadMeetingTranscript: vi.fn(),
  resolveRequestActor: vi.fn(),
  handleRouteError: vi.fn(),
}));

vi.mock("@corgtex/domain", () => ({
  uploadMeetingTranscript,
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
    uploadMeetingTranscript.mockResolvedValue({
      status: "needs_selection",
      meeting: null,
      candidates: [{ meetingId: "meeting-1", score: 0.72 }],
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
          participantEmails: ["jan@example.com"],
        }),
      }) as never,
      { params: Promise.resolve({ workspaceId: "ws-1" }) },
    );

    expect(response.status).toBe(409);
    expect(uploadMeetingTranscript).toHaveBeenCalledWith(
      { kind: "user", user: { id: "user-1" } },
      expect.objectContaining({
        workspaceId: "ws-1",
        title: "Weekly Tactical",
        transcript: "Transcript text",
        participantEmails: ["jan@example.com"],
      }),
    );
    expect(handleRouteError).not.toHaveBeenCalled();
  });
});
