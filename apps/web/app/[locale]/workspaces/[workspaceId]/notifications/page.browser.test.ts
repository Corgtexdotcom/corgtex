import React from "react";
import { createServer } from "node:http";
import { mkdir, readFile } from "node:fs/promises";
import { renderToStaticMarkup } from "react-dom/server";
import { createTranslator } from "next-intl";
import { expect, it, vi } from "vitest";
const fixture = vi.hoisted(() => ({ cursors: [] as Array<string | undefined>, summary: { count: 0, complete: false, available: true } }));
vi.mock("@corgtex/domain", () => ({
  getUnreadNotificationSummary: async () => fixture.summary,
  listNotificationPage: async (_actor: unknown, _workspace: string, opts: { cursor?: string; unreadOnly: boolean }) => {
    fixture.cursors.push(opts.cursor);
    expect(opts.unreadOnly).toBe(true);
    return opts.cursor ? { items: [{ id: "visible", title: "Visible older notification", type: "synthetic", entityType: null,
      entityId: null, bodyMd: null, readAt: null, createdAt: new Date("2026-01-01") }], hasMore: false, nextCursor: null, complete: true }
      : { items: [], hasMore: true, nextCursor: "opaque-continuation", complete: false };
  },
}));
vi.mock("@/lib/auth", () => ({ requirePageActor: async () => ({ kind: "user", user: { id: "synthetic-user" } }) }));
vi.mock("../actions", () => ({ markAllNotificationsReadAction: async () => {}, markNotificationReadAction: async () => {} }));
vi.mock("next-intl/server", () => ({
  getTranslations: async () => createTranslator({ locale: "en", messages: JSON.parse(await readFile(new URL("../../../../../messages/en.json", import.meta.url), "utf8")).notificationsPage }),
  getFormatter: async () => ({ dateTime: (date: Date) => date.toISOString(), relativeTime: () => "today" }),
}));
import NotificationsPage from "./page";
vi.stubGlobal("React", React);

async function html(url: URL) {
  const content = renderToStaticMarkup(await NotificationsPage({ params: Promise.resolve({ workspaceId: "synthetic-ws" }),
    searchParams: Promise.resolve(Object.fromEntries(url.searchParams)) }));
  const css = (await Promise.all(["globals.css", "styles/tokens.css", "styles/components.css", "styles/animations.css", "styles/pages.css"].map(path => readFile(new URL(`../../../../${path}`, import.meta.url), "utf8")))).join("\n");
  return `<html><head><meta charset="utf-8"><style>${css}</style></head><body>${content}</body></html>`;
}
it("keeps an empty hidden-history continuation reachable without claiming exact zero", async () => {
  const markup = await html(new URL("http://127.0.0.1/?filter=unread&page=999999"));
  expect(markup).toContain("No visible notifications here.");
  expect(markup).toContain("Unread count is not available yet.");
  expect(markup).not.toContain("No unread notifications");
  expect(markup).toContain("cursor=opaque-continuation");
  expect(markup).not.toContain("page=1000000");
});
it("labels a capped unread count as a lower bound", async () => {
  fixture.summary.count = 100;
  try {
    const markup = await html(new URL("http://127.0.0.1/?filter=unread"));
    expect(markup).toContain("At least 100 unread notifications");
    expect(markup).toContain("Unread (100+)");
  } finally { fixture.summary.count = 0; }
});
it.runIf(process.env.NOTIFICATIONS_BROWSER_QA === "1")("navigates the real rendered history links across an empty window and back to latest", async () => {
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
    const page = await browser.newPage();
    await page.route("**/*", route => new URL(route.request().url()).origin === origin ? route.continue() : route.abort());
    await page.goto(`${origin}/workspaces/synthetic-ws/notifications?filter=unread&page=999999`);
    await page.getByText("Unread count is not available yet.", { exact: true }).waitFor();
    await page.getByRole("link", { name: "Next", exact: true }).click();
    await page.getByText("Visible older notification", { exact: true }).waitFor();
    expect(new URL(page.url()).searchParams.get("filter")).toBe("unread");
    expect(new URL(page.url()).searchParams.get("cursor")).toBe("opaque-continuation");
    await mkdir(".artifacts/source-433-notification-history", { recursive: true });
    await page.screenshot({ path: ".artifacts/source-433-notification-history/older-readable.png", fullPage: true });
    await page.getByRole("link", { name: "Back to latest", exact: true }).click();
    expect(new URL(page.url()).searchParams.has("cursor")).toBe(false);
    await page.getByRole("link", { name: "Next", exact: true }).waitFor();
  } finally { await browser.close(); await new Promise<void>(resolve => server.close(() => resolve())); }
});
