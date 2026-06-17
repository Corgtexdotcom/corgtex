import { afterEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

const {
  enableMeetingTranscriptSourcesForWorkspace,
  getMeetingTranscriptSourcesFeatureState,
  getV1MeetingTranscriptProviderCatalog,
  listMeetingTranscriptSourceState,
  resolveRequestActor,
  checkApiDemoGuard,
  handleRouteError,
} = vi.hoisted(() => ({
  enableMeetingTranscriptSourcesForWorkspace: vi.fn(),
  getMeetingTranscriptSourcesFeatureState: vi.fn(),
  getV1MeetingTranscriptProviderCatalog: vi.fn(),
  listMeetingTranscriptSourceState: vi.fn(),
  resolveRequestActor: vi.fn(),
  checkApiDemoGuard: vi.fn(),
  handleRouteError: vi.fn(),
}));

vi.mock("@corgtex/domain", () => ({
  enableMeetingTranscriptSourcesForWorkspace,
  getMeetingTranscriptSourcesFeatureState,
  getV1MeetingTranscriptProviderCatalog,
  listMeetingTranscriptSourceState,
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

function transcriptSourceState() {
  return {
    connections: [
      { id: "connection-read", provider: "READ_AI", status: "ACTIVE" },
      { id: "connection-otter", provider: "OTTER", status: "ACTIVE" },
    ],
    batches: [
      { id: "batch-read", provider: "READ_AI" },
      { id: "batch-otter", provider: "OTTER" },
    ],
    records: [
      { id: "record-read", provider: "READ_AI" },
      { id: "record-otter", provider: "OTTER" },
    ],
  };
}

afterEach(() => {
  vi.clearAllMocks();
});

describe("/api/workspaces/[workspaceId]/onboarding/meeting-recorder", () => {
  it("returns V1 transcript-source setup state for the current workspace actor", async () => {
    resolveRequestActor.mockResolvedValue({ kind: "user", user: { id: "user-1" } });
    getMeetingTranscriptSourcesFeatureState.mockResolvedValue({ featureEnabled: true });
    getV1MeetingTranscriptProviderCatalog.mockReturnValue([
      { provider: "READ_AI", label: "Read.ai" },
      { provider: "FATHOM", label: "Fathom" },
      { provider: "FIREFLIES", label: "Fireflies" },
      { provider: "MANUAL_UPLOAD", label: "Upload files" },
    ]);
    listMeetingTranscriptSourceState.mockResolvedValue(transcriptSourceState());
    const { GET } = await import("./route");

    const response = await GET(
      new NextRequest("https://app.corgtex.com/api/workspaces/ws-1/onboarding/meeting-recorder"),
      { params: Promise.resolve({ workspaceId: "ws-1" }) },
    );

    expect(getMeetingTranscriptSourcesFeatureState).toHaveBeenCalledWith(
      { kind: "user", user: { id: "user-1" } },
      "ws-1",
    );
    await expect(response.json()).resolves.toEqual(expect.objectContaining({
      featureEnabled: true,
      catalog: expect.arrayContaining([
        expect.objectContaining({ provider: "READ_AI" }),
        expect.objectContaining({ provider: "FATHOM" }),
        expect.objectContaining({ provider: "FIREFLIES" }),
        expect.objectContaining({ provider: "MANUAL_UPLOAD" }),
      ]),
      connections: [{ id: "connection-read", provider: "READ_AI", status: "ACTIVE" }],
    }));
  });

  it("initializes transcript-source access without enabling the Corgtex recorder", async () => {
    resolveRequestActor.mockResolvedValue({ kind: "user", user: { id: "user-1" } });
    getMeetingTranscriptSourcesFeatureState.mockResolvedValue({ featureEnabled: true });
    getV1MeetingTranscriptProviderCatalog.mockReturnValue([{ provider: "READ_AI", label: "Read.ai" }]);
    listMeetingTranscriptSourceState.mockResolvedValue(transcriptSourceState());
    const { POST } = await import("./route");

    const response = await POST(
      new NextRequest("https://app.corgtex.com/api/workspaces/ws-1/onboarding/meeting-recorder", {
        method: "POST",
        body: JSON.stringify({ enabled: true }),
      }),
      { params: Promise.resolve({ workspaceId: "ws-1" }) },
    );

    expect(checkApiDemoGuard).toHaveBeenCalledWith("ws-1");
    expect(enableMeetingTranscriptSourcesForWorkspace).toHaveBeenCalledWith(
      { kind: "user", user: { id: "user-1" } },
      { workspaceId: "ws-1", enabled: true },
    );
    expect(response.status).toBe(200);
  });
});
