import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { chromium } from "playwright";

import {
  DEMO_WORKSPACE_SLUG,
  selectWorkspaceForValidation,
  validationWorkspaceSelectorFromEnv,
} from "./lib/validation-workspace.mjs";

const [, , baseUrlArg, outDirArg] = process.argv;

const baseUrl = (baseUrlArg || process.env.CLIENT_READINESS_BASE_URL || "http://localhost:3000").replace(/\/$/, "");
const outDir = path.resolve(outDirArg || process.env.CLIENT_READINESS_OUT_DIR || ".artifacts/client-readiness");
const email = process.env.AGENT_E2E_EMAIL || "system+corgtex@corgtex.local";
const password = process.env.AGENT_E2E_PASSWORD || "corgtex-test-agent-pw";
const loginLocale = process.env.CLIENT_READINESS_LOCALE || "en";
const loginTimeoutMs = positiveInt(process.env.CLIENT_READINESS_LOGIN_TIMEOUT_MS, 60_000);
const mobileModeSwitchTimeoutMs = positiveInt(process.env.CLIENT_READINESS_MOBILE_MODE_SWITCH_TIMEOUT_MS, 15_000);
const mobileModeSwitchRetryMs = positiveInt(process.env.CLIENT_READINESS_MOBILE_MODE_SWITCH_RETRY_MS, 750);

function csvSet(name) {
  return new Set((process.env[name] || "").split(",").map((value) => value.trim()).filter(Boolean));
}

const routeNameFilter = csvSet("CLIENT_READINESS_ROUTE_NAMES");
const excludedRoutePaths = csvSet("CLIENT_READINESS_EXCLUDE_ROUTES");
const expectedDisabledRoutePaths = csvSet("CLIENT_READINESS_EXPECT_DISABLED_ROUTES");

const includeOptionalRoutes = process.env.CLIENT_READINESS_INCLUDE_OPTIONAL_ROUTES === "true";

const coreRouteCatalog = [
  ["home", ""],
  ["goals", "/goals"],
  ["brain", "/brain"],
  ["brain-sources", "/brain/sources"],
  ["brain-status", "/brain/status"],
  ["members", "/members"],
  ["tensions", "/tensions"],
  ["actions", "/actions"],
  ["meetings", "/meetings"],
  ["proposals", "/proposals"],
  ["circles", "/circles"],
  ["finance", "/finance"],
  ["audit", "/audit"],
  ["settings", "/settings"],
  ["chat", "/chat"],
];

const optionalRouteCatalog = [
  ["leads", "/leads"],
  ["agents", "/agents"],
  ["governance", "/governance"],
  ["operator", "/operator"],
];

const routeCatalog = [
  ...coreRouteCatalog,
  ...(includeOptionalRoutes || routeNameFilter.size > 0 ? optionalRouteCatalog : []),
];

if (process.env.CLIENT_READINESS_INCLUDE_ADMIN === "true") {
  routeCatalog.push(["admin", "/admin"]);
}

const desktopRoutes = routeCatalog.filter(([name, suffix]) => {
  if (routeNameFilter.size > 0 && !routeNameFilter.has(name)) return false;
  if (excludedRoutePaths.has(suffix)) return false;
  if (expectedDisabledRoutePaths.has(suffix)) return false;
  return true;
});

const mobileRoutes = desktopRoutes;
const mobileShellViewports = [
  ["iphone-se", { width: 320, height: 568 }],
  ["iphone-modern", { width: 390, height: 844 }],
  ["pixel", { width: 412, height: 915 }],
  ["small-tablet", { width: 700, height: 1024 }],
];

function positiveInt(value, fallback) {
  if (value === null || value === undefined || value === "") return fallback;
  const parsed = Number.parseInt(String(value), 10);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    throw new Error(`Expected positive integer for timeout, got ${value}.`);
  }
  return parsed;
}

function normalizePath(value, fallback) {
  const text = String(value || "").trim();
  if (!text) return fallback;
  return text.startsWith("/") ? text : `/${text}`;
}

async function resolveLoginPath() {
  const explicitPath = normalizePath(process.env.CLIENT_READINESS_LOGIN_PATH, null);
  if (explicitPath) return explicitPath;

  if (loginLocale !== "en") {
    return `/${loginLocale}/login`;
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 5000);
  try {
    const response = await fetch(`${baseUrl}/api/health`, {
      signal: controller.signal,
      headers: { "user-agent": "corgtex-client-readiness/1.0" },
    });
    const payload = await response.json().catch(() => null);
    return normalizePath(payload?.loginPath, "/login");
  } catch {
    return "/login";
  } finally {
    clearTimeout(timer);
  }
}

