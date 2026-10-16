import { mkdir } from "node:fs/promises";
import type { Page } from "playwright";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { configure, conversation, refreshes, reply, requests, startChatBrowserFixture, streamAction } from "./chat-browser-fixture";

// PERSONAL_CHAT_BROWSER_QA=1 npm run test:unit -- ChatInterface.browser.test.ts
// Uses actual React effects and browser streams; all data and APIs are synthetic.
// Chromium may be supplied with PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH.
describe.runIf(process.env.PERSONAL_CHAT_BROWSER_QA === "1")("personal chat interrupted and repeated flows", () => {
  let fixture: Awaited<ReturnType<typeof startChatBrowserFixture>>;
  let page: Page;
  let errors: string[];

  beforeAll(async () => { fixture = await startChatBrowserFixture(); });
  beforeEach(async () => {
    page = await fixture.newPage();
    errors = [];
    page.on("pageerror", (error) => errors.push(error.message));
  });
  afterEach(async () => {
    await page?.close();
    expect(errors).toEqual([]);
  });
  afterAll(async () => { await fixture?.close(); });

  const input = () => page.locator("textarea");
  const send = () => page.getByRole("button", { name: "Send", exact: true });
  const messages = () => page.locator(".chat-messages");
  const error = () => page.locator(".form-message-error");
  const select = (id: string) => page.locator(".chat-session-item").filter({ hasText: `Synthetic ${id}` }).click();

  async function requestAt(id: number) {
    await expect.poll(async () => (await requests(page)).length).toBe(id + 1);
    return (await requests(page))[id];
  }

  async function load(id = "a", requestId = 0) {
    await select(id);
    await requestAt(requestId);
    await reply(page, requestId, { conversation: conversation(id) });
    expect(await messages().innerText()).toContain(`Answer ${id}`);
  }

  async function startSend(text: string, requestId: number) {
    await input().fill(text);
    await send().click();
    const request = await requestAt(requestId);
    expect(request.method).toBe("POST");
    return request;
  }

  for (const staleFails of [false, true]) {
    it(`keeps the latest selection after an older load ${staleFails ? "fails" : "succeeds"}`, async () => {
      await select("a");
      await requestAt(0);
      await select("b");
      await requestAt(1);
      await reply(page, 1, { conversation: conversation("b") });
      await reply(page, 0, { conversation: conversation("a") }, staleFails ? 503 : 200);
      expect(await messages().innerText()).toContain("Answer b");
      expect(await messages().innerText()).not.toContain("Answer a");
      expect(await page.locator(".chat-session-item.active").innerText()).toContain("Synthetic b");
      expect(await error().count()).toBe(0);
      expect((await requests(page))[0].aborted).toBe(true);
      expect(new URL(page.url()).searchParams.get("session")).toBe("b");
    });
  }

  it("clears old turns and prevents a send while the next conversation is loading", async () => {
    await load();
    await input().fill("Draft a");
    await select("b");
    await requestAt(1);
    expect(await messages().innerText()).not.toContain("Answer a");
    expect(await input().isDisabled()).toBe(true);
    await reply(page, 1, {}, 503);
    expect(await error().innerText()).toContain("Failed to load conversation");
    await select("a");
    await requestAt(2);
    await reply(page, 2, { conversation: conversation("a") });
    expect(await input().inputValue()).toBe("Draft a");
    expect(await input().isEnabled()).toBe(true);
  });

  it("unlocks a failed conversation creation and retries the same draft", async () => {
    await startSend("Synthetic create retry", 0);
    await reply(page, 0, {}, 503);
    expect(await error().innerText()).toContain("Failed to create conversation");
    expect(await input().isEnabled()).toBe(true);
    expect(await input().inputValue()).toBe("Synthetic create retry");
    await send().click();
    await requestAt(1);
    await reply(page, 1, { session: { id: "created" } });
    const post = await requestAt(2);
    expect(post.url).toBe("/api/workspaces/alpha/conversations/created");
    expect(JSON.parse(post.body!).message).toBe("Synthetic create retry");
    await streamAction(page, 2, "stream");
    await streamAction(page, 2, "chunk", 'data: {"text":"Retry worked"}\n\n');
    await streamAction(page, 2, "finish");
    expect(await input().isEnabled()).toBe(true);
    expect(await page.locator(".chat-turn").count()).toBe(1);
  });

  for (const interruption of ["http", "stream"] as const) {
    it(`restores an exact draft after ${interruption} failure and retries once in the same conversation`, async () => {
      await load();
      await startSend("  Keep my\n  draft  ", 1);
      if (interruption === "stream") {
        await streamAction(page, 1, "stream");
        await streamAction(page, 1, "chunk", 'data: {"text":"Partial answer"}\n\n');
        await streamAction(page, 1, "fail");
      } else await reply(page, 1, { error: "Synthetic send failure" }, 503);
      expect(await input().isEnabled()).toBe(true);
      expect(await input().inputValue()).toBe("  Keep my\n  draft  ");
      expect(await page.locator(".chat-turn").count()).toBe(1);
      expect(await error().count()).toBe(1);
      await send().click();
      expect((await requestAt(2)).url).toBe("/api/workspaces/alpha/conversations/a");
      await streamAction(page, 2, "stream");
      await streamAction(page, 2, "chunk", 'data: {"text":"Recovered"}\n\ndata: [DONE]\n\n');
      await streamAction(page, 2, "finish");
      expect(await error().count()).toBe(0);
      expect(await messages().innerText()).toContain("Recovered");
      expect(await page.locator(".chat-turn").count()).toBe(2);
    });
  }

  it("keeps text and attachment drafts separate for each conversation and the new chat", async () => {
    await input().fill("Unsent new chat");
    await load();
    expect(await input().inputValue()).toBe("");
    await input().fill("Unsent a");
    await page.locator('input[type="file"]').setInputFiles({ name: "synthetic.txt", mimeType: "text/plain", buffer: Buffer.from("Synthetic attachment") });
    await load("b", 1);
    expect(await input().inputValue()).toBe("");
    expect(await page.locator(".chat-attachment-bar").count()).toBe(0);
    await input().fill("Unsent b");
    await load("a", 2);
    expect(await input().inputValue()).toBe("Unsent a");
    expect(await page.locator(".chat-attachment-bar").innerText()).toContain("synthetic.txt");
    await page.getByRole("button", { name: "New Conversation", exact: true }).click();
    expect(await input().inputValue()).toBe("Unsent new chat");
    expect(await page.locator(".chat-attachment-bar").count()).toBe(0);
    await load("b", 3);
    expect(await input().inputValue()).toBe("Unsent b");
  });

  it("cancels an old stream on conversation change without refreshing or unlocking the next send", async () => {
    await load();
    await startSend("Interrupted a", 1);
    await streamAction(page, 1, "stream");
    await streamAction(page, 1, "chunk", 'data: {"text":"Partial a","refreshCurrentRoute":true}\n\n');
    await load("b", 2);
    const abandoned = (await requests(page))[1];
    expect(abandoned.aborted).toBe(true);
    expect(abandoned.canceled).toBe(true);
    expect(await refreshes(page)).toBe(0);
    expect(await input().isEnabled()).toBe(true);
    await startSend("Current b", 3);
    await streamAction(page, 1, "finish");
    expect(await input().isDisabled()).toBe(true);
    expect(await error().count()).toBe(0);
    await streamAction(page, 3, "stream");
    await streamAction(page, 3, "chunk", 'data: {"text":"Only b"}\n\n');
    await streamAction(page, 3, "finish");
    expect(await messages().innerText()).not.toContain("Partial a");
    expect(await messages().innerText()).toContain("Only b");
  });

  it("ignores a late conversation creation after selecting another conversation", async () => {
    await startSend("Prompt for abandoned new chat", 0);
    await load("b", 1);
    await reply(page, 0, { session: { id: "abandoned" } });
    expect((await requests(page)).length).toBe(2);
    expect((await requests(page))[0].aborted).toBe(true);
    expect(await messages().innerText()).toContain("Answer b");
    expect(await input().inputValue()).toBe("");
    expect(new URL(page.url()).searchParams.get("session")).toBe("b");
    await page.getByRole("button", { name: "New Conversation", exact: true }).click();
    expect(await input().inputValue()).toBe("Prompt for abandoned new chat");
  });

  it("keeps a newer send busy when an abandoned POST fails late", async () => {
    await load();
    await startSend("Abandoned a", 1);
    await load("b", 2);
    await startSend("Current b", 3);
    await reply(page, 1, { error: "Late a failure" }, 503);
    expect(await input().isDisabled()).toBe(true);
    expect(await error().count()).toBe(0);
    expect(await messages().innerText()).not.toContain("Abandoned a");
    await streamAction(page, 3, "stream");
    await streamAction(page, 3, "chunk", 'data: {"text":"Current success"}\n\n');
    await streamAction(page, 3, "finish");
    expect(await input().isEnabled()).toBe(true);
  });

  it("preserves text and the selected attachment when upload fails, without sending an incomplete prompt", async () => {
    await input().fill("Use this synthetic attachment");
    await page.locator('input[type="file"]').setInputFiles({ name: "draft.txt", mimeType: "text/plain", buffer: Buffer.from("Synthetic file") });
    await send().click();
    expect((await requestAt(0)).url).toBe("/api/workspaces/alpha/chat/attachments");
    await reply(page, 0, { message: "Synthetic upload failed" }, 503);
    expect(await input().isEnabled()).toBe(true);
    expect(await input().inputValue()).toBe("Use this synthetic attachment");
    expect(await page.locator(".chat-attachment-bar").innerText()).toContain("draft.txt");
    expect(await error().innerText()).toContain("Synthetic upload failed");
    expect((await requests(page)).length).toBe(1);
    await send().click();
    expect((await requestAt(1)).url).toBe("/api/workspaces/alpha/chat/attachments");
  });

  it("ignores a pending attachment completion after changing workspace", async () => {
    await input().fill("Alpha upload draft");
    await page.locator('input[type="file"]').setInputFiles({ name: "alpha.txt", mimeType: "text/plain", buffer: Buffer.from("Synthetic alpha") });
    await send().click();
    await requestAt(0);
    await configure(page, { workspaceId: "beta" });
    await reply(page, 0, { message: "Synthetic attachment stored", webUrl: "/synthetic-file" });
    expect((await requests(page)).length).toBe(1);
    expect((await requests(page))[0].aborted).toBe(true);
    expect(await input().inputValue()).toBe("");
    expect(await page.locator(".chat-attachment-bar").count()).toBe(0);
    expect(await input().isEnabled()).toBe(true);
  });

  for (const text of ["Use uploaded attachment", ""]) {
    it(`retains an uploaded reference after send failure for ${text ? "text and file" : "attachment-only"} retry`, async () => {
      await load();
      await input().fill(text);
      await page.locator('input[type="file"]').setInputFiles({ name: "retry.txt", mimeType: "text/plain", buffer: Buffer.from("Synthetic retry file") });
      await send().click();
      expect((await requestAt(1)).url).toBe("/api/workspaces/alpha/chat/attachments");
      await reply(page, 1, { message: "Synthetic upload ready", webUrl: "/synthetic-file" });
      const first = await requestAt(2);
      await reply(page, 2, { error: "Synthetic post-upload failure" }, 503);
      expect(await input().inputValue()).toBe(text);
      expect(await send().isEnabled()).toBe(true);
      expect(await page.locator(".chat-attachment-bar").innerText()).toContain("retry.txt");
      await send().click();
      const retry = await requestAt(3);
      expect(retry.url).toBe("/api/workspaces/alpha/conversations/a");
      expect(JSON.parse(retry.body!).message).toBe(JSON.parse(first.body!).message);
      expect(JSON.parse(retry.body!).message).toContain("/synthetic-file");
      await streamAction(page, 3, "stream");
      await streamAction(page, 3, "chunk", 'data: {"text":"Attachment retry worked"}\n\n');
      await streamAction(page, 3, "finish");
      expect(await page.locator(".chat-attachment-bar").count()).toBe(0);
      expect(await input().inputValue()).toBe("");
      expect((await requests(page)).filter((request) => request.url.endsWith("/attachments")).length).toBe(1);
    });
  }

  it("retains an uploaded reference across conversation-create failure without uploading twice", async () => {
    await input().fill("Create with uploaded file");
    await page.locator('input[type="file"]').setInputFiles({ name: "create.txt", mimeType: "text/plain", buffer: Buffer.from("Synthetic create file") });
    await send().click();
    await requestAt(0);
    await reply(page, 0, { message: "Synthetic upload ready", webUrl: "/synthetic-create-file" });
    await requestAt(1);
    await reply(page, 1, {}, 503);
    expect(await send().isEnabled()).toBe(true);
    await send().click();
    expect((await requestAt(2)).url).toBe("/api/workspaces/alpha/conversations");
    await reply(page, 2, { session: { id: "created" } });
    expect(JSON.parse((await requestAt(3)).body!).message).toContain("/synthetic-create-file");
    expect((await requests(page)).filter((request) => request.url.endsWith("/attachments")).length).toBe(1);
  });

  it("keeps company-question drafts separate from the previously selected conversation", async () => {
    await configure(page, { questions: true });
    await load();
    await input().fill("Conversation a draft");
    await page.locator(".chat-unread-question-open").click();
    await requestAt(1);
    await reply(page, 1, { conversation: conversation("q") });
    expect(await input().inputValue()).toBe("");
    await input().fill("Company question draft");
    await load("b", 2);
    await load("a", 3);
    expect(await input().inputValue()).toBe("Conversation a draft");
    await page.locator(".chat-unread-question-open").click();
    await requestAt(4);
    await reply(page, 4, { conversation: conversation("q") });
    expect(await input().inputValue()).toBe("Company question draft");
  });

  it("ignores a company-question opening response after selecting a different chat", async () => {
    await configure(page, { questions: true });
    await page.locator(".chat-unread-question-open").click();
    await requestAt(0);
    await load("b", 1);
    await reply(page, 0, { conversation: conversation("q") });
    expect(await messages().innerText()).toContain("Answer b");
    expect(await messages().innerText()).not.toContain("Answer q");
    expect(await input().isEnabled()).toBe(true);
    expect((await requests(page))[0].aborted).toBe(true);
    expect(new URL(page.url()).searchParams.get("session")).toBe("b");
  });

  for (const pending of ["load", "post", "stream"] as const) {
    it(`resets workspace data and ignores a stale ${pending} completion`, async () => {
      if (pending === "load") { await select("a"); await requestAt(0); }
      else {
        await load();
        await startSend("Private synthetic alpha draft", 1);
        if (pending === "stream") {
          await streamAction(page, 1, "stream");
          await streamAction(page, 1, "chunk", 'data: {"text":"Alpha only","refreshCurrentRoute":true}\n\n');
        }
      }
      await configure(page, { workspaceId: "beta", activeSessionId: null });
      expect(await page.locator(".chat-session-list").innerText()).toContain("Synthetic c");
      expect(await page.locator(".chat-session-list").innerText()).not.toContain("Synthetic a");
      expect(await input().inputValue()).toBe("");
      expect(await input().isEnabled()).toBe(true);
      await load("c", pending === "load" ? 1 : 2);
      if (pending === "load") await reply(page, 0, { conversation: conversation("a") });
      else if (pending === "post") { await streamAction(page, 1, "stream"); await streamAction(page, 1, "finish"); }
      else await streamAction(page, 1, "finish");
      expect(await messages().innerText()).toContain("Answer c");
      expect(await messages().innerText()).not.toContain("Alpha");
      expect(await refreshes(page)).toBe(0);
      expect((await requests(page))[pending === "load" ? 0 : 1].aborted).toBe(true);
      expect(await error().count()).toBe(0);
      const post = await startSend("Beta prompt", pending === "load" ? 2 : 3);
      expect(post.url).toBe("/api/workspaces/beta/conversations/c");
    });
  }

  it("preserves the real rail draft, attachment and streaming turn across repeated close/reopen", async () => {
    await configure(page, { rail: true });
    await page.getByRole("button", { name: "New Conversation", exact: true }).click();
    await input().fill("Rail draft");
    await page.locator('input[type="file"]').setInputFiles({ name: "rail.txt", mimeType: "text/plain", buffer: Buffer.from("Synthetic rail attachment") });
    for (let i = 0; i < 2; i++) {
      await page.getByRole("button", { name: "Collapse AI rail", exact: true }).click();
      expect(await input().isVisible()).toBe(false);
      await page.getByRole("button", { name: "Open AI rail", exact: true }).click();
      expect(await input().inputValue()).toBe("Rail draft");
      expect(await page.locator(".chat-attachment-bar").innerText()).toContain("rail.txt");
    }
    expect(await requests(page)).toEqual([]);
    await page.getByRole("button", { name: "Remove attachment", exact: true }).click();
    await send().click();
    await requestAt(0);
    await reply(page, 0, { session: { id: "rail" } });
    await requestAt(1);
    await streamAction(page, 1, "stream");
    await streamAction(page, 1, "chunk", 'data: {"text":"Before close "}\n\n');
    await page.getByRole("button", { name: "Collapse AI rail", exact: true }).click();
    await streamAction(page, 1, "chunk", 'data: {"text":"after reopen"}\n\n');
    await streamAction(page, 1, "finish");
    await page.getByRole("button", { name: "Open AI rail", exact: true }).click();
    expect(await messages().innerText()).toContain("Before close after reopen");
    expect(await input().isEnabled()).toBe(true);
    expect((await requests(page)).length).toBe(2);
    await mkdir(".artifacts/personal-chat", { recursive: true });
    await page.screenshot({ path: ".artifacts/personal-chat/rail-reopened.png" });
  });

  it("cancels a stream on mobile new-chat navigation and restores the independent draft", async () => {
    await configure(page, { mobileMode: true });
    await input().fill("Mobile new draft");
    await page.getByRole("button", { name: "History", exact: true }).click();
    await load();
    await startSend("Mobile interrupted", 1);
    await streamAction(page, 1, "stream");
    await page.getByRole("button", { name: "New", exact: true }).click();
    expect(await input().inputValue()).toBe("Mobile new draft");
    expect(await input().isEnabled()).toBe(true);
    expect((await requests(page))[1]).toMatchObject({ aborted: true, canceled: true });
  });

  it("cancels a stream when returning to rail history and restores its unsent draft on reselection", async () => {
    await configure(page, { rail: true });
    await load();
    await startSend("Keep interrupted rail prompt", 1);
    await streamAction(page, 1, "stream");
    await page.getByTitle("Back to conversations", { exact: true }).click();
    expect((await requests(page))[1]).toMatchObject({ aborted: true, canceled: true });
    await load("a", 2);
    expect(await input().inputValue()).toBe("Keep interrupted rail prompt");
    expect(await input().isEnabled()).toBe(true);
    expect(await error().count()).toBe(0);
  });

  it("decodes split UTF-8 and event lines, then sends a second turn without recreating the conversation", async () => {
    await load();
    await startSend("First synthetic turn", 1);
    await streamAction(page, 1, "stream");
    await page.evaluate(async () => {
      const fixture = window.__chatFixture;
      const bytes = Array.from(new TextEncoder().encode('data: {"text":"Café"}\n\ndata: {"topic":"Updated synthetic","refreshCurrentRoute":true}\n\ndata: [DONE]\n\n'));
      for (const byte of bytes) fixture.bytes(1, [byte]);
      fixture.finish(1);
      await fixture.settle();
    });
    expect(await messages().innerText()).toContain("Café");
    expect(await refreshes(page)).toBe(1);
    const request = await startSend("Second synthetic turn", 2);
    expect(request.url).toBe("/api/workspaces/alpha/conversations/a");
    await streamAction(page, 2, "stream");
    await streamAction(page, 2, "chunk", 'data: {"text":"Second answer"}\n\n');
    await streamAction(page, 2, "finish");
    expect(await page.locator(".chat-turn").count()).toBe(3);
    expect(await refreshes(page)).toBe(1);
  });

  it("aborts and cancels the reader on unmount without applying a late refresh", async () => {
    await load();
    await startSend("Unmounted turn", 1);
    await streamAction(page, 1, "stream");
    await streamAction(page, 1, "chunk", 'data: {"text":"Partial","refreshCurrentRoute":true}\n\n');
    await page.evaluate(async () => {
      const fixture = window.__chatFixture;
      fixture.unmount(); await fixture.settle();
    });
    expect((await requests(page))[1]).toMatchObject({ aborted: true, canceled: true });
    expect(await refreshes(page)).toBe(0);
    expect(await page.locator(".chat-layout").count()).toBe(0);
  });
});
