import assert from "node:assert/strict";
import test from "node:test";
import { randomBytes } from "node:crypto";
import { readFileSync } from "node:fs";
import pg from "pg";
import { WORKER_DEMAND_QUERY, provisionWorkerScalerRole, provisionWorkerScalerRoleInTransaction, validateWorkerScalerConnection, verifyWorkerScalerAccess } from "./worker-demand.mjs";

const database = "worker_demand_synthetic";
const password = () => randomBytes(32).toString("hex");

test("scaler provisioning refuses wrong database and existing role without modifying grants", async () => {
  for (const collision of [false, true]) {
    const calls = [];
    const client = { query: async (sql) => {
      calls.push(sql);
      if (sql.includes("current_database")) return { rows: [{ database: collision ? database : "other_database" }] };
      if (sql.includes("pg_roles")) return { rows: [{}] };
      return { rows: [] };
    } };
    await assert.rejects(provisionWorkerScalerRole({ client, database, role: "worker_scale_fixture", password: password() }),
      { message: collision ? "WORKER_SCALER_ROLE_ALREADY_EXISTS" : "WORKER_SCALER_DATABASE_MISMATCH" });
    assert.equal(calls.at(-1), "ROLLBACK");
    assert.equal(calls.some(sql => sql.startsWith("CREATE ROLE") || sql.startsWith("GRANT")), false);
  }
});

test("untrusted role input never reaches PostgreSQL and driver diagnostics are sanitized", async () => {
  let calls = 0;
  const client = { query: async () => { calls++; throw new Error("private connection or SQL detail"); } };
  await assert.rejects(provisionWorkerScalerRole({ client, database, role: "worker_scale_bad; DROP ROLE x", password: password() }),
    { message: "WORKER_SCALER_ROLE_INPUT_INVALID" });
  assert.equal(calls, 0);
  await assert.rejects(provisionWorkerScalerRole({ client, database, role: "worker_scale_fixture", password: password() }),
    { message: "WORKER_SCALER_ROLE_PROVISION_FAILED" });
});

test("unsafe inherited PUBLIC access rolls back role creation", async () => {
  const calls = [];
  const client = { query: async sql => {
    calls.push(sql);
    if (sql.includes("current_database")) return { rows: [{ database }] };
    if (sql.includes("has_schema_privilege")) return { rows: [{ schema_create: false, broad_access: true, event_payload: false, job_payload: false }] };
    return { rows: [] };
  } };
  await assert.rejects(provisionWorkerScalerRole({ client, database, role: "worker_scale_fixture", password: password() }),
    { message: "WORKER_SCALER_EXCESS_PRIVILEGES" });
  assert.equal(calls.at(-1), "ROLLBACK");
  assert.equal(calls.includes("COMMIT"), false);
});

