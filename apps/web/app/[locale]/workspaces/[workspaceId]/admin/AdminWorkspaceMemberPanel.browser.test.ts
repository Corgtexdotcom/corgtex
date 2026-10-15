import { mkdir, readFile, writeFile } from "node:fs/promises";
import { createServer, type Server } from "node:http";
import { fileURLToPath } from "node:url";
import type { Browser, Page } from "playwright";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

// Real components; controlled synthetic reads; all writes trapped; loopback only.
describe.runIf(process.env.ADMIN_MEMBERS_BROWSER_QA === "1")("Admin member panel request lifetime", () => {
  let browser: Browser;
  let server: Server;
  let page: Page;
  let origin: string;
  const errors: string[] = [];
  const output = new URL("../../../../../../../.artifacts/admin-members/", import.meta.url);
  const webRoot = new URL("../../../../../", import.meta.url);

  beforeAll(async () => {
    await mkdir(output, { recursive: true });
    const { build } = await import("esbuild");
    const { chromium } = await import("playwright");
    const bundle = await build({
      stdin: {
        resolveDir: fileURLToPath(webRoot), loader: "tsx",
        contents: `
          import React, { useState } from "react";
          import { createRoot } from "react-dom/client";
          import { AdminWorkspacesTab } from "./app/[locale]/workspaces/[workspaceId]/admin/AdminWorkspacesTab";
          import { AdminWorkspaceMemberPanel } from "./app/[locale]/workspaces/[workspaceId]/admin/AdminWorkspaceMemberPanel";
          window.fixture = { reads: [], writes: [] };
          const workspaces = ["A", "B"].map(id => ({ id, name: "Workspace " + id, slug: id, createdAt: "2026-01-01", activeMemberCount: 1, memberCount: 1, adminCount: 1, failedJobsCount: 0 }));
          function Fixture() {
            const [parent, setParent] = useState("parent-1");
            const [target, setTarget] = useState("A");
            return <><button onClick={() => setParent(p => p === "parent-1" ? "parent-2" : "parent-1")}>Change parent</button>
              <button onClick={() => setTarget(t => t === "A" ? "B" : "A")}>Change direct target</button>
              {location.pathname === "/direct" ? <AdminWorkspaceMemberPanel workspaceId={parent} targetWorkspaceId={target} /> : <AdminWorkspacesTab workspaceId={parent} workspaces={workspaces} />}</>;
          }
          createRoot(document.getElementById("root")).render(<Fixture />);
        `,
      },
      bundle: true, write: false, jsx: "automatic",
      alias: { "@": fileURLToPath(webRoot) },
      define: { "process.env.NODE_ENV": '"production"' },
      plugins: [{ name: "synthetic-boundaries", setup(build) {
        build.onResolve({ filter: /^next-intl$/ }, () => ({ path: "intl", namespace: "synthetic" }));
        build.onResolve({ filter: /^next\/link$/ }, () => ({ path: "link", namespace: "synthetic" }));
        build.onResolve({ filter: /^\.\/actions$/ }, args => /Admin(WorkspacesTab|WorkspaceMemberPanel)\.tsx$/.test(args.importer) ? { path: "actions", namespace: "synthetic" } : undefined);
        build.onLoad({ filter: /.*/, namespace: "synthetic" }, args => ({
          loader: "tsx", resolveDir: fileURLToPath(webRoot),
          contents: args.path === "intl" ? "export const useTranslations = () => key => key;"
            : args.path === "link" ? 'import React from "react"; export default function Link(props) { return <a {...props} />; }'
            : `export const adminGetWorkspaceDetailAction = (parent, target) => new Promise((resolve, reject) => window.fixture.reads.push({ parent, target, resolve, reject }));
               const trap = (...args) => { window.fixture.writes.push(args); throw new Error("Mutation forbidden in fixture"); };
               export const adminCreateWorkspaceAction = trap;
               export const adminCreateMemberAction = trap;
               export const adminUpdateMemberAction = trap;
               export const adminDeactivateMemberAction = trap;
               export const adminResendAccessLinkAction = trap;`,
        }));
      } }],
    });
    const styles = await Promise.all(["styles/tokens.css", "globals.css", "styles/pages.css", "styles/components.css"].map(async path =>
      (await readFile(new URL("app/" + path, webRoot), "utf8")).replace(/@import[^;]+;/g, "")));
    server = createServer((request, response) => {
      response.setHeader("Content-Type", request.url === "/fixture.js" ? "text/javascript" : "text/html; charset=utf-8");
      response.end(request.url === "/fixture.js" ? bundle.outputFiles[0].text : `<!doctype html><html><head><title>Synthetic Admin members</title><style>${styles.join("\n")}body{padding:24px}</style></head><body><div id="root"></div><script src="/fixture.js"></script></body></html>`);
    });
    await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("Missing fixture port");
    origin = "http://127.0.0.1:" + address.port;
    browser = await chromium.launch({ headless: true, executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH ?? "/usr/bin/chromium" });
    const context = await browser.newContext({ viewport: { width: 1400, height: 1000 } });
    await context.route("**/*", route => route.request().url().startsWith(origin + "/") ? route.continue() : route.abort());
    page = await context.newPage();
    page.setDefaultTimeout(1500);
    page.on("pageerror", error => errors.push(error.message));
  });

  beforeEach(async () => { await page.goto(origin); });
  afterAll(async () => {
    await browser?.close();
    if (server) { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); }
    await writeFile(new URL("browser-errors.json", output), JSON.stringify(errors, null, 2));
    expect(errors).toEqual([]);
  });

  async function reads(count: number) {
    await expect.poll(() => page.evaluate(() => (window as any).fixture.reads.length)).toBe(count);
  }
  async function settle(index: number, label: string | null) {
    await page.evaluate(({ index, label }) => {
      const read = (window as any).fixture.reads[index];
      if (label === null) read.reject(new Error("Synthetic load rejection"));
      else read.resolve({ members: [{ id: label, role: "ADMIN", isActive: true, user: { displayName: label, email: label + "@example.test", sessions: [] } }], failedJobs: [], commInstallations: [] });
    }, { index, label });
    // Let promise callbacks and React's render/effect tasks finish before assertions.
    await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
  }
  async function expand(target: string) {
    await page.getByRole("row").filter({ hasText: "Workspace " + target }).getByRole("button").click();
  }
  async function visible(label: string) {
    await expect.poll(() => page.getByText(label, { exact: true }).count()).toBe(1);
    expect(await page.locator('input[name="targetWorkspaceId"]').evaluateAll(nodes => nodes.map(node => (node as HTMLInputElement).value))).toEqual(Array(4).fill(label[0]));
    expect(await page.evaluate(() => (window as any).fixture.writes)).toEqual([]);
  }
  async function cleared() {
    expect(await page.locator('input[name="memberId"]').count()).toBe(0);
    expect(await page.locator('input[name="targetWorkspaceId"]').count()).toBe(0);
  }

  it("clears loaded A and drafts immediately when selecting pending B", async () => {
    await expand("A"); await reads(1); await settle(0, "A-member"); await visible("A-member");
    await page.locator('input[name="displayName"]').fill("Unsaved A draft");
    await expand("B"); await reads(2);
    await page.screenshot({ path: fileURLToPath(new URL("switch-pending.png", output)), fullPage: true });
    await cleared();
    await settle(1, "B-member"); await visible("B-member");
    expect(await page.locator('input[name="displayName"]').inputValue()).toBe("");
  });

  it("ignores A resolving after B", async () => {
    await expand("A"); await reads(1); await expand("B"); await reads(2);
    await settle(1, "B-member"); await visible("B-member");
    await settle(0, "A-member"); await visible("B-member");
    expect(await page.getByText("A-member", { exact: true }).count()).toBe(0);
  });

  it("isolates repeated A/B/A switches including stale rejection", async () => {
    await expand("A"); await reads(1); await expand("B"); await reads(2); await expand("A"); await reads(3);
    await settle(2, "A-latest"); await visible("A-latest");
    await settle(1, null); await settle(0, "A-old"); await visible("A-latest");
  });

  it("does not reuse a collapsed pending request on reopen", async () => {
    await expand("A"); await reads(1); await expand("A"); await cleared();
    await expand("A"); await reads(2); await settle(0, "A-old"); await cleared();
    await settle(1, "A-reopened"); await visible("A-reopened");
  });

  it("resets on parent workspace changes and ignores the prior parent", async () => {
    await expand("A"); await reads(1); await settle(0, "A-first");
    await page.getByRole("button", { name: "Change parent", exact: true }).click(); await reads(2); await cleared();
    await page.getByRole("button", { name: "Change parent", exact: true }).click(); await reads(3);
    await settle(2, "A-current"); await settle(1, "A-stale-parent"); await visible("A-current");
    expect(await page.locator('input[name="workspaceId"]').evaluateAll(nodes => nodes.map(node => (node as HTMLInputElement).value))).toEqual(Array(4).fill("parent-1"));
  });

  it("shows a controlled failure and retries only on deliberate click", async () => {
    await expand("A"); await reads(1); await settle(0, null); await cleared();
    await expect.poll(() => page.getByText("Failed to load", { exact: true }).count()).toBe(1);
    expect(await page.evaluate(() => (window as any).fixture.reads.length)).toBe(1);
    await page.screenshot({ path: fileURLToPath(new URL("load-failed.png", output)), fullPage: true });
    await page.getByRole("button", { name: "Retry", exact: true }).click(); await reads(2); await cleared();
    await settle(1, "A-retried"); await visible("A-retried");
  });

  it("guards direct prop changes even without a keyed parent", async () => {
    await page.goto(origin + "/direct"); await reads(1); await settle(0, "A-direct");
    await page.getByRole("button", { name: "Change direct target", exact: true }).click(); await reads(2); await cleared();
    await page.getByRole("button", { name: "Change direct target", exact: true }).click(); await reads(3);
    await settle(2, "A-current"); await settle(1, "B-stale"); await visible("A-current");
  });
});
