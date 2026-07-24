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

const baseUrl = normalizeBaseUrl(baseUrlArg || process.env.MEETING_SPINE_SMOKE_BASE_URL || "http://localhost:3000");
const outDir = path.resolve(outDirArg || process.env.MEETING_SPINE_SMOKE_OUT_DIR || ".artifacts/meeting-processing-spine");
const expectedGitSha = firstEnv(["MEETING_SPINE_EXPECTED_GIT_SHA", "EXPECTED_GIT_SHA"]);
const explicitMeetingId = firstEnv(["MEETING_SPINE_SMOKE_MEETING_ID"]);
const explicitMeetingUrl = firstEnv(["MEETING_SPINE_SMOKE_MEETING_URL"]);
const targetMeetingTitle = firstEnv(["MEETING_SPINE_SMOKE_MEETING_TITLE"]) || "Innovation & AI Working Group Kickoff";
const navigationTimeoutMs = positiveInt(process.env.MEETING_SPINE_SMOKE_NAVIGATION_TIMEOUT_MS, 180_000);
const authEmail = firstEnv([
  "MEETING_SPINE_SMOKE_EMAIL",
  "PRODUCTION_VALIDATION_ADMIN_EMAIL",
  "ADMIN_EMAIL",
]);
const authPassword = firstEnv([
  "MEETING_SPINE_SMOKE_PASSWORD",
  "PRODUCTION_VALIDATION_ADMIN_PASSWORD",
  "ADMIN_PASSWORD",
]);

const viewports = [
  ["desktop", { width: 1440, height: 900 }],
  ["mobile", { width: 390, height: 844 }],
];

function firstEnv(names) {
  for (const name of names) {
    const value = process.env[name]?.trim();
    if (value) return value;
  }
  return null;
}

function positiveInt(value, fallback) {
  if (value === null || value === undefined || value === "") return fallback;
  const parsed = Number.parseInt(String(value), 10);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    throw new Error(`Expected positive integer timeout, got ${value}.`);
  }
  return parsed;
}

export function normalizeBaseUrl(value) {
  return String(value || "http://localhost:3000").replace(/\/$/, "");
}

export function meetingDetailUrl(base, workspaceId, meetingId) {
  return `${normalizeBaseUrl(base)}/workspaces/${workspaceId}/meetings/${meetingId}`;
}

export function compactSummaryMatches(text) {
  const normalized = String(text || "").replace(/\s+/g, " ").trim();
  return /\bReady\b/.test(normalized)
    && /Show steps/.test(normalized)
    && (
      /All processing steps complete/.test(normalized)
      || /\d+ extracted items? needs? review/.test(normalized)
    );
}

export function selectMeetingForSmoke(meetings, {
  meetingId = null,
  title = targetMeetingTitle,
} = {}) {
  if (!Array.isArray(meetings)) return null;

  if (meetingId) {
    return meetings.find((meeting) => meeting.id === meetingId) ?? null;
  }

  const exactTitle = meetings.find((meeting) =>
    meeting.title === title
    && meeting.transcript
    && (meeting.aiProcessedAt || meeting.summaryMd)
    && !meeting.archivedAt
  );
  if (exactTitle) return exactTitle;

  return meetings.find((meeting) =>
    meeting.transcript
    && (meeting.aiProcessedAt || meeting.summaryMd)
    && !meeting.archivedAt
  ) ?? null;
}

export function rectsOverlap(first, second, tolerance = 2) {
  const horizontal = Math.min(first.right, second.right) - Math.max(first.left, second.left);
  const vertical = Math.min(first.bottom, second.bottom) - Math.max(first.top, second.top);
  return horizontal > tolerance && vertical > tolerance;
}

function assert(condition, message) {
  if (!condition) {
    throw new Error(message);
  }
}

