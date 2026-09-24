import assert from "node:assert/strict";
import { test } from "node:test";
import { buildCreateDatabaseSql, inspectProtectedScratchAccess, protectScratchDatabaseAccess } from "./run-postgres-restore-rehearsal.mjs";
const settings = { encoding: "UTF8", provider: "libc", collation: "C", ctype: "C", providerLocale: null, icuRules: null };
const binding = { scratchName: "corgtex_rehearsal_123_ops", scratchOid: "12345", administrator: "admin" };
function fixture(fault) {
  const calls = [], guards = [];
  let committed = false, allowed = false;
  const client = { async query(sql) {
    calls.push(sql);
    if (fault === "revoke" && sql.startsWith("REVOKE")) throw Error("INJECTED");
    if (sql.startsWith("ALTER DATABASE")) allowed = true;
    if (sql === "COMMIT") { committed = true; if (fault === "lost-ack") throw Error("ACK_LOST"); }
    if (sql === "ROLLBACK" && !committed) allowed = false;
    if (sql.includes("FROM pg_database")) return { rows: [{ oid: fault === "oid" ? "45678" : "12345", owner: fault === "owner" ? "foreign" : "admin", allow_connections: allowed,
      administrator_connect: true, foreign_acl: fault === "acl", foreign_login_connect: fault === "inherited", connections: fault === "connection" ? "1" : "0" }] };
    return { rows: [] };
  } };
  const assertCustody = async stage => { guards.push(stage); if (fault === "custody" && stage === "ENABLE_PROTECTED_SCRATCH_CONNECTIONS") throw Error("CUSTODY_LOST"); };
  return { client, calls, guards, assertCustody, get allowed() { return allowed; } };
}
test("production creation disables connections; ordinary rehearsal SQL is unchanged", () => {
  assert.match(buildCreateDatabaseSql(binding.scratchName, settings, { allowConnections: false }), /ALLOW_CONNECTIONS false$/);
  assert.doesNotMatch(buildCreateDatabaseSql(binding.scratchName, settings), /ALLOW_CONNECTIONS/);
});
test("protected scratch enables connections only after ACL and identity proof, then verifies committed access", async () => {
  const f = fixture();
  assert.equal((await protectScratchDatabaseAccess({ ...binding, ...f })).protectedAccess, true);
  const revoke = f.calls.findIndex(s => s.startsWith("REVOKE")), enable = f.calls.findIndex(s => s.startsWith("ALTER DATABASE"));
  assert(revoke > f.calls.indexOf("BEGIN"));
  assert(f.calls.slice(revoke, enable).some(s => s.includes("foreign_login_connect")));
  assert.equal(f.calls.filter(s => s === "COMMIT").length, 1);
  assert(f.calls.at(-1).includes("foreign_login_connect"));
});
for (const fault of ["oid", "owner", "acl", "inherited", "connection", "revoke", "custody", "lost-ack"]) test(`scratch protection fails closed without replay: ${fault}`, async () => {
  const f = fixture(fault);
  await assert.rejects(() => protectScratchDatabaseAccess({ ...binding, ...f }));
  assert.equal(f.calls.filter(s => s === "BEGIN").length, 1);
  assert.equal(f.calls.filter(s => s === "ROLLBACK").length, 1);
  assert.equal(f.allowed, fault === "lost-ack");
  assert(f.calls.filter(s => s.startsWith("ALTER DATABASE")).length <= 1);
});
for (const patch of [{ foreign_acl: true }, { foreign_login_connect: true }, { administrator_connect: false }, { allow_connections: false }, { oid: "999" }, { owner: "foreign" }]) test(`read-only resumed scratch rejects ${JSON.stringify(patch)}`, async () => {
  const calls = [];
  const client = { async query(sql) { calls.push(sql); return { rows: [{ oid: "12345", owner: "admin", allow_connections: true, administrator_connect: true, foreign_acl: false, foreign_login_connect: false, connections: "0", ...patch }] }; } };
  await assert.rejects(() => inspectProtectedScratchAccess({ ...binding, client, allowConnections: true }));
  assert.equal(calls.length, 1); assert(calls[0].startsWith("SELECT"));
});
