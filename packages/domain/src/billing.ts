import { createHmac, timingSafeEqual } from "node:crypto";
import type { Prisma } from "@prisma/client";
import { env, prisma } from "@corgtex/shared";
import type { AppActor } from "@corgtex/shared";
import { requireWorkspaceMembership } from "./auth";
import { getWorkspaceMonthlyUsage } from "./agent-run-usage";
import { AppError, invariant } from "./errors";

type StripeEvent = {
  id: string;
  type: string;
  data?: {
    object?: Record<string, unknown>;
  };
};

type BillingActivation = {
  stripeCustomerId?: string | null;
  stripeSubscriptionId?: string | null;
  stripeSubscriptionItemId?: string | null;
  stripePriceId?: string | null;
  billingEmail?: string | null;
  currentPeriodStart?: Date | null;
  currentPeriodEnd?: Date | null;
};

const MEETING_RECORDERS_FEATURE_FLAG = "MEETING_RECORDERS";
const STRIPE_PAYG_RECORDER_ACCESS_KEY = "stripePaygAiRecorderAccess";
const STRIPE_PAYG_RECORDER_ACCESS_GRANTED_AT_KEY = "stripePaygAiRecorderAccessGrantedAt";
const RECORDER_ACCESS_EXTERNAL_TOUCH_GRACE_MS = 5000;

function requireStripeSecret() {
  if (!env.STRIPE_SECRET_KEY) {
    throw new AppError(503, "STRIPE_NOT_CONFIGURED", "Stripe billing is not configured.");
  }
  return env.STRIPE_SECRET_KEY;
}

function requireStripePriceId() {
  if (!env.STRIPE_PRICE_AI_USAGE_ID) {
    throw new AppError(503, "STRIPE_PRICE_NOT_CONFIGURED", "Stripe AI usage price is not configured.");
  }
  return env.STRIPE_PRICE_AI_USAGE_ID;
}

function appReturnUrl(workspaceId: string, status: string) {
  return `${env.APP_URL.replace(/\/$/, "")}/workspaces/${workspaceId}/settings?tab=agents&billing=${status}`;
}

function stringField(value: unknown) {
  return typeof value === "string" && value.trim().length > 0 ? value : null;
}

function numberDate(value: unknown) {
  return typeof value === "number" && Number.isFinite(value) ? new Date(value * 1000) : null;
}

function stripeStatus(status: string | null | undefined) {
  switch (status) {
    case "active":
    case "trialing":
      return "ACTIVE";
    case "past_due":
      return "PAST_DUE";
    case "canceled":
      return "CANCELED";
    case "unpaid":
    case "incomplete":
    case "incomplete_expired":
      return "PAYMENT_REQUIRED";
    default:
      return "CHECKOUT_PENDING";
  }
}

function subscriptionItemIdFromObject(value: Record<string, unknown>) {
  const items = value.items;
  if (!items || typeof items !== "object" || Array.isArray(items)) return null;
  const data = (items as { data?: unknown }).data;
  if (!Array.isArray(data)) return null;
  const first = data.find((entry) => entry && typeof entry === "object" && typeof (entry as { id?: unknown }).id === "string");
  return first ? String((first as { id: string }).id) : null;
}

async function stripeRequest(path: string, params: URLSearchParams, method: "POST" | "GET" = "POST") {
  const secret = requireStripeSecret();
  const url = new URL(`https://api.stripe.com/v1${path}`);
  const init: RequestInit = {
    method,
    headers: {
      authorization: `Bearer ${secret}`,
    },
  };
  if (method === "POST") {
    init.headers = {
      ...init.headers,
      "content-type": "application/x-www-form-urlencoded",
    };
    init.body = params;
  } else {
    for (const [key, value] of params) {
      url.searchParams.append(key, value);
    }
  }

  const response = await fetch(url, init);
  const text = await response.text();
  const data = text ? JSON.parse(text) as Record<string, unknown> : {};
  if (!response.ok) {
    const message = stringField(data.error && typeof data.error === "object" ? (data.error as { message?: unknown }).message : null)
      ?? `Stripe request failed with status ${response.status}.`;
    throw new AppError(502, "STRIPE_REQUEST_FAILED", message);
  }
  return data;
}

