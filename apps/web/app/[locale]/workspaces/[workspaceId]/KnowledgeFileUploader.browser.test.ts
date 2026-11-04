import { createServer, type Server } from "node:http";
import { mkdir, readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import type { Browser, Page, Route } from "playwright";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";

type UploadRequest = { fields: Record<string, string>; file: string; route: Route };
type UploaderFixture = { accepted: number[]; refreshes: number };
declare global {
  interface Window { __uploaderFixture: UploaderFixture }
}

const resolutions = [
  ["use_existing", "Use existing"],
  ["update_existing", "Update existing"],
  ["create_new", "Create new"],
] as const;
const duplicate = {
  status: "duplicate_confirmation_required",
  candidate: {
    entityType: "document", entityId: "synthetic-existing-A", title: "Existing A",
    excerpt: "Synthetic duplicate", score: 1, matchKind: "exact", reasons: ["Same content"],
  },
  recommendedResolution: "use_existing",
  allowedResolutions: resolutions.map(([value]) => value),
};

// Real component + React, synthetic files and held HTTP responses. No app, database or external API.
// KNOWLEDGE_UPLOADER_BROWSER_QA=1 PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH=/usr/bin/chromium npx vitest run --project unit KnowledgeFileUploader.browser.test.ts
// Optional KNOWLEDGE_UPLOADER_QA_ARTIFACTS points to an ignored directory for screenshots.
describe.runIf(process.env.KNOWLEDGE_UPLOADER_BROWSER_QA === "1")("KnowledgeFileUploader browser", () => {
  let browser: Browser;
  let server: Server;
  let origin: string;
  let page: Page;
  let requests: UploadRequest[];

  beforeAll(async () => {
    const { build } = await import("esbuild");
    const { chromium } = await import("playwright");
    const component = fileURLToPath(new URL("./KnowledgeFileUploader.tsx", import.meta.url));
    const result = await build({
      stdin: {
        contents: `import React from 'react'; import {createRoot} from 'react-dom/client';
          import {KnowledgeFileUploader} from ${JSON.stringify(component)};
          window.__uploaderFixture = {accepted: [], refreshes: 0};
          createRoot(document.getElementById('root')).render(<KnowledgeFileUploader
            workspaceId="synthetic-workspace" actionReferenceId="synthetic-action" defaultSource="synthetic-source"
            initiallyOpen showTrigger={false} onUploaded={count => window.__uploaderFixture.accepted.push(count)} />);`,
        resolveDir: process.cwd(), loader: "tsx",
      },
      bundle: true, write: false, format: "esm", jsx: "automatic",
      define: { "process.env.NODE_ENV": '"production"' },
      plugins: [{ name: "uploader-fixture", setup(api) {
        api.onResolve({ filter: /^(next\/navigation|next-intl)$/ }, args => ({ path: args.path, namespace: "fixture" }));
        api.onLoad({ filter: /.*/, namespace: "fixture" }, args => ({ contents: args.path === "next/navigation"
          ? "export const useRouter = () => ({refresh: () => window.__uploaderFixture.refreshes++});"
          : "export const useTranslations = () => (key, values) => key + (values ? ' ' + JSON.stringify(values) : '');",
        }));
      } }],
    });
    const webRoot = new URL("../../../../", import.meta.url);
    const css = (await Promise.all([
      "app/globals.css", "app/styles/tokens.css", "app/styles/components.css", "app/styles/pages.css",
    ].map(path => readFile(new URL(path, webRoot), "utf8")))).join("\n").replace(/@import[^;]+;/g, "");
    server = createServer((request, response) => {
      if (request.url === "/fixture.js") {
        response.setHeader("Content-Type", "text/javascript");
        response.end(result.outputFiles[0].text);
      } else if (request.url === "/") {
        response.setHeader("Content-Type", "text/html");
        response.end(`<!doctype html><meta name="viewport" content="width=device-width,initial-scale=1"><style>${css}
          .hidden{display:none}body{padding:16px}#root{max-width:1000px;margin:auto}</style>
          <div id="root"></div><script type="module" src="/fixture.js"></script>`);
      } else { response.writeHead(404).end(); }
    });
    await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("Missing loopback port");
    origin = `http://127.0.0.1:${address.port}`;
    browser = await chromium.launch({ executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH });
  });
  afterEach(async () => { await page?.close(); });
  afterAll(async () => {
    await browser?.close();
    if (server) await new Promise<void>(resolve => server.close(() => resolve()));
  });

  for (const viewport of [{ width: 1280, height: 900 }, { width: 390, height: 844 }]) {
    describe(`${viewport.width}px`, () => {
      beforeEach(async () => {
        requests = [];
        page = await browser.newPage({ viewport, isMobile: viewport.width < 500, hasTouch: viewport.width < 500 });
        await page.route("**/*", async route => {
          const request = route.request();
          if (new URL(request.url()).origin !== origin) throw new Error("Fixture attempted external access");
          if (new URL(request.url()).pathname !== "/api/workspaces/synthetic-workspace/documents") {
            await route.continue(); return;
          }
          expect(request.method()).toBe("POST");
          const form = await new Request(request.url(), {
            method: "POST", headers: { "content-type": request.headers()["content-type"] }, body: request.postData()!,
          }).formData();
          const fields: Record<string, string> = {};
          let file = "";
          for (const [key, value] of form.entries()) {
            if (typeof value === "string") fields[key] = value;
            else file = value.name;
          }
          requests.push({ fields, file, route });
        });
        await page.goto(origin);
        await bulk().waitFor();
      });

      for (const [resolution, label] of resolutions) {
        it(`resolves only A with ${resolution}; leaves failed B and ready C untouched`, async () => {
          await conflictedQueue();
          await row("A.txt").locator("input").fill(" A title ");
          await row("A.txt").locator("textarea").fill(" file guidance ");
          await page.locator('[name="overallGuidance"]').fill(" overall guidance ");
          const untouched = await Promise.all([row("B.txt").innerHTML(), row("C.txt").innerHTML()]);
          await doubleClick(row("A.txt").getByRole("button", { name: label, exact: true }));
          await waitRequests(3);
          expect(requests.map(r => r.file)).toEqual(["A.txt", "B.txt", "A.txt"]);
          expect(requests[2].fields).toEqual({
            source: "synthetic-source", actionReferenceId: "synthetic-action", title: "A title",
            duplicateGuardEnabled: "true", duplicateResolution: resolution, duplicateTargetEntityId: "synthetic-existing-A",
            ingestionGuidanceMd: "Overall guidance:\r\noverall guidance\r\n\r\nFile guidance:\r\nfile guidance",
          });
          expect(await bulk().isDisabled()).toBe(true);
          await settle();
          expect(requests).toHaveLength(3);
          await reply(2, 200, { accepted: true });
          await expect.poll(() => row("A.txt").textContent()).toContain("uploadFilesStatus.done");
          await settle();
          expect(requests.map(r => r.file)).toEqual(["A.txt", "B.txt", "A.txt"]);
          await idle(2);
          expect(await Promise.all([row("B.txt").innerHTML(), row("C.txt").innerHTML()])).toEqual(untouched);
          expect(await fixture()).toEqual({ accepted: [1], refreshes: 2 });
          const artifacts = process.env.KNOWLEDGE_UPLOADER_QA_ARTIFACTS;
          if (artifacts && resolution === "use_existing") {
            await mkdir(artifacts, { recursive: true });
            await page.screenshot({ path: `${artifacts}/uploader-${viewport.width}.png`, fullPage: true });
          }
          // Bulk retries failed B and ready C sequentially, skipping done A.
          await doubleClick(bulk());
          await waitRequests(4);
          expect(requests[3].file).toBe("B.txt");
          expect(requests[3].fields.duplicateResolution).toBeUndefined();
          await settle();
          expect(requests).toHaveLength(4);
          await reply(3, 200);
          await waitRequests(5);
          expect(requests[4].file).toBe("C.txt");
          await reply(4, 200);
          await idle(3);
          expect(await fixture()).toEqual({ accepted: [1, 2], refreshes: 3 });
        });
      }

      it.each(["http", "network", "duplicate"] as const)("releases latch after %s resolution failure without sending B/C", async failure => {
        await conflictedQueue();
        await row("A.txt").getByRole("button", { name: "Use existing", exact: true }).click();
        await waitRequests(3);
        if (failure === "network") await requests[2].route.abort("failed");
        else await reply(2, failure === "duplicate" ? 409 : 503, failure === "duplicate" ? duplicate : { error: { message: "Synthetic retry failure" } });
        await idle(2);
        await settle();
        expect(requests.map(r => r.file)).toEqual(["A.txt", "B.txt", "A.txt"]);
        expect(await fixture()).toEqual({ accepted: [], refreshes: 2 });
        expect(await row("B.txt").textContent()).toContain("Synthetic B failure");
        expect(await row("C.txt").textContent()).toContain("uploadFilesStatus.ready");
        if (failure === "duplicate") {
          await row("A.txt").getByRole("button", { name: "Create new", exact: true }).click();
          await waitRequests(4);
          expect(requests[3].file).toBe("A.txt");
          await reply(3, 200);
          await idle(3);
          expect(await fixture()).toEqual({ accepted: [1], refreshes: 3 });
        } else {
          // Failed target becomes a normal retryable row; the existing bulk path recovers it.
          await bulk().click();
          for (const [index, name] of ["A.txt", "B.txt", "C.txt"].entries()) {
            await waitRequests(4 + index);
            expect(requests[3 + index].file).toBe(name);
            expect(requests[3 + index].fields.duplicateResolution).toBeUndefined();
            await reply(3 + index, 200);
          }
          await idle(3);
          expect(await fixture()).toEqual({ accepted: [3], refreshes: 3 });
        }
      });

      it("bulk snapshots IDs, skips removed rows, defers newly added rows, and ignores unresolved duplicates", async () => {
        await add("A.txt", "B.txt", "C.txt");
        await doubleClick(bulk());
        await waitRequests(1);
        await row("B.txt").getByRole("button", { name: "uploadFilesRemove" }).click();
        await add("D.txt");
        await reply(0, 409, duplicate);
        await waitRequests(2);
        expect(requests[1].file).toBe("C.txt");
        await reply(1, 200);
        await idle(1);
        expect(requests.map(r => r.file)).toEqual(["A.txt", "C.txt"]);
        expect(await fixture()).toEqual({ accepted: [1], refreshes: 1 });
        await bulk().click();
        await waitRequests(3);
        expect(requests[2].file).toBe("D.txt");
        await reply(2, 200);
        await idle(2);
        expect(await row("A.txt").getByRole("button", { name: "Use existing", exact: true }).isEnabled()).toBe(true);
        // A row resolution also excludes files added while its request is held.
        await row("A.txt").getByRole("button", { name: "Use existing", exact: true }).click();
        await waitRequests(4);
        await add("E.txt");
        await reply(3, 200);
        await idle(3);
        expect(requests.map(r => r.file)).toEqual(["A.txt", "C.txt", "D.txt", "A.txt"]);
        expect(await fixture()).toEqual({ accepted: [1, 1, 1], refreshes: 3 });
        expect(await row("E.txt").textContent()).toContain("uploadFilesStatus.ready");
      });
    });
  }

  function bulk() { return page.getByRole("button", { name: /^uploadFilesSubmit/ }); }
  function row(name: string) { return page.locator(".nr-upload-item").filter({ has: page.locator("strong.nr-item-title", { hasText: name }) }); }
  async function add(...names: string[]) {
    await page.locator('input[type="file"]').first().setInputFiles(names.map(name => ({ name, mimeType: "text/plain", buffer: Buffer.from(`Synthetic ${name}`) })));
  }
  async function doubleClick(button: ReturnType<typeof bulk>) {
    // Same event turn exercises the ref latch before a React render can disable the button.
    await button.evaluate(element => { (element as HTMLButtonElement).click(); (element as HTMLButtonElement).click(); });
  }
  async function waitRequests(count: number) { await expect.poll(() => requests.length).toBe(count); }
  async function reply(index: number, status: number, body: unknown = {}) {
    await requests[index].route.fulfill({ status, contentType: "application/json", body: JSON.stringify(body) });
  }
  async function fixture() { return page.evaluate(() => window.__uploaderFixture); }
  async function idle(refreshes: number) {
    await expect.poll(async () => (await fixture()).refreshes).toBe(refreshes);
    await bulk().waitFor();
  }
  async function settle() { await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))); }
  async function conflictedQueue() {
    await add("A.txt", "B.txt");
    await bulk().click();
    await waitRequests(1);
    await reply(0, 409, duplicate);
    await waitRequests(2);
    await reply(1, 500, { error: { message: "Synthetic B failure" } });
    await idle(1);
    await add("C.txt");
  }
});
