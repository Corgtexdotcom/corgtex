import assert from "node:assert/strict";
import { test } from "node:test";
import { EventEmitter } from "node:events";
import { createPostgresCopyCustodyGuard, postgresCopyDiagnostic } from "./ops-core-postgres-copy.mjs";
import { openPostgresMaintenance } from "./ops-core-postgres-maintenance.mjs";
import { createRestoreCustodyBoundary } from "./run-postgres-restore-rehearsal.mjs";

test("copy custody identifies the failed guard and stops before later checks", async () => {
  for (const failed of ["JOURNAL", "SOURCE", "TARGET"]) {
    const calls = [];
    const secret = "private provider response";
    const check = component => async () => {
      calls.push(component);
      if (component === failed) throw new Error(secret);
    };
    const signal = new AbortController().signal;
    const guard = createPostgresCopyCustodyGuard({
      custody: { signal, assertOwned: check("JOURNAL") },
      assertSourceFenced: check("SOURCE"), assertTargetInactive: check("TARGET"),
    });
    const boundary = createRestoreCustodyBoundary({ productionMode: true, signal,
      beforeRestore: async () => {}, assertCustody: guard });
    const error = await boundary("CREATE_SCRATCH_DATABASE").catch(value => value);
    const diagnostic = postgresCopyDiagnostic(error, "CAPTURE");
    assert.deepEqual(diagnostic, { stage: "CAPTURE", code: "RESTORE_CUSTODY_LOST",
      operationStage: null, effect: "CREATE_SCRATCH_DATABASE", component: failed, reason: "CHECK_FAILED" });
    assert.equal(calls.at(-1), failed);
    assert.equal(calls.length, ["JOURNAL", "SOURCE", "TARGET"].indexOf(failed) + 1);
    assert.equal(JSON.stringify(diagnostic).includes(secret), false);
  }
});

test("maintenance loss keeps a safe stage without exposing provider details", async () => {
  const signal = new AbortController().signal;
  const guard = createPostgresCopyCustodyGuard({ custody: { signal, assertOwned: async () => {} },
    assertSourceFenced: async () => {
      throw Object.assign(new Error("PG_MAINTENANCE_LOST"), { code: "PG_MAINTENANCE_LOST",
        reason: "LOCK_QUERY", detail: "private SQL connection" });
    }, assertTargetInactive: async () => assert.fail("target guard must not run") });
  const boundary = createRestoreCustodyBoundary({ productionMode: true, signal,
    beforeRestore: async () => {}, assertCustody: guard });
  const error = await boundary("VERIFY_FROZEN_SOURCE_SEQUENCES").catch(value => value);
  const diagnostic = postgresCopyDiagnostic(error, "CAPTURE");
  assert.equal(diagnostic.component, "MAINTENANCE");
  assert.equal(diagnostic.reason, "LOCK_QUERY");
  assert.equal(diagnostic.effect, "VERIFY_FROZEN_SOURCE_SEQUENCES");
  assert.equal(JSON.stringify(diagnostic).includes("private SQL connection"), false);
});

test("an event-driven maintenance loss before the boundary keeps its safe cause", async () => {
  const binding = { host: "fixture.postgres.database.azure.com", port: 5432, database: "postgres", user: "admin" };
  const client = Object.assign(new EventEmitter(), { async connect() {}, async end() {},
    async query(sql) { return sql.includes("session_user")
      ? { rows: [{ database: "postgres", login: "admin", role: "admin" }] }
      : { rows: [{ held: true }] }; } });
  const maintenance = await openPostgresMaintenance({ config: { ...binding, sslmode: "verify-full",
    targetTlsRootCert: "fixture" }, expected: binding, signal: new AbortController().signal,
  assertOwned: async () => {}, clientFactory: () => client });
  try {
    const guard = createPostgresCopyCustodyGuard({ custody: { signal: maintenance.signal,
      assertOwned: async () => {} }, assertSourceFenced: async () => {}, assertTargetInactive: async () => {} });
    const boundary = createRestoreCustodyBoundary({ productionMode: true, signal: maintenance.signal,
      beforeRestore: async () => {}, assertCustody: guard });
    client.emit("error", new Error("private connection details"));
    const error = await boundary("CREATE_SCRATCH_DATABASE").catch(value => value);
    const diagnostic = postgresCopyDiagnostic(error, "CAPTURE");
    assert.equal(diagnostic.code, "RESTORE_CUSTODY_LOST");
    assert.equal(diagnostic.component, "MAINTENANCE");
    assert.equal(diagnostic.reason, "SESSION_ERROR");
    assert.equal(JSON.stringify(diagnostic).includes("private connection details"), false);
  } finally { await maintenance.close(); }
});
