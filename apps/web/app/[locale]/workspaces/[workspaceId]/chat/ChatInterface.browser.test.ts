import { mkdir } from "node:fs/promises";
import { createHash } from "node:crypto";
import { NextRequest } from "next/server";
import type { Page } from "playwright";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { configure, conversation, finishUncommitted, refreshes, reply, requests, routeBrain, startChatBrowserFixture, streamAction } from "./chat-browser-fixture";

// Actual API entry point, with synthetic auth/service boundaries. The source
// owner's permission/hash/epoch implementation is unchanged and separately tested.
const nativeExport = vi.hoisted(() => vi.fn());
const nativeConversation = vi.hoisted(() => vi.fn());
vi.mock("@corgtex/domain", () => ({ exportConversationAnswerToBrain: nativeExport, getConversation: nativeConversation,
  isArtifactInputProofReadable: vi.fn(), addConversationTurn: vi.fn(), renameConversation: vi.fn(), deleteConversation: vi.fn(), completeRoleOnboardingConversation: vi.fn() }));
vi.mock("@corgtex/agents", () => ({ processConversationTurnStream: vi.fn(), sanitizeConversationPageContext: (value: unknown) => value }));
vi.mock("@corgtex/models", () => ({ defaultModelGateway: { chat: vi.fn() } }));
vi.mock("@/lib/auth", () => ({ resolveRequestActor: async () => ({ kind: "user", user: { id: "synthetic-user" } }) }));
vi.mock("@corgtex/shared", () => ({ isDatabaseUnavailableError: () => false }));
vi.mock("@corgtex/shared/telemetry-node", () => ({ captureErrorTelemetry: vi.fn() }));
vi.mock("@/lib/http", async (importOriginal) => ({
  ...await importOriginal<typeof import("@/lib/http")>(),
  handleRouteError: (error: Error) => Response.json({ message: error.message }, { status: 409 }),
}));

