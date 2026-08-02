import type { AppActor } from "@corgtex/shared";
import { prisma } from "@corgtex/shared";
import type { FinanceImportCandidate, FinanceImportCandidateReviewState, Prisma } from "@prisma/client";
import { invariant } from "./errors";
import { requireFinanceReportImportHumanWriteAccess, requireFinanceReportImportReadAccess } from "./finance";
import { parseFinanceImportInterpretationV1 } from "./finance-import-interpretation";
import { reconcileFinanceImportCandidates } from "./finance-import-reconciliation";
import { normalizeFinanceImportAmountCents, parseFinanceImportDate } from "./finance-imports";

export const FINANCE_IMPORT_HISTORICAL_MONTHS = 12;
const MAX_VERSION = 2_147_483_647;
type Version = { id: string; expectedVersion: number };
type ReviewMode = "APPROVE" | "REJECT" | "APPROVE_VERIFIED" | "APPROVE_ALL";

function validVersion(value: number) {
  invariant(Number.isInteger(value) && value > 0 && value < MAX_VERSION, 400, "INVALID_INPUT", "An incrementable Finance import version is required.");
}

function historical(periodEnd: Date, now: Date) {
  const cutoff = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
  cutoff.setUTCMonth(cutoff.getUTCMonth() - FINANCE_IMPORT_HISTORICAL_MONTHS);
  return periodEnd < cutoff;
}

function warning(candidate: Pick<FinanceImportCandidate, "action" | "periodEnd" | "reviewState">, now: Date) {
  return candidate.reviewState === "WARNING" || (["ADD", "UPDATE"].includes(candidate.action) && historical(candidate.periodEnd, now));
}

function present<T extends Pick<FinanceImportCandidate, "action" | "periodEnd" | "reviewState" | "approvedByUserId">>(candidate: T, now: Date) {
  const historicalWarning = ["ADD", "UPDATE"].includes(candidate.action) && historical(candidate.periodEnd, now);
  return { ...candidate, historicalWarning, peerConfirmationRequired: historicalWarning && candidate.action === "UPDATE" };
}

export async function listFinanceReportImports(actor: AppActor, workspaceId: string) {
  await requireFinanceReportImportReadAccess(actor, workspaceId);
  return prisma.financeImportBatch.findMany({ where: { workspaceId }, orderBy: { createdAt: "desc" }, take: 100, select: { id: true,
    originalFilename: true, stage: true, reportType: true, basis: true, cadence: true, periodStart: true, periodEnd: true,
    resolvedCurrency: true, addCount: true, updateCount: true, unchangedCount: true, duplicateCount: true, conflictCount: true,
    warningCount: true, blockerCount: true, rejectedCount: true, appliedCount: true, version: true, createdAt: true, updatedAt: true } });
}

export async function getFinanceReportImport(actor: AppActor, params: { workspaceId: string; batchId: string }, now = new Date()) {
  await requireFinanceReportImportReadAccess(actor, params.workspaceId);
  const batch = await prisma.financeImportBatch.findUnique({ where: { id_workspaceId: { id: params.batchId, workspaceId: params.workspaceId } },
    select: { id: true, uploadedByUserId: true, documentId: true, brainSourceId: true, originalFilename: true, stage: true, reportType: true,
      basis: true, cadence: true, periodStart: true, periodEnd: true, asOfDate: true, title: true, currencyState: true, resolvedCurrency: true,
      currencyResolutionSource: true, addCount: true, updateCount: true, unchangedCount: true, duplicateCount: true, conflictCount: true,
      skippedCount: true, warningCount: true, blockerCount: true, rejectedCount: true, appliedCount: true, approvedByUserId: true,
      approvedAt: true, version: true, createdAt: true, updatedAt: true, candidates: { orderBy: { sourceKey: "asc" } } } });
  invariant(batch, 404, "FINANCE_REPORT_IMPORT_NOT_FOUND", "The Finance report import was not found.");
  return { ...batch, candidates: batch.candidates.map((candidate) => present(candidate, now)) };
}

