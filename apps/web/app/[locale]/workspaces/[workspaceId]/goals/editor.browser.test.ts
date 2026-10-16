import { mkdir, readFile, writeFile } from "node:fs/promises";
import { createServer, type Server } from "node:http";
import { fileURLToPath } from "node:url";
import type { Browser, Page } from "playwright";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

// Actual page/editor/menu/form code, synthetic domain reads and server actions.
// The async page is evaluated in this client fixture; static SSR cost is measured
// separately in editor-performance.test.ts. All browser traffic is loopback only.
describe.runIf(process.env.GOAL_EDITOR_BROWSER_QA === "1")("Goal editor browser behavior", () => {
  let browser: Browser;
  let server: Server;
  let page: Page;
  let origin: string;
  const errors: string[] = [];
  const output = new URL("../../../../../../../.artifacts/pun-93/", import.meta.url);
  const webRoot = new URL("../../../../../", import.meta.url);

  beforeAll(async () => {
    await mkdir(output, { recursive: true });
    const { build } = await import("esbuild");
    const { chromium } = await import("playwright");
    const bundle = await build({
      stdin: { resolveDir: fileURLToPath(webRoot), loader: "tsx", contents: `
        import React from "react";
        import { createRoot } from "react-dom/client";
        import { NextIntlClientProvider } from "next-intl";
        import en from "./messages/en.json";
        import GoalsPage from "./app/[locale]/workspaces/[workspaceId]/goals/page";
        const makeGoal = (id, title, extra = {}) => ({
          id, title, descriptionMd: title + " description", cadence: "QUARTERLY", level: "COMPANY",
          status: "DRAFT", version: 3, progressPercent: 0, authorUserId: "synthetic-author",
          isPrivate: true, startDate: "2026-10-01T00:00:00.000Z", targetDate: null,
          parentGoalId: "goal-parent", circleId: "circle-1", ownerMemberId: "member-1",
          keyResults: [], childGoals: [], ...extra,
        });
        window.fixture = { actions: [], result: { status: "conflict" }, resolve: null,
          role: new URLSearchParams(location.search).get("role") ?? "ADMIN",
          goals: [makeGoal("goal-a", "Goal A"), makeGoal("goal-b", "Goal B", { version: 9, authorUserId: "other-author", parentGoalId: null, circleId: null, ownerMemberId: null }),
            makeGoal("goal-shared", "Shared active", { status: "ACTIVE", isPrivate: false, authorUserId: "other-author" }),
            makeGoal("goal-private", "Private active", { status: "ACTIVE", authorUserId: "other-author" }),
            makeGoal("goal-completed", "Completed", { status: "COMPLETED" }),
            makeGoal("goal-parent", "Annual parent", { cadence: "ANNUAL" })] };
        const element = await GoalsPage({ params: Promise.resolve({ workspaceId: "synthetic-workspace" }), searchParams: Promise.resolve({}) });
        createRoot(document.getElementById("root")).render(
          <NextIntlClientProvider locale="en" timeZone="UTC" messages={en}>{element}</NextIntlClientProvider>
        );
      ` },
      bundle: true, write: false, format: "esm", jsx: "automatic", logLevel: "error",
      alias: { "@": fileURLToPath(webRoot) },
      define: { "process.env.NODE_ENV": '"production"', "process.env": "{}" },
      plugins: [{ name: "synthetic-boundaries", setup(build) {
        if (process.env.GOAL_EDITOR_BASELINE_SOURCE) build.onLoad({ filter: /\/goals\/page\.tsx$/ }, async () => ({
          contents: await readFile(process.env.GOAL_EDITOR_BASELINE_SOURCE!, "utf8"), loader: "tsx",
          resolveDir: fileURLToPath(new URL("app/[locale]/workspaces/[workspaceId]/goals/", webRoot)),
        }));
        build.onResolve({ filter: /^(@corgtex\/domain|next-intl\/server|@\/lib\/auth|@\/lib\/workspace-feature-flags|@\/lib\/components\/MarkdownRenderer)$/ }, (args) => ({ path: args.path, namespace: "fixture" }));
        build.onResolve({ filter: /^\.\/actions$/ }, (args) => args.importer.includes("/goals/") ? { path: "actions", namespace: "fixture" } : undefined);
        build.onLoad({ filter: /.*/, namespace: "fixture" }, (args) => {
          const modules: Record<string, string> = {
            "@corgtex/domain": `export const listGoals = async () => window.fixture.goals;
              export const getGoalTree = async () => window.fixture.goals.filter(g => g.cadence === "QUARTERLY");
              export const listCircles = async () => [{ id: "circle-1", name: "Synthetic circle" }];
              export const listHumanMembers = async () => [{ id: "member-1", user: { displayName: null, email: "owner@example.test" } }];
              export const requireWorkspaceMembership = async () => ({ id: "member-1", role: window.fixture.role });
              export const getGoal = async () => null;
              export const getWorkspaceArchiveRecord = async () => null;
              export const getMyGoalSlice = async () => [];
              export const listRecognitions = async () => [];`,
            "@/lib/auth": `export const requirePageActor = async () => ({ kind: "user", user: { id: "synthetic-author" } });`,
            "@/lib/workspace-feature-flags": "export const requireWorkspaceFeature = async () => {};",
            "@/lib/components/MarkdownRenderer": "export const MarkdownRenderer = () => null;",
            "next-intl/server": `import {createTranslator} from "next-intl";
              import en from ${JSON.stringify(fileURLToPath(new URL("messages/en.json", webRoot)))};
              export const getTranslations = async namespace => createTranslator({ locale: "en", messages: en, namespace });`,
            actions: `export const editGoalFormAction = async (_state, data) => {
                window.fixture.actions.push(Object.fromEntries(data));
                await new Promise(resolve => window.fixture.resolve = resolve);
                if (window.fixture.result.status === "throw") throw new Error("Synthetic failure");
                return window.fixture.result;
              };
              export const addKeyResultFormAction = async () => {};
              export const updateKeyResultFormAction = async () => {};
              export const deleteKeyResultFormAction = async () => {};
              export const archiveGoalFormAction = async () => {};
              export const createGoalFormAction = async () => {};
              export const returnGoalToDraftFormAction = async () => {};
              export const updateGoalFormAction = async () => {};`,
          };
          return { contents: modules[args.path], resolveDir: fileURLToPath(webRoot) };
        });
      } }],
    });
    const styles = await Promise.all(["styles/tokens.css", "globals.css", "styles/components.css"].map(async (path) =>
      (await readFile(new URL("app/" + path, webRoot), "utf8")).replace(/@import[^;]+;/g, "")));
    server = createServer((request, response) => {
      response.setHeader("Content-Type", request.url === "/fixture.js" ? "text/javascript" : "text/html; charset=utf-8");
      response.end(request.url === "/fixture.js" ? bundle.outputFiles[0].text : `<!doctype html><html><head><title>Synthetic Goals</title><style>${styles.join("\n")}body{padding:24px}label{display:block}</style></head><body><div id="root"></div><script type="module" src="/fixture.js"></script></body></html>`);
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("Missing fixture port");
    origin = "http://127.0.0.1:" + address.port;
    browser = await chromium.launch({ headless: true, executablePath: process.env.GOAL_EDITOR_CHROME_PATH ?? "/usr/bin/chromium" });
    const context = await browser.newContext({ viewport: { width: 1280, height: 1000 } });
    await context.route("**/*", route => route.request().url().startsWith(origin + "/") ? route.continue() : route.abort());
    page = await context.newPage();
    page.setDefaultTimeout(4000);
    page.on("pageerror", error => errors.push(error.message));
  });
  afterAll(async () => {
    await browser?.close();
    if (server) { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); }
    await writeFile(new URL("browser-results.json", output), JSON.stringify({ errors, mode: "Actual page/editor/menu/form; synthetic reads/actions; loopback only" }, null, 2));
    expect(errors).toEqual([]);
  });

  const row = (title: string) => page.locator(".shadow-sm.mb-3").filter({ has: page.getByRole("heading", { name: title, exact: true }) });
  const editSummary = () => page.getByRole("menu").locator("summary").filter({ hasText: /^Edit$/ });
  const form = () => page.getByRole("menu").locator("form").filter({ has: page.locator("input[name=expectedVersion]") });
  async function openEdit(title: string) {
    await row(title).getByRole("button", { name: "More actions", exact: true }).click();
    await editSummary().click();
    await form().locator("input[name=title]").waitFor();
  }

  it("materializes no selectors until Edit opens, then preserves collapse drafts and resets on cancel/edit B", async () => {
    await page.goto(origin);
    await row("Goal A").getByRole("button", { name: "More actions", exact: true }).click();
    expect(await page.getByRole("menu").locator("select[name=parentGoalId]").count()).toBe(0);
    await editSummary().click();
    const parent = form().locator("select[name=parentGoalId]");
    await parent.waitFor();
    expect(await parent.locator("option[value=goal-a]").count()).toBe(0);
    expect(await parent.locator("option[value=goal-parent]").textContent()).toBe("Annual parent");
    expect(await parent.inputValue()).toBe("goal-parent");
    expect(await form().locator("select[name=ownerMemberId]").inputValue()).toBe("member-1");
    expect(await form().locator("select[name=ownerMemberId] option:checked").textContent()).toBe("owner@example.test");
    await form().locator("input[name=title]").fill("Unsaved A");
    await form().locator("textarea[name=descriptionMd]").fill("Unsaved Markdown");
    await editSummary().click();
    await editSummary().click();
    expect(await form().locator("input[name=title]").inputValue()).toBe("Unsaved A");
    expect(await form().locator("textarea[name=descriptionMd]").inputValue()).toBe("Unsaved Markdown");
    await form().evaluate(node => (node as HTMLFormElement).reset());
    expect(await form().locator("input[name=title]").inputValue()).toBe("Goal A");
    expect(await form().locator("textarea[name=descriptionMd]").inputValue()).toBe("Goal A description");
    await form().locator("input[name=title]").fill("Canceled A");
    await page.keyboard.press("Escape");
    await openEdit("Goal B");
    expect(await form().locator("input[name=title]").inputValue()).toBe("Goal B");
    expect(await form().locator("textarea[name=descriptionMd]").inputValue()).toBe("Goal B description");
    expect(await form().locator("input[name=expectedVersion]").inputValue()).toBe("9");
    expect(await form().locator("select[name=parentGoalId]").inputValue()).toBe("");
    expect(await form().locator("select[name=circleId]").inputValue()).toBe("");
    expect(await form().locator("select[name=ownerMemberId]").inputValue()).toBe("");
    await page.keyboard.press("Escape");
    await openEdit("Goal A");
    expect(await form().locator("input[name=title]").inputValue()).toBe("Goal A");
    await page.screenshot({ path: fileURLToPath(new URL("editor.png", output)), fullPage: true });
  });

  it("retains unsaved fields after conflicts/errors, submits the observed version, and advances it only after success", async () => {
    await page.goto(origin);
    await openEdit("Goal A");
    await form().locator("input[name=title]").fill("Unsaved title");
    await form().locator("textarea[name=descriptionMd]").fill("Unsaved description");
    for (const result of [{ status: "conflict" }, { status: "throw" }, { status: "success", version: 4 }, { status: "conflict" }]) {
      await page.evaluate(value => { (window as any).fixture.result = value; (window as any).fixture.resolve = null; }, result);
      await form().getByRole("button", { name: "Save as draft", exact: true }).click();
      await expect.poll(() => form().getAttribute("aria-busy")).toBe("true");
      expect(await form().getByRole("button", { name: "Saving...", exact: true }).isDisabled()).toBe(true);
      await page.evaluate(() => (window as any).fixture.resolve());
      await expect.poll(() => form().getAttribute("aria-busy")).toBe("false");
      expect(await form().locator("input[name=title]").inputValue()).toBe("Unsaved title");
      expect(await form().locator("textarea[name=descriptionMd]").inputValue()).toBe("Unsaved description");
      expect(await form().getByRole(result.status === "success" ? "status" : "alert").count()).toBe(1);
    }
    const actions = await page.evaluate(() => (window as any).fixture.actions);
    expect(actions.map((action: any) => action.expectedVersion)).toEqual(["3", "3", "3", "4"]);
    expect(actions[0]).toEqual({ workspaceId: "synthetic-workspace", goalId: "goal-a", expectedVersion: "3", title: "Unsaved title", descriptionMd: "Unsaved description", cadence: "QUARTERLY", level: "COMPANY", startDate: "2026-10-01", targetDate: "", parentGoalId: "goal-parent", circleId: "circle-1", ownerMemberId: "member-1" });
    await page.keyboard.press("Escape");
    await openEdit("Goal B");
    expect(await form().getByRole("alert").count()).toBe(0);
    expect(await form().locator("input[name=expectedVersion]").inputValue()).toBe("9");
  });

  it("preserves author/admin, public active collaboration, private Goal and completed Goal permissions", async () => {
    await page.goto(origin + "/?role=MEMBER");
    await row("Goal A").waitFor();
    for (const [title, editable] of [["Goal A", true], ["Goal B", false], ["Shared active", true], ["Private active", false], ["Completed", false]] as const) {
      expect(await row(title).getByRole("button", { name: "More actions", exact: true }).count()).toBe(editable ? 1 : 0);
    }
    await page.goto(origin);
    await row("Goal B").waitFor();
    expect(await row("Goal B").getByRole("button", { name: "More actions", exact: true }).count()).toBe(1);
    expect(await row("Completed").getByRole("button", { name: "More actions", exact: true }).count()).toBe(0);
  });
});
