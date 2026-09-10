import { createHash, randomUUID } from "node:crypto";
import { spawn } from "node:child_process";
import { chmodSync, createReadStream, existsSync, linkSync, openSync, closeSync, fsyncSync, readdirSync, readFileSync, statSync, unlinkSync, writeSync } from "node:fs";
import { resolve } from "node:path";
import { createRequire } from "node:module";
import { setTimeout as delay } from "node:timers/promises";
import { inventorySharedTenantSource, quoteIdentifier } from "./shared-tenant-inventory.mjs";
import { exportTenantSnapshot, hashCanonical } from "./shared-tenant-export";
import type { TenantTransferManifest, TransferSqlClient } from "./shared-tenant-transfer-contract";

const require = createRequire(import.meta.url);
const { Client } = require("pg") as { Client: new (config: Record<string, unknown>) => TransferSqlClient & { connect(): Promise<void>; end(): Promise<void> } };
function fail(code: string): never { throw new Error(code); }
const isolatedEnv = () => Object.fromEntries(["PATH", "HOME", "TMPDIR", "DOCKER_HOST", "DOCKER_CONTEXT", "DOCKER_CONFIG"]
  .flatMap((key) => process.env[key] ? [[key, process.env[key]!]] : []));

async function command(program: string, args: string[], options: { env?: NodeJS.ProcessEnv; timeoutMs?: number; archive?: string; maxBytes?: number; stage?: string; diagnostics?: number } = {}) {
  return new Promise<string>((resolveCommand, reject) => {
    const child = spawn(program, args, { env: options.env ?? isolatedEnv(), stdio: ["ignore", "pipe", "pipe"] });
    const stage = options.stage ?? "COMMAND";
    let output = ""; let failure: string | undefined;
    let diagnosticBytes = 0;
    if (options.diagnostics !== undefined) writeSync(options.diagnostics, `\n--- ${stage} ---\n`);
    const diagnostic = (chunk: Buffer) => {
      if (options.diagnostics !== undefined && diagnosticBytes < 2 ** 22) {
        const bounded = chunk.subarray(0, 2 ** 22 - diagnosticBytes);
        writeSync(options.diagnostics, bounded); diagnosticBytes += bounded.length;
      }
    };
    let hardKill: ReturnType<typeof setTimeout> | undefined;
    const stop = (code: string) => {
      if (failure) return;
      failure = code; child.kill("SIGTERM");
      hardKill = setTimeout(() => child.kill("SIGKILL"), 1000);
    };
    child.stdout.on("data", (chunk: Buffer) => { diagnostic(chunk); if (output.length + chunk.length > 2 ** 20) stop(`TRANSFER_COPY_${stage}_OUTPUT_LIMIT`); else output += chunk.toString(); });
    // SQL/provider output can contain customer rows. Only the private log receives it.
    child.stderr.on("data", diagnostic);
    const timeout = setTimeout(() => stop(`TRANSFER_COPY_${stage}_TIMEOUT`), options.timeoutMs ?? 300_000);
    const monitor = setInterval(() => {
      if (options.archive && existsSync(options.archive) && statSync(options.archive).size > options.maxBytes!) stop("TRANSFER_ARCHIVE_LIMIT_EXCEEDED");
    }, 100);
    child.on("error", () => { clearTimeout(timeout); clearTimeout(hardKill); clearInterval(monitor); reject(new Error(`TRANSFER_COPY_${stage}_FAILED`)); });
    child.on("close", (code) => { clearTimeout(timeout); clearTimeout(hardKill); clearInterval(monitor); if (failure || code !== 0) reject(new Error(failure ?? `TRANSFER_COPY_${stage}_FAILED`)); else resolveCommand(output.trim()); });
  });
}
export async function archiveDigest(path: string) {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(path)) hash.update(chunk);
  return hash.digest("hex");
}
function createArchive(path: string) {
  if (existsSync(path)) fail("TRANSFER_OUTPUT_ALREADY_EXISTS");
  const temporary = `${path}.${randomUUID()}.tmp`;
  closeSync(openSync(temporary, "wx", 0o600));
  return temporary;
}
function publishArchive(temporary: string, path: string) {
  chmodSync(temporary, 0o600);
  const descriptor = openSync(temporary, "r");
  try { fsyncSync(descriptor); } finally { closeSync(descriptor); }
  linkSync(temporary, path); unlinkSync(temporary);
}
function bounded(maxBytes: number, timeoutMs: number) {
  if (!Number.isSafeInteger(maxBytes) || maxBytes <= 0 || !Number.isSafeInteger(timeoutMs) || timeoutMs <= 0) fail("TRANSFER_COPY_LIMIT_REQUIRED");
}
function sourceDumpEnv(connectionString: string) {
  let url: URL;
  try { url = new URL(connectionString); } catch { fail("TRANSFER_SOURCE_CONNECTION_INVALID"); }
  if (!["postgres:", "postgresql:"].includes(url.protocol) || !url.hostname || !url.pathname.slice(1) || url.hash) fail("TRANSFER_SOURCE_CONNECTION_INVALID");
  const result: NodeJS.ProcessEnv = { ...isolatedEnv(), PGOPTIONS: "-c default_transaction_read_only=on",
    PGHOST: url.hostname.replace(/^\[|\]$/g, ""), PGPORT: url.port || "5432",
    PGDATABASE: decodeURIComponent(url.pathname.slice(1)), PGUSER: decodeURIComponent(url.username), PGPASSWORD: decodeURIComponent(url.password) };
  const parameters: Record<string, string> = { sslmode: "PGSSLMODE", sslrootcert: "PGSSLROOTCERT", sslcert: "PGSSLCERT", sslkey: "PGSSLKEY",
    sslcrl: "PGSSLCRL", sslpassword: "PGSSLPASSWORD", channel_binding: "PGCHANNELBINDING", connect_timeout: "PGCONNECT_TIMEOUT" };
  const seen = new Set<string>();
  for (const [name, value] of url.searchParams) {
    if (!parameters[name] || seen.has(name) || !value || value.includes("\0")) fail("TRANSFER_SOURCE_CONNECTION_OPTION_UNSUPPORTED");
    seen.add(name);
    if (name === "sslmode" && !["disable", "allow", "prefer", "require", "verify-ca", "verify-full"].includes(value)) fail("TRANSFER_SOURCE_CONNECTION_OPTION_UNSUPPORTED");
    if (name === "channel_binding" && !["disable", "prefer", "require"].includes(value)) fail("TRANSFER_SOURCE_CONNECTION_OPTION_UNSUPPORTED");
    if (name === "connect_timeout" && (!/^\d+$/.test(value) || Number(value) < 1 || Number(value) > 60)) fail("TRANSFER_SOURCE_CONNECTION_OPTION_UNSUPPORTED");
    result[parameters[name]] = value;
  }
  return result;
}
async function copiedSchemaInventory(client: TransferSqlClient) {
  const schemas = (await client.query(`SELECT nspname AS name FROM pg_namespace
    WHERE nspname !~ '^pg_' AND nspname <> 'information_schema' ORDER BY nspname`)).rows.map((row) => String(row.name));
  const tables = (await client.query(`SELECT n.nspname AS schema,c.relname AS name,c.relkind AS kind,c.relispopulated AS populated
    FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
    WHERE n.nspname !~ '^pg_' AND n.nspname <> 'information_schema' AND c.relkind IN ('r','p','m','f')
    ORDER BY n.nspname,c.relname`)).rows;
  const inventory: { schema: string; name: string; kind: string; rows: string | null }[] = [];
  for (const table of tables) inventory.push({
    schema: String(table.schema), name: String(table.name), kind: String(table.kind),
    // pg_dump does not copy foreign table rows by default; never query remote
    // foreign servers during an isolated conversion or a source inventory.
    rows: table.kind === "f" || (table.kind === "m" && !table.populated) ? null : String((await client.query(`SELECT count(*)::text AS count FROM ${quoteIdentifier(String(table.schema))}.${quoteIdentifier(String(table.name))}`)).rows[0].count),
  });
  return { schemas, tables: inventory };
}

