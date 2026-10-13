import type { Prisma } from "@prisma/client";
import { getMcpOrigin, prisma, type AppActor } from "@corgtex/shared";
import { invariant } from "./errors";

/** Reserve ambient physical read-authority rows before any source or OAuth epoch
 * checks in a bounded caller transaction. This grants no source access, captures
 * no epochs and does not replace a complete source/target lock plan. */
export async function lockArtifactReadAuthorityRows(actor: AppActor, workspaceId: string,
  tx: Prisma.TransactionClient): Promise<void> {
  invariant(tx !== prisma, 409, "SOURCE_CHANGED", "Read authority locks require a caller transaction.");
  const origin = getMcpOrigin();
  invariant(!origin || origin.workspaceId === workspaceId, 409, "SOURCE_CHANGED", "Read authority workspace changed.");
  if (actor.kind === "user") {
    const { lockFinanceReadAuthority } = await import("./finance");
    await lockFinanceReadAuthority(tx, workspaceId, actor.user.id);
    await tx.$queryRaw`SELECT "id" FROM "User" WHERE "id" = ${actor.user.id} FOR SHARE`;
  } else {
    if (actor.credentialId) await tx.$queryRaw`SELECT "id" FROM "AgentCredential" WHERE "id" = ${actor.credentialId} AND "workspaceId" = ${workspaceId} FOR SHARE`;
    if (actor.agentIdentityId) await tx.$queryRaw`SELECT "id" FROM "AgentIdentity" WHERE "id" = ${actor.agentIdentityId} AND "workspaceId" = ${workspaceId} FOR SHARE`;
    if (actor.supportOrigin) {
      await tx.$queryRaw`SELECT "id" FROM "User" WHERE "id" = ${actor.supportOrigin.userId} FOR SHARE`;
      await tx.$queryRaw`SELECT "id" FROM "WorkspaceSupportGrant" WHERE "workspaceId" = ${workspaceId} AND "userId" = ${actor.supportOrigin.userId} FOR SHARE`;
    }
  }
  if (origin?.kind === "oauth") {
    await tx.$queryRaw`SELECT "id" FROM "McpOAuthAccessToken" WHERE "id" = ${origin.id} AND "workspaceId" = ${workspaceId} FOR SHARE`;
    const token = await tx.mcpOAuthAccessToken.findFirst({ where: { id: origin.id, workspaceId }, select: { clientId: true } });
    invariant(token, 409, "SOURCE_CHANGED", "The serving OAuth grant changed.");
    await tx.$queryRaw`SELECT "id" FROM "McpOAuthClient" WHERE "id" = ${token.clientId} FOR SHARE`;
  } else if (origin?.kind === "agent") {
    await tx.$queryRaw`SELECT "id" FROM "AgentCredential" WHERE "id" = ${origin.id} AND "workspaceId" = ${workspaceId} FOR SHARE`;
  }
}
