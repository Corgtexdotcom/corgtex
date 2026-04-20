import { execSync } from "child_process";

const INTEGRATION_DB_URL =
  process.env.DATABASE_URL ??
  "postgresql://postgres:postgres@localhost:5433/corgtex_test?schema=public";

export async function setup() {
  console.log("Setting up test database...");
  process.env.DATABASE_URL = INTEGRATION_DB_URL;

  // Wait to ensure db is ready if spun up right before this
  // In CI or test:integration, the --wait flag on docker-compose handles this,
  // but it's safe to run deploy here.
  execSync("npx prisma migrate deploy", {
    stdio: "inherit",
    env: {
      ...process.env,
      DATABASE_URL: INTEGRATION_DB_URL,
    },
  });
  console.log("Test database migrations applied.");
}

export async function teardown() {
  // We do not drop the database on teardown. We rely on beforeEach
  // truncations to keep tests isolated. This makes subsequent test runs
  // much faster.
  console.log("Test database teardown complete.");
}
