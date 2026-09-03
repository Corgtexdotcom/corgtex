#!/usr/bin/env node

import { randomBytes, X509Certificate } from "node:crypto";
import { spawn } from "node:child_process";
import { chmodSync, mkdtempSync, mkdirSync, readFileSync, readdirSync, rmSync, unlinkSync, writeFileSync } from "node:fs";
import net from "node:net";
import { join } from "node:path";
import { tmpdir } from "node:os";
import pg from "pg";
import {
  buildConstraintSemanticDiagnostic,
  cleanupScratchDatabase,
  collectConstraintCatalogManifest,
  probeTargetClientConnection,
  runPostgresRestoreRehearsal,
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

const fail = (code) => {
  const error = new Error(code);
  error.code = code;
  throw error;
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
    await sourceBootstrap.end();

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

    const targetConstraintMutator = new Client(config(targetPort, scratchName));
    await targetConstraintMutator.connect();
    let changedTargetConstraintManifest;
    try {
      await targetConstraintMutator.query(
        'ALTER TABLE "ConstraintFixture" DROP CONSTRAINT "ConstraintFixture_kind_check"',
      );
      await targetConstraintMutator.query(
        `ALTER TABLE "ConstraintFixture" ADD CONSTRAINT "ConstraintFixture_kind_check"
          CHECK ("kind" IN ('private-alpha', 'private-beta', 'private-delta'))`,
      );
      await targetConstraintMutator.query("BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY");
      await targetConstraintMutator.query("SET LOCAL search_path = pg_catalog");
      changedTargetConstraintManifest = await collectConstraintCatalogManifest(
        targetConstraintMutator,
        "DESTINATION_CONSTRAINT_CATALOG_EVIDENCE_FAILED",
      );
      await targetConstraintMutator.query("COMMIT");
    } finally {
      await targetConstraintMutator.end().catch(() => {});
    }
    const changedConstraintDiagnostic = buildConstraintSemanticDiagnostic(
      sourceConstraintManifest,
      changedTargetConstraintManifest,
    );
    if (
      changedConstraintDiagnostic.semanticEqual
      || !changedConstraintDiagnostic.mismatchFields.includes("CHECK_EXPRESSION")
    ) fail("CONSTRAINT_CATALOG_MUTATION_UNDETECTED");
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
