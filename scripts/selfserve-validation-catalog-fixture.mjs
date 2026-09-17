import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { readFile, readdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { preparedSchemaEngine, verifyLedger } from "./accepted-core-baseline.mjs";
import { requireValidation } from "./lib/selfserve-validation-target.mjs";
import { collectSchemaCatalog, expectedCatalogArtifact, catalogBinding } from "./lib/selfserve-schema-catalog.mjs";

export async function createFixtureCatalog(env = process.env) {
  requireValidation(env.SELFSERVE_ISOLATED_FIXTURE === "true" && !env.SELFSERVE_SCHEMA_AUDITOR_URL
    && !env.PRODUCTION_DATABASE_URL, "CATALOG_FIXTURE_ONLY");
  const url = new URL(env.DATABASE_URL);
  requireValidation(url.hostname === "fixture-pg" && url.pathname === "/selfserve_validation_synthetic", "CATALOG_FIXTURE_ONLY");
  const input = JSON.parse(await readFile("/proof/catalog-source.json", "utf8"));
  const binding = { expectedSha: env.SELFSERVE_VALIDATION_EXPECTED_SHA, manifest: input.manifest,
    runId: env.GITHUB_RUN_ID, runAttempt: env.GITHUB_RUN_ATTEMPT };
  catalogBinding(binding);
  const build = JSON.parse(await readFile("/app/release-build.json", "utf8"));
  requireValidation(build.schemaVersion === 1 && build.role === "web" && build.gitSha === binding.expectedSha, "CATALOG_FIXTURE_SOURCE_MISMATCH");
  const hash = async path => createHash("sha256").update(await readFile(path)).digest("hex");
  requireValidation(await hash("/app/prisma/schema.prisma") === binding.manifest.datamodelSha256, "CATALOG_FIXTURE_SOURCE_MISMATCH");
  const migrationNames = (await readdir("/app/prisma/migrations", { withFileTypes: true })).filter(entry => entry.isDirectory()).map(entry => entry.name).sort();
  requireValidation(JSON.stringify(migrationNames) === JSON.stringify(input.manifest.migrations.map(item => item.name)), "CATALOG_FIXTURE_SOURCE_MISMATCH");
  for (const migration of input.manifest.migrations) {
    requireValidation(/^[a-zA-Z0-9_]+$/.test(migration.name)
      && await hash(join("/app/prisma/migrations", migration.name, "migration.sql")) === migration.checksum, "CATALOG_FIXTURE_SOURCE_MISMATCH");
  }
  // Prove the migration-replayed reference matches the accepted Prisma model,
  // using only its disposable fixture administrator, never the live auditor.
  const engine = await preparedSchemaEngine("/app");
  execFileSync("/app/node_modules/.bin/prisma", ["migrate", "diff", "--from-schema-datasource", "prisma/schema.prisma",
    "--to-schema-datamodel", "prisma/schema.prisma", "--exit-code"], { cwd: "/app", stdio: "pipe", timeout: 60000,
    env: { PATH: env.PATH, HOME: env.HOME, DATABASE_URL: url.href, PRISMA_SCHEMA_ENGINE_BINARY: engine,
      PRISMA_ENGINES_MIRROR: "http://127.0.0.1:9", CHECKPOINT_DISABLE: "1", PRISMA_HIDE_UPDATE_MESSAGE: "1" } });
  const { default: pg } = await import("pg");
  const client = new pg.Client({ connectionString: url.href, connectionTimeoutMillis: 5000 });
  try {
    await client.connect();
    await client.query("BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY");
    await client.query("SET LOCAL statement_timeout = '5s'");
    const ledger = await client.query("SELECT migration_name,checksum,finished_at,rolled_back_at FROM public._prisma_migrations ORDER BY migration_name LIMIT 10001");
    requireValidation(verifyLedger(input.manifest, ledger.rows, binding.expectedSha).exactLedgerMatch, "CATALOG_FIXTURE_LEDGER_MISMATCH");
    const catalog = await collectSchemaCatalog(client);
    const artifact = expectedCatalogArtifact(catalog, binding);
    await writeFile("/proof/expected-catalog.json", `${JSON.stringify(artifact)}\n`);
  } finally {
    await client.query("ROLLBACK").catch(() => {});
    await client.end();
  }
}

if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url) {
  try { await createFixtureCatalog(); }
  catch (error) {
    const codes = new Set(["CATALOG_FIXTURE_ONLY", "CATALOG_BINDING_INVALID", "CATALOG_FIXTURE_SOURCE_MISMATCH",
      "CATALOG_FIXTURE_LEDGER_MISMATCH", "CATALOG_VERSION_UNSUPPORTED", "CATALOG_OBJECT_UNSUPPORTED", "CATALOG_EXTENSION_UNSUPPORTED",
      "CATALOG_SHAPE_INVALID", "CATALOG_SNAPSHOT_REQUIRED", "CORE_BASELINE_PRISMA_ENGINE_NOT_PREPARED",
      "CORE_BASELINE_LEDGER_NOT_EXACT", "CORE_BASELINE_LEDGER_UNBOUNDED"]);
    const code = codes.has(error.message) ? error.message : ["ENOENT", "42501", "42703"].includes(error.code) ? error.code : "UNCLASSIFIED";
    console.error(JSON.stringify({ status: "failed", stage: "catalog-fixture", code })); process.exitCode = 1;
  }
}
