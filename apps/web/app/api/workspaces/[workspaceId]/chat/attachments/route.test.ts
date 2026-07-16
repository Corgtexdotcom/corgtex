import { afterEach, describe, expect, it, vi } from "vitest";

const {
  classifyUploadedTextForMeeting,
  intakeMeetingTranscript,
  ingestFile,
  extractTextFromFileBuffer,
  resolveRequestActor,
  handleRouteError,
} = vi.hoisted(() => ({
  classifyUploadedTextForMeeting: vi.fn(),
  intakeMeetingTranscript: vi.fn(),
  ingestFile: vi.fn(),
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
  classifyUploadedTextForMeeting,
  intakeMeetingTranscript,
}));

vi.mock("@corgtex/knowledge", () => ({
  extractTextFromFileBuffer,
  ingestFile,
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

describe("POST /api/workspaces/[workspaceId]/chat/attachments", () => {
  it("routes likely meeting transcripts into Meetings", async () => {
    resolveRequestActor.mockResolvedValue({ kind: "user", user: { id: "user-1" } });
    extractTextFromFileBuffer.mockResolvedValue({ textContent: "Jan: Milan owns onboarding.", supported: true });
    classifyUploadedTextForMeeting.mockReturnValue({
      classification: "meeting_transcript",
      confidence: 0.91,
      reason: "meeting",
    });
    intakeMeetingTranscript.mockResolvedValue({
      status: "meeting_created",
      meeting: { id: "meeting-1", title: "Weekly" },
      message: "Transcript saved as meeting.",
      inferred: {},
    });

    const { POST } = await import("./route");
    const formData = new FormData();
    formData.set("file", new File(["hello"], "weekly-transcript.txt", { type: "text/plain" }));
    formData.set("message", "April 30 2026 weekly transcript");
    formData.set("recordedAt", "2026-04-30T09:00");
    formData.set("timeZone", "America/Los_Angeles");

    const response = await POST(
      new Request("http://localhost/api/workspaces/ws-1/chat/attachments", {
        method: "POST",
        body: formData,
      }) as never,
      { params: Promise.resolve({ workspaceId: "ws-1" }) },
    );
    const json = await response.json();

    expect(response.status).toBe(200);
    expect(json.status).toBe("meeting_created");
    expect(json.webUrl).toBe("/workspaces/ws-1/meetings/meeting-1");
    expect(intakeMeetingTranscript).toHaveBeenCalledWith(
      { kind: "user", user: { id: "user-1" } },
      expect.objectContaining({
        workspaceId: "ws-1",
        transcript: "Jan: Milan owns onboarding.",
        userMessage: "April 30 2026 weekly transcript",
        recordedAt: new Date("2026-04-30T16:00:00.000Z"),
      }),
    );
    expect(ingestFile).not.toHaveBeenCalled();
  });

  it("routes chat meeting transcripts without date/time to the full upload flow", async () => {
    resolveRequestActor.mockResolvedValue({ kind: "user", user: { id: "user-1" } });
    extractTextFromFileBuffer.mockResolvedValue({ textContent: "Jan: Milan owns onboarding.", supported: true });
    classifyUploadedTextForMeeting.mockReturnValue({
      classification: "meeting_transcript",
      confidence: 0.91,
      reason: "meeting",
    });

    const { POST } = await import("./route");
    const formData = new FormData();
    formData.set("file", new File(["hello"], "weekly-transcript.txt", { type: "text/plain" }));

    const response = await POST(
      new Request("http://localhost/api/workspaces/ws-1/chat/attachments", {
        method: "POST",
        body: formData,
      }) as never,
      { params: Promise.resolve({ workspaceId: "ws-1" }) },
    );
    const json = await response.json();

    expect(response.status).toBe(200);
    expect(json.status).toBe("needs_meeting_details");
    expect(json.requiredFields).toEqual(["recordedAt"]);
    expect(json.webUrl).toBe("/workspaces/ws-1/add?kind=meeting_transcript");
    expect(intakeMeetingTranscript).not.toHaveBeenCalled();
    expect(ingestFile).not.toHaveBeenCalled();
  });

  it("keeps generic uploads on the document path", async () => {
    resolveRequestActor.mockResolvedValue({ kind: "user", user: { id: "user-1" } });
    extractTextFromFileBuffer.mockResolvedValue({ textContent: "Quarterly policy", supported: true });
    classifyUploadedTextForMeeting.mockReturnValue({
      classification: "document",
      confidence: 0.3,
      reason: "document",
    });
    ingestFile.mockResolvedValue({ document: { id: "doc-1", title: "policy.md" } });

    const { POST } = await import("./route");
    const formData = new FormData();
    formData.set("file", new File(["hello"], "policy.md", { type: "text/markdown" }));

    const response = await POST(
      new Request("http://localhost/api/workspaces/ws-1/chat/attachments", {
        method: "POST",
        body: formData,
      }) as never,
      { params: Promise.resolve({ workspaceId: "ws-1" }) },
    );
    const json = await response.json();

    expect(response.status).toBe(200);
    expect(json.status).toBe("document_uploaded");
    expect(ingestFile).toHaveBeenCalledWith(
      { kind: "user", user: { id: "user-1" } },
      expect.objectContaining({
        workspaceId: "ws-1",
        fileName: "policy.md",
        uploadSource: "chat-upload",
      }),
    );
    expect(intakeMeetingTranscript).not.toHaveBeenCalled();
  });
});
