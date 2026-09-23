import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { randomBytes, randomUUID } from "node:crypto";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { test } from "node:test";
import pg from "pg";
import { archiveEvidenceHash } from "./ops-core-archive.mjs";
import { createCutoverJournal, openCutoverCustody } from "./ops-core-custody.mjs";
import { runOpsCoreSourceFence, assertOpsCoreSourceFenced } from "./ops-core-source-controller.mjs";
import { createRailwayPostgresCustody } from "./railway-postgres-custody.mjs";
import { RailwaySourceFence } from "./railway-source-fence.mjs";

const IMAGE = "postgres:18.6@sha256:4ef4dbc939d61acea57712655ddb4b4ab27419c913f94cca0cd57cb3ea3c2280";
const LABEL = "corgtex.source-controller-test";
const id = value => `00000000-0000-4000-8000-${String(value).padStart(12, "0")}`;
const PG_SERVICE = id(4);
const WRITER_SERVICE = id(3);
const scope = { projectId: id(1), environmentId: id(2) };

function storesFor(plan, scenario) {
  const intentSha256 = archiveEvidenceHash(plan);
  let text = JSON.stringify(createCutoverJournal({ domain: "core", intentSha256, evidenceSha256: "e".repeat(64) }));
  let etag = 0;
  let lease = null;
  const records = new Map();
  const state = { receiptLost: false };
  const blob = {
    async acquire() { assert.equal(lease, null); lease = randomUUID(); return lease; },
    async renew(value) { assert.equal(value, lease); },
    async release(value) { assert.equal(value, lease); lease = null; },
    async read(value) { assert.equal(value, lease); return { text, etag }; },
    async write(next, conditions) {
      assert.equal(conditions.lease, lease); assert.equal(conditions.etag, etag);
      text = next; return { etag: ++etag };
    },
  };
  const store = {
    async assertPrivate() {},
    async readOptional(key) { return records.get(key) ?? null; },
    async listDescriptors(prefix) { return [...records.keys()].filter(key => key.startsWith(prefix) && key.endsWith("/descriptor.json")).sort(); },
    async createOnly(key, value) {
      assert.equal(records.has(key), false); records.set(key, value);
      if (scenario === "LOST_ROTATION_RECEIPT" && !state.receiptLost && key.endsWith("/receipt.json")) {
        const intent = JSON.parse(records.get(key.replace(/receipt\.json$/, "intent.json")));
        if (intent.kind === "POSTGRES_ROTATE_RUNTIME_PASSWORD") {
          state.receiptLost = true;
          throw new Error("SYNTHETIC_RECEIPT_ACKNOWLEDGEMENT_LOSS");
        }
      }
      if (["LOST_WRITER_STAGE_RECEIPT", "LOST_POSTGRES_STAGE_RECEIPT"].includes(scenario)
        && !state.receiptLost && key.endsWith("/receipt.json")) {
        const descriptor = JSON.parse(records.get(key.replace(/receipt\.json$/, "descriptor.json")));
        const serviceId = scenario === "LOST_WRITER_STAGE_RECEIPT" ? WRITER_SERVICE : PG_SERVICE;
        if (descriptor.kind === "RAILWAY_STAGE_SOURCE_TRIGGERS" && descriptor.input.binding.serviceIds.includes(serviceId)) {
          state.receiptLost = true;
          throw new Error("SYNTHETIC_STAGE_RECEIPT_ACKNOWLEDGEMENT_LOSS");
        }
      }
    },
  };
  return { intentSha256, records, blob, store, state };
}

