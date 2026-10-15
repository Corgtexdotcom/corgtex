import { NextRequest, NextResponse } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

const {
  createMeetingAudioAsset,
  findManyMeetingAudioAssets,
  findManyNativeInputs,
  readableArtifactIds,
  handleRouteError,
  isPlausibleMeetingRecordedAt,
  requireWorkspaceMembership,
  resolveRequestActor,
} = vi.hoisted(() => ({
  createMeetingAudioAsset: vi.fn(),
  findManyMeetingAudioAssets: vi.fn(),
  findManyNativeInputs: vi.fn(),
  readableArtifactIds: vi.fn(),
  handleRouteError: vi.fn((error: unknown) => NextResponse.json({ error: String(error) }, { status: 500 })),
  isPlausibleMeetingRecordedAt: vi.fn((value: Date | null) => Boolean(value && value.getUTCFullYear() >= 2016 && value.getUTCFullYear() <= 2026)),
  requireWorkspaceMembership: vi.fn(),
  resolveRequestActor: vi.fn(),
}));

class MockAppError extends Error {
  constructor(public status: number, public code: string, message: string) {
    super(message);
  }
}

vi.mock("@corgtex/domain", () => ({ AppError: MockAppError, MAX_AUDIO_FILE_BYTES: 500 * 1024 * 1024, createMeetingAudioAsset, isPlausibleMeetingRecordedAt, readableArtifactIds, requireWorkspaceMembership }));
vi.mock("@corgtex/shared", () => {
  const tx = { $queryRaw: vi.fn().mockResolvedValue([{ id: "member-1" }]),
    meetingAudioAsset: { findMany: findManyMeetingAudioAssets }, nativeTranscriptInput: { findMany: findManyNativeInputs } };
  return { prisma: { ...tx, $transaction: (run: (db: typeof tx) => unknown) => run(tx) } };
});
vi.mock("@/lib/auth", () => ({ resolveRequestActor }));
vi.mock("@/lib/http", async () => ({ ...(await vi.importActual<typeof import("@/lib/http")>("@/lib/http")), handleRouteError }));

function context(workspaceId = "workspace-1") {
  return { params: Promise.resolve({ workspaceId }) };
}

function request(init?: ConstructorParameters<typeof NextRequest>[1]) {
  return new NextRequest("http://localhost/api/workspaces/workspace-1/meeting-audio-assets?take=200", init);
}

function audioAsset(overrides = {}) {
  return {
    id: "audio-1",
    meetingId: "meeting-1",
    fileName: "Team Sync.m4a",
    mimeType: "audio/mp4",
    sizeBytes: 1234,
    durationSeconds: 180,
    title: "Team Sync",
    recordedAt: new Date("2026-07-10T15:00:00.000Z"),
    participantEmails: ["jan@example.com"],
    status: "UPLOADED",
    transcriptProvider: null,
    transcriptModel: null,
    workflowJobId: "job-1",
    intakeMeetingId: null,
    failureCode: null,
    failureMessage: null,
    transcribedAt: null,
    ingestedAt: null,
    createdAt: new Date("2026-07-10T15:01:00.000Z"),
    updatedAt: new Date("2026-07-10T15:02:00.000Z"),
    workflowJob: null,
    ...overrides,
  };
}

