import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Prisma } from "@prisma/client";

const { prismaMock } = vi.hoisted(() => ({
  prismaMock: {
    webhookEndpoint: { findMany: vi.fn() },
    webhookDelivery: { createManyAndReturn: vi.fn() },
  },
}));

vi.mock("@corgtex/shared", () => ({
  prisma: prismaMock,
  toInputJson: (value: unknown) => value,
}));

import { createWebhookDeliveries, signWebhookPayload } from "./webhooks";

function makeTxMock() {
  return {
    webhookEndpoint: { findMany: vi.fn() },
    webhookDelivery: { createManyAndReturn: vi.fn() },
  };
}

describe("createWebhookDeliveries", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("performs both the endpoint read and the delivery write through the injected client", async () => {
    const tx = makeTxMock();
    tx.webhookEndpoint.findMany.mockResolvedValue([{ id: "ep-1", eventTypes: [] }]);
    tx.webhookDelivery.createManyAndReturn.mockResolvedValue([{ id: "delivery-1" }]);

    const result = await createWebhookDeliveries(tx as unknown as Prisma.TransactionClient, {
      workspaceId: "workspace-1",
      eventId: "event-1",
      eventType: "meeting.created",
      payload: { hello: "world" },
    });

    expect(result).toEqual([{ id: "delivery-1" }]);
    expect(tx.webhookEndpoint.findMany).toHaveBeenCalledTimes(1);
    expect(tx.webhookDelivery.createManyAndReturn).toHaveBeenCalledTimes(1);
    // The global prisma client must never be touched: that is the orphan/duplicate bug this guards.
    expect(prismaMock.webhookEndpoint.findMany).not.toHaveBeenCalled();
    expect(prismaMock.webhookDelivery.createManyAndReturn).not.toHaveBeenCalled();
  });

  it("matches wildcard endpoints and filters the rest by eventType", async () => {
    const tx = makeTxMock();
    tx.webhookEndpoint.findMany.mockResolvedValue([
      { id: "ep-all", eventTypes: [] },
      { id: "ep-match", eventTypes: ["meeting.created"] },
      { id: "ep-other", eventTypes: ["action.created"] },
    ]);
    tx.webhookDelivery.createManyAndReturn.mockResolvedValue([{ id: "d-all" }, { id: "d-match" }]);

    await createWebhookDeliveries(tx as unknown as Prisma.TransactionClient, {
      workspaceId: "workspace-1",
      eventId: "event-1",
      eventType: "meeting.created",
      payload: {},
    });

    expect(tx.webhookDelivery.createManyAndReturn).toHaveBeenCalledTimes(1);
    const writeArg = tx.webhookDelivery.createManyAndReturn.mock.calls[0][0] as {
      data: Array<{ endpointId: string; status: string }>;
    };
    expect(writeArg.data.map((d) => d.endpointId)).toEqual(["ep-all", "ep-match"]);
    expect(writeArg.data.every((d) => d.status === "PENDING")).toBe(true);
  });

  it("returns [] and skips the write when no endpoint matches", async () => {
    const tx = makeTxMock();
    tx.webhookEndpoint.findMany.mockResolvedValue([{ id: "ep-other", eventTypes: ["action.created"] }]);

    const result = await createWebhookDeliveries(tx as unknown as Prisma.TransactionClient, {
      workspaceId: "workspace-1",
      eventId: "event-1",
      eventType: "meeting.created",
      payload: {},
    });

    expect(result).toEqual([]);
    expect(tx.webhookDelivery.createManyAndReturn).not.toHaveBeenCalled();
  });
});

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