function reviewable(batch: { stage: string; version: number }, expectedVersion: number) {
  validVersion(expectedVersion);
  invariant(batch.stage === "READY_FOR_REVIEW" && batch.version === expectedVersion, 409, "FINANCE_REPORT_REVIEW_CONFLICT", "The Finance report import changed. Refresh and try again.");
}

function candidateVersions(candidates: FinanceImportCandidate[], supplied: Version[]) {
  const versions = new Map(supplied.map(({ id, expectedVersion }) => [id, expectedVersion]));
  invariant(versions.size === supplied.length && supplied.every(({ expectedVersion }) => (validVersion(expectedVersion), true)),
    400, "INVALID_INPUT", "Candidate versions must be unique and incrementable.");
  invariant(candidates.every(({ id, version }) => versions.get(id) === version), 409, "FINANCE_REPORT_REVIEW_CONFLICT", "A Finance report candidate changed. Refresh and try again.");
}

function normalizedPath(value: string[]) {
  const path = value.map((part) => part.normalize("NFKC").trim().replace(/\s+/gu, " "));
  invariant(path.length > 0 && path.length <= 100 && path.every((part) => part.length > 0 && part.length <= 500),
    400, "INVALID_INPUT", "The proposed account path is invalid.");
  return path;
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
    const batch = await tx.financeImportBatch.findUnique({ where: { id_workspaceId: { id: params.batchId, workspaceId: params.workspaceId } }, include: { candidates: true } });
    invariant(batch, 404, "FINANCE_REPORT_IMPORT_NOT_FOUND", "The Finance report import was not found.");
    reviewable(batch, params.expectedVersion);
    const target = batch.candidates.find(({ id }) => id === params.candidateId);
    invariant(target && target.version === params.expectedCandidateVersion, 409, "FINANCE_REPORT_REVIEW_CONFLICT", "The Finance report candidate changed. Refresh and try again.");
    invariant(target.factKind === "LEAF", 409, "FINANCE_REPORT_REVIEW_BLOCKED", "Derived rows are read-only validation results.");
    batch.candidates.forEach(({ version }) => validVersion(version));
    const edited = { ...target, proposedAccountPath: params.proposedAccountPath === undefined ? target.proposedAccountPath : normalizedPath(params.proposedAccountPath),
      amountCents: params.amountCents === undefined ? target.amountCents : normalizeFinanceImportAmountCents(params.amountCents),
      periodStart: params.periodStart === undefined ? target.periodStart : parseFinanceImportDate(params.periodStart, "Period start"),
      periodEnd: params.periodEnd === undefined ? target.periodEnd : parseFinanceImportDate(params.periodEnd, "Period end") };
    invariant(edited.periodStart <= edited.periodEnd, 400, "INVALID_INPUT", "Period start must not be after period end.");
    invariant(batch.reportType && batch.basis && batch.resolvedCurrency, 409, "FINANCE_REPORT_REVIEW_BLOCKED", "Resolve report classification and currency before review.");
    const rows = batch.candidates.map((candidate) => candidate.id === edited.id ? edited : candidate);
    const identity = { workspaceId: batch.workspaceId, reportType: batch.reportType, basis: batch.basis, currency: batch.resolvedCurrency };
    const keys = reconcileFinanceImportCandidates({ ...identity, candidates: rows, currentFacts: [] }).decisions.flatMap(({ semanticKey }) => semanticKey ? [semanticKey] : []);
    const facts = await tx.financeReportFact.findMany({ where: { workspaceId: batch.workspaceId, semanticKey: { in: keys } }, select: { id: true, semanticKey: true, kind: true, amountCents: true } });
    const result = reconcileFinanceImportCandidates({ ...identity, candidates: rows, currentFacts: facts });
    const now = new Date(); let warningCount = 0; let rejectedCount = 0;
    for (const decision of result.decisions) {
      const prior = batch.candidates.find(({ id }) => id === decision.candidate.id)!;
      const state: FinanceImportCandidateReviewState = decision.reviewState === "BLOCKED" ? "BLOCKED"
        : prior.id !== edited.id && prior.reviewState === "REJECTED" ? "REJECTED"
          : ["ADD", "UPDATE"].includes(decision.action) && historical(decision.candidate.periodEnd, now) ? "WARNING" : decision.reviewState;
      if (state === "WARNING") warningCount += 1; if (state === "REJECTED") rejectedCount += 1;
      const updated = await tx.financeImportCandidate.updateMany({ where: { id: prior.id, workspaceId: batch.workspaceId, batchId: batch.id, version: prior.version }, data: {
        ...(prior.id === edited.id ? { proposedAccountPath: edited.proposedAccountPath, amountCents: edited.amountCents, periodStart: edited.periodStart,
          periodEnd: edited.periodEnd, editedByUserId: actor.user.id, editedAt: now } : {}), semanticKey: decision.semanticKey, action: decision.action,
        reviewState: state, currentFactId: decision.currentFactId, currentAmountCents: decision.currentAmountCents, explanationMd: decision.explanationMd,
        approvedByUserId: null, approvedAt: null, version: { increment: 1 } } });
      invariant(updated.count === 1, 409, "FINANCE_REPORT_REVIEW_CONFLICT", "A Finance report candidate changed. Refresh and try again.");
    }
    const baseWarnings = parseFinanceImportInterpretationV1(batch.interpretationJson).exceptions.filter(({ code, severity }) => severity === "WARNING" && !code.startsWith("HISTORICAL_")).length;
    const reportingDates = rows.flatMap(({ periodStart, periodEnd }) => [periodStart.valueOf(), periodEnd.valueOf()]);
    const updated = await tx.financeImportBatch.updateMany({ where: { id: batch.id, workspaceId: batch.workspaceId, version: batch.version }, data: {
      ...result.counts, warningCount: baseWarnings + warningCount, blockerCount: result.counts.conflictCount, rejectedCount,
      periodStart: new Date(Math.min(...reportingDates)), periodEnd: new Date(Math.max(...reportingDates)),
      approvedByUserId: null, approvedAt: null, version: { increment: 1 } } });
    invariant(updated.count === 1, 409, "FINANCE_REPORT_REVIEW_CONFLICT", "The Finance report import changed. Refresh and try again.");
    await tx.auditLog.create({ data: { workspaceId: batch.workspaceId, actorUserId: actor.user.id, action: "finance-report-import.candidate-edited",
      entityType: "FinanceImportCandidate", entityId: target.id, meta: { batchId: batch.id, version: batch.version + 1 } } });
    return { batchId: batch.id, version: batch.version + 1, candidateId: target.id, candidateVersion: target.version + 1 };
  });
}

