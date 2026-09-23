import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomBytes, randomUUID } from "node:crypto";
import { afterEach, describe, expect, it, vi } from "vitest";
import { archiveEvidenceHash } from "./ops-core-archive.mjs";
import { createCutoverJournal, openCutoverCustody } from "./ops-core-custody.mjs";
import { opsCoreAzureTargetBindingSha256 } from "./ops-core-azure-target.mjs";
import { redisGateBindingSha256 } from "./ops-core-redis-gate.mjs";
import { runOpsCoreDataTransfer } from "./ops-core-transfer-controller.mjs";

const shared = vi.hoisted(() => ({ current: null }));
vi.mock("./ops-core-source-controller.mjs", () => ({ assertOpsCoreSourceFenced: vi.fn(async ({ plan }) => ({
  schemaVersion: 1, domain: plan.domain, intentSha256: shared.current.intentHash,
  railway: { complete: shared.current.sourceComplete }, postgres: { synthetic: true },
})) }));
vi.mock("./ops-core-azure-target.mjs", async importOriginal => {
  const original = await importOriginal();
  return { ...original, createOpsCoreAzureTarget: ({ binding }) => ({
    async assertInactive() { return { complete: shared.current.targetComplete, domain: binding.domain,
      intentSha256: shared.current.intentHash, targetBindingSha256: original.opsCoreAzureTargetBindingSha256(binding) }; },
    async assertEnterpriseBinding() { return { complete: true }; },
  }) };
});
vi.mock("./ops-core-postgres-copy.mjs", () => ({ runOpsCorePostgresCopy: vi.fn(async options => {
  const f = shared.current; f.events.push("copy");
  await options.assertSourceFenced(); await options.assertTargetInactive();
  for (const phase of ["CAPTURED", "RESTORED"]) {
    const op = await options.custody.begin(phase, "d".repeat(64)); await options.custody.complete(op.operationId, "e".repeat(64));
  }
  await writeFile(f.stateFile, JSON.stringify({ schemaVersion: "1.0.0", scratchName: options.scratchName,
    targetRef: f.targetRef, phase: "CREATED" }), { mode: 0o600 });
  return { operationDir: f.directory, stateFile: f.stateFile, scratchName: options.scratchName,
    archive: { sha256: "a".repeat(64) }, parity: { evidenceSha256: "b".repeat(64), sourceSequenceParity: "VERIFIED" }, evidence: {} };
}) }));
vi.mock("pg", () => ({ default: { Client: class {
  constructor(config) { this.connectionParameters = config; }
  async connect() {}
  async end() { shared.current.closed++; }
  async query(sql) {
    const f = shared.current;
    if (sql.startsWith("SELECT oid::text")) return { rows: [{ oid: "16401" }] };
    if (sql.includes("current_database()")) return { rows: [{ database: "postgres", session_user: "target_admin", role_user: "target_admin" }] };
    if (sql.includes("FROM pg_catalog.pg_database")) return { rows: [{ name: f.databaseName, oid: "16401", owner: "target_admin",
      is_template: false, connection_count: 0 }] };
    if (sql.startsWith("ALTER DATABASE")) {
      expect(f.records.size).toBeGreaterThan(2); f.events.push("promote"); f.databaseName = "corgtex_core";
      expect(JSON.parse(await readFile(f.stateFile)).phase).toBe("PROMOTION_INTENT"); return { rows: [] };
    }
    throw new Error("unexpected SQL in bounded controller test");
  }
} } }));
vi.mock("./ops-core-redis-job.mjs", async importOriginal => ({ ...await importOriginal(), createRedisJobDispatcher: () => ({
  identity: { synthetic: true }, runProbe: async () => {},
  async prepare() { shared.current.events.push("prepare-probe"); },
}) }));
vi.mock("./ops-core-redis-gate.mjs", async importOriginal => {
  const original = await importOriginal();
  return { ...original, assertOpsCoreRedisEmpty: async options => {
    const f = shared.current; f.events.push("redis");
    expect(f.events).toContain("prepare-probe");
    const source = await options.assertSourceFenced(); const target = await options.assertTargetInactive();
    expect(target.targetBindingSha256).toBe(original.redisGateBindingSha256(options.target));
    expect(target.azureTargetBindingSha256).toBe(opsCoreAzureTargetBindingSha256(f.plan.azure));
    if (f.redisFails) throw new Error("private Redis diagnostic");
    return { status: "REDIS_EMPTY_ACCEPTED", domain: f.plan.domain, intentSha256: f.intentHash,
      sourceFenceSha256: source.sourceFenceSha256 };
  } };
});

const fixtures = [];
afterEach(async () => {
  for (const f of fixtures.splice(0)) { await f.custody.close(); await rm(f.directory, { recursive: true, force: true }); }
  shared.current = null;
});

