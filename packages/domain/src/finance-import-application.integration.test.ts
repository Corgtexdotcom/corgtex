import type { AppActor } from "@corgtex/shared";
import { getPrismaClient } from "@corgtex/shared";
import { truncateAllTables } from "../../shared/src/db-test-utils";
import { beforeEach, describe, expect, it } from "vitest";
import { applyFinanceReportImport } from "./finance-import-application";
import { buildFinanceReportFactSemanticKey } from "./finance-import-reconciliation";
const prisma = getPrismaClient();
beforeEach(async () => { await truncateAllTables(); });
describe("Finance report application database contract", () => {
  it("persists one traceable Reported Actuals fact and receipt, then no-ops the exact retry", async () => {
    const user = await prisma.user.create({ data: { email: "finance-application@example.com", displayName: "Finance Writer", passwordHash: "test" } });
    const workspace = await prisma.workspace.create({ data: { slug: "finance-application", name: "Finance Application" } });
    await prisma.member.create({ data: { workspaceId: workspace.id, userId: user.id, role: "ADMIN", isActive: true } });
    await prisma.workspaceFeatureFlag.create({ data: { workspaceId: workspace.id, flag: "FINANCE", enabled: true,
      config: { financeAllMemberWrite: true, financeCapabilities: { reports: true, reportImports: true } } } });
    const actor: AppActor = { kind: "user", user }; const periodStart = new Date("2026-01-01Z"), periodEnd = new Date("2026-01-31Z");
    const semanticKey = buildFinanceReportFactSemanticKey({ workspaceId: workspace.id, reportType: "PROFIT_AND_LOSS", basis: "ACCRUAL",
      currency: "EUR", accountPath: ["Revenue"], periodStart, periodEnd });
    const batch = await prisma.financeImportBatch.create({ data: { workspaceId: workspace.id, uploadedByUserId: user.id,
      fileHash: "a".repeat(64), mimeType: "text/csv", originalFilename: "synthetic.csv", fileSizeBytes: 100, stage: "READY_FOR_REVIEW",
      reportType: "PROFIT_AND_LOSS", basis: "ACCRUAL", cadence: "MONTHLY", currencyState: "RESOLVED", resolvedCurrency: "EUR",
      periodStart, periodEnd, asOfDate: periodEnd, addCount: 1 } });
    const candidate = await prisma.financeImportCandidate.create({ data: { workspaceId: workspace.id, batchId: batch.id, sourceKey: "b".repeat(64),
      sourceLocation: { row: 1 }, sourceLabel: "Revenue", sourcePath: ["Revenue"], proposedAccountPath: ["Revenue"], factKind: "LEAF",
      periodStart, periodEnd, amountCents: 12_345, extractionJson: { value: "123.45" }, proposalJson: { value: 12_345 }, action: "ADD",
      reviewState: "APPROVED", semanticKey, confidenceBps: 10_000, evidenceMd: "Synthetic row 1", approvedByUserId: user.id, approvedAt: new Date() } });
    const request = { workspaceId: workspace.id, batchId: batch.id, expectedVersion: batch.version,
      candidateVersions: [{ id: candidate.id, expectedVersion: candidate.version }] };
    const concurrent = await Promise.all([applyFinanceReportImport(actor, request), applyFinanceReportImport(actor, request)]);
    expect(concurrent.map(({ appliedNow }) => appliedNow).sort()).toEqual([0, 1]);
    expect(concurrent.every(({ stage, appliedCount }) => stage === "APPLIED" && appliedCount === 1)).toBe(true);
    const fact = await prisma.financeReportFact.findUniqueOrThrow({ where: { workspaceId_semanticKey: { workspaceId: workspace.id, semanticKey } } });
    expect(fact).toMatchObject({ amountCents: 12_345, sourceBatchId: batch.id, sourceCandidateId: candidate.id, appliedByUserId: user.id });
    const receipt = await prisma.financeImportApplication.findUniqueOrThrow({ where: { candidateId: candidate.id } });
    expect(receipt).toMatchObject({ targetFactId: fact.id, outcome: "CREATED", appliedByUserId: user.id, beforeValueJson: null });
    expect(receipt.afterValueHash).toMatch(/^[a-f0-9]{64}$/);
    await expect(Promise.all([
      prisma.financeTimeEntry.count({ where: { workspaceId: workspace.id } }),
      prisma.financeExpense.count({ where: { workspaceId: workspace.id } }),
      prisma.financeContributionEntry.count({ where: { workspaceId: workspace.id } }),
    ])).resolves.toEqual([0, 0, 0]);
    await expect(applyFinanceReportImport(actor, request)).resolves.toMatchObject({ stage: "APPLIED", appliedCount: 1, appliedNow: 0, noOp: true });
    const refreshed = await prisma.financeImportBatch.findUniqueOrThrow({ where: { id: batch.id }, include: { candidates: true } }); await expect(applyFinanceReportImport(actor, { ...request, expectedVersion: refreshed.version, candidateVersions: [{ id: candidate.id, expectedVersion: refreshed.candidates[0]!.version }] })).resolves.toMatchObject({ stage: "APPLIED", appliedNow: 0, noOp: true });
    await expect(prisma.financeReportFact.count({ where: { workspaceId: workspace.id } })).resolves.toBe(1);
    await expect(prisma.financeImportApplication.count({ where: { workspaceId: workspace.id } })).resolves.toBe(1);
  });
});
