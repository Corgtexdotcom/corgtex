#!/usr/bin/env node

import { execFileSync } from "node:child_process";
import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const rootDir = path.resolve(__dirname, "..");
const prismaBin = path.join(rootDir, "node_modules", ".bin", "prisma");
const tsxBin = path.join(rootDir, "node_modules", "tsx", "dist", "cli.mjs");
const REQUIRED_CANONICAL_WORKSPACE_SEEDS = new Set([
  "prisma/seed.mjs",
  "scripts/lib/client-stable-seed.mjs",
  "scripts/seed-corgtex.mjs",
  "scripts/seed-jnj-demo.mjs",
]);

export function selectRuntimeSeedPaths(relativePaths) {
  return [...new Set(relativePaths.filter((relativePath) => {
    if (relativePath === "prisma/seed.mjs") return true;
    if (!relativePath.startsWith("scripts/")) return false;
    if (!/[.](?:mjs|ts)$/.test(relativePath)) return false;
    return !/[.](?:test|spec)[.](?:mjs|ts)$/.test(relativePath);
  }))].sort();
}

export function discoverProductionSeedPaths(root = rootDir) {
  const candidates = ["prisma/seed.mjs"];
  const visit = (directory) => {
    const entries = readdirSync(directory, { withFileTypes: true })
      .sort((left, right) => left.name.localeCompare(right.name));
    for (const entry of entries) {
      const absolutePath = path.join(directory, entry.name);
      if (entry.isDirectory()) {
        visit(absolutePath);
        continue;
      }
      candidates.push(path.relative(root, absolutePath).split(path.sep).join("/"));
    }
  };
  visit(path.join(root, "scripts"));
  return selectRuntimeSeedPaths(candidates);
}

export function assertCanonicalWorkspaceSeedSources(seedSources) {
  for (const { relativePath, source } of seedSources) {
    if (/\b[A-Za-z_$][\w$]*\.workspace\.(?:create|upsert)\s*\(/.test(source)) {
      throw new Error(`${relativePath} contains a direct workspace create/upsert outside the canonical domain helper.`);
    }
    if (REQUIRED_CANONICAL_WORKSPACE_SEEDS.has(relativePath) && !source.includes("ensureCanonicalWorkspace")) {
      throw new Error(`${relativePath} must reconcile workspaces through ensureCanonicalWorkspace.`);
    }
  }
}

export function assertCanonicalWorkspaceSeeds(root = rootDir) {
  const relativePaths = discoverProductionSeedPaths(root);
  assertCanonicalWorkspaceSeedSources(relativePaths.map((relativePath) => ({
    relativePath,
    source: readFileSync(path.join(root, relativePath), "utf8"),
  })));
  return relativePaths;
}

function run(command, args, options = {}) {
  console.log(`[seed-fixtures] ${[command, ...args].join(" ")}`);
  execFileSync(command, args, {
    cwd: rootDir,
    env: options.env ?? process.env,
    stdio: "inherit",
  });
}

function main() {
  assertCanonicalWorkspaceSeeds();

  for (const name of ["DATABASE_URL", "ADMIN_EMAIL", "ADMIN_PASSWORD"]) {
    if (!process.env[name]?.trim()) throw new Error(`${name} is required for seed fixture validation.`);
  }

  console.log("[seed-fixtures] Applying migrations to disposable fixture database.");
  run(prismaBin, ["migrate", "deploy"]);

  console.log("[seed-fixtures] Running base production seed.");
  run(process.execPath, [tsxBin, path.join(rootDir, "prisma", "seed.mjs")], {
    env: {
      ...process.env,
      ADMIN_EMAIL: "seed-fixture-admin@corgtex.local",
    },
  });

  console.log("[seed-fixtures] Running J&J demo seed against current schema.");
  run(process.execPath, [tsxBin, path.join(rootDir, "scripts", "seed-jnj-demo.mjs")]);

  console.log("OK seed fixture validation passed.");
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    main();
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  }
}
