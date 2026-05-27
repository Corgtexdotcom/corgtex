import { afterEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

const { processMeetingTranscriptSourceWebhook, normalizeMeetingTranscriptSourceProvider, handleRouteError } = vi.hoisted(() => ({
  processMeetingTranscriptSourceWebhook: vi.fn(),
  normalizeMeetingTranscriptSourceProvider: vi.fn(),
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
  normalizeMeetingTranscriptSourceProvider,
  processMeetingTranscriptSourceWebhook,
}));

vi.mock("@/lib/http", () => ({
  handleRouteError,
}));

afterEach(() => {
  vi.clearAllMocks();
});

describe("POST /api/integrations/meeting-transcripts/[provider]/webhook", () => {
  it("imports a signed provider webhook for the selected workspace", async () => {
    normalizeMeetingTranscriptSourceProvider.mockReturnValue("FIREFLIES");
    processMeetingTranscriptSourceWebhook.mockResolvedValue({
      batch: { id: "batch-1", status: "COMPLETED" },
    });
    const { POST } = await import("./route");
    const rawBody = JSON.stringify({ event: "meeting.transcribed", transcript_id: "ff-1" });

    const response = await POST(
      new NextRequest("http://localhost/api/integrations/meeting-transcripts/fireflies/webhook?workspaceId=ws-1", {
        method: "POST",
        headers: { "x-fireflies-signature": "sha256=abc" },
        body: rawBody,
      }) as never,
      { params: Promise.resolve({ provider: "fireflies" }) },
    );

    expect(response.status).toBe(200);
    expect(processMeetingTranscriptSourceWebhook).toHaveBeenCalledWith(expect.objectContaining({
      provider: "FIREFLIES",
      workspaceId: "ws-1",
      rawBody,
    }));
    expect(handleRouteError).not.toHaveBeenCalled();
  });

  it("rejects invalid provider signatures before route success", async () => {
    normalizeMeetingTranscriptSourceProvider.mockReturnValue("FATHOM");
    const error = new MockAppError(401, "INVALID_SIGNATURE", "Invalid meeting transcript webhook signature.");
    processMeetingTranscriptSourceWebhook.mockRejectedValue(error);
    handleRouteError.mockReturnValue(new Response("invalid", { status: 401 }));
    const { POST } = await import("./route");

    const response = await POST(
      new NextRequest("http://localhost/api/integrations/meeting-transcripts/fathom/webhook?workspaceId=ws-1", {
        method: "POST",
        headers: { "x-fathom-signature": "bad" },
        body: "{}",
      }) as never,
      { params: Promise.resolve({ provider: "fathom" }) },
    );

    expect(response.status).toBe(401);
    expect(handleRouteError).toHaveBeenCalledWith(error);
  });
});
