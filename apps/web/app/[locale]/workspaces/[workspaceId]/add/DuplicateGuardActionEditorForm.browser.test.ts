import { existsSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { createServer, type Server } from "node:http";
import { fileURLToPath } from "node:url";
import type { Browser, Page } from "playwright";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

type Payload = Record<string, string>;
type FixtureWindow = typeof window & {
  fixture: {
    submissions: Payload[];
    resolutions: Payload[];
    creations: Payload[];
    release: (() => void) | null;
  };
};

// Real React form actions and editor controls; synthetic server-action responses.
// Deliberately opt-in, loopback only, with no Next server or database.
describe.runIf(process.env.DUPLICATE_GUARD_BROWSER_QA === "1")("Action duplicate confirmation drafts", () => {
  let browser: Browser;
  let server: Server;
  let page: Page;
  let origin: string;
  const errors: string[] = [];
  const output = new URL("../../../../../../../.artifacts/action-duplicate-draft/", import.meta.url);
  const draft = {
    title: "Synthetic unsaved action",
    bodyMd: "# Synthetic notes\n\nPreserve **this draft** without retyping.",
    dueAt: "2031-06-17",
    assigneeMemberId: "member-two",
    priority: "3",
    proposalId: "proposal-two",
    checklistItems: "Synthetic first item\nSynthetic second item",
  };

  beforeAll(async () => {
    await mkdir(output, { recursive: true });
    const { build } = await import("esbuild");
    const { chromium } = await import("playwright");
    const webRoot = new URL("../../../../../", import.meta.url);
    const messages = JSON.parse(await readFile(new URL("messages/en.json", webRoot), "utf8"));
    const bundle = await build({
      stdin: {
        resolveDir: fileURLToPath(webRoot), loader: "tsx",
        contents: `
          import React from "react";
          import { createRoot } from "react-dom/client";
          import { NextIntlClientProvider } from "next-intl";
          import { DuplicateGuardActionEditorForm } from "./app/[locale]/workspaces/[workspaceId]/add/DuplicateGuardActionEditorForm";
          import { DuplicateGuardSubmitButton } from "./app/[locale]/workspaces/[workspaceId]/add/DuplicateGuardForm";
          const fixture = window.fixture = { submissions: [], resolutions: [], creations: [], release: null };
          const params = new URLSearchParams(location.search);
          const confirmation = {
            status: "duplicate_confirmation_required",
            candidate: { entityType: "Action", entityId: "existing-action", title: "Synthetic existing action",
              excerpt: "Synthetic existing notes", score: .94, matchKind: "likely", reasons: ["similar title"] },
            recommendedResolution: "create_new", allowedResolutions: ["use_existing", "update_existing", "create_new"]
          };
          async function action(previous, data) {
            const payload = Object.fromEntries(data);
            fixture.submissions.push(payload);
            await new Promise(resolve => { fixture.release = resolve; });
            if (!data.get("duplicateResolution") || (params.has("repeat") && fixture.submissions.length === 2)) {
              return { ...confirmation, submitIntent: data.get("submitIntent") };
            }
            fixture.resolutions.push(payload);
            if (data.get("duplicateResolution") === "create_new") fixture.creations.push(payload);
            return null;
          }
          const footer = <div className="actions-inline">
            <DuplicateGuardSubmitButton name="submitIntent" value="draft">Save draft</DuplicateGuardSubmitButton>
            <DuplicateGuardSubmitButton name="submitIntent" value="open">Create action</DuplicateGuardSubmitButton>
            <a href="/cancel">Cancel</a>
          </div>;
          addEventListener("pagehide", () => sessionStorage.setItem("duplicate-outcome", JSON.stringify(fixture)));
          createRoot(document.getElementById("root")).render(
            <NextIntlClientProvider locale="en" timeZone="UTC" messages={${JSON.stringify(messages)}}>
              <DuplicateGuardActionEditorForm action={action} workspaceId="synthetic-workspace"
                idempotencyKey="synthetic-stable-form-key" cancelHref="/cancel"
                title={params.has("defaults") ? "Original title" : undefined}
                bodyMd={params.has("defaults") ? "Original notes" : undefined}
                dueAt={params.has("defaults") ? "2030-01-01" : undefined}
                members={[{ id: "member-one", label: "Synthetic One" }, { id: "member-two", label: "Synthetic Two" }]}
                assigneeMemberId="member-one" priority={1}
                footer={params.has("defaultFooter") ? undefined : footer}
                labels={{ title: "Title", notes: "Notes", assignee: "Assignee", assigneeNone: "None",
                  submit: "Create action", cancel: "Cancel", dueDate: "Due date", priorityLabel: "Priority",
                  priority: { 0: "None", 1: "Low", 2: "Normal", 3: "High", 4: "Urgent" } }}>
                <label>Proposal<select name="proposalId" defaultValue=""><option value="">None</option><option value="proposal-two">Synthetic proposal</option></select></label>
                <label>Checklist<textarea name="checklistItems" defaultValue="" /></label>
                <label><input name="requestInput" type="checkbox" value="true" />Request input</label>
              </DuplicateGuardActionEditorForm>
            </NextIntlClientProvider>);
        `,
      },
      bundle: true, write: false, jsx: "automatic",
      define: { "process.env.NODE_ENV": '"production"' },
    });
    const css = await readFile(new URL("app/styles/components.css", webRoot), "utf8");
    server = createServer((request, response) => {
      if (request.url === "/fixture.js") {
        response.setHeader("Content-Type", "text/javascript");
        response.end(bundle.outputFiles[0].text);
      } else if (request.url === "/cancel") {
        response.setHeader("Content-Type", "text/html");
        response.end("<!doctype html><html lang='en'><title>Cancelled</title><body>Cancelled</body></html>");
      } else {
        response.setHeader("Content-Type", "text/html; charset=utf-8");
        response.end(`<!doctype html><html lang="en"><head><title>Synthetic action editor</title><style>${css}
          :root{--accent:#345;--line:#ccc;--surface-strong:#fff;--surface-sunken:#f6f6f6;--text:#123;--muted:#456}
          body{margin:24px;max-width:720px;font-family:Arial}label{display:block}input,textarea,select{box-sizing:border-box;max-width:100%}
          </style></head><body><div id="root"></div><script src="/fixture.js"></script></body></html>`);
      }
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("Missing fixture port");
    origin = `http://127.0.0.1:${address.port}`;
    browser = await chromium.launch({
      headless: true, timeout: 15_000,
      executablePath: process.env.DUPLICATE_GUARD_CHROME_PATH
        ?? (existsSync("/usr/lib/chromium/chromium") ? "/usr/lib/chromium/chromium" : undefined),
    });
    const context = await browser.newContext({ viewport: { width: 1100, height: 1000 } });
    await context.route("**/*", (route) => route.request().url().startsWith(origin + "/") ? route.continue() : route.abort());
    page = await context.newPage();
    page.setDefaultTimeout(10_000);
    page.on("pageerror", (error) => errors.push(error.message));
    page.on("console", (message) => { if (message.type() === "error") errors.push(message.text()); });
  });

  afterAll(async () => {
    await browser?.close();
    if (server) {
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
    await writeFile(new URL("browser-results.json", output), JSON.stringify({ errors, draft }, null, 2));
    expect(errors).toEqual([]);
  });

  async function open(query = "") {
    await page.goto(origin + "/" + query);
    await page.locator("input[name=title]").waitFor();
  }

  async function fillDraft() {
    for (const name of ["title", "bodyMd", "dueAt", "checklistItems"] as const) {
      await page.locator(`[name=${name}]`).fill(draft[name]);
    }
    for (const name of ["assigneeMemberId", "priority", "proposalId"] as const) {
      await page.locator(`[name=${name}]`).selectOption(draft[name]);
    }
    await page.locator("[name=requestInput]").check();
  }

  async function release() {
    await expect.poll(() => page.evaluate(() => typeof (window as FixtureWindow).fixture.release)).toBe("function");
    await page.evaluate(() => {
      const fixture = (window as FixtureWindow).fixture;
      const resolve = fixture.release!;
      fixture.release = null;
      resolve();
    });
    await expect.poll(() => page.locator("button[type=submit]:disabled").count()).toBe(0);
  }

  async function assertDraft() {
    for (const [name, value] of Object.entries(draft)) {
      expect(await page.locator(`[name=${name}]`).inputValue()).toBe(value);
    }
    expect(await page.locator("[name=requestInput]").isChecked()).toBe(true);
  }

  for (const intent of ["open", "draft"] as const) {
    for (const preview of [false, true]) {
      it(`confirms ${intent} from ${preview ? "preview" : "compose"} without retyping or duplicate submission`, async () => {
        await open();
        await fillDraft();
        if (preview) await page.getByRole("button", { name: "Review", exact: true }).click();
        await page.getByRole("button", { name: intent === "open" ? "Create action" : "Save draft", exact: true }).click();
        expect(await page.locator("button[type=submit]:disabled").count()).toBe(2);
        await release();
        await page.getByText("Possible duplicate", { exact: true }).waitFor();
        await assertDraft();
        expect(await page.locator("[name=submitIntent][type=hidden]").inputValue()).toBe(intent);
        if (preview) expect(await page.locator(".md-editor-preview").innerText()).toContain("Preserve this draft");
        if (intent === "open" && !preview) await page.screenshot({ path: fileURLToPath(new URL("duplicate-draft-preserved.png", output)), fullPage: true });
        await page.getByRole("button", { name: "Create new", exact: true }).click({ clickCount: 2 });
        expect(await page.locator("button[type=submit]:disabled").count()).toBe(5);
        await release();
        const actual = await page.evaluate(() => (window as FixtureWindow).fixture);
        expect(actual.submissions).toHaveLength(2);
        expect(actual.creations).toHaveLength(1);
        expect(actual.creations[0]).toMatchObject({ ...draft, requestInput: "true", submitIntent: intent,
          workspaceId: "synthetic-workspace", idempotencyKey: "synthetic-stable-form-key",
          duplicateResolution: "create_new", duplicateTargetEntityId: "existing-action" });
        expect(actual.submissions.map((entry) => entry.idempotencyKey)).toEqual(["synthetic-stable-form-key", "synthetic-stable-form-key"]);
        expect(await page.locator("input[name=title]").inputValue()).toBe("");
        expect(await page.locator("textarea[name=bodyMd]").inputValue()).toBe("");
      });
    }
  }

  for (const resolution of ["use_existing", "update_existing"] as const) {
    it(`preserves edits across another warning and ${resolution} creates nothing`, async () => {
      await open("?defaults&repeat");
      await fillDraft();
      await page.getByRole("button", { name: "Create action", exact: true }).click();
      await release();
      await assertDraft();
      await page.locator(`[name=duplicateResolution][value=${resolution}]`).click();
      await release();
      await assertDraft();
      await page.locator(`[name=duplicateResolution][value=${resolution}]`).click();
      await release();
      const actual = await page.evaluate(() => (window as FixtureWindow).fixture);
      expect(actual.submissions).toHaveLength(3);
      expect(actual.creations).toEqual([]);
      expect(actual.resolutions).toHaveLength(1);
      expect(actual.resolutions[0]).toMatchObject({ ...draft, duplicateResolution: resolution, submitIntent: "open" });
      expect(await page.locator("input[name=title]").inputValue()).toBe("Original title");
      expect(await page.locator("textarea[name=bodyMd]").inputValue()).toBe("Original notes");
    });
  }

  for (const warning of [false, true]) {
    it(`Cancel ${warning ? "after" : "before"} a warning creates nothing`, async () => {
      await open("?defaultFooter");
      await fillDraft();
      if (warning) {
        await page.getByRole("button", { name: "Create action", exact: true }).click();
        await release();
        await assertDraft();
      }
      await page.getByRole("link", { name: "Cancel", exact: true }).click();
      await page.waitForURL(origin + "/cancel");
      const actual = await page.evaluate(() => JSON.parse(sessionStorage.getItem("duplicate-outcome")!));
      expect(actual.submissions).toHaveLength(warning ? 1 : 0);
      expect(actual.creations).toEqual([]);
      expect(actual.resolutions).toEqual([]);
    });
  }

  it("retains native required-title validation", async () => {
    await open();
    await page.getByRole("button", { name: "Create action", exact: true }).click();
    expect(await page.locator("input[name=title]").evaluate((node: HTMLInputElement) => node.validity.valueMissing)).toBe(true);
    expect(await page.evaluate(() => (window as FixtureWindow).fixture.submissions)).toEqual([]);
  });
});