function simulatedRailway(scenario) {
  const source = serviceId => ({ image: serviceId === PG_SERVICE
    ? "ghcr.io/railwayapp-templates/postgres-ssl:18" : "fixture/writer:retained", repo: null });
  const deployment = (serviceId, n) => ({ ...scope, serviceId, id: id(n), status: "SUCCESS",
    createdAt: "2026-09-22T12:00:00Z", updatedAt: "2026-09-22T12:00:00Z", deploymentStopped: false,
    instances: [{ id: id(n + 100), status: "RUNNING" }] });
  const state = { staged: { id: id(10), environmentId: scope.environmentId, status: "STAGED", patch: {} },
    config: { services: Object.fromEntries([WRITER_SERVICE, PG_SERVICE].map(serviceId => [serviceId, {
      source: { ...source(serviceId), autoUpdates: { type: "patch" } }, deploy: { cronSchedule: "0 * * * *" },
    }])) }, auto: { [WRITER_SERVICE]: true, [PG_SERVICE]: true },
    deployments: { [WRITER_SERVICE]: [deployment(WRITER_SERVICE, 20)], [PG_SERVICE]: [deployment(PG_SERVICE, 21)] },
    pending: [], effects: new Map(), stageLost: false, records: null,
  };
  const environment = () => ({ id: scope.environmentId, projectId: scope.projectId });
  const service = serviceId => {
    const config = state.config.services[serviceId];
    return { id: id(serviceId === PG_SERVICE ? 31 : 30), serviceId, environmentId: scope.environmentId,
      service: { id: serviceId, projectId: scope.projectId }, source: source(serviceId),
      startCommand: null, preDeployCommand: [], cronSchedule: config.deploy.cronSchedule,
      nextCronRunAt: config.deploy.cronSchedule ? "2026-09-22T13:00:00Z" : null,
      restartPolicyType: "ON_FAILURE", restartPolicyMaxRetries: 10, drainingSeconds: null, overlapSeconds: null,
      resolvedFileConfig: null, activeDeployments: state.deployments[serviceId].filter(value => !value.deploymentStopped),
    };
  };
  const transport = async ({ query, variables, signal }) => {
    signal.throwIfAborted();
    const operation = /(?:query|mutation) (\w+)/.exec(query)?.[1];
    let data;
    if (query.startsWith("mutation")) {
      const kind = { FenceAutoDeploy: "RAILWAY_DISABLE_AUTODEPLOY", FenceStage: "RAILWAY_STAGE_SOURCE_TRIGGERS",
        FenceCommit: "RAILWAY_COMMIT_SOURCE_TRIGGERS", FenceStop: "RAILWAY_STOP_SOURCE_DEPLOYMENT" }[operation];
      assert.ok(kind, "simulation admits only the intended provider effects");
      assert.ok([...state.records.values()].some(text => { const value = JSON.parse(text); return value.type === "intent" && value.kind === kind; }),
        "every simulated mutation requires an actual retained intent");
      const target = operation === "FenceStage" ? Object.keys(variables.input.services)[0]
        : operation === "FenceCommit" ? Object.keys(state.staged.patch.services)[0]
          : variables.input?.serviceId ?? variables.id;
      const key = `${operation}:${target}`;
      state.effects.set(key, (state.effects.get(key) ?? 0) + 1);
    }
    if (operation === "PostgresCustody") data = { environment: environment(), serviceInstance: service(PG_SERVICE) };
    if (operation === "FenceEnvironment") data = { environment: { ...environment(), config: state.config },
      environmentStagedChanges: state.staged, environmentPendingWork: state.pending };
    if (operation === "FenceService") data = { environment: environment(), serviceInstance: service(variables.serviceId),
      serviceInstanceAutoDeployStatus: { enabled: state.auto[variables.serviceId] } };
    if (operation === "FenceDeployments") data = { environment: environment(), deployments: {
      edges: state.deployments[variables.serviceId].map(node => ({ cursor: node.id, node })), pageInfo: { hasNextPage: false, endCursor: null },
    } };
    if (operation === "FenceDeployment") data = { environment: environment(),
      deployment: Object.values(state.deployments).flat().find(value => value.id === variables.id) };
    if (operation === "FenceAutoDeploy") {
      state.auto[variables.input.serviceId] = false; data = { serviceInstanceAutoDeployUpdate: { enabled: false } };
    }
    if (operation === "FenceStage") {
      state.staged.patch = structuredClone(variables.input);
      if (scenario === "LOST_WRITER_STAGE" && !state.stageLost && variables.input.services[WRITER_SERVICE]) {
        state.stageLost = true; throw new Error("SYNTHETIC_STAGE_ACKNOWLEDGEMENT_LOSS");
      }
      data = { environmentStageChanges: { id: state.staged.id, environmentId: scope.environmentId } };
    }
    if (operation === "FenceCommit") {
      for (const [serviceId, patch] of Object.entries(state.staged.patch.services)) {
        state.config.services[serviceId].source.autoUpdates = patch.source.autoUpdates;
        state.config.services[serviceId].deploy.cronSchedule = null;
      }
      state.staged.patch = {}; data = { environmentPatchCommitStaged: id(10) };
    }
    if (operation === "FenceStop") {
      const target = Object.values(state.deployments).flat().find(value => value.id === variables.id);
      assert.equal(target.serviceId, WRITER_SERVICE, "PostgreSQL must never be stopped");
      target.deploymentStopped = true; target.instances = [];
      if (scenario === "PROVIDER_INCOMPLETE") state.pending = [{ id: id(50), environmentId: scope.environmentId,
        kind: "fixture-pending-work", status: "applying", children: [] }];
      data = { deploymentStop: true };
    }
    assert.ok(data, "unknown simulated provider read");
    return structuredClone(data);
  };
  return { state, transport };
}

