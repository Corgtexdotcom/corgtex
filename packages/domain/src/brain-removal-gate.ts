import { Prisma } from "@prisma/client";
import { prisma } from "@corgtex/shared";
import { invariant } from "./errors";

const FLAG = "BRAIN_SOURCE_REMOVAL";
const RUNTIME_OPT_IN = "BRAIN_SOURCE_REMOVAL_RUNTIME_ENABLED";

/** A stored workspace flag alone cannot activate removal during mixed revisions. */
export function isBrainSourceRemovalRuntimeEnabled() {
  return process.env[RUNTIME_OPT_IN] === "true";
}

export async function isBrainSourceRemovalEnabled(db: Prisma.TransactionClient | typeof prisma, workspaceId: string) {
  if (!isBrainSourceRemovalRuntimeEnabled()) return false;
  const flag = await db.workspaceFeatureFlag.findUnique({
    where: { workspaceId_flag: { workspaceId, flag: FLAG } }, select: { enabled: true },
  });
  return flag?.enabled === true;
}

/** Hold a shared lock so disabling the flag cannot race a removal transaction. */
export async function requireBrainSourceRemovalEnabled(tx: Prisma.TransactionClient, workspaceId: string) {
  invariant(isBrainSourceRemovalRuntimeEnabled(), 409, "BRAIN_SOURCE_REMOVAL_DISABLED",
    "Source removal is paused until compatible workers are ready.");
  const flags = await tx.$queryRaw<Array<{ enabled: boolean }>>(Prisma.sql`
    SELECT enabled FROM "WorkspaceFeatureFlag"
    WHERE "workspaceId" = ${workspaceId} AND flag = ${FLAG}
    FOR SHARE
  `);
  invariant(flags[0]?.enabled === true, 409, "BRAIN_SOURCE_REMOVAL_DISABLED",
    "Source removal is paused until compatible workers are ready.");
}
