import assert from "node:assert/strict";
import { test } from "node:test";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { archiveEvidenceHash as hash, retainPostgresArchive } from "./ops-core-archive.mjs";
import { reconcileOpsCorePostgresCopy, postgresCopyCaptureIntent, postgresCopyRestoreIntent, postgresCopyRecordKey, postgresCopyObservedParity } from "./ops-core-postgres-reconcile.mjs";
import { resumeOpsCorePostgresCopy } from "./ops-core-postgres-copy.mjs";

const ref = value => `sha256:${createHash("sha256").update(value).digest("hex").slice(0, 16)}`;
const evidence = () => ({ server: { majorVersion: 18 }, locale: { encoding: "UTF8", collation: "C", ctype: "C", provider: "builtin",
  providerLocale: "C.UTF-8", icuRules: null, collationVersion: "1", actualCollationVersion: "1" },
  extensions: [{ name: "plpgsql", version: "1.0" }, { name: "vector", version: "0.8.2" }], schema: { algorithm: "PG_DUMP_SQL_TOKENS_V1", digest: "a".repeat(64) },
  tables: [{ schema: "public", name: "WorkflowJob", rowCount: 1, rowSha256: "b".repeat(64) }],
  largeObjects: { count: 1, contentSha256: "c".repeat(64) },
  migrations: { rows: [{ name: "20260901000000_init", checksum: "d".repeat(64), state: "FINISHED", appliedStepsCount: 1 }],
    counts: { finished: 1, rolledBack: 0, incomplete: 0 } },
  queues: { event: { statuses: [{ status: "PENDING", count: 0 }], lockedCount: 0 },
    workflowJob: { statuses: [{ status: "COMPLETED", count: 1 }], lockedCount: 0 } } });

