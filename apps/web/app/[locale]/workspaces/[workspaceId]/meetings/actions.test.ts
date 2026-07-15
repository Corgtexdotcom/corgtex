import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ManualMeetingRecordingActionState, MeetingTranscriptActionState } from "./actions";

const actor = {
  kind: "user" as const,
  user: {
    id: "user-1",
    email: "user@example.com",
    displayName: "User",
    globalRole: "USER",
  },
};

const enforceDemoGuard = vi.fn();
const requirePageActor = vi.fn(async () => actor);
const redirect = vi.fn((url: string) => {
  throw new Error(`redirect:${url}`);
});
const sendManualMeetingRecorder = vi.fn();
const intakeMeetingTranscript = vi.fn();
const extractTextFromFileBuffer = vi.fn();
const redisClient = {
  del: vi.fn(),
  get: vi.fn(),
  setEx: vi.fn(),
};
const getRedisClient = vi.fn();

vi.mock("@/lib/demo-guard", () => ({
  enforceDemoGuard,
}));

vi.mock("@/lib/auth", () => ({
  requirePageActor,
}));

vi.mock("next/navigation", () => ({
  redirect,
}));

vi.mock("next/cache", () => ({
  revalidatePath: vi.fn(),
}));

vi.mock("@corgtex/knowledge", () => ({
  extractTextFromFileBuffer,
}));

vi.mock("@corgtex/shared", () => ({
  getRedisClient,
  redisKey: (key: string) => `test:${key}`,
}));

vi.mock("@corgtex/domain", () => ({
  DEFAULT_MEETING_DURATION_MINUTES: 60,
  MAX_MEETING_DURATION_MINUTES: 480,
  MIN_MEETING_DURATION_MINUTES: 1,
  applyInsight: vi.fn(),
  cancelMeetingRecording: vi.fn(),
  createMeetingSeries: vi.fn(),
  deleteMeeting: vi.fn(),
  dismissInsight: vi.fn(),
  enqueueMeetingAgendaPreparation: vi.fn(),
  importMeetingInvite: vi.fn(),
  intakeMeetingTranscript,
  postDeliberationEntry: vi.fn(),
  requireWorkspaceMembership: vi.fn(),
  requestMeetingIntelligenceRegeneration: vi.fn(),
  replayWorkflowJob: vi.fn(),
  resolveDeliberationEntry: vi.fn(),
  scheduleMeetingRecording: vi.fn(),
  sendManualMeetingRecorder,
  updateInsight: vi.fn(),
}));

function formData(values: Record<string, string>) {
  const data = new FormData();
  for (const [key, value] of Object.entries(values)) {
    data.set(key, value);
  }
  return data;
}

const initialState: ManualMeetingRecordingActionState = {
  status: "idle",
  values: {},
};

const initialTranscriptState: MeetingTranscriptActionState = {
  status: "idle",
  message: null,
};

beforeEach(() => {
  getRedisClient.mockResolvedValue(redisClient);
  redisClient.del.mockResolvedValue(1);
  redisClient.get.mockResolvedValue(null);
  redisClient.setEx.mockResolvedValue("OK");
});

afterEach(() => {
  vi.clearAllMocks();
});

