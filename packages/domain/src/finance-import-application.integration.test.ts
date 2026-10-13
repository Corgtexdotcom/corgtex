import type { AppActor } from "@corgtex/shared";
import { getPrismaClient } from "@corgtex/shared";
import { truncateAllTables } from "../../shared/src/db-test-utils";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { createFinanceReportImportUpload } from "./finance-import-upload";
import { captureArtifactInputProof, captureImmutableArtifactInputProof, recordArtifactInputLineage } from "./source-lineage";
import { applyFinanceReportImport } from "./finance-import-application";
import { buildFinanceReportFactSemanticKey, captureFinanceCurrentFactProof } from "./finance-import-reconciliation";
const prisma = getPrismaClient();
beforeEach(async () => { await truncateAllTables(); });
describe("Finance report application database contract", () => {
  it("withholds a restatement whose Fact parent transition invalidates its historical proof and rolls back every effect", async () => {
    const alice = await prisma.user.create({data: {email: "finance-restatement-alice@example.test", displayName: "Synthetic Alice", passwordHash: "synthetic"}});
    const bob = await prisma.user.create({data: {email: "finance-restatement-bob@example.test", displayName: "Synthetic Bob", passwordHash: "synthetic"}});
    const workspace = await prisma.workspace.create({data: {slug: "finance-restatement", name: "Synthetic restatement"}});
    await prisma.member.createMany({data: [alice, bob].map(user => ({workspaceId: workspace.id, userId: user.id, role: "ADMIN" as const, isActive: true}))});
    await prisma.workspaceFeatureFlag.create({data: {workspaceId: workspace.id, flag: "FINANCE", enabled: true,
      config: {financeAllMemberWrite: true, financeCapabilities: {reports: true, reportImports: true}}}});
    const actor: AppActor = {kind: "user", user: alice};
    const approver: AppActor = {kind: "user", user: bob};
    // Earlier than the twelve-month historical peer-approval cutoff.
    const periodStart = new Date("2024-01-01Z"), periodEnd = new Date("2024-01-31Z");
    const semanticKey = buildFinanceReportFactSemanticKey({workspaceId: workspace.id, reportType: "PROFIT_AND_LOSS", basis: "ACCRUAL",
      currency: "EUR", accountPath: ["Revenue"], periodStart, periodEnd});
    const ready = async (amountCents: number) => {
      const uploaded = await createFinanceReportImportUpload(actor, {workspaceId: workspace.id,
        fileBuffer: Buffer.from(`Account,Amount\nRevenue,${(amountCents / 100).toFixed(2)}\n`),
        fileName: `synthetic-${amountCents}.csv`, mimeType: "text/csv", storage: {put: async (key, data) => ({key, size: data.length})}});
      return prisma.$transaction(async tx => {
        const current = await tx.financeReportFact.findUnique({where: {workspaceId_semanticKey: {workspaceId: workspace.id, semanticKey}}});
        const uploadRoots = await captureArtifactInputProof(actor, workspace.id,
          [{kind: "FinanceImportBatch", id: uploaded.batch.id, snapshot: uploaded.batch}], tx);
        const currentRoots = await captureFinanceCurrentFactProof(tx, actor, workspace.id, current ? [current] : []);
        const inputs = await captureImmutableArtifactInputProof(actor, workspace.id, [...uploadRoots, ...currentRoots], tx);
        // Fresh deterministic synthetic proposal, with every copied field bound
        // to the genuine upload and the exact current Fact used for comparison.
        const batch = await tx.financeImportBatch.update({where: {id: uploaded.batch.id}, data: {stage: "READY_FOR_REVIEW",
          reportType: "PROFIT_AND_LOSS", basis: "ACCRUAL", cadence: "MONTHLY", currencyState: "RESOLVED", resolvedCurrency: "EUR",
          periodStart, periodEnd, asOfDate: periodEnd, addCount: current ? 0 : 1, updateCount: current ? 1 : 0, version: {increment: 1}}});
        const candidate = await tx.financeImportCandidate.create({data: {workspaceId: workspace.id, batchId: batch.id,
          sourceKey: (current ? "c" : "b").repeat(64), sourceLocation: {row: 1}, sourceLabel: "Revenue", sourcePath: ["Revenue"],
          proposedAccountPath: ["Revenue"], factKind: "LEAF", periodStart, periodEnd, amountCents,
          extractionJson: {value: (amountCents / 100).toFixed(2)}, proposalJson: {value: amountCents},
          action: current ? "UPDATE" : "ADD", reviewState: "APPROVED", semanticKey,
          currentFactId: current?.id ?? null, currentAmountCents: current?.amountCents ?? null,
          confidenceBps: 10_000, evidenceMd: "Synthetic row 1", approvedByUserId: bob.id, approvedAt: new Date()}});
        await recordArtifactInputLineage({tx, actor, workspaceId: workspace.id, artifact: {kind: "FinanceImportCandidate", id: candidate.id},
          content: candidate, origin: "DERIVED", inputs: [], inheritedRoots: inputs});
        const candidateRoots = await captureArtifactInputProof(actor, workspace.id,
          [{kind: "FinanceImportCandidate", id: candidate.id, snapshot: candidate}], tx);
        await recordArtifactInputLineage({tx, actor, workspaceId: workspace.id, artifact: {kind: "FinanceImportBatch", id: batch.id},
          content: batch, origin: "DERIVED", inputs: [], inheritedRoots: [...inputs, ...candidateRoots]});
        return {batch, candidate};
      }, {timeout: 120_000});
    };
    const request = (prepared: Awaited<ReturnType<typeof ready>>) => ({workspaceId: workspace.id, batchId: prepared.batch.id,
      expectedVersion: prepared.batch.version, candidateVersions: [{id: prepared.candidate.id, expectedVersion: prepared.candidate.version}]});
    const first = await ready(12_345);
    await expect(applyFinanceReportImport(approver, request(first))).resolves.toMatchObject({appliedNow: 1});
    const oldFact = await prisma.financeReportFact.findUniqueOrThrow({where: {workspaceId_semanticKey: {workspaceId: workspace.id, semanticKey}}});
    const oldManifests = await prisma.artifactInputLineage.findMany({where: {workspaceId: workspace.id,
      artifactType: "FinanceReportFact", artifactId: oldFact.id}, orderBy: {revision: "asc"}});
    const second = await ready(23_456);
    const retainedState = () => Promise.all([
      prisma.artifactInputLineage.findMany({where: {workspaceId: workspace.id}, orderBy: {id: "asc"}}),
      prisma.artifactInputSnapshot.findMany({where: {workspaceId: workspace.id}, orderBy: {id: "asc"}}),
      prisma.auditLog.findMany({where: {workspaceId: workspace.id}, orderBy: {id: "asc"}}),
      prisma.sourcePermissionEpoch.findMany({where: {workspaceId: workspace.id}, orderBy: {id: "asc"}}),
      prisma.event.findMany({where: {workspaceId: workspace.id}, orderBy: {id: "asc"}}),
    ]);
    const before = await retainedState();
    const transition = {updated: false, beforeEpoch: 0n, afterEpoch: 0n, fact: null as typeof oldFact | null};
    const originalTransaction = prisma.$transaction.bind(prisma) as (...args: any[]) => Promise<any>;
    // Observe genuine DML and genuine same-connection trigger results. No row,
    // epoch, query result or receipt is replaced by this phase probe.
    const probe = vi.spyOn(prisma, "$transaction").mockImplementation(async (...args: any[]) => {
      if (typeof args[0] !== "function") return originalTransaction(...args);
      return originalTransaction(async (tx: any) => {
        const factDelegate = new Proxy(tx.financeReportFact, {get(delegate, key) {
          const method = Reflect.get(delegate, key, delegate);
          if (key !== "updateMany") return typeof method === "function" ? method.bind(delegate) : method;
          return async (...values: any[]) => {
            const where = {workspaceId_sourceKind_sourceId: {workspaceId: workspace.id, sourceKind: "FinanceReportFact", sourceId: oldFact.id}};
            transition.beforeEpoch = (await tx.sourcePermissionEpoch.findUniqueOrThrow({where})).epoch;
            const result = await method.apply(delegate, values);
            transition.updated = result.count === 1;
            transition.fact = await tx.financeReportFact.findUniqueOrThrow({where: {id: oldFact.id}});
            transition.afterEpoch = (await tx.sourcePermissionEpoch.findUniqueOrThrow({where})).epoch;
            return result;
          };
        }});
        const observed = new Proxy(tx, {get(connection, key) {
          if (key === "financeReportFact") return factDelegate;
          const value = Reflect.get(connection, key, connection);
          return typeof value === "function" ? value.bind(connection) : value;
        }});
        return args[0](observed);
      }, ...args.slice(1));
    });
    // This is a documented safety regression, not successful restatement
    // acceptance. The real parent-binding trigger invalidates the old Fact key;
    // changing that saved vector to today's epoch would grant false lineage.
    try {
      await expect(applyFinanceReportImport(approver, request(second))).rejects.toMatchObject({code: "SOURCE_CHANGED"});
    } finally {probe.mockRestore();}
    expect(transition.updated).toBe(true);
    expect(transition.fact).toMatchObject({id: oldFact.id, version: oldFact.version + 1, amountCents: 23_456,
      sourceBatchId: second.batch.id, sourceCandidateId: second.candidate.id});
    expect(transition.fact?.reportId).not.toBe(oldFact.reportId);
    expect(transition.afterEpoch).toBeGreaterThan(transition.beforeEpoch);
    expect(await prisma.financeReportFact.findUniqueOrThrow({where: {id: oldFact.id}})).toEqual(oldFact);
    expect(await prisma.artifactInputLineage.findMany({where: {workspaceId: workspace.id,
      artifactType: "FinanceReportFact", artifactId: oldFact.id}, orderBy: {revision: "asc"}})).toEqual(oldManifests);
    expect(await prisma.financeImportBatch.findUniqueOrThrow({where: {id: second.batch.id}})).toEqual(second.batch);
    expect(await prisma.financeImportCandidate.findUniqueOrThrow({where: {id: second.candidate.id}})).toEqual(second.candidate);
    expect(await prisma.financeReport.count({where: {sourceBatchId: second.batch.id}})).toBe(0);
    expect(await prisma.financeImportApplication.count({where: {candidateId: second.candidate.id}})).toBe(0);
    expect(await retainedState()).toEqual(before);
  }, 240_000);

  it("persists one traceable Reported Actuals fact and receipt, then no-ops the exact retry", async () => {
    const user = await prisma.user.create({ data: { email: "finance-application@example.com", displayName: "Finance Writer", passwordHash: "test" } });
    const workspace = await prisma.workspace.create({ data: { slug: "finance-application", name: "Finance Application" } });
    await prisma.member.create({ data: { workspaceId: workspace.id, userId: user.id, role: "ADMIN", isActive: true } });
    await prisma.workspaceFeatureFlag.create({ data: { workspaceId: workspace.id, flag: "FINANCE", enabled: true,
      config: { financeAllMemberWrite: true, financeCapabilities: { reports: true, reportImports: true } } } });
    const actor: AppActor = { kind: "user", user }; const periodStart = new Date("2026-01-01Z"), periodEnd = new Date("2026-01-31Z");
    const semanticKey = buildFinanceReportFactSemanticKey({ workspaceId: workspace.id, reportType: "PROFIT_AND_LOSS", basis: "ACCRUAL",
      currency: "EUR", accountPath: ["Revenue"], periodStart, periodEnd });
    const fileBuffer = Buffer.from("Account,Amount\nRevenue,123.45\n");
    const uploaded = await createFinanceReportImportUpload(actor, { workspaceId: workspace.id, fileBuffer, fileName: "synthetic.csv", mimeType: "text/csv",
      storage: { put: async (key, data) => ({ key, size: data.length }) } });
    // Fresh deterministic fixture output; every copied field has this exact upload input.
    // Existing legacy rows never pass through this fixture admission.
    const { batch, candidate } = await prisma.$transaction(async tx => {
      const inputs = await captureImmutableArtifactInputProof(actor, workspace.id,
        await captureArtifactInputProof(actor, workspace.id, [{ kind: "FinanceImportBatch", id: uploaded.batch.id, snapshot: uploaded.batch }], tx), tx);
      const batch = await tx.financeImportBatch.update({ where: { id: uploaded.batch.id }, data: { stage: "READY_FOR_REVIEW",
        reportType: "PROFIT_AND_LOSS", basis: "ACCRUAL", cadence: "MONTHLY", currencyState: "RESOLVED", resolvedCurrency: "EUR",
        periodStart, periodEnd, asOfDate: periodEnd, addCount: 1, version: { increment: 1 } } });
      const candidate = await tx.financeImportCandidate.create({ data: { workspaceId: workspace.id, batchId: batch.id, sourceKey: "b".repeat(64),
        sourceLocation: { row: 1 }, sourceLabel: "Revenue", sourcePath: ["Revenue"], proposedAccountPath: ["Revenue"], factKind: "LEAF",
        periodStart, periodEnd, amountCents: 12_345, extractionJson: { value: "123.45" }, proposalJson: { value: 12_345 }, action: "ADD",
        reviewState: "APPROVED", semanticKey, confidenceBps: 10_000, evidenceMd: "Synthetic row 1", approvedByUserId: user.id, approvedAt: new Date() } });
      await recordArtifactInputLineage({ tx, actor, workspaceId: workspace.id, artifact: { kind: "FinanceImportCandidate", id: candidate.id },
        content: candidate, origin: "DERIVED", inputs: [], inheritedRoots: inputs });
      const candidateRoots = await captureArtifactInputProof(actor, workspace.id, [{ kind: "FinanceImportCandidate", id: candidate.id, snapshot: candidate }], tx);
      await recordArtifactInputLineage({ tx, actor, workspaceId: workspace.id, artifact: { kind: "FinanceImportBatch", id: batch.id },
        content: batch, origin: "DERIVED", inputs: [], inheritedRoots: [...inputs, ...candidateRoots] });
      return { batch, candidate };
    });
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