test("real PostgreSQL demand, active claims, retries, import holds and least privileges", {
  skip: !process.env.WORKER_DEMAND_TEST_DATABASE_URL,
}, async () => {
  const url = new URL(process.env.WORKER_DEMAND_TEST_DATABASE_URL);
  assert.ok(["localhost", "127.0.0.1"].includes(url.hostname));
  assert.equal(url.pathname, `/${database}`);
  assert.ok(url.port && url.username === "postgres" && url.password);
  assert.equal(url.search, "");
  const ssl = { ca: readFileSync(process.env.WORKER_DEMAND_TEST_CA_FILE, "utf8"), rejectUnauthorized: true };
  const admin = new pg.Client({ connectionString: url.href, ssl });
  let scaler;
  try {
    await admin.connect();
    const empty = await admin.query("SELECT count(*)::int AS n FROM pg_tables WHERE schemaname = 'public'");
    assert.equal(empty.rows[0].n, 0, "fixture must be a new empty database");
    await admin.query(`CREATE TABLE "Event" (id text PRIMARY KEY, status text, "lockedAt" timestamptz,
        "availableAt" timestamptz, "workspaceId" text, payload jsonb);
      CREATE TABLE "WorkflowJob" (id text PRIMARY KEY, status text, "dependsOnJobId" text,
        "runAfter" timestamptz, "workspaceId" text, payload jsonb);
      CREATE TABLE "WorkspaceFeatureFlag" ("workspaceId" text, flag text, enabled boolean);
      CREATE TABLE "CustomerPrivateData" (payload text);`);
    const role = "worker_scale_fixture";
    const secret = process.env.WORKER_DEMAND_TEST_SCALER_PASSWORD ?? password();
    const created = await provisionWorkerScalerRole({ client: admin, database, role, password: secret });
    assert.equal(created.created, true);
    assert.equal(created.demand, 0);
    const scalerUrl = new URL(url); scalerUrl.username = role; scalerUrl.password = secret;
    scaler = new pg.Client({ connectionString: scalerUrl.href, ssl }); await scaler.connect();
    assert.deepEqual(await verifyWorkerScalerAccess({ client: scaler, database, role }), { database, role, demand: 0, verifiedTls: true, connectionLimit: 2, access: "queue eligibility columns only; no payload or application write access" });
    const demand = async expected => assert.deepEqual((await scaler.query(WORKER_DEMAND_QUERY)).rows, [{ demand: expected }]);
    await demand(0);
    await admin.query(`INSERT INTO "Event" VALUES ('event', 'PENDING', NULL, now(), 'workspace', '{}')`);
    await demand(1);
    await admin.query(`UPDATE "Event" SET "availableAt" = now() + interval '1 hour'`); await demand(0);
    await admin.query(`UPDATE "Event" SET "availableAt" = now() + interval '0.08 second'`);
    await admin.query("SELECT pg_sleep(0.12)"); await demand(1); // No new queue insert.
    await admin.query(`INSERT INTO "WorkspaceFeatureFlag" VALUES ('workspace', 'operator_import_inactive', true)`); await demand(0);
    await admin.query(`UPDATE "Event" SET "lockedAt" = now()`); await demand(1); // Claimed work drains through a later hold.
    await admin.query(`UPDATE "Event" SET "lockedAt" = now() - interval '6 minutes'`); await demand(1);
    await admin.query(`UPDATE "Event" SET status = 'DISPATCHED'`); await demand(0);
    await admin.query(`DELETE FROM "WorkspaceFeatureFlag";
      INSERT INTO "WorkflowJob" VALUES ('dependency','PENDING',NULL,now()+interval '1 day','workspace','{}'),
        ('job','PENDING','dependency',now(),'workspace','{}')`); await demand(0);
    await admin.query(`UPDATE "WorkflowJob" SET status='COMPLETED' WHERE id='dependency'`); await demand(1);
    await admin.query(`UPDATE "WorkflowJob" SET "runAfter"=now()+interval '1 day' WHERE id='job'`); await demand(0);
    await admin.query(`UPDATE "WorkflowJob" SET status='RUNNING' WHERE id='job';
      INSERT INTO "WorkspaceFeatureFlag" VALUES ('workspace','operator_import_inactive',true)`); await demand(1);
    await admin.query(`UPDATE "WorkflowJob" SET status='COMPLETED' WHERE id='job'`); await demand(0);
    for (const sql of [
      'SELECT payload FROM "Event"', 'SELECT payload FROM "WorkflowJob"', 'SELECT * FROM "CustomerPrivateData"',
      'UPDATE "Event" SET status=\'PENDING\'', 'DELETE FROM "WorkflowJob"', 'CREATE TABLE public.scaler_write (id int)',
    ]) await assert.rejects(scaler.query(sql), { code: "42501" });
    await assert.rejects(provisionWorkerScalerRole({ client: admin, database, role, password: password() }),
      { message: "WORKER_SCALER_ROLE_ALREADY_EXISTS" });
    await demand(0);
  } finally {
    if (scaler) await scaler.end();
    await admin.end();
  }
});