function routeUrl(locale, workspacePath, suffix) {
  return `${baseUrl}${locale}${workspacePath}${suffix}`;
}

export function demoAddGuardRouteSuffix(workspacePath) {
  return `/add?kind=upload_file&returnTo=${encodeURIComponent(`${workspacePath}/brain`)}`;
}

export async function resolveSelectedWorkspace(page, currentWorkspacePath) {
  const selector = validationWorkspaceSelectorFromEnv(process.env, "CLIENT_READINESS");
  if (!selector.explicit) {
    if (!currentWorkspacePath) {
      const response = await page.request.get(`${baseUrl}/api/session`);
      if (!response.ok()) {
        throw new Error(`/api/session failed while resolving client-readiness workspace: ${response.status()}`);
      }
      const session = await response.json();
      const workspaces = session.workspaces ?? [];
      if (workspaces.length === 1 && workspaces[0]) {
        return {
          workspacePath: `/workspaces/${workspaces[0].id}`,
          workspaceSlug: workspaces[0].slug ?? null,
          selected: false,
        };
      }
      throw new Error(
        "Login reached the account picker. Set CLIENT_READINESS_WORKSPACE_ID or CLIENT_READINESS_WORKSPACE_SLUG " +
        "so the production client-readiness smoke can select the intended tenant.",
      );
    }
    return {
      workspacePath: currentWorkspacePath,
      workspaceSlug: null,
      selected: false,
    };
  }

  const response = await page.request.get(`${baseUrl}/api/session`);
  if (!response.ok()) {
    throw new Error(`/api/session failed while selecting client-readiness workspace: ${response.status()}`);
  }
  const session = await response.json();
  const workspace = selectWorkspaceForValidation(session.workspaces ?? [], {
    workspaceId: selector.workspaceId,
    workspaceSlug: selector.workspaceSlug,
    purpose: "client readiness smoke",
  });

  return {
    workspacePath: `/workspaces/${workspace.id}`,
    workspaceSlug: workspace.slug ?? null,
    selected: true,
  };
}

export function labelConsoleEntry(entry, routeLabel) {
  const label = String(routeLabel || "").trim();
  return label ? { ...entry, routeLabel: label } : entry;
}

function setActiveRouteLabel(label) {
  if (typeof globalThis.__corgtexClientReadinessSetRouteLabel === "function") {
    globalThis.__corgtexClientReadinessSetRouteLabel(label);
  }
}

function cleanConsoleMessage(message) {
  return {
    type: message.type(),
    text: message.text(),
    location: message.location(),
  };
}

async function waitForPageSettled(page) {
  await page.waitForLoadState("domcontentloaded");
  await page.waitForTimeout(350);
}

async function captureScreenshot(page, fileName) {
  await page.screenshot({
    path: path.join(outDir, fileName),
    fullPage: true,
    caret: "initial",
  }).catch(() => null);
}

export function isWorkspaceUrl(value) {
  try {
    return /\/workspaces\//.test(new URL(value).pathname);
  } catch {
    return false;
  }
}

export function isFindAccountUrl(value) {
  try {
    return /^(?:\/[a-z]{2})?\/find-account\/?$/.test(new URL(value).pathname);
  } catch {
    return false;
  }
}

export function localePrefixFromUrl(value) {
  try {
    const match = new URL(value).pathname.match(/^(\/[a-z]{2})(?:\/|$)/);
    return match?.[1] ?? "";
  } catch {
    return "";
  }
}

export function workspacePathFromUrl(value) {
  try {
    return new URL(value).pathname.match(/^(?:\/[a-z]{2})?(\/workspaces\/[^/]+)/)?.[1] ?? null;
  } catch {
    return null;
  }
}

export async function visibleLoginErrorMessage(page) {
  const locators = page.locator('[role="alert"], .form-message-error');
  const count = await locators.count().catch(() => 0);

  for (let index = 0; index < count; index += 1) {
    const locator = locators.nth(index);
    if (!(await locator.isVisible().catch(() => false))) continue;

    const message = (await locator.textContent().catch(() => null))?.trim();
    if (message) return message;
  }

  return null;
}

