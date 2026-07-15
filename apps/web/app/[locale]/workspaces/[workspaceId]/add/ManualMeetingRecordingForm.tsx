"use client";

import { useActionState } from "react";
import { useFormStatus } from "react-dom";
import {
  DEFAULT_MEETING_DURATION_MINUTES,
  MAX_MEETING_DURATION_MINUTES,
  MIN_MEETING_DURATION_MINUTES,
} from "@/lib/meeting-timezone";
import {
  scheduleManualMeetingRecordingAction,
  type ManualMeetingRecordingActionState,
} from "../meetings/actions";

const initialState: ManualMeetingRecordingActionState = {
  status: "idle",
  values: {
    durationMinutes: String(DEFAULT_MEETING_DURATION_MINUTES),
  },
};

function SubmitButton() {
  const { pending } = useFormStatus();
  return (
    <button type="submit" disabled={pending}>
      {pending ? "Sending recorder..." : "Send recorder now"}
    </button>
  );
}

export function ManualMeetingRecordingForm({
  workspaceId,
  cancelHref,
}: {
  workspaceId: string;
  cancelHref: string;
}) {
  const [state, formAction] = useActionState(scheduleManualMeetingRecordingAction, initialState);
  const values = state.values ?? initialState.values ?? {};

  return (
    <form action={formAction} noValidate className="stack nr-form-section">
      <input type="hidden" name="workspaceId" value={workspaceId} />
      <label>
        Meeting URL
        <input
          name="meetingUrl"
          type="url"
          placeholder="https://teams.microsoft.com/meet/..."
          defaultValue={values.meetingUrl ?? ""}
          required
        />
      </label>
      <details>
        <summary className="nr-hide-marker" style={{ cursor: "pointer", fontWeight: 600, color: "var(--accent)" }}>Optional details</summary>
        <div className="stack" style={{ marginTop: 12 }}>
          <label>
            Title
            <input name="title" placeholder="Live meeting" defaultValue={values.title ?? ""} />
          </label>
          <label>
            Duration (minutes)
            <input
              name="durationMinutes"
              type="number"
              min={MIN_MEETING_DURATION_MINUTES}
              max={MAX_MEETING_DURATION_MINUTES}
              step={1}
              defaultValue={values.durationMinutes ?? String(DEFAULT_MEETING_DURATION_MINUTES)}
            />
          </label>
          <label>
            Participant emails
            <input
              name="participantEmails"
              placeholder="one@example.com, two@example.com"
              defaultValue={values.participantEmails ?? ""}
            />
          </label>
        </div>
      </details>
      {state.status === "error" && state.message ? (
        <p className="form-message form-message-error" role="alert">
          {state.message}
        </p>
      ) : null}
      <div className="actions-inline">
        <SubmitButton />
        <a className="link-button secondary" href={cancelHref}>Cancel</a>
      </div>
    </form>
  );
}
