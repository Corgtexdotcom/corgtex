import type { AppActor } from "@corgtex/shared";
import { beforeEach, describe, expect, it, vi } from "vitest";
const mocks = vi.hoisted(() => ({ write: vi.fn(), prisma: { $transaction: vi.fn(), $executeRaw: vi.fn(),
  financeImportBatch: { findUnique: vi.fn(), updateMany: vi.fn() }, financeReport: { upsert: vi.fn() },
  financeReportFact: { findUnique: vi.fn(), create: vi.fn(), updateMany: vi.fn() }, financeImportApplication: { create: vi.fn(), count: vi.fn() },
  financeImportCandidate: { updateMany: vi.fn() }, auditLog: { create: vi.fn() }, financeTransaction: { create: vi.fn() } } }));
vi.mock("@corgtex/shared", () => ({ prisma: mocks.prisma }));
vi.mock("./finance", () => ({ requireFinanceReportImportHumanWriteAccess: mocks.write }));
import { applyFinanceReportImport } from "./finance-import-application";
import { buildFinanceReportFactSemanticKey } from "./finance-import-reconciliation";
const actor: AppActor = { kind: "user", user: { id: "writer-1", email: "writer@example.com", displayName: "Writer", globalRole: "USER" } };
const semantic = (value: string) => value.padEnd(64, value);
const candidate = (id: string, change: Record<string, unknown> = {}) => { const row = { id, sourceKey: semantic(id), proposedAccountPath: ["Revenue", id], factKind: "LEAF",
  periodStart: new Date("2026-01-01Z"), periodEnd: new Date("2026-01-31Z"), amountCents: 100, dimensions: null, action: "ADD",
  reviewState: "APPROVED", currentFactId: null, currentAmountCents: null, editedByUserId: null, editedAt: null, approvedByUserId: "reviewer-1",
  approvedAt: new Date("2026-02-01Z"), version: 2, application: null, ...change }; return { ...row, semanticKey: "semanticKey" in change ? change.semanticKey as string | null
    : row.action === "SKIP" ? null : buildFinanceReportFactSemanticKey({ workspaceId: "workspace-1", reportType: "PROFIT_AND_LOSS", basis: "ACCRUAL",
      currency: "EUR", accountPath: row.proposedAccountPath, periodStart: row.periodStart, periodEnd: row.periodEnd, dimensions: row.dimensions }) }; };
const batch = (candidates = [candidate("add")], change = {}) => ({ id: "batch-1", workspaceId: "workspace-1", stage: "READY_FOR_REVIEW",
  uploadedByUserId: "uploader-1", originalFilename: "synthetic.csv",
  reportType: "PROFIT_AND_LOSS", basis: "ACCRUAL", cadence: "MONTHLY", resolvedCurrency: "EUR", periodStart: new Date("2026-01-01Z"),
  periodEnd: new Date("2026-01-31Z"), asOfDate: new Date("2026-01-31Z"), title: "Synthetic P&L", version: 4, appliedCount: 0,
  report: null, candidates, ...change });
const fact = (id: string, change = {}) => ({ id, reportId: "report-old", accountPath: ["Revenue"], kind: "LEAF", periodStart: new Date("2026-01-01Z"),
  periodEnd: new Date("2026-01-31Z"), amountCents: 100, dimensions: null, semanticKey: semantic(id[0]!), sourceBatchId: "batch-old",
  sourceCandidateId: "candidate-old", appliedByUserId: "writer-old", version: 3, ...change });
const input = (rows: ReturnType<typeof candidate>[], expectedVersion = 4) => ({ workspaceId: "workspace-1", batchId: "batch-1", expectedVersion,
  candidateVersions: rows.map(({ id, version }) => ({ id, expectedVersion: version })) });
