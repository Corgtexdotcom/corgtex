import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Resend } from "resend";

const state = vi.hoisted(() => ({ apiKey: "synthetic-resend-key", upsert: vi.fn() }));
vi.mock("./env", () => ({ env: {
  get RESEND_API_KEY() { return state.apiKey; },
  EMAIL_FROM: "Synthetic <sender@example.test>", EMAIL_REPLY_TO: "reply@example.test",
} }));
vi.mock("./db", () => ({ prisma: { emailDelivery: { upsert: state.upsert } } }));
import { sendEmail } from "./email";

const message = { to: "recipient@example.test", subject: "Original subject", html: "<p>Original body</p>", text: "Original body" };
const http = vi.fn<typeof fetch>();
const success = () => new Response(JSON.stringify({ id: "synthetic-message" }), { status: 200, headers: { "Content-Type": "application/json" } });
beforeEach(() => {
  vi.restoreAllMocks();
  state.apiKey = "synthetic-resend-key";
  state.upsert.mockReset().mockResolvedValue({});
  http.mockReset().mockResolvedValue(success());
  vi.stubGlobal("fetch", http); // Test-only wire boundary; production never patches global fetch.
});
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); });

describe("email HTTP attempt controls with installed Resend SDK", () => {
  it("blocks source revocation during SDK preparation before the real HTTP call", async () => {
    let current = true;
    const post = Resend.prototype.post;
    vi.spyOn(Resend.prototype, "post").mockImplementation((async function (this: Resend, ...args: Parameters<Resend["post"]>) {
      await Promise.resolve(); current = false;
      return post.apply(this, args);
    }) as Resend["post"]);
    const controller = new AbortController();
    const denied = new Error("Original source revoked");
    const authorizeAttempt = vi.fn(async () => { if (!current) throw denied; });
    await expect(sendEmail(message, { signal: controller.signal, authorizeAttempt })).rejects.toBe(denied);
    expect(authorizeAttempt).toHaveBeenCalledTimes(1);
    expect(http).not.toHaveBeenCalled();
  });

  it("binds callback and wire to one signal while preserving payload, idempotency and tracking", async () => {
    const controller = new AbortController();
    const authorizeAttempt = vi.fn<(context: Readonly<{ signal: AbortSignal }>) => Promise<void>>(async () => {});
    const result = await sendEmail({ ...message, cc: "copy@example.test", idempotencyKey: "synthetic-key",
      tracking: { emailType: "synthetic", workspaceId: "synthetic-workspace" } }, { signal: controller.signal, authorizeAttempt });
    expect(result).toEqual({ status: "SENT", providerMessageId: "synthetic-message" });
    expect(authorizeAttempt).toHaveBeenCalledTimes(1);
    expect(http).toHaveBeenCalledTimes(1);
    const [url, options] = http.mock.calls[0];
    expect(url).toBe("https://api.resend.com/emails");
    expect(options?.signal).toBe(authorizeAttempt.mock.calls[0][0].signal);
    expect(new Headers(options?.headers).get("Idempotency-Key")).toBe("synthetic-key");
    expect(JSON.parse(String(options?.body))).toMatchObject({ from: "Synthetic <sender@example.test>", to: message.to,
      subject: message.subject, html: message.html, text: message.text, cc: "copy@example.test" });
    expect(state.upsert).toHaveBeenCalledTimes(1);
  });

  it("checks every SDK dispatch and prevents a retry after original authority changes", async () => {
    let current = true;
    const authorizeAttempt = vi.fn(async () => { if (!current) throw new Error("Original epoch changed"); });
    vi.spyOn(Resend.prototype, "post").mockImplementation((async function (this: Resend, path: string, entity?: unknown) {
      await this.fetchRequest(path, { method: "POST", body: JSON.stringify(entity) });
      current = false;
      return this.fetchRequest(path, { method: "POST", body: JSON.stringify(entity) });
    }) as Resend["post"]);
    await expect(sendEmail(message, { signal: new AbortController().signal, authorizeAttempt })).rejects.toThrow("Original epoch changed");
    expect(authorizeAttempt).toHaveBeenCalledTimes(2);
    expect(http).toHaveBeenCalledTimes(1);
  });

  it.each(["before", "during authorization"])("blocks cancellation %s dispatch", async when => {
    const controller = new AbortController();
    const reason = new Error("Synthetic cancellation");
    if (when === "before") controller.abort(reason);
    const authorizeAttempt = vi.fn(async () => { controller.abort(reason); });
    await expect(sendEmail(message, { signal: controller.signal, authorizeAttempt })).rejects.toBe(reason);
    expect(http).not.toHaveBeenCalled();
    expect(authorizeAttempt).toHaveBeenCalledTimes(when === "before" ? 0 : 1);
  });

  it("preserves cancellation when the SDK converts an aborted fetch to a provider error", async () => {
    const controller = new AbortController();
    const reason = new Error("Cancelled at HTTP boundary");
    http.mockImplementationOnce(async (_url, options) => {
      controller.abort(reason);
      options?.signal?.throwIfAborted();
      return success();
    });
    await expect(sendEmail(message, { signal: controller.signal, authorizeAttempt: async () => {} })).rejects.toBe(reason);
    expect(http).toHaveBeenCalledTimes(1);
  });

  it("does not let an SDK wrapper swallow authorization denial", async () => {
    const denied = new Error("Original proof denied");
    vi.spyOn(Resend.prototype, "post").mockImplementation((async function (this: Resend, path: string, entity?: unknown) {
      try { await this.fetchRequest(path, { method: "POST", body: JSON.stringify(entity) }); } catch { /* simulated SDK error wrapper */ }
      return { data: { id: "not-sent" }, error: null };
    }) as Resend["post"]);
    await expect(sendEmail(message, { signal: new AbortController().signal, authorizeAttempt: async () => { throw denied; } })).rejects.toBe(denied);
    expect(http).not.toHaveBeenCalled();
  });

  it("keeps simultaneous per-send guards isolated", async () => {
    let release!: () => void;
    const paused = new Promise<void>(resolve => { release = resolve; });
    const denied = new Error("Only first source denied");
    const first = sendEmail({ ...message, subject: "First denied" }, { signal: new AbortController().signal,
      authorizeAttempt: async () => { await paused; throw denied; } });
    const firstResult = first.then(value => ({ value, error: undefined }), error => ({ value: undefined, error }));
    const second = await sendEmail({ ...message, subject: "Second permitted" }, { signal: new AbortController().signal, authorizeAttempt: async () => {} });
    release(); expect((await firstResult).error).toBe(denied);
    expect(second.status).toBe("SENT");
    expect(http).toHaveBeenCalledTimes(1);
    expect(JSON.parse(String(http.mock.calls[0][1]?.body)).subject).toBe("Second permitted");
  });

  it("preserves ordinary provider errors for guarded sends", async () => {
    http.mockResolvedValueOnce(new Response(JSON.stringify({ name: "validation_error", message: "Synthetic provider denial" }), { status: 400 }));
    await expect(sendEmail(message, { signal: new AbortController().signal, authorizeAttempt: async () => {} })).rejects.toThrow("Email send failed: Synthetic provider denial");
    expect(http).toHaveBeenCalledTimes(1);
  });

  it("keeps ordinary unguarded sends unchanged and skips missing credentials", async () => {
    expect(await sendEmail(message)).toEqual({ status: "SENT", providerMessageId: "synthetic-message" });
    expect(http.mock.calls[0][1]?.signal).toBeUndefined();
    state.apiKey = "";
    expect(await sendEmail(message)).toEqual({ status: "SKIPPED", reason: "RESEND_API_KEY missing" });
    expect(http).toHaveBeenCalledTimes(1);
  });
});