/** pg_dump imports this live read-only transaction's snapshot; no source DDL or writes. */
export async function captureSourceCopy(connectionString: string, archive: string, limits: { maxBytes: number; timeoutMs: number }) {
  bounded(limits.maxBytes, limits.timeoutMs);
  const dumpEnv = sourceDumpEnv(connectionString);
  const source = new Client({ connectionString, connectionTimeoutMillis: 15_000, options: "-c default_transaction_read_only=on" });
  const temporary = createArchive(archive);
  try {
    await source.connect();
    await source.query("BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY");
    const exported = (await source.query("SELECT pg_export_snapshot() AS snapshot")).rows[0].snapshot as string;
    const inventory = await inventorySharedTenantSource(source, { existingReadOnlyTransaction: true });
    const copiedSchemas = await copiedSchemaInventory(source);
    // libpq does not expand a URI stored only in PGDATABASE. Keep credentials in
    // discrete libpq environment fields; the process arguments contain no URI.
    await command("pg_dump", ["--format=custom", "--no-owner", "--no-privileges", `--snapshot=${exported}`, `--file=${temporary}`], {
      env: dumpEnv,
      archive: temporary, stage: "CAPTURE_DUMP", ...limits,
    });
    if (statSync(temporary).size > limits.maxBytes) fail("TRANSFER_ARCHIVE_LIMIT_EXCEEDED");
    const receipt = { formatVersion: 1, kind: "CONSISTENT_SOURCE_COPY", capturedAt: new Date().toISOString(),
      exportedSnapshot: exported, bytes: statSync(temporary).size, archiveSha256: await archiveDigest(temporary), inventoryScope: "public", inventory, copiedSchemas };
    await source.query("COMMIT"); publishArchive(temporary, archive);
    return receipt;
  } catch (error) { await source.query("ROLLBACK").catch(() => {}); throw error; }
  finally { await source.end().catch(() => {}); if (existsSync(temporary)) unlinkSync(temporary); }
}