async function getStripeSubscription(subscriptionId: string) {
  return stripeRequest(`/subscriptions/${encodeURIComponent(subscriptionId)}`, new URLSearchParams(), "GET");
}

function isJsonObject(value: Prisma.JsonValue | null | undefined): value is Prisma.JsonObject {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}

function hasStripePaygRecorderAccess(config: Prisma.JsonValue | null | undefined) {
  return isJsonObject(config) && config[STRIPE_PAYG_RECORDER_ACCESS_KEY] === true;
}

function wasTouchedAfterStripeGrant(record: { updatedAt: Date; config: Prisma.JsonValue | null } | null | undefined) {
  const rawGrantedAt = record && isJsonObject(record.config) ? record.config[STRIPE_PAYG_RECORDER_ACCESS_GRANTED_AT_KEY] : null;
  const grantedAt = typeof rawGrantedAt === "string" ? Date.parse(rawGrantedAt) : NaN;
  return Number.isFinite(grantedAt)
    && record
    && record.updatedAt.getTime() - grantedAt > RECORDER_ACCESS_EXTERNAL_TOUCH_GRACE_MS;
}

function recorderAccessConfig(config: Prisma.JsonValue | null | undefined, enabled: boolean): Prisma.InputJsonObject {
  return {
    ...(isJsonObject(config) ? config : {}),
    [STRIPE_PAYG_RECORDER_ACCESS_KEY]: enabled,
    ...(enabled ? { [STRIPE_PAYG_RECORDER_ACCESS_GRANTED_AT_KEY]: new Date().toISOString() } : {}),
  };
}

async function setPurchasedRecorderAccess(tx: Prisma.TransactionClient, workspaceId: string, enabled: boolean) {
  const existing = await tx.workspaceFeatureFlag.findUnique({
    where: {
      workspaceId_flag: {
        workspaceId,
        flag: MEETING_RECORDERS_FEATURE_FLAG,
      },
    },
  });
  if (enabled && existing?.enabled) {
    return;
  }
  if (!enabled && (!hasStripePaygRecorderAccess(existing?.config) || wasTouchedAfterStripeGrant(existing))) {
    return;
  }
  const config = recorderAccessConfig(existing?.config, enabled);
  await tx.workspaceFeatureFlag.upsert({
    where: {
      workspaceId_flag: {
        workspaceId,
        flag: MEETING_RECORDERS_FEATURE_FLAG,
      },
    },
    update: { enabled, config },
    create: {
      workspaceId,
      flag: MEETING_RECORDERS_FEATURE_FLAG,
      enabled,
      config,
    },
  });
}

async function activatePaygAi(tx: Prisma.TransactionClient, workspaceId: string, params: BillingActivation) {
  await tx.workspace.update({
    where: { id: workspaceId },
    data: {
      plan: "PAYG_AI",
      planActivatedAt: new Date(),
    },
  });
  await tx.modelUsageBudget.upsert({
    where: { workspaceId },
    create: {
      workspaceId,
      monthlyCostCapUsd: -1,
    },
    update: {
      monthlyCostCapUsd: -1,
    },
  });
  await tx.workspaceBillingProfile.upsert({
    where: { workspaceId },
    create: {
      workspaceId,
      billingStatus: "ACTIVE",
      stripeCustomerId: params.stripeCustomerId ?? undefined,
      stripeSubscriptionId: params.stripeSubscriptionId ?? undefined,
      stripeSubscriptionItemId: params.stripeSubscriptionItemId ?? undefined,
      stripePriceId: params.stripePriceId ?? undefined,
      billingEmail: params.billingEmail ?? undefined,
      paymentMethodReady: true,
      currentPeriodStart: params.currentPeriodStart ?? undefined,
      currentPeriodEnd: params.currentPeriodEnd ?? undefined,
    },
    update: {
      billingStatus: "ACTIVE",
      stripeCustomerId: params.stripeCustomerId ?? undefined,
      stripeSubscriptionId: params.stripeSubscriptionId ?? undefined,
      stripeSubscriptionItemId: params.stripeSubscriptionItemId ?? undefined,
      stripePriceId: params.stripePriceId ?? undefined,
      billingEmail: params.billingEmail ?? undefined,
      paymentMethodReady: true,
      failedPaymentAt: null,
      canceledAt: null,
      currentPeriodStart: params.currentPeriodStart ?? undefined,
      currentPeriodEnd: params.currentPeriodEnd ?? undefined,
    },
  });
  await setPurchasedRecorderAccess(tx, workspaceId, true);
  await tx.customerAccount.updateMany({
    where: {
      deployments: {
        some: { managedWorkspaceId: workspaceId },
      },
    },
    data: { status: "ACTIVE" },
  });
}

