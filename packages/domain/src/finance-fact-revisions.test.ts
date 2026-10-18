import { describe, expect, it, vi } from "vitest";
import type { AppActor } from "@corgtex/shared";
import type { FinanceReportFact, Prisma } from "@prisma/client";
const lineage = vi.hoisted(() => ({capture: vi.fn(async () => []), record: vi.fn()}));
vi.mock("./source-lineage", () => ({captureArtifactInputProof: lineage.capture, recordArtifactInputLineage: lineage.record}));
vi.mock("./source-commit-lock-plan", () => ({hasActiveSourceCommitLockPlan: () => false, assertSourceCommitRowCovered: vi.fn()}));
import { publishFinanceFactRevision } from "./finance-fact-revisions";
import { financeRevisionValue, financeValueHash } from "./finance-fact-value";
const actor = {kind: "user", user: {id: "writer"}} as AppActor;
function fixture() {
  const fact = {id: "fact", workspaceId: "ws", reportId: "report", accountPath: ["Revenue"], kind: "LEAF",
    periodStart: new Date("2024-01-01Z"), periodEnd: new Date("2024-01-31Z"), amountCents: 12345,
    dimensions: {region: "EU"}, semanticKey: "a".repeat(64), sourceBatchId: "batch", sourceCandidateId: "candidate",
    appliedByUserId: "writer", version: 1, createdAt: new Date("2026-10-14Z"),
    updatedAt: new Date("2026-10-14Z")} satisfies FinanceReportFact;
  const candidate = {id: "candidate", version: 2, workspaceId: "ws", batchId: "batch", approvedByUserId: "peer",
    approvedAt: new Date("2026-10-14Z"), reviewState: "APPROVED", semanticKey: fact.semanticKey, amountCents: fact.amountCents,
    proposedAccountPath: fact.accountPath, factKind: fact.kind, periodStart: fact.periodStart, periodEnd: fact.periodEnd, dimensions: fact.dimensions};
  const create = vi.fn(async ({data}) => ({...data, id: "revision", createdAt: new Date("2026-10-14Z")}));
  const tx = {financeImportCandidate: {findFirst: vi.fn(async () => candidate)}, financeReportFactRevision: {create}} as unknown as Prisma.TransactionClient;
  const roots = [{kind: "ArtifactInputSnapshot" as const, id: "approved-snapshot", fingerprint: "b".repeat(64)}];
  return {fact, candidate, create, tx, roots};
}
describe("Finance immutable revision custody", () => {
  it.each([
    {amountCents: 999}, {semanticKey: "c".repeat(64)}, {sourceCandidateId: "other"},
    {accountPath: ["Expense"]}, {kind: "DERIVED"}, {dimensions: {region: "US"}},
    {periodStart: new Date("2023-01-01Z")}, {periodEnd: new Date("2023-01-31Z")},
  ])("rejects a value that differs from the actual approved candidate: %j", async change => {
    const {fact, candidate, create, tx, roots} = fixture();
    await expect(publishFinanceFactRevision(tx, actor, {...fact, ...change} as FinanceReportFact, candidate, roots))
      .rejects.toMatchObject({code: "FINANCE_REPORT_APPLICATION_CONFLICT"});
    expect(create).not.toHaveBeenCalled();
  });
  it("requires the exact approval version and retains an independent original recipe", async () => {
    const {fact, candidate, create, tx, roots} = fixture();
    await expect(publishFinanceFactRevision(tx, actor, fact, {...candidate, version: 1}, roots))
      .rejects.toMatchObject({code: "FINANCE_REPORT_APPLICATION_CONFLICT"});
    expect(create).not.toHaveBeenCalled();
    const published = await publishFinanceFactRevision(tx, actor, fact, candidate, roots);
    roots.push({kind: "ArtifactInputSnapshot", id: "later-output", fingerprint: "d".repeat(64)});
    expect(published.revision.recipeJson).toEqual([{kind: "ArtifactInputSnapshot", id: "approved-snapshot", fingerprint: "b".repeat(64)}]);
    expect(published.revision.recipeHash).toBe(financeValueHash(published.revision.recipeJson));
    expect(published.revision.valueHash).toBe(financeValueHash(financeRevisionValue(published.revision)));
    expect(published.revision).toMatchObject({factId: fact.id, factVersion: 1, candidateVersion: 2,
      approvedByUserId: "peer", appliedByUserId: "writer", amountCents: 12345});
  });
});
