import type { Prisma } from "@prisma/client";
import { invariant } from "./errors";

export type FinanceImportArtifactKind = "BRAIN_SOURCE" | "DOCUMENT";

type FinanceImportArtifact = {
  workspaceId: string;
  kind: FinanceImportArtifactKind;
  id: string;
};

function ownershipLockKey(artifact: FinanceImportArtifact) {
  return `finance-import-artifact:${artifact.workspaceId}:${artifact.kind}:${artifact.id}`;
}

export async function lockFinanceImportArtifactOwnership(
  tx: Prisma.TransactionClient,
  artifact: FinanceImportArtifact,
) {
  const lockKey = ownershipLockKey(artifact);
  await tx.$queryRaw`SELECT pg_advisory_xact_lock(hashtextextended(${lockKey}, 0))`;
}

export async function lockFinanceImportArtifactLinkTargets(
  tx: Prisma.TransactionClient,
  params: { workspaceId: string; documentId: string; brainSourceId: string },
) {
  const artifacts: FinanceImportArtifact[] = [
    { workspaceId: params.workspaceId, kind: "DOCUMENT", id: params.documentId },
    { workspaceId: params.workspaceId, kind: "BRAIN_SOURCE", id: params.brainSourceId },
  ];
  artifacts.sort((left, right) => ownershipLockKey(left) < ownershipLockKey(right) ? -1 : 1);
  for (const artifact of artifacts) {
    await lockFinanceImportArtifactOwnership(tx, artifact);
  }

  const [document, brainSource] = await Promise.all([
    tx.document.findUnique({
      where: { id_workspaceId: { id: params.documentId, workspaceId: params.workspaceId } },
      select: { accessDomain: true, archivedAt: true },
    }),
    tx.brainSource.findUnique({
      where: { id_workspaceId: { id: params.brainSourceId, workspaceId: params.workspaceId } },
      select: { accessDomain: true, archivedAt: true },
    }),
  ]);
  invariant(
    document?.accessDomain === "FINANCE" && !document.archivedAt,
    409,
    "FINANCE_IMPORT_ARTIFACT_UNAVAILABLE",
    "The Finance report document is no longer available.",
  );
  invariant(
    brainSource?.accessDomain === "FINANCE" && !brainSource.archivedAt,
    409,
    "FINANCE_IMPORT_ARTIFACT_UNAVAILABLE",
    "The Finance report Brain source is no longer available.",
  );
}