async function pauseAiForBilling(tx: Prisma.TransactionClient, workspaceId: string, status: "PAST_DUE" | "PAYMENT_REQUIRED" | "CANCELED") {
  await tx.workspace.update({
    where: { id: workspaceId },
    data: {
      plan: "CORE_FREE",
      planActivatedAt: new Date(),
    },
  });
  await tx.modelUsageBudget.upsert({
    where: { workspaceId },
    create: { workspaceId, monthlyCostCapUsd: 0 },
    update: { monthlyCostCapUsd: 0 },
  });
  await tx.workspaceBillingProfile.update({
    where: { workspaceId },
    data: {
      billingStatus: status,
      paymentMethodReady: false,
      ...(status === "CANCELED" ? { canceledAt: new Date() } : { failedPaymentAt: new Date() }),
    },
  });
  await setPurchasedRecorderAccess(tx, workspaceId, false);
}

export async function getWorkspacePlanState(actor: AppActor, workspaceId: string) {
  await requireWorkspaceMembership({ actor, workspaceId });
  const workspace = await prisma.workspace.findUnique({
    where: { id: workspaceId },
    select: {
      id: true,
      plan: true,
      planActivatedAt: true,
      trialEndsAt: true,
      billingProfile: true,
      modelUsageBudget: true,
      procurementTrials: {
        orderBy: { createdAt: "desc" },
        take: 1,
        select: {
          id: true,
          status: true,
          trialExpiresAt: true,
          modelMonthlyBudgetCents: true,
        },
      },
      oauthConnections: {
        orderBy: { updatedAt: "desc" },
        select: {
          id: true,
          provider: true,
          providerAccountId: true,
          providerEmail: true,
          scopes: true,
          status: true,
          syncSettings: true,
          lastSyncAt: true,
          lastSyncError: true,
          disconnectedAt: true,
          updatedAt: true,
        },
      },
      _count: {
        select: { members: true },
      },
    },
  });
  invariant(workspace, 404, "NOT_FOUND", "Workspace not found.");

  const usedUsd = await getWorkspaceMonthlyUsage(workspaceId, workspace.modelUsageBudget?.periodStartDay ?? 1);
  const capUsd = workspace.modelUsageBudget ? Number(workspace.modelUsageBudget.monthlyCostCapUsd) : null;
  return {
    workspaceId: workspace.id,
    plan: workspace.plan,
    planActivatedAt: workspace.planActivatedAt,
    trialEndsAt: workspace.trialEndsAt,
    trial: workspace.procurementTrials[0] ?? null,
    billing: workspace.billingProfile,
    aiBudget: {
      capUsd,
      usedUsd,
      usedPct: capUsd && capUsd > 0 ? (usedUsd / capUsd) * 100 : capUsd === 0 ? 100 : 0,
      enabled: workspace.plan === "TRIAL" || workspace.plan === "PAYG_AI" || workspace.plan === "ENTERPRISE_MANAGED",
    },
    connectors: workspace.oauthConnections,
    memberCount: workspace._count.members,
  };
}

