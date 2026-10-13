import type { MemberRole, Prisma } from "@prisma/client";
import { mcpCredentialVersion, prisma } from "@corgtex/shared";
import type { AppActor, MembershipSummary } from "@corgtex/shared";
import { requireWorkspaceMembership } from "./auth";
import { requireAgentOperation, requiredAgentOperationScopes } from "./agent-operation-capabilities";
import { AppError } from "./errors";

/** Revalidate credential authority at the domain boundary, including callers that
 * hold an actor resolved earlier. Credential metadata is never authority to read a
 * tool secret. In sensitive transactions call this before selecting secret fields. */
export async function requireWorkspaceOperation(params: {
  actor: AppActor;
  workspaceId: string;
  operation: string;
  allowedRoles?: MemberRole[];
  resolvedMembership?: MembershipSummary | null;
  tx?: Prisma.TransactionClient;
}) {
  const { actor, operation, ...membershipParams } = params;
  requireAgentOperation(actor, operation);
  const membership = await requireWorkspaceMembership({ actor, ...membershipParams });
  if (actor.kind !== "agent" || actor.authProvider !== "credential") return membership;
  if (!actor.credentialId || !actor.credentialVersion) {
    throw new AppError(403, "AGENT_AUTHORIZATION_REVOKED", "Agent authorization is unavailable.");
  }
  const db = params.tx ?? prisma;
  const credential = await db.agentCredential.findUnique({
    where: { id: actor.credentialId },
    select: { workspaceId: true, isActive: true, tokenHash: true, scopes: true,
      createdBy: { select: { id: true } }, supportGrantVersion: true },
  });
  const requiredScopes = requiredAgentOperationScopes(operation);
  if (!credential?.isActive || credential.workspaceId !== params.workspaceId
    || mcpCredentialVersion(credential.tokenHash) !== actor.credentialVersion
    || !requiredScopes || requiredScopes.some(scope => !credential.scopes.includes(scope))
    || (params.allowedRoles?.length && !credential.scopes.includes("support:write"))) {
    throw new AppError(403, "AGENT_AUTHORIZATION_REVOKED", "Agent authorization is unavailable.");
  }
  // A cached actor may predate a support grant or its restriction. Resolve the
  // current creator grant just as bearer authentication does, rather than treating
  // the absence of supportOrigin on the cached actor as unrestricted authority.
  const grant = credential.createdBy ? await db.workspaceSupportGrant.findUnique({
    where: { workspaceId_userId: { workspaceId: params.workspaceId, userId: credential.createdBy.id } },
    select: { role: true, isActive: true, version: true },
  }) : null;
  if ((grant && (!grant.isActive || grant.role !== "FULL" || credential.supportGrantVersion !== grant.version))
    || (!grant && credential.supportGrantVersion != null)) {
    throw new AppError(403, "SUPPORT_AUTHORIZATION_REVOKED", "Support authorization is unavailable.");
  }
  return membership;
}