// All provider identities and startup file hashes below are explicitly synthetic.
// Only PostgreSQL and Docker are real, bounded to each test's own local container.
for (const scenario of ["COMPLETE", "LOST_WRITER_STAGE", "LOST_WRITER_STAGE_RECEIPT", "LOST_POSTGRES_STAGE_RECEIPT",
  "LOST_ROTATION_RECEIPT", "PROVIDER_INCOMPLETE"]) {
  test(`integrated source controller ${scenario}`, { timeout: 180_000 }, async () => {
    let stage = "SETUP";
    let directory;
    let dockerHost;
    let containerId;
    let owner;
    let held;
    let admin;
    const runId = randomUUID();
    const recoveryBytes = randomBytes(32);
    const recoveryPassword = recoveryBytes.toString("base64");
    const oldPassword = randomBytes(32).toString("base64");
    const readerPassword = randomBytes(32).toString("base64");
    const docker = (...args) => {
      const result = spawnSync("docker", ["--config", directory, "--host", dockerHost, ...args], {
        encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], timeout: 120_000, maxBuffer: 16 * 1024 * 1024,
      });
      if (result.error || result.status !== 0) throw new Error("LOCAL_DOCKER_COMMAND_FAILED");
      return result.stdout.trim();
    };
    const connect = async config => {
      const client = new pg.Client({ ...config, ssl: false, connectionTimeoutMillis: 3_000, query_timeout: 10_000 });
      client.on("error", () => {});
      try { await client.connect(); return client; }
      catch (error) { await client.end().catch(() => {}); throw error; }
    };
    try {
      directory = mkdtempSync(join(tmpdir(), "ops-core-source-controller-"));
      try { dockerHost = execFileSync("docker", ["context", "inspect", "--format", "{{.Endpoints.docker.Host}}"],
        { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], timeout: 10_000 }).trim(); }
      catch { throw new Error("LOCAL_DOCKER_UNAVAILABLE"); }
      assert.match(dockerHost, /^unix:\/\//);
      writeFileSync(join(directory, "config.json"), "{}", { mode: 0o600 });
      const envFile = join(directory, "postgres.env");
      writeFileSync(envFile, `POSTGRES_USER=postgres\nPOSTGRES_DB=railway\nPOSTGRES_PASSWORD=${oldPassword}\nPOSTGRES_INITDB_ARGS=--auth-host=scram-sha-256 --auth-local=trust\n`, { mode: 0o600 });
      containerId = docker("run", "--detach", "--rm", "--name", `corgtex-source-controller-${runId}`,
        "--label", `${LABEL}=${runId}`, "--env-file", envFile, "--publish", "127.0.0.1::5432", IMAGE,
        "postgres", "-c", "password_encryption=scram-sha-256");
      assert.match(containerId, /^[a-f0-9]{64}$/);
      const address = docker("port", containerId, "5432/tcp");
      assert.match(address, /^127\.0\.0\.1:[0-9]+$/);
      const sourceConfig = { host: "127.0.0.1", port: Number(address.split(":")[1]), database: "railway",
        user: "postgres", password: oldPassword, sslmode: "disable" };
      const readerConfig = { ...sourceConfig, user: "fence_reader", password: readerPassword };
      stage = "STARTUP";
      for (const deadline = Date.now() + 30_000; ;) {
        try { admin = await connect(sourceConfig); break; }
        catch { if (Date.now() > deadline) throw new Error("LOCAL_POSTGRES_UNAVAILABLE"); await delay(250); }
      }
      const identity = (await admin.query(`SELECT system_identifier::text AS system_identifier,
        (SELECT oid::text FROM pg_database WHERE datname=current_database()) AS database_oid FROM pg_control_system()`)).rows[0];
      await admin.query(`CREATE ROLE fence_reader LOGIN PASSWORD '${readerPassword}' NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS;
        CREATE TABLE retained_lifecycle_fixture (id serial PRIMARY KEY,status text NOT NULL,dependency_id integer REFERENCES retained_lifecycle_fixture(id));
        INSERT INTO retained_lifecycle_fixture(status) VALUES ('COMPLETED');
        INSERT INTO retained_lifecycle_fixture(status,dependency_id) VALUES ('PENDING',1);
        GRANT CONNECT ON DATABASE railway TO fence_reader; GRANT USAGE ON SCHEMA public TO fence_reader;
        GRANT SELECT ON retained_lifecycle_fixture TO fence_reader; GRANT SELECT ON retained_lifecycle_fixture_id_seq TO fence_reader`);
      await admin.end(); admin = null;
      held = await connect({ ...sourceConfig, database: "postgres" });
      const heldPid = (await held.query("SELECT pg_backend_pid() AS pid")).rows[0].pid;
      const rail = simulatedRailway(scenario);
      const signal = new AbortController().signal;
      const postgresService = { domain: "core", ...scope, serviceId: PG_SERVICE, deploymentId: id(21), instanceId: id(121),
        sourceImage: "ghcr.io/railwayapp-templates/postgres-ssl:18", startCommand: null, preDeployCommand: [],
        dataDirectory: "/var/lib/postgresql/data/pgdata", systemIdentifier: identity.system_identifier,
        files: ["docker-entrypoint.sh", "wrapper.sh", "pgbackrest-backup-watcher.sh", "pgbackrest-archive-push-wrapper.sh"]
          .map((name, index) => ({ path: `/usr/local/bin/${name}`, sha256: String(index + 1).repeat(64) })) };
      const runRemoteRead = async ({ binding, signal: remoteSignal }) => {
        remoteSignal.throwIfAborted();
        assert.equal(binding.serviceId, PG_SERVICE);
        return `RAILWAY_PG_CUSTODY_FILES_V1\n${binding.files.map(file => `${file.sha256}  ${file.path}`).join("\n")}\nRAILWAY_PG_CUSTODY_VERSION_V1\n18\n\nRAILWAY_PG_CUSTODY_IDENTITY_V1\n${JSON.stringify({
          user: "postgres", sessionUser: "postgres", database: "postgres", serverVersionNum: 180006,
          dataDirectory: binding.dataDirectory, readOnly: "on", inRecovery: false, passwordEncryption: "scram-sha-256",
          superuser: true, systemIdentifier: identity.system_identifier, unixSocket: true,
        })}\n`;
      };
      const configFor = async serviceId => {
        const binding = { ...scope, serviceIds: [serviceId] };
        const inventory = await new RailwaySourceFence({ binding, transport: rail.transport, signal,
          runRecordedOperation: async () => { throw new Error("READ_ONLY_BASELINE"); } }).read();
        return { binding, expectedSourceLinks: inventory.services.map(({ serviceId, sourceLinkSha256 }) => ({ serviceId, sourceLinkSha256 })) };
      };
      const postgresCustody = createRailwayPostgresCustody({ binding: postgresService, transport: rail.transport, runRemoteRead, signal });
      const plan = { schemaVersion: 1, domain: "core", source: { writers: await configFor(WRITER_SERVICE),
        postgresTriggers: await configFor(PG_SERVICE), postgresService, postgres: {
          expected: { domain: "core", connection: { host: sourceConfig.host, port: sourceConfig.port, database: "railway", user: "postgres" },
            systemIdentifier: identity.system_identifier, databaseOid: identity.database_oid, readerRole: "fence_reader",
            databaseServiceSha256: postgresCustody.bindingSha256 },
          retainedSecretVersion: `https://migration-fixture.vault.azure.net/secrets/source-recovery/${"a".repeat(32)}`, vaultName: "migration-fixture",
        } } };
      const stores = storesFor(plan, scenario);
      rail.state.records = stores.records;
      owner = await openCutoverCustody(stores.blob, stores.intentSha256);
      const options = retainedPlan => ({ plan: retainedPlan, custody: owner, operationStore: stores.store,
        sourceConfig, readerConfig, railway: { transport: rail.transport, runRemoteRead },
        resolveSecret: async (version, vault) => {
          assert.equal(version, plan.source.postgres.retainedSecretVersion); assert.equal(vault, "migration-fixture");
          return Buffer.from(recoveryBytes);
        } });
      stage = "CONTROLLER";
      let result;
      let verifierBeforeRecovery;
      if (scenario === "COMPLETE") result = await runOpsCoreSourceFence(options(plan));
      else {
        await assert.rejects(runOpsCoreSourceFence(options(plan)));
        assert.equal(owner.snapshot().phase, "PREPARED");
        if (scenario === "PROVIDER_INCOMPLETE") {
          const providerReceipt = await new RailwaySourceFence({ ...plan.source.writers, transport: rail.transport,
            signal: owner.signal, runRecordedOperation: async () => { throw new Error("READ_ONLY_ASSERTION"); } }).assertFenced();
          assert.equal(providerReceipt.complete, false);
          assert.ok(providerReceipt.evidence.blockers.includes("PENDING_ENVIRONMENT_WORK"));
          assert.equal([...stores.records.values()].some(text => JSON.parse(text).kind === "POSTGRES_ROTATE_RUNTIME_PASSWORD"), false);
          admin = await connect(sourceConfig);
          assert.equal((await admin.query("SELECT session_user AS role")).rows[0].role, "postgres");
          assert.equal(rail.state.deployments[PG_SERVICE][0].deploymentStopped, false);
          return;
        }
        if (scenario === "LOST_ROTATION_RECEIPT") {
          assert.equal(stores.state.receiptLost, true);
          admin = await connect({ ...sourceConfig, password: recoveryPassword });
          verifierBeforeRecovery = (await admin.query("SELECT rolpassword FROM pg_authid WHERE rolname='postgres'")).rows[0].rolpassword;
          await admin.end(); admin = null;
        } else if (scenario.endsWith("STAGE_RECEIPT")) {
          assert.equal(stores.state.receiptLost, true);
          const intents = [...stores.records.keys()].filter(key => key.endsWith("/intent.json"));
          assert.ok(intents.length > 0);
          assert.ok(intents.every(key => stores.records.has(key.replace(/intent\.json$/, "receipt.json"))),
            "completed staging must recover with zero pending intents");
          const serviceId = scenario === "LOST_WRITER_STAGE_RECEIPT" ? WRITER_SERVICE : PG_SERVICE;
          assert.ok(rail.state.staged.patch.services[serviceId]);
          assert.equal(rail.state.effects.get(`FenceStage:${serviceId}`), 1);
        } else assert.equal(rail.state.stageLost, true);
        const retained = [...stores.records.entries()].find(([key]) => key.endsWith("/phase-plan.json"));
        assert.ok(retained);
        const recoveredPlan = { schemaVersion: 1, domain: "core", source: JSON.parse(retained[1]).source };
        assert.equal(archiveEvidenceHash(recoveredPlan), stores.intentSha256);
        await owner.close();
        owner = await openCutoverCustody(stores.blob, stores.intentSha256);
        stage = "REOPEN";
        result = await runOpsCoreSourceFence(options(recoveredPlan));
      }
      stage = "ACCEPTANCE";
      assert.equal(result.status, "SOURCE_FENCED");
      assert.equal(owner.snapshot().phase, "SOURCE_FENCED");
      assert.equal(owner.snapshot().pending, null);
      await assertOpsCoreSourceFenced(options(plan));
      assert.ok([...rail.state.effects.values()].every(value => value === 1), "no Railway effect may repeat after reopen");
      assert.equal(rail.state.effects.get(`FenceStage:${WRITER_SERVICE}`), 1);
      assert.equal(rail.state.deployments[PG_SERVICE][0].deploymentStopped, false);
      assert.equal(rail.state.deployments[PG_SERVICE][0].instances[0].status, "RUNNING");
      const descriptors = [...stores.records.values()].map(text => JSON.parse(text)).filter(value => value.type === "descriptor");
      const intents = [...stores.records.keys()].filter(key => key.endsWith("/intent.json"));
      const receipts = [...stores.records.keys()].filter(key => key.endsWith("/receipt.json"));
      assert.equal(descriptors.length, intents.length); assert.equal(intents.length, receipts.length);
      assert.equal(descriptors.filter(value => value.kind === "POSTGRES_ROTATE_RUNTIME_PASSWORD").length, 1);
      assert.equal(result.evidence.operations.completedCount, descriptors.length);
      assert.ok([...stores.records.keys()].some(key => /\/phase-evidence-[a-f0-9]{64}\.json$/.test(key)));
      for (const record of stores.records.values()) for (const secret of [oldPassword, readerPassword, recoveryPassword]) {
        assert.equal(record.includes(secret), false, "durable records cannot include credential values");
      }
      await assert.rejects(connect(sourceConfig), { code: "28P01" });
      admin = await connect({ ...sourceConfig, password: recoveryPassword });
      if (verifierBeforeRecovery) assert.ok((await admin.query("SELECT rolpassword FROM pg_authid WHERE rolname='postgres'")).rows[0].rolpassword === verifierBeforeRecovery,
        "rotation must not execute again with a new SCRAM salt");
      assert.equal((await admin.query("SELECT count(*)::integer AS count FROM pg_stat_activity WHERE pid=$1", [heldPid])).rows[0].count, 0);
      const reader = await connect(readerConfig);
      try {
        assert.deepEqual((await reader.query("SELECT status,dependency_id FROM retained_lifecycle_fixture ORDER BY id")).rows,
          [{ status: "COMPLETED", dependency_id: null }, { status: "PENDING", dependency_id: 1 }]);
        await assert.rejects(reader.query("INSERT INTO retained_lifecycle_fixture(status) VALUES ('FORBIDDEN')"), { code: "42501" });
      } finally { await reader.end(); }
      const dumpEnv = join(directory, "reader.env");
      writeFileSync(dumpEnv, `PGHOST=127.0.0.1\nPGPORT=5432\nPGDATABASE=railway\nPGUSER=fence_reader\nPGPASSWORD=${readerPassword}\n`, { mode: 0o600 });
      docker("exec", "--env-file", dumpEnv, containerId, "pg_dump", "--format=custom", "--file=/tmp/source-controller-reader.dump");
      const toc = docker("exec", containerId, "pg_restore", "--list", "/tmp/source-controller-reader.dump");
      assert.ok(toc.includes("TABLE DATA public retained_lifecycle_fixture"));
      assert.ok(toc.includes("SEQUENCE SET public retained_lifecycle_fixture_id_seq"));
    } catch (error) {
      const diagnostic = /^[A-Z][A-Z0-9_]{2,100}$/.test(error?.message ?? "") ? error.message
        : /^[0-9A-Z]{5}$/.test(error?.code ?? "") ? error.code : "ASSERTION_OR_OPERATION_FAILED";
      throw new Error(`LOCAL_SOURCE_CONTROLLER_${stage}_${diagnostic}`);
    } finally {
      await admin?.end().catch(() => {}); await held?.end().catch(() => {}); recoveryBytes.fill(0);
      try { await owner?.close(); }
      finally {
        try {
          if (containerId) {
            const inspected = JSON.parse(docker("inspect", containerId));
            assert.equal(inspected.length, 1); assert.equal(inspected[0]?.Id, containerId);
            assert.equal(inspected[0]?.Name, `/corgtex-source-controller-${runId}`);
            assert.equal(inspected[0]?.Config?.Labels?.[LABEL], runId);
            docker("stop", containerId);
            for (const deadline = Date.now() + 5_000; ;) {
              if (!docker("ps", "--all", "--filter", `label=${LABEL}=${runId}`, "--format", "{{.ID}}").trim()) break;
              if (Date.now() > deadline) throw new Error("LOCAL_CONTROLLER_CONTAINER_REMOVAL_UNPROVEN");
              await delay(100);
            }
          }
        } finally { if (directory) rmSync(directory, { recursive: true }); }
      }
    }
  });
}
