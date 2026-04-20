import { execFileSync } from "child_process";
import path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const rootDir = path.resolve(__dirname, "..");
const prismaBin = path.join(rootDir, "node_modules", ".bin", "prisma");
const nextBin = path.join(rootDir, "node_modules", "next", "dist", "bin", "next");

function run(command, args, options = {}) {
  execFileSync(command, args, {
    stdio: "inherit",
    cwd: options.cwd ?? rootDir,
    env: process.env,
  });
}

console.log("[start-web] === Production Startup Sequence ===");

try {
  // 1. Prisma Migrations
  console.log("[start-web] Step 1: Database Migrations");



  run(prismaBin, ["migrate", "deploy"]);

  // 2. Seeds
  console.log("[start-web] Step 2: Running Seeds");
  run(process.execPath, [path.join(rootDir, "prisma", "seed.mjs")]);

  // Default: SaaS multi-tenant seeds. Enterprise deploys override via SEED_SCRIPTS env var.
  const defaultSeeds = ["scripts/seed-corgtex.mjs", "scripts/seed-jnj-demo.mjs"];
  const seedScripts = process.env.SEED_SCRIPTS
    ? process.env.SEED_SCRIPTS.split(",").filter(Boolean)
    : defaultSeeds;

  for (const script of seedScripts) {
    console.log(`[start-web] Running seed: ${script}`);
    run(process.execPath, [path.resolve(rootDir, script)]);
  }

  // 2.5. DB Health Check Audit
  console.log("[start-web] Step 2.5: Verifying DB Migrations before Next.js");
  try {
    const { PrismaClient } = await import('@prisma/client');
    const prisma = new PrismaClient();
    const failedMigrationsRaw = await prisma.$queryRaw`
      SELECT migration_name FROM _prisma_migrations 
      WHERE rolled_back_at IS NOT NULL OR (finished_at IS NULL AND applied_steps_count = 0)
    `;
    console.log("[start-web] Migrations requiring attention:", failedMigrationsRaw);
    await prisma.$disconnect();
  } catch(e) {
    console.log("[start-web] Failed DB check:", e.message);
  }

  // 3. Web Server
  console.log("[start-web] Step 3: Starting Next.js Web Server...");
  run(process.execPath, [nextBin, "start"], { cwd: path.join(rootDir, "apps", "web") });
} catch (error) {
  console.error("[start-web] Startup sequence failed:", error.message);
  process.exit(1);
}
