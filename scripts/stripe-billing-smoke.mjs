#!/usr/bin/env node
import { createHmac, randomUUID } from "node:crypto";
import process from "node:process";

function arg(name) {
  const prefix = `--${name}=`;
  return process.argv.find((entry) => entry.startsWith(prefix))?.slice(prefix.length);
}

function pass(message) {
  console.log(`OK   ${message}`);
}

function skip(message) {
  console.log(`SKIP ${message}`);
}

function fail(message) {
  console.error(`FAIL ${message}`);
  process.exit(1);
}

async function stripeGet(path) {
  const response = await fetch(`https://api.stripe.com/v1${path}`, {
    headers: { authorization: `Bearer ${process.env.STRIPE_SECRET_KEY}` },
  });
  const body = await response.json().catch(() => ({}));
  if (!response.ok) {
    fail(`Stripe ${path} failed with ${response.status}: ${body.error?.message ?? "unknown error"}`);
  }
  return body;
}

function stripeSignature(rawBody, secret) {
  const timestamp = Math.floor(Date.now() / 1000);
  const digest = createHmac("sha256", secret).update(`${timestamp}.${rawBody}`).digest("hex");
  return `t=${timestamp},v1=${digest}`;
}

async function postSignedWebhook(baseUrl, event) {
  const secret = process.env.STRIPE_WEBHOOK_SECRET;
  if (!secret) fail("STRIPE_WEBHOOK_SECRET is required for webhook simulation");
  const rawBody = JSON.stringify(event);
  const response = await fetch(new URL("/api/webhooks/stripe", baseUrl), {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "stripe-signature": stripeSignature(rawBody, secret),
    },
    body: rawBody,
  });
  const body = await response.json().catch(() => ({}));
  if (!response.ok) {
    fail(`signed Stripe webhook simulation failed (${response.status}): ${JSON.stringify(body)}`);
  }
  return body;
}

async function main() {
  if (!process.env.STRIPE_SECRET_KEY) fail("STRIPE_SECRET_KEY is required");
  const priceId = arg("price-id") || process.env.STRIPE_PRICE_AI_USAGE_ID;
  if (!priceId) fail("STRIPE_PRICE_AI_USAGE_ID or --price-id is required");

  const price = await stripeGet(`/prices/${encodeURIComponent(priceId)}`);
  if (price.currency !== "usd") fail(`expected USD price, got ${price.currency}`);
  if (price.unit_amount !== 1) fail(`expected 1-cent unit amount, got ${price.unit_amount}`);
  if (price.recurring?.interval !== "month") fail(`expected monthly recurring price, got ${price.recurring?.interval}`);
  if (price.recurring?.usage_type !== "metered") fail(`expected metered usage_type, got ${price.recurring?.usage_type}`);
  if (price.recurring?.aggregate_usage && price.recurring.aggregate_usage !== "sum") {
    fail(`expected aggregate_usage=sum, got ${price.recurring.aggregate_usage}`);
  }
  pass("Stripe AI usage price is monthly metered USD at 1 cent per reported unit");

  const baseUrl = arg("base-url") || process.env.STRIPE_BILLING_SMOKE_BASE_URL;
  const workspaceId = arg("workspace-id") || process.env.STRIPE_BILLING_SMOKE_WORKSPACE_ID;
  if (!baseUrl || !workspaceId) {
    skip("signed webhook simulation requires --base-url and --workspace-id");
    return;
  }
  if (process.env.STRIPE_BILLING_SMOKE_ALLOW_WEBHOOK_MUTATION !== "1") {
    skip("set STRIPE_BILLING_SMOKE_ALLOW_WEBHOOK_MUTATION=1 to simulate billing webhooks against the target app");
    return;
  }

  const suffix = randomUUID().slice(0, 8);
  await postSignedWebhook(baseUrl, {
    id: `evt_smoke_active_${suffix}`,
    type: "customer.subscription.updated",
    data: {
      object: {
        id: `sub_smoke_${suffix}`,
        customer: `cus_smoke_${suffix}`,
        status: "active",
        metadata: { workspaceId },
        items: { data: [{ id: `si_smoke_${suffix}` }] },
      },
    },
  });
  pass("signed active subscription webhook accepted");

  await postSignedWebhook(baseUrl, {
    id: `evt_smoke_failed_${suffix}`,
    type: "invoice.payment_failed",
    data: {
      object: {
        id: `in_smoke_failed_${suffix}`,
        customer: `cus_smoke_${suffix}`,
        subscription: `sub_smoke_${suffix}`,
        metadata: { workspaceId },
      },
    },
  });
  pass("signed failed-payment webhook accepted");

  await postSignedWebhook(baseUrl, {
    id: `evt_smoke_recovered_${suffix}`,
    type: "customer.subscription.updated",
    data: {
      object: {
        id: `sub_smoke_${suffix}`,
        customer: `cus_smoke_${suffix}`,
        status: "active",
        metadata: { workspaceId },
        items: { data: [{ id: `si_smoke_${suffix}` }] },
      },
    },
  });
  pass("signed billing recovery webhook accepted");

  await postSignedWebhook(baseUrl, {
    id: `evt_smoke_detached_${suffix}`,
    type: "payment_method.detached",
    data: {
      object: {
        id: `pm_smoke_${suffix}`,
        metadata: { workspaceId },
      },
    },
  });
  pass("signed payment-method detach webhook accepted");
}

main().catch((error) => {
  fail(error instanceof Error ? error.message : String(error));
});
