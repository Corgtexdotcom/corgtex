import { existsSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { createServer, type Server } from "node:http";
import { fileURLToPath } from "node:url";
import type { Browser, Page } from "playwright";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

// Opt-in real Chromium coverage of the unchanged server-page consumer tree with
// synthetic auth/data/action bindings. No application server, database or provider.
describe.runIf(process.env.SHARED_INTERACTIONS_BROWSER_QA === "1")("Actions card menu browser interactions", () => {
  let browser: Browser;
  let server: Server;
  let page: Page;
  let origin: string;
  const errors: string[] = [];
  const webRoot = new URL("../../../../../", import.meta.url);
  const artifactRoot = new URL("../../.artifacts/pun101/", webRoot);

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
        export async function listActions() { return { items: actions, total: actions.length }; }
        export async function countActionsByStatus() { return { ALL: 5, OPEN: 2, DRAFT: 1, IN_PROGRESS: 1, COMPLETED: 1 }; }
        export async function listCircles() { return []; }
        export async function listHumanMembers() { return [member]; }
        export async function requireWorkspaceMembership() { return member; }
      `,
      "@corgtex/shared": `export const prisma = {
        workspace: { async findUnique() { return { slug: "synthetic-only" }; } },
        workItemEvidence: { async findMany() { return []; } },
      };`,
      "@/lib/auth": `export async function requirePageActor() {
        return { kind: "user", user: { id: "synthetic-user", displayName: "Synthetic owner", email: "owner@example.invalid" } };
      }`,
      "next-intl/server": `import { createTranslator } from "next-intl";
        const messages = ${JSON.stringify(messages)};
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
        window.fixture = { submissions: [], confirmations: 0 };
        window.confirm = () => { window.fixture.confirmations++; return false; };
        document.addEventListener("click", event => { if (event.target.closest("a[href]")) event.preventDefault(); }, true);
        (async () => {
          const tree = await ActionsPage({ params: Promise.resolve({ workspaceId: "synthetic-workspace" }),
            searchParams: Promise.resolve({ scope: "workspace", status: "ALL", view: "list" }) });
          createRoot(document.getElementById("root")).render(
            <NextIntlClientProvider locale="en" timeZone="UTC" messages={${JSON.stringify(messages)}}>
              <button id="before">Before cards</button>{tree}<button id="after">After cards</button>
            </NextIntlClientProvider>
          );
        })();
      ` },
      alias: { "@": fileURLToPath(webRoot) },
      bundle: true, write: false, jsx: "automatic",
      define: { "process.env.NODE_ENV": '"production"' },
      plugins: [{
        name: "synthetic-server-bindings",
        setup(builder) {
          builder.onResolve({ filter: /.*/ }, args => {
            if (Object.hasOwn(mocks, args.path) && (args.path !== "../actions" || args.importer.endsWith("/actions/page.tsx"))) {
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
  beforeEach(async () => { await page.goto(origin); await page.locator("#after").waitFor(); await settled(); });
  afterAll(async () => {
    await browser?.close();
    if (server) { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); }
    expect(errors).toEqual([]);
  });
  const trigger = (index = 0) => page.locator(".nr-list-card .action-menu-trigger").nth(index);
  const card = (index = 0) => page.locator(".nr-list-card").nth(index);
  async function settled() { await page.evaluate(() => new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve())))); }
  async function open(key = "Enter", index = 0) { await trigger(index).focus(); await page.keyboard.press(key); await settled(); }
  async function focusText() { return page.evaluate(() => document.activeElement?.textContent?.trim()); }
  async function focused(selector: string) { return page.locator(selector).evaluate(node => document.activeElement === node); }

  it("gives all status-menu entries menuitem semantics without changing primary or dialog controls", async () => {
    for (const index of [0, 2, 3, 4]) {
      await open("Enter", index);
      const items = page.getByRole("menuitem");
      expect(await items.count()).toBe(4);
      expect(await items.evaluateAll(nodes => nodes.every(node => node.getAttribute("tabindex") === "-1"))).toBe(true);
      expect(await page.getByRole("separator").count()).toBe(1);
      expect(await page.locator("dialog [role='menuitem']").count()).toBe(0);
      await page.keyboard.press("Escape");
    }
    expect(await card().getByRole("button", { name: "Start", exact: true }).count()).toBe(1);
    await open();
    await writeFile(new URL("actions-menu-accessibility.yml", artifactRoot), await page.getByRole("menu").ariaSnapshot());
    await page.screenshot({ path: fileURLToPath(new URL("actions-menu.png", artifactRoot)) });
  });
  it("preserves keyboard entry, wrapping arrows, Home/End and Escape focus", async () => {
    for (const key of ["Enter", "Space", "ArrowDown", "ArrowUp"]) {
      await open(key);
      expect(await focusText()).toBe(key === "ArrowUp" ? "Archive" : "Return to draft");
      await page.keyboard.press("Escape");
    }
    await open();
    for (const label of ["Complete", "Edit", "Archive", "Return to draft"]) {
      await page.keyboard.press("ArrowDown"); expect(await focusText()).toBe(label);
    }
    await page.keyboard.press("ArrowUp"); expect(await focusText()).toBe("Archive");
    await page.keyboard.press("Home"); expect(await focusText()).toBe("Return to draft");
    await page.keyboard.press("End"); expect(await focusText()).toBe("Archive");
    await page.keyboard.press("Escape");
    expect(await trigger().evaluate(node => document.activeElement === node)).toBe(true);
  });
  it("Tab and Shift+Tab leave any menu entry at the card's sequential focus position", async () => {
    for (const key of ["Tab", "Shift+Tab"]) {
      for (let index = 0; index < 4; index++) {
        await open();
        for (let i = 0; i < index; i++) await page.keyboard.press("ArrowDown");
        await page.keyboard.press(key); await settled();
        expect(await page.getByRole("menu").count()).toBe(0);
        const target = key === "Tab" ? card(1).locator(".nr-card-hitbox") : card().getByRole("button", { name: "Start", exact: true });
        expect(await target.evaluate(node => document.activeElement === node)).toBe(true);
      }
    }
  });
  it("lets the Complete dialog own Escape and restores focus through both layers", async () => {
    for (const selector of ["dialog[open] .dialog-close", "dialog[open] textarea"]) {
      await open(); await page.getByRole("menuitem", { name: "Complete", exact: true }).click(); await settled();
      await page.locator(selector).focus();
      expect(await page.locator("dialog[open]").count()).toBe(1);
      await page.keyboard.press("Escape"); await settled();
      expect(await page.locator("dialog[open]").count()).toBe(0);
      expect(await page.getByRole("menu").count()).toBe(1);
      expect(await focusText()).toBe("Complete");
      await page.keyboard.press("Escape"); await settled();
      expect(await page.getByRole("menu").count()).toBe(0);
      expect(await trigger().evaluate(node => document.activeElement === node)).toBe(true);
    }
  });
  it("preserves native dialog Tab, validation, arrows and ordinary button roles", async () => {
    await open(); await page.getByRole("menuitem", { name: "Complete", exact: true }).click(); await settled();
    expect(await focused("dialog[open] .dialog-close")).toBe(true);
    await page.keyboard.press("ArrowDown");
    expect(await focused("dialog[open] .dialog-close")).toBe(true);
    await page.keyboard.press("Tab"); await settled();
    expect(await page.locator("dialog[open]").count()).toBe(1);
    expect(await page.evaluate(() => Boolean(document.activeElement?.closest("dialog[open]")))).toBe(true);
    await page.locator("dialog[open]").getByRole("button", { name: "Complete", exact: true }).click();
    expect(await focused("dialog[open] textarea")).toBe(true);
    await page.locator("dialog[open] textarea").fill("Synthetic completion note");
    await page.keyboard.press("Home");
    expect(await focused("dialog[open] textarea")).toBe(true);
    await page.screenshot({ path: fileURLToPath(new URL("actions-complete-dialog.png", artifactRoot)) });
    await page.locator("dialog[open]").getByRole("button", { name: "Cancel", exact: true }).click(); await settled();
    expect(await focusText()).toBe("Complete");
  });
  it("keeps menu form activation and cancelled archive confirmation working", async () => {
    await open(); await page.getByRole("menuitem", { name: "Archive", exact: true }).click();
    expect(await page.getByRole("menu").count()).toBe(1);
    await page.getByRole("menuitem", { name: "Return to draft", exact: true }).focus();
    await page.keyboard.press("Enter"); await settled();
    expect(await page.getByRole("menu").count()).toBe(0);
    expect(await trigger().evaluate(node => document.activeElement === node)).toBe(true);
    expect(await page.evaluate(() => (window as unknown as { fixture: { confirmations: number; submissions: { name: string }[] } }).fixture)).toMatchObject({ confirmations: 1, submissions: [{ name: "return-to-draft" }] });
  });
});
