"use client";

import { useState } from "react";
import { Dialog } from "@/lib/components/Dialog";

type MeetingArchiveDialogLabels = {
  button: string;
  title: string;
  reason: string;
  reasonPlaceholder: string;
  submit: string;
  cancel: string;
};

export function MeetingArchiveDialog({
  action,
  workspaceId,
  meetingId,
  labels,
  className = "danger",
}: {
  action: (formData: FormData) => void | Promise<void>;
  workspaceId: string;
  meetingId: string;
  labels: MeetingArchiveDialogLabels;
  className?: string;
}) {
  const [open, setOpen] = useState(false);

  return (
    <>
      <button type="button" className={className} onClick={() => setOpen(true)}>
        {labels.button}
      </button>
      <Dialog open={open} onClose={() => setOpen(false)} title={labels.title}>
        <form action={action} className="stack nr-form-section" onSubmit={() => setOpen(false)}>
          <input type="hidden" name="workspaceId" value={workspaceId} />
          <input type="hidden" name="meetingId" value={meetingId} />
          <label>
            {labels.reason}
            <textarea name="archiveReason" placeholder={labels.reasonPlaceholder} required rows={4} />
          </label>
          <div className="actions-inline">
            <button type="submit" className="danger">{labels.submit}</button>
            <button type="button" className="secondary" onClick={() => setOpen(false)}>
              {labels.cancel}
            </button>
          </div>
        </form>
      </Dialog>
    </>
  );
}
