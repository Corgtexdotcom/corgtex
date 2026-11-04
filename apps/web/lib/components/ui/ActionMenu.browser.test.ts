import { existsSync } from "node:fs";
import { mkdir, readFile } from "node:fs/promises";
import { createServer, type Server } from "node:http";
import { fileURLToPath } from "node:url";
import type { Browser, Page } from "playwright";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

// Real production components/React and native Chromium interactions; synthetic data,
// real application CSS, loopback only. Explicit opt-in follows existing browser QA.
describe.runIf(process.env.SHARED_INTERACTIONS_BROWSER_QA === "1")("ActionMenu browser interactions", () => {
  let browser: Browser;
  let server: Server;
  let page: Page;
  let origin: string;
  const errors: string[] = [];
  beforeAll(async () => {
    await mkdir(new URL("../../../../../.artifacts/shared-interactions/", import.meta.url), { recursive: true });
    const { build } = await import("esbuild");
    const { chromium } = await import("playwright");
    const webRoot = new URL("../../../", import.meta.url);
    const messages = JSON.parse(await readFile(new URL("messages/en.json", webRoot), "utf8"));
    const bundle = await build({
      stdin: { resolveDir: fileURLToPath(webRoot), loader: "tsx", contents: `
        import React, { useState } from "react";
        import { createRoot } from "react-dom/client";
        import { NextIntlClientProvider } from "next-intl";
        import { Dialog } from "./lib/components/Dialog";
        import { ActionMenu } from "./lib/components/ui/ActionMenu";
        import { WorkspaceSwitcher } from "./app/[locale]/workspaces/[workspaceId]/WorkspaceSwitcher";
        const fixture = window.fixture = { submissions: 0, closes: 0 };
        const workspaces = ["Sample A", "Sample B"].map((name, i) => ({ id: "sample-" + i, name, slug: name, primaryName: name, secondaryLabel: "Synthetic" }));
        function Fixture() {
 const [dialog, setDialog] = useState(false), [mounted, setMounted] = useState(true);
 fixture.unmount = () => setMounted(false);
 if (location.search.includes("switcher")) return <><button>Open</button><WorkspaceSwitcher workspaceId="sample-0" workspaces={workspaces} mobile={innerWidth < 720} /></>;
 return <><button id="outside">Open</button><button onClick={() => setDialog(true)}>Show dialog</button>
 {mounted && <ActionMenu label="Menu">{close => <>
 <button disabled>Disabled</button><button id="first">First</button><button style={{ display: "none" }}>Hidden</button>
 <button aria-disabled="true" id="aria-disabled">Unavailable</button>
 <button id="last" onClick={close}>Last</button>
 <ActionMenu label="Nested"><button id="nested-first">Nested first</button><button>Nested last</button><a href="#synthetic">Nested link</a></ActionMenu>
 <form onSubmit={e => { e.preventDefault(); fixture.submissions++; }}><input required aria-label="Required" /><button>Save</button></form>
 </>}</ActionMenu>}
 <Dialog open={dialog} onClose={() => setDialog(false)} title="Container"><ActionMenu label="Modal menu"><button id="modal-action">Modal action</button></ActionMenu></Dialog>
 <ActionMenu label="Form popover" panelRole="dialog"><details><summary id="popover-summary">Edit fields</summary><input id="popover-first" aria-label="First field" /><input id="popover-second" aria-label="Second field" /></details></ActionMenu>
 </>;
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
  it("opens at the last eligible control with ArrowUp", async () => {
    const trigger = page.getByRole("button", { name: "Menu", exact: true });
    await trigger.focus(); await trigger.press("ArrowUp"); await settled();
    expect(await page.getByRole("button", { name: "Save", exact: true }).evaluate(node => document.activeElement === node)).toBe(true);
  });
  it("opens with keyboard and skips disabled/hidden controls during navigation", async () => {
    const trigger = page.getByRole("button", { name: "Menu", exact: true });
    await trigger.focus(); await page.keyboard.press("ArrowDown"); await settled();
    expect(await focused("#first")).toBe(true);
    await page.keyboard.press("ArrowDown");
    expect(await focused("#last")).toBe(true);
    await page.keyboard.press("Home"); expect(await focused("#first")).toBe(true);
    await page.keyboard.press("Escape"); expect(await trigger.getAttribute("aria-expanded")).toBe("false");
    expect(await trigger.evaluate(node => document.activeElement === node)).toBe(true);
    await trigger.press("ArrowUp"); await settled();
    expect(await page.getByRole("button", { name: "Save", exact: true }).evaluate(node => document.activeElement === node)).toBe(true);
  });
  it("keeps a nested menu and its parent open, then Escape closes only the child", async () => {
    await page.getByRole("button", { name: "Menu", exact: true }).click(); await settled();
    await page.getByRole("button", { name: "Nested", exact: true }).click(); await settled();
    expect(await page.locator(".action-menu-panel").count()).toBe(2);
    expect(await focused("#nested-first")).toBe(true);
    await page.keyboard.press("ArrowDown"); expect(await page.getByRole("button", { name: "Nested last", exact: true }).evaluate(node => document.activeElement === node)).toBe(true);
    await page.keyboard.press("Escape"); await settled();
    expect(await page.locator(".action-menu-panel").count()).toBe(1);
    expect(await page.getByRole("button", { name: "Nested", exact: true }).evaluate(node => document.activeElement === node)).toBe(true);
    await page.keyboard.press("Escape"); expect(await page.locator(".action-menu-panel").count()).toBe(0);
  });
  it("closes only the nested panel after its link is selected", async () => {
    await page.getByRole("button", { name: "Menu", exact: true }).click(); await settled();
    await page.getByRole("button", { name: "Nested", exact: true }).click(); await settled();
    await page.getByRole("link", { name: "Nested link" }).click(); await settled();
    expect(await page.locator(".action-menu-panel").count()).toBe(1);
    expect(await page.getByRole("button", { name: "Nested", exact: true }).evaluate(node => document.activeElement === node)).toBe(true);
  });
  for (const width of [1200, 390]) {
    it(`smokes the unchanged WorkspaceSwitcher at ${width}px without navigation`, async () => {
      await page.setViewportSize({ width, height: 844 }); await page.goto(origin + "/?switcher");
      await page.locator(".workspace-switcher-trigger").click(); await settled();
      expect(await page.locator(".workspace-switcher-option").count()).toBe(2);
      await page.locator('.workspace-switcher-option[aria-current="true"]').click(); await settled();
      expect(await page.locator("dialog[open], .action-menu-panel").count()).toBe(0);
      expect(page.url()).toBe(origin + "/?switcher");
      expect(await focused(".workspace-switcher-trigger")).toBe(true);
    });
    it(`keeps a menu interactive inside a native modal at ${width}px`, async () => {
      await page.setViewportSize({ width, height: 844 });
      await page.getByRole("button", { name: "Show dialog" }).click();
      await page.getByRole("button", { name: "Modal menu", exact: true }).click(); await settled();
      expect(await focused("#modal-action")).toBe(true);
      await page.screenshot({ path: fileURLToPath(new URL(`../../../../../.artifacts/shared-interactions/menu-modal-${width}.png`, import.meta.url)) });
      await page.locator("#modal-action").click();
      await page.keyboard.press("Escape"); await settled();
      expect(await page.locator(".action-menu-panel").count()).toBe(0);
      expect(await page.locator("dialog[open]").count()).toBe(1);
      await page.keyboard.press("Escape"); await settled();
      expect(await page.locator("dialog[open]").count()).toBe(0);
    });
  }
  it("preserves native form validation and input arrow keys, then closes after valid submit", async () => {
    await page.getByRole("button", { name: "Menu", exact: true }).click(); await settled();
    await page.getByRole("button", { name: "Save", exact: true }).click();
    expect(await focused("input")).toBe(true);
    expect(await page.locator(".action-menu-panel").count()).toBe(1);
    await page.getByRole("textbox").fill("Valid"); await page.keyboard.press("Home");
    expect(await focused("input")).toBe(true);
    await page.getByRole("button", { name: "Save", exact: true }).click(); await settled();
    expect(await page.locator(".action-menu-panel").count()).toBe(0);
    expect(await page.evaluate(() => (window as unknown as { fixture: { submissions: number } }).fixture.submissions)).toBe(1);
  });
  it("supports repeated open/close, outside focus and open unmount without stale listeners", async () => {
    for (let i = 0; i < 3; i++) {
      await page.getByRole("button", { name: "Menu", exact: true }).click(); await settled();
      await page.locator("#outside").click();
      expect(await page.locator(".action-menu-panel").count()).toBe(0);
      expect(await focused("#outside")).toBe(true);
    }
    await page.getByRole("button", { name: "Menu", exact: true }).click(); await settled();
    await page.locator("#outside").tap();
    expect(await page.locator(".action-menu-panel").count()).toBe(0);
    await page.getByRole("button", { name: "Menu", exact: true }).click(); await settled();
    await page.evaluate(() => (window as unknown as { fixture: { unmount: () => void } }).fixture.unmount());
    await settled(); await page.locator("#outside").focus(); await page.keyboard.press("Escape");
    expect(await focused("#outside")).toBe(true);
    expect(await page.locator(".action-menu-panel").count()).toBe(0);
  });
  it("Tab exits nested menus from the outer trigger's position in both directions", async () => {
    for (const key of ["Tab", "Shift+Tab"]) {
      await page.getByRole("button", { name: "Menu", exact: true }).click(); await settled();
      await page.getByRole("button", { name: "Nested", exact: true }).click(); await settled();
      await page.keyboard.press(key); await settled();
      expect(await page.locator(".action-menu-panel").count()).toBe(0);
      const destination = key === "Tab" ? "Form popover" : "Show dialog";
      expect(await page.getByRole("button", { name: destination, exact: true }).evaluate(node => document.activeElement === node)).toBe(true);
    }
  });
  it("preserves sequential navigation within a dialog-role popover", async () => {
    await page.getByRole("button", { name: "Form popover", exact: true }).click(); await settled();
    expect(await focused("#popover-summary")).toBe(true);
    await page.keyboard.press("Space"); await page.keyboard.press("Tab");
    expect(await focused("#popover-first")).toBe(true);
    await page.keyboard.press("Tab"); await settled();
    expect(await focused("#popover-second")).toBe(true);
    expect(await page.locator('.action-menu-panel[role="dialog"]').count()).toBe(1);
    await page.keyboard.press("Shift+Tab"); expect(await focused("#popover-first")).toBe(true);
  });
});
