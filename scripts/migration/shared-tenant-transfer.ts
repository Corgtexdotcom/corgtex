import { createRequire } from "node:module";
import { randomUUID } from "node:crypto";
import { closeSync, constants, existsSync, fsyncSync, linkSync, openSync, readFileSync, realpathSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { dirname, isAbsolute, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { BlobServiceClient } from "@azure/storage-blob";
import { inventorySharedTenantSource } from "./shared-tenant-inventory.mjs";
import { exportTenantSnapshot, hashCanonical } from "./shared-tenant-export";
import { importTenantSnapshot, verifyImportedTenant, type TenantImportOptions } from "./shared-tenant-import";
import { AzureBlobObjectStore, copyReferencedObjects, type ObjectCopyManifest } from "./shared-tenant-objects";
import { prepareTenantPublication } from "./shared-tenant-publication";
import { captureSourceCopy, convertSourceCopy, exportConvertedCopy } from "./shared-tenant-source-copy";
import type { TenantTransferManifest, TenantTransferSnapshot, TransferSqlClient } from "./shared-tenant-transfer-contract";

const require = createRequire(import.meta.url);
const { Client } = require("pg") as { Client: new (config: Record<string, unknown>) => TransferSqlClient & { connect(): Promise<void>; end(): Promise<void> } };
const { parse: parseConnectionString } = require("pg-connection-string") as { parse(value: string): Record<string, unknown> };
const repository = realpathSync(resolve(dirname(fileURLToPath(import.meta.url)), "../.."));
function fail(code: string): never { throw new Error(code); }

function args(argv: string[]) {
  const [command, ...values] = argv;
  const options = new Map<string, string>();
  for (let index = 0; index < values.length; index++) {
    const key = values[index];
    if (!key.startsWith("--") || options.has(key)) fail("TRANSFER_ARGUMENT_INVALID");
    if (key === "--execute") { options.set(key, "true"); continue; }
    const value = values[++index];
    if (!value || value.startsWith("--")) fail("TRANSFER_ARGUMENT_VALUE_REQUIRED");
    options.set(key, value);
  }
  const allowed = ["--execute", "--manifest", "--snapshot", "--options", "--receipt", "--output", "--connection", "--max-rows", "--max-bytes", "--archive", "--archive-output", "--archive-sha256", "--timeout-ms", "--postgres-major", "--diagnostics"];
  for (const key of options.keys()) if (!allowed.includes(key)) fail("TRANSFER_ARGUMENT_UNKNOWN");
  if (!["convert-copy", "export-copy", "help"].includes(command)
    && (options.has("--postgres-major") || options.has("--diagnostics"))) fail("TRANSFER_ARGUMENT_NOT_APPLICABLE");
  return { command, options };
}

function privatePath(value: string | undefined, mustExist: boolean) {
  if (!value || !isAbsolute(value)) fail("TRANSFER_ABSOLUTE_PRIVATE_PATH_REQUIRED");
  const resolved = mustExist ? realpathSync(value) : resolve(realpathSync(dirname(value)), value.split("/").at(-1)!);
  const withinRepo = relative(repository, resolved);
  if (withinRepo === "" || (withinRepo !== ".." && !withinRepo.startsWith("../") && !isAbsolute(withinRepo))) fail("TRANSFER_ARTIFACT_MUST_BE_OUTSIDE_REPOSITORY");
  if (mustExist && (!statSync(resolved).isFile() || (statSync(resolved).mode & 0o077))) fail("TRANSFER_INPUT_MUST_BE_PRIVATE_FILE");
  return resolved;
}

function readPrivate<T>(value: string | undefined): T {
  const path = privatePath(value, true);
  if (statSync(path).size > 1024 * 1024 * 1024) fail("TRANSFER_INPUT_LIMIT_EXCEEDED");
  return JSON.parse(readFileSync(path, "utf8")) as T;
}

function readSnapshot(path: string | undefined): TenantTransferSnapshot {
  const value = readPrivate<TenantTransferSnapshot | ReturnType<typeof prepareTenantPublication>>(path);
  if (value && typeof value === "object" && ("publicationSnapshot" in value || "staging" in value)) {
    if (!("publicationSnapshot" in value) || !("staging" in value) || !value.publicationSnapshot || !value.staging) fail("TRANSFER_PREPARED_ARTIFACT_INVALID");
    const { sha256, ...body } = value;
    const { sha256: stagingSha256, ...stagingBody } = value.staging;
    const { sha256: publicationSha256, ...publicationBody } = value.publicationSnapshot;
    if (sha256 !== hashCanonical(body) || stagingSha256 !== hashCanonical(stagingBody)
      || publicationSha256 !== hashCanonical(publicationBody)
      || value.publicationSnapshot.manifestSha256 !== hashCanonical(value.publicationSnapshot.manifest)
      || value.publicationSnapshot.manifest.preparedFromSha256 !== value.staging.sourceSnapshotSha256
      || value.publicationSnapshot.manifest.stagingSha256 !== stagingSha256) fail("TRANSFER_PREPARED_ARTIFACT_DIGEST_MISMATCH");
    return value.publicationSnapshot;
  }
  return value as TenantTransferSnapshot;
}

function writePrivate(value: string | undefined, content: unknown) {
  const path = privatePath(value, false);
  if (existsSync(path)) fail("TRANSFER_OUTPUT_ALREADY_EXISTS");
  const temporary = `${path}.${randomUUID()}.tmp`;
  let descriptor: number | undefined;
  try {
    descriptor = openSync(temporary, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL, 0o600);
    writeFileSync(descriptor, `${JSON.stringify(content, null, 2)}\n`);
    fsyncSync(descriptor); closeSync(descriptor); descriptor = undefined;
    // Exclusive hard link prevents clobbering another process's receipt.
    linkSync(temporary, path); unlinkSync(temporary);
    const directory = openSync(dirname(path), constants.O_RDONLY);
    try { fsyncSync(directory); } finally { closeSync(directory); }
  } finally {
    if (descriptor !== undefined) closeSync(descriptor);
    if (existsSync(temporary)) unlinkSync(temporary);
  }
}

type DatabaseBinding = { host: string; port: number; database: string; user: string };
async function database(role: "SOURCE" | "TARGET", write: boolean, expected?: DatabaseBinding) {
  const connectionString = process.env[`TRANSFER_${role}_DATABASE_URL`];
  if (!connectionString) fail("TRANSFER_DATABASE_ENV_REQUIRED");
  const url = new URL(connectionString);
  if (!["postgres:", "postgresql:"].includes(url.protocol)) fail("TRANSFER_DATABASE_PROTOCOL_INVALID");
  const supportedQueryParameters = new Set(["sslmode", "sslrootcert", "sslcert", "sslkey", "ssl", "uselibpqcompat", "sslnegotiation", "schema"]);
  const seen = new Set<string>();
  for (const [key] of url.searchParams) {
    if (seen.has(key)) fail("TRANSFER_DATABASE_QUERY_PARAMETER_DUPLICATED");
    seen.add(key);
    if (!supportedQueryParameters.has(key)) fail("TRANSFER_DATABASE_QUERY_OVERRIDE_FORBIDDEN");
  }
  const parameters = parseConnectionString(connectionString);
  // Use the same parser as pg, then pass explicit connection fields. A blank
  // URL port must not silently fall back to an ambient PGPORT after validation.
  const port = Number(url.port || 5432);
  if (!Number.isInteger(port) || port < 1 || port > 65535) fail("TRANSFER_DATABASE_PORT_INVALID");
  if (!parameters.host || !parameters.database || !parameters.user) fail("TRANSFER_DATABASE_IDENTITY_REQUIRED");
  if (write && (!expected || expected.host !== parameters.host || expected.port !== port
    || expected.database !== parameters.database || expected.user !== parameters.user)) {
    fail("TRANSFER_EXACT_TARGET_BINDING_REQUIRED");
  }
  const client = new Client({ ...parameters, port, connectionTimeoutMillis: 15_000,
    application_name: `corgtex_tenant_transfer_${role.toLowerCase()}`,
    ...(write ? {} : { options: "-c default_transaction_read_only=on" }) });
  await client.connect();
  if (write) {
    try {
      const identity = (await client.query("SELECT current_database() AS database, current_user AS user")).rows[0];
      if (identity.database !== expected!.database || identity.user !== expected!.user) fail("TRANSFER_TARGET_DATABASE_IDENTITY_MISMATCH");
    } catch (error) { await client.end(); throw error; }
  }
  return client;
}

function blobStore(role: "SOURCE" | "TARGET", binding: { account: string; container: string }) {
  const connectionString = process.env[`TRANSFER_${role}_STORAGE_CONNECTION_STRING`];
  if (!connectionString || !/^[a-z0-9]{3,24}$/.test(binding.account) || !binding.container) fail("TRANSFER_STORAGE_BINDING_REQUIRED");
  const container = BlobServiceClient.fromConnectionString(connectionString).getContainerClient(binding.container);
  const url = new URL(container.url);
  if (url.protocol !== "https:" || url.hostname !== `${binding.account}.blob.core.windows.net`
    || decodeURIComponent(url.pathname) !== `/${binding.container}`) fail("TRANSFER_STORAGE_IDENTITY_MISMATCH");
  return new AzureBlobObjectStore(container);
}

export async function runTenantTransferCli(argv: string[]) {
  const { command, options } = args(argv);
  if (command === "help" || !command) {
    console.log("Tenant transfer: inventory | prepare-publication | capture-copy | convert-copy | export-copy | export | copy-objects | import | verify-inactive. Use --output /private/file.json. convert-copy/export-copy accept --postgres-major 16|17|18 (default16) and --diagnostics /private/file.log (default: output path + .diagnostics.log). prepare-publication writes a private wrapper accepted as --snapshot by import and verify-inactive. Database URLs and storage credentials are read only from TRANSFER_SOURCE_* and TRANSFER_TARGET_* environment variables. Import and copy-objects require --execute; import options require exact targetBinding. This CLI never activates a workspace, changes a customer primary or retires a source.");
    return;
  }
  // Fail before a mutation if the immutable receipt cannot be created.
  const output = privatePath(options.get("--output"), false);
  if (existsSync(output)) fail("TRANSFER_OUTPUT_ALREADY_EXISTS");
  if (command === "prepare-publication") {
    const original = readPrivate<TenantTransferSnapshot>(options.get("--snapshot"));
    const policy = readPrivate<Parameters<typeof prepareTenantPublication>[1]>(options.get("--options"));
    const prepared = prepareTenantPublication(original, policy);
    writePrivate(output, prepared);
    console.log(JSON.stringify({ status: "PUBLICATION_PREPARED", sourceSnapshotSha256: original.sha256,
      publicationSnapshotSha256: prepared.publicationSnapshot.sha256, stagingSha256: prepared.staging.sha256 }));
    return;
  }
  if (["capture-copy", "convert-copy", "export-copy"].includes(command)) {
    const limits = { maxBytes: Number(options.get("--max-bytes")), timeoutMs: Number(options.get("--timeout-ms")) };
    let result: unknown;
    if (command === "capture-copy") {
      const archive = privatePath(options.get("--archive-output"), false);
      if (archive === output) fail("TRANSFER_DISTINCT_OUTPUTS_REQUIRED");
      const url = process.env.TRANSFER_SOURCE_DATABASE_URL;
      if (!url) fail("TRANSFER_DATABASE_ENV_REQUIRED");
      result = await captureSourceCopy(url, archive, limits);
    } else {
      const major = options.get("--postgres-major") ?? "16";
      if (!["16", "17", "18"].includes(major)) fail("TRANSFER_COPY_POSTGRES_MAJOR_INVALID");
      const diagnosticsFile = privatePath(options.get("--diagnostics") ?? `${output}.diagnostics.log`, false);
      const copy = { ...limits, archive: privatePath(options.get("--archive"), true), archiveSha256: options.get("--archive-sha256") ?? "",
        postgresMajor: Number(major) as 16 | 17 | 18, diagnosticsFile };
      if ([output, copy.archive].includes(diagnosticsFile)) fail("TRANSFER_DISTINCT_OUTPUTS_REQUIRED");
      if (existsSync(diagnosticsFile)) fail("TRANSFER_OUTPUT_ALREADY_EXISTS");
      if (command === "convert-copy") {
        const convertedArchive = privatePath(options.get("--archive-output"), false);
        if ([output, copy.archive, diagnosticsFile].includes(convertedArchive)) fail("TRANSFER_DISTINCT_OUTPUTS_REQUIRED");
        result = await convertSourceCopy({ ...copy, convertedArchive });
      } else {
        result = await exportConvertedCopy(copy, readPrivate<TenantTransferManifest>(options.get("--manifest")), {
          maxRows: Number(options.get("--max-rows")), maxBytes: limits.maxBytes,
        });
      }
    }
    writePrivate(output, result);
    console.log(JSON.stringify({ status: command === "capture-copy" ? "SOURCE_COPY_CAPTURED" : command === "convert-copy" ? "ISOLATED_COPY_CONVERTED" : "CONVERTED_TENANT_EXPORTED" }));
    return;
  }
  if (command === "copy-objects") {
    if (!options.has("--execute")) fail("TRANSFER_EXECUTE_REQUIRED");
    const config = readPrivate<{ manifest: ObjectCopyManifest; source: { account: string; container: string }; target: { account: string; container: string } }>(options.get("--manifest"));
    const receipt = await copyReferencedObjects(blobStore("SOURCE", config.source), blobStore("TARGET", config.target), config.manifest);
    writePrivate(output, receipt);
    console.log(JSON.stringify({ status: "OBJECTS_VERIFIED", entries: receipt.entries.length, receiptSha256: receipt.sha256 }));
    return;
  }
  if (command === "import") {
    if (!options.has("--execute")) fail("TRANSFER_EXECUTE_REQUIRED");
    const snapshot = readSnapshot(options.get("--snapshot"));
    const config = readPrivate<Omit<TenantImportOptions, "sourceEncryptionKey" | "targetEncryptionKey" | "objectReceipt"> & { targetBinding: DatabaseBinding }>(options.get("--options"));
    if ("sourceEncryptionKey" in config || "targetEncryptionKey" in config) fail("TRANSFER_KEYS_MUST_USE_ENVIRONMENT");
    const receipt = readPrivate<TenantImportOptions["objectReceipt"]>(options.get("--receipt"));
    const client = await database("TARGET", true, config.targetBinding);
    try {
      const result = await importTenantSnapshot(client, snapshot, { ...config, objectReceipt: receipt,
        sourceEncryptionKey: process.env.TRANSFER_SOURCE_ENCRYPTION_KEY,
        targetEncryptionKey: process.env.TRANSFER_TARGET_ENCRYPTION_KEY });
      writePrivate(output, result.receipt);
      console.log(JSON.stringify({ status: result.held ? "IMPORTED_INACTIVE" : "ALREADY_IMPORTED_ACTIVE", alreadyImported: result.alreadyImported, transferId: snapshot.manifest.transferId }));
    } finally { await client.end(); }
    return;
  }
  if (options.has("--connection") && !["source", "target"].includes(options.get("--connection")!)) fail("TRANSFER_CONNECTION_INVALID");
  const role = command === "verify-inactive" ? "TARGET" : options.get("--connection") === "target" ? "TARGET" : "SOURCE";
  if (!["inventory", "export", "verify-inactive"].includes(command)) fail("TRANSFER_COMMAND_INVALID");
  if (command === "export" && role !== "SOURCE") fail("TRANSFER_EXPORT_SOURCE_REQUIRED");
  const client = await database(role, false);
  try {
    if (command === "inventory") {
      const inventory = await inventorySharedTenantSource(client);
      writePrivate(output, inventory);
      console.log(JSON.stringify({ status: "INVENTORIED", tables: inventory.tables.length, workspaces: inventory.workspaces.length, schemaSha256: inventory.schemaSha256 }));
    } else if (command === "export") {
      const manifest = readPrivate<TenantTransferManifest>(options.get("--manifest"));
      const snapshot = await exportTenantSnapshot(client, manifest, {
        ...(options.has("--max-rows") ? { maxRows: Number(options.get("--max-rows")) } : {}),
        ...(options.has("--max-bytes") ? { maxBytes: Number(options.get("--max-bytes")) } : {}),
      });
      writePrivate(output, snapshot);
      console.log(JSON.stringify({ status: "EXPORTED", tables: snapshot.tables.length, snapshotSha256: snapshot.sha256 }));
    } else {
      const snapshot = readSnapshot(options.get("--snapshot"));
      await client.query("BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY");
      try {
        await client.query("SET LOCAL TimeZone = 'UTC'");
        await client.query("SET LOCAL DateStyle = 'ISO, YMD'");
        await client.query("SET LOCAL extra_float_digits = 3");
        await client.query("SET LOCAL bytea_output = 'hex'");
        const marker = (await client.query('SELECT enabled, config FROM public."WorkspaceFeatureFlag" WHERE "workspaceId"=$1 AND flag=$2', [snapshot.manifest.workspaceId, "operator_import_inactive"])).rows[0];
        const receipt = (marker?.config as { transferReceipt?: Record<string, unknown> } | undefined)?.transferReceipt;
        if (marker?.enabled !== true || receipt?.sourceSnapshotSha256 !== snapshot.sha256) fail("TRANSFER_MATCHING_INACTIVE_IMPORT_REQUIRED");
        await verifyImportedTenant(client, snapshot, receipt);
        await client.query("COMMIT");
        writePrivate(output, { status: "INACTIVE_IMPORT_VERIFIED", verifiedAt: new Date().toISOString(), receipt });
        console.log(JSON.stringify({ status: "INACTIVE_IMPORT_VERIFIED", transferId: snapshot.manifest.transferId }));
      } catch (error) { await client.query("ROLLBACK").catch(() => {}); throw error; }
    }
  } finally { await client.end(); }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  runTenantTransferCli(process.argv.slice(2)).catch((error: unknown) => {
    // Provider and SQL errors can include credentials or customer row values.
    const message = error instanceof Error ? error.message : "";
    // Publication failures may append a private table name. Preserve only the
    // stable code; never echo SQL, provider text or that identifying suffix.
    const cleanup = /^TRANSFER_ISOLATED_CLEANUP_FAILED container=([a-f0-9]{64}) primary=(TRANSFER_[A-Z0-9_]+|NONE|UNCLASSIFIED_FAILURE); remove the exact owned container with docker rm --force \1$/.exec(message);
    const code = cleanup ? "TRANSFER_ISOLATED_CLEANUP_FAILED" : /^TRANSFER_[A-Z_]+$/.test(message) ? message
      : /^PUBLICATION_[A-Z_]+(?::|$)/.exec(message)?.[0].replace(/:$/, "") ?? "TRANSFER_FAILED";
    console.error(JSON.stringify({ status: "FAILED", code, ...(cleanup ? {
      containerId: cleanup[1], primaryCode: cleanup[2], cleanupCommand: `docker rm --force ${cleanup[1]}`,
    } : {}) }));
    process.exitCode = 1;
  });
}
