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
    OR EXISTS (SELECT 1 FROM pg_namespace n WHERE left(n.nspname, 3) <> 'pg_' AND n.nspname <> 'information_schema'
      AND (n.nspowner = r.oid OR has_schema_privilege(r.oid, n.oid, 'CREATE')))
    OR EXISTS (SELECT 1 FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
      WHERE left(n.nspname, 3) <> 'pg_' AND n.nspname <> 'information_schema' AND c.relkind IN ('r','p','v','m','f')
      AND (c.relowner = r.oid OR has_table_privilege(r.oid, c.oid, 'INSERT,UPDATE,DELETE,TRUNCATE,TRIGGER')
        OR has_any_column_privilege(r.oid, c.oid, 'INSERT,UPDATE')))
    OR EXISTS (SELECT 1 FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
      WHERE left(n.nspname, 3) <> 'pg_' AND n.nspname <> 'information_schema' AND c.relkind = 'S'
      AND (c.relowner = r.oid OR has_sequence_privilege(r.oid, c.oid, 'USAGE,UPDATE')))
  )
) AS can_write`;

const stages = new Set(["source", "configuration", "prepared-engine", "connection-tls", "read-only-context",
  "privilege", "ledger", "introspection", "cleanup", "receipt"]);
const knownCodes = new Set(["SCHEMA_SOURCE_MISMATCH", "VALIDATION_SHA_REQUIRED", "SCHEMA_WRITER_ENV_FORBIDDEN",
  "DEDICATED_READ_ONLY_SCHEMA_AUDITOR_REQUIRED", "SCHEMA_DUPLICATE_CONNECTION_OPTION",
  "SCHEMA_DATABASE_IDENTITY_MISMATCH", "SCHEMA_VERIFIED_TLS_REQUIRED", "DATABASE_URL_INVALID",
  "DATABASE_SCHEMA_UNSUPPORTED", "PRISMA_ENGINE_NOT_PREPARED", "SCHEMA_READ_ONLY_CONTEXT_MISMATCH",
  "SOURCE_MIGRATIONS_INVALID", "SCHEMA_AUDITOR_HAS_WRITE_PRIVILEGES", "SCHEMA_LEDGER_NOT_EXACT", "LEDGER_NOT_EXACT", "LEDGER_UNBOUNDED"]);
const connectionCodes = new Set(["ECONNREFUSED", "ETIMEDOUT", "ENOTFOUND", "EAI_AGAIN", "ECONNRESET",
  "CERT_HAS_EXPIRED", "CERT_NOT_YET_VALID", "DEPTH_ZERO_SELF_SIGNED_CERT", "SELF_SIGNED_CERT_IN_CHAIN",
  "UNABLE_TO_VERIFY_LEAF_SIGNATURE", "UNABLE_TO_GET_ISSUER_CERT_LOCALLY", "ERR_TLS_CERT_ALTNAME_INVALID",
  "28P01", "28000", "42501", "3D000", "53300", "57014", "57P01"]);

// Never serialize an exception, SQL, child output, path, URL, or connection option.
// Only exact allowlisted codes cross the diagnostic boundary.
export function classifySchemaFailure(stage, error) {
  const safeStage = stages.has(stage) ? stage : "unknown";
  let code = "UNCLASSIFIED_FAILURE";
  if (knownCodes.has(error?.message)) code = error.message;
  else if (connectionCodes.has(error?.code)) code = error.code;
  else if (["ENOENT", "EACCES"].includes(error?.code)) code = error.code;
  else if (safeStage === "introspection") {
    if (error?.status === 2) code = "SCHEMA_DIFF_DETECTED";
    else if (error?.code === "ETIMEDOUT" || error?.signal) code = "ENGINE_INTERRUPTED";
    else {
      // Prisma CLI's Error: Pnnnn header is inspected privately; no stderr text is emitted.
      const header = String(error?.stderr || "").replace(/\u001b\[[0-9;]*m/g, "")
        .match(/^Error: (P1000|P1001|P1002|P1003|P1010|P1011|P1012|P1017|P4001|P4002)\b/m)?.[1];
      code = header || "ENGINE_FAILURE";
    }
  }
  return { schemaVersion: 1, status: "failed", stage: safeStage, code };
}

class SchemaAuditFailure extends Error {
  constructor(stage, error) {
    const diagnostic = classifySchemaFailure(stage, error);
    super(`Schema audit failed: ${diagnostic.stage}/${diagnostic.code}`);
    this.diagnostic = diagnostic;
  }
}

async function atStage(stage, operation) {
  try { return await operation(); }
  catch (error) { throw new SchemaAuditFailure(stage, error); }
}

export async function reportSchemaFailure(error, directory) {
  const diagnostic = error instanceof SchemaAuditFailure ? error.diagnostic : classifySchemaFailure("unknown", error);
  console.error(JSON.stringify(diagnostic));
  try {
    await mkdir(directory, { recursive: true });
    // Deliberately not *.receipt.json: a diagnostic is never acceptance evidence.
    await writeFile(join(directory, "schema.failure.json"), `${JSON.stringify(diagnostic, null, 2)}\n`);
  } catch {
    console.error(JSON.stringify({ schemaVersion: 1, status: "failed", stage: "receipt", code: "DIAGNOSTIC_WRITE_FAILED" }));
  }
}

export async function verifySelfserveSchema(env = process.env) {
  const expectedSha = await atStage("source", () => fullReleaseSha(env.SELFSERVE_VALIDATION_EXPECTED_SHA));
  const source = resolve(env.SELFSERVE_VALIDATION_SOURCE_DIR || ".accepted-source");
  const git = (...args) => execFileSync("git", args, { cwd: source, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
  await atStage("source", () => requireValidation(git("rev-parse", "HEAD") === expectedSha && !git("status", "--porcelain", "--untracked-files=no"), "SCHEMA_SOURCE_MISMATCH"));
  const url = await atStage("configuration", () => schemaAuditConnection(env));
  const manifest = await atStage("source", () => migrationManifest(source));
  const engine = await atStage("prepared-engine", () => preparedSchemaEngine(source));
  const client = await atStage("connection-tls", async () => {
    const { default: pg } = await import("pg");
    return new pg.Client({ connectionString: url.href, connectionTimeoutMillis: 10000 });
  });
  let failure;
  try {
    await atStage("connection-tls", () => client.connect());
    await atStage("read-only-context", async () => {
      await client.query("BEGIN READ ONLY");
      const settings = await client.query("SELECT current_database() AS database, current_schema() AS schema, current_setting('default_transaction_read_only') AS default_read_only, current_setting('transaction_read_only') AS read_only");
      requireValidation(settings.rows[0]?.database === decodeURIComponent(url.pathname.slice(1)) && settings.rows[0]?.schema === "public"
        && settings.rows[0]?.default_read_only === "on" && settings.rows[0]?.read_only === "on", "SCHEMA_READ_ONLY_CONTEXT_MISMATCH");
    });
    await atStage("privilege", async () => {
      const privileges = await client.query(AUDITOR_PRIVILEGES_SQL);
      requireValidation(privileges.rows[0]?.can_write === false, "SCHEMA_AUDITOR_HAS_WRITE_PRIVILEGES");
    });
    await atStage("ledger", async () => {
      const rows = await client.query("SELECT migration_name, checksum, finished_at, rolled_back_at FROM public._prisma_migrations ORDER BY migration_name LIMIT 10001");
      requireValidation(verifyLedger(manifest, rows.rows, expectedSha).exactLedgerMatch === true, "SCHEMA_LEDGER_NOT_EXACT");
    });
  } catch (error) {
    failure = error;
  } finally {
    await client.query("ROLLBACK").catch(() => {});
    try { await atStage("cleanup", () => client.end()); }
    catch (error) { failure ||= error; }
  }
  if (failure) throw failure;
  await atStage("introspection", () => execFileSync(join(source, "node_modules/.bin/prisma"), ["migrate", "diff", "--from-schema-datasource", "prisma/schema.prisma",
    "--to-schema-datamodel", "prisma/schema.prisma", "--exit-code"], { cwd: source, timeout: 60000, stdio: "pipe", env: {
    PATH: env.PATH, HOME: env.HOME, DATABASE_URL: schemaAuditPrismaConnection(url).href, PRISMA_SCHEMA_ENGINE_BINARY: engine,
    CHECKPOINT_DISABLE: "1", PRISMA_HIDE_UPDATE_MESSAGE: "1", PRISMA_ENGINES_MIRROR: "http://127.0.0.1:9",
  } }));
  return { schemaVersion: 1, lane: "selfserve-schema-read-only", target: SELFSERVE_VALIDATION_TARGET.name,
    gitSha: expectedSha, runId: env.GITHUB_RUN_ID, runAttempt: env.GITHUB_RUN_ATTEMPT,
    scope: "live-read-only", status: "passed", cleanup: "completed", manifestSha256: manifest.manifestSha256,
    datamodelSha256: manifest.datamodelSha256, exactLedgerMatch: true, supportedSchemaMatch: true };
}

if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url) {
  try {
    const receipt = await verifySelfserveSchema();
    const out = process.env.SELFSERVE_VALIDATION_OUT_DIR || ".artifacts/selfserve-validation";
    await atStage("receipt", async () => {
      await mkdir(out, { recursive: true });
      await writeFile(join(out, "schema.receipt.json"), `${JSON.stringify(receipt, null, 2)}\n`);
    });
  } catch (error) {
    await reportSchemaFailure(error, process.env.SELFSERVE_VALIDATION_OUT_DIR || ".artifacts/selfserve-validation");
    process.exitCode = 1;
  }
}
