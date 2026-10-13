import { AsyncLocalStorage } from "node:async_hooks";
import type { Prisma } from "@prisma/client";
import { createHash } from "node:crypto";

export type McpOrigin = { kind: "oauth" | "agent"; id: string; workspaceId: string; credentialVersion?: string;
  scopeHash?: string; requiredScopes?: string[]; canonical?: true };
const context = new AsyncLocalStorage<McpOrigin | undefined>();
export const getMcpOrigin = () => context.getStore();
export const mcpCredentialVersion = (tokenHash: string) => createHash("sha256").update(tokenHash).digest("hex");
export const mcpScopesHash = (scopes: readonly string[]) => createHash("sha256")
  .update(JSON.stringify([...new Set(scopes)].sort())).digest("hex");
export function runWithMcpOrigin<T>(origin: McpOrigin | undefined, run: () => PromiseLike<T>): Promise<T> {
  return context.run(origin, async () => await run());
}
export function parseMcpOrigin(value: unknown): McpOrigin {
  const row = value as McpOrigin | null;
  if (!row || !["oauth", "agent"].includes(row.kind) || typeof row.id !== "string" || !row.id
    || typeof row.workspaceId !== "string" || !row.workspaceId
    || !/^[a-f0-9]{64}$/.test(row.scopeHash ?? "")
    || (row.requiredScopes !== undefined && (!Array.isArray(row.requiredScopes)
      || row.requiredScopes.some(scope => typeof scope !== "string" || !scope.trim())))
    || (row.canonical !== undefined && row.canonical !== true)
    || (row.kind === "agent" && !/^[a-f0-9]{64}$/.test(row.credentialVersion ?? ""))) {
    throw new Error("MCP_AUTHORIZATION_REVOKED");
  }
  return { kind: row.kind, id: row.id, workspaceId: row.workspaceId, scopeHash: row.scopeHash,
    requiredScopes: [...new Set(row.requiredScopes ?? [])],
    ...(row.canonical ? { canonical: true } : {}),
    ...(row.kind === "agent" ? { credentialVersion: row.credentialVersion } : {}) };
}

/** Dynamic tool scopes join the same origin persisted on queued work. */
export function recordMcpRequiredScope(scope: string) {
  const origin = getMcpOrigin();
  if (origin) origin.requiredScopes = [...new Set([...(origin.requiredScopes ?? []), scope])];
}

/** Each concurrent tool gets its own scope set; another session cannot replace its origin. */
export async function withMcpRequiredScopes<T>(db: Prisma.TransactionClient, expected: McpOrigin | undefined,
  scopes: readonly string[], run: () => PromiseLike<T>): Promise<T> {
  const current = getMcpOrigin();
  if (!expected) {
    if (current) throw new Error("MCP_AUTHORIZATION_REVOKED");
    return await run();
  }
  const origin = parseMcpOrigin(expected);
  if (current && (current.kind !== origin.kind || current.id !== origin.id || current.workspaceId !== origin.workspaceId
    || current.credentialVersion !== origin.credentialVersion || current.scopeHash !== origin.scopeHash)) {
    throw new Error("MCP_AUTHORIZATION_REVOKED");
  }
  origin.requiredScopes = [...new Set([...(current?.requiredScopes ?? []), ...(origin.requiredScopes ?? []), ...scopes])];
  return runWithMcpOrigin(origin, async () => {
    await assertMcpOriginActive(db, origin, origin.workspaceId);
    const result = await run();
    await assertMcpOriginActive(db, origin, origin.workspaceId);
    return result;
  });
}

// Domain membership and every manifested write reuse this live origin check.
// Scope changes do not require token rotation to revoke in-flight or queued work.
export async function assertMcpOriginActive(db: Prisma.TransactionClient, origin: McpOrigin, workspaceId: string) {
  if (origin.workspaceId !== workspaceId || !/^[a-f0-9]{64}$/.test(origin.scopeHash ?? "")) throw new Error("MCP_AUTHORIZATION_REVOKED");
  let scopes: string[];
  if (origin.kind === "oauth") {
    const token = await db.mcpOAuthAccessToken.findUnique({ where: { id: origin.id }, include: { client: true } });
    if (!token || token.workspaceId !== workspaceId || token.revokedAt || !token.client.isActive
      || (token.refreshExpiresAt && token.refreshExpiresAt <= new Date())) throw new Error("MCP_AUTHORIZATION_REVOKED");
    scopes = token.scopes;
  } else {
    const credential = await db.agentCredential.findUnique({ where: { id: origin.id } });
    if (!credential?.isActive || credential.workspaceId !== workspaceId
      || mcpCredentialVersion(credential.tokenHash) !== origin.credentialVersion) throw new Error("MCP_AUTHORIZATION_REVOKED");
    scopes = credential.scopes;
  }
  if (!Array.isArray(scopes) || mcpScopesHash(scopes) !== origin.scopeHash
    || (origin.requiredScopes ?? []).some(scope => !scopes.includes(scope))) throw new Error("MCP_AUTHORIZATION_REVOKED");
}
