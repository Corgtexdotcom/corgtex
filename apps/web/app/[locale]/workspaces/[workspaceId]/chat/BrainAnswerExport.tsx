"use client";
import { useId, useRef, useState } from "react";
import { useTranslations } from "next-intl";
type Turn = { id: string; sequenceNumber: number; userMessage: string; assistantMessage: string };
const TRANSCRIPT_TURN_LIMIT = 100;
async function hash(value: unknown) {
  const bytes = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(JSON.stringify(value)));
  return Array.from(new Uint8Array(bytes), byte => byte.toString(16).padStart(2, "0")).join("");
}
export function BrainAnswerExport({ workspaceId, conversationId, output, turns }: {
  workspaceId: string; conversationId: string; output: Turn; turns: Turn[];
}) {
  const t = useTranslations("chat.brainExport"), id = useId();
  const requestIds = useRef(new Map<string, string>());
  const [mode, setMode] = useState<"NONE" | "PARTIAL" | "FULL">("NONE");
  const [title, setTitle] = useState(output.assistantMessage.split("\n")[0].replace(/^#+\s*/, "").slice(0, 100));
  const [selected, setSelected] = useState<string[]>([]);
  const [busy, setBusy] = useState(false), [saved, setSaved] = useState(false), [error, setError] = useState<string | null>(null);
  const persistedTurns = turns.filter(turn => !turn.id.startsWith("pending-"));
  const selectedCount = persistedTurns.filter(turn => selected.includes(turn.id)).length;
  const fullAvailable = persistedTurns.length <= TRANSCRIPT_TURN_LIMIT;
  if (output.id.startsWith("pending-") || !output.assistantMessage) return null;
  return <details className="mt-3 rounded border p-3">
    <summary className="cursor-pointer text-sm font-medium">{t("open")}</summary>
    <form className="mt-3 space-y-3" onSubmit={async event => {
      event.preventDefault(); setBusy(true); setError(null);
      try {
        const chosen = mode === "NONE" ? [] : persistedTurns.filter(turn => mode === "FULL" || selected.includes(turn.id));
        if (chosen.length > TRANSCRIPT_TURN_LIMIT) throw new Error(t("fullUnavailable", {limit: TRANSCRIPT_TURN_LIMIT}));
        const submission = { outputTurnId: output.id,
          expectedOutputHash: await hash(output.assistantMessage), title: title.trim(), transcriptMode: mode,
          selectedTurns: await Promise.all(chosen.map(async turn => ({ id: turn.id, hash: await hash([turn.id, turn.userMessage, turn.assistantMessage]) }))),
        };
        // A failed response can follow a committed export. Reuse the exact
        // choice's key, including when returning to an earlier pending choice.
        const choice = JSON.stringify(submission);
        let requestId = requestIds.current.get(choice);
        if (!requestId) { requestId = crypto.randomUUID(); requestIds.current.set(choice, requestId); }
        const response = await fetch(`/api/workspaces/${workspaceId}/conversations/${conversationId}/brain`, { method: "POST",
          headers: { "Content-Type": "application/json" }, body: JSON.stringify({ ...submission, requestId }) });
        if (!response.ok) { const body = await response.json(); throw new Error(body.error?.message || body.message || t("failed")); }
        setSaved(true);
      } catch (caught) { setError(caught instanceof Error ? caught.message : t("failed")); }
      finally { setBusy(false); }
    }}>
      <p className="text-sm">{t("explanation")}</p>
      <label className="block text-sm" htmlFor={`${id}-title`}>{t("title")}</label>
      <input className="w-full rounded border p-2" id={`${id}-title`} value={title} maxLength={200} required disabled={busy || saved} onChange={event => setTitle(event.target.value)} />
      <label className="block text-sm" htmlFor={`${id}-mode`}>{t("transcript")}</label>
      <select className="w-full rounded border p-2" id={`${id}-mode`} value={mode} disabled={busy || saved} onChange={event => setMode(event.target.value as typeof mode)}>
        <option value="NONE">{t("none")}</option><option value="PARTIAL">{t("partial")}</option><option value="FULL" disabled={!fullAvailable}>{t("full")}</option>
      </select>
      {!fullAvailable && <p className="text-sm">{t("fullUnavailable", {limit: TRANSCRIPT_TURN_LIMIT})}</p>}
      {mode === "PARTIAL" && <fieldset className="max-h-60 space-y-2 overflow-y-auto"><legend className="text-sm">{t("chooseTurns")}</legend>
        <p className="text-sm">{t("selectionLimit", {limit: TRANSCRIPT_TURN_LIMIT, count: selectedCount})}</p>
        {persistedTurns.map(turn => <label key={turn.id} className="flex flex-row items-start gap-2 text-sm">
          <input type="checkbox" className="mt-1 h-4 w-4 shrink-0 p-0" disabled={busy || saved || (selectedCount >= TRANSCRIPT_TURN_LIMIT && !selected.includes(turn.id))} checked={selected.includes(turn.id)} onChange={event => {
            const checked = event.target.checked;
            setSelected(previous => {
              const current = previous.filter(key => persistedTurns.some(candidate => candidate.id === key));
              return checked ? current.length < TRANSCRIPT_TURN_LIMIT && !current.includes(turn.id) ? [...current, turn.id] : current : current.filter(key => key !== turn.id);
            });
          }} />
          <span>{turn.sequenceNumber}. {turn.userMessage.slice(0, 180)}</span>
        </label>)}
      </fieldset>}
      {mode !== "NONE" && <p className="text-sm">{t("includesPrompts")}</p>}
      <button className="btn btn-primary" type="submit" disabled={busy || saved || (mode === "FULL" && !fullAvailable) || (mode === "PARTIAL" && !selectedCount)}>{saved ? t("saved") : busy ? t("saving") : t("confirm")}</button>
      {error && <p role="alert" className="text-sm text-red-700">{error}</p>}
      {saved && <p role="status" className="text-sm">{t("success")}</p>}
    </form>
  </details>;
}
