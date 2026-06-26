import { createHmac } from "node:crypto";
import { NextRequest } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

const { emailDeliveryEventUpsertMock, emailDeliveryUpsertMock } = vi.hoisted(() => ({
  emailDeliveryEventUpsertMock: vi.fn(),
  emailDeliveryUpsertMock: vi.fn(),
}));

vi.mock("@corgtex/shared", () => ({
  prisma: {
    emailDeliveryEvent: {
      upsert: emailDeliveryEventUpsertMock,
    },
    emailDelivery: {
      upsert: emailDeliveryUpsertMock,
    },
  },
}));

const secret = `whsec_${Buffer.from("resend-secret").toString("base64")}`;

function signedRequest(payload: Record<string, unknown>, options: { svixId?: string } = {}) {
  const rawBody = JSON.stringify(payload);
  const svixId = options.svixId ?? "delivery-event";
  const svixTimestamp = String(Math.floor(Date.now() / 1000));
  const signature = createHmac("sha256", Buffer.from(secret.slice(6), "base64"))
    .update(`${svixId}.${svixTimestamp}.${rawBody}`)
    .digest("base64");

  return new NextRequest("http://localhost/api/webhooks/resend-delivery", {
    method: "POST",
    headers: {
      "svix-id": svixId,
      "svix-timestamp": svixTimestamp,
      "svix-signature": `v1,${signature}`,
    },
    body: rawBody,
  });
}

describe("Resend delivery webhook route", () => {
  beforeEach(() => {
    vi.resetModules();
    vi.unstubAllEnvs();
    vi.clearAllMocks();
    vi.stubEnv("RESEND_WEBHOOK_SECRET", secret);
    emailDeliveryEventUpsertMock.mockResolvedValue({});
    emailDeliveryUpsertMock.mockResolvedValue({});
  });

  it("rejects unsigned delivery webhooks", async () => {
    const { POST } = await import("./route");

    const response = await POST(new NextRequest("http://localhost/api/webhooks/resend-delivery", {
      method: "POST",
      body: JSON.stringify({ type: "email.delivered" }),
    }));

    expect(response.status).toBe(401);
    expect(emailDeliveryEventUpsertMock).not.toHaveBeenCalled();
    expect(emailDeliveryUpsertMock).not.toHaveBeenCalled();
  });

  it("records delivered events and updates the tracked email", async () => {
    const { POST } = await import("./route");

    const response = await POST(signedRequest({
      type: "email.delivered",
      created_at: "2026-06-26T04:41:10.000Z",
      data: {
        email_id: "email-1",
        to: ["User <USER@Example.com>"],
        subject: "Reset your Corgtex password",
      },
    }));

    expect(response.status).toBe(200);
    expect(emailDeliveryEventUpsertMock).toHaveBeenCalledWith(expect.objectContaining({
      where: { dedupeKey: "delivery-event" },
      create: expect.objectContaining({
        provider: "resend",
        providerMessageId: "email-1",
        eventType: "email.delivered",
        dedupeKey: "delivery-event",
        occurredAt: new Date("2026-06-26T04:41:10.000Z"),
      }),
    }));
    expect(emailDeliveryUpsertMock).toHaveBeenCalledWith(expect.objectContaining({
      where: { providerMessageId: "email-1" },
      update: expect.objectContaining({
        status: "DELIVERED",
        lastEventType: "email.delivered",
        deliveredAt: new Date("2026-06-26T04:41:10.000Z"),
      }),
      create: expect.objectContaining({
        providerMessageId: "email-1",
        emailType: "unknown",
        toEmail: "user@example.com",
        toDomain: "example.com",
        subject: "Reset your Corgtex password",
        status: "DELIVERED",
        deliveredAt: new Date("2026-06-26T04:41:10.000Z"),
      }),
    }));
  });

  it("records bounced events with the provider reason", async () => {
    const { POST } = await import("./route");

    const response = await POST(signedRequest({
      type: "email.bounced",
      created_at: "2026-06-26T04:42:10.000Z",
      data: {
        email_id: "email-2",
        to: "user@example.com",
        subject: "Reset your Corgtex password",
        reason: "Mailbox does not exist",
      },
    }, { svixId: "bounce-event" }));

    expect(response.status).toBe(200);
    expect(emailDeliveryUpsertMock).toHaveBeenCalledWith(expect.objectContaining({
      where: { providerMessageId: "email-2" },
      update: expect.objectContaining({
        status: "BOUNCED",
        bouncedAt: new Date("2026-06-26T04:42:10.000Z"),
        failureReason: "Mailbox does not exist",
      }),
    }));
  });

  it("records complained events", async () => {
    const { POST } = await import("./route");

    const response = await POST(signedRequest({
      type: "email.complained",
      created_at: "2026-06-26T04:43:10.000Z",
      data: {
        email_id: "email-3",
        to: "user@example.com",
        subject: "Reset your Corgtex password",
        complaint_type: "abuse",
      },
    }, { svixId: "complaint-event" }));

    expect(response.status).toBe(200);
    expect(emailDeliveryUpsertMock).toHaveBeenCalledWith(expect.objectContaining({
      where: { providerMessageId: "email-3" },
      update: expect.objectContaining({
        status: "COMPLAINED",
        complainedAt: new Date("2026-06-26T04:43:10.000Z"),
        failureReason: "abuse",
      }),
    }));
  });

  it("ignores signed events that are not delivery outcomes", async () => {
    const { POST } = await import("./route");

    const response = await POST(signedRequest({
      type: "email.opened",
      created_at: "2026-06-26T04:44:10.000Z",
      data: {
        email_id: "email-4",
      },
    }, { svixId: "open-event" }));

    await expect(response.json()).resolves.toEqual({ ok: true, ignored: true });
    expect(emailDeliveryEventUpsertMock).not.toHaveBeenCalled();
    expect(emailDeliveryUpsertMock).not.toHaveBeenCalled();
  });
});
