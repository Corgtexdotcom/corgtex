"use client";

import { type FormEvent, useMemo, useState } from "react";
import {
  financeDerivedTotal,
  financeImportCandidateVersions,
  financeImportVisibleCandidates,
  parseFinanceAccountPath,
  parseFinanceAmountInput,
  type FinanceImportCandidateDetail,
  type FinanceImportDetail,
} from "./financeReportImportView";

type Props = { workspaceId: string; canWrite: boolean; detail: FinanceImportDetail; onChanged: () => Promise<FinanceImportDetail | null> };

async function responseMessage(response: Response, fallback: string) {
  const body = await response.json().catch(() => null) as { error?: { message?: string } | string } | null;
  return typeof body?.error === "string" ? body.error : body?.error?.message ?? fallback;
}

function money(cents: number | null, currency: string | null) {
  if (cents === null) return "—";
  return new Intl.NumberFormat(undefined, { style: "currency", currency: currency ?? "XXX" }).format(cents / 100);
}

function date(value: string | null) {
  return value ? new Intl.DateTimeFormat(undefined, { dateStyle: "medium", timeZone: "UTC" }).format(new Date(value)) : "—";
}

function label(value: string) {
  return value.toLowerCase().replaceAll("_", " ").replace(/\b\w/g, (character) => character.toUpperCase());
}

function CandidateRow({ candidate, detail, canWrite, busy, onPatch }: { candidate: FinanceImportCandidateDetail; detail: FinanceImportDetail;
  canWrite: boolean; busy: boolean; onPatch: (body: object, fallback: string) => Promise<void> }) {
  const derived = financeDerivedTotal(candidate, detail.candidates);
  const proposed = derived ?? candidate.amountCents;
  const difference = candidate.currentAmountCents === null ? null : proposed - candidate.currentAmountCents;
  const immutable = ["REJECTED", "APPLIED"].includes(candidate.reviewState);
  const canEdit = canWrite && candidate.factKind === "LEAF" && !immutable && detail.stage !== "APPLIED";
  const canReview = canWrite && !immutable && detail.stage !== "APPLIED";

  async function edit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = new FormData(event.currentTarget), path = parseFinanceAccountPath(String(form.get("path") ?? ""));
    const amountCents = parseFinanceAmountInput(String(form.get("amount") ?? ""));
    if (!path || amountCents === null) {
      await onPatch({ invalid: true }, "Enter a valid account path and amount with no more than two decimals."); return;
    }
    await onPatch({ operation: "EDIT", candidateId: candidate.id, expectedVersion: detail.version,
      expectedCandidateVersion: candidate.version, proposedAccountPath: path, amountCents,
      periodStart: String(form.get("periodStart") ?? ""), periodEnd: String(form.get("periodEnd") ?? "") }, "The proposal could not be edited.");
  }

  async function review(operation: "APPROVE" | "REJECT") {
    const warned = candidate.reviewState === "WARNING" || candidate.historicalWarning;
    if (operation === "APPROVE" && warned && !window.confirm("Approve this warning after reviewing its evidence and historical policy?")) return;
    await onPatch({ operation, candidateId: candidate.id, expectedVersion: detail.version,
      candidateVersions: [{ id: candidate.id, expectedVersion: candidate.version }], acceptWarnings: warned || undefined },
    operation === "APPROVE" ? "The proposal could not be approved." : "The proposal could not be rejected.");
  }

  return <article className={`finance-import-review-row ${candidate.reviewState.toLowerCase()}`}>
    <div className="finance-import-review-main">
      <div className="finance-import-account" style={{ paddingInlineStart: `${Math.max(0, candidate.proposedAccountPath.length - 1) * 14}px` }}>
        <small>{candidate.sourceLabel}</small><strong>{candidate.proposedAccountPath.at(-1) ?? candidate.sourceLabel}</strong>
        <span>{candidate.proposedAccountPath.join(" / ")}</span>
      </div>
      <div><small>Current</small><strong>{money(candidate.currentAmountCents, detail.resolvedCurrency)}</strong></div>
      <div><small>{candidate.factKind === "DERIVED" ? "Recalculated" : "Proposed"}</small><strong>{money(proposed, detail.resolvedCurrency)}</strong></div>
      <div><small>Change</small><strong>{money(difference, detail.resolvedCurrency)}</strong></div>
      <div className="finance-import-row-status"><span className={`status-chip ${["WARNING", "BLOCKED"].includes(candidate.reviewState) ? "warning" : ""}`}>{label(candidate.reviewState)}</span><small>{label(candidate.action)}</small></div>
    </div>
    <details className="finance-import-evidence">
      <summary>Evidence, validation, and receipt</summary>
      <div className="finance-import-evidence-grid">
        <div><small>Source path</small><p>{candidate.sourcePath.join(" / ")}</p></div>
        <div><small>Period</small><p>{date(candidate.periodStart)} – {date(candidate.periodEnd)}</p></div>
        <div><small>Confidence</small><p>{(candidate.confidenceBps / 100).toFixed(0)}%</p></div>
        <div><small>Evidence</small><p>{candidate.evidenceMd}</p></div>
        <div><small>Validation</small><p>{candidate.explanationMd ?? (candidate.factKind === "DERIVED" ? "Read-only total recalculated from descendant leaf proposals." : "No exception found.")}</p></div>
        {candidate.editedAt && <div><small>Edited</small><p>{date(candidate.editedAt)} by {candidate.editedByUserId}</p></div>}
        {candidate.approvedAt && <div><small>Approved</small><p>{date(candidate.approvedAt)} by {candidate.approvedByUserId}</p></div>}
        {candidate.application && <div className="finance-import-receipt"><small>Application receipt</small><p>{label(candidate.application.outcome)} · {candidate.application.targetFactId ?? "validation only"} · {date(candidate.application.appliedAt)}</p></div>}
      </div>
    </details>
    {canEdit && <form className="finance-import-inline-edit" key={`${candidate.id}:${candidate.version}`} onSubmit={(event) => { void edit(event); }}>
      <label><span>Account path</span><input name="path" defaultValue={candidate.proposedAccountPath.join(" / ")} /></label>
      <label><span>Amount</span><input name="amount" inputMode="decimal" defaultValue={(candidate.amountCents / 100).toFixed(2)} /></label>
      <label><span>From</span><input name="periodStart" type="date" defaultValue={candidate.periodStart.slice(0, 10)} /></label>
      <label><span>To</span><input name="periodEnd" type="date" defaultValue={candidate.periodEnd.slice(0, 10)} /></label>
      <button type="submit" className="secondary small" disabled={busy}>Save proposal</button>
    </form>}
    {canReview && <div className="finance-import-row-actions">
      {candidate.reviewState !== "BLOCKED" && <button type="button" className="secondary small" disabled={busy} onClick={() => { void review("APPROVE"); }}>Approve</button>}
      <button type="button" className="ghost small" disabled={busy} onClick={() => { void review("REJECT"); }}>Reject</button>
      {candidate.peerConfirmationRequired && <small>A different Finance writer must confirm this historical update.</small>}
      {candidate.reviewState === "BLOCKED" && <small>Structural blockers cannot be approved. Edit or reject this row.</small>}
    </div>}
  </article>;
}

