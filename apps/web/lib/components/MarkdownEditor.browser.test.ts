import { existsSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { createServer, type Server } from "node:http";
import { fileURLToPath } from "node:url";
import type { Browser, Page } from "playwright";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

type FixtureProps = {
  locale?: "en" | "es";
  defaultValue?: string;
  value?: string;
  resetKey?: string;
  disabled?: boolean;
  required?: boolean;
  ariaLabel?: string;
  refKind?: "object";
  otherRequired?: boolean;
  secondEditor?: boolean;
};
type FixtureWindow = typeof window & {
  fixture: {
    calls: Array<{ markdown: string; ms: number }>;
    changes: Array<{ value: string; eventType?: string }>;
    events: string[];
    refNodes: Array<HTMLTextAreaElement | null>;
    textarea: HTMLTextAreaElement | null;
    objectRef: { current: HTMLTextAreaElement | null };
    submissions: Array<FormDataEntryValue | null>;
    configure: (props: FixtureProps) => void;
  };
};

// Opt-in real client regression, with the actual renderer/parser/paste converter,
// synthetic bodies and loopback-only requests. No Next server or database needed.
describe.runIf(process.env.MARKDOWN_EDITOR_BROWSER_QA === "1")("MarkdownEditor client behavior", () => {
  let browser: Browser;
  let server: Server;
  let page: Page;
  let origin: string;
  let axeSource: string;
  const errors: string[] = [];
  const measurements: unknown[] = [];
  const output = new URL("../../../../.artifacts/pun-94/", import.meta.url);

  beforeAll(async () => {
    await mkdir(output, { recursive: true });
    const axePath = new URL("../../../../node_modules/axe-core/axe.min.js", import.meta.url);
    if (!existsSync(axePath)) throw new Error("MARKDOWN_EDITOR_BROWSER_QA=1 requires axe-core for all four toolbar audits. Run npm ci before browser QA.");
    axeSource = await readFile(axePath, "utf8");
    const { build } = await import("esbuild");
    const { chromium } = await import("playwright");
    const webRoot = new URL("../../", import.meta.url);
    const messages = Object.fromEntries(await Promise.all(["en", "es"].map(async (locale) => [
      locale, { shared: { markdownEditor: JSON.parse(await readFile(new URL(`messages/${locale}.json`, webRoot), "utf8")).shared.markdownEditor } },
    ])));
    const bundle = await build({
      stdin: {
        resolveDir: fileURLToPath(webRoot), loader: "tsx",
        contents: `
          import React, { useState } from "react";
          import { createRoot } from "react-dom/client";
          import { NextIntlClientProvider } from "next-intl";
          import { marked } from "marked";
          import { MarkdownEditor } from "./lib/components/MarkdownEditor";
          const fixture = window.fixture = { calls: [], changes: [], events: [], refNodes: [], submissions: [], objectRef: React.createRef() };
          const parse = marked.parse.bind(marked);
          marked.parse = (...args) => {
            const start = performance.now();
            const html = parse(...args);
            fixture.calls.push({ markdown: args[0], ms: performance.now() - start });
            return html;
          };
          const captureRef = node => { fixture.textarea = node; fixture.refNodes.push(node); };
          function Fixture() {
            const [props, setProps] = useState({ defaultValue: "Synthetic default", resetKey: "one" });
            fixture.configure = patch => setProps(current => ({ ...current, ...patch }));
            const locale = props.locale ?? "en";
            return <NextIntlClientProvider locale={locale} timeZone="UTC" messages={(${JSON.stringify(messages)})[locale]}>
              <form onSubmit={event => { event.preventDefault(); fixture.submissions.push(new FormData(event.currentTarget).get("bodyMd")); }}>
                {props.otherRequired && <label>Synthetic title<input name="title" required /></label>}
                <label htmlFor="body">Synthetic body</label>
                <MarkdownEditor id="body" name="bodyMd" required rows={8}
                  ariaAutocomplete="list" ariaControls="mentions" ariaActivedescendant="mention-1"
                  {...props} textareaRef={props.refKind === "object" ? fixture.objectRef : captureRef}
                  onSelect={() => fixture.events.push("select")}
                  onClick={() => fixture.events.push("click")}
                  onKeyDown={event => fixture.events.push("key:" + event.key)}
                  onValueChange={(value, event) => {
                    fixture.changes.push({ value, eventType: event?.type });
                    if (props.value !== undefined) setProps(current => ({ ...current, value }));
                  }} />
                {props.secondEditor && <><label htmlFor="second-body">Second synthetic body</label><MarkdownEditor id="second-body" name="secondBodyMd" defaultValue="" required /></>}
                <button type="submit">Save synthetic draft</button>
              </form>
            </NextIntlClientProvider>;
          }
          createRoot(document.getElementById("root")).render(<Fixture />);
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
      } else {
        response.setHeader("Content-Type", "text/html; charset=utf-8");
        response.end(`<!doctype html><html lang="en"><head><title>Synthetic Markdown editor</title><style>${css}
          :root{--accent:#345;--accent-soft:#eef;--line:#ccc;--surface-strong:#fff;--surface-sunken:#f6f6f6;--text:#123}
          body{margin:24px;max-width:900px;font-family:Arial}textarea{box-sizing:border-box;width:100%}
          </style></head><body><div id="root"></div><script src="/fixture.js"></script></body></html>`);
      }
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("Missing fixture port");
    origin = "http://127.0.0.1:" + address.port;
    browser = await chromium.launch({
      headless: true, timeout: 15_000,
      executablePath: process.env.MARKDOWN_EDITOR_CHROME_PATH
        ?? (existsSync("/usr/lib/chromium/chromium") ? "/usr/lib/chromium/chromium" : undefined),
    });
    const context = await browser.newContext({ viewport: { width: 1200, height: 800 } });
    await context.route("**/*", (route) => route.request().url().startsWith(origin + "/") ? route.continue() : route.abort());
    page = await context.newPage();
    page.setDefaultTimeout(15_000);
    page.on("pageerror", (error) => errors.push(error.message));
    page.on("console", (message) => { if (message.type() === "error") errors.push(message.text()); });
  });

  beforeEach(async () => {
    await page.goto(origin);
    await page.getByRole("textbox", { name: "Synthetic body" }).waitFor();
  });

  afterAll(async () => {
    await browser?.close();
    if (server) {
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
    await writeFile(new URL("browser-results.json", output), JSON.stringify({
      mode: "Real client component and parser, synthetic inputs, production React without StrictMode, loopback only",
      measurements, errors,
    }, null, 2));
    expect(errors).toEqual([]);
  });

  async function configure(props: FixtureProps) {
    await page.evaluate(async (patch) => {
      (window as FixtureWindow).fixture.configure(patch);
      await new Promise(requestAnimationFrame);
    }, props);
  }

  async function takeCalls() {
    return page.evaluate(() => (window as FixtureWindow).fixture.calls.splice(0));
  }

  async function input(value: string) {
    // Native setter bypasses React's value tracker; input dispatch reaches the real
    // onChange handler. Avoid Playwright fill's large-body actionability overhead.
    await page.locator("textarea").evaluate((node, next) => {
      Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")!.set!.call(node, next);
      node.dispatchEvent(new Event("input", { bubbles: true }));
    }, value);
    await page.evaluate(() => new Promise(requestAnimationFrame));
    expect(await page.locator("textarea").inputValue()).toBe(value);
  }

  async function preview() {
    await page.getByRole("button", { name: "Review", exact: true }).click();
  }

  async function write() {
    await page.getByRole("button", { name: "Compose", exact: true }).click();
  }

  for (const locale of ["en", "es"] as const) {
    for (const viewport of [{ width: 1200, height: 800 }, { width: 390, height: 844 }]) {
      it(`includes visible toolbar labels in ${locale} computed names at ${viewport.width}px`, async () => {
        await page.setViewportSize(viewport);
        try {
          await configure({ locale });
          measurements.push({ kind: "toolbar-accessibility-tree", locale, viewport, snapshot: await page.locator(".md-editor-toolbar").ariaSnapshot() });
          const actions = locale === "en"
            ? [["H1", "H1: Heading 1"], ["H2", "H2: Heading 2"], ["1.", "1. Numbered list"]]
            : [["H1", "H1: Encabezado 1"], ["H2", "H2: Encabezado 2"], ["1.", "1. Lista numerada"]];
          await page.addScriptTag({ content: axeSource });
          const audit = await page.evaluate(async () => {
            const axe = (window as unknown as { axe: { run: (context: string, options: unknown) => Promise<{ violations: unknown[]; passes: Array<{ id: string }>; incomplete: Array<{ id: string }> }> } }).axe;
            return axe.run(".md-editor-toolbar", { runOnly: { type: "rule", values: ["button-name", "label-content-name-mismatch"] } });
          });
          measurements.push({ kind: "toolbar-axe", locale, viewport, violations: audit.violations, passes: audit.passes.map(({ id }) => id), incomplete: audit.incomplete.map(({ id }) => id) });
          expect(audit.violations).toEqual([]);
          const names = [];
          for (const [label, name] of actions) {
            const button = page.locator(".md-editor-toolbar button").filter({ hasText: new RegExp("^" + label.replace(".", "\\.") + "$") });
            const snapshot = await button.ariaSnapshot();
            measurements.push({ kind: "computed-name", locale, viewport, label, snapshot });
            expect(snapshot).toContain(`button "${name}"`);
            expect(await page.getByRole("button", { name, exact: true }).count()).toBe(1);
            expect(await button.innerText()).toBe(label);
            expect(await button.isVisible()).toBe(true);
            names.push(await button.ariaSnapshot());
          }
          measurements.push({ kind: "accessible-names", locale, viewport, names });
          await page.screenshot({ path: fileURLToPath(new URL(`toolbar-${locale}-${viewport.width}.png`, output)) });
          expect(await takeCalls()).toEqual([]);
        } finally {
          await page.setViewportSize({ width: 1200, height: 800 });
        }
      });
    }
  }

  for (const controlled of [false, true]) {
    it.each([1, 40, 200])(`parses only visible previews of a %i KiB ${controlled ? "controlled" : "uncontrolled"} body`, async (kib) => {
      const seed = "# Synthetic heading\n\n**Synthetic** body.\n\n";
      const draft = seed.repeat(Math.ceil(kib * 1024 / seed.length)).slice(0, kib * 1024);
      // Set the body through the uncontrolled reset or the controlled owner.
      await configure(controlled ? { value: draft } : { defaultValue: draft, resetKey: "sized" });
      const initialCalls = await takeCalls();
      expect(initialCalls).toEqual([]);
      const changes = [];
      for (let i = 1; i <= 3; i++) {
        await input(draft + "\n\n# Latest synthetic " + i);
        changes.push((await takeCalls()).length);
      }
      expect(changes).toEqual([0, 0, 0]);
      expect(await page.evaluate(() => (window as FixtureWindow).fixture.changes.map((change) => change.eventType))).toEqual(["change", "change", "change"]);
      await preview();
      const previewCalls = await takeCalls();
      expect(previewCalls).toHaveLength(1);
      expect(previewCalls[0].markdown).toBe(draft + "\n\n# Latest synthetic 3");
      expect(await page.locator(".md-editor-preview h1").last().innerText()).toBe("Latest synthetic 3");
      expect(await page.locator(".md-editor-toolbar").count()).toBe(0);
      expect(await page.evaluate(() => new FormData(document.querySelector("form")!).get("bodyMd"))).toBe(draft + "\n\n# Latest synthetic 3");
      await write();
      expect(await takeCalls()).toEqual([]);
      expect(await page.locator(".md-editor-preview").count()).toBe(0);
      await input(draft + "\n\n# Newest synthetic");
      expect(await takeCalls()).toEqual([]);
      await preview();
      expect(await page.locator(".md-editor-preview h1").last().innerText()).toBe("Newest synthetic");
      measurements.push({ kib, controlled, initialWriteCalls: initialCalls.length, inputChanges: changes, firstPreviewCalls: previewCalls.length, firstPreviewParseMs: previewCalls[0].ms, latest: true });
    });
  }

  it("preserves uncontrolled edits until resetKey changes or the form resets", async () => {
    await input("Edited synthetic draft");
    await configure({ defaultValue: "New default" });
    expect(await page.locator("textarea").inputValue()).toBe("Edited synthetic draft");
    await preview();
    await configure({ resetKey: "two" });
    expect(await page.locator("textarea").inputValue()).toBe("New default");
    expect(await page.locator(".md-editor-preview").count()).toBe(0);
    expect(await page.getByRole("button", { name: "Compose" }).getAttribute("data-active")).toBe("true");
    await input("Another edit");
    await preview();
    await page.evaluate(() => document.querySelector("form")!.reset());
    await page.getByRole("textbox", { name: "Synthetic body" }).waitFor();
    expect(await page.locator("textarea").inputValue()).toBe("New default");
    expect(await page.locator(".md-editor-preview").count()).toBe(0);
  });

  it("keeps controlled owner updates live and leaves controlled reset behavior intact", async () => {
    await configure({ value: "# Controlled first", refKind: "object" });
    await input("# Controlled edited");
    await preview();
    await configure({ value: "# Controlled latest", defaultValue: "Ignored default", resetKey: "two" });
    expect(await page.locator(".md-editor-preview h1").innerText()).toBe("Controlled latest");
    await page.evaluate(() => document.querySelector("form")!.reset());
    expect(await page.locator(".md-editor-preview h1").innerText()).toBe("Controlled latest");
    await write();
    expect(await page.locator("textarea").inputValue()).toBe("# Controlled latest");
    expect(await page.evaluate(() => (window as FixtureWindow).fixture.objectRef.current === document.querySelector("textarea"))).toBe(true);
    await configure({ value: "" });
    await takeCalls();
    await preview();
    expect(await page.locator(".md-editor-preview").innerText()).toBe("Nothing to preview.");
    expect(await takeCalls()).toEqual([]);
  });

  it("preserves the textarea node, ref, selection, labels, validation and forwarded events", async () => {
    const textarea = page.getByRole("textbox", { name: "Synthetic body" });
    await textarea.fill("abc");
    await textarea.click();
    await textarea.press("ArrowLeft");
    await textarea.evaluate((node) => (node as HTMLTextAreaElement).setSelectionRange(1, 2));
    await preview();
    await write();
    expect(await page.evaluate(() => {
      const fixture = (window as FixtureWindow).fixture;
      const node = document.querySelector("textarea")!;
      return { same: fixture.textarea === node, refs: fixture.refNodes.length, start: node.selectionStart, end: node.selectionEnd, label: document.querySelector("label")!.control === node, events: fixture.events };
    })).toMatchObject({ same: true, refs: 1, start: 1, end: 2, label: true, events: expect.arrayContaining(["click", "select", "key:ArrowLeft"]) });
    expect(await textarea.getAttribute("name")).toBe("bodyMd");
    expect(await textarea.getAttribute("rows")).toBe("8");
    expect(await textarea.getAttribute("aria-autocomplete")).toBe("list");
    expect(await textarea.getAttribute("aria-controls")).toBe("mentions");
    expect(await textarea.getAttribute("aria-activedescendant")).toBe("mention-1");
    await input("");
    expect(await textarea.evaluate((node) => (node as HTMLTextAreaElement).checkValidity())).toBe(false);
    await configure({ disabled: true, ariaLabel: "Disabled draft" });
    expect(await page.getByRole("textbox", { name: "Disabled draft" }).isDisabled()).toBe(true);
    expect(await page.evaluate(() => new FormData(document.querySelector("form")!).has("bodyMd"))).toBe(false);
  });

  for (const controlled of [false, true]) {
    it(`prevents disabled ${controlled ? "controlled" : "uncontrolled"} toolbar and paste edits, then supports re-enabling`, async () => {
      await configure(controlled ? { value: "abc", disabled: true } : { defaultValue: "abc", resetKey: "disabled", disabled: true });
      const buttons = page.locator(".md-editor-toolbar button");
      expect(await buttons.count()).toBe(9);
      await page.locator("textarea").evaluate((node) => (node as HTMLTextAreaElement).setSelectionRange(0, 3));
      for (const button of await buttons.all()) {
        await button.evaluate((node) => (node as HTMLButtonElement).click());
        await page.evaluate(() => new Promise(requestAnimationFrame));
      }
      const pastePrevented = await page.locator("textarea").evaluate((node) => {
        const clipboardData = new DataTransfer();
        clipboardData.setData("text/html", "<strong>Disabled paste</strong>");
        const event = new ClipboardEvent("paste", { clipboardData, bubbles: true, cancelable: true });
        node.dispatchEvent(event);
        return event.defaultPrevented;
      });
      await page.evaluate(() => new Promise(requestAnimationFrame));
      const snapshot = await page.evaluate(() => {
        const fixture = (window as FixtureWindow).fixture;
        return { value: document.querySelector("textarea")!.value, changes: fixture.changes.length,
          disabledButtons: [...document.querySelectorAll<HTMLButtonElement>(".md-editor-toolbar button")].filter((button) => button.disabled).length };
      });
      measurements.push({ kind: "disabled", controlled, ...snapshot, pastePrevented });
      expect(snapshot).toEqual({ value: "abc", changes: 0, disabledButtons: 9 });
      expect(pastePrevented).toBe(false);
      expect(await takeCalls()).toEqual([]);
      await page.screenshot({ path: fileURLToPath(new URL(`disabled-${controlled ? "controlled" : "uncontrolled"}.png`, output)) });
      await preview();
      expect(await page.locator(".md-editor-preview").innerText()).toBe("abc");
      await write();
      await configure({ disabled: false });
      expect(await page.getByRole("button", { name: "Bold", exact: true }).isEnabled()).toBe(true);
      await page.getByRole("button", { name: "Bold", exact: true }).click();
      await page.evaluate(() => new Promise(requestAnimationFrame));
      expect(await page.locator("textarea").inputValue()).toBe("**abc**");
      expect(await page.evaluate(() => (window as FixtureWindow).fixture.changes.length)).toBe(1);
    });

    it(`reveals an invalid required ${controlled ? "controlled" : "uncontrolled"} draft from Preview for native correction and submission`, async () => {
      await configure(controlled ? { value: "", resetKey: "validation" } : { defaultValue: "", resetKey: "validation" });
      await preview();
      await page.getByRole("button", { name: "Save synthetic draft" }).click();
      await page.evaluate(() => new Promise(requestAnimationFrame));
      const snapshot = {
        visible: await page.locator("textarea").isVisible(),
        ...await page.evaluate(() => {
          const fixture = (window as FixtureWindow).fixture;
          const textarea = document.querySelector("textarea")!;
          return { value: textarea.value, focused: document.activeElement === textarea, invalid: textarea.validity.valueMissing,
            message: textarea.validationMessage, changes: fixture.changes.length, submissions: fixture.submissions.length,
            sameNode: fixture.textarea === textarea, refCount: fixture.refNodes.length };
        }),
      };
      measurements.push({ kind: "required-preview", controlled, ...snapshot });
      expect(snapshot).toMatchObject({ visible: true, value: "", focused: true, invalid: true, changes: 0, submissions: 0, sameNode: true, refCount: 1 });
      expect(snapshot.message).not.toBe("");
      expect(await page.locator(".md-editor-preview").count()).toBe(0);
      expect(await takeCalls()).toEqual([]);
      await page.screenshot({ path: fileURLToPath(new URL(`required-invalid-${controlled ? "controlled" : "uncontrolled"}.png`, output)) });
      await input("Ready synthetic draft");
      await preview();
      await page.getByRole("button", { name: "Save synthetic draft" }).click();
      expect(await page.evaluate(() => (window as FixtureWindow).fixture.submissions)).toEqual(["Ready synthetic draft"]);
      await page.evaluate(() => document.querySelector("form")!.reset());
      await page.evaluate(() => new Promise(requestAnimationFrame));
      expect(await page.locator("textarea").inputValue()).toBe(controlled ? "Ready synthetic draft" : "");
      expect(await page.locator(".md-editor-preview").count()).toBe(controlled ? 1 : 0);
    });
  }

  it("submits an optional empty draft from Preview without exposing validation", async () => {
    await configure({ defaultValue: "", resetKey: "optional", required: false });
    await preview();
    await page.getByRole("button", { name: "Save synthetic draft" }).click();
    expect(await page.evaluate(() => (window as FixtureWindow).fixture.submissions)).toEqual([""]);
    expect(await page.locator(".md-editor-preview").count()).toBe(1);
    expect(await page.locator("textarea").isVisible()).toBe(false);
  });

  it("preserves native first-invalid-field focus while revealing the required draft", async () => {
    await configure({ defaultValue: "", resetKey: "first-invalid", otherRequired: true });
    await preview();
    await page.getByRole("button", { name: "Save synthetic draft" }).click();
    await page.evaluate(() => new Promise(requestAnimationFrame));
    expect(await page.locator("textarea").isVisible()).toBe(true);
    expect(await page.getByRole("textbox", { name: "Synthetic title" }).evaluate((node) => document.activeElement === node)).toBe(true);
    expect(await page.evaluate(() => (window as FixtureWindow).fixture.submissions)).toEqual([]);
  });

  it("reveals two invalid previews and focuses the first required editor", async () => {
    await configure({ defaultValue: "", resetKey: "two-editors", secondEditor: true });
    for (const button of await page.getByRole("button", { name: "Review", exact: true }).all()) await button.click();
    await page.getByRole("button", { name: "Save synthetic draft" }).click();
    await page.evaluate(() => new Promise(requestAnimationFrame));
    expect(await page.locator(".md-editor-preview").count()).toBe(0);
    expect(await page.locator("#body").isVisible()).toBe(true);
    expect(await page.locator("#second-body").isVisible()).toBe(true);
    expect(await page.locator("#body").evaluate((node) => document.activeElement === node)).toBe(true);
    expect(await page.evaluate(() => (window as FixtureWindow).fixture.submissions)).toEqual([]);
  });

  it("preserves formatting selection, focus and fallback text without hidden parsing", async () => {
    const cases: Array<[string, string, number, number]> = [
      ["Bold", "**abc**", 2, 5], ["Italic", "_abc_", 1, 4],
      ["H1: Heading 1", "# abc", 2, 5], ["H2: Heading 2", "## abc", 3, 6],
      ["Bulleted list", "- abc", 5, 5], ["1. Numbered list", "1. abc", 6, 6],
      ["Quote", "> abc", 5, 5], ["Link", "[abc](https://)", 6, 14], ["Code", "`abc`", 1, 4],
    ];
    for (const [name, result, start, end] of cases) {
      await input("abc");
      await page.locator("textarea").evaluate((node) => (node as HTMLTextAreaElement).setSelectionRange(0, 3));
      await page.getByRole("button", { name, exact: true }).click();
      await page.evaluate(() => new Promise(requestAnimationFrame));
      expect(await page.locator("textarea").inputValue()).toBe(result);
      expect(await page.locator("textarea").evaluate((node) => ({ focused: document.activeElement === node, start: (node as HTMLTextAreaElement).selectionStart, end: (node as HTMLTextAreaElement).selectionEnd }))).toEqual({ focused: true, start, end });
    }
    await input("");
    await page.getByRole("button", { name: "Bold", exact: true }).click();
    expect(await page.locator("textarea").inputValue()).toBe("**text**");
    expect(await takeCalls()).toEqual([]);
    expect(await page.evaluate(() => (window as FixtureWindow).fixture.changes.at(-1)?.eventType)).toBeUndefined();
    await preview();
    expect(await page.locator(".md-editor-preview strong").innerText()).toBe("text");
  });

  it("converts rich paste and preserves native plain paste, then previews the latest text", async () => {
    await input("Before selected after");
    await page.locator("textarea").evaluate((node) => (node as HTMLTextAreaElement).setSelectionRange(7, 15));
    const richPrevented = await page.locator("textarea").evaluate((node) => {
      const clipboardData = new DataTransfer();
      clipboardData.setData("text/html", "<strong>Rich synthetic</strong>");
      const event = new ClipboardEvent("paste", { clipboardData, bubbles: true, cancelable: true });
      node.dispatchEvent(event);
      return event.defaultPrevented;
    });
    expect(richPrevented).toBe(true);
    expect(await page.locator("textarea").inputValue()).toBe("Before **Rich synthetic** after");
    expect(await takeCalls()).toEqual([]);
    const plainPrevented = await page.locator("textarea").evaluate((node) => {
      const clipboardData = new DataTransfer();
      clipboardData.setData("text/plain", "Plain synthetic");
      const event = new ClipboardEvent("paste", { clipboardData, bubbles: true, cancelable: true });
      node.dispatchEvent(event);
      return event.defaultPrevented;
    });
    // Untrusted synthetic paste has no browser default insertion; prove the
    // component leaves it available and exercise the subsequent native input.
    expect(plainPrevented).toBe(false);
    await input("Before **Rich synthetic** after\n\nPlain synthetic");
    await preview();
    expect(await page.locator(".md-editor-preview strong").innerText()).toBe("Rich synthetic");
    expect(await page.locator(".md-editor-preview").innerText()).toContain("Plain synthetic");
    await page.screenshot({ path: fileURLToPath(new URL("preview-desktop.png", output)) });
    await write();
    await page.setViewportSize({ width: 390, height: 844 });
    await page.screenshot({ path: fileURLToPath(new URL("write-mobile.png", output)) });
    await page.setViewportSize({ width: 1200, height: 800 });
  });
});
