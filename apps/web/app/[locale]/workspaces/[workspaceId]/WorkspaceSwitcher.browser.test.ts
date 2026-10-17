import { readFile } from "node:fs/promises";
import { createServer, type Server } from "node:http";
import { fileURLToPath } from "node:url";
import type { Browser, Page } from "playwright";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";

// Actual component, shared overlays, and translations; synthetic memberships and
// editor state only. No Next server, authentication, or external traffic required.
// Run: WORKSPACE_SWITCHER_BROWSER_QA=1 npx vitest run --project unit WorkspaceSwitcher.browser.test.ts
// Optionally set PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH for a system Chromium.
describe.runIf(process.env.WORKSPACE_SWITCHER_BROWSER_QA === "1")("WorkspaceSwitcher browser navigation", () => {
  let browser: Browser;
  let server: Server;
  let origin: string;
  let page: Page;
  let navigations: string[];
  let warnings: string[];
  let errors: string[];
  const webRoot = new URL("../../../../", import.meta.url);

  beforeAll(async () => {
    const { build } = await import("esbuild");
    const { chromium } = await import("playwright");
    const bundle = await build({
      stdin: {
        resolveDir: fileURLToPath(webRoot), loader: "tsx",
        contents: `
          import React from "react";
          import { createRoot } from "react-dom/client";
          import { NextIntlClientProvider } from "next-intl";
          import en from "./messages/en.json";
          import es from "./messages/es.json";
          import { WorkspaceSwitcher } from "./app/[locale]/workspaces/[workspaceId]/WorkspaceSwitcher";
          const locale = location.pathname.split("/")[1];
          const workspaces = ["a", "b", "c"].map(id => ({
            id: "synthetic-" + id, slug: "synthetic-" + id,
            name: "Synthetic " + id.toUpperCase(), primaryName: "Synthetic " + id.toUpperCase(),
            secondaryLabel: "Synthetic membership",
          }));
          createRoot(document.getElementById("root")).render(
            <NextIntlClientProvider locale={locale} timeZone="UTC" messages={locale === "es" ? es : en}>
              <WorkspaceSwitcher workspaceId="synthetic-a" workspaces={workspaces}
                mobile={new URLSearchParams(location.search).get("mobile") === "1"} />
              <label htmlFor="draft">Draft</label><textarea id="draft" defaultValue="Unsaved synthetic draft" />
              <label htmlFor="editor-selection">Editor selection</label><select id="editor-selection" defaultValue="mine"><option value="mine">Mine</option><option value="all">All</option></select>
            </NextIntlClientProvider>
          );`,
      },
      bundle: true, write: false, jsx: "automatic",
      alias: { "@": fileURLToPath(webRoot) },
      define: { "process.env.NODE_ENV": '"production"' },
    });
    const styles = await Promise.all(["styles/tokens.css", "globals.css", "styles/pages.css", "styles/components.css"].map(async (path) =>
      (await readFile(new URL("app/" + path, webRoot), "utf8")).replace(/@import[^;]+;/g, "")));
    server = createServer((request, response) => {
      if (request.url === "/fixture.js") {
        response.setHeader("Content-Type", "text/javascript");
        response.end(bundle.outputFiles[0].text);
        return;
      }
      response.setHeader("Content-Type", "text/html; charset=utf-8");
      response.end(`<!doctype html><html lang="${request.url?.startsWith("/es/") ? "es" : "en"}"><head><title>Synthetic workspace switcher</title><style>${styles.join("\n")}body{padding:24px}</style></head><body><div id="root"></div><script src="/fixture.js"></script></body></html>`);
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("Missing fixture port");
    origin = `http://127.0.0.1:${address.port}`;
    browser = await chromium.launch({ headless: true, executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH });
  });

  afterEach(async () => {
    await page?.context().close();
    expect(errors).toEqual([]);
  });

  afterAll(async () => {
    await browser?.close();
    if (server) {
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });

  for (const locale of ["en", "es"] as const) {
    for (const mobile of [false, true]) {
      describe(`${locale} ${mobile ? "mobile" : "desktop"}`, () => {
        let source: string;
        let messages: Record<string, string>;

        async function open(acceptWarning = false) {
          messages = JSON.parse(await readFile(new URL(`messages/${locale}.json`, webRoot), "utf8")).workspaceSwitcher;
          navigations = [];
          warnings = [];
          errors = [];
          const context = await browser.newContext({
            viewport: mobile ? { width: 390, height: 844 } : { width: 1280, height: 900 },
            isMobile: mobile, hasTouch: mobile,
          });
          page = await context.newPage();
          page.setDefaultTimeout(5000);
          page.on("pageerror", (error) => errors.push(error.message));
          page.on("console", (message) => { if (message.type() === "error") errors.push(message.text()); });
          page.on("dialog", async (dialog) => {
            warnings.push(dialog.message());
            expect(dialog.type()).toBe("confirm");
            if (acceptWarning) await dialog.accept();
            else await dialog.dismiss();
          });
          source = `${origin}/${locale}/workspaces/synthetic-a/meetings/old-entity?filter=old-workspace&mobile=${Number(mobile)}#old-thread`;
          let departing = false;
          await context.route("**/*", async (route) => {
            const request = route.request();
            if (!request.url().startsWith(origin + "/")) {
              errors.push("Blocked external request: " + request.url());
              await route.abort();
            } else if (request.isNavigationRequest() && departing) {
              navigations.push(request.url());
              // Keep the departing document mounted so the click lock can be
              // exercised without replacing window.location or component code.
              await route.fulfill({ status: 204 });
            } else await route.continue();
          });
          await page.goto(source);
          departing = true;
          expect(page.url()).toBe(source);
          await page.getByLabel("Draft", { exact: true }).fill("Keep my synthetic draft");
          await page.getByLabel("Editor selection", { exact: true }).selectOption("all");
          await page.locator(".workspace-switcher-trigger").click();
          await page.getByRole("dialog").waitFor();
        }

        async function retained() {
          expect(page.url()).toBe(source);
          expect(await page.getByLabel("Draft", { exact: true }).inputValue()).toBe("Keep my synthetic draft");
          expect(await page.getByLabel("Editor selection", { exact: true }).inputValue()).toBe("all");
          expect(navigations).toEqual([]);
        }

        it("cancels the localized leave warning and retains draft and current selection", async () => {
          await open();
          await page.getByRole("button", { name: "Synthetic B", exact: true }).click();
          expect(warnings).toEqual([messages.leaveWarning.replace("{name}", "Synthetic B")]);
          await retained();
          expect(await page.getByRole("dialog").isVisible()).toBe(true);
          expect(await page.locator('.workspace-switcher-option[aria-current="true"]').textContent()).toContain("Synthetic A");
          expect(await page.getByRole("button", { name: "Synthetic B", exact: true }).isEnabled()).toBe(true);
          expect(await page.getByRole("status").count()).toBe(0);
        });

        it("closes on the current workspace without a warning or navigation", async () => {
          await open();
          await page.locator('.workspace-switcher-option[aria-current="true"]').click();
          await expect.poll(() => page.getByRole("dialog").count()).toBe(0);
          expect(warnings).toEqual([]);
          await retained();
          expect(await page.locator(".workspace-switcher-trigger").getAttribute("aria-expanded")).toBe("false");
        });

        it("navigates once to localized home and resets its lock on a fixture pageshow", async () => {
          await open(true);
          // Same-turn activations exercise the ref lock before React can commit
          // disabled buttons; the next activation also covers the disabled UI.
          await page.getByRole("button", { name: "Synthetic B", exact: true }).evaluate((button) => {
            (button as HTMLButtonElement).click();
            (button as HTMLButtonElement).click();
          });
          await expect.poll(() => navigations.length).toBe(1);
          expect(navigations).toEqual([`${origin}/${locale}/workspaces/synthetic-b`]);
          expect(warnings).toEqual([messages.leaveWarning.replace("{name}", "Synthetic B")]);
          await expect.poll(() => page.locator(".workspace-switcher-option:disabled").count()).toBe(3);
          expect(await page.getByRole("status").textContent()).toBe(messages.switching);
          await page.getByRole("button", { name: "Synthetic C", exact: true }).evaluate((button) => (button as HTMLButtonElement).click());
          // Synthetic PageTransitionEvent proves the listener resets both locks.
          // This is NOT evidence of an actual browser BFCache restore.
          await page.evaluate(() => window.dispatchEvent(new PageTransitionEvent("pageshow", { persisted: true })));
          await expect.poll(() => page.locator(".workspace-switcher-option:disabled").count()).toBe(0);
          expect(navigations).toHaveLength(1);
          expect(warnings).toHaveLength(1);
          expect(await page.getByRole("status").count()).toBe(0);
          await page.getByRole("button", { name: "Synthetic C", exact: true }).click();
          await expect.poll(() => navigations.length).toBe(2);
          expect(navigations).toEqual([
            `${origin}/${locale}/workspaces/synthetic-b`,
            `${origin}/${locale}/workspaces/synthetic-c`,
          ]);
          expect(warnings).toEqual([
            messages.leaveWarning.replace("{name}", "Synthetic B"),
            messages.leaveWarning.replace("{name}", "Synthetic C"),
          ]);
        });
      });
    }
  }
});
