"use client";

import { type ChangeEvent, type DragEvent, type FormEvent, useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  buildFinanceImportView,
  financeImportCanRetryExactFile,
  financeImportNeedsPolling,
  numericFormatLabel,
  supportsFinanceReportFile,
  type FinanceImportBatchSummary,
  type FinanceImportDetail,
} from "./financeReportImportView";

type UploadItem = { id: string; name: string; status: "queued" | "uploading" | "uploaded" | "failed"; message: string | null };

function displayEnum(value: string | null) {
  return value ? value.toLowerCase().replaceAll("_", " ").replace(/\b\w/g, (character) => character.toUpperCase()) : null;
}

function displayDate(value: string | null) {
  if (!value) return null;
  return new Intl.DateTimeFormat(undefined, { dateStyle: "medium", timeZone: "UTC" }).format(new Date(value));
}

function periodLabel(batch: FinanceImportBatchSummary) {
  const start = displayDate(batch.periodStart), end = displayDate(batch.periodEnd);
  return start && end ? `${start} – ${end}` : start ?? end;
}

async function responseMessage(response: Response, fallback: string) {
  const body = await response.json().catch(() => null) as { error?: { message?: string } | string } | null;
  return typeof body?.error === "string" ? body.error : body?.error?.message ?? fallback;
}

async function requestFinanceImportDetail(workspaceId: string, batchId: string) {
  const response = await fetch(`/api/workspaces/${workspaceId}/finance/imports/${batchId}`, { cache: "no-store" });
  if (!response.ok) throw new Error(await responseMessage(response, "Import details could not be loaded."));
  return (await response.json() as { batch: FinanceImportDetail }).batch;
}

async function requestFinanceImportSummary(workspaceId: string, batchId: string) {
  const response = await fetch(`/api/workspaces/${workspaceId}/finance/imports/${batchId}?view=summary`, { cache: "no-store" });
  if (!response.ok) throw new Error(await responseMessage(response, "Import status could not be loaded."));
  return (await response.json() as { batch: FinanceImportBatchSummary }).batch;
}

