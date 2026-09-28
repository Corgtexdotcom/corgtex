import { afterEach, describe, expect, it } from "vitest";
import { mkdtemp, readFile, writeFile, rm, chmod, realpath } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { archiveEvidenceHash as hash } from "./ops-core-archive.mjs";
import { postgresRuntimeAccessIsolationInventory } from "./ops-core-postgres-runtime-access.mjs";
import { preparePostgresPromotion } from "./ops-core-postgres-promotion.mjs";
import { validatePostgresDatabaseParity } from "./validate-postgres-restore-rehearsal.mjs";
import { resolveRetryScratchAdmission } from "./ops-core-retry-scratch.mjs";

const dirs = [];
afterEach(async () => { for (const dir of dirs.splice(0)) await rm(dir, { recursive: true, force: true }); });
const ref = value => `sha256:${createHash("sha256").update(value).digest("hex").slice(0, 16)}`;

async function fixture() {
  const dir = await realpath(await mkdtemp(join(tmpdir(), "retry-scratch-"))); dirs.push(dir);
  await chmod(dir, 0o700);
  const target = { host: "pg.postgres.database.azure.com", port: 5432, database: "postgres", user: "admin" };
  const source = { host: "source.local", port: 5432, database: "source", user: "reader" };
  const oldName = "corgtex_rehearsal_1_1_core", newName = "corgtex_rehearsal_1_2_core";
  const baseRow = { name: "postgres", oid: "5", owner: "admin", allowConnections: true,
    isTemplate: false, ownerAuthority: true, acl: [{ grantee: "10", privilege: "CONNECT" }] };
  const oldRow = { name: oldName, oid: "277613", owner: "admin", allowConnections: true,
    isTemplate: false, ownerAuthority: true, acl: [{ grantee: "10", privilege: "CONNECT" }] };
  const isolation = postgresRuntimeAccessIsolationInventory({ databases: [baseRow] }, "core");
  const vault = "https://fixture.vault.azure.net/", secret = name => `${vault}secrets/${name}/${"a".repeat(32)}`;
  const policy = { schemaVersion: 2, providerProfile: "azure-flexible-postgres-18", runtimeRole: "corgtex_core_runtime",
    applicationSchema: "public", runtimeDatabaseSecrets: { web: secret("web"), worker: secret("worker") },
    scaler: { role: "worker_scale_core", connectionSecretVersion: secret("scaler") },
    isolation: { inventorySha256: isolation.inventorySha256, databases: [{ name: "postgres", oid: "5", owner: "admin",
      action: "replace-public-connect", beforeAclSha256: hash(baseRow.acl), preserveConnectRoles: [] }] } };
  const predecessorPlan = { domain: "core", transfer: { postgres: { scratchName: oldName, source, target, archiveStoreId: "archive",
    keyVersion: secret("archive") } } };
  const intent = { domain: "core", scratchName: oldName, source, target, archiveStoreId: "archive", keyVersion: secret("archive") };
  const abandoned = { operationId: "00000000-0000-4000-8000-000000000001", to: "CAPTURED", intentSha256: hash(intent) };
  const predecessorJournal = { phase: "SOURCE_RECOVERED", destinationMayHaveWritten: false,
    recovery: { abandonedPending: abandoned } };
  const plan = { domain: "core", transfer: { postgres: { target, scratchName: newName, runtimeAccess: policy } },
    activation: { runtimeVaultUri: vault }, azure: { domain: "core" }, operator: { retryOf: {
      intentSha256: hash(predecessorPlan), journalSha256: hash(predecessorJournal) } } };
  const evidence = { copy: { capture: abandoned, intent }, state: { phase: "MIGRATION_RETAINED", scratchName: oldName,
    scratchOid: oldRow.oid, scratchOwner: target.user, targetRef: ref(`${target.host}\0${oldName}`) } };
  await writeFile(join(dir, "copy-intent.json"), JSON.stringify(evidence.copy), { mode: 0o600 });
  await writeFile(join(dir, "scratch-state.json"), JSON.stringify(evidence.state), { mode: 0o600 });
  const state = { phase: "PREPARED", pending: null, destinationMayHaveWritten: false };
  const custody = { signal: new AbortController().signal, snapshot: () => state, assertOwned: async () => {} };
  const saved = new Map(), operationStore = { assertPrivate: async () => {}, readOptional: async key => saved.get(key) ?? null,
    createOnly: async (key, value) => { if (saved.has(key)) throw Error("EXISTS"); saved.set(key, value); } };
  const options = { plan, predecessorPlan, predecessorJournal, custody, operationStore,
    targetAdminConfig: { ...target, sslmode: "verify-full", targetTlsRootCert: "fixture-ca" },
    evidenceDirectory: dir, create: true, targetFactory: () => ({ assertInactive: async () => ({ complete: true }) }),
    openMaintenance: async () => ({ signal: custody.signal, assertHeld: async () => {}, close: async () => {} }),
    inspect: async () => ({ databaseOid: oldRow.oid, databaseOwner: target.user, empty: true, protectedAccess: true }),
    clientFactory: () => ({ connect: async () => {}, query: async sql => sql === "BEGIN READ ONLY" || sql === "ROLLBACK"
      ? { rows: [] } : { rows: [baseRow, oldRow] }, end: async () => {} }) };
  return { options, saved, state, oldRow, baseRow };
}