export async function waitForLoginResult(page) {
  const deadline = Date.now() + loginTimeoutMs;

  while (Date.now() < deadline) {
    if (isWorkspaceUrl(page.url())) {
      await page.waitForLoadState("domcontentloaded", { timeout: 5000 }).catch(() => null);
      return;
    }

    if (isFindAccountUrl(page.url())) {
      await page.waitForLoadState("domcontentloaded", { timeout: 5000 }).catch(() => null);
      return;
    }

    const message = await visibleLoginErrorMessage(page);
    if (message) {
      await captureScreenshot(page, "login-failed.png");
      throw new Error(`Login failed: ${message}`);
    }

    await page.waitForTimeout(Math.min(250, Math.max(1, deadline - Date.now())));
  }

  await captureScreenshot(page, "login-failed.png");
  throw new Error(`Login did not reach a workspace within ${loginTimeoutMs}ms. Current URL: ${page.url()}`);
}

export async function submitLoginForm(page) {
  const submitClick = page.click('button[type="submit"]', { noWaitAfter: true });
  await Promise.all([submitClick, waitForLoginResult(page)]);
}

function serializeError(error) {
  return {
    name: error?.name ?? "Error",
    message: error instanceof Error ? error.message : String(error),
    stack: error instanceof Error ? error.stack : null,
  };
}

async function writeResults(status, routeResults, findings, consoleErrors, fatalError = null) {
  await writeFile(
    path.join(outDir, "qa-results.json"),
    `${JSON.stringify(
      {
        used: "agent-e2e",
        status,
        baseUrl,
        checkedAt: new Date().toISOString(),
        routeResults,
        findings,
        consoleErrors,
        fatalError,
      },
      null,
      2,
    )}\n`,
  );
}

async function captureRoute(page, locale, workspacePath, name, suffix, viewport, prefix, findings, routeResults) {
  setActiveRouteLabel(`${prefix}${name}`);
  await page.setViewportSize(viewport);
  const target = routeUrl(locale, workspacePath, suffix);
  let response;
  try {
    response = await page.goto(target, { waitUntil: "domcontentloaded" });
  } catch (error) {
    findings.push({
      name: `${prefix}${name}`,
      route: target,
      status: "navigation-failed",
      error: error instanceof Error ? error.message : String(error),
    });
    routeResults.push({ name: `${prefix}${name}`, route: `${workspacePath}${suffix}`, status: 0 });
    await captureScreenshot(page, `${prefix}${name}-navigation-failed.png`);
    return;
  }
  await waitForPageSettled(page);
  const status = response?.status() ?? 0;
  routeResults.push({ name: `${prefix}${name}`, route: `${workspacePath}${suffix}`, status });
  if (status >= 400) {
    findings.push({ name: `${prefix}${name}`, route: target, status });
    await captureScreenshot(page, `${prefix}${name}-failed.png`);
    return;
  }
  await captureScreenshot(page, `${prefix}${name}.png`);
}

async function expectVisible(page, selector, label, findings, timeout = 5000) {
  const locator = page.locator(selector).first();
  await locator.waitFor({ state: "visible", timeout }).catch(() => null);
  if (!(await locator.isVisible().catch(() => false))) {
    findings.push({ name: label, route: page.url(), status: "missing-visible-selector", selector });
    await captureScreenshot(page, `${label}-missing.png`);
    return false;
  }
  return true;
}

async function activateMobileControl(page, {
  controlSelector,
  buttonText,
  expectedSelector,
  label,
  findings,
  timeoutMs = mobileModeSwitchTimeoutMs,
  retryDelayMs = mobileModeSwitchRetryMs,
}) {
  const button = page.locator(controlSelector, { hasText: buttonText }).first();
  const expected = page.locator(expectedSelector).first();
  const attempts = Math.max(1, Math.ceil(timeoutMs / retryDelayMs));
  const interactionTimeout = Math.max(250, Math.min(2000, retryDelayMs));

  for (let attempt = 0; attempt < attempts; attempt += 1) {
    await button.waitFor({ state: "visible", timeout: interactionTimeout }).catch(() => null);
    await button.click({ timeout: interactionTimeout }).catch(() => null);
    await expected.waitFor({ state: "visible", timeout: retryDelayMs }).catch(() => null);

    if (await expected.isVisible().catch(() => false)) {
      return true;
    }

    await page.waitForTimeout(Math.min(250, retryDelayMs)).catch(() => null);
  }

  findings.push({
    name: label,
    route: page.url(),
    status: "mode-switch-timeout",
    selector: expectedSelector,
  });
  await captureScreenshot(page, `${label}-missing.png`);
  return false;
}

