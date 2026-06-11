#!/usr/bin/env node
import { randomBytes } from "node:crypto";
import path from "node:path";
import process from "node:process";
import { chromium } from "playwright";
import {
  arg,
  envFlag,
  firstAllowedSmokeEmailDomain,
  pollCapturedSetupEmail,
  recordSmokeRun,
  resetProcurementTrialRateLimits,
  trimTrailingSlash,
  writeJsonArtifact,
} from "./lib/self-serve-smoke-utils.mjs";

const startedAt = new Date();
const runId = arg("run-id") || `self-serve-${Date.now()}-${randomBytes(4).toString("hex")}`;
const baseUrl = trimTrailingSlash(arg("base-url") || process.env.SELF_SERVE_BROWSER_BASE_URL || process.env.NEXT_PUBLIC_APP_URL || process.env.APP_URL || "http://localhost:3000");
const siteUrlRaw = arg("site-url") || process.env.SELF_SERVE_BROWSER_SITE_URL || process.env.NEXT_PUBLIC_SITE_URL || "";
const siteUrl = siteUrlRaw ? trimTrailingSlash(siteUrlRaw) : null;
const secret = process.env.SMOKE_EMAIL_CAPTURE_SECRET?.trim();
const emailDomain = arg("email-domain") || process.env.SELF_SERVE_SMOKE_EMAIL_DOMAIN || firstAllowedSmokeEmailDomain();
const artifactsDir = path.resolve(arg("artifacts-dir") || `.artifacts/self-serve-smoke/${runId}`);
const password = process.env.SELF_SERVE_SMOKE_PASSWORD || `Corgtex-${runId.slice(-8)}!`;
const companyName = `Corgtex Smoke ${runId.slice(-8)}`;
const adminEmail = `smoke+${runId.replace(/[^a-z0-9-]/gi, "").toLowerCase()}@${emailDomain}`;
const headless = !envFlag("SELF_SERVE_BROWSER_HEADFUL");
const allowBillingSkip = envFlag("SELF_SERVE_BROWSER_ALLOW_BILLING_SKIP");
const completeStripeCard = envFlag("SELF_SERVE_BROWSER_COMPLETE_STRIPE_TEST_CARD");

if (!secret) {
  throw new Error("SMOKE_EMAIL_CAPTURE_SECRET is required for self-serve browser smoke.");
}
if (!emailDomain) {
  throw new Error("Configure SMOKE_EMAIL_CAPTURE_ALLOWED_DOMAINS or SELF_SERVE_SMOKE_EMAIL_DOMAIN for smoke registration.");
}

const result = {
  runId,
  runKind: "browser",
  status: "RUNNING",
  baseUrl,
  siteUrl,
  startedAt: startedAt.toISOString(),
  completedAt: null,
  email: adminEmail,
  workspaceId: null,
  steps: [],
  artifacts: [],
  warnings: [],
  error: null,
};

function pass(name, detail = {}) {
  result.steps.push({ name, status: "PASSED", ...detail });
  console.log(`OK   ${name}`);
}

function warn(name, detail = {}) {
  result.steps.push({ name, status: "SKIPPED", ...detail });
  result.warnings.push({ name, ...detail });
  console.log(`WARN ${name}`);
}

async function screenshot(page, name) {
  const filePath = path.join(artifactsDir, `${String(result.steps.length + 1).padStart(2, "0")}-${name}.png`);
  await page.screenshot({ path: filePath, fullPage: true });
  result.artifacts.push({ type: "screenshot", label: name, path: filePath });
}

async function clickFirstVisible(locator) {
  const count = await locator.count();
  for (let index = 0; index < count; index += 1) {
    const candidate = locator.nth(index);
    if (await candidate.isVisible().catch(() => false)) {
      await candidate.click();
      return true;
    }
  }
  return false;
}

