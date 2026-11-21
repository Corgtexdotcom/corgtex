"use client";

import { useState, type FormEvent } from "react";
import { useTranslations } from "next-intl";

const RECORDS = { actions: "Action", proposals: "Proposal", tensions: "Tension", meetings: "Meeting" } as const;
const KINDS = ["Action", "Proposal", "Tension", "MeetingTranscript", "Meeting", "MeetingAgenda", "MeetingInsight", "BrainArticle"] as const;
type Kind = (typeof KINDS)[number];

function selection(value: string, workspaceId: string, kind: Kind | "") {
  if (kind && /^[a-zA-Z0-9_-]{1,191}$/.test(value.trim())) return { kind, id: value.trim() };
  const path = value.trim().replace(/^https?:\/\/[^/]+/, "").split(/[?#]/, 1)[0];
  const match = path.match(/^(?:\/[a-z]{2})?\/workspaces\/([^/]+)\/(actions|proposals|tensions|meetings)\/([a-zA-Z0-9_-]{1,191})\/?$/);
  if (!match || match[1] !== workspaceId) return null;
  const pathKind = RECORDS[match[2] as keyof typeof RECORDS];
  if (kind && kind !== pathKind && !(pathKind === "Meeting" && (kind === "MeetingTranscript" || kind === "MeetingAgenda"))) return null;
  return { kind: kind || pathKind, id: match[3] };
}

export function HistoryRecoveryForm({ workspaceId }: { workspaceId: string }) {
  const t = useTranslations("historyRecovery");
  const [value, setValue] = useState("");
  const [kind, setKind] = useState<Kind | "">("");
  const [preview, setPreview] = useState<(NonNullable<ReturnType<typeof selection>> & {
    expectedFingerprint: string; requestId: string;
  }) | null>(null);
  const [pending, setPending] = useState(false);
  const [batchPending, setBatchPending] = useState(false);
  const endpoint = `/api/workspaces/${workspaceId}/history-recovery`;
  const [status, setStatus] = useState<"invalid" | "unavailable" | "restored" | null>(null);

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (pending || batchPending) return;
    const target = selection(value, workspaceId, kind);
    setStatus(null);
    if (!target) {
      setStatus("invalid");
      return;
    }
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
    <>
    <form onSubmit={submit} className="ws-form">
      <label>
        {t("typeLabel")}
        <select value={kind} disabled={pending || batchPending} onChange={event => {
          setKind(event.target.value as Kind | "");
          setPreview(null);
          setStatus(null);
        }}>
          <option value="">{t("fromLink")}</option>
          {KINDS.map(item => <option key={item} value={item}>{t(item)}</option>)}
        </select>
      </label>
      <label>
        {kind ? t("idLabel") : t("linkLabel")}
        <input value={value} required disabled={pending || batchPending} onChange={event => {
          setValue(event.target.value);
          setPreview(null);
          setStatus(null);
        }} />
      </label>
      {preview && <p>{t("confirm")}</p>}
      <button className="primary" type="submit" disabled={pending || batchPending}>
        {t(preview ? "restore" : "inspect")}
      </button>
      {status && <p role="status">{t(status)}</p>}
    </form>
    {kind && <RecoveryCandidates key={kind} kind={kind} endpoint={endpoint} onPending={setBatchPending} disabled={pending} />}
    </>
  );
}

type Candidate = { id: string; createdAt: string };

function RecoveryCandidates({ endpoint, kind, disabled, onPending }: {
  endpoint: string; kind: Kind; disabled: boolean; onPending: (pending: boolean) => void;
}) {
  const t = useTranslations("historyRecovery");
  const [page, setPage] = useState<{ items: Candidate[]; nextCursor: string | null } | null>(null);
  const [selected, setSelected] = useState<string[]>([]);
  const [results, setResults] = useState<{ id: string; restored: boolean }[]>([]);
  const [pending, setPending] = useState(false);
  const [failed, setFailed] = useState(false);
  const [confirmed, setConfirmed] = useState(false);
  const [receipts, setReceipts] = useState<Record<string, { expectedFingerprint: string; requestId: string }>>({});

  function changePending(value: boolean) {
    setPending(value);
    onPending(value);
  }

  async function load(cursor?: string) {
    changePending(true);
    setFailed(false);
    try {
      const query = new URLSearchParams({ mode: "candidates", kind, ...(cursor ? { cursor } : {}) });
      const response = await fetch(`${endpoint}?${query}`);
      if (!response.ok) throw new Error("Candidate list unavailable");
      setPage(await response.json());
      setSelected([]);
      setResults([]);
      setConfirmed(false);
    } catch {
      setFailed(true);
    } finally {
      changePending(false);
    }
  }

  async function reviewSelection() {
    changePending(true);
    setFailed(false);
    const checked = { ...receipts };
    const unavailable: typeof results = [];
    for (const id of selected) {
      if (checked[id]) continue;
      try {
        const response = await fetch(`${endpoint}?${new URLSearchParams({ kind, id })}`);
        if (!response.ok) throw new Error("Record unavailable");
        const metadata = await response.json();
        if (typeof metadata.fingerprint !== "string") throw new Error("Missing fingerprint");
        checked[id] = { expectedFingerprint: metadata.fingerprint, requestId: crypto.randomUUID() };
      } catch {
        unavailable.push({ id, restored: false });
      }
    }
    setReceipts(checked);
    setResults(current => [...current.filter(item => !selected.includes(item.id)), ...unavailable]);
    const eligible = selected.filter(id => checked[id]);
    setSelected(eligible);
    setConfirmed(eligible.length > 0);
    changePending(false);
  }

  async function restoreSelected() {
    changePending(true);
    setFailed(false);
    const outcomes: typeof results = [];
    for (const id of selected) {
      const receipt = receipts[id];
      try {
        if (!receipt) throw new Error("Selection was not checked");
        const response = await fetch(endpoint, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ ...receipt, kind, id, consent: "RESTORE_SELECTED_HISTORY" }),
        });
        if (!response.ok) {
          const error = await response.json().catch(() => null);
          if (error?.error?.code === "RECOVERY_STALE") setReceipts(current => {
            const next = { ...current };
            delete next[id];
            return next;
          });
          throw new Error("Record unavailable");
        }
        outcomes.push({ id, restored: true });
      } catch {
        outcomes.push({ id, restored: false });
      }
      setResults(current => [...current.filter(item => !outcomes.some(outcome => outcome.id === item.id)), ...outcomes]);
    }
    setSelected(outcomes.filter(item => !item.restored).map(item => item.id));
    setConfirmed(false);
    changePending(false);
  }

  return (
    <section className="ws-section">
      <h2>{t("candidateTitle")}</h2>
      <p>{t("candidateDescription")}</p>
      <button type="button" disabled={disabled || pending} onClick={() => load()}>{t("loadCandidates")}</button>
      {page && (
        <>
          {page.items.length === 0 && <p>{t("noCandidates")}</p>}
          {page.items.length > 0 && (
            <ul>
              {page.items.map(({ id, createdAt }) => {
                const result = results.find(item => item.id === id);
                const checked = selected.includes(id);
                return (
                  <li key={id}>
                    <label>
                      <input type="checkbox" checked={checked}
                        disabled={disabled || pending || result?.restored || (!checked && selected.length >= 10)}
                        onChange={event => {
                          setSelected(current => event.target.checked ? [...current, id] : current.filter(selectedId => selectedId !== id));
                          setConfirmed(false);
                        }} />
                      <code>{id}</code> <time dateTime={createdAt}>{createdAt.slice(0, 10)}</time>
                    </label>
                    {result && <span role="status"> {t(result.restored ? "candidateRestored" : "unavailable")}</span>}
                  </li>
                );
              })}
            </ul>
          )}
          {page.nextCursor && <button type="button" disabled={disabled || pending} onClick={() => load(page.nextCursor ?? undefined)}>{t("moreCandidates")}</button>}
          {selected.length > 0 && (
            <>
              {confirmed && <p>{t("confirmSelection", { count: selected.length })}</p>}
              <button className="primary" type="button" disabled={disabled || pending}
                onClick={() => confirmed ? restoreSelected() : reviewSelection()}>
                {t(confirmed ? "restoreSelection" : "reviewSelection")}
              </button>
            </>
          )}
        </>
      )}
      {failed && <p role="status">{t("unavailable")}</p>}
    </section>
  );
}
