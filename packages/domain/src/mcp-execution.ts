import { prisma, parseMcpOrigin, assertMcpOriginActive, runWithMcpOrigin, runWithSupportOrigin } from "@corgtex/shared";
import type { AppActor } from "@corgtex/shared";
import { requireWorkspaceMembership } from "./auth";
import { supportCapabilityVersion } from "./workspace-support-access";
import { invariant } from "./errors";
import { getMcpConnectorInstance } from "./mcp-connector";

export async function withMcpConnectionExecution<T>(record: { workspaceId: string | null; mcpOrigin?: unknown }, run: () => PromiseLike<T>): Promise<T> {
  if (record.mcpOrigin == null) return runWithMcpOrigin(undefined, run);
  const origin = parseMcpOrigin(record.mcpOrigin);
  invariant(record.workspaceId === origin.workspaceId, 403, "MCP_AUTHORIZATION_REVOKED", "MCP connection authorization is unavailable.");
  await assertMcpOriginActive(prisma, origin, origin.workspaceId);
  let actor: AppActor;
  let userId: string | null, version: number | null;
  if (origin.kind === "oauth") {
    const token = await prisma.mcpOAuthAccessToken.findUniqueOrThrow({ where: { id: origin.id }, include: { user: true } });
    invariant(getMcpConnectorInstance(token.instanceSlug), 403, "MCP_AUTHORIZATION_REVOKED", "MCP connection authorization is unavailable.");
    actor = { kind: "user", user: token.user };
    userId = token.userId; version = token.supportGrantVersion;
  } else {
    const credential = await prisma.agentCredential.findUniqueOrThrow({ where: { id: origin.id } });
    userId = credential.createdByUserId; version = credential.supportGrantVersion;
    actor = { kind: "agent", authProvider: "credential", label: credential.label, credentialId: credential.id, credentialVersion: origin.credentialVersion,
      workspaceIds: [credential.workspaceId], scopes: credential.scopes,
      ...(userId && version != null ? { supportOrigin: { userId, workspaceId: origin.workspaceId, version } } : {}) };
  }
  await supportCapabilityVersion(userId, origin.workspaceId, version);
  return runWithMcpOrigin(origin, () => runWithSupportOrigin(userId && version != null
    ? { userId, workspaceId: origin.workspaceId, version } : undefined, async () => {
    await requireWorkspaceMembership({ actor, workspaceId: origin.workspaceId });
    const result = await run();
    await requireWorkspaceMembership({ actor, workspaceId: origin.workspaceId });
    return result;
  }));
}
