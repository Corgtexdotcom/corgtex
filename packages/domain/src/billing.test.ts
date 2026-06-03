import { createHmac } from "node:crypto";
import { beforeEach, describe, expect, it, vi } from "vitest";

const { prismaMock } = vi.hoisted(() => {
  const prisma = {
    $transaction: vi.fn(),
    workspace: { update: vi.fn(), findUnique: vi.fn() },
    modelUsageBudget: { upsert: vi.fn() },
    workspaceFeatureFlag: { findUnique: vi.fn(), upsert: vi.fn() },
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
    prismaMock.workspaceFeatureFlag.findUnique.mockResolvedValue(null);
    prismaMock.workspaceFeatureFlag.upsert.mockResolvedValue({});
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
    expect(prismaMock.workspaceFeatureFlag.upsert).toHaveBeenCalledWith({
      where: {
        workspaceId_flag: {
          workspaceId: "ws-1",
          flag: "MEETING_RECORDERS",
        },
      },
      update: {
        enabled: true,
        config: expect.objectContaining({ stripePaygAiRecorderAccess: true }),
      },
      create: {
        workspaceId: "ws-1",
        flag: "MEETING_RECORDERS",
        enabled: true,
        config: expect.objectContaining({ stripePaygAiRecorderAccess: true }),
      },
    });
  });

  it("rejects unsigned webhooks", async () => {
    const { handleStripeWebhook } = await import("./billing");

    await expect(handleStripeWebhook(JSON.stringify({ id: "evt-1", type: "ping" }), null)).rejects.toMatchObject({
      code: "STRIPE_SIGNATURE_MISSING",
    });
  });

  it("ignores duplicate processed webhooks", async () => {
    prismaMock.stripeWebhookEvent.upsert.mockResolvedValueOnce({ id: "evt-processed", processedAt: new Date() });
    const event = {
      id: "evt-processed",
      type: "invoice.payment_failed",
      data: { object: { metadata: { workspaceId: "ws-1" } } },
    };
    const rawBody = JSON.stringify(event);
    const { handleStripeWebhook } = await import("./billing");

    await expect(handleStripeWebhook(rawBody, signature(rawBody))).resolves.toEqual({
      processed: false,
      id: "evt-processed",
    });
    expect(prismaMock.workspace.update).not.toHaveBeenCalled();
  });

  it("pauses AI on payment failure and resumes on active subscription", async () => {
    const { handleStripeWebhook } = await import("./billing");
    const failed = {
      id: "evt-failed",
      type: "invoice.payment_failed",
      data: { object: { metadata: { workspaceId: "ws-1" } } },
    };
    let rawBody = JSON.stringify(failed);
    prismaMock.workspaceFeatureFlag.findUnique.mockResolvedValueOnce({
      enabled: true,
      config: { stripePaygAiRecorderAccess: true },
    });

    await handleStripeWebhook(rawBody, signature(rawBody));

    expect(prismaMock.workspace.update).toHaveBeenCalledWith(expect.objectContaining({
      where: { id: "ws-1" },
      data: expect.objectContaining({ plan: "CORE_FREE" }),
    }));
    expect(prismaMock.modelUsageBudget.upsert).toHaveBeenCalledWith(expect.objectContaining({
      update: { monthlyCostCapUsd: 0 },
    }));
    expect(prismaMock.workspaceBillingProfile.update).toHaveBeenCalledWith(expect.objectContaining({
      where: { workspaceId: "ws-1" },
      data: expect.objectContaining({ billingStatus: "PAST_DUE", paymentMethodReady: false }),
    }));
    expect(prismaMock.workspaceFeatureFlag.upsert).toHaveBeenCalledWith(expect.objectContaining({
      where: {
        workspaceId_flag: {
          workspaceId: "ws-1",
          flag: "MEETING_RECORDERS",
        },
      },
      update: { enabled: false, config: { stripePaygAiRecorderAccess: false } },
      create: expect.objectContaining({
        enabled: false,
        config: { stripePaygAiRecorderAccess: false },
      }),
    }));

    vi.clearAllMocks();
    prismaMock.$transaction.mockImplementation(async (callback: any) => callback(prismaMock));
    prismaMock.stripeWebhookEvent.upsert.mockResolvedValue({ id: "evt-active", processedAt: null });
    prismaMock.stripeWebhookEvent.update.mockResolvedValue({});
    prismaMock.workspaceFeatureFlag.findUnique.mockResolvedValue(null);
    prismaMock.workspaceFeatureFlag.upsert.mockResolvedValue({});
    const active = {
      id: "evt-active",
      type: "customer.subscription.updated",
      data: {
        object: {
          id: "sub-1",
          customer: "cus-1",
          status: "active",
          metadata: { workspaceId: "ws-1" },
          items: { data: [{ id: "si-1" }] },
        },
      },
    };
    rawBody = JSON.stringify(active);

    await handleStripeWebhook(rawBody, signature(rawBody));

    expect(prismaMock.workspace.update).toHaveBeenCalledWith(expect.objectContaining({
      where: { id: "ws-1" },
      data: expect.objectContaining({ plan: "PAYG_AI" }),
    }));
    expect(prismaMock.workspaceBillingProfile.upsert).toHaveBeenCalledWith(expect.objectContaining({
      update: expect.objectContaining({ billingStatus: "ACTIVE", paymentMethodReady: true }),
    }));
    expect(prismaMock.workspaceFeatureFlag.upsert).toHaveBeenCalledWith(expect.objectContaining({
      update: {
        enabled: true,
        config: expect.objectContaining({ stripePaygAiRecorderAccess: true }),
      },
      create: expect.objectContaining({
        enabled: true,
        config: expect.objectContaining({ stripePaygAiRecorderAccess: true }),
      }),
    }));
  });

  it("does not disable recorder access touched after the Stripe grant", async () => {
    const { handleStripeWebhook } = await import("./billing");
    const event = {
      id: "evt-manual-recorder",
      type: "customer.subscription.updated",
      data: {
        object: {
          id: "sub-1",
          customer: "cus-1",
          status: "past_due",
          metadata: { workspaceId: "ws-1" },
        },
      },
    };
    const rawBody = JSON.stringify(event);
    prismaMock.workspaceFeatureFlag.findUnique.mockResolvedValueOnce({
      enabled: true,
      updatedAt: new Date("2026-06-03T12:00:10.000Z"),
      config: {
        stripePaygAiRecorderAccess: true,
        stripePaygAiRecorderAccessGrantedAt: "2026-06-03T12:00:00.000Z",
      },
    });

    await handleStripeWebhook(rawBody, signature(rawBody));

    expect(prismaMock.workspaceBillingProfile.update).toHaveBeenCalledWith(expect.objectContaining({
      where: { workspaceId: "ws-1" },
      data: expect.objectContaining({ billingStatus: "PAST_DUE", paymentMethodReady: false }),
    }));
    expect(prismaMock.workspaceFeatureFlag.upsert).not.toHaveBeenCalled();
  });

  it("pauses AI on canceled subscriptions and records detached payment methods", async () => {
    const { handleStripeWebhook } = await import("./billing");
    const canceled = {
      id: "evt-canceled",
      type: "customer.subscription.deleted",
      data: {
        object: {
          id: "sub-1",
          customer: "cus-1",
          metadata: { workspaceId: "ws-1" },
        },
      },
    };
    let rawBody = JSON.stringify(canceled);
    prismaMock.workspaceFeatureFlag.findUnique.mockResolvedValue({
      enabled: true,
      config: { stripePaygAiRecorderAccess: true },
    });

    await handleStripeWebhook(rawBody, signature(rawBody));

    expect(prismaMock.workspace.update).toHaveBeenCalledWith(expect.objectContaining({
      where: { id: "ws-1" },
      data: expect.objectContaining({ plan: "CORE_FREE" }),
    }));
    expect(prismaMock.workspaceBillingProfile.update).toHaveBeenCalledWith(expect.objectContaining({
      where: { workspaceId: "ws-1" },
      data: expect.objectContaining({ billingStatus: "CANCELED", paymentMethodReady: false }),
    }));
    expect(prismaMock.workspaceFeatureFlag.upsert).toHaveBeenCalledWith(expect.objectContaining({
      where: {
        workspaceId_flag: {
          workspaceId: "ws-1",
          flag: "MEETING_RECORDERS",
        },
      },
      update: { enabled: false, config: { stripePaygAiRecorderAccess: false } },
      create: expect.objectContaining({
        enabled: false,
        config: { stripePaygAiRecorderAccess: false },
      }),
    }));

    vi.clearAllMocks();
    prismaMock.$transaction.mockImplementation(async (callback: any) => callback(prismaMock));
    prismaMock.stripeWebhookEvent.upsert.mockResolvedValue({ id: "evt-detached", processedAt: null });
    prismaMock.stripeWebhookEvent.update.mockResolvedValue({});
    prismaMock.workspaceFeatureFlag.findUnique.mockResolvedValue(null);
    prismaMock.workspaceFeatureFlag.upsert.mockResolvedValue({});
    const detached = {
      id: "evt-detached",
      type: "payment_method.detached",
      data: {
        object: {
          id: "pm-1",
          metadata: { workspaceId: "ws-1" },
        },
      },
    };
    rawBody = JSON.stringify(detached);

    await handleStripeWebhook(rawBody, signature(rawBody));

    expect(prismaMock.workspaceBillingProfile.updateMany).toHaveBeenCalledWith({
      where: { workspaceId: "ws-1" },
      data: { paymentMethodReady: false },
    });
    expect(prismaMock.workspaceFeatureFlag.upsert).not.toHaveBeenCalled();
  });

  it("marks reported usage invoiced on successful invoice payment", async () => {
    vi.mocked(fetch).mockResolvedValueOnce(new Response(JSON.stringify({
      id: "sub-1",
      items: { data: [{ id: "si-1" }] },
    }), { status: 200 }));
    const event = {
      id: "evt-invoice",
      type: "invoice.payment_succeeded",
      data: {
        object: {
          id: "in-1",
          customer: "cus-1",
          subscription: "sub-1",
          metadata: { workspaceId: "ws-1" },
        },
      },
    };
    const rawBody = JSON.stringify(event);
    const { handleStripeWebhook } = await import("./billing");
    prismaMock.workspaceFeatureFlag.findUnique.mockResolvedValueOnce(null);

    await handleStripeWebhook(rawBody, signature(rawBody));

    expect(prismaMock.aiUsageLedgerEntry.updateMany).toHaveBeenCalledWith({
      where: {
        workspaceId: "ws-1",
        status: "REPORTED",
        stripeInvoiceId: null,
      },
      data: {
        status: "INVOICED",
        stripeInvoiceId: "in-1",
      },
    });
    expect(prismaMock.workspaceFeatureFlag.upsert).toHaveBeenCalledWith(expect.objectContaining({
      update: {
        enabled: true,
        config: expect.objectContaining({ stripePaygAiRecorderAccess: true }),
      },
      create: expect.objectContaining({
        workspaceId: "ws-1",
        flag: "MEETING_RECORDERS",
        enabled: true,
        config: expect.objectContaining({ stripePaygAiRecorderAccess: true }),
      }),
    }));
  });

  it("reports pending and failed usage entries to Stripe in billable cents", async () => {
    prismaMock.aiUsageLedgerEntry.findMany.mockResolvedValueOnce([
      {
        id: "ledger-1",
        billableCostUsd: "1.231",
        createdAt: new Date("2026-05-24T12:00:00.000Z"),
        workspace: { billingProfile: { stripeSubscriptionItemId: "si-1" } },
      },
    ]).mockResolvedValueOnce([
      {
        id: "ledger-2",
        billableCostUsd: "0.000",
        createdAt: new Date("2026-05-24T12:01:00.000Z"),
        workspace: { billingProfile: { stripeSubscriptionItemId: "si-1" } },
      },
    ]);
    vi.mocked(fetch).mockResolvedValueOnce(new Response(JSON.stringify({ id: "ur-1" }), { status: 200 }));
    const { reportPendingAiUsageToStripe } = await import("./billing");

    await expect(reportPendingAiUsageToStripe()).resolves.toEqual({ scanned: 2, reported: 2 });

    expect(prismaMock.aiUsageLedgerEntry.findMany).toHaveBeenNthCalledWith(1, expect.objectContaining({
      where: expect.objectContaining({ status: "PENDING" }),
      take: 100,
    }));
    expect(prismaMock.aiUsageLedgerEntry.findMany).toHaveBeenNthCalledWith(2, expect.objectContaining({
      where: expect.objectContaining({ status: "FAILED" }),
      take: 99,
    }));
    const [url, init] = vi.mocked(fetch).mock.calls[0] ?? [];
    expect(String(url)).toBe("https://api.stripe.com/v1/subscription_items/si-1/usage_records");
    expect(init).toEqual(expect.objectContaining({ method: "POST" }));
    const body = init?.body as URLSearchParams;
    expect(body.get("quantity")).toBe("124");
    expect(prismaMock.aiUsageLedgerEntry.update).toHaveBeenCalledWith(expect.objectContaining({
      where: { id: "ledger-1" },
      data: expect.objectContaining({ status: "REPORTED", stripeUsageRecordId: "ur-1" }),
    }));
    expect(prismaMock.aiUsageLedgerEntry.update).toHaveBeenCalledWith(expect.objectContaining({
      where: { id: "ledger-2" },
      data: expect.objectContaining({ status: "REPORTED" }),
    }));
  });

  it("keeps usage entries retryable when Stripe usage reporting fails", async () => {
    prismaMock.aiUsageLedgerEntry.findMany.mockResolvedValueOnce([]).mockResolvedValueOnce([
      {
        id: "ledger-1",
        billableCostUsd: "2.00",
        createdAt: new Date("2026-05-24T12:00:00.000Z"),
        workspace: { billingProfile: { stripeSubscriptionItemId: "si-1" } },
      },
    ]);
    vi.mocked(fetch).mockResolvedValueOnce(new Response(JSON.stringify({ error: { message: "bad subscription item" } }), { status: 400 }));
    const { reportPendingAiUsageToStripe } = await import("./billing");

    await expect(reportPendingAiUsageToStripe()).resolves.toEqual({ scanned: 1, reported: 0 });

    expect(prismaMock.aiUsageLedgerEntry.update).toHaveBeenCalledWith(expect.objectContaining({
      where: { id: "ledger-1" },
      data: expect.objectContaining({
        status: "FAILED",
        lastReportError: "bad subscription item",
      }),
    }));
  });

  it("prioritizes pending usage before failed retry backlog", async () => {
    prismaMock.aiUsageLedgerEntry.findMany.mockResolvedValueOnce([
      {
        id: "ledger-pending",
        billableCostUsd: "1.00",
        createdAt: new Date("2026-05-24T12:00:00.000Z"),
        workspace: { billingProfile: { stripeSubscriptionItemId: "si-1" } },
      },
    ]);
    vi.mocked(fetch).mockResolvedValueOnce(new Response(JSON.stringify({ id: "ur-1" }), { status: 200 }));
    const { reportPendingAiUsageToStripe } = await import("./billing");

    await expect(reportPendingAiUsageToStripe({ limit: 1 })).resolves.toEqual({ scanned: 1, reported: 1 });

    expect(prismaMock.aiUsageLedgerEntry.findMany).toHaveBeenCalledTimes(1);
    expect(prismaMock.aiUsageLedgerEntry.findMany).toHaveBeenCalledWith(expect.objectContaining({
      where: expect.objectContaining({ status: "PENDING" }),
      take: 1,
    }));
  });
});
