import { createHmac } from "node:crypto";
import { beforeEach, describe, expect, it, vi } from "vitest";

const { prismaMock } = vi.hoisted(() => {
  const prisma = {
    $transaction: vi.fn(),
    workspace: { update: vi.fn(), findUnique: vi.fn() },
    modelUsageBudget: { upsert: vi.fn() },
    workspaceBillingProfile: {
      findFirst: vi.fn(),
      findUnique: vi.fn(),
      upsert: vi.fn(),
      update: vi.fn(),
      updateMany: vi.fn(),
    },
    customerAccount: { updateMany: vi.fn() },
    stripeWebhookEvent: {
      upsert: vi.fn(),
      update: vi.fn(),
    },
    aiUsageLedgerEntry: {
      findMany: vi.fn(),
      update: vi.fn(),
      updateMany: vi.fn(),
    },
    modelUsage: { findMany: vi.fn() },
  };
  return { prismaMock: prisma };
});

vi.mock("@corgtex/shared", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@corgtex/shared")>();
  return {
    ...actual,
    env: {
      ...actual.env,
      APP_URL: "https://app.test",
      STRIPE_SECRET_KEY: "sk_test",
      STRIPE_WEBHOOK_SECRET: "whsec_test",
      STRIPE_PRICE_AI_USAGE_ID: "price_ai",
    },
    prisma: prismaMock,
  };
});

function signature(rawBody: string) {
  const timestamp = "1770000000";
  const digest = createHmac("sha256", "whsec_test").update(`${timestamp}.${rawBody}`).digest("hex");
  return `t=${timestamp},v1=${digest}`;
}

describe("billing", () => {
  beforeEach(() => {
    vi.resetModules();
    vi.clearAllMocks();
    vi.stubGlobal("fetch", vi.fn());
    prismaMock.$transaction.mockImplementation(async (callback: any) => callback(prismaMock));
    prismaMock.stripeWebhookEvent.upsert.mockResolvedValue({ id: "evt-1", processedAt: null });
    prismaMock.stripeWebhookEvent.update.mockResolvedValue({});
    prismaMock.workspace.update.mockResolvedValue({});
    prismaMock.modelUsageBudget.upsert.mockResolvedValue({});
    prismaMock.workspaceBillingProfile.upsert.mockResolvedValue({});
    prismaMock.customerAccount.updateMany.mockResolvedValue({ count: 1 });
  });

  it("activates PAYG AI from a verified checkout webhook", async () => {
    vi.mocked(fetch).mockResolvedValueOnce(new Response(JSON.stringify({
      id: "sub-1",
      current_period_start: 1770000000,
      current_period_end: 1772592000,
      items: { data: [{ id: "si-1" }] },
    }), { status: 200 }));
    const event = {
      id: "evt-1",
      type: "checkout.session.completed",
      data: {
        object: {
          client_reference_id: "ws-1",
          customer: "cus-1",
          subscription: "sub-1",
          customer_email: "admin@example.test",
          metadata: { workspaceId: "ws-1" },
        },
      },
    };
    const rawBody = JSON.stringify(event);
    const { handleStripeWebhook } = await import("./billing");

    await expect(handleStripeWebhook(rawBody, signature(rawBody))).resolves.toEqual({
      processed: true,
      id: "evt-1",
    });

    expect(prismaMock.workspace.update).toHaveBeenCalledWith(expect.objectContaining({
      where: { id: "ws-1" },
      data: expect.objectContaining({ plan: "PAYG_AI" }),
    }));
    expect(prismaMock.modelUsageBudget.upsert).toHaveBeenCalledWith(expect.objectContaining({
      where: { workspaceId: "ws-1" },
      update: { monthlyCostCapUsd: -1 },
    }));
    expect(prismaMock.workspaceBillingProfile.upsert).toHaveBeenCalledWith(expect.objectContaining({
      where: { workspaceId: "ws-1" },
      update: expect.objectContaining({
        billingStatus: "ACTIVE",
        stripeCustomerId: "cus-1",
        stripeSubscriptionId: "sub-1",
        stripeSubscriptionItemId: "si-1",
      }),
    }));
  });

  it("rejects unsigned webhooks", async () => {
    const { handleStripeWebhook } = await import("./billing");

    await expect(handleStripeWebhook(JSON.stringify({ id: "evt-1", type: "ping" }), null)).rejects.toMatchObject({
      code: "STRIPE_SIGNATURE_MISSING",
    });
  });
});