export async function reviewFinanceReportImport(actor: AppActor, params: { workspaceId: string; batchId: string; expectedVersion: number;
  mode: ReviewMode; candidateVersions: Version[]; candidateId?: string; acceptWarnings?: boolean }) {
  await requireFinanceReportImportHumanWriteAccess(actor, params.workspaceId);
  invariant(actor.kind === "user", 403, "HUMAN_REVIEW_REQUIRED", "A human Finance writer is required.");
  return prisma.$transaction(async (tx) => {
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${`finance-report-review:${params.workspaceId}:${params.batchId}`}, 0))`;
    const batch = await tx.financeImportBatch.findUnique({ where: { id_workspaceId: { id: params.batchId, workspaceId: params.workspaceId } }, include: { candidates: true } });
    invariant(batch, 404, "FINANCE_REPORT_IMPORT_NOT_FOUND", "The Finance report import was not found.");
    reviewable(batch, params.expectedVersion);
    const bulk = params.mode === "APPROVE_VERIFIED" || params.mode === "APPROVE_ALL";
    const supplied = bulk ? params.candidateVersions : params.candidateVersions.filter(({ id }) => id === params.candidateId);
    const scope = bulk ? batch.candidates : batch.candidates.filter(({ id }) => id === params.candidateId);
    invariant(scope.length > 0 && params.candidateVersions.length === supplied.length
      && (bulk ? supplied.length === batch.candidates.length : supplied.length === 1), 400, "INVALID_INPUT", "The review selection is invalid.");
    candidateVersions(scope, supplied);
    const now = new Date();
    if (params.mode === "APPROVE_ALL") {
      invariant(batch.blockerCount === 0 && !batch.candidates.some(({ reviewState }) => reviewState === "BLOCKED"), 409, "FINANCE_REPORT_REVIEW_BLOCKED", "Structural blockers cannot be approved.");
      invariant((batch.warningCount === 0 && !batch.candidates.some((candidate) => warning(candidate, now))) || params.acceptWarnings === true,
        409, "FINANCE_REPORT_WARNING_ACCEPTANCE_REQUIRED", "Explicitly accept report warnings before approving everything.");
    }
    invariant(scope.every(({ reviewState }) => reviewState !== "APPLIED"), 409, "FINANCE_REPORT_REVIEW_BLOCKED", "Applied candidates cannot be reviewed again.");
    const targets = scope.filter((candidate) => params.mode !== "APPROVE_VERIFIED"
      || (batch.warningCount === 0 && !warning(candidate, now) && !["APPROVED", "BLOCKED", "REJECTED"].includes(candidate.reviewState)));
    invariant(params.mode === "REJECT" || targets.every(({ reviewState }) => reviewState !== "BLOCKED"), 409, "FINANCE_REPORT_REVIEW_BLOCKED", "Structural blockers cannot be approved.");
    invariant(params.mode === "REJECT" || params.acceptWarnings === true || (batch.warningCount === 0 && targets.every((candidate) => !warning(candidate, now))),
      409, "FINANCE_REPORT_WARNING_ACCEPTANCE_REQUIRED", "Explicitly accept warnings before approval.");
    for (const candidate of targets) if (params.mode !== "REJECT" && candidate.action === "UPDATE" && historical(candidate.periodEnd, now)) {
      invariant(actor.user.id !== (candidate.editedByUserId ?? batch.uploadedByUserId), 409, "FINANCE_REPORT_PEER_CONFIRMATION_REQUIRED", "A different Finance writer must confirm this historical update.");
    }
    const targetIds = new Set(targets.map(({ id }) => id));
    for (const candidate of targets) {
      const approved = params.mode !== "REJECT";
      const updated = await tx.financeImportCandidate.updateMany({ where: { id: candidate.id, workspaceId: batch.workspaceId, batchId: batch.id, version: candidate.version }, data: {
        reviewState: approved ? "APPROVED" : "REJECTED", approvedByUserId: approved ? actor.user.id : null, approvedAt: approved ? now : null, version: { increment: 1 } } });
      invariant(updated.count === 1, 409, "FINANCE_REPORT_REVIEW_CONFLICT", "A Finance report candidate changed. Refresh and try again.");
    }
    const states = batch.candidates.map((candidate) => targetIds.has(candidate.id) ? (params.mode === "REJECT" ? "REJECTED" : "APPROVED") : candidate.reviewState);
    const complete = states.every((state) => ["APPROVED", "REJECTED", "VERIFIED"].includes(state));
    const rejectedCount = states.filter((state) => state === "REJECTED").length;
    const updated = await tx.financeImportBatch.updateMany({ where: { id: batch.id, workspaceId: batch.workspaceId, version: batch.version }, data: {
      rejectedCount, approvedByUserId: complete ? actor.user.id : null, approvedAt: complete ? now : null, version: { increment: 1 } } });
    invariant(updated.count === 1, 409, "FINANCE_REPORT_REVIEW_CONFLICT", "The Finance report import changed. Refresh and try again.");
    await tx.auditLog.create({ data: { workspaceId: batch.workspaceId, actorUserId: actor.user.id, action: `finance-report-import.review.${params.mode.toLowerCase()}`,
      entityType: "FinanceImportBatch", entityId: batch.id, meta: { version: batch.version + 1, reviewedCount: targets.length, complete } } });
    return { batchId: batch.id, version: batch.version + 1, reviewedCount: targets.length, rejectedCount, complete };
  });
}
