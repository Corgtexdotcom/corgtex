import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import pg from "pg";
import { cleanupScratchDatabase } from "./run-postgres-restore-rehearsal.mjs";
import {
  applyPostgresPromotion, postgresPromotionDurableRecord, preparePostgresPromotion,
  reconcilePostgresPromotion,
} from "./ops-core-postgres-promotion.mjs";

const expectedConnection = { host: "synthetic.postgres.example", port: 5432, database: "postgres", user: "migration_admin" };
const scratchName = "corgtex_rehearsal_123_1_core";
const source = () => ({ name: scratchName, oid: "12001", owner: expectedConnection.user, is_template: false, connection_count: 0 });
const input = (client) => ({ client, expectedConnection: { ...expectedConnection }, domain: "core", scratchName,
  scratchOid: "12001", permanentName: "corgtex_core", targetIdentity: "azure-core", parityEvidenceSha256: "a".repeat(64) });

function admin() {
  const state = { rows: [source()], commands: [], sessionUser: expectedConnection.user, roleUser: expectedConnection.user,
    database: expectedConnection.database, ackFailure: false, rejected: false, disconnected: false, disconnectAfterRename: false,
    onRename: null, identityQueries: 0 };
  const client = {
    connectionParameters: { ...expectedConnection },
    async query(sql, values) {
      state.commands.push(sql);
      if (state.disconnected) throw new Error("private disconnected provider details");
      if (sql.includes("current_database()")) {
        state.identityQueries++;
        return { rows: [{ database: state.database, session_user: state.sessionUser, role_user: state.roleUser }] };
      }
      if (sql.includes("FROM pg_catalog.pg_database")) {
        assert.deepEqual(values, [[scratchName, "corgtex_core"], "12001"]);
        return { rows: structuredClone(state.rows.filter((row) => values[0].includes(row.name) || row.oid === values[1])) };
      }
      if (sql.startsWith("ALTER DATABASE")) {
        assert.equal(sql, `ALTER DATABASE "${scratchName}" RENAME TO "corgtex_core"`);
        if (state.onRename) await state.onRename();
        if (state.rejected) throw new Error("private provider reject details");
        state.rows.find((row) => row.name === scratchName).name = "corgtex_core";
        state.disconnected = state.disconnectAfterRename;
        if (state.ackFailure) throw new Error("private acknowledgement lost");
        return { rows: [] };
      }
      throw new Error("UNEXPECTED_SQL");
    },
  };
  return { client, state };
}

async function fixture() {
  const { client, state } = admin();
  const intent = await preparePostgresPromotion(input(client));
  const controller = new AbortController();
  const stored = { value: null, events: [] };
  const options = { client, intent, signal: controller.signal,
    lease: { async assertHeld({ effect }) { stored.events.push(`lease:${effect}`); } },
    async assertTargetInactive({ effect }) { stored.events.push(`inactive:${effect}`); },
    async persistOperationIntent(record) {
      assert.equal(stored.value, null, "durable callback must CAS-create, never overwrite");
      stored.events.push("persist");
      stored.value = structuredClone(record);
    },
    async readOperationIntent() { stored.events.push("read"); return structuredClone(stored.value); },
  };
  return { client, state, intent, controller, stored, options,
    alterCount: () => state.commands.filter((sql) => sql.startsWith("ALTER DATABASE")).length };
}

test("prepare binds immutable intent to connection, OID, destination and parity without mutation", async () => {
  const { client, state } = admin();
  const args = input(client);
  const intent = await preparePostgresPromotion(args);
  args.expectedConnection.host = "foreign.example";
  assert.equal(intent.expectedConnection.host, expectedConnection.host);
  assert.equal(intent.scratchOid, "12001");
  assert.equal(intent.parityEvidenceSha256, "a".repeat(64));
  assert.throws(() => { intent.scratchOid = "12002"; }, TypeError);
  assert.ok(state.commands.every((sql) => sql.trimStart().startsWith("SELECT")));
});

for (const key of ["host", "port", "database", "user"]) test(`rejects foreign connection ${key} before SQL`, async () => {
  const { client, state } = admin();
  client.connectionParameters[key] = key === "port" ? 5433 : "foreign";
  await assert.rejects(preparePostgresPromotion(input(client)), { code: "ADMIN_CONNECTION_BINDING_MISMATCH" });
  assert.equal(state.commands.length, 0);
});

for (const key of ["sessionUser", "roleUser", "database"]) test(`checks SQL ${key} independently from client config`, async () => {
  const { client, state } = admin();
  state[key] = "foreign";
  await assert.rejects(preparePostgresPromotion(input(client)), { code: "ADMIN_SQL_IDENTITY_MISMATCH" });
});