async function requestJson(request, url, options = {}) {
  const response = await request.fetch(url, {
    ...options,
    headers: {
      "accept": "application/json",
      ...(options.headers ?? {}),
    },
  });
  const text = await response.text();
  let body = null;
  try {
    body = text ? JSON.parse(text) : null;
  } catch {
    body = null;
  }
  return { response, body, text };
}

async function verifyHealth(request) {
  const { response, body, text } = await requestJson(request, `${baseUrl}/api/health`, {
    headers: { "user-agent": "corgtex-meeting-processing-spine-smoke/1.0" },
  });
  assert(response.ok(), `/api/health failed ${response.status()}: ${text.slice(0, 300)}`);
  assert(body?.status === "ok", `/api/health status was ${body?.status ?? "missing"}`);
  assert(body?.database === "up", `/api/health database was ${body?.database ?? "missing"}`);
  assert(body?.schema === "ready", `/api/health schema was ${body?.schema ?? "missing"}`);
  if (expectedGitSha) {
    const actual = body?.release?.gitSha ?? null;
    assert(actual === expectedGitSha, `/api/health release.gitSha ${actual ?? "missing"} did not match ${expectedGitSha}`);
  }
  return body;
}

async function resolveWorkspaceFromSession(page, selector, { fallbackToDemo = false } = {}) {
  const session = await page.request.get(`${baseUrl}/api/session`);
  assert(session.ok(), `/api/session failed while resolving workspace: ${session.status()}`);
  const body = await session.json();
  const workspaces = body.workspaces ?? [];

  if (!selector.explicit && workspaces.length === 1 && workspaces[0]) {
    return workspaces[0];
  }

  return selectWorkspaceForValidation(workspaces, {
    workspaceId: selector.workspaceId,
    workspaceSlug: selector.explicit ? selector.workspaceSlug : DEMO_WORKSPACE_SLUG,
    fallbackToFirstWorkspace: fallbackToDemo,
    purpose: "meeting processing spine smoke",
  });
}

async function loginDemo(page, selector) {
  const { response, body, text } = await requestJson(page.request, `${baseUrl}/api/auth/demo-login`, {
    method: "POST",
  });
  assert(response.ok(), `/api/auth/demo-login failed ${response.status()}: ${text.slice(0, 300)}`);
  const workspace = await resolveWorkspaceFromSession(page, selector, { fallbackToDemo: true });
  return {
    method: "demo-login",
    workspaceId: workspace.id ?? body?.workspaceId,
    workspaceSlug: workspace.slug ?? DEMO_WORKSPACE_SLUG,
  };
}

async function loginPassword(page, selector) {
  assert(authEmail && authPassword, "Set MEETING_SPINE_SMOKE_EMAIL and MEETING_SPINE_SMOKE_PASSWORD, or leave them unset to use demo login.");
  const { response, text } = await requestJson(page.request, `${baseUrl}/api/auth/login`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    data: {
      email: authEmail,
      password: authPassword,
    },
  });
  assert(response.ok(), `/api/auth/login failed ${response.status()}: ${text.slice(0, 300)}`);
  const workspace = await resolveWorkspaceFromSession(page, selector);
  return {
    method: "password",
    workspaceId: workspace.id,
    workspaceSlug: workspace.slug ?? null,
  };
}

async function login(page) {
  const selector = validationWorkspaceSelectorFromEnv(process.env, "MEETING_SPINE_SMOKE");
  const selectorTargetsDemo = !selector.explicit || selector.workspaceSlug === DEMO_WORKSPACE_SLUG;
  if (!authEmail && !authPassword && selectorTargetsDemo) {
    return loginDemo(page, selector);
  }
  return loginPassword(page, selector);
}

