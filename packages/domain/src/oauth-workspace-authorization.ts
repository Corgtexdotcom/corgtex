import type { Prisma } from "@prisma/client";
import { getSupportAuthorizationContext, prisma } from "@corgtex/shared";
import { requireDeploymentWorkspaceScope } from "./auth";
import { invariant } from "./errors";
import { lockWorkspaceMembership } from "./workspace-support-access";

// OAuth writes and owner revocation share one lock. Capture authorization before
// waiting, then re-read it under the lock so a regrant cannot upgrade this request.
export async function withOAuthWorkspaceAuthorization<T>(
  userId: string,
  workspaceId: string,
  run: (tx: Prisma.TransactionClient) => Promise<T>,
) {
  const origin = getSupportAuthorizationContext()?.origin;
  const where = { workspaceId_userId: { workspaceId, userId } };
  const captured = await prisma.workspaceSupportGrant.findUnique({ where });
  invariant(!origin || (origin.userId === userId && origin.workspaceId === workspaceId && origin.version === captured?.version),
    403, "SUPPORT_AUTHORIZATION_REVOKED", "Support authorization is unavailable.");
  invariant(!captured || (captured.isActive && captured.role === "FULL"),
    403, "SUPPORT_CONTENT_RESTRICTED", "Content access is restricted.");
  return prisma.$transaction(async tx => {
    await lockWorkspaceMembership(tx, workspaceId);
    await requireDeploymentWorkspaceScope(workspaceId, tx);
    const current = await tx.workspaceSupportGrant.findUnique({ where });
    invariant((current?.version ?? null) === (captured?.version ?? null)
      && (!current || (current.isActive && current.role === "FULL")),
    403, "SUPPORT_AUTHORIZATION_REVOKED", "Support authorization is unavailable.");
    const member = await tx.member.findUnique({ where, select: { isActive: true } });
    invariant(member?.isActive, 403, "NOT_A_MEMBER", "You are not an active member of this workspace.");
    return run(tx);
  });
}
