import { createHmac } from "node:crypto";
import { NextRequest } from "next/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ record: vi.fn() }));
vi.mock("@corgtex/domain", () => ({ recordInboundEmailReply: mocks.record }));
import { POST } from "./route";

const key = Buffer.from("synthetic-only-resend-webhook");
function request(signed = true) {
  const body = JSON.stringify({ type: "email.received", data: { from: "Synthetic <lead@example.invalid>", text: "Synthetic reply" } });
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
    mocks.record.mockReset().mockResolvedValue({});
    vi.spyOn(console, "error").mockImplementation(() => {}); vi.spyOn(console, "warn").mockImplementation(() => {});
  });
  afterEach(() => { vi.unstubAllEnvs(); vi.restoreAllMocks(); });
  it("does not acknowledge a paused atomic writer", async () => {
    mocks.record.mockRejectedValue({ code: "CRM_PUBLIC_WRITES_PAUSED" });
    const response = await POST(request());
    expect(response.status).toBe(503);
    expect(await response.json()).toEqual({ error: "Lead intake is temporarily paused." });
  });
  it("still authenticates provider origin before calling the writer", async () => {
    expect((await POST(request(false))).status).toBe(401);
    expect(mocks.record).not.toHaveBeenCalled();
  });
  it("acknowledges ordinary processing without exposing failure details", async () => {
    mocks.record.mockRejectedValue(new Error("synthetic-private-payload"));
    expect((await POST(request())).status).toBe(200);
    expect(JSON.stringify(vi.mocked(console.error).mock.calls)).not.toContain("synthetic-private-payload");
  });
});