async function fixture(t, phase = "CAPTURED") {
  const directory = await mkdtemp(join(tmpdir(), "postgres-reconcile-")); t.after(() => rm(directory, { recursive: true, force: true }));
  const controller = new AbortController(), records = new Map(), objects = new Map(), log = [];
  const globalSha = "a".repeat(64), captureId = randomUUID(), sourceFenceSha256 = "b".repeat(64);
  const sourceConfig = { host: "source.invalid", port: 5432, database: "source", user: "reader" };
  const targetAdminConfig = { host: "target.invalid", port: 5432, database: "postgres", user: "administrator" };
  const key = randomBytes(32), scratchName = "corgtex_rehearsal_fixture", scratchOid = "12345";
  const sourceEvidence = evidence(), sequences = [{ schema: "public", name: "id_seq", lastValue: "41", isCalled: true }];
  let destination = structuredClone(sourceEvidence), observedSequences = structuredClone(sequences), empty = true, actualOid = scratchOid;
  const archiveStore = { identity: "private-reconcile-fixture", async assertPrivate() {},
    async createOnly(name, stream) {
      assert.equal(objects.has(name), false); const chunks = [];
      for await (const chunk of stream) chunks.push(Buffer.from(chunk)); objects.set(name, Buffer.concat(chunks));
    },
    async read(name) { assert.ok(objects.has(name)); return (async function* () { yield objects.get(name); })(); } };
  const operationStore = { async assertPrivate() {}, async readOptional(name) { return records.get(name) ?? null; },
    async createOnly(name, text) { assert.equal(records.has(name), false); records.set(name, text); log.push("retain"); } };
  const o = { domain: "ops", sourceConfig, targetAdminConfig, expectedSource: { ...sourceConfig }, expectedTarget: { ...targetAdminConfig },
    scratchName, artifactDir: directory, archiveStore, operationStore, keyVersion: `https://fixture.vault.azure.net/secrets/archive/${"c".repeat(32)}`,
    vaultName: "fixture", maxArchiveBytes: 100000, resolveKey: async () => { log.push("decrypt-key"); return Buffer.from(key); },
    async assertSourceFenced() { log.push("fence"); }, async assertTargetInactive() { log.push("inactive"); } };
  const captureIntent = postgresCopyCaptureIntent(o), captureIntentSha256 = hash(captureIntent);
  const binding = { domain: "ops", operationId: captureId, intentSha256: globalSha, sourceFenceSha256,
    sourceRef: ref(`${sourceConfig.host}\0${sourceConfig.database}`), targetRef: ref(`${targetAdminConfig.host}\0${scratchName}`) };
  const checkpoint = { type: "POSTGRES_COPY_CAPTURE", schemaVersion: 1, binding, captureIntent,
    captureIntentSha256, scratchOid, scratchOwner: targetAdminConfig.user };
  const captureKey = postgresCopyRecordKey("ops", globalSha, captureId); records.set(captureKey, JSON.stringify(checkpoint));
  const dumpFile = join(directory, "original.dump"), plaintext = Buffer.concat([Buffer.from("PGDMP"), randomBytes(1024)]);
  await writeFile(dumpFile, plaintext, { mode: 0o600 });
  const manifest = await retainPostgresArchive({ dumpFile, sourceEvidence, sourceSequences: sequences, binding,
    keyVersion: o.keyVersion, vaultName: o.vaultName, store: archiveStore, assertOwned: async () => {}, signal: controller.signal,
    maxBytes: o.maxArchiveBytes, resolveKey: o.resolveKey });
  const journal = { domain: "ops", intentSha256: globalSha, destinationMayHaveWritten: false, phase: "SOURCE_FENCED",
    history: [{ phase: "SOURCE_FENCED", evidenceSha256: sourceFenceSha256 }],
    pending: { to: "CAPTURED", operationId: captureId, intentSha256: captureIntentSha256 } };
  const custody = { signal: controller.signal, snapshot: () => structuredClone(journal),
    async assertOwned() { controller.signal.throwIfAborted(); },
    async begin(to, intentSha256) { assert.equal(journal.pending, null); log.push(`begin:${to}`);
      journal.pending = { to, operationId: randomUUID(), intentSha256 }; return structuredClone(journal.pending); },
    async complete(operationId, evidenceSha256) {
      assert.equal(operationId, journal.pending.operationId); log.push(`complete:${journal.pending.to}`);
      journal.phase = journal.pending.to; journal.history.push({ phase: journal.phase, operationId,
        intentSha256: journal.pending.intentSha256, evidenceSha256 }); journal.pending = null;
    } };
  o.custody = custody;
  async function captured() { if (journal.pending?.to === "CAPTURED") await custody.complete(captureId, manifest.sha256); }
  async function restoredPending() {
    await captured(); const restore = await custody.begin("RESTORED", hash(postgresCopyRestoreIntent(manifest, o)));
    records.set(postgresCopyRecordKey("ops", globalSha, restore.operationId), JSON.stringify({ type: "POSTGRES_COPY_RESTORE", schemaVersion: 1,
      captureOperationId: captureId, checkpointSha256: hash(checkpoint), archiveManifestSha256: manifest.sha256,
      restoreOperationId: restore.operationId, restoreIntentSha256: restore.intentSha256 })); empty = false;
  }
  if (phase === "RESTORED") await restoredPending();
  const dependencies = {
    async inspectArchive({ tempDir, assertCustody }) {
      await assertCustody(); assert.deepEqual(await readFile(join(tempDir, "snapshot.dump")), plaintext); log.push("inspect-decrypted-dump");
      return { tocEntryCount: sequences.length };
    },
    async inspectScratch({ assertCustody, requireProtectedAccess, expectedScratchOid }) { await assertCustody(); assert.equal(requireProtectedAccess, true); assert.equal(expectedScratchOid, checkpoint.scratchOid); log.push("scratch-read"); return { databaseOid: actualOid, databaseOwner: targetAdminConfig.user, empty, protectedAccess: true }; },
    async observe({ config, assertCustody }) { await assertCustody(); const source = config.host === sourceConfig.host;
      log.push(source ? "source-read" : "destination-read");
      if (!source && empty) throw Error("missing application tables");
      return { databaseOid: source ? "999" : actualOid, evidence: structuredClone(source ? sourceEvidence : destination),
        sequences: structuredClone(source ? sequences : observedSequences) }; },
    async restoreArchive({ assertCustody, scratchOid: oid, scratchOwner, tempDir }) {
      await assertCustody(); assert.equal(journal.pending.to, "RESTORED"); assert.equal(oid, actualOid);
      assert.equal(scratchOwner, targetAdminConfig.user); assert.equal(empty, true);
      assert.deepEqual(await readFile(join(tempDir, "snapshot.dump")), plaintext);
      log.push("restore"); empty = false;
    },
  };
  log.length = 0;
  return { o, dependencies, journal, custody, manifest, records, objects, checkpoint, captureKey, log, controller, sourceEvidence,
    captured, restoredPending, setOid(value) { actualOid = value; }, setEmpty(value) { empty = value; },
    destination, observedSequences, reconcile: () => reconcileOpsCorePostgresCopy(o, dependencies),
    resume: () => resumeOpsCorePostgresCopy(o, dependencies) };
}

test("CAPTURED reconciliation actually decrypts remote archive and verifies frozen source without restore", async t => {
  const f = await fixture(t); const result = await f.reconcile();
  assert.equal(result.complete, true); assert.equal(result.nextAction, "RESTORE_RETAINED_ARCHIVE");
  assert.equal(f.journal.phase, "CAPTURED"); assert.equal(f.journal.pending, null);
  assert.ok(f.log.includes("inspect-decrypted-dump")); assert.ok(f.log.includes("source-read"));
  assert.equal(f.log.includes("restore"), false); assert.equal(f.log.includes("destination-read"), false);
});

