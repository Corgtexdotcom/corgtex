import { randomUUID } from "node:crypto";
import { afterEach, describe, expect, it } from "vitest";
import { assertMcpOriginActive, mcpScopesHash, parseMcpOrigin, prisma, runWithMcpOrigin, sha256, type McpOrigin } from "@corgtex/shared";
import { listMcpConnectorInstances, resolveMcpOAuthAccessToken } from "./mcp-connector";

type Fixture = Awaited<ReturnType<typeof fixture>>;
let current: Fixture | null = null;

function gate() {
  let open!: () => void;
  const promise = new Promise<void>(resolve => { open = resolve; });
  return { promise, open };
}

async function waitForDatabaseLock(pid: number) {
  const deadline = Date.now() + 3_000;
  do {
    const rows = await prisma.$queryRaw<Array<{ wait_event_type: string | null }>>`
      SELECT wait_event_type FROM pg_stat_activity WHERE pid = ${pid}`;
    if (rows[0]?.wait_event_type === "Lock") return;
    await new Promise(resolve => setTimeout(resolve, 20));
  } while (Date.now() < deadline);
  throw new Error("The synthetic revocation did not wait for the grant epoch lock.");
}

async function fixture() {
  const suffix = randomUUID();
  const user = await prisma.user.create({ data: { email: `mcp-epoch-${suffix}@example.test`, passwordHash: "synthetic" } });
  const workspace = await prisma.workspace.create({ data: { name: "Synthetic MCP epoch", slug: `mcp-epoch-${suffix}` } });
  const otherWorkspace = await prisma.workspace.create({ data: { name: "Synthetic second MCP epoch", slug: `mcp-epoch-b-${suffix}` } });
  await prisma.member.createMany({ data: [workspace.id, otherWorkspace.id].map(workspaceId => ({ workspaceId, userId: user.id, role: "ADMIN" })) });
  const client = await prisma.mcpOAuthClient.create({ data: {
    clientId: `synthetic-mcp-client-${suffix}`, name: "Synthetic MCP client",
    redirectUris: ["https://synthetic.example.test/callback"], scopes: ["workspace:read", "brain:read"],
  } });
  const createToken = async (workspaceId = workspace.id, id: string = randomUUID()) => {
    const bearer = `mcp_at_${randomUUID()}`;
    const token = await prisma.mcpOAuthAccessToken.create({ data: {
      id, clientId: client.id, userId: user.id, workspaceId,
      instanceSlug: listMcpConnectorInstances()[0]!.slug, tokenHash: sha256(bearer),
      scopes: ["workspace:read", "brain:read"], expiresAt: new Date(Date.now() + 60_000),
      refreshExpiresAt: new Date(Date.now() + 60 * 60_000),
    } });
    return { token, bearer };
  };
  const issued = await createToken();
  const resolve = async (bearer = issued.bearer): Promise<McpOrigin> => {
    const session = await resolveMcpOAuthAccessToken(bearer);
    expect(session).not.toBeNull();
    return { kind: "oauth", id: session!.connectionId, workspaceId: session!.workspaceId,
      scopeHash: mcpScopesHash(session!.scopes), grantEpoch: session!.grantEpoch,
      requiredScopes: ["workspace:read"] };
  };
  return { user, workspace, otherWorkspace, client, issued, createToken, resolve };
}

afterEach(async () => {
  const f = current;
  current = null;
  if (!f) return;
  await prisma.workspace.deleteMany({ where: { id: { in: [f.workspace.id, f.otherWorkspace.id] } } });
  await prisma.mcpOAuthClient.delete({ where: { id: f.client.id } });
  await prisma.user.delete({ where: { id: f.user.id } });
});