export async function createStripeCheckoutSession(actor: AppActor, workspaceId: string) {
  await requireWorkspaceMembership({ actor, workspaceId, allowedRoles: ["ADMIN"] });
  invariant(actor.kind === "user", 403, "FORBIDDEN", "Only users can start billing checkout.");
  const priceId = requireStripePriceId();
  const workspace = await prisma.workspace.findUnique({
    where: { id: workspaceId },
    select: {
      id: true,
      name: true,
      slug: true,
      billingProfile: true,
    },
  });
  invariant(workspace, 404, "NOT_FOUND", "Workspace not found.");

  let stripeCustomerId = workspace.billingProfile?.stripeCustomerId ?? null;
  if (!stripeCustomerId) {
    const customer = await stripeRequest("/customers", new URLSearchParams({
      email: actor.user.email,
      name: workspace.name,
      "metadata[workspaceId]": workspace.id,
      "metadata[workspaceSlug]": workspace.slug,
    }));
    stripeCustomerId = String(customer.id);
  }

  const session = await stripeRequest("/checkout/sessions", new URLSearchParams({
    mode: "subscription",
    customer: stripeCustomerId,
    client_reference_id: workspace.id,
    success_url: appReturnUrl(workspace.id, "success"),
    cancel_url: appReturnUrl(workspace.id, "canceled"),
    "line_items[0][price]": priceId,
    "metadata[workspaceId]": workspace.id,
    "subscription_data[metadata][workspaceId]": workspace.id,
  }));

  await prisma.workspaceBillingProfile.upsert({
    where: { workspaceId: workspace.id },
    create: {
      workspaceId: workspace.id,
      stripeCustomerId,
      stripeCheckoutSessionId: String(session.id),
      stripePriceId: priceId,
      billingStatus: "CHECKOUT_PENDING",
      billingEmail: actor.user.email,
    },
    update: {
      stripeCustomerId,
      stripeCheckoutSessionId: String(session.id),
      stripePriceId: priceId,
      billingStatus: "CHECKOUT_PENDING",
      billingEmail: actor.user.email,
    },
  });

  return {
    id: String(session.id),
    url: stringField(session.url),
  };
}

export async function createStripeBillingPortalSession(actor: AppActor, workspaceId: string) {
  await requireWorkspaceMembership({ actor, workspaceId, allowedRoles: ["ADMIN"] });
  const profile = await prisma.workspaceBillingProfile.findUnique({
    where: { workspaceId },
    select: { stripeCustomerId: true },
  });
  invariant(profile?.stripeCustomerId, 400, "BILLING_NOT_CONNECTED", "Billing is not connected for this workspace.");

  const session = await stripeRequest("/billing_portal/sessions", new URLSearchParams({
    customer: profile.stripeCustomerId,
    return_url: appReturnUrl(workspaceId, "portal_return"),
  }));

  return {
    id: String(session.id),
    url: stringField(session.url),
  };
}

export function verifyStripeWebhookSignature(rawBody: string, signatureHeader: string | null | undefined) {
  if (!env.STRIPE_WEBHOOK_SECRET) {
    throw new AppError(503, "STRIPE_WEBHOOK_NOT_CONFIGURED", "Stripe webhook signing secret is not configured.");
  }
  if (!signatureHeader) {
    throw new AppError(400, "STRIPE_SIGNATURE_MISSING", "Missing Stripe-Signature header.");
  }

  const parts = signatureHeader.split(",").map((part) => part.trim());
  const timestamp = parts.find((part) => part.startsWith("t="))?.slice(2);
  const signatures = parts.filter((part) => part.startsWith("v1=")).map((part) => part.slice(3));
  invariant(timestamp && signatures.length > 0, 400, "STRIPE_SIGNATURE_INVALID", "Invalid Stripe-Signature header.");

  const signedPayload = `${timestamp}.${rawBody}`;
  const expected = createHmac("sha256", env.STRIPE_WEBHOOK_SECRET).update(signedPayload).digest("hex");
  const expectedBuffer = Buffer.from(expected, "hex");
  const valid = signatures.some((signature) => {
    const candidate = Buffer.from(signature, "hex");
    return candidate.length === expectedBuffer.length && timingSafeEqual(candidate, expectedBuffer);
  });
  if (!valid) {
    throw new AppError(400, "STRIPE_SIGNATURE_INVALID", "Invalid Stripe webhook signature.");
  }
}

