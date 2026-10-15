import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { createHash, randomUUID } from "node:crypto";
import type { Prisma } from "@prisma/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { prisma, type AppActor } from "@corgtex/shared";
import { truncateAllTables } from "../../shared/src/db-test-utils";
import { createFinanceReportImportUpload } from "./finance-import-upload";
import { listFinanceReportImports, getFinanceReportImportSummary, getFinanceReportImport } from "./finance-import-review";
import { captureArtifactInputProof, recordArtifactInputLineage, lineageContentFingerprint } from "./source-lineage";

beforeEach(async () => { await truncateAllTables(); });
afterEach(() => vi.restoreAllMocks());
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

it("lists the permitted tail after 5001 unproved batches using bounded canonical pages", async () => {
  const {actor, workspace, batch, user} = await fixture();
  for (let n=0;n<5001;n+=100) await prisma.financeImportBatch.createMany({data: Array.from({length: Math.min(100,5001-n)},(_,i)=>({
    workspaceId: workspace.id, uploadedByUserId: user.id, fileHash: hash(`unknown-${n+i}`), originalFilename: "Unproved.csv", mimeType: "text/csv", fileSizeBytes: 10,
    createdAt: new Date(batch.createdAt.getTime()+1000+n+i)}))});
  const reads = vi.spyOn(prisma.financeImportBatch, "findMany");
  expect((await listFinanceReportImports(actor, workspace.id)).map(row=>row.id)).toEqual([batch.id]);
  expect(reads.mock.calls.length).toBeGreaterThan(50);
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
  const reads = vi.spyOn(prisma.financeImportCandidate, "findMany");
  const canonicalReads = vi.spyOn(prisma.financeImportCandidate, "findFirst");
  const headReads = vi.spyOn(prisma.artifactInputLineage, "findFirst");
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
  const original = prisma.financeImportCandidate.findMany.bind(prisma.financeImportCandidate);
  let changed = false;
  vi.spyOn(prisma.financeImportCandidate, "findMany").mockImplementation(((args: Prisma.FinanceImportCandidateFindManyArgs = {}) => {
    const run = async () => {
      const rows = await original(args);
      if (!changed && args.where?.OR) {
        changed = true;
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
      }
      return rows;
    };
    return run() as ReturnType<typeof original>;
  }) as typeof prisma.financeImportCandidate.findMany);
  await expect(getFinanceReportImportSummary(f.actor, {workspaceId: f.workspace.id, batchId: f.batch.id})).rejects.toMatchObject({code: "SOURCE_CHANGED"});
  expect(changed).toBe(true);
});

function recordProofMetrics(name: string, metrics: Record<string, number>) {
  if (process.env.COLLECTION_PROOF_METRICS_DIR) writeFileSync(join(process.env.COLLECTION_PROOF_METRICS_DIR, `${name}.json`), JSON.stringify(metrics));
}

it("rejects missing candidate heads in one page lookup before per-row authorization", async () => {
  const f = await fixture(); await unknownCandidates(f, 100);
  const rows = vi.spyOn(prisma.financeImportCandidate, "findFirst");
  const heads = vi.spyOn(prisma.artifactInputLineage, "findFirst");
  const members = vi.spyOn(prisma.member, "findUnique");
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
  const reads = vi.spyOn(prisma.financeImportCandidate, "findFirst");
  expect(await getFinanceReportImportSummary(f.actor, {workspaceId: f.workspace.id, batchId: f.batch.id})).toMatchObject({addCount: 0});
  expect(reads.mock.calls.some(([query]) => query?.where?.id === row.id)).toBe(true);
});
