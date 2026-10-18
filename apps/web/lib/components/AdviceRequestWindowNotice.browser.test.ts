import { createServer } from "node:http";
import { mkdir, readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { expect, it } from "vitest";

it.runIf(process.env.ADVICE_WINDOW_BROWSER_QA === "1")("continues hidden advice windows without changing entity routes or repeated filters", async () => {
  const { build } = await import("esbuild");
  const { chromium } = await import("playwright");
  const component = fileURLToPath(new URL("./AdviceRequestWindowNotice.tsx", import.meta.url));
  const labels = JSON.parse(await readFile(new URL("../../messages/en.json", import.meta.url), "utf8")).workItems;
  const cursor = "synthetic+/opaque=continuation";
  const bundle = await build({ stdin: { resolveDir: fileURLToPath(new URL("../../", import.meta.url)), loader: "tsx", contents: `
    import React from "react"; import {createRoot} from "react-dom/client";
    import {AdviceRequestWindowNotice} from ${JSON.stringify(component)};
    const url = new URL(location.href); const continued = url.searchParams.has("adviceCursor");
    const search = {}; for (const key of url.searchParams.keys()) { const values = url.searchParams.getAll(key); search[key] = values.length > 1 ? values : values[0]; }
    createRoot(document.getElementById("root")).render(<section id="advice-requests">
      <h1>Advice requests</h1>{continued && <article>Older permitted advice request</article>}
      <AdviceRequestWindowNotice path={url.pathname} search={search} page={{complete:continued,nextCursor:continued?null:${JSON.stringify(cursor)}}}
        labels={${JSON.stringify({ limited: labels.adviceWindowLimited, older: labels.olderAdviceRequests, newest: labels.newestAdviceRequests })}}/>
    </section>);
  ` }, bundle: true, write: false, jsx: "automatic", define: { "process.env.NODE_ENV": '"production"' } });
  const css = (await Promise.all(["globals.css", "styles/tokens.css", "styles/components.css", "styles/animations.css", "styles/pages.css"]
    .map(path => readFile(new URL(`../../app/${path}`, import.meta.url), "utf8")))).join("\n");
  const server = createServer((request, response) => {
    if (request.url === "/fixture.js") { response.writeHead(200, { "Content-Type": "text/javascript" }).end(bundle.outputFiles[0].text); return; }
    response.writeHead(200, { "Content-Type": "text/html; charset=utf-8" }).end(`<html><head><style>${css}</style></head><body><main style="max-width:900px;margin:32px auto;padding:24px"><div id="root"></div></main><script src="/fixture.js"></script></body></html>`);
  });
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  const address = server.address(); if (!address || typeof address === "string") throw new Error("Missing local fixture port");
  const origin = `http://127.0.0.1:${address.port}`;
  let browser: Awaited<ReturnType<typeof chromium.launch>> | undefined;
  try {
    browser = await chromium.launch({ headless: true });
    const page = await browser.newPage({ viewport: { width: 1100, height: 800 } });
    await page.route("**/*", route => new URL(route.request().url()).origin === origin ? route.continue() : route.abort());
    const errors: string[] = []; page.on("pageerror", error => errors.push(error.message));
    for (const suffix of ["proposals", "tensions", "proposals/synthetic-proposal", "tensions/synthetic-tension", "actions/synthetic-action"]) {
      const path = `/workspaces/synthetic-advice/${suffix}`;
      const original = `${origin}${path}?status=OPEN&memberId=first&memberId=second&returnTo=%2Fworkspaces%2Fsynthetic-advice%2Factions`;
      await page.goto(original);
      await page.getByText(labels.adviceWindowLimited, { exact: true }).waitFor();
      expect(await page.getByText("Older permitted advice request", { exact: true }).count()).toBe(0);
      await page.getByRole("link", { name: labels.olderAdviceRequests, exact: true }).click();
      await page.getByText("Older permitted advice request", { exact: true }).waitFor();
      const continued = new URL(page.url());
      expect(continued.pathname).toBe(path);
      expect(continued.searchParams.getAll("memberId")).toEqual(["first", "second"]);
      expect(continued.searchParams.get("status")).toBe("OPEN");
      expect(continued.searchParams.get("returnTo")).toBe("/workspaces/synthetic-advice/actions");
      expect(continued.searchParams.get("adviceCursor")).toBe(cursor);
      expect(continued.hash).toBe("#advice-requests");
      expect(await page.getByRole("link", { name: labels.olderAdviceRequests, exact: true }).count()).toBe(0);
      expect(await page.getByText(labels.adviceWindowLimited, { exact: true }).isVisible()).toBe(true);
      await mkdir(".artifacts/source-bb676-discovery", { recursive: true });
      if (suffix === "actions/synthetic-action") await page.screenshot({ path: ".artifacts/source-bb676-discovery/advice-continued.png", fullPage: true });
      await page.getByRole("link", { name: labels.newestAdviceRequests, exact: true }).click();
      await page.getByRole("link", { name: labels.olderAdviceRequests, exact: true }).waitFor();
      expect(new URL(page.url()).searchParams.has("adviceCursor")).toBe(false);
      expect(new URL(page.url()).pathname).toBe(path);
    }
    expect(errors).toEqual([]);
  } finally {
    await browser?.close();
    await new Promise<void>(resolve => server.close(() => resolve()));
  }
}, 60_000);
