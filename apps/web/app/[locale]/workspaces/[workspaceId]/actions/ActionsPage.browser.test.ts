import { existsSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { createServer, type Server } from "node:http";
import { fileURLToPath } from "node:url";
import type { Browser, Page } from "playwright";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

// Opt-in real Chromium coverage of the real server-page consumer trees with
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
    await mkdir(new URL("forms-review/", artifactRoot), { recursive: true });
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
        export const syntheticMember = member;
        export const syntheticGoal = { id: "synthetic-goal", title: "Synthetic goal", descriptionMd: "",
          authorUserId: user.id, status: "ACTIVE", isPrivate: false, version: 1, progressPercent: 10,
          cadence: "QUARTERLY", level: "COMPANY", children: [], keyResults: [] };
        export const syntheticRoleData = {
          roles: [{ id: "synthetic-role", name: "Synthetic role", purposeMd: "", accountabilities: [], artifacts: [],
            createdAt: new Date(), updatedAt: new Date(), circle: { id: "synthetic-circle", name: "Synthetic circle" },
            assignments: [{ id: "synthetic-assignment", memberId: member.id, member: { id: member.id, kind: "HUMAN", isActive: true, user } }] }],
          circles: [{ id: "synthetic-circle", name: "Synthetic circle" }, { id: "other-circle", name: "Other circle" }],
          members: [{ id: member.id, name: user.displayName, email: user.email }, { id: "other-member", name: "Other member", email: "other@example.invalid" }],
          onboardingByRoleMember: new Map(),
        };
        export async function listActions() { return { items: actions, total: actions.length }; }
        export async function countActionsByStatus() { return { ALL: 5, OPEN: 2, DRAFT: 1, IN_PROGRESS: 1, COMPLETED: 1 }; }
        export async function listCircles() { return []; }
        export async function listHumanMembers() { return [member]; }
        export async function requireWorkspaceMembership() { return member; }
        export async function getGoal() { return syntheticGoal; }
        export async function getGoalTree() { return [syntheticGoal]; }
        export async function getWorkspaceArchiveRecord() { return null; }
        export async function listGoals() { return [syntheticGoal]; }
        export async function getMyGoalSlice() { return []; }
        export async function listRecognitions() { return []; }
        export async function listTensions() { return { items: [{ ...actions[0], id: "synthetic-tension", upvotes: [], raisedByMember: member }] }; }
        export async function listProposals() { return { items: [{ ...actions[0], id: "synthetic-proposal", ownerMemberId: member.id, ownerMember: member }] }; }
        export async function listAdviceRequests() { return []; }
        export async function listDeliberationEntriesForParents() { return new Map(); }
        export async function listProposalDecisionStates() { return new Map(); }
        export const humanMemberIdentityWhere = () => ({});
        export const isHumanMemberIdentity = () => true;
        export const isRoleAssignmentActive = () => true;
      `,
      "@corgtex/shared": `export const prisma = {
        workspace: { async findUnique() { return { slug: "synthetic-only" }; } },
        workItemEvidence: { async findMany() { return []; } },
      };`,
      "@/lib/auth": `export async function requirePageActor() {
        return { kind: "user", user: { id: "synthetic-user", displayName: "Synthetic owner", email: "owner@example.invalid" } };
      }`,
      "@/lib/workspace-feature-flags": "export async function requireWorkspaceFeature() {}",
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
        export const createTensionAction = capture("create-tension");
        export const updateTensionAction = capture("update-tension");
        export const upvoteTensionAction = capture("upvote-tension");
        export const deleteTensionAction = capture("delete-tension");
        export const publishTensionAction = capture("publish-tension");
        export const returnTensionToDraftAction = capture("return-tension");
        export const createProposalFromTensionAction = capture("draft-proposal");
        export const archiveProposalAction = capture("archive-proposal");
        export const resolveProposalAction = capture("resolve-proposal");
        export const reopenProposalAction = capture("reopen-proposal");
        export const submitProposalAction = capture("submit-proposal");
        export const returnProposalToDraftAction = capture("return-proposal");
        export async function editTensionAction(_state, data) { await capture("edit-tension")(data); return { status: "success", version: 2 }; }
      `,
      "./actions": `
        const capture = name => async data => { window.fixture.submissions.push({ name, fields: Object.fromEntries(data) }); };
        export const addKeyResultFormAction = capture("add-key-result");
        export const updateKeyResultFormAction = capture("update-key-result");
        export const deleteKeyResultFormAction = capture("delete-key-result");
        export const archiveGoalFormAction = capture("archive-goal");
        export const createGoalFormAction = capture("create-goal");
        export const returnGoalToDraftFormAction = capture("return-goal");
        export const updateGoalFormAction = capture("update-goal");
        export async function editGoalFormAction(_state, data) { await capture("edit-goal")(data); return { status: "success", version: 2 }; }
        export async function editProposalAction(_state, data) { await capture("edit-proposal")(data); return { status: "success", version: 2 }; }
      `,
      "../circles/actions": `
        const capture = name => async data => { window.fixture.submissions.push({ name, fields: Object.fromEntries(data) }); };
        export const assignRoleAction = capture("assign-role");
        export const deleteRoleAction = capture("delete-role");
        export const reassignRoleAction = capture("reassign-role");
        export const unassignRoleAction = capture("unassign-role");
        export const updateRoleAction = capture("update-role");
      `,
      // Server-only creation and Markdown rendering are outside this interaction
      // boundary. Keep real card, menu, confirmation, resolution dialog and editor.
      "@/lib/components/ActionEditorForm": "export function ActionEditorForm() { return null; }",
      "@/lib/components/MarkdownRenderer": "export function MarkdownRenderer() { return null; } export function MarkdownExcerpt() { return null; }",
      "./CreateProposalForm": "export function CreateProposalForm() { return null; }",
    };
    const bundle = await build({
      stdin: { resolveDir: fileURLToPath(webRoot), loader: "tsx", contents: `
        import React from "react";
        import { createRoot } from "react-dom/client";
        import { NextIntlClientProvider } from "next-intl";
        import ActionsPage from "./app/[locale]/workspaces/[workspaceId]/actions/page";
        import GoalsPage from "./app/[locale]/workspaces/[workspaceId]/goals/page";
        import TensionsPage from "./app/[locale]/workspaces/[workspaceId]/tensions/page";
        import ProposalsPage from "./app/[locale]/workspaces/[workspaceId]/proposals/page";
        import { RoleDirectorySurface } from "./app/[locale]/workspaces/[workspaceId]/roles/RoleDirectorySurface";
        import { syntheticRoleData } from "@corgtex/domain";
        window.fixture = { submissions: [], confirmations: 0 };
        window.confirm = () => { window.fixture.confirmations++; return false; };
        document.addEventListener("click", event => { if (event.target.closest("a[href]")) event.preventDefault(); }, true);
        (async () => {
          const query = new URLSearchParams(location.search), surface = query.get("surface") ?? "actions";
          const props = { params: Promise.resolve({ workspaceId: "synthetic-workspace" }),
            searchParams: Promise.resolve({ scope: "workspace", status: "ALL", view: query.get("view") ?? "list" }) };
          const tree = surface === "goals" ? await GoalsPage({ ...props, searchParams: Promise.resolve({ view: "tree" }) })
            : surface === "roles" ? await RoleDirectorySurface({ ...syntheticRoleData, workspaceId: "synthetic-workspace", baseHref: "/workspaces/synthetic-workspace/roles", searchParams: await props.searchParams, canManageStructure: true })
            : surface === "tensions" ? await TensionsPage(props)
            : surface === "proposals" ? await ProposalsPage(props) : await ActionsPage(props);
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
            const pageActionImport = ["../actions", "./actions", "./CreateProposalForm"].includes(args.path);
            if (Object.hasOwn(mocks, args.path) && (!pageActionImport || /\/(actions|goals|tensions|proposals)\/page\.tsx$/.test(args.importer))) {
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
  for (const surface of ["goals", "roles", "tensions", "proposals"]) {
    for (const view of surface === "goals" ? ["tree"] : ["list", "table", "kanban"]) {
      it(`${surface} ${view} editor preserves Tab between summary and fields, validation and draft input`, async () => {
        await page.goto(`${origin}/?surface=${surface}&view=${view}`); await page.locator("#after").waitFor(); await settled();
        const opener = page.locator(".item-actions .action-menu-trigger").first();
        await opener.focus(); await page.keyboard.press("Enter"); await settled();
        const panel = page.locator(".action-menu-panel");
        expect(await opener.getAttribute("aria-haspopup")).toBe("dialog");
        if (surface === "roles") expect(await panel.locator("summary").first().evaluate(node => document.activeElement === node)).toBe(true);
        const summary = panel.locator("summary").filter({ hasText: /^Edit/ }).last();
        await summary.focus(); await page.keyboard.press("Enter");
        await page.keyboard.press("Tab"); await settled();
        expect(await panel.count()).toBe(1);
        expect(await panel.getAttribute("role")).toBe("dialog");
        const titleName = surface === "roles" ? "name" : "title";
        const title = panel.locator(`details[open] input[name="${titleName}"]`);
        expect(await title.evaluate(node => document.activeElement === node)).toBe(true);
        await title.fill("Unsaved synthetic edit");
        await page.keyboard.press("Tab"); await settled();
        expect(await panel.count()).toBe(1);
        expect(await title.inputValue()).toBe("Unsaved synthetic edit");
        expect(await page.evaluate(() => Boolean(document.activeElement?.closest(".action-menu-panel")))).toBe(true);
        await page.keyboard.press("Shift+Tab"); await settled();
        expect(await title.evaluate(node => document.activeElement === node)).toBe(true);
        await page.screenshot({ path: fileURLToPath(new URL(`forms-review/${surface}-${view}-editor.png`, artifactRoot)) });
        await page.keyboard.press("Escape"); await settled();
        expect(await panel.count()).toBe(0);
        expect(await opener.evaluate(node => document.activeElement === node)).toBe(true);
        await opener.press("Enter"); await settled();
        await summary.focus(); await page.keyboard.press("Enter"); await page.keyboard.press("Tab");
        const form = title.locator("xpath=ancestor::form[1]");
        await title.fill(""); await form.locator('button[type="submit"]').click();
        expect(await title.evaluate(node => document.activeElement === node)).toBe(true);
        expect(await page.evaluate(() => (window as unknown as { fixture: { submissions: unknown[] } }).fixture.submissions.length)).toBe(0);
        await title.fill("Saved synthetic edit");
        for (const textarea of await form.locator("textarea[required]").all()) await textarea.fill("Synthetic required description");
        await form.locator('button[type="submit"]').click(); await settled();
        const submissions = await page.evaluate(() => (window as unknown as { fixture: { submissions: { fields: Record<string, string> }[] } }).fixture.submissions);
        expect(submissions).toHaveLength(1);
        expect(submissions[0].fields[titleName]).toBe("Saved synthetic edit");
      });
    }
  }
  it.each(["goals", "roles"])("%s secondary form retains native field navigation and submits once", async surface => {
    await page.goto(`${origin}/?surface=${surface}`); await page.locator("#after").waitFor(); await settled();
    const opener = page.locator(".item-actions .action-menu-trigger").first();
    await opener.focus(); await page.keyboard.press("Enter"); await settled();
    const panel = page.locator(".action-menu-panel");
    const summary = panel.locator("summary").filter({ hasText: surface === "roles" ? /^Assign/ : /^Add key result/ }).first();
    await summary.focus(); await page.keyboard.press("Space"); await page.keyboard.press("Tab"); await settled();
    const form = panel.locator("details[open] form").first();
    const first = form.locator(surface === "roles" ? 'select[name="memberId"]' : 'input[name="title"]');
    expect(await first.evaluate(node => document.activeElement === node)).toBe(true);
    if (surface === "roles") await first.selectOption("other-member");
    else await first.fill("Synthetic key result");
    await page.keyboard.press("Tab"); await settled();
    expect(await panel.count()).toBe(1);
    const next = form.locator(surface === "roles" ? 'input[name="expiresAt"]' : 'input[name="currentValue"]');
    expect(await next.evaluate(node => document.activeElement === node)).toBe(true);
    await page.keyboard.press("Shift+Tab");
    expect(await first.evaluate(node => document.activeElement === node)).toBe(true);
    await form.locator('button[type="submit"]').click(); await settled();
    expect(await page.evaluate(() => (window as unknown as { fixture: { submissions: unknown[] } }).fixture.submissions.length)).toBe(1);
    expect(await panel.count()).toBe(0);
    expect(await opener.evaluate(node => document.activeElement === node)).toBe(true);
  });
});
