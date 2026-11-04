import { AsyncResource } from "node:async_hooks";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { createHash, randomUUID } from "node:crypto";
import type { Prisma } from "@prisma/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { prisma, getPrismaClient, type AppActor } from "@corgtex/shared";
import { truncateAllTables } from "../../shared/src/db-test-utils";
import { createFinanceReportImportUpload } from "./finance-import-upload";
import { listFinanceReportImports, getFinanceReportImportSummary, getFinanceReportImport } from "./finance-import-review";
import { captureArtifactInputProof, recordArtifactInputLineage, lineageContentFingerprint } from "./source-lineage";

beforeEach(async () => { await truncateAllTables(); });
afterEach(() => vi.restoreAllMocks());
function observeModel(modelName: "financeImportBatch" | "financeImportCandidate" | "artifactInputLineage" | "member", method: "findMany" | "findFirst" | "findUnique") {
  const observed = vi.fn(async (_args: any, _rows: any) => {});
  const model = prisma[modelName] as any;
  const original = model[method].bind(model);
  vi.spyOn(model, method).mockImplementation(async (args: any) => {const rows = await original(args); await observed(args, rows); return rows;});
  const currentTransaction = getPrismaClient().$transaction;
  const transaction = vi.isMockFunction(currentTransaction) ? currentTransaction.getMockImplementation()! : currentTransaction.bind(getPrismaClient());
  vi.spyOn(getPrismaClient(), "$transaction").mockImplementation(((operation: any, options: any) => transaction(async (tx: Prisma.TransactionClient) => operation(new Proxy(tx, {
    get(target, property) {
      if (property === modelName) return new Proxy(target[modelName], {get(delegate, name) {
        if (name === method) return async (args: any) => {const rows = await (delegate as any)[method](args); await observed(args, rows); return rows;};
        const value = Reflect.get(delegate, name); return typeof value === "function" ? value.bind(delegate) : value;
      }});
      const value = Reflect.get(target, property); return typeof value === "function" ? value.bind(target) : value;
    },
  })), options)) as typeof prisma.$transaction);
  return observed;
}
async function fixture() {
  const user = await prisma.user.create({data: {email: `${randomUUID()}@example.test`, passwordHash: "synthetic"}});
  const workspace = await prisma.workspace.create({data: {slug: `finance-read-${randomUUID()}`, name: "Synthetic Finance reader"}});
  const member = await prisma.member.create({data: {workspaceId: workspace.id, userId: user.id, role: "ADMIN"}});
  const flag = await prisma.workspaceFeatureFlag.create({data: {workspaceId: workspace.id, flag: "FINANCE", enabled: true,
    config: {financeAllMemberWrite: true, financeCapabilities: {reports: true, reportImports: true}}}});
  const actor: AppActor = {kind: "user", user};
  const {batch} = await createFinanceReportImportUpload(actor, {workspaceId: workspace.id, fileBuffer: Buffer.from("Account,Amount\nRevenue,123\n"),
    fileName: "synthetic.csv", mimeType: "text/csv", storage: {put: async (key, data) => ({key, size: data.length})}});
  return {actor, workspace, member, flag, batch, user};
}
const hash = (value: string) => createHash("sha256").update(value).digest("hex");