export function FinanceReportImportPanel({ workspaceId, canWrite }: { workspaceId: string; canWrite: boolean }) {
  const inputRef = useRef<HTMLInputElement>(null);
  const uploadAttemptRef = useRef(0);
  const detailRequestRef = useRef(new Map<string, number>());
  const summaryRequestRef = useRef(new Map<string, number>());
  const pinnedBatchesRef = useRef(new Map<string, FinanceImportBatchSummary | null>());
  const [batches, setBatches] = useState<FinanceImportBatchSummary[]>([]);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [detail, setDetail] = useState<FinanceImportDetail | null>(null);
  const [uploads, setUploads] = useState<UploadItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [listError, setListError] = useState<string | null>(null);
  const [detailError, setDetailError] = useState<string | null>(null);
  const [currency, setCurrency] = useState("");
  const [clarifyingBatchId, setClarifyingBatchId] = useState<string | null>(null);
  const selected = useMemo(() => batches.find(({ id }) => id === selectedId) ?? null, [batches, selectedId]);
  const selectedVersion = selected?.version;
  const needsClarificationDetail = selected?.stage === "NEEDS_INPUT" && selected.safeErrorCode === "CURRENCY_UNRESOLVED"
    && selected.currencyState === "UNRESOLVED";
  const selectedIdRef = useRef(selectedId); selectedIdRef.current = selectedId;

  const loadBatches = useCallback(async () => {
    try {
      const response = await fetch(`/api/workspaces/${workspaceId}/finance/imports`, { cache: "no-store" });
      if (!response.ok) throw new Error(await responseMessage(response, "Import history could not be loaded."));
      const body = await response.json() as { batches: FinanceImportBatchSummary[] };
      body.batches.forEach(({ id }) => pinnedBatchesRef.current.delete(id));
      const pinned = [...pinnedBatchesRef.current.values()].filter((batch): batch is FinanceImportBatchSummary => batch !== null);
      const merged = [...pinned, ...body.batches];
      setBatches(merged);
      setSelectedId((current) => current && (merged.some(({ id }) => id === current) || pinnedBatchesRef.current.has(current))
        ? current : merged[0]?.id ?? null);
      setListError(null);
    } catch (error) {
      setListError(error instanceof Error ? error.message : "Import history could not be loaded.");
    } finally {
      setLoading(false);
    }
  }, [workspaceId]);

  const loadDetail = useCallback(async (batchId: string) => {
    const requestId = (detailRequestRef.current.get(batchId) ?? 0) + 1; detailRequestRef.current.set(batchId, requestId);
    try {
      const batch = await requestFinanceImportDetail(workspaceId, batchId);
      if (requestId !== detailRequestRef.current.get(batchId)) return;
      if (selectedIdRef.current !== batchId) return;
      setDetail(batch);
      setCurrency(batch.resolvedCurrency ?? "");
      setDetailError(null);
    } catch (error) {
      if (requestId !== detailRequestRef.current.get(batchId) || selectedIdRef.current !== batchId) return;
      setDetail(null);
      setDetailError(error instanceof Error ? error.message : "Import details could not be loaded.");
    }
  }, [workspaceId]);

  const loadPinnedSummary = useCallback(async (batchId: string) => {
    const requestId = (summaryRequestRef.current.get(batchId) ?? 0) + 1; summaryRequestRef.current.set(batchId, requestId);
    try {
      const batch = await requestFinanceImportSummary(workspaceId, batchId);
      if (requestId !== summaryRequestRef.current.get(batchId) || !pinnedBatchesRef.current.has(batchId)) return;
      pinnedBatchesRef.current.set(batchId, batch);
      setBatches((current) => [batch, ...current.filter(({ id }) => id !== batch.id)]);
    } catch {
      // Keep the pinned ID so a transient summary failure is retried without losing an exact-file resume.
    }
  }, [workspaceId]);

  useEffect(() => { void loadBatches(); }, [loadBatches]);
  useEffect(() => {
    if (!selectedId || !needsClarificationDetail) { setDetail(null); setDetailError(null); return; }
    setDetail(null); setDetailError(null);
    void loadDetail(selectedId);
  }, [loadDetail, needsClarificationDetail, selectedId, selectedVersion]);
  useEffect(() => {
    const pinnedNeedsPolling = [...pinnedBatchesRef.current.entries()].some(([, batch]) => batch === null || financeImportNeedsPolling([batch]));
    if (!financeImportNeedsPolling(batches) && !pinnedNeedsPolling) return;
    const timer = window.setInterval(() => {
      void loadBatches();
      pinnedBatchesRef.current.forEach((batch, id) => { if (batch === null || financeImportNeedsPolling([batch])) void loadPinnedSummary(id); });
    }, 4_000);
    return () => window.clearInterval(timer);
  }, [batches, loadBatches, loadPinnedSummary]);

  const selectedDetail = detail?.id === selectedId ? detail : null;
  const processingView = selected ? buildFinanceImportView(selected) : null;
  const agentUnavailable = selected?.safeErrorCode === "FINANCE_REPORT_AGENT_UNAVAILABLE";

  async function uploadFiles(files: File[]) {
    if (!canWrite || files.length === 0) return;
    const items = files.map((file): UploadItem => ({ id: `${file.name}:${file.size}:${file.lastModified}:${++uploadAttemptRef.current}`, name: file.name,
      status: supportsFinanceReportFile(file.name) ? "queued" : "failed", message: supportsFinanceReportFile(file.name) ? null : "Only PDF, CSV, and XLSX reports are supported." }));
    setUploads((current) => [...items, ...current]);
    for (const [index, file] of files.entries()) {
      const item = items[index]!;
      if (item.status === "failed") continue;
      setUploads((current) => current.map((row) => row.id === item.id ? { ...row, status: "uploading", message: "Uploading securely…" } : row));
      const formData = new FormData(); formData.set("file", file);
      try {
        const response = await fetch(`/api/workspaces/${workspaceId}/finance/imports`, { method: "POST", body: formData });
        if (!response.ok) throw new Error(await responseMessage(response, "The report could not be uploaded."));
        const body = await response.json() as { batch: { id: string }; reused: boolean };
        setUploads((current) => current.map((row) => row.id === item.id ? { ...row, status: "uploaded",
          message: body.reused ? "Existing exact-file import resumed or reopened." : "Queued as an independent report." } : row));
        pinnedBatchesRef.current.set(body.batch.id, null);
        selectedIdRef.current = body.batch.id; setSelectedId(body.batch.id);
        try {
          const uploadedSummary = await requestFinanceImportSummary(workspaceId, body.batch.id);
          summaryRequestRef.current.set(uploadedSummary.id, (summaryRequestRef.current.get(uploadedSummary.id) ?? 0) + 1);
          pinnedBatchesRef.current.set(uploadedSummary.id, uploadedSummary);
          setBatches((current) => [uploadedSummary, ...current.filter(({ id }) => id !== uploadedSummary.id)]);
        } catch (error) {
          setDetailError(error instanceof Error ? error.message : "Import status could not be loaded.");
        }
      } catch (error) {
        setUploads((current) => current.map((row) => row.id === item.id ? { ...row, status: "failed",
          message: error instanceof Error ? error.message : "The report could not be uploaded." } : row));
      }
      await loadBatches();
    }
    if (inputRef.current) inputRef.current.value = "";
  }

  function onFilesChanged(event: ChangeEvent<HTMLInputElement>) {
    void uploadFiles(Array.from(event.target.files ?? []));
  }

  function onDrop(event: DragEvent<HTMLDivElement>) {
    event.preventDefault();
    void uploadFiles(Array.from(event.dataTransfer.files));
  }

  async function confirmClarification(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!selectedDetail?.clarification.canConfirm || selectedDetail.clarification.numericFormat.amountScale === null) return;
    const submittedBatchId = selectedDetail.id;
    setClarifyingBatchId(submittedBatchId); setDetailError(null);
    try {
      const response = await fetch(`/api/workspaces/${workspaceId}/finance/imports/${selectedDetail.id}`, {
        method: "PATCH", headers: { "content-type": "application/json" },
        body: JSON.stringify({ operation: "CLARIFY", expectedVersion: selectedDetail.version,
          candidateVersions: selectedDetail.candidates.map(({ id, version }) => ({ id, expectedVersion: version })),
          confirmedCurrency: currency, confirmedAmountScale: selectedDetail.clarification.numericFormat.amountScale }),
      });
      if (!response.ok) throw new Error(await responseMessage(response, "The report settings could not be confirmed."));
      await loadBatches();
      if (selectedIdRef.current === submittedBatchId) await loadDetail(submittedBatchId);
    } catch (error) {
      if (selectedIdRef.current === submittedBatchId) setDetailError(error instanceof Error ? error.message : "The report settings could not be confirmed.");
    } finally {
      setClarifyingBatchId((current) => current === submittedBatchId ? null : current);
    }
  }

  return (
    <section className="finance-import-shell" aria-labelledby="finance-import-title">
      <div className="finance-import-heading">
        <div><p className="nr-page-eyebrow">Reported Actuals</p><h2 className="nr-upload-title" id="finance-import-title">Import financial reports</h2>
          <p className="nr-upload-desc muted">Upload source reports. The agent proposes report facts; only Finance writers can confirm or apply them.</p></div>
        <button type="button" className="secondary small" onClick={() => { void loadBatches(); if (selectedId && needsClarificationDetail) void loadDetail(selectedId); }} disabled={loading}>Refresh</button>
      </div>

      {canWrite ? (
        <div className="nr-upload-area finance-import-dropzone" onDragOver={(event) => event.preventDefault()} onDrop={onDrop}>
          <input ref={inputRef} className="sr-only" type="file" multiple accept=".pdf,.csv,.xlsx" onChange={onFilesChanged} />
          <strong>Drop PDF, CSV, or XLSX reports here</strong>
          <span>Each file becomes its own governed import. Maximum 25 MB per file.</span>
          <button type="button" className="primary" onClick={() => inputRef.current?.click()}>Choose reports</button>
        </div>
      ) : <div className="finance-import-notice"><strong>Finance write access required</strong><span>You can follow import history, but only a Finance writer can upload or confirm reports.</span></div>}

      {uploads.length > 0 && <div className="finance-import-upload-queue" aria-label="Current upload queue">
        {uploads.map((item) => <div className="finance-import-upload-row" key={item.id}><span><strong>{item.name}</strong>{item.message && <small>{item.message}</small>}</span>
          <span className={`status-chip ${item.status === "failed" ? "warning" : ""}`}>{displayEnum(item.status)}</span></div>)}
      </div>}

      <div className="finance-import-grid">
        <div className="finance-import-batches">
          <div className="finance-import-section-title"><h3 className="nr-upload-title">Report queue</h3><span className="status-chip">{batches.length}</span></div>
          {listError && <p className="finance-import-error" role="alert">{listError}</p>}
          {!loading && batches.length === 0 && !listError && <p className="muted">No reports imported yet.</p>}
          {batches.map((batch) => {
            const view = buildFinanceImportView(batch), period = periodLabel(batch);
            return <button type="button" className={`finance-import-batch ${batch.id === selectedId ? "selected" : ""}`} key={batch.id} onClick={() => setSelectedId(batch.id)}>
              <span className="finance-import-batch-main"><strong>{batch.originalFilename}</strong><small>{[displayEnum(batch.reportType), period, batch.resolvedCurrency].filter(Boolean).join(" · ") || "Classification pending"}</small></span>
              <span className={`status-chip ${["FAILED", "NEEDS_INPUT", "PARTIALLY_APPLIED"].includes(batch.stage) ? "warning" : ""}`}>{view.title}</span>
            </button>;
          })}
        </div>

        <div className="finance-import-detail">
          {!selected && <p className="muted">Select a report to see its processing stages.</p>}
          {selected && processingView && <>
            <div className="finance-import-detail-heading"><div><h3 className="nr-upload-title">{selected.originalFilename}</h3><p className="nr-upload-desc">{[displayEnum(selected.reportType), displayEnum(selected.basis), displayEnum(selected.cadence)].filter(Boolean).join(" · ") || "Agent classification pending"}</p></div>
              <span className={`status-chip ${processingView.className === "failed" || processingView.className === "needs-input" ? "warning" : ""}`}>{processingView.title}</span></div>
            <details className={`finance-import-processing ${processingView.className}`} open={processingView.defaultExpanded ? true : undefined}>
              <summary><span><strong>{processingView.title}</strong><small>{processingView.summary}</small></span><span className="finance-import-toggle">Show stages</span></summary>
              <ol>{processingView.steps.map((step) => <li className={step.status} key={step.stage}><span aria-hidden="true" /><div><strong>{step.label}</strong><small>{displayEnum(step.status)}</small></div></li>)}</ol>
              {(selectedDetail?.safeErrorMessage ?? selected.safeErrorMessage) && <p className="finance-import-safe-error" role="status">{selectedDetail?.safeErrorMessage ?? selected.safeErrorMessage}</p>}
              {selected.stage === "FAILED" && <p className="muted">{financeImportCanRetryExactFile(selected.safeErrorCode)
                ? "Choose the exact file above again. Its immutable hash is reused, and only supported storage or extraction stages resume."
                : "Correct the source issue described above, then upload the corrected report as a new file."}</p>}
            </details>
            {detailError && <p className="finance-import-error" role="alert">{detailError}</p>}
            {selected.stage === "NEEDS_INPUT" && selectedDetail?.clarification.canConfirm && canWrite && <form className="finance-import-clarification" onSubmit={confirmClarification}>
              <div><h4 className="nr-upload-title">Confirm report settings</h4><p className="nr-upload-desc">Currency was unresolved. The numeric format and scale below were already proven from exact source values.</p></div>
              <label><span>Report currency</span><input value={currency} onChange={(event) => setCurrency(event.target.value.toUpperCase())} required minLength={3} maxLength={3} pattern="[A-Za-z]{3}" placeholder="EUR" autoComplete="off" /></label>
              <div className="finance-import-format"><span>Detected numeric format</span><strong>{numericFormatLabel(selectedDetail.clarification.numericFormat)}</strong></div>
              <button type="submit" className="primary" disabled={clarifyingBatchId === selectedDetail.id}>{clarifyingBatchId === selectedDetail.id ? "Confirming…" : "Confirm and reconcile"}</button>
            </form>}
            {selected.stage === "NEEDS_INPUT" && (!selectedDetail?.clarification.canConfirm || !canWrite) && <div className="finance-import-notice warning"><strong>{!canWrite ? "Finance write access required" : agentUnavailable ? "Import agent unavailable" : "Structural blocker"}</strong>
              <span>{!canWrite ? "A Finance writer must resolve this report." : agentUnavailable
                ? selected.safeErrorMessage ?? "Ask a workspace administrator to enable the Finance report import agent."
                : "The numeric format, scale, or source structure could not be proven. This cannot be overridden; upload a corrected report."}</span></div>}
            {selected.stage === "READY_FOR_REVIEW" && <div className="finance-import-notice"><strong>Proposal ready</strong><span>Review and application stay separate from processing. The changes-first review surface is delivered in R9.</span></div>}
          </>}
        </div>
      </div>
    </section>
  );
}
