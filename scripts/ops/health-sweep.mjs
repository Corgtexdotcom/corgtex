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
const publishControlPlaneOnly = Boolean(args["publish-control-plane-only"]);

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
  const syncDedupePrefixes = resolvedSyncDedupePrefixes(
    publishControlPlaneOnly ? [] : targets,
    controlPlaneCustomers,
  );
  const unhealthyDedupePrefixes = unverifiedReleaseDedupePrefixes(controlPlaneCustomers);
  const incidents = [
    ...results.filter((result) => result.incident).map((result) => result.incident),
    ...controlPlaneIncidents,
  ];
  const publishedIncidents = publishControlPlaneOnly ? controlPlaneIncidents : incidents;
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
    publishedIncidents: publishedIncidents.length,
  };

  console.log(JSON.stringify(output, null, 2));

  if (!dryRun && createIssues) {
    const incidentArgs = [fileURLToPath(new URL("./github-incident.mjs", import.meta.url))];
    if (syncDedupePrefixes.length > 0) {
      incidentArgs.push("--sync-resolved", "--sync-dedupe-prefixes", JSON.stringify(syncDedupePrefixes));
      if (unhealthyDedupePrefixes.length > 0) {
        incidentArgs.push("--unhealthy-dedupe-prefixes", JSON.stringify(unhealthyDedupePrefixes));
      }
    }
    const issueResult = spawnSync(
      process.execPath,
      incidentArgs,
      {
        input: JSON.stringify(publishedIncidents),
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
  for (const customer of controlPlaneCustomers) {
    if (!optionalText(customer?.id)) continue;
    prefixes.push(normalizeDedupePrefix(`control-plane:${customer.id}:`));
    // Drift recovery is independent of unrelated control-plane findings.
    prefixes.push(normalizeDedupePrefix(`control-plane:${customer.id}:releaseMetadataDrift`));
  }
  return prefixes;
}

function unverifiedReleaseDedupePrefixes(controlPlaneCustomers) {
  return controlPlaneCustomers
    .filter((customer) => optionalText(customer?.id) && !verifiedReleaseRecovery(customer))
    .map((customer) => normalizeDedupePrefix(`control-plane:${customer.id}:releaseMetadataDrift`));
}

function verifiedReleaseRecovery(customer) {
  // A different error or an ok response without release metadata can replace
  // drift without proving the live release matches the recorded baseline.
  if (customer?.deploymentKind === "SHARED_WORKSPACE" || customer?.managedWorkspaceId
    || customer?.lastHealthStatus !== "ok" || optionalText(customer?.lastHealthError)) return false;
  const baseline = optionalText(customer?.releaseImageTag);
  const healthAt = Date.parse(customer?.lastHealthCheck ?? "");
  const releaseAt = Date.parse(customer?.lastReleaseCheck ?? "");
  if (!baseline || !Number.isFinite(healthAt) || !Number.isFinite(releaseAt)) return false;
  const snapshot = (Array.isArray(customer?.fleetSnapshots) ? customer.fleetSnapshots : [])
    .filter((item) => item?.snapshotKind === "HEALTH")
    .sort((a, b) => Date.parse(b.observedAt ?? b.createdAt ?? 0) - Date.parse(a.observedAt ?? a.createdAt ?? 0))[0];
  const snapshotAt = Date.parse(snapshot?.observedAt ?? snapshot?.createdAt ?? "");
  const observed = snapshot?.summary?.health?.release;
  const imageTag = optionalText(observed?.imageTag);
  const gitSha = optionalText(observed?.gitSha);
  return snapshot?.status === "ok" && !optionalText(snapshot?.error)
    && Number.isFinite(snapshotAt) && snapshotAt >= healthAt
    && (baseline === imageTag || (gitSha && (baseline === gitSha || baseline === `sha-${gitSha}`)));
}

function normalizeDedupePrefix(value) {
  return String(value).trim().replace(/\s+/g, " ").slice(0, 200).toLowerCase();
}

function optionalText(value) {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}
