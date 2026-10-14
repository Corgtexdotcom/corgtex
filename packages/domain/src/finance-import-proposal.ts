import { randomUUID } from "node:crypto";
import type { Prisma } from "@prisma/client";
import { prisma, type AppActor } from "@corgtex/shared";
import { resolveFinanceUploadInputs, type FinanceExtractionLease } from "./finance-import-lineage";
import { requireFinanceReportImportHumanWriteAccess } from "./finance";
import { advanceHumanArtifactInputLineage, captureArtifactInputProof, captureImmutableArtifactInputProof,
  isArtifactInputProofReadable, recordArtifactInputLineage, type LineageRoot } from "./source-lineage";
import { mergeArtifactInputProofs } from "./digest-lineage";
import { invariant } from "./errors";
import { lockFinanceImportArtifactLinkTargets } from "./finance-import-artifact-ownership";
import { parseFinanceImportInterpretationV1 } from "./finance-import-interpretation";
import { reconcileFinanceImportCandidates, captureFinanceCurrentFactValues } from "./finance-import-reconciliation";
import { normalizeFinanceImportAmountCents, normalizeFinanceImportIsoCurrency, validateFinanceImportReportingWindow } from "./finance-imports";
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
type ProposalJob = { workspaceId: string; batchId: string; expectedVersion: number; workflowJobId: string;
  attempts?: number; expectedLease?: FinanceExtractionLease };
export type FinanceProposalReceipt = Readonly<{ kind: "FINANCE_REPORT_PROPOSAL" }>;
type ProposalReceiptState = { job: ProposalJob; actor: AppActor; version: number; agentRunId: string;
  roots: LineageRoot[]; modelReady: boolean };
const proposalReceipts = new WeakMap<FinanceProposalReceipt, ProposalReceiptState>();
async function assertProposalLease(tx: Prisma.TransactionClient, params: ProposalJob) {
  const lease = params.expectedLease;
  invariant(lease?.lockedBy && lease.lockedAt instanceof Date && Number.isFinite(lease.lockedAt.valueOf()) && Number.isInteger(params.attempts),
    409, "FINANCE_REPORT_SOURCE_NOT_READY", "The report worker lease is unavailable.");
  await tx.$queryRaw`SELECT id FROM "WorkflowJob" WHERE id = ${params.workflowJobId} AND "workspaceId" = ${params.workspaceId} FOR UPDATE`;
  const job = await tx.workflowJob.findFirst({ where: { id: params.workflowJobId, workspaceId: params.workspaceId } });
  invariant(job && job.type === "finance-report-import.interpret" && job.status === "RUNNING" && job.attempts === params.attempts
    && job.lockedBy === lease.lockedBy && job.lockedAt?.valueOf() === lease.lockedAt.valueOf()
    && job.payload && typeof job.payload === "object" && !Array.isArray(job.payload)
    && job.payload.batchId === params.batchId && job.payload.expectedVersion === params.expectedVersion,
  409, "FINANCE_REPORT_PROPOSAL_CONFLICT", "The report worker lease changed.");
}
export async function prepareFinanceReportImportProposalInput(params: ProposalJob) {
  return prisma.$transaction(async tx => {
    await assertProposalLease(tx, params);
    const batch = await tx.financeImportBatch.findUnique({ where: { id_workspaceId: { id: params.batchId, workspaceId: params.workspaceId } } });
    invariant(batch, 404, "FINANCE_REPORT_IMPORT_NOT_FOUND", "The Finance report import was not found.");
    const captured = await resolveFinanceUploadInputs(batch, tx);
    const roots = mergeArtifactInputProofs(captured.roots, await captureArtifactInputProof(captured.actor, params.workspaceId,
      [{ kind: "FinanceImportBatch", id: batch.id, snapshot: batch }], tx));
    return { actor: captured.actor, lineageRoots: await captureImmutableArtifactInputProof(captured.actor, params.workspaceId, roots, tx) };
  });
}
async function validateProposalReceipt(receipt: FinanceProposalReceipt | undefined, tx: Prisma.TransactionClient, modelRequired = true) {
  const state = receipt && proposalReceipts.get(receipt);
  invariant(state && (!modelRequired || state.modelReady), 409, "FINANCE_REPORT_SOURCE_NOT_READY", "The report model input receipt is unavailable.");
  await assertProposalLease(tx, state.job);
  await requireFinanceReportImportHumanWriteAccess(state.actor, state.job.workspaceId);
  invariant(await isArtifactInputProofReadable(state.actor, state.job.workspaceId, state.roots, tx),
    409, "SOURCE_CHANGED", "The report inputs or permissions changed.");
  return state;
}
export async function bindFinanceReportProposalBehavior(receipt: FinanceProposalReceipt, behaviorRoots: readonly LineageRoot[]) {
  return prisma.$transaction(async tx => {
    const state = await validateProposalReceipt(receipt, tx, false);
    const roots = mergeArtifactInputProofs(state.roots, [...behaviorRoots]);
    invariant(await isArtifactInputProofReadable(state.actor, state.job.workspaceId, roots, tx), 409, "SOURCE_CHANGED", "Agent behavior changed.");
    const frozen = await captureImmutableArtifactInputProof(state.actor, state.job.workspaceId, roots, tx);
    state.roots = structuredClone(roots);
    state.modelReady = true;
    return frozen;
  });
}
export async function assertFinanceReportProposalInputCurrent(receipt: FinanceProposalReceipt) {
  await prisma.$transaction(async tx => { await validateProposalReceipt(receipt, tx); });
}