export async function activateMobileMode(page, options) {
  return activateMobileControl(page, {
    controlSelector: ".mobile-mode-switch button",
    ...options,
  });
}

export async function activateMobileWorkspaceMode(page, {
  label,
  findings,
  timeoutMs = mobileModeSwitchTimeoutMs,
  retryDelayMs = mobileModeSwitchRetryMs,
}) {
  return activateMobileMode(page, {
    buttonText: /Workspace|Espacio/,
    expectedSelector: ".mobile-bottom-nav",
    label,
    findings,
    timeoutMs,
    retryDelayMs,
  });
}

export async function activateMobileAskTab(page, {
  label,
  findings,
  timeoutMs = mobileModeSwitchTimeoutMs,
  retryDelayMs = mobileModeSwitchRetryMs,
}) {
  return activateMobileControl(page, {
    controlSelector: ".mobile-ai-tabs button",
    buttonText: /Ask|Preguntar/,
    expectedSelector: ".mobile-ai-pane-ask .chat-input",
    label,
    findings,
    timeoutMs,
    retryDelayMs,
  });
}

async function expectTextVisible(page, selector, text, label, findings) {
  const locator = page.locator(selector, { hasText: text }).first();
  await locator.waitFor({ state: "visible", timeout: 5000 }).catch(() => null);
  if (!(await locator.isVisible().catch(() => false))) {
    findings.push({ name: label, route: page.url(), status: "missing-visible-text", selector, text });
    await captureScreenshot(page, `${label}-missing.png`);
    return false;
  }
  return true;
}

async function verifyNoHorizontalOverflow(page, label, findings) {
  const overflow = await page.evaluate(() => {
    const root = document.documentElement;
    return {
      scrollWidth: root.scrollWidth,
      clientWidth: root.clientWidth,
      bodyScrollWidth: document.body.scrollWidth,
      bodyClientWidth: document.body.clientWidth,
    };
  });

  if (overflow.scrollWidth > overflow.clientWidth + 2 || overflow.bodyScrollWidth > overflow.bodyClientWidth + 2) {
    findings.push({ name: label, route: page.url(), status: "horizontal-overflow", overflow });
    await captureScreenshot(page, `${label}-overflow.png`);
  }
}

