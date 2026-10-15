import type { AppActor } from "@corgtex/shared";
import { prisma } from "@corgtex/shared";
import { Prisma, type FinanceImportBatch, type FinanceImportCandidate, type FinanceImportCandidateReviewState } from "@prisma/client";
import { captureArtifactInputProof, captureImmutableArtifactInputProof, recordArtifactInputLineage, type LineageRoot } from "./source-lineage";
import { DigestReadRelease, loadReadableArtifactSample } from "./digest-lineage";
import { AppError, invariant } from "./errors";
import { requireFinanceReportImportHumanWriteAccess, requireFinanceReportImportReadAccess } from "./finance";
import { parseFinanceImportInterpretationV1 } from "./finance-import-interpretation";
import { captureFinanceCurrentFactValues, reconcileFinanceImportCandidates, type FinanceImportReconciliationDecision } from "./finance-import-reconciliation";
import { normalizeFinanceImportAmountCents, parseFinanceImportDate } from "./finance-imports";
export const FINANCE_IMPORT_HISTORICAL_MONTHS = 12;
const MAX_VERSION = 2_147_483_647, HISTORICAL_POLICY_CODES = new Set(["HISTORICAL_ADDITION", "HISTORICAL_UPDATE"]);
const COUNT_KEY = { ADD: "addCount", UPDATE: "updateCount", UNCHANGED: "unchangedCount", DUPLICATE: "duplicateCount", CONFLICT: "conflictCount", SKIP: "skippedCount" } as const;
const SUMMARY_SELECT = { id: true, originalFilename: true, stage: true, reportType: true, basis: true, cadence: true,
  periodStart: true, periodEnd: true, currencyState: true, resolvedCurrency: true, safeErrorCode: true, safeErrorMessage: true,
  addCount: true, updateCount: true, unchangedCount: true, duplicateCount: true, conflictCount: true,
  warningCount: true, blockerCount: true, rejectedCount: true, appliedCount: true, version: true, createdAt: true, updatedAt: true } satisfies Prisma.FinanceImportBatchSelect;
type Version = { id: string; expectedVersion: number };
type ReviewMode = "APPROVE" | "REJECT" | "APPROVE_VERIFIED" | "APPROVE_ALL";
function validVersion(value: number) {
  invariant(Number.isInteger(value) && value > 0 && value < MAX_VERSION, 400, "INVALID_INPUT", "An incrementable Finance import version is required.");
}
function historicalCutoff(now: Date) {
  const cutoff = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
  cutoff.setUTCMonth(cutoff.getUTCMonth() - FINANCE_IMPORT_HISTORICAL_MONTHS);
  return cutoff;
}
function historical(periodEnd: Date, now: Date) {
  return periodEnd < historicalCutoff(now);
}
function warning(candidate: Pick<FinanceImportCandidate, "action" | "periodEnd" | "reviewState">, now: Date) {
  return !["REJECTED", "APPLIED"].includes(candidate.reviewState) && (candidate.reviewState === "WARNING" || (["ADD", "UPDATE"].includes(candidate.action) && historical(candidate.periodEnd, now)));
}
function present<T extends Pick<FinanceImportCandidate, "action" | "periodEnd" | "reviewState" | "approvedByUserId">>(candidate: T, now: Date) {
  const historicalWarning = !["REJECTED", "APPLIED"].includes(candidate.reviewState) && ["ADD", "UPDATE"].includes(candidate.action) && historical(candidate.periodEnd, now);
  return { ...candidate, historicalWarning, peerConfirmationRequired: historicalWarning && candidate.action === "UPDATE" };
}
function reportWarnings(value: Prisma.JsonValue | null) { return value ? parseFinanceImportInterpretationV1(value).exceptions.filter(({ severity }) => severity === "WARNING") : []; }
const FINANCE_READ_BUDGET = 5_000;
async function visitReadableCandidates(release: DigestReadRelease, batchIds: string[], visit: (rows: FinanceImportCandidate[]) => void) {
  if (!batchIds.length) return;
  let after: Pick<FinanceImportCandidate, "sourceKey" | "id"> | undefined;
  for (;;) {
    const rows = await prisma.financeImportCandidate.findMany({where: {workspaceId: release.workspaceId, batchId: {in: batchIds},
      ...(after ? {OR: [{sourceKey: {gt: after.sourceKey}}, {sourceKey: after.sourceKey, id: {gt: after.id}}]} : {})},
      orderBy: [{sourceKey: "asc"}, {id: "asc"}], take: 100});
    const next = rows.at(-1);
    visit((await release.capture("FinanceImportCandidate", rows)).records);
    if (rows.length < 100) return;
    invariant(next && next.id !== after?.id, 409, "SOURCE_CHANGED", "Finance candidates changed during pagination.");
    after = {sourceKey: next.sourceKey, id: next.id};
  }
}
function emptyCounts() {
  return { addCount: 0, updateCount: 0, unchangedCount: 0, duplicateCount: 0, conflictCount: 0, skippedCount: 0,
    rejectedCount: 0, appliedCount: 0, warningCount: 0, blockerCount: 0 };
}
function countCandidate(counts: ReturnType<typeof emptyCounts>, candidate: FinanceImportCandidate, now: Date) {
  counts[COUNT_KEY[candidate.action]] += 1;
  counts.rejectedCount += Number(candidate.reviewState === "REJECTED");
  counts.appliedCount += Number(candidate.reviewState === "APPLIED");
  counts.blockerCount += Number(candidate.reviewState === "BLOCKED");
  counts.warningCount += Number(warning(candidate, now));
}
function completeCounts(batch: FinanceImportBatch, counts: ReturnType<typeof emptyCounts>) {
  const interpretation = batch.interpretationJson ? parseFinanceImportInterpretationV1(batch.interpretationJson) : null;
  return {...counts,
    warningCount: counts.warningCount + (interpretation?.exceptions.filter(item => item.severity === "WARNING" && !HISTORICAL_POLICY_CODES.has(item.code)).length ?? 0),
    blockerCount: Math.max(counts.blockerCount, interpretation?.exceptions.filter(item => item.severity === "BLOCKER").length ?? 0,
      Number(batch.currencyState === "UNRESOLVED" && batch.stage === "NEEDS_INPUT"))};
}
function currentCounts(batch: FinanceImportBatch, candidates: FinanceImportCandidate[], now: Date) {
  const counts = emptyCounts();
  for (const candidate of candidates) countCandidate(counts, candidate, now);
  return completeCounts(batch, counts);
}

