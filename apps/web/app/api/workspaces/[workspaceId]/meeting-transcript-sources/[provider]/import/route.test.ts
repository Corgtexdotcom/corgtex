import { afterEach, describe, expect, it, vi } from "vitest";

const {
  captureManualTranscriptSourceArtifact,
  requireWorkspaceMembership,
  importMeetingTranscriptSourceArtifacts,
  normalizeMeetingTranscriptSourceProvider,
  resolveRequestActor,
  checkApiDemoGuard,
  handleRouteError,
} = vi.hoisted(() => ({
  captureManualTranscriptSourceArtifact: vi.fn(),
  requireWorkspaceMembership: vi.fn(),
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
  captureManualTranscriptSourceArtifact,
  requireWorkspaceMembership,
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
  transcriptArtifactByteBudget: vi.fn((value: unknown) => typeof value === "string" ? Buffer.byteLength(value) + 2 : 100),
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
    expect(requireWorkspaceMembership).toHaveBeenCalledWith({ actor, workspaceId: "ws-1" });
    expect(captureManualTranscriptSourceArtifact).toHaveBeenCalledWith(actor, expect.objectContaining({ workspaceId: "ws-1", provider: "FIREFLIES", artifact: expect.objectContaining({ rawRequestText: expect.stringContaining("Import this transcript") }) }));
    expect(requireWorkspaceMembership.mock.invocationCallOrder[0]).toBeLessThan(captureManualTranscriptSourceArtifact.mock.invocationCallOrder[0]);
    expect(checkApiDemoGuard).toHaveBeenCalledWith("ws-1");
    expect(importMeetingTranscriptSourceArtifacts).toHaveBeenCalledWith(actor, expect.objectContaining({
      workspaceId: "ws-1",
      provider: "FIREFLIES",
      sourceKind: "api_upload",
    }));
    expect(handleRouteError).not.toHaveBeenCalled();
  });
  it("rejects repeated raw JSON custody before creating any native receipt or import batch", async () => {
    resolveRequestActor.mockResolvedValue({ kind: "user", user: { id: "user-1" } });
    normalizeMeetingTranscriptSourceProvider.mockReturnValue("FIREFLIES");
    handleRouteError.mockImplementation((error: MockAppError) => Response.json({ code: error.code }, { status: error.status }));
    const { POST } = await import("./route");
    const response = await POST(new Request("http://localhost/import", { method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ originalPadding: "x".repeat(1024 * 1024), artifacts: Array.from({ length: 50 }, (_, index) => ({ externalId: String(index), text: "Small original" })) }),
    }) as never, { params: Promise.resolve({ workspaceId: "ws-1", provider: "fireflies" }) });
    expect(response.status).toBe(413);
    expect(captureManualTranscriptSourceArtifact).not.toHaveBeenCalled();
    expect(importMeetingTranscriptSourceArtifacts).not.toHaveBeenCalled();
  });

});
