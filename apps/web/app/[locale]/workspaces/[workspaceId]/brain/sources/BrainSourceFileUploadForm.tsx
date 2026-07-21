"use client";

import React, { useState } from "react";
import { useRouter } from "next/navigation";
import {
  DuplicateGuardConfirmationPanel,
  type DuplicateGuardFormState,
} from "../../add/DuplicateGuardForm";

type BrainSourceFileUploadFormProps = {
  workspaceId: string;
  labels: {
    fileToIngest: string;
    labelTitle: string;
    placeholderSourceTitle: string;
    uploadAndMap: string;
  };
};

function responseMessage(payload: unknown, fallback: string) {
  if (typeof payload === "object" && payload !== null && "error" in payload) {
    const error = (payload as { error?: { message?: unknown } }).error;
    if (typeof error?.message === "string" && error.message.trim()) return error.message;
  }
  return fallback;
}

export function BrainSourceFileUploadForm({ workspaceId, labels }: BrainSourceFileUploadFormProps) {
  const router = useRouter();
  const [state, setState] = useState<DuplicateGuardFormState>(null);
  const [error, setError] = useState<string | null>(null);
  const [isPending, setIsPending] = useState(false);

  async function onSubmit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setError(null);
    setIsPending(true);

    const form = event.currentTarget;
    const formData = new FormData(form);
    const submitter = (event.nativeEvent as SubmitEvent).submitter;
    if (submitter instanceof HTMLButtonElement && submitter.name) {
      formData.set(submitter.name, submitter.value);
    }

    try {
      const response = await fetch(`/api/workspaces/${workspaceId}/brain/sources/upload`, {
        method: "POST",
        headers: {
          Accept: "application/json",
        },
        body: formData,
      });
      const contentType = response.headers.get("content-type") ?? "";
      const payload = contentType.includes("application/json") ? await response.json() as unknown : null;

      if (
        typeof payload === "object"
        && payload !== null
        && "status" in payload
        && (payload as { status?: unknown }).status === "duplicate_confirmation_required"
      ) {
        setState(payload as DuplicateGuardFormState);
        return;
      }

      if (!response.ok) {
        setError(responseMessage(payload, "Upload failed."));
        return;
      }

      form.reset();
      setState(null);
      router.refresh();
    } catch {
      setError("Upload failed.");
    } finally {
      setIsPending(false);
    }
  }

  return (
    <form onSubmit={onSubmit} encType="multipart/form-data" className="stack panel">
      <input type="hidden" name="workspaceId" value={workspaceId} />
      <DuplicateGuardConfirmationPanel state={state} isPending={isPending} />
      {error && <p className="error">{error}</p>}
      <label>
        {labels.fileToIngest}
        <input type="file" name="file" required />
      </label>
      <label>
        {labels.labelTitle}
        <input name="title" placeholder={labels.placeholderSourceTitle} />
      </label>
      <button type="submit" disabled={isPending}>{labels.uploadAndMap}</button>
    </form>
  );
}
