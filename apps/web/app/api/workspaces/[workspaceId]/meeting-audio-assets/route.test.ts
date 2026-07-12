import { NextRequest, NextResponse } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

const {
  createMeetingAudioAsset,
  findManyMeetingAudioAssets,
  handleRouteError,
  requireWorkspaceMembership,
  resolveRequestActor,
} = vi.hoisted(() => ({
  createMeetingAudioAsset: vi.fn(),
  findManyMeetingAudioAssets: vi.fn(),
  handleRouteError: vi.fn((error: unknown) => NextResponse.json({ error: String(error) }, { status: 500 })),
  requireWorkspaceMembership: vi.fn(),
  resolveRequestActor: vi.fn(),
}));

class MockAppError extends Error {
  constructor(public status: number, public code: string, message: string) {
    super(message);
  }
}

vi.mock("@corgtex/domain", () => ({ AppError: MockAppError, createMeetingAudioAsset, requireWorkspaceMembership }));
vi.mock("@corgtex/shared", () => ({ prisma: { meetingAudioAsset: { findMany: findManyMeetingAudioAssets } } }));
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
    requireWorkspaceMembership.mockResolvedValue({ id: "member-1" });
  });

  it("lists sanitized audio asset summaries after workspace authorization", async () => {
    findManyMeetingAudioAssets.mockResolvedValue([
      audioAsset({
        status: "TRANSCRIBING",
        workflowJob: {
          id: "job-1",
          status: "RUNNING",
          attempts: 1,
          error: null,
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
        where: { workspaceId: "workspace-1" },
        orderBy: [{ createdAt: "desc" }],
        take: 50,
        select: expect.not.objectContaining({ storageKey: true, transcriptText: true }),
      }),
    );
    expect(json.audioAssets[0]).toMatchObject({
      id: "audio-1",
      recordedAt: "2026-07-10T15:00:00.000Z",
      createdAt: "2026-07-10T15:01:00.000Z",
      workflowJob: { id: "job-1", runAfter: "2026-07-10T15:01:00.000Z" },
    });
    expect(json.audioAssets[0]).not.toHaveProperty("storageKey");
    expect(json.audioAssets[0]).not.toHaveProperty("transcriptText");
  });

  it("uploads multipart audio through the domain primitive", async () => {
    createMeetingAudioAsset.mockResolvedValue({ workflowJobId: "job-1", audioAsset: audioAsset({ sizeBytes: 5 }) });
    const formData = new FormData();
    formData.set("file", new File(["audio"], "Team Sync.m4a", { type: "audio/mp4" }));
    formData.set("meetingId", "meeting-1");
    formData.set("title", "Team Sync");
    formData.set("recordedAt", "2026-07-10T15:00:00.000Z");
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
        recordedAt: new Date("2026-07-10T15:00:00.000Z"),
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

  it("rejects invalid upload input before domain creation", async () => {
    const { POST } = await import("./route");
    const formData = new FormData();
    formData.set("file", new File(["text"], "notes.txt", { type: "text/plain" }));

    await POST(request({ method: "POST", body: formData }), context());
    expect(handleRouteError).toHaveBeenLastCalledWith(expect.any(MockAppError), {
      request: expect.any(NextRequest),
      surface: "meeting_audio_assets",
      workspaceId: "workspace-1",
    });

    await POST(request({ method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({}) }), context());
    expect(handleRouteError).toHaveBeenLastCalledWith(expect.any(MockAppError), {
      request: expect.any(NextRequest),
      surface: "meeting_audio_assets",
      workspaceId: undefined,
    });
    expect(createMeetingAudioAsset).not.toHaveBeenCalled();
  });
});
