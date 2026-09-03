#!/usr/bin/env node

import { randomBytes, X509Certificate } from "node:crypto";
import { spawn } from "node:child_process";
import { chmodSync, mkdtempSync, mkdirSync, readFileSync, readdirSync, rmSync, unlinkSync, writeFileSync } from "node:fs";
import net from "node:net";
import { join } from "node:path";
import { tmpdir } from "node:os";
import pg from "pg";
import {
  buildUniqueCheckTokenEdit,
  buildConstraintSemanticDiagnostic,
  cleanupScratchDatabase,
  collectCheckConstraintDetail,
  collectConstraintCatalogManifest,
  collectReboundSourceCheckDetail,
  findSingleCheckExpressionMismatch,
  probeTargetClientConnection,
  runPostgresRestoreRehearsal,
  runTargetCheckReparseDiagnostic,
  schemaTokenDigest,
  tokenizeSchemaDump,
  writeClientFiles,
} from "./run-postgres-restore-rehearsal.mjs";
import { validatePostgresRestoreRehearsal } from "./validate-postgres-restore-rehearsal.mjs";

const { Client } = pg;
const SERVER_IMAGE = "pgvector/pgvector:pg18@sha256:2ba9ca5f2e7daa0f0e7723cba1ee9167bab54efd3640516a44ac1a928dd67e7a";
const TEST_PASSWORD = "local-rehearsal-only";
const TEST_READER_PASSWORD = "local-rehearsal-reader-only";
const TEST_TARGET_OPERATOR_PASSWORD = "local-rehearsal-target-operator-only";
const TARGET_TLS_HOST = "target.rehearsal.test";
const WRONG_TARGET_TLS_HOST = "wrong-target.rehearsal.test";
const CHECK_COLLECTION_FAILURES = new Map(
  ["SOURCE", "DESTINATION"].flatMap((side) => [
    [JSON.stringify([side, "IDENTITY_REBIND_FAILED", "REBIND", null]), `${side}_IDENTITY_REBIND_FAILED_REBIND`],
    [JSON.stringify([side, "SOURCE_REBIND_DRIFT", "REBIND", null]), `${side}_SOURCE_REBIND_DRIFT_REBIND`],
    ...[
      "REBIND", "PREFLIGHT", "EXPRESSION_FETCH", "DEPENDENCY_PREFLIGHT",
      "KEYWORD_PREFLIGHT", "KEYWORD_FETCH", "DEPENDENCY_FETCH", "NODE_COUNT", "TOKENIZE",
    ].map((stage) => [
      JSON.stringify([side, "COLLECTION_UNAVAILABLE", stage, null]),
      `${side}_COLLECTION_UNAVAILABLE_${stage}`,
    ]),
    ...[
      ["PREFLIGHT", "EXPRESSION_BYTES"],
      ["PREFLIGHT", "TREE_BYTES"],
      ["PREFLIGHT", "DEPENDENCY_COUNT"],
      ["PREFLIGHT", "NODE_COUNT"],
      ["DEPENDENCY_PREFLIGHT", "DEPENDENCY_BYTES"],
      ["KEYWORD_PREFLIGHT", "KEYWORD_COUNT"],
      ["KEYWORD_PREFLIGHT", "KEYWORD_BYTES"],
      ["TOKENIZE", "TOKENS"],
    ].map(([stage, limitKind]) => [
      JSON.stringify([side, "LIMIT_EXCEEDED", stage, limitKind]),
      `${side}_LIMIT_EXCEEDED_${limitKind}`,
    ]),
  ]),
);

const fail = (code) => {
  const error = new Error(code);
  error.code = code;
  throw error;
};

const assertCheckCollection = (side, detail) => {
  if (detail?.ok === true) return;
  const code = CHECK_COLLECTION_FAILURES.get(JSON.stringify([
    side,
    detail?.status,
    detail?.stage,
    detail?.limitKind ?? null,
  ]));
  fail(`CONSTRAINT_CHECK_DIAGNOSTIC_${code ?? "COLLECTION_STATUS_INVALID"}`);
};

const run = (command, args, code) => new Promise((resolvePromise, rejectPromise) => {
  const child = spawn(command, args, { stdio: ["ignore", "ignore", "pipe"] });
  let stderrBytes = 0;
  child.stderr.on("data", (chunk) => {
    stderrBytes += chunk.length;
    if (stderrBytes > 1024 * 1024) child.kill("SIGKILL");
  });
  child.on("error", () => rejectPromise(Object.assign(new Error(code), { code })));
  child.on("close", (status) => {
    if (status === 0) resolvePromise();
    else rejectPromise(Object.assign(new Error(code), { code }));
  });
});

const allocatePort = () => new Promise((resolvePromise, rejectPromise) => {
  const server = net.createServer();
  server.unref();
  server.on("error", rejectPromise);
  server.listen(0, "127.0.0.1", () => {
    const address = server.address();
    if (!address || typeof address === "string") {
      server.close();
      rejectPromise(new Error("PORT_ALLOCATION_FAILED"));
      return;
    }
    const { port } = address;
    server.close((error) => error ? rejectPromise(error) : resolvePromise(port));
  });
});

const config = (port, database, user = "postgres", password = TEST_PASSWORD) => ({
  host: "127.0.0.1",
  port,
  user,
  password,
  database,
  ssl: false,
});

const waitForDatabase = async (port, database) => {
  const deadline = Date.now() + 60_000;
  while (Date.now() < deadline) {
    const client = new Client(config(port, database));
    try {
      await client.connect();
      await client.query("SELECT 1");
      await client.end();
      return;
    } catch {
      await client.end().catch(() => {});
      await new Promise((resolvePromise) => setTimeout(resolvePromise, 500));
    }
  }
  fail("POSTGRES_START_TIMEOUT");
};

const tableIdentities = async (client) => {
  const result = await client.query(`
    SELECT schemaname, tablename
    FROM pg_tables
    WHERE schemaname = 'public'
    ORDER BY tablename COLLATE "C"
  `);
  return result.rows;
};

