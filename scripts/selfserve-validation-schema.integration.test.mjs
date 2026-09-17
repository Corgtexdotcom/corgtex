import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { test } from "node:test";
import pg from "pg";
import { AUDITOR_PRIVILEGES_SQL } from "./selfserve-validation-schema.mjs";

const url = new URL(process.env.QA_SCHEMA_TEST_DATABASE_URL || "http://missing");
if (!["localhost", "127.0.0.1"].includes(url.hostname) || url.pathname !== "/corgtex_test"
  || !["postgres:", "postgresql:"].includes(url.protocol)) {
  throw new Error("Set QA_SCHEMA_TEST_DATABASE_URL to an isolated local corgtex_test database");
}

// Exercise PostgreSQL's actual ACL/role semantics. Every fixture, including
// cluster roles, is transactional and rolled back; no application rows change.
for (const namespace of ["public", "private"]) {
  for (const reachable of [false, true]) {
    for (const access of ["SELECT", "USAGE", "UPDATE", "OWNER"]) {
      test(`${namespace} sequence ${access}, ${reachable ? "SET ROLE reachable" : "direct"} principal`, async () => {
        const client = new pg.Client({ connectionString: url.href, connectionTimeoutMillis: 5000 });
        const suffix = randomUUID().replaceAll("-", "");
        const auditor = `qa_auditor_${suffix}`, delegate = `qa_delegate_${suffix}`;
        const schema = namespace === "public" ? "public" : `qa_schema_${suffix}`;
        const sequence = `${schema}.qa_sequence_${suffix}`;
        try {
          await client.connect();
          await client.query("BEGIN");
          await client.query("SET LOCAL statement_timeout = '5s'");
          await client.query("SET LOCAL lock_timeout = '1s'");
          await client.query(`CREATE ROLE ${auditor} NOLOGIN NOINHERIT`);
          await client.query(`CREATE ROLE ${delegate} NOLOGIN NOINHERIT`);
          if (namespace !== "public") await client.query(`CREATE SCHEMA ${schema}`);
          await client.query(`GRANT USAGE ON SCHEMA ${schema} TO ${auditor}, ${delegate}`);
          await client.query(`CREATE SEQUENCE ${sequence}`);
          if (reachable) await client.query(`GRANT ${delegate} TO ${auditor}`);
          await client.query(`SET LOCAL ROLE ${auditor}`);
          assert.equal((await client.query(AUDITOR_PRIVILEGES_SQL)).rows[0].can_write, false, "fixture must start read-only");
          await client.query("RESET ROLE");
          const principal = reachable ? delegate : auditor;
          if (access === "OWNER") await client.query(`ALTER SEQUENCE ${sequence} OWNER TO ${principal}`);
          else await client.query(`GRANT ${access} ON SEQUENCE ${sequence} TO ${principal}`);
          await client.query(`SET LOCAL ROLE ${auditor}`);
          if (reachable) {
            const roles = await client.query("SELECT pg_has_role(current_user, $1, 'MEMBER') AS reachable, pg_has_role(current_user, $1, 'USAGE') AS inherited", [delegate]);
            assert.deepEqual(roles.rows[0], { reachable: true, inherited: false });
          }
          const original = AUDITOR_PRIVILEGES_SQL.replace(/\n    OR EXISTS \(SELECT 1 FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace\n      WHERE n.nspname NOT LIKE 'pg_%'[\s\S]*?'USAGE,UPDATE'\)\)\)/, "");
          assert.notEqual(original, AUDITOR_PRIVILEGES_SQL);
          assert.equal((await client.query(original)).rows[0].can_write, false, "original query misses sequence writes");
          assert.equal((await client.query(AUDITOR_PRIVILEGES_SQL)).rows[0].can_write, access !== "SELECT");
        } finally {
          await client.query("ROLLBACK").catch(() => {});
          await client.end();
        }
      });
    }
  }
}
