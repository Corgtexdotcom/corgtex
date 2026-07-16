"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import type { FormEvent } from "react";

type AudioAsset = {
  id: string;
  fileName: string;
  title: string | null;
  status: "UPLOADED" | "TRANSCRIBING" | "TRANSCRIBED" | "INGESTED" | "FAILED";
  workflowJobId: string | null;
  intakeMeetingId: string | null;
  failureCode: string | null;
  failureMessage: string | null;
  createdAt: string;
  updatedAt: string;
};

type SubmitState =
  | { status: "idle" }
  | { status: "submitting" }
  | { status: "success"; message: string; asset: AudioAsset }
  | { status: "error"; message: string };

const STATUS_LABELS: Record<AudioAsset["status"], string> = {
  UPLOADED: "Queued",
  TRANSCRIBING: "Transcribing",
  TRANSCRIBED: "Transcript ready",
  INGESTED: "Meeting created",
  FAILED: "Needs attention",
};

function isAudioAsset(value: unknown): value is AudioAsset {
  return Boolean(value && typeof value === "object" && "id" in value && "status" in value);
}

function errorMessage(body: unknown, fallback: string) {
  if (body && typeof body === "object" && "error" in body) {
    const error = (body as { error?: { message?: unknown } }).error;
    if (typeof error?.message === "string") return error.message;
  }
  return fallback;
}

function statusClass(status: AudioAsset["status"]) {
  return status === "FAILED" ? "tag warning" : "tag";
}

export function MeetingAudioUploadForm({
  workspaceId,
  cancelHref,
}: {
  workspaceId: string;
  cancelHref: string;
}) {
  const formRef = useRef<HTMLFormElement | null>(null);
  const [state, setState] = useState<SubmitState>({ status: "idle" });
  const [recentAssets, setRecentAssets] = useState<AudioAsset[]>([]);
  const [isRefreshing, setIsRefreshing] = useState(false);

  const refreshAssets = useCallback(async () => {
    setIsRefreshing(true);
    try {
      const response = await fetch(`/api/workspaces/${workspaceId}/meeting-audio-assets?take=5`);
      const body = await response.json().catch(() => ({}));
      if (!response.ok || !Array.isArray(body.audioAssets)) {
        throw new Error(errorMessage(body, "Could not load audio status."));
      }
      setRecentAssets(body.audioAssets.filter(isAudioAsset));
    } catch (error) {
      setState({ status: "error", message: error instanceof Error ? error.message : "Could not load audio status." });
    } finally {
      setIsRefreshing(false);
    }
  }, [workspaceId]);

  useEffect(() => {
    void refreshAssets();
  }, [refreshAssets]);

  async function onSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const formData = new FormData(event.currentTarget);
    const file = formData.get("file");
    if (!(file instanceof File) || file.size === 0) {
      setState({ status: "error", message: "Choose an audio file first." });
      return;
    }
    if (file.type && !file.type.toLowerCase().startsWith("audio/")) {
      setState({ status: "error", message: "Choose an audio file." });
      return;
    }
    const recordedAt = formData.get("recordedAt");
    if (typeof recordedAt === "string" && recordedAt) {
      formData.set("recordedAt", new Date(recordedAt).toISOString());
    }

    setState({ status: "submitting" });
    const response = await fetch(`/api/workspaces/${workspaceId}/meeting-audio-assets`, {
      method: "POST",
      body: formData,
    });
    const body = await response.json().catch(() => ({}));
    if (!response.ok || !isAudioAsset(body.audioAsset)) {
      setState({ status: "error", message: errorMessage(body, "Audio upload failed.") });
      return;
    }

    formRef.current?.reset();
    setState({
      status: "success",
      message: "Audio uploaded. Transcription will continue in the background.",
      asset: body.audioAsset,
    });
    await refreshAssets();
  }

  return (
    <div className="stack" style={{ gap: 20, paddingBottom: 96 }}>
      <form ref={formRef} onSubmit={onSubmit} className="stack nr-form-section">
        <label>
          Audio file
          <input name="file" type="file" accept="audio/*" required />
        </label>
        <label>
          Title
          <input name="title" placeholder="Leadership offsite" />
        </label>
        <label>
          Recorded at
          <input name="recordedAt" type="datetime-local" required />
        </label>
        <label>
          Duration seconds
          <input name="durationSeconds" type="number" min={1} step={1} />
        </label>
        <label>
          Participant emails
          <input name="participantEmails" placeholder="one@example.com, two@example.com" />
        </label>
        {state.status === "error" ? (
          <p className="form-message form-message-error" role="alert">{state.message}</p>
        ) : null}
        {state.status === "success" ? (
          <div className="form-message form-message-success" role="status">
            <strong>{state.message}</strong>
            <div style={{ marginTop: 8 }}>
              <span className={statusClass(state.asset.status)}>{STATUS_LABELS[state.asset.status]}</span>
            </div>
          </div>
        ) : null}
        <div className="actions-inline">
          <button type="submit" disabled={state.status === "submitting"}>
            {state.status === "submitting" ? "Uploading..." : "Upload audio"}
          </button>
          <a className="link-button secondary" href={cancelHref}>Cancel</a>
        </div>
      </form>

      <section className="nr-form-section stack" aria-label="Recent audio uploads">
        <div className="actions-inline" style={{ justifyContent: "space-between", marginTop: 0 }}>
          <h2 className="nr-section-header" style={{ margin: 0 }}>Recent audio uploads</h2>
          <button type="button" className="secondary small" onClick={refreshAssets} disabled={isRefreshing}>
            {isRefreshing ? "Refreshing..." : "Refresh"}
          </button>
        </div>
        {recentAssets.length === 0 ? (
          <p className="nr-item-meta">No audio uploads yet.</p>
        ) : (
          recentAssets.map((asset) => (
            <div key={asset.id} style={{ borderTop: "1px solid var(--line)", paddingTop: 12 }}>
              <div className="row" style={{ justifyContent: "space-between", gap: 12, alignItems: "flex-start" }}>
                <div>
                  <strong>{asset.title || asset.fileName}</strong>
                  <div className="nr-item-meta">{new Date(asset.createdAt).toLocaleString()}</div>
                </div>
                <span className={statusClass(asset.status)}>{STATUS_LABELS[asset.status]}</span>
              </div>
              {asset.failureMessage ? (
                <p className="form-message form-message-error" style={{ marginTop: 10 }}>
                  {asset.failureCode ? `${asset.failureCode}: ` : ""}{asset.failureMessage}
                </p>
              ) : null}
              {asset.intakeMeetingId ? (
                <a className="link-button small" href={`/workspaces/${workspaceId}/meetings/${asset.intakeMeetingId}`}>
                  Open meeting
                </a>
              ) : null}
            </div>
          ))
        )}
      </section>
    </div>
  );
}