describe("preserved retry scratch admission", () => {
  it("retains an exact receipt and carries the complete verify-only policy into transfer", async () => {
    const f = await fixture();
    const first = await resolveRetryScratchAdmission(f.options);
    expect(first.policy.isolation.databases.find(row => row.name === f.oldRow.name)).toMatchObject({ action: "verify-only",
      oid: f.oldRow.oid, beforeAclSha256: hash(f.oldRow.acl) });
    expect(f.saved.size).toBe(1);
    f.state.phase = "SOURCE_FENCED";
    const continued = await resolveRetryScratchAdmission({ ...f.options, create: false,
      targetFactory: () => { throw Error("SHOULD_NOT_READ_BASELINE_AFTER_FENCE"); } });
    expect(continued).toEqual(first);
  });
  it("admits a completed capture recovered before restore intent", async () => {
    const f = await fixture();
    const capture = f.options.predecessorJournal.recovery.abandonedPending;
    f.options.predecessorJournal.recovery = { from: "CAPTURED", abandonedPending: null };
    f.options.predecessorJournal.history = [{ phase: "CAPTURED", operationId: capture.operationId,
      intentSha256: capture.intentSha256, evidenceSha256: "a".repeat(64) }];
    f.options.plan.operator.retryOf.journalSha256 = hash(f.options.predecessorJournal);
    const admitted = await resolveRetryScratchAdmission(f.options);
    expect(admitted.scratch.name).toBe(f.oldRow.name);
    expect(JSON.parse([...f.saved.values()][0]).predecessorCaptureOperationId).toBe(capture.operationId);
  });
  it("rejects every unrelated database inventory change before writing a receipt", async () => {
    const f = await fixture();
    const changed = { ...f.baseRow, oid: "6" };
    await expect(resolveRetryScratchAdmission({ ...f.options, clientFactory: () => ({ connect: async () => {},
      query: async sql => sql === "BEGIN READ ONLY" || sql === "ROLLBACK" ? { rows: [] } : { rows: [changed, f.oldRow] },
      end: async () => {} }) })).rejects.toThrow("RETRY_SCRATCH_OTHER_DATABASE_DRIFT");
    expect(f.saved.size).toBe(0);
  });
});

const databaseEvidence = () => ({
  server: { majorVersion: 18 }, locale: { encoding: "UTF8", collation: "C", ctype: "C", provider: "builtin",
    providerLocale: "C.UTF-8", icuRules: null, collationVersion: "1", actualCollationVersion: "1" },
  extensions: [{ name: "plpgsql", version: "1.0" }, { name: "vector", version: "0.8.2" }],
  schema: { algorithm: "PG_DUMP_SQL_TOKENS_V1", digest: "a".repeat(64) },
  tables: [{ schema: "public", name: "Event", rowCount: 0, rowSha256: "a".repeat(64) }],
  largeObjects: { count: 0, contentSha256: "a".repeat(64) },
  migrations: { rows: [], counts: { finished: 0, rolledBack: 0, incomplete: 0 } },
  queues: { event: { statuses: [{ status: "DISPATCHED", count: 0 }, { status: "FAILED", count: 0 },
    { status: "PENDING", count: 0 }], lockedCount: 0 }, workflowJob: { statuses: [
    { status: "CANCELLED", count: 0 }, { status: "COMPLETED", count: 0 }, { status: "FAILED", count: 0 },
    { status: "PENDING", count: 0 }, { status: "RUNNING", count: 0 }], lockedCount: 0 } },
});