export type CopyConversionOptions = {
  archive: string; archiveSha256: string; maxBytes: number; timeoutMs: number;
  postgresMajor?: 16 | 17 | 18;
  // Must be private: pg_restore errors can include customer SQL and values.
  // Defaults to a unique mode-0600 diagnostic file next to the input archive.
  diagnosticsFile?: string;
};
type IsolatedCopyContext = {
  databaseEnv: NodeJS.ProcessEnv; container: string; postgresMajor: 16 | 17 | 18;
  converterImageId: string; diagnosticsFile: string; diagnostics: number;
};

/** Restores ONLY into a newly owned loopback Docker database with no app/worker. */
async function isolatedCopy<T>(options: CopyConversionOptions, run: (client: TransferSqlClient, context: IsolatedCopyContext) => Promise<T>) {
  bounded(options.maxBytes, options.timeoutMs);
  const postgresMajor = options.postgresMajor ?? 16;
  if (![16, 17, 18].includes(postgresMajor)) fail("TRANSFER_COPY_POSTGRES_MAJOR_INVALID");
  if (!/^[a-f0-9]{64}$/.test(options.archiveSha256) || statSync(options.archive).size > options.maxBytes
    || await archiveDigest(options.archive) !== options.archiveSha256) fail("TRANSFER_ARCHIVE_DIGEST_MISMATCH");
  const name = `corgtex-transfer-copy-${randomUUID()}`;
  const diagnosticsFile = options.diagnosticsFile ?? `${options.archive}.${randomUUID()}.diagnostics.log`;
  const diagnostics = openSync(diagnosticsFile, "wx", 0o600);
  const commandOptions = { diagnostics, timeoutMs: options.timeoutMs };
  let container: string | undefined; let client: InstanceType<typeof Client> | undefined; let primaryError: unknown;
  try {
    container = await command("docker", ["run", "--detach", "--rm", "--pull=missing", "--name", name,
      "-e", "POSTGRES_PASSWORD=synthetic-local-copy", "-e", "POSTGRES_DB=transfer_copy", "-p", "127.0.0.1::5432", `pgvector/pgvector:pg${postgresMajor}`], { ...commandOptions, stage: "CONTAINER_START" });
    if (!/^[a-f0-9]{64}$/.test(container)) fail("TRANSFER_ISOLATED_CONTAINER_IDENTITY_INVALID");
    const port = (await command("docker", ["port", container, "5432"], { ...commandOptions, stage: "CONTAINER_PORT" })).match(/^127\.0\.0\.1:(\d+)$/)?.[1];
    if (!port) fail("TRANSFER_ISOLATED_PORT_INVALID");
    const url = `postgresql://postgres:synthetic-local-copy@127.0.0.1:${port}/transfer_copy`;
    for (let attempt = 0; ; attempt++) {
      client = new Client({ connectionString: url, connectionTimeoutMillis: 1000 });
      try { await client.connect(); break; }
      catch { await client.end().catch(() => {}); if (attempt >= 60) fail("TRANSFER_ISOLATED_DATABASE_UNAVAILABLE"); await delay(100); }
    }
    const databaseEnv = { ...isolatedEnv(), PGDATABASE: url, DATABASE_URL: url };
    const converterImageId = await command("docker", ["inspect", container, "--format", "{{.Image}}"], { ...commandOptions, stage: "CONTAINER_IDENTITY" });
    if (!/^sha256:[a-f0-9]{64}$/.test(converterImageId)) fail("TRANSFER_ISOLATED_IMAGE_IDENTITY_INVALID");
    await command("docker", ["cp", resolve(options.archive), `${container}:/tmp/source.dump`], { ...commandOptions, stage: "ARCHIVE_COPY_IN" });
    await command("docker", ["exec", container, "chmod", "600", "/tmp/source.dump"], { ...commandOptions, stage: "ARCHIVE_PERMISSIONS" });
    await command("docker", ["exec", container, "pg_restore", "--exit-on-error", "--no-owner", "--no-privileges", "--username=postgres", "--dbname=transfer_copy", "/tmp/source.dump"], { ...commandOptions, stage: "RESTORE" });
    return await run(client, { databaseEnv, container, postgresMajor, converterImageId, diagnosticsFile, diagnostics });
  } catch (error) {
    primaryError = error;
    throw error;
  } finally {
    try {
      await client?.end().catch(() => {});
      // Only the exact container created by this invocation. No shared volume cleanup.
      if (container && /^[a-f0-9]{64}$/.test(container)) {
        const cleanupOptions = { diagnostics, timeoutMs: Math.min(options.timeoutMs, 15_000) };
        try {
          await command("docker", ["stop", "--time", "10", container], { ...cleanupOptions, stage: "CONTAINER_STOP" });
        } catch {
          try {
            await command("docker", ["rm", "--force", container], { ...cleanupOptions, stage: "CONTAINER_REMOVE" });
          } catch {
            // A timeout can race successful auto-removal. Confirm absence explicitly.
            let absent = false;
            try {
              absent = await command("docker", ["ps", "--all", "--no-trunc", "--filter", `id=${container}`, "--format", "{{.ID}}"],
                { diagnostics, timeoutMs: Math.min(options.timeoutMs, 5000), stage: "CONTAINER_CLEANUP_VERIFY" }) === "";
            } catch { /* Absence is unproven; report the exact remediation handle. */ }
            if (!absent) {
              const primary = primaryError instanceof Error && /^TRANSFER_[A-Z0-9_]+$/.test(primaryError.message)
                ? primaryError.message : primaryError === undefined ? "NONE" : "UNCLASSIFIED_FAILURE";
              throw new Error(`TRANSFER_ISOLATED_CLEANUP_FAILED container=${container} primary=${primary}; remove the exact owned container with docker rm --force ${container}`);
            }
          }
        }
      }
    } finally { closeSync(diagnostics); }
  }
}