function workspaceIdFromUrl(value) {
  const match = value.match(/\/workspaces\/([^/?#]+)/);
  return match ? decodeURIComponent(match[1]) : null;
}

async function record(status) {
  await recordSmokeRun({
    baseUrl,
    secret,
    run: {
      runId,
      runKind: "browser",
      status,
      workspaceId: result.workspaceId,
      baseUrl,
      siteUrl,
      summary: {
        email: adminEmail,
        companyName,
        steps: result.steps,
        warnings: result.warnings,
      },
      artifacts: result.artifacts,
      error: result.error,
      startedAt: result.startedAt,
      completedAt: result.completedAt,
    },
  }).catch((error) => {
    console.warn(`WARN unable to persist smoke run: ${error instanceof Error ? error.message : String(error)}`);
  });
}

async function driveOnboardingTour(page) {
  await page.waitForTimeout(1_500);
  const skip = page.getByRole("button", { name: /skip to tour/i }).first();
  if (await skip.isVisible().catch(() => false)) {
    await skip.click();
    await page.waitForTimeout(650);
  }
  for (let index = 0; index < 16; index += 1) {
    const next = page.locator(".driver-popover-next-btn").first();
    if (!(await next.isVisible().catch(() => false))) break;
    await next.click();
    await page.waitForTimeout(650);
  }
  const done = page.locator(".driver-popover-next-btn").first();
  if (await done.isVisible().catch(() => false)) {
    await done.click().catch(() => undefined);
  }
  await page.waitForTimeout(650);
  const later = page.getByRole("button", { name: /maybe later|mas tarde/i }).first();
  if (await later.isVisible().catch(() => false)) {
    await Promise.all([
      page.waitForResponse((response) => (
        response.url().includes("/api/workspaces/") &&
        response.url().includes("/onboarding") &&
        response.request().method() === "POST"
      ), { timeout: 15_000 }).catch(() => undefined),
      later.click(),
    ]);
    await page.waitForTimeout(650);
  }
  const setupDialog = page.getByRole("dialog", { name: /set up your workspace|add your first workspace context/i }).first();
  if (await setupDialog.isVisible().catch(() => false)) {
    throw new Error("Onboarding setup dialog still blocks the workspace after tour acknowledgement.");
  }
}

async function verifyRoleSurface(page, workspaceId) {
  const roleSetup = await page.evaluate(async (id) => {
    async function request(path, options = {}) {
      const response = await fetch(path, {
        ...options,
        headers: {
          "content-type": "application/json",
          ...(options.headers ?? {}),
        },
      });
      const text = await response.text();
      let body;
      try {
        body = text ? JSON.parse(text) : {};
      } catch {
        body = { raw: text };
      }
      if (!response.ok) {
        throw new Error(`${path} failed (${response.status}): ${JSON.stringify(body)}`);
      }
      return body;
    }

    const rolesBody = await request(`/api/workspaces/${id}/roles`);
    let role = Array.isArray(rolesBody.roles) ? rolesBody.roles[0] : null;
    let createdRole = false;
    if (!role) {
      const circlesBody = await request(`/api/workspaces/${id}/circles`);
      let circle = Array.isArray(circlesBody.circles) ? circlesBody.circles[0] : null;
      if (!circle) {
        const createdCircle = await request(`/api/workspaces/${id}/circles`, {
          method: "POST",
          body: JSON.stringify({
            name: "Smoke Operations",
            purposeMd: "Coordinate self-serve smoke verification.",
            domainMd: "Trial setup, onboarding, billing, and support reproducibility.",
          }),
        });
        circle = createdCircle.circle;
      }
      role = await request(`/api/workspaces/${id}/roles`, {
        method: "POST",
        body: JSON.stringify({
          circleId: circle.id,
          name: "Smoke Role Owner",
          purposeMd: "Owns the launch smoke role description and customer support reproducibility.",
          accountabilities: [
            "Verify onboarding state is understandable.",
            "Confirm customer bugs can be reproduced through audited support access.",
          ],
          artifacts: ["Self-serve smoke QA result"],
        }),
      });
      createdRole = true;
    }

    const membersBody = await request(`/api/workspaces/${id}/members`);
    const member = Array.isArray(membersBody.members) ? membersBody.members[0] : null;
    if (member?.id) {
      await request(`/api/workspaces/${id}/roles/${role.id}/assignments`, {
        method: "POST",
        body: JSON.stringify({ memberId: member.id }),
      });
    }
    return { roleId: role.id, memberId: member?.id ?? null, createdRole };
  }, workspaceId);

  await page.goto(`${baseUrl}/workspaces/${workspaceId}/roles/${roleSetup.roleId}`, { waitUntil: "networkidle" });
  await screenshot(page, "role-detail");
  pass("role detail and role onboarding path verified", {
    url: page.url(),
    roleId: roleSetup.roleId,
    memberId: roleSetup.memberId,
    createdRole: roleSetup.createdRole,
  });
}

async function verifyBillingCheckout(page, workspaceId) {
  const checkout = await page.evaluate(async (id) => {
    const response = await fetch("/api/billing/checkout", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ workspaceId: id }),
    });
    const text = await response.text();
    let body;
    try {
      body = text ? JSON.parse(text) : {};
    } catch {
      body = { raw: text };
    }
    return { status: response.status, ok: response.ok, body };
  }, workspaceId);

  if (!checkout.ok) {
    if (allowBillingSkip) {
      warn("billing checkout skipped", { response: checkout });
      return;
    }
    throw new Error(`Billing checkout failed (${checkout.status}): ${JSON.stringify(checkout.body)}`);
  }

  if (!checkout.body?.url) {
    throw new Error(`Billing checkout did not return a Stripe URL: ${JSON.stringify(checkout.body)}`);
  }
  pass("billing checkout session created", { status: checkout.status });

  if (completeStripeCard) {
    warn("Stripe test-card completion requested but not automated in this smoke version", { checkoutUrl: checkout.body.url });
  }
}

