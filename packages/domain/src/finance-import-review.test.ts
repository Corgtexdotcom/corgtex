import type { AppActor } from "@corgtex/shared";
import { beforeEach, describe, expect, it, vi } from "vitest";
const mocks = vi.hoisted(() => ({
  read: vi.fn(), write: vi.fn(), prisma: { $transaction: vi.fn(), $executeRaw: vi.fn(), $queryRaw: vi.fn(), financeImportBatch: { findMany: vi.fn(), findUnique: vi.fn(), updateMany: vi.fn() },
    financeImportCandidate: { updateMany: vi.fn() }, financeReportFact: { findMany: vi.fn(), create: vi.fn(), update: vi.fn() }, financeReport: { create: vi.fn(), updateMany: vi.fn() },
    financeImportApplication: { create: vi.fn() }, financeTransaction: { create: vi.fn() }, auditLog: { create: vi.fn() } },
}));
vi.mock("@corgtex/shared", () => ({ prisma: mocks.prisma }));
vi.mock("./finance", () => ({ requireFinanceReportImportReadAccess: mocks.read, requireFinanceReportImportHumanWriteAccess: mocks.write }));
import { editFinanceReportImportCandidate, getFinanceReportImport, listFinanceReportImports, reviewFinanceReportImport } from "./finance-import-review";
import { buildFinanceReportFactSemanticKey } from "./finance-import-reconciliation";
const writer = (id: string): AppActor => ({ kind: "user", user: { id, email: `${id}@example.com`, displayName: id, globalRole: "USER" } });
const actor = writer("writer-1"), peer = writer("writer-2");
const evidence = (id: string) => ({ id, role: "TEXT" as const, source: { kind: "CELL" as const, sheet: "Report", row: 1, column: 1, evidence: id } });
const interpretation = { version: 1, classification: { reportType: "PROFIT_AND_LOSS", basis: "ACCRUAL", cadence: "MONTHLY",
  reportTypeEvidenceClaimIds: ["type"], basisEvidenceClaimIds: ["basis"], cadenceEvidenceClaimIds: ["cadence"], confidence: 1 },
numericFormat: { status: "RESOLVED", version: 1, decimalSeparator: "DOT", groupingSeparator: "NONE", amountScale: 1,
  decimalSeparatorEvidenceClaimIds: [], groupingSeparatorEvidenceClaimIds: [], amountScaleEvidenceClaimIds: ["scale"], confidence: 1 },
evidenceClaims: ["type", "basis", "cadence", "scale"].map(evidence), exceptions: [] };
const candidate = (id = "candidate-1", change = {}) => ({ id, workspaceId: "workspace-1", batchId: "batch-1", sourceKey: id.padEnd(64, "a"),
  sourceLocation: {}, sourceLabel: "Revenue", sourcePath: ["Revenue"], proposedAccountPath: ["Revenue"], factKind: "LEAF", periodStart: new Date("2024-01-01Z"),
  periodEnd: new Date("2024-01-31Z"), amountCents: 100, dimensions: null, extractionJson: {}, proposalJson: {}, action: "ADD", reviewState: "PROPOSED",
  semanticKey: "b".repeat(64), currentFactId: null, currentAmountCents: null, confidenceBps: 9900, evidenceMd: "R1C1", explanationMd: null,
  editedByUserId: null, editedAt: null, approvedByUserId: null, approvedAt: null, version: 1, createdAt: new Date(), updatedAt: new Date(), ...change });
const batch = (candidates = [candidate()], change = {}) => ({ id: "batch-1", workspaceId: "workspace-1", uploadedByUserId: "writer-1", version: 4,
  stage: "READY_FOR_REVIEW", reportType: "PROFIT_AND_LOSS", basis: "ACCRUAL", resolvedCurrency: "EUR", interpretationJson: interpretation,
  currencyState: "RESOLVED", safeErrorCode: null, safeErrorMessage: null, warningCount: 0, blockerCount: 0,
  approvedByUserId: null, approvedAt: null, candidates, ...change });