async function restoredFixture() {
  const f = await fixture(), o = f.options, old = o.predecessorPlan.transfer.postgres;
  old.targetIdentity = "fixture-pg";
  old.runtimeAccess = o.plan.transfer.postgres.runtimeAccess;
  const predecessorIntent = hash(o.predecessorPlan), oid = f.oldRow.oid;
  const promotionClient = { connectionParameters: old.target, async query(sql) {
    if (sql.includes("current_database()")) return { rows: [{ database: "postgres", session_user: "admin", role_user: "admin" }] };
    if (sql.includes("FROM pg_catalog.pg_database")) return { rows: [{ name: old.scratchName, oid,
      owner: "admin", is_template: false, connection_count: 0 }] };
    throw Error("unexpected promotion query");
  } };
  const source = databaseEvidence(), archiveSha = "a".repeat(64);
  const evidence = { schemaVersion: "1.0.0", domain: "core", sourceRef: "sha256:0123456789abcdef",
    targetRef: "sha256:fedcba9876543210", source, destination: structuredClone(source),
    frozenSourceSequences: [], archiveSequences: { tocEntryCount: 0, beforeReplay: [], afterReplay: [] } };
  const parity = validatePostgresDatabaseParity(evidence, { requireFrozenSourceSequences: true });
  const copyPath = join(o.evidenceDirectory, "copy-intent.json");
  const captureIntent = JSON.parse(await readFile(copyPath, "utf8")).intent;
  const capture = { phase: "CAPTURED", operationId: "00000000-0000-4000-8000-000000000001",
    intentSha256: hash(captureIntent), evidenceSha256: archiveSha };
  const restore = { phase: "RESTORED", operationId: "00000000-0000-4000-8000-000000000002",
    intentSha256: "d".repeat(64), evidenceSha256: hash({ parity, archiveManifestSha256: archiveSha }) };
  const promotion = await preparePostgresPromotion({ client: promotionClient, expectedConnection: old.target,
    domain: "core", scratchName: old.scratchName, scratchOid: oid,
    permanentName: "corgtex_core", targetIdentity: old.targetIdentity, parityEvidenceSha256: parity.evidenceSha256 });
  const verification = { from: "RESTORED", to: "VERIFIED", operationId: "00000000-0000-4000-8000-000000000003",
    intentSha256: promotion.sha256 };
  const journal = { domain: "core", intentSha256: predecessorIntent, phase: "SOURCE_RECOVERED", pending: null,
    destinationMayHaveWritten: false, history: [capture, restore],
    recovery: { from: "RESTORED", abandonedPending: verification } };
  o.predecessorJournal = journal;
  o.plan.operator.retryOf = { intentSha256: predecessorIntent, journalSha256: hash(journal) };
  await writeFile(copyPath, JSON.stringify({ capture: { ...capture, to: "CAPTURED" }, intent: captureIntent }), { mode: 0o600 });
  const prefix = `operations/core/${predecessorIntent}/${verification.operationId}/`;
  const proof = { type: "POSTGRES_COPY_PARITY", restoreOperationId: restore.operationId,
    restoreIntentSha256: restore.intentSha256, scratchOid: oid, archiveManifestSha256: archiveSha, evidence, parity };
  const evidenceKey = `operations/core/${predecessorIntent}/${restore.operationId}/phase-evidence-${hash(proof)}.json`;
  const copied = { scratchName: old.scratchName, scratchOid: oid, stateFile: join(o.evidenceDirectory, "scratch-state.json"),
    archive: { sha256: archiveSha }, evidence, parity, evidenceSha256: restore.evidenceSha256, evidenceKey };
  const context = { type: "POSTGRES_COPY_CONTEXT", copied };
  const phasePlan = { schemaVersion: 3, intentSha256: predecessorIntent, promotion,
    archiveManifestSha256: archiveSha, postgresCopyEvidenceSha256: hash(context),
    objectSnapshotEvidenceSha256: "e".repeat(64), runtimeAccessPolicySha256: hash(old.runtimeAccess) };
  o.operationStore.readOptional = async key => f.saved.get(key) ?? null;
  f.saved.set(`${prefix}phase-plan.json`, JSON.stringify(phasePlan));
  f.saved.set(`${prefix}phase-evidence-${hash(context)}.json`, JSON.stringify(context));
  f.saved.set(evidenceKey, JSON.stringify(proof));
  o.inspect = async () => ({ databaseOid: oid, databaseOwner: old.target.user, empty: false, protectedAccess: true });
  o.clientFactory = config => ({ connectionParameters: config, connect: async () => {}, end: async () => {},
    query: async sql => {
      if (sql.includes("current_database()")) return promotionClient.query(sql);
      if (sql.includes("WHERE d.datname = ANY")) return promotionClient.query(sql);
      if (sql === "BEGIN READ ONLY" || sql === "ROLLBACK") return { rows: [] };
      return { rows: [f.baseRow, f.oldRow] };
    } });
  return { f, phasePlan, proof, prefix };
}

