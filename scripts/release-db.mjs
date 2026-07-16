#!/usr/bin/env node

process.env.CORGTEX_STARTUP_MODE = "migrate-and-seed";
process.env.CORGTEX_AUTO_SEED_JNJ_DEMO = "false";
process.env.SEED_SCRIPTS = "scripts/seed-internal-validation-workspace.mjs";

const { main } = await import("./start-web.mjs");

try {
  await main();
} catch (error) {
  console.error("[release-db] Database release failed:", error instanceof Error ? error.message : String(error));
  process.exit(1);
}
