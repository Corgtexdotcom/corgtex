import { createServer } from "node:http";
import { mkdir, readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { expect, it } from "vitest";

it.runIf(process.env.NOTIFICATIONS_BROWSER_QA === "1")("continues explicit batches and retains the last cursor after a failed response", async () => {
  const { build } = await import("esbuild");
  const { chromium } = await import("playwright");
  const component = fileURLToPath(new URL("./MarkAllNotificationsReadButton.tsx", import.meta.url));
  const messages = JSON.parse(await readFile(new URL("../../../../../messages/en.json", import.meta.url), "utf8")).notificationsPage;
  const labels = { start: messages.markAllRead, continue: messages.markAllContinue, pending: messages.markAllPending,
    partial: messages.markAllPartial, complete: messages.markAllComplete, error: messages.markAllError };
  const bundle = await build({ stdin: { resolveDir: fileURLToPath(new URL("../../../../../", import.meta.url)), loader: "tsx", contents: `
    import React from "react"; import {createRoot} from "react-dom/client";
    import {MarkAllNotificationsReadButton} from ${JSON.stringify(component)};
    createRoot(document.getElementById("root")).render(<MarkAllNotificationsReadButton workspaceId="synthetic-workspace" canStart={true} labels={${JSON.stringify(labels)}}/>);
  ` }, bundle: true, write: false, jsx: "automatic", define: { "process.env.NODE_ENV": '"production"' }, plugins: [{
    name: "synthetic-server-action", setup(build) {
      build.onResolve({ filter: /settings\/actions$/ }, () => ({ path: "action", namespace: "synthetic" }));
      build.onLoad({ filter: /.*/, namespace: "synthetic" }, () => ({ loader: "js", contents: `
        export async function markAllNotificationsReadAction(formData) {
          const response = await fetch('/mark-all', {method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(Object.fromEntries(formData))});
          if(!response.ok) throw new Error('Synthetic failed response');
          return response.json();
        }
      ` }));
    },
  }] });
  const css = (await Promise.all(["globals.css", "styles/tokens.css", "styles/components.css", "styles/animations.css", "styles/pages.css"]
    .map(path => readFile(new URL(`../../../../${path}`, import.meta.url), "utf8")))).join("\n");
  const requests: Array<{ workspaceId: string; cursor: string }> = [];
  const server = createServer(async (request, response) => {
    if (request.method === "POST") {
      let raw = ""; for await (const chunk of request) raw += chunk;
      requests.push(JSON.parse(raw)); response.setHeader("Content-Type", "application/json");
      if (requests.length === 2) { response.writeHead(503).end(JSON.stringify({ error: "Synthetic transient failure" })); return; }
      response.end(JSON.stringify(requests.length === 1 ? { updatedCount: 0, complete: false, nextCursor: "after-hidden-200" }
        : { updatedCount: 2, complete: true, nextCursor: null })); return;
    }
    if (request.url === "/fixture.js") { response.setHeader("Content-Type", "text/javascript"); response.end(bundle.outputFiles[0].text); return; }
    response.setHeader("Content-Type", "text/html");
    response.end(`<html><head><meta charset="utf-8"><style>${css}</style></head><body><main class="notifications-page"><h1>Notifications</h1><div id="root"></div></main><script src="/fixture.js"></script></body></html>`);
  });
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  const address = server.address(); if (!address || typeof address === "string") throw new Error("Missing fixture port");
  const origin = `http://127.0.0.1:${address.port}`;
  const browser = await chromium.launch({ headless: true });
  try {
    const page = await browser.newPage({ viewport: { width: 1100, height: 700 } });
    const errors: string[] = []; page.on("pageerror", error => errors.push(error.message));
    await page.route("**/*", route => new URL(route.request().url()).origin === origin ? route.continue() : route.abort());
    await page.goto(origin);
    await page.getByRole("button", { name: labels.start, exact: true }).click();
    await page.getByText(labels.partial, { exact: true }).waitFor();
    expect(requests).toEqual([{ workspaceId: "synthetic-workspace", cursor: "" }]);
    await mkdir(".artifacts/source-160-mark-all-window", { recursive: true });
    await page.screenshot({ path: ".artifacts/source-160-mark-all-window/partial.png", fullPage: true });
    await page.getByRole("button", { name: labels.continue, exact: true }).click();
    await page.getByRole("alert").waitFor();
    expect(requests).toHaveLength(2);
    expect(requests[1]).toEqual({ workspaceId: "synthetic-workspace", cursor: "after-hidden-200" });
    await page.getByRole("button", { name: labels.continue, exact: true }).click();
    await page.getByText(labels.complete, { exact: true }).waitFor();
    expect(requests).toHaveLength(3); expect(requests[2]).toEqual(requests[1]);
    expect(await page.getByRole("alert").count()).toBe(0);
    expect(await page.getByRole("button", { name: labels.continue, exact: true }).count()).toBe(0);
    expect(errors).toEqual([]);
    await page.screenshot({ path: ".artifacts/source-160-mark-all-window/complete.png", fullPage: true });
  } finally { await browser.close(); await new Promise<void>(resolve => server.close(() => resolve())); }
}, 60_000);
