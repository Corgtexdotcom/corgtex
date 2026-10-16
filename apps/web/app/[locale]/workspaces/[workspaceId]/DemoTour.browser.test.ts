import { existsSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { createServer, type Server } from "node:http";
import { fileURLToPath } from "node:url";
import type { Browser, Page } from "playwright";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

type FixtureWindow = typeof window & {
  fixture: {
    navigate: (path: string) => void;
    mount: (mounted: boolean) => void;
    holdNavigation: boolean;
    pendingPath: string | null;
  };
};

// Production tour/banner/Driver.js/CSS, synthetic workspace, loopback only.
// Run with DEMO_TOUR_BROWSER_QA=1 npm run test:unit -- DemoTour.browser.test.ts.
describe.runIf(process.env.DEMO_TOUR_BROWSER_QA === "1")("DemoTour browser lifecycle", () => {
  let browser: Browser;
  let server: Server;
  let page: Page;
  let origin: string;
  const home = "/workspaces/synthetic-tour";
  const key = "corgtex_tour_completed_synthetic-tour";
  const errors: string[] = [];
  const output = new URL("../../../../../../.artifacts/pun-98/", import.meta.url);

  beforeAll(async () => {
    await mkdir(output, { recursive: true });
    const { build } = await import("esbuild");
    const { chromium } = await import("playwright");
    const webRoot = new URL("../../../../", import.meta.url);
    const messages = Object.fromEntries(await Promise.all(["en", "es"].map(async locale =>
      [locale, JSON.parse(await readFile(new URL(`messages/${locale}.json`, webRoot), "utf8"))])));
    const bundle = await build({
      stdin: {
        resolveDir: fileURLToPath(webRoot), loader: "tsx",
        contents: `
          import React, { useState } from "react";
          import { createRoot } from "react-dom/client";
          import { NextIntlClientProvider } from "next-intl";
          import { DemoTour } from "./app/[locale]/workspaces/[workspaceId]/DemoTour";
          import { DemoBanner } from "./app/[locale]/workspaces/[workspaceId]/DemoBanner";
          import { usePathname } from "next/navigation";
          const fixture = window.fixture = { holdNavigation: false, pendingPath: null };
          function Fixture() {
            const [mounted, setMounted] = useState(true);
            const pathname = usePathname();
            fixture.mount = setMounted;
            const locale = pathname.startsWith("/es/") ? "es" : "en";
            const messages = ${JSON.stringify(messages)};
            return <NextIntlClientProvider locale={locale} timeZone="UTC" messages={messages[locale]}>
              <DemoBanner /><main className="ws-main-content"><h1>Synthetic workspace</h1><p>{pathname}</p>
                <button id="page-action">Page action</button></main>
              {mounted && <DemoTour workspaceId="synthetic-tour" />}
            </NextIntlClientProvider>;
          }
          createRoot(document.getElementById("root")).render(<Fixture />);
        `,
      },
      plugins: [{
        name: "synthetic-navigation",
        setup(build) {
          build.onResolve({ filter: /^next\/navigation$/ }, () => ({ path: "navigation", namespace: "fixture" }));
          build.onLoad({ filter: /.*/, namespace: "fixture" }, () => ({
            resolveDir: fileURLToPath(webRoot),
            contents: `
              import { useSyncExternalStore } from "react";
              const listeners = new Set();
              const subscribe = fn => { listeners.add(fn); return () => listeners.delete(fn); };
              const navigate = path => {
                history.pushState({}, "", path);
                listeners.forEach(fn => fn());
              };
              const router = { push(path) {
                const prefix = ["en", "es"].includes(location.pathname.split("/")[1]) ? "/" + location.pathname.split("/")[1] : "";
                const destination = prefix + path;
                window.fixture.pendingPath = destination;
                if (!window.fixture.holdNavigation) navigate(destination);
              } };
              export const useRouter = () => router;
              export const usePathname = () => {
                if (window.fixture) window.fixture.navigate = navigate;
                return useSyncExternalStore(subscribe, () => location.pathname);
              };
            `,
          }));
        },
      }],
      alias: { "@": fileURLToPath(webRoot) },
      outfile: "fixture.js", bundle: true, write: false, jsx: "automatic",
      define: { "process.env.NODE_ENV": '"production"', "process.env.NEXT_PUBLIC_BOOK_DEMO_URL": '""' },
    });
    const css = (await Promise.all(["app/styles/tokens.css", "app/globals.css", "app/styles/components.css"]
      .map(path => readFile(new URL(path, webRoot), "utf8")))).join("\n") + bundle.outputFiles.find(file => file.path.endsWith(".css"))!.text;
    const js = bundle.outputFiles.find(file => file.path.endsWith(".js"))!.text;
    server = createServer((request, response) => {
      response.setHeader("Content-Type", request.url === "/fixture.js" ? "text/javascript" : "text/html; charset=utf-8");
      response.end(request.url === "/fixture.js" ? js : `<!doctype html><html lang="en"><head><title>Synthetic demo tour</title><style>${css}
        body{margin:24px;font-family:Arial}.ws-main-content{min-height:400px;padding:16px}
      </style></head><body><div id="root"></div><script src="/fixture.js"></script></body></html>`);
    });
    await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("Missing fixture port");
    origin = "http://127.0.0.1:" + address.port;
    browser = await chromium.launch({
      headless: true,
      executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH
        ?? (existsSync("/usr/lib/chromium/chromium") ? "/usr/lib/chromium/chromium" : undefined),
    });
    const context = await browser.newContext();
    await context.route("**/*", route => route.request().url().startsWith(origin + "/") ? route.continue() : route.abort());
    page = await context.newPage();
    page.setDefaultTimeout(3000);
    page.on("pageerror", error => errors.push(error.message));
    page.on("console", message => { if (message.type() === "error") errors.push(message.text()); });
  });

  beforeEach(async () => {
    await page.setViewportSize({ width: 1280, height: 800 });
    await page.goto(origin + home);
    await page.evaluate(() => localStorage.clear());
    await page.reload();
  });

  afterAll(async () => {
    await writeFile(new URL("browser-errors.json", output), JSON.stringify(errors, null, 2));
    await browser?.close();
    if (server) { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); }
    expect(errors).toEqual([]);
  });

  async function start() {
    await page.locator(".driver-popover").waitFor();
    await page.waitForTimeout(450); // Driver's highlight animation lasts 400ms.
  }
  async function step(title: string) {
    await expect.poll(() => page.locator(".driver-popover-title").textContent()).toBe(title);
    await page.waitForTimeout(450);
  }
  async function restart() { await page.getByRole("button", { name: "Restart Tour", exact: true }).click(); await start(); }
  async function navigate(path: string) {
    await page.evaluate(path => (window as FixtureWindow).fixture.navigate(path), path);
  }
  async function absent() {
    await page.waitForTimeout(1200);
    expect(await page.locator(".driver-popover, .driver-overlay").count()).toBe(0);
    expect(await page.locator("body.driver-active").count()).toBe(0);
  }

  for (const width of [1280, 390]) {
    it(`remembers Escape across navigation and reload at ${width}px`, async () => {
      await page.setViewportSize({ width, height: 844 });
      await start();
      await page.keyboard.press("Escape");
      expect(await page.evaluate(key => localStorage.getItem(key), key)).toBe("true");
      await navigate(home + "/brain");
      await absent();
      await page.reload();
      await absent();
      await page.locator("#page-action").click();
      if (width === 390) await page.screenshot({ path: fileURLToPath(new URL("mobile-after-escape.png", output)) });
    });
  }

  it("restarts at welcome after Skip, Escape and reload using Enter", async () => {
    await start();
    await page.locator(".driver-popover-close-btn").click();
    for (let i = 0; i < 3; i++) {
      const restart = page.getByRole("button", { name: "Restart Tour", exact: true });
      await restart.focus();
      await restart.press("Enter");
      await start();
      expect(await page.locator(".driver-popover-title").textContent()).toBe("Welcome to Corgtex");
      expect(await page.locator(".driver-popover").count()).toBe(1);
      await page.keyboard.press("Escape");
      if (i === 0) await page.reload();
    }
  });

  it("restarts on locale-prefixed Home without waiting for a pathname change", async () => {
    await page.goto(origin + "/en" + home);
    await start();
    await page.locator(".driver-popover-close-btn").click();
    await restart();
    expect(new URL(page.url()).pathname).toBe("/en" + home);
    expect(await page.locator(".driver-popover-title").textContent()).toBe("Welcome to Corgtex");
  });

  for (const width of [1280, 390]) for (const dark of [false, true]) {
    it(`keeps keyboard Next readable at ${width}px in ${dark ? "dark" : "light"} theme`, async () => {
      await page.setViewportSize({ width, height: 844 });
      if (dark) await page.evaluate(() => document.documentElement.classList.add("dark"));
      await start();
      await page.keyboard.press("Tab");
      const next = page.locator(".driver-popover-next-btn");
      expect(await next.evaluate(node => document.activeElement === node)).toBe(true);
      await page.waitForTimeout(250);
      const style = await next.evaluate(node => {
        const s = getComputedStyle(node);
        return { background: s.backgroundColor, color: s.color, outline: s.outlineStyle, width: s.outlineWidth };
      });
      await page.screenshot({ path: fileURLToPath(new URL(`keyboard-next-${width}-${dark ? "dark" : "light"}.png`, output)) });
      expect(style.background).toBe(dark ? "rgb(94, 234, 212)" : "rgb(15, 118, 110)");
      expect(style.color).toBe(dark ? "rgb(4, 47, 46)" : "rgb(255, 255, 255)");
      expect(style.outline).toBe("solid");
      expect(style.width).toBe("2px");
      await page.keyboard.press("Tab");
      const skip = page.getByRole("button", { name: "Skip", exact: true });
      expect(await skip.evaluate(node => document.activeElement === node)).toBe(true);
      await page.keyboard.press("Enter");
      await absent();
    });
  }

  for (const [locale, label] of [["en", "Skip"], ["es", "Omitir"]]) {
    it(`names Skip consistently with visible ${locale} text and supports Space`, async () => {
      await page.goto(origin + "/" + locale + home);
      await start();
      const skip = page.getByRole("button", { name: label, exact: true });
      expect(await skip.textContent()).toBe(label);
      await skip.focus();
      await skip.press("Space");
      await absent();
      expect(await page.evaluate(key => localStorage.getItem(key), key)).toBe("true");
    });
  }

  it("navigates forward and back with the keyboard and finishes in the existing briefing Dialog", async () => {
    await page.goto(origin + "/en" + home);
    await start();
    await page.locator(".driver-popover-next-btn").press("Enter");
    await step("Your Daily Newspaper");
    expect(new URL(page.url()).pathname).toBe("/en" + home);
    await page.keyboard.press("ArrowRight");
    await step("Organizational Memory");
    expect(new URL(page.url()).pathname).toBe("/en" + home + "/brain");
    expect(await page.evaluate(key => localStorage.getItem(key), key)).toBe(null);
    await page.keyboard.press("ArrowLeft");
    await step("Your Daily Newspaper");
    for (const title of ["Organizational Memory", "Structure Without Hierarchy", "Consent-Based Decisions", "Sample Meetings", "Your Turn to Explore"]) {
      await page.locator(".driver-popover-next-btn").press("Enter");
      await step(title);
    }
    await page.getByRole("button", { name: "Done", exact: true }).press("Enter");
    await page.getByRole("dialog", { name: "Want to see this with your organization?" }).waitFor();
    expect(await page.locator(".driver-popover, .driver-overlay").count()).toBe(0);
    expect(await page.evaluate(key => localStorage.getItem(key), key)).toBe("true");
    await page.screenshot({ path: fileURLToPath(new URL("briefing-complete.png", output)) });
    await page.keyboard.press("Escape");
    await absent();
    await restart();
    expect(await page.locator("dialog[open]").count()).toBe(0);
    expect(await page.locator(".driver-popover-title").textContent()).toBe("Welcome to Corgtex");
  });

  it("cancels automatic startup on navigation and unmount", async () => {
    await navigate(home + "/actions");
    await absent();
    await navigate(home);
    await absent();
    await page.reload();
    await page.getByRole("button", { name: "Restart Tour", exact: true }).waitFor();
    await page.evaluate(() => (window as FixtureWindow).fixture.mount(false));
    await absent();
  });

  it("cancels a pending automatic start and repeated starts cannot reset a later step", async () => {
    await page.getByRole("button", { name: "Restart Tour", exact: true }).waitFor();
    await page.evaluate(() => {
      for (let i = 0; i < 3; i++) window.dispatchEvent(new CustomEvent("corgtex:restart-tour"));
    });
    await start();
    await page.locator(".driver-popover-next-btn").press("Enter");
    await step("Your Daily Newspaper");
    await page.waitForTimeout(1200);
    expect(await page.locator(".driver-popover").count()).toBe(1);
    expect(await page.locator(".driver-popover-title").textContent()).toBe("Your Daily Newspaper");
    await page.evaluate(() => (window as FixtureWindow).fixture.mount(false));
    await absent();
    await page.locator("#page-action").click();
  });

  it("lets Escape cancel a tour while its route transition is pending", async () => {
    await start();
    await page.locator(".driver-popover-next-btn").click();
    await step("Your Daily Newspaper");
    await page.evaluate(() => { (window as FixtureWindow).fixture.holdNavigation = true; });
    await page.locator(".driver-popover-next-btn").click();
    expect(await page.locator(".driver-overlay").count()).toBe(0);
    await page.keyboard.press("Escape");
    await navigate(home + "/brain");
    await absent();
    expect(await page.evaluate(key => localStorage.getItem(key), key)).toBe("true");
  });

  for (const dismiss of [false, true]) it(`supersedes pending Next navigation on Restart${dismiss ? " after Escape" : ""}`, async () => {
    await start();
    await page.locator(".driver-popover-next-btn").click();
    await step("Your Daily Newspaper");
    await page.evaluate(() => { (window as FixtureWindow).fixture.holdNavigation = true; });
    await page.locator(".driver-popover-next-btn").click();
    expect(await page.evaluate(() => (window as FixtureWindow).fixture.pendingPath)).toBe(home + "/brain");
    if (dismiss) await page.keyboard.press("Escape");
    await restart();
    expect(await page.evaluate(() => (window as FixtureWindow).fixture.pendingPath)).toBe(home);
    await page.evaluate(() => {
      const fixture = (window as FixtureWindow).fixture;
      fixture.navigate(fixture.pendingPath!);
    });
    await step("Welcome to Corgtex");
    expect(await page.locator(".driver-popover").count()).toBe(1);
    expect(new URL(page.url()).pathname).toBe(home);
  });

  it("restarts while a destination is settling without reviving the old step", async () => {
    await start();
    await page.locator(".driver-popover-next-btn").click();
    await step("Your Daily Newspaper");
    await page.locator(".driver-popover-next-btn").click();
    await expect.poll(() => new URL(page.url()).pathname).toBe(home + "/brain");
    await restart();
    await page.waitForTimeout(700);
    expect(await page.locator(".driver-popover-title").textContent()).toBe("Welcome to Corgtex");
    expect(await page.locator(".driver-popover").count()).toBe(1);
    expect(new URL(page.url()).pathname).toBe(home);
  });

  it("cancels delayed route continuation on unrelated navigation or unmount", async () => {
    await start();
    await page.locator(".driver-popover-next-btn").click();
    await step("Your Daily Newspaper");
    await page.locator(".driver-popover-next-btn").click();
    await expect.poll(() => new URL(page.url()).pathname).toBe(home + "/brain");
    await navigate(home + "/actions");
    await absent();
    await navigate(home + "/brain");
    await absent();
    await restart();
    await page.locator(".driver-popover-next-btn").click();
    await step("Your Daily Newspaper");
    await page.locator(".driver-popover-next-btn").click();
    await expect.poll(() => new URL(page.url()).pathname).toBe(home + "/brain");
    await page.evaluate(() => (window as FixtureWindow).fixture.mount(false));
    await absent();
  });

  it("leaves Maps unblocked and can explicitly restart from another route", async () => {
    await page.goto(origin + "/en" + home + "/maps");
    await absent();
    await restart();
    expect(new URL(page.url()).pathname).toBe("/en" + home);
    expect(await page.locator(".driver-popover-title").textContent()).toBe("Welcome to Corgtex");
    await page.mouse.click(2, 2);
    await absent();
    expect(await page.evaluate(key => localStorage.getItem(key), key)).toBe("true");
  });
});