async function resolveMeetingTarget(page, workspaceId) {
  if (explicitMeetingUrl) {
    return new URL(explicitMeetingUrl, baseUrl).href;
  }

  if (explicitMeetingId) {
    return meetingDetailUrl(baseUrl, workspaceId, explicitMeetingId);
  }

  const { response, body, text } = await requestJson(
    page.request,
    `${baseUrl}/api/workspaces/${workspaceId}/meetings`,
  );
  assert(response.ok(), `/api/workspaces/${workspaceId}/meetings failed ${response.status()}: ${text.slice(0, 300)}`);
  const meeting = selectMeetingForSmoke(body?.meetings ?? [], { title: targetMeetingTitle });
  assert(meeting, `No completed transcript meeting was available for smoke title "${targetMeetingTitle}".`);
  return meetingDetailUrl(baseUrl, workspaceId, meeting.id);
}

async function suppressDemoTour(page, workspaceId) {
  await page.addInitScript((id) => {
    window.localStorage.setItem(`corgtex_tour_completed_${id}`, "true");
  }, workspaceId);
  await page.evaluate((id) => {
    window.localStorage.setItem(`corgtex_tour_completed_${id}`, "true");
    document.querySelectorAll(".driver-overlay, .driver-popover").forEach((element) => element.remove());
  }, workspaceId).catch(() => null);
}

async function captureScreenshot(page, artifacts, fileName) {
  const filePath = path.join(outDir, fileName);
  await page.screenshot({ path: filePath, fullPage: true, caret: "initial" });
  artifacts.push({ type: "screenshot", label: fileName.replace(/\.png$/, ""), path: filePath });
}

async function captureElementScreenshot(page, locator, artifacts, fileName) {
  const filePath = path.join(outDir, fileName);
  const viewport = page.viewportSize();
  const box = await locator.boundingBox().catch(() => null);
  const useTallMobileCapture = viewport && box && viewport.width <= 720;
  if (useTallMobileCapture) {
    await page.setViewportSize({
      width: viewport.width,
      height: Math.max(viewport.height, Math.ceil(box.height + 520)),
    });
    await waitForPageSettled(page);
  }
  await locator.screenshot({ path: filePath, caret: "initial" }).catch(async () => {
    await page.screenshot({ path: filePath, fullPage: true, caret: "initial" });
  });
  if (useTallMobileCapture && viewport) {
    await page.setViewportSize(viewport);
    await waitForPageSettled(page);
  }
  artifacts.push({ type: "screenshot", label: fileName.replace(/\.png$/, ""), path: filePath });
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
  await page.waitForLoadState("networkidle", { timeout: 5000 }).catch(() => null);
  await page.waitForTimeout(1000);
}

async function visibleCount(locator) {
  return locator.evaluateAll((elements) => elements.filter((element) => {
    if (typeof element.checkVisibility === "function" && !element.checkVisibility({ checkVisibilityCSS: true })) {
      return false;
    }
    const rect = element.getBoundingClientRect();
    const style = window.getComputedStyle(element);
    return style.visibility !== "hidden" && style.display !== "none" && rect.width > 0 && rect.height > 0;
  }).length);
}