describe("/api/workspaces/[workspaceId]/meeting-audio-assets", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    resolveRequestActor.mockResolvedValue({ kind: "user", user: { id: "user-1" } });
    requireWorkspaceMembership.mockResolvedValue({ id: "member-1", userId: "user-1" });
    findManyNativeInputs.mockResolvedValue([{ id: "native-1", meetingAudioAssetId: "audio-1" }]);
    readableArtifactIds.mockResolvedValue(new Set(["audio-1"]));
  });

  it("lists sanitized audio asset summaries after workspace authorization", async () => {
    findManyMeetingAudioAssets.mockResolvedValue([
      audioAsset({
        status: "TRANSCRIBING",
        workflowJob: {
          id: "job-1",
          status: "RUNNING",
          attempts: 1,
          error: "raw provider response with private source text",
          runAfter: new Date("2026-07-10T15:01:00.000Z"),
          updatedAt: new Date("2026-07-10T15:02:00.000Z"),
        },
      }),
    ]);

    const { GET } = await import("./route");
    const response = await GET(request(), context());
    const json = await response.json();

    expect(response.status).toBe(200);
    expect(requireWorkspaceMembership).toHaveBeenCalledWith({
      actor: expect.objectContaining({ kind: "user" }),
      workspaceId: "workspace-1",
    });
    expect(findManyMeetingAudioAssets).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { workspaceId: "workspace-1", uploadedByUserId: "user-1" },
        orderBy: [{ createdAt: "desc" }, { id: "desc" }],
        take: 100,
        select: expect.objectContaining({ storageKey: true, transcriptText: true, transcriptMetadata: true }),
      }),
    );
    expect(json.audioAssets[0]).toMatchObject({
      id: "audio-1",
      recordedAt: "2026-07-10T15:00:00.000Z",
      createdAt: "2026-07-10T15:01:00.000Z",
      workflowJob: { id: "job-1", runAfter: "2026-07-10T15:01:00.000Z" },
    });
    expect(json.audioAssets[0].workflowJob.error).toBe("Audio processing failed.");
    expect(json.audioAssets[0]).not.toHaveProperty("storageKey");
    expect(json.audioAssets[0]).not.toHaveProperty("transcriptText");
  });

  it("withholds legacy and revoked inputs, then replenishes the requested page", async () => {
    const hidden = Array.from({ length: 100 }, (_, index) => audioAsset({
      id: `hidden-${index}`, fileName: `secret-${index}.m4a`,
    }));
    const visible = audioAsset({ id: "audio-allowed", fileName: "allowed.m4a" });
    findManyMeetingAudioAssets.mockResolvedValueOnce(hidden).mockResolvedValueOnce([visible]);
    findManyNativeInputs.mockResolvedValueOnce([{ id: "native-hidden", meetingAudioAssetId: "hidden-0" }])
      .mockResolvedValueOnce([{ id: "native-allowed", meetingAudioAssetId: "audio-allowed" }]);
    readableArtifactIds.mockResolvedValueOnce(new Set()).mockResolvedValueOnce(new Set(["audio-allowed"]));
    const { GET } = await import("./route");
    const response = await GET(new NextRequest("http://localhost/api/workspaces/workspace-1/meeting-audio-assets?take=1"), context());
    expect(response.status).toBe(200);
    expect((await response.json()).audioAssets).toEqual([expect.objectContaining({ id: "audio-allowed", fileName: "allowed.m4a" })]);
    expect(findManyMeetingAudioAssets).toHaveBeenCalledTimes(2);
  });

  it("rejects credentials before querying audio history", async () => {
    resolveRequestActor.mockResolvedValue({ kind: "agent", authProvider: "credential", workspaceIds: ["workspace-1"] });
    const { GET } = await import("./route");
    await GET(request(), context());
    expect(findManyMeetingAudioAssets).not.toHaveBeenCalled();
    expect(handleRouteError).toHaveBeenCalledWith(expect.objectContaining({ code: "SOURCE_RESTRICTED" }),
      expect.objectContaining({ surface: "meeting_audio_assets" }));
  });

  it("uploads multipart audio through the domain primitive", async () => {
    createMeetingAudioAsset.mockResolvedValue({ workflowJobId: "job-1", audioAsset: audioAsset({ sizeBytes: 5 }) });
    const formData = new FormData();
    formData.set("file", new File(["audio"], "Team Sync.m4a", { type: "audio/mp4" }));
    formData.set("meetingId", "meeting-1");
    formData.set("title", "Team Sync");
    formData.set("recordedAt", "2001-07-15T11:00:00.000Z");
    formData.set("durationSeconds", "180");
    formData.append("participantEmails", "jan@example.com, milan@example.com");
    formData.append("participantEmails", "david@example.com");

    const { POST } = await import("./route");
    const response = await POST(request({ method: "POST", body: formData }), context());
    const json = await response.json();

    expect(response.status).toBe(201);
    expect(createMeetingAudioAsset).toHaveBeenCalledWith(
      expect.objectContaining({ kind: "user" }),
      expect.objectContaining({
        workspaceId: "workspace-1",
        fileName: "Team Sync.m4a",
        mimeType: "audio/mp4",
        meetingId: "meeting-1",
        recordedAt: null,
        durationSeconds: 180,
        participantEmails: ["jan@example.com", "milan@example.com", "david@example.com"],
        fileBuffer: expect.any(Buffer),
      }),
    );
    expect(createMeetingAudioAsset.mock.calls[0][1].fileBuffer.toString("utf8")).toBe("audio");
    expect(json.audioAsset).toMatchObject({ id: "audio-1", workflowJobId: "job-1" });
    expect(json.audioAsset).not.toHaveProperty("storageKey");
    expect(json.audioAsset).not.toHaveProperty("transcriptText");
  });

  it("rejects a parsed oversized File before arrayBuffer allocation", async () => {
    const { POST } = await import("./route");
    const file = new File(["audio"], "large.m4a", { type: "audio/mp4" });
    Object.defineProperty(file, "size", { value: 500 * 1024 * 1024 + 1 });
    const readBytes = vi.spyOn(file, "arrayBuffer");
    const formData = new FormData();
    formData.set("file", file);
    const uploadRequest = request({ method: "POST", headers: { "Content-Type": "multipart/form-data" } });
    vi.spyOn(uploadRequest, "formData").mockResolvedValue(formData);
    await POST(uploadRequest, context());
    expect(readBytes).not.toHaveBeenCalled();
    expect(createMeetingAudioAsset).not.toHaveBeenCalled();
    expect(handleRouteError).toHaveBeenCalledWith(expect.objectContaining({ status: 413, code: "AUDIO_TOO_LARGE" }),
      expect.objectContaining({ workspaceId: "workspace-1" }));
  });

  it("rejects invalid upload input before domain creation", async () => {
    const { POST } = await import("./route");
    const formData = new FormData();
    formData.set("file", new File(["audio"], "Team Sync.m4a", { type: "audio/mp4" }));

    await POST(request({ method: "POST", body: formData }), context());
    expect(handleRouteError).toHaveBeenLastCalledWith(expect.any(MockAppError), {
      request: expect.any(NextRequest),
      surface: "meeting_audio_assets",
      workspaceId: "workspace-1",
    });
    formData.set("recordedAt", "2001-07-15T11:00:00.000Z");
    await POST(request({ method: "POST", body: formData }), context());
    expect(createMeetingAudioAsset).not.toHaveBeenCalled();

    await POST(request({ method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({}) }), context());
    expect(handleRouteError).toHaveBeenLastCalledWith(expect.any(MockAppError), {
      request: expect.any(NextRequest),
      surface: "meeting_audio_assets",
      workspaceId: undefined,
    });
  });
});
