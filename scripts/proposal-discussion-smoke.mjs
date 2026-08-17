#!/usr/bin/env node

import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { pathToFileURL } from "node:url";
import { chromium } from "playwright";

function arg(name) {
  const prefix = `--${name}=`;
  return process.argv.find((entry) => entry.startsWith(prefix))?.slice(prefix.length);
}

function trimTrailingSlash(value) {
  return String(value || "").replace(/\/$/, "");
}

const runId = arg("run-id") || `proposal-discussion-${Date.now()}`;
const baseUrl = trimTrailingSlash(arg("base-url") || process.env.PROPOSAL_DISCUSSION_BASE_URL || process.env.CLIENT_READINESS_BASE_URL || "http://localhost:3000");
const outDir = path.resolve(arg("out-dir") || process.env.PROPOSAL_DISCUSSION_OUT_DIR || `.artifacts/proposal-discussion/${runId}`);
const email = process.env.AGENT_E2E_EMAIL || "e2e-validation@corgtex.local";
const password = process.env.AGENT_E2E_PASSWORD || "corgtex-test-agent-pw";
const headless = process.env.PROPOSAL_DISCUSSION_HEADFUL !== "true";

const result = {
  runId,
  status: "RUNNING",
  baseUrl,
  startedAt: new Date().toISOString(),
  completedAt: null,
  proposalId: null,
  proposalUrl: null,
  steps: [],
  artifacts: [],
  error: null,
};

function pass(name, detail = {}) {
  result.steps.push({ name, status: "PASSED", ...detail });
  console.log(`OK   ${name}`);
}

async function screenshot(page, name) {
  const filePath = path.join(outDir, `${String(result.steps.length + 1).padStart(2, "0")}-${name}.png`);
  await page.screenshot({ path: filePath, fullPage: true, caret: "initial" }).catch(() => null);
  result.artifacts.push({ type: "screenshot", label: name, path: filePath });
}

async function writeResult(status) {
  result.status = status;
  result.completedAt = new Date().toISOString();
  await mkdir(outDir, { recursive: true });
  await writeFile(path.join(outDir, "proposal-discussion-smoke.json"), `${JSON.stringify(result, null, 2)}\n`);
}

async function resolveLoginPath() {
  const explicitPath = arg("login-path") || process.env.PROPOSAL_DISCUSSION_LOGIN_PATH;
  if (explicitPath) return explicitPath.startsWith("/") ? explicitPath : `/${explicitPath}`;

  try {
    const response = await fetch(`${baseUrl}/api/health`, {
      headers: { "user-agent": "corgtex-proposal-discussion-smoke/1.0" },
    });
    const payload = await response.json();
    return typeof payload?.loginPath === "string" ? payload.loginPath : "/login";
  } catch {
    return "/login";
  }
}

