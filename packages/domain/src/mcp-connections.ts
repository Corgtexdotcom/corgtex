import { prisma, runWithMcpExecutionOrigin } from "@corgtex/shared";
import type { AppActor } from "@corgtex/shared";
import { requireWorkspaceMembership } from "./auth";
import { AppError, invariant } from "./errors";
import { getMcpConnectorInstance, getWorkspaceMcpPublicUrl } from "./mcp-connector";
import { supportCapabilityVersion } from "./workspace-support-access";

export async function listWorkspaceMcpConnections(actor: AppActor, workspaceId: string) {
  await requireWorkspaceMembership({ actor, workspaceId });
  invariant(actor.kind === "user", 403, "FORBIDDEN", "A signed-in user is required.");
  const [workspace, connections] = await Promise.all([
    prisma.workspace.findUniqueOrThrow({ where: { id: workspaceId }, select: { name: true } }),
    prisma.mcpOAuthAccessToken.findMany({
      where: { workspaceId, userId: actor.user.id, revokedAt: null },
      select: { id: true, resource: true, createdAt: true, refreshExpiresAt: true, client: { select: { name: true } } },
      orderBy: { createdAt: "desc" },
    }),
  ]);
  const resource = getWorkspaceMcpPublicUrl(workspaceId);
  return {
    label: `Corgtex - ${workspace.name} - ${workspaceId}`,
    resource,
    connections: connections.map(({ client, ...connection }) => ({
      ...connection, clientName: client.name,
      requiresReauthorization: connection.resource !== resource,
    })),
  };
}

export async function revokeWorkspaceMcpConnection(actor: AppActor, workspaceId: string, connectionId: string) {
  await requireWorkspaceMembership({ actor, workspaceId });
  invariant(actor.kind === "user", 403, "FORBIDDEN", "A signed-in user is required.");
  const result = await prisma.mcpOAuthAccessToken.updateMany({
    where: { id: connectionId, workspaceId, userId: actor.user.id },
    data: { revokedAt: new Date() },
  });
  invariant(result.count === 1, 404, "NOT_FOUND", "Connection not found.");
}

export async function withMcpConnectionExecution<T>(record: {
  workspaceId: string | null; mcpConnectionId?: string | null;
}, run: () => Promise<T>): Promise<T> {
  if (!record.mcpConnectionId) return runWithMcpExecutionOrigin(undefined, run);
  const token = await prisma.mcpOAuthAccessToken.findUnique({
    where: { id: record.mcpConnectionId }, include: { user: true, client: true },
  });
  invariant(token && !token.revokedAt && token.client.isActive && token.workspaceId === record.workspaceId &&
    token.refreshExpiresAt && token.refreshExpiresAt > new Date() && getMcpConnectorInstance(token.instanceSlug),
  403, "MCP_CONNECTION_REVOKED", "Delegated MCP connection is no longer authorized.");
  try {
    await requireWorkspaceMembership({ actor: { kind: "user", user: token.user }, workspaceId: token.workspaceId });
    await supportCapabilityVersion(token.userId, token.workspaceId, token.supportGrantVersion);
  } catch (error) {
    if (error instanceof AppError && error.status === 403) {
      throw new AppError(403, "MCP_CONNECTION_REVOKED", "Delegated MCP connection is no longer authorized.");
    }
    throw error;
  }
  return runWithMcpExecutionOrigin({ connectionId: token.id, workspaceId: token.workspaceId }, run);
}
