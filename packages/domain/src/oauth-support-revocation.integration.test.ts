import { createHash, randomUUID } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { prisma, runWithSupportOrigin, sha256 } from "@corgtex/shared";
import type { AppActor } from "@corgtex/shared";
import { requireWorkspaceMembership } from "./auth";
import { changeWorkspaceSupportGrant } from "./workspace-support-access";
import { exchangeMcpAuthorizationCode, issueMcpAuthorizationCode, refreshMcpAccessToken, resolveMcpOAuthAccessToken, revokeMcpToken } from "./mcp-connector";
import { exchangeAuthorizationCode, issueAuthorizationCode, refreshAccessToken, resolveOAuthAccessToken } from "./oauth-server";

const interception = vi.hoisted(() => ({ hook: undefined as undefined | ((model: string, operation: string, after: boolean) => Promise<void>) }));
vi.mock("@corgtex/shared", async importOriginal => {
  const actual = await importOriginal<typeof import("@corgtex/shared")>();
  return { ...actual, prisma: actual.prisma.$extends({ query: { $allModels: {
    async $allOperations({ model, operation, args, query }) {
      await interception.hook?.(model, operation, false);
      const result = await query(args);
      await interception.hook?.(model, operation, true);
      return result;
    },
  } } }) };
});

const redirectUri = "https://client.example/callback";
const verifier = "synthetic-pkce-verifier-".repeat(3);
const challenge = createHash("sha256").update(verifier).digest("base64url");
const fresh = <T>(run: () => Promise<T>) => runWithSupportOrigin(undefined, run);
function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>(done => { resolve = done; });
  return { promise, resolve };
}
function pause(model: string, operation: string, after = false) {
  const entered = deferred(), release = deferred();
  interception.hook = async (m, op, a) => {
    if (m !== model || op !== operation || a !== after) return;
    interception.hook = undefined;
    entered.resolve();
    await release.promise;
  };
  return { entered: entered.promise, release: release.resolve };
}

