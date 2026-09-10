import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { chmodSync, copyFileSync, cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { after, before, test } from "node:test";
import pg from "pg";
import { archiveDigest, captureSourceCopy, convertSourceCopy, exportConvertedCopy } from "./shared-tenant-source-copy";
import type { TenantTransferManifest } from "./shared-tenant-transfer-contract";

const directory = mkdtempSync(resolve(tmpdir(), "corgtex-source-copy-test-"));
chmodSync(directory, 0o700);
const ownedContainers: string[] = [];
const archives = new Map<number, { archive: string; archiveSha256: string }>();
let sourceUrl: string;
const limits = { maxBytes: 30_000_000, timeoutMs: 180_000 };
const currentMigrationCount = readdirSync("prisma/migrations").filter((name) => /^\d{14}_/.test(name)).length;
const workspaceId = randomUUID();
const command = (args: string[]) => execFileSync("docker", args, { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();

async function ownedDatabase(major: 16 | 17 | 18) {
  const id = command(["run", "--detach", "--rm", "--pull=missing", "--name", `corgtex-source-copy-test-${randomUUID()}`,
    "-e", "POSTGRES_PASSWORD=synthetic-test", "-e", "POSTGRES_DB=copy_test", "-p", "127.0.0.1::5432", `pgvector/pgvector:pg${major}`]);
  assert.match(id, /^[a-f0-9]{64}$/); ownedContainers.push(id);
  const port = command(["port", id, "5432"]).match(/^127\.0\.0\.1:(\d+)$/)![1];
  const url = `postgresql://postgres:synthetic-test@127.0.0.1:${port}/copy_test`;
  assert.equal(new URL(url).hostname, "127.0.0.1");
  for (let attempt = 0; ; attempt++) {
    const client = new pg.Client({ connectionString: url });
    try { await client.connect(); return { id, url, client }; }
    catch (error) { await client.end().catch(() => {}); if (attempt === 60) throw error; await delay(100); }
  }
}
async function dump(id: string, name: string) {
  command(["exec", id, "pg_dump", "--username=postgres", "--dbname=copy_test", "--format=custom", "--no-owner", "--no-privileges", `--file=/tmp/${name}.dump`]);
  const archive = resolve(directory, `${name}.dump`);
  command(["cp", `${id}:/tmp/${name}.dump`, archive]); chmodSync(archive, 0o600);
  return { archive, archiveSha256: await archiveDigest(archive) };
}
async function fixture(major: 16 | 17 | 18, count: 132 | 147) {
  const database = await ownedDatabase(major);
  try {
    const schema = resolve(directory, `schema-${major}-${count}-${randomUUID()}`); mkdirSync(schema);
    copyFileSync("prisma/schema.prisma", resolve(schema, "schema.prisma"));
    mkdirSync(resolve(schema, "migrations"));
    copyFileSync("prisma/migrations/migration_lock.toml", resolve(schema, "migrations/migration_lock.toml"));
    const migrations = readdirSync("prisma/migrations").filter((name) => /^\d{14}_/.test(name)).sort().slice(0, count);
    assert.equal(migrations.length, count);
    for (const name of migrations) cpSync(resolve("prisma/migrations", name), resolve(schema, "migrations", name), { recursive: true });
    execFileSync("node_modules/.bin/prisma", ["migrate", "deploy", "--schema", resolve(schema, "schema.prisma")], { env: { ...process.env, DATABASE_URL: database.url }, stdio: "pipe" });
    await database.client.query(`INSERT INTO "Workspace" (id,slug,name,"updatedAt") VALUES ($1,$1,'Synthetic preserved workspace',now())`, [workspaceId]);
    await database.client.query(`INSERT INTO "ModelUsage" (id,"workspaceId",provider,model,"taskType","estimatedCostUsd") VALUES ($1,$2,'synthetic','synthetic','CHAT',123456.123456)`, [randomUUID(), workspaceId]);
    await database.client.query('CREATE SCHEMA synthetic_archive');
    await database.client.query('CREATE TABLE synthetic_archive.history (value numeric)');
    await database.client.query('INSERT INTO synthetic_archive.history VALUES (123456.1234567890123456789)');
    return { database, archive: await dump(database.id, `source-${major}-${count}`) };
  } catch (error) { await database.client.end(); throw error; }
}
before(async () => {
  for (const count of [132, 147] as const) {
    const created = await fixture(16, count);
    if (count === 147) sourceUrl = created.database.url;
    archives.set(count, created.archive); await created.database.client.end();
  }
});
after(() => {
  for (const id of ownedContainers) { try { command(["stop", id]); } catch { /* Own container may already be stopped. */ } }
  rmSync(directory, { recursive: true, force: true });
});

for (const count of [132, 147] as const) test(`isolated conversion preserves historical ${count} data at current ${currentMigrationCount} migrations`, async () => {
  const convertedArchive = resolve(directory, `converted-${count}.dump`);
  const diagnosticsFile = resolve(directory, `converted-${count}.diagnostics.log`);
  const receipt = await convertSourceCopy({ ...archives.get(count)!, ...limits, postgresMajor: 16, convertedArchive, diagnosticsFile });
  assert.equal(receipt.migrations.length, currentMigrationCount);
  assert.equal(receipt.postgresMajor, 16); assert.match(receipt.converterImageId, /^sha256:[a-f0-9]{64}$/);
  assert.equal(receipt.inventoryScope, "public");
  assert.deepEqual(receipt.copiedSchemas.tables.find((table) => table.schema === "synthetic_archive"), { schema: "synthetic_archive", name: "history", kind: "r", rows: "1" });
  assert.equal(receipt.convertedArchiveSha256, await archiveDigest(convertedArchive));
  assert.equal(statSync(convertedArchive).mode & 0o777, 0o600); assert.equal(statSync(diagnosticsFile).mode & 0o777, 0o600);
  assert.equal(receipt.inventory.tables.find((table: { name: string }) => table.name === "_prisma_migrations").rows, String(currentMigrationCount));
  const manifest: TenantTransferManifest = {
    formatVersion: 1, transferId: `synthetic-${count}`, workspaceId, workspaceSlug: workspaceId, schemaSha256: receipt.inventory.schemaSha256,
    tables: { Workspace: { disposition: "copy", reason: "Explicit synthetic fixture" }, ModelUsage: { disposition: "copy", reason: "Explicit synthetic numeric history" }, _prisma_migrations: { disposition: "operator-control", reason: "Isolated schema history" } },
  };
  // Fields added by migrations are classified from the actual converted schema.
  for (const table of ["Workspace", "ModelUsage"]) manifest.tables[table].fields = Object.fromEntries(receipt.inventory.schema.columns
    .filter((column: { table: string; type: string }) => column.table === table && (/^jsonb?$/.test(column.type) || column.type.endsWith("[]")))
    .map((column: { name: string }) => [column.name, { kind: "content", reason: "Synthetic content" }]));
  const snapshot = await exportConvertedCopy({ archive: convertedArchive, archiveSha256: receipt.convertedArchiveSha256, ...limits, postgresMajor: 16 }, manifest, { maxRows: 100, maxBytes: limits.maxBytes });
  const workspace = snapshot.tables.find((table) => table.name === "Workspace")!;
  assert.equal(workspace.rows[0][workspace.columns.findIndex((column) => column.name === "name")], "Synthetic preserved workspace");
  const usage = snapshot.tables.find((table) => table.name === "ModelUsage")!;
  assert.equal(usage.rows[0][usage.columns.findIndex((column) => column.name === "estimatedCostUsd")], "123456.123456");
});

test("restore failures expose only their stage and retain private diagnostics without publishing output", async () => {
  const archive = resolve(directory, "invalid.dump"); writeFileSync(archive, "invalid synthetic archive", { mode: 0o600 });
  const convertedArchive = resolve(directory, "must-not-publish.dump"); const diagnosticsFile = resolve(directory, "invalid.diagnostics.log");
  await assert.rejects(convertSourceCopy({ archive, archiveSha256: await archiveDigest(archive), ...limits, convertedArchive, diagnosticsFile }), /^Error: TRANSFER_COPY_RESTORE_FAILED$/);
  assert.equal(existsSync(convertedArchive), false);
  assert.equal(statSync(diagnosticsFile).mode & 0o777, 0o600);
  assert.match(readFileSync(diagnosticsFile, "utf8"), /--- RESTORE ---/);
  assert.equal(readdirSync(directory).some((name) => name.startsWith("must-not-publish.dump.")), false);
});

test("archive digest and byte limits fail before restoration", async () => {
  await assert.rejects(convertSourceCopy({ ...archives.get(147)!, ...limits, archiveSha256: "0".repeat(64), convertedArchive: resolve(directory, "wrong-digest.dump") }), /TRANSFER_ARCHIVE_DIGEST_MISMATCH/);
  await assert.rejects(convertSourceCopy({ ...archives.get(147)!, ...limits, maxBytes: 1, convertedArchive: resolve(directory, "too-big.dump") }), /TRANSFER_ARCHIVE_DIGEST_MISMATCH/);
});

test("conversion output limit cannot publish a partial archive", async () => {
  const original = archives.get(132)!;
  const convertedArchive = resolve(directory, "bounded-output.dump");
  await assert.rejects(convertSourceCopy({ ...original, ...limits, maxBytes: statSync(original.archive).size + 1, convertedArchive }),
    /TRANSFER_COPY_DUMP_FAILED|TRANSFER_ARCHIVE_LIMIT_EXCEEDED/);
  assert.equal(existsSync(convertedArchive), false);
  assert.equal(readdirSync(directory).some((name) => name.startsWith("bounded-output.dump.")), false);
});

test("read-only capture passes its explicit loopback connection instead of using a local default socket", async () => {
  const archive = resolve(directory, "captured-source.dump");
  const wrapper = resolve(directory, "capture-bin"); mkdirSync(wrapper);
  const record = resolve(directory, "capture-arguments.json");
  const nativeDump = execFileSync("which", ["pg_dump"], { encoding: "utf8" }).trim();
  writeFileSync(resolve(wrapper, "pg_dump"), `#!/usr/bin/env python3
import json,os,subprocess,sys
fd=os.open(${JSON.stringify(record)},os.O_CREAT|os.O_EXCL|os.O_WRONLY,0o600)
os.write(fd,json.dumps({"args":sys.argv[1:],"env":{key:os.environ.get(key) for key in ["PGHOST","PGPORT","PGDATABASE","PGUSER","PGPASSWORD","PGSSLMODE","PGOPTIONS"]}}).encode());os.close(fd)
sys.exit(subprocess.run([${JSON.stringify(nativeDump)},*sys.argv[1:]]).returncode)
`, { mode: 0o700 });
  const previousPath = process.env.PATH;
  let receipt: Awaited<ReturnType<typeof captureSourceCopy>>;
  try {
    process.env.PATH = `${wrapper}:${previousPath}`;
    receipt = await captureSourceCopy(`${sourceUrl}?sslmode=disable`, archive, limits);
  } finally { process.env.PATH = previousPath; }
  assert.equal(receipt.archiveSha256, await archiveDigest(archive));
  assert.equal(statSync(archive).mode & 0o777, 0o600);
  assert.equal(receipt.inventory.tables.find((table: { name: string }) => table.name === "ModelUsage").rows, "1");
  const invocation = JSON.parse(readFileSync(record, "utf8"));
  assert.equal(invocation.args.some((argument: string) => argument.includes("postgresql:") || argument.includes("synthetic-test")), false);
  assert.deepEqual(invocation.env, { PGHOST: "127.0.0.1", PGPORT: new URL(sourceUrl).port, PGDATABASE: "copy_test", PGUSER: "postgres", PGPASSWORD: "synthetic-test", PGSSLMODE: "disable", PGOPTIONS: "-c default_transaction_read_only=on" });
  await assert.rejects(captureSourceCopy(`${sourceUrl}?options=unsafe`, resolve(directory, "invalid-options.dump"), limits), /TRANSFER_SOURCE_CONNECTION_OPTION_UNSUPPORTED/);
});

test("migration checksum mismatch is rejected without publishing a converted archive", async () => {
  const created = await fixture(16, 132);
  try {
    await created.database.client.query(`UPDATE "_prisma_migrations" SET checksum=repeat('0',64) WHERE migration_name=(SELECT min(migration_name) FROM "_prisma_migrations")`);
    const altered = await dump(created.database.id, "altered-history");
    const convertedArchive = resolve(directory, "bad-history.dump");
    await assert.rejects(convertSourceCopy({ ...altered, ...limits, convertedArchive }), /TRANSFER_SOURCE_MIGRATION_HISTORY_MISMATCH/);
    assert.equal(existsSync(convertedArchive), false);
  } finally { await created.database.client.end(); }
});

for (const major of [17, 18] as const) test(`conversion uses matching PostgreSQL ${major} restore and dump clients`, async () => {
  const created = await fixture(major, 147);
  try {
    const convertedArchive = resolve(directory, `converted-major-${major}.dump`);
    const receipt = await convertSourceCopy({ ...created.archive, ...limits, postgresMajor: major, convertedArchive });
    assert.equal(receipt.postgresMajor, major); assert.equal(receipt.migrations.length, currentMigrationCount);
    assert.equal(receipt.convertedArchiveSha256, await archiveDigest(convertedArchive));
    assert.equal(receipt.inventory.tables.find((table: { name: string }) => table.name === "ModelUsage").rows, "1");
  } finally { await created.database.client.end(); }
});
