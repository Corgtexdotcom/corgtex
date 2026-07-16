"use client";

import { useState } from "react";
import type { BrainSourceType } from "@prisma/client";
import { MarkdownEditor } from "@/lib/components/MarkdownEditor";
import { TimeZoneSelect } from "@/lib/components/TimeZoneSelect";
import { MeetingTranscriptUploadForm } from "../meetings/MeetingTranscriptUploadForm";

type Props = {
  workspaceId: string;
  sourceTypes: BrainSourceType[];
  ingestAction: (formData: FormData) => void | Promise<void>;
  cancelHref: string;
};

function SourceTypeSelect({
  sourceTypes,
  value,
  onChange,
}: {
  sourceTypes: BrainSourceType[];
  value: BrainSourceType;
  onChange: (value: BrainSourceType) => void;
}) {
  return (
    <label style={{ flex: 1 }}>
      Source type
      <select
        name="sourceType"
        value={value}
        onChange={(event) => onChange(event.target.value as BrainSourceType)}
      >
        {sourceTypes.map((sourceType) => (
          <option key={sourceType} value={sourceType}>{sourceType}</option>
        ))}
      </select>
    </label>
  );
}

export function PasteTextForm({ workspaceId, sourceTypes, ingestAction, cancelHref }: Props) {
  const [sourceType, setSourceType] = useState<BrainSourceType>("ARTICLE");

  if (sourceType === "MEETING") {
    return (
      <MeetingTranscriptUploadForm
        workspaceId={workspaceId}
        className="stack nr-form-section"
        successHref={cancelHref}
        showTitle
        showSource
        showRecordedAt
        requireRecordedAt
        showTimeZone
        showFile={false}
        showTranscript
        showGuidance
        transcriptRows={10}
        labels={{
          title: "Title",
          source: "Channel or source",
          recordedAt: "Meeting recorded at",
          transcript: "Content",
          ingestionGuidance: "Ingestion guidance",
          submit: "Ingest text",
          retrySubmit: "Continue",
          chooseMeeting: "Choose meeting",
          createNewMeeting: "None of these - create a new meeting",
          cancel: "Cancel",
        }}
        cancelHref={cancelHref}
        beforeFields={
          <div className="actions-inline">
            <SourceTypeSelect sourceTypes={sourceTypes} value={sourceType} onChange={setSourceType} />
          </div>
        }
      />
    );
  }

  return (
    <form action={ingestAction} className="stack nr-form-section">
      <input type="hidden" name="workspaceId" value={workspaceId} />
      <label>Title<input name="title" /></label>
      <div className="actions-inline">
        <SourceTypeSelect sourceTypes={sourceTypes} value={sourceType} onChange={setSourceType} />
        <label style={{ flex: 1 }}>Channel or source<input name="channel" placeholder="text-paste" /></label>
      </div>
      <label>Content<textarea name="content" rows={10} required /></label>
      <label>Ingestion guidance<MarkdownEditor name="ingestionGuidanceMd" rows={3} /></label>
      <div className="actions-inline">
        <button type="submit">Ingest text</button>
        <a className="button secondary" href={cancelHref}>Cancel</a>
      </div>
    </form>
  );
}