function workspaceIdFromUrl(value) {
  const match = value.match(/\/workspaces\/([^/?#]+)/);
  if (!match) throw new Error(`Could not determine workspace id from ${value}`);
  return decodeURIComponent(match[1]);
}

async function waitForWorkspace(page) {
  const deadline = Date.now() + 60_000;
  while (Date.now() < deadline) {
    if (/\/workspaces\//.test(page.url())) return workspaceIdFromUrl(page.url());
    const visibleError = await page.locator('[role="alert"], .form-message-error').first().textContent().catch(() => null);
    if (visibleError?.trim()) throw new Error(`Login failed: ${visibleError.trim()}`);
    await page.waitForTimeout(250);
  }
  throw new Error(`Login did not reach a workspace. Current URL: ${page.url()}`);
}

async function requestJsonInPage(page, pathName, options = {}) {
  return page.evaluate(async ({ pathName: requestPath, options: requestOptions }) => {
    const response = await fetch(requestPath, {
      ...requestOptions,
      headers: {
        "content-type": "application/json",
        ...(requestOptions.headers ?? {}),
      },
    });
    const text = await response.text();
    let body = {};
    try {
      body = text ? JSON.parse(text) : {};
    } catch {
      body = { raw: text };
    }
    if (!response.ok) {
      throw new Error(`${requestPath} failed with ${response.status}: ${JSON.stringify(body)}`);
    }
    return body;
  }, { pathName, options });
}

async function createSmokeProposal(page, workspaceId) {
  const title = `[SMOKE] Proposal mutation reliability ${runId}`;
  const response = await requestJsonInPage(page, `/api/workspaces/${encodeURIComponent(workspaceId)}/proposals`, {
    method: "POST",
    body: JSON.stringify({
      title,
      summary: "Smoke proposal for API-backed discussion mutations.",
      bodyMd: "This proposal is created by the focused proposal discussion smoke.",
      isPrivate: false,
      priorityLabel: "Low",
    }),
  });
  const proposal = response.proposal ?? response;
  if (!proposal?.id) throw new Error(`Proposal creation did not return an id: ${JSON.stringify(response)}`);
  return { id: proposal.id, title };
}

async function waitForApiResponse(page, workspaceId, method, suffix = "") {
  const response = await page.waitForResponse((candidate) => {
    const url = candidate.url();
    return url.includes(`/api/workspaces/${encodeURIComponent(workspaceId)}/deliberation-entries${suffix}`)
      && candidate.request().method() === method;
  }, { timeout: 20_000 });

  if (!response.ok()) {
    throw new Error(`Discussion ${method} failed with ${response.status()}: ${await response.text().catch(() => "")}`);
  }
}

async function assertNoServerActionError(page) {
  const text = await page.locator("body").innerText();
  if (/Server Action.*was not found|failed-to-find-server-action/i.test(text)) {
    throw new Error("Page rendered a missing Server Action error.");
  }
}

async function dismissWorkspaceSetupDialog(page) {
  const dialog = page.getByRole("dialog", { name: /set up your workspace/i });
  if (!await dialog.isVisible({ timeout: 1500 }).catch(() => false)) return;

  await dialog.getByRole("button", { name: /close/i }).click();
  await dialog.waitFor({ state: "hidden", timeout: 5000 });
}

async function discussionSurface(page) {
  const surface = page.locator("section.work-conversation").filter({
    has: page.getByRole("heading", { name: "Discussion" }),
  }).last();
  await surface.getByRole("button", { name: "Post reply" }).waitFor({ timeout: 15_000 });
  await surface.locator('form.delib-composer-form[data-api-ready="true"]').last().waitFor({ timeout: 15_000 });
  return surface;
}

async function postReaction(page, surface, workspaceId, text) {
  const form = surface.locator('form.delib-composer-form[data-api-ready="true"]').last();
  await form.locator('textarea[name="bodyMd"]').fill(text);
  await Promise.all([
    waitForApiResponse(page, workspaceId, "POST"),
    form.getByRole("button", { name: "Post reply" }).click(),
  ]);
  await page.locator("article.delib-entry").filter({ hasText: text }).waitFor({ timeout: 15_000 });
  await assertNoServerActionError(page);
}

async function editEntry(page, workspaceId, oldText, newText) {
  const entry = page.locator("article.delib-entry").filter({ hasText: oldText }).last();
  await entry.getByRole("button", { name: "Edit" }).click();
  const form = entry.locator('form.delib-inline-form[data-api-ready="true"]');
  await form.waitFor({ timeout: 15_000 });
  await form.locator('textarea[name="bodyMd"]').fill(newText);
  await Promise.all([
    waitForApiResponse(page, workspaceId, "PATCH", "/"),
    form.getByRole("button", { name: "Save" }).click(),
  ]);
  await page.locator("article.delib-entry").filter({ hasText: newText }).waitFor({ timeout: 15_000 });
  if (await page.locator("article.delib-entry").filter({ hasText: oldText }).count()) {
    throw new Error(`Old entry text still visible after edit: ${oldText}`);
  }
  await assertNoServerActionError(page);
}

async function attachReference(page, workspaceId) {
  const referenceUrl = `https://example.com/corgtex/proposal-discussion-smoke/${encodeURIComponent(runId)}`;
  const form = page.locator('form.nr-form-section[data-api-ready="true"]');
  await form.waitFor({ timeout: 15_000 });
  await form.locator('input[name="url"]').fill(referenceUrl);
  await form.locator('textarea[name="descriptionMd"]').fill("Focused proposal discussion smoke reference.");
  const [response] = await Promise.all([
    page.waitForResponse((candidate) => (
      candidate.url().includes(`/api/workspaces/${encodeURIComponent(workspaceId)}/external-resources`)
        && candidate.request().method() === "POST"
    ), { timeout: 20_000 }),
    form.getByRole("button", { name: "Save reference" }).click(),
  ]);
  if (!response.ok()) {
    throw new Error(`Reference attach failed with ${response.status()}: ${await response.text().catch(() => "")}`);
  }
  await page.locator(`a[href="${referenceUrl}"]`).first().waitFor({ timeout: 15_000 });
  await assertNoServerActionError(page);
  return referenceUrl;
}

async function main() {
  await mkdir(outDir, { recursive: true });
  const browser = await chromium.launch({ headless });
  const page = await browser.newPage({ viewport: { width: 1440, height: 950 } });
  page.setDefaultNavigationTimeout(90_000);

  try {
    await page.goto(`${baseUrl}${await resolveLoginPath()}`, { waitUntil: "domcontentloaded" });
    await page.fill('input[name="email"]', email);
    await page.fill('input[name="password"]', password);
    await page.click('button[type="submit"]', { noWaitAfter: true });
    const workspaceId = await waitForWorkspace(page);
    pass("login", { workspaceId });

    await requestJsonInPage(page, `/api/workspaces/${encodeURIComponent(workspaceId)}/onboarding`, {
      method: "POST",
      body: JSON.stringify({}),
    });
    pass("complete onboarding for smoke workspace");

    const proposal = await createSmokeProposal(page, workspaceId);
    result.proposalId = proposal.id;
    result.proposalUrl = `${baseUrl}/workspaces/${workspaceId}/proposals/${proposal.id}`;
    pass("create open proposal", { proposalId: proposal.id });

    await page.goto(result.proposalUrl, { waitUntil: "domcontentloaded" });
    await page.getByRole("heading", { name: proposal.title }).waitFor({ timeout: 15_000 });
    await screenshot(page, "proposal-opened");
    await assertNoServerActionError(page);
    await dismissWorkspaceSetupDialog(page);

    const surface = await discussionSurface(page);
    const firstReaction = `First smoke reaction ${runId}`;
    const secondReaction = `Second smoke reaction ${runId}`;
    const secondEditOne = `Second smoke reaction edited once ${runId}`;
    const secondEditTwo = `Second smoke reaction edited twice ${runId}`;

    await postReaction(page, surface, workspaceId, firstReaction);
    await postReaction(page, surface, workspaceId, secondReaction);
    pass("add two reactions");

    await editEntry(page, workspaceId, secondReaction, secondEditOne);
    await editEntry(page, workspaceId, secondEditOne, secondEditTwo);
    await page.locator("article.delib-entry").filter({ hasText: firstReaction }).waitFor({ timeout: 5_000 });
    pass("edit second reaction twice without changing first reaction");

    const referenceUrl = await attachReference(page, workspaceId);
    pass("attach reference link", { referenceUrl });
    await screenshot(page, "proposal-discussion-complete");
    await writeResult("PASSED");
  } catch (error) {
    result.error = {
      message: error instanceof Error ? error.message : String(error),
      stack: error instanceof Error ? error.stack : null,
    };
    await screenshot(page, "failure");
    await writeResult("FAILED");
    throw error;
  } finally {
    await browser.close().catch(() => null);
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    console.error(error);
    process.exitCode = 1;
  });
}
