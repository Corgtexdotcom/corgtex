"use client";

import { useState } from "react";
import { Dialog } from "./Dialog";
import { MarkdownEditor } from "./MarkdownEditor";

type Option = {
  value: string;
  label: string;
};

export function WorkItemResolutionDialog({
  action,
  buttonLabel,
  title,
  noteName,
  noteLabel,
  notePlaceholder,
  hiddenFields,
  outcomeName,
  outcomeLabel,
  outcomeOptions,
  submitLabel,
  cancelLabel,
  fileLabel,
  className = "secondary small",
}: {
  action: (formData: FormData) => void | Promise<void>;
  buttonLabel: string;
  title: string;
  noteName: string;
  noteLabel: string;
  notePlaceholder: string;
  hiddenFields: Record<string, string>;
  outcomeName?: string;
  outcomeLabel?: string;
  outcomeOptions?: Option[];
  submitLabel: string;
  cancelLabel: string;
  fileLabel: string;
  className?: string;
}) {
  const [open, setOpen] = useState(false);

  return (
    <>
      <button type="button" className={className} onClick={() => setOpen(true)}>
        {buttonLabel}
      </button>
      <Dialog open={open} onClose={() => setOpen(false)} title={title}>
        <form action={action} className="stack nr-form-section" onSubmit={() => setOpen(false)}>
          {Object.entries(hiddenFields).map(([name, value]) => (
            <input key={name} type="hidden" name={name} value={value} />
          ))}
          {outcomeName && outcomeOptions && outcomeOptions.length > 0 && (
            <label>
              {outcomeLabel}
              <select name={outcomeName} defaultValue={outcomeOptions[0].value} required>
                {outcomeOptions.map((option) => (
                  <option key={option.value} value={option.value}>
                    {option.label}
                  </option>
                ))}
              </select>
            </label>
          )}
          <label>
            {noteLabel}
            <MarkdownEditor name={noteName} placeholder={notePlaceholder} required rows={5} />
          </label>
          <label>
            {fileLabel}
            <input name="evidenceFile" type="file" accept=".txt,.md,.csv,.json,.pdf,.docx,.png,.jpg,.jpeg,.webp" />
          </label>
          <div className="actions-inline">
            <button type="submit">{submitLabel}</button>
            <button type="button" className="secondary" onClick={() => setOpen(false)}>
              {cancelLabel}
            </button>
          </div>
        </form>
      </Dialog>
    </>
  );
}
