import React from "react";
import { createServer } from "node:http";
import { mkdir, readFile } from "node:fs/promises";
import { renderToStaticMarkup } from "react-dom/server";
import { createTranslator } from "next-intl";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
const fixture = vi.hoisted(() => ({ cursors: [] as Array<string | undefined> }));
vi.mock("@corgtex/domain", () => ({
  requireWorkspaceMembership: async () => ({ role: "ADMIN" }),
  listAuditLogsPage: async () => ({ items: [], nextCursor: null, scanLimited: false }),
  listNewspaperDeliverySummaries: vi.fn(), listNewspaperDeliveryDetails: vi.fn(),
  listArchivedWorkspaceArtifactsPage: async (_actor: unknown, opts: { workspaceId: string; cursor?: string; entityType?: string; take: number }) => {
    fixture.cursors.push(opts.cursor);
    expect(opts.workspaceId).toBe("synthetic-ws"); expect(opts.take).toBe(100); expect(opts.entityType).toBe("BrainArticle");
    return opts.cursor ? { items: [{ id: "visible", entityId: "synthetic-article", entityType: "BrainArticle", entityLabel: "BrainArticle",
      archivedByUserId: "synthetic-admin", archivedByLabel: null, archiveReason: null, archivedAt: new Date("2026-01-01"), permanentPath: null }], nextCursor: null, complete: true }
      : { items: [], nextCursor: "opaque-archive-continuation", complete: false };
  },
}));
vi.mock("@/lib/auth", () => ({ requirePageActor: async () => ({ kind: "user", user: { id: "synthetic-user" } }) }));
vi.mock("@/lib/workspace-feature-flags", () => ({ getWorkspaceFeatureFlags: async () => ({ AGENT_GOVERNANCE: true }) }));
vi.mock("./actions", () => ({ purgeArchivedArtifactAction: async () => {}, restoreArchivedArtifactAction: async () => {} }));
vi.mock("next/navigation", () => ({ notFound: () => { throw new Error("NOT_FOUND"); } }));
vi.mock("next-intl/server", () => ({ getTranslations: async () => createTranslator({ locale: "en",
  messages: JSON.parse(await readFile(new URL("../../../../../messages/en.json", import.meta.url), "utf8")).audit }) }));
import AuditPage from "./page";
beforeEach(() => vi.stubGlobal("React", React));
afterEach(() => vi.unstubAllGlobals());

let stylesheet: Promise<string> | undefined;
function styles() {
  return stylesheet ??= (async () => {
    const raw = (await Promise.all(["globals.css", "styles/tokens.css", "styles/components.css", "styles/pages.css"].map(path => readFile(new URL(`../../../../${path}`, import.meta.url), "utf8")))).join("\n");
    const { default: postcss } = await import("postcss");
    const { default: tailwind } = await import("tailwindcss");
    const { default: config } = await import("../../../../../tailwind.config");
    return (await postcss([tailwind({ ...config, content: [new URL("./page.tsx", import.meta.url).pathname] })])
      .process(raw.replace(/@import[^;]+;/g, ""), { from: undefined })).css;
  })();
}
async function html(url: URL) {
  const content = renderToStaticMarkup(await AuditPage({ params: Promise.resolve({ workspaceId: "synthetic-ws" }),
    searchParams: Promise.resolve(Object.fromEntries(url.searchParams)) }));
  const css = await styles();
  return `<html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><style>:root{--font-inter:system-ui;--font-playfair:Georgia}${css}</style></head><body><main style="max-width:900px;margin:24px auto;padding:16px">${content}</main></body></html>`;
}
it("qualifies hidden-only archive windows and keeps every display filter on continuation", async () => {
  const markup = await html(new URL("http://127.0.0.1/?tab=archive&archiveEntityType=BrainArticle&archiveActor=synthetic&archiveReason=unmatched&archiveDateFrom=2025-01-01"));
  expect(markup).toContain("No visible archived records in this window.");
  expect(markup).toContain("Older records may be outside this window.");
  expect(markup).not.toContain("No archived records found.");
  for (const value of ["archiveEntityType=BrainArticle", "archiveActor=synthetic", "archiveReason=unmatched", "archiveDateFrom=2025-01-01", "archiveCursor=opaque-archive-continuation"]) expect(markup).toContain(value);
});
it.runIf(process.env.ARCHIVE_WINDOW_BROWSER_QA === "1")("navigates real archive page through a hidden window, older result, and reset", async () => {
  const { chromium } = await import("playwright");
  const server = createServer(async (request, response) => {
    try { response.setHeader("Content-Type", "text/html; charset=utf-8"); response.end(await html(new URL(request.url!, "http://127.0.0.1"))); }
    catch (error) { response.writeHead(500).end(String(error)); }
  });
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  const address = server.address(); if (!address || typeof address === "string") throw new Error("Missing fixture port");
  const origin = `http://127.0.0.1:${address.port}`;
  const browser = await chromium.launch({ headless: true });
  try {
    const page = await browser.newPage({ viewport: { width: 1120, height: 900 } });
    await page.route("**/*", route => new URL(route.request().url()).origin === origin ? route.continue() : route.abort());
    const errors: string[] = []; page.on("pageerror", error => errors.push(error.message));
    await page.goto(`${origin}/workspaces/synthetic-ws/audit?tab=archive&archiveEntityType=BrainArticle&archiveActor=synthetic&archiveDateFrom=2025-01-01`);
    await page.getByText("No visible archived records in this window.", { exact: true }).waitFor();
    await mkdir(".artifacts/source-20e45-archive-window", { recursive: true });
    await page.screenshot({ path: ".artifacts/source-20e45-archive-window/hidden-window.png", fullPage: true });
    await page.getByRole("link", { name: "Older archived records", exact: true }).click();
    await page.getByText("BrainArticle", { exact: true }).waitFor();
    expect(new URL(page.url()).searchParams.get("archiveCursor")).toBe("opaque-archive-continuation");
    for (const [key, value] of [["tab", "archive"], ["archiveEntityType", "BrainArticle"], ["archiveActor", "synthetic"], ["archiveDateFrom", "2025-01-01"]]) expect(new URL(page.url()).searchParams.get(key)).toBe(value);
    await page.screenshot({ path: ".artifacts/source-20e45-archive-window/older-readable.png", fullPage: true });
    await page.getByRole("link", { name: "Back to latest archive", exact: true }).click();
    expect(new URL(page.url()).searchParams.has("archiveCursor")).toBe(false);
    await page.getByRole("link", { name: "Older archived records", exact: true }).waitFor();
    await page.setViewportSize({ width: 390, height: 844 });
    await page.screenshot({ path: ".artifacts/source-20e45-archive-window/hidden-window-mobile.png", fullPage: true });
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    expect(errors).toEqual([]);
    expect(fixture.cursors).toContain("opaque-archive-continuation");
  } finally { await browser.close(); await new Promise<void>(resolve => server.close(() => resolve())); }
}, 60_000);