describe("meeting server actions", () => {
  it("returns inline state and preserves values when manual recorder validation fails", async () => {
    const { scheduleManualMeetingRecordingAction } = await import("./actions");
    sendManualMeetingRecorder.mockRejectedValueOnce(Object.assign(
      new Error("Paste a supported live meeting link from Microsoft Teams, Google Meet, or Zoom."),
      { status: 400, code: "RECORDER_TEAMS_FULL_JOIN_LINK_REQUIRED" },
    ));

    const state = await scheduleManualMeetingRecordingAction(initialState, formData({
      workspaceId: "workspace-1",
      meetingUrl: "https://teams.microsoft.com/meet/12345678901234?p=abc",
      title: "Client call",
      durationMinutes: "60",
      participantEmails: "team@example.com",
    }));

    expect(state).toEqual({
      status: "error",
      message: "Paste a supported live meeting link from Microsoft Teams, Google Meet, or Zoom.",
      values: {
        meetingUrl: "https://teams.microsoft.com/meet/12345678901234?p=abc",
        title: "Client call",
        durationMinutes: "60",
        participantEmails: "team@example.com",
      },
    });
    expect(enforceDemoGuard).toHaveBeenCalledWith("workspace-1");
    expect(requirePageActor).toHaveBeenCalled();
    expect(sendManualMeetingRecorder).toHaveBeenCalledWith(actor, expect.objectContaining({
      workspaceId: "workspace-1",
      meetingUrl: "https://teams.microsoft.com/meet/12345678901234?p=abc",
      title: "Client call",
      durationMinutes: "60",
      participantEmails: ["team@example.com"],
    }));
    expect(redirect).not.toHaveBeenCalled();
  });

  it("redirects to meetings with success state after manual recorder scheduling succeeds", async () => {
    const { scheduleManualMeetingRecordingAction } = await import("./actions");
    sendManualMeetingRecorder.mockResolvedValueOnce({
      meeting: { id: "meeting-1" },
      recording: { id: "recording-1", status: "SCHEDULED" },
    });

    await expect(scheduleManualMeetingRecordingAction(initialState, formData({
      workspaceId: "workspace-1",
      meetingUrl: "https://meet.google.com/abc-defg-hij",
    }))).rejects.toThrow("redirect:/workspaces/workspace-1/meetings?recorderSent=meeting-1");

    expect(redirect).toHaveBeenCalledWith("/workspaces/workspace-1/meetings?recorderSent=meeting-1");
  });

  it("returns candidate selection state and stores ambiguous transcript payload", async () => {
    const { uploadMeetingTranscriptStateAction } = await import("./actions");
    intakeMeetingTranscript.mockResolvedValueOnce({
      status: "needs_clarification",
      message: "I found multiple scheduled meetings that could match this transcript. Choose one and upload again.",
      requiredFields: ["meetingId"],
      inferred: {
        title: "Weekly Review",
        recordedAt: new Date("2026-07-15T16:00:00.000Z"),
        participantEmails: [],
        source: "transcript-upload",
      },
      candidates: [{
        meetingId: "meeting-1",
        title: "Weekly Review",
        recordedAt: new Date("2026-07-15T16:00:00.000Z"),
        score: 0.72,
        reason: "time",
      }],
    });

    const state = await uploadMeetingTranscriptStateAction(initialTranscriptState, formData({
      workspaceId: "workspace-1",
      title: "Weekly Review",
      source: "transcript-upload",
      recordedAt: "2026-07-15T09:00",
      timeZone: "America/Los_Angeles",
      transcript: "Jan: We discussed follow-up actions.",
      participantEmails: "jan@example.com",
    }));

    expect(state).toMatchObject({
      status: "needs_clarification",
      message: "I found multiple scheduled meetings that could match this transcript. Choose one and upload again.",
      requiredFields: ["meetingId"],
      retryRequiresTranscriptUpload: false,
      candidates: [{
        meetingId: "meeting-1",
        title: "Weekly Review",
        recordedAt: "2026-07-15T16:00:00.000Z",
        score: 0.72,
        reason: "time",
      }],
    });
    expect(state.pendingTranscriptToken).toEqual(expect.any(String));
    expect(redisClient.setEx).toHaveBeenCalledWith(
      expect.stringContaining("meeting-transcript-upload:workspace-1:"),
      1200,
      expect.stringContaining("Jan: We discussed follow-up actions."),
    );
    expect(redirect).not.toHaveBeenCalled();
  });

  it("uses a pending transcript token for selected meeting resubmission and clears it", async () => {
    const { uploadMeetingTranscriptStateAction } = await import("./actions");
    redisClient.get.mockResolvedValueOnce(JSON.stringify({
      workspaceId: "workspace-1",
      transcript: "Jan: We discussed follow-up actions.",
      fileName: "weekly.txt",
      title: "Weekly Review",
      source: "transcript-upload",
      recordedAt: "2026-07-15T09:00",
      timeZone: "America/Los_Angeles",
      summaryMd: null,
      ingestionGuidanceMd: "Preserve owners.",
      participantIds: [],
      participantEmails: ["jan@example.com"],
    }));
    intakeMeetingTranscript.mockResolvedValueOnce({
      status: "meeting_matched",
      message: "Transcript saved as meeting \"Weekly Review\". Summary and follow-up extraction are queued.",
      meeting: { id: "meeting-1" },
      inferred: {
        title: "Weekly Review",
        recordedAt: new Date("2026-07-15T16:00:00.000Z"),
        participantEmails: ["jan@example.com"],
        source: "transcript-upload",
      },
    });

    const state = await uploadMeetingTranscriptStateAction(initialTranscriptState, formData({
      workspaceId: "workspace-1",
      pendingTranscriptToken: "token-1",
      meetingId: "meeting-1",
    }));

    expect(state).toEqual({
      status: "success",
      message: "Transcript saved as meeting \"Weekly Review\". Summary and follow-up extraction are queued.",
      meetingId: "meeting-1",
    });
    expect(intakeMeetingTranscript).toHaveBeenCalledWith(actor, expect.objectContaining({
      workspaceId: "workspace-1",
      meetingId: "meeting-1",
      transcript: "Jan: We discussed follow-up actions.",
      fileName: "weekly.txt",
      ingestionGuidanceMd: "Preserve owners.",
      participantEmails: ["jan@example.com"],
    }));
    expect(redisClient.del).toHaveBeenCalledWith("test:meeting-transcript-upload:workspace-1:token-1");
  });

  it("keeps clarification inline and asks for retry when Redis cannot hold the pending transcript", async () => {
    const { uploadMeetingTranscriptStateAction } = await import("./actions");
    getRedisClient.mockResolvedValueOnce(null);
    intakeMeetingTranscript.mockResolvedValueOnce({
      status: "needs_clarification",
      message: "I can save this as a meeting transcript, but I need the meeting date/time first.",
      requiredFields: ["recordedAt"],
      inferred: {
        title: null,
        recordedAt: null,
        participantEmails: [],
        source: "transcript-upload",
      },
      candidates: [],
    });

    const state = await uploadMeetingTranscriptStateAction(initialTranscriptState, formData({
      workspaceId: "workspace-1",
      transcript: "Jan: We discussed follow-up actions.",
    }));

    expect(state).toMatchObject({
      status: "needs_clarification",
      pendingTranscriptToken: null,
      retryRequiresTranscriptUpload: true,
      requiredFields: ["recordedAt"],
    });
    expect(redirect).not.toHaveBeenCalled();
  });
});
