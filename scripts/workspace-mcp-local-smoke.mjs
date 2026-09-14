import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { mkdir } from "node:fs/promises";
import { PrismaClient } from "@prisma/client";
import { chromium } from "playwright";

const origin = process.env.MCP_SMOKE_ORIGIN ?? "http://localhost:3184";
const database = new URL(process.env.DATABASE_URL ?? "");
assert.ok(["localhost", "127.0.0.1"].includes(new URL(origin).hostname));
assert.equal(database.hostname, "127.0.0.1");
assert.equal(database.pathname, "/mcp_test", "Dedicated synthetic database only");
const prisma = new PrismaClient();
const browser = await chromium.launch({ headless: true });
const suffix = randomUUID();
const ids = [`mcp-ui-A-${suffix}`, `mcp-ui-B-${suffix}`];
const session = randomUUID();
const verifier = `local-pkce-${suffix}`;
const challenge = createHash("sha256").update(verifier).digest("base64url");
let user;
let clientDbId;
await mkdir(".artifacts/workspace-mcp", { recursive: true });
try {
  user = await prisma.user.create({ data: { email: `mcp-ui-${suffix}@example.test`, passwordHash: "synthetic-only", displayName: "MCP Fixture" } });
  for (const [index, id] of ids.entries()) {
    await prisma.workspace.create({ data: { id, slug: id.toLowerCase(), name: `MCP Fixture ${index ? "Beta" : "Alpha"}` } });
    await prisma.member.create({ data: { workspaceId: id, userId: user.id, role: "ADMIN", kind: "HUMAN" } });
    await prisma.userWorkspaceOnboardingState.create({ data: { userId: user.id, workspaceId: id, tourKey: "self_serve_workspace", tourVersion: "v2", completedAt: new Date() } });
  }
  await prisma.session.create({ data: { userId: user.id, tokenHash: createHash("sha256").update(session).digest("hex"), expiresAt: new Date(Date.now() + 3600000) } });
  const context = await browser.newContext({ viewport: { width: 1440, height: 1000 } });
  await context.route("**/*", (route) => new URL(route.request().url()).origin === origin ? route.continue() : route.abort());
  await context.addCookies([{ name: "corgtex_session", value: session, domain: new URL(origin).hostname, path: "/", httpOnly: true, sameSite: "Lax" }]);
  const registration = await context.request.post(`${origin}/api/oauth/register`, { data: { client_name: "Shared MCP fixture", redirect_uris: [`${origin}/fixture-callback`], scope: "workspace:read governance:read" }, timeout: 120000 });
  assert.equal(registration.status(), 201);
  const client = await registration.json();
  clientDbId = client.client.id;
  const tokens = [];
  const page = await context.newPage();
  for (const id of ids) {
    const resource = `${origin}/mcp/workspaces/${id}`;
    const metadataUrl = `${origin}/.well-known/oauth-protected-resource/mcp/workspaces/${id}`;
    const metadata = await context.request.get(metadataUrl, { timeout: 120000 });
    assert.equal(metadata.status(), 200);
    assert.equal((await metadata.json()).resource, resource);
    const denied = await context.request.get(resource, { timeout: 120000 });
    assert.equal(denied.status(), 401);
    assert.ok(denied.headers()["www-authenticate"].includes(metadataUrl));
    const query = new URLSearchParams({ client_id: client.client_id, redirect_uri: `${origin}/fixture-callback`, response_type: "code", state: "local-state", code_challenge: challenge, code_challenge_method: "S256", resource });
    const consentRedirect = await context.request.get(`${origin}/api/oauth/authorize?${query}`, {
      headers: { "x-forwarded-host": "forged.example", "x-forwarded-proto": "https" }, maxRedirects: 0,
    });
    assert.equal(consentRedirect.status(), 307);
    assert.equal(new URL(consentRedirect.headers().location).origin, origin);
    await page.goto(`${origin}/oauth/authorize?${query}`, { waitUntil: "networkidle", timeout: 120000 });
    assert.equal(await page.locator('input[name="workspaceId"]').inputValue(), id);
    assert.equal(await page.locator('input[name="resource"]').inputValue(), resource);
    assert.equal(await page.locator('select[name="workspaceId"]').count(), 0);
    const authorization = await context.request.post(`${origin}/api/oauth/authorize`, { data: { clientId: client.client_id, redirectUri: `${origin}/fixture-callback`, workspaceId: id, codeChallenge: challenge, codeChallengeMethod: "S256", resource }, timeout: 120000 });
    assert.equal(authorization.status(), 200);
    const code = new URL((await authorization.json()).redirectUrl).searchParams.get("code");
    const response = await context.request.post(`${origin}/api/oauth/token`, { form: { grant_type: "authorization_code", client_id: client.client_id, redirect_uri: `${origin}/fixture-callback`, code, code_verifier: verifier, resource }, timeout: 120000 });
    assert.equal(response.status(), 200);
    tokens.push(await response.json());
  }
  const rpc = (index, token, method, params = {}) => context.request.post(`${origin}/mcp/workspaces/${ids[index]}`, { headers: { authorization: `Bearer ${token}` }, data: { jsonrpc: "2.0", id: 1, method, params }, timeout: 120000 });
  for (const [index, token] of tokens.entries()) {
    const initialized = await rpc(index, token.access_token, "initialize", { protocolVersion: "2025-03-26", capabilities: {}, clientInfo: { name: "fixture", version: "1" } });
    assert.equal(initialized.status(), 200);
    const info = await initialized.json();
    assert.equal(info.result.serverInfo.name, `corgtex-workspace-${ids[index]}`);
    const result = await rpc(index, token.access_token, "tools/call", { name: "get_workspace_info", arguments: {} });
    assert.equal(result.status(), 200);
    assert.ok((await result.text()).includes(ids[index]));
    const resource = await rpc(index, token.access_token, "resources/read", { uri: "corgtex://workspace/constitution" });
    assert.equal(resource.status(), 200);
    assert.ok(!(await resource.json()).error);
  }
  assert.equal((await rpc(1, tokens[0].access_token, "tools/list")).status(), 401);
  assert.equal((await rpc(0, tokens[0].access_token, "tools/call", { name: "get_workspace_info", arguments: { workspaceId: ids[1] } })).status(), 403);
  await page.goto(`${origin}/workspaces/${ids[0]}/settings?tab=ai-workspaces`, { waitUntil: "networkidle", timeout: 120000 });
  assert.equal(await page.getByRole("link", { name: "Support access", exact: true }).count(), 0, "Legacy null owner must not advertise owner-only settings");
  const panel = page.getByRole("region", { name: "Workspace MCP connections" });
  await panel.getByText("Shared MCP fixture", { exact: true }).waitFor();
  await panel.scrollIntoViewIfNeeded();
  await panel.screenshot({ path: ".artifacts/workspace-mcp/connections-desktop.png" });
  await page.setViewportSize({ width: 390, height: 844 });
  await panel.screenshot({ path: ".artifacts/workspace-mcp/connections-mobile.png" });
  assert.equal(await panel.evaluate((element) => element.scrollWidth <= element.clientWidth + 1), true, "Connection panel overflows on mobile");
  const revoked = page.waitForResponse((response) => response.request().method() === "DELETE" && response.url().endsWith("/oauth-connections"));
  await panel.getByRole("button", { name: "Revoke", exact: true }).click();
  assert.equal((await revoked).status(), 204);
  await panel.getByText("No connections yet.").waitFor();
  assert.equal((await rpc(0, tokens[0].access_token, "tools/list")).status(), 401);
  assert.equal((await rpc(1, tokens[1].access_token, "tools/list")).status(), 200);
  await page.goto(`${origin}/workspaces/${ids[0]}/settings/support`, { waitUntil: "networkidle", timeout: 120000 });
  await page.getByText("Support access is available only to the verified workspace owner.", { exact: false }).waitFor();
  await page.screenshot({ path: ".artifacts/workspace-mcp/support-unavailable-mobile.png" });
  await prisma.workspace.update({ where: { id: ids[0] }, data: { supportOwnerUserId: user.id } });
  await page.goto(`${origin}/workspaces/${ids[0]}/settings`, { waitUntil: "networkidle", timeout: 120000 });
  await page.getByRole("link", { name: "Support access", exact: true }).waitFor();
  await page.getByRole("link", { name: "Support access", exact: true }).click();
  await page.getByRole("heading", { name: "Support Access", exact: true }).waitFor();
  await page.screenshot({ path: ".artifacts/workspace-mcp/support-owner-mobile.png" });
  for (const method of ["GET", "POST"]) {
    const retired = await context.request.fetch(`${origin}/support/sessions/synthetic-retired`, { method });
    assert.equal(retired.status(), 410);
    assert.ok(!retired.headers()["set-cookie"]);
    assert.ok(!(await retired.text()).includes("<form"));
  }
  console.log("PASS: scoped discovery/challenge, fixed consent, shared registration A/B, tools/resources, forged workspace denial, independent UI revoke, desktop/mobile rendering. External AI clients not exercised.");
} finally {
  await browser.close();
  await prisma.mcpOAuthAuthorizationCode.deleteMany({ where: { workspaceId: { in: ids } } });
  await prisma.mcpOAuthAccessToken.deleteMany({ where: { workspaceId: { in: ids } } });
  await prisma.workflowJob.deleteMany({ where: { workspaceId: { in: ids } } });
  await prisma.event.deleteMany({ where: { workspaceId: { in: ids } } });
  await prisma.workspace.deleteMany({ where: { id: { in: ids } } });
  if (user) await prisma.user.delete({ where: { id: user.id } });
  if (clientDbId) await prisma.mcpOAuthClient.delete({ where: { id: clientDbId } });
  await prisma.$disconnect();
}