async function fixture(changePlan = () => {}) {
  const directory = await mkdtemp(join(tmpdir(), "ops-core-transfer-"));
  const sub = "00000000-0000-4000-8000-000000000001";
  const root = `/subscriptions/${sub}/resourceGroups/migration-fixture/providers/`;
  const azure = { domain: "core", subscriptionId: sub, resourceGroupName: "migration-fixture",
    environmentId: `${root}Microsoft.App/managedEnvironments/fixture`,
    postgres: { resourceId: `${root}Microsoft.DBforPostgreSQL/flexibleServers/fixture-pg`,
      host: "fixture-pg.postgres.database.azure.com", major: 18, privateEndpointId: `${root}Microsoft.Network/privateEndpoints/pg` },
    redis: { resourceId: `${root}Microsoft.Cache/redisEnterprise/fixture-redis`,
      databaseId: `${root}Microsoft.Cache/redisEnterprise/fixture-redis/databases/default`,
      host: "fixture.westus3.redis.azure.net", port: 10000, privateEndpointId: `${root}Microsoft.Network/privateEndpoints/redis` },
    apps: { web: "fixture-web", worker: "fixture-worker" } };
  const redis = { source: { mode: "standalone", resourceId: null, server: { version: "8.2.9", runId: "a".repeat(40) },
    connection: { host: "source.local", port: 6379, database: 0, username: "default", tls: false } },
  target: { mode: "azure-enterprise-proxy", resourceId: azure.redis.databaseId, server: { version: "7.4.0", runId: null },
    connection: { host: azure.redis.host, port: 10000, database: 0, username: "default", tls: true } } };
  redis.job = { target: structuredClone(redis.target), environmentResourceId: azure.environmentId,
    jobResourceId: `${root}Microsoft.App/jobs/fixture-probe`,
    infrastructureSubnetId: `${root}Microsoft.Network/virtualNetworks/fixture/subnets/aca`,
    workspaceId: "00000000-0000-4000-8000-000000000002",
    identityResourceId: `${root}Microsoft.ManagedIdentity/userAssignedIdentities/fixture`,
    image: `fixture.azurecr.io/worker@sha256:${"d".repeat(64)}`, probeSha256: "e".repeat(64),
    redisSecretVersion: `https://fixture-vault.vault.azure.net/secrets/redis/${"a".repeat(32)}`, location: "westus3" };
  const sourceConnection = { host: "source.local", port: 5432, database: "railway", user: "postgres" };
  const plan = { schemaVersion: 1, domain: "core", azure, redis,
    source: { postgres: { expected: { connection: sourceConnection, readerRole: "reader" } } },
    transfer: { postgres: { source: { ...sourceConnection, user: "reader" },
      target: { host: azure.postgres.host, port: 5432, database: "postgres", user: "target_admin" },
      scratchName: "corgtex_rehearsal_10_1_core", targetIdentity: "fixture-pg", archiveStoreId: "archive-fixture",
      keyVersion: `https://fixture-vault.vault.azure.net/secrets/archive/${"a".repeat(32)}`, vaultName: "fixture-vault", maxArchiveBytes: 100000 },
    objects: { sourceStoreId: "source-objects", targetStoreId: "target-objects",
      limits: { maxPages: 2, maxObjects: 5, maxObjectBytes: 100, maxTotalBytes: 500 } } } };
  changePlan(plan);
  const intentHash = archiveEvidenceHash(plan);
  let journal = JSON.stringify(createCutoverJournal({ domain: "core", intentSha256: intentHash, evidenceSha256: "e".repeat(64) }));
  let etag = 0; let lease;
  const custody = await openCutoverCustody({
    async acquire() { lease = randomUUID(); return lease; }, async renew(value) { expect(value).toBe(lease); }, async release() {},
    async read() { return { text: journal, etag }; },
    async write(text, expected) { expect(expected.etag).toBe(etag); journal = text; return { etag: ++etag }; },
  }, intentHash);
  const sourceFence = await custody.begin("SOURCE_FENCED", "d".repeat(64)); await custody.complete(sourceFence.operationId, "c".repeat(64));
  const f = { directory, custody, plan, intentHash, stateFile: join(directory, "scratch-state.json"), records: new Map(),
    events: [], sourceComplete: true, targetComplete: true, redisFails: false, closed: 0,
    databaseName: plan.transfer.postgres.scratchName };
  // Same opaque target reference contract as the actual scratch/promotion code.
  const { createHash } = await import("node:crypto");
  f.targetRef = `sha256:${createHash("sha256").update(`${azure.postgres.host}\0${plan.transfer.postgres.scratchName}`).digest("hex").slice(0, 16)}`;
  const sourceValues = new Map([["document", { data: Buffer.from("retained"), etag: "one", metadata: {}, contentType: "text/plain" }]]);
  const targetValues = new Map();
  function objects(identity, map) {
    return { identity, async assertPrivate() {},
      async head(key) { const v = map.get(key); return v ? { etag: v.etag, bytes: v.data.length, metadata: v.metadata, contentType: v.contentType } : null; },
      async read(key) { const v = map.get(key); return v ? { ...await this.head(key), body: (async function* () { yield v.data; })() } : null; },
      async createOnly(key, bytes, metadata, contentType) { if (map.has(key)) return false;
        f.events.push("object"); map.set(key, { data: bytes, metadata, contentType, etag: "target-one" }); return true; },
      async removeIfMatch() { throw new Error("deletion forbidden"); },
      async inventory() { return Promise.all([...map.keys()].map(async key => ({ key, ...await this.head(key) }))); },
    };
  }
  const secret = randomBytes(24).toString("base64");
  f.options = { plan, custody, artifactDir: directory, archiveStore: { identity: "archive-fixture" },
    sourceCredentials: { sourceConfig: { ...sourceConnection, password: secret },
      readerConfig: { ...sourceConnection, user: "reader", password: secret } },
    targetAdminConfig: { host: azure.postgres.host, port: 5432, database: "postgres", user: "target_admin",
      password: secret, sslmode: "verify-full", targetTlsRootCert: "local-test-only" },
    objectSource: objects("source-objects", sourceValues), objectTarget: objects("target-objects", targetValues),
    operationStore: { async assertPrivate() {}, async readOptional(key) { return f.records.get(key) ?? null; },
      async createOnly(key, text) { expect(f.records.has(key)).toBe(false); f.records.set(key, text); } },
  };
  fixtures.push(f); shared.current = f; return f;
}

