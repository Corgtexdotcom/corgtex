"use client";

import { useActionState, useEffect, useRef, useState, type ReactNode } from "react";
import { MarkdownEditor } from "@/lib/components/MarkdownEditor";
import { TimeZoneSelect } from "@/lib/components/TimeZoneSelect";
import {
  uploadMeetingTranscriptStateAction,
  type MeetingTranscriptActionState,
  type MeetingTranscriptActionValues,
} from "./actions";

type HiddenField = {
  name: string;
  value: string;
};

type Labels = {
  title?: string;
  source?: string;
  recordedAt?: string;
  file?: string;
  transcript?: string;
  transcriptPlaceholder?: string;
  participantEmails?: string;
  participantEmailsPlaceholder?: string;
  participantIds?: string;
  participantIdsPlaceholder?: string;
  ingestionGuidance?: string;
  ingestionGuidanceHelp?: string;
  submit: string;
  retrySubmit?: string;
  chooseMeeting?: string;
  createNewMeeting?: string;
  retryUpload?: string;
  cancel?: string;
};

const CREATE_NEW_MEETING_CHOICE = "__create_new_meeting__";

const DUPLICATE_RESOLUTION_LABELS = {
  use_existing: "Use existing",
  update_existing: "Update existing",
  create_new: "Create new",
};

type Props = {
  workspaceId: string;
  className?: string;
  hiddenFields?: HiddenField[];
  defaultValues?: MeetingTranscriptActionValues;
  labels: Labels;
  showTitle?: boolean;
  showSource?: boolean;
  showRecordedAt?: boolean;
  requireRecordedAt?: boolean;
  showTimeZone?: boolean;
  showParticipants?: boolean;
  showParticipantIds?: boolean;
  showFile?: boolean;
  showTranscript?: boolean;
  showGuidance?: boolean;
  transcriptRows?: number;
  cancelHref?: string;
  successHref?: string;
  beforeFields?: ReactNode;
};

const initialMeetingTranscriptActionState: MeetingTranscriptActionState = {
  status: "idle",
  message: null,
};

function fieldValue(
  state: MeetingTranscriptActionState,
  defaults: MeetingTranscriptActionValues | undefined,
  key: keyof MeetingTranscriptActionValues,
) {
  return state.values?.[key] ?? defaults?.[key] ?? "";
}

function renderHiddenFields(workspaceId: string, hiddenFields: HiddenField[]) {
  return (
    <>
      <input type="hidden" name="workspaceId" value={workspaceId} />
      {hiddenFields.map((field) => (
        <input key={`${field.name}:${field.value}`} type="hidden" name={field.name} value={field.value} />
      ))}
    </>
  );
}

function candidateLabel(candidate: NonNullable<MeetingTranscriptActionState["candidates"]>[number]) {
  const recordedAt = new Date(candidate.recordedAt);
  const title = candidate.title?.trim() || "Untitled meeting";
  const score = Math.round(candidate.score * 100);
  return `${title} - ${recordedAt.toLocaleString()} - ${score}% match (${candidate.reason})`;
}

function DuplicateConfirmationPanel({
  state,
  isPending,
}: {
  state: MeetingTranscriptActionState;
  isPending: boolean;
}) {
  if (state.status !== "duplicate_confirmation_required" || !state.duplicateCandidate) return null;
  const candidate = state.duplicateCandidate;
  const allowedResolutions = state.allowedResolutions ?? ["use_existing", "update_existing", "create_new"];

  return (
    <section className="panel stack" style={{ borderColor: "var(--color-warning-border, #d97706)" }}>
      <div>
        <strong>Possible duplicate</strong>
        <p style={{ margin: "6px 0 0", color: "var(--muted)" }}>
          {candidate.title || candidate.entityType} matches an active {candidate.entityType} with score {Math.round(candidate.score * 100)}%.
        </p>
      </div>
      {candidate.excerpt ? <p style={{ margin: 0 }}>{candidate.excerpt}</p> : null}
      {candidate.reasons.length > 0 ? (
        <p style={{ margin: 0, color: "var(--muted)" }}>{candidate.reasons.join(", ")}</p>
      ) : null}
      <input type="hidden" name="duplicateTargetEntityId" value={candidate.entityId} />
      <div className="actions-inline">
        {allowedResolutions.map((resolution) => (
          <button key={resolution} type="submit" name="duplicateResolution" value={resolution} disabled={isPending}>
            {DUPLICATE_RESOLUTION_LABELS[resolution]}
          </button>
        ))}
      </div>
    </section>
  );
}

