import { existsSync } from "node:fs";
import { mkdir, readFile } from "node:fs/promises";
import { createServer, type Server } from "node:http";
import { fileURLToPath } from "node:url";
import type { Browser, Page } from "playwright";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

// Opt-in real Chromium coverage of the real server-page consumer trees with
// synthetic auth/data/action bindings. No application server, database or provider.
describe.runIf(process.env.ACTIONS_EMPTY_BROWSER_QA === "1")("Actions empty-view recovery", () => {
  let browser: Browser;
  let server: Server;
  let page: Page;
  let origin: string;
  const errors: string[] = [];
  const webRoot = new URL("../../../../../", import.meta.url);
  const artifactRoot = new URL(`../../.artifacts/pun113-empty/${Date.now()}/`, webRoot);

  beforeAll(async () => {
    await mkdir(artifactRoot, { recursive: true });
    const { build } = await import("esbuild");
    const { chromium } = await import("playwright");
    const messages = JSON.parse(await readFile(new URL("messages/en.json", webRoot), "utf8"));
    const mocks: Record<string, string> = {
      "@corgtex/domain": `
        const user = { id: "synthetic-user", displayName: "Synthetic owner", email: "owner@example.invalid" };
        const member = { id: "synthetic-member", role: "ADMIN", isActive: true, user };
        const actions = ["OPEN", "OPEN", "DRAFT", "IN_PROGRESS", "COMPLETED"].map((status, i) => ({
          id: "synthetic-action-" + i, title: "Synthetic " + status + " action " + i, status, bodyMd: "",
          authorUserId: user.id, author: user, assigneeMemberId: member.id, assigneeMember: member,
          isPrivate: status === "DRAFT", createdAt: new Date("2026-10-16T12:00:00Z"), priority: 1, version: 1,
          dueAt: null, circle: null, proposal: null, completedVia: null,
        }));
        function listResult(opts) {
          if (!sessionStorage.getItem("emptyRecovery")) return { items: actions, total: actions.length,
            statusCounts: { ALL: 5, OPEN: 2, DRAFT: 1, IN_PROGRESS: 1, COMPLETED: 1 }, page: 1, pageCount: 1 };
          window.fixture.reads.push(opts);
          // The synthetic regular member can read a public action assigned to
          // another member. The server binding supplies only authorized rows.
          const visible = sessionStorage.getItem("emptyRecovery") === "empty" ? [] : [
            { ...actions[0], id: "older-action", title: "Older workspace action", assigneeMemberId: "other-member" },
          ];
          const scoped = visible.filter(action => (!opts.assigneeMemberIds?.length || opts.assigneeMemberIds.includes(action.assigneeMemberId))
            && !opts.circleIds?.length);
          const items = scoped.filter(action => !opts.statuses?.length || opts.statuses.includes(action.status));
          return { items, total: items.length, statusCounts: { ALL: scoped.length, OPEN: scoped.length, DRAFT: 0, IN_PROGRESS: 0, COMPLETED: 0 }, page: 1, pageCount: 1 };
        }
        export async function listActions(_actor, _workspaceId, opts) { return listResult(opts); }
        export async function listActionsWithStatusCounts(_actor, _workspaceId, opts) { return listResult(opts); }
        export async function listCircles() { return []; }
        export async function listHumanMembers() { return [member]; }
        export async function requireWorkspaceMembership() { return sessionStorage.getItem("emptyRecovery") ? { ...member, role: "MEMBER" } : member; }
      `,
      "@corgtex/shared": `export const prisma = {
        workspace: { async findUnique() { return { slug: "synthetic-only" }; } },
        workItemEvidence: { async findMany() { return []; } },
      };`,
      "@/lib/auth": `export async function requirePageActor() {
        return { kind: "user", user: { id: "synthetic-user", displayName: "Synthetic owner", email: "owner@example.invalid" } };
      }`,
      "@/lib/workspace-feature-flags": "export async function requireWorkspaceFeature() {}",
      "next/navigation": `
        const router = { replace: path => sessionStorage.getItem("emptyRecovery") ? location.replace(path) : history.replaceState({}, "", path) };
        export const useRouter = () => router;
        export const usePathname = () => location.pathname;
        export const useSearchParams = () => new URLSearchParams(location.search);
      `,
      "next-intl/server": `import { createTranslator } from "next-intl";
        const messages = ${JSON.stringify(messages)};
        export async function getLocale() { return "en"; }
        export async function getTranslations(namespace) { return createTranslator({ locale: "en", timeZone: "UTC", messages, namespace }); }`,
      "../actions": `
        const capture = name => async data => { window.fixture.submissions.push({ name, fields: Object.fromEntries(data) }); };
        export const createActionAction = capture("create");
        export const updateActionAction = capture("update");
        export const deleteActionAction = capture("delete");
        export const publishActionAction = capture("publish");
        export const returnActionToDraftAction = capture("return-to-draft");
      `,
      // Server-only creation and Markdown rendering are outside this interaction
      // boundary. Keep real card, menu, confirmation, resolution dialog and editor.
      "@/lib/components/ActionEditorForm": "export function ActionEditorForm() { return null; }",
      "@/lib/components/MarkdownRenderer": "export function MarkdownRenderer() { return null; } export function MarkdownExcerpt() { return null; }",
    };
    const bundle = await build({
      stdin: { resolveDir: fileURLToPath(webRoot), loader: "tsx", contents: `
        import React from "react";
        import { createRoot } from "react-dom/client";
        import { NextIntlClientProvider } from "next-intl";
        import ActionsPage from "./app/[locale]/workspaces/[workspaceId]/actions/page";
        window.fixture = { submissions: [], confirmations: 0, reads: [] };
        window.confirm = () => { window.fixture.confirmations++; return false; };
        document.addEventListener("click", event => { if (!sessionStorage.getItem("emptyRecovery") && !new URLSearchParams(location.search).has("navigate") && event.target.closest("a[href]")) event.preventDefault(); }, true);
        (async () => {
          const query = new URLSearchParams(location.search);
          const props = { params: Promise.resolve({ workspaceId: "synthetic-workspace" }),
            searchParams: Promise.resolve(sessionStorage.getItem("emptyRecovery")
              ? Object.fromEntries([...new Set(query.keys())].map(key => [key, query.getAll(key).length > 1 ? query.getAll(key) : query.get(key)]))
              : { scope: "workspace", status: "ALL", view: query.get("view") ?? "list" }) };
          const tree = await ActionsPage(props);
          createRoot(document.getElementById("root")).render(
            <NextIntlClientProvider locale="en" timeZone="UTC" messages={${JSON.stringify(messages)}}>
              <button id="before">Before cards</button>{tree}<button id="after">After cards</button>
            </NextIntlClientProvider>
          );
        })();
      ` },
      alias: { "@": fileURLToPath(webRoot) },
      bundle: true, write: false, jsx: "automatic",
      define: { "process.env.NODE_ENV": '"production"', "process.env": "{}" },
      plugins: [{
        name: "synthetic-server-bindings",
        setup(builder) {
          builder.onResolve({ filter: /.*/ }, args => {
            const pageActionImport = args.path === "../actions";
            if (Object.hasOwn(mocks, args.path) && (!pageActionImport || /\/actions\/page\.tsx$/.test(args.importer))) {
              return { path: args.path, namespace: "synthetic" };
            }
            if (args.path === "./MarkdownRenderer" && args.importer.endsWith("/MarkdownEditor.tsx")) {
              return { path: "@/lib/components/MarkdownRenderer", namespace: "synthetic" };
            }
          });
          builder.onLoad({ filter: /.*/, namespace: "synthetic" }, args => ({ contents: mocks[args.path], loader: "tsx", resolveDir: fileURLToPath(webRoot) }));
        },
      }],
    });
    // Compile real styles: raw CSS omits @apply and can expose hidden transition
    // controls, changing the sequential focus order this regression exercises.
    const { default: postcss } = await import("postcss");
    const { default: tailwindcss } = await import("tailwindcss");
    const { default: autoprefixer } = await import("autoprefixer");
    const { default: config } = await import("../../../../../tailwind.config");
    let cssInput = await readFile(new URL("app/globals.css", webRoot), "utf8");
    for (const match of cssInput.matchAll(/@import "(.+?)";/g)) {
      cssInput = cssInput.replace(match[0], await readFile(new URL(`app/${match[1]}`, webRoot), "utf8"));
    }
    const css = (await postcss([tailwindcss({ ...config, content: [
      fileURLToPath(new URL("app/**/*.{js,ts,jsx,tsx,mdx}", webRoot)),
      fileURLToPath(new URL("lib/**/*.{js,ts,jsx,tsx,mdx}", webRoot)),
    ] }), autoprefixer]).process(cssInput, { from: fileURLToPath(new URL("app/globals.css", webRoot)) })).css;
    server = createServer((request, response) => {
      const js = request.url === "/fixture.js";
      response.setHeader("Content-Type", js ? "text/javascript" : "text/html");
      response.end(js ? bundle.outputFiles[0].text : `<!doctype html><html lang="en"><head><style>${css}</style></head><body style="padding:24px"><main id="root"></main><script src="/fixture.js"></script></body></html>`);
    });
    await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("Missing port");
    origin = `http://127.0.0.1:${address.port}`;
    browser = await chromium.launch({ headless: true, executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH ?? (existsSync("/usr/lib/chromium/chromium") ? "/usr/lib/chromium/chromium" : undefined) });
    const context = await browser.newContext({ viewport: { width: 1280, height: 800 } });
    await context.route("**/*", route => route.request().url().startsWith(origin + "/") ? route.continue() : route.abort());
    page = await context.newPage();
    page.setDefaultTimeout(4000);
    page.on("pageerror", error => errors.push(error.message));
  });
  beforeEach(async () => { await page.goto(origin); await page.locator("#after").waitFor();  });
  afterAll(async () => {
    await browser?.close();
    if (server) { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); }
    expect(errors).toEqual([]);
  });
  it.each(["list", "table", "kanban"])("recovers a regular member's filtered empty %s view without a new inventory query", async view => {
    await page.evaluate(() => { localStorage.clear(); sessionStorage.setItem("emptyRecovery", "filtered"); });
    const path = "/en/workspaces/synthetic-workspace/actions";
    try {
      await page.goto(origin + path + `?view=${view}&status=DRAFT&circleId=old-circle&assigneeMemberId=old-member&page=9&columns=DRAFT`);
      const recovery = page.getByRole("link", { name: "Show all workspace actions", exact: true });
      await recovery.waitFor();
      expect(await page.getByRole("status").innerText()).toContain("Status: DRAFT · Scope: Selected assignees");
      expect(await page.getByRole("status").innerText()).toContain("Circle filters are also applied.");
      expect(await recovery.getAttribute("href")).toBe("?status=ALL&scope=workspace");
      const reads = () => page.evaluate(() => (window as unknown as { fixture: { reads: unknown[] } }).fixture.reads);
      expect(await reads()).toHaveLength(1);
      await recovery.focus();
      await page.screenshot({ path: fileURLToPath(new URL(`actions-empty-${view}.png`, artifactRoot)) });
      await page.keyboard.press("Enter");
      await page.getByRole("link", { name: "Open Older workspace action", exact: true }).first().waitFor();
      expect(new URL(page.url()).search).toBe("?status=ALL&scope=workspace");
      expect(await reads()).toEqual([expect.objectContaining({ assigneeMemberIds: [], circleIds: [], statuses: [], page: 1 })]);
      expect(await page.getByRole("link", { name: "Show all workspace actions", exact: true }).count()).toBe(0);
      // A later bare sidebar visit restores the user's explicitly chosen recovery.
      await page.goto(origin + path);
      await page.getByRole("link", { name: "Open Older workspace action", exact: true }).first().waitFor();
      expect(new URL(page.url()).search).toBe("?status=ALL&scope=workspace");
      expect(await page.evaluate(() => (window as unknown as { fixture: { submissions: unknown[] } }).fixture.submissions)).toEqual([]);
    } finally {
      await page.evaluate(() => { sessionStorage.removeItem("emptyRecovery"); localStorage.clear(); });
    }
  });

  it("restores an intentionally saved Draft/My view and offers recovery without changing it first", async () => {
    await page.evaluate(() => {
      sessionStorage.setItem("emptyRecovery", "filtered");
      localStorage.setItem('actions-view:v1:["synthetic-user","synthetic-workspace"]', "/workspaces/synthetic-workspace/actions?view=list&status=DRAFT");
    });
    try {
      await page.goto(origin + "/en/workspaces/synthetic-workspace/actions");
      await page.getByRole("link", { name: "Show all workspace actions", exact: true }).waitFor();
      expect(await page.getByRole("status").innerText()).toContain("Status: DRAFT · Scope: My actions");
      expect(new URL(page.url()).searchParams.get("status")).toBe("DRAFT");
      expect(new URL(page.url()).searchParams.has("scope")).toBe(false);
    } finally {
      await page.evaluate(() => { sessionStorage.removeItem("emptyRecovery"); localStorage.clear(); });
    }
  });

  it("keeps a genuinely empty unrestricted workspace neutral without a recovery loop", async () => {
    await page.evaluate(() => { sessionStorage.setItem("emptyRecovery", "empty"); localStorage.clear(); });
    try {
      await page.goto(origin + "/en/workspaces/synthetic-workspace/actions?view=list&status=ALL&scope=workspace");
      await page.getByRole("status").waitFor();
      expect(await page.getByRole("status").innerText()).toContain("No actions found.");
      expect(await page.getByRole("status").innerText()).toContain("Status: All statuses · Scope: All workspace actions");
      expect(await page.getByRole("link", { name: "Show all workspace actions", exact: true }).count()).toBe(0);
    } finally {
      await page.evaluate(() => { sessionStorage.removeItem("emptyRecovery"); localStorage.clear(); });
    }
  });

});
