#!/usr/bin/env node

import { spawnSync } from "node:child_process";
import { parseArgs } from "./ops-core.mjs";

const args = parseArgs(process.argv.slice(2));
const dryRun = Boolean(args["dry-run"]);

const smokeSuites = {
  site: {
    command: [process.execPath, ["scripts/site-smoke.mjs", process.env.OPS_SITE_URL || process.env.NEXT_PUBLIC_SITE_URL || "http://localhost:3008", process.env.OPS_APP_URL || process.env.NEXT_PUBLIC_APP_URL || process.env.APP_URL || "http://localhost:3000"]],
  },
  app: {
    command: [process.execPath, ["scripts/railway-smoke.mjs", process.env.OPS_APP_URL || process.env.NEXT_PUBLIC_APP_URL || process.env.APP_URL || "", process.env.OPS_SMOKE_EMAIL || process.env.ADMIN_EMAIL || "", process.env.OPS_SMOKE_PASSWORD || process.env.ADMIN_PASSWORD || ""]],
  },
  client: {
    command: [process.execPath, ["scripts/ops/customer-readiness-sweep.mjs"]],
  },
};

function main() {
  const requested = args._.length > 0 ? args._ : ["site", "app", "client"];
  const plan = requested.map((name) => {
    const suite = smokeSuites[name];
    if (!suite) throw new Error(`Unknown smoke suite: ${name}`);
    const [bin, suiteArgs] = suite.command;
    return { name, command: [bin, ...suiteArgs] };
  });

  if (dryRun) {
    console.log(JSON.stringify({ dryRun: true, plan }, null, 2));
    return;
  }

  for (const suite of plan) {
    const [bin, ...suiteArgs] = suite.command;
    const result = spawnSync(bin, suiteArgs, { stdio: "inherit", env: process.env });
    if (result.status !== 0) process.exit(result.status ?? 1);
  }
}

try {
  main();
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
}