export async function convertSourceCopy(options: CopyConversionOptions & { convertedArchive: string }) {
  const temporary = createArchive(options.convertedArchive);
  try {
    return await isolatedCopy(options, async (client, context) => {
      const { databaseEnv, container, diagnostics } = context;
      const applied = (await client.query('SELECT migration_name, checksum, finished_at, rolled_back_at FROM "_prisma_migrations" ORDER BY started_at')).rows;
      for (const row of applied) {
        const name = String(row.migration_name);
        if (!/^\d{14}_[a-zA-Z0-9_]+$/.test(name) || !row.finished_at || row.rolled_back_at) fail("TRANSFER_SOURCE_MIGRATION_HISTORY_INVALID");
        const file = resolve("prisma/migrations", name, "migration.sql");
        if (!existsSync(file) || createHash("sha256").update(readFileSync(file)).digest("hex") !== row.checksum) fail("TRANSFER_SOURCE_MIGRATION_HISTORY_MISMATCH");
      }
      const before = await inventorySharedTenantSource(client);
      await command(resolve("node_modules/.bin/prisma"), ["migrate", "deploy"], { env: databaseEnv, timeoutMs: options.timeoutMs, diagnostics, stage: "MIGRATE" });
      const inventory = await inventorySharedTenantSource(client);
      const copiedSchemas = await copiedSchemaInventory(client);
      const migrations = readdirSync("prisma/migrations").filter((name) => /^\d{14}_/.test(name)).sort()
        .map((name) => ({ name, sha256: createHash("sha256").update(readFileSync(resolve("prisma/migrations", name, "migration.sql"))).digest("hex") }));
      // Bound the container's output too; the final host copy is checked exactly
      // before publication. Shell text contains only a validated numeric limit.
      await command("docker", ["exec", container, "sh", "-c", `ulimit -f ${Math.ceil(options.maxBytes / 1024)}; exec pg_dump --username=postgres --dbname=transfer_copy --format=custom --no-owner --no-privileges --file=/tmp/converted.dump`], { timeoutMs: options.timeoutMs, diagnostics, stage: "DUMP" });
      await command("docker", ["cp", `${container}:/tmp/converted.dump`, temporary], { timeoutMs: options.timeoutMs, diagnostics, stage: "ARCHIVE_COPY_OUT", archive: temporary, maxBytes: options.maxBytes });
      chmodSync(temporary, 0o600);
      if (statSync(temporary).size > options.maxBytes) fail("TRANSFER_ARCHIVE_LIMIT_EXCEEDED");
      const receipt = { formatVersion: 1, kind: "ISOLATED_SOURCE_CONVERSION", convertedAt: new Date().toISOString(),
        sourceArchiveSha256: options.archiveSha256, convertedArchiveSha256: await archiveDigest(temporary), bytes: statSync(temporary).size,
        converterImageId: context.converterImageId, postgresMajor: context.postgresMajor, diagnosticsFile: context.diagnosticsFile,
        migrationSetSha256: hashCanonical(migrations), migrations, sourceSchemaSha256: before.schemaSha256, inventoryScope: "public", inventory, copiedSchemas };
      publishArchive(temporary, options.convertedArchive); return receipt;
    });
  } finally { if (existsSync(temporary)) unlinkSync(temporary); }
}

export async function exportConvertedCopy(options: CopyConversionOptions, manifest: TenantTransferManifest, limits: { maxRows: number; maxBytes: number }) {
  return isolatedCopy(options, (client) => exportTenantSnapshot(client, manifest, limits));
}
