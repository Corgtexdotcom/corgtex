import type { AppActor } from "@corgtex/shared";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  access: vi.fn(),
  prisma: { $transaction: vi.fn(), $executeRaw: vi.fn(), financeImportBatch: { findUnique: vi.fn(), updateMany: vi.fn() },
    financeReport: { create: vi.fn(), update: vi.fn() }, financeReportFact: { findMany: vi.fn(), create: vi.fn(), update: vi.fn() },
    financeImportApplication: { create: vi.fn() }, financeTransaction: { create: vi.fn() }, financeImportCandidate: { updateMany: vi.fn() },
    event: { create: vi.fn() }, auditLog: { create: vi.fn() } },
}));
vi.mock("@corgtex/shared", () => ({ prisma: mocks.prisma }));
vi.mock("./finance", () => ({ requireFinanceReportImportHumanWriteAccess: mocks.access }));

import { buildFinanceReportFactSemanticKey, reconcileFinanceImportCandidates, rerunFinanceReportImportReconciliation } from "./finance-import-reconciliation";

const actor: AppActor = { kind: "user", user: { id: "writer-1", email: "writer@example.com", displayName: "Writer", globalRole: "USER" } };
const start = new Date("2026-01-01T00:00:00.000Z"), end = new Date("2026-01-31T00:00:00.000Z");
const storedNumericFormat = { version: 1, decimalSeparator: "DOT", groupingSeparator: "NONE", amountScale: 1_000 } as const;
const base = { proposedAccountPath: ["Revenue"], factKind: "LEAF" as const, periodStart: start, periodEnd: end, amountCents: 10_000,
  dimensions: null, proposalJson: { numericFormat: storedNumericFormat } };
const candidate = (sourceKey: string, overrides = {}) => ({ id: `candidate-${sourceKey}`, version: 1, sourceKey, ...base, ...overrides });
const identity = { workspaceId: "workspace-1", reportType: "PROFIT_AND_LOSS" as const, basis: "ACCRUAL" as const, currency: "EUR" };
const textClaim = (id: string) => ({ id, role: "TEXT" as const, source: { kind: "CELL" as const, sheet: "Report", row: 1, column: 1, evidence: id } });
const interpretation = { version: 1, classification: { reportType: "PROFIT_AND_LOSS", basis: "ACCRUAL", cadence: "MONTHLY",
  reportTypeEvidenceClaimIds: ["type"], basisEvidenceClaimIds: ["basis"], cadenceEvidenceClaimIds: ["cadence"], confidence: 1 },
numericFormat: { status: "RESOLVED", ...storedNumericFormat,
  decimalSeparatorEvidenceClaimIds: [], groupingSeparatorEvidenceClaimIds: [], amountScaleEvidenceClaimIds: ["scale"], confidence: 1 },
evidenceClaims: ["type", "basis", "cadence", "scale"].map(textClaim), exceptions: [] };

