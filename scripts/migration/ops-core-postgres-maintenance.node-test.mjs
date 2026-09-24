import assert from "node:assert/strict";
import { test } from "node:test";
import { EventEmitter } from "node:events";
import { openPostgresMaintenance } from "./ops-core-postgres-maintenance.mjs";

function fixture() {
  const controller = new AbortController();
  const expected = { host: "fixture.postgres.database.azure.com", port: 5432, database: "postgres", user: "admin" };
  let held = true, closed = false, acquired = 0;
  const client = Object.assign(new EventEmitter(), {
    async connect() {}, async end() { closed = true; },
    async query(sql) {
      if (sql.includes("session_user")) return { rows: [{ database: "postgres", login: "admin", role: "admin" }] };
      if (sql.includes("pg_try_advisory_lock")) acquired++;
      return { rows: [{ held }] };
    },
  });
  return { options: { config: { ...expected, sslmode: "verify-full", targetTlsRootCert: "fixture" }, expected,
    signal: controller.signal, assertOwned: async () => {}, clientFactory: () => client },
  client, controller, lose: () => { held = false; }, closed: () => closed, acquired: () => acquired };
}

test("one shared maintenance session is held, rechecked and closed", async () => {
  const f = fixture(), lease = await openPostgresMaintenance(f.options);
  assert.equal(f.acquired(), 1); await lease.assertHeld();
  await lease.close(); assert.equal(f.closed(), true);
  assert.equal(lease.signal.aborted, true);
  await assert.rejects(lease.assertHeld(), /PG_MAINTENANCE_LOST/);
});
test("another maintenance owner is refused without retries", async () => {
  const f = fixture(); f.lose();
  await assert.rejects(openPostgresMaintenance(f.options), /PG_MAINTENANCE_ALREADY_OWNED/);
  assert.equal(f.acquired(), 1); assert.equal(f.closed(), true);
});
test("loss of server lock or source custody aborts the operation", async () => {
  for (const type of ["lock", "connection", "source"]) {
    const f = fixture(), lease = await openPostgresMaintenance(f.options);
    if (type === "lock") f.lose();
    if (type === "connection") f.client.emit("error", new Error("private connection details"));
    if (type === "source") f.controller.abort();
    await assert.rejects(lease.assertHeld(), /PG_MAINTENANCE_LOST/);
    assert.equal(lease.signal.aborted, true); await lease.close();
  }
});
test("an application database cannot define a separate maintenance lock scope", async () => {
  const f = fixture(); f.options.config.database = "corgtex_core";
  await assert.rejects(openPostgresMaintenance(f.options), /PG_MAINTENANCE_BINDING_INVALID/);
  assert.equal(f.acquired(), 0);
});
