import { createHash } from "node:crypto";
import type { AppActor } from "@corgtex/shared";
import { prisma } from "@corgtex/shared";
import type { FinanceAccountingBasis, FinanceImportCandidateAction, FinanceImportCandidateReviewState, FinanceReportType, Prisma } from "@prisma/client";
import { invariant } from "./errors";
import { requireFinanceReportImportHumanWriteAccess } from "./finance";
import { parseFinanceImportInterpretationV1 } from "./finance-import-interpretation";
import { normalizeFinanceImportIsoCurrency } from "./finance-imports";

type Candidate = { id?: string; sourceKey: string; version?: number; proposedAccountPath: string[]; factKind: "LEAF" | "DERIVED";
  periodStart: Date; periodEnd: Date; amountCents: number; dimensions?: Prisma.JsonValue | null; proposalJson?: unknown };
type CurrentFact = { id: string; semanticKey: string; kind: "LEAF" | "DERIVED"; amountCents: number };
export type FinanceImportReconciliationDecision = { candidate: Candidate; semanticKey: string | null; action: FinanceImportCandidateAction;
  reviewState: FinanceImportCandidateReviewState; currentFactId: string | null; currentAmountCents: number | null; explanationMd: string | null };

function canonicalJson(value: Prisma.JsonValue | null): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key]!)}`).join(",")}}`;
}

function normalizedPath(path: string[]) {
  const result = path.map((part) => part.normalize("NFKC").trim().replace(/\s+/gu, " ").toLocaleLowerCase("en-US"));
  invariant(result.length > 0 && result.every(Boolean), 400, "INVALID_FINANCE_IMPORT_IDENTITY", "Finance report account path is ambiguous.");
  return result;
}

function dateOnly(value: Date) {
  invariant(!Number.isNaN(value.valueOf()), 400, "INVALID_FINANCE_IMPORT_IDENTITY", "Finance report period is invalid.");
  return value.toISOString().slice(0, 10);
}

export function buildFinanceReportFactSemanticKey(params: { workspaceId: string; reportType: FinanceReportType;
  basis: FinanceAccountingBasis; currency: string; accountPath: string[]; periodStart: Date; periodEnd: Date; dimensions?: Prisma.JsonValue | null }) {
  invariant(params.periodStart <= params.periodEnd, 400, "INVALID_FINANCE_IMPORT_IDENTITY", "Finance report period is reversed.");
  const identity = ["finance-report-fact/v1", params.workspaceId.trim(), params.reportType, params.basis,
    normalizeFinanceImportIsoCurrency(params.currency), normalizedPath(params.accountPath), dateOnly(params.periodStart), dateOnly(params.periodEnd),
    canonicalJson(params.dimensions ?? null)];
  invariant(identity[1], 400, "INVALID_FINANCE_IMPORT_IDENTITY", "Finance report workspace is required.");
  return createHash("sha256").update(JSON.stringify(identity)).digest("hex");
}

const outcome = (candidate: Candidate, semanticKey: string | null, action: FinanceImportCandidateAction,
  current: CurrentFact | null = null, explanationMd: string | null = null): FinanceImportReconciliationDecision => ({ candidate, semanticKey, action,
    reviewState: action === "CONFLICT" ? "BLOCKED" : ["UNCHANGED", "DUPLICATE", "SKIP"].includes(action) ? "VERIFIED" : "PROPOSED",
    currentFactId: current?.id ?? null, currentAmountCents: current?.amountCents ?? null, explanationMd });

