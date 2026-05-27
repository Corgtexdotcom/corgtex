import { afterEach, describe, expect, it, vi } from "vitest";

const {
  importMeetingTranscriptSourceArtifacts,
  normalizeMeetingTranscriptSourceProvider,
  resolveRequestActor,
  checkApiDemoGuard,
  handleRouteError,
} = vi.hoisted(() => ({
  importMeetingTranscriptSourceArtifacts: vi.fn(),
  normalizeMeetingTranscriptSourceProvider: vi.fn(),
  resolveRequestActor: vi.fn(),
  checkApiDemoGuard: vi.fn(),
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
  importMeetingTranscriptSourceArtifacts,
  normalizeMeetingTranscriptSourceProvider,
}));

vi.mock("@/lib/auth", () => ({
  resolveRequestActor,
}));

vi.mock("@/lib/demo-guard", () => ({
  checkApiDemoGuard,
}));

vi.mock("@/lib/http", () => ({
  handleRouteError,
}));

vi.mock("@/lib/meeting-transcript-source-artifacts", () => ({
  meetingTranscriptArtifactsFromFormData: vi.fn(),
}));

afterEach(() => {
  vi.clearAllMocks();
});

describe("POST /api/workspaces/[workspaceId]/meeting-transcript-sources/[provider]/import", () => {
  it("enforces the API demo guard before importing transcript artifacts", async () => {
    const actor = { kind: "user", user: { id: "user-1" } };
    resolveRequestActor.mockResolvedValue(actor);
    normalizeMeetingTranscriptSourceProvider.mockReturnValue("FIREFLIES");
    importMeetingTranscriptSourceArtifacts.mockResolvedValue({
      batch: { id: "batch-1", status: "COMPLETED" },
      results: [],
    });

    const { POST } = await import("./route");
    const response = await POST(
      new Request("http://localhost/api/workspaces/ws-1/meeting-transcript-sources/fireflies/import", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          artifacts: [{
            externalId: "ff-1",
            recordedAt: "2026-05-01T10:00:00.000Z",
            text: "Jan: Import this transcript.",
          }],
        }),
      }) as never,
      { params: Promise.resolve({ workspaceId: "ws-1", provider: "fireflies" }) },
    );

    expect(response.status).toBe(201);
    expect(checkApiDemoGuard).toHaveBeenCalledWith("ws-1");
    expect(importMeetingTranscriptSourceArtifacts).toHaveBeenCalledWith(actor, expect.objectContaining({
      workspaceId: "ws-1",
      provider: "FIREFLIES",
      sourceKind: "api_upload",
    }));
    expect(handleRouteError).not.toHaveBeenCalled();
  });
});
