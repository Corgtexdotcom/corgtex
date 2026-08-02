import { beforeEach, describe, expect, it, vi } from "vitest";
const prismaMock = vi.hoisted(() => ({ $transaction: vi.fn(), $executeRaw: vi.fn(), financeImportBatch: { findUnique: vi.fn(), updateMany: vi.fn() },
  financeReport: { findMany: vi.fn() }, financeReportFact: { findMany: vi.fn() }, financeImportCandidate: { createMany: vi.fn() },
  event: { create: vi.fn() }, auditLog: { create: vi.fn() } }));
vi.mock("@corgtex/shared", () => ({ prisma: prismaMock }));
vi.mock("./finance-import-artifact-ownership", () => ({ lockFinanceImportArtifactLinkTargets: vi.fn() }));
const extraction = { status: "complete", format: "CSV" };
const batch = { id: "batch-1", workspaceId: "ws-1", documentId: "doc-1", brainSourceId: "source-1", workflowJobId: "extract-1", agentRunId: null,
  version: 3, stage: "CLASSIFYING", mimeType: "text/csv", document: { accessDomain: "FINANCE", archivedAt: null, textContent: "exact evidence", metadata: { extraction } },
  brainSource: { accessDomain: "FINANCE", archivedAt: null, content: "exact evidence", metadata: { extraction } }, agentRun: null };
const textClaim = (id: string) => ({ id, role: "TEXT" as const, source: { kind: "CELL" as const, sheet: "Report", row: 1, column: 1, evidence: id } });
const interpretation = { version: 1, classification: { reportType: "PROFIT_AND_LOSS", basis: "ACCRUAL", cadence: "MONTHLY",
  reportTypeEvidenceClaimIds: ["type"], basisEvidenceClaimIds: ["basis"], cadenceEvidenceClaimIds: ["cadence"], confidence: 1 },
numericFormat: { status: "RESOLVED", version: 1, decimalSeparator: "DOT", groupingSeparator: "NONE", amountScale: 1,
  decimalSeparatorEvidenceClaimIds: [], groupingSeparatorEvidenceClaimIds: [], amountScaleEvidenceClaimIds: ["scale"], confidence: 1 },
evidenceClaims: ["type", "basis", "cadence", "scale"].map(textClaim), exceptions: [] } as const;
const candidate = { sourceKey: "a".repeat(64), sourceLocation: { kind: "CELL", sheet: "Report", row: 2, column: 2, evidence: "100" },
  sourceLabel: "Revenue", sourcePath: ["Revenue"], proposedAccountPath: ["Revenue"], factKind: "LEAF" as const,
  periodStart: "2026-01-01", periodEnd: "2026-01-31", amountCents: 10_000, extractionJson: { claimId: "amount" },
  proposalJson: { mappingId: "mapping-1" }, confidenceBps: 9900, evidenceMd: "Report R2C2" };
