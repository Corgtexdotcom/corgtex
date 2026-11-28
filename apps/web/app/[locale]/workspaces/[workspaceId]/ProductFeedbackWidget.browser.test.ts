import { createServer, type Server } from "node:http";
import { fileURLToPath } from "node:url";
import type { Browser, Page } from "playwright";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";

type CaptureRecord = {
  body: boolean;
  width: number;
  height: number;
  scale: number;
  useCORS: boolean;
  logging: boolean;
  backgroundColor: null;
  scrollX: number;
  scrollY: number;
  x: number;
  y: number;
  excludedWidget: boolean;
  excludedChild: boolean;
  excludedDialogChild: boolean;
  includedContent: boolean;
};
type SubmitOutcome = "success" | "failure" | "network";
type CommitChange = "Escape" | "X" | "backdrop" | "pathname" | "search" | "workspace" | "focused route" | "unmount";
type Fixture = {
  pathname: string;
  search: string;
  workspaceId: string;
  captures: CaptureRecord[];
  toasts: string[];
  mode: "success" | "fail" | "canvas-pending" | "blob-pending";
  resolveCanvas: () => void;
  resolveBlob: () => void;
  resolvePreviousCapture: () => void;
  navigate: (pathname: string, search?: string, workspaceId?: string) => void;
  unmount: () => void;
  holdPost: (outcome: SubmitOutcome) => void;
  postReady: boolean;
  postCount: number;
  completePostDuringCommit: (change: CommitChange) => void;
  postSettledBeforePassive: boolean | null;
  queuedFrames: Array<{ id: number; callback: FrameRequestCallback; canceled: boolean }>;
  holdFrames: () => void;
  runQueuedFrames: () => boolean[];
  restoreFrames: () => void;
  settle: () => Promise<void>;
};
type CaptureResolver = "resolveCanvas" | "resolveBlob";

declare global {
  interface Window {
    __feedbackFixture: Fixture;
  }
}

const engine = `export default async function capture(body, options) {
  const fixture = window.__feedbackFixture;
  fixture.captures.push({
    body: body === document.body,
    width: options.width, height: options.height, scale: options.scale,
    useCORS: options.useCORS, logging: options.logging, backgroundColor: options.backgroundColor,
    scrollX: options.scrollX, scrollY: options.scrollY, x: options.x, y: options.y,
    excludedWidget: options.ignoreElements(document.querySelector('[data-product-feedback-ignore]')),
    excludedChild: options.ignoreElements(document.querySelector('.product-feedback-trigger')),
    excludedDialogChild: options.ignoreElements(document.querySelector('dialog textarea')),
    includedContent: !options.ignoreElements(document.querySelector('#synthetic-content')),
  });
  if (fixture.mode === 'fail') throw new Error('Synthetic render failure');
  if (fixture.mode === 'canvas-pending') await new Promise(resolve => { fixture.resolveCanvas = resolve; });
  return { toBlob(callback, type) {
    const finish = () => callback(new Blob(['synthetic screenshot'], {type}));
    if (fixture.mode === 'blob-pending') fixture.resolveBlob = finish;
    else finish();
  }};
}`;

it("keeps html2canvas behind a dynamic import in the widget dependency graph", async () => {
  const { build } = await import("esbuild");
  const component = fileURLToPath(new URL("./ProductFeedbackWidget.tsx", import.meta.url));
  const result = await build({
    entryPoints: [component], bundle: true, packages: "external", write: false,
    format: "esm", jsx: "automatic", metafile: true,
  });
  const captureImports = Object.values(result.metafile.outputs)
    .flatMap((output) => output.imports).filter((edge) => edge.path === "html2canvas");
  expect(captureImports).toEqual([expect.objectContaining({ kind: "dynamic-import", external: true })]);
});

