import React from "react";
import { createServer } from "node:http";
import { mkdir, readFile } from "node:fs/promises";
import { renderToStaticMarkup } from "react-dom/server";
import { createTranslator } from "next-intl";
import { expect, it, vi } from "vitest";
import messages from "../../../../../messages/en.json";
vi.mock("next/navigation", () => ({useRouter: () => ({refresh() {}, push() {}})}));
vi.mock("next-intl", async original => ({...await original<typeof import("next-intl")>(),
  useTranslations: () => createTranslator({locale: "en", messages: messages.chat}),
}));
import { ChatInterface } from "./ChatInterface";
function html(limited: boolean) {
  vi.stubGlobal("React", React);
  try { return renderToStaticMarkup(React.createElement(ChatInterface, {workspaceId: "synthetic-ws", conversations: [], activeSessionId: null, compact: true, historyLimited: limited})); }
  finally { vi.unstubAllGlobals(); }
}
it("qualifies incomplete empty history while keeping complete-empty wording", () => {
  expect(html(true)).toContain(messages.chat.historyLimited);
  expect(html(true)).toContain(messages.chat.historyWindowEmpty);
  expect(html(true)).not.toContain(messages.chat.noConversations);
  expect(html(false)).toContain(messages.chat.noConversations);
});
it.runIf(process.env.RECENT_CHAT_BROWSER_QA === "1")("renders the qualified history in a running browser", async () => {
  const {chromium} = await import("playwright");
  const css = (await Promise.all(["globals.css", "styles/tokens.css", "styles/components.css", "styles/animations.css", "styles/pages.css"].map(path => readFile(`apps/web/app/${path}`, "utf8")))).join("\n");
  const markup = `<html><head><meta charset="utf-8"><style>${css}</style></head><body>${html(true)}</body></html>`;
  const server = createServer((_request, response) => {response.setHeader("Content-Type", "text/html; charset=utf-8"); response.end(markup);});
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  const address = server.address(); if (!address || typeof address === "string") throw new Error("Missing fixture port");
  const origin = `http://127.0.0.1:${address.port}`;
  const browser = await chromium.launch({headless: true});
  try {
    const page = await browser.newPage();
    await page.route("**/*", route => new URL(route.request().url()).origin === origin ? route.continue() : route.abort());
    await page.goto(origin);
    await page.getByRole("status").filter({hasText: messages.chat.historyLimited}).waitFor();
    await page.getByText(messages.chat.historyWindowEmpty, {exact: true}).waitFor();
    expect(await page.getByText(messages.chat.noConversations, {exact: true}).count()).toBe(0);
    await mkdir(".artifacts/source-160-recent-chat", {recursive: true});
    await page.screenshot({path: ".artifacts/source-160-recent-chat/limited.png", fullPage: true});
  } finally { await browser.close(); await new Promise<void>(resolve => server.close(() => resolve())); }
});