describe("Finance report reconciliation", () => {
  beforeEach(() => {
    vi.clearAllMocks(); mocks.access.mockResolvedValue({}); mocks.prisma.$transaction.mockImplementation((work) => work(mocks.prisma));
    mocks.prisma.$executeRaw.mockResolvedValue(1); mocks.prisma.financeImportBatch.updateMany.mockResolvedValue({ count: 1 });
    mocks.prisma.financeImportCandidate.updateMany.mockResolvedValue({ count: 1 }); mocks.prisma.financeReportFact.findMany.mockResolvedValue([]);
    mocks.prisma.event.create.mockResolvedValue({}); mocks.prisma.auditLog.create.mockResolvedValue({});
  });

  it("builds stable normalized keys without collapsing real identity differences", () => {
    const key = buildFinanceReportFactSemanticKey({ ...identity, accountPath: [" Revenue ", "Product  A"], periodStart: start, periodEnd: end,
      dimensions: { region: "EU", channel: { direct: true, rank: 1 } } });
    expect(buildFinanceReportFactSemanticKey({ ...identity, currency: " eur ", accountPath: ["revenue", "product a"], periodStart: start, periodEnd: end,
      dimensions: { channel: { rank: 1, direct: true }, region: "EU" } })).toBe(key);
    const variants = [
      { currency: "USD" }, { accountPath: ["Revenue", "Product B"] }, { periodEnd: new Date("2026-02-28T00:00:00.000Z") },
      { dimensions: { region: "US", channel: { direct: true, rank: 1 } } },
    ].map((change) => buildFinanceReportFactSemanticKey({ ...identity, accountPath: ["Revenue", "Product A"], periodStart: start, periodEnd: end,
      dimensions: { region: "EU", channel: { direct: true, rank: 1 } }, ...change }));
    expect(new Set([key, ...variants])).toHaveLength(5);
    expect(key).toMatch(/^[a-f0-9]{64}$/);
    expect(() => buildFinanceReportFactSemanticKey({ ...identity, currency: "ZZZ", accountPath: ["Revenue"], periodStart: start, periodEnd: end }))
      .toThrow("ISO 4217");
    expect(() => buildFinanceReportFactSemanticKey({ ...identity, accountPath: ["Revenue"], periodStart: end, periodEnd: start })).toThrow("reversed");
  });

  it("classifies exact add, restatement, unchanged, duplicate, conflict, derived, and invalid identities", () => {
    const update = candidate("b", { proposedAccountPath: ["Expense"], amountCents: 2147483647 });
    const unchanged = candidate("c", { proposedAccountPath: ["Cash"], amountCents: -2147483648 });
    const duplicateA = candidate("d", { proposedAccountPath: ["Customers"] }), duplicateB = candidate("e", { proposedAccountPath: ["customers "] });
    const conflictA = candidate("f", { proposedAccountPath: ["Tax"], amountCents: 100 }), conflictB = candidate("g", { proposedAccountPath: ["tax"], amountCents: 101 });
    const keys = [update, unchanged].map((item) => buildFinanceReportFactSemanticKey({ ...identity, accountPath: item.proposedAccountPath,
      periodStart: item.periodStart, periodEnd: item.periodEnd, dimensions: item.dimensions }));
    const result = reconcileFinanceImportCandidates({ ...identity, candidates: [candidate("a"), update, unchanged, duplicateB, duplicateA, conflictA,
      conflictB, candidate("h", { factKind: "DERIVED" }), candidate("i", { proposedAccountPath: [" "] }), candidate("j", { periodStart: end, periodEnd: start })], currentFacts: [
      { id: "fact-update", semanticKey: keys[0]!, kind: "LEAF", amountCents: 50 },
      { id: "fact-same", semanticKey: keys[1]!, kind: "LEAF", amountCents: -2147483648 },
    ] });
    const actions = Object.fromEntries(result.decisions.map(({ candidate: item, action }) => [item.sourceKey, action]));
    expect(actions).toEqual({ a: "ADD", b: "UPDATE", c: "UNCHANGED", d: "ADD", e: "DUPLICATE", f: "CONFLICT", g: "CONFLICT", h: "SKIP", i: "CONFLICT", j: "CONFLICT" });
    expect(result.counts).toEqual({ addCount: 2, updateCount: 1, unchangedCount: 1, duplicateCount: 1, conflictCount: 4, skippedCount: 1 });
    expect(result.decisions.find(({ candidate: item }) => item.sourceKey === "b")).toMatchObject({ currentFactId: "fact-update", currentAmountCents: 50,
      reviewState: "PROPOSED", explanationMd: "Restatement from 50 to 2147483647 cents." });
    expect(result.decisions.filter(({ action }) => action === "CONFLICT").every(({ reviewState }) => reviewState === "BLOCKED")).toBe(true);
  });

  it("reruns every candidate under human access, exact versions, currency, and scale without canonical writes", async () => {
    const row = candidate("a", { periodStart: new Date("2025-12-01T00:00:00.000Z"), periodEnd: new Date("2026-02-28T00:00:00.000Z") });
    const batch = { id: "batch-1", workspaceId: "workspace-1", version: 5, stage: "NEEDS_INPUT", reportType: "BALANCE_SHEET", basis: "CASH",
      interpretationJson: { ...interpretation, exceptions: [{ code: "REVIEW_NOTE", severity: "WARNING", message: "Review.", evidenceClaimIds: ["type"] }] }, candidates: [row] };
    mocks.prisma.financeImportBatch.findUnique.mockResolvedValue(batch);
    await expect(rerunFinanceReportImportReconciliation(actor, { workspaceId: "workspace-1", batchId: "batch-1", expectedVersion: 5,
      candidateVersions: [{ id: row.id, expectedVersion: 1 }], confirmedCurrency: " eur ", confirmedAmountScale: 1_000 }))
      .resolves.toMatchObject({ batchId: "batch-1", version: 6, stage: "READY_FOR_REVIEW", addCount: 1, conflictCount: 0 });
    expect(mocks.access).toHaveBeenCalledWith(actor, "workspace-1");
    expect(mocks.prisma.financeImportCandidate.updateMany).toHaveBeenCalledWith(expect.objectContaining({ where: expect.objectContaining({ id: row.id, version: 1 }),
      data: expect.objectContaining({ action: "ADD", reviewState: "PROPOSED", approvedByUserId: null, version: { increment: 1 } }) }));
    expect(mocks.prisma.financeImportBatch.updateMany).toHaveBeenCalledWith(expect.objectContaining({ data: expect.objectContaining({ resolvedCurrency: "EUR",
      currencyResolutionSource: "USER_CONFIRMED", currencyConfirmedByUserId: "writer-1", stage: "READY_FOR_REVIEW", addCount: 1 }) }));
    expect(mocks.prisma.financeImportBatch.updateMany).toHaveBeenCalledWith(expect.objectContaining({ data: expect.objectContaining({
      reportType: "PROFIT_AND_LOSS", basis: "ACCRUAL", cadence: "MONTHLY", warningCount: 1,
      periodStart: new Date("2025-12-01T00:00:00.000Z"), periodEnd: new Date("2026-02-28T00:00:00.000Z") }) }));
    expect([mocks.prisma.financeReport.create, mocks.prisma.financeReport.update, mocks.prisma.financeReportFact.create,
      mocks.prisma.financeReportFact.update, mocks.prisma.financeImportApplication.create, mocks.prisma.financeTransaction.create]
      .every((write) => write.mock.calls.length === 0)).toBe(true);
  });

  it("fails closed on unresolved scale, missing candidates, or stale batch/candidate versions", async () => {
    const row = candidate("a"), resolved = { id: "batch-1", workspaceId: "workspace-1", version: 5, stage: "NEEDS_INPUT", reportType: "PROFIT_AND_LOSS",
      basis: "ACCRUAL", interpretationJson: interpretation, candidates: [row] };
    const run = (change = {}, input = {}) => { mocks.prisma.financeImportBatch.findUnique.mockResolvedValue({ ...resolved, ...change });
      return rerunFinanceReportImportReconciliation(actor, { workspaceId: "workspace-1", batchId: "batch-1", expectedVersion: 5,
        candidateVersions: [{ id: row.id, expectedVersion: 1 }], confirmedCurrency: "EUR", confirmedAmountScale: 1_000, ...input }); };
    await expect(run({ interpretationJson: { ...interpretation, numericFormat: { status: "UNRESOLVED", version: 1, decimalSeparator: null,
      groupingSeparator: null, amountScale: null, evidenceClaimIds: [], confidence: 0 }, evidenceClaims: interpretation.evidenceClaims.slice(0, 3),
      exceptions: [{ code: "NUMERIC_FORMAT_UNRESOLVED", severity: "BLOCKER", message: "Confirm format.", evidenceClaimIds: [] }] } }))
      .rejects.toMatchObject({ code: "FINANCE_REPORT_CLARIFICATION_REQUIRED" });
    await expect(run({ candidates: [] })).rejects.toMatchObject({ code: "FINANCE_REPORT_CLARIFICATION_REQUIRED" });
    await expect(run({}, { expectedVersion: 4 })).rejects.toMatchObject({ code: "FINANCE_REPORT_RECONCILIATION_CONFLICT" });
    await expect(run({}, { candidateVersions: [{ id: row.id, expectedVersion: 2 }] })).rejects.toMatchObject({ code: "FINANCE_REPORT_RECONCILIATION_CONFLICT" });
    await expect(run({}, { confirmedAmountScale: 1 })).rejects.toMatchObject({ code: "FINANCE_REPORT_CLARIFICATION_REQUIRED" });
    await expect(run({ candidates: [candidate("a", { proposalJson: { numericFormat: { ...storedNumericFormat, groupingSeparator: "COMMA" } } })] }))
      .rejects.toMatchObject({ code: "FINANCE_REPORT_CLARIFICATION_REQUIRED" });
    await expect(run({}, { confirmedCurrency: "" })).rejects.toMatchObject({ code: "INVALID_INPUT" });
    expect(mocks.prisma.financeImportCandidate.updateMany).not.toHaveBeenCalled();
  });

  it("rejects a shape-valid non-ISO confirmation before starting a write transaction", async () => {
    await expect(rerunFinanceReportImportReconciliation(actor, { workspaceId: "workspace-1", batchId: "batch-1", expectedVersion: 5,
      candidateVersions: [], confirmedCurrency: "ZZZ", confirmedAmountScale: 1_000 })).rejects.toMatchObject({ code: "INVALID_INPUT" });
    expect(mocks.prisma.$transaction).not.toHaveBeenCalled();
    expect(mocks.prisma.financeImportCandidate.updateMany).not.toHaveBeenCalled();
    expect(mocks.prisma.financeImportBatch.updateMany).not.toHaveBeenCalled();
  });

  it("stops the transaction before the batch transition when a candidate version loses the race", async () => {
    const rows = [candidate("a"), candidate("b", { proposedAccountPath: ["Expense"] })];
    mocks.prisma.financeImportBatch.findUnique.mockResolvedValue({ id: "batch-1", workspaceId: "workspace-1", version: 5, stage: "READY_FOR_REVIEW",
      reportType: "PROFIT_AND_LOSS", basis: "ACCRUAL", interpretationJson: interpretation, candidates: rows });
    mocks.prisma.financeImportCandidate.updateMany.mockResolvedValueOnce({ count: 1 }).mockResolvedValueOnce({ count: 0 });
    await expect(rerunFinanceReportImportReconciliation(actor, { workspaceId: "workspace-1", batchId: "batch-1", expectedVersion: 5,
      candidateVersions: rows.map(({ id, version }) => ({ id, expectedVersion: version })), confirmedCurrency: "EUR", confirmedAmountScale: 1_000 }))
      .rejects.toMatchObject({ code: "FINANCE_REPORT_RECONCILIATION_CONFLICT" });
    expect(mocks.prisma.financeImportBatch.updateMany).not.toHaveBeenCalled();
    expect(mocks.prisma.event.create).not.toHaveBeenCalled();
  });
});