for (const [name, change] of [
  ["wrong source OID", (state) => { state.rows[0].oid = "12002"; }],
  ["wrong owner", (state) => { state.rows[0].owner = "other"; }],
  ["template database", (state) => { state.rows[0].is_template = true; }],
  ["active source connection", (state) => { state.rows[0].connection_count = 1; }],
  ["existing permanent database", (state) => { state.rows.push({ ...source(), name: "corgtex_core", oid: "12003" }); }],
]) test(`prepare rejects ${name}`, async () => {
  const { client, state } = admin();
  change(state);
  await assert.rejects(preparePostgresPromotion(input(client)), { code: "PROMOTION_PRECONDITIONS_UNPROVEN" });
  assert.equal(state.commands.some((sql) => sql.startsWith("ALTER")), false);
});

test("rejects foreign-domain names and tampered parity intent", async () => {
  const { client } = admin();
  await assert.rejects(preparePostgresPromotion({ ...input(client), permanentName: "corgtex_ops" }), { code: "INVALID_PROMOTION_DESTINATION" });
  await assert.rejects(preparePostgresPromotion({ ...input(client), scratchName: "unowned" }), { code: "INVALID_PROMOTION_SCRATCH" });
  const f = await fixture();
  await assert.rejects(applyPostgresPromotion({ ...f.options, intent: { ...f.intent, parityEvidenceSha256: "b".repeat(64) } }),
    { code: "PROMOTION_INTENT_DIGEST_MISMATCH" });
  assert.equal(f.alterCount(), 0);
});

test("promotes once only after independent durable intent and cleanup marker readback", async () => {
  const f = await fixture();
  const result = await applyPostgresPromotion(f.options);
  assert.equal(result.status, "PROMOTED");
  assert.equal(result.renameAcknowledged, true);
  assert.equal(result.targetInactiveVerified, true);
  assert.equal(f.alterCount(), 1);
  assert.deepEqual(f.stored.value, postgresPromotionDurableRecord(f.intent));
  assert.ok(f.stored.events.indexOf("persist") < f.stored.events.indexOf("lease:ALTER_DATABASE"));
  assert.ok(f.state.commands.every((sql) => !/DROP|CREATE DATABASE|TERMINATE_BACKEND/.test(sql)));
  assert.ok(!JSON.stringify(result).includes(expectedConnection.host));
});

for (const missing of ["lease", "assertTargetInactive", "persistOperationIntent", "readOperationIntent", "signal"]) {
  test(`apply requires ${missing}`, async () => {
    const f = await fixture();
    delete f.options[missing];
    await assert.rejects(applyPostgresPromotion(f.options), { code: "PROMOTION_CUSTODY_REQUIRED" });
    assert.equal(f.alterCount(), 0);
  });
}

for (const shape of ["marker-only", "intent-only", "wrong-oid", "wrong-phase"]) test(`rejects ${shape} durable readback`, async () => {
  const f = await fixture();
  f.options.persistOperationIntent = async (record) => {
    f.stored.value = structuredClone(record);
    if (shape === "marker-only") delete f.stored.value.intent;
    if (shape === "intent-only") delete f.stored.value.cleanupState;
    if (shape === "wrong-oid") f.stored.value.cleanupState.scratchOid = "12002";
    if (shape === "wrong-phase") f.stored.value.cleanupState.phase = "CREATED";
  };
  await assert.rejects(applyPostgresPromotion(f.options), { code: "PROMOTION_DURABILITY_UNPROVEN", reconciliationRequired: true });
  assert.equal(f.alterCount(), 0);
});

test("partial persistence failure blocks rename and does not expose storage errors", async () => {
  const f = await fixture();
  f.options.persistOperationIntent = async (record) => {
    f.stored.value = { intent: record.intent };
    throw new Error("private storage details");
  };
  await assert.rejects(applyPostgresPromotion(f.options), (error) => {
    assert.equal(error.code, "PROMOTION_DURABILITY_UNPROVEN");
    assert.equal(error.cause, undefined);
    assert.ok(!error.message.includes("private"));
    return true;
  });
  assert.equal(f.alterCount(), 0);
});

test("prior durable intent is reconciled without attempting ALTER even when scratch is still prepared", async () => {
  const f = await fixture();
  f.stored.value = postgresPromotionDurableRecord(f.intent);
  const result = await applyPostgresPromotion(f.options);
  assert.equal(result.status, "PREPARED");
  assert.equal(result.priorIntentReconciled, true);
  assert.equal(result.renameAttempted, false);
  assert.equal(f.alterCount(), 0);
});

for (const [name, change] of [
  ["destination created", (state) => { state.rows.push({ ...source(), name: "corgtex_core", oid: "12005" }); }],
  ["scratch replaced", (state) => { state.rows[0].oid = "12005"; }],
  ["connection opened", (state) => { state.rows[0].connection_count = 1; }],
  ["owner changed", (state) => { state.rows[0].owner = "other"; }],
]) test(`rechecks after persistence when ${name}`, async () => {
  const f = await fixture();
  const persist = f.options.persistOperationIntent;
  f.options.persistOperationIntent = async (record) => { await persist(record); change(f.state); };
  await assert.rejects(applyPostgresPromotion(f.options), { code: "PROMOTION_PRECONDITIONS_UNPROVEN" });
  assert.equal(f.alterCount(), 0);
});