export function MeetingTranscriptUploadForm({
  workspaceId,
  className = "stack panel",
  hiddenFields = [],
  defaultValues,
  labels,
  showTitle = false,
  showSource = false,
  showRecordedAt = false,
  requireRecordedAt = false,
  showTimeZone = false,
  showParticipants = false,
  showParticipantIds = false,
  showFile = true,
  showTranscript = true,
  showGuidance = true,
  transcriptRows = 5,
  cancelHref,
  successHref,
  beforeFields,
}: Props) {
  const formRef = useRef<HTMLFormElement>(null);
  const [state, formAction, isPending] = useActionState(
    uploadMeetingTranscriptStateAction,
    initialMeetingTranscriptActionState,
  );
  const stateTimeZone = fieldValue(state, defaultValues, "timeZone");
  const [selectedTimeZone, setSelectedTimeZone] = useState(stateTimeZone || undefined);
  const [selectedMeetingChoice, setSelectedMeetingChoice] = useState<string | undefined>();
  const requiresMeetingChoice = state.status === "needs_clarification"
    && state.requiredFields?.includes("meetingId")
    && (state.candidates?.length ?? 0) > 0;
  const creatingNewMeetingFromChoice = requiresMeetingChoice && selectedMeetingChoice === CREATE_NEW_MEETING_CHOICE;
  const showDetailFields = !requiresMeetingChoice || creatingNewMeetingFromChoice;
  const requiresRecordedAt = state.status === "needs_clarification"
    && state.requiredFields?.includes("recordedAt");
  const mustRetryUpload = (state.status === "needs_clarification" || state.status === "duplicate_confirmation_required")
    && state.retryRequiresTranscriptUpload;
  const hasPendingTranscript = Boolean(state.pendingTranscriptToken) && !mustRetryUpload;
  const recordedAtRequired = requireRecordedAt || requiresRecordedAt;
  const showUploadFields = showDetailFields && !hasPendingTranscript;
  const formKey = `${state.status}:${state.pendingTranscriptToken ?? "no-token"}:${mustRetryUpload ? "retry" : "normal"}`;

  useEffect(() => {
    if (state.status === "success" && successHref) {
      window.location.assign(successHref);
    }
  }, [state.status, successHref]);

  useEffect(() => {
    if (state.status === "idle" || successHref) return;
    const form = formRef.current;
    if (!form) return;
    const parentDetails = form.closest("details");
    if (parentDetails instanceof HTMLDetailsElement) {
      parentDetails.open = true;
    }
    form.scrollIntoView({ behavior: "smooth", block: "start" });
  }, [state.status, successHref]);

  useEffect(() => {
    if (stateTimeZone) setSelectedTimeZone(stateTimeZone);
  }, [stateTimeZone]);

  useEffect(() => {
    if (state.status === "needs_clarification") {
      setSelectedMeetingChoice(undefined);
    }
  }, [state.status, state.pendingTranscriptToken]);

  return (
    <form action={formAction} className={className} key={formKey} ref={formRef}>
      {renderHiddenFields(workspaceId, hiddenFields)}
      {state.pendingTranscriptToken ? (
        <input type="hidden" name="pendingTranscriptToken" value={state.pendingTranscriptToken} />
      ) : null}

      {state.status === "success" && !successHref ? (
        <p className="form-message form-message-success" role="status">
          {state.message}
        </p>
      ) : null}
      {state.status === "error" ? (
        <p className="form-message form-message-error" role="alert">
          {state.message}
        </p>
      ) : null}
      {state.status === "needs_clarification" ? (
        <div className="form-message" role="status">
          {state.message}
        </div>
      ) : null}
      {state.status === "duplicate_confirmation_required" ? (
        <div className="form-message" role="status">
          {state.message}
        </div>
      ) : null}

      {beforeFields}
      <DuplicateConfirmationPanel state={state} isPending={isPending} />

      {requiresMeetingChoice ? (
        <fieldset className="stack" style={{ border: "1px solid var(--line)", borderRadius: 8, padding: 12 }}>
          <legend className="nr-meta" style={{ padding: "0 6px" }}>
            {labels.chooseMeeting ?? "Choose meeting"}
          </legend>
          {state.candidates?.map((candidate) => (
            <label key={candidate.meetingId} style={{ flexDirection: "row", alignItems: "flex-start", gap: 8 }}>
              <input
                type="radio"
                name="meetingId"
                value={candidate.meetingId}
                required
                onChange={() => setSelectedMeetingChoice(candidate.meetingId)}
                style={{ width: "auto", marginTop: 3 }}
              />
              <span>{candidateLabel(candidate)}</span>
            </label>
          ))}
          <label style={{ flexDirection: "row", alignItems: "flex-start", gap: 8 }}>
            <input
              type="radio"
              name="meetingId"
              value={CREATE_NEW_MEETING_CHOICE}
              required
              onChange={() => setSelectedMeetingChoice(CREATE_NEW_MEETING_CHOICE)}
              style={{ width: "auto", marginTop: 3 }}
            />
            <span>{labels.createNewMeeting ?? "None of these - create a new meeting"}</span>
          </label>
        </fieldset>
      ) : null}

      {showTitle && showDetailFields ? (
        <label>
          {labels.title ?? "Title"}
          <input name="title" defaultValue={fieldValue(state, defaultValues, "title")} />
        </label>
      ) : null}

      {(showSource || showRecordedAt) && showDetailFields ? (
        <div className="actions-inline">
          {showSource ? (
            <label style={{ flex: 1 }}>
              {labels.source ?? "Source"}
              <input name="source" defaultValue={fieldValue(state, defaultValues, "source") || "transcript-upload"} required />
            </label>
          ) : null}
          {showRecordedAt ? (
            <label style={{ flex: 1 }}>
              {labels.recordedAt ?? "Recorded at"}
              <input
                name="recordedAt"
                type="datetime-local"
                defaultValue={fieldValue(state, defaultValues, "recordedAt")}
                required={recordedAtRequired}
                aria-required={recordedAtRequired}
              />
            </label>
          ) : null}
        </div>
      ) : null}

      {requiresRecordedAt && requiresMeetingChoice && !creatingNewMeetingFromChoice ? (
        <label>
          {labels.recordedAt ?? "Recorded at"}
          <input name="recordedAt" type="datetime-local" defaultValue={fieldValue(state, defaultValues, "recordedAt")} required />
        </label>
      ) : null}

      {showTimeZone && showDetailFields ? (
        <TimeZoneSelect value={selectedTimeZone} onValueChange={setSelectedTimeZone} />
      ) : null}

      {showParticipants && showDetailFields ? (
        <label>
          {labels.participantEmails ?? "Participant emails"}
          <input
            name="participantEmails"
            defaultValue={fieldValue(state, defaultValues, "participantEmails")}
            placeholder={labels.participantEmailsPlaceholder}
          />
        </label>
      ) : null}

      {showParticipantIds && showDetailFields ? (
        <label>
          {labels.participantIds ?? "Participant IDs"}
          <input
            name="participantIds"
            defaultValue={fieldValue(state, defaultValues, "participantIds")}
            placeholder={labels.participantIdsPlaceholder}
          />
        </label>
      ) : null}

      {(showGuidance && showDetailFields) || (showGuidance && mustRetryUpload) ? (
        <label>
          {labels.ingestionGuidance ?? "Ingestion guidance"}
          <MarkdownEditor
            name="ingestionGuidanceMd"
            rows={3}
            defaultValue={fieldValue(state, defaultValues, "ingestionGuidanceMd")}
          />
          {labels.ingestionGuidanceHelp ? (
            <span className="nr-item-meta" style={{ display: "block", marginTop: 4 }}>{labels.ingestionGuidanceHelp}</span>
          ) : null}
        </label>
      ) : null}

      {(showFile && showUploadFields) || (showFile && mustRetryUpload) ? (
        <label>
          {labels.file ?? "Transcript file"}
          <input name="file" type="file" accept=".txt,.md,.csv,.json,.pdf,.docx" />
        </label>
      ) : null}

      {(showTranscript && showUploadFields) || (showTranscript && mustRetryUpload) ? (
        <label>
          {labels.transcript ?? "Transcript"}
          <textarea
            name="transcript"
            rows={transcriptRows}
            defaultValue={fieldValue(state, defaultValues, "transcript")}
            placeholder={labels.transcriptPlaceholder}
          />
        </label>
      ) : null}

      {mustRetryUpload ? (
        <p className="nr-item-meta" style={{ margin: 0 }}>
          {labels.retryUpload ?? "Upload or paste the transcript again to continue."}
        </p>
      ) : null}

      <div className="actions-inline">
        <button type="submit" disabled={isPending}>
          {isPending ? "..." : state.status === "needs_clarification" || state.status === "duplicate_confirmation_required" ? labels.retrySubmit ?? labels.submit : labels.submit}
        </button>
        {cancelHref ? (
          <a className="button secondary" href={cancelHref}>
            {labels.cancel ?? "Cancel"}
          </a>
        ) : null}
      </div>
    </form>
  );
}
