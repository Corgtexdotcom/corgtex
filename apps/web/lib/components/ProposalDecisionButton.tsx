"use client";

import { useState, useTransition } from "react";

export function ProposalDecisionButton({
  action,
  workspaceId,
  flowId,
  choice,
  label,
  selected,
  className,
  errorLabel,
}: {
  action: (formData: FormData) => Promise<void>;
  workspaceId: string;
  flowId: string;
  choice: string;
  label: string;
  selected: boolean;
  className: string;
  errorLabel: string;
}) {
  const [pending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);
  const submit = () => {
    setError(null);
    const formData = new FormData();
    formData.set("workspaceId", workspaceId);
    formData.set("flowId", flowId);
    formData.set("choice", choice);
    startTransition(async () => {
      try {
        await action(formData);
      } catch {
        setError(errorLabel);
      }
    });
  };

  return (
    <span>
      <button type="button" className={selected ? "primary small" : className} disabled={pending} onClick={submit}>
        {label}
      </button>
      {error && <span role="alert" className="form-message form-message-error">{error}</span>}
    </span>
  );
}
