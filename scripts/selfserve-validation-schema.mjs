import { execFileSync } from "node:child_process";
import { mkdir, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { databaseIdentity, migrationManifest, preparedSchemaEngine, verifyLedger } from "./accepted-core-baseline.mjs";
import { fullReleaseSha, requireValidation, SELFSERVE_VALIDATION_TARGET } from "./lib/selfserve-validation-target.mjs";

export function schemaAuditConnection(env) {
  requireValidation(!env.DATABASE_URL && !env.PRODUCTION_DATABASE_URL, "SCHEMA_WRITER_ENV_FORBIDDEN");
  requireValidation(Boolean(env.SELFSERVE_SCHEMA_AUDITOR_URL), "DEDICATED_READ_ONLY_SCHEMA_AUDITOR_REQUIRED");
  const url = new URL(env.SELFSERVE_SCHEMA_AUDITOR_URL);
  requireValidation(new Set(url.searchParams.keys()).size === [...url.searchParams.keys()].length, "SCHEMA_DUPLICATE_CONNECTION_OPTION");
  requireValidation(/^[a-f0-9]{64}$/.test(env.SELFSERVE_DATABASE_IDENTITY_SHA256 || "")
    && databaseIdentity(url.href) === env.SELFSERVE_DATABASE_IDENTITY_SHA256, "SCHEMA_DATABASE_IDENTITY_MISMATCH");
  requireValidation(url.searchParams.get("sslmode") === "verify-full", "SCHEMA_VERIFIED_TLS_REQUIRED");
  url.searchParams.set("options", "-c default_transaction_read_only=on -c statement_timeout=5000 -c lock_timeout=1000");
  return url;
}

export function schemaAuditPrismaConnection(url) {
  const prismaUrl = new URL(url.href);
  // Prisma's TLS controls differ from libpq/node-postgres. Require TLS and
  // certificate validation explicitly instead of relying on URL defaults.
  prismaUrl.searchParams.set("sslmode", "require");
  prismaUrl.searchParams.set("sslaccept", "strict");
  if (prismaUrl.searchParams.has("sslrootcert")) {
    prismaUrl.searchParams.set("sslcert", prismaUrl.searchParams.get("sslrootcert"));
    prismaUrl.searchParams.delete("sslrootcert");
  }
  return prismaUrl;
}

// Check effective and SET ROLE-reachable privileges, not just the connection's
// read-only setting. An application writer with read_only=on is not an auditor.
export const AUDITOR_PRIVILEGES_SQL = `
SELECT EXISTS (
  SELECT 1 FROM pg_roles r WHERE pg_has_role(current_user, r.oid, 'MEMBER') AND (
    r.rolsuper OR r.rolcreatedb OR r.rolcreaterole OR r.rolbypassrls
    OR EXISTS (SELECT 1 FROM pg_database d WHERE d.datname = current_database()
      AND (d.datdba = r.oid OR has_database_privilege(r.oid, d.oid, 'CREATE')))
    OR EXISTS (SELECT 1 FROM pg_namespace n WHERE n.nspname NOT LIKE 'pg_%' AND n.nspname <> 'information_schema'
      AND (n.nspowner = r.oid OR has_schema_privilege(r.oid, n.oid, 'CREATE')))
    OR EXISTS (SELECT 1 FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
      WHERE n.nspname = 'public' AND c.relkind IN ('r','p','v','m','f')
      AND (c.relowner = r.oid OR has_table_privilege(r.oid, c.oid, 'INSERT,UPDATE,DELETE,TRUNCATE,TRIGGER')))
  )
) AS can_write`;

export async function verifySelfserveSchema(env = process.env) {
  const expectedSha = fullReleaseSha(env.SELFSERVE_VALIDATION_EXPECTED_SHA);
  const source = resolve(env.SELFSERVE_VALIDATION_SOURCE_DIR || ".accepted-source");
  const git = (...args) => execFileSync("git", args, { cwd: source, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
  requireValidation(git("rev-parse", "HEAD") === expectedSha && !git("status", "--porcelain", "--untracked-files=no"), "SCHEMA_SOURCE_MISMATCH");
  const url = schemaAuditConnection(env);
  const manifest = migrationManifest(source);
  const engine = await preparedSchemaEngine(source);
  const { default: pg } = await import("pg");
  const client = new pg.Client({ connectionString: url.href, connectionTimeoutMillis: 10000 });
  try {
    await client.connect();
    await client.query("BEGIN READ ONLY");
    const settings = await client.query("SELECT current_database() AS database, current_schema() AS schema, current_setting('default_transaction_read_only') AS default_read_only, current_setting('transaction_read_only') AS read_only");
    requireValidation(settings.rows[0]?.database === decodeURIComponent(url.pathname.slice(1)) && settings.rows[0]?.schema === "public"
      && settings.rows[0]?.default_read_only === "on" && settings.rows[0]?.read_only === "on", "SCHEMA_READ_ONLY_CONTEXT_MISMATCH");
    const privileges = await client.query(AUDITOR_PRIVILEGES_SQL);
    requireValidation(privileges.rows[0]?.can_write === false, "SCHEMA_AUDITOR_HAS_WRITE_PRIVILEGES");
    const rows = await client.query("SELECT migration_name, checksum, finished_at, rolled_back_at FROM public._prisma_migrations ORDER BY migration_name LIMIT 10001");
    requireValidation(verifyLedger(manifest, rows.rows, expectedSha).exactLedgerMatch === true, "SCHEMA_LEDGER_NOT_EXACT");
  } finally {
    await client.query("ROLLBACK").catch(() => {});
    await client.end();
  }
  execFileSync(join(source, "node_modules/.bin/prisma"), ["migrate", "diff", "--from-schema-datasource", "prisma/schema.prisma",
    "--to-schema-datamodel", "prisma/schema.prisma", "--exit-code"], { cwd: source, timeout: 60000, stdio: "pipe", env: {
    PATH: env.PATH, HOME: env.HOME, DATABASE_URL: schemaAuditPrismaConnection(url).href, PRISMA_SCHEMA_ENGINE_BINARY: engine,
    CHECKPOINT_DISABLE: "1", PRISMA_HIDE_UPDATE_MESSAGE: "1", PRISMA_ENGINES_MIRROR: "http://127.0.0.1:9",
  } });
  return { schemaVersion: 1, lane: "selfserve-schema-read-only", target: SELFSERVE_VALIDATION_TARGET.name,
    gitSha: expectedSha, runId: env.GITHUB_RUN_ID, runAttempt: env.GITHUB_RUN_ATTEMPT,
    scope: "live-read-only", status: "passed", cleanup: "completed", manifestSha256: manifest.manifestSha256,
    datamodelSha256: manifest.datamodelSha256, exactLedgerMatch: true, supportedSchemaMatch: true };
}

if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url) {
  try {
    const receipt = await verifySelfserveSchema();
    const out = process.env.SELFSERVE_VALIDATION_OUT_DIR || ".artifacts/selfserve-validation";
    await mkdir(out, { recursive: true });
    await writeFile(join(out, "schema.receipt.json"), `${JSON.stringify(receipt, null, 2)}\n`);
  } catch {
    console.error("Selfserve schema audit failed: dedicated read-only role, verified TLS, pinned database/source and exact ledger/schema are required.");
    process.exitCode = 1;
  }
}
