#!/usr/bin/env node

import { randomBytes } from "node:crypto";
import { spawn } from "node:child_process";
import { mkdtempSync, mkdirSync, readFileSync, readdirSync, rmSync, unlinkSync } from "node:fs";
import net from "node:net";
import { join } from "node:path";
import { tmpdir } from "node:os";
import pg from "pg";
import {
  cleanupScratchDatabase,
  runPostgresRestoreRehearsal,
} from "./run-postgres-restore-rehearsal.mjs";
import { validatePostgresRestoreRehearsal } from "./validate-postgres-restore-rehearsal.mjs";

const { Client } = pg;
const SERVER_IMAGE = "pgvector/pgvector:pg18@sha256:2ba9ca5f2e7daa0f0e7723cba1ee9167bab54efd3640516a44ac1a928dd67e7a";
const TEST_PASSWORD = "local-rehearsal-only";
const TEST_READER_PASSWORD = "local-rehearsal-reader-only";

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
  mkdirSync(artifactDir, { mode: 0o700 });
  mkdirSync(tempDir, { mode: 0o700 });
  let networkCreated = false;
  let sourceStarted = false;
  let targetStarted = false;

  try {
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
      "--publish", `127.0.0.1:${targetPort}:5432`,
      "--env", `POSTGRES_PASSWORD=${TEST_PASSWORD}`,
      SERVER_IMAGE,
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
    const targetAdminConfig = {
      host: "127.0.0.1",
      dockerHost: targetContainer,
      dockerPort: 5432,
      port: targetPort,
      user: "postgres",
      password: TEST_PASSWORD,
      database: "postgres",
      sslmode: "disable",
    };
    const scratchName = `corgtex_rehearsal_${suffix}_core`;
    let liveSequenceAfterArchive = null;

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
