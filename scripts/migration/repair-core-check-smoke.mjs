// Synthetic PG18.6 only. No production credentials; the published port is loopback-only.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { randomBytes, createHash } from "node:crypto";
import pg from "pg";
import { CATALOG_SQL, runCoreCheckRepair, treeDigest, TREE_DIGESTS } from "./repair-core-check.mjs";
import { analyzeSchemaDump } from "./run-postgres-restore-rehearsal.mjs";

const image = "pgvector/pgvector:pg18@sha256:2ba9ca5f2e7daa0f0e7723cba1ee9167bab54efd3640516a44ac1a928dd67e7a";
const name = `corgtex-core-check-smoke-${randomBytes(6).toString("hex")}`;
const docker = (args, input) => execFileSync("docker", args, { input, encoding: "utf8", timeout: 30000, stdio: ["pipe", "pipe", "pipe"] });
const migration = readFileSync(new URL("../../prisma/migrations/20260810224717_constitution_source_references/migration.sql", import.meta.url), "utf8");
const migrationHash = createHash("sha256").update(migration).digest("hex");
const original = `ALTER TABLE public."ConstitutionSourceReference" DROP CONSTRAINT "ConstitutionSource_point_contract_check", ADD CONSTRAINT "ConstitutionSource_point_contract_check" CHECK ("pointOrder" BETWEEN 1 AND 10 AND "sourceOrder" >= 1 AND "pointKey" = 'point-' || "pointOrder"::TEXT);`;
let admin;
let blocker;
let started = false;
const report = { status: "UNPROVEN", productionEffects: 0 };
try {
  docker(["run", "-d", "--rm", "--name", name, "-p", "127.0.0.1::5432", "-e", "POSTGRES_HOST_AUTH_METHOD=trust", "-e", "POSTGRES_DB=railway", image]);
  started = true;
  const mapping = docker(["port", name, "5432/tcp"]).trim();
  assert.match(mapping, /^127\.0\.0\.1:[0-9]+$/u);
  const config = { host: "127.0.0.1", port: Number(mapping.split(":")[1]), user: "postgres", database: "railway", connectionTimeoutMillis: 2000, query_timeout: 10000, ssl: false };
  const client = () => new pg.Client(config);
  const deadline = Date.now() + 30000;
  while (true) {
    admin = client();
    try { await admin.connect(); break; }
    catch { await admin.end().catch(() => {}); assert.ok(Date.now() < deadline); await new Promise(r => setTimeout(r, 100)); }
  }
  await admin.query(migration.slice(0, migration.indexOf("CREATE INDEX")));
  await admin.query("CREATE TABLE public._prisma_migrations (id text PRIMARY KEY, checksum text NOT NULL)");
  await admin.query("INSERT INTO public._prisma_migrations VALUES ('synthetic', $1)", [migrationHash]);
  const insert = (id, point, source, key = `point-${point}`) => admin.query(`INSERT INTO public."ConstitutionSourceReference"
    ("id","workspaceId","constitutionId","pointKey","pointOrder","sourceOrder","policyCorpusId","sourceKind","proposalId","labelSnapshot","acceptedAtSnapshot","updatedAt")
    VALUES ($1,'fixture','fixture',$2,$3,$4,'fixture','PROPOSAL','fixture','fixture','2026-01-01','2026-01-01')`, [id, key, point, source]);
  for (let point = 1; point <= 10; point++) await insert(`valid-${point}`, point, 1);
  const rejectInvalid = async () => {
    for (const [point, source, key] of [[0, 1], [11, 1], [1, 0], [1, 1, "wrong"], [-2147483648, 1], [2147483647, 1]]) {
      await assert.rejects(insert("invalid", point, source, key), error => error.code === "23514");
    }
  };
  await rejectInvalid();
  const comment = "synthetic ' quoted ; comment";
  await admin.query(`COMMENT ON CONSTRAINT "ConstitutionSource_point_contract_check" ON public."ConstitutionSourceReference" IS 'synthetic '' quoted ; comment'`);
  await admin.query("SET search_path=pg_catalog");
  const baseline = (await admin.query(CATALOG_SQL)).rows[0];
  assert.equal(treeDigest(baseline.tree), TREE_DIGESTS.original);
  assert.equal(baseline.comment, comment);
  const dump = () => docker(["exec", name, "pg_dump", "-U", "postgres", "-d", "railway", "--schema-only", "--no-owner", "--no-acl", "--restrict-key=CorgtexSchemaParityV1"]);
  const roundtrip = async (target) => {
    const source = dump();
    await admin.query(`CREATE DATABASE ${target} TEMPLATE template0`);
    docker(["exec", "-i", name, "psql", "-U", "postgres", "-d", target, "-Xq", "-v", "ON_ERROR_STOP=1"], source);
    const destination = docker(["exec", name, "pg_dump", "-U", "postgres", "-d", target, "--schema-only", "--no-owner", "--no-acl", "--restrict-key=CorgtexSchemaParityV1"]);
    return analyzeSchemaDump(source).digest === analyzeSchemaDump(destination).digest;
  };
  assert.equal(await roundtrip("original_roundtrip"), false);
  assert.equal((await runCoreCheckRepair("inspect", client)).state, "original");
  assert.deepEqual((await admin.query(CATALOG_SQL)).rows[0], baseline);
  report.inspectNoMutation = true;

  const wrapped = (intercept) => () => {
    const c = client();
    const query = c.query.bind(c);
    c.query = (sql, args) => intercept(sql, args, query);
    return c;
  };
  const denied = await runCoreCheckRepair("apply", wrapped((sql, args, query) => {
    if (sql.includes("SET LOCAL event_triggers")) throw new Error("synthetic permission denied secret");
    return query(sql, args);
  }));
  assert.equal(denied.status, "ABORTED");
  assert.equal(denied.rollbackVerified, true);
  assert.ok(!JSON.stringify(denied).includes("secret"));
  assert.deepEqual((await admin.query(CATALOG_SQL)).rows[0], baseline);
  report.suppressionFailureStops = true;
  const tls = await runCoreCheckRepair("apply", () => new pg.Client({ ...config, ssl: { rejectUnauthorized: true } }));
  assert.equal(tls.status, "ABORTED");
  report.tlsFailureStops = true;

  blocker = client();
  await blocker.connect();
  await blocker.query('BEGIN; LOCK TABLE public."ConstitutionSourceReference" IN ACCESS SHARE MODE');
  const start = Date.now();
  const locked = await runCoreCheckRepair("apply", client);
  assert.equal(locked.status, "ABORTED");
  assert.ok(Date.now() - start < 5000);
  await blocker.query("ROLLBACK");
  await blocker.end(); blocker = null;
  assert.deepEqual((await admin.query(CATALOG_SQL)).rows[0], baseline);
  report.lockTimeoutStops = true;

  let catalogs = 0;
  const rolledBack = await runCoreCheckRepair("apply", wrapped((sql, args, query) => {
    if (sql === CATALOG_SQL && ++catalogs === 2) throw new Error("synthetic post-DDL failure");
    return query(sql, args);
  }));
  assert.equal(rolledBack.status, "ABORTED");
  assert.equal(rolledBack.rollbackVerified, true);
  assert.deepEqual((await admin.query(CATALOG_SQL)).rows[0], baseline);
  report.postDdlRollback = true;

  await admin.query(`ALTER TABLE public."ConstitutionSourceReference" DROP CONSTRAINT "ConstitutionSource_point_contract_check", ADD CONSTRAINT "ConstitutionSource_point_contract_check" CHECK ("pointOrder">=1)`);
  assert.equal((await runCoreCheckRepair("apply", client)).reason, "CATALOG_DRIFT");
  await admin.query(original);
  await admin.query(`COMMENT ON CONSTRAINT "ConstitutionSource_point_contract_check" ON public."ConstitutionSourceReference" IS 'synthetic '' quoted ; comment'`);
  report.definitionDriftStops = true;
  await admin.query(`CREATE FUNCTION public.block_fixture_ddl() RETURNS event_trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'must be suppressed'; END; $$; CREATE EVENT TRIGGER fixture_guard ON ddl_command_start EXECUTE FUNCTION public.block_fixture_ddl()`);
  const receipts = [];
  const applied = await runCoreCheckRepair("apply", client, r => receipts.push(r));
  assert.equal(applied.status, "APPLIED_AND_VERIFIED");
  assert.equal(receipts[0].status, "COMMITTING");
  const after = (await admin.query(CATALOG_SQL)).rows[0];
  assert.equal(after.comment, comment);
  assert.deepEqual(after.options, baseline.options);
  assert.equal(after.migration_ledger, baseline.migration_ledger);
  assert.equal(after.other_constraints, baseline.other_constraints);
  assert.equal(treeDigest(after.tree), TREE_DIGESTS.canonical);
  await rejectInvalid();
  assert.equal((await admin.query('SELECT count(*)::integer AS count FROM public."ConstitutionSourceReference"')).rows[0].count, 10);
  report.rowAcceptancePreserved = true;
  assert.equal((await admin.query("SHOW event_triggers")).rows[0].event_triggers, "on");
  assert.equal((await runCoreCheckRepair("apply", client)).status, "ALREADY_CANONICAL");
  assert.equal((await runCoreCheckRepair("inspect", client)).state, "canonical");
  report.applyAndRepeatPreserveMetadata = true;
  // Dropping the synthetic guard allows the synthetic restore; this is never source code.
  await admin.query("SET event_triggers=false; DROP EVENT TRIGGER fixture_guard; DROP FUNCTION public.block_fixture_ddl(); SET event_triggers=true");
  assert.equal(await roundtrip("canonical_roundtrip"), true);
  report.canonicalStrictRoundtrip = true;

  await admin.query(original);
  const uncertain = await runCoreCheckRepair("apply", wrapped(async (sql, args, query) => {
    const result = await query(sql, args);
    if (sql === "COMMIT") throw new Error("synthetic lost commit acknowledgement");
    return result;
  }));
  assert.equal(uncertain.status, "COMMIT_OUTCOME_UNCERTAIN");
  assert.equal(uncertain.reconcileBeforeRetry, true);
  assert.equal((await runCoreCheckRepair("inspect", client)).state, "canonical");
  report.uncertainCommitReconciledReadOnly = true;
  assert.equal(createHash("sha256").update(readFileSync(new URL("../../prisma/migrations/20260810224717_constitution_source_references/migration.sql", import.meta.url))).digest("hex"), migrationHash);
  report.status = "LOCAL_SYNTHETIC_REPAIR_VERIFIED";
} catch (error) {
  report.status = "FAILED";
  report.reason = error instanceof assert.AssertionError ? error.message : "LOCAL_FIXTURE_OPERATION_FAILED";
  process.exitCode = 1;
} finally {
  await blocker?.end().catch(() => {});
  await admin?.end().catch(() => {});
  if (started) {
    docker(["stop", "--time", "3", name]);
    let absent = false;
    for (let i = 0; i < 40; i++) {
      try { docker(["inspect", name]); } catch { absent = true; break; }
      await new Promise(r => setTimeout(r, 100));
    }
    report.containerRemoved = absent;
    if (!absent) process.exitCode = 1;
  }
  console.log(JSON.stringify(report, null, 2));
}