function summaryOf(batch: FinanceImportBatch) {
  return Object.fromEntries(Object.keys(SUMMARY_SELECT).map(key => [key, batch[key as keyof FinanceImportBatch]])) as Pick<FinanceImportBatch, keyof typeof SUMMARY_SELECT>;
}
async function bindBatch(release: DigestReadRelease, batch: FinanceImportBatch) {
  release.add(await release.observeRead(() => captureArtifactInputProof(release.actor, release.workspaceId,
    [{kind: "FinanceImportBatch", id: batch.id, snapshot: batch}])));
}
function candidateState(decision: FinanceImportReconciliationDecision, now: Date): FinanceImportCandidateReviewState {
  return decision.reviewState === "BLOCKED" ? "BLOCKED" : ["ADD", "UPDATE"].includes(decision.action) && historical(decision.candidate.periodEnd, now) ? "WARNING" : decision.reviewState;
}
function withAppliedCounts(result: ReturnType<typeof reconcileFinanceImportCandidates>, candidates: Array<Pick<FinanceImportCandidate, "id" | "action" | "reviewState">>) {
  const states = new Map(candidates.map(({ id, reviewState }) => [id, reviewState])); const total = { ...result.counts };
  for (const decision of result.decisions) if (states.get(decision.candidate.id!) === "APPLIED") total[COUNT_KEY[decision.action]] -= 1;
  for (const candidate of candidates) if (candidate.reviewState === "APPLIED") total[COUNT_KEY[candidate.action]] += 1; return total;
}
async function reconcile(tx: Prisma.TransactionClient, actor: AppActor, identity: Omit<Parameters<typeof reconcileFinanceImportCandidates>[0], "candidates" | "currentFacts">,
  rows: Parameters<typeof reconcileFinanceImportCandidates>[0]["candidates"]) {
  const keys = reconcileFinanceImportCandidates({ ...identity, candidates: rows, currentFacts: [] }).decisions.flatMap(({ semanticKey }) => semanticKey ? [semanticKey] : []);
  const facts = await tx.financeReportFact.findMany({ where: { workspaceId: identity.workspaceId, semanticKey: { in: keys } }, orderBy: { id: "asc" }, take: 5001 });
  const current = await captureFinanceCurrentFactValues(tx, actor, identity.workspaceId, facts);
  return { ...reconcileFinanceImportCandidates({ ...identity, candidates: rows, currentFacts: current.facts }), lineageRoots: current.roots };
}
export async function listFinanceReportImports(actor: AppActor, workspaceId: string, now = new Date()) {
  await requireFinanceReportImportReadAccess(actor, workspaceId);
  const release = new DigestReadRelease(actor, workspaceId);
  const {records: batches} = await loadReadableArtifactSample({actor, workspaceId, kind: "FinanceImportBatch", limit: 100, release,
    loadBatch: (after: FinanceImportBatch | undefined, take) => prisma.financeImportBatch.findMany({where: {workspaceId,
      ...(after ? {OR: [{createdAt: {lt: after.createdAt}}, {createdAt: after.createdAt, id: {gt: after.id}}]} : {})},
      orderBy: [{createdAt: "desc"}, {id: "asc"}], take})});
  const counts = new Map(batches.map(batch => [batch.id, emptyCounts()]));
  await visitReadableCandidates(release, batches.map(batch => batch.id), rows => {
    for (const row of rows) countCandidate(counts.get(row.batchId)!, row, now);
  });
  await requireFinanceReportImportReadAccess(actor, workspaceId);
  return release.finish(batches.map(batch => ({...summaryOf(batch), ...completeCounts(batch, counts.get(batch.id)!)})));
}
export async function getFinanceReportImportSummary(actor: AppActor, params: { workspaceId: string; batchId: string }, now = new Date()) {
  await requireFinanceReportImportReadAccess(actor, params.workspaceId);
  const release = new DigestReadRelease(actor, params.workspaceId);
  const batch = await prisma.financeImportBatch.findUnique({ where: { id_workspaceId: { id: params.batchId, workspaceId: params.workspaceId } } });
  invariant(batch, 404, "FINANCE_REPORT_IMPORT_NOT_FOUND", "The Finance report import was not found.");
  await bindBatch(release, batch);
  const counts = emptyCounts();
  await visitReadableCandidates(release, [batch.id], rows => {for (const row of rows) countCandidate(counts, row, now);});
  await requireFinanceReportImportReadAccess(actor, params.workspaceId);
  return release.finish({...summaryOf(batch), ...completeCounts(batch, counts)});
}
export async function getFinanceReportImport(actor: AppActor, params: { workspaceId: string; batchId: string }, now = new Date()) {
  await requireFinanceReportImportReadAccess(actor, params.workspaceId);
  const batch = await prisma.financeImportBatch.findUnique({ where: { id_workspaceId: { id: params.batchId, workspaceId: params.workspaceId } } });
  invariant(batch, 404, "FINANCE_REPORT_IMPORT_NOT_FOUND", "The Finance report import was not found.");
  const release = new DigestReadRelease(actor, params.workspaceId);
  await bindBatch(release, batch);
  const candidates: FinanceImportCandidate[] = [];
  await visitReadableCandidates(release, [batch.id], rows => {candidates.push(...rows);});
  const applicationByCandidate = new Map<string, {id: string; outcome: import("@prisma/client").FinanceImportApplicationOutcome;
    targetFactId: string | null; appliedByUserId: string; appliedAt: Date}>();
  // Detail deliberately returns every permitted candidate. Only its returned
  // rows and compact application summaries survive bounded join hydration.
  for (let offset = 0; offset < candidates.length; offset += 100) {
    let afterId: string | undefined;
    for (;;) {
      const rows = await prisma.financeImportApplication.findMany({where: {workspaceId: params.workspaceId, batchId: batch.id,
        candidateId: {in: candidates.slice(offset, offset + 100).map(row => row.id)}, ...(afterId ? {id: {gt: afterId}} : {})},
        orderBy: {id: "asc"}, take: 100});
      const admitted = await release.capture("FinanceImportApplication", rows);
      for (const row of admitted.records) applicationByCandidate.set(row.candidateId, {id: row.id, outcome: row.outcome,
        targetFactId: row.targetFactId, appliedByUserId: row.appliedByUserId, appliedAt: row.appliedAt});
      if (rows.length < 100) break;
      invariant(rows.at(-1)!.id !== afterId, 409, "SOURCE_CHANGED", "Finance applications changed during pagination.");
      afterId = rows.at(-1)!.id;
    }
  }
  const { interpretationJson, ...detail } = batch;
  const interpretation = interpretationJson ? parseFinanceImportInterpretationV1(interpretationJson) : null;
  const warnings = interpretation?.exceptions.filter(({ severity, code }) => severity === "WARNING" && !HISTORICAL_POLICY_CODES.has(code)) ?? [];
  const numericFormat = interpretation?.numericFormat.status === "RESOLVED"
    ? { status: "RESOLVED" as const, decimalSeparator: interpretation.numericFormat.decimalSeparator,
        groupingSeparator: interpretation.numericFormat.groupingSeparator, amountScale: interpretation.numericFormat.amountScale }
    : { status: "UNRESOLVED" as const, decimalSeparator: null, groupingSeparator: null, amountScale: null };
  await requireFinanceReportImportReadAccess(actor, params.workspaceId);
  return release.finish({ ...detail, ...currentCounts(batch, candidates, now), warnings,
    clarification: { canConfirm: detail.stage === "NEEDS_INPUT" && detail.safeErrorCode === "CURRENCY_UNRESOLVED"
      && numericFormat.status === "RESOLVED" && candidates.length > 0, numericFormat },
    candidates: candidates.map(candidate => ({ ...present(candidate, now), application: applicationByCandidate.get(candidate.id) ?? null })) });
}
function reviewable(batch: { stage: string; version: number }, expectedVersion: number) {
  validVersion(expectedVersion);
  invariant(["READY_FOR_REVIEW", "PARTIALLY_APPLIED"].includes(batch.stage) && batch.version === expectedVersion, 409, "FINANCE_REPORT_REVIEW_CONFLICT", "The Finance report import changed. Refresh and try again.");
}
function candidateVersions(candidates: Array<Pick<FinanceImportCandidate, "id" | "version">>, supplied: Version[]) {
  const versions = new Map(supplied.map(({ id, expectedVersion }) => [id, expectedVersion]));
  invariant(versions.size === supplied.length && supplied.every(({ expectedVersion }) => (validVersion(expectedVersion), true)),
    400, "INVALID_INPUT", "Candidate versions must be unique and incrementable.");
  invariant(candidates.every(({ id, version }) => versions.get(id) === version), 409, "FINANCE_REPORT_REVIEW_CONFLICT", "A Finance report candidate changed. Refresh and try again.");
}
function normalizedPath(value: string[]) {
  const path = value.map((part) => part.normalize("NFKC").trim().replace(/\s+/gu, " "));
  invariant(path.length > 0 && path.length <= 100 && path.every((part) => part.length > 0 && part.length <= 500 && !part.includes("\0")),
    400, "INVALID_INPUT", "The proposed account path is invalid.");
  return path;
}
async function recordReviewOutputs(tx: Prisma.TransactionClient, actor: AppActor, workspaceId: string,
  before: FinanceImportBatch & { candidates: FinanceImportCandidate[] }, roots: LineageRoot[]) {
  const current = await tx.financeImportCandidate.findMany({ where: { workspaceId, batchId: before.id }, orderBy: { id: "asc" }, take: FINANCE_READ_BUDGET + 1 });
  invariant(current.length <= FINANCE_READ_BUDGET && current.length === before.candidates.length,
    409, "FINANCE_REPORT_REVIEW_CONFLICT", "The Finance report candidates changed.");
  const priors = new Map(before.candidates.map(row => [row.id, row]));
  for (const row of current) {
    const prior = priors.get(row.id);
    invariant(prior, 409, "FINANCE_REPORT_REVIEW_CONFLICT", "The Finance report candidates changed.");
    if (row.version !== prior.version) await recordArtifactInputLineage({ tx, actor, workspaceId,
      artifact: { kind: "FinanceImportCandidate", id: row.id }, content: row, origin: "DERIVED", inputs: [], inheritedRoots: roots });
  }
  const currentRoots = await captureArtifactInputProof(actor, workspaceId,
    current.map(row => ({ kind: "FinanceImportCandidate" as const, id: row.id, snapshot: row })), tx);
  const batch = await tx.financeImportBatch.findUniqueOrThrow({ where: { id_workspaceId: { id: before.id, workspaceId } } });
  await recordArtifactInputLineage({ tx, actor, workspaceId, artifact: { kind: "FinanceImportBatch", id: batch.id },
    content: batch, origin: "DERIVED", inputs: [], inheritedRoots: [...roots, ...currentRoots] });
}
export async function editFinanceReportImportCandidate(actor: AppActor, params: { workspaceId: string; batchId: string; candidateId: string;
  expectedVersion: number; expectedCandidateVersion: number; proposedAccountPath?: string[]; amountCents?: number; periodStart?: string; periodEnd?: string }) {
  await requireFinanceReportImportHumanWriteAccess(actor, params.workspaceId);
  invariant(actor.kind === "user", 403, "HUMAN_REVIEW_REQUIRED", "A human Finance writer is required.");
  validVersion(params.expectedCandidateVersion);
  invariant(params.proposedAccountPath !== undefined || params.amountCents !== undefined || params.periodStart !== undefined || params.periodEnd !== undefined,
    400, "INVALID_INPUT", "At least one editable proposal field is required.");
  return prisma.$transaction(async (tx) => {
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${`finance-report-review:${params.workspaceId}:${params.batchId}`}, 0))`;
    const batch = await tx.financeImportBatch.findUnique({ where: { id_workspaceId: { id: params.batchId, workspaceId: params.workspaceId } }, include: { candidates: { orderBy: { id: "asc" }, take: FINANCE_READ_BUDGET + 1 } } });
    invariant(batch, 404, "FINANCE_REPORT_IMPORT_NOT_FOUND", "The Finance report import was not found.");
    invariant(batch.candidates.length <= FINANCE_READ_BUDGET, 413, "FINANCE_READ_BUDGET", "Narrow the Finance import selection.");
    await requireFinanceReportImportHumanWriteAccess(actor, params.workspaceId);
    const inputRoots = await captureArtifactInputProof(actor, params.workspaceId, [
      { kind: "FinanceImportBatch", id: batch.id, snapshot: batch },
      ...batch.candidates.map(row => ({ kind: "FinanceImportCandidate" as const, id: row.id, snapshot: row })),
    ], tx);
    const frozenRoots = await captureImmutableArtifactInputProof(actor, params.workspaceId, inputRoots, tx);
    reviewable(batch, params.expectedVersion);
    const target = batch.candidates.find(({ id }) => id === params.candidateId);
    invariant(target && target.version === params.expectedCandidateVersion, 409, "FINANCE_REPORT_REVIEW_CONFLICT", "The Finance report candidate changed. Refresh and try again.");
    invariant(!["REJECTED", "APPLIED"].includes(target.reviewState), 409, "FINANCE_REPORT_REVIEW_BLOCKED", "Rejected or applied candidates cannot be edited.");
    invariant(target.factKind === "LEAF", 409, "FINANCE_REPORT_REVIEW_BLOCKED", "Derived rows are read-only validation results.");
    batch.candidates.forEach(({ version }) => validVersion(version));
    const edited = { ...target, proposedAccountPath: params.proposedAccountPath === undefined ? target.proposedAccountPath : normalizedPath(params.proposedAccountPath),
      amountCents: params.amountCents === undefined ? target.amountCents : normalizeFinanceImportAmountCents(params.amountCents),
      periodStart: params.periodStart === undefined ? target.periodStart : parseFinanceImportDate(params.periodStart, "Period start"),
      periodEnd: params.periodEnd === undefined ? target.periodEnd : parseFinanceImportDate(params.periodEnd, "Period end") };
    invariant(edited.periodStart <= edited.periodEnd, 400, "INVALID_INPUT", "Period start must not be after period end.");
    invariant(batch.reportType && batch.basis && batch.resolvedCurrency, 409, "FINANCE_REPORT_REVIEW_BLOCKED", "Resolve report classification and currency before review.");
    const rows = batch.candidates.filter(({ reviewState }) => reviewState !== "REJECTED").map((candidate) => candidate.id === edited.id ? edited : candidate);
    const identity = { workspaceId: batch.workspaceId, reportType: batch.reportType, basis: batch.basis, currency: batch.resolvedCurrency };
    const result = await reconcile(tx, actor, identity, rows);
    if (result.lineageRoots.length) frozenRoots.push(...await captureImmutableArtifactInputProof(actor, params.workspaceId, result.lineageRoots, tx));
    const counts = withAppliedCounts(result, batch.candidates);
    const now = new Date(); const rejectedCount = batch.candidates.filter(({ reviewState }) => reviewState === "REJECTED").length;
    const editedDecision = result.decisions.find(({ candidate }) => candidate.id === edited.id)!; const affectedKeys = new Set([target.semanticKey, editedDecision.semanticKey]);
    const affected = result.decisions.filter((decision) => batch.candidates.find(({ id }) => id === decision.candidate.id)?.reviewState !== "APPLIED" && (decision.candidate.id === edited.id || (decision.semanticKey && affectedKeys.has(decision.semanticKey))));
    const signature = (decision: FinanceImportReconciliationDecision) => JSON.stringify([decision.candidate.id === edited.id ? edited.id : null, decision.semanticKey, decision.action, candidateState(decision, now), decision.currentFactId, decision.currentFactRevisionId, decision.currentAmountCents, decision.explanationMd]);
    for (const key of new Set(affected.map(signature))) {
      const decisions = affected.filter((decision) => signature(decision) === key); const decision = decisions[0]!; const state = candidateState(decision, now);
      const priors = decisions.map(({ candidate }) => batch.candidates.find(({ id }) => id === candidate.id)!);
      const updated = await tx.financeImportCandidate.updateMany({ where: { workspaceId: batch.workspaceId, batchId: batch.id, OR: priors.map(({ id, version }) => ({ id, version })) }, data: {
        ...(decision.candidate.id === edited.id ? { proposedAccountPath: edited.proposedAccountPath, amountCents: edited.amountCents, periodStart: edited.periodStart, periodEnd: edited.periodEnd, editedByUserId: actor.user.id, editedAt: now } : {}),
        semanticKey: decision.semanticKey, action: decision.action, reviewState: state, currentFactId: decision.currentFactId, currentFactRevisionId: decision.currentFactRevisionId, currentAmountCents: decision.currentAmountCents, explanationMd: decision.explanationMd, approvedByUserId: null, approvedAt: null, version: { increment: 1 } } });
      invariant(updated.count === priors.length, 409, "FINANCE_REPORT_REVIEW_CONFLICT", "A Finance report candidate changed. Refresh and try again.");
    }
    const reportWarningCount = reportWarnings(batch.interpretationJson).length;
    const reportingDates = batch.candidates.filter(({ reviewState }) => reviewState !== "REJECTED").map((candidate) => candidate.id === edited.id ? edited : candidate)
      .flatMap(({ periodStart, periodEnd }) => [periodStart.valueOf(), periodEnd.valueOf()]);
    const updated = await tx.financeImportBatch.updateMany({ where: { id: batch.id, workspaceId: batch.workspaceId, version: batch.version }, data: {
      ...counts, warningCount: reportWarningCount, blockerCount: counts.conflictCount, rejectedCount,
      periodStart: new Date(Math.min(...reportingDates)), periodEnd: new Date(Math.max(...reportingDates)),
      approvedByUserId: null, approvedAt: null, version: { increment: 1 } } });
    invariant(updated.count === 1, 409, "FINANCE_REPORT_REVIEW_CONFLICT", "The Finance report import changed. Refresh and try again.");
    await recordReviewOutputs(tx, actor, batch.workspaceId, batch, frozenRoots);
    await tx.auditLog.create({ data: { workspaceId: batch.workspaceId, actorUserId: actor.user.id, action: "finance-report-import.candidate-edited",
      entityType: "FinanceImportCandidate", entityId: target.id, meta: { batchId: batch.id, version: batch.version + 1 } } });
    return { batchId: batch.id, version: batch.version + 1, candidateId: target.id, candidateVersion: target.version + 1 };
  }, {maxWait: 10_000, timeout: 120_000});
}
export async function reviewFinanceReportImport(actor: AppActor, params: { workspaceId: string; batchId: string; expectedVersion: number;
  mode: ReviewMode; candidateVersions: Version[]; candidateId?: string; acceptWarnings?: boolean }) {
  await requireFinanceReportImportHumanWriteAccess(actor, params.workspaceId);
  invariant(actor.kind === "user", 403, "HUMAN_REVIEW_REQUIRED", "A human Finance writer is required.");
  return prisma.$transaction(async (tx) => {
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${`finance-report-review:${params.workspaceId}:${params.batchId}`}, 0))`;
    const batch = await tx.financeImportBatch.findUnique({ where: { id_workspaceId: { id: params.batchId, workspaceId: params.workspaceId } }, include: { candidates: { orderBy: { id: "asc" }, take: FINANCE_READ_BUDGET + 1 } } });
    invariant(batch, 404, "FINANCE_REPORT_IMPORT_NOT_FOUND", "The Finance report import was not found.");
    invariant(batch.candidates.length <= FINANCE_READ_BUDGET, 413, "FINANCE_READ_BUDGET", "Narrow the Finance import selection.");
    await requireFinanceReportImportHumanWriteAccess(actor, params.workspaceId);
    const inputRoots = await captureArtifactInputProof(actor, params.workspaceId, [
      { kind: "FinanceImportBatch", id: batch.id, snapshot: batch },
      ...batch.candidates.map(row => ({ kind: "FinanceImportCandidate" as const, id: row.id, snapshot: row })),
    ], tx);
    const frozenRoots = await captureImmutableArtifactInputProof(actor, params.workspaceId, inputRoots, tx);
    reviewable(batch, params.expectedVersion);
    const priorReport = batch.stage === "PARTIALLY_APPLIED" && params.mode === "REJECT"
      ? await tx.financeReport.findFirst({ where: { workspaceId: params.workspaceId, sourceBatchId: batch.id } }) : null;
    if (batch.stage === "PARTIALLY_APPLIED" && params.mode === "REJECT") {
      invariant(priorReport, 409, "FINANCE_REPORT_SOURCE_NOT_READY", "Finance reconciliation is unavailable.");
      try {
        frozenRoots.push(...await captureImmutableArtifactInputProof(actor, params.workspaceId,
          await captureArtifactInputProof(actor, params.workspaceId, [{ kind: "FinanceReport", id: priorReport.id, snapshot: priorReport }], tx), tx));
      } catch (error) {
        if (error instanceof AppError && ["SOURCE_CHANGED", "UNKNOWN_LINEAGE", "FORBIDDEN"].includes(error.code))
          throw new AppError(409, "FINANCE_REPORT_SOURCE_NOT_READY", "Finance reconciliation is unavailable.");
        throw error;
      }
    }
    const bulk = params.mode === "APPROVE_VERIFIED" || params.mode === "APPROVE_ALL";
    const supplied = bulk ? params.candidateVersions : params.candidateVersions.filter(({ id }) => id === params.candidateId);
    const scope = bulk ? batch.candidates.filter(({ reviewState }) => reviewState !== "APPLIED") : batch.candidates.filter(({ id }) => id === params.candidateId);
    invariant(scope.length > 0 && params.candidateVersions.length === supplied.length
      && (bulk ? supplied.length === scope.length : supplied.length === 1), 400, "INVALID_INPUT", "The review selection is invalid.");
    candidateVersions(scope, supplied);
    const now = new Date();
    if (params.mode === "APPROVE_ALL") {
      invariant(batch.blockerCount === 0 && !batch.candidates.some(({ reviewState }) => reviewState === "BLOCKED"), 409, "FINANCE_REPORT_REVIEW_BLOCKED", "Structural blockers cannot be approved.");
      invariant((reportWarnings(batch.interpretationJson).every(({ code }) => HISTORICAL_POLICY_CODES.has(code)) && !batch.candidates.some((candidate) => warning(candidate, now))) || params.acceptWarnings === true,
        409, "FINANCE_REPORT_WARNING_ACCEPTANCE_REQUIRED", "Explicitly accept report warnings before approving everything.");
    }
    invariant(scope.every(({ reviewState }) => reviewState !== "APPLIED"), 409, "FINANCE_REPORT_REVIEW_BLOCKED", "Applied candidates cannot be reviewed again.");
    invariant(bulk || scope.every(({ reviewState }) => reviewState !== "REJECTED"), 409, "FINANCE_REPORT_REVIEW_BLOCKED", "Rejected candidates cannot be reviewed again.");
    const targets = scope.filter((candidate) => candidate.reviewState !== "REJECTED" && (!bulk || candidate.reviewState !== "APPROVED" || (candidate.action === "UPDATE" && historical(candidate.periodEnd, now) && (!candidate.approvedByUserId || candidate.approvedByUserId === (candidate.editedByUserId ?? batch.uploadedByUserId)))) && (params.mode !== "APPROVE_VERIFIED"
      || (!warning(candidate, now) && !["APPROVED", "BLOCKED"].includes(candidate.reviewState))));
    invariant(params.mode === "REJECT" || targets.every(({ reviewState }) => reviewState !== "BLOCKED"), 409, "FINANCE_REPORT_REVIEW_BLOCKED", "Structural blockers cannot be approved.");
    invariant(["REJECT", "APPROVE_VERIFIED"].includes(params.mode) || params.acceptWarnings === true || (reportWarnings(batch.interpretationJson).every(({ code }) => HISTORICAL_POLICY_CODES.has(code)) && targets.every((candidate) => !warning(candidate, now))),
      409, "FINANCE_REPORT_WARNING_ACCEPTANCE_REQUIRED", "Explicitly accept warnings before approval.");
    for (const candidate of targets) if (params.mode !== "REJECT" && candidate.action === "UPDATE" && historical(candidate.periodEnd, now)) {
      invariant(actor.user.id !== (candidate.editedByUserId ?? batch.uploadedByUserId), 409, "FINANCE_REPORT_PEER_CONFIRMATION_REQUIRED", "A different Finance writer must confirm this historical update.");
    }
    const targetIds = new Set(targets.map(({ id }) => id));
    if (targets.length > 0) {
      const approved = params.mode !== "REJECT";
      const updated = await tx.financeImportCandidate.updateMany({ where: { workspaceId: batch.workspaceId, batchId: batch.id,
        OR: targets.map(({ id, version }) => ({ id, version })) }, data: { reviewState: approved ? "APPROVED" : "REJECTED",
        approvedByUserId: approved ? actor.user.id : null, approvedAt: approved ? now : null, version: { increment: 1 } } });
      invariant(updated.count === targets.length, 409, "FINANCE_REPORT_REVIEW_CONFLICT", "A Finance report candidate changed. Refresh and try again.");
    }
    let reconciled: Awaited<ReturnType<typeof reconcile>> | null = null; let warningCount = reportWarnings(batch.interpretationJson).filter(({ code }) => !HISTORICAL_POLICY_CODES.has(code)).length; let reportingWindow: { periodStart?: Date; periodEnd?: Date; asOfDate?: Date | null } = {};
    const reconciledStates = new Map<string, FinanceImportCandidateReviewState>();
    if (params.mode === "REJECT") {
      invariant(batch.reportType && batch.basis && batch.resolvedCurrency, 409, "FINANCE_REPORT_REVIEW_BLOCKED", "Resolve report classification and currency before review.");
      batch.candidates.forEach(({ version }) => validVersion(version));
      const active = batch.candidates.filter(({ id, reviewState }) => !targetIds.has(id) && reviewState !== "REJECTED"); if (active.length) { const dates = active.flatMap(({ periodStart, periodEnd }) => [periodStart.valueOf(), periodEnd.valueOf()]); const periodStart = new Date(Math.min(...dates)), periodEnd = new Date(Math.max(...dates)); reportingWindow = { periodStart, periodEnd, asOfDate: batch.asOfDate && (batch.asOfDate < periodStart || batch.asOfDate > periodEnd) ? null : batch.asOfDate }; }
      const survivors = active;
      reconciled = await reconcile(tx, actor, { workspaceId: batch.workspaceId, reportType: batch.reportType, basis: batch.basis, currency: batch.resolvedCurrency }, survivors);
      if (reconciled.lineageRoots.length) frozenRoots.push(...await captureImmutableArtifactInputProof(actor, params.workspaceId, reconciled.lineageRoots, tx));
      const affected = targets[0]!.semanticKey ? reconciled.decisions.filter((decision) => decision.semanticKey === targets[0]!.semanticKey && batch.candidates.find(({ id }) => id === decision.candidate.id)?.reviewState !== "APPLIED") : [];
      for (const action of new Set(affected.map(({ action }) => action))) {
        const decisions = affected.filter((decision) => decision.action === action); const decision = decisions[0]!; const state = candidateState(decision, now);
        const priors = decisions.map(({ candidate }) => batch.candidates.find(({ id }) => id === candidate.id)!);
        const updated = await tx.financeImportCandidate.updateMany({ where: { workspaceId: batch.workspaceId, batchId: batch.id,
          OR: priors.map(({ id, version }) => ({ id, version })) }, data: { semanticKey: decision.semanticKey, action, reviewState: state,
          currentFactId: decision.currentFactId, currentFactRevisionId: decision.currentFactRevisionId, currentAmountCents: decision.currentAmountCents, explanationMd: decision.explanationMd,
          approvedByUserId: null, approvedAt: null, version: { increment: 1 } } });
        invariant(updated.count === priors.length, 409, "FINANCE_REPORT_REVIEW_CONFLICT", "A Finance report candidate changed. Refresh and try again.");
        priors.forEach(({ id }) => reconciledStates.set(id, state));
      }
      warningCount = reportWarnings(batch.interpretationJson).filter(({ code }) => !HISTORICAL_POLICY_CODES.has(code)).length;
    }
    const states = batch.candidates.map((candidate) => targetIds.has(candidate.id) ? (params.mode === "REJECT" ? "REJECTED" : "APPROVED")
      : reconciledStates.get(candidate.id) ?? candidate.reviewState);
    const reconciledCounts = reconciled ? withAppliedCounts(reconciled, batch.candidates) : null;
    const blockerCount = reconciledCounts?.conflictCount ?? batch.blockerCount;
    const complete = states.every((state) => ["APPROVED", "REJECTED", "VERIFIED", "APPLIED"].includes(state)) && blockerCount === 0 && !batch.candidates.some((candidate) => !targetIds.has(candidate.id) && candidate.reviewState === "APPROVED" && warning(candidate, now) && ((candidate.action === "UPDATE" && (!candidate.approvedByUserId || candidate.approvedByUserId === (candidate.editedByUserId ?? batch.uploadedByUserId))) || ((!candidate.approvedAt || !historical(candidate.periodEnd, candidate.approvedAt)) && (params.mode === "APPROVE_VERIFIED" || params.acceptWarnings !== true))))
      && (warningCount === 0 || (params.mode !== "APPROVE_VERIFIED" && params.acceptWarnings === true));
    const rejectedCount = states.filter((state) => state === "REJECTED").length;
    const finalized = batch.stage === "PARTIALLY_APPLIED" && states.every((state) => ["APPLIED", "REJECTED"].includes(state));
    if (priorReport) {
      const changed = await tx.financeReport.updateMany({ where: { id: priorReport.id, workspaceId: params.workspaceId, version: priorReport.version }, data: { ...reportingWindow, version: { increment: 1 } } });
      invariant(changed.count === 1, 409, "FINANCE_REPORT_REVIEW_CONFLICT", "The applied Finance report changed.");
      const after = await tx.financeReport.findUniqueOrThrow({ where: { id_workspaceId: { id: priorReport.id, workspaceId: params.workspaceId } } });
      await recordArtifactInputLineage({ tx, actor, workspaceId: params.workspaceId, artifact: { kind: "FinanceReport", id: after.id },
        content: after, origin: "DERIVED", inputs: [], inheritedRoots: frozenRoots });
      frozenRoots.push(...await captureImmutableArtifactInputProof(actor, params.workspaceId,
        await captureArtifactInputProof(actor, params.workspaceId, [{ kind: "FinanceReport", id: after.id, snapshot: after }], tx), tx));
    }

    const updated = await tx.financeImportBatch.updateMany({ where: { id: batch.id, workspaceId: batch.workspaceId, version: batch.version }, data: {
      ...(reconciledCounts ? { ...reconciledCounts, warningCount: reportWarnings(batch.interpretationJson).length, blockerCount, ...reportingWindow } : {}), rejectedCount,
      ...(finalized ? { stage: "APPLIED" as const, appliedByUserId: actor.user.id, appliedAt: now } : {}),
      approvedByUserId: complete ? actor.user.id : null, approvedAt: complete ? now : null, version: { increment: 1 } } });
    invariant(updated.count === 1, 409, "FINANCE_REPORT_REVIEW_CONFLICT", "The Finance report import changed. Refresh and try again.");
    await recordReviewOutputs(tx, actor, batch.workspaceId, batch, frozenRoots);
    await tx.auditLog.create({ data: { workspaceId: batch.workspaceId, actorUserId: actor.user.id, action: `finance-report-import.review.${params.mode.toLowerCase()}`,
      entityType: "FinanceImportBatch", entityId: batch.id, meta: { version: batch.version + 1, reviewedCount: targets.length, complete } } });
    return { batchId: batch.id, version: batch.version + 1, reviewedCount: targets.length, rejectedCount, complete };
  }, {maxWait: 10_000, timeout: 120_000});
}
