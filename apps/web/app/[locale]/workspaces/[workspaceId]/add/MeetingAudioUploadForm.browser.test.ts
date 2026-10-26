import { createServer } from "node:http";
import { mkdir, readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { expect, it } from "vitest";

// Real React component and application CSS; HTTP history is synthetic and local.
it.runIf(process.env.MEETING_AUDIO_BROWSER_QA === "1")("continues empty hidden upload history and refreshes the original workspace window", async () => {
  const { build } = await import("esbuild");
  const { chromium } = await import("playwright");
  const component = fileURLToPath(new URL("./MeetingAudioUploadForm.tsx", import.meta.url));
  const bundle = await build({ stdin: { resolveDir: fileURLToPath(new URL("../../../../../", import.meta.url)), loader: "tsx", contents: `
    import React from "react"; import {createRoot} from "react-dom/client";
    import {MeetingAudioUploadForm} from ${JSON.stringify(component)};
    createRoot(document.getElementById("root")).render(<MeetingAudioUploadForm workspaceId="synthetic-audio-workspace" cancelHref="/workspaces/synthetic-audio-workspace/add"/>);
  ` }, bundle: true, write: false, jsx: "automatic", define: { "process.env.NODE_ENV": '"production"' } });
  const css = (await Promise.all(["globals.css", "styles/tokens.css", "styles/components.css", "styles/animations.css", "styles/pages.css"]
    .map(path => readFile(new URL(`../../../../${path}`, import.meta.url), "utf8")))).join("\n");
  const requests: Array<{ method: string | undefined; path: string; take: string | null; cursor: string | null }> = [];
  const cursor = "synthetic opaque+/cursor=";
  const server = createServer((request, response) => {
    const url = new URL(request.url!, "http://127.0.0.1");
    if (url.pathname.startsWith("/api/")) {
      requests.push({ method: request.method, path: url.pathname, take: url.searchParams.get("take"), cursor: url.searchParams.get("cursor") });
      if (url.pathname !== "/api/workspaces/synthetic-audio-workspace/meeting-audio-assets" || request.method !== "GET") {
        response.writeHead(404).end(); return;
      }
      const older = url.searchParams.get("cursor") === cursor;
      response.writeHead(200, { "Content-Type": "application/json" }).end(JSON.stringify({
        audioAssets: older ? [{ id: "synthetic-older-audio", fileName: "synthetic-meeting.wav", title: "Older visible meeting audio",
          status: "INGESTED", workflowJobId: null, intakeMeetingId: "synthetic-meeting", failureCode: null, failureMessage: null,
          createdAt: "2026-01-01T12:00:00.000Z", updatedAt: "2026-01-01T12:00:00.000Z" }] : [],
        complete: older, nextCursor: older ? null : cursor,
      })); return;
    }
    if (url.pathname === "/fixture.js") { response.writeHead(200, { "Content-Type": "text/javascript" }).end(bundle.outputFiles[0].text); return; }
    response.writeHead(200, { "Content-Type": "text/html; charset=utf-8" }).end(`<html><head><style>${css}</style></head><body><main style="max-width:900px;margin:32px auto;padding:24px"><div id="root"></div></main><script src="/fixture.js"></script></body></html>`);
  });
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  const address = server.address(); if (!address || typeof address === "string") throw new Error("Missing fixture port");
  const origin = `http://127.0.0.1:${address.port}`;
  let browser: Awaited<ReturnType<typeof chromium.launch>> | undefined;
  try {
    browser = await chromium.launch({ headless: true });
    const page = await browser.newPage({ viewport: { width: 1100, height: 1000 } });
    await page.route("**/*", route => new URL(route.request().url()).origin === origin ? route.continue() : route.abort());
    const errors: string[] = []; page.on("pageerror", error => errors.push(error.message));
    const originalUrl = `${origin}/workspaces/synthetic-audio-workspace/add?type=audio`;
    await page.goto(originalUrl);
    const qualifiedEmpty = page.getByText("No visible uploads in this window. Check older uploads to continue.", { exact: true });
    await qualifiedEmpty.waitFor();
    expect(await page.getByText("Showing a limited history window.", { exact: true }).isVisible()).toBe(true);
    expect(await page.getByText("No audio uploads in this history window.", { exact: true }).count()).toBe(0);
    await mkdir(".artifacts/source-1604-audio-history-browser", { recursive: true });
    await page.screenshot({ path: ".artifacts/source-1604-audio-history-browser/empty-hidden-window.png", fullPage: true });
    await page.getByRole("button", { name: "Older uploads", exact: true }).click();
    await page.getByText("Older visible meeting audio", { exact: true }).waitFor();
    expect(await page.getByRole("button", { name: "Older uploads", exact: true }).count()).toBe(0);
    expect(await page.getByText("Showing a limited history window.", { exact: true }).count()).toBe(0);
    expect(await page.getByRole("link", { name: "Open meeting", exact: true }).getAttribute("href"))
      .toBe("/workspaces/synthetic-audio-workspace/meetings/synthetic-meeting");
    expect(page.url()).toBe(originalUrl);
    await page.screenshot({ path: ".artifacts/source-1604-audio-history-browser/older-visible-window.png", fullPage: true });
    await page.getByRole("button", { name: "Refresh", exact: true }).click();
    await qualifiedEmpty.waitFor();
    expect(await page.getByRole("button", { name: "Older uploads", exact: true }).isEnabled()).toBe(true);
    expect(await page.getByText("Older visible meeting audio", { exact: true }).count()).toBe(0);
    expect(page.url()).toBe(originalUrl);
    expect(await page.getByRole("link", { name: "Cancel", exact: true }).getAttribute("href")).toBe("/workspaces/synthetic-audio-workspace/add");
    expect(requests).toEqual([null, cursor, null].map(value => ({ method: "GET", path: "/api/workspaces/synthetic-audio-workspace/meeting-audio-assets", take: "5", cursor: value })));
    expect(errors).toEqual([]);
  } finally {
    await browser?.close();
    await new Promise<void>(resolve => server.close(() => resolve()));
  }
}, 60_000);
