import { existsSync } from "fs";
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
  console.log("[start-web] Step 2: Running Production Bootstrap Seed");
  run(process.execPath, [path.join(rootDir, "prisma", "seed.mjs")]);

  const seedScripts = process.env.SEED_SCRIPTS
    ? process.env.SEED_SCRIPTS.split(",").map((script) => script.trim()).filter(Boolean)
    : [];

  for (const script of seedScripts) {
    const resolved = path.resolve(rootDir, script);
    if (!existsSync(resolved)) {
      console.warn(`[start-web] Seed script not found, skipping: ${script}`);
      continue;
    }
    console.log(`[start-web] Running explicit extra seed: ${script}`);
    run(process.execPath, [resolved]);
  }

  // 2.5. DB Health Check Audit
  console.log("[start-web] Step 2.5: Verifying DB Migrations before Next.js");
  try {
    const { PrismaClient } = await import("@prisma/client");
    const prisma = new PrismaClient();
    const failedMigrationsRaw = await prisma.$queryRaw`
      SELECT migration_name FROM _prisma_migrations 
      WHERE rolled_back_at IS NOT NULL OR (finished_at IS NULL AND applied_steps_count = 0)
    `;
    console.log("[start-web] Migrations requiring attention:", failedMigrationsRaw);
    await prisma.$disconnect();
  } catch (e) {
    console.log("[start-web] Failed DB check:", e.message);
  }

  // 3. Web Server
  const port = process.env.PORT || "3000";
  console.log(`[start-web] Step 3: Starting Next.js Web Server on 0.0.0.0:${port}...`);
  run(process.execPath, [nextBin, "start", "-H", "0.0.0.0", "-p", port], { cwd: path.join(rootDir, "apps", "web") });
} catch (error) {
  console.error("[start-web] Startup sequence failed:", error.message);
  process.exit(1);
}
