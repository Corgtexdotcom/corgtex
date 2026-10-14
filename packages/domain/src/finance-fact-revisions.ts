import type { FinanceImportCandidate, FinanceReportFact, Prisma } from "@prisma/client";
import { Prisma as PrismaValues } from "@prisma/client";
import type { AppActor } from "@corgtex/shared";
import { assertSourceCommitRowCovered, hasActiveSourceCommitLockPlan } from "./source-commit-lock-plan";
import { invariant } from "./errors";
import { captureArtifactInputProof, recordArtifactInputLineage, type LineageRoot } from "./source-lineage";
import { financeCanonicalJson, financeFactValue, financeRevisionValue, financeValueHash, isFinanceFactRevisionIntact } from "./finance-fact-value";

/** Canonical rows are only locked parity controls. Semantic old values and their
 * complete original recipe always come from an independently readable revision. */
export async function captureFinanceFactRevisions(tx: Prisma.TransactionClient, actor: AppActor, workspaceId: string, facts: FinanceReportFact[]) {
  invariant(facts.length <= 5000, 413, "FINANCE_READ_BUDGET", "Narrow the Finance import selection.");
  if (!facts.length) return { roots: [] as LineageRoot[], facts: [] as Array<FinanceReportFact & { currentFactRevisionId: string }>, revisions: [] };
  const revisions = await tx.financeReportFactRevision.findMany({ where: { workspaceId,
    OR: facts.map(fact => ({ factId: fact.id, factVersion: fact.version })) }, orderBy: { id: "asc" }, take: 5001 });
  invariant(revisions.length === facts.length, 409, "FINANCE_REPORT_SOURCE_NOT_READY", "Finance value history is unavailable. Verified original-source recovery is required before these identities can be restated.");
  const roots = await captureArtifactInputProof(actor, workspaceId,
    revisions.map(row => ({ kind: "FinanceReportFactRevision" as const, id: row.id, snapshot: row })), tx);
  if (hasActiveSourceCommitLockPlan(tx)) for (const fact of facts) assertSourceCommitRowCovered(tx, "FinanceReportFact", fact.id, "UPDATE");
  else await tx.$queryRaw(PrismaValues.sql`SELECT id FROM "FinanceReportFact" WHERE "workspaceId"=${workspaceId}
    AND id IN (${PrismaValues.join(facts.map(fact => fact.id))}) ORDER BY id COLLATE "C" FOR UPDATE`);
  const current = await tx.financeReportFact.findMany({ where: { workspaceId, id: { in: facts.map(fact => fact.id) } }, orderBy: { id: "asc" }, take: 5001 });
  invariant(current.length === facts.length, 409, "FINANCE_REPORT_APPLICATION_CONFLICT", "The current values changed. Reconcile again.");
  const revisionByFact = new Map(revisions.map(row => [row.factId, row]));
  const currentById = new Map(current.map(row => [row.id, row]));
  const values = facts.map(fact => {
    const revision = revisionByFact.get(fact.id)!;
    const locked = currentById.get(fact.id)!;
    invariant(revision && isFinanceFactRevisionIntact(revision) && revision.valueHash === financeValueHash(financeFactValue(fact))
      && revision.valueHash === financeValueHash(financeFactValue(locked)),
    409, "FINANCE_REPORT_APPLICATION_CONFLICT", "The current value no longer matches its immutable revision.");
    return { ...locked, reportId: revision.reportId, accountPath: revision.accountPath, kind: revision.kind,
      periodStart: revision.periodStart, periodEnd: revision.periodEnd, amountCents: revision.amountCents,
      dimensions: revision.dimensions, semanticKey: revision.semanticKey, sourceBatchId: revision.sourceBatchId,
      sourceCandidateId: revision.sourceCandidateId, appliedByUserId: revision.appliedByUserId,
      version: revision.factVersion, currentFactRevisionId: revision.id };
  });
  return { roots, facts: values, revisions };
}

export async function publishFinanceFactRevision(tx: Prisma.TransactionClient, actor: AppActor, fact: FinanceReportFact,
  candidate: Pick<FinanceImportCandidate, "id" | "version" | "approvedByUserId" | "approvedAt">, roots: LineageRoot[]) {
  invariant(actor.kind === "user" && fact.appliedByUserId === actor.user.id && candidate.approvedByUserId && candidate.approvedAt && roots.length,
    409, "FINANCE_REPORT_APPLICATION_BLOCKED", "An immutable value needs its original human approval and complete recipe.");
  const current = await tx.financeImportCandidate.findFirst({ where: { id: candidate.id, workspaceId: fact.workspaceId, batchId: fact.sourceBatchId } });
  invariant(current && current.version === candidate.version && current.reviewState === "APPROVED"
    && current.approvedByUserId === candidate.approvedByUserId && current.approvedAt?.valueOf() === candidate.approvedAt.valueOf()
    && current.id === fact.sourceCandidateId && current.semanticKey === fact.semanticKey && current.amountCents === fact.amountCents
    && current.factKind === fact.kind && current.periodStart.valueOf() === fact.periodStart.valueOf()
    && current.periodEnd.valueOf() === fact.periodEnd.valueOf()
    && financeCanonicalJson(current.proposedAccountPath) === financeCanonicalJson(fact.accountPath)
    && financeCanonicalJson(current.dimensions ?? null) === financeCanonicalJson(fact.dimensions ?? null),
  409, "FINANCE_REPORT_APPLICATION_CONFLICT", "The approved Finance value changed.");
  const recipe = JSON.parse(JSON.stringify(roots)) as Prisma.InputJsonArray;
  const revision = await tx.financeReportFactRevision.create({ data: { workspaceId: fact.workspaceId, factId: fact.id,
    factVersion: fact.version, reportId: fact.reportId, accountPath: fact.accountPath, kind: fact.kind,
    periodStart: fact.periodStart, periodEnd: fact.periodEnd, amountCents: fact.amountCents,
    dimensions: fact.dimensions ?? PrismaValues.JsonNull, semanticKey: fact.semanticKey, sourceBatchId: fact.sourceBatchId,
    sourceCandidateId: fact.sourceCandidateId, appliedByUserId: fact.appliedByUserId, approvedByUserId: candidate.approvedByUserId,
    approvedAt: candidate.approvedAt, candidateVersion: candidate.version, valueHash: financeValueHash(financeFactValue(fact)),
    recipeJson: recipe, recipeHash: financeValueHash(recipe) } });
  await recordArtifactInputLineage({ tx, actor, workspaceId: fact.workspaceId,
    artifact: { kind: "FinanceReportFactRevision", id: revision.id }, content: revision, origin: "DERIVED", inputs: [], inheritedRoots: roots });
  return { revision, value: financeRevisionValue(revision), roots: await captureArtifactInputProof(actor, fact.workspaceId,
    [{ kind: "FinanceReportFactRevision", id: revision.id, snapshot: revision }], tx) };
}