export function FinanceReportReviewPanel({ workspaceId, canWrite, detail, onChanged }: Props) {
  const [showAll, setShowAll] = useState(false), [busy, setBusy] = useState(false), [error, setError] = useState<string | null>(null);
  const [confirmAll, setConfirmAll] = useState(false), [acceptWarnings, setAcceptWarnings] = useState(false);
  const visible = useMemo(() => financeImportVisibleCandidates(detail.candidates, showAll), [detail.candidates, showAll]);
  const approvedCount = detail.candidates.filter(({ reviewState }) => reviewState === "APPROVED").length;
  const reviewVersions = financeImportCandidateVersions(detail.candidates, "review");
  const blockers = detail.blockerCount > 0 || detail.candidates.some(({ reviewState }) => reviewState === "BLOCKED");
  const warnings = detail.warningCount > 0 || detail.warnings.length > 0 || detail.candidates.some(({ historicalWarning }) => historicalWarning);

  async function request(method: "PATCH" | "POST", body: object, fallback: string) {
    setBusy(true); setError(null);
    try {
      const response = await fetch(`/api/workspaces/${workspaceId}/finance/imports/${detail.id}`, {
        method, headers: { "content-type": "application/json" }, body: JSON.stringify(body),
      });
      if (!response.ok) throw new Error(await responseMessage(response, fallback));
      return await onChanged();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : fallback); return null;
    } finally { setBusy(false); }
  }

  async function patch(body: object, fallback: string) {
    if ("invalid" in body) { setError(fallback); return; }
    await request("PATCH", body, fallback);
  }

  async function applyApproved(batch = detail) {
    const candidateVersions = financeImportCandidateVersions(batch.candidates, "apply");
    if (candidateVersions.length === 0) { setError("No approved proposal versions are ready to apply."); return; }
    await request("POST", { expectedVersion: batch.version, candidateVersions }, "The approved proposals could not be applied.");
  }

  async function applyVerified() {
    const fresh = await request("PATCH", { operation: "APPROVE_VERIFIED", expectedVersion: detail.version, candidateVersions: reviewVersions },
      "Verified proposals could not be approved.");
    if (fresh) await applyApproved(fresh);
  }

  async function approveAll() {
    const fresh = await request("PATCH", { operation: "APPROVE_ALL", expectedVersion: detail.version, candidateVersions: reviewVersions,
      acceptWarnings: acceptWarnings || undefined }, "The proposals could not all be approved.");
    if (fresh) { setConfirmAll(false); setAcceptWarnings(false); }
  }

  return <section className="finance-import-review" aria-labelledby="finance-import-review-title">
    <div className="finance-import-review-heading"><div><p className="nr-page-eyebrow">Review proposal</p><h4 id="finance-import-review-title">Changes first</h4></div>
      <button type="button" className="secondary small" onClick={() => setShowAll((value) => !value)}>{showAll ? "Show changes only" : "Show all rows"}</button></div>
    <div className="finance-import-summary-cards">
      <div><strong>{detail.addCount}</strong><span>New</span></div><div><strong>{detail.updateCount}</strong><span>Updates</span></div>
      <div><strong>{detail.unchangedCount + detail.duplicateCount + detail.skippedCount}</strong><span>Unchanged / skipped</span></div>
      <div className={detail.warningCount + detail.blockerCount > 0 ? "attention" : ""}><strong>{detail.warningCount + detail.blockerCount}</strong><span>Needs attention</span></div>
    </div>
    <div className="finance-import-source-links">
      {detail.documentId && detail.brainSourceId && <a className="secondary small" href={`/api/workspaces/${workspaceId}/brain/sources/${detail.brainSourceId}/file`} target="_blank" rel="noreferrer">Open original report</a>}
      <a className="ghost small" href={`/workspaces/${workspaceId}/brain/sources`}>View in Brain</a>
      <span>{detail.title ?? detail.originalFilename} · {date(detail.periodStart)} – {date(detail.periodEnd)} · {detail.resolvedCurrency}</span>
    </div>
    {error && <p className="finance-import-error" role="alert">{error}</p>}
    <div className="finance-import-review-list">{visible.map((candidate) => <CandidateRow key={candidate.id} candidate={candidate} detail={detail}
      canWrite={canWrite} busy={busy} onPatch={patch} />)}</div>
    {visible.length === 0 && <p className="muted">No proposed changes need review.</p>}
    {canWrite && detail.stage !== "APPLIED" ? <div className="finance-import-bulk-actions">
      <button type="button" className="primary" disabled={busy || reviewVersions.length === 0} onClick={() => { void applyVerified(); }}>Apply verified changes; review exceptions</button>
      <button type="button" className="secondary" disabled={busy || blockers || reviewVersions.length === 0} onClick={() => setConfirmAll(true)}>Approve everything as proposed</button>
      {approvedCount > 0 && <button type="button" className="ghost" disabled={busy} onClick={() => { void applyApproved(); }}>Apply approved versions ({approvedCount})</button>}
    </div> : <div className="finance-import-notice"><strong>{detail.stage === "APPLIED" ? "Application complete" : "Read-only review"}</strong><span>{detail.stage === "APPLIED" ? "Receipts remain available with each row." : "Finance write access is required to edit, approve, or apply proposals."}</span></div>}
    {confirmAll && <div className="finance-import-confirm-all" role="dialog" aria-label="Confirm all proposals">
      <strong>Approve every non-blocked proposal?</strong><p>This includes {detail.addCount} new and {detail.updateCount} updated value(s){warnings ? `, with ${detail.warningCount} warning(s)` : ""}.</p>
      {warnings && <label><input type="checkbox" checked={acceptWarnings} onChange={(event) => setAcceptWarnings(event.target.checked)} /> I reviewed and accept the included warnings.</label>}
      <div><button type="button" className="primary" disabled={busy || (warnings && !acceptWarnings)} onClick={() => { void approveAll(); }}>Confirm approval</button>
        <button type="button" className="ghost" disabled={busy} onClick={() => setConfirmAll(false)}>Cancel</button></div>
    </div>}
    <details className="finance-import-history"><summary>Import history and audit receipt</summary><p>Uploaded by {detail.uploadedByUserId} on {date(detail.createdAt)}. Last updated {date(detail.updatedAt)}.</p>
      <p>Agent run {detail.agentRunId ?? "—"} · Workflow job {detail.workflowJobId ?? "—"} · Currency {detail.currencyResolutionSource ? label(detail.currencyResolutionSource) : "unresolved"}.</p>
      <p>Applied {detail.appliedAt ? `${date(detail.appliedAt)} by ${detail.appliedByUserId}` : "not yet"}. {detail.rejectedCount} rejected; {detail.appliedCount} applied.</p></details>
  </section>;
}
