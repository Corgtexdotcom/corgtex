import { createHash } from "node:crypto";
import type { AppActor } from "@corgtex/shared";
import { prisma } from "@corgtex/shared";
import { Prisma, type FinanceImportApplicationOutcome } from "@prisma/client";
import { AppError, invariant } from "./errors";
import { requireFinanceReportImportHumanWriteAccess } from "./finance";
import { buildFinanceReportFactSemanticKey } from "./finance-import-reconciliation";
import { FINANCE_IMPORT_HISTORICAL_MONTHS } from "./finance-import-review";
import { buildFinanceImportApplicationIdempotencyKey, normalizeFinanceImportIsoCurrency } from "./finance-imports";

const MAX_VERSION = 2_147_483_647;
type Version = { id: string; expectedVersion: number };
type Fact = { id: string; reportId: string; accountPath: string[]; kind: "LEAF" | "DERIVED"; periodStart: Date; periodEnd: Date;
  amountCents: number; dimensions: Prisma.JsonValue | null; semanticKey: string; sourceBatchId: string; sourceCandidateId: string;
  appliedByUserId: string; version: number };
type Candidate = { id: string; sourceKey: string; proposedAccountPath: string[]; factKind: "LEAF" | "DERIVED"; periodStart: Date;
  periodEnd: Date; amountCents: number; dimensions: Prisma.JsonValue | null; action: "ADD" | "UPDATE" | "UNCHANGED" | "DUPLICATE" | "CONFLICT" | "SKIP";
  reviewState: string; semanticKey: string | null; currentFactId: string | null; currentAmountCents: number | null; editedByUserId: string | null; editedAt: Date | null;
  approvedByUserId: string | null; approvedAt: Date | null; version: number;
  application: { id: string; idempotencyKey: string; outcome: FinanceImportApplicationOutcome; targetFactId: string | null } | null };

function validVersion(value: number) {
  invariant(Number.isInteger(value) && value > 0 && value < MAX_VERSION, 400, "INVALID_INPUT", "An incrementable Finance import version is required.");
}
function canonicalJson(value: Prisma.JsonValue): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key]!)}`).join(",")}}`;
}
function hashJson(value: Prisma.JsonValue) { return createHash("sha256").update(canonicalJson(value)).digest("hex"); }
function date(value: Date) { return value.toISOString().slice(0, 10); }
function historical(periodEnd: Date, now: Date) { const cutoff = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate())); cutoff.setUTCMonth(cutoff.getUTCMonth() - FINANCE_IMPORT_HISTORICAL_MONTHS); return periodEnd < cutoff; }
async function retrySerializableConflict<T>(operation: () => Promise<T>) {
  try { return await operation(); } catch (error) {
    if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2034") return operation();
    throw error;
  }
}
function proposal(candidate: Candidate): Prisma.InputJsonObject {
  return { action: candidate.action, semanticKey: candidate.semanticKey, accountPath: candidate.proposedAccountPath, kind: candidate.factKind,
    periodStart: date(candidate.periodStart), periodEnd: date(candidate.periodEnd), amountCents: candidate.amountCents,
    dimensions: candidate.dimensions ?? null } as Prisma.InputJsonObject;
}
function factSnapshot(fact: Fact): Prisma.InputJsonObject {
  return { id: fact.id, reportId: fact.reportId, accountPath: fact.accountPath, kind: fact.kind, periodStart: date(fact.periodStart),
    periodEnd: date(fact.periodEnd), amountCents: fact.amountCents, dimensions: fact.dimensions ?? null, semanticKey: fact.semanticKey,
    sourceBatchId: fact.sourceBatchId, sourceCandidateId: fact.sourceCandidateId, appliedByUserId: fact.appliedByUserId,
    version: fact.version } as Prisma.InputJsonObject;
}
function applicationKey(workspaceId: string, batchId: string, candidate: Candidate, expectedVersion: number) {
  return buildFinanceImportApplicationIdempotencyKey({ workspaceId, batchId, candidateId: candidate.id,
    candidateVersion: expectedVersion, proposalHash: hashJson(proposal(candidate) as Prisma.JsonObject) });
}
const factSelect = { id: true, reportId: true, accountPath: true, kind: true, periodStart: true, periodEnd: true, amountCents: true,
  dimensions: true, semanticKey: true, sourceBatchId: true, sourceCandidateId: true, appliedByUserId: true, version: true } as const;

