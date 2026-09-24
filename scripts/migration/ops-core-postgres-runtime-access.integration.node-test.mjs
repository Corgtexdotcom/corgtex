import assert from "node:assert/strict";
import { test } from "node:test";
import { execFileSync, spawnSync } from "node:child_process";
import { randomBytes, randomUUID } from "node:crypto";
import { cpSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import pg from "pg";
import { openPostgresMaintenance } from "./ops-core-postgres-maintenance.mjs";
import { createScratchDatabase, inspectProtectedScratchAccess, protectScratchDatabaseAccess } from "./run-postgres-restore-rehearsal.mjs";

// Opt in explicitly; this cached private fixture image is not a public pull target.
// CORGTEX_RUNTIME_ACCESS_LOCAL_TEST=1 [CORGTEX_RUNTIME_ACCESS_PG_IMAGE=sha256:<cached-id>]
// node --test scripts/migration/ops-core-postgres-runtime-access.integration.node-test.mjs
// An alternate preloaded image must contain PG18 and vector 0.8.2; no image is pulled.
const IMAGE = process.env.CORGTEX_RUNTIME_ACCESS_PG_IMAGE ?? "sha256:dcb131869da366a7f5a9f38f12e4d57fa19d99e786959d048be67d26470c3b36";
const LABEL = "corgtex.runtime-access-fixture";
const { Client } = pg;
const qi = value => `"${value.replaceAll('"', '""')}"`;
const ql = value => `'${value.replaceAll("'", "''")}'`;

// Explicit local qualification: no provider clients, live credentials or remote Docker endpoint.
test("PG18 runtime ownership after real baseline restore preserves Prisma, isolation and recovery", { timeout: 300_000, skip: process.env.CORGTEX_RUNTIME_ACCESS_LOCAL_TEST !== "1" }, async () => {
  assert.match(IMAGE, /^sha256:[a-f0-9]{64}$/);
  const api = await import("./ops-core-postgres-runtime-access.mjs");
  const runId = randomUUID(), directory = mkdtempSync(join(tmpdir(), "corgtex-runtime-access-"));
  const evidenceDir = resolve(".artifacts/postgres-runtime-access", runId); mkdirSync(evidenceDir, { recursive: true, mode: 0o700 });
  const receipt = { runId, scope: "LOCAL_SYNTHETIC_ONLY", image: IMAGE, checks: [], startedAt: new Date().toISOString() };
  let containerId, stage = "SETUP";
  const clients = new Set();
  const dockerHost = execFileSync("docker", ["context", "inspect", "--format", "{{.Endpoints.docker.Host}}"], { encoding: "utf8", timeout: 10000 }).trim();
  assert.match(dockerHost, /^unix:\/\//);
  writeFileSync(join(directory, "config.json"), "{}", { mode: 0o600 });
  const docker = (...args) => {
    const r = spawnSync("docker", ["--config", directory, "--host", dockerHost, ...args], { encoding: "utf8", timeout: 60000, maxBuffer: 16 * 1024 * 1024 });
    if (r.error || r.status !== 0) {
      receipt.dockerDiagnostic = { exitCode: r.status, extensionOwner: /must be owner of extension/.test(r.stderr), schemaExists: /schema .* already exists/.test(r.stderr), permissionDenied: /permission denied/.test(r.stderr) };
      throw Error("LOCAL_DOCKER_COMMAND_FAILED");
    }
    return r.stdout.trim();
  };
  const password = randomBytes(32).toString("hex"), administratorPassword = randomBytes(32).toString("hex"), legitimatePassword = randomBytes(32).toString("hex");
  const passwords = Object.fromEntries(["core", "ops"].map(domain => [domain, { runtime: randomBytes(32).toString("hex"), scaler: randomBytes(32).toString("hex") }]));
  let endpoint, ca;
  const connect = async (database, user = "fixture_admin", pw = administratorPassword) => {
    const client = new Client({ ...endpoint, database, user, password: pw, ssl: { ca, rejectUnauthorized: true }, connectionTimeoutMillis: 3000, query_timeout: 20000 });
    client.on("error", () => {}); clients.add(client);
    try { await client.connect(); return client; } catch (e) { await client.end().catch(() => {}); clients.delete(client); throw e; }
  };
  const close = async client => { await client.end(); clients.delete(client); };
  const deniedConnect = async (database, user, pw) => { let client; try { client = await connect(database, user, pw); } catch (error) { assert.equal(error.code, "42501"); return; } if (client) await close(client); assert.fail("FOREIGN_DATABASE_CONNECTION_ACCEPTED"); };
  const mark = name => { receipt.checks.push(name); writeFileSync(join(evidenceDir, "receipt.json"), JSON.stringify(receipt, null, 2) + "\n", { mode: 0o600 }); };
  try {
    const openssl = args => execFileSync("openssl", args, { stdio: "ignore", timeout: 10000 });
    openssl(["req", "-x509", "-newkey", "rsa:2048", "-nodes", "-keyout", join(directory, "ca.key"), "-out", join(directory, "ca.crt"), "-days", "1", "-subj", "/CN=Corgtex local fixture CA", "-addext", "basicConstraints=critical,CA:TRUE", "-addext", "keyUsage=critical,keyCertSign,cRLSign"]);
    openssl(["req", "-newkey", "rsa:2048", "-nodes", "-keyout", join(directory, "server.key"), "-out", join(directory, "server.csr"), "-subj", "/CN=localhost"]);
    writeFileSync(join(directory, "server.ext"), "basicConstraints=critical,CA:FALSE\nkeyUsage=critical,digitalSignature,keyEncipherment\nextendedKeyUsage=serverAuth\nsubjectAltName=IP:127.0.0.1,DNS:localhost\n");
    openssl(["x509", "-req", "-in", join(directory, "server.csr"), "-CA", join(directory, "ca.crt"), "-CAkey", join(directory, "ca.key"), "-CAcreateserial", "-out", join(directory, "server.crt"), "-days", "1", "-extfile", join(directory, "server.ext")]);
    ca = readFileSync(join(directory, "ca.crt"), "utf8");
    writeFileSync(join(directory, "postgres.env"), `POSTGRES_PASSWORD=${password}\nPOSTGRES_INITDB_ARGS=--auth-host=scram-sha-256 --auth-local=trust\n`, { mode: 0o600 });
    containerId = docker("run", "--pull=never", "--detach", "--rm", "--name", `corgtex-runtime-${runId}`, "--label", `${LABEL}=${runId}`, "--cpus=2", "--memory=2g", "--memory-swap=2g", "--env-file", join(directory, "postgres.env"), "--publish", "127.0.0.1::5432", "--mount", `type=bind,src=${directory},dst=/fixture,readonly`, "--entrypoint", "sh", IMAGE, "-c", "cp /fixture/server.key /tmp/server.key && cp /fixture/server.crt /tmp/server.crt && chown postgres:postgres /tmp/server.key /tmp/server.crt && chmod 600 /tmp/server.key && exec docker-entrypoint.sh postgres -c ssl=on -c ssl_cert_file=/tmp/server.crt -c ssl_key_file=/tmp/server.key");
    assert.match(containerId, /^[a-f0-9]{64}$/);
    const port = docker("port", containerId, "5432/tcp"); assert.match(port, /^127\.0\.0\.1:[0-9]+$/); endpoint = { host: "127.0.0.1", port: Number(port.split(":")[1]) };
    stage = "STARTUP";
    let superuser;
    for (const until = Date.now() + 30000; ;) { try { superuser = await connect("postgres", "postgres", password); break; } catch (error) { receipt.startupErrorCode = /^[A-Z0-9_]{1,64}$/.test(error.code) ? error.code : null; if (Date.now() > until) throw Error("POSTGRES_START_TIMEOUT"); await delay(250); } }
    assert.equal(Math.floor(Number((await superuser.query("SHOW server_version_num")).rows[0].server_version_num) / 10000), 18);
    stage = "FIXTURE_ADMIN";
    await superuser.query(`CREATE ROLE fixture_admin LOGIN CREATEDB CREATEROLE NOSUPERUSER NOREPLICATION NOBYPASSRLS PASSWORD ${ql(administratorPassword)}; CREATE ROLE foundation_user LOGIN PASSWORD ${ql(legitimatePassword)}; CREATE ROLE azure_pg_admin NOLOGIN; GRANT azure_pg_admin TO fixture_admin`);
    for (const name of Object.keys(api.RUNTIME_ACCESS_SENSITIVE_SETTINGS)) await superuser.query(`GRANT SET ON PARAMETER ${qi(name)} TO fixture_admin`);
    const admin = await connect("postgres");
    assert.deepEqual((await admin.query("SELECT rolsuper,rolcreatedb,rolcreaterole FROM pg_roles WHERE rolname=current_user")).rows[0], { rolsuper: false, rolcreatedb: true, rolcreaterole: true });
    await admin.query("CREATE DATABASE fixture_source"); await admin.query("CREATE DATABASE foundation");
    await superuser.query("REVOKE CONNECT ON DATABASE postgres, template1 FROM PUBLIC; GRANT CONNECT ON DATABASE postgres, template1 TO fixture_admin");
    await admin.query("GRANT CONNECT ON DATABASE foundation TO foundation_user");
    const maintenanceConfig = { ...endpoint, database: "postgres", user: "fixture_admin", password: administratorPassword, sslmode: "verify-full", targetTlsRootCert: ca };
    const maintenanceOptions = { config: maintenanceConfig, expected: { ...endpoint, database: "postgres", user: "fixture_admin" }, signal: AbortSignal.timeout(30000), assertOwned: async () => {} };
    const firstLease = await openPostgresMaintenance(maintenanceOptions);
    try { await assert.rejects(() => openPostgresMaintenance(maintenanceOptions), /PG_MAINTENANCE_ALREADY_OWNED/); } finally { await firstLease.close(); }
    const nextLease = await openPostgresMaintenance(maintenanceOptions); await nextLease.assertHeld(); await nextLease.close(); mark("maintenance-excludes-second-owner-and-releases-on-close");
    // No-runtime scratch access while initially disabled, before its first ACL transaction.
    const scratch = "corgtex_rehearsal_runtime_access";
    await admin.query(`CREATE DATABASE ${qi(scratch)} ALLOW_CONNECTIONS false`);
    const scratchOid = (await admin.query("SELECT oid::text FROM pg_database WHERE datname=$1", [scratch])).rows[0].oid;
    let observedDisabled = false;
    await protectScratchDatabaseAccess({ client: admin, scratchName: scratch, scratchOid, administrator: "fixture_admin", assertCustody: async phase => { if (phase === "PROTECT_SCRATCH_ACCESS") observedDisabled = (await admin.query("SELECT datallowconn FROM pg_database WHERE oid=$1", [scratchOid])).rows[0].datallowconn === false; } });
    assert(observedDisabled); await deniedConnect(scratch, "foundation_user", legitimatePassword);
    await inspectProtectedScratchAccess({ client: admin, scratchName: scratch, scratchOid, administrator: "fixture_admin", allowConnections: true });
    await admin.query(`DROP DATABASE ${qi(scratch)}`); mark("protected-scratch-denies-foreign-connect");
    stage = "BASELINE_MIGRATIONS";
    const sourceSuper = await connect("fixture_source", "postgres", password); await sourceSuper.query("CREATE EXTENSION vector"); await close(sourceSuper);
    const baseline = join(directory, "baseline"); mkdirSync(baseline); cpSync("prisma/schema.prisma", join(baseline, "schema.prisma")); mkdirSync(join(baseline, "migrations"));
    for (const name of readdirSync("prisma/migrations")) if (name === "migration_lock.toml" || name < "20260915182000_workspace_mcp_connections") cpSync(join("prisma/migrations", name), join(baseline, "migrations", name), { recursive: true });
    const prisma = (database, user, pw, schema) => {
      const url = new URL(`postgresql://${user}:${pw}@${endpoint.host}:${endpoint.port}/${database}`); url.searchParams.set("sslmode", "require"); url.searchParams.set("sslaccept", "strict"); url.searchParams.set("sslcert", join(directory, "ca.crt")); url.searchParams.set("sslrootcert", join(directory, "ca.crt"));
      const r = spawnSync(process.execPath, [resolve("node_modules/prisma/build/index.js"), "migrate", "deploy", "--schema", schema], { env: { ...process.env, DATABASE_URL: url.toString(), DIRECT_URL: url.toString(), RUST_LOG: "info", RUST_BACKTRACE: "1", DEBUG: "prisma:schemaEngine:stderr" }, encoding: "utf8", timeout: 60000, maxBuffer: 8 * 1024 * 1024 });
      if (r.error || r.status !== 0) {
        const text = String(r.stdout) + String(r.stderr);
        let redacted = text.replace(/postgres(?:ql)?:\/\/[^\s"']+/g, "[REDACTED_DATABASE_URL]");
        for (const secret of [password, administratorPassword, legitimatePassword, ...Object.values(passwords).flatMap(v => Object.values(v))]) redacted = redacted.replaceAll(secret, "[REDACTED]");
        writeFileSync(join(evidenceDir, "prisma-output-redacted.txt"), redacted, { mode: 0o600 });
        receipt.prismaDiagnostic = { exitCode: r.status, code: text.match(/\bP[0-9]{4}\b/)?.[0] ?? null, sqlState: text.match(/(?:Database error code|SQLSTATE):\s*([0-9A-Z]{5})/)?.[1] ?? null,
          certificateError: /certificate|TLS|SSL/.test(text), missingModule: /Cannot find module/.test(text), validationError: /schema validation|Validation Error/.test(text) };
        throw Error("PRISMA_DEPLOY_FAILED");
      } return r.stdout;
    };
    prisma("fixture_source", "fixture_admin", administratorPassword, join(baseline, "schema.prisma"));
    const source = await connect("fixture_source");
    await source.query(`INSERT INTO "Workspace" (id,slug,name,"updatedAt") VALUES ('retained-workspace','runtime-access-fixture','Synthetic retained data',now()); CREATE TABLE runtime_retained_sequence (id serial PRIMARY KEY, label text); INSERT INTO runtime_retained_sequence(label) VALUES ('retained'); SELECT setval('runtime_retained_sequence_id_seq',41,true); INSERT INTO "CustomerAccount" (id,slug,"displayName","updatedAt") VALUES ('synthetic-account','synthetic-account','Synthetic',now()); INSERT INTO "CustomerDeployment" (id,label,url,"updatedAt","customerAccountId","cloudProvider","deploymentStatus","provisioningStatus","releaseImageTag","releaseLeaseFence","releaseLeaseId","releaseLeaseTokenHash","releaseLeaseOwner","releaseLeaseExpectedImageTag","releaseLeaseIncomingImageTag","releaseLeaseIncomingVersion","releaseLeasePhase","releaseLeaseAcquiredAt","releaseLeaseHeartbeatAt","releaseLeaseExpiresAt") VALUES ('retained-deployment','Synthetic','https://fixture.invalid',now(),'synthetic-account','AZURE','ACTIVE','active','sha-'||repeat('a',40),1,'held-lease',repeat('a',64),'synthetic','sha-'||repeat('a',40),'sha-'||repeat('b',40),'synthetic','RESERVED',now(),now(),now()+interval '1 hour')`);
    const lob = (await source.query("SELECT lo_from_bytea(0,decode('01020304','hex')) AS oid")).rows[0].oid;
    await close(source);
    docker("exec", containerId, "pg_dump", "-U", "fixture_admin", "-d", "fixture_source", "-Fc", "--no-owner", "--no-acl", "--no-comments", "-f", "/tmp/baseline.dump");
    receipt.restoreLimitation = "Comments omitted: local vector is bootstrap-owned; extension identity and members remain unchanged. Azure extension administrator semantics are not qualified.";
    mark("actual-prisma-baseline-dump");
    for (const domain of ["core", "ops"]) {
      stage = `RESTORE_${domain.toUpperCase()}`;
      const database = `corgtex_${domain}`;
      const artifactDir = join(directory, domain); mkdirSync(artifactDir);
      const scratchName = `corgtex_rehearsal_fixture_${domain}`;
      const creation = await createScratchDatabase({ adminConfig: { ...endpoint, user: "fixture_admin", password: administratorPassword, database: "postgres", sslmode: "verify-full", targetTlsRootCert: ca }, scratchName, settings: { encoding: "UTF8", provider: "libc", collation: "C.UTF-8", ctype: "C.UTF-8", providerLocale: null, icuRules: null, collationVersion: null, actualCollationVersion: null }, stateFile: join(artifactDir, "state.json"), targetRef: "synthetic", artifactDir, productionMode: true, assertCustody: async () => {} });
      if (domain === "ops") { await deniedConnect(scratchName, "corgtex_core_runtime", passwords.core.runtime); await deniedConnect(scratchName, "worker_scale_core", passwords.core.scaler); mark("existing-core-runtime-denied-ops-scratch-before-restore"); }
      const targetSuper = await connect(scratchName, "postgres", password); await targetSuper.query("CREATE EXTENSION vector"); await close(targetSuper);
      docker("exec", containerId, "pg_restore", "-U", "fixture_admin", "-d", scratchName, "--exit-on-error", "--no-owner", "--no-acl", "/tmp/baseline.dump");
      await admin.query(`ALTER DATABASE ${qi(scratchName)} RENAME TO ${qi(database)}`);
      const target = await connect(database);
      await target.query("ALTER SCHEMA public OWNER TO azure_pg_admin; GRANT USAGE,CREATE ON SCHEMA public TO fixture_admin");
      const extBefore = (await target.query("SELECT oid::text,extowner,extversion FROM pg_extension WHERE extname='vector'")).rows[0];
      assert.equal(extBefore.extversion, "0.8.2");
      const oidBefore = (await target.query("SELECT oid::text,datdba::text FROM pg_database WHERE datname=current_database()")).rows[0]; assert.equal(oidBefore.oid, creation.scratchOid);
      // Filled using the public module's exact inventory/prepare/apply/reconcile API below.
      await qualifyDomain({ api, domain, target, admin, endpoint, ca, passwords, connect, close, deniedConnect, prisma, lob, receipt, extBefore, oidBefore, evidenceDir, mark });
      await close(target);
    }
    stage = "CROSS_DOMAIN_ISOLATION";
    for (const domain of ["core", "ops"]) for (const other of ["foundation", "postgres", "fixture_source", `corgtex_${domain === "core" ? "ops" : "core"}`]) {
      await deniedConnect(other, `corgtex_${domain}_runtime`, passwords[domain].runtime);
      await deniedConnect(other, `worker_scale_${domain}`, passwords[domain].scaler);
    }
    const legitimate = await connect("foundation", "foundation_user", legitimatePassword); await legitimate.query("SELECT 1"); await close(legitimate); mark("two-domain-runtime-scaler-isolation-and-legitimate-foundation-user");
    receipt.status = "PASS_LOCAL_PG18_ONLY";
  } catch (error) {
    receipt.status = "FAILED_LOCAL_ONLY"; receipt.stage = stage; receipt.code = /^[A-Z][A-Z0-9_]+$/.test(error.message) ? error.message : "LOCAL_FIXTURE_FAILED"; receipt.sqlState = /^[0-9A-Z]{5}$/.test(error.code) ? error.code : null;
    throw Error(`${receipt.code}:${stage}:${receipt.sqlState ?? "NO_SQLSTATE"}`);
  } finally {
    for (const client of clients) await client.end().catch(() => {});
    if (containerId) {
      const actual = JSON.parse(docker("inspect", containerId))[0]; assert.equal(actual.Config.Labels[LABEL], runId); assert.equal(actual.Id, containerId);
      docker("rm", "--force", "--volumes", containerId);
      assert.equal(docker("ps", "--all", "--filter", `label=${LABEL}=${runId}`, "--format", "{{.ID}}"), "");
      receipt.cleanup = "OWNED_CONTAINER_ABSENT";
    }
    receipt.endedAt = new Date().toISOString(); writeFileSync(join(evidenceDir, "receipt.json"), JSON.stringify(receipt, null, 2) + "\n", { mode: 0o600 });
    rmSync(directory, { recursive: true, force: true });
  }
});

async function qualifyDomain({ api, domain, target, admin, endpoint, ca, passwords, connect, close, deniedConnect, prisma, lob, receipt, extBefore, oidBefore, evidenceDir, mark }) {
  const runtimeRole = `corgtex_${domain}_runtime`, scalerRole = `worker_scale_${domain}`, database = `corgtex_${domain}`;
  const vault = "https://fixture-vault.vault.azure.net/", version = "a".repeat(32);
  const policy = { schemaVersion: 1, runtimeRole, runtimeDatabaseSecrets: { web: `${vault}secrets/${domain}-web/${version}`, worker: `${vault}secrets/${domain}-worker/${version}` }, scaler: { role: scalerRole, connectionSecretVersion: `${vault}secrets/${domain}-scaler/${version}` }, applicationSchema: "public", isolation: { inventorySha256: "a".repeat(64), databases: [{ name: "postgres", oid: "1", owner: "postgres", action: "verify-only", beforeAclSha256: "a".repeat(64), preserveConnectRoles: [] }] } };
  const plan = { schemaVersion: 1, domain, ...endpoint, database, databaseOid: oidBefore.oid, administrator: "fixture_admin", runtimeVaultUri: vault, serverResourceId: "/subscriptions/00000000-0000-0000-0000-000000000001/resourceGroups/fixture/providers/Microsoft.DBforPostgreSQL/flexibleServers/local-fixture", intentSha256: "d".repeat(64), operationId: randomUUID(), policy };
  const first = await api.observePostgresRuntimeAccessCatalog({ plan, client: target });
  const inventory = api.postgresRuntimeAccessIsolationInventory(first, domain);
  const legitimateOid = first.roles.find(r => r.name === "foundation_user").oid;
  policy.isolation = { inventorySha256: inventory.inventorySha256, databases: inventory.databases.map(db => ({ name: db.name, oid: db.oid, owner: db.owner, action: ["foundation", "fixture_source"].includes(db.name) && first.databases.find(d => d.name === db.name).acl.some(a => a.grantee === "0" && a.privilege === "CONNECT") ? "replace-public-connect" : "verify-only", beforeAclSha256: db.aclSha256, preserveConnectRoles: db.name === "foundation" && first.databases.find(d => d.name === db.name).acl.some(a => a.grantee === "0" && a.privilege === "CONNECT") ? [{ name: "foundation_user", oid: legitimateOid }] : [] })) };
  const secrets = new Map(Object.entries(policy.runtimeDatabaseSecrets).map(([, url]) => [url, `postgresql://${runtimeRole}:${passwords[domain].runtime}@${endpoint.host}:${endpoint.port}/${database}?sslmode=verify-full`]));
  secrets.set(policy.scaler.connectionSecretVersion, `postgresql://${scalerRole}:${passwords[domain].scaler}@${endpoint.host}:${endpoint.port}/${database}?sslmode=verify-full`);
  const guardLog = [], guards = { signal: AbortSignal.timeout(180000), assertHeld: async value => { guardLog.push(value.effect); }, assertSourceFenced: async () => {}, assertTargetInactive: async () => {}, resolveSecretVersion: async url => { assert(secrets.has(url)); return secrets.get(url); } };
  const records = { intent: null, expectedAfter: null };
  const persistIntent = async value => { assert.equal(records.intent, null); records.intent = structuredClone(value); };
  const persistExpectedAfter = async value => { records.expectedAfter = structuredClone(value); };
  const readRecords = async () => structuredClone(records);
  const clientFactory = config => new Client({ ...config, ssl: { ...config.ssl, ca, rejectUnauthorized: true } });
  const intent = await api.preparePostgresRuntimeAccess({ ...guards, plan, client: target });
  const options = { ...guards, intent, client: target, persistIntent, persistExpectedAfter, readRecords, clientFactory };
  // Failure of durable pre-commit evidence must roll back catalog changes.
  await assert.rejects(() => api.applyPostgresRuntimeAccess({ ...options, persistExpectedAfter: async () => { throw Error("INJECTED_EVIDENCE_FAILURE"); } }));
  const rolledBack = await api.observePostgresRuntimeAccessCatalog({ plan, client: target });
  assert.deepEqual(rolledBack, first);
  records.intent = null; records.expectedAfter = null;
  // A lost COMMIT acknowledgement is reconciled against durable expected state, never replayed.
  const realQuery = target.query.bind(target); let lostAck = false, commitCount = 0;
  target.query = async (...args) => { const result = await realQuery(...args); if (String(args[0]).trim() === "COMMIT") { commitCount++; if (!lostAck) { lostAck = true; throw Error("INJECTED_COMMIT_ACK_LOSS"); } } return result; };
  let applied;
  try { applied = await api.applyPostgresRuntimeAccess(options); } catch { applied = await api.reconcilePostgresRuntimeAccess(options); }
  target.query = realQuery;
  assert.equal(applied.status, "APPLIED"); assert.equal(commitCount, 1);
  const reconciled = await api.reconcilePostgresRuntimeAccess(options); assert.equal(reconciled.status, "APPLIED");
  assert.equal((await target.query("SELECT count(*)::int AS n FROM \"Workspace\" WHERE id='retained-workspace'")).rows[0].n, 1);
  const runtime = await connect(database, runtimeRole, passwords[domain].runtime);
  assert.equal((await runtime.query("SELECT nextval('runtime_retained_sequence_id_seq')::int AS n")).rows[0].n, 42);
  assert.equal((await runtime.query("SELECT encode(lo_get($1),'hex') AS bytes", [lob])).rows[0].bytes, "01020304");
  assert.equal((await runtime.query("SELECT '[1,2,3]'::vector <-> '[1,2,3]'::vector AS distance")).rows[0].distance, 0);
  await assert.rejects(() => runtime.query("DELETE FROM \"CustomerDeployment\" WHERE id='retained-deployment'"), e => e.code === "23514" && e.constraint === "CustomerDeployment_release_lease_delete_guard");
  await assert.rejects(() => runtime.query("UPDATE \"CustomerDeployment\" SET label='forbidden' WHERE id='retained-deployment'"), e => e.code === "23514" && e.constraint === "CustomerDeployment_release_lease_update_guard");
  await assert.rejects(() => runtime.query(`INSERT INTO "ConstitutionSourceReference" (id,"workspaceId","constitutionId","pointKey","pointOrder","sourceOrder","policyCorpusId","sourceKind","proposalId","labelSnapshot","acceptedAtSnapshot","updatedAt") VALUES ('bad','retained-workspace','missing','point',0,0,'missing','PROPOSAL','missing','synthetic',now(),now())`), e => e.code === "23503" && e.constraint === "ConstitutionSourceReference_policy_source_check");
  await assert.rejects(() => runtime.query("CREATE ROLE forbidden_runtime_role"), e => e.code === "42501");
  await assert.rejects(() => runtime.query("CREATE DATABASE forbidden_runtime_db"), e => e.code === "42501");
  await assert.rejects(() => runtime.query("SET ROLE fixture_admin"), e => e.code === "42501");
  await close(runtime);
  prisma(database, runtimeRole, passwords[domain].runtime, resolve("prisma/schema.prisma"));
  const noOp = prisma(database, runtimeRole, passwords[domain].runtime, resolve("prisma/schema.prisma")); assert.match(noOp, /No pending migrations/);
  assert.equal((await target.query("SELECT count(*)::int AS n FROM information_schema.columns WHERE table_name='WorkflowJob' AND column_name='mcpOrigin'")).rows[0].n, 1);
  assert.deepEqual((await target.query("SELECT oid::text,extowner,extversion FROM pg_extension WHERE extname='vector'")).rows[0], extBefore);
  assert.deepEqual((await target.query("SELECT oid::text,datdba::text FROM pg_database WHERE datname=current_database()")).rows[0], oidBefore);
  assert.equal((await target.query("SELECT pg_get_userbyid(nspowner) AS owner FROM pg_namespace WHERE nspname='public'")).rows[0].owner, "azure_pg_admin");
  const scaler = await connect(database, scalerRole, passwords[domain].scaler);
  await assert.rejects(() => scaler.query('SELECT payload FROM "WorkflowJob" LIMIT 1'), e => e.code === "42501");
  await assert.rejects(() => scaler.query('INSERT INTO "WorkflowJob"(id) VALUES (\'forbidden\')'), e => e.code === "42501");
  await assert.rejects(() => scaler.query("CREATE TABLE forbidden_scaler_table (id int)"), e => e.code === "42501");
  await close(scaler);
  receipt[domain] = { databaseOid: oidBefore.oid, extensionOid: extBefore.oid, adminReadback: true, retainedData: true, sequenceNext: 42, largeObject: true, triggerCount: 3, pendingMigrationApplied: true, noOpDeploy: true, commitAcknowledgementLost: true, commitCount, evidenceFailureRolledBack: true, guardedOperationCount: guardLog.length };
  mark(`${domain}-ownership-prisma-triggers-vector-sequence-admin-recovery`);
}