describe("Ops/Core combined transfer controller", () => {
  it("integrates retained copy, real object transfer, durable promotion and Redis hash bridge before VERIFIED", async () => {
    const f = await fixture(); const result = await runOpsCoreDataTransfer(f.options);
    expect(result.status).toBe("VERIFIED"); expect(f.custody.snapshot().phase).toBe("VERIFIED");
    expect(f.custody.snapshot().destinationMayHaveWritten).toBe(false);
    expect(f.events).toEqual(["copy", "object", "promote", "prepare-probe", "redis"]);
    expect(f.closed).toBe(1); expect(result.evidence.objects.entries).toHaveLength(1);
    expect(await f.options.objectTarget.head("document")).not.toBeNull();
    for (const text of f.records.values()) expect(text).not.toContain(f.options.targetAdminConfig.password);
  });
  it("rejects a different Redis target even when the surrounding intent is correctly hashed", async () => {
    const f = await fixture(plan => { plan.redis.target.connection.host = "other.westus3.redis.azure.net"; });
    await expect(runOpsCoreDataTransfer(f.options)).rejects.toThrow("TRANSFER_REDIS_BINDING_MISMATCH");
    expect(f.events).toEqual([]);
  });
  it("requires verified TLS for external Azure PostgreSQL before source capture", async () => {
    const f = await fixture(); f.options.targetAdminConfig.sslmode = "disable";
    await expect(runOpsCoreDataTransfer(f.options)).rejects.toThrow("TRANSFER_STORAGE_BINDING_MISMATCH");
    expect(f.events).toEqual([]);
  });
  it("rejects an unpinned probe image before source capture", async () => {
    const f = await fixture(plan => { plan.redis.job.image = "fixture.azurecr.io/worker:latest"; });
    await expect(runOpsCoreDataTransfer(f.options)).rejects.toThrow("TRANSFER_RECONCILIATION_REQUIRED");
    expect(f.events).toEqual([]);
  });
  it("rejects an explicitly incomplete source or target assertion before any copy", async () => {
    for (const side of ["sourceComplete", "targetComplete"]) {
      const f = await fixture(); f[side] = false;
      await expect(runOpsCoreDataTransfer(f.options)).rejects.toThrow(side === "sourceComplete" ? "TRANSFER_SOURCE_UNPROVEN" : "TRANSFER_TARGET_UNPROVEN");
      expect(f.events).toEqual([]);
    }
  });
  it("retains promoted data and pending verification after a Redis failure, with no automatic repeat", async () => {
    const f = await fixture(); f.redisFails = true;
    await expect(runOpsCoreDataTransfer(f.options)).rejects.toThrow("TRANSFER_RECONCILIATION_REQUIRED");
    expect(f.databaseName).toBe("corgtex_core"); expect(f.custody.snapshot().phase).toBe("RESTORED");
    expect(f.custody.snapshot().pending.to).toBe("VERIFIED");
    expect(f.custody.snapshot().destinationMayHaveWritten).toBe(false);
    const previous = [...f.events];
    await expect(runOpsCoreDataTransfer(f.options)).rejects.toThrow("TRANSFER_RECONCILIATION_REQUIRED");
    expect(f.events).toEqual(previous);
  });
});
