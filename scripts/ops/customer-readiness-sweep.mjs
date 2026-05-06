#!/usr/bin/env node

import { spawnSync } from "node:child_process";
import path from "node:path";
import {
  checkHealthTarget,
  normalizeIncident,
  parseArgs,
} from "./ops-core.mjs";

const args = parseArgs(process.argv.slice(2));
const dryRun = Boolean(args["dry-run"]);
const healthOnly = Boolean(args["health-only"]);
const createIssues = Boolean(args["create-issues"] || process.env.OPS_CREATE_GITHUB_ISSUES === "true");
const outRoot = path.resolve(String(args["out-dir"] || process.env.CLIENT_READINESS_OUT_DIR || ".artifacts/client-readiness"));

function optionalText(value) {
  if (value === null || value === undefined) return null;
  const text = String(value).trim();
  return text.length > 0 ? text : null;
}

function slugSafe(value) {
  return String(value || "customer")
    .toLowerCase()
    .replace(/[^a-z0-9-]+/g, "-")
    .replace(/^-|-$/g, "")
    .slice(0, 60) || "customer";
}

function customerSlug(customer) {
  return slugSafe(customer.customerSlug || customer.slug || customer.label || customer.id);
}

function customerUrl(customer) {
  return optionalText(customer.url) || optionalText(customer.supportBaseUrl);
}

function appendPath(baseUrl, suffix) {
  return `${baseUrl.replace(/\/$/, "")}${suffix}`;
}

function parseJsonEnv(name, fallback) {
  const raw = optionalText(process.env[name]);
  if (!raw) return fallback;
  try {
    return JSON.parse(raw);
  } catch (error) {
    throw new Error(`${name} must be valid JSON: ${error instanceof Error ? error.message : String(error)}`);
  }
}

function selectedSlugSet() {
  const raw = optionalText(args.customers) || optionalText(process.env.CLIENT_READINESS_CUSTOMER_SLUGS);
  if (!raw) return null;
  return new Set(raw.split(",").map((value) => slugSafe(value)).filter(Boolean));
}

