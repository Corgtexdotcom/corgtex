import { existsSync } from "node:fs";
import { mkdir, readFile } from "node:fs/promises";
import { createServer, type Server } from "node:http";
import { fileURLToPath } from "node:url";
import type { Browser, Page } from "playwright";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

// Real production components/React and native Chromium interactions; synthetic data,
// real application CSS, loopback only. Explicit opt-in follows existing browser QA.
describe.runIf(process.env.SHARED_INTERACTIONS_BROWSER_QA === "1")("Dialog browser interactions", () => {
  let browser: Browser;
  let server: Server;
  let page: Page;
  let origin: string;
  const errors: string[] = [];
  beforeAll(async () => {
    await mkdir(new URL("../../../../.artifacts/shared-interactions/", import.meta.url), { recursive: true });
    const { build } = await import("esbuild");
    const { chromium } = await import("playwright");
    const webRoot = new URL("../../", import.meta.url);
    const messages = JSON.parse(await readFile(new URL("messages/en.json", webRoot), "utf8"));
    const bundle = await build({
      stdin: { resolveDir: fileURLToPath(webRoot), loader: "tsx", contents: `
        import React, { useState } from "react";
        import { createRoot } from "react-dom/client";
        import { NextIntlClientProvider } from "next-intl";
        import { Dialog } from "./lib/components/Dialog";
        const fixture = window.fixture = { submissions: 0, closes: 0 };
        function Fixture() {
 const [open, setOpen] = useState(false), [child, setChild] = useState(false), [mounted, setMounted] = useState(true);
 fixture.unmount = () => setMounted(false);
 return <><button id="opener" onClick={() => setOpen(true)}>Open</button><button id="outside">Outside</button>
 {mounted && <Dialog open={open} title="Outer" onClose={() => { fixture.closes++; setOpen(false); }}>
 <form onSubmit={e => { e.preventDefault(); fixture.submissions++; }}><input aria-label="Required" required /><button>Submit</button></form>
 <button id="child-opener" onClick={() => setChild(true)}>Open child</button>
 <Dialog open={child} title="Child" onClose={() => setChild(false)}><button>Child action</button></Dialog>
 </Dialog>}</>;
}
        createRoot(document.getElementById("root")).render(
          <NextIntlClientProvider locale="en" timeZone="UTC" messages={${JSON.stringify(messages)}}><Fixture /></NextIntlClientProvider>
        );
      ` },
      alias: { "@": fileURLToPath(webRoot) },
      bundle: true, write: false, jsx: "automatic",
      define: { "process.env.NODE_ENV": '"production"' },
    });
    const css = (await Promise.all(["app/globals.css", "app/styles/components.css"].map(path => readFile(new URL(path, webRoot), "utf8")))).join("\n");
    server = createServer((request, response) => {
      response.setHeader("Content-Type", request.url === "/fixture.js" ? "text/javascript" : "text/html");
      response.end(request.url === "/fixture.js" ? bundle.outputFiles[0].text : `<!doctype html><html><head><style>${css}
        :root{--surface-strong:white;--line:#ccc;--text:#123}body{margin:24px}button,input{padding:8px} .action-menu{display:inline-block}
      </style></head><body><div id="root"></div><script src="/fixture.js"></script></body></html>`);
    });
    await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("Missing port");
    origin = "http://127.0.0.1:" + address.port;
    browser = await chromium.launch({ headless: true, executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH ?? (existsSync("/usr/lib/chromium/chromium") ? "/usr/lib/chromium/chromium" : undefined) });
    const context = await browser.newContext({ hasTouch: true });
    await context.route("**/*", route => route.request().url().startsWith(origin + "/") ? route.continue() : route.abort());
    page = await context.newPage();
    page.setDefaultTimeout(3000);
    page.on("pageerror", error => errors.push(error.message));
  });
  beforeEach(async () => { await page.setViewportSize({ width: 1200, height: 800 }); await page.goto(origin); await page.getByRole("button", { name: "Open", exact: true }).waitFor(); });
  afterAll(async () => {
    await browser?.close();
    if (server) { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); }
    expect(errors).toEqual([]);
  });
  async function focused(selector: string) { return page.locator(selector).evaluate(node => document.activeElement === node); }
  async function settled() { await page.evaluate(() => new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve())))); }
  for (const width of [1200, 390]) {
    it(`keeps dialog padding open and closes only an outside click at ${width}px`, async () => {
      await page.setViewportSize({ width, height: 844 });
      await page.locator("#opener").click();
      const box = await page.locator("dialog[open]").boundingBox();
      if (!box) throw new Error("No dialog");
      await page.screenshot({ path: fileURLToPath(new URL(`../../../../.artifacts/shared-interactions/dialog-${width}.png`, import.meta.url)) });
      await page.mouse.click(box.x + 5, box.y + 5);
      expect(await page.locator("dialog[open]").count()).toBe(1);
      await page.mouse.click(2, 2);
      expect(await page.locator("dialog[open]").count()).toBe(0);
      expect(await focused("#opener")).toBe(true);
    });
  }
  it("supports initial focus, native validation, Escape and repeated return focus", async () => {
    for (let i = 0; i < 3; i++) {
      await page.locator("#opener").click();
      expect(await focused("dialog[open] > .dialog-content > .dialog-header > .dialog-close")).toBe(true);
      await page.getByRole("button", { name: "Submit", exact: true }).click();
      expect(await focused("input")).toBe(true);
      expect(await page.evaluate(() => (window as unknown as { fixture: { submissions: number } }).fixture.submissions)).toBe(i);
      await page.getByRole("textbox").fill("Valid");
      await page.getByRole("button", { name: "Submit", exact: true }).click();
      await page.keyboard.press("Escape"); await settled();
      expect(await page.locator("dialog[open]").count()).toBe(0);
      expect(await focused("#opener")).toBe(true);
      await page.evaluate(() => document.querySelector("form")!.reset());
    }
  });
  it("dismisses only the top nested dialog and restores each opener", async () => {
    await page.locator("#opener").click(); await page.locator("#child-opener").click();
    await page.keyboard.press("Escape"); await settled();
    expect(await page.locator("dialog[open]").count()).toBe(1);
    expect(await focused("#child-opener")).toBe(true);
    await page.keyboard.press("Escape"); await settled();
    expect(await focused("#opener")).toBe(true);
  });
  it("restores focus and removes modal inertness when unmounted open", async () => {
    await page.locator("#opener").click();
    await page.evaluate(() => (window as unknown as { fixture: { unmount: () => void } }).fixture.unmount());
    await settled();
    expect(await focused("#opener")).toBe(true);
    await page.locator("#outside").click();
    expect(await focused("#outside")).toBe(true);
  });
});
