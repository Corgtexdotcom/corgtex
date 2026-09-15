import assert from "node:assert/strict";
import { randomUUID, scryptSync } from "node:crypto";
import { mkdir } from "node:fs/promises";
import { PrismaClient } from "@prisma/client";
import { chromium } from "playwright";

const origin = process.env.SUPPORT_SMOKE_ORIGIN ?? "http://localhost:3195";
const database = new URL(process.env.DATABASE_URL ?? "");
assert.equal(new URL(origin).hostname, "localhost");
assert.equal(database.hostname, "127.0.0.1");
assert.equal(database.port, "55495");
assert.equal(database.pathname, "/workspace_admin_support");
const prisma = new PrismaClient();
const browser = await chromium.launch({ headless: true });
const ids = [randomUUID(), randomUUID()];
const users = [];
const failures = [];
const password = "synthetic-password-only";
const salt = randomUUID();
const passwordHash = `scrypt$${salt}$${scryptSync(password, salt, 64).toString("hex")}`;
await mkdir(".artifacts/support-access", { recursive: true });
try {
  for (const kind of ["owner", "setup", "full", "ordinary", "mixed"]) {
    users.push(await prisma.user.create({ data: { email: `${kind}-${randomUUID()}@example.test`, displayName: `Synthetic ${kind}`, passwordHash } }));
  }
  const [owner, setup, full, ordinary, mixed] = users;
  for (const [index, id] of ids.entries()) {
    await prisma.workspace.create({ data: { id, slug: id, name: `Support picker ${index ? "Beta" : "Alpha"}`, supportOwnerUserId: owner.id } });
    await prisma.member.create({ data: { workspaceId: id, userId: owner.id, role: "ADMIN", kind: "HUMAN" } });
    await prisma.workspaceSupportGrant.create({ data: { workspaceId: id, userId: full.id, grantedByUserId: owner.id, role: "FULL" } });
    await prisma.member.create({ data: { workspaceId: id, userId: full.id, role: "ADMIN", kind: "HUMAN" } });
  }
  await prisma.workspaceSupportGrant.create({ data: { workspaceId: ids[0], userId: setup.id, grantedByUserId: owner.id, role: "SETUP" } });
  await prisma.workspaceSupportGrant.create({ data: { workspaceId: ids[0], userId: mixed.id, grantedByUserId: owner.id, role: "SETUP" } });
  for (const user of [ordinary, mixed]) {
    await prisma.member.create({ data: { workspaceId: ids[1], userId: user.id, role: "CONTRIBUTOR", kind: "HUMAN" } });
    await prisma.userWorkspaceOnboardingState.create({ data: { userId: user.id, workspaceId: ids[1], tourKey: "self_serve_workspace", tourVersion: "v2", completedAt: new Date() } });
  }
  for (const user of [setup, full, ordinary, mixed]) {
    const context = await browser.newContext({ viewport: { width: 390, height: 844 } });
    await context.route("**/*", (route) => new URL(route.request().url()).origin === origin ? route.continue() : route.abort());
    const page = await context.newPage();
    await page.goto(`${origin}/en/login`, { waitUntil: "networkidle", timeout: 120000 });
    await page.locator('input[name="email"]').fill(user.email);
    await page.locator('input[name="password"]').fill(password);
    await page.locator('form button[type="submit"]').click();
    await page.waitForURL((url) => !url.pathname.endsWith("/login"), { timeout: 120000 });
    if (user.id === setup.id) {
      if (!page.url().endsWith("/support")) failures.push(`Setup login destination: ${new URL(page.url()).pathname}`);
      await page.goto(origin, { waitUntil: "networkidle", timeout: 120000 });
      if (!page.url().endsWith("/support")) failures.push(`Setup root destination: ${new URL(page.url()).pathname}`);
      if (page.url().endsWith("/support")) {
        await page.getByRole("link", { name: "Support picker Alpha", exact: true }).click();
        await page.getByText("Setup Admin", { exact: true }).waitFor();
        await page.screenshot({ path: ".artifacts/support-access/setup-normal-login-mobile.png", fullPage: true });
      }
    } else if (user.id === full.id) {
      await page.goto(`${origin}/support`, { waitUntil: "networkidle", timeout: 120000 });
      for (const id of ids) {
        if (await page.locator(`a[href="/support/${id}"]`).count() !== 1) failures.push("FULL workspace missing from support directory");
      }
      await page.screenshot({ path: ".artifacts/support-access/full-directory-mobile.png", fullPage: true });
      for (const id of ids) {
        await page.goto(`${origin}/support/${id}`, { waitUntil: "networkidle", timeout: 120000 });
        assert.equal(await page.getByRole("link", { name: "Open workspace", exact: true }).getAttribute("href"), `/workspaces/${id}`);
      }
    } else {
      assert.ok(new URL(page.url()).pathname.endsWith(`/workspaces/${ids[1]}`), "Ordinary and mixed users keep their ordinary landing destination");
      await page.getByRole("button", { name: "More", exact: true }).click();
      const supportLink = page.getByRole("link", { name: "Workspace Support", exact: true });
      assert.equal(await supportLink.count(), user.id === mixed.id ? 1 : 0);
      if (user.id === mixed.id) {
        await supportLink.scrollIntoViewIfNeeded();
        await page.screenshot({ path: ".artifacts/support-access/mixed-support-navigation-mobile.png", fullPage: true });
        await supportLink.click();
        await page.getByRole("link", { name: "Support picker Alpha", exact: true }).click();
        await page.getByText("Setup Admin", { exact: true }).waitFor();
      }
      await page.goto(`${origin}/find-account`, { waitUntil: "networkidle", timeout: 120000 });
      assert.equal(await page.getByRole("link", { name: "Workspace Support", exact: true }).count(), user.id === mixed.id ? 1 : 0);
      if (user.id === mixed.id) {
        await page.setViewportSize({ width: 1440, height: 1000 });
        await page.goto(`${origin}/workspaces/${ids[1]}`, { waitUntil: "networkidle", timeout: 120000 });
        await page.getByRole("link", { name: "Workspace Support", exact: true }).waitFor();
        await page.getByRole("link", { name: "Workspace Support", exact: true }).scrollIntoViewIfNeeded();
        await page.screenshot({ path: ".artifacts/support-access/mixed-support-navigation-desktop.png", fullPage: true });
        await page.getByRole("link", { name: "Workspace Support", exact: true }).click();
        await page.getByRole("heading", { name: "Workspace Support", exact: true }).waitFor();
      }
    }
    if (user.id === full.id) {
      await prisma.user.update({ where: { id: user.id }, data: { globalRole: "OPERATOR" } });
      for (const [label, viewport] of [["desktop", { width: 1440, height: 1000 }], ["mobile", { width: 390, height: 844 }]]) {
        await page.setViewportSize(viewport);
        await page.goto(`${origin}/en/control-plane/support`, { waitUntil: "networkidle", timeout: 120000 });
        await page.getByRole("heading", { name: "Workspace Support", exact: true }).waitFor();
        for (const id of ids) assert.equal(await page.locator(`a[href="/support/${id}"]`).count(), 1);
        assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false);
        await page.screenshot({ path: `.artifacts/support-access/ops-support-${label}.png`, fullPage: true });
      }
    }
    await context.close();
  }
  assert.deepEqual(failures, []);
  console.log("PASS: synthetic password login, ordinary landing preserved, support directory navigation, exact Full workspace links, and desktop/mobile Ops entrypoint.");
} finally {
  await browser.close();
  await prisma.workflowJob.deleteMany({ where: { workspaceId: { in: ids } } });
  await prisma.event.deleteMany({ where: { workspaceId: { in: ids } } });
  await prisma.workspace.deleteMany({ where: { id: { in: ids } } });
  await prisma.user.deleteMany({ where: { id: { in: users.map((user) => user.id) } } });
  await prisma.$disconnect();
}
