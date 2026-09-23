import assert from "node:assert/strict";
import { randomBytes, randomUUID } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { retainPostgresArchive, recoverPostgresArchive, validateArchiveKeyVersion } from "./ops-core-archive.mjs";
import { postgresCopyDiagnostic } from "./ops-core-postgres-copy.mjs";

async function fixture(t) {
  const directory = await mkdtemp(join(tmpdir(), "ops-core-archive-"));
  t.after(() => rm(directory, { recursive: true }));
  const dumpFile = join(directory, "source.dump");
  const outputFile = join(directory, "recovered.dump");
  const data = Buffer.concat([Buffer.from("PGDMP"), randomBytes(40_000)]);
  await writeFile(dumpFile, data, { mode: 0o600 });
  const objects = new Map();
  const controller = new AbortController();
  let keyReads = 0;
  let writes = 0;
  const retainedKey = randomBytes(32);
  const store = {
    identity: "synthetic-private-archive",
    afterCreate: () => {},
    async assertPrivate() {},
    async createOnly(name, stream) {
      writes++;
      if (objects.has(name)) throw new Error("already exists");
      const chunks = [];
      for await (const chunk of stream) chunks.push(Buffer.from(chunk));
      objects.set(name, Buffer.concat(chunks));
      this.afterCreate(name);
    },
    async read(name) {
      const data = objects.get(name);
      if (!data) throw new Error("not found");
      return (async function* () {
        // Exercise split magic, nonce, encrypted bytes and final authentication tag.
        for (let i = 0; i < data.length; i += 7) yield data.subarray(i, i + 7);
      })();
    },
  };
  const binding = { domain: "ops", operationId: randomUUID(), intentSha256: "a".repeat(64),
    sourceFenceSha256: "b".repeat(64), sourceRef: `sha256:${"c".repeat(16)}`, targetRef: `sha256:${"d".repeat(16)}` };
  const options = { dumpFile, sourceEvidence: { tables: [], migrations: [] }, sourceSequences: [], binding,
    keyVersion: `https://migration-custody.vault.azure.net/secrets/archive-key/${randomBytes(16).toString("hex")}`,
    vaultName: "migration-custody", store, signal: controller.signal, maxBytes: 100_000,
    async assertOwned() {}, async resolveKey() { keyReads++; return Buffer.from(retainedKey); } };
  const retain = () => retainPostgresArchive(options);
  const recover = (manifest) => recoverPostgresArchive({ manifest, expectedBinding: binding, store,
    outputFile, vaultName: options.vaultName, maxBytes: options.maxBytes, signal: controller.signal, resolveKey: options.resolveKey });
  return { directory, dumpFile, outputFile, data, objects, store, binding, options, controller, retain, recover,
    get keyReads() { return keyReads; }, get writes() { return writes; } };
}

test("encrypted archive is retained and independently recovered with a re-read versioned key", async (t) => {
  const f = await fixture(t);
  const manifest = await f.retain();
  assert.equal(f.keyReads, 2);
  assert.equal(f.objects.size, 3);
  assert.equal(f.objects.get(manifest.archiveKey).includes(f.data), false);
  const receipt = await f.recover(manifest);
  assert.equal(receipt.bytes, f.data.length);
  assert.deepEqual(await readFile(f.outputFile), f.data);
  assert.equal((await stat(f.outputFile)).mode & 0o777, 0o600);
  assert.deepEqual(await readFile(f.dumpFile), f.data);
});

test("ciphertext corruption cannot produce a usable recovery file", async (t) => {
  const f = await fixture(t); const manifest = await f.retain();
  f.objects.get(manifest.archiveKey)[100] ^= 1;
  await assert.rejects(f.recover(manifest), /ARCHIVE_RECOVERY_FAILED/);
  await assert.rejects(stat(f.outputFile), { code: "ENOENT" });
  assert.equal(f.objects.size, 3);
});

test("lost upload acknowledgement preserves ciphertext and source for reconciliation", async (t) => {
  const f = await fixture(t);
  f.store.afterCreate = () => { throw new Error("signed provider URL must not escape"); };
  await assert.rejects(f.retain(), /^Error: ARCHIVE_RETENTION_RECONCILE_REQUIRED$/);
  assert.equal(f.writes, 1);
  assert.equal(f.objects.size, 1);
  assert.deepEqual(await readFile(f.dumpFile), f.data);
});

test("lost custody after ciphertext creation prevents an acceptance manifest", async (t) => {
  const f = await fixture(t);
  f.store.afterCreate = () => f.controller.abort();
  await assert.rejects(f.retain(), /ARCHIVE_RETENTION_RECONCILE_REQUIRED/);
  assert.equal(f.writes, 1);
  assert.equal(f.objects.size, 1);
});

test("recovery never overwrites a preexisting file and rejects another operation binding", async (t) => {
  const f = await fixture(t); const manifest = await f.retain();
  await writeFile(f.outputFile, "unrelated", { mode: 0o600 });
  await assert.rejects(f.recover(manifest), /ARCHIVE_RECOVERY_FAILED/);
  assert.equal(await readFile(f.outputFile, "utf8"), "unrelated");
  f.binding.operationId = randomUUID();
  await assert.rejects(f.recover(manifest), /ARCHIVE_MANIFEST_INVALID/);
});

test("archive custody accepts only an exact version in the intended Azure vault", () => {
  const version = randomBytes(16).toString("hex");
  assert.equal(validateArchiveKeyVersion(`https://migration-custody.vault.azure.net/secrets/archive/${version}`, "migration-custody")
    .endsWith(version), true);
  for (const value of [
    "https://migration-custody.vault.azure.net/secrets/archive",
    `https://foreign.vault.azure.net/secrets/archive/${version}`,
    `https://migration-custody.vault.azure.net/secrets/archive/${version}?credential=private`,
  ]) assert.throws(() => validateArchiveKeyVersion(value, "migration-custody"), /ARCHIVE_KEY_VERSION_INVALID/);
});

test("uppercase provider secrets cannot masquerade as trusted diagnostic codes", async (t) => {
  const f = await fixture(t);
  const secret = randomBytes(24).toString("hex").toUpperCase();
  const providerError = Object.assign(new Error(secret), { code: secret, reason: secret, stage: secret });
  f.store.afterCreate = () => { throw providerError; };
  const retained = await f.retain().catch((error) => error);
  assert.equal(retained.reason, "UNCLASSIFIED_FAILURE");
  assert.equal(JSON.stringify(retained).includes(secret), false);
  const copyDiagnostic = postgresCopyDiagnostic(providerError, "RETAIN_ARCHIVE");
  assert.deepEqual(copyDiagnostic, { stage: "RETAIN_ARCHIVE", code: "UNCLASSIFIED_FAILURE", operationStage: null, reason: null });
  assert.equal(JSON.stringify(postgresCopyDiagnostic(providerError, secret)).includes(secret), false);
  assert.equal(postgresCopyDiagnostic(retained, "RETAIN_ARCHIVE").code, "ARCHIVE_RETENTION_RECONCILE_REQUIRED");
});