test("RESTORED reconciliation requires fresh full parity and retains evidence before completing", async t => {
  const f = await fixture(t, "RESTORED");
  postgresCopyObservedParity({ checkpoint: f.checkpoint, binding: f.checkpoint.binding,
    source: { evidence: f.sourceEvidence, sequences: f.observedSequences }, archive: { tocEntryCount: 1 } },
  { databaseOid: "12345", evidence: f.destination, sequences: f.observedSequences });
  const result = await f.reconcile();
  assert.equal(result.complete, true); assert.equal(result.parity.sourceSequenceParity, "VERIFIED");
  assert.equal(f.journal.phase, "RESTORED"); assert.equal(f.journal.pending, null);
  assert.ok(f.log.includes("destination-read")); assert.equal(f.log.includes("restore"), false);
  assert.ok(f.log.indexOf("retain") < f.log.indexOf("complete:RESTORED"));
  assert.equal(JSON.parse(f.records.get(result.evidenceKey)).evidence.destination.tables[0].rowSha256, "b".repeat(64));
  assert.equal(JSON.parse(await readFile(result.stateFile, "utf8")).scratchName, f.o.scratchName);
  assert.equal(JSON.parse(await readFile(result.stateFile, "utf8")).phase, "MIGRATION_RETAINED");
  assert.equal(JSON.parse(await readFile(result.stateFile, "utf8")).scratchOid, "12345");
});

for (const corrupt of ["checkpoint-missing", "oid", "owner", "intent", "fence", "archive-evidence", "ciphertext", "manifest-missing"]) {
  test(`capture reconciliation leaves phase pending for ${corrupt}`, async t => {
    const f = await fixture(t);
    if (corrupt === "checkpoint-missing") f.records.delete(f.captureKey);
    if (corrupt === "oid") f.setOid("12346");
    if (corrupt === "owner") { f.checkpoint.scratchOwner = "foreign"; f.records.set(f.captureKey, JSON.stringify(f.checkpoint)); }
    if (corrupt === "intent") f.journal.pending.intentSha256 = "e".repeat(64);
    if (corrupt === "fence") f.journal.history[0].evidenceSha256 = "e".repeat(64);
    if (corrupt === "archive-evidence") f.objects.set(`${f.checkpoint.binding.operationId}.evidence.json`, Buffer.from("{}"));
    if (corrupt === "ciphertext") f.objects.get(f.manifest.archiveKey)[100] ^= 1;
    if (corrupt === "manifest-missing") f.objects.delete(`${f.checkpoint.binding.operationId}.manifest.json`);
    const result = await f.reconcile(); assert.equal(result.complete, false); assert.equal(result.status, "INCOMPLETE");
    assert.equal(f.journal.pending.to, "CAPTURED"); assert.equal(f.log.some(x => x.startsWith("complete:")), false);
    assert.equal(f.log.includes("restore"), false);
  });
}

for (const field of ["schema", "tables", "largeObjects", "queues", "migrations", "sequences"]) test(`fresh restored ${field} drift cannot be accepted`, async t => {
  const f = await fixture(t, "RESTORED");
  if (field === "schema") f.destination.schema.digest = "e".repeat(64);
  if (field === "tables") f.destination.tables[0].rowSha256 = "e".repeat(64);
  if (field === "largeObjects") f.destination.largeObjects.contentSha256 = "e".repeat(64);
  if (field === "queues") f.destination.queues.workflowJob.lockedCount = 1;
  if (field === "migrations") f.destination.migrations.rows[0].checksum = "e".repeat(64);
  if (field === "sequences") f.observedSequences[0].lastValue = "42";
  assert.equal((await f.reconcile()).complete, false); assert.equal(f.journal.pending.to, "RESTORED");
  assert.equal(f.log.includes("restore"), false);
});

test("changed frozen source and lost custody cannot finish restoration", async t => {
  const f = await fixture(t, "RESTORED"); f.sourceEvidence.tables[0].rowCount++;
  assert.equal((await f.reconcile()).code, "POSTGRES_FROZEN_SOURCE_CHANGED");
  const g = await fixture(t, "RESTORED"); g.controller.abort();
  assert.equal((await g.reconcile()).complete, false); assert.equal(g.journal.pending.to, "RESTORED");
});

