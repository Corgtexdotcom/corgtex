import { createHash, randomUUID } from "node:crypto";
import { NextRequest } from "next/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { prisma, runWithSupportOrigin, runWithMcpOrigin, getMcpOrigin } from "@corgtex/shared";
import type { AppActor, McpOrigin } from "@corgtex/shared";
import { issueMcpAuthorizationCode, exchangeMcpAuthorizationCode, refreshMcpAccessToken, resolveMcpOAuthAccessToken,
  revokeMcpWorkspaceConnection, listMcpWorkspaceConnections } from "./mcp-connector";
import { getWorkspaceMcpResource, getWorkspaceMcpInstallUrl } from "./mcp-resource";
import { withMcpConnectionExecution } from "./mcp-execution";
import { changeWorkspaceSupportGrant, lockWorkspaceMembership } from "./workspace-support-access";
import { requireWorkspaceMembership } from "./auth";
import { issueAgentCredential, rotateAgentCredential, resolveAgentActorFromBearer, revokeAgentCredential } from "./agent-auth";

const redirectUri = "https://synthetic-client.example/callback";
const verifier = "synthetic-pkce-verifier-".repeat(3);
const codeChallenge = createHash("sha256").update(verifier).digest("base64url");
const fresh = <T>(run: () => Promise<T>) => runWithMcpOrigin(undefined, () => runWithSupportOrigin(undefined, run));