const versions = (rows: ReturnType<typeof candidate>[]) => rows.map(({ id, version }) => ({ id, expectedVersion: version }));
describe("Finance import review", () => {
  beforeEach(() => { vi.clearAllMocks(); mocks.prisma.$transaction.mockImplementation((work) => work(mocks.prisma)); mocks.prisma.$executeRaw.mockResolvedValue(1); mocks.prisma.$queryRaw.mockResolvedValue([]);
    mocks.prisma.financeImportBatch.updateMany.mockResolvedValue({ count: 1 }); mocks.prisma.financeImportCandidate.updateMany.mockResolvedValue({ count: 1 });
    mocks.prisma.financeReportFact.findMany.mockResolvedValue([]); mocks.prisma.financeReport.updateMany.mockResolvedValue({ count: 1 }); mocks.prisma.auditLog.create.mockResolvedValue({}); });
  it("lists and decorates only reader-authorized workspace batches", async () => {
    const reportWarning = { code: "HISTORICAL_DATA_QUALITY", severity: "WARNING", message: "Review the source.", evidenceClaimIds: ["type"] };
    mocks.prisma.financeImportBatch.findMany.mockResolvedValue([batch([], { warningCount: 1, candidates: [candidate()] })]); mocks.prisma.$queryRaw.mockResolvedValue([{ id: "batch-1", count: 1 }]);
    await expect(listFinanceReportImports(actor, "workspace-1", new Date("2026-08-02Z"))).resolves.toEqual([expect.objectContaining({ id: "batch-1", warningCount: 2 })]);
    expect(mocks.read).toHaveBeenCalledWith(actor, "workspace-1"); expect(mocks.prisma.financeImportBatch.findMany.mock.calls[0][0].select)
      .toMatchObject({ safeErrorCode: true, safeErrorMessage: true, currencyState: true });
    expect(mocks.prisma.financeImportBatch.findMany.mock.calls[0][0].select).not.toHaveProperty("interpretationJson"); mocks.prisma.financeImportBatch.findUnique.mockResolvedValue(batch([candidate(), candidate("rejected", { action: "UPDATE", reviewState: "REJECTED" })], { interpretationJson: { ...interpretation, exceptions: [reportWarning] } }));
    const detail = await getFinanceReportImport(actor, { workspaceId: "workspace-1", batchId: "batch-1" }, new Date("2026-08-02Z"));
    expect(detail).toMatchObject({ warningCount: 2, warnings: [reportWarning], safeErrorCode: null,
      clarification: { canConfirm: false, numericFormat: { status: "RESOLVED", decimalSeparator: "DOT", groupingSeparator: "NONE", amountScale: 1 } },
      candidates: [{ historicalWarning: true, peerConfirmationRequired: false }, { historicalWarning: false, peerConfirmationRequired: false }] });
    expect(detail).not.toHaveProperty("interpretationJson"); expect(mocks.prisma.financeImportBatch.findUnique.mock.calls[0][0].select.candidates.select).not.toHaveProperty("extractionJson"); expect(mocks.prisma.financeImportBatch.findUnique.mock.calls[0][0].select.candidates.select).not.toHaveProperty("proposalJson");
    mocks.prisma.financeImportBatch.findUnique.mockResolvedValue(batch([candidate()], { stage: "NEEDS_INPUT", currencyState: "UNRESOLVED",
      resolvedCurrency: null, safeErrorCode: "CURRENCY_UNRESOLVED", safeErrorMessage: "Choose currency." }));
    await expect(getFinanceReportImport(actor, { workspaceId: "workspace-1", batchId: "batch-1" }))
      .resolves.toMatchObject({ clarification: { canConfirm: true, numericFormat: { status: "RESOLVED", amountScale: 1 } } });
    mocks.prisma.financeImportBatch.findUnique.mockResolvedValue(batch([], { stage: "NEEDS_INPUT", currencyState: "UNRESOLVED",
      resolvedCurrency: null, safeErrorCode: "NUMERIC_FORMAT_UNRESOLVED", safeErrorMessage: "Choose format.",
      interpretationJson: { ...interpretation, numericFormat: { status: "UNRESOLVED", version: 1, decimalSeparator: null,
        groupingSeparator: null, amountScale: null, evidenceClaimIds: [], confidence: 0 }, evidenceClaims: interpretation.evidenceClaims.slice(0, 3),
        exceptions: [{ code: "NUMERIC_FORMAT_UNRESOLVED", severity: "BLOCKER", message: "Choose format.", evidenceClaimIds: [] }] } }));
    await expect(getFinanceReportImport(actor, { workspaceId: "workspace-1", batchId: "batch-1" }))
      .resolves.toMatchObject({ clarification: { canConfirm: false, numericFormat: { status: "UNRESOLVED", amountScale: null } } });
  });
  it("edits and rereconciles exact versions while clearing approvals and creating no canonical records", async () => {
    mocks.prisma.financeImportBatch.findUnique.mockResolvedValue(batch([candidate("candidate-1", { approvedByUserId: "writer-2", approvedAt: new Date() }),
      candidate("rejected", { amountCents: 999, action: "CONFLICT", reviewState: "REJECTED" }), candidate("unrelated", { proposedAccountPath: ["Expense"] })]));
    await expect(editFinanceReportImportCandidate(actor, { workspaceId: "workspace-1", batchId: "batch-1", candidateId: "candidate-1",
      expectedVersion: 4, expectedCandidateVersion: 1, proposedAccountPath: ["Revenue\0"] })).rejects.toMatchObject({ code: "INVALID_INPUT" });
    await expect(editFinanceReportImportCandidate(actor, { workspaceId: "workspace-1", batchId: "batch-1", candidateId: "rejected",
      expectedVersion: 4, expectedCandidateVersion: 1, amountCents: 1 })).rejects.toMatchObject({ code: "FINANCE_REPORT_REVIEW_BLOCKED" });
    await expect(editFinanceReportImportCandidate(actor, { workspaceId: "workspace-1", batchId: "batch-1", candidateId: "candidate-1",
      expectedVersion: 4, expectedCandidateVersion: 1, proposedAccountPath: [" Revenue ", "Sales"], amountCents: 200 })).resolves.toMatchObject({ version: 5, candidateVersion: 2 });
    expect(mocks.write).toHaveBeenCalledWith(actor, "workspace-1"); expect(mocks.prisma.financeImportCandidate.updateMany).toHaveBeenCalledTimes(1); expect(mocks.prisma.financeImportBatch.findUnique.mock.calls.at(-1)?.[0].select.candidates.select).not.toHaveProperty("extractionJson"); expect(mocks.prisma.financeImportBatch.findUnique.mock.calls.at(-1)?.[0].select.candidates.select).not.toHaveProperty("proposalJson");
    expect(mocks.prisma.financeImportCandidate.updateMany).toHaveBeenCalledWith(expect.objectContaining({ data: expect.objectContaining({
      proposedAccountPath: ["Revenue", "Sales"], amountCents: 200, reviewState: "WARNING", editedByUserId: "writer-1", approvedByUserId: null, version: { increment: 1 } }) }));
    expect(mocks.prisma.financeImportBatch.updateMany).toHaveBeenCalledWith(expect.objectContaining({ data: expect.objectContaining({ approvedByUserId: null,
      warningCount: 0, periodStart: new Date("2024-01-01Z"), periodEnd: new Date("2024-01-31Z") }) }));
    expect([mocks.prisma.financeReport.create, mocks.prisma.financeReportFact.create, mocks.prisma.financeReportFact.update,
      mocks.prisma.financeImportApplication.create, mocks.prisma.financeTransaction.create].every((write) => write.mock.calls.length === 0)).toBe(true);
  });
  it("enforces stale versions, warning acceptance, structural blockers, and both bulk paths", async () => {
    const clean = candidate("clean", { periodStart: new Date("2026-07-01Z"), periodEnd: new Date("2026-07-31Z") });
    const clean2 = candidate("clean-2", { periodStart: new Date("2026-06-01Z"), periodEnd: new Date("2026-06-30Z") });
    const warned = candidate("warned"); const blocked = candidate("blocked", { action: "CONFLICT", reviewState: "BLOCKED" });
    mocks.prisma.financeImportBatch.findUnique.mockResolvedValue(batch([clean, clean2, warned, blocked], { blockerCount: 1 }));
    const input = { workspaceId: "workspace-1", batchId: "batch-1", expectedVersion: 4, candidateVersions: versions([clean, clean2, warned, blocked]) };
    mocks.prisma.financeImportCandidate.updateMany.mockResolvedValueOnce({ count: 2 });
    await expect(reviewFinanceReportImport(actor, { ...input, mode: "APPROVE_VERIFIED" })).resolves.toMatchObject({ reviewedCount: 2, complete: false });
    expect(mocks.prisma.financeImportCandidate.updateMany).toHaveBeenCalledTimes(1);
    await expect(reviewFinanceReportImport(actor, { ...input, mode: "APPROVE_ALL", acceptWarnings: true })).rejects.toMatchObject({ code: "FINANCE_REPORT_REVIEW_BLOCKED" });
    mocks.prisma.financeImportBatch.findUnique.mockResolvedValue(batch([clean, warned], { warningCount: 1 }));
    await expect(reviewFinanceReportImport(actor, { ...input, candidateVersions: versions([clean, warned]), mode: "APPROVE_VERIFIED" }))
      .resolves.toMatchObject({ reviewedCount: 1, complete: false });
    mocks.prisma.financeImportBatch.findUnique.mockResolvedValue(batch([clean], { warningCount: 1, interpretationJson: { ...interpretation, exceptions: [{ code: "SOURCE_WARNING", severity: "WARNING", message: "Review.", evidenceClaimIds: ["type"] }] } })); await expect(reviewFinanceReportImport(actor, { ...input, candidateVersions: versions([clean]), mode: "APPROVE_VERIFIED", acceptWarnings: true })).resolves.toMatchObject({ complete: false }); const prior = candidate("prior", { reviewState: "APPROVED", approvedByUserId: "writer-2", approvedAt: new Date("2024-02-01Z") }); mocks.prisma.financeImportBatch.findUnique.mockResolvedValue(batch([prior])); await expect(reviewFinanceReportImport(actor, { ...input, candidateVersions: versions([prior]), mode: "APPROVE_VERIFIED", acceptWarnings: true })).resolves.toMatchObject({ reviewedCount: 0, complete: false }); mocks.prisma.financeImportBatch.findUnique.mockResolvedValue(batch([clean], { warningCount: 1, interpretationJson: { ...interpretation, exceptions: [{ code: "SOURCE_WARNING", severity: "WARNING", message: "Review.", evidenceClaimIds: ["type"] }] } })); await expect(reviewFinanceReportImport(actor, { ...input, candidateId: clean.id, candidateVersions: versions([clean]), mode: "APPROVE" }))
      .rejects.toMatchObject({ code: "FINANCE_REPORT_WARNING_ACCEPTANCE_REQUIRED" });
    mocks.prisma.financeImportBatch.findUnique.mockResolvedValue(batch([clean, warned], { warningCount: 1 })); await expect(reviewFinanceReportImport(actor, { ...input, candidateVersions: versions([clean, warned]), mode: "APPROVE_ALL" }))
      .rejects.toMatchObject({ code: "FINANCE_REPORT_WARNING_ACCEPTANCE_REQUIRED" });
    mocks.prisma.financeImportCandidate.updateMany.mockResolvedValueOnce({ count: 2 });
    await expect(reviewFinanceReportImport(actor, { ...input, candidateVersions: versions([clean, warned]), mode: "APPROVE_ALL", acceptWarnings: true }))
      .resolves.toMatchObject({ reviewedCount: 2, complete: true });
    mocks.prisma.financeImportBatch.findUnique.mockResolvedValue(batch([clean], { warningCount: 1, interpretationJson: { ...interpretation, exceptions: [{ code: "HISTORICAL_ADDITION", severity: "WARNING", message: "Legacy.", evidenceClaimIds: ["type"] }] } })); await expect(reviewFinanceReportImport(actor, { ...input, candidateVersions: versions([clean]), mode: "APPROVE_ALL" })).resolves.toMatchObject({ complete: true }); mocks.prisma.financeImportBatch.findUnique.mockResolvedValue(batch([clean], { version: 5 }));
    await expect(reviewFinanceReportImport(actor, { ...input, candidateVersions: versions([clean]), mode: "APPROVE_VERIFIED" }))
      .rejects.toMatchObject({ code: "FINANCE_REPORT_REVIEW_CONFLICT" });
  });
  it("requires a different writer for historical updates and stores that peer at the exact candidate version", async () => {
    const update = candidate("update", { action: "UPDATE", reviewState: "WARNING", editedByUserId: "writer-1" });
    mocks.prisma.financeImportBatch.findUnique.mockResolvedValue(batch([update], { warningCount: 1 }));
    const input = { workspaceId: "workspace-1", batchId: "batch-1", expectedVersion: 4, candidateId: update.id, candidateVersions: versions([update]), mode: "APPROVE" as const, acceptWarnings: true };
    await expect(reviewFinanceReportImport(actor, input)).rejects.toMatchObject({ code: "FINANCE_REPORT_PEER_CONFIRMATION_REQUIRED" });
    await expect(reviewFinanceReportImport(peer, input)).resolves.toMatchObject({ reviewedCount: 1, complete: true });
    expect(mocks.prisma.financeImportCandidate.updateMany).toHaveBeenLastCalledWith(expect.objectContaining({ where: expect.objectContaining({ OR: [{ id: update.id, version: 1 }] }),
      data: expect.objectContaining({ reviewState: "APPROVED", approvedByUserId: "writer-2", version: { increment: 1 } }) }));
    const approved = candidate("update", { action: "UPDATE", reviewState: "APPROVED", editedByUserId: "writer-1", approvedByUserId: "writer-2", version: 2 }); const expired = candidate("update", { action: "UPDATE", reviewState: "APPROVED", editedByUserId: "writer-1", approvedByUserId: "writer-1", version: 2 }); const other = candidate("other", { periodStart: new Date("2026-07-01Z"), periodEnd: new Date("2026-07-31Z") }); mocks.prisma.financeImportBatch.findUnique.mockResolvedValue(batch([expired, other], { version: 5, warningCount: 1 })); await expect(reviewFinanceReportImport(actor, { ...input, mode: "APPROVE", expectedVersion: 5, candidateId: other.id, candidateVersions: versions([other]), acceptWarnings: true })).resolves.toMatchObject({ complete: false }); mocks.prisma.financeImportBatch.findUnique.mockResolvedValue(batch([expired], { version: 5, warningCount: 1 })); await expect(reviewFinanceReportImport(actor, { ...input, mode: "APPROVE_VERIFIED", expectedVersion: 5, candidateId: undefined, candidateVersions: versions([expired]), acceptWarnings: true })).resolves.toMatchObject({ reviewedCount: 0, complete: false }); await expect(reviewFinanceReportImport(actor, { ...input, mode: "APPROVE_ALL", expectedVersion: 5, candidateId: undefined, candidateVersions: versions([expired]), acceptWarnings: true })).rejects.toMatchObject({ code: "FINANCE_REPORT_PEER_CONFIRMATION_REQUIRED" }); await expect(reviewFinanceReportImport(peer, { ...input, mode: "APPROVE_ALL", expectedVersion: 5, candidateId: undefined, candidateVersions: versions([expired]), acceptWarnings: true })).resolves.toMatchObject({ reviewedCount: 1, complete: true }); mocks.prisma.financeImportBatch.findUnique.mockResolvedValue(batch([approved], { version: 5, warningCount: 1 }));
    await expect(reviewFinanceReportImport(actor, { ...input, mode: "APPROVE_ALL", expectedVersion: 5, candidateId: undefined, candidateVersions: versions([approved]) })).resolves.toMatchObject({ reviewedCount: 0, complete: true }); expect(mocks.prisma.financeImportCandidate.updateMany).toHaveBeenCalledTimes(3); expect(mocks.prisma.financeImportBatch.findUnique.mock.calls.at(-1)?.[0].select.candidates.select).not.toHaveProperty("extractionJson"); expect(mocks.prisma.financeImportBatch.findUnique.mock.calls.at(-1)?.[0].select.candidates.select).not.toHaveProperty("proposalJson");
    await expect(reviewFinanceReportImport(peer, { ...input, candidateVersions: [{ id: update.id, expectedVersion: 2 }] })).rejects.toMatchObject({ code: "FINANCE_REPORT_REVIEW_CONFLICT" });
  });
  it("keeps only unapplied rows editable and reviewable after a partial application", async () => {
    const applied = candidate("applied", { reviewState: "APPLIED", periodStart: new Date("2026-07-01Z"), periodEnd: new Date("2026-07-31Z") }); const clean = candidate("clean", { periodStart: new Date("2026-07-01Z"), periodEnd: new Date("2026-07-31Z") });
    mocks.prisma.financeImportBatch.findUnique.mockResolvedValue(batch([applied, clean], { stage: "PARTIALLY_APPLIED" }));
    await expect(editFinanceReportImportCandidate(actor, { workspaceId: "workspace-1", batchId: "batch-1", candidateId: applied.id,
      expectedVersion: 4, expectedCandidateVersion: 1, amountCents: 200 })).rejects.toMatchObject({ code: "FINANCE_REPORT_REVIEW_BLOCKED" });
    await expect(editFinanceReportImportCandidate(actor, { workspaceId: "workspace-1", batchId: "batch-1", candidateId: clean.id,
      expectedVersion: 4, expectedCandidateVersion: 1, amountCents: 200 })).resolves.toMatchObject({ version: 5 });
    expect(mocks.prisma.financeImportCandidate.updateMany).toHaveBeenLastCalledWith(expect.objectContaining({ where: expect.objectContaining({ OR: [{ id: clean.id, version: 1 }] }), data: expect.objectContaining({ action: "CONFLICT" }) }));
    expect(mocks.prisma.financeImportBatch.updateMany).toHaveBeenLastCalledWith(expect.objectContaining({ data: expect.objectContaining({ addCount: 1, conflictCount: 1, blockerCount: 1 }) }));
    mocks.prisma.financeImportBatch.findUnique.mockResolvedValue(batch([applied, clean], { stage: "PARTIALLY_APPLIED" }));
    await expect(reviewFinanceReportImport(actor, { workspaceId: "workspace-1", batchId: "batch-1", expectedVersion: 4, mode: "APPROVE_ALL",
      candidateVersions: versions([clean]), acceptWarnings: true })).resolves.toMatchObject({ reviewedCount: 1, complete: true });
  });
  it("rejects one proposal at exact versions without accepting warnings", async () => {
    const semanticKey = buildFinanceReportFactSemanticKey({ workspaceId: "workspace-1", reportType: "PROFIT_AND_LOSS", basis: "ACCRUAL", currency: "EUR", accountPath: ["Revenue"], periodStart: new Date("2024-01-01Z"), periodEnd: new Date("2024-01-31Z") }); const row = candidate("reject", { semanticKey, action: "CONFLICT", reviewState: "BLOCKED", periodStart: new Date("2023-01-01Z"), periodEnd: new Date("2023-01-31Z") }); const survivor = candidate("survivor", { semanticKey, amountCents: 999, action: "CONFLICT", reviewState: "BLOCKED" });
    mocks.prisma.financeImportBatch.findUnique.mockResolvedValue(batch([row, survivor], { blockerCount: 2, conflictCount: 2 }));
    const input = { workspaceId: "workspace-1", batchId: "batch-1", expectedVersion: 4, candidateId: row.id, candidateVersions: versions([row]) };
    await expect(reviewFinanceReportImport(actor, { ...input, mode: "REJECT" })).resolves.toMatchObject({ rejectedCount: 1, complete: false });
    expect(mocks.prisma.financeImportCandidate.updateMany).toHaveBeenCalledWith(expect.objectContaining({ data: expect.objectContaining({ action: "ADD", reviewState: "WARNING", approvedByUserId: null }) }));
    expect(mocks.prisma.financeImportBatch.updateMany).toHaveBeenCalledWith(expect.objectContaining({ data: expect.objectContaining({ conflictCount: 0, blockerCount: 0, warningCount: 0, periodStart: new Date("2024-01-01Z"), periodEnd: new Date("2024-01-31Z") }) }));
    const rejected = candidate("reject", { reviewState: "REJECTED" }); mocks.prisma.financeImportBatch.findUnique.mockResolvedValue(batch([rejected]));
    await expect(reviewFinanceReportImport(actor, { ...input, mode: "APPROVE", candidateVersions: versions([rejected]) })).rejects.toMatchObject({ code: "FINANCE_REPORT_REVIEW_BLOCKED" });
    await expect(reviewFinanceReportImport(actor, { ...input, mode: "APPROVE_ALL", candidateVersions: versions([rejected]) })).resolves.toMatchObject({ reviewedCount: 0, complete: true });
    mocks.prisma.financeImportBatch.findUnique.mockResolvedValue(batch([row])); await reviewFinanceReportImport(actor, { ...input, mode: "REJECT", candidateVersions: versions([row]) }); expect(mocks.prisma.financeImportBatch.updateMany.mock.calls.at(-1)?.[0].data).not.toHaveProperty("stage");
    const applied = candidate("applied", { reviewState: "APPLIED" }); mocks.prisma.financeImportBatch.findUnique.mockResolvedValue(batch([applied, row], { stage: "PARTIALLY_APPLIED", asOfDate: row.periodEnd })); await reviewFinanceReportImport(actor, { ...input, mode: "REJECT", candidateVersions: versions([row]) }); expect(mocks.prisma.financeImportBatch.updateMany).toHaveBeenLastCalledWith(expect.objectContaining({ data: expect.objectContaining({ stage: "APPLIED", asOfDate: null }) })); expect(mocks.prisma.financeReport.updateMany).toHaveBeenCalledWith(expect.objectContaining({ data: expect.objectContaining({ periodStart: applied.periodStart, periodEnd: applied.periodEnd, asOfDate: null }) }));
  });
});
