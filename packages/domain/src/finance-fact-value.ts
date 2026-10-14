import { createHash } from "node:crypto";
import type { FinanceReportFact, FinanceReportFactRevision, Prisma } from "@prisma/client";

export function financeCanonicalJson(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (value instanceof Date) return JSON.stringify(value.toISOString());
  if (Array.isArray(value)) return `[${value.map(financeCanonicalJson).join(",")}]`;
  const row = value as Record<string, unknown>;
  return `{${Object.keys(row).sort().map(key => `${JSON.stringify(key)}:${financeCanonicalJson(row[key])}`).join(",")}}`;
}
export function financeValueHash(value: unknown) { return createHash("sha256").update(financeCanonicalJson(value)).digest("hex"); }

export function financeFactValue(fact: Pick<FinanceReportFact, "id" | "reportId" | "accountPath" | "kind" | "periodStart" | "periodEnd" | "amountCents" | "dimensions" | "semanticKey" | "sourceBatchId" | "sourceCandidateId" | "appliedByUserId" | "version">): Prisma.InputJsonObject {
  return { id: fact.id, reportId: fact.reportId, accountPath: fact.accountPath, kind: fact.kind,
    periodStart: fact.periodStart.toISOString().slice(0, 10), periodEnd: fact.periodEnd.toISOString().slice(0, 10),
    amountCents: fact.amountCents, dimensions: fact.dimensions ?? null, semanticKey: fact.semanticKey,
    sourceBatchId: fact.sourceBatchId, sourceCandidateId: fact.sourceCandidateId,
    appliedByUserId: fact.appliedByUserId, version: fact.version };
}
export function financeRevisionValue(revision: FinanceReportFactRevision) {
  return financeFactValue({ ...revision, id: revision.factId, version: revision.factVersion });
}
export function isFinanceFactRevisionIntact(row: Record<string, unknown>): boolean {
  if (!(row.periodStart instanceof Date) || !Number.isFinite(row.periodStart.valueOf())
    || !(row.periodEnd instanceof Date) || !Number.isFinite(row.periodEnd.valueOf()) || !Array.isArray(row.accountPath)
    || !Array.isArray(row.recipeJson) || !row.recipeJson.length || typeof row.approvedByUserId !== "string"
    || !(row.approvedAt instanceof Date) || !Number.isInteger(row.candidateVersion)) return false;
  const revision = row as unknown as FinanceReportFactRevision;
  const valueValid = financeValueHash(financeRevisionValue(revision)) === row.valueHash;
  const recipeValid = financeValueHash(row.recipeJson) === row.recipeHash;
  return valueValid && recipeValid;
}