async function verifyMobileShell(page, locale, workspacePath, findings, routeResults) {
  let fakeConversationCounter = 0;
  await page.route("**/api/workspaces/*/mobile-analytics", async (route) => {
    if (route.request().method() !== "POST") {
      await route.fallback();
      return;
    }

    await route.fulfill({ status: 204 });
  });
  await page.route("**/api/workspaces/*/conversations", async (route) => {
    if (route.request().method() !== "POST") {
      await route.fallback();
      return;
    }

    fakeConversationCounter += 1;
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({ session: { id: `mobile-smoke-${fakeConversationCounter}` } }),
    });
  });
  await page.route("**/api/workspaces/*/conversations/*", async (route) => {
    if (route.request().method() !== "POST") {
      await route.fallback();
      return;
    }

    await route.fulfill({
      status: 200,
      contentType: "text/event-stream; charset=utf-8",
      body: "data: {\"text\":\"Smoke response\"}\n\ndata: [DONE]\n\n",
    });
  });

  for (const [viewportName, viewport] of mobileShellViewports) {
    setActiveRouteLabel(`mobile-shell-${viewportName}`);
    await page.setViewportSize(viewport);
    const target = routeUrl(locale, workspacePath, "");
    const response = await page.goto(target, { waitUntil: "domcontentloaded" });
    await waitForPageSettled(page);
    const status = response?.status() ?? 0;
    routeResults.push({ name: `mobile-shell-${viewportName}`, route: workspacePath, status });
    if (status >= 400) {
      findings.push({ name: `mobile-shell-${viewportName}`, route: target, status });
      await captureScreenshot(page, `mobile-shell-${viewportName}-failed.png`);
      continue;
    }

    await expectVisible(page, ".mobile-topbar", `mobile-shell-${viewportName}-topbar`, findings);
    await expectVisible(page, ".mobile-mode-switch", `mobile-shell-${viewportName}-mode-switch`, findings);
    const workspaceModeReady = await activateMobileWorkspaceMode(page, {
      label: `mobile-shell-${viewportName}-workspace-mode`,
      findings,
    });
    if (!workspaceModeReady) continue;
    await expectVisible(page, ".mobile-bottom-nav", `mobile-shell-${viewportName}-bottom-nav`, findings);
    await verifyNoHorizontalOverflow(page, `mobile-shell-${viewportName}`, findings);
    await captureScreenshot(page, `mobile-shell-${viewportName}-workspace.png`);

    const aiModeReady = await activateMobileMode(page, {
      buttonText: /AI|IA/,
      expectedSelector: ".mobile-ai-workbench",
      label: `mobile-shell-${viewportName}-ai`,
      findings,
    });
    if (!aiModeReady) continue;

    const askTabReady = await activateMobileAskTab(page, {
      label: `mobile-shell-${viewportName}-ai-ask`,
      findings,
    });
    if (!askTabReady) continue;

    const inputReady = await expectVisible(
      page,
      ".mobile-ai-workbench .chat-input",
      `mobile-shell-${viewportName}-ai-input`,
      findings,
    );
    const sendReady = await expectVisible(
      page,
      ".mobile-ai-workbench .chat-send-btn",
      `mobile-shell-${viewportName}-ai-send`,
      findings,
    );
    if (!inputReady || !sendReady) continue;

    const smokePrompt = `Mobile smoke ${viewportName}`;
    try {
      await page.locator(".mobile-ai-workbench .chat-input").first().fill(smokePrompt, { timeout: 5000 });
      await page.locator(".mobile-ai-workbench .chat-send-btn").first().click({ timeout: 5000 });
    } catch (error) {
      findings.push({
        name: `mobile-shell-${viewportName}-ai-submit`,
        route: page.url(),
        status: "chat-submit-failed",
        error: error instanceof Error ? error.message : String(error),
      });
      await captureScreenshot(page, `mobile-shell-${viewportName}-ai-submit-failed.png`);
      continue;
    }
    await expectTextVisible(page, ".mobile-ai-workbench .chat-message.user", smokePrompt, `mobile-shell-${viewportName}-ai-user-message`, findings);
    await expectTextVisible(page, ".mobile-ai-workbench .chat-message.assistant", "Smoke response", `mobile-shell-${viewportName}-ai-response`, findings);
    const storedMode = await page.evaluate(() => window.localStorage.getItem("corgtex.mobileMode"));
    if (storedMode !== "ai") {
      findings.push({ name: `mobile-shell-${viewportName}-mode-store`, route: page.url(), status: storedMode });
    }
    await captureScreenshot(page, `mobile-shell-${viewportName}-ai.png`);

    await page.reload({ waitUntil: "domcontentloaded" });
    await waitForPageSettled(page);
    await expectVisible(page, ".mobile-ai-workbench", `mobile-shell-${viewportName}-ai-persisted`, findings, mobileModeSwitchTimeoutMs);

    await page.locator(".mobile-mode-switch button", { hasText: /Workspace|Espacio/ }).first().click();
    await expectVisible(page, ".ws-main", `mobile-shell-${viewportName}-workspace-return`, findings);
    await expectVisible(page, ".mobile-bottom-nav", `mobile-shell-${viewportName}-bottom-nav-return`, findings);
    await captureScreenshot(page, `mobile-shell-${viewportName}-workspace-return.png`);
  }
}