async function resolveWorkspaceIdFromStripeObject(object: Record<string, unknown>) {
  const metadata = object.metadata && typeof object.metadata === "object" && !Array.isArray(object.metadata)
    ? object.metadata as Record<string, unknown>
    : {};
  const workspaceId = stringField(metadata.workspaceId) ?? stringField(object.client_reference_id);
  if (workspaceId) return workspaceId;

  const customerId = stringField(object.customer);
  const subscriptionId = stringField(object.subscription) ?? stringField(object.id);
  const profile = await prisma.workspaceBillingProfile.findFirst({
    where: {
      OR: [
        ...(customerId ? [{ stripeCustomerId: customerId }] : []),
        ...(subscriptionId ? [{ stripeSubscriptionId: subscriptionId }] : []),
      ],
    },
    select: { workspaceId: true },
  });
  return profile?.workspaceId ?? null;
}

async function applyStripeEvent(event: StripeEvent) {
  const object = event.data?.object;
  if (!object) return;
  const workspaceId = await resolveWorkspaceIdFromStripeObject(object);
  if (!workspaceId) return;

  if (event.type === "checkout.session.completed") {
    const subscriptionId = stringField(object.subscription);
    const subscription = subscriptionId ? await getStripeSubscription(subscriptionId) : null;
    await prisma.$transaction(async (tx) => {
      await activatePaygAi(tx, workspaceId, {
        stripeCustomerId: stringField(object.customer),
        stripeSubscriptionId: subscriptionId,
        stripeSubscriptionItemId: subscription ? subscriptionItemIdFromObject(subscription) : null,
        stripePriceId: env.STRIPE_PRICE_AI_USAGE_ID,
        billingEmail: stringField(object.customer_email),
        currentPeriodStart: subscription ? numberDate(subscription.current_period_start) : null,
        currentPeriodEnd: subscription ? numberDate(subscription.current_period_end) : null,
      });
    });
    return;
  }

  if (event.type === "customer.subscription.updated" || event.type === "customer.subscription.deleted") {
    const status = event.type === "customer.subscription.deleted" ? "CANCELED" : stripeStatus(stringField(object.status));
    await prisma.$transaction(async (tx) => {
      if (status === "ACTIVE") {
        await activatePaygAi(tx, workspaceId, {
          stripeCustomerId: stringField(object.customer),
          stripeSubscriptionId: stringField(object.id),
          stripeSubscriptionItemId: subscriptionItemIdFromObject(object),
          stripePriceId: env.STRIPE_PRICE_AI_USAGE_ID,
          currentPeriodStart: numberDate(object.current_period_start),
          currentPeriodEnd: numberDate(object.current_period_end),
        });
      } else if (status === "PAST_DUE" || status === "PAYMENT_REQUIRED" || status === "CANCELED") {
        await pauseAiForBilling(tx, workspaceId, status);
      }
    });
    return;
  }

  if (event.type === "invoice.payment_failed") {
    await prisma.$transaction(async (tx) => {
      await pauseAiForBilling(tx, workspaceId, "PAST_DUE");
    });
    return;
  }

  if (event.type === "invoice.payment_succeeded") {
    const subscriptionId = stringField(object.subscription);
    const subscription = subscriptionId ? await getStripeSubscription(subscriptionId) : null;
    await prisma.$transaction(async (tx) => {
      await activatePaygAi(tx, workspaceId, {
        stripeCustomerId: stringField(object.customer),
        stripeSubscriptionId: subscriptionId,
        stripeSubscriptionItemId: subscription ? subscriptionItemIdFromObject(subscription) : null,
        stripePriceId: env.STRIPE_PRICE_AI_USAGE_ID,
        currentPeriodStart: subscription ? numberDate(subscription.current_period_start) : null,
        currentPeriodEnd: subscription ? numberDate(subscription.current_period_end) : null,
      });
      await tx.aiUsageLedgerEntry.updateMany({
        where: {
          workspaceId,
          status: "REPORTED",
          stripeInvoiceId: null,
        },
        data: {
          status: "INVOICED",
          stripeInvoiceId: stringField(object.id),
        },
      });
    });
    return;
  }

  if (event.type === "payment_method.detached") {
    await prisma.workspaceBillingProfile.updateMany({
      where: { workspaceId },
      data: { paymentMethodReady: false },
    });
  }
}

