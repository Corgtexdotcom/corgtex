"use client";

import { useState, type FormEvent } from "react";
import { useTranslations } from "next-intl";

const RECORDS = { actions: "Action", proposals: "Proposal", tensions: "Tension" } as const;

function selection(value: string, workspaceId: string) {
  const path = value.trim().replace(/^https?:\/\/[^/]+/, "").split(/[?#]/, 1)[0];
  const match = path.match(/^(?:\/[a-z]{2})?\/workspaces\/([^/]+)\/(actions|proposals|tensions)\/([a-zA-Z0-9_-]{1,191})\/?$/);
  if (!match || match[1] !== workspaceId) return null;
  return { kind: RECORDS[match[2] as keyof typeof RECORDS], id: match[3] };
}

export function HistoryRecoveryForm({ workspaceId }: { workspaceId: string }) {
  const t = useTranslations("historyRecovery");
  const [value, setValue] = useState("");
  const [preview, setPreview] = useState<(NonNullable<ReturnType<typeof selection>> & {
    expectedFingerprint: string; requestId: string;
  }) | null>(null);
  const [pending, setPending] = useState(false);
  const [status, setStatus] = useState<"invalid" | "unavailable" | "restored" | null>(null);

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (pending) return;
    const target = selection(value, workspaceId);
    setStatus(null);
    if (!target) {
      setStatus("invalid");
      return;
    }
    const endpoint = `/api/workspaces/${workspaceId}/history-recovery`;
    setPending(true);
    try {
      if (preview) {
        const response = await fetch(endpoint, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ ...preview, consent: "RESTORE_SELECTED_HISTORY" }),
        });
        if (!response.ok) {
          const error = await response.json().catch(() => null);
          if (error?.error?.code === "RECOVERY_STALE") setPreview(null);
          throw new Error("Recovery failed");
        }
        setPreview(null);
        setValue("");
        setStatus("restored");
      } else {
        const query = new URLSearchParams(target);
        const response = await fetch(`${endpoint}?${query}`);
        if (!response.ok) throw new Error("Record unavailable");
        const item = await response.json();
        if (typeof item.fingerprint !== "string") throw new Error("Missing fingerprint");
        setPreview({ ...target, expectedFingerprint: item.fingerprint, requestId: crypto.randomUUID() });
      }
    } catch {
      setStatus("unavailable");
    } finally {
      setPending(false);
    }
  }

  return (
    <form onSubmit={submit} className="ws-form">
      <label>
        {t("linkLabel")}
        <input value={value} required disabled={pending} onChange={event => {
          setValue(event.target.value);
          setPreview(null);
          setStatus(null);
        }} />
      </label>
      {preview && <p>{t("confirm")}</p>}
      <button className="primary" type="submit" disabled={pending}>
        {t(preview ? "restore" : "inspect")}
      </button>
      {status && <p role="status">{t(status)}</p>}
    </form>
  );
}
