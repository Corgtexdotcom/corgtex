import { prisma } from "@corgtex/shared";
import type { Prisma } from "@prisma/client";

/** Absence-sensitive control projection, with no provider body or credentials. */
export async function loadExternalMcpConnectionSetInput(workspaceId: string, localUserId: string,
  db: typeof prisma | Prisma.TransactionClient = prisma) {
  const rows = await db.$queryRaw<Array<{ epoch: bigint }>>`SELECT epoch FROM "SourcePermissionEpoch"
    WHERE "workspaceId" = ${workspaceId} AND "sourceKind" = ${"ExternalMcpConnectionSetPolicy"} AND "sourceId" = ${localUserId}`;
  return { id: localUserId, workspaceId, localUserId, epoch: String(rows[0]?.epoch ?? 0n) };
}
