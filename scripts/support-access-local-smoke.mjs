import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { mkdir } from "node:fs/promises";
import { PrismaClient } from "@prisma/client";
import { chromium } from "playwright";

const origin = process.env.SUPPORT_SMOKE_ORIGIN ?? "http://localhost:3183";
const database = new URL(process.env.DATABASE_URL ?? "");
assert.ok(["127.0.0.1", "localhost"].includes(new URL(origin).hostname), "Local smoke only");
assert.equal(database.hostname, "127.0.0.1", "Local fixture database only");
assert.equal(database.pathname, "/support_test", "Dedicated support_test database required");
const prisma = new PrismaClient();
const browser = await chromium.launch({ headless: true });
const ids = { workspace: randomUUID(), owner: randomUUID(), support: randomUUID(), full: randomUUID() };
const tokens = { owner: randomUUID(), support: randomUUID() };
await mkdir(".artifacts/support-access", { recursive: true });
try {
  for (const role of ["owner", "support", "full"]) {
    await prisma.user.create({ data: { id: ids[role], email: `${role}-${ids[role]}@example.test`, passwordHash: "local-fixture", displayName: `Fixture ${role}`, isSupportAccount: role === "support" } });
  }
  await prisma.workspace.create({ data: { id: ids.workspace, name: "Support Access Fixture", slug: `support-ui-${ids.workspace}`, supportOwnerUserId: ids.owner } });
  await prisma.member.create({ data: { workspaceId: ids.workspace, userId: ids.owner, role: "ADMIN", kind: "HUMAN" } });
  await prisma.userWorkspaceOnboardingState.create({ data: { userId: ids.owner, workspaceId: ids.workspace, tourKey: "self_serve_workspace", tourVersion: "v2", completedAt: new Date() } });
  await prisma.workspaceSupportGrant.create({ data: { workspaceId: ids.workspace, userId: ids.support, grantedByUserId: ids.owner } });
  for (const role of ["owner", "support"]) {
    await prisma.session.create({ data: { userId: ids[role], tokenHash: createHash("sha256").update(tokens[role]).digest("hex"), expiresAt: new Date(Date.now() + 3_600_000) } });
  }
  const contexts = {};
  for (const role of ["owner", "support"]) {
    contexts[role] = await browser.newContext({ viewport: { width: 1440, height: 1000 } });
    await contexts[role].route("**/*", (route) => new URL(route.request().url()).origin === origin ? route.continue() : route.abort());
    await contexts[role].addCookies([{ name: "corgtex_session", value: tokens[role], domain: new URL(origin).hostname, path: "/", httpOnly: true, sameSite: "Lax", secure: false }]);
  }
  const supportPage = await contexts.support.newPage();
  const setupResponse = await contexts.support.request.get(`${origin}/api/workspaces/${ids.workspace}/support-setup`);
  assert.equal(setupResponse.status(), 200, `Setup API returned ${setupResponse.status()}`);
  const setupBody = await setupResponse.json();
  assert.equal(typeof setupBody.setupRevision, "number", "Dev server must use the current generated Prisma client");
  await supportPage.goto(`${origin}/support/${ids.workspace}`, { waitUntil: "networkidle", timeout: 120_000 });
  assert.match(await supportPage.locator("main").innerText(), /Setup Admin/);
  await supportPage.getByLabel("Configuration prepared").check();
  await supportPage.getByLabel("Google", { exact: true }).check();
  await supportPage.getByLabel("Purpose", { exact: true }).selectOption("documents");
  await supportPage.getByLabel("Slack", { exact: true }).check();
  const saveResponse = supportPage.waitForResponse((response) => response.request().method() === "PATCH" && response.url().endsWith("/support-setup"));
  await supportPage.getByRole("button", { name: "Save", exact: true }).click();
  const saved = await saveResponse;
  assert.equal(saved.status(), 200, await saved.text());
  await supportPage.getByRole("status").filter({ hasText: "Saved." }).waitFor();
  await supportPage.screenshot({ path: ".artifacts/support-access/setup-desktop.png", fullPage: true });
  await supportPage.setViewportSize({ width: 390, height: 844 });
  await supportPage.screenshot({ path: ".artifacts/support-access/setup-mobile.png", fullPage: true });
  assert.equal(await supportPage.evaluate(() => document.documentElement.scrollWidth > innerWidth), false);
  for (const path of ["brain/search?q=canary", "members", "workflow-jobs", "events", "finance/history-archive", "support-access"]) {
    const response = await contexts.support.request.get(`${origin}/api/workspaces/${ids.workspace}/${path}`);
    assert.equal(response.status(), 403, path);
  }
  await supportPage.goto(`${origin}/workspaces/${ids.workspace}/brain`, { waitUntil: "networkidle", timeout: 120_000 });
  assert.match(supportPage.url(), new RegExp(`/support/${ids.workspace}$`));
  const ownerPage = await contexts.owner.newPage();
  await ownerPage.goto(`${origin}/workspaces/${ids.workspace}/settings/support`, { waitUntil: "networkidle", timeout: 120_000 });
  await ownerPage.getByRole("heading", { name: "Support Access", exact: true }).waitFor();
  assert.equal(await ownerPage.getByRole("link", { name: "Approve configuration and continue to provider consent" }).count(), 2);
  assert.match(await ownerPage.locator("main").innerText(), /Selected Drive documents/);
  await ownerPage.screenshot({ path: ".artifacts/support-access/owner-desktop.png", fullPage: true });
  await ownerPage.setViewportSize({ width: 390, height: 844 });
  await ownerPage.screenshot({ path: ".artifacts/support-access/owner-preparation-mobile.png", fullPage: true });
  assert.equal(await ownerPage.evaluate(() => document.documentElement.scrollWidth > innerWidth), false);
  await ownerPage.setViewportSize({ width: 1440, height: 1000 });
  await ownerPage.getByLabel("Named account email").fill(`full-${ids.full}@example.test`);
  await ownerPage.getByLabel("Workspace role").selectOption("FULL");
  await ownerPage.getByRole("checkbox").check();
  await ownerPage.getByRole("button", { name: "Grant access", exact: true }).click();
  await ownerPage.getByRole("status").filter({ hasText: "Access updated." }).waitFor();
  assert.equal((await prisma.member.findUnique({ where: { workspaceId_userId: { workspaceId: ids.workspace, userId: ids.full } } })).role, "ADMIN");
  const supportRow = ownerPage.locator("li").filter({ hasText: `support-${ids.support}@example.test` });
  await supportRow.getByRole("button", { name: "Revoke", exact: true }).click();
  await supportRow.getByText("Revoked", { exact: true }).waitFor();
  const revoked = await contexts.support.request.get(`${origin}/api/workspaces/${ids.workspace}/support-setup`);
  assert.equal(revoked.status(), 403);
  await ownerPage.setViewportSize({ width: 390, height: 844 });
  await ownerPage.screenshot({ path: ".artifacts/support-access/owner-mobile.png", fullPage: true });
  assert.equal(await ownerPage.evaluate(() => document.documentElement.scrollWidth > innerWidth), false);
  console.log("Support UI: desktop/mobile, setup save, owner grant/revoke, API content denial, SSR redirect passed.");
} finally {
  await browser.close();
  await prisma.event.deleteMany({ where: { workspaceId: ids.workspace } });
  await prisma.workspace.deleteMany({ where: { id: ids.workspace } });
  await prisma.user.deleteMany({ where: { id: { in: [ids.owner, ids.support, ids.full] } } });
  await prisma.$disconnect();
}
