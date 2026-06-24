import { existsSync } from "fs";
import { execFileSync } from "child_process";
import path from "path";
import { fileURLToPath, pathToFileURL } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const rootDir = path.resolve(__dirname, "..");
const prismaBin = path.join(rootDir, "node_modules", ".bin", "prisma");
const nextBin = path.join(rootDir, "node_modules", "next", "dist", "bin", "next");
const STARTUP_MODES = new Set(["combined", "migrate-and-seed", "web"]);

function run(command, args, options = {}) {
  execFileSync(command, args, {
    stdio: "inherit",
    cwd: options.cwd ?? rootDir,
    env: process.env,
  });
}

export function flagEnabled(name, env = process.env) {
  const value = env[name]?.trim().toLowerCase();
  return value === "1" || value === "true" || value === "yes" || value === "on";
}

export function configuredSeedScripts(env = process.env) {
  const seedScripts = env.SEED_SCRIPTS
    ? env.SEED_SCRIPTS.split(",").map((script) => script.trim()).filter(Boolean)
    : [];

  if (flagEnabled("CORGTEX_AUTO_SEED_JNJ_DEMO", env)) {
    seedScripts.push("scripts/seed-jnj-demo.mjs");
  }

  const uniqueScripts = new Map();
  for (const script of seedScripts) {
    const resolved = path.resolve(rootDir, script);
    if (!uniqueScripts.has(resolved)) {
      uniqueScripts.set(resolved, script);
    }
  }

  return [...uniqueScripts.values()];
}

export function resolveStartupMode(env = process.env) {
  const mode = env.CORGTEX_STARTUP_MODE?.trim() || "web";
  if (!STARTUP_MODES.has(mode)) {
    throw new Error(`Unsupported CORGTEX_STARTUP_MODE "${mode}". Expected one of: ${[...STARTUP_MODES].join(", ")}.`);
  }
  return mode;
}

export function startupPlanForMode(mode) {
  if (mode === "combined") {
    return {
      runMigrations: true,
      runSeeds: true,
      verifyMigrations: true,
      startWeb: true,
    };
  }
  if (mode === "migrate-and-seed") {
    return {
      runMigrations: true,
      runSeeds: true,
      verifyMigrations: true,
      startWeb: false,
    };
  }
  return {
    runMigrations: false,
    runSeeds: false,
    verifyMigrations: true,
    startWeb: true,
  };
}

export async function verifyMigrations() {
  console.log("[start-web] Step 2.5: Verifying DB Migrations before Next.js");
  try {
    const { PrismaClient } = await import("@prisma/client");
    const prisma = new PrismaClient();
    const failedMigrationsRaw = await prisma.$queryRaw`
      SELECT migration_name FROM _prisma_migrations
      WHERE finished_at IS NULL AND rolled_back_at IS NULL
    `;
    console.log("[start-web] Migrations requiring attention:", failedMigrationsRaw);
    await prisma.$disconnect();
  } catch (e) {
    console.log("[start-web] Failed DB check:", e.message);
  }
}

function runMigrations() {
  console.log("[start-web] Step 1: Database Migrations");
  run(prismaBin, ["migrate", "deploy"]);
}

function runSeeds() {
  console.log("[start-web] Step 2: Running Production Bootstrap Seed");
  run(process.execPath, [path.join(rootDir, "prisma", "seed.mjs")]);

  const seedScripts = configuredSeedScripts();

  for (const script of seedScripts) {
    const resolved = path.resolve(rootDir, script);
    if (!existsSync(resolved)) {
      console.warn(`[start-web] Seed script not found, skipping: ${script}`);
      continue;
    }
    console.log(`[start-web] Running explicit extra seed: ${script}`);
    run(process.execPath, [resolved]);
  }
}

function startWeb() {
  const port = process.env.PORT || "3000";
  console.log(`[start-web] Step 3: Starting Next.js Web Server on 0.0.0.0:${port}...`);
  run(process.execPath, [nextBin, "start", "-H", "0.0.0.0", "-p", port], { cwd: path.join(rootDir, "apps", "web") });
}

export async function main() {
  console.log("[start-web] === Production Startup Sequence ===");
  const mode = resolveStartupMode();
  const plan = startupPlanForMode(mode);
  console.log(`[start-web] Startup mode: ${mode}`);
  if (plan.startWeb && flagEnabled("CORGTEX_AUTO_SEED_JNJ_DEMO")) {
    console.warn("[start-web] CORGTEX_AUTO_SEED_JNJ_DEMO is ignored for web startup. Run an explicit seed job instead.");
  }
  if (plan.startWeb && process.env.SEED_SCRIPTS?.trim()) {
    console.warn("[start-web] SEED_SCRIPTS is ignored for web startup. Run CORGTEX_STARTUP_MODE=migrate-and-seed instead.");
  }

  if (plan.runMigrations) {
    runMigrations();
  } else {
    console.log("[start-web] Step 1: Skipping database migrations for web-only startup mode.");
  }

  if (plan.runSeeds) {
    runSeeds();
  } else {
    console.log("[start-web] Step 2: Skipping seeds for web-only startup mode.");
  }

  if (plan.verifyMigrations) {
    await verifyMigrations();
  }

  if (!plan.startWeb) {
    console.log("[start-web] Startup mode completed without starting Next.js.");
    return;
  }

  startWeb();
}

const invokedScriptUrl = process.argv[1] ? pathToFileURL(process.argv[1]).href : null;

if (import.meta.url === invokedScriptUrl) {
  try {
    await main();
  } catch (error) {
    console.error("[start-web] Startup sequence failed:", error.message);
    process.exit(1);
  }
}
