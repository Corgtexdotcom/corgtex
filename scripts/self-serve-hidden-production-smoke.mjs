#!/usr/bin/env node
import process from "node:process";
import { createHmac, randomUUID } from "node:crypto";
import { resetProcurementTrialRateLimits } from "./lib/self-serve-smoke-utils.mjs";

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

function envFlag(name) {
  return process.env[name] === "1";
}

function jsonRpcId() {
  return randomUUID().slice(0, 12);
}

function setupTokenFromUrl(value) {
  if (!value) return null;
  try {
    const url = new URL(value);
    const parts = url.pathname.split("/").filter(Boolean);
    const index = parts.indexOf("setup-account");
    return index >= 0 && parts[index + 1] ? decodeURIComponent(parts[index + 1]) : null;
  } catch {
    const match = value.match(/setup-account\/([^/?#]+)/);
    return match ? decodeURIComponent(match[1]) : null;
  }
}

function cookieHeader(response) {
  const headers = response.headers;
  const values = typeof headers.getSetCookie === "function"
    ? headers.getSetCookie()
    : [headers.get("set-cookie")].filter(Boolean);
  return values.map((value) => String(value).split(";")[0]).join("; ");
}

async function readJson(response) {
  const text = await response.text();
  try {
    return text ? JSON.parse(text) : {};
  } catch {
    return { raw: text };
  }
}

async function postJson(url, body, headers = {}) {
  const response = await fetch(url, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      ...headers,
    },
    body: JSON.stringify(body),
  });
  return { response, body: await readJson(response) };
}

async function getJson(url, headers = {}) {
  const response = await fetch(url, { headers });
  return { response, body: await readJson(response) };
}

async function authedJson(baseUrl, cookie, method, path, body) {
  const response = await fetch(new URL(path, baseUrl), {
    method,
    headers: {
      "content-type": "application/json",
      cookie,
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return { response, body: await readJson(response) };
}

async function mcpJson(mcpUrl, token, method, params = {}) {
  const response = await fetch(mcpUrl, {
    method: "POST",
    headers: {
      authorization: `Bearer ${token}`,
      "content-type": "application/json",
      accept: "application/json, text/event-stream",
    },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: jsonRpcId(),
      method,
      params,
    }),
  });
  return { response, body: await readJson(response) };
}

async function claimAndLogin(baseUrl, setupToken, adminEmail, password) {
  const reset = await postJson(`${baseUrl}/api/auth/reset-password`, {
    token: setupToken,
    password,
  });
  if (!reset.response.ok) {
    fail(`setup-account token claim failed (${reset.response.status}): ${JSON.stringify(reset.body)}`);
  }
  pass("claimed setup-account token through reset-password API");

  const login = await postJson(`${baseUrl}/api/auth/login`, {
    email: adminEmail,
    password,
  });
  if (!login.response.ok) {
    fail(`admin login failed (${login.response.status}): ${JSON.stringify(login.body)}`);
  }
  const cookie = cookieHeader(login.response);
  if (!cookie) {
    fail("login response did not set a session cookie");
  }
  pass("logged in as trial admin");
  return { cookie, user: login.body.user, workspaces: login.body.workspaces ?? [] };
}

async function maybePrisma() {
  if (!envFlag("SELF_SERVE_SMOKE_ALLOW_DB_MUTATION")) {
    return null;
  }
  if (!process.env.DATABASE_URL) {
    fail("SELF_SERVE_SMOKE_ALLOW_DB_MUTATION=1 requires DATABASE_URL");
  }
  const { PrismaClient } = await import("@prisma/client");
  return new PrismaClient();
}

async function monthlyUsageUsd(prisma, workspaceId) {
  const start = new Date();
  start.setUTCDate(1);
  start.setUTCHours(0, 0, 0, 0);
  const rows = await prisma.modelUsage.findMany({
    where: { workspaceId, createdAt: { gte: start } },
    select: { estimatedCostUsd: true, billableCostUsd: true },
  });
  return rows.reduce((sum, row) => sum + Number(row.billableCostUsd ?? row.estimatedCostUsd ?? 0), 0);
}

async function expectMcpBudgetBlock(mcpUrl, connectorToken) {
  const blocked = await mcpJson(mcpUrl, connectorToken, "tools/call", {
    name: "chat",
    arguments: { message: "Budget cap smoke check. Reply with one short sentence." },
  });
  const text = JSON.stringify(blocked.body);
  if (!/BUDGET|budget|AI usage is paused/i.test(text)) {
    fail(`AI budget cap check did not block model use: ${text}`);
  }
  pass("AI budget cap blocks additional model use");
}

function stripeSignature(rawBody, secret) {
  const timestamp = Math.floor(Date.now() / 1000);
  const digest = createHmac("sha256", secret).update(`${timestamp}.${rawBody}`).digest("hex");
  return `t=${timestamp},v1=${digest}`;
}

async function postSignedStripeWebhook(baseUrl, event) {
  const secret = process.env.STRIPE_WEBHOOK_SECRET;
  if (!secret) fail("STRIPE_WEBHOOK_SECRET is required for signed billing webhook smoke");
  const rawBody = JSON.stringify(event);
  const response = await fetch(new URL("/api/webhooks/stripe", baseUrl), {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "stripe-signature": stripeSignature(rawBody, secret),
    },
    body: rawBody,
  });
  const body = await readJson(response);
  if (!response.ok) {
    fail(`signed Stripe webhook failed (${response.status}): ${JSON.stringify(body)}`);
  }
  return body;
}

function assertTrialLimits(body) {
  const limits = body.limits ?? {};
  if (
    limits.trialDays !== 30 ||
    limits.modelMonthlyBudgetCents !== 500 ||
    limits.storageLimitMb !== 100 ||
    limits.memberLimit !== 5 ||
    limits.mcpDailyCallLimit !== 100
  ) {
    fail(`trial limits do not match launch defaults: ${JSON.stringify(limits)}`);
  }
  pass("trial response uses launch default limits");
}

async function main() {
  const baseUrl = (arg("base-url") || process.env.SELF_SERVE_SMOKE_BASE_URL || process.env.APP_URL || "").replace(/\/$/, "");
  if (!baseUrl) fail("usage: node scripts/self-serve-hidden-production-smoke.mjs --base-url=https://app.example");
  if (process.env.SELF_SERVE_SMOKE_ALLOW_MUTATION !== "1") {
    fail("refusing to create a production trial unless SELF_SERVE_SMOKE_ALLOW_MUTATION=1 is set");
  }

  const runId = arg("run-id") || new Date().toISOString().replace(/[^0-9]/g, "").slice(0, 14);
  const emailDomain = arg("email-domain") || process.env.SELF_SERVE_SMOKE_EMAIL_DOMAIN || `corgtex-smoke-${runId}.example.com`;
  const adminEmail = arg("admin-email") || process.env.SELF_SERVE_SMOKE_ADMIN_EMAIL || `admin+${runId}@${emailDomain}`;
  const companyName = arg("company") || `Corgtex Hidden Smoke ${runId}`;
  const idempotencyKey = arg("idempotency-key") || `hidden-prod-smoke-${runId}-${randomUUID()}`;
  const smokeSecret = process.env.SMOKE_EMAIL_CAPTURE_SECRET?.trim();

  if (smokeSecret) {
    await resetProcurementTrialRateLimits({
      baseUrl,
      secret: smokeSecret,
      adminEmail,
      companyName,
    });
    pass("reset trial-create rate limits for hidden smoke identity");
  } else {
    skip("SMOKE_EMAIL_CAPTURE_SECRET missing; trial-create rate limits were not reset before hidden smoke");
  }

  const trial = await postJson(`${baseUrl}/api/procurement/v1/trials`, {
    companyName,
    adminEmail,
    adminName: "Hidden Production Smoke",
    acceptedTermsVersion: "hidden-production-smoke-v1",
    sourceAgent: {
      kind: "hidden-production-smoke",
      runId,
    },
  }, {
    "Idempotency-Key": idempotencyKey,
  });

  if (trial.response.status !== 201) {
    fail(`trial create expected HTTP 201 active trial, got ${trial.response.status}: ${JSON.stringify(trial.body)}`);
  }
  pass("created hidden-production trial through public procurement API");
  assertTrialLimits(trial.body);

  if (!trial.body.workspace?.id || !trial.body.workspace?.url) {
    fail(`trial response did not include workspace: ${JSON.stringify(trial.body.workspace)}`);
  }
  pass("trial response includes workspace entrypoint");

  if (!trial.body.connector?.token || !trial.body.connector?.mcpConnectorUrl) {
    fail("trial response did not include active MCP connector token and URL");
  }
  pass("trial response includes active MCP connector details");

  const statusResponse = await fetch(`${baseUrl}/api/procurement/v1/trials/${trial.body.trialId}`);
  const statusBody = await readJson(statusResponse);
  if (!statusResponse.ok || statusBody.status !== "ACTIVE") {
    fail(`trial status endpoint did not report active trial: ${JSON.stringify(statusBody)}`);
  }
  pass("trial status endpoint reports active trial");

  if (trial.body.claimEmailStatus && typeof trial.body.claimEmailStatus === "object") {
    pass("trial response records setup-account claim email status");
  } else {
    fail("trial response did not record setup-account claim email status");
  }

  const mcpUrl = trial.body.connector.mcpConnectorUrl;
  const connectorToken = trial.body.connector.token;
  const mcpTools = await mcpJson(mcpUrl, connectorToken, "tools/list");
  if (!mcpTools.response.ok || !Array.isArray(mcpTools.body.result?.tools)) {
    fail(`MCP connector did not list tools: ${JSON.stringify(mcpTools.body)}`);
  }
  pass("MCP connector token can list tools");

  const setupUrl = arg("setup-url") || process.env.SELF_SERVE_SMOKE_SETUP_URL;
  if (setupUrl) {
    const setupResponse = await fetch(setupUrl);
    if (!setupResponse.ok) {
      fail(`setup-account URL did not load (${setupResponse.status})`);
    }
    pass("operator-supplied setup-account URL loads");
  } else {
    skip("setup-account form claim requires the emailed setup URL; rerun with SELF_SERVE_SMOKE_SETUP_URL after receiving the email");
  }

  const setupToken = arg("setup-token") || process.env.SELF_SERVE_SMOKE_SETUP_TOKEN || setupTokenFromUrl(setupUrl);
  const password = arg("password") || process.env.SELF_SERVE_SMOKE_PASSWORD || `Corgtex-smoke-${randomUUID().slice(0, 12)}!`;
  let cookie = null;
  if (setupToken) {
    const login = await claimAndLogin(baseUrl, setupToken, adminEmail, password);
    cookie = login.cookie;
    if (!login.workspaces.some((workspace) => workspace.id === trial.body.workspace.id)) {
      fail("logged-in admin workspace list does not include the trial workspace");
    }
    pass("trial admin session can see the trial workspace");

    const colleagueEmail = arg("colleague-email") || process.env.SELF_SERVE_SMOKE_COLLEAGUE_EMAIL || `colleague+${runId}@${emailDomain}`;
    const invited = await authedJson(baseUrl, cookie, "POST", `/api/workspaces/${trial.body.workspace.id}/members`, {
      email: colleagueEmail,
      displayName: "Hidden Production Colleague",
      role: "CONTRIBUTOR",
    });
    if (invited.response.status !== 201) {
      fail(`member invite/create failed (${invited.response.status}): ${JSON.stringify(invited.body)}`);
    }
    pass("trial admin can invite a colleague");

    const recorder = await getJson(`${baseUrl}/api/workspaces/${trial.body.workspace.id}/meeting-recorders/config`, { cookie });
    if (!recorder.response.ok || recorder.body.featureEnabled !== false) {
      fail(`meeting recorder was not unavailable for self-serve trial: ${JSON.stringify(recorder.body)}`);
    }
    pass("meeting recorder remains unavailable for self-serve trial");
  } else if (envFlag("SELF_SERVE_SMOKE_REQUIRE_SETUP")) {
    fail("SELF_SERVE_SMOKE_REQUIRE_SETUP=1 requires SELF_SERVE_SMOKE_SETUP_TOKEN or SELF_SERVE_SMOKE_SETUP_URL");
  } else {
    skip("admin claim, login, colleague invite, and recorder UI proof require SELF_SERVE_SMOKE_SETUP_TOKEN or SELF_SERVE_SMOKE_SETUP_URL");
  }

  const prisma = await maybePrisma();
  try {
    if (envFlag("SELF_SERVE_SMOKE_ALLOW_AI_SPEND")) {
      const ai = await mcpJson(mcpUrl, connectorToken, "tools/call", {
        name: "chat",
        arguments: { message: "Hidden production smoke. Reply with exactly: Corgtex trial AI is active." },
      });
      if (!ai.response.ok || ai.body.error) {
        fail(`MCP chat AI spend failed: ${JSON.stringify(ai.body)}`);
      }
      pass("MCP connector can consume trial AI credit");
    } else {
      skip("set SELF_SERVE_SMOKE_ALLOW_AI_SPEND=1 to consume trial AI credit");
    }

    if (prisma) {
      if (envFlag("SELF_SERVE_SMOKE_ALLOW_AI_SPEND")) {
        const usedUsd = await monthlyUsageUsd(prisma, trial.body.workspace.id);
        const capUsd = usedUsd > 0 ? Math.max(0.000001, usedUsd / 2) : 0;
        await prisma.modelUsageBudget.upsert({
          where: { workspaceId: trial.body.workspace.id },
          create: { workspaceId: trial.body.workspace.id, monthlyCostCapUsd: capUsd },
          update: { monthlyCostCapUsd: capUsd },
        });
        await expectMcpBudgetBlock(mcpUrl, connectorToken);
      } else {
        await prisma.modelUsageBudget.upsert({
          where: { workspaceId: trial.body.workspace.id },
          create: { workspaceId: trial.body.workspace.id, monthlyCostCapUsd: 0 },
          update: { monthlyCostCapUsd: 0 },
        });
        await expectMcpBudgetBlock(mcpUrl, connectorToken);
      }
      await prisma.modelUsageBudget.upsert({
        where: { workspaceId: trial.body.workspace.id },
        create: { workspaceId: trial.body.workspace.id, monthlyCostCapUsd: 5 },
        update: { monthlyCostCapUsd: 5 },
      });

      const past = new Date(Date.now() - 60_000);
      await prisma.$transaction([
        prisma.procurementTrial.update({
          where: { id: trial.body.trialId },
          data: { trialExpiresAt: past },
        }),
        prisma.workspace.update({
          where: { id: trial.body.workspace.id },
          data: { trialEndsAt: past },
        }),
      ]);
      const expiredMcp = await mcpJson(mcpUrl, connectorToken, "tools/list");
      const expiredText = JSON.stringify(expiredMcp.body);
      if (expiredMcp.response.status !== 403 || !/TRIAL_EXPIRED/.test(expiredText)) {
        fail(`expired trial did not reject MCP access: ${expiredText}`);
      }
      const downgraded = await prisma.workspace.findUnique({
        where: { id: trial.body.workspace.id },
        select: {
          plan: true,
          modelUsageBudget: { select: { monthlyCostCapUsd: true } },
          procurementTrials: { select: { status: true }, take: 1 },
        },
      });
      if (downgraded?.plan !== "CORE_FREE" || Number(downgraded.modelUsageBudget?.monthlyCostCapUsd ?? -1) !== 0) {
        fail(`trial expiry did not downgrade to CORE_FREE with zero AI budget: ${JSON.stringify(downgraded)}`);
      }
      pass("trial expiry downgrades workspace to CORE_FREE and pauses Corgtex-paid AI");

      if (envFlag("SELF_SERVE_SMOKE_ALLOW_BILLING_WEBHOOK")) {
        const suffix = randomUUID().slice(0, 8);
        await postSignedStripeWebhook(baseUrl, {
          id: `evt_hidden_smoke_active_${suffix}`,
          type: "customer.subscription.updated",
          data: {
            object: {
              id: `sub_hidden_smoke_${suffix}`,
              customer: `cus_hidden_smoke_${suffix}`,
              status: "active",
              metadata: { workspaceId: trial.body.workspace.id },
              items: { data: [{ id: `si_hidden_smoke_${suffix}` }] },
            },
          },
        });
        const paid = await prisma.workspace.findUnique({
          where: { id: trial.body.workspace.id },
          select: { plan: true, modelUsageBudget: { select: { monthlyCostCapUsd: true } } },
        });
        if (paid?.plan !== "PAYG_AI" || Number(paid.modelUsageBudget?.monthlyCostCapUsd ?? 0) !== -1) {
          fail(`billing webhook did not resume PAYG AI: ${JSON.stringify(paid)}`);
        }
        pass("signed billing webhook resumes PAYG AI after trial expiry");
      } else {
        skip("set SELF_SERVE_SMOKE_ALLOW_BILLING_WEBHOOK=1 to simulate paid billing recovery");
      }
    } else {
      skip("budget-cap and forced-expiry proof require DATABASE_URL plus SELF_SERVE_SMOKE_ALLOW_DB_MUTATION=1");
    }

    if (cookie && envFlag("SELF_SERVE_SMOKE_ALLOW_CHECKOUT_SESSION")) {
      const checkout = await authedJson(baseUrl, cookie, "POST", "/api/billing/checkout", {
        workspaceId: trial.body.workspace.id,
      });
      if (!checkout.response.ok || !checkout.body.url) {
        fail(`billing checkout session failed (${checkout.response.status}): ${JSON.stringify(checkout.body)}`);
      }
      pass("billing checkout session can be created for the trial workspace");
    } else if (envFlag("SELF_SERVE_SMOKE_REQUIRE_BILLING")) {
      fail("SELF_SERVE_SMOKE_REQUIRE_BILLING=1 requires admin session and SELF_SERVE_SMOKE_ALLOW_CHECKOUT_SESSION=1");
    } else {
      skip("set SELF_SERVE_SMOKE_ALLOW_CHECKOUT_SESSION=1 with a claimed admin session to create a Stripe checkout session");
    }
  } finally {
    if (prisma) {
      await prisma.$disconnect();
    }
  }

  console.log(JSON.stringify({
    runId,
    trialId: trial.body.trialId,
    workspaceId: trial.body.workspace.id,
    workspaceUrl: trial.body.workspace.url,
    statusUrl: trial.body.statusUrl,
  }, null, 2));
}

main().catch((error) => {
  fail(error instanceof Error ? error.message : String(error));
});