it.each([100, 5001])("bounds the import list to 200 examined rows after %i unproved batches", async deniedCount => {
  const {actor, workspace, batch, user} = await fixture();
  for (let n=0;n<deniedCount;n+=100) await prisma.financeImportBatch.createMany({data: Array.from({length: Math.min(100,deniedCount-n)},(_,i)=>({
    workspaceId: workspace.id, uploadedByUserId: user.id, fileHash: hash(`unknown-${n+i}`), originalFilename: "Unproved.csv", mimeType: "text/csv", fileSizeBytes: 10,
    createdAt: new Date(batch.createdAt.getTime()+1000+n+i)}))});
  const reads = observeModel("financeImportBatch", "findMany");
  if (deniedCount > 200) {
    await expect(listFinanceReportImports(actor, workspace.id)).rejects.toMatchObject({code: "SOURCE_READ_SCAN_LIMIT"});
  } else {
    expect((await listFinanceReportImports(actor, workspace.id)).map(row=>row.id)).toEqual([batch.id]);
  }
  expect(reads).toHaveBeenCalledTimes(2);
  expect(reads.mock.calls[0][0]?.where?.OR).toBeUndefined();
  expect(reads.mock.calls[1][0]?.where?.OR).toBeDefined();
  for (const [query] of reads.mock.calls) { expect(query?.take).toBe(100); expect(query).not.toHaveProperty("select"); }
});

function candidateData(workspaceId: string, batchId: string, sourceKey: string): Prisma.FinanceImportCandidateUncheckedCreateInput {
  return {workspaceId, batchId, sourceKey, sourceLocation: {row: 1}, sourceLabel: "Revenue", sourcePath: ["Revenue"], proposedAccountPath: ["Revenue"],
    factKind: "LEAF", periodStart: new Date("2026-09-01Z"), periodEnd: new Date("2026-09-30Z"), amountCents: 123,
    extractionJson: {}, proposalJson: {}, action: "ADD", confidenceBps: 10000, evidenceMd: "Synthetic exact row"};
}
async function provedCandidate(f: Awaited<ReturnType<typeof fixture>>, sourceKey: string) {
  return prisma.$transaction(async tx => {
    const row = await tx.financeImportCandidate.create({data: candidateData(f.workspace.id, f.batch.id, sourceKey)});
    const roots = await captureArtifactInputProof(f.actor, f.workspace.id, [{kind: "FinanceImportBatch", id: f.batch.id, snapshot: f.batch}], tx);
    await recordArtifactInputLineage({tx, actor: f.actor, workspaceId: f.workspace.id, artifact: {kind: "FinanceImportCandidate", id: row.id},
      content: row, origin: "DERIVED", inputs: [], inheritedRoots: roots});
    return row;
  });
}
async function unknownCandidates(f: Awaited<ReturnType<typeof fixture>>, count: number) {
  for (let n=0;n<count;n+=100) await prisma.financeImportCandidate.createMany({data: Array.from({length: Math.min(100,count-n)},(_,i)=>
    candidateData(f.workspace.id, f.batch.id, `unknown-${String(n+i).padStart(6,"0")}`))});
}
it("streams summary counts and complete detail past 5001 unproved candidates, admitting applications independently", async () => {
  const started = performance.now();
  const f = await fixture();
  await unknownCandidates(f, 5001);
  const first = await provedCandidate(f, "visible-1"), second = await provedCandidate(f, "visible-2");
  const application = await prisma.$transaction(async tx => {
    const row = await tx.financeImportApplication.create({data: {workspaceId: f.workspace.id, batchId: f.batch.id, candidateId: first.id,
      idempotencyKey: hash(first.id), targetType: "REPORT_FACT", outcome: "SKIPPED", appliedByUserId: f.user.id}});
    await recordArtifactInputLineage({tx, actor: f.actor, workspaceId: f.workspace.id, artifact: {kind: "FinanceImportApplication", id: row.id},
      content: row, origin: "DERIVED", inputs: [{kind: "FinanceImportCandidate", id: first.id}]});
    return row;
  });
  await prisma.financeImportApplication.create({data: {workspaceId: f.workspace.id, batchId: f.batch.id, candidateId: second.id,
    idempotencyKey: hash(second.id), targetType: "REPORT_FACT", outcome: "SKIPPED", appliedByUserId: f.user.id}});
  const seedMilliseconds = performance.now()-started;
  const reads = observeModel("financeImportCandidate", "findMany");
  const canonicalReads = observeModel("financeImportCandidate", "findFirst");
  const headReads = observeModel("artifactInputLineage", "findFirst");
  const summaryStarted = performance.now();
  expect(await getFinanceReportImportSummary(f.actor, {workspaceId: f.workspace.id, batchId: f.batch.id})).toMatchObject({addCount: 2});
  const summaryMilliseconds = performance.now()-summaryStarted;
  const detailStarted = performance.now();
  const detail = await getFinanceReportImport(f.actor, {workspaceId: f.workspace.id, batchId: f.batch.id});
  recordProofMetrics("finance-full", {seedMilliseconds, summaryMilliseconds, detailMilliseconds: performance.now()-detailStarted,
    candidatePages: reads.mock.calls.length, canonicalReads: canonicalReads.mock.calls.length, headReads: headReads.mock.calls.length});
  expect(detail.addCount).toBe(2);
  expect(detail.candidates.map(row=>row.id)).toEqual([first.id, second.id]);
  expect(detail.candidates[0].application?.id).toBe(application.id);
  expect(detail.candidates[1].application).toBeNull();
  expect(reads.mock.calls.length).toBeGreaterThan(100);
  for (const [query] of reads.mock.calls) {expect(query?.take).toBe(100);expect(query).not.toHaveProperty("select");}
});