const main = async () => {
  const suffix = randomBytes(5).toString("hex");
  const network = `corgtex-pg-rehearsal-${suffix}`;
  const sourceContainer = `corgtex-pg-source-${suffix}`;
  const targetContainer = `corgtex-pg-target-${suffix}`;
  const [sourcePort, targetPort] = await Promise.all([allocatePort(), allocatePort()]);
  const root = mkdtempSync(join(tmpdir(), "corgtex-pg18-rehearsal-"));
  const artifactDir = join(root, "artifacts");
  const tempDir = join(root, "client");
  const stateFile = join(root, "state.json");
  const diagnosticArtifactDir = join(root, "diagnostic-artifacts");
  const diagnosticTempDir = join(root, "diagnostic-client");
  const diagnosticStateFile = join(root, "diagnostic-state.json");
  const tlsDir = join(root, "target-tls");
  const probeCases = ["valid", "wrong-ca", "wrong-host"].map((name) => ({
    name,
    artifactDir: join(root, `probe-${name}-artifacts`),
    tempDir: join(root, `probe-${name}-client`),
  }));
  mkdirSync(artifactDir, { mode: 0o700 });
  mkdirSync(tempDir, { mode: 0o700 });
  mkdirSync(diagnosticArtifactDir, { mode: 0o700 });
  mkdirSync(diagnosticTempDir, { mode: 0o700 });
  mkdirSync(tlsDir, { mode: 0o700 });
  for (const probeCase of probeCases) {
    mkdirSync(probeCase.artifactDir, { mode: 0o700 });
    mkdirSync(probeCase.tempDir, { mode: 0o700 });
  }
  let networkCreated = false;
  let sourceStarted = false;
  let targetStarted = false;

  try {
    const targetCaKey = join(tlsDir, "target-ca.key");
    const targetCaCert = join(tlsDir, "target-ca.crt");
    const wrongCaKey = join(tlsDir, "wrong-ca.key");
    const wrongCaCert = join(tlsDir, "wrong-ca.crt");
    const serverKey = join(tlsDir, "server.key");
    const serverRequest = join(tlsDir, "server.csr");
    const serverCert = join(tlsDir, "server.crt");
    const serverExtensions = join(tlsDir, "server.ext");
    writeFileSync(serverExtensions, [
      "basicConstraints=critical,CA:FALSE",
      "keyUsage=critical,digitalSignature,keyEncipherment",
      "extendedKeyUsage=serverAuth",
      `subjectAltName=DNS:${TARGET_TLS_HOST},DNS:localhost,IP:127.0.0.1`,
      "",
    ].join("\n"), { mode: 0o600 });
    await run("openssl", [
      "req", "-x509", "-newkey", "rsa:2048", "-sha256", "-nodes",
      "-keyout", targetCaKey, "-out", targetCaCert, "-days", "2",
      "-subj", "/CN=Corgtex PostgreSQL TLS Smoke Root",
    ], "TARGET_CA_CREATE_FAILED");
    await run("openssl", [
      "req", "-x509", "-newkey", "rsa:2048", "-sha256", "-nodes",
      "-keyout", wrongCaKey, "-out", wrongCaCert, "-days", "2",
      "-subj", "/CN=Corgtex Wrong PostgreSQL TLS Smoke Root",
    ], "WRONG_CA_CREATE_FAILED");
    await run("openssl", [
      "req", "-new", "-newkey", "rsa:2048", "-sha256", "-nodes",
      "-keyout", serverKey, "-out", serverRequest,
      "-subj", `/CN=${TARGET_TLS_HOST}`,
    ], "TARGET_CERTIFICATE_REQUEST_FAILED");
    await run("openssl", [
      "x509", "-req", "-in", serverRequest, "-CA", targetCaCert, "-CAkey", targetCaKey,
      "-CAcreateserial", "-out", serverCert, "-days", "2", "-sha256", "-extfile", serverExtensions,
    ], "TARGET_CERTIFICATE_CREATE_FAILED");
    for (const file of [targetCaCert, wrongCaCert, serverCert, serverKey]) chmodSync(file, 0o644);

    await run("docker", ["network", "create", network], "NETWORK_CREATE_FAILED");
    networkCreated = true;
    await run("docker", [
      "run", "--detach", "--name", sourceContainer, "--network", network,
      "--publish", `127.0.0.1:${sourcePort}:5432`,
      "--env", `POSTGRES_PASSWORD=${TEST_PASSWORD}`,
      SERVER_IMAGE,
    ], "SOURCE_CONTAINER_START_FAILED");
    sourceStarted = true;
    await run("docker", [
      "run", "--detach", "--name", targetContainer, "--network", network,
      "--network-alias", TARGET_TLS_HOST,
      "--network-alias", WRONG_TARGET_TLS_HOST,
      "--publish", `127.0.0.1:${targetPort}:5432`,
      "--env", `POSTGRES_PASSWORD=${TEST_PASSWORD}`,
      "--mount", `type=bind,source=${tlsDir},target=/tls,readonly`,
      "--entrypoint", "sh",
      SERVER_IMAGE,
      "-c", [
        "cp /tls/server.crt /tmp/corgtex-server.crt",
        "cp /tls/server.key /tmp/corgtex-server.key",
        "chown postgres:postgres /tmp/corgtex-server.crt /tmp/corgtex-server.key",
        "chmod 600 /tmp/corgtex-server.key",
        "exec docker-entrypoint.sh postgres -c ssl=on -c ssl_cert_file=/tmp/corgtex-server.crt -c ssl_key_file=/tmp/corgtex-server.key",
      ].join(" && "),
    ], "TARGET_CONTAINER_START_FAILED");
    targetStarted = true;
    await Promise.all([waitForDatabase(sourcePort, "postgres"), waitForDatabase(targetPort, "postgres")]);

    const sourceBootstrap = new Client(config(sourcePort, "postgres"));
    await sourceBootstrap.connect();
    await sourceBootstrap.query(
      "CREATE DATABASE source TEMPLATE template0 ENCODING 'UTF8' LOCALE_PROVIDER 'builtin' LC_COLLATE 'C' LC_CTYPE 'C' BUILTIN_LOCALE 'C.UTF-8'",
    );
    await sourceBootstrap.query(
      "CREATE DATABASE latin1_bytes TEMPLATE template0 ENCODING 'LATIN1' LC_COLLATE 'C' LC_CTYPE 'C'",
    );
    await sourceBootstrap.end();

    const latin1Admin = new Client(config(sourcePort, "latin1_bytes"));
    await latin1Admin.connect();
    try {
      await latin1Admin.query(`
        CREATE TABLE "Utf8BoundaryFixture" (
          "caf\u00e9" text,
          CONSTRAINT "Utf8BoundaryFixture_check" CHECK ("caf\u00e9" <> '\u00e9')
        )
      `);
      await latin1Admin.query("BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY");
      await latin1Admin.query("SET LOCAL client_encoding = 'UTF8'");
      await latin1Admin.query("SET LOCAL search_path = pg_catalog");
      const latin1Manifest = await collectConstraintCatalogManifest(
        latin1Admin,
        "LATIN1_CONSTRAINT_CATALOG_FAILED",
      );
      const latin1Entry = [...latin1Manifest.values()].find((entry) => entry.type === "CHECK");
      if (latin1Entry === undefined) fail("LATIN1_CHECK_MISSING");
      const byteProof = (await latin1Admin.query(`
        SELECT
          pg_catalog.octet_length(pg_catalog.pg_get_expr(conbin, conrelid, false))::integer AS database_bytes,
          pg_catalog.octet_length(pg_catalog.convert_to(
            pg_catalog.pg_get_expr(conbin, conrelid, false),
            'UTF8'
          ))::integer AS utf8_bytes
        FROM pg_catalog.pg_constraint
        WHERE oid = $1::pg_catalog.oid AND contype = 'c'
      `, [latin1Entry.diagnostic.constraintOid])).rows[0];
      if (!(byteProof?.utf8_bytes > byteProof?.database_bytes)) fail("LATIN1_UTF8_BYTE_DIFFERENCE_MISSING");
      const latin1Detail = await collectCheckConstraintDetail(latin1Admin, latin1Entry);
      if (latin1Detail.ok !== true) fail("LATIN1_UTF8_BOUNDARY_FAILED");
      await latin1Admin.query("COMMIT");
    } catch (error) {
      await latin1Admin.query("ROLLBACK").catch(() => {});
      throw error;
    } finally {
      await latin1Admin.end().catch(() => {});
    }

    const sourceAdmin = new Client(config(sourcePort, "source"));
    await sourceAdmin.connect();
    await sourceAdmin.query(`CREATE ROLE rehearsal_reader LOGIN PASSWORD '${TEST_READER_PASSWORD}'`);
    await sourceAdmin.query(`
      CREATE EXTENSION vector;
      CREATE TYPE "EventStatus" AS ENUM ('PENDING', 'DISPATCHED', 'FAILED');
      CREATE TYPE "WorkflowJobStatus" AS ENUM ('PENDING', 'RUNNING', 'COMPLETED', 'FAILED', 'CANCELLED');
      CREATE TABLE "Event" (
        "id" text PRIMARY KEY,
        "payload" jsonb NOT NULL,
        "status" "EventStatus" NOT NULL,
        "lockedAt" timestamp(3),
        "lockedBy" text
      );
      CREATE TABLE "WorkflowJob" (
        "id" text PRIMARY KEY,
        "payload" jsonb NOT NULL,
        "status" "WorkflowJobStatus" NOT NULL,
        "lockedAt" timestamp(3),
        "lockedBy" text
      );
      CREATE TABLE "CanonicalTypes" (
        "id" text PRIMARY KEY,
        "amount" numeric(20, 6) NOT NULL,
        "bytes" bytea NOT NULL,
        "occurredAt" timestamptz NOT NULL,
        "embedding" vector(3) NOT NULL,
        "values" integer[] NOT NULL
      );
      CREATE DOMAIN "ConstraintDomain" AS text
        CONSTRAINT "ConstraintDomain_check" CHECK (VALUE <> 'private-domain-sentinel');
      CREATE TABLE "ConstraintParent" (
        "id" integer PRIMARY KEY
      );
      CREATE TABLE "ConstraintFixture" (
        "id" integer PRIMARY KEY,
        "parentId" integer,
        "kind" text,
        "domainValue" "ConstraintDomain",
        CONSTRAINT "ConstraintFixture_kind_check"
          CHECK ("kind" IN ('private-alpha', 'private-beta', 'private-gamma')),
        CONSTRAINT "ConstraintFixture_kind_key"
          UNIQUE ("kind") DEFERRABLE INITIALLY DEFERRED,
        CONSTRAINT "ConstraintFixture_parentId_fkey"
          FOREIGN KEY ("parentId") REFERENCES "ConstraintParent" ("id") ON DELETE CASCADE NOT VALID
      );
      CREATE FUNCTION "constraint_trigger_guard"() RETURNS trigger
      LANGUAGE plpgsql AS $function$
      BEGIN
        RETURN NEW;
      END;
      $function$;
      CREATE CONSTRAINT TRIGGER "ConstraintFixture_guard"
        AFTER INSERT ON "ConstraintFixture"
        DEFERRABLE INITIALLY DEFERRED
        FOR EACH ROW EXECUTE FUNCTION "constraint_trigger_guard"();
      CREATE TABLE "InheritedConstraintBase" (
        "id" integer,
        CONSTRAINT "InheritedConstraintBase_id_check" CHECK ("id" >= 0)
      );
      CREATE TABLE "InheritedConstraintChild" () INHERITS ("InheritedConstraintBase");
      CREATE TABLE "PartitionedConstraintFixture" (
        "id" integer,
        CONSTRAINT "PartitionedConstraintFixture_id_check" CHECK ("id" >= 0)
      ) PARTITION BY RANGE ("id");
      CREATE TABLE "PartitionedConstraintFixture_first"
        PARTITION OF "PartitionedConstraintFixture" FOR VALUES FROM (0) TO (10);
      CREATE SCHEMA "context fixture";
      CREATE DOMAIN "context fixture"."bounded_text" AS text;
      CREATE DOMAIN "context fixture"."operator" AS text;
      CREATE FUNCTION "context fixture"."greater_than"(integer, integer) RETURNS boolean
      LANGUAGE sql IMMUTABLE AS 'SELECT $1 > $2';
      CREATE OPERATOR "context fixture".> (
        LEFTARG = integer,
        RIGHTARG = integer,
        FUNCTION = "context fixture"."greater_than"
      );
      CREATE SCHEMA "operator";
      CREATE DOMAIN "operator"."bounded_text" AS text;
      CREATE FUNCTION "operator"."greater_than"(integer, integer) RETURNS boolean
      LANGUAGE sql IMMUTABLE AS 'SELECT $1 > $2';
      CREATE OPERATOR "operator".> (
        LEFTARG = integer,
        RIGHTARG = integer,
        FUNCTION = "operator"."greater_than"
      );
      CREATE FUNCTION "type_context_varying"(text) RETURNS boolean
      LANGUAGE sql IMMUTABLE AS 'SELECT true';
      CREATE TABLE "TypeContextFixture" (
        "value" text,
        CONSTRAINT "TypeContextFixture_character_check"
          CHECK (("value"::character varying(10)) IS NOT NULL),
        CONSTRAINT "TypeContextFixture_bit_check"
          CHECK (("value"::bit varying(8)) IS NOT NULL),
        CONSTRAINT "TypeContextFixture_function_check"
          CHECK ("type_context_varying"("value"))
      );
      CREATE TABLE "QualifiedContextFixture" (
        "value" text,
        "amount" integer,
        "flag" boolean,
        "observedAt" timestamptz,
        CONSTRAINT "QualifiedContextFixture_type_check"
          CHECK (("value"::"context fixture"."bounded_text") IS NOT NULL),
        CONSTRAINT "QualifiedContextFixture_operator_check"
          CHECK ("amount" OPERATOR("context fixture".>) 0),
        CONSTRAINT "QualifiedContextFixture_operator_type_check"
          CHECK (("value"::"context fixture"."operator") IS NOT NULL),
        CONSTRAINT "QualifiedContextFixture_operator_schema_type_check"
          CHECK (("value"::"operator"."bounded_text") IS NOT NULL),
        CONSTRAINT "QualifiedContextFixture_operator_schema_operator_check"
          CHECK ("amount" OPERATOR("operator".>) 0),
        CONSTRAINT "QualifiedContextFixture_coalesce_check"
          CHECK (COALESCE("amount", 0) >= 0),
        CONSTRAINT "QualifiedContextFixture_nullif_check"
          CHECK (NULLIF("amount", 0) IS NULL OR "amount" <> 0),
        CONSTRAINT "QualifiedContextFixture_greatest_check"
          CHECK (GREATEST("amount", 0) >= 0),
        CONSTRAINT "QualifiedContextFixture_least_check"
          CHECK (LEAST("amount", 0) <= 0),
        CONSTRAINT "QualifiedContextFixture_current_date_check"
          CHECK (CURRENT_DATE IS NOT NULL),
        CONSTRAINT "QualifiedContextFixture_current_time_check"
          CHECK (CURRENT_TIME(3) IS NOT NULL),
        CONSTRAINT "QualifiedContextFixture_current_user_check"
          CHECK (CURRENT_USER IS NOT NULL),
        CONSTRAINT "QualifiedContextFixture_current_catalog_check"
          CHECK (CURRENT_CATALOG IS NOT NULL),
        CONSTRAINT "QualifiedContextFixture_current_schema_check"
          CHECK (CURRENT_SCHEMA IS NOT NULL),
        CONSTRAINT "QualifiedContextFixture_is_unknown_check"
          CHECK ("flag" IS UNKNOWN),
        CONSTRAINT "QualifiedContextFixture_is_not_unknown_check"
          CHECK ("flag" IS NOT UNKNOWN),
        CONSTRAINT "QualifiedContextFixture_case_searched_check"
          CHECK ((CASE WHEN "amount" < 0 THEN 0 ELSE 2 END) >= 0),
        CONSTRAINT "QualifiedContextFixture_case_simple_check"
          CHECK ((CASE "amount" WHEN 0 THEN 0 ELSE 1 END) >= 0),
        CONSTRAINT "QualifiedContextFixture_case_multi_check"
          CHECK ((CASE WHEN "amount" < 0 THEN 0 WHEN "amount" = 0 THEN 1 ELSE 2 END) >= 0),
        CONSTRAINT "QualifiedContextFixture_case_nested_check"
          CHECK ((CASE WHEN "flag" THEN CASE "amount" WHEN 0 THEN 0 ELSE 1 END ELSE 2 END) >= 0),
        CONSTRAINT "QualifiedContextFixture_array_any_check"
          CHECK ("amount" = ANY (ARRAY[1, 2])),
        CONSTRAINT "QualifiedContextFixture_array_nested_check"
          CHECK ("amount" = ANY (ARRAY[ARRAY[1, 2], ARRAY[3, 4]])),
        CONSTRAINT "QualifiedContextFixture_array_multidimensional_check"
          CHECK ("amount" = ANY (ARRAY[[1, 2], [3, 4]])),
        CONSTRAINT "QualifiedContextFixture_array_empty_check"
          CHECK (cardinality(ARRAY[]::integer[]) = 0),
        CONSTRAINT "QualifiedContextFixture_timezone_check"
          CHECK ("observedAt" >= TIMESTAMPTZ '2026-01-01 00:00:00+00'),
        CONSTRAINT "QualifiedContextFixture_extract_check"
          CHECK (EXTRACT(YEAR FROM "observedAt") >= 2026)
      );
      CREATE SEQUENCE "legacy_id_seq" START 41;
      SELECT nextval('"legacy_id_seq"');
      CREATE TABLE _prisma_migrations (
        id varchar(36) PRIMARY KEY,
        checksum varchar(64) NOT NULL,
        finished_at timestamptz,
        migration_name varchar(255) NOT NULL,
        logs text,
        rolled_back_at timestamptz,
        started_at timestamptz NOT NULL DEFAULT now(),
        applied_steps_count integer NOT NULL DEFAULT 0
      );
      INSERT INTO "Event" ("id", "payload", "status") VALUES ('event-before', '{"b":2,"a":1}', 'DISPATCHED');
      INSERT INTO "WorkflowJob" ("id", "payload", "status") VALUES ('job-before', '{"nested":{"z":2,"a":1}}', 'COMPLETED');
      INSERT INTO "CanonicalTypes" VALUES ('types-before', 123456789.123400, decode('00ff10', 'hex'), '2026-01-02T03:04:05.678Z', '[1.25,2.5,3.75]', ARRAY[3,1,2]);
      INSERT INTO _prisma_migrations (id, checksum, finished_at, migration_name, applied_steps_count)
      VALUES ('11111111-1111-4111-8111-111111111111', repeat('a', 64), now(), '20260101000000_init', 1);
    `);
    await sourceAdmin.query("BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY");
    await sourceAdmin.query("SET LOCAL client_encoding = 'UTF8'");
    await sourceAdmin.query("SET LOCAL search_path = pg_catalog");
    const typeContextExpressions = (await sourceAdmin.query(`
      SELECT
        conname,
        pg_get_expr(conbin, conrelid) AS expression,
        position('{COALESCEEXPR ' IN conbin::text) > 0 AS has_coalesce_node,
        position('{NULLIFEXPR ' IN conbin::text) > 0 AS has_nullif_node,
        position('{MINMAXEXPR ' IN conbin::text) > 0 AS has_minmax_node,
        position('{SQLVALUEFUNCTION ' IN conbin::text) > 0 AS has_sql_value_node,
        position('{BOOLEANTEST ' IN conbin::text) > 0 AS has_boolean_test_node,
        position('{CASEEXPR ' IN conbin::text) > 0 AS has_case_node,
        position('{CASEWHEN ' IN conbin::text) > 0 AS has_case_when_node,
        position('{CASETESTEXPR ' IN conbin::text) > 0 AS has_case_test_node,
        position('{ARRAYEXPR ' IN conbin::text) > 0 AS has_array_node,
        position('{FUNCEXPR ' IN conbin::text) > 0 AS has_function_node
      FROM pg_constraint
      WHERE conname IN (
        'TypeContextFixture_character_check',
        'TypeContextFixture_bit_check',
        'TypeContextFixture_function_check',
        'QualifiedContextFixture_type_check',
        'QualifiedContextFixture_operator_check',
        'QualifiedContextFixture_operator_type_check',
        'QualifiedContextFixture_operator_schema_type_check',
        'QualifiedContextFixture_operator_schema_operator_check',
        'QualifiedContextFixture_coalesce_check',
        'QualifiedContextFixture_nullif_check',
        'QualifiedContextFixture_greatest_check',
        'QualifiedContextFixture_least_check',
        'QualifiedContextFixture_current_date_check',
        'QualifiedContextFixture_current_time_check',
        'QualifiedContextFixture_current_user_check',
        'QualifiedContextFixture_current_catalog_check',
        'QualifiedContextFixture_current_schema_check',
        'QualifiedContextFixture_is_unknown_check',
        'QualifiedContextFixture_is_not_unknown_check',
        'QualifiedContextFixture_case_searched_check',
        'QualifiedContextFixture_case_simple_check',
        'QualifiedContextFixture_case_multi_check',
        'QualifiedContextFixture_case_nested_check',
        'QualifiedContextFixture_array_any_check',
        'QualifiedContextFixture_array_nested_check',
        'QualifiedContextFixture_array_multidimensional_check',
        'QualifiedContextFixture_array_empty_check',
        'QualifiedContextFixture_extract_check'
      )
      ORDER BY conname COLLATE "C"
    `)).rows;
    await sourceAdmin.query("COMMIT");
    if (typeContextExpressions.length !== 28) fail("TYPE_CONTEXT_EXPRESSION_COUNT");
    for (const [constraintName, typeName, typmod] of [
      ["TypeContextFixture_character_check", "character", "10"],
      ["TypeContextFixture_bit_check", "bit", "8"],
    ]) {
      const expression = typeContextExpressions.find((row) => row.conname === constraintName)?.expression;
      if (typeof expression !== "string" || !new RegExp(`${typeName} varying\\(${typmod}\\)`, "iu").test(expression)) {
        fail("TYPE_CONTEXT_PG18_DEPARSE_MISMATCH");
      }
      const withoutVarying = expression.replace(/\s+varying(?=\()/iu, "");
      const edit = buildUniqueCheckTokenEdit(tokenizeSchemaDump(expression), tokenizeSchemaDump(withoutVarying));
      if (
        edit.status !== "UNIQUE"
        || edit.sourceOnly.BUILTIN_TYPE !== 1
        || edit.sourceOnly.FUNCTION !== 0
        || JSON.stringify(edit).match(/character|varying|private|type_context/iu)
      ) fail("TYPE_CONTEXT_CLASSIFICATION_MISMATCH");
    }
    const functionExpression = typeContextExpressions.find(
      (row) => row.conname === "TypeContextFixture_function_check",
    )?.expression;
    if (typeof functionExpression !== "string" || !/public\.type_context_varying\(/iu.test(functionExpression)) {
      fail("FUNCTION_CONTEXT_PG18_DEPARSE_MISMATCH");
    }
    const renamedFunctionExpression = functionExpression.replace(/public\.type_context_varying/iu, "other_schema.type_context_varying");
    const functionEdit = buildUniqueCheckTokenEdit(
      tokenizeSchemaDump(functionExpression),
      tokenizeSchemaDump(renamedFunctionExpression),
    );
    if (
      functionEdit.status !== "UNIQUE"
      || functionEdit.sourceOnly.FUNCTION !== 1
      || functionEdit.destinationOnly.FUNCTION !== 1
      || JSON.stringify(functionEdit).match(/varying|private|type_context/iu)
    ) fail("FUNCTION_CONTEXT_CLASSIFICATION_MISMATCH");
    const qualifiedTypeExpression = typeContextExpressions.find(
      (row) => row.conname === "QualifiedContextFixture_type_check",
    )?.expression;
    if (
      typeof qualifiedTypeExpression !== "string"
      || !/::"context fixture"\.bounded_text/iu.test(qualifiedTypeExpression)
    ) fail("QUALIFIED_TYPE_CONTEXT_PG18_DEPARSE_MISMATCH");
    const renamedQualifiedTypeExpression = qualifiedTypeExpression.replace(
      /"context fixture"\.bounded_text/iu,
      '"other context".bounded_text',
    );
    const qualifiedTypeEdit = buildUniqueCheckTokenEdit(
      tokenizeSchemaDump(qualifiedTypeExpression),
      tokenizeSchemaDump(renamedQualifiedTypeExpression),
    );
    if (
      qualifiedTypeEdit.status !== "UNIQUE"
      || qualifiedTypeEdit.sourceOnly.BUILTIN_TYPE !== 1
      || qualifiedTypeEdit.destinationOnly.BUILTIN_TYPE !== 1
      || qualifiedTypeEdit.sourceOnly.COLUMN_REFERENCE !== 0
      || qualifiedTypeEdit.destinationOnly.COLUMN_REFERENCE !== 0
      || JSON.stringify(qualifiedTypeEdit).match(/context|bounded|private/iu)
    ) fail("QUALIFIED_TYPE_CONTEXT_CLASSIFICATION_MISMATCH");
    const qualifiedOperatorExpression = typeContextExpressions.find(
      (row) => row.conname === "QualifiedContextFixture_operator_check",
    )?.expression;
    if (
      typeof qualifiedOperatorExpression !== "string"
      || !/OPERATOR\("context fixture"\.>\)/iu.test(qualifiedOperatorExpression)
    ) fail("QUALIFIED_OPERATOR_CONTEXT_PG18_DEPARSE_MISMATCH");
    const renamedQualifiedOperatorExpression = qualifiedOperatorExpression.replace(
      /"context fixture"(?=\.>)/iu,
      '"other context"',
    );
    const qualifiedOperatorEdit = buildUniqueCheckTokenEdit(
      tokenizeSchemaDump(qualifiedOperatorExpression),
      tokenizeSchemaDump(renamedQualifiedOperatorExpression),
    );
    if (
      qualifiedOperatorEdit.status !== "UNIQUE"
      || qualifiedOperatorEdit.sourceOnly.OPERATOR !== 1
      || qualifiedOperatorEdit.destinationOnly.OPERATOR !== 1
      || qualifiedOperatorEdit.sourceOnly.COLUMN_REFERENCE !== 0
      || qualifiedOperatorEdit.destinationOnly.COLUMN_REFERENCE !== 0
      || JSON.stringify(qualifiedOperatorEdit).match(/context|greater|private/iu)
    ) fail("QUALIFIED_OPERATOR_CONTEXT_CLASSIFICATION_MISMATCH");
    for (const [constraintName, pattern, replacement, category] of [
      [
        "QualifiedContextFixture_operator_type_check",
        /\.(?:"operator"|operator)(?=\)|\s)/iu,
        ".renamed_type",
        "BUILTIN_TYPE",
      ],
      [
        "QualifiedContextFixture_operator_schema_type_check",
        /::(?:"operator"|operator)\./iu,
        "::renamed_schema.",
        "BUILTIN_TYPE",
      ],
      [
        "QualifiedContextFixture_operator_schema_operator_check",
        /OPERATOR\((?:"operator"|operator)(?=\.>)/iu,
        "OPERATOR(renamed_schema",
        "OPERATOR",
      ],
    ]) {
      const expression = typeContextExpressions.find((row) => row.conname === constraintName)?.expression;
      if (typeof expression !== "string" || !pattern.test(expression)) fail("OPERATOR_IDENTIFIER_PG18_DEPARSE_MISMATCH");
      const renamed = expression.replace(pattern, replacement);
      const edit = buildUniqueCheckTokenEdit(tokenizeSchemaDump(expression), tokenizeSchemaDump(renamed));
      if (
        edit.status !== "UNIQUE"
        || edit.sourceOnly[category] !== 1
        || edit.destinationOnly[category] !== 1
        || edit.sourceOnly.COLUMN_REFERENCE !== 0
        || edit.destinationOnly.COLUMN_REFERENCE !== 0
        || JSON.stringify(edit).match(/renamed|context|private/iu)
      ) fail("OPERATOR_IDENTIFIER_CLASSIFICATION_MISMATCH");
    }
    for (const [constraintName, sourceName, destinationName, nodeField] of [
      ["QualifiedContextFixture_coalesce_check", "COALESCE", "NULLIF", "has_coalesce_node"],
      ["QualifiedContextFixture_nullif_check", "NULLIF", "COALESCE", "has_nullif_node"],
      ["QualifiedContextFixture_greatest_check", "GREATEST", "LEAST", "has_minmax_node"],
      ["QualifiedContextFixture_least_check", "LEAST", "GREATEST", "has_minmax_node"],
    ]) {
      const row = typeContextExpressions.find((entry) => entry.conname === constraintName);
      if (typeof row?.expression !== "string" || row[nodeField] !== true) fail("SQL_CONSTRUCT_PG18_NODE_MISMATCH");
      const renamed = row.expression.replace(new RegExp(`\\b${sourceName}\\b`, "iu"), destinationName);
      const edit = buildUniqueCheckTokenEdit(tokenizeSchemaDump(row.expression), tokenizeSchemaDump(renamed));
      if (
        edit.status !== "UNIQUE"
        || edit.sourceOnly.OTHER !== 1
        || edit.destinationOnly.OTHER !== 1
        || edit.sourceOnly.FUNCTION !== 0
        || edit.destinationOnly.FUNCTION !== 0
        || JSON.stringify(edit).match(/coalesce|nullif|greatest|least|private/iu)
      ) fail("SQL_CONSTRUCT_CLASSIFICATION_MISMATCH");
    }
    for (const [constraintName, sourceName, destinationName] of [
      ["QualifiedContextFixture_current_date_check", "CURRENT_DATE", "CURRENT_TIMESTAMP"],
      ["QualifiedContextFixture_current_time_check", "CURRENT_TIME", "LOCALTIME"],
      ["QualifiedContextFixture_current_user_check", "CURRENT_USER", "SESSION_USER"],
      ["QualifiedContextFixture_current_catalog_check", "CURRENT_CATALOG", "CURRENT_SCHEMA"],
      ["QualifiedContextFixture_current_schema_check", "CURRENT_SCHEMA", "CURRENT_CATALOG"],
    ]) {
      const row = typeContextExpressions.find((entry) => entry.conname === constraintName);
      if (typeof row?.expression !== "string" || row.has_sql_value_node !== true) {
        fail("SQL_VALUE_CONTEXT_PG18_NODE_MISMATCH");
      }
      const renamed = row.expression.replace(new RegExp(`\\b${sourceName}\\b`, "iu"), destinationName);
      const edit = buildUniqueCheckTokenEdit(tokenizeSchemaDump(row.expression), tokenizeSchemaDump(renamed));
      if (
        edit.status !== "UNIQUE"
        || edit.sourceOnly.OTHER !== 1
        || edit.destinationOnly.OTHER !== 1
        || edit.sourceOnly.COLUMN_REFERENCE !== 0
        || edit.destinationOnly.COLUMN_REFERENCE !== 0
        || edit.sourceOnly.FUNCTION !== 0
        || edit.destinationOnly.FUNCTION !== 0
        || JSON.stringify(edit).match(/current|localtime|session|private/iu)
      ) fail("SQL_VALUE_CONTEXT_CLASSIFICATION_MISMATCH");
    }
    for (const [constraintName, destinationName] of [
      ["QualifiedContextFixture_is_unknown_check", "TRUE"],
      ["QualifiedContextFixture_is_not_unknown_check", "FALSE"],
    ]) {
      const row = typeContextExpressions.find((entry) => entry.conname === constraintName);
      if (typeof row?.expression !== "string" || row.has_boolean_test_node !== true) {
        fail("BOOLEAN_TEST_PG18_NODE_MISMATCH");
      }
      const renamed = row.expression.replace(/\bUNKNOWN\b/iu, destinationName);
      const edit = buildUniqueCheckTokenEdit(tokenizeSchemaDump(row.expression), tokenizeSchemaDump(renamed));
      if (
        edit.status !== "UNIQUE"
        || edit.sourceOnly.OTHER !== 1
        || edit.destinationOnly.OTHER !== 1
        || edit.sourceOnly.OPERATOR !== 0
        || edit.destinationOnly.OPERATOR !== 0
        || edit.sourceOnly.COLUMN_REFERENCE !== 0
        || edit.destinationOnly.COLUMN_REFERENCE !== 0
        || JSON.stringify(edit).match(/unknown|private/iu)
      ) fail("BOOLEAN_TEST_CLASSIFICATION_MISMATCH");
    }
    for (const [constraintName, structuralCount, hasCaseTest] of [
      ["QualifiedContextFixture_case_searched_check", 5, false],
      ["QualifiedContextFixture_case_simple_check", 5, true],
      ["QualifiedContextFixture_case_multi_check", 7, false],
      ["QualifiedContextFixture_case_nested_check", 10, true],
    ]) {
      const row = typeContextExpressions.find((entry) => entry.conname === constraintName);
      if (
        typeof row?.expression !== "string"
        || row.has_case_node !== true
        || row.has_case_when_node !== true
        || row.has_case_test_node !== hasCaseTest
      ) fail("CASE_CONTEXT_PG18_NODE_MISMATCH");
      const lowerCaseSyntax = row.expression.replace(/\b(?:CASE|WHEN|THEN|ELSE|END)\b/gu, (word) => word.toLowerCase());
      const edit = buildUniqueCheckTokenEdit(tokenizeSchemaDump(row.expression), tokenizeSchemaDump(lowerCaseSyntax));
      if (
        edit.status !== "UNIQUE"
        || edit.sourceOnly.OTHER !== structuralCount
        || edit.destinationOnly.OTHER !== structuralCount
        || edit.sourceOnly.COLUMN_REFERENCE !== 0
        || edit.destinationOnly.COLUMN_REFERENCE !== 0
        || edit.sourceOnly.FUNCTION !== 0
        || edit.destinationOnly.FUNCTION !== 0
        || JSON.stringify(edit).match(/case|when|then|else|end|private/iu)
      ) fail("CASE_CONTEXT_CLASSIFICATION_MISMATCH");
    }
    for (const [constraintName, structuralCount] of [
      ["QualifiedContextFixture_array_any_check", 1],
      ["QualifiedContextFixture_array_nested_check", 3],
      ["QualifiedContextFixture_array_multidimensional_check", 3],
      ["QualifiedContextFixture_array_empty_check", 1],
    ]) {
      const row = typeContextExpressions.find((entry) => entry.conname === constraintName);
      if (
        typeof row?.expression !== "string"
        || !/\bARRAY\s*\[/u.test(row.expression)
        || row.has_array_node !== true
      ) fail("ARRAY_CONTEXT_PG18_NODE_MISMATCH");
      const lowerArraySyntax = row.expression.replace(/\bARRAY(?=\s*\[)/gu, (word) => word.toLowerCase());
      const edit = buildUniqueCheckTokenEdit(tokenizeSchemaDump(row.expression), tokenizeSchemaDump(lowerArraySyntax));
      if (
        edit.status !== "UNIQUE"
        || edit.sourceOnly.OTHER !== structuralCount
        || edit.destinationOnly.OTHER !== structuralCount
        || edit.sourceOnly.COLUMN_REFERENCE !== 0
        || edit.destinationOnly.COLUMN_REFERENCE !== 0
        || edit.sourceOnly.FUNCTION !== 0
        || edit.destinationOnly.FUNCTION !== 0
        || JSON.stringify(edit).match(/array|private/iu)
      ) fail("ARRAY_CONTEXT_CLASSIFICATION_MISMATCH");
    }
    const extractRow = typeContextExpressions.find(
      (entry) => entry.conname === "QualifiedContextFixture_extract_check",
    );
    if (
      typeof extractRow?.expression !== "string"
      || extractRow.has_function_node !== true
      || !/EXTRACT\(year FROM "observedAt"\)/iu.test(extractRow.expression)
    ) fail("EXTRACT_CONTEXT_PG18_NODE_MISMATCH");
    await sourceAdmin.query("BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY");
    await sourceAdmin.query("SET LOCAL timezone = 'UTC'");
    await sourceAdmin.query("SET LOCAL client_encoding = 'UTF8'");
    await sourceAdmin.query("SET LOCAL search_path = pg_catalog");
    const contextConstraintManifest = await collectConstraintCatalogManifest(
      sourceAdmin,
      "CONTEXT_CONSTRAINT_CATALOG_FAILED",
    );
    const extractConstraint = [...contextConstraintManifest.values()].find((entry) => {
      try {
        return JSON.parse(entry.key)?.[3] === "QualifiedContextFixture_extract_check";
      } catch {
        return false;
      }
    });
    if (extractConstraint === undefined) fail("EXTRACT_CONTEXT_FIXTURE_MISSING");
    const extractDetail = await collectCheckConstraintDetail(sourceAdmin, extractConstraint);
    if (
      extractDetail.ok !== true
      || !extractDetail.keywords.has("extract")
      || !extractDetail.keywords.has("year")
      || !extractDetail.keywords.has("month")
      || !extractDetail.keywords.has("from")
      || !extractDetail.columnReferences.has("observedAt")
    ) fail("EXTRACT_CONTEXT_CATALOG_EVIDENCE_MISMATCH");
    const monthExpression = extractRow.expression.replace(/\byear\b/iu, "month");
    const extractEdit = buildUniqueCheckTokenEdit(
      tokenizeSchemaDump(extractRow.expression),
      tokenizeSchemaDump(monthExpression),
      extractDetail,
      extractDetail,
    );
    if (
      extractEdit.status !== "UNIQUE"
      || extractEdit.sourceOnly.OTHER !== 1
      || extractEdit.destinationOnly.OTHER !== 1
      || extractEdit.sourceOnly.COLUMN_REFERENCE !== 0
      || extractEdit.destinationOnly.COLUMN_REFERENCE !== 0
      || extractEdit.sourceOnly.FUNCTION !== 0
      || extractEdit.destinationOnly.FUNCTION !== 0
      || JSON.stringify(extractEdit).match(/extract|year|month|observed|private/iu)
    ) fail("EXTRACT_CONTEXT_CLASSIFICATION_MISMATCH");
    await sourceAdmin.query("COMMIT");
    const largeObjectOid = String((await sourceAdmin.query(
      "SELECT lo_from_bytea(0, decode('00112233445566778899aabbccddeeff', 'hex')) AS oid",
    )).rows[0].oid);
    if (!/^[1-9][0-9]{0,9}$/u.test(largeObjectOid)) fail("LARGE_OBJECT_CREATE_FAILED");
    await sourceAdmin.query(`
      GRANT CONNECT ON DATABASE source TO rehearsal_reader;
      GRANT USAGE ON SCHEMA public TO rehearsal_reader;
      GRANT SELECT ON ALL TABLES IN SCHEMA public TO rehearsal_reader;
      GRANT SELECT ON ALL SEQUENCES IN SCHEMA public TO rehearsal_reader;
      GRANT SELECT ON LARGE OBJECT ${largeObjectOid} TO rehearsal_reader;
      ALTER ROLE rehearsal_reader SET timezone = 'America/Los_Angeles';
    `);
    const identitiesBefore = await tableIdentities(sourceAdmin);
    await sourceAdmin.end();

    const restrictedReader = new Client(config(sourcePort, "source", "rehearsal_reader", TEST_READER_PASSWORD));
    await restrictedReader.connect();
    let protectedCatalogCode = null;
    try {
      await restrictedReader.query("SELECT count(*) FROM pg_largeobject");
    } catch (error) {
      protectedCatalogCode = error?.code;
    } finally {
      await restrictedReader.end();
    }
    if (protectedCatalogCode !== "42501") fail("RESTRICTED_READER_BOUNDARY_UNPROVEN");

    const targetBootstrap = new Client(config(targetPort, "postgres"));
    await targetBootstrap.connect();
    await targetBootstrap.query(`CREATE ROLE rehearsal_target_operator LOGIN CREATEDB PASSWORD '${TEST_TARGET_OPERATOR_PASSWORD}'`);
    await targetBootstrap.end();

    const sourceConfig = {
      host: "127.0.0.1",
      dockerHost: sourceContainer,
      dockerPort: 5432,
      port: sourcePort,
      user: "rehearsal_reader",
      password: TEST_READER_PASSWORD,
      database: "source",
      sslmode: "disable",
    };
    const targetTlsRootCert = readFileSync(targetCaCert, "utf8");
    const targetTlsRootCertFingerprints = [new X509Certificate(targetTlsRootCert).fingerprint256];
    const targetAdminConfig = {
      host: "127.0.0.1",
      dockerHost: TARGET_TLS_HOST,
      dockerPort: 5432,
      port: targetPort,
      user: "postgres",
      password: TEST_PASSWORD,
      database: "postgres",
      sslmode: "verify-full",
      targetTlsRootCert,
      targetTlsRootCertFingerprints,
    };
    const restrictedTargetConfig = {
      ...targetAdminConfig,
      user: "rehearsal_target_operator",
      password: TEST_TARGET_OPERATOR_PASSWORD,
    };

    const runProbeCase = async (probeCase, probeTargetConfig, expectedError) => {
      const temporaryFiles = [];
      const clientFiles = writeClientFiles(
        probeCase.tempDir,
        sourceConfig,
        probeTargetConfig,
        (...paths) => temporaryFiles.push(...paths),
      );
      let probeError = null;
      try {
        await probeTargetClientConnection({
          tempDir: probeCase.tempDir,
          clientFiles,
          network,
          artifactDir: probeCase.artifactDir,
        });
      } catch (error) {
        probeError = error?.code;
      } finally {
        for (const file of temporaryFiles) unlinkSync(file);
      }
      if (probeError !== expectedError) fail("TARGET_TLS_PROBE_RESULT_MISMATCH");
      if (expectedError === null) {
        if (readdirSync(probeCase.artifactDir).length !== 0) fail("SUCCESSFUL_TARGET_TLS_PROBE_EMITTED_DIAGNOSTIC");
        return;
      }
      const diagnostic = JSON.parse(readFileSync(join(probeCase.artifactDir, "connection-probe-diagnostic.json"), "utf8"));
      if (JSON.stringify(diagnostic) !== JSON.stringify({
        phase: "TARGET_CLIENT_CONNECTION_PROBE",
        processClass: "CONNECTION_ERROR",
        category: "UNKNOWN",
        sqlstate: null,
        stderrObserved: true,
        stderrTruncated: false,
      })) fail("TARGET_TLS_PROBE_DIAGNOSTIC_MISMATCH");
      const serializedDiagnostic = JSON.stringify(diagnostic);
      for (const forbidden of [TARGET_TLS_HOST, WRONG_TARGET_TLS_HOST, TEST_PASSWORD, "certificate", "password"]) {
        if (serializedDiagnostic.includes(forbidden)) fail("TARGET_TLS_PROBE_DIAGNOSTIC_LEAKED_INPUT");
      }
    };

    await runProbeCase(probeCases[0], targetAdminConfig, null);
    const wrongTargetTlsRootCert = readFileSync(wrongCaCert, "utf8");
    await runProbeCase(probeCases[1], {
      ...targetAdminConfig,
      targetTlsRootCert: wrongTargetTlsRootCert,
      targetTlsRootCertFingerprints: [new X509Certificate(wrongTargetTlsRootCert).fingerprint256],
    }, "TARGET_CLIENT_CONNECTION_PROBE_FAILED");
    await runProbeCase(probeCases[2], {
      ...targetAdminConfig,
      dockerHost: WRONG_TARGET_TLS_HOST,
    }, "TARGET_CLIENT_CONNECTION_PROBE_FAILED");

    const scratchName = `corgtex_rehearsal_${suffix}_core`;
    const diagnosticScratchName = `corgtex_rehearsal_${suffix}_diagnostic`;
    let liveSequenceAfterArchive = null;

    let diagnosticError = null;
    try {
      await runPostgresRestoreRehearsal({
        domain: "core",
        sourceConfig,
        targetAdminConfig: restrictedTargetConfig,
        scratchName: diagnosticScratchName,
        artifactDir: diagnosticArtifactDir,
        tempDir: diagnosticTempDir,
        stateFile: diagnosticStateFile,
        dockerNetwork: network,
      });
    } catch (error) {
      diagnosticError = error?.code;
    }
    if (diagnosticError !== "DESTINATION_RESTORE_FAILED") fail(diagnosticError ?? "EXPECTED_RESTORE_FAILURE_MISSING");
    const restoreDiagnostic = JSON.parse(readFileSync(join(diagnosticArtifactDir, "restore-diagnostic.json"), "utf8"));
    if (JSON.stringify(restoreDiagnostic) !== JSON.stringify({
      phase: "DESTINATION_RESTORE",
      section: "PRE_DATA",
      processClass: "SCRIPT_ERROR",
      category: "INSUFFICIENT_PRIVILEGE",
      sqlstate: "42501",
      stderrObserved: true,
      stderrTruncated: false,
    })) fail("RESTORE_DIAGNOSTIC_BOUNDARY_FAILED");
    const serializedRestoreDiagnostic = JSON.stringify(restoreDiagnostic);
    for (const forbidden of ["rehearsal_target_operator", TEST_TARGET_OPERATOR_PASSWORD, "CREATE EXTENSION", "source"]) {
      if (serializedRestoreDiagnostic.includes(forbidden)) fail("RESTORE_DIAGNOSTIC_LEAKED_INPUT");
    }
    if (readdirSync(diagnosticTempDir).length !== 0) fail("DIAGNOSTIC_TEMPORARY_FILE_CLEANUP_FAILED");
    await cleanupScratchDatabase({
      targetAdminConfig: restrictedTargetConfig,
      stateFile: diagnosticStateFile,
      artifactDir: diagnosticArtifactDir,
      expectedScratchName: diagnosticScratchName,
    });

    await runPostgresRestoreRehearsal({
      domain: "core",
      sourceConfig,
      targetAdminConfig,
      scratchName,
      artifactDir,
      tempDir,
      stateFile,
      dockerNetwork: network,
      afterSnapshot: async () => {
        const concurrent = new Client(config(sourcePort, "source"));
        await concurrent.connect();
        try {
          await concurrent.query(
            'INSERT INTO "Event" ("id", "payload", "status") VALUES ($1, $2::jsonb, $3)',
            ["event-after-snapshot", '{"concurrent":true}', "PENDING"],
          );
        } finally {
          await concurrent.end();
        }
      },
      afterArchive: async () => {
        const concurrent = new Client(config(sourcePort, "source"));
        await concurrent.connect();
        try {
          liveSequenceAfterArchive = String((await concurrent.query("SELECT nextval('\"legacy_id_seq\"') AS value")).rows[0].value);
        } finally {
          await concurrent.end();
        }
      },
    });

    const evidence = JSON.parse(readFileSync(join(artifactDir, "postgres-restore-evidence.json"), "utf8"));
    if (
      evidence.source.schema.algorithm !== "PG_DUMP_SQL_TOKENS_V1"
      || JSON.stringify(evidence.source.schema) !== JSON.stringify(evidence.destination.schema)
    ) fail("SCHEMA_TOKEN_PARITY_FAILED");
    const schemaDiagnosticPath = join(artifactDir, "schema-diagnostic.json");
    if (readdirSync(artifactDir).includes("schema-diagnostic.json")) {
      const schemaDiagnostic = JSON.parse(readFileSync(schemaDiagnosticPath, "utf8"));
      if (JSON.stringify(schemaDiagnostic) !== JSON.stringify({ classification: "NON_EXECUTABLE_DUMP_TEXT_ONLY" })) {
        fail("SCHEMA_DIAGNOSTIC_BOUNDARY_FAILED");
      }
    }
    const sourceConstraintReadback = new Client(config(
      sourcePort,
      "source",
      "rehearsal_reader",
      TEST_READER_PASSWORD,
    ));
    const targetConstraintReadback = new Client(config(targetPort, scratchName));
    await sourceConstraintReadback.connect();
    await targetConstraintReadback.connect();
    let sourceConstraintManifest;
    let targetConstraintManifest;
    try {
      await sourceConstraintReadback.query("BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY");
      await targetConstraintReadback.query("BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY");
      await sourceConstraintReadback.query("SET LOCAL timezone = 'UTC'");
      await targetConstraintReadback.query("SET LOCAL timezone = 'UTC'");
      await sourceConstraintReadback.query("SET LOCAL client_encoding = 'UTF8'");
      await targetConstraintReadback.query("SET LOCAL client_encoding = 'UTF8'");
      await sourceConstraintReadback.query("SET LOCAL search_path = pg_catalog");
      await targetConstraintReadback.query("SET LOCAL search_path = pg_catalog");
      sourceConstraintManifest = await collectConstraintCatalogManifest(
        sourceConstraintReadback,
        "SOURCE_CONSTRAINT_CATALOG_EVIDENCE_FAILED",
      );
      targetConstraintManifest = await collectConstraintCatalogManifest(
        targetConstraintReadback,
        "DESTINATION_CONSTRAINT_CATALOG_EVIDENCE_FAILED",
      );
      await sourceConstraintReadback.query("COMMIT");
      await targetConstraintReadback.query("COMMIT");
    } finally {
      await sourceConstraintReadback.end().catch(() => {});
      await targetConstraintReadback.end().catch(() => {});
    }
    const equalConstraintDiagnostic = buildConstraintSemanticDiagnostic(
      sourceConstraintManifest,
      targetConstraintManifest,
    );
    if (!equalConstraintDiagnostic.semanticEqual || equalConstraintDiagnostic.mismatchFields.length !== 0) {
      fail("CONSTRAINT_CATALOG_PARITY_FAILED");
    }
    const timezoneConstraint = [...sourceConstraintManifest.values()].find((entry) => {
      try {
        return JSON.parse(entry.key)?.[3] === "QualifiedContextFixture_timezone_check";
      } catch {
        return false;
      }
    });
    if (timezoneConstraint === undefined) fail("TIMEZONE_REBIND_FIXTURE_MISSING");
    const timezoneDetail = await collectReboundSourceCheckDetail(sourceConfig, timezoneConstraint);
    if (timezoneDetail.ok !== true) fail("TIMEZONE_REBIND_DRIFT");

    const verifyBooleanOperatorExtraction = async () => {
      const tableName = "BooleanOperatorExtractionFixture";
      const expectedCounts = {
        BooleanOperatorExtractionFixture_grouped_and: { AND: 1, OR: 0, NOT: 0 },
        BooleanOperatorExtractionFixture_flat_and: { AND: 1, OR: 0, NOT: 0 },
        BooleanOperatorExtractionFixture_grouped_or: { AND: 0, OR: 1, NOT: 0 },
        BooleanOperatorExtractionFixture_flat_or: { AND: 0, OR: 1, NOT: 0 },
        BooleanOperatorExtractionFixture_mixed: { AND: 1, OR: 1, NOT: 1 },
      };
      const fixture = new Client(config(sourcePort, "source"));
      await fixture.connect();
      let transactionOpen = false;
      try {
        await fixture.query(`
          CREATE TABLE "${tableName}" (
            "fixture_a" boolean,
            "fixture_b" boolean,
            "fixture_c" boolean,
            CONSTRAINT "BooleanOperatorExtractionFixture_grouped_and"
              CHECK (("fixture_a" AND "fixture_b") AND "fixture_c"),
            CONSTRAINT "BooleanOperatorExtractionFixture_flat_and"
              CHECK ("fixture_a" AND "fixture_b" AND "fixture_c"),
            CONSTRAINT "BooleanOperatorExtractionFixture_grouped_or"
              CHECK (("fixture_a" OR "fixture_b") OR "fixture_c"),
            CONSTRAINT "BooleanOperatorExtractionFixture_flat_or"
              CHECK ("fixture_a" OR "fixture_b" OR "fixture_c"),
            CONSTRAINT "BooleanOperatorExtractionFixture_mixed"
              CHECK (NOT "fixture_a" AND ("fixture_b" OR "fixture_c"))
          )
        `);
        await fixture.query("BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY");
        transactionOpen = true;
        await fixture.query("SET LOCAL timezone = 'UTC'");
        await fixture.query("SET LOCAL client_encoding = 'UTF8'");
        await fixture.query("SET LOCAL search_path = pg_catalog");
        const manifest = await collectConstraintCatalogManifest(
          fixture,
          "BOOLEAN_OPERATOR_CATALOG_FAILED",
        );
        const entries = new Map([...manifest.values()].flatMap((entry) => {
          try {
            const identity = JSON.parse(entry.key);
            return identity?.[2] === tableName && Object.hasOwn(expectedCounts, identity?.[3])
              ? [[identity[3], entry]]
              : [];
          } catch {
            return [];
          }
        }));
        if (entries.size !== Object.keys(expectedCounts).length) fail("BOOLEAN_OPERATOR_FIXTURE_MISSING");
        const details = new Map();
        for (const [constraintName, entry] of entries) {
          const detail = await collectCheckConstraintDetail(fixture, entry);
          if (detail.ok !== true) fail("BOOLEAN_OPERATOR_DETAIL_FAILED");
          if (JSON.stringify(detail.booleanNodeCounts) !== JSON.stringify(expectedCounts[constraintName])) {
            fail("BOOLEAN_OPERATOR_COUNT_MISMATCH");
          }
          const booleanTotal = Object.values(detail.booleanNodeCounts).reduce((total, count) => total + count, 0);
          if (booleanTotal !== detail.nodeTagCounts.BOOLEXPR) fail("BOOLEAN_OPERATOR_RECONCILIATION_FAILED");
          if (Object.hasOwn(detail, "conbin") || Object.hasOwn(detail, "expressionTree")) {
            fail("BOOLEAN_OPERATOR_RAW_TREE_EXPOSED");
          }
          details.set(constraintName, detail);
        }
        for (const operator of ["and", "or"]) {
          const grouped = details.get(`BooleanOperatorExtractionFixture_grouped_${operator}`);
          const flat = details.get(`BooleanOperatorExtractionFixture_flat_${operator}`);
          if (
            JSON.stringify(grouped.tokens) !== JSON.stringify(flat.tokens)
            || JSON.stringify(grouped.nodeTagCounts) !== JSON.stringify(flat.nodeTagCounts)
            || JSON.stringify(grouped.booleanNodeCounts) !== JSON.stringify(flat.booleanNodeCounts)
          ) fail("BOOLEAN_OPERATOR_CURRENT_VERSION_CANONICALIZATION_FAILED");
        }
        await fixture.query("COMMIT");
        transactionOpen = false;
        const publicEvidence = [...details.values()].map((detail) => ({
          booleanNodeCounts: detail.booleanNodeCounts,
          booleanNodeCount: detail.nodeTagCounts.BOOLEXPR,
        }));
        const serialized = JSON.stringify(publicEvidence);
        for (const forbidden of [tableName, "fixture_a", "fixture_b", "fixture_c", "BOOLEXPR :boolop"]) {
          if (serialized.includes(forbidden)) fail("BOOLEAN_OPERATOR_EVIDENCE_PRIVACY_FAILED");
        }
        if (/[a-f0-9]{64}/u.test(serialized)) fail("BOOLEAN_OPERATOR_EVIDENCE_DIGEST_LEAKED");
      } finally {
        if (transactionOpen) await fixture.query("ROLLBACK").catch(() => {});
        await fixture.query(`DROP TABLE IF EXISTS "${tableName}"`).catch(() => {});
        await fixture.end().catch(() => {});
      }
    };
    await verifyBooleanOperatorExtraction();

    const verifyTargetCheckReparse = async () => {
      const client = new Client(config(targetPort, scratchName));
      await client.connect();
      const tableName = "Target Reparse; Fixture";
      const constraintName = "Target Reparse Flat Check";
      const partitionedTableName = "Target Reparse Partitioned Fixture";
      const functionTableName = "Target Reparse Function Fixture";
      const destinationExpression = '"flag; a" AND "flag b" AND "flag c"';
      const sourceExpression = '("flag; a" AND "flag b") AND "flag c"';
      const syntheticSource = (destination, expression) => ({
        ...destination,
        semantics: {
          ...destination.semantics,
          DEFINITION: schemaTokenDigest(tokenizeSchemaDump(`CHECK (${expression}) NO INHERIT NOT VALID`)),
          CHECK_EXPRESSION: schemaTokenDigest(tokenizeSchemaDump(expression)),
        },
      });
      try {
        await client.query(`
          CREATE TABLE "${tableName}" (
            "flag; a" boolean,
            "flag b" boolean,
            "flag c" boolean
          );
          INSERT INTO "${tableName}" VALUES (false, false, false);
          ALTER TABLE "${tableName}" ADD CONSTRAINT "${constraintName}"
            CHECK (${destinationExpression}) NO INHERIT NOT VALID
        `);
        await client.query("BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY");
        await client.query("SET LOCAL timezone = 'UTC'");
        await client.query("SET LOCAL client_encoding = 'UTF8'");
        await client.query("SET LOCAL search_path = pg_catalog");
        const manifest = await collectConstraintCatalogManifest(client, "TARGET_REPARSE_CATALOG_FAILED");
        const destination = [...manifest.values()].find((entry) => {
          try { return JSON.parse(entry.key)?.[3] === constraintName; } catch { return false; }
        });
        if (destination === undefined) fail("TARGET_REPARSE_FIXTURE_MISSING");
        const destinationDetail = await collectCheckConstraintDetail(client, destination);
        if (destinationDetail.ok !== true) fail("TARGET_REPARSE_FIXTURE_DETAIL_FAILED");
        const safeSourceDependencies = destinationDetail.dependencies;
        await client.query("COMMIT");

        const matching = await runTargetCheckReparseDiagnostic({
          targetConfig: { ...targetAdminConfig, database: scratchName },
          sourceManifestEntry: syntheticSource(destination, sourceExpression),
          destinationManifestEntry: destination,
          sourceExpression,
          sourceDependencies: safeSourceDependencies,
          serverVersionRelation: "MATCH",
        });
        if (matching.status !== "MATCH" || matching.mismatchFields.length !== 0) {
          fail(`TARGET_REPARSE_GROUPING_MATCH_FAILED_${matching.status}_${matching.stage ?? "NONE"}_${matching.reason ?? "NONE"}_${matching.mismatchFields.join("_")}`);
        }

        for (const expression of [
          '"flag; a" AND ("flag b" OR "flag c")',
          '"flag; a" AND ("flag b" = "flag c")',
          '"flag; a" AND "flag b" AND ("flag c" IS TRUE)',
          '"flag; a" AND "flag b" AND "flag b"',
        ]) {
          const different = await runTargetCheckReparseDiagnostic({
            targetConfig: { ...targetAdminConfig, database: scratchName },
            sourceManifestEntry: syntheticSource(destination, expression),
            destinationManifestEntry: destination,
            sourceExpression: expression,
            sourceDependencies: safeSourceDependencies,
            serverVersionRelation: "MATCH",
          });
          if (different.status !== "DIFFERENT" || different.mismatchFields.length === 0) {
            fail("TARGET_REPARSE_NEGATIVE_CONTROL_FAILED");
          }
        }

        await client.query(`
          CREATE FUNCTION public.corgtex_reparse_event_trigger() RETURNS event_trigger
            LANGUAGE plpgsql AS 'BEGIN NULL; END';
          CREATE EVENT TRIGGER corgtex_reparse_event_trigger
            ON ddl_command_start EXECUTE FUNCTION public.corgtex_reparse_event_trigger()
        `);
        const eventTriggerResult = await runTargetCheckReparseDiagnostic({
          targetConfig: { ...targetAdminConfig, database: scratchName },
          sourceManifestEntry: syntheticSource(destination, sourceExpression),
          destinationManifestEntry: destination,
          sourceExpression,
          sourceDependencies: safeSourceDependencies,
          serverVersionRelation: "MATCH",
        });
        await client.query("DROP EVENT TRIGGER corgtex_reparse_event_trigger");
        await client.query("DROP FUNCTION public.corgtex_reparse_event_trigger()");
        if (eventTriggerResult.status !== "NOT_ELIGIBLE" || eventTriggerResult.reason !== "EVENT_TRIGGER_ENABLED") {
          fail("TARGET_REPARSE_EVENT_TRIGGER_GATE_FAILED");
        }

        await client.query(`
          CREATE TABLE "${partitionedTableName}" (
            "flag" boolean,
            CONSTRAINT "Target Reparse Partitioned Check" CHECK ("flag" IS NOT NULL)
          ) PARTITION BY LIST ("flag");
          CREATE FUNCTION public.corgtex_reparse_custom(boolean) RETURNS boolean
            LANGUAGE sql IMMUTABLE AS 'SELECT $1';
          CREATE TABLE "${functionTableName}" ("flag" boolean);
          ALTER TABLE "${functionTableName}" ADD CONSTRAINT "Target Reparse Function Check"
            CHECK (public.corgtex_reparse_custom("flag")) NO INHERIT NOT VALID
        `);
        await client.query("BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY");
        await client.query("SET LOCAL timezone = 'UTC'");
        await client.query("SET LOCAL client_encoding = 'UTF8'");
        await client.query("SET LOCAL search_path = pg_catalog");
        const ineligibleManifest = await collectConstraintCatalogManifest(client, "TARGET_REPARSE_CATALOG_FAILED");
        await client.query("COMMIT");
        const findConstraint = (name) => [...ineligibleManifest.values()].find((entry) => {
          try { return JSON.parse(entry.key)?.[3] === name; } catch { return false; }
        });
        const partitionedConstraint = findConstraint("Target Reparse Partitioned Check");
        const functionConstraint = findConstraint("Target Reparse Function Check");
        if (partitionedConstraint === undefined || functionConstraint === undefined) {
          fail("TARGET_REPARSE_INELIGIBLE_FIXTURE_MISSING");
        }
        const partitionedExpression = '(("flag" IS NOT NULL))';
        const partitionedResult = await runTargetCheckReparseDiagnostic({
          targetConfig: { ...targetAdminConfig, database: scratchName },
          sourceManifestEntry: syntheticSource(partitionedConstraint, partitionedExpression),
          destinationManifestEntry: partitionedConstraint,
          sourceExpression: partitionedExpression,
          sourceDependencies: safeSourceDependencies,
          serverVersionRelation: "MATCH",
        });
        if (partitionedResult.status !== "NOT_ELIGIBLE" || partitionedResult.reason !== "RELATION_KIND") {
          fail("TARGET_REPARSE_RELATION_KIND_GATE_FAILED");
        }
        const functionExpression = '(public.corgtex_reparse_custom("flag"))';
        const functionResult = await runTargetCheckReparseDiagnostic({
          targetConfig: { ...targetAdminConfig, database: scratchName },
          sourceManifestEntry: syntheticSource(functionConstraint, functionExpression),
          destinationManifestEntry: functionConstraint,
          sourceExpression: functionExpression,
          sourceDependencies: safeSourceDependencies,
          serverVersionRelation: "MATCH",
        });
        if (functionResult.status !== "NOT_ELIGIBLE" || functionResult.reason !== "EXECUTABLE_DEPENDENCY") {
          fail("TARGET_REPARSE_EXECUTABLE_DEPENDENCY_GATE_FAILED");
        }

        await client.query(`
          ALTER TABLE "${tableName}" DROP CONSTRAINT "${constraintName}";
          ALTER TABLE "${tableName}" ADD CONSTRAINT "${constraintName}"
            CHECK (${destinationExpression}) NO INHERIT NOT VALID
        `);
        const driftResult = await runTargetCheckReparseDiagnostic({
          targetConfig: { ...targetAdminConfig, database: scratchName },
          sourceManifestEntry: syntheticSource(destination, sourceExpression),
          destinationManifestEntry: destination,
          sourceExpression,
          sourceDependencies: safeSourceDependencies,
          serverVersionRelation: "MATCH",
        });
        if (driftResult.status !== "NOT_ELIGIBLE" || driftResult.reason !== "DESTINATION_REBIND_DRIFT") {
          fail("TARGET_REPARSE_IDENTITY_DRIFT_GATE_FAILED");
        }

        const probeCount = Number((await client.query(`
          SELECT count(*) AS count FROM pg_catalog.pg_constraint
          WHERE conname LIKE 'corgtex_reparse_%'
        `)).rows[0].count);
        if (probeCount !== 0) fail("TARGET_REPARSE_PROBE_REMAINS");
        const violatingRows = Number((await client.query(`SELECT count(*) AS count FROM "${tableName}"`)).rows[0].count);
        if (violatingRows !== 1) fail("TARGET_REPARSE_NOT_VALID_SCANNED_ROWS");
        const serialized = JSON.stringify({ matching, eventTriggerResult });
        for (const forbidden of [tableName, constraintName, "flag; a", sourceExpression, destinationExpression]) {
          if (serialized.includes(forbidden)) fail("TARGET_REPARSE_PRIVACY_FAILED");
        }
      } finally {
        await client.query("DROP EVENT TRIGGER IF EXISTS corgtex_reparse_event_trigger").catch(() => {});
        await client.query("DROP FUNCTION IF EXISTS public.corgtex_reparse_event_trigger()").catch(() => {});
        await client.query(`DROP TABLE IF EXISTS "${functionTableName}"`).catch(() => {});
        await client.query("DROP FUNCTION IF EXISTS public.corgtex_reparse_custom(boolean)").catch(() => {});
        await client.query(`DROP TABLE IF EXISTS "${partitionedTableName}"`).catch(() => {});
        await client.query(`DROP TABLE IF EXISTS "${tableName}"`).catch(() => {});
        await client.end().catch(() => {});
      }
    };
    await verifyTargetCheckReparse();

    const ambiguousSourceExpression = "fixture_flag AND ((other_fixture_flag IS NOT NULL))";
    const ambiguousDestinationExpression = "fixture_flag AND (other_fixture_flag IS NOT NULL)";
    const ambiguousSourceManifest = new Map([[timezoneConstraint.key, {
      ...timezoneConstraint,
      semantics: {
        ...timezoneConstraint.semantics,
        DEFINITION: schemaTokenDigest(tokenizeSchemaDump(`CHECK (${ambiguousSourceExpression})`)),
        CHECK_EXPRESSION: schemaTokenDigest(tokenizeSchemaDump(ambiguousSourceExpression)),
      },
    }]]);
    const ambiguousDestinationManifest = new Map([[timezoneConstraint.key, {
      ...timezoneConstraint,
      semantics: {
        ...timezoneConstraint.semantics,
        DEFINITION: schemaTokenDigest(tokenizeSchemaDump(`CHECK (${ambiguousDestinationExpression})`)),
        CHECK_EXPRESSION: schemaTokenDigest(tokenizeSchemaDump(ambiguousDestinationExpression)),
      },
    }]]);
    const ambiguityDetail = (expression) => ({
      ...timezoneDetail,
      tokens: tokenizeSchemaDump(expression),
      columnReferences: new Set(["fixture_flag", "other_fixture_flag"]),
      functionReferences: new Set(),
    });
    const ambiguousDiagnostic = buildConstraintSemanticDiagnostic(
      ambiguousSourceManifest,
      ambiguousDestinationManifest,
      "MATCH",
      {
        source: ambiguityDetail(ambiguousSourceExpression),
        destination: ambiguityDetail(ambiguousDestinationExpression),
      },
    );
    if (
      ambiguousDiagnostic.mismatchCount !== 1
      || JSON.stringify(ambiguousDiagnostic.mismatchFields) !== JSON.stringify(["DEFINITION", "CHECK_EXPRESSION"])
    ) fail("CONSTRAINT_CHECK_AMBIGUITY_CANDIDATE_MISMATCH");
    const ambiguity = ambiguousDiagnostic.checkExpressionDifference;
    if (ambiguity?.status !== "AMBIGUOUS" || ambiguity.tokenEdit !== null) {
      fail("CONSTRAINT_CHECK_AMBIGUITY_STATUS_MISMATCH");
    }
    if (ambiguity.ambiguityFingerprint?.nonParenthesisTokenSequenceRelation !== "MATCH") {
      fail("CONSTRAINT_CHECK_AMBIGUITY_SEQUENCE_MISMATCH");
    }
    if (ambiguity.ambiguityFingerprint.sourceOnly.PARENTHESIS !== 2) {
      fail("CONSTRAINT_CHECK_AMBIGUITY_PARENTHESIS_COUNT");
    }
    if (Object.entries(ambiguity.ambiguityFingerprint.sourceOnly).some(
      ([category, count]) => category !== "PARENTHESIS" && count !== 0,
    )) fail("CONSTRAINT_CHECK_AMBIGUITY_SOURCE_EXTRA_CATEGORY");
    if (Object.values(ambiguity.ambiguityFingerprint.destinationOnly).some((count) => count !== 0)) {
      fail("CONSTRAINT_CHECK_AMBIGUITY_DESTINATION_EXTRA_CATEGORY");
    }
    if (
      ambiguity.booleanGroupingFingerprint?.relation !== "NOT_PROVEN"
      || ambiguity.booleanGroupingFingerprint.operator !== null
    ) fail("CONSTRAINT_CHECK_AMBIGUITY_BOOLEAN_GROUPING_STATUS");
    if (!ambiguity.dependencies.identitySetEqual || ambiguity.dependencies.changedClasses.length !== 0) {
      fail("CONSTRAINT_CHECK_AMBIGUITY_DEPENDENCY_MISMATCH");
    }
    if (
      Object.values(ambiguity.nodeTagDeltas.sourceOnly).some((count) => count !== 0)
      || Object.values(ambiguity.nodeTagDeltas.destinationOnly).some((count) => count !== 0)
    ) fail("CONSTRAINT_CHECK_AMBIGUITY_NODE_MISMATCH");
    const serializedAmbiguity = JSON.stringify(ambiguity);
    if (
      serializedAmbiguity.includes("fixture_flag")
      || serializedAmbiguity.includes("other_fixture_flag")
      || /[a-f0-9]{64}/u.test(serializedAmbiguity)
    ) fail("CONSTRAINT_CHECK_AMBIGUITY_PRIVACY_FAILED");

    const recoveryConstraint = [...targetConstraintManifest.values()].find((entry) => {
      try {
        return JSON.parse(entry.key)?.[3] === "QualifiedContextFixture_is_unknown_check";
      } catch {
        return false;
      }
    });
    if (recoveryConstraint === undefined) fail("CHECK_RECOVERY_FIXTURE_MISSING");
    const recoveryClient = new Client(config(targetPort, scratchName));
    await recoveryClient.connect();
    let recoveryTransactionOpen = false;
    try {
      await recoveryClient.query("BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY");
      recoveryTransactionOpen = true;
      await recoveryClient.query("SET LOCAL timezone = 'UTC'");
      await recoveryClient.query("SET LOCAL client_encoding = 'UTF8'");
      await recoveryClient.query("SET LOCAL search_path = pg_catalog");
      let injectedFailure = false;
      const recoveryProxy = {
        query: async (sql, values) => {
          if (!injectedFailure && sql.includes("AS check_expression")) {
            injectedFailure = true;
            return recoveryClient.query("SELECT 1 / 0");
          }
          return recoveryClient.query(sql, values);
        },
      };
      const recoveryDetail = await collectCheckConstraintDetail(recoveryProxy, recoveryConstraint);
      if (
        recoveryDetail.ok !== false
        || recoveryDetail.status !== "COLLECTION_UNAVAILABLE"
        || recoveryDetail.stage !== "EXPRESSION_FETCH"
      ) fail("CHECK_RECOVERY_STATUS_MISMATCH");
      await recoveryClient.query("SELECT 1");
      await recoveryClient.query("COMMIT");
      recoveryTransactionOpen = false;
    } finally {
      if (recoveryTransactionOpen) await recoveryClient.query("ROLLBACK").catch(() => {});
      await recoveryClient.end().catch(() => {});
    }

    const targetConstraintMutator = new Client(config(targetPort, scratchName));
    await targetConstraintMutator.connect();
    let changedTargetConstraintManifest;
    let changedCheckDetails;
    try {
      await targetConstraintMutator.query(
        'ALTER TABLE "ConstraintFixture" DROP CONSTRAINT "ConstraintFixture_kind_check"',
      );
      await targetConstraintMutator.query(
        `ALTER TABLE "ConstraintFixture" ADD CONSTRAINT "ConstraintFixture_kind_check"
          CHECK ("kind" IN ('private-alpha', 'private-beta', 'private-delta'))`,
      );
      await targetConstraintMutator.query("BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY");
      await targetConstraintMutator.query("SET LOCAL timezone = 'UTC'");
      await targetConstraintMutator.query("SET LOCAL client_encoding = 'UTF8'");
      await targetConstraintMutator.query("SET LOCAL search_path = pg_catalog");
      changedTargetConstraintManifest = await collectConstraintCatalogManifest(
        targetConstraintMutator,
        "DESTINATION_CONSTRAINT_CATALOG_EVIDENCE_FAILED",
      );
      const candidate = findSingleCheckExpressionMismatch(
        sourceConstraintManifest,
        changedTargetConstraintManifest,
      );
      if (candidate === null) fail("CONSTRAINT_CHECK_DIAGNOSTIC_CANDIDATE_MISSING");
      changedCheckDetails = {
        source: await collectReboundSourceCheckDetail(sourceConfig, candidate.source),
        destination: await collectCheckConstraintDetail(targetConstraintMutator, candidate.destination),
      };
      assertCheckCollection("SOURCE", changedCheckDetails.source);
      assertCheckCollection("DESTINATION", changedCheckDetails.destination);
      await targetConstraintMutator.query("COMMIT");
    } finally {
      await targetConstraintMutator.end().catch(() => {});
    }
    const changedConstraintDiagnostic = buildConstraintSemanticDiagnostic(
      sourceConstraintManifest,
      changedTargetConstraintManifest,
      "MATCH",
      changedCheckDetails,
    );
    if (
      changedConstraintDiagnostic.semanticEqual
      || !changedConstraintDiagnostic.mismatchFields.includes("CHECK_EXPRESSION")
    ) fail("CONSTRAINT_CATALOG_MUTATION_UNDETECTED");
    const checkDifference = changedConstraintDiagnostic.checkExpressionDifference;
    if (checkDifference === null) fail("CONSTRAINT_CHECK_DIAGNOSTIC_DETAIL_MISSING");
    if (checkDifference.status !== "UNIQUE" || checkDifference.limitKind !== null) {
      fail("CONSTRAINT_CHECK_DIAGNOSTIC_COLLECTION_STATUS");
    }
    if (checkDifference.tokenEdit?.status !== "UNIQUE") fail("CONSTRAINT_CHECK_DIAGNOSTIC_TOKEN_STATUS");
    if (checkDifference.tokenEdit.sourceOnly.STRING_LITERAL !== 1) {
      fail("CONSTRAINT_CHECK_DIAGNOSTIC_SOURCE_LITERAL_COUNT");
    }
    if (checkDifference.tokenEdit.destinationOnly.STRING_LITERAL !== 1) {
      fail("CONSTRAINT_CHECK_DIAGNOSTIC_DESTINATION_LITERAL_COUNT");
    }
    if (Object.entries(checkDifference.tokenEdit.sourceOnly).some(
      ([category, count]) => category !== "STRING_LITERAL" && count !== 0,
    )) fail("CONSTRAINT_CHECK_DIAGNOSTIC_SOURCE_EXTRA_CATEGORY");
    if (Object.entries(checkDifference.tokenEdit.destinationOnly).some(
      ([category, count]) => category !== "STRING_LITERAL" && count !== 0,
    )) fail("CONSTRAINT_CHECK_DIAGNOSTIC_DESTINATION_EXTRA_CATEGORY");
    if (!checkDifference.dependencies.identitySetEqual) fail("CONSTRAINT_CHECK_DIAGNOSTIC_DEPENDENCY_IDENTITY");
    if (checkDifference.dependencies.changedClasses.length !== 0) fail("CONSTRAINT_CHECK_DIAGNOSTIC_DEPENDENCY_CLASS");
    if (Object.values(checkDifference.nodeTagDeltas.sourceOnly).some((count) => count !== 0)) {
      fail("CONSTRAINT_CHECK_DIAGNOSTIC_SOURCE_NODE_COUNTS");
    }
    if (Object.values(checkDifference.nodeTagDeltas.destinationOnly).some((count) => count !== 0)) {
      fail("CONSTRAINT_CHECK_DIAGNOSTIC_DESTINATION_NODE_COUNTS");
    }
    if (evidence.source.locale.provider !== "builtin" || JSON.stringify(evidence.source.locale) !== JSON.stringify(evidence.destination.locale)) {
      fail("LOCALE_PROVIDER_PARITY_FAILED");
    }
    const sourceEvent = evidence.source.tables.find((table) => table.name === "Event");
    const destinationEvent = evidence.destination.tables.find((table) => table.name === "Event");
    if (sourceEvent?.rowCount !== 1 || destinationEvent?.rowCount !== 1) fail("SNAPSHOT_BINDING_FAILED");
    if (
      evidence.source.largeObjects.count !== 1
      || evidence.destination.largeObjects.count !== 1
      || evidence.source.largeObjects.contentSha256 !== evidence.destination.largeObjects.contentSha256
    ) fail("LARGE_OBJECT_PARITY_FAILED");
    const archiveSequenceBefore = evidence.archiveSequences.beforeReplay.find((sequence) => sequence.name === "legacy_id_seq");
    const archiveSequenceAfter = evidence.archiveSequences.afterReplay.find((sequence) => sequence.name === "legacy_id_seq");
    if (
      evidence.archiveSequences.tocEntryCount !== 1
      || archiveSequenceBefore?.lastValue === liveSequenceAfterArchive
      || JSON.stringify(archiveSequenceBefore) !== JSON.stringify(archiveSequenceAfter)
    ) fail("ARCHIVE_SEQUENCE_BINDING_FAILED");
    if (readdirSync(tempDir).length !== 0) fail("TEMPORARY_FILE_CLEANUP_FAILED");

    const sourceReadback = new Client(config(sourcePort, "source"));
    await sourceReadback.connect();
    const actualEventCount = Number((await sourceReadback.query('SELECT count(*) AS count FROM "Event"')).rows[0].count);
    const actualSequenceValue = String((await sourceReadback.query('SELECT last_value AS value FROM "legacy_id_seq"')).rows[0].value);
    const actualLargeObject = (await sourceReadback.query(
      "SELECT encode(lo_get($1::oid), 'hex') AS content",
      [largeObjectOid],
    )).rows[0].content;
    const identitiesAfter = await tableIdentities(sourceReadback);
    await sourceReadback.end();
    if (actualEventCount !== 2) fail("CONCURRENT_INSERT_MISSING");
    if (actualSequenceValue !== liveSequenceAfterArchive) fail("CONCURRENT_SEQUENCE_ADVANCE_MISSING");
    if (actualLargeObject !== "00112233445566778899aabbccddeeff") fail("SOURCE_LARGE_OBJECT_MUTATED");
    if (JSON.stringify(identitiesBefore) !== JSON.stringify(identitiesAfter)) fail("SOURCE_SCHEMA_MUTATED");

    const databaseCleanup = await cleanupScratchDatabase({
      targetAdminConfig,
      stateFile,
      artifactDir,
      expectedScratchName: scratchName,
    });
    const runnerCleanup = JSON.parse(readFileSync(join(artifactDir, "runner-cleanup.json"), "utf8"));
    const cleanup = {
      ...databaseCleanup,
      firewallRule: { nameRef: "sha256:2222222222222222", deleted: true },
      ...runnerCleanup,
    };
    const receipt = validatePostgresRestoreRehearsal(evidence, cleanup);
    if (receipt.status !== "POSTGRES_REHEARSAL_VERIFIED" || receipt.cutoverReady !== false) fail("RECEIPT_INVALID");

    const targetReadback = new Client(config(targetPort, "postgres"));
    await targetReadback.connect();
    const scratchRemaining = await targetReadback.query("SELECT 1 FROM pg_database WHERE datname = $1", [scratchName]);
    if (scratchRemaining.rowCount !== 0) fail("SCRATCH_DATABASE_REMAINS");
    unlinkSync(stateFile);
    await targetReadback.query(`CREATE DATABASE "${scratchName}"`);
    let missingStateError = null;
    try {
      await cleanupScratchDatabase({
        targetAdminConfig,
        stateFile,
        artifactDir,
        expectedScratchName: scratchName,
      });
    } catch (error) {
      missingStateError = error?.code;
    }
    const foreignDatabase = await targetReadback.query("SELECT 1 FROM pg_database WHERE datname = $1", [scratchName]);
    if (missingStateError !== "DATABASE_OWNERSHIP_UNPROVEN" || foreignDatabase.rowCount !== 1) {
      fail("MISSING_STATE_CLEANUP_FAILED_OPEN");
    }
    await targetReadback.query(`DROP DATABASE "${scratchName}" WITH (FORCE)`);
    await targetReadback.end();

    process.stdout.write(`${JSON.stringify({ ok: true, status: "POSTGRES_18_SYNTHETIC_REHEARSAL_VERIFIED" })}\n`);
  } finally {
    if (sourceStarted) await run("docker", ["rm", "--force", sourceContainer], "SOURCE_CONTAINER_CLEANUP_FAILED").catch(() => {});
    if (targetStarted) await run("docker", ["rm", "--force", targetContainer], "TARGET_CONTAINER_CLEANUP_FAILED").catch(() => {});
    if (networkCreated) await run("docker", ["network", "rm", network], "NETWORK_CLEANUP_FAILED").catch(() => {});
    rmSync(root, { recursive: true, force: true });
  }
};

main().catch((error) => {
  process.stdout.write(`${JSON.stringify({ ok: false, error: error?.code ?? "SYNTHETIC_REHEARSAL_FAILED" })}\n`);
  process.exitCode = 1;
});
