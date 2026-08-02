import type { Prisma } from "@prisma/client";
import { prisma } from "@corgtex/shared";
import { invariant } from "./errors";
import { lockFinanceImportArtifactLinkTargets } from "./finance-import-artifact-ownership";
import { parseFinanceImportInterpretationV1 } from "./finance-import-interpretation";
import { normalizeFinanceImportAmountCents, normalizeFinanceImportCurrency, validateFinanceImportReportingWindow } from "./finance-imports";
const FORMAT_BY_MIME = { "text/csv": "CSV", "application/pdf": "PDF", "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet": "XLSX" } as const;
const FINISHED = new Set(["RECONCILING", "READY_FOR_REVIEW", "NEEDS_INPUT", "APPLYING", "APPLIED", "PARTIALLY_APPLIED", "FAILED", "CANCELLED"]);
const SAFE_FAILURES = {
  AGENT_UNAVAILABLE: ["NEEDS_INPUT", "Finance report interpretation is unavailable. Ask an administrator to enable the import agent."],
  INVALID_INPUT: ["FAILED", "The extracted report could not be interpreted safely."],
  INVALID_MODEL_OUTPUT: ["FAILED", "The report proposal could not be validated. Please retry."],
  PROVIDER_ERROR: ["FAILED", "The report interpretation provider is unavailable. Please retry."],
} as const;
type FailureCode = keyof typeof SAFE_FAILURES;
type Candidate = { sourceKey: string; sourceLocation: Prisma.InputJsonObject; sourceLabel: string; sourcePath: string[];
  proposedAccountPath: string[]; factKind: "LEAF" | "DERIVED"; periodStart: string; periodEnd: string; amountCents: number;
  extractionJson: Prisma.InputJsonObject; proposalJson: Prisma.InputJsonObject; confidenceBps: number; evidenceMd: string };