// Real React effects and shared Dialog, with synthetic browser data and a held capture module.
// Run with PRODUCT_FEEDBACK_BROWSER_QA=1; optionally set PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH.
describe.runIf(process.env.PRODUCT_FEEDBACK_BROWSER_QA === "1")("ProductFeedbackWidget browser lifecycle", () => {
  let browser: Browser;
  let server: Server;
  let origin: string;
  let page: Page;
  let importRequests: number;
  let releaseImport: (status?: number) => void;

  beforeAll(async () => {
    const { build } = await import("esbuild");
    const { chromium } = await import("playwright");
    const component = fileURLToPath(new URL("./ProductFeedbackWidget.tsx", import.meta.url));
    const bundle = await build({
      stdin: {
        contents: `import React, {startTransition, useEffect, useLayoutEffect} from 'react';
          import {createRoot} from 'react-dom/client';
          import {unstable_shouldYield as shouldYield} from 'scheduler';
          import {ProductFeedbackWidget} from ${JSON.stringify(component)};
          const fixture = window.__feedbackFixture = {
            pathname: '/en/workspaces/demo', search: '', workspaceId: 'demo', captures: [], toasts: [], mode: 'success',
          };
          const root = createRoot(document.getElementById('root'));
          let version = 0;
          let widgetMounted = true;
          function FixtureRoot({version}) {
            useLayoutEffect(() => {
              const finishPost = fixture.finishPostOnCommit;
              if (!finishPost) return;
              fixture.finishPostOnCommit = null;
              queueMicrotask(async () => {
                finishPost();
                // Drain the fetch/json/await chain before checking the passive marker.
                for (let i = 0; i < 5; i++) await Promise.resolve();
                fixture.postSettledBeforePassive = fixture.passiveVersion !== version;
              });
              // Make React yield after commit so the microtask runs before passive effects,
              // rather than relying on network delivery or a fixed-duration timing race.
              while (!shouldYield()) {}
            }, [version]);
            useEffect(() => { fixture.passiveVersion = version; }, [version]);
            return widgetMounted ? <ProductFeedbackWidget locale="en" workspaceId={fixture.workspaceId} /> : null;
          }
          const render = () => root.render(<FixtureRoot version={++version} />);
          fixture.navigate = (pathname, search = '', workspaceId = 'demo') => {
            Object.assign(fixture, {pathname, search, workspaceId}); render();
          };
          fixture.unmount = () => root.unmount();
          fixture.holdPost = outcome => {
            const nativeFetch = window.fetch.bind(window);
            fixture.postReady = false;
            fixture.postCount = 0;
            fixture.postSettledBeforePassive = null;
            window.fetch = (url, options) => {
              if (!String(url).endsWith('/product-feedback')) return nativeFetch(url, options);
              fixture.postCount++;
              if (outcome === 'network') return new Promise((resolve, reject) => {
                fixture.finishPost = () => reject(new Error('Old network failure'));
                fixture.postReady = true;
              });
              return Promise.resolve({ok: outcome === 'success', json: () => new Promise(resolve => {
                fixture.finishPost = () => resolve({error: {message: 'Old request failed'}});
                fixture.postReady = true;
              })});
            };
          };
          fixture.completePostDuringCommit = change => {
            fixture.finishPostOnCommit = fixture.finishPost;
            startTransition(() => {
              const dialog = document.querySelector('dialog');
              if (change === 'Escape') dialog.dispatchEvent(new Event('cancel', {bubbles: true, cancelable: true}));
              else if (change === 'X') document.querySelector('.dialog-close').click();
              else if (change === 'backdrop') dialog.dispatchEvent(new MouseEvent('click', {bubbles: true}));
              else if (change === 'unmount') widgetMounted = false;
              else if (change === 'pathname') fixture.pathname = '/en/workspaces/demo/meetings';
              else if (change === 'search') fixture.search = 'tab=other';
              else if (change === 'workspace') fixture.workspaceId = 'other';
              else {
                fixture.pathname = '/en/workspaces/demo/add';
                fixture.search = 'kind=action';
              }
              render();
            });
          };
          const nativeFrame = window.requestAnimationFrame.bind(window);
          const nativeCancelFrame = window.cancelAnimationFrame.bind(window);
          fixture.queuedFrames = [];
          fixture.holdFrames = () => {
            window.requestAnimationFrame = callback => {
              const id = nativeFrame(() => {});
              fixture.queuedFrames.push({id, callback, canceled: false});
              return id;
            };
            window.cancelAnimationFrame = id => {
              const frame = fixture.queuedFrames.find(frame => frame.id === id);
              if (frame) frame.canceled = true;
              nativeCancelFrame(id);
            };
          };
          fixture.runQueuedFrames = () => {
            const frames = fixture.queuedFrames.splice(0);
            // Deliberately invoke canceled callbacks to exercise the session guard too.
            frames.forEach(frame => frame.callback(performance.now()));
            return frames.map(frame => frame.canceled);
          };
          fixture.restoreFrames = () => {
            window.requestAnimationFrame = nativeFrame;
            window.cancelAnimationFrame = nativeCancelFrame;
          };
          fixture.settle = () => new Promise(resolve => nativeFrame(() => nativeFrame(resolve)));
          render();`,
        resolveDir: process.cwd(), loader: "tsx",
      },
      bundle: true, write: false, format: "esm", jsx: "automatic",
      define: { "process.env.NODE_ENV": '"production"' },
      plugins: [{ name: "feedback-browser-fixture", setup(buildApi) {
        buildApi.onResolve({ filter: /^html2canvas$/ }, () => ({ path: "/capture-engine.js", external: true }));
        buildApi.onResolve({ filter: /^(next\/navigation|next-intl|@\/lib\/components\/Toast)$/ }, (args) => ({ path: args.path, namespace: "fixture" }));
        buildApi.onLoad({ filter: /.*/, namespace: "fixture" }, (args) => ({ contents:
          args.path === "next/navigation"
            ? `export const usePathname = () => window.__feedbackFixture.pathname;
               export const useSearchParams = () => new URLSearchParams(window.__feedbackFixture.search);`
            : args.path === "next-intl"
              ? `const translate = (key, values) => key + (values?.number ? ' ' + values.number : ''); export const useTranslations = () => translate;`
              : `const addToast = message => window.__feedbackFixture.toasts.push(message); export const useToast = () => ({addToast});`,
        }));
      } }],
    });
    const js = bundle.outputFiles[0].text;
    server = createServer((request, response) => {
      if (request.url === "/fixture.js") {
        response.setHeader("Content-Type", "text/javascript");
        response.end(js);
        return;
      }
      response.setHeader("Content-Type", "text/html");
      response.end('<!doctype html><html><body><main id="synthetic-content">Synthetic workspace</main><div id="root"></div><script type="module" src="/fixture.js"></script></body></html>');
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("Missing fixture server port");
    origin = `http://127.0.0.1:${address.port}`;
    browser = await chromium.launch({ headless: true, executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH });
  });

  beforeEach(async () => {
    page = await browser.newPage({ viewport: { width: 1100, height: 800 }, deviceScaleFactor: 2 });
    importRequests = 0;
    const importResult = new Promise<number>((resolve) => { releaseImport = (status = 200) => resolve(status); });
    await page.route("**/capture-engine.js", async (route) => {
      importRequests++;
      const status = await importResult;
      await route.fulfill({ status, contentType: "text/javascript", body: status === 200 ? engine : "Synthetic module unavailable" }).catch(() => {});
    });
    await page.goto(origin, { waitUntil: "domcontentloaded" });
  });

  afterEach(async () => {
    releaseImport?.();
    await page?.close();
  });

  afterAll(async () => {
    await browser?.close();
    if (server) await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  async function open() {
    await page.getByRole("button", { name: "open", exact: true }).click();
    await expect.poll(() => importRequests).toBe(1);
  }

  async function releaseModule(status = 200) {
    const response = page.waitForResponse("**/capture-engine.js");
    releaseImport(status);
    await response;
  }

  async function settle() {
    await page.evaluate(() => window.__feedbackFixture.settle());
  }

  async function attach(count = 1) {
    await page.locator('input[type="file"]').setInputFiles(Array.from({ length: count }, (_, index) => ({
      name: `manual-${index}.png`, mimeType: "image/png", buffer: Buffer.from("synthetic manual image"),
    })));
  }

  it("loads on first open, captures once, preserves exclusions and viewport options, and reuses the module for manual capture", async () => {
    await page.getByRole("button", { name: "open", exact: true }).waitFor();
    await settle();
    expect(importRequests).toBe(0);
    await open();
    expect(await page.getByRole("button", { name: "capturing", exact: true }).isDisabled()).toBe(true);
    expect(await page.evaluate(() => window.__feedbackFixture.captures.length)).toBe(0);
    await releaseModule();
    await expect.poll(() => page.getByRole("img").count()).toBe(1);
    expect(await page.evaluate(() => window.__feedbackFixture.captures)).toEqual([{
      body: true, width: 1100, height: 800, scale: 1.5, useCORS: true, logging: false,
      backgroundColor: null, scrollX: -0, scrollY: -0, x: 0, y: 0, excludedWidget: true, excludedChild: true, excludedDialogChild: true, includedContent: true,
    }]);
    await page.getByRole("button", { name: "capture", exact: true }).click();
    await expect.poll(() => page.getByRole("img").count()).toBe(2);
    expect(importRequests).toBe(1);
  });

  it("keeps the draft and manual attachment when import fails, permits submission, and handles cached retry failure", async () => {
    await open();
    await page.getByRole("textbox").fill("Keep this feedback draft");
    await attach();
    await releaseModule(503);
    await expect.poll(() => page.getByRole("alert").textContent()).toBe("captureFailed");
    expect(await page.getByRole("textbox").inputValue()).toBe("Keep this feedback draft");
    expect(await page.getByRole("img").count()).toBe(1);
    expect(await page.getByRole("button", { name: "submit", exact: true }).isEnabled()).toBe(true);
    await page.getByRole("button", { name: "capture", exact: true }).click();
    await expect.poll(() => page.getByRole("alert").textContent()).toBe("captureFailed");
    expect(importRequests).toBe(1); // Native ESM caches failed module fetches for this document.
    expect(await page.getByRole("img").count()).toBe(1);
    await page.route("**/api/workspaces/demo/product-feedback", (route) => route.fulfill({
      status: 200, contentType: "application/json", body: "{}",
    }));
    const submitted = page.waitForRequest("**/api/workspaces/demo/product-feedback");
    await page.getByRole("button", { name: "submit", exact: true }).click();
    const request = await submitted;
    expect(request.method()).toBe("POST");
    expect(request.postData()).toContain("Keep this feedback draft");
    expect(request.postData()).toContain('filename="manual-0.png"');
    await expect.poll(() => page.locator("dialog").evaluate((dialog) => (dialog as HTMLDialogElement).open)).toBe(false);
  });

  it("recovers from a renderer failure through manual retry without losing attachments", async () => {
    await page.evaluate(() => { window.__feedbackFixture.mode = "fail"; });
    await open();
    await attach();
    await releaseModule();
    await expect.poll(() => page.getByRole("alert").textContent()).toBe("captureFailed");
    await page.evaluate(() => { window.__feedbackFixture.mode = "success"; });
    await page.getByRole("button", { name: "capture", exact: true }).click();
    await expect.poll(() => page.getByRole("img").count()).toBe(2);
    expect(await page.getByRole("alert").count()).toBe(0);
    expect(importRequests).toBe(1);
  });

  it("discards a closed session's pending import and captures afresh when reopened", async () => {
    await open();
    await page.getByRole("textbox").fill("Retained draft");
    await attach();
    await page.getByRole("button", { name: "cancel", exact: true }).click();
    await releaseModule();
    await settle();
    expect(await page.evaluate(() => window.__feedbackFixture.captures.length)).toBe(0);
    await page.getByRole("button", { name: "open", exact: true }).click();
    await expect.poll(() => page.getByRole("img").count()).toBe(2);
    expect(await page.getByRole("textbox").inputValue()).toBe("Retained draft");
  });

  it("captures only for the newest session when reopened before the module resolves", async () => {
    await open();
    await page.getByRole("button", { name: "cancel", exact: true }).click();
    await page.getByRole("button", { name: "open", exact: true }).click();
    await expect.poll(() => page.getByRole("button", { name: "capturing", exact: true }).isDisabled()).toBe(true);
    await releaseModule();
    await expect.poll(() => page.getByRole("img").count()).toBe(1);
    expect(await page.evaluate(() => window.__feedbackFixture.captures.length)).toBe(1);
    expect(importRequests).toBe(1);
    expect(await page.getByRole("button", { name: "capture", exact: true }).isEnabled()).toBe(true);
  });

  it.each([
    ["pathname", "/en/workspaces/demo/meetings", "", "demo"],
    ["search parameters", "/en/workspaces/demo", "tab=other", "demo"],
    ["workspace", "/en/workspaces/other", "", "other"],
  ])("discards queued automatic capture after a change to %s and preserves recovery", async (_name, pathname, search, workspaceId) => {
    await page.evaluate(() => window.__feedbackFixture.holdFrames());
    await page.getByRole("button", { name: "open", exact: true }).click();
    await page.getByRole("textbox").fill("Keep draft through navigation");
    await attach();
    await settle();
    expect(await page.evaluate(() => window.__feedbackFixture.queuedFrames.length)).toBeGreaterThan(0);
    expect(importRequests).toBe(0);
    await page.evaluate(([path, query, id]) => window.__feedbackFixture.navigate(path, query, id), [pathname, search, workspaceId]);
    await settle();
    const canceled = await page.evaluate(() => window.__feedbackFixture.runQueuedFrames());
    await settle();
    expect(importRequests).toBe(0);
    expect(await page.evaluate(() => window.__feedbackFixture.captures.length)).toBe(0);
    expect(canceled.every(Boolean)).toBe(true);
    expect(await page.getByRole("textbox").inputValue()).toBe("Keep draft through navigation");
    expect(await page.getByRole("img").count()).toBe(1);
    await page.evaluate(() => window.__feedbackFixture.restoreFrames());
    await page.getByRole("button", { name: "capture", exact: true }).click();
    await expect.poll(() => importRequests).toBe(1);
    await releaseModule();
    await expect.poll(() => page.getByRole("img").count()).toBe(2);
    await page.getByRole("button", { name: "cancel", exact: true }).click();
    await page.getByRole("button", { name: "open", exact: true }).click();
    await expect.poll(() => page.getByRole("img").count()).toBe(3);
    expect(await page.getByRole("textbox").inputValue()).toBe("Keep draft through navigation");
    expect(importRequests).toBe(1);
  });

  it.each([
    ["pathname", "/en/workspaces/demo/meetings", "", "demo"],
    ["search parameters", "/en/workspaces/demo", "tab=other", "demo"],
    ["workspace", "/en/workspaces/other", "", "other"],
    ["focused route", "/en/workspaces/demo/add", "kind=action", "demo"],
  ])("discards import completion after a change to %s", async (_name, pathname, search, workspaceId) => {
    await open();
    await page.evaluate(([path, query, id]) => window.__feedbackFixture.navigate(path, query, id), [pathname, search, workspaceId]);
    await settle();
    await releaseModule();
    await settle();
    expect(await page.evaluate(() => window.__feedbackFixture.captures.length)).toBe(0);
    expect(await page.getByRole("img").count()).toBe(0);
  });

  it("does not render after unmount while the import is pending", async () => {
    await open();
    await page.evaluate(() => window.__feedbackFixture.unmount());
    await releaseModule();
    await settle();
    expect(await page.evaluate(() => window.__feedbackFixture.captures.length)).toBe(0);
  });

  it.each(["canvas-pending", "blob-pending"] as const)("discards %s completion after closing", async (mode) => {
    await page.evaluate((value) => { window.__feedbackFixture.mode = value; }, mode);
    await open();
    await releaseModule();
    await expect.poll(() => page.evaluate(() => window.__feedbackFixture.captures.length)).toBe(1);
    await expect.poll(() => page.evaluate((value) => typeof window.__feedbackFixture[value === "canvas-pending" ? "resolveCanvas" : "resolveBlob"], mode)).toBe("function");
    await page.getByRole("button", { name: "cancel", exact: true }).click();
    await page.evaluate((value) => window.__feedbackFixture[value === "canvas-pending" ? "resolveCanvas" : "resolveBlob"](), mode);
    await settle();
    expect(await page.locator('[role="img"]').count()).toBe(0);
  });

  it.each(["canvas-pending", "blob-pending"] as const)("keeps a newer capture pending when an older %s completes", async (mode) => {
    await page.evaluate((value) => { window.__feedbackFixture.mode = value; }, mode);
    await open();
    await releaseModule();
    const resolver: CaptureResolver = mode === "canvas-pending" ? "resolveCanvas" : "resolveBlob";
    await expect.poll(() => page.evaluate((key: CaptureResolver) => typeof window.__feedbackFixture[key], resolver)).toBe("function");
    await page.evaluate((key: CaptureResolver) => {
      window.__feedbackFixture.resolvePreviousCapture = window.__feedbackFixture[key];
    }, resolver);
    await page.getByRole("button", { name: "cancel", exact: true }).click();
    await page.getByRole("button", { name: "open", exact: true }).click();
    await expect.poll(() => page.evaluate((key: CaptureResolver) => {
      const fixture = window.__feedbackFixture;
      return fixture.captures.length === 2 && fixture[key] !== fixture.resolvePreviousCapture;
    }, resolver)).toBe(true);
    await page.evaluate(() => window.__feedbackFixture.resolvePreviousCapture());
    await settle();
    expect(await page.getByRole("img").count()).toBe(0);
    expect(await page.getByRole("button", { name: "capturing", exact: true }).isDisabled()).toBe(true);
    await page.evaluate((key: CaptureResolver) => window.__feedbackFixture[key](), resolver);
    await expect.poll(() => page.getByRole("img").count()).toBe(1);
    expect(await page.getByRole("button", { name: "capture", exact: true }).isEnabled()).toBe(true);
  });

  for (const width of [1100, 390]) {
    for (const dismissal of ["Escape", "X", "backdrop"]) {
      it.each(["success", "failure", "network"] as const)(`isolates a late %s after ${dismissal} at ${width}px`, async (outcome) => {
        await page.setViewportSize({ width, height: 800 });
        await open();
        await releaseModule();
        await expect.poll(() => page.getByRole("img").count()).toBe(1);
        await page.getByRole("textbox").fill("Request A");
        let release!: () => void;
        const held = new Promise<void>((resolve) => { release = resolve; });
        let posts = 0;
        await page.route("**/api/workspaces/demo/product-feedback", async (route) => {
          posts++;
          await held;
          if (outcome === "network") await route.abort("failed");
          else await route.fulfill({ status: outcome === "success" ? 200 : 503,
            contentType: "application/json", body: JSON.stringify({ error: { message: "Old request failed" } }) });
        });
        await page.getByRole("button", { name: "submit", exact: true }).click();
        await expect.poll(() => posts).toBe(1);
        expect(await page.getByRole("textbox").isDisabled()).toBe(true);
        for (const name of ["capture", "attach", "removeScreenshot 1"]) {
          expect(await page.getByRole("button", { name, exact: true }).isDisabled()).toBe(true);
        }
        expect(await page.getByRole("button", { name: "cancel", exact: true }).isDisabled()).toBe(true);
        if (dismissal === "Escape") await page.keyboard.press("Escape");
        else if (dismissal === "X") await page.getByRole("button", { name: "close", exact: true }).click();
        else await page.locator("dialog").evaluate((dialog) => dialog.dispatchEvent(new MouseEvent("click", { bubbles: true })));
        await page.getByRole("button", { name: "open", exact: true }).click();
        await expect.poll(() => page.getByRole("img").count()).toBe(2);
        expect(await page.getByRole("button", { name: "submitting", exact: true }).isDisabled()).toBe(true);
        // Even a programmatic duplicate submit must respect the transport lock.
        await page.locator("form").evaluate((form) => form.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true })));
        await settle();
        expect(posts).toBe(1);
        release();
        await expect.poll(() => page.getByRole("button", { name: "submit", exact: true }).isEnabled()).toBe(true);
        expect(await page.locator("dialog").evaluate((dialog) => (dialog as HTMLDialogElement).open)).toBe(true);
        expect(await page.getByRole("textbox").inputValue()).toBe("Request A");
        expect(await page.getByRole("img").count()).toBe(2);
        expect(await page.getByRole("alert").count()).toBe(0);
        expect(await page.evaluate(() => window.__feedbackFixture.toasts)).toEqual([]);
        await page.getByRole("textbox").fill("New session remains editable");
        await page.getByRole("button", { name: "removeScreenshot 1", exact: true }).click();
        expect(await page.getByRole("img").count()).toBe(1);
        await page.unroute("**/api/workspaces/demo/product-feedback");
        await page.route("**/api/workspaces/demo/product-feedback", (route) => {
          posts++;
          return route.fulfill({ status: 200, contentType: "application/json", body: "{}" });
        });
        await page.getByRole("button", { name: "submit", exact: true }).click();
        await expect.poll(() => page.locator("dialog").evaluate((dialog) => (dialog as HTMLDialogElement).open)).toBe(false);
        expect(posts).toBe(2);
        expect(await page.evaluate(() => window.__feedbackFixture.toasts)).toEqual(["submitted"]);
        expect(await page.locator("textarea").inputValue()).toBe("");
        expect(await page.locator('[role="img"]').count()).toBe(0);
      });
    }
  }

  for (const change of ["Escape", "X", "backdrop", "pathname", "search", "workspace", "focused route", "unmount"] as const) {
    it.each(["success", "failure", "network"] as const)(`ignores a %s POST between ${change} commit and passive effects`, async (outcome) => {
      await open();
      await releaseModule();
      await expect.poll(() => page.getByRole("img").count()).toBe(1);
      await page.getByRole("textbox").fill("Commit-boundary draft");
      await page.evaluate((value) => window.__feedbackFixture.holdPost(value), outcome);
      await page.getByRole("button", { name: "submit", exact: true }).click();
      await expect.poll(() => page.evaluate(() => window.__feedbackFixture.postReady)).toBe(true);
      await page.evaluate((value) => window.__feedbackFixture.completePostDuringCommit(value), change);
      await expect.poll(() => page.evaluate(() => window.__feedbackFixture.postSettledBeforePassive)).toBe(true);
      await settle();
      expect(await page.evaluate(() => window.__feedbackFixture.postCount)).toBe(1);
      expect(await page.evaluate(() => window.__feedbackFixture.toasts)).toEqual([]);
      if (change === "unmount") {
        expect(await page.locator("#root").textContent()).toBe("");
        return;
      }
      if (["Escape", "X", "backdrop"].includes(change)) {
        await page.getByRole("button", { name: "open", exact: true }).click();
      } else if (change === "focused route") {
        await page.evaluate(() => window.__feedbackFixture.navigate("/en/workspaces/demo"));
      }
      expect(await page.getByRole("textbox").inputValue()).toBe("Commit-boundary draft");
      expect(await page.getByRole("img").count()).toBeGreaterThanOrEqual(1);
      expect(await page.getByRole("alert").count()).toBe(0);
      expect(await page.getByRole("button", { name: "submit", exact: true }).isEnabled()).toBe(true);
    });
  }

  it.each(["pathname", "search", "workspace", "unmount"])("ignores POST completion after %s changes", async (change) => {
    await open();
    await releaseModule();
    await expect.poll(() => page.getByRole("img").count()).toBe(1);
    await page.getByRole("textbox").fill("Navigation draft");
    let release!: () => void;
    const held = new Promise<void>((resolve) => { release = resolve; });
    let received = false;
    await page.route("**/api/workspaces/demo/product-feedback", async (route) => {
      received = true;
      await held;
      await route.fulfill({ status: 200, contentType: "application/json", body: "{}" });
    });
    await page.getByRole("button", { name: "submit", exact: true }).click();
    await expect.poll(() => received).toBe(true);
    await page.evaluate((value) => {
      const fixture = window.__feedbackFixture;
      if (value === "unmount") fixture.unmount();
      else fixture.navigate(value === "pathname" ? "/en/workspaces/demo/meetings" : "/en/workspaces/demo",
        value === "search" ? "tab=other" : "", value === "workspace" ? "other" : "demo");
    }, change);
    await settle();
    release();
    if (change === "unmount") {
      await settle();
      expect(await page.locator("#root").textContent()).toBe("");
    } else {
      await expect.poll(() => page.getByRole("button", { name: "submit", exact: true }).isEnabled()).toBe(true);
      expect(await page.getByRole("textbox").inputValue()).toBe("Navigation draft");
      expect(await page.getByRole("img").count()).toBe(1);
    }
  });

  it.each(["failure", "network"])("shows a current session's %s and permits retry", async (outcome) => {
    await open();
    await releaseModule();
    await expect.poll(() => page.getByRole("img").count()).toBe(1);
    await page.getByRole("textbox").fill("Retry draft");
    await page.route("**/api/workspaces/demo/product-feedback", (route) => outcome === "network"
      ? route.abort("failed")
      : route.fulfill({ status: 503, contentType: "application/json", body: '{"error":{"message":"Current failure"}}' }));
    await page.getByRole("button", { name: "submit", exact: true }).click();
    await expect.poll(() => page.getByRole("alert").count()).toBe(1);
    expect(await page.getByRole("textbox").inputValue()).toBe("Retry draft");
    expect(await page.getByRole("img").count()).toBe(1);
    expect(await page.getByRole("button", { name: "submit", exact: true }).isEnabled()).toBe(true);
    await page.unroute("**/api/workspaces/demo/product-feedback");
    await page.route("**/api/workspaces/demo/product-feedback", (route) => route.fulfill({
      status: 200, contentType: "application/json", body: "{}",
    }));
    await page.getByRole("button", { name: "submit", exact: true }).click();
    await expect.poll(() => page.locator("dialog").evaluate((dialog) => (dialog as HTMLDialogElement).open)).toBe(false);
  });

  it.each(["canvas-pending", "blob-pending"] as const)("preserves a newer %s capture when the old POST finishes", async (mode) => {
    await open();
    await releaseModule();
    await expect.poll(() => page.getByRole("img").count()).toBe(1);
    await page.getByRole("textbox").fill("Held capture draft");
    let release!: () => void;
    const held = new Promise<void>((resolve) => { release = resolve; });
    let received = false;
    await page.route("**/api/workspaces/demo/product-feedback", async (route) => {
      received = true;
      await held;
      await route.fulfill({ status: 200, contentType: "application/json", body: "{}" });
    });
    await page.getByRole("button", { name: "submit", exact: true }).click();
    await expect.poll(() => received).toBe(true);
    await page.keyboard.press("Escape");
    await page.evaluate((value) => { window.__feedbackFixture.mode = value; }, mode);
    await page.getByRole("button", { name: "open", exact: true }).click();
    const resolver: CaptureResolver = mode === "canvas-pending" ? "resolveCanvas" : "resolveBlob";
    await expect.poll(() => page.evaluate((key) => typeof window.__feedbackFixture[key], resolver)).toBe("function");
    release();
    await expect.poll(() => page.getByRole("button", { name: "submit", exact: true }).isEnabled()).toBe(true);
    expect(await page.getByRole("button", { name: "capturing", exact: true }).isDisabled()).toBe(true);
    await page.evaluate((key) => window.__feedbackFixture[key](), resolver);
    await expect.poll(() => page.getByRole("img").count()).toBe(2);
    expect(await page.getByRole("textbox").inputValue()).toBe("Held capture draft");
  });

  it("rejects oversized and unsupported manual files while accepting supported images", async () => {
    await open();
    await page.locator('input[type="file"]').setInputFiles([
      { name: "oversized.png", mimeType: "image/png", buffer: Buffer.alloc(10 * 1024 * 1024 + 1) },
    ]);
    await expect.poll(() => page.getByRole("alert").textContent()).toBe("fileTooLarge");
    expect(await page.getByRole("img").count()).toBe(0);
    await page.locator('input[type="file"]').setInputFiles([
      { name: "unsupported.pdf", mimeType: "application/pdf", buffer: Buffer.from("synthetic") },
    ]);
    await expect.poll(() => page.getByRole("alert").textContent()).toBe("invalidFile");
    expect(await page.getByRole("img").count()).toBe(0);
    await page.locator('input[type="file"]').setInputFiles([
      { name: "valid.jpeg", mimeType: "image/jpeg", buffer: Buffer.from("synthetic") },
      { name: "valid.webp", mimeType: "image/webp", buffer: Buffer.from("synthetic") },
    ]);
    await expect.poll(() => page.getByRole("img").count()).toBe(2);
    await releaseModule();
    await expect.poll(() => page.getByRole("img").count()).toBe(3);
  });

  it("keeps at most five attachments when manual files fill the slots during import", async () => {
    await open();
    await attach(6);
    await expect.poll(() => page.getByRole("img").count()).toBe(5);
    await releaseModule();
    await settle();
    expect(await page.getByRole("img").count()).toBe(5);
    expect(await page.getByRole("button", { name: "attach", exact: true }).isDisabled()).toBe(true);
    expect(await page.getByRole("button", { name: "capture", exact: true }).isDisabled()).toBe(true);
  });
});