async function verifyDisabledRoute(page, locale, workspacePath, suffix, findings, routeResults) {
  const routeName = suffix.replace(/^\//, "").replace(/[^a-z0-9_-]+/gi, "-") || "home";
  setActiveRouteLabel(`disabled-${routeName}`);
  const target = routeUrl(locale, workspacePath, suffix);
  const response = await page.goto(target, { waitUntil: "domcontentloaded" });
  await waitForPageSettled(page);
  const status = response?.status() ?? 0;
  routeResults.push({ name: `disabled-${routeName}`, route: `${workspacePath}${suffix}`, status });
  if (status < 400) {
    findings.push({ name: `disabled-${routeName}`, route: target, status, expected: "disabled" });
    await captureScreenshot(page, `disabled-${routeName}-visible.png`);
  }
}

async function main() {
  await mkdir(outDir, { recursive: true });

  let browser;
  let activeRouteLabel = "startup";
  globalThis.__corgtexClientReadinessSetRouteLabel = (label) => {
    activeRouteLabel = String(label || "unknown");
  };
  const consoleErrors = [];
  const findings = [];
  const routeResults = [];
  try {
    browser = await chromium.launch();
    const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
    page.setDefaultNavigationTimeout(90000);
    let expectedNotFoundRoute = false;

    page.on("console", (message) => {
      if (message.type() === "error") {
        if (
          expectedNotFoundRoute &&
          message.text().includes("Failed to load resource: the server responded with a status of 404")
        ) {
          return;
        }
        consoleErrors.push(labelConsoleEntry(cleanConsoleMessage(message), activeRouteLabel));
      }
    });
    page.on("pageerror", (error) => {
      consoleErrors.push(labelConsoleEntry({ type: "pageerror", text: error.message }, activeRouteLabel));
    });

    setActiveRouteLabel("login");
    await page.goto(`${baseUrl}${await resolveLoginPath()}`, { waitUntil: "domcontentloaded" });
    await waitForPageSettled(page);
    await captureScreenshot(page, "00-login.png");
    await page.fill('input[name="email"]', email);
    await page.fill('input[name="password"]', password);
    await submitLoginForm(page);
    await waitForPageSettled(page);
    await captureScreenshot(page, "01-after-login.png");

    const locale = localePrefixFromUrl(page.url());
    const initialWorkspacePath = workspacePathFromUrl(page.url());
    const selectedWorkspace = await resolveSelectedWorkspace(page, initialWorkspacePath);
    const workspacePath = selectedWorkspace.workspacePath;
    if (workspacePath !== initialWorkspacePath) {
      await page.goto(routeUrl(locale, workspacePath, ""), { waitUntil: "domcontentloaded" });
      await waitForPageSettled(page);
      await captureScreenshot(page, "02-selected-workspace.png");
    }
    const disabledRoutePaths = new Set(expectedDisabledRoutePaths);
    if (
      selectedWorkspace.workspaceSlug === DEMO_WORKSPACE_SLUG
      || process.env.CLIENT_READINESS_ASSERT_DEMO_GUARDS === "true"
    ) {
      disabledRoutePaths.add(demoAddGuardRouteSuffix(workspacePath));
    }

    for (const [name, suffix] of desktopRoutes) {
      await captureRoute(
        page,
        locale,
        workspacePath,
        name,
        suffix,
        { width: 1440, height: 900 },
        "desktop-",
        findings,
        routeResults,
      );
    }

    expectedNotFoundRoute = true;
    setActiveRouteLabel("desktop-invalid-route");
    await page.goto(routeUrl(locale, workspacePath, "/not-a-real-client-readiness-route"), { waitUntil: "domcontentloaded" });
    await waitForPageSettled(page);
    await captureScreenshot(page, "desktop-invalid-route.png");
    expectedNotFoundRoute = false;

    if (disabledRoutePaths.size > 0) {
      expectedNotFoundRoute = true;
      for (const suffix of disabledRoutePaths) {
        await verifyDisabledRoute(page, locale, workspacePath, suffix, findings, routeResults);
      }
      expectedNotFoundRoute = false;
    }

    for (const [name, suffix] of mobileRoutes) {
      await captureRoute(
        page,
        locale,
        workspacePath,
        name,
        suffix,
        { width: 390, height: 844 },
        "mobile-",
        findings,
        routeResults,
      );
    }

    await verifyMobileShell(page, locale, workspacePath, findings, routeResults);

    await writeResults("completed", routeResults, findings, consoleErrors);

    if (findings.length > 0 || consoleErrors.length > 0) {
      throw new Error(`Client readiness smoke found ${findings.length} route findings and ${consoleErrors.length} console errors.`);
    }
  } catch (error) {
    const fatalError = serializeError(error);
    findings.push({
      name: "fatal",
      route: baseUrl,
      status: "failed",
      error: fatalError.message,
    });
    await writeResults("failed", routeResults, findings, consoleErrors, fatalError);
    throw error;
  } finally {
    delete globalThis.__corgtexClientReadinessSetRouteLabel;
    await browser?.close().catch(() => null);
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    console.error(error);
    process.exitCode = 1;
  });
}
