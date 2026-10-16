import { createHash } from "node:crypto";
import type { AppActor } from "@corgtex/shared";
import { prisma } from "@corgtex/shared";
import { Prisma, type FinanceImportApplicationOutcome } from "@prisma/client";
import { captureArtifactInputProof, captureImmutableArtifactInputProof, recordArtifactInputLineage, type LineageKind, type LineageRoot } from "./source-lineage";
import { AppError, invariant } from "./errors";
import { requireFinanceReportImportHumanWriteAccess } from "./finance";
import { buildFinanceReportFactSemanticKey, captureFinanceCurrentFactValues } from "./finance-import-reconciliation";
import { publishFinanceFactRevision } from "./finance-fact-revisions";
import { financeRevisionValue } from "./finance-fact-value";
import { FINANCE_IMPORT_HISTORICAL_MONTHS } from "./finance-import-review";
import { buildFinanceImportApplicationIdempotencyKey, normalizeFinanceImportIsoCurrency } from "./finance-imports";

const MAX_VERSION = 2_147_483_647;
type Version = { id: string; expectedVersion: number };
type Candidate = { id: string; sourceKey: string; proposedAccountPath: string[]; factKind: "LEAF" | "DERIVED"; periodStart: Date;
  periodEnd: Date; amountCents: number; dimensions: Prisma.JsonValue | null; action: "ADD" | "UPDATE" | "UNCHANGED" | "DUPLICATE" | "CONFLICT" | "SKIP";
  reviewState: string; semanticKey: string | null; currentFactId: string | null; currentFactRevisionId: string | null; currentAmountCents: number | null; editedByUserId: string | null; editedAt: Date | null;
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
function serializableConflict(error: unknown) {
  return error instanceof Prisma.PrismaClientKnownRequestError
    && (error.code === "P2034" || (error.code === "P2010" && error.meta?.code === "40001"));
}
async function retrySerializableConflict<T>(operation: () => Promise<T>) {
  try { return await operation(); } catch (error) {
    if (serializableConflict(error)) return operation();
    throw error;
  }
}
function proposal(candidate: Candidate): Prisma.InputJsonObject {
  return { action: candidate.action, semanticKey: candidate.semanticKey, accountPath: candidate.proposedAccountPath, kind: candidate.factKind,
    periodStart: date(candidate.periodStart), periodEnd: date(candidate.periodEnd), amountCents: candidate.amountCents,
    dimensions: candidate.dimensions ?? null } as Prisma.InputJsonObject;
}
function applicationKey(workspaceId: string, batchId: string, candidate: Candidate, expectedVersion: number) {
  return buildFinanceImportApplicationIdempotencyKey({ workspaceId, batchId, candidateId: candidate.id,
    candidateVersion: expectedVersion, proposalHash: hashJson(proposal(candidate) as Prisma.JsonObject) });
}
function applicationSummary(row: { id: string; idempotencyKey: string; outcome: FinanceImportApplicationOutcome; targetFactId: string | null }) {
  return { id: row.id, idempotencyKey: row.idempotencyKey, outcome: row.outcome, targetFactId: row.targetFactId };
}
async function recordOutput(tx: Prisma.TransactionClient, actor: AppActor, workspaceId: string, kind: LineageKind,
  row: { id: string }, roots: LineageRoot[]) {
  await recordArtifactInputLineage({ tx, actor, workspaceId, artifact: { kind, id: row.id }, content: row,
    origin: "DERIVED", inputs: [], inheritedRoots: roots });
  return captureImmutableArtifactInputProof(actor, workspaceId,
    await captureArtifactInputProof(actor, workspaceId, [{ kind, id: row.id, snapshot: row }], tx), tx);
}

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
        include: { report: true, candidates: { orderBy: [{ sourceKey: "asc" }, { id: "asc" }], take: 5001,
          include: { application: true } } } });
      invariant(batch, 404, "FINANCE_REPORT_IMPORT_NOT_FOUND", "The Finance report import was not found.");
      invariant(batch.candidates.length <= 5000, 413, "FINANCE_READ_BUDGET", "Narrow the Finance import selection.");
      await requireFinanceReportImportHumanWriteAccess(actor, params.workspaceId);
      const inputRoots = await captureArtifactInputProof(actor, params.workspaceId, [
        { kind: "FinanceImportBatch", id: batch.id, snapshot: batch },
        ...batch.candidates.map(row => ({ kind: "FinanceImportCandidate" as const, id: row.id, snapshot: row })),
        ...batch.candidates.flatMap(row => row.application ? [{ kind: "FinanceImportApplication" as const, id: row.application.id, snapshot: row.application }] : []),
        ...(batch.report ? [{ kind: "FinanceReport" as const, id: batch.report.id, snapshot: batch.report }] : []),
      ], tx);
      const candidates = batch.candidates as Candidate[];
      const selected = candidates.filter(({ id }) => supplied.has(id));
      invariant(selected.length === supplied.size, 400, "INVALID_INPUT", "Every candidate version must belong to this Finance report import.");
      const existing = selected.filter(({ application }) => application);
      for (const candidate of existing) {
        const appliedVersion = candidate.version - 1; const requestedVersion = supplied.get(candidate.id)!;
        invariant(candidate.reviewState === "APPLIED" && appliedVersion > 0 && [appliedVersion, candidate.version].includes(requestedVersion)
          && candidate.application!.idempotencyKey === applicationKey(batch.workspaceId, batch.id, candidate, appliedVersion),
        409, "FINANCE_REPORT_APPLICATION_CONFLICT", "The Finance report application changed. Refresh and try again.");
      }
      if (batch.stage === "APPLIED") {
        invariant(selected.length === 0 || existing.length === selected.length, 409, "FINANCE_REPORT_APPLICATION_CONFLICT", "The completed application does not match this request.");
        return { batchId: batch.id, version: batch.version, stage: batch.stage, appliedCount: candidates.filter(row => row.application).length,
          appliedNow: 0, noOp: true, receipts: candidates.flatMap(({ id, application }) => application ? [{ candidateId: id, ...applicationSummary(application) }] : []) };
      }
      const outstanding = selected.filter(({ application }) => !application);
      if (outstanding.length === 0 && selected.length > 0) return { batchId: batch.id, version: batch.version, stage: batch.stage,
        appliedCount: candidates.filter(row => row.application).length, appliedNow: 0, noOp: true, receipts: existing.map(({ id, application }) => ({ candidateId: id, ...applicationSummary(application!) })) };
      invariant(batch.version === params.expectedVersion && ["READY_FOR_REVIEW", "PARTIALLY_APPLIED"].includes(batch.stage),
        409, "FINANCE_REPORT_APPLICATION_CONFLICT", "The Finance report import changed. Refresh and try again.");
      invariant(outstanding.length > 0 && outstanding.every(({ reviewState }) => reviewState === "APPROVED"),
        409, "FINANCE_REPORT_APPLICATION_BLOCKED", "Apply exactly the currently approved Finance report candidates.");
      for (const candidate of outstanding) {
        invariant(candidate.version === supplied.get(candidate.id), 409, "FINANCE_REPORT_APPLICATION_CONFLICT", "A Finance report candidate changed. Refresh and try again.");
        invariant(candidate.action !== "CONFLICT" && (candidate.factKind === "LEAF" || candidate.action === "SKIP"),
          409, "FINANCE_REPORT_APPLICATION_BLOCKED", "Only approved Reported Actuals facts or validation-only skips can be applied.");
      }
      invariant(batch.reportType && batch.basis && batch.cadence && batch.resolvedCurrency && batch.periodStart && batch.periodEnd,
        409, "FINANCE_REPORT_APPLICATION_BLOCKED", "Resolve the report identity, currency, and dates before applying.");
      const title = (batch.title?.trim() || batch.originalFilename.trim()).slice(0, 200); invariant(title, 409, "FINANCE_REPORT_APPLICATION_BLOCKED", "Resolve the report title before applying.");
      const currency = normalizeFinanceImportIsoCurrency(batch.resolvedCurrency); const now = new Date();
      invariant(batch.periodStart <= batch.periodEnd, 409, "FINANCE_REPORT_APPLICATION_BLOCKED", "The report period is invalid.");
      for (const candidate of outstanding) {
        invariant(candidate.approvedByUserId && candidate.approvedAt, 409, "FINANCE_REPORT_APPLICATION_BLOCKED", "Every applied candidate needs a human approval receipt.");
        if (["ADD", "UPDATE"].includes(candidate.action) && historical(candidate.periodEnd, now)) invariant(historical(candidate.periodEnd, candidate.approvedAt),
          409, "FINANCE_REPORT_APPLICATION_BLOCKED", "A Finance writer must explicitly accept the current historical warning.");
        if (candidate.action === "UPDATE" && historical(candidate.periodEnd, now)) invariant(candidate.approvedByUserId !== (candidate.editedByUserId ?? batch.uploadedByUserId)
          && (!candidate.editedAt || candidate.approvedAt >= candidate.editedAt),
          409, "FINANCE_REPORT_APPLICATION_BLOCKED", "A different Finance writer must confirm the historical update.");
        if (candidate.action !== "SKIP") invariant(candidate.semanticKey === buildFinanceReportFactSemanticKey({ workspaceId: batch.workspaceId,
          reportType: batch.reportType, basis: batch.basis, currency, accountPath: candidate.proposedAccountPath, periodStart: candidate.periodStart,
          periodEnd: candidate.periodEnd, dimensions: candidate.dimensions }), 409, "FINANCE_REPORT_APPLICATION_CONFLICT", "The approved fact identity changed. Refresh and reconcile again.");
      }
      const sourceFacts = await tx.financeReportFact.findMany({ where: { workspaceId: params.workspaceId,
        semanticKey: { in: outstanding.flatMap(row => row.semanticKey ? [row.semanticKey] : []) } }, orderBy: { id: "asc" }, take: 5001 });
      invariant(sourceFacts.length <= 5000, 413, "FINANCE_READ_BUDGET", "Narrow the Finance import selection.");
      const currentValues = await captureFinanceCurrentFactValues(tx, actor, params.workspaceId, sourceFacts);
      const factRoots = currentValues.roots;
      const revisionsByFact = new Map(currentValues.revisions.map(row => [row.factId, row]));
      const frozenRoots = await captureImmutableArtifactInputProof(actor, params.workspaceId, [...inputRoots, ...factRoots], tx);
      const factsByKey = new Map(currentValues.facts.map(row => [row.semanticKey, row]));
      const report = await tx.financeReport.upsert({ where: { sourceBatchId: batch.id }, update: { reportType: batch.reportType, basis: batch.basis,
        cadence: batch.cadence, currency, periodStart: batch.periodStart, periodEnd: batch.periodEnd, asOfDate: batch.asOfDate,
        title, status: "ACTIVE", version: { increment: 1 } }, create: { workspaceId: batch.workspaceId, sourceBatchId: batch.id,
        reportType: batch.reportType, basis: batch.basis, cadence: batch.cadence, currency, periodStart: batch.periodStart,
        periodEnd: batch.periodEnd, asOfDate: batch.asOfDate, title } });
      const reportRoots = await recordOutput(tx, actor, params.workspaceId, "FinanceReport", report, frozenRoots);
      const receipts = [];
      for (const candidate of outstanding) {
        const outputRoots = [...frozenRoots, ...reportRoots];
        let before: Prisma.InputJsonObject | null = null; let after: Prisma.InputJsonObject | null = null;
        let beforeRevisionId: string | null = null; let afterRevisionId: string | null = null;
        let targetFactId: string | null = null; let outcome: FinanceImportApplicationOutcome;
        const desired = { reportId: report.id, accountPath: candidate.proposedAccountPath, kind: candidate.factKind as "LEAF", periodStart: candidate.periodStart,
          periodEnd: candidate.periodEnd, amountCents: candidate.amountCents, dimensions: candidate.dimensions ?? Prisma.JsonNull,
          semanticKey: candidate.semanticKey!, sourceBatchId: batch.id, sourceCandidateId: candidate.id, appliedByUserId: actor.user.id };
        if (candidate.action === "ADD") {
          invariant(candidate.semanticKey && !candidate.currentFactId, 409, "FINANCE_REPORT_APPLICATION_BLOCKED", "The approved addition identity is invalid.");
          invariant(!factsByKey.has(candidate.semanticKey),
            409, "FINANCE_REPORT_APPLICATION_CONFLICT", "A Reported Actuals fact now occupies this identity. Refresh and reconcile again.");
          const created = await tx.financeReportFact.create({ data: { workspaceId: batch.workspaceId, ...desired } });
          const published = await publishFinanceFactRevision(tx, actor, created, candidate, outputRoots);
          outputRoots.push(...published.roots);
          await recordOutput(tx, actor, params.workspaceId, "FinanceReportFact", created, published.roots);
          factsByKey.set(created.semanticKey, { ...created, currentFactRevisionId: published.revision.id });
          revisionsByFact.set(created.id, published.revision);
          targetFactId = created.id; after = published.value; afterRevisionId = published.revision.id; outcome = "CREATED";
        } else if (["UPDATE", "UNCHANGED"].includes(candidate.action)) {
          invariant(candidate.semanticKey && candidate.currentFactId, 409, "FINANCE_REPORT_APPLICATION_BLOCKED", "The approved target identity is invalid.");
          const current = factsByKey.get(candidate.semanticKey);
          invariant(current && current.id === candidate.currentFactId && current.semanticKey === candidate.semanticKey && current.amountCents === candidate.currentAmountCents
            && current.currentFactRevisionId === candidate.currentFactRevisionId,
            409, "FINANCE_REPORT_APPLICATION_CONFLICT", "The current Reported Actuals fact changed. Refresh and reconcile again.");
          targetFactId = current.id;
          const beforeRevision = revisionsByFact.get(current.id)!;
          before = financeRevisionValue(beforeRevision); beforeRevisionId = beforeRevision.id;
          if (candidate.action === "UNCHANGED") invariant(current.amountCents === candidate.amountCents, 409, "FINANCE_REPORT_APPLICATION_CONFLICT", "The unchanged fact no longer matches.");
          const updated = await tx.financeReportFact.updateMany({ where: { id: current.id, workspaceId: batch.workspaceId, version: current.version,
            semanticKey: current.semanticKey, amountCents: current.amountCents }, data: { ...desired, version: { increment: 1 } } });
          invariant(updated.count === 1, 409, "FINANCE_REPORT_APPLICATION_CONFLICT", "The current Reported Actuals fact changed. Refresh and reconcile again.");
          const changed = await tx.financeReportFact.findUniqueOrThrow({ where: { id_workspaceId: { id: current.id, workspaceId: params.workspaceId } } });
          const published = await publishFinanceFactRevision(tx, actor, changed, candidate, outputRoots);
          outputRoots.push(...published.roots);
          await recordOutput(tx, actor, params.workspaceId, "FinanceReportFact", changed, published.roots);
          factsByKey.set(changed.semanticKey, { ...changed, currentFactRevisionId: published.revision.id });
          revisionsByFact.set(changed.id, published.revision);
          after = published.value; afterRevisionId = published.revision.id; outcome = candidate.action === "UPDATE" ? "UPDATED" : "UNCHANGED";
        } else if (candidate.action === "DUPLICATE") {
          invariant(candidate.semanticKey, 409, "FINANCE_REPORT_APPLICATION_BLOCKED", "The approved duplicate identity is invalid.");
          const target = factsByKey.get(candidate.semanticKey);
          invariant(target, 409, "FINANCE_REPORT_APPLICATION_CONFLICT", "The duplicate needs a verified existing revision.");
          invariant(target.amountCents === candidate.amountCents, 409, "FINANCE_REPORT_APPLICATION_CONFLICT", "The duplicate target changed. Refresh and reconcile again.");
          const revision = revisionsByFact.get(target.id)!;
          invariant(revision, 409, "FINANCE_REPORT_SOURCE_NOT_READY", "The duplicate needs a verified existing revision.");
          targetFactId = target.id; before = financeRevisionValue(revision); after = before;
          beforeRevisionId = revision.id; afterRevisionId = revision.id;
          outputRoots.push(...await captureImmutableArtifactInputProof(actor, params.workspaceId, await captureArtifactInputProof(actor, params.workspaceId, [{ kind: "FinanceReportFactRevision", id: revision.id, snapshot: revision }], tx), tx));
          outcome = "SKIPPED";
        } else { invariant(candidate.action === "SKIP", 409, "FINANCE_REPORT_APPLICATION_BLOCKED", "The candidate action cannot be applied."); outcome = "SKIPPED"; }
        const key = applicationKey(batch.workspaceId, batch.id, candidate, candidate.version);
        const receipt = await tx.financeImportApplication.create({ data: { workspaceId: batch.workspaceId, batchId: batch.id, candidateId: candidate.id,
          idempotencyKey: key, targetType: "REPORT_FACT", targetFactId, beforeRevisionId, afterRevisionId, beforeValueJson: before ?? Prisma.DbNull, afterValueJson: after ?? Prisma.DbNull,
          beforeValueHash: before ? hashJson(before as Prisma.JsonObject) : null, afterValueHash: after ? hashJson(after as Prisma.JsonObject) : null,
          outcome, appliedByUserId: actor.user.id, appliedAt: now } });
        const receiptRoots = await recordOutput(tx, actor, params.workspaceId, "FinanceImportApplication", receipt, outputRoots);
        const updated = await tx.financeImportCandidate.updateMany({ where: { id: candidate.id, workspaceId: batch.workspaceId, batchId: batch.id,
          version: candidate.version, reviewState: "APPROVED" }, data: { reviewState: "APPLIED", currentFactId: targetFactId,
          currentAmountCents: targetFactId ? candidate.amountCents : null, version: { increment: 1 } } });
        invariant(updated.count === 1, 409, "FINANCE_REPORT_APPLICATION_CONFLICT", "A Finance report candidate changed. Refresh and try again.");
        const currentCandidate = await tx.financeImportCandidate.findUniqueOrThrow({ where: { id_workspaceId: { id: candidate.id, workspaceId: params.workspaceId } } });
        await recordOutput(tx, actor, params.workspaceId, "FinanceImportCandidate", currentCandidate, [...outputRoots, ...receiptRoots]);
        receipts.push({ candidateId: candidate.id, ...applicationSummary(receipt) });
      }
      const appliedIds = new Set(outstanding.map(({ id }) => id));
      const complete = candidates.every(({ id, reviewState }) => appliedIds.has(id) || ["APPLIED", "REJECTED"].includes(reviewState));
      const stage = complete ? "APPLIED" as const : "PARTIALLY_APPLIED" as const;
      const applications = await tx.financeImportApplication.findMany({ where: { workspaceId: batch.workspaceId, batchId: batch.id }, orderBy: { id: "asc" }, take: 5001 });
      invariant(applications.length <= 5000, 413, "FINANCE_READ_BUDGET", "Narrow the Finance import selection.");
      const applicationRoots = await captureArtifactInputProof(actor, params.workspaceId,
        applications.map(row => ({ kind: "FinanceImportApplication" as const, id: row.id, snapshot: row })), tx);
      const appliedCount = applications.length;
      const updated = await tx.financeImportBatch.updateMany({ where: { id: batch.id, workspaceId: batch.workspaceId, version: batch.version }, data: {
        stage, appliedCount, appliedByUserId: complete ? actor.user.id : null, appliedAt: complete ? now : null, version: { increment: 1 } } });
      invariant(updated.count === 1, 409, "FINANCE_REPORT_APPLICATION_CONFLICT", "The Finance report import changed. Refresh and try again.");
      const currentCandidates = await tx.financeImportCandidate.findMany({ where: { workspaceId: params.workspaceId, batchId: batch.id }, orderBy: { id: "asc" }, take: 5001 });
      invariant(currentCandidates.length === batch.candidates.length && currentCandidates.every(row => batch.candidates.some(prior => row.id === prior.id)),
        409, "FINANCE_REPORT_APPLICATION_CONFLICT", "The Finance report candidates changed.");
      const candidateRoots = await captureArtifactInputProof(actor, params.workspaceId,
        currentCandidates.map(row => ({ kind: "FinanceImportCandidate" as const, id: row.id, snapshot: row })), tx);
      const currentBatch = await tx.financeImportBatch.findUniqueOrThrow({ where: { id_workspaceId: { id: batch.id, workspaceId: params.workspaceId } } });
      await recordOutput(tx, actor, params.workspaceId, "FinanceImportBatch", currentBatch, [...frozenRoots, ...reportRoots, ...applicationRoots, ...candidateRoots]);
      await tx.auditLog.create({ data: { workspaceId: batch.workspaceId, actorUserId: actor.user.id, action: "finance-report-import.applied",
        entityType: "FinanceImportBatch", entityId: batch.id, meta: { version: batch.version + 1, stage, appliedNow: receipts.length, appliedCount } } });
      return { batchId: batch.id, version: batch.version + 1, stage, appliedCount, appliedNow: receipts.length, noOp: false, receipts };
    }, { isolationLevel: Prisma.TransactionIsolationLevel.Serializable, maxWait: 10_000, timeout: 120_000 }));
  } catch (error) {
    if (serializableConflict(error) || (error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2002")) {
      throw new AppError(409, "FINANCE_REPORT_APPLICATION_CONFLICT", "The Finance report application changed. Refresh and try again.");
    }
    throw error;
  }
}
