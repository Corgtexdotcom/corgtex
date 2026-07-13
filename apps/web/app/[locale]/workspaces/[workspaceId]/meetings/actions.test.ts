import { afterEach, describe, expect, it, vi } from "vitest";
import type { ManualMeetingRecordingActionState } from "./actions";

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
  extractTextFromFileBuffer: vi.fn(),
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
  intakeMeetingTranscript: vi.fn(),
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

afterEach(() => {
  vi.clearAllMocks();
});

describe("meeting server actions", () => {
  it("returns inline state and preserves values when manual recorder validation fails", async () => {
    const { scheduleManualMeetingRecordingAction } = await import("./actions");
    sendManualMeetingRecorder.mockRejectedValueOnce(Object.assign(
      new Error("Paste the full Microsoft Teams join link that starts with https://teams.microsoft.com/l/meetup-join/."),
      { status: 400, code: "RECORDER_TEAMS_FULL_JOIN_LINK_REQUIRED" },
    ));

    const state = await scheduleManualMeetingRecordingAction(initialState, formData({
      workspaceId: "workspace-1",
      meetingUrl: "https://teams.microsoft.com/meet/21377000607471?p=abc",
      title: "Client call",
      durationMinutes: "60",
      participantEmails: "team@example.com",
    }));

    expect(state).toEqual({
      status: "error",
      message: "Paste the full Microsoft Teams join link that starts with https://teams.microsoft.com/l/meetup-join/.",
      values: {
        meetingUrl: "https://teams.microsoft.com/meet/21377000607471?p=abc",
        title: "Client call",
        durationMinutes: "60",
        participantEmails: "team@example.com",
      },
    });
    expect(enforceDemoGuard).toHaveBeenCalledWith("workspace-1");
    expect(requirePageActor).toHaveBeenCalled();
    expect(sendManualMeetingRecorder).toHaveBeenCalledWith(actor, expect.objectContaining({
      workspaceId: "workspace-1",
      meetingUrl: "https://teams.microsoft.com/meet/21377000607471?p=abc",
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
});