test("scaler secret value binds one Azure database/role and verified TLS without exposing its password", () => {
  const host = "fixture-server.postgres.database.azure.com", role = "worker_scale_fixture";
  const secret = password();
  const connectionString = `postgresql://${role}:${secret}@${host}:5432/${database}?sslmode=verify-full`;
  const binding = { connectionString, host, role, database };
  assert.deepEqual(validateWorkerScalerConnection(binding), { host, role, database, port: 5432, tls: "verify-full" });
  for (const altered of [connectionString.replace(host, "foreign.postgres.database.azure.com"),
    connectionString.replace("verify-full", "require"), connectionString + "&sslmode=disable",
    connectionString + "&hostaddr=127.0.0.1", connectionString + "#extra", connectionString.replace(role, "postgres"),
    connectionString.replace(database, "other_database"), connectionString.replace(":5432", ":6432")]) {
    assert.throws(() => validateWorkerScalerConnection({ ...binding, connectionString: altered }), { message: "WORKER_SCALER_CONNECTION_INVALID" });
  }
  assert.ok(!JSON.stringify(validateWorkerScalerConnection(binding)).includes(secret));
});

test("scaler access probe rejects plaintext, wrong identities and new inherited privileges", async () => {
  const role = "worker_scale_fixture";
  const identity = { database, role, rolsuper: false, rolcreatedb: false, rolcreaterole: false,
    rolreplication: false, rolbypassrls: false, rolconnlimit: 2, memberships: false };
  for (const change of ["plaintext", "database", "role", "rolsuper", "memberships", "excess"]) {
    let calls = 0;
    const client = { connection: { stream: { encrypted: change !== "plaintext", authorized: true } }, query: async sql => {
      calls++;
      if (sql.includes("current_database")) return { rows: [{ ...identity,
        ...(change === "database" || change === "role" ? { [change]: "foreign" } : {}),
        ...(change === "rolsuper" || change === "memberships" ? { [change]: true } : {}) }] };
      return { rows: [{ schema_create: false, broad_access: change === "excess", event_payload: false, job_payload: false }] };
    } };
    await assert.rejects(verifyWorkerScalerAccess({ client, database, role }), { message: change === "plaintext"
      ? "WORKER_SCALER_VERIFIED_TLS_REQUIRED" : change === "excess" ? "WORKER_SCALER_EXCESS_PRIVILEGES" : "WORKER_SCALER_ROLE_IDENTITY_INVALID" });
    if (change === "plaintext") assert.equal(calls, 0);
  }
});


test("transaction body leaves commit/rollback to custody owner and grants scaler only TO admin", async () => {
  const calls = [], role = "worker_scale_fixture";
  const client = { query: async (sql) => {
    calls.push(sql);
    if (sql.includes("current_database")) return { rows: [{ database }] };
    if (sql.includes("AS schema_create")) return { rows: [{ schema_create: false, broad_access: false, event_payload: false, job_payload: false }] };
    if (sql === WORKER_DEMAND_QUERY) return { rows: [{ demand: 0 }] };
    return { rows: [] };
  } };
  const passwordVerifier = `SCRAM-SHA-256$4096:${randomBytes(16).toString("base64")}$${randomBytes(32).toString("base64")}:${randomBytes(32).toString("base64")}`;
  await provisionWorkerScalerRoleInTransaction({ client, database, role, passwordVerifier, administrator: "fixture_admin" });
  assert.equal(calls.some(sql => /^(BEGIN|COMMIT|ROLLBACK)/.test(sql)), false);
  assert.ok(calls.includes('GRANT "worker_scale_fixture" TO "fixture_admin" WITH SET TRUE, INHERIT FALSE'));
  assert.equal(calls.some(sql => sql.startsWith('GRANT "fixture_admin" TO')), false);
  assert.equal(calls.at(-1), "RESET ROLE");
});