export async function handleStripeWebhook(rawBody: string, signatureHeader: string | null | undefined) {
  verifyStripeWebhookSignature(rawBody, signatureHeader);
  const event = JSON.parse(rawBody) as StripeEvent;
  invariant(event.id && event.type, 400, "STRIPE_EVENT_INVALID", "Invalid Stripe event payload.");

  const stored = await prisma.stripeWebhookEvent.upsert({
    where: { id: event.id },
    create: {
      id: event.id,
      type: event.type,
      payload: event as unknown as Prisma.InputJsonObject,
    },
    update: {},
  });
  if (stored.processedAt) {
    return { processed: false, id: event.id };
  }

  try {
    await applyStripeEvent(event);
    await prisma.stripeWebhookEvent.update({
      where: { id: event.id },
      data: {
        processedAt: new Date(),
        error: null,
      },
    });
  } catch (error) {
    await prisma.stripeWebhookEvent.update({
      where: { id: event.id },
      data: {
        error: error instanceof Error ? error.message : "Unknown Stripe webhook error.",
      },
    });
    throw error;
  }

  return { processed: true, id: event.id };
}

export async function reportPendingAiUsageToStripe(params: { limit?: number } = {}) {
  const limit = Math.min(Math.max(params.limit ?? 100, 1), 500);
  const baseQuery = {
    where: {
      workspace: {
        billingProfile: {
          is: {
            billingStatus: "ACTIVE",
            stripeSubscriptionItemId: { not: null },
          },
        },
      },
    },
    orderBy: { createdAt: "asc" },
    include: {
      workspace: {
        select: {
          billingProfile: {
            select: {
              stripeSubscriptionItemId: true,
            },
          },
        },
      },
    },
  } satisfies Omit<Prisma.AiUsageLedgerEntryFindManyArgs, "where" | "take"> & {
    where: Omit<Prisma.AiUsageLedgerEntryWhereInput, "status">;
  };
  const pendingEntries = await prisma.aiUsageLedgerEntry.findMany({
    ...baseQuery,
    where: { ...baseQuery.where, status: "PENDING" },
    take: limit,
  });
  const failedRetryLimit = limit - pendingEntries.length;
  const failedEntries = failedRetryLimit > 0
    ? await prisma.aiUsageLedgerEntry.findMany({
      ...baseQuery,
      where: { ...baseQuery.where, status: "FAILED" },
      take: failedRetryLimit,
    })
    : [];
  const entries = [...pendingEntries, ...failedEntries];

  let reported = 0;
  for (const entry of entries) {
    const subscriptionItemId = entry.workspace.billingProfile?.stripeSubscriptionItemId;
    if (!subscriptionItemId) continue;
    const quantityCents = Math.ceil(Number(entry.billableCostUsd) * 100);
    if (quantityCents <= 0) {
      await prisma.aiUsageLedgerEntry.update({
        where: { id: entry.id },
        data: { status: "REPORTED", stripeReportedAt: new Date() },
      });
      reported++;
      continue;
    }
    try {
      const usageRecord = await stripeRequest(`/subscription_items/${encodeURIComponent(subscriptionItemId)}/usage_records`, new URLSearchParams({
        quantity: String(quantityCents),
        timestamp: String(Math.floor(entry.createdAt.getTime() / 1000)),
        action: "increment",
      }));
      await prisma.aiUsageLedgerEntry.update({
        where: { id: entry.id },
        data: {
          status: "REPORTED",
          stripeUsageRecordId: stringField(usageRecord.id),
          stripeReportedAt: new Date(),
          lastReportError: null,
        },
      });
      reported++;
    } catch (error) {
      await prisma.aiUsageLedgerEntry.update({
        where: { id: entry.id },
        data: {
          status: "FAILED",
          lastReportError: error instanceof Error ? error.message : "Unknown Stripe usage report error.",
        },
      });
    }
  }

  return {
    scanned: entries.length,
    reported,
  };
}