test("lease loss, target activity or abort after persistence prevents ALTER", async () => {
  for (const kind of ["lease", "inactive", "abort"]) {
    const f = await fixture();
    const persist = f.options.persistOperationIntent;
    f.options.persistOperationIntent = async (record) => {
      await persist(record);
      if (kind === "lease") f.options.lease.assertHeld = async () => { throw new Error("private lease"); };
      if (kind === "inactive") f.options.assertTargetInactive = async () => false;
      if (kind === "abort") f.controller.abort();
    };
    await assert.rejects(applyPostgresPromotion(f.options), { code: kind === "lease" ? "PROMOTION_CUSTODY_LOST"
      : kind === "inactive" ? "PROMOTION_TARGET_ACTIVITY_UNPROVEN" : "PROMOTION_ABORTED" });
    assert.equal(f.alterCount(), 0);
  }
});

test("lost ALTER acknowledgement reconciles the same promoted OID and cannot trigger replay", async () => {
  const f = await fixture();
  f.state.ackFailure = true;
  const result = await applyPostgresPromotion(f.options);
  assert.equal(result.status, "PROMOTED");
  assert.equal(result.renameAcknowledged, false);
  const retried = await applyPostgresPromotion(f.options);
  assert.equal(retried.status, "PROMOTED");
  assert.equal(retried.renameAttempted, false);
  assert.equal(f.alterCount(), 1);
});

test("a rejected ALTER reconciles PREPARED and never automatically retries", async () => {
  const f = await fixture();
  f.state.rejected = true;
  const result = await applyPostgresPromotion(f.options);
  assert.equal(result.status, "PREPARED");
  assert.equal(result.renameAcknowledged, false);
  assert.equal(f.alterCount(), 1);
});

test("a broken connection after ALTER yields indeterminate acknowledgement evidence", async () => {
  const f = await fixture();
  f.state.ackFailure = true;
  f.state.disconnectAfterRename = true;
  const result = await applyPostgresPromotion(f.options);
  assert.equal(result.status, "INDETERMINATE");
  assert.equal(result.reason, "PROMOTION_READ_FAILED");
  assert.equal(result.targetInactiveVerified, false);
  assert.equal(f.alterCount(), 1);
});

test("abort after an accepted ALTER waits for its acknowledgement and reports actual resulting state", async () => {
  const f = await fixture();
  f.state.onRename = async () => { f.controller.abort(); };
  const result = await applyPostgresPromotion(f.options);
  assert.equal(result.status, "PROMOTED");
  assert.equal(result.renameAcknowledged, true);
  assert.equal(result.custodyVerified, false);
  assert.equal(result.targetInactiveVerified, false);
  assert.equal(f.alterCount(), 1);
});

test("reconcile rejects OID reuse, source recreation and unexpected renamed identity", async () => {
  const f = await fixture();
  for (const rows of [
    [{ ...source(), name: "corgtex_core", oid: "12002" }],
    [{ ...source(), name: "corgtex_core" }, { ...source(), oid: "12002" }],
    [{ ...source(), name: "unexpected_name" }],
  ]) {
    f.state.rows = rows;
    assert.equal((await reconcilePostgresPromotion({ client: f.client, intent: f.intent })).status, "INDETERMINATE");
  }
  assert.equal(f.alterCount(), 0);
});

test("promotion marker invalidates the actual legacy scratch cleanup runner before it can drop a recreated name", async () => {
  const f = await fixture();
  const root = mkdtempSync(join(tmpdir(), "corgtex-promotion-cleanup-"));
  const prototype = pg.Client.prototype;
  const original = { connect: prototype.connect, end: prototype.end, query: prototype.query };
  const queries = [];
  try {
    prototype.connect = async () => {};
    prototype.end = async () => {};
    prototype.query = async (sql) => { queries.push(sql); return { rowCount: 1, rows: [{ present: true }] }; };
    const stateFile = join(root, "scratch-state.json");
    writeFileSync(stateFile, JSON.stringify(postgresPromotionDurableRecord(f.intent).cleanupState), { mode: 0o600 });
    await assert.rejects(cleanupScratchDatabase({ targetAdminConfig: { ...expectedConnection, sslmode: "disable" },
      stateFile, artifactDir: root, expectedScratchName: scratchName }), /INVALID_CLEANUP_STATE/);
    assert.deepEqual(queries, []);
  } finally {
    Object.assign(prototype, original);
    rmSync(root, { recursive: true, force: true });
  }
});