describe.each(["mcp", "legacy"] as const)("%s OAuth support revocation on PostgreSQL", kind => {
  let workspaceId: string, clientId: string, clientDbId: string;
  let owner: Extract<AppActor, { kind: "user" }>, support: Extract<AppActor, { kind: "user" }>;
  const tokenModel = kind === "mcp" ? "McpOAuthAccessToken" : "OAuthAccessToken";
  const codeModel = kind === "mcp" ? "McpOAuthAuthorizationCode" : "OAuthAuthorizationCode";
  const change = (version: number, active: boolean, role: "FULL" | "SETUP" = "FULL") => fresh(() => changeWorkspaceSupportGrant(owner, {
    workspaceId, email: support.user.email, role, expectedVersion: version, isActive: active,
  }));
  const issue = () => fresh(() => kind === "mcp"
    ? issueMcpAuthorizationCode(support, { workspaceId, clientId, redirectUri, scopes: ["workspace:read"], codeChallenge: challenge, codeChallengeMethod: "S256" })
    : issueAuthorizationCode(support, { workspaceId, clientId, redirectUri, scopes: ["read"] }));
  const exchange = (code: string) => fresh(() => kind === "mcp"
    ? exchangeMcpAuthorizationCode({ code, clientId, redirectUri, codeVerifier: verifier })
    : exchangeAuthorizationCode({ code, clientId, redirectUri, clientSecret: "synthetic" }));
  const refresh = (refreshToken: string) => fresh(() => kind === "mcp"
    ? refreshMcpAccessToken({ refreshToken, clientId })
    : refreshAccessToken({ refreshToken, clientId, clientSecret: "synthetic" }));
  const resolve = (token: string) => fresh(async () => kind === "mcp" ? resolveMcpOAuthAccessToken(token) : resolveOAuthAccessToken(token));
  const tokens = () => kind === "mcp"
    ? prisma.mcpOAuthAccessToken.findMany({ where: { workspaceId } })
    : prisma.oAuthAccessToken.findMany({ where: { workspaceId } });

  beforeEach(async () => fresh(async () => {
    interception.hook = undefined;
    const suffix = randomUUID();
    const a = await prisma.user.create({ data: { email: `oauth-owner-${suffix}@example.test`, passwordHash: "synthetic" } });
    const b = await prisma.user.create({ data: { email: `oauth-support-${suffix}@example.test`, passwordHash: "synthetic" } });
    owner = { kind: "user", user: a }; support = { kind: "user", user: b };
    const workspace = await prisma.workspace.create({ data: { slug: suffix, name: "Synthetic OAuth race", supportOwnerUserId: a.id } });
    workspaceId = workspace.id;
    await prisma.member.create({ data: { workspaceId, userId: a.id, role: "ADMIN" } });
    clientId = `synthetic-${suffix}`;
    const data = { clientId, name: "Synthetic OAuth", redirectUris: [redirectUri], scopes: kind === "mcp" ? ["workspace:read"] : ["read"] };
    const client = kind === "mcp" ? await prisma.mcpOAuthClient.create({ data })
      : await prisma.oAuthApp.create({ data: { ...data, workspaceId, clientSecret: sha256("synthetic") } });
    clientDbId = client.id;
    await change(0, true);
  }));
  afterEach(async () => fresh(async () => {
    interception.hook = undefined;
    await prisma.oAuthAccessToken.deleteMany({ where: { workspaceId } });
    await prisma.workspace.delete({ where: { id: workspaceId } });
    if (kind === "mcp") await prisma.mcpOAuthClient.delete({ where: { id: clientDbId } });
    await prisma.user.deleteMany({ where: { id: { in: [owner.user.id, support.user.id] } } });
  }));

  it("supports normal Full consent, exchange, refresh and fresh reconnect after regrant", async () => {
    const first = await exchange(await issue());
    expect(await resolve(first.access_token)).not.toBeNull();
    const next = await refresh(first.refresh_token);
    expect(await resolve(next.access_token)).not.toBeNull();
    await expect(refresh(first.refresh_token)).rejects.toMatchObject({ status: 401 });
    await change(1, false); await change(2, true);
    await expect(refresh(next.refresh_token)).rejects.toMatchObject({ status: 401 });
    const reconnect = await exchange(await issue());
    expect(await resolve(reconnect.access_token)).not.toBeNull();
  });

  it("keeps ordinary membership independent of support in another workspace", async () => {
    await prisma.workspaceSupportGrant.deleteMany({ where: { workspaceId } });
    const other = await prisma.workspace.create({ data: { slug: randomUUID(), name: "Other synthetic workspace" } });
    try {
      await prisma.workspaceSupportGrant.create({ data: { workspaceId: other.id, userId: support.user.id, role: "SETUP", grantedByUserId: owner.user.id } });
      const token = await exchange(await issue());
      const rotated = await refresh(token.refresh_token);
      expect(await resolve(rotated.access_token)).not.toBeNull();
    } finally { await prisma.workspace.delete({ where: { id: other.id } }); }
  });

  it("denies Setup even with a stale active member", async () => {
    await change(1, true, "SETUP");
    await prisma.member.update({ where: { workspaceId_userId: { workspaceId, userId: support.user.id } }, data: { isActive: true } });
    await expect(issue()).rejects.toMatchObject({ status: 403 });
  });

  it("preserves an already captured request epoch across regrant", async () => fresh(async () => {
    await requireWorkspaceMembership({ actor: support, workspaceId });
    await change(1, false); await change(2, true);
    const run = kind === "mcp"
      ? issueMcpAuthorizationCode(support, { workspaceId, clientId, redirectUri, codeChallenge: challenge, codeChallengeMethod: "S256" })
      : issueAuthorizationCode(support, { workspaceId, clientId, redirectUri, scopes: ["read"] });
    await expect(run).rejects.toMatchObject({ code: "SUPPORT_AUTHORIZATION_REVOKED" });
  }));

  it("rejects the captured grant if revocation wins before lock acquisition", async () => {
    const old = await exchange(await issue());
    const gate = pause("WorkspaceSupportGrant", "findUnique", true);
    const pending = refresh(old.refresh_token);
    const checked = expect(pending).rejects.toMatchObject({ code: "SUPPORT_AUTHORIZATION_REVOKED" });
    await gate.entered;
    try { await change(1, false); await change(2, true); }
    finally { gate.release(); }
    await checked;
  });

  it("does not issue a code under a regrant after capturing the previous grant", async () => {
    const gate = pause("WorkspaceSupportGrant", "findUnique", true);
    const pending = issue();
    const checked = expect(pending).rejects.toMatchObject({ code: "SUPPORT_AUTHORIZATION_REVOKED" });
    await gate.entered;
    try { await change(1, false); await change(2, true); }
    finally { gate.release(); }
    await checked;
  });

  it.each(["refresh", "exchange-create", "exchange-existing"])("re-reads a stale %s credential after revoke/regrant wins", async operation => {
    const old = operation !== "exchange-create" ? await exchange(await issue()) : null;
    const code = operation !== "refresh" ? await issue() : "";
    const gate = pause(operation === "refresh" ? tokenModel : codeModel, "findUnique", true);
    const pending = operation === "refresh" ? refresh(old!.refresh_token) : exchange(code);
    const checked = expect(pending).rejects.toMatchObject({ status: kind === "mcp" ? 403 : operation === "refresh" ? 401 : 400 });
    await gate.entered;
    try { await change(1, false); await change(2, true); }
    finally { gate.release(); }
    await checked;
    expect((await tokens()).every(token => token.revokedAt !== null)).toBe(true);
  });

  it.each(["refresh", "exchange-create", "exchange-existing", "issue"])("serializes delayed %s persistence with real owner revoke/regrant", async operation => {
    const old = operation === "refresh" || operation === "exchange-existing" ? await exchange(await issue()) : null;
    const code = operation.startsWith("exchange") ? await issue() : "";
    const gate = operation === "issue" ? pause(codeModel, "create")
      : pause(tokenModel, operation === "refresh" ? "updateMany" : kind === "mcp" ? "create" : "findFirst");
    const pending = operation === "issue" ? issue() : operation === "refresh" ? refresh(old!.refresh_token) : exchange(code);
    await gate.entered;
    const revocation = change(1, false).then(() => change(2, true));
    try {
      // Observe the actual PostgreSQL workspace-lock wait, not a timer-based guess.
      await expect.poll(async () => {
        const rows = await prisma.$queryRaw<Array<{ n: bigint }>>`SELECT count(*) AS n FROM pg_stat_activity WHERE datname = current_database() AND wait_event_type = 'Lock' AND query LIKE '%Workspace%FOR UPDATE%'`;
        return Number(rows[0].n);
      }, { timeout: 2000 }).toBeGreaterThan(0);
    } finally { gate.release(); }
    const result = await pending;
    await revocation;
    if (typeof result === "string") await expect(exchange(result)).rejects.toMatchObject({ status: 400 });
    else {
      expect(await resolve(result.access_token)).toBeNull();
      await expect(refresh(result.refresh_token)).rejects.toMatchObject({ status: 401 });
    }
    expect((await tokens()).every(token => token.revokedAt !== null)).toBe(true);
  });

  it("consumes a code and rotates a refresh token only once under concurrency", async () => {
    const code = await issue();
    const results = await Promise.allSettled([exchange(code), exchange(code)]);
    expect(results.filter(result => result.status === "fulfilled")).toHaveLength(1);
    const token = results.find(result => result.status === "fulfilled")!;
    if (token.status !== "fulfilled") throw new Error("Expected a token");
    const rotations = await Promise.allSettled([refresh(token.value.refresh_token), refresh(token.value.refresh_token)]);
    expect(rotations.filter(result => result.status === "fulfilled")).toHaveLength(1);
  });

  if (kind === "mcp") it("refresh cannot clear an explicit concurrent token revocation", async () => {
    const old = await exchange(await issue());
    const gate = pause(tokenModel, "updateMany");
    const pending = refresh(old.refresh_token);
    await gate.entered;
    const revocation = fresh(() => revokeMcpToken({ token: old.access_token, clientId }));
    try {
      await expect.poll(async () => {
        const rows = await prisma.$queryRaw<Array<{ n: bigint }>>`SELECT count(*) AS n FROM pg_stat_activity WHERE datname = current_database() AND wait_event_type = 'Lock' AND query LIKE '%Workspace%FOR UPDATE%'`;
        return Number(rows[0].n);
      }, { timeout: 2000 }).toBeGreaterThan(0);
    }
    finally { gate.release(); }
    const rotated = await pending;
    await revocation;
    expect(await resolve(rotated.access_token)).toBeNull();
    await expect(refresh(rotated.refresh_token)).rejects.toMatchObject({ status: 401 });
    expect(await resolve(old.access_token)).toBeNull();
    expect((await tokens())[0].revokedAt).not.toBeNull();
  });
});
