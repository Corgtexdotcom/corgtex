#!/usr/bin/env node

import { execFileSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const rootDir = path.resolve(__dirname, "..");
const prismaBin = path.join(rootDir, "node_modules", ".bin", "prisma");

function run(command, args) {
  console.log(`[seed-fixtures] ${[command, ...args].join(" ")}`);
  execFileSync(command, args, {
    cwd: rootDir,
    env: process.env,
    stdio: "inherit",
  });
}

function main() {
  for (const name of ["DATABASE_URL", "ADMIN_EMAIL", "ADMIN_PASSWORD"]) {
    if (!process.env[name]?.trim()) throw new Error(`${name} is required for seed fixture validation.`);
  }

  console.log("[seed-fixtures] Applying migrations to disposable fixture database.");
  run(prismaBin, ["migrate", "deploy"]);

  console.log("[seed-fixtures] Running base production seed.");
  run(process.execPath, [path.join(rootDir, "prisma", "seed.mjs")]);

  console.log("[seed-fixtures] Running J&J demo seed against current schema.");
  run(process.execPath, [path.join(rootDir, "scripts", "seed-jnj-demo.mjs")]);

  console.log("OK seed fixture validation passed.");
}

try {
  main();
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
}
