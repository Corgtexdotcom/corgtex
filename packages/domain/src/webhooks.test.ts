import { describe, expect, it } from "vitest";
import { signWebhookPayload } from "./webhooks";

describe("signWebhookPayload", () => {
  it("produces a consistent HMAC-SHA256 signature", () => {
    const payload = JSON.stringify({ event: "test", data: { id: "1" } });
    const secret = "test-secret-key";

    const sig1 = signWebhookPayload(payload, secret);
    const sig2 = signWebhookPayload(payload, secret);

    expect(sig1).toBe(sig2);
    expect(sig1).toMatch(/^[a-f0-9]{64}$/);
  });

  it("produces different signatures for different secrets", () => {
    const payload = JSON.stringify({ event: "test" });

    const sig1 = signWebhookPayload(payload, "secret-a");
    const sig2 = signWebhookPayload(payload, "secret-b");

    expect(sig1).not.toBe(sig2);
  });

  it("produces different signatures for different payloads", () => {
    const secret = "same-secret";

    const sig1 = signWebhookPayload(JSON.stringify({ a: 1 }), secret);
    const sig2 = signWebhookPayload(JSON.stringify({ b: 2 }), secret);

    expect(sig1).not.toBe(sig2);
  });
});