async function main() {
  await writeJsonArtifact(path.join(artifactsDir, "qa-results.json"), result);
  await record("RUNNING");

  const browser = await chromium.launch({ headless });
  const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });

  try {
    await resetProcurementTrialRateLimits({
      baseUrl,
      secret,
      adminEmail,
      companyName,
    });
    pass("trial-create rate limits reset for smoke identity", { email: adminEmail });

    if (siteUrl) {
      await page.goto(`${siteUrl}/pricing`, { waitUntil: "networkidle" });
      await screenshot(page, "public-pricing");
      const clicked = await clickFirstVisible(page.locator('a[href*="/signup"]'));
      if (clicked) {
        await page.waitForLoadState("networkidle").catch(() => undefined);
        pass("public site start-trial CTA opened app signup", { url: page.url() });
      } else {
        warn("public site signup CTA not found; opening app signup directly", { siteUrl });
        await page.goto(`${baseUrl}/signup`, { waitUntil: "networkidle" });
      }
    } else {
      await page.goto(`${baseUrl}/signup`, { waitUntil: "networkidle" });
    }

    if (!/\/signup(?:[/?#]|$)/.test(page.url())) {
      await page.goto(`${baseUrl}/signup`, { waitUntil: "networkidle" });
    }
    await screenshot(page, "signup-form");
    await page.fill('input[name="companyName"]', companyName);
    await page.fill('input[name="adminName"]', "Corgtex Smoke Agent");
    await page.fill('input[name="adminEmail"]', adminEmail);
    await page.check('input[name="acceptedTerms"]');
    await page.click('button[type="submit"]');
    await page.getByText("Check your email").waitFor({ timeout: 30_000 });
    await screenshot(page, "signup-complete");
    pass("signup created an active self-serve trial", { email: adminEmail });

    const capture = await pollCapturedSetupEmail({ baseUrl, secret, toEmail: adminEmail, consume: true });
    pass("setup email captured through smoke-only endpoint", { captureId: capture.id, providerStatus: capture.providerStatus });

    await page.goto(capture.setupUrl, { waitUntil: "networkidle" });
    await screenshot(page, "setup-account");
    await page.fill('input[name="password"]', password);
    await page.fill('input[name="confirmPassword"]', password);
    await page.click('button[type="submit"]');
    await page.waitForURL(/\/login/i, { timeout: 30_000 });
    pass("setup-account password claim completed");

    await page.fill('input[name="email"]', adminEmail);
    await page.fill('input[name="password"]', password);
    await page.click('button[type="submit"]');
    await page.waitForURL(/\/workspaces\//i, { timeout: 45_000 });
    result.workspaceId = workspaceIdFromUrl(page.url());
    if (!result.workspaceId) {
      throw new Error(`Unable to parse workspace id from URL ${page.url()}`);
    }
    await screenshot(page, "workspace-home");
    pass("trial admin logged into workspace", { workspaceId: result.workspaceId });

    await driveOnboardingTour(page);
    await screenshot(page, "onboarding-tour");
    pass("onboarding tour v2 completed or acknowledged");

    await verifyRoleSurface(page, result.workspaceId);
    await verifyBillingCheckout(page, result.workspaceId);

    result.status = "PASSED";
  } catch (error) {
    result.status = "FAILED";
    result.error = error instanceof Error ? error.message : String(error);
    await screenshot(page, "failure").catch(() => undefined);
    throw error;
  } finally {
    await browser.close();
    result.completedAt = new Date().toISOString();
    await writeJsonArtifact(path.join(artifactsDir, "qa-results.json"), result);
    await record(result.status);
  }
}

main().catch((error) => {
  console.error(`FAIL ${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = 1;
});
