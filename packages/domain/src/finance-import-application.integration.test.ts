import { createHash } from "node:crypto";
import type { AppActor } from "@corgtex/shared";
import { getPrismaClient } from "@corgtex/shared";
import { truncateAllTables } from "../../shared/src/db-test-utils";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { createFinanceReportImportUpload } from "./finance-import-upload";
import { captureArtifactInputProof, captureImmutableArtifactInputProof, recordArtifactInputLineage, isArtifactInputProofReadable } from "./source-lineage";
import { financeRevisionValue, financeValueHash } from "./finance-fact-value";
import { getFinanceReportImport, listFinanceReportImports, reviewFinanceReportImport } from "./finance-import-review";
import { applyFinanceReportImport } from "./finance-import-application";
import { buildFinanceReportFactSemanticKey, captureFinanceCurrentFactProof, rerunFinanceReportImportReconciliation } from "./finance-import-reconciliation";
const prisma = getPrismaClient();
beforeEach(async () => { await truncateAllTables(); });
async function restatementFixture() {
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
    const numericFormat = {version: 1, decimalSeparator: "DOT", groupingSeparator: "NONE", amountScale: 1};
    const interpretation = {version: 1, classification: {reportType: "PROFIT_AND_LOSS", basis: "ACCRUAL", cadence: "MONTHLY",
      reportTypeEvidenceClaimIds: ["type"], basisEvidenceClaimIds: ["basis"], cadenceEvidenceClaimIds: ["cadence"], confidence: 1},
      numericFormat: {status: "RESOLVED", ...numericFormat, decimalSeparatorEvidenceClaimIds: [], groupingSeparatorEvidenceClaimIds: [], amountScaleEvidenceClaimIds: ["scale"], confidence: 1},
      evidenceClaims: ["type", "basis", "cadence", "scale"].map(id => ({id, role: "TEXT", source: {kind: "CELL", sheet: "Report", row: 1, column: 1, evidence: id}})), exceptions: []};
    let uploadNumber = 0;
    const originalBytes = new Map<string, Buffer>();
    const ready = async (amountCents: number, includeDuplicate = false) => {
      const uploaded = await createFinanceReportImportUpload(actor, {workspaceId: workspace.id,
        fileBuffer: Buffer.from(`Account,Amount,Note\nRevenue,${(amountCents / 100).toFixed(2)},upload ${++uploadNumber}\n`),
        fileName: `synthetic-${amountCents}.csv`, mimeType: "text/csv", storage: {put: async (key, data) => {originalBytes.set(key, Buffer.from(data)); return {key, size: data.length};}}});
      const prepared = await prisma.$transaction(async tx => {
        const current = await tx.financeReportFact.findUnique({where: {workspaceId_semanticKey: {workspaceId: workspace.id, semanticKey}}});
        const uploadRoots = await captureArtifactInputProof(actor, workspace.id,
          [{kind: "FinanceImportBatch", id: uploaded.batch.id, snapshot: uploaded.batch}], tx);
        const currentRevision = current ? await tx.financeReportFactRevision.findUniqueOrThrow({where: {workspaceId_factId_factVersion: {workspaceId: workspace.id, factId: current.id, factVersion: current.version}}}) : null;
        const currentRoots = await captureFinanceCurrentFactProof(tx, actor, workspace.id, current ? [current] : []);
        const inputs = await captureImmutableArtifactInputProof(actor, workspace.id, [...uploadRoots, ...currentRoots], tx);
        // Fresh deterministic synthetic proposal, with every copied field bound
        // to the genuine upload and the exact current Fact used for comparison.
        const batch = await tx.financeImportBatch.update({where: {id: uploaded.batch.id}, data: {stage: "READY_FOR_REVIEW", interpretationJson: interpretation,
          reportType: "PROFIT_AND_LOSS", basis: "ACCRUAL", cadence: "MONTHLY", currencyState: "RESOLVED", resolvedCurrency: "EUR",
          periodStart, periodEnd, asOfDate: periodEnd, addCount: current ? 0 : 1, updateCount: current ? 1 : 0, version: {increment: 1}}});
        const candidate = await tx.financeImportCandidate.create({data: {workspaceId: workspace.id, batchId: batch.id,
          sourceKey: (current ? "c" : "b").repeat(64), sourceLocation: {row: 1}, sourceLabel: "Revenue", sourcePath: ["Revenue"],
          proposedAccountPath: ["Revenue"], factKind: "LEAF", periodStart, periodEnd, amountCents,
          extractionJson: {value: (amountCents / 100).toFixed(2)}, proposalJson: {value: amountCents, numericFormat},
          action: current ? current.amountCents === amountCents ? "UNCHANGED" : "UPDATE" : "ADD", reviewState: "WARNING", semanticKey,
          currentFactId: current?.id ?? null, currentFactRevisionId: currentRevision?.id ?? null, currentAmountCents: current?.amountCents ?? null,
          confidenceBps: 10_000, evidenceMd: "Synthetic row 1"}});
        await recordArtifactInputLineage({tx, actor, workspaceId: workspace.id, artifact: {kind: "FinanceImportCandidate", id: candidate.id},
          content: candidate, origin: "DERIVED", inputs: [], inheritedRoots: inputs});
        const duplicate = includeDuplicate ? await tx.financeImportCandidate.create({data: {...candidate, id: undefined, sourceKey: "d".repeat(64), action: "DUPLICATE", dimensions: candidate.dimensions ?? undefined, extractionJson: candidate.extractionJson!, proposalJson: candidate.proposalJson!, sourceLocation: candidate.sourceLocation!}}) : null;
        if (duplicate) await recordArtifactInputLineage({tx, actor, workspaceId: workspace.id, artifact: {kind: "FinanceImportCandidate", id: duplicate.id}, content: duplicate, origin: "DERIVED", inputs: [], inheritedRoots: inputs});
        const candidateRoots = await captureArtifactInputProof(actor, workspace.id,
          [candidate, ...(duplicate ? [duplicate] : [])].map(row => ({kind: "FinanceImportCandidate" as const, id: row.id, snapshot: row})), tx);
        await recordArtifactInputLineage({tx, actor, workspaceId: workspace.id, artifact: {kind: "FinanceImportBatch", id: batch.id},
          content: batch, origin: "DERIVED", inputs: [], inheritedRoots: [...inputs, ...candidateRoots]});
        return {batch, candidate, duplicate};
      }, {timeout: 120_000});
      await reviewFinanceReportImport(approver, {workspaceId: workspace.id, batchId: prepared.batch.id, expectedVersion: prepared.batch.version,
        mode: "APPROVE_ALL", acceptWarnings: true, candidateVersions: [prepared.candidate, ...(prepared.duplicate ? [prepared.duplicate] : [])].map(row => ({id: row.id, expectedVersion: row.version}))});
      return {batch: await prisma.financeImportBatch.findUniqueOrThrow({where: {id: prepared.batch.id}}),
        candidate: await prisma.financeImportCandidate.findUniqueOrThrow({where: {id: prepared.candidate.id}}),
        duplicate: prepared.duplicate ? await prisma.financeImportCandidate.findUniqueOrThrow({where: {id: prepared.duplicate.id}}) : null};
    };
    const request = (prepared: Awaited<ReturnType<typeof ready>>) => ({workspaceId: workspace.id, batchId: prepared.batch.id,
      expectedVersion: prepared.batch.version, candidateVersions: [prepared.candidate, ...(prepared.duplicate ? [prepared.duplicate] : [])].map(row => ({id: row.id, expectedVersion: row.version}))});
    return { alice, bob, workspace, actor, approver, ready, request, semanticKey, originalBytes };
}
describe("Finance report application database contract", () => {
  it("publishes immutable historical revisions for a real two-upload restatement without rebasing old proof", async () => {
    const { alice, bob, workspace, approver, ready, request, semanticKey, originalBytes } = await restatementFixture();
    const first = await ready(12_345);
    await expect(applyFinanceReportImport(approver, request(first))).resolves.toMatchObject({appliedNow: 1});
    const oldFact = await prisma.financeReportFact.findUniqueOrThrow({where: {workspaceId_semanticKey: {workspaceId: workspace.id, semanticKey}}});
    const oldManifests = await prisma.artifactInputLineage.findMany({where: {workspaceId: workspace.id,
      artifactType: "FinanceReportFact", artifactId: oldFact.id}, orderBy: {revision: "asc"}});
    const second = await ready(23_456);
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
    try {
      await expect(applyFinanceReportImport(approver, request(second))).resolves.toMatchObject({appliedNow: 1});
    } finally {probe.mockRestore();}
    expect(transition.updated).toBe(true);
    expect(transition.fact).toMatchObject({id: oldFact.id, version: oldFact.version + 1, amountCents: 23_456,
      sourceBatchId: second.batch.id, sourceCandidateId: second.candidate.id});
    expect(transition.fact?.reportId).not.toBe(oldFact.reportId);
    expect(transition.afterEpoch).toBeGreaterThan(transition.beforeEpoch);
    expect(await prisma.financeReportFact.findUniqueOrThrow({where: {id: oldFact.id}})).toEqual(transition.fact);
    const revisions = await prisma.financeReportFactRevision.findMany({where: {factId: oldFact.id}, orderBy: {factVersion: "asc"}});
    expect(revisions.map(row => row.amountCents)).toEqual([12_345, 23_456]);
    expect(revisions.map(row => row.approvedByUserId)).toEqual([bob.id, bob.id]);
    expect(revisions.map(row => row.sourceBatchId)).toEqual([first.batch.id, second.batch.id]);
    expect(revisions.map(row => row.sourceCandidateId)).toEqual([first.candidate.id, second.candidate.id]);
    expect(revisions.every(row => row.recipeHash.length === 64 && Array.isArray(row.recipeJson) && row.recipeJson.length > 0)).toBe(true);
    expect(await prisma.artifactInputLineage.findMany({where: {workspaceId: workspace.id,
      artifactType: "FinanceReportFact", artifactId: oldFact.id, revision: {lte: oldManifests.at(-1)!.revision}}, orderBy: {revision: "asc"}})).toEqual(oldManifests);
    const receipt = await prisma.financeImportApplication.findUniqueOrThrow({where: {candidateId: second.candidate.id}});
    expect(receipt).toMatchObject({beforeRevisionId: revisions[0]!.id, afterRevisionId: revisions[1]!.id,
      beforeValueJson: {amountCents: 12_345, version: 1}, afterValueJson: {amountCents: 23_456, version: 2}});
    expect(receipt.beforeValueHash).toBe(revisions[0]!.valueHash);
    expect(receipt.afterValueHash).toBe(revisions[1]!.valueHash);
    await expect(captureArtifactInputProof(approver, workspace.id, revisions.map(row => ({kind: "FinanceReportFactRevision" as const, id: row.id, snapshot: row})), prisma)).resolves.toEqual(expect.arrayContaining(revisions.map(row => expect.objectContaining({kind: "FinanceReportFactRevision", id: row.id}))));
    await expect(applyFinanceReportImport(approver, request(second))).resolves.toMatchObject({appliedNow: 0, noOp: true});
    await expect(prisma.financeReportFactRevision.update({where: {id: revisions[0]!.id}, data: {amountCents: 999}})).rejects.toThrow(/Immutable Finance/);
    const oldProof = await captureArtifactInputProof(approver, workspace.id, [{kind: "FinanceReportFactRevision", id: revisions[0]!.id}], prisma);
    const newProof = await captureArtifactInputProof(approver, workspace.id, [{kind: "FinanceReportFactRevision", id: revisions[1]!.id}], prisma);
    const beforeEvidence = await prisma.financeReportFactRevision.findMany({where: {factId: oldFact.id}, orderBy: {factVersion: "asc"}});
    expect((await getFinanceReportImport(approver, {workspaceId: workspace.id, batchId: second.batch.id})).candidates[0]).toMatchObject({amountCents: 23_456});
    // Each rollback isolates a real permission transition from the same permitted
    // baseline; restoring within that transaction must not revive saved proof.
    const rolledBack = new Error("synthetic policy rollback");
    for (const policy of ["member", "feature", "archive", "fact-recreate"] as const) {
      await expect(prisma.$transaction(async tx => {
        if (policy === "member") await tx.member.updateMany({where: {workspaceId: workspace.id, userId: alice.id}, data: {isActive: false}});
        if (policy === "feature") await tx.workspaceFeatureFlag.updateMany({where: {workspaceId: workspace.id, flag: "FINANCE"}, data: {enabled: false}});
        if (policy === "archive") await tx.financeReport.update({where: {id: revisions[0]!.reportId}, data: {status: "ARCHIVED"}});
        if (policy === "fact-recreate") {
          await tx.financeImportCandidate.updateMany({where: {workspaceId: workspace.id, currentFactId: oldFact.id}, data: {currentFactId: null}});
          await tx.financeImportApplication.updateMany({where: {workspaceId: workspace.id, targetFactId: oldFact.id}, data: {targetFactId: null}});
          await tx.financeReportFact.delete({where: {id: oldFact.id}});
        }
        expect(await isArtifactInputProofReadable(approver, workspace.id, oldProof, tx)).toBe(false);
        expect(await isArtifactInputProofReadable(approver, workspace.id, newProof, tx)).toBe(false);
        if (policy === "member") await tx.member.updateMany({where: {workspaceId: workspace.id, userId: alice.id}, data: {isActive: true}});
        if (policy === "feature") await tx.workspaceFeatureFlag.updateMany({where: {workspaceId: workspace.id, flag: "FINANCE"}, data: {enabled: true}});
        if (policy === "archive") await tx.financeReport.update({where: {id: revisions[0]!.reportId}, data: {status: "ACTIVE"}});
        if (policy === "fact-recreate") await tx.financeReportFact.create({data: {...transition.fact!, dimensions: transition.fact!.dimensions ?? undefined}});
        expect(await isArtifactInputProofReadable(approver, workspace.id, oldProof, tx)).toBe(false);
        expect(await isArtifactInputProofReadable(approver, workspace.id, newProof, tx)).toBe(false);
        throw rolledBack;
      }, {timeout: 120_000})).rejects.toBe(rolledBack);
    }
    const newUpload = await prisma.financeReportUploadInput.findFirstOrThrow({where: {batchId: second.batch.id}});
    const oldUpload = await prisma.financeReportUploadInput.findFirstOrThrow({where: {batchId: first.batch.id}});
    const exactBytes = [...originalBytes].map(([key, bytes]) => [key, Buffer.from(bytes)] as const);
    for (const upload of [oldUpload, newUpload]) expect(createHash("sha256").update(originalBytes.get(upload.storageKey)!).digest("hex")).toBe(upload.fileHash);
    // Committed new-source denial leaves the independently permitted old value
    // readable. Its restore cannot resurrect the new derived value.
    await prisma.document.update({where: {id: newUpload.documentId!}, data: {archivedAt: new Date()}});
    expect(await isArtifactInputProofReadable(approver, workspace.id, oldProof)).toBe(true);
    expect(await isArtifactInputProofReadable(approver, workspace.id, newProof)).toBe(false);
    await expect(getFinanceReportImport(approver, {workspaceId: workspace.id, batchId: second.batch.id})).rejects.toThrow();
    expect((await listFinanceReportImports(approver, workspace.id)).map(row => row.id)).not.toContain(second.batch.id);
    await prisma.document.update({where: {id: newUpload.documentId!}, data: {archivedAt: null}});
    expect(await isArtifactInputProofReadable(approver, workspace.id, newProof)).toBe(false);
    await prisma.document.update({where: {id: oldUpload.documentId!}, data: {archivedAt: new Date()}});
    expect(await isArtifactInputProofReadable(approver, workspace.id, oldProof)).toBe(false);
    await prisma.document.update({where: {id: oldUpload.documentId!}, data: {archivedAt: null}});
    expect(await isArtifactInputProofReadable(approver, workspace.id, oldProof)).toBe(false);
    expect(await prisma.financeReportFactRevision.findMany({where: {factId: oldFact.id}, orderBy: {factVersion: "asc"}})).toEqual(beforeEvidence);
    expect([...originalBytes]).toEqual(exactBytes);


  }, 240_000);

  it("publishes a new unchanged revision and binds a duplicate to that exact existing revision", async () => {
    const {workspace, approver, ready, request} = await restatementFixture();
    const first = await ready(12_345); await applyFinanceReportImport(approver, request(first));
    const second = await ready(12_345, true);
    const result = await applyFinanceReportImport(approver, request(second));
    expect(result.receipts.map(row => row.outcome)).toEqual(["UNCHANGED", "SKIPPED"]);
    const revisions = await prisma.financeReportFactRevision.findMany({where: {workspaceId: workspace.id}, orderBy: {factVersion: "asc"}});
    expect(revisions.map(row => row.amountCents)).toEqual([12_345, 12_345]);
    expect(revisions.map(row => row.factVersion)).toEqual([1, 2]);
    const duplicate = await prisma.financeImportApplication.findUniqueOrThrow({where: {candidateId: second.duplicate!.id}});
    expect(duplicate).toMatchObject({beforeRevisionId: revisions[1]!.id, afterRevisionId: revisions[1]!.id});
    expect(await prisma.financeReportFact.count({where: {workspaceId: workspace.id}})).toBe(1);
  }, 240_000);

  it("rolls back newborn evidence and lets only one of two independent restatements win", async () => {
    const {workspace, approver, ready, request, semanticKey} = await restatementFixture();
    const first = await ready(12_345);
    await applyFinanceReportImport(approver, request(first));
    const left = await ready(23_456), right = await ready(34_567);
    const state = () => Promise.all([
      prisma.financeReportFact.findMany({where: {workspaceId: workspace.id}, orderBy: {id: "asc"}}),
      prisma.financeReportFactRevision.findMany({where: {workspaceId: workspace.id}, orderBy: {id: "asc"}}),
      prisma.financeReport.findMany({where: {workspaceId: workspace.id}, orderBy: {id: "asc"}}),
      prisma.financeImportApplication.findMany({where: {workspaceId: workspace.id}, orderBy: {id: "asc"}}),
      prisma.financeImportCandidate.findMany({where: {workspaceId: workspace.id}, orderBy: {id: "asc"}}),
      prisma.financeImportBatch.findMany({where: {workspaceId: workspace.id}, orderBy: {id: "asc"}}),
      prisma.artifactInputLineage.findMany({where: {workspaceId: workspace.id}, orderBy: {id: "asc"}}),
      prisma.artifactInputSnapshot.findMany({where: {workspaceId: workspace.id}, orderBy: {id: "asc"}}),
      prisma.sourcePermissionEpoch.findMany({where: {workspaceId: workspace.id}, orderBy: {id: "asc"}}),
      prisma.event.findMany({where: {workspaceId: workspace.id}, orderBy: {id: "asc"}}),
      prisma.auditLog.findMany({where: {workspaceId: workspace.id}, orderBy: {id: "asc"}}),
    ]);
    const before = await state(); const rollback = new Error("synthetic post-receipt failure");
    const original = prisma.$transaction.bind(prisma) as (...args: any[]) => Promise<any>;
    let observedReceipt = false;
    const probe = vi.spyOn(prisma, "$transaction").mockImplementation(async (...args: any[]) => {
      if (typeof args[0] !== "function") return original(...args);
      return original(async (tx: any) => args[0](new Proxy(tx, {get(connection, key) {
        if (key === "financeImportApplication") return new Proxy(tx.financeImportApplication, {get(delegate, field) {
          const method = Reflect.get(delegate, field, delegate);
          if (field === "create") return async (...values: any[]) => {await method.apply(delegate, values); observedReceipt = true; throw rollback;};
          return typeof method === "function" ? method.bind(delegate) : method;
        }});
        const method = Reflect.get(connection, key, connection); return typeof method === "function" ? method.bind(connection) : method;
      }})), ...args.slice(1));
    });
    try {await expect(applyFinanceReportImport(approver, request(left))).rejects.toBe(rollback);} finally {probe.mockRestore();}
    expect(observedReceipt).toBe(true); expect(await state()).toEqual(before);
    const results = await Promise.allSettled([applyFinanceReportImport(approver, request(left)), applyFinanceReportImport(approver, request(right))]);
    expect(results.filter(result => result.status === "fulfilled")).toHaveLength(1);
    const failure = results.find(result => result.status === "rejected") as PromiseRejectedResult;
    expect(failure.reason).toMatchObject({code: "FINANCE_REPORT_APPLICATION_CONFLICT"});
    const fact = await prisma.financeReportFact.findUniqueOrThrow({where: {workspaceId_semanticKey: {workspaceId: workspace.id, semanticKey}}});
    expect(fact.version).toBe(2); expect([23_456, 34_567]).toContain(fact.amountCents);
    expect(await prisma.financeReportFactRevision.count({where: {factId: fact.id}})).toBe(2);
    expect(await prisma.financeImportApplication.count({where: {workspaceId: workspace.id}})).toBe(2);
    const winner = fact.sourceBatchId === left.batch.id ? left : right;
    await expect(applyFinanceReportImport(approver, request(winner))).resolves.toMatchObject({noOp: true, appliedNow: 0});
    const loser = winner.batch.id === left.batch.id ? right : left;
    const freshRevision = await prisma.financeReportFactRevision.findFirstOrThrow({where: {factId: fact.id, factVersion: fact.version}});
    await rerunFinanceReportImportReconciliation(approver, {...request(loser), confirmedCurrency: "EUR", confirmedAmountScale: 1});
    const reconciled = await prisma.financeImportCandidate.findUniqueOrThrow({where: {id: loser.candidate.id}});
    expect(reconciled).toMatchObject({currentFactRevisionId: freshRevision.id, currentAmountCents: fact.amountCents,
      approvedByUserId: null, approvedAt: null, reviewState: "PROPOSED"});
    expect(await prisma.financeReportFactRevision.count({where: {factId: fact.id}})).toBe(2);

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
    const revision = await prisma.financeReportFactRevision.findFirstOrThrow({where: {factId: fact.id}});
    const forged = { ...revision, id: "synthetic-forged-revision", factVersion: 2 };
    forged.valueHash = financeValueHash(financeRevisionValue(forged));
    await prisma.financeReportFactRevision.create({data: {...forged, dimensions: forged.dimensions ?? undefined, recipeJson: forged.recipeJson!}});
    await expect(captureArtifactInputProof(actor, workspace.id, [{kind: "FinanceReportFactRevision", id: forged.id}])).rejects.toThrow();
    // A hash-matching row without an issued revision is legacy data, never a
    // semantic before-value, even while an old mutable Fact manifest remains.
    await prisma.financeReportFactRevision.deleteMany({where: {factId: fact.id}});
    await expect(captureFinanceCurrentFactProof(prisma, actor, workspace.id, [fact])).rejects.toMatchObject({code: "FINANCE_REPORT_SOURCE_NOT_READY"});
    await expect(captureArtifactInputProof(actor, workspace.id, [{kind: "FinanceReportFact", id: fact.id}])).rejects.toThrow();

  });
});
