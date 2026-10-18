import { afterEach, describe, expect, it, vi } from "vitest";

const {
  captureDirectMemberTranscriptInput,
  requireWorkspaceMembership,
  classifyUploadedTextForMeeting,
  intakeMeetingTranscript,
  ingestFile,
  extractTextFromFileBuffer,
  resolveRequestActor,
  handleRouteError,
} = vi.hoisted(() => ({
  captureDirectMemberTranscriptInput: vi.fn(async (_actor: unknown, _params: { workspaceId: string; submission: Record<string, unknown> }) => ({ inputId: "native-input" })),
  requireWorkspaceMembership: vi.fn(),
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
  captureDirectMemberTranscriptInput,
  requireWorkspaceMembership,
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
  it("checks membership before reading or extracting a submitted file", async () => {
    resolveRequestActor.mockResolvedValue({ kind: "user", user: { id: "outsider" } });
    requireWorkspaceMembership.mockRejectedValueOnce(new MockAppError(403, "FORBIDDEN", "Not a member"));
    handleRouteError.mockReturnValueOnce(new Response("denied", { status: 403 }));
    const { POST } = await import("./route");
    const request = { formData: vi.fn() };
    const response = await POST(request as never, { params: Promise.resolve({ workspaceId: "ws-1" }) });
    expect(response.status).toBe(403);
    expect(request.formData).not.toHaveBeenCalled();
    expect(extractTextFromFileBuffer).not.toHaveBeenCalled();
    expect(captureDirectMemberTranscriptInput).not.toHaveBeenCalled();
    expect(intakeMeetingTranscript).not.toHaveBeenCalled();
  });

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
        rawFileBase64: Buffer.from("hello").toString("base64"),
        rawFileMimeType: "text/plain",
        nativeReceipt: { inputId: "native-input" },
        userMessage: "April 30 2026 weekly transcript",
        recordedAt: new Date("2026-04-30T16:00:00.000Z"),
      }),
    );
    const captured = captureDirectMemberTranscriptInput.mock.calls[0];
    expect(captured[1].submission).toEqual(Object.fromEntries(Object.entries(intakeMeetingTranscript.mock.calls[0][1]).filter(([key]) => key !== "nativeReceipt")));
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

  it("uses a selected meeting for chat transcript uploads without a new date/time", async () => {
    resolveRequestActor.mockResolvedValue({ kind: "user", user: { id: "user-1" } });
    extractTextFromFileBuffer.mockResolvedValue({ textContent: "Jan: Milan owns onboarding.", supported: true });
    classifyUploadedTextForMeeting.mockReturnValue({
      classification: "meeting_transcript",
      confidence: 0.91,
      reason: "meeting",
    });
    intakeMeetingTranscript.mockResolvedValue({
      status: "meeting_matched",
      meeting: { id: "meeting-1", title: "Weekly" },
      message: "Transcript saved as meeting.",
      inferred: {},
    });

    const { POST } = await import("./route");
    const formData = new FormData();
    formData.set("file", new File(["hello"], "weekly-transcript.txt", { type: "text/plain" }));
    formData.set("meetingId", "meeting-1");

    const response = await POST(
      new Request("http://localhost/api/workspaces/ws-1/chat/attachments", { method: "POST", body: formData }) as never,
      { params: Promise.resolve({ workspaceId: "ws-1" }) },
    );

    expect(response.status).toBe(200);
    expect(intakeMeetingTranscript).toHaveBeenCalledWith(
      { kind: "user", user: { id: "user-1" } },
      expect.objectContaining({ meetingId: "meeting-1", recordedAt: null }),
    );
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