it.each(["head", "membership", "finance"] as const)("retains original proof when %s changes and restores during later candidate pages", async mode => {
  const f = await fixture();
  const first = await provedCandidate(f, "000-visible");
  await unknownCandidates(f, 101);
  // Warm epoch identities before the independent mutation barrier.
  await getFinanceReportImportSummary(f.actor, {workspaceId: f.workspace.id, batchId: f.batch.id});
  const writer = new AsyncResource("independent-finance-withdrawal");
  let changed = false;
  const reads = observeModel("financeImportCandidate", "findMany");
  reads.mockImplementation(async args => {
    if (!changed && args.take === 100 && args.where?.OR) {
      changed = true;
      await writer.runInAsyncScope(async () => {
        if (mode === "head") await prisma.$transaction(tx => recordArtifactInputLineage({tx, actor: f.actor, workspaceId: f.workspace.id,
          artifact: {kind: "FinanceImportCandidate", id: first.id}, content: first, origin: "DERIVED", inputs: [{kind: "FinanceImportBatch", id: f.batch.id}]}));
        if (mode === "membership") {
          await prisma.member.update({where: {id: f.member.id}, data: {isActive: false}});
          await prisma.member.update({where: {id: f.member.id}, data: {isActive: true}});
        }
        if (mode === "finance") {
          await prisma.workspaceFeatureFlag.update({where: {id: f.flag.id}, data: {enabled: false}});
          await prisma.workspaceFeatureFlag.update({where: {id: f.flag.id}, data: {enabled: true}});
        }
      });
    }
  });
  await expect(getFinanceReportImportSummary(f.actor, {workspaceId: f.workspace.id, batchId: f.batch.id})).rejects.toMatchObject({code: "SOURCE_CHANGED"});
  expect(changed).toBe(true);
});

function recordProofMetrics(name: string, metrics: Record<string, number>) {
  if (process.env.COLLECTION_PROOF_METRICS_DIR) writeFileSync(join(process.env.COLLECTION_PROOF_METRICS_DIR, `${name}.json`), JSON.stringify(metrics));
}

it("rejects missing candidate heads in one page lookup before per-row authorization", async () => {
  const f = await fixture(); await unknownCandidates(f, 100);
  const rows = observeModel("financeImportCandidate", "findFirst");
  const heads = observeModel("artifactInputLineage", "findFirst");
  const members = observeModel("member", "findUnique");
  const start = performance.now();
  expect(await getFinanceReportImportSummary(f.actor, {workspaceId: f.workspace.id, batchId: f.batch.id})).toMatchObject({addCount: 0});
  recordProofMetrics("finance-100", {milliseconds: performance.now()-start, candidateReads: rows.mock.calls.length, headReads: heads.mock.calls.length, memberReads: members.mock.calls.length});
  expect(rows.mock.calls.length).toBe(0);
});

