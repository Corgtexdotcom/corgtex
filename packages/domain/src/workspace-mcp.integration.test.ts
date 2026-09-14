import { createHash, randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { beginAuthorizationContext, prisma, runWithMcpExecutionOrigin, runWithSupportOrigin, sha256 } from "@corgtex/shared";
import type { AppActor } from "@corgtex/shared";
import { exchangeMcpAuthorizationCode, getWorkspaceMcpPublicUrl, issueMcpAuthorizationCode, refreshMcpAccessToken, registerMcpOAuthClient, resolveMcpOAuthAccessToken } from "./mcp-connector";
import { listWorkspaceMcpConnections, revokeWorkspaceMcpConnection, withMcpConnectionExecution } from "./mcp-connections";
import { changeWorkspaceSupportGrant } from "./workspace-support-access";

describe("workspace-specific MCP grants", () => {
  const suffix = randomUUID();
  const a = `mcp-A-${suffix}`;
  const b = `mcp-B-${suffix}`;
  const verifier = "synthetic-pkce-verifier-" + suffix;
  const challenge = createHash("sha256").update(verifier).digest("base64url");
  let actor: Extract<AppActor, { kind: "user" }>;
  let clientId: string;
  let clientDbId: string;
  let support: Extract<AppActor, { kind: "user" }>;
  const redirectUri = "https://client.example.test/callback";

  beforeAll(async () => {
    vi.stubEnv("APP_URL", "https://mcp.example.test");
    vi.stubEnv("MCP_PUBLIC_URL", "https://mcp.example.test/mcp");
    vi.stubEnv("MCP_INSTANCE_REGISTRY", "");
    vi.stubEnv("WORKSPACE_SLUG", "");
    beginAuthorizationContext();
    actor = { kind: "user", user: await prisma.user.create({ data: { email: `mcp-${suffix}@example.test`, passwordHash: "synthetic-only" } }) };
    support = { kind: "user", user: await prisma.user.create({ data: { email: `mcp-support-${suffix}@example.test`, passwordHash: "synthetic-only" } }) };
    for (const id of [a, b]) {
      await prisma.workspace.create({ data: { id, slug: id.toLowerCase(), name: `Fixture ${id === a ? "A" : "B"}`, supportOwnerUserId: actor.user.id } });
      await prisma.member.create({ data: { workspaceId: id, userId: actor.user.id, role: "ADMIN", kind: "HUMAN" } });
    }
    const registration = await registerMcpOAuthClient({ name: "Shared software fixture", redirectUris: [redirectUri], scopes: ["workspace:read", "brain:read"] });
    clientId = registration.client_id;
    clientDbId = registration.client.id;
  });

  afterAll(async () => {
    beginAuthorizationContext();
    await runWithSupportOrigin(undefined, async () => {
      await prisma.mcpOAuthAuthorizationCode.deleteMany({ where: { workspaceId: { in: [a, b] } } });
      await prisma.mcpOAuthAccessToken.deleteMany({ where: { workspaceId: { in: [a, b] } } });
      await prisma.workflowJob.deleteMany({ where: { workspaceId: { in: [a, b] } } });
      await prisma.event.deleteMany({ where: { workspaceId: { in: [a, b] } } });
      await prisma.workspace.deleteMany({ where: { id: { in: [a, b] } } });
      if (actor && support) await prisma.user.deleteMany({ where: { id: { in: [actor.user.id, support.user.id] } } });
      if (clientDbId) await prisma.mcpOAuthClient.delete({ where: { id: clientDbId } });
    });
    vi.unstubAllEnvs();
  });

  async function issue(workspaceId: string, user = actor, resource = getWorkspaceMcpPublicUrl(workspaceId)) {
    beginAuthorizationContext();
    return issueMcpAuthorizationCode(user, { clientId, workspaceId, redirectUri, codeChallenge: challenge, codeChallengeMethod: "S256", resource });
  }
  const exchange = (code: string, workspaceId: string) => exchangeMcpAuthorizationCode({ code, clientId, redirectUri, codeVerifier: verifier, resource: getWorkspaceMcpPublicUrl(workspaceId) });
  const connect = async (workspaceId: string, user = actor) => exchange(await issue(workspaceId, user), workspaceId);

  it("keeps A/B connections distinct for one software client, survives rename, and revokes independently", async () => {
    const ta = await connect(a);
    const tb = await connect(b);
    const sa = await resolveMcpOAuthAccessToken(ta.access_token, getWorkspaceMcpPublicUrl(a));
    expect(sa?.workspaceId).toBe(a);
    expect(await resolveMcpOAuthAccessToken(ta.access_token, getWorkspaceMcpPublicUrl(b))).toBeNull();
    await prisma.workspace.update({ where: { id: a }, data: { name: "Renamed fixture" } });
    expect(await listWorkspaceMcpConnections(actor, a)).toMatchObject({ resource: getWorkspaceMcpPublicUrl(a), label: `Corgtex - Renamed fixture - ${a}` });
    const secondA = await connect(a);
    expect(await resolveMcpOAuthAccessToken(ta.access_token, getWorkspaceMcpPublicUrl(a))).not.toBeNull();
    await revokeWorkspaceMcpConnection(actor, a, sa!.connectionId);
    expect(await resolveMcpOAuthAccessToken(ta.access_token, getWorkspaceMcpPublicUrl(a))).toBeNull();
    await expect(refreshMcpAccessToken({ clientId, refreshToken: ta.refresh_token })).rejects.toMatchObject({ status: 401 });
    expect(await resolveMcpOAuthAccessToken(tb.access_token, getWorkspaceMcpPublicUrl(b))).not.toBeNull();
    expect(await resolveMcpOAuthAccessToken(secondA.access_token, getWorkspaceMcpPublicUrl(a))).not.toBeNull();
    await expect(revokeWorkspaceMcpConnection(actor, b, sa!.connectionId)).rejects.toMatchObject({ status: 404 });
  });

  it("rejects forged resource, cross-workspace exchange, omitted audience, and replay", async () => {
    await expect(issue(a, actor, getWorkspaceMcpPublicUrl(b))).rejects.toMatchObject({ code: "MCP_REAUTHORIZATION_REQUIRED" });
    for (const resource of ["", "https://mcp.example.test/mcp", `${getWorkspaceMcpPublicUrl(a)}?workspaceId=${b}`, `https://evil.test/mcp/workspaces/${a}`]) {
      await expect(issue(a, actor, resource)).rejects.toMatchObject({ status: 400 });
    }
    const code = await issue(a);
    await expect(exchange(code, b)).rejects.toMatchObject({ status: 400 });
    await expect(exchangeMcpAuthorizationCode({ code, clientId, redirectUri, codeVerifier: verifier })).rejects.toMatchObject({ status: 400 });
    const results = await Promise.allSettled([exchange(code, a), exchange(code, a)]);
    expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1);
  });

  it("binds refresh to its resource, rejects widening and atomically rotates", async () => {
    const t = await connect(a);
    await expect(refreshMcpAccessToken({ clientId, refreshToken: t.refresh_token, resource: getWorkspaceMcpPublicUrl(b) })).rejects.toMatchObject({ status: 400 });
    await expect(refreshMcpAccessToken({ clientId, refreshToken: t.refresh_token, scopes: ["members:write"] })).rejects.toMatchObject({ status: 400 });
    const results = await Promise.allSettled([1, 2].map(() => refreshMcpAccessToken({ clientId, refreshToken: t.refresh_token, resource: getWorkspaceMcpPublicUrl(a) })));
    expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1);
    expect(await resolveMcpOAuthAccessToken(t.access_token, getWorkspaceMcpPublicUrl(a))).toBeNull();
  });

  it("rejects old null/global audiences at the scoped endpoint and retains explicit legacy identity", async () => {
    const t = await connect(a);
    await prisma.mcpOAuthAccessToken.update({ where: { tokenHash: sha256(t.access_token) }, data: { resource: null } });
    expect(await resolveMcpOAuthAccessToken(t.access_token, getWorkspaceMcpPublicUrl(a))).toBeNull();
    expect((await listWorkspaceMcpConnections(actor, a)).connections.some((row) => row.requiresReauthorization)).toBe(true);
  });

  it("rechecks membership without granting access from a second workspace", async () => {
    const ta = await connect(a);
    const tb = await connect(b);
    await prisma.member.update({ where: { workspaceId_userId: { workspaceId: a, userId: actor.user.id } }, data: { isActive: false } });
    expect(await resolveMcpOAuthAccessToken(ta.access_token, getWorkspaceMcpPublicUrl(a))).toBeNull();
    await expect(refreshMcpAccessToken({ clientId, refreshToken: ta.refresh_token })).rejects.toMatchObject({ status: 403 });
    expect(await resolveMcpOAuthAccessToken(tb.access_token, getWorkspaceMcpPublicUrl(b))).not.toBeNull();
    await prisma.member.update({ where: { workspaceId_userId: { workspaceId: a, userId: actor.user.id } }, data: { isActive: true } });
  });

  it("persists connection provenance for jobs/events and rechecks revocation before delegated work", async () => {
    const t = await connect(a);
    const session = await resolveMcpOAuthAccessToken(t.access_token, getWorkspaceMcpPublicUrl(a));
    const job = await runWithMcpExecutionOrigin({ connectionId: session!.connectionId, workspaceId: a }, async () => {
      const event = await prisma.event.create({ data: { workspaceId: a, type: "fixture", payload: {} } });
      expect(event.mcpConnectionId).toBe(session!.connectionId);
      await expect(prisma.workflowJob.create({ data: { workspaceId: b, type: "fixture", payload: {} } })).rejects.toThrow("MCP_WORKSPACE_MISMATCH");
      return prisma.workflowJob.create({ data: { workspaceId: a, type: "fixture", payload: {} } });
    });
    expect(job.mcpConnectionId).toBe(session!.connectionId);
    expect(await withMcpConnectionExecution(job, async () => "allowed")).toBe("allowed");
    await revokeWorkspaceMcpConnection(actor, a, session!.connectionId);
    const run = vi.fn();
    await expect(withMcpConnectionExecution(job, run)).rejects.toMatchObject({ code: "MCP_CONNECTION_REVOKED" });
    expect(run).not.toHaveBeenCalled();
    expect(await withMcpConnectionExecution({ workspaceId: a }, async () => "system-owned")).toBe("system-owned");
  });

  it("enforces Setup denial and non-revivable Full support versions", async () => {
    beginAuthorizationContext();
    await changeWorkspaceSupportGrant(actor, { workspaceId: a, email: support.user.email, role: "SETUP", isActive: true, expectedVersion: 0 });
    await expect(issue(a, support)).rejects.toMatchObject({ status: 403 });
    beginAuthorizationContext();
    await changeWorkspaceSupportGrant(actor, { workspaceId: a, email: support.user.email, role: "FULL", isActive: true, expectedVersion: 1 });
    const code = await issue(a, support);
    const originalCode = await prisma.mcpOAuthAuthorizationCode.findUniqueOrThrow({ where: { code: sha256(code) } });
    const t = await connect(a, support);
    beginAuthorizationContext();
    await changeWorkspaceSupportGrant(actor, { workspaceId: a, email: support.user.email, role: "SETUP", isActive: true, expectedVersion: 2 });
    expect(await resolveMcpOAuthAccessToken(t.access_token, getWorkspaceMcpPublicUrl(a))).toBeNull();
    await expect(exchange(code, a)).rejects.toMatchObject({ status: 400 });
    beginAuthorizationContext();
    await changeWorkspaceSupportGrant(actor, { workspaceId: a, email: support.user.email, role: "FULL", isActive: true, expectedVersion: 3 });
    await prisma.mcpOAuthAuthorizationCode.create({ data: originalCode });
    await expect(exchange(code, a)).rejects.toMatchObject({ code: "SUPPORT_AUTHORIZATION_REVOKED" });
    expect(await connect(a, support)).toHaveProperty("access_token");
  });
});
