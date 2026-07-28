#!/usr/bin/env node

import { spawnSync } from "node:child_process";
import { pathToFileURL } from "node:url";

import {
  normalizeReleaseInput,
  normalizeTargets,
  parseBoolean,
  parseKeyValueArgs,
  parsePositiveInteger,
} from "./release/fleet-release-core.mjs";

export function buildWorkflowInputs(argv = process.argv.slice(2)) {
  const args = parseKeyValueArgs(argv);
  const release = normalizeReleaseInput(args.release ?? "latest-stable");
  const targets = normalizeTargets(args.targets).join(",");
  const reason = args.reason ?? "";
  if (!reason.trim()) {
    throw new Error("Usage: npm run release:fleet -- --reason \"...\" [--release latest-stable|<full-sha>] [--targets default|all|railway-customers|azure-managed-customers|azure-selfserve|ops|backup-app] [--dry-run] [--concurrency 2]");
  }
  return {
    release,
    targets,
    reason,
    dryRun: parseBoolean(args.dryRun, false),
    concurrency: parsePositiveInteger(args.concurrency, 2),
    forceAfterFailure: parseBoolean(args.forceAfterFailure, false),
    watch: !parseBoolean(args.noWatch, false),
    ref: args.ref ?? "main",
  };
}

export function workflowForInputs(inputs) {
  return inputs.dryRun ? "fleet-release-preflight.yml" : "fleet-release.yml";
}

export function runFleetReleaseDispatch(argv = process.argv.slice(2), deps = {}) {
  const inputs = buildWorkflowInputs(argv);
  const run = deps.runCommand ?? runCommand;
  const workflow = workflowForInputs(inputs);
  const dispatchArgs = [
    "workflow",
    "run",
    workflow,
    "--ref",
    inputs.ref,
    "-f",
    `release=${inputs.release}`,
    "-f",
    `targets=${inputs.targets}`,
    "-f",
    `reason=${inputs.reason}`,
    "-f",
    `concurrency=${inputs.concurrency}`,
  ];
  if (!inputs.dryRun) {
    dispatchArgs.push(
      "-f",
      `dry_run=${inputs.dryRun}`,
      "-f",
      `force_after_failure=${inputs.forceAfterFailure}`,
    );
  }

  run("gh", dispatchArgs);
  console.log(JSON.stringify({ dispatched: true, workflow, inputs }, null, 2));
  if (!inputs.watch) return inputs;

  const list = run("gh", [
    "run",
    "list",
    "--workflow",
    workflow,
    "--limit",
    "1",
    "--json",
    "databaseId,url,status,conclusion,createdAt",
  ]);
  const latest = JSON.parse(list.stdout || "[]")[0];
  if (!latest?.databaseId) {
    throw new Error("Workflow was dispatched but the run ID could not be found.");
  }
  console.log(JSON.stringify({ watching: latest.databaseId, url: latest.url }, null, 2));
  run("gh", ["run", "watch", String(latest.databaseId), "--exit-status"], { stdio: "inherit" });
  return inputs;
}

function runCommand(command, args, options = {}) {
  const result = spawnSync(command, args, {
    encoding: "utf8",
    stdio: options.stdio ?? ["ignore", "pipe", "pipe"],
  });
  if (result.status !== 0) {
    throw new Error(result.stderr?.trim() || `${command} ${args.join(" ")} failed.`);
  }
  return { stdout: result.stdout ?? "", stderr: result.stderr ?? "" };
}

if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url) {
  try {
    runFleetReleaseDispatch();
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  }
}