describe("recovered restored scratch admission", () => {
  it("retains the populated scratch with exact restore and unpromoted catalog proof", async () => {
    const { f } = await restoredFixture();
    const admitted = await resolveRetryScratchAdmission(f.options);
    expect(admitted.scratch).toMatchObject({ name: f.oldRow.name, oid: f.oldRow.oid });
    expect(admitted.policy.isolation.databases.find(row => row.name === f.oldRow.name).action).toBe("verify-only");
    const receipt = [...f.saved.entries()].find(([key]) => key.startsWith("retry-admissions/"));
    expect(JSON.parse(receipt[1])).toMatchObject({ type: "PRESERVED_RESTORED_RETRY_SCRATCH",
      predecessorRestoreOperationId: "00000000-0000-4000-8000-000000000002",
      predecessorVerificationOperationId: "00000000-0000-4000-8000-000000000003" });
  });
  it("admits a reconciled restore whose local marker has no copy intent or owner field", async () => {
    const { f } = await restoredFixture();
    const copyPath = join(f.options.evidenceDirectory, "copy-intent.json");
    const statePath = join(f.options.evidenceDirectory, "scratch-state.json");
    await rm(copyPath);
    const state = JSON.parse(await readFile(statePath, "utf8"));
    delete state.scratchOwner;
    await writeFile(statePath, JSON.stringify(state), { mode: 0o600 });
    const admitted = await resolveRetryScratchAdmission(f.options);
    expect(admitted.scratch.oid).toBe(f.oldRow.oid);
  });
  it("rejects changed restore evidence before creating the admission receipt", async () => {
    const { f, proof } = await restoredFixture();
    proof.scratchOid = "277999";
    const key = [...f.saved.keys()].find(value => value.includes("/phase-evidence-") && value.includes("/00000000-0000-4000-8000-000000000002/"));
    f.saved.set(key, JSON.stringify(proof));
    await expect(resolveRetryScratchAdmission(f.options)).rejects.toThrow("RETRY_RESTORED_RESTORE_PROOF_INVALID");
    expect([...f.saved.keys()].some(value => value.startsWith("retry-admissions/"))).toBe(false);
  });
  it("rejects a promoted catalog or durable promotion intent", async () => {
    const { f, prefix } = await restoredFixture();
    f.saved.set(`${prefix}promotion-intent.json`, JSON.stringify({ synthetic: true }));
    await expect(resolveRetryScratchAdmission(f.options)).rejects.toThrow("RETRY_RESTORED_PROMOTION_INTENT_PRESENT");
  });
  it("rejects active scratch sessions and target activity before admission", async () => {
    const active = await restoredFixture();
    const clientFactory = active.f.options.clientFactory;
    active.f.options.clientFactory = config => {
      const client = clientFactory(config), query = client.query;
      client.query = async sql => sql.includes("WHERE d.datname = ANY")
        ? { rows: [{ name: active.f.oldRow.name, oid: active.f.oldRow.oid,
          owner: "admin", is_template: false, connection_count: 1 }] } : query(sql);
      return client;
    };
    await expect(resolveRetryScratchAdmission(active.f.options)).rejects.toThrow("RETRY_RESTORED_PROMOTION_STATE_INVALID");
    const target = await restoredFixture();
    target.f.options.targetFactory = () => ({ assertInactive: async () => ({ complete: false }) });
    await expect(resolveRetryScratchAdmission(target.f.options)).rejects.toThrow("RETRY_SCRATCH_TARGET_ACTIVE");
  });
  it("rejects a scratch session opened after the first restored catalog check", async () => {
    const { f } = await restoredFixture();
    const clientFactory = f.options.clientFactory;
    let promotionReads = 0;
    f.options.clientFactory = config => {
      const client = clientFactory(config), query = client.query;
      client.query = async sql => {
        if (sql.includes("WHERE d.datname = ANY") && ++promotionReads === 2)
          return { rows: [{ name: f.oldRow.name, oid: f.oldRow.oid,
            owner: "admin", is_template: false, connection_count: 1 }] };
        return query(sql);
      };
      return client;
    };
    await expect(resolveRetryScratchAdmission(f.options)).rejects.toThrow("RETRY_RESTORED_PROMOTION_STATE_INVALID");
    expect(promotionReads).toBe(2);
    expect([...f.saved.keys()].some(key => key.startsWith("retry-admissions/"))).toBe(false);
  });
  it("rejects a changed scratch OID before retaining the restored receipt", async () => {
    const { f } = await restoredFixture();
    f.options.inspect = async () => ({ databaseOid: "277999", databaseOwner: "admin",
      empty: false, protectedAccess: true });
    await expect(resolveRetryScratchAdmission(f.options)).rejects.toThrow("RETRY_SCRATCH_LIVE_PROOF_INVALID");
    expect([...f.saved.keys()].some(value => value.startsWith("retry-admissions/"))).toBe(false);
  });
});
