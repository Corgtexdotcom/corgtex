#!/usr/bin/env node

import { spawnSync } from "node:child_process";
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

  if (!dryRun && createIssues && incidents.length > 0) {
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

  if (incidents.length > 0) {
    process.exitCode = 1;
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
});
