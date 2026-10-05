import type { Prisma } from "@prisma/client";
import { invariant } from "./errors";

/** Shared transaction lock for article links and source/document archive. */
export async function lockBrainSourceLink(tx: Prisma.TransactionClient, sourceId: string) {
  await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${`workspace_archive:BrainSource:${sourceId}`}, 0))`;
}

export async function lockActiveArticleSources(tx: Prisma.TransactionClient, workspaceId: string, sourceIds: readonly string[]) {
  const ids = [...new Set(sourceIds)].sort();
  for (const id of ids) await lockBrainSourceLink(tx, id);
  if (ids.length === 0) return;
  const sources = await tx.brainSource.findMany({
    where: { id: { in: ids }, workspaceId, archivedAt: null },
    select: { id: true, metadata: true },
  });
  invariant(sources.length === ids.length, 409, "SOURCE_CHANGED", "An article source is no longer active.");
  const documentIds = [...new Set(sources.flatMap((source) => {
    const metadata = source.metadata;
    if (!metadata || typeof metadata !== "object" || Array.isArray(metadata)) return [];
    return typeof metadata.documentId === "string" ? [metadata.documentId] : [];
  }))];
  if (documentIds.length > 0) {
    const activeCount = await tx.document.count({ where: { id: { in: documentIds }, workspaceId, archivedAt: null } });
    invariant(activeCount === documentIds.length, 409, "SOURCE_CHANGED", "A source document is no longer active.");
  }
}
