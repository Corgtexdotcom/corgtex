import { mkdir, readFile, writeFile } from "node:fs/promises";
import { createServer, type Server } from "node:http";
import { fileURLToPath } from "node:url";
import type { Browser, Page } from "playwright";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

// Actual client component with synthetic state, stubbed server actions, and
// loopback-only traffic. Never submit account/security forms or upload a file.
describe.runIf(process.env.USER_SETTINGS_BROWSER_QA === "1")("User settings browser accessibility", () => {
  let browser: Browser;
  let server: Server;
  let page: Page;
  let origin: string;
  const errors: string[] = [];
  const output = new URL("../../../../../../../.artifacts/settings-accessibility/", import.meta.url);
  const webRoot = new URL("../../../../../", import.meta.url);

  beforeAll(async () => {
    await mkdir(output, { recursive: true });
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
          import { UserSettingsPanel } from "./app/[locale]/workspaces/[workspaceId]/settings/UserSettingsPanel";
          window.fixture = { actions: [], refreshes: 0, inputClicks: 0 };
          const locale = location.pathname === "/es" ? "es" : "en";
          createRoot(document.getElementById("root")).render(
            <NextIntlClientProvider locale={locale} timeZone="UTC" messages={locale === "es" ? es : en}>
              <UserSettingsPanel workspaceId="synthetic-workspace" profile={{
                user: { displayName: "Synthetic member", email: "member@example.test", bio: "Synthetic profile" },
                member: null,
              }} sessions={[]} preferences={[]} slackConnected={false} />
            </NextIntlClientProvider>
          );
          document.addEventListener("click", event => {
            if (event.target instanceof HTMLInputElement && event.target.type === "file") {
              event.preventDefault(); window.fixture.inputClicks++;
            }
          }, true);
        `,
      },
      bundle: true, write: false, jsx: "automatic",
      alias: { "@": fileURLToPath(webRoot) },
      define: { "process.env.NODE_ENV": '"production"' },
      plugins: [{
        name: "synthetic-boundaries",
        setup(build) {
          build.onResolve({ filter: /^next\/navigation$/ }, () => ({ path: "router", namespace: "synthetic" }));
          build.onResolve({ filter: /^\.\/actions$/ }, (args) => args.importer.endsWith("/UserSettingsPanel.tsx")
            ? { path: "actions", namespace: "synthetic" } : undefined);
          build.onLoad({ filter: /.*/, namespace: "synthetic" }, (args) => ({
            contents: args.path === "router"
              ? "export const useRouter = () => ({ refresh: () => window.fixture.refreshes++ });"
              : `export const updateProfileAction = async (...args) => window.fixture.actions.push(["profile", ...args]);
                 export const updateNotificationPrefAction = async (...args) => window.fixture.actions.push(["preference", ...args]);
                 export const updateMemberNewspaperCadenceAction = async (...args) => window.fixture.actions.push(["cadence", ...args]);`,
          }));
        },
      }],
    });
    const styles = await Promise.all(["styles/tokens.css", "globals.css", "styles/pages.css", "styles/components.css"].map(async (path) =>
      (await readFile(new URL("app/" + path, webRoot), "utf8")).replace(/@import[^;]+;/g, "")));
    server = createServer((request, response) => {
      if (request.url === "/fixture.js") {
        response.setHeader("Content-Type", "text/javascript");
        response.end(bundle.outputFiles[0].text);
      } else {
        response.setHeader("Content-Type", "text/html; charset=utf-8");
        response.end(`<!doctype html><html lang="${request.url === "/es" ? "es" : "en"}"><head><title>Synthetic settings</title>
          <style>${styles.join("\n")}:root{--accent:#3f5839;--accent-soft:#edf3e9;--accent-fg:#fff;--line:#bcc5b8;--text:#182315;--muted:#5b6855;--bg-card:#fff;--surface-strong:#fff;--overlay-scrim:#0009;--overlay-fg:#fff;--radius-full:24px}body{padding:24px;max-width:1000px;margin:auto}label{display:block;margin-bottom:6px}</style>
          </head><body><div id="root"></div><script src="/fixture.js"></script></body></html>`);
      }
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("Missing fixture port");
    origin = "http://127.0.0.1:" + address.port;
    browser = await chromium.launch({ headless: true, executablePath: process.env.USER_SETTINGS_CHROME_PATH ?? "/usr/bin/chromium" });
    const context = await browser.newContext({ viewport: { width: 1200, height: 900 } });
    await context.route("**/*", (route) => route.request().url().startsWith(origin + "/") ? route.continue() : route.abort());
    page = await context.newPage();
    page.setDefaultTimeout(3000);
    page.on("pageerror", (error) => errors.push(error.message));
    page.on("console", (message) => { if (message.type() === "error") errors.push(message.text()); });
  });

  afterAll(async () => {
    await browser?.close();
    if (server) {
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
    await writeFile(new URL("browser-results.json", output), JSON.stringify({ errors, mode: "Actual component; synthetic state; loopback only; no account/security submissions or uploads" }, null, 2));
    expect(errors).toEqual([]);
  });

  for (const locale of ["en", "es"] as const) {
    it(`names controls, focuses labels, and preserves editing in ${locale}`, async () => {
      const messages = JSON.parse(await readFile(new URL(`messages/${locale}.json`, webRoot), "utf8")).settings;
      await page.goto(origin + "/" + locale);
      await page.locator(".user-profile-card").waitFor();
      for (const key of ["labelDisplayName", "labelBio", "labelLinkedinUrl", "labelWebsiteUrl", "labelEmail", "labelNewspaperCadence"]) {
        expect(await page.getByLabel(messages[key], { exact: true }).count()).toBe(1);
      }
      const name = page.getByLabel(messages.labelDisplayName, { exact: true });
      await page.locator("label").filter({ hasText: new RegExp("^" + messages.labelDisplayName + "$") }).click();
      expect(await name.evaluate((node) => node === document.activeElement)).toBe(true);
      await name.fill("Updated synthetic name");
      expect(await name.inputValue()).toBe("Updated synthetic name");
      const unnamed = await page.locator("select").evaluateAll((nodes) => nodes.filter((node) => !(node as HTMLSelectElement).labels?.length).length);
      expect(unnamed).toBe(0);
      await page.screenshot({ path: fileURLToPath(new URL(locale + "-desktop.png", output)), fullPage: true });
    });

    it(`opens avatar picker with Enter and Space in ${locale}`, async () => {
      const messages = JSON.parse(await readFile(new URL(`messages/${locale}.json`, webRoot), "utf8")).settings;
      await page.goto(origin + "/" + locale);
      await page.locator(".user-profile-card").waitFor();
      const button = page.getByRole("button", { name: messages.btnUploadAvatar, exact: true });
      expect(await button.count()).toBe(1);
      await page.keyboard.press("Tab");
      expect(await button.evaluate((node) => node === document.activeElement)).toBe(true);
      await page.keyboard.press("Enter");
      await page.keyboard.press("Space");
      expect(await page.evaluate(() => (window as any).fixture.inputClicks)).toBe(2);
      await expect.poll(() => button.evaluate((node) => getComputedStyle(node.querySelector(".avatar-overlay")!).opacity)).toBe("1");
      expect(await page.evaluate(() => (window as any).fixture.actions)).toEqual([]);
    });
  }

  it("retains exact notification dispatch and profile draft while preferences change", async () => {
    await page.goto(origin + "/en");
    await page.locator(".user-profile-card").waitFor();
    await page.getByLabel("Bio (About me)", { exact: true }).fill("Unsaved synthetic draft");
    await page.getByLabel("Mentions", { exact: true }).selectOption("EMAIL");
    await page.getByLabel("Default", { exact: true }).selectOption("OFF");
    await page.getByLabel("Corgtex newspaper", { exact: true }).selectOption("WEEKLY");
    expect(await page.getByLabel("Bio (About me)", { exact: true }).inputValue()).toBe("Unsaved synthetic draft");
    expect(await page.evaluate(() => (window as any).fixture.actions)).toEqual([
      ["preference", "synthetic-workspace", { notifType: "deliberation.mention", channel: "EMAIL" }],
      ["preference", "synthetic-workspace", { notifType: "*", channel: "OFF" }],
      ["cadence", "synthetic-workspace", "WEEKLY"],
    ]);
  });
});