it("does not authorize a candidate merely because matching empty roots metadata exists", async () => {
  const f = await fixture();
  const row = await prisma.financeImportCandidate.create({data: candidateData(f.workspace.id, f.batch.id, "matching-unknown")});
  await prisma.artifactInputLineage.create({data: {workspaceId: f.workspace.id, artifactType: "FinanceImportCandidate", artifactId: row.id,
    revision: 1, origin: "UNKNOWN", contentHash: lineageContentFingerprint("FinanceImportCandidate", row), inputsJson: [], rootsJson: []}});
  const reads = observeModel("financeImportCandidate", "findFirst");
  expect(await getFinanceReportImportSummary(f.actor, {workspaceId: f.workspace.id, batchId: f.batch.id})).toMatchObject({addCount: 0});
  expect(reads.mock.calls.some(([query]) => query?.where?.id === row.id)).toBe(true);
});


it.each(["summary", "detail", "list"] as const)("keeps %s collection in one snapshot across low/high source-key insertions", async mode => {
  const f = await fixture();
  await unknownCandidates(f, 100);
  await provedCandidate(f, "bbb-before-unknown");
  await provedCandidate(f, "visible-last");
  await getFinanceReportImportSummary(f.actor, {workspaceId: f.workspace.id, batchId: f.batch.id});
  const writer = new AsyncResource("independent-finance-insert");
  let changed = 0;
  const transaction = prisma.$transaction.bind(prisma);
  const query = prisma.financeImportCandidate.findMany.bind(prisma.financeImportCandidate);
  async function afterRead(args: any, read: () => Promise<any[]>) {
    const rows = await read();
    if (!changed && args.take === 100 && !args.where?.OR) {
      changed++;
      await writer.runInAsyncScope(() => transaction(async tx => {
        for (const sourceKey of ["aaa-before", "zzz-after"]) {
          const row = await tx.financeImportCandidate.create({data: candidateData(f.workspace.id, f.batch.id, sourceKey)});
          await recordArtifactInputLineage({tx, actor: f.actor, workspaceId: f.workspace.id, artifact: {kind: "FinanceImportCandidate", id: row.id},
            content: row, origin: "DERIVED", inputs: [{kind: "FinanceImportBatch", id: f.batch.id}]});
        }
      }));
    }
    return rows;
  }
  vi.spyOn(prisma.financeImportCandidate, "findMany").mockImplementation(((args: any) => afterRead(args, () => query(args))) as unknown as typeof query);
  vi.spyOn(getPrismaClient(), "$transaction").mockImplementation(((operation: any, options: any) => transaction(async tx => operation(new Proxy(tx, {
    get(target, property) {
      if (property === "financeImportCandidate") return new Proxy(target.financeImportCandidate, {get(model, method) {
        if (method === "findMany") return (args: any) => afterRead(args, () => model.findMany(args));
        const value = Reflect.get(model, method); return typeof value === "function" ? value.bind(model) : value;
      }});
      const value = Reflect.get(target, property); return typeof value === "function" ? value.bind(target) : value;
    },
  })), options)) as typeof prisma.$transaction);
  const result = mode === "list" ? (await listFinanceReportImports(f.actor, f.workspace.id))[0]
    : mode === "detail" ? await getFinanceReportImport(f.actor, {workspaceId: f.workspace.id, batchId: f.batch.id})
    : await getFinanceReportImportSummary(f.actor, {workspaceId: f.workspace.id, batchId: f.batch.id});
  expect(changed).toBe(1);
  expect(result.addCount).toBe(2);
  if ("candidates" in result) expect(result.candidates).toHaveLength(2);
  expect(await prisma.financeImportCandidate.count({where: {batchId: f.batch.id}})).toBe(104);
}, 120_000);
