import { mkdir, writeFile } from "node:fs/promises";
import { createServer, type Server } from "node:http";
import { fileURLToPath } from "node:url";
import type { Browser, Page } from "playwright";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

// Real uploader/editor/time-zone controls; synthetic responses and loopback only.
describe.runIf(process.env.TEXT_PASTE_BROWSER_QA === "1")("Text paste pending drafts", () => {
  let browser: Browser;
  let server: Server;
  let page: Page;
  let origin: string;
  const errors: string[] = [];
  const output = new URL("../../../../../../../.artifacts/text-paste/", import.meta.url);
  const webRoot = new URL("../../../../../", import.meta.url);
  const duplicate = { status: "duplicate_confirmation_required", candidate: {
    entityType: "article", entityId: "synthetic-A", title: "Existing A", excerpt: "Synthetic excerpt",
    score: 1, matchKind: "exact", reasons: ["Exact content"],
  }, recommendedResolution: "use_existing", allowedResolutions: ["use_existing", "update_existing", "create_new"] };

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
        import { TextPasteUploader } from "./app/[locale]/workspaces/[workspaceId]/settings/TextPasteUploader";
        window.fixture = { requests: [], refreshes: 0, pushes: [] };
        window.fetch = (url, options) => new Promise((resolve, reject) => {
          window.fixture.requests.push({url, body: JSON.parse(options.body), resolve: (status, body) =>
            resolve(new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } })), resolveHeaders: (status) => resolve({ ok: status < 300, status, json: () => new Promise(resolveBody => { window.fixture.resolveBody = resolveBody; }) }), reject});
        });
        const root = createRoot(document.getElementById("root"));
        window.mount = (workspaceId = "synthetic-workspace") => root.render(
          <NextIntlClientProvider locale="en" timeZone="UTC" messages={en}>
            <TextPasteUploader workspaceId={workspaceId} />
          </NextIntlClientProvider>);
        window.unmount = () => root.render(null);
        window.mount();
      ` }, bundle: true, write: false, jsx: "automatic",
      alias: { "@": fileURLToPath(webRoot) }, define: { "process.env.NODE_ENV": '"production"' },
      plugins: [{ name: "synthetic-router", setup(build) {
        build.onResolve({ filter: /^next\/navigation$/ }, () => ({ path: "router", namespace: "synthetic" }));
        build.onLoad({ filter: /.*/, namespace: "synthetic" }, () => ({ contents:
          "export const useRouter = () => ({refresh: () => window.fixture.refreshes++, push: path => window.fixture.pushes.push(path)});" }));
      } }],
    });
    server = createServer((request, response) => {
      response.setHeader("Content-Type", request.url === "/fixture.js" ? "text/javascript" : "text/html");
      response.end(request.url === "/fixture.js" ? bundle.outputFiles[0].text :
        '<!doctype html><html><body><div id="root"></div><script src="/fixture.js"></script></body></html>');
    });
    await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("Missing port");
    origin = `http://127.0.0.1:${address.port}`;
    browser = await chromium.launch({ headless: true, executablePath: process.env.TEXT_PASTE_CHROME_PATH ?? "/usr/bin/chromium" });
    const context = await browser.newContext({ timezoneId: "UTC" });
    await context.route("**/*", route => route.request().url().startsWith(origin + "/") ? route.continue() : route.abort());
    page = await context.newPage();
    page.on("pageerror", error => errors.push(error.message));
    page.setDefaultTimeout(3000);
  });
  afterAll(async () => {
    await browser?.close();
    if (server) { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); }
    await writeFile(new URL("browser-results.json", output), JSON.stringify({ errors, mode: "Actual component; synthetic held responses; loopback only" }, null, 2));
    expect(errors).toEqual([]);
  });
  const requests = () => page.evaluate(() => (window as any).fixture.requests.map((r: any) => ({ url: r.url, body: r.body })));
  const release = async (status: number, body: unknown = {}, index = 0) => {
    await page.evaluate(({ status, body, index }) => (window as any).fixture.requests[index].resolve(status, body), { status, body, index });
    await expect.poll(() => page.locator('button[type="submit"]').textContent()).not.toMatch(/Ingesting/);
  };
  const fresh = async (meeting = false) => {
    await page.goto(origin);
    await page.locator('textarea[required]').fill("Content A");
    await page.locator('input').first().fill("Title A");
    await page.locator('[name="ingestionGuidanceMd"]').fill("Guidance A");
    if (meeting) {
      await page.locator('select').first().selectOption("MEETING");
      await page.locator('[type="datetime-local"]').fill("2026-10-15T10:00");
    } else await page.locator('input').nth(1).fill("Channel A");
  };
  const submit = async () => {
    await page.locator('button[type="submit"]').click();
    await expect.poll(async () => (await requests()).length).toBe(1);
  };

  for (const meeting of [false, true]) {
    for (const outcome of ["success", "duplicate", "clarification", "error", "network"]) {
      it(`preserves edited ${meeting ? "meeting" : "article"} B after A ${outcome}`, async () => {
        await fresh(meeting);
        await submit();
        await page.locator('input').first().fill("Title B");
        await page.locator('textarea[required]').fill("Content B");
        await page.locator('[name="ingestionGuidanceMd"]').fill("Guidance B");
        if (meeting) {
          await page.locator('[type="datetime-local"]').fill("2026-10-16T11:00");
          await page.locator('[name="timeZone"]').selectOption("Europe/Prague");
        } else await page.locator('input').nth(1).fill("Channel B");
        if (outcome === "network") {
          await page.evaluate(() => (window as any).fixture.requests[0].reject(new Error("Synthetic offline")));
          await expect.poll(() => page.locator('button[type="submit"]').textContent()).not.toMatch(/Ingesting/);
        } else await release(outcome === "success" ? 200 : outcome === "error" ? 500 : 409,
          outcome === "duplicate" ? duplicate : outcome === "success" && meeting ? { meeting: { id: "meeting-A" } } : { message: "Clarification A", error: { message: "Error A" } });
        expect(await page.locator('input').first().inputValue()).toBe("Title B");
        expect(await page.locator('textarea[required]').inputValue()).toBe("Content B");
        expect(await page.locator('[name="ingestionGuidanceMd"]').inputValue()).toBe("Guidance B");
        expect(await page.getByText("Possible duplicate", { exact: true }).count()).toBe(0);
        expect(await page.evaluate(() => (window as any).fixture.pushes)).toEqual([]);
        if (meeting) {
          expect(await page.locator('[type="datetime-local"]').inputValue()).toBe("2026-10-16T11:00");
          expect(await page.locator('[name="timeZone"]').inputValue()).toBe("Europe/Prague");
        } else expect(await page.locator('input').nth(1).inputValue()).toBe("Channel B");
        await page.locator('button[type="submit"]').click();
        await expect.poll(async () => (await requests()).length).toBe(2);
        expect((await requests())[1].body).toMatchObject({ title: "Title B", content: "Content B", ingestionGuidanceMd: "Guidance B" });
        expect((await requests())[1].body.duplicateResolution).toBeUndefined();
        await release(200, {}, 1);
      });
    }
  }

  for (const field of ["title", "content", "guidance", "channel", "source", "recordedAt", "timeZone"]) {
    it(`invalidates duplicate consent on ${field} edit`, async () => {
      await fresh(field === "recordedAt" || field === "timeZone"); await submit(); await release(409, duplicate);
      expect(await page.getByRole("button", { name: "Use existing", exact: true }).count()).toBe(1);
      if (field === "title") await page.locator('input').first().fill("B");
      if (field === "content") await page.locator('textarea[required]').fill("B");
      if (field === "guidance") await page.locator('[name="ingestionGuidanceMd"]').fill("B");
      if (field === "channel") await page.locator('input').nth(1).fill("B");
      if (field === "source") await page.locator('select').first().selectOption("DOC");
      if (field === "recordedAt") await page.locator('[type="datetime-local"]').fill("2026-10-16T11:00");
      if (field === "timeZone") await page.locator('[name="timeZone"]').selectOption("Europe/Prague");
      expect(await page.getByText("Possible duplicate", { exact: true }).count()).toBe(0);
    });
  }

  for (const resolution of ["Use existing", "Update existing", "Create new"]) {
    it(`binds ${resolution} to exact snapshot and preserves newer edits`, async () => {
      await fresh(); await submit(); const original = (await requests())[0].body; await release(409, duplicate);
      await page.getByRole("button", { name: resolution, exact: true }).click();
      await expect.poll(async () => (await requests()).length).toBe(2);
      expect((await requests())[1].body).toEqual({ ...original, duplicateResolution: resolution.toLowerCase().replace(" ", "_"), duplicateTargetEntityId: "synthetic-A" });
      await page.locator('textarea[required]').fill("Content B"); await release(200, {}, 1);
      expect(await page.locator('textarea[required]').inputValue()).toBe("Content B");
    });
  }

  it("fences edits while the response body is still pending", async () => {
    await fresh(); await submit();
    await page.evaluate(() => (window as any).fixture.requests[0].resolveHeaders(200));
    await expect.poll(() => page.evaluate(() => typeof (window as any).fixture.resolveBody)).toBe("function");
    await page.locator('[name="ingestionGuidanceMd"]').fill("Guidance B only");
    await page.evaluate(() => (window as any).fixture.resolveBody({}));
    await expect.poll(() => page.locator('button[type="submit"]').isDisabled()).toBe(false);
    expect(await page.locator('[name="ingestionGuidanceMd"]').inputValue()).toBe("Guidance B only");
    expect(await page.locator('textarea[required]').inputValue()).toBe("Content A");
    expect(await page.evaluate(() => (window as any).fixture.refreshes)).toBe(0);
  });

  it("keeps unchanged meeting success navigation and its original payload", async () => {
    await fresh(true); await submit();
    expect((await requests())[0]).toEqual({
      url: "/api/workspaces/synthetic-workspace/data-sources/text-ingest",
      body: { title: "Title A", sourceType: "MEETING", channel: "", content: "Content A",
        ingestionGuidanceMd: "Guidance A", recordedAt: "2026-10-15T10:00", timeZone: "UTC", duplicateGuardEnabled: true },
    });
    await release(200, { meeting: { id: "synthetic-meeting" } });
    expect(await page.locator('textarea[required]').inputValue()).toBe("");
    expect(await page.evaluate(() => (window as any).fixture.pushes)).toEqual(["/workspaces/synthetic-workspace/meetings/synthetic-meeting"]);
  });

  it("permits an unchanged draft retry after network failure", async () => {
    await fresh(); await submit();
    const original = (await requests())[0].body;
    await page.evaluate(() => (window as any).fixture.requests[0].reject(new Error("Synthetic offline")));
    await expect.poll(() => page.locator('button[type="submit"]').isDisabled()).toBe(false);
    await page.locator('button[type="submit"]').click();
    await expect.poll(async () => (await requests()).length).toBe(2);
    expect((await requests())[1].body).toEqual(original);
    await release(200, {}, 1);
    expect(await page.evaluate(() => (window as any).fixture.refreshes)).toBe(1);
  });

  it("synchronously guards repeated submit events and permits retry after failure", async () => {
    await fresh();
    await page.locator("form").evaluate(form => { for (let i = 0; i < 3; i++) form.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true })); });
    expect((await requests()).length).toBe(1);
    await release(500, { error: { message: "Synthetic failure" } });
    await page.locator('button[type="submit"]').click();
    await expect.poll(async () => (await requests()).length).toBe(2); await release(200, {}, 1);
    expect(await page.locator('textarea[required]').inputValue()).toBe("");
  });

  it("fences source changes even when changed back", async () => {
    await fresh(); await submit();
    await page.locator('select').first().selectOption("DOC"); await page.locator('select').first().selectOption("ARTICLE");
    await release(409, duplicate);
    expect(await page.getByText("Possible duplicate", { exact: true }).count()).toBe(0);
  });

  it("fences old workspace responses and their finally block from a new request", async () => {
    await fresh(); await submit();
    await page.evaluate(() => (window as any).mount("synthetic-other"));
    await expect.poll(() => page.locator('button[type="submit"]').textContent()).not.toMatch(/Ingesting/);
    await page.locator('button[type="submit"]').click();
    await expect.poll(async () => (await requests()).length).toBe(2);
    await page.evaluate(() => (window as any).fixture.requests[0].resolve(200, { meeting: { id: "old" } }));
    expect(await page.locator('button[type="submit"]').isDisabled()).toBe(true);
    expect(await page.evaluate(() => (window as any).fixture.pushes)).toEqual([]);
    await release(500, {}, 1);
  });

  it("ignores success after unmount and remount", async () => {
    await fresh(true); await submit(); await page.evaluate(() => (window as any).unmount());
    await expect.poll(() => page.locator("form").count()).toBe(0);
    await page.evaluate(() => (window as any).mount());
    await page.locator('textarea[required]').fill("New session B");
    await page.evaluate(() => (window as any).fixture.requests[0].resolve(200, { meeting: { id: "old" } }));
    await page.screenshot({ path: fileURLToPath(new URL("remounted-draft.png", output)) });
    expect(await page.locator('textarea[required]').inputValue()).toBe("New session B");
    expect(await page.evaluate(() => (window as any).fixture.pushes)).toEqual([]);
  });
});