const jsonRecord = (value: Prisma.JsonValue | null) => value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
export async function claimFinanceReportImportProposal(params: { workspaceId: string; batchId: string; expectedVersion: number;
  workflowJobId: string; agentRunId: string }) {
  invariant([params.workspaceId, params.batchId, params.workflowJobId, params.agentRunId].every((value) => value.trim()), 400, "INVALID_INPUT", "Finance report proposal identity is invalid.");
  return prisma.$transaction(async (tx) => {
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${`finance-report-import:${params.workspaceId}:${params.batchId}`}, 0))`;
    const links = await tx.financeImportBatch.findUnique({ where: { id_workspaceId: { id: params.batchId, workspaceId: params.workspaceId } }, select: { documentId: true, brainSourceId: true } });
    invariant(links?.documentId && links.brainSourceId, 404, "FINANCE_REPORT_IMPORT_NOT_FOUND", "The Finance report import was not found.");
    await lockFinanceImportArtifactLinkTargets(tx, { workspaceId: params.workspaceId, documentId: links.documentId, brainSourceId: links.brainSourceId });
    const batch = await tx.financeImportBatch.findUnique({ where: { id_workspaceId: { id: params.batchId, workspaceId: params.workspaceId } },
      include: { document: true, brainSource: true, agentRun: { select: { status: true } } } });
    invariant(batch, 404, "FINANCE_REPORT_IMPORT_NOT_FOUND", "The Finance report import was not found.");
    if (FINISHED.has(batch.stage)) return { skipped: true as const, batchId: batch.id, version: batch.version };
    const retry = batch.stage === "MAPPING" && batch.workflowJobId === params.workflowJobId && batch.agentRun?.status === "FAILED";
    invariant((batch.stage === "CLASSIFYING" && batch.version === params.expectedVersion) || retry, 409, "FINANCE_REPORT_PROPOSAL_CONFLICT", "The Finance report import changed. Please retry.");
    const format = FORMAT_BY_MIME[batch.mimeType as keyof typeof FORMAT_BY_MIME];
    const documentExtraction = jsonRecord(batch.document?.metadata ?? null).extraction as Record<string, unknown> | undefined;
    const sourceExtraction = jsonRecord(batch.brainSource?.metadata ?? null).extraction as Record<string, unknown> | undefined;
    invariant(format && batch.document?.accessDomain === "FINANCE" && batch.brainSource?.accessDomain === "FINANCE"
      && !batch.document.archivedAt && !batch.brainSource.archivedAt && batch.document.textContent?.length
      && batch.document.textContent === batch.brainSource.content && documentExtraction?.status === "complete"
      && sourceExtraction?.status === "complete" && documentExtraction.format === format && sourceExtraction.format === format,
    409, "FINANCE_IMPORT_ARTIFACT_UNAVAILABLE", "The Finance report artifacts are unavailable.");
    const updated = await tx.financeImportBatch.updateMany({ where: { id: batch.id, workspaceId: batch.workspaceId, version: batch.version, stage: batch.stage,
      ...(retry ? { workflowJobId: params.workflowJobId, agentRunId: batch.agentRunId } : {}) }, data: { stage: "MAPPING", workflowJobId: params.workflowJobId,
      agentRunId: params.agentRunId, safeErrorCode: null, safeErrorMessage: null, version: { increment: 1 } } });
    invariant(updated.count === 1, 409, "FINANCE_REPORT_PROPOSAL_CONFLICT", "The Finance report import changed. Please retry.");
    const currencies = await tx.financeReport.findMany({ where: { workspaceId: batch.workspaceId, status: "ACTIVE" }, select: { currency: true }, distinct: ["currency"] });
    return { skipped: false as const, batchId: batch.id, version: batch.version + 1, format,
      extractedEvidence: batch.document.textContent, workspaceCurrencyCodes: currencies.map(({ currency }) => currency) };
  });
}

export async function persistFinanceReportImportProposal(params: { workspaceId: string; batchId: string; workflowJobId: string; agentRunId: string;
  expectedVersion: number; interpretation: unknown; currency: { state: "RESOLVED" | "UNRESOLVED"; code: string | null; source: "DOCUMENT" | "WORKSPACE_SINGLE_CURRENCY" | null };
  periodStart: string; periodEnd: string; candidates: Candidate[]; warningCount: number; blockerCount: number; blocker?: { code: string; message: string } }) {
  const interpretation = parseFinanceImportInterpretationV1(params.interpretation);
  const window = validateFinanceImportReportingWindow({ periodStart: params.periodStart, periodEnd: params.periodEnd });
  const keys = new Set<string>();
  const candidates = params.candidates.map((candidate) => {
    const encoded = JSON.stringify(candidate);
    invariant(/^[a-f0-9]{64}$/.test(candidate.sourceKey) && !keys.has(candidate.sourceKey), 400, "INVALID_FINANCE_IMPORT_PROPOSAL", "Candidate source identity is invalid."); keys.add(candidate.sourceKey);
    invariant(candidate.sourceLabel.length > 0 && candidate.sourceLabel.length <= 500 && candidate.sourcePath.length > 0 && candidate.proposedAccountPath.length > 0
      && candidate.sourcePath.length <= 100 && candidate.proposedAccountPath.length <= 100 && encoded.length <= 50_000 && !/\\u0000|\\ud[89a-f]/i.test(encoded)
      && Number.isInteger(candidate.confidenceBps) && candidate.confidenceBps >= 0 && candidate.confidenceBps <= 10_000 && candidate.evidenceMd.length <= 2_000,
    400, "INVALID_FINANCE_IMPORT_PROPOSAL", "Candidate proposal metadata is invalid.");
    const dates = validateFinanceImportReportingWindow({ periodStart: candidate.periodStart, periodEnd: candidate.periodEnd });
    return { workspaceId: params.workspaceId, batchId: params.batchId, ...candidate, periodStart: dates.periodStart, periodEnd: dates.periodEnd,
      amountCents: normalizeFinanceImportAmountCents(candidate.amountCents), action: "CONFLICT" as const, reviewState: "BLOCKED" as const, semanticKey: null };
  });
  const needsInput = params.blockerCount > 0;
  invariant([params.warningCount, params.blockerCount].every((count) => Number.isInteger(count) && count >= 0 && count <= 200), 400, "INVALID_FINANCE_IMPORT_PROPOSAL", "Proposal counts are invalid.");
  invariant((needsInput && candidates.length === 0) || (!needsInput && candidates.length > 0), 400, "INVALID_FINANCE_IMPORT_PROPOSAL", "Blocked proposals cannot create candidates.");
  const resolvedCurrency = params.currency.state === "RESOLVED" ? normalizeFinanceImportCurrency(params.currency.code ?? "") : null;
  invariant((params.currency.state === "UNRESOLVED" && params.currency.code === null && params.currency.source === null)
    || (params.currency.state === "RESOLVED" && resolvedCurrency !== null && params.currency.source !== null), 400, "INVALID_FINANCE_IMPORT_PROPOSAL", "Currency state is inconsistent.");
  return prisma.$transaction(async (tx) => {
    if (candidates.length) await tx.financeImportCandidate.createMany({ data: candidates });
    const nextVersion = params.expectedVersion + 1, stage = needsInput ? "NEEDS_INPUT" as const : "RECONCILING" as const;
    const updated = await tx.financeImportBatch.updateMany({ where: { id: params.batchId, workspaceId: params.workspaceId, version: params.expectedVersion,
      stage: "MAPPING", workflowJobId: params.workflowJobId, agentRunId: params.agentRunId }, data: { stage, interpretationJson: interpretation as unknown as Prisma.InputJsonObject,
      reportType: interpretation.classification.reportType, basis: interpretation.classification.basis, cadence: interpretation.classification.cadence,
      periodStart: window.periodStart, periodEnd: window.periodEnd, currencyState: params.currency.state, resolvedCurrency,
      currencyResolutionSource: params.currency.source, warningCount: params.warningCount, blockerCount: params.blockerCount,
      safeErrorCode: params.blocker?.code ?? null, safeErrorMessage: params.blocker?.message ?? null, version: { increment: 1 } } });
    invariant(updated.count === 1, 409, "FINANCE_REPORT_PROPOSAL_CONFLICT", "The Finance report import changed. Please retry.");
    await tx.event.create({ data: { workspaceId: params.workspaceId, type: "finance-report-import.proposed", aggregateType: "FinanceImportBatch",
      aggregateId: params.batchId, payload: { batchId: params.batchId, version: nextVersion, stage, candidateCount: candidates.length } } });
    await tx.auditLog.create({ data: { workspaceId: params.workspaceId, action: "finance-report-import.proposed", entityType: "FinanceImportBatch",
      entityId: params.batchId, meta: { stage, candidateCount: candidates.length, warningCount: params.warningCount, blockerCount: params.blockerCount } } });
    return { batchId: params.batchId, version: nextVersion, stage, candidateCount: candidates.length };
  });
}

export async function failFinanceReportImportProposal(params: { workspaceId: string; batchId: string; workflowJobId: string; expectedVersion: number;
  agentRunId?: string; failureCode: FailureCode }) {
  const [stage, message] = SAFE_FAILURES[params.failureCode];
  const prior = params.agentRunId ? null : await prisma.financeImportBatch.findUnique({ where: { id_workspaceId: { id: params.batchId, workspaceId: params.workspaceId } },
    include: { agentRun: { select: { status: true } } } });
  const resume = prior?.stage === "MAPPING" && prior.workflowJobId === params.workflowJobId && prior.agentRunId && prior.agentRun?.status === "FAILED";
  const version = resume ? prior.version : params.expectedVersion, agentRunId = resume ? prior.agentRunId : params.agentRunId;
  const updated = await prisma.financeImportBatch.updateMany({ where: { id: params.batchId, workspaceId: params.workspaceId, version,
    stage: agentRunId ? "MAPPING" : "CLASSIFYING", ...(agentRunId ? { workflowJobId: params.workflowJobId, agentRunId } : {}) },
  data: { stage, workflowJobId: params.workflowJobId, safeErrorCode: `FINANCE_REPORT_${params.failureCode}`, safeErrorMessage: message, version: { increment: 1 } } });
  invariant(updated.count === 1, 409, "FINANCE_REPORT_PROPOSAL_CONFLICT", "The Finance report import changed. Please retry.");
  return { batchId: params.batchId, version: version + 1, stage, failureCode: params.failureCode };
}
