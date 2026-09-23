// Local-only integrated fixture, invoked by postgres-restore-rehearsal-smoke.mjs.
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { join } from "node:path";
import { readFile, writeFile } from "node:fs/promises";
import pg from "pg";
import { createCutoverJournal, openCutoverCustody } from "./ops-core-custody.mjs";
import { runOpsCorePostgresCopy, resumeOpsCorePostgresCopy } from "./ops-core-postgres-copy.mjs";
import { reconcileOpsCorePostgresCopy } from "./ops-core-postgres-reconcile.mjs";
import { applyPostgresPromotion, preparePostgresPromotion } from "./ops-core-postgres-promotion.mjs";
import { openPostgresPromotionCustody } from "./ops-core-promotion-custody.mjs";
import { cleanupScratchDatabase } from "./run-postgres-restore-rehearsal.mjs";

const { Client } = pg;
const binding = (config) => ({ host: config.host, port: config.port, database: config.database, user: config.user });

export async function runRetainedPostgresCopyFixture({ root, sourceConfig, targetAdminConfig, sourceAdminConfig, targetLocalConfig, network, interruptAfterCapture = false }) {
  for (const config of [sourceConfig, targetAdminConfig, sourceAdminConfig, targetLocalConfig]) {
    assert.equal(config.host, "127.0.0.1");
    assert.ok(config.port > 1024 && config.port !== 5432);
  }
  assert.match(network, /^corgtex-pg-rehearsal-[a-f0-9]{10}$/);
  const query = async (config, sql, values) => {
    const client = new Client(config);
    try { await client.connect(); return await client.query(sql, values); }
    finally { await client.end().catch(() => {}); }
  };
  await query(sourceAdminConfig, `
    CREATE TABLE public.retained_lifecycle_fixture (
      id serial PRIMARY KEY, status text NOT NULL, archived_at timestamptz,
      dependency_id integer REFERENCES public.retained_lifecycle_fixture(id)
    );
    INSERT INTO public.retained_lifecycle_fixture(status,archived_at) VALUES ('COMPLETED','2026-09-01T00:00:00Z');
    INSERT INTO public.retained_lifecycle_fixture(status,dependency_id) VALUES ('PENDING',1);
    GRANT SELECT ON public.retained_lifecycle_fixture TO rehearsal_reader;
    GRANT SELECT ON public.retained_lifecycle_fixture_id_seq TO rehearsal_reader;
  `);
  const assertSourceFenced = async () => {
    const census = await query(sourceAdminConfig, `SELECT count(*)::integer AS count FROM pg_stat_activity
      WHERE datname=current_database() AND backend_type='client backend' AND pid<>pg_backend_pid() AND usename<>$1`, [sourceConfig.user]);
    assert.equal(census.rows[0].count, 0);
  };
  const assertTargetInactive = async () => {
    const census = await query(targetLocalConfig, "SELECT count(*)::integer AS count FROM pg_stat_activity WHERE usename='retained_runtime'");
    assert.equal(census.rows[0].count, 0);
  };
  let journal = JSON.stringify(createCutoverJournal({ domain: "ops", intentSha256: "a".repeat(64), evidenceSha256: "b".repeat(64) }));
  let etag = 0;
  let held = false;
  const custody = await openCutoverCustody({
    async acquire() { assert.equal(held, false); held = true; return "local-lease"; },
    async renew() { assert.equal(held, true); },
    async release() { held = false; },
    async read() { assert.equal(held, true); return { text: journal, etag }; },
    async write(text, expected) { assert.equal(expected.etag, etag); assert.equal(held, true); journal = text; return { etag: ++etag }; },
  }, "a".repeat(64));
  const objects = new Map();
  const archiveStore = {
    identity: "local-retained-pg-fixture",
    async assertPrivate() {},
    async createOnly(key, stream) {
      assert.equal(objects.has(key), false);
      const chunks = []; for await (const chunk of stream) chunks.push(Buffer.from(chunk));
      objects.set(key, Buffer.concat(chunks));
    },
    async read(key) { assert.ok(objects.has(key)); return (async function* () { yield objects.get(key); })(); },
  };
  const key = randomBytes(32);
  const copyRecords = new Map();
  const operationStore = { async assertPrivate() {}, async readOptional(name) { return copyRecords.get(name) ?? null; },
    async createOnly(name, text) { assert.equal(copyRecords.has(name), false); copyRecords.set(name, text); } };
  try {
    const fence = await custody.begin("SOURCE_FENCED", "c".repeat(64));
    await custody.complete(fence.operationId, "d".repeat(64));
    let interrupt = interruptAfterCapture;
    const copyCustody = { ...custody, async complete(...args) {
      const capture = custody.snapshot().pending?.to === "CAPTURED";
      await custody.complete(...args);
      if (capture && interrupt) { interrupt = false; throw new Error("LOCAL_CAPTURE_ACK_LOST"); }
    } };
    const copyOptions = { domain: "ops", sourceConfig, targetAdminConfig,
      expectedSource: binding(sourceConfig), expectedTarget: binding(targetAdminConfig), scratchName: "corgtex_rehearsal_9821_1_ops",
      artifactDir: join(root, "retained-copy"), dockerNetwork: network, custody: copyCustody, assertSourceFenced, assertTargetInactive,
      archiveStore, operationStore, keyVersion: `https://migration-fixture.vault.azure.net/secrets/archive/${randomBytes(16).toString("hex")}`,
      vaultName: "migration-fixture", maxArchiveBytes: 100 * 1024 * 1024, resolveKey: async () => Buffer.from(key) };
    let copied;
    if (interruptAfterCapture) {
      await assert.rejects(runOpsCorePostgresCopy(copyOptions), /RECONCILIATION_REQUIRED/);
      assert.equal(custody.snapshot().phase, "CAPTURED"); assert.equal(custody.snapshot().pending, null);
      copied = await resumeOpsCorePostgresCopy(copyOptions);
      assert.equal(copied.complete, true, copied.code);
    } else copied = await runOpsCorePostgresCopy(copyOptions);
    assert.equal(custody.snapshot().phase, "RESTORED");
    assert.equal(copied.parity.sourceSequenceParity, "VERIFIED");
    assert.equal(objects.size, 3);
    const reconciled = await reconcileOpsCorePostgresCopy(copyOptions);
    assert.equal(reconciled.complete, true, reconciled.code);
    assert.equal(reconciled.parity.evidenceSha256, copied.parity.evidenceSha256);
    const client = new Client(targetLocalConfig);
    await client.connect();
    try {
      const oid = (await client.query("SELECT oid::text FROM pg_database WHERE datname=$1", [copied.scratchName])).rows[0].oid;
      const intent = await preparePostgresPromotion({ client, expectedConnection: binding(targetLocalConfig), domain: "ops",
        scratchName: copied.scratchName, scratchOid: oid, permanentName: "corgtex_ops", targetIdentity: "local-pg18-fixture",
        parityEvidenceSha256: copied.parity.evidenceSha256 });
      const promotion = await custody.begin("VERIFIED", intent.sha256);
      const promotionRecords = new Map();
      const promotionCustody = await openPostgresPromotionCustody({ custody, intent, stateFile: reconciled.stateFile,
        assertSourceFenced, assertTargetInactive, store: {
          async assertPrivate() {},
          async readOptional(key) { return promotionRecords.get(key) ?? null; },
          async createOnly(key, text) { assert.equal(promotionRecords.has(key), false); promotionRecords.set(key, text); },
        } });
      const receipt = await applyPostgresPromotion({ client, intent, ...promotionCustody });
      assert.equal(receipt.status, "PROMOTED");
      assert.equal(receipt.custodyVerified, true);
      assert.equal(receipt.targetInactiveVerified, true);
      await promotionCustody.recordResult(receipt);
      assert.equal(promotionRecords.size, 2);
      await custody.complete(promotion.operationId, copied.parity.evidenceSha256);
      // A later database reusing the staging name cannot inherit cleanup authority.
      await client.query(`CREATE DATABASE "${copied.scratchName}"`);
      await assert.rejects(cleanupScratchDatabase({ targetAdminConfig, stateFile: copied.stateFile,
        artifactDir: copied.operationDir, expectedScratchName: copied.scratchName }), /INVALID_CLEANUP_STATE/);
      await assert.rejects(cleanupScratchDatabase({ targetAdminConfig, stateFile: reconciled.stateFile,
        artifactDir: reconciled.operationDir, expectedScratchName: copied.scratchName }), /INVALID_CLEANUP_STATE/);
      const retainedMarker = JSON.parse(await readFile(copied.stateFile, "utf8"));
      for (const phase of ["MIGRATION_INTENT", "MIGRATION_ABSENCE_VERIFIED", "MIGRATION_RETAINED"]) {
        const stateFile = join(root, `${phase}.json`);
        await writeFile(stateFile, JSON.stringify({ schemaVersion: "1.0.0", scratchName: copied.scratchName,
          targetRef: retainedMarker.targetRef, phase, ...(phase === "MIGRATION_RETAINED" ? { scratchOid: copied.scratchOid } : {}) }),
        { mode: 0o600, flag: "wx" });
        await assert.rejects(cleanupScratchDatabase({ targetAdminConfig, stateFile,
          artifactDir: copied.operationDir, expectedScratchName: copied.scratchName }), /INVALID_CLEANUP_STATE/);
      }
      assert.equal((await client.query("SELECT count(*)::integer AS count FROM pg_database WHERE datname=$1", [copied.scratchName])).rows[0].count, 1);
      const password = randomBytes(24).toString("hex");
      await client.query(`CREATE ROLE retained_runtime LOGIN PASSWORD '${password}'; GRANT CONNECT ON DATABASE corgtex_ops TO retained_runtime`);
      const grant = new Client({ ...targetLocalConfig, database: "corgtex_ops" });
      try {
        await grant.connect();
        await grant.query("GRANT USAGE ON SCHEMA public TO retained_runtime; GRANT SELECT,INSERT,UPDATE,DELETE ON ALL TABLES IN SCHEMA public TO retained_runtime; GRANT USAGE,SELECT,UPDATE ON ALL SEQUENCES IN SCHEMA public TO retained_runtime");
      } finally { await grant.end().catch(() => {}); }
      const runtime = new Client({ ...targetLocalConfig, database: "corgtex_ops", user: "retained_runtime", password });
      try {
        await runtime.connect();
        const rows = (await runtime.query("SELECT id,status,archived_at IS NOT NULL AS archived,dependency_id FROM retained_lifecycle_fixture ORDER BY id")).rows;
        assert.deepEqual(rows, [{ id: 1, status: "COMPLETED", archived: true, dependency_id: null }, { id: 2, status: "PENDING", archived: false, dependency_id: 1 }]);
        const inserted = await runtime.query("INSERT INTO retained_lifecycle_fixture(status,dependency_id) VALUES ('PENDING',2) RETURNING id");
        assert.equal(inserted.rows[0].id, 3);
      } finally { await runtime.end().catch(() => {}); }
    } finally { await client.end().catch(() => {}); }
    return { status: "RETAINED_POSTGRES_COPY_AND_PROMOTION_VERIFIED", sourceSequenceParity: "VERIFIED", archiveRoundTrip: "VERIFIED",
      runtimeAccess: "VERIFIED", readOnlyReconciliation: "VERIFIED", ...(interruptAfterCapture ? { explicitCapturedContinuation: "VERIFIED" } : {}) };
  } finally { key.fill(0); await custody.close(); }
}