describe("Finance import proposal persistence", () => {
  beforeEach(() => { vi.clearAllMocks(); prismaMock.$transaction.mockImplementation((work) => work(prismaMock)); prismaMock.$executeRaw.mockResolvedValue(1);
    prismaMock.financeImportBatch.updateMany.mockResolvedValue({ count: 1 }); prismaMock.financeReport.findMany.mockResolvedValue([{ currency: "EUR" }]);
    prismaMock.financeReportFact.findMany.mockResolvedValue([]);
    prismaMock.financeImportCandidate.createMany.mockResolvedValue({ count: 1 }); prismaMock.event.create.mockResolvedValue({}); prismaMock.auditLog.create.mockResolvedValue({}); });
  it("claims exact Finance artifacts and links the retry-safe AgentRun owner", async () => {
    prismaMock.financeImportBatch.findUnique.mockResolvedValueOnce({ documentId: "doc-1", brainSourceId: "source-1" }).mockResolvedValueOnce(batch);
    const { claimFinanceReportImportProposal } = await import("./finance-import-proposal");
    await expect(claimFinanceReportImportProposal({ workspaceId: "ws-1", batchId: "batch-1", expectedVersion: 3,
      workflowJobId: "job-1", agentRunId: "run-1" })).resolves.toEqual({ skipped: false, batchId: "batch-1", version: 4,
        format: "CSV", extractedEvidence: "exact evidence", workspaceCurrencyCodes: ["EUR"] });
    expect(prismaMock.financeImportBatch.updateMany).toHaveBeenCalledWith(expect.objectContaining({ where: expect.objectContaining({ version: 3, stage: "CLASSIFYING" }),
      data: expect.objectContaining({ stage: "MAPPING", workflowJobId: "job-1", agentRunId: "run-1" }) }));
  });
  it("fails closed on stale or non-Finance claims and permits only a failed owned run retry", async () => {
    const { claimFinanceReportImportProposal } = await import("./finance-import-proposal");
    for (const value of [{ ...batch, version: 4 }, { ...batch, document: { ...batch.document, accessDomain: "WORKSPACE" } }]) {
      prismaMock.financeImportBatch.findUnique.mockResolvedValueOnce({ documentId: "doc-1", brainSourceId: "source-1" }).mockResolvedValueOnce(value);
      await expect(claimFinanceReportImportProposal({ workspaceId: "ws-1", batchId: "batch-1", expectedVersion: 3,
        workflowJobId: "job-1", agentRunId: "run-2" })).rejects.toMatchObject({ code: expect.stringMatching(/CONFLICT|UNAVAILABLE/) });
    }
    const retry = { ...batch, stage: "MAPPING", workflowJobId: "job-1", agentRunId: "run-1", agentRun: { status: "FAILED" } };
    prismaMock.financeImportBatch.findUnique.mockResolvedValueOnce({ documentId: "doc-1", brainSourceId: "source-1" }).mockResolvedValueOnce(retry);
    await expect(claimFinanceReportImportProposal({ workspaceId: "ws-1", batchId: "batch-1", expectedVersion: 3,
      workflowJobId: "job-1", agentRunId: "run-2" })).resolves.toMatchObject({ skipped: false, version: 4 });
  });
  it("atomically stores blocked pre-reconciliation candidates and sanitized state", async () => {
    const { persistFinanceReportImportProposal } = await import("./finance-import-proposal");
    await expect(persistFinanceReportImportProposal({ workspaceId: "ws-1", batchId: "batch-1", workflowJobId: "job-1", agentRunId: "run-1",
      expectedVersion: 4, interpretation, currency: { state: "RESOLVED", code: "EUR", source: "WORKSPACE_SINGLE_CURRENCY" },
      periodStart: "2026-01-01", periodEnd: "2026-01-31", candidates: [candidate], warningCount: 0, blockerCount: 0 }))
      .resolves.toEqual({ batchId: "batch-1", version: 5, stage: "READY_FOR_REVIEW", candidateCount: 1 });
    expect(prismaMock.financeImportCandidate.createMany.mock.calls[0][0].data[0]).toMatchObject({ action: "ADD", reviewState: "PROPOSED",
      semanticKey: expect.stringMatching(/^[a-f0-9]{64}$/), amountCents: 10_000, periodStart: new Date("2026-01-01T00:00:00.000Z") });
    expect(prismaMock.financeImportBatch.updateMany).toHaveBeenCalledWith(expect.objectContaining({ where: expect.objectContaining({ version: 4, agentRunId: "run-1" }),
      data: expect.objectContaining({ stage: "READY_FOR_REVIEW", resolvedCurrency: "EUR", interpretationJson: interpretation, addCount: 1 }) }));
    expect(prismaMock.auditLog.create).toHaveBeenLastCalledWith(expect.objectContaining({ data: expect.objectContaining({
      meta: expect.objectContaining({ blockerCount: 0, addCount: 1, conflictCount: 0 }) }) }));
    const conflict = { ...candidate, sourceKey: "b".repeat(64), amountCents: 20_000 };
    await persistFinanceReportImportProposal({ workspaceId: "ws-1", batchId: "batch-1", workflowJobId: "job-1", agentRunId: "run-1",
      expectedVersion: 4, interpretation, currency: { state: "RESOLVED", code: "EUR", source: "WORKSPACE_SINGLE_CURRENCY" },
      periodStart: "2026-01-01", periodEnd: "2026-01-31", candidates: [candidate, conflict], warningCount: 0, blockerCount: 0 });
    expect(prismaMock.auditLog.create).toHaveBeenLastCalledWith(expect.objectContaining({ data: expect.objectContaining({
      meta: expect.objectContaining({ blockerCount: 2, conflictCount: 2 }) }) }));
  });
  it("retains currency-only candidates but creates none for structural blockers, then records failures safely", async () => {
    const { persistFinanceReportImportProposal, failFinanceReportImportProposal } = await import("./finance-import-proposal");
    await expect(persistFinanceReportImportProposal({ workspaceId: "ws-1", batchId: "batch-1", workflowJobId: "job-1", agentRunId: "run-1",
      expectedVersion: 4, interpretation, currency: { state: "RESOLVED", code: "EUR", source: "DOCUMENT" }, periodStart: "2026-01-01", periodEnd: "2026-01-31",
      candidates: [{ ...candidate, sourcePath: Array(101).fill("nested") }], warningCount: 0, blockerCount: 0 })).rejects.toMatchObject({ code: "INVALID_FINANCE_IMPORT_PROPOSAL" });
    await expect(persistFinanceReportImportProposal({ workspaceId: "ws-1", batchId: "batch-1", workflowJobId: "job-1", agentRunId: "run-1",
      expectedVersion: 4, interpretation, currency: { state: "UNRESOLVED", code: null, source: null }, periodStart: "2026-01-01", periodEnd: "2026-01-31",
      candidates: [candidate], warningCount: 0, blockerCount: 1, blocker: { code: "CURRENCY_UNRESOLVED", message: "Choose currency." } }))
      .resolves.toMatchObject({ stage: "NEEDS_INPUT", candidateCount: 1 });
    expect(prismaMock.financeImportCandidate.createMany.mock.calls[0][0].data[0]).toMatchObject({ action: "CONFLICT", reviewState: "BLOCKED", semanticKey: null });
    prismaMock.financeImportCandidate.createMany.mockClear();
    await expect(persistFinanceReportImportProposal({ workspaceId: "ws-1", batchId: "batch-1", workflowJobId: "job-1", agentRunId: "run-1",
      expectedVersion: 4, interpretation, currency: { state: "UNRESOLVED", code: null, source: null }, periodStart: "2026-01-01", periodEnd: "2026-01-31",
      candidates: [], warningCount: 0, blockerCount: 1, blocker: { code: "NUMERIC_FORMAT_UNRESOLVED", message: "Choose format." } }))
      .resolves.toMatchObject({ stage: "NEEDS_INPUT", candidateCount: 0 });
    expect(prismaMock.financeImportCandidate.createMany).not.toHaveBeenCalled();
    await expect(failFinanceReportImportProposal({ workspaceId: "ws-1", batchId: "batch-1", workflowJobId: "job-2", expectedVersion: 5,
      failureCode: "AGENT_UNAVAILABLE" })).resolves.toMatchObject({ stage: "NEEDS_INPUT" });
    expect(prismaMock.financeImportBatch.updateMany).toHaveBeenLastCalledWith(expect.objectContaining({ data: expect.objectContaining({
      safeErrorCode: "FINANCE_REPORT_AGENT_UNAVAILABLE", safeErrorMessage: expect.not.stringContaining("provider") }) }));
    prismaMock.financeImportBatch.findUnique.mockResolvedValue({ ...batch, stage: "MAPPING", version: 6, workflowJobId: "job-2", agentRunId: "failed-run", agentRun: { status: "FAILED" } });
    await expect(failFinanceReportImportProposal({ workspaceId: "ws-1", batchId: "batch-1", workflowJobId: "job-2", expectedVersion: 5,
      failureCode: "AGENT_UNAVAILABLE" })).resolves.toMatchObject({ version: 7, stage: "NEEDS_INPUT" });
    expect(prismaMock.financeImportBatch.updateMany).toHaveBeenLastCalledWith(expect.objectContaining({ where: expect.objectContaining({ version: 6, agentRunId: "failed-run" }) }));
  });
});