export function reconcileFinanceImportCandidates(params: { workspaceId: string; reportType: FinanceReportType; basis: FinanceAccountingBasis;
  currency: string; candidates: Candidate[]; currentFacts: CurrentFact[] }) {
  const facts = new Map(params.currentFacts.map((fact) => [fact.semanticKey, fact]));
  const keyed = params.candidates.map((candidate) => {
    if (candidate.factKind === "DERIVED") return outcome(candidate, null, "SKIP", null, "Derived rows are validation-only and are not canonical Reported Actuals.");
    try {
      const semanticKey = buildFinanceReportFactSemanticKey({ ...params, accountPath: candidate.proposedAccountPath,
        periodStart: candidate.periodStart, periodEnd: candidate.periodEnd, dimensions: candidate.dimensions });
      return { candidate, semanticKey };
    } catch { return outcome(candidate, null, "CONFLICT", null, "The proposed fact identity is ambiguous."); }
  });
  const groups = new Map<string, Candidate[]>();
  for (const item of keyed) if (!("action" in item)) groups.set(item.semanticKey, [...(groups.get(item.semanticKey) ?? []), item.candidate]);
  const decisions = keyed.filter((item): item is FinanceImportReconciliationDecision => "action" in item);
  for (const [semanticKey, unsorted] of groups) {
    const candidates = [...unsorted].sort((left, right) => left.sourceKey < right.sourceKey ? -1 : left.sourceKey > right.sourceKey ? 1 : 0);
    const current = facts.get(semanticKey) ?? null;
    if (new Set(candidates.map(({ amountCents }) => amountCents)).size > 1 || (current && current.kind !== "LEAF")) {
      decisions.push(...candidates.map((candidate) => outcome(candidate, semanticKey, "CONFLICT", current,
        "Multiple facts claim this identity with incompatible values or kinds.")));
      continue;
    }
    const first = candidates[0]!;
    decisions.push(outcome(first, semanticKey, !current ? "ADD" : current.amountCents === first.amountCents ? "UNCHANGED" : "UPDATE", current,
      current && current.amountCents !== first.amountCents ? `Restatement from ${current.amountCents} to ${first.amountCents} cents.` : null));
    decisions.push(...candidates.slice(1).map((candidate) => outcome(candidate, semanticKey, "DUPLICATE", current,
      "Equivalent source lines resolve to the same semantic fact.")));
  }
  const counts = { addCount: 0, updateCount: 0, unchangedCount: 0, duplicateCount: 0, conflictCount: 0, skippedCount: 0 };
  const countKey = { ADD: "addCount", UPDATE: "updateCount", UNCHANGED: "unchangedCount", DUPLICATE: "duplicateCount",
    CONFLICT: "conflictCount", SKIP: "skippedCount" } as const;
  for (const decision of decisions) counts[countKey[decision.action]] += 1;
  return { decisions, counts };
}