describe("ephemeral MCP OAuth grant epoch on real PostgreSQL", () => {
  it("rejects legacy queued origins and revoke-restore while preserving same-consent refresh", async () => {
    const f = current = await fixture();
    const origin = await f.resolve();
    expect(() => parseMcpOrigin({ ...origin, grantEpoch: undefined })).toThrow("MCP_AUTHORIZATION_REVOKED");
    await prisma.mcpOAuthAccessToken.update({ where: { id: origin.id }, data: {
      tokenHash: sha256(`mcp_at_refreshed_${randomUUID()}`), refreshHash: sha256(`mcp_rt_${randomUUID()}`),
      expiresAt: new Date(Date.now() + 60_000), refreshExpiresAt: new Date(Date.now() + 60 * 60_000),
    } });
    await expect(assertMcpOriginActive(prisma, origin, f.workspace.id)).resolves.toBeUndefined();
    await prisma.mcpOAuthAccessToken.update({ where: { id: origin.id }, data: { revokedAt: new Date() } });
    await prisma.mcpOAuthAccessToken.update({ where: { id: origin.id }, data: { revokedAt: null } });
    await expect(assertMcpOriginActive(prisma, origin, f.workspace.id)).rejects.toThrow("MCP_AUTHORIZATION_REVOKED");
  });

  it("fans global client liveness transitions into each token workspace", async () => {
    const f = current = await fixture();
    const other = await f.createToken(f.otherWorkspace.id);
    const firstOrigin = await f.resolve();
    const secondSession = await resolveMcpOAuthAccessToken(other.bearer);
    expect(secondSession).not.toBeNull();
    const secondOrigin: McpOrigin = { kind: "oauth", id: secondSession!.connectionId,
      workspaceId: f.otherWorkspace.id, scopeHash: mcpScopesHash(secondSession!.scopes), grantEpoch: secondSession!.grantEpoch };
    await prisma.mcpOAuthClient.update({ where: { id: f.client.id }, data: { isActive: false } });
    await prisma.mcpOAuthClient.update({ where: { id: f.client.id }, data: { isActive: true } });
    await expect(assertMcpOriginActive(prisma, firstOrigin, f.workspace.id)).rejects.toThrow("MCP_AUTHORIZATION_REVOKED");
    await expect(assertMcpOriginActive(prisma, secondOrigin, f.otherWorkspace.id)).rejects.toThrow("MCP_AUTHORIZATION_REVOKED");
  });

  it("keeps a deleted token tombstone stale after recreation with the same ID", async () => {
    const f = current = await fixture();
    const origin = await f.resolve();
    await prisma.mcpOAuthAccessToken.delete({ where: { id: origin.id } });
    await f.createToken(f.workspace.id, origin.id);
    await expect(assertMcpOriginActive(prisma, origin, f.workspace.id)).rejects.toThrow("MCP_AUTHORIZATION_REVOKED");
  });

  it("serializes a publication fence before revocation and rejects revocation committed first", async () => {
    const f = current = await fixture();
    const origin = await f.resolve();
    const locked = gate(), release = gate(), pidReady = gate();
    let revokerPid = 0;
    const publication = prisma.$transaction(async tx => {
      await assertMcpOriginActive(tx, origin, f.workspace.id);
      locked.open();
      await release.promise;
    });
    await locked.promise;
    const revocation = prisma.$transaction(async tx => {
      const pid = await tx.$queryRaw<Array<{ pid: number }>>`SELECT pg_backend_pid() AS pid`;
      revokerPid = pid[0]!.pid; pidReady.open();
      await tx.mcpOAuthAccessToken.update({ where: { id: origin.id }, data: { revokedAt: new Date() } });
    });
    await pidReady.promise;
    try { await waitForDatabaseLock(revokerPid); }
    finally { release.open(); }
    await publication;
    await revocation;
    await expect(assertMcpOriginActive(prisma, origin, f.workspace.id)).rejects.toThrow("MCP_AUTHORIZATION_REVOKED");
    await expect(prisma.$transaction(tx => assertMcpOriginActive(tx, origin, f.workspace.id)))
      .rejects.toThrow("MCP_AUTHORIZATION_REVOKED");
  });

  it("allows a guarded write under the publisher's epoch fence while a revoker waits", async () => {
    const f = current = await fixture();
    const origin = await f.resolve();
    const locked = gate(), mutate = gate(), finished = gate(), pidReady = gate();
    let revokerPid = 0, publisherPid = 0;
    const publication = prisma.$transaction(async tx => {
      await assertMcpOriginActive(tx, origin, f.workspace.id);
      publisherPid = (await tx.$queryRaw<Array<{ pid: number }>>`SELECT pg_backend_pid() AS pid`)[0]!.pid;
      locked.open();
      await mutate.promise;
      await runWithMcpOrigin(origin, () => tx.workspace.update({ where: { id: f.workspace.id }, data: { name: "Published synthetic MCP work" } }));
      finished.open();
    }, { timeout: 10_000 });
    await locked.promise;
    const revocation = prisma.$transaction(async tx => {
      await tx.$executeRawUnsafe("SET LOCAL lock_timeout = '2500ms'");
      const pid = await tx.$queryRaw<Array<{ pid: number }>>`SELECT pg_backend_pid() AS pid`;
      revokerPid = pid[0]!.pid; pidReady.open();
      await tx.mcpOAuthAccessToken.update({ where: { id: origin.id }, data: { revokedAt: new Date() } });
    }, { timeout: 10_000 });
    await pidReady.promise;
    try {
      await waitForDatabaseLock(revokerPid);
      const blocked = await prisma.$queryRaw<Array<{ blockers: number[] }>>`
        SELECT pg_blocking_pids(${revokerPid}::int) AS blockers FROM pg_stat_activity WHERE pid = ${revokerPid}`;
      expect(blocked[0]!.blockers).toContain(publisherPid);
      mutate.open();
      const completedBeforeRevoker = await Promise.race([
        finished.promise.then(() => true),
        new Promise<false>(resolve => setTimeout(() => resolve(false), 700)),
      ]);
      expect(completedBeforeRevoker).toBe(true);
      await publication;
      await revocation;
      await expect(runWithMcpOrigin(origin, () => prisma.workspace.update({ where: { id: f.workspace.id },
        data: { name: "Unauthorized stale synthetic work" } }))).rejects.toThrow("MCP_AUTHORIZATION_REVOKED");
      await expect(prisma.$transaction(tx => runWithMcpOrigin(origin, () => tx.workspace.update({ where: { id: f.workspace.id },
        data: { name: "Unauthorized stale transactional work" } })))).rejects.toThrow("MCP_AUTHORIZATION_REVOKED");
    } finally {
      mutate.open();
      await Promise.allSettled([publication, revocation]);
    }
  });
});
