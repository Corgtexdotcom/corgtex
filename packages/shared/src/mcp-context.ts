import { AsyncLocalStorage } from "node:async_hooks";
import { Prisma, type AgentCredential } from "@prisma/client";
import { createHash, randomUUID } from "node:crypto";

export type McpOrigin = { kind: "oauth" | "agent"; id: string; workspaceId: string; credentialVersion?: string;
  scopeHash?: string; grantEpoch?: string; requiredScopes?: string[]; canonical?: true };
// Compare only these existing queries and their generated payloads. Comparing
// whole generic model delegates expands unrelated include/select result types
// for the query interceptor's configured PrismaClient.
type McpOriginReadClient = Pick<Prisma.TransactionClient, "$queryRaw"> & {
  mcpOAuthAccessToken: {
    findUnique(args: { where: { id: string }; include: { client: true } }):
      PromiseLike<Prisma.McpOAuthAccessTokenGetPayload<{ include: { client: true } }> | null>;
  };
  agentCredential: {
    findUnique(args: { where: { id: string } }): PromiseLike<AgentCredential | null>;
  };
};
const OAUTH_GRANT_POLICY = "McpOAuthGrantPolicy";
const validEpoch = (value: unknown): value is string => typeof value === "string" && /^(0|[1-9][0-9]*)$/.test(value);
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
    || (row.kind === "agent" && (!/^[a-f0-9]{64}$/.test(row.credentialVersion ?? "") || row.grantEpoch !== undefined))
    || (row.kind === "oauth" && !validEpoch(row.grantEpoch))) {
    throw new Error("MCP_AUTHORIZATION_REVOKED");
  }
  return { kind: row.kind, id: row.id, workspaceId: row.workspaceId, scopeHash: row.scopeHash,
    requiredScopes: [...new Set(row.requiredScopes ?? [])],
    ...(row.canonical ? { canonical: true } : {}),
    ...(row.kind === "agent" ? { credentialVersion: row.credentialVersion } : { grantEpoch: row.grantEpoch }) };
}

/** Mint only while authenticating a bearer, then verify the token on the same
 * transaction after this row is locked. Never mint a queued origin at dispatch. */
export async function captureMcpOAuthGrantEpoch(tx: Prisma.TransactionClient, workspaceId: string, tokenId: string): Promise<string> {
  if (!workspaceId || !tokenId) throw new Error("MCP_AUTHORIZATION_REVOKED");
  await tx.$executeRaw(Prisma.sql`INSERT INTO "SourcePermissionEpoch" ("id", "workspaceId", "sourceKind", "sourceId", "epoch")
    VALUES (${randomUUID()}, ${workspaceId}, ${OAUTH_GRANT_POLICY}, ${tokenId}, 0)
    ON CONFLICT ("workspaceId", "sourceKind", "sourceId") DO NOTHING`);
  const rows = await tx.$queryRaw<Array<{ epoch: bigint }>>(Prisma.sql`SELECT "epoch" FROM "SourcePermissionEpoch"
    WHERE "workspaceId" = ${workspaceId} AND "sourceKind" = ${OAUTH_GRANT_POLICY} AND "sourceId" = ${tokenId} FOR SHARE`);
  if (rows.length !== 1) throw new Error("MCP_AUTHORIZATION_REVOKED");
  return rows[0]!.epoch.toString();
}

async function assertMcpOAuthGrantEpoch(tx: Pick<McpOriginReadClient, "$queryRaw">, origin: McpOrigin, workspaceId: string, lock: boolean) {
  if (!validEpoch(origin.grantEpoch)) throw new Error("MCP_AUTHORIZATION_REVOKED");
  const identity = Prisma.sql`WHERE "workspaceId" = ${workspaceId} AND "sourceKind" = ${OAUTH_GRANT_POLICY} AND "sourceId" = ${origin.id}`;
  const rows = lock
    ? await tx.$queryRaw<Array<{ epoch: bigint }>>(Prisma.sql`SELECT "epoch" FROM "SourcePermissionEpoch" ${identity} FOR SHARE`)
    : await tx.$queryRaw<Array<{ epoch: bigint }>>(Prisma.sql`SELECT "epoch" FROM "SourcePermissionEpoch" ${identity}`);
  if (rows.length !== 1 || rows[0]!.epoch.toString() !== origin.grantEpoch) throw new Error("MCP_AUTHORIZATION_REVOKED");
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
    || current.credentialVersion !== origin.credentialVersion || current.scopeHash !== origin.scopeHash
    || current.grantEpoch !== origin.grantEpoch)) {
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
async function assertMcpOriginActiveUsing(db: McpOriginReadClient, origin: McpOrigin, workspaceId: string,
  lockEpoch: boolean): Promise<void> {
  if (origin.workspaceId !== workspaceId || !/^[a-f0-9]{64}$/.test(origin.scopeHash ?? "")) throw new Error("MCP_AUTHORIZATION_REVOKED");
  // A standalone check needs one short transaction so the epoch lock protects
  // the subsequent token/client read. A supplied writer tx retains that lock
  // through its own commit.
  if (origin.kind === "oauth" && lockEpoch) {
    const client = db as McpOriginReadClient & { $transaction?: <T>(fn: (tx: Prisma.TransactionClient) => Promise<T>) => Promise<T> };
    if (typeof client.$transaction === "function") {
      return client.$transaction(tx => assertMcpOriginActiveUsing(tx, origin, workspaceId, lockEpoch));
    }
  }
  if (origin.kind === "oauth") await assertMcpOAuthGrantEpoch(db, origin, workspaceId, lockEpoch);
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
  if (origin.kind === "oauth" && !lockEpoch) await assertMcpOAuthGrantEpoch(db, origin, workspaceId, false);
}

export async function assertMcpOriginActive(db: Prisma.TransactionClient, origin: McpOrigin, workspaceId: string): Promise<void> {
  return assertMcpOriginActiveUsing(db, origin, workspaceId, true);
}

/** A nonlocking, read–token–read observation for the Prisma query interceptor.
 * It is only a diagnostic around mutations; callers must fence writes in their
 * own transaction with assertMcpOriginActive. */
export async function assertMcpOriginActiveAdvisory(db: McpOriginReadClient, origin: McpOrigin, workspaceId: string): Promise<void> {
  return assertMcpOriginActiveUsing(db, origin, workspaceId, false);
}