export async function rerunFinanceReportImportReconciliation(actor: AppActor, params: { workspaceId: string; batchId: string;
  expectedVersion: number; candidateVersions: Array<{ id: string; expectedVersion: number }>; confirmedCurrency: string; confirmedAmountScale: number }) {
  await requireFinanceReportImportHumanWriteAccess(actor, params.workspaceId);
  invariant(actor.kind === "user", 403, "HUMAN_REVIEW_REQUIRED", "A human Finance writer is required.");
  const currency = normalizeFinanceImportIsoCurrency(params.confirmedCurrency, "Confirmed currency");
  return prisma.$transaction(async (tx) => {
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${`finance-report-import:${params.workspaceId}:${params.batchId}`}, 0))`;
    const batch = await tx.financeImportBatch.findUnique({ where: { id_workspaceId: { id: params.batchId, workspaceId: params.workspaceId } }, include: { candidates: true } });
    invariant(batch, 404, "FINANCE_REPORT_IMPORT_NOT_FOUND", "The Finance report import was not found.");
    invariant(batch.version === params.expectedVersion && ["RECONCILING", "READY_FOR_REVIEW", "NEEDS_INPUT"].includes(batch.stage),
      409, "FINANCE_REPORT_RECONCILIATION_CONFLICT", "The Finance report import changed. Refresh and try again.");
    const proposalEvent = await tx.event.findFirst({ where: { workspaceId: batch.workspaceId, type: "finance-report-import.proposed",
      aggregateType: "FinanceImportBatch", aggregateId: batch.id }, orderBy: { createdAt: "desc" }, select: { payload: true } });
    const payload = proposalEvent?.payload;
    const legacySnapshot = batch.stage === "RECONCILING" && payload !== null && payload !== undefined && typeof payload === "object" && !Array.isArray(payload)
      && payload.version === batch.version && payload.stage === "RECONCILING" && payload.candidateCount === batch.candidates.length;
    const interpretation = parseFinanceImportInterpretationV1(batch.interpretationJson);
    const numericFormat = interpretation.numericFormat.status === "RESOLVED" ? { version: interpretation.numericFormat.version, decimalSeparator: interpretation.numericFormat.decimalSeparator,
      groupingSeparator: interpretation.numericFormat.groupingSeparator,
      amountScale: interpretation.numericFormat.amountScale } : null;
    invariant(numericFormat && numericFormat.amountScale === params.confirmedAmountScale
      && !interpretation.exceptions.some(({ severity }) => severity === "BLOCKER") && batch.candidates.length > 0
      && batch.candidates.every(({ proposalJson }) => proposalJson && typeof proposalJson === "object" && !Array.isArray(proposalJson)
        && ("numericFormat" in proposalJson ? canonicalJson((proposalJson as Record<string, Prisma.JsonValue>).numericFormat ?? null) === canonicalJson(numericFormat) : legacySnapshot)),
    409, "FINANCE_REPORT_CLARIFICATION_REQUIRED", "Resolve the report structure, numeric format, scale, and candidate amounts before reconciliation.");
    const versions = new Map(params.candidateVersions.map(({ id, expectedVersion }) => [id, expectedVersion]));
    invariant(params.candidateVersions.length === batch.candidates.length && versions.size === batch.candidates.length
      && batch.candidates.every(({ id, version }) => versions.get(id) === version),
      409, "FINANCE_REPORT_RECONCILIATION_CONFLICT", "A Finance report candidate changed. Refresh and try again.");
    const identity = { workspaceId: batch.workspaceId, reportType: interpretation.classification.reportType,
      basis: interpretation.classification.basis, currency };
    const reportingDates = batch.candidates.flatMap(({ periodStart, periodEnd }) => [periodStart, periodEnd]).map((date) => date.valueOf());
    const preliminary = reconcileFinanceImportCandidates({ ...identity, candidates: batch.candidates, currentFacts: [] });
    const keys = preliminary.decisions.flatMap(({ semanticKey }) => semanticKey ? [semanticKey] : []);
    const currentFacts = await tx.financeReportFact.findMany({ where: { workspaceId: batch.workspaceId, semanticKey: { in: keys } },
      select: { id: true, semanticKey: true, kind: true, amountCents: true } });
    const result = reconcileFinanceImportCandidates({ ...identity, candidates: batch.candidates, currentFacts });
    for (const decision of result.decisions) {
      const updated = await tx.financeImportCandidate.updateMany({ where: { id: decision.candidate.id!, workspaceId: batch.workspaceId,
        batchId: batch.id, version: decision.candidate.version! }, data: { semanticKey: decision.semanticKey, action: decision.action,
        reviewState: decision.reviewState, currentFactId: decision.currentFactId, currentAmountCents: decision.currentAmountCents,
        explanationMd: decision.explanationMd, approvedByUserId: null, approvedAt: null, version: { increment: 1 } } });
      invariant(updated.count === 1, 409, "FINANCE_REPORT_RECONCILIATION_CONFLICT", "A Finance report candidate changed. Refresh and try again.");
    }
    const updated = await tx.financeImportBatch.updateMany({ where: { id: batch.id, workspaceId: batch.workspaceId, version: batch.version }, data: {
      stage: "READY_FOR_REVIEW", currencyState: "RESOLVED", resolvedCurrency: currency, currencyResolutionSource: "USER_CONFIRMED",
      reportType: identity.reportType, basis: identity.basis, cadence: interpretation.classification.cadence,
      periodStart: new Date(Math.min(...reportingDates)), periodEnd: new Date(Math.max(...reportingDates)),
      warningCount: interpretation.exceptions.filter(({ severity }) => severity === "WARNING").length,
      currencyConfirmedByUserId: actor.user.id, currencyConfirmedAt: new Date(), ...result.counts, blockerCount: result.counts.conflictCount,
      approvedByUserId: null, approvedAt: null, safeErrorCode: null, safeErrorMessage: null, version: { increment: 1 } } });
    invariant(updated.count === 1, 409, "FINANCE_REPORT_RECONCILIATION_CONFLICT", "The Finance report import changed. Refresh and try again.");
    await tx.event.create({ data: { workspaceId: batch.workspaceId, type: "finance-report-import.reconciled", aggregateType: "FinanceImportBatch",
      aggregateId: batch.id, payload: { batchId: batch.id, version: batch.version + 1, ...result.counts } } });
    await tx.auditLog.create({ data: { workspaceId: batch.workspaceId, actorUserId: actor.user.id, action: "finance-report-import.reconciled",
      entityType: "FinanceImportBatch", entityId: batch.id, meta: { version: batch.version + 1, ...result.counts } } });
    return { batchId: batch.id, version: batch.version + 1, stage: "READY_FOR_REVIEW" as const, ...result.counts };
  });
}
