#!/usr/bin/env node

import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import {
  buildControlPlaneIncidents,
  buildHealthTargets,
  checkHealthTarget,
  fetchControlPlaneCustomers,
  parseArgs,
} from "./ops-core.mjs";

const args = parseArgs(process.argv.slice(2));
const dryRun = Boolean(args["dry-run"]);
const createIssues = Boolean(args["create-issues"] || process.env.OPS_CREATE_GITHUB_ISSUES === "true");

async function main() {
  const targets = buildHealthTargets(process.env);
  const results = dryRun
    ? targets.map((target) => ({
      ok: true,
      status: "dry-run",
      target,
      elapsedMs: 0,
      httpStatus: null,
      attempts: 0,
    }))
    : await Promise.all(targets.map((target) => checkHealthTarget(target)));

  const controlPlaneCustomers = dryRun ? [] : await fetchControlPlaneCustomers(process.env);
  const controlPlaneIncidents = buildControlPlaneIncidents(controlPlaneCustomers);
  const syncDedupePrefixes = resolvedSyncDedupePrefixes(targets, controlPlaneCustomers);
  const incidents = [
    ...results.filter((result) => result.incident).map((result) => result.incident),
    ...controlPlaneIncidents,
  ];
  const output = {
    dryRun,
    checkedAt: new Date().toISOString(),
    targets: targets.map((target) => ({
      name: target.name,
      service: target.service,
      clientSlug: target.clientSlug,
      url: target.url,
      severity: target.severity,
    })),
    results: results.map((result) => ({
      name: result.target.name,
      ok: result.ok,
      status: result.status,
      elapsedMs: result.elapsedMs,
      httpStatus: result.httpStatus ?? null,
      attempts: result.attempts ?? 1,
    })),
    controlPlane: {
      customers: controlPlaneCustomers.length,
      incidents: controlPlaneIncidents.length,
    },
    incidents,
  };

  console.log(JSON.stringify(output, null, 2));

  if (!dryRun && createIssues) {
    const incidentArgs = [fileURLToPath(new URL("./github-incident.mjs", import.meta.url))];
    if (syncDedupePrefixes.length > 0) {
      incidentArgs.push("--sync-resolved", "--sync-dedupe-prefixes", JSON.stringify(syncDedupePrefixes));
    }
    const issueResult = spawnSync(
      process.execPath,
      incidentArgs,
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

  // A detected outage is a successful monitor run once its incident is published.
  // Railway cron treats a nonzero exit as Deployment.crashed, obscuring real alerts.
  if (incidents.length > 0 && !createIssues) process.exitCode = 1;
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
});

function resolvedSyncDedupePrefixes(targets, controlPlaneCustomers) {
  const prefixes = targets.map((target) => normalizeDedupePrefix(`${target.name}:${target.url}:`));
  // A configured but empty control-plane response does not prove that any
  // previously reported deployment has recovered.
  prefixes.push(...controlPlaneCustomers
    .filter((customer) => optionalText(customer?.id))
    .map((customer) => normalizeDedupePrefix(`control-plane:${customer.id}:`)));
  return prefixes;
}

function normalizeDedupePrefix(value) {
  return String(value).trim().replace(/\s+/g, " ").slice(0, 200).toLowerCase();
}

function optionalText(value) {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}