test("explicit captured continuation publishes RESTORED before its only restore, then freshly reconciles", async t => {
  const f = await fixture(t); await f.captured(); f.log.length = 0;
  const result = await f.resume(); assert.equal(result.complete, true); assert.equal(result.phase, "RESTORED");
  assert.ok(f.log.indexOf("begin:RESTORED") < f.log.indexOf("restore"));
  assert.ok(f.log.indexOf("retain") < f.log.indexOf("restore"));
  assert.equal(f.log.filter(x => x === "restore").length, 1);
  assert.equal(f.journal.pending, null); assert.ok(f.log.includes("destination-read"));
});

test("nonempty scratch cannot start explicit restore and inherited restore is never replayed", async t => {
  const f = await fixture(t); await f.captured(); f.setEmpty(false);
  await assert.rejects(f.resume(), /POSTGRES_COPY_SCRATCH_NOT_EMPTY/); assert.equal(f.journal.pending, null);
  const g = await fixture(t, "RESTORED"); await assert.rejects(g.resume(), /POSTGRES_COPY_RESTORE_ALREADY_ATTEMPTED/);
  assert.equal(g.log.includes("restore"), false);
});

test("lost restore acknowledgement is reconciled read-only and never dispatched twice", async t => {
  const f = await fixture(t); await f.captured();
  const actual = f.dependencies.restoreArchive;
  f.dependencies.restoreArchive = async args => { await actual(args); throw Error("lost response"); };
  await assert.rejects(f.resume()); assert.equal(f.journal.pending.to, "RESTORED");
  await assert.rejects(f.resume(), /POSTGRES_COPY_RESTORE_ALREADY_ATTEMPTED/);
  assert.equal((await f.reconcile()).complete, true);
  assert.equal(f.log.filter(x => x === "restore").length, 1);
});

test("lost immutable proof acknowledgement preserves pending restoration and permits exact readback completion", async t => {
  const f = await fixture(t, "RESTORED"); const create = f.o.operationStore.createOnly;
  let lose = true;
  f.o.operationStore.createOnly = async (...args) => { await create(...args); if (lose) { lose = false; throw Error("lost proof response"); } };
  assert.equal((await f.reconcile()).complete, false); assert.equal(f.journal.pending.to, "RESTORED");
  assert.equal((await f.reconcile()).complete, true); assert.equal(f.log.includes("restore"), false);
});

for (const phase of ["CAPTURED", "RESTORED"]) test(`lost ${phase} completion acknowledgement reopens using retained operation lineage`, async t => {
  const f = await fixture(t, phase), complete = f.custody.complete;
  let lose = true;
  f.custody.complete = async (...args) => { await complete(...args); if (lose) { lose = false; throw Error("lost completion acknowledgement"); } };
  assert.equal((await f.reconcile()).complete, false);
  assert.equal(f.journal.phase, phase); assert.equal(f.journal.pending, null);
  const result = await f.reconcile(); assert.equal(result.complete, true); assert.equal(result.phase, phase);
  assert.equal(f.log.includes("restore"), false);
});

test("missing restore checkpoint cannot be inferred from otherwise matching destination contents", async t => {
  const f = await fixture(t, "RESTORED");
  f.records.delete(postgresCopyRecordKey("ops", f.journal.intentSha256, f.journal.pending.operationId));
  const result = await f.reconcile(); assert.equal(result.complete, false);
  assert.equal(result.code, "POSTGRES_RESTORE_CHECKPOINT_CHANGED"); assert.equal(f.journal.pending.to, "RESTORED");
});

test("lost first restore checkpoint acknowledgement never starts or replays restoration", async t => {
  const f = await fixture(t); await f.captured(); const create = f.o.operationStore.createOnly;
  f.o.operationStore.createOnly = async (...args) => { await create(...args); throw Error("lost restore checkpoint acknowledgement"); };
  await assert.rejects(f.resume()); assert.equal(f.journal.pending.to, "RESTORED");
  await assert.rejects(f.resume(), /POSTGRES_COPY_RESTORE_ALREADY_ATTEMPTED/);
  assert.equal((await f.reconcile()).complete, false); assert.equal(f.journal.pending.to, "RESTORED");
  assert.equal(f.log.includes("restore"), false);
});

for (const protectedAccess of [undefined, false]) test(`resume rejects missing/unprotected scratch ACL proof: ${protectedAccess}`, async t => {
  const f = await fixture(t);
  const inspect = f.dependencies.inspectScratch;
  f.dependencies.inspectScratch = async args => ({ ...await inspect(args), protectedAccess });
  const result = await f.reconcile();
  assert.equal(result.complete, false);
  assert.equal(result.code, "POSTGRES_SCRATCH_ACCESS_UNPROTECTED");
  assert.equal(f.log.includes("restore"), false);
  assert.equal(f.journal.pending.to, "CAPTURED");
});
