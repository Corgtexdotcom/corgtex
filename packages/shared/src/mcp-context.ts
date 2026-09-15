import { AsyncLocalStorage } from "node:async_hooks";
import type { Prisma } from "@prisma/client";
import { createHash } from "node:crypto";

export type McpOrigin = { kind: "oauth" | "agent"; id: string; workspaceId: string; credentialVersion?: string; canonical?: true };
const context = new AsyncLocalStorage<McpOrigin | undefined>();
export const getMcpOrigin = () => context.getStore();
export const mcpCredentialVersion = (tokenHash: string) => createHash("sha256").update(tokenHash).digest("hex");
export function runWithMcpOrigin<T>(origin: McpOrigin | undefined, run: () => PromiseLike<T>): Promise<T> {
  return context.run(origin, async () => await run());
}
export function parseMcpOrigin(value: unknown): McpOrigin {
  const row = value as McpOrigin | null;
  if (!row || !["oauth", "agent"].includes(row.kind) || typeof row.id !== "string" || !row.id
    || typeof row.workspaceId !== "string" || !row.workspaceId
    || (row.canonical !== undefined && row.canonical !== true)
    || (row.kind === "agent" && !/^[a-f0-9]{64}$/.test(row.credentialVersion ?? ""))) {
    throw new Error("MCP_AUTHORIZATION_REVOKED");
  }
  return { kind: row.kind, id: row.id, workspaceId: row.workspaceId,
    ...(row.canonical ? { canonical: true } : {}),
    ...(row.kind === "agent" ? { credentialVersion: row.credentialVersion } : {}) };
}

// Only credential identity/revocation here. Domain membership remains the single
// Full/Setup permission policy; the outbox and request wrappers both invoke it.
export async function assertMcpOriginActive(db: Prisma.TransactionClient, origin: McpOrigin, workspaceId: string) {
  if (origin.workspaceId !== workspaceId) throw new Error("MCP_AUTHORIZATION_REVOKED");
  if (origin.kind === "oauth") {
    const token = await db.mcpOAuthAccessToken.findUnique({ where: { id: origin.id }, include: { client: true } });
    if (!token || token.workspaceId !== workspaceId || token.revokedAt || !token.client.isActive
      || (token.refreshExpiresAt && token.refreshExpiresAt <= new Date())) throw new Error("MCP_AUTHORIZATION_REVOKED");
  } else {
    const credential = await db.agentCredential.findUnique({ where: { id: origin.id } });
    if (!credential?.isActive || credential.workspaceId !== workspaceId
      || mcpCredentialVersion(credential.tokenHash) !== origin.credentialVersion) throw new Error("MCP_AUTHORIZATION_REVOKED");
  }
}