function normalizeCustomer(customer) {
  const url = customerUrl(customer);
  if (!url || !/^https?:\/\//i.test(url)) return null;
  const slug = customerSlug(customer);
  return {
    id: optionalText(customer.id),
    label: optionalText(customer.label) || slug,
    slug,
    url: url.replace(/\/$/, ""),
    provisioningStatus: optionalText(customer.provisioningStatus),
    environment: optionalText(customer.environment),
  };
}

function discoverCustomers() {
  const configured = parseJsonEnv("CLIENT_READINESS_CUSTOMERS_JSON", null);
  if (configured) {
    if (!Array.isArray(configured)) {
      throw new Error("CLIENT_READINESS_CUSTOMERS_JSON must be an array.");
    }
    return configured.map(normalizeCustomer).filter(Boolean);
  }

  const result = spawnSync(process.execPath, ["scripts/control-plane.mjs", "list-customers"], {
    cwd: process.cwd(),
    env: process.env,
    encoding: "utf8",
    maxBuffer: 10 * 1024 * 1024,
  });
  if (result.status !== 0) {
    throw new Error(`Control-plane customer discovery failed with exit code ${result.status ?? 1}.`);
  }
  const parsed = JSON.parse(result.stdout);
  if (!Array.isArray(parsed)) {
    throw new Error("Control-plane customer discovery did not return an array.");
  }
  return parsed.map(normalizeCustomer).filter(Boolean);
}

function eligibleCustomers() {
  const only = selectedSlugSet();
  const includeInactive = process.env.CLIENT_READINESS_INCLUDE_INACTIVE === "true";
  return discoverCustomers().filter((customer) => {
    if (only && !only.has(customer.slug)) return false;
    if (includeInactive) return true;
    return !customer.provisioningStatus || customer.provisioningStatus === "active";
  });
}

function healthTarget(customer) {
  return {
    name: `${customer.slug}-health`,
    service: "client",
    clientSlug: customer.slug,
    url: appendPath(customer.url, "/api/health"),
    severity: "P1",
    timeoutMs: 10_000,
    expectedStatuses: [200],
    expectJson: { status: "ok" },
    method: "GET",
  };
}

function smokeCommand(customer) {
  return [
    process.execPath,
    [
      "scripts/client-readiness-smoke.mjs",
      customer.url,
      path.join(outRoot, customer.slug),
    ],
  ];
}

function runSmoke(customer) {
  const [bin, suiteArgs] = smokeCommand(customer);
  const result = spawnSync(bin, suiteArgs, {
    cwd: process.cwd(),
    env: {
      ...process.env,
      CLIENT_READINESS_BASE_URL: customer.url,
      OPS_CLIENT_URL: customer.url,
      OPS_PRIMARY_CLIENT_URL: customer.url,
      OPS_PRIMARY_CLIENT_SLUG: customer.slug,
      CLIENT_READINESS_OUT_DIR: path.join(outRoot, customer.slug),
    },
    encoding: "utf8",
    maxBuffer: 10 * 1024 * 1024,
  });
  return {
    ok: result.status === 0,
    exitCode: result.status ?? 1,
    signal: result.signal,
    stderr: result.stderr,
  };
}

function smokeIncident(customer, result) {
  return normalizeIncident({
    dedupeKey: `client-readiness:${customer.slug}:smoke:${result.exitCode}:${result.signal ?? "none"}`,
    severity: "P2",
    service: "client",
    clientSlug: customer.slug,
    status: "smoke-failed",
    summary: `${customer.slug} client readiness smoke failed`,
    evidence: [
      `URL: ${customer.url}`,
      `Exit code: ${result.exitCode}`,
      result.signal ? `Signal: ${result.signal}` : null,
      `Artifacts: ${path.join(outRoot, customer.slug)}`,
      result.stderr ? `Error: ${result.stderr.split("\n").find(Boolean)?.slice(0, 500)}` : null,
    ].filter(Boolean),
    recommendedAction: "run Codex Builder Loop",
  });
}

async function maybeCreateIssues(incidents) {
  if (dryRun || !createIssues || incidents.length === 0) return;
  const issueResult = spawnSync(
    process.execPath,
    [new URL("./github-incident.mjs", import.meta.url).pathname],
    {
      input: JSON.stringify(incidents),
      encoding: "utf8",
      stdio: ["pipe", "inherit", "inherit"],
    },
  );
  if (issueResult.status !== 0) {
    process.exit(issueResult.status ?? 1);
  }
}

async function main() {
  const customers = eligibleCustomers();
  const plan = customers.map((customer) => {
    const [bin, suiteArgs] = smokeCommand(customer);
    return {
      slug: customer.slug,
      label: customer.label,
      url: customer.url,
      healthUrl: healthTarget(customer).url,
      smokeCommand: healthOnly ? null : [bin, ...suiteArgs],
    };
  });

  if (dryRun) {
    console.log(JSON.stringify({ dryRun: true, checkedAt: new Date().toISOString(), customers: plan }, null, 2));
    return;
  }

  const results = [];
  const incidents = [];
  for (const customer of customers) {
    const health = await checkHealthTarget(healthTarget(customer));
    if (health.incident) incidents.push(health.incident);
    let smoke = null;
    if (health.ok && !healthOnly) {
      smoke = runSmoke(customer);
      if (!smoke.ok) incidents.push(smokeIncident(customer, smoke));
    }
    results.push({
      slug: customer.slug,
      url: customer.url,
      health: {
        ok: health.ok,
        status: health.status,
        httpStatus: health.httpStatus ?? null,
        elapsedMs: health.elapsedMs,
      },
      smoke: smoke ? { ok: smoke.ok, exitCode: smoke.exitCode, signal: smoke.signal } : null,
    });
  }

  console.log(JSON.stringify({
    dryRun: false,
    checkedAt: new Date().toISOString(),
    results,
    incidents,
  }, null, 2));

  await maybeCreateIssues(incidents);
  if (incidents.length > 0) {
    process.exitCode = 1;
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
});
