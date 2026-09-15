import { spawnSync } from "node:child_process";
import { expect, it } from "vitest";

it.each([undefined, "another-database.example"])("refuses an unconfirmed database host %s before connecting", (host) => {
  const env = { ...process.env, DATABASE_URL: "postgresql://unused:unused@127.0.0.1:1/unused" };
  delete env.QA_EXPECTED_DATABASE_HOST;
  if (host) env.QA_EXPECTED_DATABASE_HOST = host;
  const result = spawnSync(process.execPath, ["scripts/provision-qa-workspaces.mjs", "--apply"], { env, encoding: "utf8" });
  expect(result.status).toBe(1);
  expect(result.stderr).toContain("QA_EXPECTED_DATABASE_HOST must match");
});

it.each([
  { database: "other", schema: "public" },
  { database: "unused", schema: "private" },
])("rejects an incorrect database or schema on the confirmed host: %j", ({ database, schema }) => {
  const env = { ...process.env, DATABASE_URL: "postgresql://unused:unused@127.0.0.1:1/unused", QA_EXPECTED_DATABASE_HOST: "127.0.0.1", QA_EXPECTED_DATABASE_NAME: database, QA_EXPECTED_DATABASE_SCHEMA: schema };
  const result = spawnSync(process.execPath, ["scripts/provision-qa-workspaces.mjs", "--apply"], { env, encoding: "utf8" });
  expect(result.status).toBe(1);
  expect(result.stderr).toContain("Confirm QA_EXPECTED_DATABASE_NAME");
});