// PERSONAL_CHAT_BROWSER_QA=1 npm run test:unit -- ChatInterface.browser.test.ts
// Uses actual React effects and browser streams; all data and APIs are synthetic.
// Chromium may be supplied with PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH.
describe.runIf(process.env.PERSONAL_CHAT_BROWSER_QA === "1")("personal chat interrupted and repeated flows", () => {
  let fixture: Awaited<ReturnType<typeof startChatBrowserFixture>>;
  let page: Page;
  let errors: string[];
  let loseExportResponse: boolean;
  let nativeRead: typeof import("@/app/api/workspaces/[workspaceId]/conversations/[conversationId]/route").GET;

  beforeAll(async () => {
    const { POST } = await import("@/app/api/workspaces/[workspaceId]/conversations/[conversationId]/brain/route");
    nativeRead = (await import("@/app/api/workspaces/[workspaceId]/conversations/[conversationId]/route")).GET;
    fixture = await startChatBrowserFixture({ brainRoute: async (request, params) => {
      const response = await POST(new NextRequest(request), { params: Promise.resolve(params) });
      if (loseExportResponse && response.ok) {
        loseExportResponse = false;
        return Response.json({ message: "Synthetic response lost after commit" }, { status: 503 });
      }
      return response;
    } });
  });
  beforeEach(async () => {
    nativeExport.mockReset().mockResolvedValue({ sourceId: "synthetic-brain-source" });
    nativeConversation.mockReset();
    loseExportResponse = false;
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

  const digest = (value: unknown) => createHash("sha256").update(JSON.stringify(value)).digest("hex");
  const exports = () => page.getByText("Save to Brain", { exact: true });
  const exportForm = () => page.locator(".chat-turn").last().locator("details");
  const persisted = () => {
    const data = conversation("a");
    data.turns.push({ id: "persisted-a2", sequenceNumber: 7, userMessage: "Persisted second question",
      assistantMessage: "Persisted final answer", createdAt: "2026-01-02T00:00:00.000Z" });
    return data;
  };
  async function loadPersisted() {
    await select("a"); await requestAt(0);
    const data = persisted(); await reply(page, 0, { conversation: data }); return data;
  }
  async function replyPersisted(id: number, data: ReturnType<typeof persisted>) {
    const request = (await requests(page))[id];
    const parts = request.url.split("/");
    nativeConversation.mockResolvedValueOnce(data);
    const response = await nativeRead(new NextRequest(`${fixture.origin}${request.url}`), {
      params: Promise.resolve({ workspaceId: parts[3], conversationId: parts[5] }),
    });
    expect(response.status).toBe(200);
    expect(nativeConversation).toHaveBeenLastCalledWith({ kind: "user", user: { id: "synthetic-user" } }, parts[3], parts[5]);
    await reply(page, id, await response.json(), response.status);
  }
  async function openExport(mode: string) {
    await exports().last().click();
    await exportForm().getByLabel("Transcript metadata to include", { exact: true }).selectOption(mode);
    if (mode === "PARTIAL") await exportForm().getByRole("checkbox").first().check();
  }
  async function submitExport(id: number) {
    await exportForm().getByRole("button", { name: "Confirm and save", exact: true }).click();
    const request = await requestAt(id);
    expect(request.url).toBe("/api/workspaces/alpha/conversations/a/brain");
    return JSON.parse(request.body!);
  }
  async function committedSend(post = 1) {
    await streamAction(page, post, "stream");
    await streamAction(page, post, "chunk", 'data: {"text":"Streamed partial"}\n\n');
    await streamAction(page, post, "chunk", 'data: {"committedTurn":{"id":"persisted-a2","sequenceNumber":7,"createdAt":"2026-01-02T00:00:00.000Z"}}\n\n');
  }

  for (const mode of ["NONE", "PARTIAL", "FULL"]) {
    it(`sends exact persisted output and ${mode} metadata through the actual Brain route`, async () => {
      const data = await loadPersisted(); await openExport(mode);
      const body = await submitExport(1);
      const selected = mode === "NONE" ? [] : mode === "PARTIAL" ? data.turns.slice(0, 1) : data.turns;
      expect(body).toMatchObject({ outputTurnId: "persisted-a2", expectedOutputHash: digest(data.turns[1].assistantMessage), transcriptMode: mode,
        selectedTurns: selected.map(turn => ({ id: turn.id, hash: digest([turn.id, turn.userMessage, turn.assistantMessage]) })) });
      await routeBrain(page, 1);
      await exportForm().getByRole("status").waitFor();
      expect(nativeExport).toHaveBeenCalledWith({ kind: "user", user: { id: "synthetic-user" } }, { workspaceId: "alpha", conversationId: "a", ...body });
    });

    it(`reuses the exact ${mode} export identity after the actual route commits and its response is lost`, async () => {
      await loadPersisted(); await openExport(mode); loseExportResponse = true;
      const first = await submitExport(1); await routeBrain(page, 1);
      await exportForm().getByRole("alert").waitFor();
      const retry = await submitExport(2); expect(retry).toEqual(first);
      await routeBrain(page, 2); await exportForm().getByRole("status").waitFor();
      expect(nativeExport).toHaveBeenCalledTimes(2);
      expect(nativeExport.mock.calls[1][1]).toEqual(nativeExport.mock.calls[0][1]);
    });
  }

  it("keeps the earlier export identity when changing metadata mode and returning after lost responses", async () => {
    await loadPersisted(); await openExport("NONE"); loseExportResponse = true;
    const first = await submitExport(1); await routeBrain(page, 1); await exportForm().getByRole("alert").waitFor();
    await exportForm().getByLabel("Transcript metadata to include", { exact: true }).selectOption("FULL"); loseExportResponse = true;
    const changed = await submitExport(2); expect(changed.requestId).not.toBe(first.requestId);
    await routeBrain(page, 2); await exportForm().getByRole("alert").waitFor();
    await exportForm().getByLabel("Transcript metadata to include", { exact: true }).selectOption("NONE");
    expect(await submitExport(3)).toEqual(first); await routeBrain(page, 3);
    await exportForm().getByRole("status").waitFor();
  });

  it("remaps committed identity before export and reads exact persisted wording instead of streamed fragments", async () => {
    await load(); await startSend("Second question", 1); await committedSend();
    expect(await page.locator('[data-turn-id="persisted-a2"]').count()).toBe(1);
    expect(await exports().count()).toBe(0);
    await streamAction(page, 1, "chunk", 'data: {"text":" after receipt"}\n\n');
    expect(await messages().innerText()).toContain("Streamed partial after receipt");
    await streamAction(page, 1, "finish");
    expect(await requestAt(2)).toMatchObject({ method: "GET", url: "/api/workspaces/alpha/conversations/a" });
    expect(await exports().count()).toBe(0);
    const data = persisted(); await replyPersisted(2, data);
    expect(await messages().innerText()).toContain("Persisted final answer");
    expect(await messages().innerText()).not.toContain("Streamed partial");
    expect(await page.locator('[data-turn-id^="pending-"]').count()).toBe(0);
    await openExport("FULL"); const body = await submitExport(3);
    expect(body.expectedOutputHash).toBe(digest(data.turns[1].assistantMessage));
    expect(body.selectedTurns.map((turn: { id: string }) => turn.id)).toEqual(["turn-a", "persisted-a2"]);
    await routeBrain(page, 3); await exportForm().getByRole("status").waitFor();
    await mkdir(".artifacts/personal-chat", { recursive: true });
    await page.screenshot({ path: ".artifacts/personal-chat/composed-native-export.png", fullPage: true });
  });

  for (const staleFails of [false, true]) {
    it(`ignores a committed-answer reload that ${staleFails ? "fails" : "succeeds"} after navigation`, async () => {
      await load(); await startSend("Abandoned answer", 1); await committedSend(); await streamAction(page, 1, "finish"); await requestAt(2);
      await load("b", 3); await reply(page, 2, { conversation: persisted() }, staleFails ? 503 : 200);
      expect((await requests(page))[2].aborted).toBe(true);
      expect(await messages().innerText()).toContain("Answer b");
      expect(await messages().innerText()).not.toContain("Persisted final answer");
      await exports().click(); await page.getByRole("button", { name: "Confirm and save", exact: true }).click();
      expect(await requestAt(4)).toMatchObject({ url: "/api/workspaces/alpha/conversations/b/brain" });
      expect(JSON.parse((await requests(page))[4].body!).outputTurnId).toBe("turn-b");
      await routeBrain(page, 4);
    });
  }

  it("rejects a late persisted reload after workspace change and exports only the selected workspace", async () => {
    await load(); await startSend("Alpha prompt", 1); await committedSend(); await streamAction(page, 1, "finish"); await requestAt(2);
    await configure(page, { workspaceId: "beta", activeSessionId: "c" }); await requestAt(3);
    expect(await exports().count()).toBe(0); await reply(page, 3, { conversation: conversation("c") });
    await reply(page, 2, { conversation: persisted() });
    expect(await input().inputValue()).toBe(""); expect(await messages().innerText()).toContain("Answer c");
    await exports().click(); await page.getByRole("button", { name: "Confirm and save", exact: true }).click();
    expect(await requestAt(4)).toMatchObject({ url: "/api/workspaces/beta/conversations/c/brain" });
    expect(JSON.parse((await requests(page))[4].body!).outputTurnId).toBe("turn-c"); await routeBrain(page, 4);
  });

  it("does not restore an old export's saved state or selection after another conversation loads", async () => {
    await loadPersisted(); await openExport("PARTIAL"); await submitExport(1);
    await load("b", 2); await reply(page, 1, { sourceId: "old-source" }, 201);
    await exports().click();
    expect(await page.getByLabel("Brain title", { exact: true }).inputValue()).toBe("Answer b");
    expect(await page.getByLabel("Transcript metadata to include", { exact: true }).inputValue()).toBe("NONE");
    expect(await page.getByRole("status").count()).toBe(0);
    await page.getByRole("button", { name: "Confirm and save", exact: true }).click();
    expect(await requestAt(3)).toMatchObject({ url: "/api/workspaces/alpha/conversations/b/brain" }); await routeBrain(page, 3);
  });

  it("retains attachments and exact draft when a stream ends without commit, then removes uncommitted output on retry", async () => {
    await load(); await input().fill("  Retry exact\n draft  ");
    await page.locator('input[type="file"]').setInputFiles({ name: "native.txt", mimeType: "text/plain", buffer: Buffer.from("Synthetic native attachment") });
    await send().click(); await requestAt(1); await reply(page, 1, { message: "Uploaded once", webUrl: "/synthetic/uploaded" }); await requestAt(2);
    await streamAction(page, 2, "stream"); await streamAction(page, 2, "chunk", 'data: {"text":"Uncommitted answer"}\n\n');
    await finishUncommitted(page, 2);
    expect(await input().inputValue()).toBe("  Retry exact\n draft  ");
    expect(await page.locator(".chat-attachment-bar").innerText()).toContain("native.txt");
    expect(await messages().innerText()).not.toContain("Uncommitted answer"); expect(await exports().count()).toBe(1);
    await send().click(); expect(await requestAt(3)).toMatchObject({ url: "/api/workspaces/alpha/conversations/a" });
    expect(JSON.parse((await requests(page))[3].body!).message).toContain("/synthetic/uploaded");
    await committedSend(3); await streamAction(page, 3, "finish"); await requestAt(4); await replyPersisted(4, persisted());
    expect(await input().inputValue()).toBe(""); expect(await page.locator(".chat-attachment-bar").count()).toBe(0);
    expect((await requests(page)).filter(request => request.url.endsWith("/chat/attachments"))).toHaveLength(1);
  });

  it("removes the remapped answer and restores its draft if the stream fails after receipt", async () => {
    await load(); await startSend("Retry after receipt", 1); await committedSend(); await streamAction(page, 1, "fail");
    expect(await input().inputValue()).toBe("Retry after receipt");
    expect(await page.locator('[data-turn-id="persisted-a2"]').count()).toBe(0);
    expect(await messages().innerText()).not.toContain("Streamed partial"); expect(await exports().count()).toBe(1);
  });

  it("rejects a current load or commit read whose conversation identity does not match its route", async () => {
    await select("a"); await requestAt(0); await reply(page, 0, { conversation: conversation("b") });
    expect(await exports().count()).toBe(0); expect(await messages().innerText()).not.toContain("Answer b");
    await load("a", 1); await startSend("Mismatched commit read", 2); await committedSend(2); await streamAction(page, 2, "finish"); await requestAt(3);
    await reply(page, 3, { conversation: conversation("b") });
    expect(await input().inputValue()).toBe("Mismatched commit read"); expect(await messages().innerText()).not.toContain("Answer b");
    expect(await exports().count()).toBe(1);
  });
});
