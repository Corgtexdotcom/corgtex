import { createServer, type Server } from "node:http";
import { mkdir, readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import type { Browser, Page, Route } from "playwright";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";

const link = (id: string, title = `Synthetic ${id}`) => ({
  id, title, url: `https://example.test/${id}`, category: "OTHER",
  descriptionMd: null, accessNotesMd: null, previewTitle: null, previewDescription: null,
  previewImageUrl: null, previewFaviconUrl: null, credentialLabel: null, hasCredential: false,
  createdAt: "2026-01-01T12:00:00Z", updatedAt: "2026-01-01T12:00:00Z", archivedAt: null,
  createdBy: null, circles: [], canManage: true, canManageCredentials: true, canArchive: true,
});

// Real client, MarkdownEditor, controls and translations; only Next navigation and HTTP are fixtures.
// TOOLS_DIRECTORY_BROWSER_QA=1; optional PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH.
describe.runIf(process.env.TOOLS_DIRECTORY_BROWSER_QA === "1")("manual-link browser saves", () => {
  let browser: Browser;
  let server: Server;
  let origin: string;

  beforeAll(async () => {
    const { build } = await import("esbuild");
    const { chromium } = await import("playwright");
    const component = fileURLToPath(new URL("./ToolsDirectoryClient.tsx", import.meta.url));
    const messages = fileURLToPath(new URL("../../../../../messages/en.json", import.meta.url));
    const bundle = await build({
      stdin: { contents: `import React from 'react'; import {createRoot} from 'react-dom/client';
        import {NextIntlClientProvider} from 'next-intl'; import messages from ${JSON.stringify(messages)};
        import {ToolsDirectoryClient} from ${JSON.stringify(component)};
        createRoot(document.getElementById('root')).render(
          <NextIntlClientProvider locale="en" messages={messages} timeZone="UTC">
            <ToolsDirectoryClient workspaceId="synthetic-workspace" initialLinks={${JSON.stringify([link("A"), link("B")])}}
              initialCatalogItems={[]} initialRequests={[]} canManageCatalog={false}
              circles={[{id:'circle-1',name:'Synthetic circle'}]} initialView="list" initialExternalResources={[]} />
          </NextIntlClientProvider>);`, resolveDir: fileURLToPath(new URL("../../../../../", import.meta.url)), loader: "tsx" },
      bundle: true, write: false, format: "esm", jsx: "automatic",
      define: { "process.env.NODE_ENV": '"production"' },
      plugins: [{ name: "tools-navigation-fixture", setup(api) {
        api.onResolve({ filter: /^next\/navigation$/ }, () => ({ path: "navigation", namespace: "fixture" }));
        api.onLoad({ filter: /.*/, namespace: "fixture" }, () => ({ contents:
          `export const useRouter = () => ({refresh: () => {window.__toolsRefreshes = (window.__toolsRefreshes || 0) + 1;}});
           export const useSearchParams = () => new URLSearchParams('surface=links');` }));
      } }],
    });
    const js = bundle.outputFiles[0].text;
    const appDirectory = fileURLToPath(new URL("../../../../../app/", import.meta.url));
    const globalCss = await readFile(`${appDirectory}/globals.css`, "utf8");
    const imports = globalCss.match(/^@import .*;$/gm) ?? [];
    const styles = await build({
      stdin: { contents: `${imports.join("\n")}\n${globalCss.replace(/^@import .*;$/gm, "")}`,
        loader: "css", resolveDir: appDirectory },
      bundle: true, write: false,
    });
    const { default: postcss } = await import("postcss");
    const { default: tailwindcss } = await import("tailwindcss");
    const css = (await postcss([tailwindcss(fileURLToPath(new URL("../../../../../tailwind.config.ts", import.meta.url)))])
      .process(styles.outputFiles[0].text, { from: undefined })).css;
    server = createServer((req, res) => {
      if (req.url === "/fixture.css") {
        res.setHeader("Content-Type", "text/css"); res.end(css); return;
      }
      res.setHeader("Content-Type", req.url === "/fixture.js" ? "text/javascript" : "text/html");
      res.end(req.url === "/fixture.js" ? js : '<!doctype html><html><head><meta name="viewport" content="width=device-width, initial-scale=1"><link rel="stylesheet" href="/fixture.css"></head><body><div id="root"></div><script type="module" src="/fixture.js"></script></body></html>');
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("Missing fixture port");
    origin = `http://127.0.0.1:${address.port}`;
    browser = await chromium.launch({ executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH });
  });

  afterAll(async () => {
    await browser?.close();
    if (server) await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  for (const mobile of [false, true]) describe(mobile ? "mobile" : "desktop", () => {
    let page: Page;
    let saves: Route[];
    let errors: string[];
    const form = () => page.locator("form").filter({ has: page.getByRole("heading", { name: /Add manual link|Edit/ }) });
    const title = () => form().getByLabel("Title", { exact: true });
    const save = () => form().getByRole("button", { name: /Add link|Update tool/ });
    const cancel = () => form().getByRole("button", { name: "Cancel", exact: true });
    async function settle() {
      await page.evaluate(() => new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))));
    }
    async function edit(id: string) {
      await page.getByRole("row").filter({ hasText: `Synthetic ${id}` }).getByRole("button", { name: "Edit", exact: true }).click();
    }
    async function add() {
      await page.getByRole("button", { name: "Add manual link", exact: true }).click();
      await title().fill("Synthetic new link");
      await form().getByLabel("URL", { exact: true }).fill("https://example.test/new");
    }
    async function submit() {
      const count = saves.length;
      await save().click();
      await expect.poll(() => saves.length).toBe(count + 1);
    }
    async function finish(index: number, status = 200) {
      const request = saves[index].request();
      const payload = request.postDataJSON();
      const id = request.method() === "POST" ? "new" : request.url().split("/").at(-1)!;
      await saves[index].fulfill({ status, contentType: "application/json", body: JSON.stringify(
        status < 400 ? { ...link(id), ...payload } : { error: { message: "Synthetic HTTP failure" } },
      ) });
      await settle();
    }

    beforeEach(async () => {
      saves = []; errors = [];
      page = await browser.newPage({ viewport: mobile ? { width: 390, height: 844 } : { width: 1280, height: 900 }, isMobile: mobile, hasTouch: mobile });
      page.setDefaultTimeout(3000);
      page.on("pageerror", (error) => errors.push(error.message));
      // Reject every non-loopback request, including accidental image/provider traffic.
      await page.route("**/*", (route) => {
        if (new URL(route.request().url()).origin !== origin) return route.abort();
        if (route.request().url().includes("/tool-links")) { saves.push(route); return; }
        if (route.request().url().includes("/catalog")) return route.fulfill({ json: { items: [] } });
        return route.continue();
      });
      await page.goto(origin);
      await page.getByText("Manual shared-link management", { exact: true }).click();
    });
    afterEach(async () => { await page?.close(); });

    it.each(["success", "http", "network"])("preserves B after cancel/reopen while A completes with %s", async (outcome) => {
      await edit("A"); await title().fill("Saved A"); await submit();
      await cancel().click(); await edit("B"); await title().fill("Unsaved B draft");
      if (outcome === "network") { await saves[0].abort("failed"); await settle(); }
      else await finish(0, outcome === "http" ? 503 : 200);
      expect(await title().inputValue()).toBe("Unsaved B draft");
      expect(await save().isEnabled()).toBe(true);
      expect(await page.locator(".form-message-error").count()).toBe(0);
      expect(errors).toEqual([]);
      if (process.env.TOOLS_DIRECTORY_CAPTURE === "1") {
        await mkdir(".artifacts/tools-manual-saves", { recursive: true });
        await page.screenshot({ path: `.artifacts/tools-manual-saves/${mobile ? "mobile" : "desktop"}-${outcome}.png`, fullPage: true });
      }
    });

    it("preserves a reopened draft after toolbar cancellation of a pending save", async () => {
      await edit("A"); await submit();
      await page.getByRole("button", { name: "Cancel", exact: true }).first().click();
      await page.getByRole("button", { name: "Add manual link", exact: true }).click();
      await title().fill("Reopened draft");
      await finish(0);
      expect(await title().inputValue()).toBe("Reopened draft");
      expect(await save().isEnabled()).toBe(true);
    });

    it("adds an abandoned successful create to the list without clearing B", async () => {
      await add(); await submit(); await cancel().click();
      await edit("B"); await title().fill("B after create"); await finish(0);
      expect(await title().inputValue()).toBe("B after create");
      expect(await page.getByRole("row").filter({ hasText: "Synthetic new link" }).count()).toBe(1);
    });

    it("keeps an accepted save successful when catalog refresh fails", async () => {
      await page.route("**/catalog", (route) => route.abort("failed"));
      await add(); await submit(); await finish(0);
      expect(await form().count()).toBe(0);
      expect(await page.getByRole("row").filter({ hasText: "Synthetic new link" }).count()).toBe(1);
      await settle(); expect(saves.length).toBe(1); expect(errors).toEqual([]);
    });

    it("does not unlock B's pending save when abandoned A finishes", async () => {
      await edit("A"); await submit(); await cancel().click();
      await edit("B"); await title().fill("Saved B"); await submit();
      await finish(0);
      expect(await title().inputValue()).toBe("Saved B");
      expect(await save().isDisabled()).toBe(true);
      await finish(1);
      expect(await form().count()).toBe(0);
      expect(await page.getByRole("row").filter({ hasText: "Saved B" }).count()).toBe(1);
    });

    it("locks duplicate click, Enter and synchronous submit events until completion", async () => {
      await add();
      await form().evaluate((node) => {
        node.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
        node.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
      });
      await expect.poll(() => saves.length).toBeGreaterThan(0);
      expect(saves.length).toBe(1);
      expect(await save().isDisabled()).toBe(true);
      await save().evaluate((node) => (node as HTMLButtonElement).click());
      await title().press("Enter"); await settle();
      expect(saves.length).toBe(1);
      await finish(0); expect(await form().count()).toBe(0);
    });

    it.each(["http", "network"])("retains all draft fields on %s failure and retries only deliberately", async (outcome) => {
      await add();
      await form().locator('textarea[name="descriptionMd"]').fill("Synthetic description");
      await form().locator('textarea[name="accessNotesMd"]').fill("Synthetic access notes");
      await form().getByLabel("Credential label", { exact: true }).fill("Synthetic label");
      await form().locator('input[type="password"]').fill("synthetic-fixture-secret");
      await form().getByRole("checkbox", { name: "Synthetic circle" }).check();
      await submit();
      const payload = saves[0].request().postDataJSON();
      if (outcome === "network") { await saves[0].abort("failed"); await settle(); }
      else await finish(0, 503);
      await expect.poll(() => page.locator(".form-message-error").count()).toBe(1);
      expect(await title().inputValue()).toBe(payload.title);
      expect(await form().locator('textarea[name="descriptionMd"]').inputValue()).toBe(payload.descriptionMd);
      expect(await form().locator('textarea[name="accessNotesMd"]').inputValue()).toBe(payload.accessNotesMd);
      expect(await form().locator('input[type="password"]').inputValue()).toBe(payload.credentialSecret);
      expect(await form().getByRole("checkbox", { name: "Synthetic circle" }).isChecked()).toBe(true);
      expect(await save().isEnabled()).toBe(true);
      await settle(); expect(saves.length).toBe(1);
      await submit(); expect(saves[1].request().postDataJSON()).toEqual(payload);
      await finish(1); expect(await form().count()).toBe(0); expect(errors).toEqual([]);
    });

    it("creates then edits normally with the correct URL, method and clean new draft", async () => {
      await add(); await submit();
      expect(saves[0].request().method()).toBe("POST");
      await finish(0); expect(await form().count()).toBe(0);
      await page.getByRole("row").filter({ hasText: "Synthetic new link" }).getByRole("button", { name: "Edit", exact: true }).click();
      await title().fill("Updated new link"); await submit();
      expect(saves[1].request().method()).toBe("PATCH");
      expect(new URL(saves[1].request().url()).pathname).toBe("/api/workspaces/synthetic-workspace/tool-links/new");
      await finish(1); expect(await form().count()).toBe(0);
      expect(await page.getByRole("row").filter({ hasText: "Updated new link" }).count()).toBe(1);
      await page.getByRole("button", { name: "Add manual link", exact: true }).click();
      expect(await title().inputValue()).toBe(""); expect(errors).toEqual([]);
    });
  });
});
