import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { mkdir } from "node:fs/promises";
import { PrismaClient } from "@prisma/client";
import { chromium } from "playwright";

const origin = process.env.SUPPORT_SMOKE_ORIGIN ?? "http://localhost:3195";
const database = new URL(process.env.DATABASE_URL ?? "");
assert.ok(["127.0.0.1", "localhost"].includes(new URL(origin).hostname), "Local smoke only");
assert.equal(database.hostname, "127.0.0.1", "Local fixture database only");
assert.equal(database.pathname, "/workspace_admin_support", "Dedicated workspace_admin_support database required");
assert.equal(database.port, "55495", "Dedicated fixture port required");
const prisma = new PrismaClient();
const browser = await chromium.launch({ headless: true });
const ids = { workspace: randomUUID(), owner: randomUUID(), support: randomUUID(), full: randomUUID(), ordinary: randomUUID() };
const tokens = { owner: randomUUID(), support: randomUUID(), ordinary: randomUUID() };
await mkdir(".artifacts/support-access", { recursive: true });
try {
  for (const role of ["owner", "support", "full", "ordinary"]) {
    await prisma.user.create({ data: { id: ids[role], email: `${role}-${ids[role]}@example.test`, passwordHash: "local-fixture", displayName: `Fixture ${role}`, isSupportAccount: role === "support" } });
  }
  await prisma.workspace.create({ data: { id: ids.workspace, name: "Support Access Fixture", slug: `support-ui-${ids.workspace}`, supportOwnerUserId: ids.owner } });
  await prisma.member.create({ data: { workspaceId: ids.workspace, userId: ids.owner, role: "ADMIN", kind: "HUMAN" } });
  await prisma.userWorkspaceOnboardingState.create({ data: { userId: ids.owner, workspaceId: ids.workspace, tourKey: "self_serve_workspace", tourVersion: "v2", completedAt: new Date() } });
  await prisma.workspaceSupportGrant.create({ data: { workspaceId: ids.workspace, userId: ids.support, grantedByUserId: ids.owner } });
  await prisma.brainSource.create({ data: { workspaceId: ids.workspace, sourceType: "DOC", tier: 1, title: "content-canary", content: "content-canary" } });
  const connection = await prisma.oAuthConnection.create({ data: { workspaceId: ids.workspace, userId: ids.owner, provider: "GOOGLE", providerAccountId: "account-canary", accessToken: "token-canary", scopes: ["https://www.googleapis.com/auth/calendar.readonly"], syncSettings: { calendar: { enabled: true, includeAllEvents: false }, documents: { enabled: false, selectedDriveIds: ["selection-canary"] } } } });
  for (const role of ["owner", "support", "ordinary"]) {
    await prisma.session.create({ data: { userId: ids[role], tokenHash: createHash("sha256").update(tokens[role]).digest("hex"), expiresAt: new Date(Date.now() + 3_600_000) } });
  }
  const contexts = {};
  for (const role of ["owner", "support", "ordinary"]) {
    contexts[role] = await browser.newContext({ viewport: { width: 1440, height: 1000 } });
    await contexts[role].route("**/*", (route) => new URL(route.request().url()).origin === origin ? route.continue() : route.abort());
    await contexts[role].addCookies([{ name: "corgtex_session", value: tokens[role], domain: new URL(origin).hostname, path: "/", httpOnly: true, sameSite: "Lax", secure: false }]);
  }
  const supportPage = await contexts.support.newPage();
  const ownerPage = await contexts.owner.newPage();
  const setupResponse = await contexts.support.request.get(`${origin}/api/workspaces/${ids.workspace}/support-setup`);
  assert.equal(setupResponse.status(), 200, `Setup API returned ${setupResponse.status()}`);
  const setupBody = await setupResponse.json();
  assert.equal(typeof setupBody.setupRevision, "number", "Dev server must use the current generated Prisma client");
  await supportPage.goto(`${origin}/support/${ids.workspace}`, { waitUntil: "networkidle", timeout: 120_000 });
  assert.match(await supportPage.locator("main").innerText(), /Setup Admin/);
  async function saveConfiguration(form, buttonName) {
    const request = supportPage.waitForResponse(response => response.request().method() === "PATCH" && response.url().endsWith("/support-configuration"));
    await form.getByRole("button", { name: buttonName, exact: true }).click();
    const response = await request;
    assert.equal(response.status(), 200, await response.text());
    await supportPage.waitForLoadState("networkidle");
    return response.json();
  }
  async function approveAccess(requestId) {
    await ownerPage.goto(`${origin}/workspaces/${ids.workspace}/settings/support`, { waitUntil: "networkidle", timeout: 120_000 });
    await ownerPage.getByRole("listitem", { name: `access request ${requestId}`, exact: true }).evaluate(element => element.scrollIntoView({ block: "center" }));
    await ownerPage.screenshot({ path: ".artifacts/support-access/owner-request-desktop.png" });
    await ownerPage.setViewportSize({ width: 390, height: 844 });
    await ownerPage.getByRole("listitem", { name: `access request ${requestId}`, exact: true }).evaluate(element => element.scrollIntoView({ block: "center" }));
    await ownerPage.screenshot({ path: ".artifacts/support-access/owner-request-mobile.png" });
    assert.equal(await ownerPage.evaluate(() => document.documentElement.scrollWidth > innerWidth), false);
    const response = ownerPage.waitForResponse(response => response.request().method() === "POST" && response.url().endsWith("/support-access/requests"));
    await ownerPage.getByRole("listitem", { name: `access request ${requestId}`, exact: true }).getByRole("button", { name: "Approve access", exact: true }).click();
    assert.equal((await response).status(), 200);
    await ownerPage.getByRole("status").filter({ hasText: "Access approved by owner." }).waitFor();
    await ownerPage.setViewportSize({ width: 1440, height: 1000 });
    await supportPage.reload({ waitUntil: "networkidle" });
  }
  const workspaceForm = supportPage.getByRole("form", { name: "workspace", exact: true });
  await workspaceForm.getByLabel("Workspace name", { exact: true }).fill("Configured Support Fixture");
  await saveConfiguration(workspaceForm, "Save workspace");
  assert.equal((await prisma.workspace.findUniqueOrThrow({ where: { id: ids.workspace } })).name, "Configured Support Fixture");
  const budgetForm = supportPage.getByRole("form", { name: "budget", exact: true });
  await budgetForm.locator('[name="monthlyCostCapUsd"]').fill("75");
  await saveConfiguration(budgetForm, "Save budget");
  assert.equal(Number((await prisma.modelUsageBudget.findUniqueOrThrow({ where: { workspaceId: ids.workspace } })).monthlyCostCapUsd), 75);
  const addForm = supportPage.getByRole("form", { name: "add member", exact: true });
  await addForm.getByLabel("Member email").fill(`ordinary-${ids.ordinary}@example.test`);
  const addRequest = await saveConfiguration(addForm, "Add member");
  assert.equal(addRequest.approvalRequired, true);
  await addForm.getByRole("status").filter({ hasText: "Requested owner approval" }).waitFor();
  assert.equal(await prisma.member.count({ where: { workspaceId: ids.workspace, userId: ids.ordinary } }), 0);
  assert.equal((await contexts.ordinary.request.get(`${origin}/api/workspaces/${ids.workspace}/brain/search?q=canary`)).status(), 403);
  assert.equal((await contexts.support.request.post(`${origin}/api/workspaces/${ids.workspace}/support-access/requests`, { data: { requestId: addRequest.requestId, approve: true } })).status(), 403);
  await approveAccess(addRequest.requestId);
  const memberForm = supportPage.getByRole("form", { name: `member ordinary-${ids.ordinary}@example.test`, exact: true });
  await memberForm.waitFor();
  await memberForm.locator('select[name="role"]').selectOption("ADMIN");
  const promotion = await saveConfiguration(memberForm, `Save member ordinary-${ids.ordinary}@example.test`);
  assert.equal(promotion.approvalRequired, true);
  assert.equal((await prisma.member.findUniqueOrThrow({ where: { workspaceId_userId: { workspaceId: ids.workspace, userId: ids.ordinary } } })).role, "CONTRIBUTOR");
  await approveAccess(promotion.requestId);
  assert.equal((await prisma.member.findUniqueOrThrow({ where: { workspaceId_userId: { workspaceId: ids.workspace, userId: ids.ordinary } } })).role, "ADMIN");
  const connectionForm = supportPage.getByRole("form", { name: "connection 1", exact: true });
  await connectionForm.getByLabel("Connection status").selectOption("PAUSED");
  await saveConfiguration(connectionForm, "Save connection 1");
  assert.equal((await prisma.oAuthConnection.findUniqueOrThrow({ where: { id: connection.id } })).status, "PAUSED");
  const configResponse = await contexts.support.request.get(`${origin}/api/workspaces/${ids.workspace}/support-configuration`);
  assert.equal(configResponse.status(), 200);
  assert.ok(!(await configResponse.text()).includes("canary"));
  assert.ok(!(await supportPage.locator("main").innerText()).includes("canary"));
  await supportPage.screenshot({ path: ".artifacts/support-access/configuration-desktop.png", fullPage: true });
  await supportPage.setViewportSize({ width: 390, height: 844 });
  await supportPage.screenshot({ path: ".artifacts/support-access/configuration-mobile.png", fullPage: true });
  assert.equal(await supportPage.evaluate(() => document.documentElement.scrollWidth > innerWidth), false);
  await supportPage.setViewportSize({ width: 1440, height: 1000 });
  await supportPage.getByText("Optional handoff checklist", { exact: true }).click();
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
  await ownerPage.goto(`${origin}/workspaces/${ids.workspace}/settings/support`, { waitUntil: "networkidle", timeout: 120_000 });
  await ownerPage.getByRole("heading", { name: "Support Access", exact: true }).waitFor();
  assert.equal(await ownerPage.locator('a[href*="preparationId="]').count(), 0);
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
  const supportRow = ownerPage.getByRole("list", { name: "Support grants", exact: true }).locator("li").filter({ hasText: `support-${ids.support}@example.test` });
  await supportRow.getByRole("button", { name: "Revoke", exact: true }).click();
  await supportRow.getByText("Revoked", { exact: true }).waitFor();
  const revoked = await contexts.support.request.get(`${origin}/api/workspaces/${ids.workspace}/support-setup`);
  assert.equal(revoked.status(), 403);
  await ownerPage.setViewportSize({ width: 390, height: 844 });
  await ownerPage.screenshot({ path: ".artifacts/support-access/owner-mobile.png", fullPage: true });
  assert.equal(await ownerPage.evaluate(() => document.documentElement.scrollWidth > innerWidth), false);
  console.log("Support UI PASS: owner-approved membership/promotion, alternate content and self-approval denied before consent; actual workspace/budget/integration persistence, scrubbed DTO, desktop/mobile, owner grant/revoke and SSR denial.");
} finally {
  await browser.close();
  await prisma.event.deleteMany({ where: { workspaceId: ids.workspace } });
  await prisma.workspace.deleteMany({ where: { id: ids.workspace } });
  await prisma.user.deleteMany({ where: { id: { in: [ids.owner, ids.support, ids.full, ids.ordinary] } } });
  await prisma.$disconnect();
}