async function collectLayoutFindings(page, label) {
  return page.evaluate((currentLabel) => {
    const findings = [];
    const isVisible = (element) => {
      if (typeof element.checkVisibility === "function" && !element.checkVisibility({ checkVisibilityCSS: true })) {
        return false;
      }
      const rect = element.getBoundingClientRect();
      const style = window.getComputedStyle(element);
      return style.display !== "none" && style.visibility !== "hidden" && rect.width > 0 && rect.height > 0;
    };
    const root = document.documentElement;
    if (root.scrollWidth > root.clientWidth + 2 || document.body.scrollWidth > document.body.clientWidth + 2) {
      findings.push({
        name: currentLabel,
        status: "horizontal-overflow",
        scrollWidth: root.scrollWidth,
        clientWidth: root.clientWidth,
        bodyScrollWidth: document.body.scrollWidth,
        bodyClientWidth: document.body.clientWidth,
      });
    }

    const textSelectors = [
      ".meeting-processing-status-label",
      ".meeting-processing-summary-text",
      ".meeting-processing-summary-actions",
      ".meeting-processing-step strong",
      ".meeting-processing-step span",
      ".meeting-processing-step em",
      ".meeting-processing-diagnostics summary",
    ];

    for (const selector of textSelectors) {
      for (const element of document.querySelectorAll(selector)) {
        if (!isVisible(element)) continue;
        if (element.scrollWidth > element.clientWidth + 2) {
          findings.push({
            name: currentLabel,
            status: "cropped-label",
            selector,
            text: element.textContent?.trim().slice(0, 120) ?? "",
            scrollWidth: element.scrollWidth,
            clientWidth: element.clientWidth,
          });
        }
      }
    }

    const overlapGroups = [
      [".meeting-processing-stepper-summary > *", "summary-row-overlap"],
      [".meeting-processing-step", "step-card-overlap"],
      [".meeting-processing-diagnostic", "diagnostic-card-overlap"],
    ];

    for (const [selector, status] of overlapGroups) {
      const boxes = Array.from(document.querySelectorAll(selector))
        .map((element, index) => {
          if (!isVisible(element)) return null;
          const rect = element.getBoundingClientRect();
          return {
            index,
            left: rect.left,
            right: rect.right,
            top: rect.top,
            bottom: rect.bottom,
            text: element.textContent?.trim().slice(0, 80) ?? "",
          };
        })
        .filter(Boolean);

      for (let i = 0; i < boxes.length; i += 1) {
        for (let j = i + 1; j < boxes.length; j += 1) {
          const first = boxes[i];
          const second = boxes[j];
          const horizontal = Math.min(first.right, second.right) - Math.max(first.left, second.left);
          const vertical = Math.min(first.bottom, second.bottom) - Math.max(first.top, second.top);
          if (horizontal > 2 && vertical > 2) {
            findings.push({ name: currentLabel, status, first, second });
          }
        }
      }
    }

    return findings;
  }, label);
}

async function verifyViewport(page, targetUrl, viewportName, viewport, findings, routeResults, artifacts) {
  await page.setViewportSize(viewport);
  const response = await page.goto(targetUrl, { waitUntil: "domcontentloaded" });
  await waitForPageSettled(page);
  const status = response?.status() ?? 0;
  routeResults.push({ name: viewportName, route: targetUrl, status });
  if (status >= 400) {
    findings.push({ name: viewportName, route: targetUrl, status });
    await captureScreenshot(page, artifacts, `${viewportName}-failed.png`);
    return;
  }

  const spine = page.locator("details.meeting-processing-stepper").first();
  await spine.waitFor({ state: "visible", timeout: 10_000 }).catch(() => null);
  if (!(await spine.isVisible().catch(() => false))) {
    findings.push({ name: `${viewportName}-compact-row`, route: targetUrl, status: "missing-compact-row" });
    await captureScreenshot(page, artifacts, `${viewportName}-missing-compact-row.png`);
    return;
  }

  const isOpenByDefault = await spine.evaluate((element) => element.open);
  if (isOpenByDefault) {
    findings.push({ name: `${viewportName}-default-state`, route: targetUrl, status: "stepper-open-by-default" });
  }

  const summaryText = await page.locator(".meeting-processing-stepper-summary").first().textContent();
  if (!compactSummaryMatches(summaryText)) {
    findings.push({
      name: `${viewportName}-compact-copy`,
      route: targetUrl,
      status: "unexpected-compact-copy",
      text: summaryText?.replace(/\s+/g, " ").trim() ?? "",
    });
  }

  const visibleCollapsedSteps = await visibleCount(page.locator(".meeting-processing-stepper:not([open]) .meeting-processing-step"));
  if (visibleCollapsedSteps > 0) {
    findings.push({
      name: `${viewportName}-collapsed-steps`,
      route: targetUrl,
      status: "visible-step-cards-while-collapsed",
      count: visibleCollapsedSteps,
    });
  }

  findings.push(...await collectLayoutFindings(page, `${viewportName}-collapsed`));
  await captureElementScreenshot(page, spine, artifacts, `${viewportName}-collapsed.png`);

  await page.locator(".meeting-processing-status-label").first().click();
  await page.locator("details.meeting-processing-stepper[open]").first().waitFor({ state: "visible", timeout: 5000 }).catch(() => null);
  const isOpenAfterClick = await spine.evaluate((element) => element.open);
  if (!isOpenAfterClick) {
    findings.push({ name: `${viewportName}-expand`, route: targetUrl, status: "did-not-open" });
  }

  const stepCount = await visibleCount(page.locator(".meeting-processing-step"));
  if (stepCount < 6) {
    findings.push({
      name: `${viewportName}-expanded-steps`,
      route: targetUrl,
      status: "missing-step-cards",
      count: stepCount,
    });
  }

  const diagnostics = page.locator("details.meeting-processing-diagnostics");
  const diagnosticCount = await diagnostics.count();
  if (diagnosticCount > 0) {
    const diagnosticsOpen = await diagnostics.first().evaluate((element) => element.open);
    if (diagnosticsOpen) {
      findings.push({ name: `${viewportName}-diagnostics`, route: targetUrl, status: "diagnostics-open-by-default" });
    }
  }

  findings.push(...await collectLayoutFindings(page, `${viewportName}-expanded`));
  await captureElementScreenshot(page, spine, artifacts, `${viewportName}-expanded.png`);
}