export async function claimFinanceReportImportProposal(params: ProposalJob & { agentRunId: string }) {
  invariant([params.workspaceId, params.batchId, params.workflowJobId, params.agentRunId].every((value) => value.trim()), 400, "INVALID_INPUT", "Finance report proposal identity is invalid.");
  return prisma.$transaction(async (tx) => {
    await assertProposalLease(tx, params);
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${`finance-report-import:${params.workspaceId}:${params.batchId}`}, 0))`;
    const links = await tx.financeImportBatch.findUnique({ where: { id_workspaceId: { id: params.batchId, workspaceId: params.workspaceId } }, select: { documentId: true, brainSourceId: true } });
    invariant(links?.documentId && links.brainSourceId, 404, "FINANCE_REPORT_IMPORT_NOT_FOUND", "The Finance report import was not found.");
    await lockFinanceImportArtifactLinkTargets(tx, { workspaceId: params.workspaceId, documentId: links.documentId, brainSourceId: links.brainSourceId });
    const batch = await tx.financeImportBatch.findUnique({ where: { id_workspaceId: { id: params.batchId, workspaceId: params.workspaceId } },
      include: { document: true, brainSource: true, agentRun: { select: { status: true } } } });
    invariant(batch, 404, "FINANCE_REPORT_IMPORT_NOT_FOUND", "The Finance report import was not found.");
    const captured = await resolveFinanceUploadInputs(batch, tx);
    await captureArtifactInputProof(captured.actor, params.workspaceId, [{ kind: "FinanceImportBatch", id: batch.id, snapshot: batch }], tx);
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
    const current = await tx.financeImportBatch.findUniqueOrThrow({ where: { id_workspaceId: { id: batch.id, workspaceId: batch.workspaceId } } });
    await advanceHumanArtifactInputLineage({ tx, actor: captured.actor, workspaceId: params.workspaceId,
      artifact: { kind: "FinanceImportBatch", id: batch.id }, before: batch, after: current, allowSystemTransition: true });
    const roots = mergeArtifactInputProofs(captured.roots, await captureArtifactInputProof(captured.actor, params.workspaceId,
      [{ kind: "FinanceImportBatch", id: current.id, snapshot: current }], tx));
    const receipt = Object.freeze({ kind: "FINANCE_REPORT_PROPOSAL" as const });
    proposalReceipts.set(receipt, { job: { ...params, expectedLease: { ...params.expectedLease!, lockedAt: new Date(params.expectedLease!.lockedAt) } },
      actor: captured.actor, version: current.version, agentRunId: params.agentRunId, roots: structuredClone(roots), modelReady: false });
    return { skipped: false as const, batchId: batch.id, version: current.version, format,
      extractedEvidence: batch.document.textContent, workspaceCurrencyCodes: [] as string[], receipt,
      lineageRoots: await captureImmutableArtifactInputProof(captured.actor, params.workspaceId, roots, tx) };

  });
}

export async function persistFinanceReportImportProposal(params: { workspaceId: string; batchId: string; workflowJobId: string; agentRunId: string;
  expectedVersion: number; receipt?: FinanceProposalReceipt; interpretation: unknown; currency: { state: "RESOLVED" | "UNRESOLVED"; code: string | null; source: "DOCUMENT" | "WORKSPACE_SINGLE_CURRENCY" | null };
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
    return { id: randomUUID(), workspaceId: params.workspaceId, batchId: params.batchId, ...candidate, periodStart: dates.periodStart, periodEnd: dates.periodEnd,
      amountCents: normalizeFinanceImportAmountCents(candidate.amountCents), action: "CONFLICT" as const, reviewState: "BLOCKED" as const, semanticKey: null };
  });
  const needsInput = params.blockerCount > 0;
  invariant([params.warningCount, params.blockerCount].every((count) => Number.isInteger(count) && count >= 0 && count <= 200), 400, "INVALID_FINANCE_IMPORT_PROPOSAL", "Proposal counts are invalid.");
  const currencyOnlyBlocker = needsInput && params.blockerCount === 1 && params.currency.state === "UNRESOLVED"
    && params.blocker?.code === "CURRENCY_UNRESOLVED";
  invariant((needsInput && (candidates.length === 0 || currencyOnlyBlocker)) || (!needsInput && candidates.length > 0),
    400, "INVALID_FINANCE_IMPORT_PROPOSAL", "Only currency-only blockers may retain exact candidate proposals.");
  const resolvedCurrency = params.currency.state === "RESOLVED" ? normalizeFinanceImportIsoCurrency(params.currency.code ?? "") : null;
  invariant((params.currency.state === "UNRESOLVED" && params.currency.code === null && params.currency.source === null)
    || (params.currency.state === "RESOLVED" && resolvedCurrency !== null && params.currency.source !== null), 400, "INVALID_FINANCE_IMPORT_PROPOSAL", "Currency state is inconsistent.");
  return prisma.$transaction(async (tx) => {
    const authority = await validateProposalReceipt(params.receipt, tx);
    invariant(authority.job.workspaceId === params.workspaceId && authority.job.batchId === params.batchId
      && authority.job.workflowJobId === params.workflowJobId && authority.agentRunId === params.agentRunId && authority.version === params.expectedVersion,
    409, "FINANCE_REPORT_PROPOSAL_CONFLICT", "The report model input identity changed.");
    const frozenRoots = await captureImmutableArtifactInputProof(authority.actor, params.workspaceId, authority.roots, tx);
    const emptyCounts = { addCount: 0, updateCount: 0, unchangedCount: 0, duplicateCount: 0, conflictCount: 0, skippedCount: 0 };
    let counts = emptyCounts;
    if (candidates.length && !needsInput) {
      const identity = { workspaceId: params.workspaceId, reportType: interpretation.classification.reportType,
        basis: interpretation.classification.basis, currency: resolvedCurrency! };
      const preliminary = reconcileFinanceImportCandidates({ ...identity, candidates, currentFacts: [] });
      const currentFacts = await tx.financeReportFact.findMany({ where: { workspaceId: params.workspaceId,
        semanticKey: { in: preliminary.decisions.flatMap(({ semanticKey }) => semanticKey ? [semanticKey] : []) } },
      orderBy: { id: "asc" }, take: 5001 });
      const current = await captureFinanceCurrentFactValues(tx, authority.actor, params.workspaceId, currentFacts);
      if (current.roots.length) frozenRoots.push(...await captureImmutableArtifactInputProof(authority.actor, params.workspaceId, current.roots, tx));
      const reconciled = reconcileFinanceImportCandidates({ ...identity, candidates, currentFacts: current.facts });
      counts = reconciled.counts;
      const bySource = new Map(reconciled.decisions.map((decision) => [decision.candidate.sourceKey, decision]));
      await tx.financeImportCandidate.createMany({ data: candidates.map((candidate) => { const decision = bySource.get(candidate.sourceKey)!;
        return { ...candidate, semanticKey: decision.semanticKey, action: decision.action, reviewState: decision.reviewState,
          currentFactId: decision.currentFactId, currentFactRevisionId: decision.currentFactRevisionId, currentAmountCents: decision.currentAmountCents, explanationMd: decision.explanationMd }; }) });
    } else if (candidates.length) await tx.financeImportCandidate.createMany({ data: candidates });
    const nextVersion = params.expectedVersion + 1, stage = needsInput ? "NEEDS_INPUT" as const : "READY_FOR_REVIEW" as const;
    const blockerCount = needsInput ? params.blockerCount : counts.conflictCount;
    const updated = await tx.financeImportBatch.updateMany({ where: { id: params.batchId, workspaceId: params.workspaceId, version: params.expectedVersion,
      stage: "MAPPING", workflowJobId: params.workflowJobId, agentRunId: params.agentRunId }, data: { stage, interpretationJson: interpretation as unknown as Prisma.InputJsonObject,
      reportType: interpretation.classification.reportType, basis: interpretation.classification.basis, cadence: interpretation.classification.cadence,
      periodStart: window.periodStart, periodEnd: window.periodEnd, currencyState: params.currency.state, resolvedCurrency,
      currencyResolutionSource: params.currency.source, warningCount: params.warningCount, blockerCount, ...counts,
      safeErrorCode: params.blocker?.code ?? null, safeErrorMessage: params.blocker?.message ?? null, version: { increment: 1 } } });
    invariant(updated.count === 1, 409, "FINANCE_REPORT_PROPOSAL_CONFLICT", "The Finance report import changed. Please retry.");
    const storedCandidates = candidates.length ? await tx.financeImportCandidate.findMany({ where: { workspaceId: params.workspaceId,
      batchId: params.batchId, id: { in: candidates.map(row => row.id) } } }) : [];
    invariant(storedCandidates.length === candidates.length, 409, "SOURCE_CHANGED", "The report candidates changed.");
    for (const candidate of storedCandidates) await recordArtifactInputLineage({ tx, actor: authority.actor, workspaceId: params.workspaceId,
      artifact: { kind: "FinanceImportCandidate", id: candidate.id }, content: candidate, origin: "DERIVED", inputs: [], inheritedRoots: frozenRoots });
    const candidateRoots = await captureArtifactInputProof(authority.actor, params.workspaceId,
      storedCandidates.map(row => ({ kind: "FinanceImportCandidate" as const, id: row.id, snapshot: row })), tx);
    const current = await tx.financeImportBatch.findUniqueOrThrow({ where: { id_workspaceId: { id: params.batchId, workspaceId: params.workspaceId } } });
    await recordArtifactInputLineage({ tx, actor: authority.actor, workspaceId: params.workspaceId,
      artifact: { kind: "FinanceImportBatch", id: current.id }, content: current, origin: "DERIVED", inputs: [],
      inheritedRoots: mergeArtifactInputProofs(frozenRoots, candidateRoots) });
    const lineageRoots = await captureArtifactInputProof(authority.actor, params.workspaceId,
      [{ kind: "FinanceImportBatch", id: current.id, snapshot: current }], tx);
    await tx.event.create({ data: { workspaceId: params.workspaceId, type: "finance-report-import.proposed", aggregateType: "FinanceImportBatch",
      aggregateId: params.batchId, payload: { batchId: params.batchId, version: nextVersion, stage, candidateCount: candidates.length, blockerCount, ...counts } } });
    await tx.auditLog.create({ data: { workspaceId: params.workspaceId, action: "finance-report-import.proposed", entityType: "FinanceImportBatch",
      entityId: params.batchId, meta: { stage, candidateCount: candidates.length, warningCount: params.warningCount, blockerCount, ...counts } } });
    return { batchId: params.batchId, version: nextVersion, stage, candidateCount: candidates.length, lineageRoots };
  }, {maxWait: 10_000, timeout: 120_000});
}

export async function failFinanceReportImportProposal(params: ProposalJob & {
  agentRunId?: string; receipt?: FinanceProposalReceipt; failureCode: FailureCode;
}) {
  invariant(Object.hasOwn(SAFE_FAILURES, params.failureCode), 400, "INVALID_INPUT", "Report failure code is invalid.");
  return prisma.$transaction(async tx => {
    const priorReceipt = params.receipt && proposalReceipts.get(params.receipt);
    await assertProposalLease(tx, priorReceipt?.job ?? params);
    const before = await tx.financeImportBatch.findUnique({ where: { id_workspaceId: { id: params.batchId, workspaceId: params.workspaceId } },
      include: { agentRun: { select: { status: true } } } });
    invariant(before, 404, "FINANCE_REPORT_IMPORT_NOT_FOUND", "The Finance report import was not found.");
    const captured = await resolveFinanceUploadInputs(before, tx);
    await captureArtifactInputProof(captured.actor, params.workspaceId, [{ kind: "FinanceImportBatch", id: before.id, snapshot: before }], tx);
    if (params.agentRunId) {
      const authority = await validateProposalReceipt(params.receipt, tx, false);
      invariant(authority.job.workspaceId === params.workspaceId && authority.job.batchId === params.batchId
        && authority.job.workflowJobId === params.workflowJobId && authority.agentRunId === params.agentRunId && authority.version === params.expectedVersion,
      409, "FINANCE_REPORT_PROPOSAL_CONFLICT", "The report model input identity changed.");
    }
    const resume = !params.agentRunId && before.stage === "MAPPING" && before.workflowJobId === params.workflowJobId && before.agentRunId && before.agentRun?.status === "FAILED";
    const version = resume ? before.version : params.expectedVersion, agentRunId = resume ? before.agentRunId : params.agentRunId;
    const [stage, message] = SAFE_FAILURES[params.failureCode];
    const updated = await tx.financeImportBatch.updateMany({ where: { id: params.batchId, workspaceId: params.workspaceId, version,
      stage: agentRunId ? "MAPPING" : "CLASSIFYING", ...(agentRunId ? { workflowJobId: params.workflowJobId, agentRunId } : {}) },
      data: { stage, workflowJobId: params.workflowJobId, safeErrorCode: `FINANCE_REPORT_${params.failureCode}`, safeErrorMessage: message, version: { increment: 1 } } });
    invariant(updated.count === 1, 409, "FINANCE_REPORT_PROPOSAL_CONFLICT", "The Finance report import changed. Please retry.");
    const after = await tx.financeImportBatch.findUniqueOrThrow({ where: { id_workspaceId: { id: params.batchId, workspaceId: params.workspaceId } } });
    await advanceHumanArtifactInputLineage({ tx, actor: captured.actor, workspaceId: params.workspaceId,
      artifact: { kind: "FinanceImportBatch", id: before.id }, before, after, allowSystemTransition: true });
    return { batchId: params.batchId, version: version + 1, stage, failureCode: params.failureCode };
  });
}