describe("Finance report application", () => {
  beforeEach(() => { vi.clearAllMocks(); mocks.prisma.$transaction.mockImplementation((work) => work(mocks.prisma)); mocks.prisma.$executeRaw.mockResolvedValue(1);
    mocks.prisma.financeReport.upsert.mockResolvedValue({ id: "report-1" }); mocks.prisma.financeReportFact.findUnique.mockResolvedValue(null);
    mocks.prisma.financeReportFact.create.mockImplementation(({ data }) => Promise.resolve(fact("fact-new", { ...data, id: "fact-new", version: 1 })));
    mocks.prisma.financeReportFact.updateMany.mockResolvedValue({ count: 1 }); mocks.prisma.financeImportCandidate.updateMany.mockResolvedValue({ count: 1 });
    mocks.prisma.financeImportApplication.create.mockImplementation(({ data }) => Promise.resolve({ id: `receipt-${data.candidateId}`, outcome: data.outcome,
      targetFactId: data.targetFactId, idempotencyKey: data.idempotencyKey })); mocks.prisma.financeImportApplication.count.mockResolvedValue(1);
    mocks.prisma.financeImportBatch.updateMany.mockResolvedValue({ count: 1 }); mocks.prisma.auditLog.create.mockResolvedValue({}); });
  it("requires a human Finance writer and exact approved versions before canonical writes", async () => {
    const agent: AppActor = { kind: "agent", authProvider: "bootstrap", label: "agent-1", workspaceIds: ["workspace-1"], scopes: ["finance:read"] };
    await expect(applyFinanceReportImport(agent, input([candidate("add")]))).rejects.toMatchObject({ code: "HUMAN_APPLICATION_REQUIRED" });
    mocks.prisma.financeImportBatch.findUnique.mockResolvedValue(batch([candidate("add", { reviewState: "WARNING" })]));
    await expect(applyFinanceReportImport(actor, input([candidate("add")]))).rejects.toMatchObject({ code: "FINANCE_REPORT_APPLICATION_BLOCKED" });
    mocks.prisma.financeImportBatch.findUnique.mockResolvedValue(batch([candidate("add")], { version: 5 }));
    await expect(applyFinanceReportImport(actor, input([candidate("add")]))).rejects.toMatchObject({ code: "FINANCE_REPORT_APPLICATION_CONFLICT" });
    expect(mocks.write).toHaveBeenCalledWith(actor, "workspace-1"); expect(mocks.prisma.financeReport.upsert).not.toHaveBeenCalled();
  });
  it("creates only Reported Actuals and immutable created/skipped receipts with provenance", async () => {
    const add = candidate("add"); const duplicate = candidate("duplicate", { action: "DUPLICATE", proposedAccountPath: add.proposedAccountPath, semanticKey: add.semanticKey });
    const skip = candidate("skip", { action: "SKIP", factKind: "DERIVED", semanticKey: null }); const rows = [add, duplicate, skip];
    mocks.prisma.financeImportBatch.findUnique.mockResolvedValue(batch(rows, { title: null })); const created = fact("fact-new", { id: "fact-new", semanticKey: add.semanticKey,
      reportId: "report-1", sourceBatchId: "batch-1", sourceCandidateId: "add", appliedByUserId: "writer-1", version: 1 });
    mocks.prisma.financeReportFact.create.mockResolvedValue(created); mocks.prisma.financeReportFact.findUnique
      .mockResolvedValueOnce(null).mockResolvedValueOnce(created); mocks.prisma.financeImportApplication.count.mockResolvedValue(3);
    const result = await applyFinanceReportImport(actor, input(rows));
    expect(result).toMatchObject({ stage: "APPLIED", appliedNow: 3, appliedCount: 3, noOp: false });
    expect(result.receipts.map(({ outcome }) => outcome)).toEqual(["CREATED", "SKIPPED", "SKIPPED"]);
    expect(mocks.prisma.financeReportFact.create).toHaveBeenCalledWith(expect.objectContaining({ data: expect.objectContaining({ reportId: "report-1",
      sourceBatchId: "batch-1", sourceCandidateId: "add", appliedByUserId: "writer-1" }) }));
    expect(mocks.prisma.financeReport.upsert).toHaveBeenCalledWith(expect.objectContaining({ create: expect.objectContaining({ title: "synthetic.csv" }) })); expect(mocks.prisma.financeImportApplication.create).toHaveBeenCalledTimes(3); expect(mocks.prisma.financeTransaction.create).not.toHaveBeenCalled(); expect(mocks.prisma.$transaction).toHaveBeenCalledWith(expect.any(Function), expect.objectContaining({ timeout: 120_000 }));
    expect(mocks.prisma.financeImportBatch.updateMany).toHaveBeenCalledWith(expect.objectContaining({ data: expect.objectContaining({ stage: "APPLIED", appliedCount: 3, appliedByUserId: "writer-1" }) }));
  });
  it("restates with optimistic versions and records unchanged before/after receipts", async () => {
    const update = candidate("update", { action: "UPDATE", currentFactId: "fact-u", currentAmountCents: 50 });
    const unchanged = candidate("same", { action: "UNCHANGED", currentFactId: "fact-s", currentAmountCents: 100 });
    const oldUpdate = fact("fact-u", { semanticKey: update.semanticKey, amountCents: 50 }); const oldSame = fact("fact-s", { semanticKey: unchanged.semanticKey });
    mocks.prisma.financeImportBatch.findUnique.mockResolvedValue(batch([update, unchanged])); mocks.prisma.financeReportFact.findUnique
      .mockResolvedValueOnce(oldUpdate).mockResolvedValueOnce(oldSame); mocks.prisma.financeImportApplication.count.mockResolvedValue(2);
    const result = await applyFinanceReportImport(actor, input([update, unchanged]));
    expect(result.receipts.map(({ outcome }) => outcome)).toEqual(["UPDATED", "UNCHANGED"]);
    expect(mocks.prisma.financeReportFact.updateMany).toHaveBeenCalledWith(expect.objectContaining({ where: expect.objectContaining({ id: "fact-u", version: 3,
      amountCents: 50 }), data: expect.objectContaining({ reportId: "report-1", amountCents: 100, sourceBatchId: "batch-1", sourceCandidateId: "update", version: { increment: 1 } }) }));
    expect(mocks.prisma.financeReportFact.updateMany).toHaveBeenLastCalledWith(expect.objectContaining({ data: expect.objectContaining({ reportId: "report-1", sourceCandidateId: "same", version: { increment: 1 } }) }));
    const receiptData = mocks.prisma.financeImportApplication.create.mock.calls.map(([{ data }]) => data); expect(receiptData.every(({ beforeValueHash, afterValueHash }) => beforeValueHash && afterValueHash)).toBe(true);
  });
  it("partially applies approved rows, resumes without replay, and exact retries are no-ops", async () => {
    const add = candidate("add"); const pending = candidate("pending");
    mocks.prisma.financeImportBatch.findUnique.mockResolvedValue(batch([add, pending])); const first = await applyFinanceReportImport(actor, input([add]));
    expect(first).toMatchObject({ stage: "PARTIALLY_APPLIED", appliedNow: 1 }); const receipt = first.receipts[0]!;
    const applied = candidate("add", { reviewState: "APPLIED", version: 3, application: { id: receipt.id, idempotencyKey: receipt.idempotencyKey,
      outcome: receipt.outcome, targetFactId: receipt.targetFactId } }); mocks.prisma.financeImportBatch.findUnique.mockResolvedValue(batch([applied, pending], { stage: "PARTIALLY_APPLIED", version: 5, appliedCount: 1 }));
    await expect(applyFinanceReportImport(actor, input([add]))).resolves.toMatchObject({ noOp: true, appliedNow: 0, appliedCount: 1 });
    expect(mocks.prisma.financeReport.upsert).toHaveBeenCalledTimes(1); expect(mocks.prisma.financeReportFact.create).toHaveBeenCalledTimes(1);
  });
  it("rolls back the wave when the optimistic current-fact write loses", async () => {
    const update = candidate("update", { action: "UPDATE", currentFactId: "fact-u", currentAmountCents: 50 });
    mocks.prisma.financeImportBatch.findUnique.mockResolvedValue(batch([update])); mocks.prisma.financeReportFact.findUnique.mockResolvedValue(fact("fact-u", { semanticKey: update.semanticKey, amountCents: 50 }));
    mocks.prisma.financeReportFact.updateMany.mockResolvedValue({ count: 0 });
    await expect(applyFinanceReportImport(actor, input([update]))).rejects.toMatchObject({ code: "FINANCE_REPORT_APPLICATION_CONFLICT" });
    expect(mocks.prisma.financeImportApplication.create).not.toHaveBeenCalled(); expect(mocks.prisma.financeImportCandidate.updateMany).not.toHaveBeenCalled();
  });
  it("revalidates version-safe historical peer approval and the canonical semantic identity", async () => {
    const staleWarning = candidate("add", { periodStart: new Date("2025-07-01Z"), periodEnd: new Date("2025-07-31Z"), approvedAt: new Date("2025-08-01Z") }); mocks.prisma.financeImportBatch.findUnique.mockResolvedValue(batch([staleWarning]));
    await expect(applyFinanceReportImport(actor, input([staleWarning]))).rejects.toMatchObject({ code: "FINANCE_REPORT_APPLICATION_BLOCKED" });
    const stalePeer = candidate("update", { action: "UPDATE", currentFactId: "fact-u", currentAmountCents: 50,
      periodStart: new Date("2024-01-01Z"), periodEnd: new Date("2024-01-31Z"),
      editedByUserId: "writer-1", editedAt: new Date("2026-02-02Z"), approvedByUserId: "reviewer-1", approvedAt: new Date("2026-02-01Z") });
    mocks.prisma.financeImportBatch.findUnique.mockResolvedValue(batch([stalePeer]));
    await expect(applyFinanceReportImport(actor, input([stalePeer]))).rejects.toMatchObject({ code: "FINANCE_REPORT_APPLICATION_BLOCKED" });
    const tampered = candidate("add", { semanticKey: semantic("tampered") }); mocks.prisma.financeImportBatch.findUnique.mockResolvedValue(batch([tampered]));
    await expect(applyFinanceReportImport(actor, input([tampered]))).rejects.toMatchObject({ code: "FINANCE_REPORT_APPLICATION_CONFLICT" });
    expect(mocks.prisma.financeReport.upsert).not.toHaveBeenCalled();
  });
});
