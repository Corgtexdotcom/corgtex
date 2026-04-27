import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { chromium } from "playwright";

const [, , baseUrlArg, outDirArg] = process.argv;

const baseUrl = (baseUrlArg || process.env.CLIENT_READINESS_BASE_URL || "http://localhost:3000").replace(/\/$/, "");
const outDir = path.resolve(outDirArg || process.env.CLIENT_READINESS_OUT_DIR || "docs/assets/client-readiness-2026-04-25");
const email = process.env.AGENT_E2E_EMAIL || "system+corgtex@corgtex.local";
const password = process.env.AGENT_E2E_PASSWORD || "corgtex-test-agent-pw";
const loginLocale = process.env.CLIENT_READINESS_LOCALE || "en";

function csvSet(name) {
  return new Set((process.env[name] || "").split(",").map((value) => value.trim()).filter(Boolean));
}

const routeNameFilter = csvSet("CLIENT_READINESS_ROUTE_NAMES");
const excludedRoutePaths = csvSet("CLIENT_READINESS_EXCLUDE_ROUTES");
const expectedDisabledRoutePaths = csvSet("CLIENT_READINESS_EXPECT_DISABLED_ROUTES");

const routeCatalog = [
  ["home", ""],
  ["goals", "/goals"],
  ["brain", "/brain"],
  ["brain-sources", "/brain/sources"],
  ["brain-status", "/brain/status"],
  ["members", "/members"],
  ["tensions", "/tensions"],
  ["actions", "/actions"],
  ["meetings", "/meetings"],
  ["leads", "/leads"],
  ["proposals", "/proposals"],
  ["circles", "/circles"],
  ["cycles", "/cycles"],
  ["finance", "/finance"],
  ["agents", "/agents"],
  ["governance", "/governance"],
  ["audit", "/audit"],
  ["settings", "/settings"],
  ["chat", "/chat"],
  ["operator", "/operator"],
];

const desktopRoutes = routeCatalog.filter(([name, suffix]) => {
  if (routeNameFilter.size > 0 && !routeNameFilter.has(name)) return false;
  if (excludedRoutePaths.has(suffix)) return false;
  if (expectedDisabledRoutePaths.has(suffix)) return false;
  return true;
});

const mobileRoutes = desktopRoutes.filter(([name]) => name !== "operator");

function routeUrl(locale, workspacePath, suffix) {
  return `${baseUrl}${locale}${workspacePath}${suffix}`;
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
  });
}

async function captureRoute(page, locale, workspacePath, name, suffix, viewport, prefix, findings, routeResults) {
  await page.setViewportSize(viewport);
  const target = routeUrl(locale, workspacePath, suffix);
  const response = await page.goto(target, { waitUntil: "domcontentloaded" });
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

async function verifyDisabledRoute(page, locale, workspacePath, suffix, findings, routeResults) {
  const routeName = suffix.replace(/^\//, "").replace(/[^a-z0-9_-]+/gi, "-") || "home";
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

  const browser = await chromium.launch();
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  page.setDefaultNavigationTimeout(90000);
  const consoleErrors = [];
  const findings = [];
  const routeResults = [];
  let expectedNotFoundRoute = false;

  page.on("console", (message) => {
    if (message.type() === "error") {
      if (
        expectedNotFoundRoute &&
        message.text().includes("Failed to load resource: the server responded with a status of 404")
      ) {
        return;
      }
      consoleErrors.push(cleanConsoleMessage(message));
    }
  });
  page.on("pageerror", (error) => {
    consoleErrors.push({ type: "pageerror", text: error.message });
  });

  await page.goto(`${baseUrl}/${loginLocale}/login`, { waitUntil: "domcontentloaded" });
  await waitForPageSettled(page);
  await captureScreenshot(page, "00-login.png");
  await page.fill('input[name="email"]', email);
  await page.fill('input[name="password"]', password);
  await Promise.all([
    page.waitForURL(/\/workspaces\//, { timeout: 15000 }),
    page.click('button[type="submit"]'),
  ]);
  await waitForPageSettled(page);
  await captureScreenshot(page, "01-after-login.png");

  const match = new URL(page.url()).pathname.match(/^(\/[a-z]{2})?(\/workspaces\/[^/]+)/);
  if (!match) {
    throw new Error(`Login did not land in a workspace: ${page.url()}`);
  }
  const [, locale = "", workspacePath] = match;

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
  await page.goto(routeUrl(locale, workspacePath, "/not-a-real-client-readiness-route"), { waitUntil: "domcontentloaded" });
  await waitForPageSettled(page);
  await captureScreenshot(page, "desktop-invalid-route.png");
  expectedNotFoundRoute = false;

  if (expectedDisabledRoutePaths.size > 0) {
    expectedNotFoundRoute = true;
    for (const suffix of expectedDisabledRoutePaths) {
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

  await writeFile(
    path.join(outDir, "qa-results.json"),
    `${JSON.stringify(
      {
        used: "agent-e2e",
        routeResults,
        findings,
        consoleErrors,
      },
      null,
      2,
    )}\n`,
  );

  await browser.close();

  if (findings.length > 0 || consoleErrors.length > 0) {
    throw new Error(`Client readiness smoke found ${findings.length} route findings and ${consoleErrors.length} console errors.`);
  }
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