describe("workspace MCP connection contract on real PostgreSQL", () => {
  let a: string, b: string, clientId: string, clientDbId: string;
  let actor: Extract<AppActor, { kind: "user" }>, owner: Extract<AppActor, { kind: "user" }>;
  const issue = (workspaceId = a, resource = getWorkspaceMcpResource(workspaceId)) => fresh(() => issueMcpAuthorizationCode(actor,
    { clientId, workspaceId, redirectUri, codeChallenge, codeChallengeMethod: "S256", resource, scopes: ["workspace:read"] }));
  const exchange = (code: string, workspaceId = a, resource: string | undefined = getWorkspaceMcpResource(workspaceId)) => fresh(() => exchangeMcpAuthorizationCode(
    { clientId, code, redirectUri, codeVerifier: verifier, resource }));
  const connect = async (workspaceId = a) => exchange(await issue(workspaceId), workspaceId);
  const resolve = (token: string, workspaceId = a) => fresh(() => resolveMcpOAuthAccessToken(token, getWorkspaceMcpResource(workspaceId)));
  const origin = async (token: string, workspaceId = a): Promise<McpOrigin> => {
    const session = await resolve(token, workspaceId);
    if (!session) throw new Error("Expected connection");
    return { kind: "oauth", id: session.connectionId, workspaceId };
  };
  const disconnect = (id: string, workspaceId = a) => fresh(() => revokeMcpWorkspaceConnection(actor, workspaceId, id));
  const change = (version: number, active: boolean, role: "FULL" | "SETUP" = "FULL") => fresh(async () => {
    if (version === 0) await prisma.member.delete({ where: { workspaceId_userId: { workspaceId: b, userId: actor.user.id } } });
    return changeWorkspaceSupportGrant(owner, { workspaceId: b, email: actor.user.email, role, isActive: active, expectedVersion: version });
  });

  beforeEach(async () => fresh(async () => {
    vi.stubEnv("MCP_WORKSPACE_CONNECTIONS_ENABLED", "true");
    const suffix = randomUUID();
    const user = await prisma.user.create({ data: { email: `mcp-user-${suffix}@example.test`, passwordHash: "synthetic" } });
    const admin = await prisma.user.create({ data: { email: `mcp-owner-${suffix}@example.test`, passwordHash: "synthetic" } });
    actor = { kind: "user", user }; owner = { kind: "user", user: admin };
    a = (await prisma.workspace.create({ data: { name: "Synthetic Workspace A", slug: `mcp-a-${suffix}` } })).id;
    b = (await prisma.workspace.create({ data: { name: "Synthetic Workspace B", slug: `mcp-b-${suffix}`, supportOwnerUserId: admin.id } })).id;
    await prisma.member.createMany({ data: [{ workspaceId: a, userId: user.id, role: "ADMIN" },
      { workspaceId: b, userId: user.id, role: "ADMIN" }, { workspaceId: b, userId: admin.id, role: "ADMIN" }] });
    clientId = `synthetic-client-${suffix}`;
    clientDbId = (await prisma.mcpOAuthClient.create({ data: { clientId, name: "Synthetic shared MCP client", redirectUris: [redirectUri], scopes: ["workspace:read"] } })).id;
  }));
  afterEach(async () => fresh(async () => {
    await prisma.workspace.deleteMany({ where: { id: { in: [a, b] } } });
    await prisma.mcpOAuthClient.deleteMany({ where: { id: clientDbId } });
    await prisma.user.deleteMany({ where: { id: { in: [actor.user.id, owner.user.id] } } });
    vi.unstubAllEnvs();
  }));

  it("isolates the same software client/user in two workspaces through refresh and independent disconnect", async () => {
    const [ta, tb] = await Promise.all([connect(a), connect(b)]);
    const oa = await origin(ta.access_token), ob = await origin(tb.access_token, b);
    expect(oa.id).not.toBe(ob.id);
    expect(await resolve(ta.access_token, b)).toBeNull(); expect(await resolve(tb.access_token, a)).toBeNull();
    await expect(fresh(() => refreshMcpAccessToken({ clientId, refreshToken: ta.refresh_token, resource: getWorkspaceMcpResource(b) }))).rejects.toMatchObject({ code: "INVALID_MCP_RESOURCE" });
    await expect(fresh(() => refreshMcpAccessToken({ clientId, refreshToken: ta.refresh_token, scopes: ["brain:read"] }))).rejects.toMatchObject({ status: 400 });
    await disconnect(oa.id);
    expect(await resolve(ta.access_token)).toBeNull();
    const rotated = await fresh(() => refreshMcpAccessToken({ clientId, refreshToken: tb.refresh_token, resource: getWorkspaceMcpResource(b) }));
    expect(await resolve(rotated.access_token, b)).not.toBeNull();
    expect(await fresh(() => listMcpWorkspaceConnections(actor, a))).toEqual([expect.objectContaining({ id: oa.id, status: "revoked" })]);
  });
  it("defaults canonical activation off across issuance, exchange, refresh, HTTP and workers without breaking legacy", async () => {
    const canonical = await connect(), pending = await issue(), oa = await origin(canonical.access_token);
    const root = new URL(getWorkspaceMcpResource(a)).origin;
    const legacy = await exchange(await issue(b, `${root}/mcp`), b, `${root}/mcp`);
    const route = await import("../../../apps/web/app/mcp/workspaces/[workspaceId]/route");
    const metadata = await import("../../../apps/web/app/.well-known/oauth-protected-resource/mcp/workspaces/[workspaceId]/route");
    vi.stubEnv("MCP_WORKSPACE_CONNECTIONS_ENABLED", undefined);
    expect(getWorkspaceMcpInstallUrl(a)).toBe(`${root}/mcp`);
    await expect(issue()).rejects.toMatchObject({ status: 503, code: "MCP_WORKSPACE_CONNECTIONS_DISABLED" });
    await expect(exchange(pending)).rejects.toMatchObject({ status: 503 });
    await expect(fresh(() => refreshMcpAccessToken({ clientId, refreshToken: canonical.refresh_token }))).rejects.toMatchObject({ status: 503 });
    expect(await resolve(canonical.access_token)).toBeNull();
    const handler = vi.fn(async () => true);
    await expect(fresh(() => withMcpConnectionExecution({ workspaceId: a, mcpOrigin: oa }, handler))).rejects.toMatchObject({ status: 503 });
    expect(handler).not.toHaveBeenCalled();
    const context = { params: Promise.resolve({ workspaceId: a }) };
    for (const method of ["GET", "POST", "DELETE"] as const) {
      const response = await route[method](new NextRequest(getWorkspaceMcpResource(a), { method,
        headers: { authorization: `Bearer ${canonical.access_token}` } }), context);
      expect(response.status).toBe(503);
    }
    expect((await metadata.GET(new NextRequest(getWorkspaceMcpResource(a)), context)).status).toBe(503);
    expect((await fresh(() => listMcpWorkspaceConnections(actor, a)))[0].status).toBe("paused");
    expect(await fresh(() => resolveMcpOAuthAccessToken(legacy.access_token, `${root}/mcp`))).not.toBeNull();
    await expect(fresh(() => refreshMcpAccessToken({ clientId, refreshToken: legacy.refresh_token }))).resolves.toHaveProperty("access_token");
    await expect(exchange(await issue(b, `${root}/mcp`), b, `${root}/mcp`)).resolves.toHaveProperty("access_token");
    vi.stubEnv("MCP_WORKSPACE_CONNECTIONS_ENABLED", "true");
    expect(await resolve(canonical.access_token)).not.toBeNull();
    await expect(exchange(pending)).resolves.toHaveProperty("access_token");
  });
  it("does not permit an explicit foreign connection id and preserves endpoint identity across rename", async () => {
    const ta = await connect(); const oa = await origin(ta.access_token);
    await expect(disconnect(oa.id, b)).rejects.toMatchObject({ status: 404 });
    const url = getWorkspaceMcpResource(a);
    await prisma.workspace.update({ where: { id: a }, data: { name: "Renamed synthetic workspace" } });
    expect(getWorkspaceMcpResource(a)).toBe(url); expect(await resolve(ta.access_token)).not.toBeNull();
  });
  it("enforces the canonical HTTP boundary through the actual SDK, discovery, tools and resources", async () => {
    const route = await import("../../../apps/web/app/mcp/workspaces/[workspaceId]/route");
    const metadata = await import("../../../apps/web/app/.well-known/oauth-protected-resource/mcp/workspaces/[workspaceId]/route");
    const ta = await connect(), tb = await connect(b);
    const call = (token: string, workspaceId: string, method: string, params: unknown, extraHeaders = {}) => fresh(() => route.POST(
      new NextRequest(getWorkspaceMcpResource(workspaceId), { method: "POST", headers: { authorization: `Bearer ${token}`,
        "Content-Type": "application/json", Accept: "application/json, text/event-stream", ...extraHeaders },
        body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }) }), { params: Promise.resolve({ workspaceId }) }));
    const init = await call(ta.access_token, a, "initialize", { protocolVersion: "2025-11-25", capabilities: {}, clientInfo: { name: "Synthetic", version: "1" } });
    expect(init.status).toBe(200);
    expect((await init.json()).result.serverInfo.name).toBe(`corgtex-${a}`);
    const info = await call(ta.access_token, a, "tools/call", { name: "get_workspace_info", arguments: {} });
    expect(info.status).toBe(200);
    expect(JSON.parse((await info.json()).result.content[0].text).id).toBe(a);
    expect((await call(ta.access_token, b, "tools/list", {})).status).toBe(401);
    expect((await call(tb.access_token, a, "resources/list", {})).status).toBe(401);
    expect((await call(ta.access_token, a, "tools/call", { name: "get_workspace_info", arguments: { workspaceId: b } })).status).toBe(403);
    expect((await call(ta.access_token, a, "tools/list", {}, { "x-workspace-id": b })).status).toBe(403);
    const foreignResource = await call(ta.access_token, a, "resources/read", { uri: `corgtex://workspaces/${b}/constitution` });
    expect((await foreignResource.json()).error).toBeDefined();
    const challenge = await route.GET(new NextRequest(getWorkspaceMcpResource(a)), { params: Promise.resolve({ workspaceId: a }) });
    expect(challenge.status).toBe(401);
    expect(challenge.headers.get("www-authenticate")).toContain(`/.well-known/oauth-protected-resource/mcp/workspaces/${a}`);
    const discovery = await metadata.GET(new NextRequest(getWorkspaceMcpResource(a)), { params: Promise.resolve({ workspaceId: a }) });
    expect((await discovery.json()).resource).toBe(getWorkspaceMcpResource(a));
    await disconnect((await origin(ta.access_token)).id);
    expect((await call(ta.access_token, a, "tools/list", {})).status).toBe(401);
    expect((await call(tb.access_token, b, "tools/list", {})).status).toBe(200);
  });
  it("binds id-only delegated updates and upserts to the connection workspace", async () => {
    const connection = await connect(), oa = await origin(connection.access_token);
    const foreign = await prisma.workflowJob.create({ data: { workspaceId: b, type: "synthetic.foreign", payload: {} } });
    await expect(fresh(() => withMcpConnectionExecution({ workspaceId: a, mcpOrigin: oa }, () => prisma.workflowJob.update({
      where: { id: foreign.id }, data: { payload: { changed: true } },
    })))).rejects.toThrow();
    await expect(fresh(() => withMcpConnectionExecution({ workspaceId: a, mcpOrigin: oa }, () => prisma.workflowJob.upsert({
      where: { id: foreign.id }, create: { id: foreign.id, workspaceId: a, type: "synthetic.foreign", payload: {} }, update: { payload: { changed: true } },
    })))).rejects.toThrow();
    const result = await fresh(() => withMcpConnectionExecution({ workspaceId: a, mcpOrigin: oa }, () => prisma.workflowJob.updateMany({
      where: { id: foreign.id }, data: { payload: { changed: true } },
    })));
    expect(result.count).toBe(0);
    expect((await prisma.workflowJob.findUniqueOrThrow({ where: { id: foreign.id } })).payload).toEqual({});
  });
  it("rejects forged consent resource, missing exchange resource, wrong PKCE and replay", async () => {
    await expect(issue(a, getWorkspaceMcpResource(b))).rejects.toMatchObject({ code: "INVALID_MCP_RESOURCE" });
    const code = await issue();
    await expect(fresh(() => exchangeMcpAuthorizationCode({ code, clientId, redirectUri, codeVerifier: verifier }))).rejects.toMatchObject({ code: "INVALID_MCP_RESOURCE" });
    await expect(fresh(() => exchangeMcpAuthorizationCode({ code, clientId, redirectUri, codeVerifier: "wrong", resource: getWorkspaceMcpResource(a) }))).rejects.toMatchObject({ status: 400 });
    const exchanged = await Promise.allSettled([exchange(code), exchange(code)]);
    expect(exchanged.filter(result => result.status === "fulfilled")).toHaveLength(1);
    const token = exchanged.find(result => result.status === "fulfilled")!;
    if (token.status !== "fulfilled") throw new Error("No token");
    const refreshed = await Promise.allSettled([1, 2].map(() => fresh(() => refreshMcpAccessToken({ clientId, refreshToken: token.value.refresh_token }))));
    expect(refreshed.filter(result => result.status === "fulfilled")).toHaveLength(1);
  });
  it("revokes pending codes and never reuses a revoked connection identity on fresh consent", async () => {
    const first = await connect(), oa = await origin(first.access_token), pending = await issue();
    await disconnect(oa.id);
    await expect(exchange(pending)).rejects.toMatchObject({ status: 400 });
    const next = await connect(); expect((await origin(next.access_token)).id).not.toBe(oa.id);
    await expect(withMcpConnectionExecution({ workspaceId: a, mcpOrigin: oa }, async () => true)).rejects.toThrow("MCP_AUTHORIZATION_REVOKED");
  });
  it("preserves legacy global/null tokens only at the legacy endpoint and requires new canonical consent", async () => {
    const root = new URL(getWorkspaceMcpResource(a)).origin;
    const legacy = await exchange(await issue(a, `${root}/mcp`), a, `${root}/mcp`);
    expect(await fresh(() => resolveMcpOAuthAccessToken(legacy.access_token, `${root}/api/mcp`))).not.toBeNull();
    expect(await resolve(legacy.access_token)).toBeNull();
    await prisma.mcpOAuthAccessToken.updateMany({ where: { workspaceId: a }, data: { resource: null } });
    expect(await resolve(legacy.access_token)).toBeNull();
    expect(await fresh(() => resolveMcpOAuthAccessToken(legacy.access_token, `${root}/mcp`))).not.toBeNull();
    const next = await connect(); expect(await resolve(next.access_token)).not.toBeNull();
  });
  it("stores Full epochs, denies Setup, and rejects revoked/regranted codes/tokens without changing ordinary A", async () => {
    const ta = await connect(); await change(0, true);
    const tb = await connect(b), code = await issue(b);
    expect((await resolve(tb.access_token, b))?.supportGrantVersion).toBe(1);
    await change(1, false); await change(2, true);
    await expect(exchange(code, b)).rejects.toMatchObject({ status: 400, code: "INVALID_INPUT" });
    expect(await resolve(tb.access_token, b)).toBeNull();
    await change(3, true, "SETUP");
    await expect(issue(b)).rejects.toMatchObject({ status: 403 });
    expect(await resolve(ta.access_token)).not.toBeNull();
  });
  it("stamps and checks delegated events/jobs without attaching independent system work", async () => {
    const ta = await connect(), oa = await origin(ta.access_token);
    const event = await fresh(() => withMcpConnectionExecution({ workspaceId: a, mcpOrigin: oa }, () => prisma.event.create({ data: { workspaceId: a, type: "synthetic.mcp", payload: {} } })));
    expect(event.mcpOrigin).toEqual(oa);
    const job = await fresh(() => withMcpConnectionExecution(event, () => prisma.workflowJob.create({ data: { workspaceId: a, type: "synthetic.mcp", payload: {} } })));
    expect(job.mcpOrigin).toEqual(oa);
    await disconnect(oa.id);
    let ran = false;
    await expect(fresh(() => withMcpConnectionExecution(job, async () => { ran = true; }))).rejects.toThrow("MCP_AUTHORIZATION_REVOKED");
    expect(ran).toBe(false);
    const system = await fresh(() => prisma.workflowJob.create({ data: { workspaceId: a, type: "synthetic.system", payload: {} } }));
    await expect(fresh(() => withMcpConnectionExecution(system, async () => getMcpOrigin()))).resolves.toBeUndefined();
  });
  it("blocks foreign delegated writes and active request responses after disconnect", async () => {
    const ta = await connect(), oa = await origin(ta.access_token);
    await expect(fresh(() => withMcpConnectionExecution({ workspaceId: a, mcpOrigin: oa }, () => prisma.event.create({ data: { workspaceId: b, type: "synthetic.forbidden", payload: {} } })))).rejects.toThrow("MCP_AUTHORIZATION_REVOKED");
    await expect(fresh(() => withMcpConnectionExecution({ workspaceId: a, mcpOrigin: oa }, async () => {
      await disconnect(oa.id); return "content must not escape";
    }))).rejects.toThrow("MCP_AUTHORIZATION_REVOKED");
  });
  it("uses the workspace row lock for disconnect vs refresh and never revives a revoked connection", async () => {
    const ta = await connect(), oa = await origin(ta.access_token);
    let release!: () => void, entered!: () => void;
    const wait = new Promise<void>(done => { release = done; }), locked = new Promise<void>(done => { entered = done; });
    const hold = prisma.$transaction(async tx => { await lockWorkspaceMembership(tx, a); entered(); await wait; }, { timeout: 10000 });
    await locked;
    const revoke = disconnect(oa.id);
    const refreshed = Promise.allSettled([fresh(() => refreshMcpAccessToken({ clientId, refreshToken: ta.refresh_token }))]);
    try { await expect.poll(async () => {
      const rows = await prisma.$queryRaw<Array<{ n: bigint }>>`SELECT count(*) AS n FROM pg_stat_activity WHERE datname = current_database() AND wait_event_type = 'Lock' AND query LIKE '%Workspace%FOR UPDATE%'`;
      return Number(rows[0].n);
    }).toBeGreaterThanOrEqual(2); } finally { release(); }
    await hold; await revoke;
    const result = await refreshed;
    if (result[0].status === "fulfilled") expect(await resolve(result[0].value.access_token)).toBeNull();
    expect((await prisma.mcpOAuthAccessToken.findUniqueOrThrow({ where: { id: oa.id } })).revokedAt).not.toBeNull();
  });
  it("binds agent delegated work to the issued credential, not a later rotation/regrant", async () => {
    const issued = await fresh(() => issueAgentCredential(actor, { workspaceId: a, label: "Synthetic MCP agent", scopes: ["workspace:read"] }));
    const { authenticateMcpRequest } = await import("../../mcp/src/auth");
    const canonicalSession = await fresh(() => authenticateMcpRequest(`Bearer ${issued.token}`, { workspaceId: a, resourceUrl: getWorkspaceMcpResource(a) }));
    expect(canonicalSession.mcpOrigin).toMatchObject({ kind: "agent", workspaceId: a, canonical: true });
    vi.stubEnv("MCP_WORKSPACE_CONNECTIONS_ENABLED", "false");
    await expect(fresh(() => authenticateMcpRequest(`Bearer ${issued.token}`, { workspaceId: a, resourceUrl: getWorkspaceMcpResource(a) }))).rejects.toMatchObject({ status: 503 });
    await expect(fresh(() => withMcpConnectionExecution({ workspaceId: a, mcpOrigin: canonicalSession.mcpOrigin }, async () => true))).rejects.toMatchObject({ status: 503 });
    await expect(fresh(() => authenticateMcpRequest(`Bearer ${issued.token}`))).resolves.toMatchObject({ workspaceId: a });
    vi.stubEnv("MCP_WORKSPACE_CONNECTIONS_ENABLED", "true");
    const agent = await fresh(() => resolveAgentActorFromBearer(issued.token));
    if (agent?.kind !== "agent") throw new Error("Expected agent");
    const mcpOrigin: McpOrigin = { kind: "agent", id: agent.credentialId!, workspaceId: a, credentialVersion: agent.credentialVersion };
    await expect(fresh(() => withMcpConnectionExecution({ workspaceId: a, mcpOrigin }, async () => true))).resolves.toBe(true);
    await fresh(() => revokeAgentCredential(actor, { workspaceId: a, credentialId: agent.credentialId! }));
    await fresh(() => rotateAgentCredential(actor, { workspaceId: a, credentialId: agent.credentialId! }));
    await expect(fresh(() => withMcpConnectionExecution({ workspaceId: a, mcpOrigin }, async () => true))).rejects.toThrow("MCP_AUTHORIZATION_REVOKED");
  });
  it("retains captured support authorization across a regrant before code persistence", async () => {
    await change(0, true);
    await expect(fresh(async () => {
      await requireWorkspaceMembership({ actor, workspaceId: b });
      await change(1, false); await change(2, true);
      return issueMcpAuthorizationCode(actor, { clientId, workspaceId: b, redirectUri, codeChallenge, codeChallengeMethod: "S256", resource: getWorkspaceMcpResource(b) });
    })).rejects.toMatchObject({ code: "SUPPORT_AUTHORIZATION_REVOKED" });
  });
});
