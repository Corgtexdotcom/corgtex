/**
 * Generic Client Stable Seed Script
 *
 * This script contains NO private client data. All configuration is
 * injected at runtime via the CLIENT_SEED_CONFIG_JSON environment variable.
 *
 * Usage:
 *   CLIENT_SEED_CONFIG_JSON='{ ... }' node scripts/seed-client-stable.mjs
 *
 * The JSON must conform to the config shape expected by seedStableClient()
 * from scripts/lib/client-stable-seed.mjs.
 *
 * Required environment variables:
 *   - CLIENT_SEED_CONFIG_JSON  — full workspace config as JSON
 *   - ADMIN_PASSWORD           — bootstrap admin password
 *   - DATABASE_URL             — Prisma connection string
 *
 * Optional environment variables (override JSON values):
 *   - CLIENT_WORKSPACE_SLUG
 *   - CLIENT_WORKSPACE_NAME
 *   - CLIENT_BOOTSTRAP_ADMIN_EMAIL
 *   - CLIENT_USERS_JSON
 *   - CLIENT_PRINT_INVITE_LINKS
 */

import { seedStableClient } from "./lib/client-stable-seed.mjs";

const configJson = process.env.CLIENT_SEED_CONFIG_JSON?.trim();
if (!configJson) {
  console.error(
    "ERROR: CLIENT_SEED_CONFIG_JSON environment variable is required.\n" +
    "This script does not contain any client data — all configuration\n" +
    "must be provided via environment variables.\n" +
    "See scripts/lib/client-stable-seed.mjs for the config schema."
  );
  process.exit(1);
}

let config;
try {
  config = JSON.parse(configJson);
} catch (err) {
  console.error("ERROR: CLIENT_SEED_CONFIG_JSON is not valid JSON:", err.message);
  process.exit(1);
}

if (!config.envPrefix) {
  config.envPrefix = "CLIENT";
}

try {
  await seedStableClient(config);
} catch (err) {
  console.error("Seed failed:", err);
  process.exit(1);
}