export async function applyFinanceReportImport(actor: AppActor, params: { workspaceId: string; batchId: string; expectedVersion: number;
  candidateVersions: Version[] }) {
  await requireFinanceReportImportHumanWriteAccess(actor, params.workspaceId);
  invariant(actor.kind === "user", 403, "HUMAN_APPLICATION_REQUIRED", "A human Finance writer is required.");
  validVersion(params.expectedVersion);
  const supplied = new Map(params.candidateVersions.map(({ id, expectedVersion }) => (validVersion(expectedVersion), [id, expectedVersion])));
  invariant(supplied.size === params.candidateVersions.length && supplied.size > 0 && supplied.size <= 1_000 && params.candidateVersions.every(({ id }) => id.length > 0 && id.length <= 100),
    400, "INVALID_INPUT", "Candidate versions must be unique and bounded.");
  try {
    return await retrySerializableConflict(() => prisma.$transaction(async (tx) => {
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${`finance-report-review:${params.workspaceId}:${params.batchId}`}, 0))`;
      const batch = await tx.financeImportBatch.findUnique({ where: { id_workspaceId: { id: params.batchId, workspaceId: params.workspaceId } },
        select: { id: true, workspaceId: true, uploadedByUserId: true, stage: true, reportType: true, basis: true, cadence: true, resolvedCurrency: true, periodStart: true,
          periodEnd: true, asOfDate: true, title: true, version: true, appliedCount: true, report: { select: { id: true } }, candidates: { orderBy: { sourceKey: "asc" },
            select: { id: true, sourceKey: true, proposedAccountPath: true, factKind: true, periodStart: true, periodEnd: true, amountCents: true,
              dimensions: true, action: true, reviewState: true, semanticKey: true, currentFactId: true, currentAmountCents: true, editedByUserId: true,
              editedAt: true, approvedByUserId: true, approvedAt: true, version: true,
              application: { select: { id: true, idempotencyKey: true, outcome: true, targetFactId: true } } } } } });
      invariant(batch, 404, "FINANCE_REPORT_IMPORT_NOT_FOUND", "The Finance report import was not found.");
      const candidates = batch.candidates as Candidate[];
      const selected = candidates.filter(({ id }) => supplied.has(id));
      invariant(selected.length === supplied.size, 400, "INVALID_INPUT", "Every candidate version must belong to this Finance report import.");
      const existing = selected.filter(({ application }) => application);
      for (const candidate of existing) invariant(candidate.reviewState === "APPLIED"
        && candidate.application!.idempotencyKey === applicationKey(batch.workspaceId, batch.id, candidate, supplied.get(candidate.id)!),
      409, "FINANCE_REPORT_APPLICATION_CONFLICT", "The Finance report application changed. Refresh and try again.");
      if (batch.stage === "APPLIED") {
        invariant(selected.length === 0 || existing.length === selected.length, 409, "FINANCE_REPORT_APPLICATION_CONFLICT", "The completed application does not match this request.");
        return { batchId: batch.id, version: batch.version, stage: batch.stage, appliedCount: batch.appliedCount,
          appliedNow: 0, noOp: true, receipts: candidates.flatMap(({ id, application }) => application ? [{ candidateId: id, ...application }] : []) };
      }
      const outstanding = selected.filter(({ application }) => !application);
      if (outstanding.length === 0 && selected.length > 0) return { batchId: batch.id, version: batch.version, stage: batch.stage,
        appliedCount: batch.appliedCount, appliedNow: 0, noOp: true, receipts: existing.map(({ id, application }) => ({ candidateId: id, ...application! })) };
      invariant(batch.version === params.expectedVersion && ["READY_FOR_REVIEW", "PARTIALLY_APPLIED"].includes(batch.stage),
        409, "FINANCE_REPORT_APPLICATION_CONFLICT", "The Finance report import changed. Refresh and try again.");
      const approved = candidates.filter(({ reviewState, application }) => reviewState === "APPROVED" && !application);
      invariant(outstanding.length > 0 && approved.length === outstanding.length && approved.every(({ id }) => supplied.has(id)),
        409, "FINANCE_REPORT_APPLICATION_BLOCKED", "Apply exactly the currently approved Finance report candidates.");
      for (const candidate of outstanding) {
        invariant(candidate.version === supplied.get(candidate.id), 409, "FINANCE_REPORT_APPLICATION_CONFLICT", "A Finance report candidate changed. Refresh and try again.");
        invariant(candidate.action !== "CONFLICT" && (candidate.factKind === "LEAF" || candidate.action === "SKIP"),
          409, "FINANCE_REPORT_APPLICATION_BLOCKED", "Only approved Reported Actuals facts or validation-only skips can be applied.");
      }
      invariant(batch.reportType && batch.basis && batch.cadence && batch.resolvedCurrency && batch.periodStart && batch.periodEnd && batch.title?.trim(),
        409, "FINANCE_REPORT_APPLICATION_BLOCKED", "Resolve the report identity, currency, dates, and title before applying.");
      const currency = normalizeFinanceImportIsoCurrency(batch.resolvedCurrency); const now = new Date();
      invariant(batch.periodStart <= batch.periodEnd, 409, "FINANCE_REPORT_APPLICATION_BLOCKED", "The report period is invalid.");
      for (const candidate of outstanding) {
        invariant(candidate.approvedByUserId && candidate.approvedAt, 409, "FINANCE_REPORT_APPLICATION_BLOCKED", "Every applied candidate needs a human approval receipt.");
        if (candidate.action === "UPDATE" && historical(candidate.periodEnd, now)) invariant(candidate.approvedByUserId !== (candidate.editedByUserId ?? batch.uploadedByUserId)
          && (!candidate.editedAt || candidate.approvedAt >= candidate.editedAt),
          409, "FINANCE_REPORT_APPLICATION_BLOCKED", "A different Finance writer must confirm the historical update.");
        if (candidate.action !== "SKIP") invariant(candidate.semanticKey === buildFinanceReportFactSemanticKey({ workspaceId: batch.workspaceId,
          reportType: batch.reportType, basis: batch.basis, currency, accountPath: candidate.proposedAccountPath, periodStart: candidate.periodStart,
          periodEnd: candidate.periodEnd, dimensions: candidate.dimensions }), 409, "FINANCE_REPORT_APPLICATION_CONFLICT", "The approved fact identity changed. Refresh and reconcile again.");
      }
      const report = await tx.financeReport.upsert({ where: { sourceBatchId: batch.id }, update: { reportType: batch.reportType, basis: batch.basis,
        cadence: batch.cadence, currency, periodStart: batch.periodStart, periodEnd: batch.periodEnd, asOfDate: batch.asOfDate,
        title: batch.title!, status: "ACTIVE", version: { increment: 1 } }, create: { workspaceId: batch.workspaceId, sourceBatchId: batch.id,
        reportType: batch.reportType, basis: batch.basis, cadence: batch.cadence, currency, periodStart: batch.periodStart,
        periodEnd: batch.periodEnd, asOfDate: batch.asOfDate, title: batch.title! }, select: { id: true } });
      const receipts = [];
      for (const candidate of outstanding) {
        let before: Prisma.InputJsonObject | null = null; let after: Prisma.InputJsonObject | null = null;
        let targetFactId: string | null = null; let outcome: FinanceImportApplicationOutcome;
        const desired = { reportId: report.id, accountPath: candidate.proposedAccountPath, kind: candidate.factKind as "LEAF", periodStart: candidate.periodStart,
          periodEnd: candidate.periodEnd, amountCents: candidate.amountCents, dimensions: candidate.dimensions ?? Prisma.JsonNull,
          semanticKey: candidate.semanticKey!, sourceBatchId: batch.id, sourceCandidateId: candidate.id, appliedByUserId: actor.user.id };
        if (candidate.action === "ADD") {
          invariant(candidate.semanticKey && !candidate.currentFactId, 409, "FINANCE_REPORT_APPLICATION_BLOCKED", "The approved addition identity is invalid.");
          invariant(!await tx.financeReportFact.findUnique({ where: { workspaceId_semanticKey: { workspaceId: batch.workspaceId, semanticKey: candidate.semanticKey } }, select: { id: true } }),
            409, "FINANCE_REPORT_APPLICATION_CONFLICT", "A Reported Actuals fact now occupies this identity. Refresh and reconcile again.");
          const created = await tx.financeReportFact.create({ data: { workspaceId: batch.workspaceId, ...desired }, select: factSelect });
          targetFactId = created.id; after = factSnapshot(created); outcome = "CREATED";
        } else if (["UPDATE", "UNCHANGED"].includes(candidate.action)) {
          invariant(candidate.semanticKey && candidate.currentFactId, 409, "FINANCE_REPORT_APPLICATION_BLOCKED", "The approved target identity is invalid.");
          const current = await tx.financeReportFact.findUnique({ where: { id_workspaceId: { id: candidate.currentFactId, workspaceId: batch.workspaceId } }, select: factSelect });
          invariant(current && current.semanticKey === candidate.semanticKey && current.amountCents === candidate.currentAmountCents,
            409, "FINANCE_REPORT_APPLICATION_CONFLICT", "The current Reported Actuals fact changed. Refresh and reconcile again.");
          targetFactId = current.id; before = factSnapshot(current);
          if (candidate.action === "UPDATE") {
            const updated = await tx.financeReportFact.updateMany({ where: { id: current.id, workspaceId: batch.workspaceId, version: current.version,
              semanticKey: current.semanticKey, amountCents: current.amountCents }, data: { ...desired, version: { increment: 1 } } });
            invariant(updated.count === 1, 409, "FINANCE_REPORT_APPLICATION_CONFLICT", "The current Reported Actuals fact changed. Refresh and reconcile again.");
            after = factSnapshot({ ...current, ...desired, dimensions: candidate.dimensions, version: current.version + 1 }); outcome = "UPDATED";
          } else { invariant(current.amountCents === candidate.amountCents, 409, "FINANCE_REPORT_APPLICATION_CONFLICT", "The unchanged fact no longer matches."); after = before; outcome = "UNCHANGED"; }
        } else if (candidate.action === "DUPLICATE") {
          invariant(candidate.semanticKey, 409, "FINANCE_REPORT_APPLICATION_BLOCKED", "The approved duplicate identity is invalid.");
          const target = await tx.financeReportFact.findUnique({ where: { workspaceId_semanticKey: { workspaceId: batch.workspaceId,
            semanticKey: candidate.semanticKey } }, select: factSelect });
          invariant(target && target.amountCents === candidate.amountCents, 409, "FINANCE_REPORT_APPLICATION_CONFLICT", "The duplicate target changed. Refresh and reconcile again.");
          targetFactId = target.id; before = factSnapshot(target); after = before; outcome = "SKIPPED";
        } else { invariant(candidate.action === "SKIP", 409, "FINANCE_REPORT_APPLICATION_BLOCKED", "The candidate action cannot be applied."); outcome = "SKIPPED"; }
        const key = applicationKey(batch.workspaceId, batch.id, candidate, candidate.version);
        const receipt = await tx.financeImportApplication.create({ data: { workspaceId: batch.workspaceId, batchId: batch.id, candidateId: candidate.id,
          idempotencyKey: key, targetType: "REPORT_FACT", targetFactId, beforeValueJson: before ?? Prisma.DbNull, afterValueJson: after ?? Prisma.DbNull,
          beforeValueHash: before ? hashJson(before as Prisma.JsonObject) : null, afterValueHash: after ? hashJson(after as Prisma.JsonObject) : null,
          outcome, appliedByUserId: actor.user.id, appliedAt: now }, select: { id: true, outcome: true, targetFactId: true, idempotencyKey: true } });
        const updated = await tx.financeImportCandidate.updateMany({ where: { id: candidate.id, workspaceId: batch.workspaceId, batchId: batch.id,
          version: candidate.version, reviewState: "APPROVED" }, data: { reviewState: "APPLIED", currentFactId: targetFactId,
          currentAmountCents: targetFactId ? candidate.amountCents : null, version: { increment: 1 } } });
        invariant(updated.count === 1, 409, "FINANCE_REPORT_APPLICATION_CONFLICT", "A Finance report candidate changed. Refresh and try again.");
        receipts.push({ candidateId: candidate.id, ...receipt });
      }
      const appliedIds = new Set(outstanding.map(({ id }) => id));
      const complete = candidates.every(({ id, reviewState }) => appliedIds.has(id) || ["APPLIED", "REJECTED"].includes(reviewState));
      const stage = complete ? "APPLIED" as const : "PARTIALLY_APPLIED" as const;
      const appliedCount = await tx.financeImportApplication.count({ where: { workspaceId: batch.workspaceId, batchId: batch.id } });
      const updated = await tx.financeImportBatch.updateMany({ where: { id: batch.id, workspaceId: batch.workspaceId, version: batch.version }, data: {
        stage, appliedCount, appliedByUserId: complete ? actor.user.id : null, appliedAt: complete ? now : null, version: { increment: 1 } } });
      invariant(updated.count === 1, 409, "FINANCE_REPORT_APPLICATION_CONFLICT", "The Finance report import changed. Refresh and try again.");
      await tx.auditLog.create({ data: { workspaceId: batch.workspaceId, actorUserId: actor.user.id, action: "finance-report-import.applied",
        entityType: "FinanceImportBatch", entityId: batch.id, meta: { version: batch.version + 1, stage, appliedNow: receipts.length, appliedCount } } });
      return { batchId: batch.id, version: batch.version + 1, stage, appliedCount, appliedNow: receipts.length, noOp: false, receipts };
    }, { isolationLevel: Prisma.TransactionIsolationLevel.Serializable }));
  } catch (error) {
    if (error instanceof Prisma.PrismaClientKnownRequestError && ["P2002", "P2034"].includes(error.code)) {
      throw new AppError(409, "FINANCE_REPORT_APPLICATION_CONFLICT", "The Finance report application changed. Refresh and try again.");
    }
    throw error;
  }
}
