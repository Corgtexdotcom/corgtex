import { createHmac } from "node:crypto";
import { NextRequest } from "next/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ record: vi.fn(), fetch: vi.fn() }));
vi.mock("@corgtex/domain", () => ({ recordInboundEmailReply: mocks.record }));
import { POST } from "./route";

const key = Buffer.from("synthetic-only-resend-webhook");
const emailId = "56761188-7520-42d8-8898-ff6fc54ce618";
const email = { id: emailId, from: "Synthetic <lead@example.invalid>", subject: "Synthetic", text: "Synthetic reply", to: ["support@example.invalid"] };
function request(signed = true, data: unknown = { email_id: emailId, from: email.from, subject: email.subject, to: email.to }) {
  const body = JSON.stringify({ type: "email.received", data });
  const id = "synthetic-svix", timestamp = String(Math.floor(Date.now() / 1000));
  const signature = createHmac("sha256", key).update(`${id}.${timestamp}.${body}`).digest("base64");
  return new NextRequest("https://selfserve.corgtex.com/api/webhooks/resend-inbound", {
    method: "POST", body,
    headers: signed ? { "svix-id": id, "svix-timestamp": timestamp, "svix-signature": `v1,${signature}` } : {},
  });
}
describe("Resend cutover retry behavior", () => {
  beforeEach(() => {
    vi.stubEnv("RESEND_WEBHOOK_SECRET", `whsec_${key.toString("base64")}`);
    vi.stubEnv("RESEND_API_KEY", "synthetic-only-provider-key");
    vi.stubEnv("EMAIL_REPLY_TO", "support@example.invalid");
    vi.stubGlobal("fetch", mocks.fetch);
    mocks.record.mockReset().mockResolvedValue({});
    mocks.fetch.mockReset().mockResolvedValue(Response.json(email));
    vi.spyOn(console, "error").mockImplementation(() => {}); vi.spyOn(console, "warn").mockImplementation(() => {});
  });
  afterEach(() => { vi.unstubAllEnvs(); vi.unstubAllGlobals(); vi.restoreAllMocks(); });
  it("retrieves the provider body from a metadata-only event and records its identity", async () => {
    expect((await POST(request())).status).toBe(200);
    expect(mocks.fetch).toHaveBeenCalledWith(`https://api.resend.com/emails/receiving/${emailId}`, expect.objectContaining({
      headers: { Authorization: "Bearer synthetic-only-provider-key" }, redirect: "error", cache: "no-store",
    }));
    expect(mocks.record).toHaveBeenCalledWith({ fromEmail: "lead@example.invalid", subject: "Synthetic", bodyText: "Synthetic reply", providerEmailId: emailId });
  });
  it.each(["", "support@example.invalid,other@example.invalid"])("fails closed for missing or invalid recipient %s", async recipient => {
    vi.stubEnv("EMAIL_REPLY_TO", recipient);
    expect((await POST(request())).status).toBe(503);
    expect(mocks.fetch).not.toHaveBeenCalled(); expect(mocks.record).not.toHaveBeenCalled();
  });
  it("ignores other receiving mailboxes before content retrieval or writes", async () => {
    expect((await POST(request(true, { email_id: emailId, to: ["private@example.invalid"] }))).status).toBe(200);
    expect(mocks.fetch).not.toHaveBeenCalled(); expect(mocks.record).not.toHaveBeenCalled();
    mocks.fetch.mockResolvedValue(Response.json({ ...email, to: ["private@example.invalid"] }));
    expect((await POST(request())).status).toBe(200);
    expect(mocks.record).not.toHaveBeenCalled();
  });
  it("normalizes the approved recipient and refuses non-string entries", async () => {
    vi.stubEnv("EMAIL_REPLY_TO", " Support@Example.Invalid ");
    mocks.fetch.mockResolvedValue(Response.json({ ...email, to: [" SUPPORT@example.invalid "] }));
    expect((await POST(request())).status).toBe(200);
    expect(mocks.record).toHaveBeenCalledOnce();
    mocks.record.mockClear(); mocks.fetch.mockClear();
    expect((await POST(request(true, { email_id: emailId, to: [{ address: "support@example.invalid" }] }))).status).toBe(200);
    expect(mocks.fetch).not.toHaveBeenCalled(); expect(mocks.record).not.toHaveBeenCalled();
  });
  it("does not acknowledge a paused atomic writer", async () => {
    mocks.record.mockRejectedValue({ code: "CRM_PUBLIC_WRITES_PAUSED" });
    const response = await POST(request());
    expect(response.status).toBe(503);
    expect(await response.json()).toEqual({ error: "Lead intake is temporarily paused." });
  });
  it("authenticates provider origin before retrieval or writes", async () => {
    expect((await POST(request(false))).status).toBe(401);
    expect(mocks.fetch).not.toHaveBeenCalled();
    expect(mocks.record).not.toHaveBeenCalled();
  });
  it.each([401, 429, 500])("retries provider retrieval failure %s without writes", async status => {
    mocks.fetch.mockResolvedValue(new Response("synthetic-private-provider-detail", { status }));
    const response = await POST(request());
    expect(response.status).toBe(503);
    expect(JSON.stringify(await response.json())).not.toContain("synthetic-private-provider-detail");
    expect(mocks.record).not.toHaveBeenCalled();
  });
  it("rejects a mismatched provider email and invalid identifiers", async () => {
    mocks.fetch.mockResolvedValue(Response.json({ ...email, id: "different-id" }));
    expect((await POST(request())).status).toBe(503);
    mocks.fetch.mockClear();
    expect((await POST(request(true, { email_id: "../webhooks" }))).status).toBe(400);
    expect(mocks.fetch).not.toHaveBeenCalled(); expect(mocks.record).not.toHaveBeenCalled();
  });
  it("accepts HTML-only replies without preserving executable markup", async () => {
    mocks.fetch.mockResolvedValue(Response.json({ ...email, text: null, html: "<p>Plan a pilot.</p><script>privateScript()</script>" }));
    expect((await POST(request())).status).toBe(200);
    expect(mocks.record).toHaveBeenCalledWith(expect.objectContaining({ bodyText: "Plan a pilot." }));
  });
  it("acknowledges unrelated senders while retrying database failures safely", async () => {
    mocks.record.mockRejectedValue({ code: "NOT_FOUND" });
    expect((await POST(request())).status).toBe(200);
    mocks.fetch.mockResolvedValue(Response.json(email));
    mocks.record.mockRejectedValue(new Error("synthetic-private-payload"));
    expect((await POST(request())).status).toBe(503);
    expect(JSON.stringify(vi.mocked(console.error).mock.calls)).not.toContain("synthetic-private-payload");
  });
});