async function writeResults(status, payload) {
  await writeFile(
    path.join(outDir, "qa-results.json"),
    `${JSON.stringify({
      status,
      baseUrl,
      checkedAt: new Date().toISOString(),
      ...payload,
    }, null, 2)}\n`,
  );
}

async function main() {
  await mkdir(outDir, { recursive: true });

  let browser;
  const consoleErrors = [];
  const findings = [];
  const routeResults = [];
  const artifacts = [];
  let health = null;
  let loginResult = null;
  let targetUrl = explicitMeetingUrl ? new URL(explicitMeetingUrl, baseUrl).href : null;

  try {
    browser = await chromium.launch();
    const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
    page.setDefaultNavigationTimeout(navigationTimeoutMs);
    page.on("console", (message) => {
      if (message.type() === "error") {
        consoleErrors.push(cleanConsoleMessage(message));
      }
    });
    page.on("pageerror", (error) => {
      consoleErrors.push({ type: "pageerror", text: error.message });
    });

    health = await verifyHealth(page.request);
    loginResult = await login(page);
    await suppressDemoTour(page, loginResult.workspaceId);
    targetUrl = targetUrl ?? await resolveMeetingTarget(page, loginResult.workspaceId);

    for (const [viewportName, viewport] of viewports) {
      await verifyViewport(page, targetUrl, viewportName, viewport, findings, routeResults, artifacts);
    }

    await writeResults("completed", { health, login: loginResult, targetUrl, routeResults, findings, consoleErrors, artifacts });
    if (findings.length > 0 || consoleErrors.length > 0) {
      throw new Error(`Meeting processing spine smoke found ${findings.length} findings and ${consoleErrors.length} console errors.`);
    }
  } catch (error) {
    const fatalError = {
      name: error?.name ?? "Error",
      message: error instanceof Error ? error.message : String(error),
      stack: error instanceof Error ? error.stack : null,
    };
    findings.push({ name: "fatal", route: targetUrl ?? baseUrl, status: "failed", error: fatalError.message });
    if (browser) {
      const pages = browser.contexts().flatMap((context) => context.pages());
      const page = pages[0];
      if (page) {
        await captureScreenshot(page, artifacts, "failure.png").catch(() => null);
      }
    }
    await writeResults("failed", { health, login: loginResult, targetUrl, routeResults, findings, consoleErrors, artifacts, fatalError });
    throw error;
  } finally {
    await browser?.close().catch(() => null);
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    console.error(error);
    process.exitCode = 1;
  });
}
