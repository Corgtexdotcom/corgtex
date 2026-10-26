import { existsSync } from "node:fs";
import { mkdir, readFile } from "node:fs/promises";
import { createServer, type Server } from "node:http";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { Browser, Page } from "playwright";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";

type FixtureWindow = Window & {
  mobileShellFixture: { navigate: (path: string) => void; setMounted: (mounted: boolean) => void };
};

// Production shell, primitives, nav registry, translations and compiled application CSS.
// Only Next routing and utility content are synthetic; the browser can reach loopback only.
// Opt in with MOBILE_SHELL_BROWSER_QA=1. MOBILE_SHELL_FONT_DIR optionally supplies
// local inter-400.ttf / inter-700.ttf; no fonts or other assets are fetched externally.
describe.runIf(process.env.MOBILE_SHELL_BROWSER_QA === "1")("mobile workspace shell browser interactions", () => {
  let browser: Browser;
  let server: Server;
  let origin: string;
  let page: Page;
  let errors: string[];
  let unexpectedRequests: string[];
  const artifacts = fileURLToPath(new URL(`../../../../../../.artifacts/pun99-fixed/${Date.now()}/`, import.meta.url));
  const more = () => page.locator('.mobile-bottom-nav button[aria-controls="mobile-more-menu"]');
  const panel = () => page.locator("#mobile-more-menu");
  const close = () => panel().locator(":scope > .dialog-content > .dialog-header > .dialog-close");

  beforeAll(async () => {
    const { build } = await import("esbuild");
    const { chromium } = await import("playwright");
    const webRoot = fileURLToPath(new URL("../../../../", import.meta.url));
    const repoRoot = fileURLToPath(new URL("../../../../../../", import.meta.url));
    const messages = await Promise.all(["en", "es"].map(async locale =>
      JSON.parse(await readFile(resolve(webRoot, "messages", locale + ".json"), "utf8")),
    ));
    const bundle = await build({
      stdin: { loader: "tsx", resolveDir: webRoot, contents: `
        import React, { useState } from "react";
        import { createRoot } from "react-dom/client";
        import { NextIntlClientProvider } from "next-intl";
        import { usePathname } from "next/navigation";
        import { MobileWorkspaceShell } from "./app/[locale]/workspaces/[workspaceId]/MobileWorkspaceShell";
        import { Dialog } from "./lib/components/Dialog";
        import { WORKSPACE_NAV_GROUPS } from "./lib/nav-config";
        const fixture = window.mobileShellFixture = {
          navigate(path) { history.pushState({}, "", path); window.dispatchEvent(new Event("fixture-route")); }
        };
        const workspaces = ["Sample A", "Sample B"].map((name, i) => ({
          id: "sample-" + i, name, slug: "sample-" + i, primaryName: name, secondaryLabel: "Synthetic QA"
        }));
        function Utilities({workspaceId}) {
          const [open, setOpen] = useState(false);
          return <><a className="mobile-utility-action" href={"/workspaces/" + workspaceId + "/settings?tab=user"}>User settings</a>
            <button id="utility-opener" className="mobile-utility-action" onClick={() => setOpen(true)}>Synthetic utility</button>
            <Dialog open={open} onClose={() => setOpen(false)} title="Utility">
              <input aria-label="Utility input"/><button id="utility-last" onClick={() => setOpen(false)}>Finish utility</button>
            </Dialog></>;
        }
        function Fixture() {
          const [mounted, setMounted] = useState(true);
          fixture.setMounted = setMounted;
          const pathname = usePathname();
          const workspaceId = pathname.match(/workspaces\\/(sample-[01])/)?.[1] ?? "sample-0";
          const filtered = new URLSearchParams(location.search).has("filtered");
          const navGroups = filtered ? WORKSPACE_NAV_GROUPS.map(group => ({...group, items: group.items.filter(item =>
            !["tensions", "actions", "notifications"].includes(item.moduleKey))})).filter(group => group.items.length) : WORKSPACE_NAV_GROUPS;
          return <div className="ws-layout">
            {mounted && <MobileWorkspaceShell key={workspaceId} workspaceId={workspaceId} workspaces={workspaces}
              navGroups={navGroups} unreadCount={4} conversations={[]} captureActions={[]} readOnly
              aiWorkspaceState={{providers: [], connections: [], activeProviderKey: null}}
              utilityActions={<Utilities workspaceId={workspaceId}/>}/>}
            <aside className="ws-sidebar">Synthetic desktop sidebar</aside>
            <main className="ws-main"><div className="ws-main-content"><h1>Synthetic workspace</h1>
              <button id="page-action">Background action</button></div></main>
          </div>;
        }
        const locale = location.pathname.startsWith("/es/") ? "es" : "en";
        document.documentElement.lang = locale;
        const messages = ${JSON.stringify(messages)}[locale === "es" ? 1 : 0];
        createRoot(document.getElementById("root")).render(
          <NextIntlClientProvider locale={locale} timeZone="UTC" messages={messages}><Fixture/></NextIntlClientProvider>
        );
      ` },
      alias: { "@": webRoot, "@corgtex/domain/modules": resolve(repoRoot, "packages/domain/src/modules/index.ts") },
      bundle: true, write: false, format: "esm", jsx: "automatic",
      define: { "process.env.NODE_ENV": '"production"' },
      plugins: [{ name: "mobile-shell-navigation-fixture", setup(api) {
        api.onResolve({ filter: /^next\/navigation$/ }, () => ({ path: "navigation", namespace: "fixture" }));
        api.onLoad({ filter: /.*/, namespace: "fixture" }, () => ({ resolveDir: webRoot, contents: `
          import { useSyncExternalStore } from "react";
          const subscribe = notify => { window.addEventListener("fixture-route", notify); return () => window.removeEventListener("fixture-route", notify); };
          export const usePathname = () => useSyncExternalStore(subscribe, () => location.pathname);
          export const useSearchParams = () => new URLSearchParams(useSyncExternalStore(subscribe, () => location.search));
          export const useRouter = () => ({ push: path => window.mobileShellFixture.navigate(path), replace: path => window.mobileShellFixture.navigate(path), refresh() {} });
        ` }));
      } }],
    });
    const globalCss = await readFile(resolve(webRoot, "app/globals.css"), "utf8");
    const styles = await build({
      stdin: { loader: "css", resolveDir: resolve(webRoot, "app"), contents:
        `${(globalCss.match(/^@import .*;$/gm) ?? []).join("\n")}\n${globalCss.replace(/^@import .*;$/gm, "")}` },
      bundle: true, write: false,
    });
    const { default: postcss } = await import("postcss");
    const { default: tailwindcss } = await import("tailwindcss");
    let css = (await postcss([tailwindcss(resolve(webRoot, "tailwind.config.ts"))])
      .process(styles.outputFiles[0].text, { from: undefined })).css;
    const fonts = new Map<string, Buffer>();
    if (process.env.MOBILE_SHELL_FONT_DIR) {
      for (const weight of [400, 700]) {
        const path = `/inter-${weight}.ttf`;
        fonts.set(path, await readFile(resolve(process.env.MOBILE_SHELL_FONT_DIR, `inter-${weight}.ttf`)));
        css += `\n@font-face{font-family:Inter; font-style:normal;font-weight:${weight};src:url(${path})}`;
      }
      css += "\n:root{--font-inter:Inter}";
    } else {
      css += "\n:root{--font-inter:system-ui}";
    }
    server = createServer((request, response) => {
      if (fonts.has(request.url ?? "")) {
        response.setHeader("Content-Type", "font/ttf"); response.end(fonts.get(request.url!)); return;
      }
      if (request.url === "/fixture.css") { response.setHeader("Content-Type", "text/css"); response.end(css); return; }
      if (request.url === "/fixture.js") { response.setHeader("Content-Type", "text/javascript"); response.end(bundle.outputFiles[0].text); return; }
      response.setHeader("Content-Type", "text/html");
      response.end('<!doctype html><html lang="en"><head><meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover"><link rel="stylesheet" href="/fixture.css"></head><body class="font-sans"><div id="root"></div><script type="module" src="/fixture.js"></script></body></html>');
    });
    await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("Missing fixture port");
    origin = `http://127.0.0.1:${address.port}`;
    browser = await chromium.launch({ headless: true, executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH ??
      (existsSync("/usr/lib/chromium/chromium") ? "/usr/lib/chromium/chromium" : undefined) });
    await mkdir(artifacts, { recursive: true });
  });

  async function settled() {
    await page.evaluate(() => new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))));
  }
  async function load(locale = "en", filtered = false) {
    await page.goto(`${origin}/${locale}/workspaces/sample-0${filtered ? "?filtered" : ""}`);
    await more().waitFor(); await page.evaluate(() => document.fonts.ready); await settled();
  }
  async function open() {
    await more().focus(); await page.keyboard.press("Enter"); await panel().waitFor(); await settled();
  }
  async function navigate(path: string) {
    await page.evaluate(path => (window as unknown as FixtureWindow).mobileShellFixture.navigate(path), path); await settled();
  }
  async function focused(selector: string) { return page.locator(selector).evaluate(node => document.activeElement === node); }
  async function capture(name: string) {
    if (process.env.MOBILE_SHELL_CAPTURE === "1") await page.screenshot({ path: resolve(artifacts, name + ".png"), scale: "css" });
  }
  beforeEach(async () => {
    errors = []; unexpectedRequests = [];
    page = await browser.newPage({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true, deviceScaleFactor: 3 });
    page.setDefaultTimeout(3000);
    page.on("pageerror", error => errors.push(error.message));
    await page.route("**/*", route => {
      const url = new URL(route.request().url());
      if (url.origin !== origin || url.pathname.startsWith("/api/")) {
        unexpectedRequests.push(route.request().url()); return route.abort();
      }
      return route.continue();
    });
    await load();
  });
  afterEach(async () => {
    await page?.close(); expect(errors).toEqual([]); expect(unexpectedRequests).toEqual([]);
  });
  afterAll(async () => {
    await browser?.close();
    if (server) { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); }
  });

  it("moves focus inside and returns it after repeated Escape and Close dismissal", async () => {
    for (let cycle = 0; cycle < 3; cycle++) {
      await open(); expect(await focused("#mobile-more-menu > .dialog-content > .dialog-header > .dialog-close")).toBe(true);
      expect(await more().getAttribute("aria-expanded")).toBe("true");
      expect(await more().getAttribute("aria-haspopup")).toBe("dialog");
      expect(await panel().getAttribute("aria-labelledby")).toBeTruthy();
      if (cycle === 0) await capture("more-open-390");
      await page.keyboard.press("Escape"); await settled();
      expect(await panel().count()).toBe(0); expect(await more().evaluate(e => document.activeElement === e)).toBe(true);
      await more().click(); await close().click(); await settled();
      expect(await panel().count()).toBe(0); expect(await more().getAttribute("aria-expanded")).toBe("false");
      expect(await more().evaluate(e => document.activeElement === e)).toBe(true);
    }
  });

  it("keeps Tab, Shift-Tab and programmatic focus away from the background", async () => {
    await open();
    for (const [selector, key] of [["#utility-opener", "Tab"], ["#mobile-more-menu .dialog-close", "Shift+Tab"]]) {
      await page.locator(selector).first().focus();
      // A native modal may yield to browser chrome at an end stop, then re-enter.
      for (let step = 0; step < 2; step++) {
        await page.keyboard.press(key);
        expect(await page.evaluate(() => document.activeElement === document.body || !!document.activeElement?.closest("#mobile-more-menu"))).toBe(true);
      }
    }
    await page.locator("#page-action").evaluate(e => (e as HTMLElement).focus());
    expect(await focused("#page-action")).toBe(false);
    expect(await more().evaluate(e => document.activeElement === e)).toBe(false);
  });

  it("dismisses the nested utility first and restores each opener", async () => {
    await open(); await page.locator("#utility-opener").click(); await settled();
    expect(await page.locator("dialog[open]").count()).toBe(2);
    expect(await panel().locator("dialog[open] .dialog-close").evaluate(e => document.activeElement === e)).toBe(true);
    await page.keyboard.press("Escape"); await settled();
    expect(await page.locator("dialog[open]").count()).toBe(1); expect(await focused("#utility-opener")).toBe(true);
    await page.keyboard.press("Escape"); await settled();
    expect(await page.locator("dialog[open]").count()).toBe(0); expect(await more().evaluate(e => document.activeElement === e)).toBe(true);
    await open(); await page.locator("#utility-opener").click(); await navigate("/en/workspaces/sample-0/goals");
    expect(await page.locator("dialog[open]").count()).toBe(0);
    await page.locator("#page-action").click(); expect(await focused("#page-action")).toBe(true);
  });

  it("keeps interior padding open and dismisses a backdrop click", async () => {
    await open(); const box = await panel().boundingBox();
    if (!box) throw new Error("Missing More dialog bounds");
    await page.mouse.click(box.x + 5, box.y + 5); expect(await panel().count()).toBe(1);
    await page.mouse.click(2, 2); await settled();
    expect(await panel().count()).toBe(0); expect(await more().evaluate(e => document.activeElement === e)).toBe(true);
  });

  for (const height of [844, 390]) it(`scrolls to the final navigation and utility controls at 390x${height}`, async () => {
    await page.setViewportSize({ width: 390, height }); await open();
    const scroll = panel().locator(":scope > .dialog-content > .dialog-body");
    expect(await scroll.evaluate(e => e.scrollHeight > e.clientHeight)).toBe(true);
    await page.locator("#utility-opener").scrollIntoViewIfNeeded();
    const last = await page.locator("#utility-opener").boundingBox(), body = await scroll.boundingBox();
    if (!last || !body) throw new Error("Missing scroll bounds");
    expect(last.y).toBeGreaterThanOrEqual(body.y); expect(last.y + last.height).toBeLessThanOrEqual(body.y + body.height + 1);
    expect(await scroll.evaluate(e => e.scrollTop)).toBeGreaterThan(0);
    await capture("more-scrolled-" + height);
    const link = panel().locator(".mobile-more-link").last(), href = await link.getAttribute("href");
    await link.click(); await page.waitForURL(origin + href); await more().waitFor();
    expect(await page.locator("dialog[open]").count()).toBe(0);
  });

  it("closes for same-route selection and route changes, including focused Action routes", async () => {
    await navigate("/workspaces/sample-0/settings"); await open();
    const link = panel().locator('a[href="/workspaces/sample-0/settings"]');
    await link.evaluate(e => e.addEventListener("click", event => event.preventDefault(), { once: true }));
    await link.click(); await settled(); expect(await panel().count()).toBe(0);
    expect(await more().evaluate(e => document.activeElement === e)).toBe(true);
    await open(); await navigate("/en/workspaces/sample-0/goals"); expect(await panel().count()).toBe(0);
    await open(); await navigate("/en/workspaces/sample-0/actions/synthetic-action");
    expect(await panel().count()).toBe(0); expect(await more().count()).toBe(0);
    await page.locator("#page-action").click(); expect(await focused("#page-action")).toBe(true);
    await navigate("/en/workspaces/sample-0/add?kind=action"); expect(await more().count()).toBe(0);
    await navigate("/en/workspaces/sample-0/add?kind=tension"); expect(await more().count()).toBe(1);
  });

  it("cleans up open unmounts and workspace replacement without leaving the page inert", async () => {
    await open(); await page.locator("#utility-opener").click();
    await page.evaluate(() => (window as unknown as FixtureWindow).mobileShellFixture.setMounted(false)); await settled();
    expect(await page.locator("dialog[open]").count()).toBe(0);
    await page.locator("#page-action").click(); expect(await focused("#page-action")).toBe(true);
    await page.evaluate(() => (window as unknown as FixtureWindow).mobileShellFixture.setMounted(true)); await settled();
    await open(); await navigate("/en/workspaces/sample-1"); expect(await page.locator("dialog[open]").count()).toBe(0);
    expect(await page.locator(".workspace-switcher-identity").first().textContent()).toContain("Sample B");
    await open(); await close().click(); expect(await more().evaluate(e => document.activeElement === e)).toBe(true);
  });

  it("preserves current, cancelled and confirmed workspace switching after More closes", async () => {
    await open(); await page.keyboard.press("Escape"); await settled();
    const switcher = page.locator(".workspace-switcher-trigger");
    await switcher.click(); await page.keyboard.press("Escape"); await settled();
    expect(await switcher.evaluate(e => document.activeElement === e)).toBe(true);
    await switcher.click(); await page.locator('.workspace-switcher-option[aria-current="true"]').click(); await settled();
    expect(await page.locator("dialog[open]").count()).toBe(0);
    await switcher.click(); page.once("dialog", dialog => dialog.dismiss());
    await page.locator(".workspace-switcher-option").filter({ hasText: "Sample B" }).click();
    expect(page.url()).toBe(origin + "/en/workspaces/sample-0"); expect(await page.locator("dialog[open]").count()).toBe(1);
    page.once("dialog", dialog => dialog.accept());
    await page.locator(".workspace-switcher-option").filter({ hasText: "Sample B" }).click();
    await page.waitForURL(origin + "/en/workspaces/sample-1"); await more().waitFor();
    expect(await page.locator("dialog[open]").count()).toBe(0); expect(await more().getAttribute("aria-expanded")).toBe("false");
  });

  it("closes the modal and its nested utility on desktop resize without reopening on mobile", async () => {
    await open(); await page.locator("#utility-opener").click();
    await page.setViewportSize({ width: 1200, height: 844 }); await settled();
    expect(await page.locator("dialog[open]").count()).toBe(0); expect(await panel().count()).toBe(0);
    await page.locator("#page-action").click(); expect(await focused("#page-action")).toBe(true);
    await page.setViewportSize({ width: 390, height: 844 }); await settled(); expect(await panel().count()).toBe(0);
    await open(); await close().click(); expect(await more().evaluate(e => document.activeElement === e)).toBe(true);
  });

  for (const locale of ["en", "es"]) it(`fits ${locale} tab labels across mobile widths and filtered navigation`, async () => {
    for (const filtered of [false, true]) for (const width of [320, 360, 375, 390, 414, 430, 720]) {
      await page.setViewportSize({ width, height: 844 }); await load(locale, filtered);
      const labels = await page.locator(".mobile-bottom-nav a > span:not(.mobile-bottom-badge), .mobile-bottom-nav button > span").evaluateAll(nodes => nodes.map(node => ({
        text: node.textContent, client: node.clientWidth, scroll: node.scrollWidth, width: node.parentElement!.getBoundingClientRect().width,
      })));
      for (const label of labels) {
        expect(label.scroll, `${locale} ${width}px ${label.text} filtered=${filtered}`).toBeLessThanOrEqual(label.client);
        expect(label.width, `${locale} ${width}px ${label.text} filtered=${filtered}`).toBeGreaterThanOrEqual(44);
      }
      expect(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth)).toBe(false);
      if (width === 390 && !filtered) await capture("bottom-labels-" + locale + "-390");
    }
  });
});
