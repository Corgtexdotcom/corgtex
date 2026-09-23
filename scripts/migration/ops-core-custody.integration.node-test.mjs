import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { randomBytes, randomUUID } from "node:crypto";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { after, before, test } from "node:test";
import { BlobServiceClient, StorageSharedKeyCredential } from "@azure/storage-blob";
import { azureBlobCustodyAdapter, createCutoverJournal, openCutoverCustody } from "./ops-core-custody.mjs";
import { azureProviderOperationStore, openProviderOperationRecorder } from "./ops-core-provider-operations.mjs";
import { openSourceOperations } from "./ops-core-source-operations.mjs";
import { archiveEvidenceHash } from "./ops-core-archive.mjs";
import { postgresPromotionDurableRecord } from "./ops-core-postgres-promotion.mjs";
import { openPostgresPromotionCustody } from "./ops-core-promotion-custody.mjs";

const runId = randomUUID();
const account = "migration";
const key = randomBytes(64).toString("base64");
const intentSha256 = "a".repeat(64);
const evidenceSha256 = "b".repeat(64);
let directory;
let containerId;
let storage;
let dockerHost;
const docker = (...args) => execFileSync("docker", ["--config", directory, "--host", dockerHost, ...args], {
  encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], timeout: 120_000,
}).trim();

before(async () => {
  directory = mkdtempSync(join(tmpdir(), "ops-core-custody-"));
  dockerHost = execFileSync("docker", ["context", "inspect", "--format", "{{.Endpoints.docker.Host}}"], {
    encoding: "utf8", timeout: 10_000,
  }).trim();
  assert.match(dockerHost, /^unix:\/\//);
  // Pull the public emulator without the user's registry credential helper.
  writeFileSync(join(directory, "config.json"), "{}", { mode: 0o600 });
  const envFile = join(directory, "azurite.env");
  writeFileSync(envFile, `AZURITE_ACCOUNTS=${account}:${key}\n`, { mode: 0o600 });
  // No ambient cloud credentials or existing storage enters this test. The
  // emulator has no mounted data and only a loopback-bound ephemeral port.
  containerId = docker("run", "--detach", "--rm", "--label", `corgtex.custody-test=${runId}`,
    "--env-file", envFile, "--publish", "127.0.0.1::10000",
    "mcr.microsoft.com/azure-storage/azurite:3.35.0",
    "azurite-blob", "--blobHost", "0.0.0.0", "--skipApiVersionCheck", "--silent");
  assert.match(containerId, /^[a-f0-9]{64}$/);
  const binding = docker("port", containerId, "10000/tcp");
  assert.match(binding, /^127\.0\.0\.1:[0-9]+$/);
  const service = new BlobServiceClient(`http://${binding}/${account}`, new StorageSharedKeyCredential(account, key), {
    allowInsecureConnection: true, retryOptions: { maxTries: 1, tryTimeoutInMs: 2_000 },
  });
  storage = service.getContainerClient(`custody-${runId}`);
  const deadline = Date.now() + 20_000;
  for (;;) {
    try { await storage.create(); break; }
    catch {
      if (Date.now() > deadline) throw new Error("LOCAL_AZURITE_UNAVAILABLE");
      await delay(250);
    }
  }
});

after(() => {
  if (containerId) {
    const inspected = JSON.parse(docker("inspect", containerId));
    assert.equal(inspected[0]?.Config?.Labels?.["corgtex.custody-test"], runId);
    docker("stop", containerId);
  }
  if (directory) rmSync(directory, { recursive: true });
});

async function journal(name) {
  const client = storage.getBlockBlobClient(name);
  const adapter = azureBlobCustodyAdapter(client);
  await adapter.createOnly(createCutoverJournal({ domain: "ops", intentSha256, evidenceSha256 }));
  return { client, adapter };
}

test("actual Blob operation inventory proves empty prefix and includes intents without descriptors", async () => {
  const store = azureProviderOperationStore(storage), signal = new AbortController().signal;
  const prefix = `operations/core/${"f".repeat(64)}/${randomUUID()}/`;
  assert.deepEqual(await store.listRecords(prefix, signal), []);
  const key = `${prefix}${"e".repeat(64)}/intent.json`;
  await store.createOnly(key, JSON.stringify({ type: "fixture" }), signal);
  assert.deepEqual(await store.listDescriptors(prefix, signal), []);
  assert.deepEqual(await store.listRecords(prefix, signal), [key]);
  await assert.rejects(store.listRecords("operations/", signal), /PROVIDER_RECORD_KEY_INVALID/);
  const aborted = new AbortController(); aborted.abort();
  await assert.rejects(store.listRecords(prefix, aborted.signal));
});

test("promotion callbacks retain independent intent and receipt through the actual Blob adapter", async () => {
  const { adapter } = await journal("promotion-callbacks.json");
  let owner = await openCutoverCustody(adapter, intentSha256);
  const body = { schemaVersion: "1.0.0", operationId: randomUUID(), domain: "ops",
    expectedConnection: { host: "target.fixture", port: 5432, database: "postgres", user: "target_admin" },
    scratchName: "corgtex_rehearsal_10_1_ops", scratchOid: "16401", permanentName: "corgtex_ops",
    targetIdentity: "azurite-callback-fixture", parityEvidenceSha256: "c".repeat(64) };
  const intent = { ...body, sha256: archiveEvidenceHash(body) };
  const record = postgresPromotionDurableRecord(intent);
  const stateFile = join(directory, "promotion-state.json");
  writeFileSync(stateFile, JSON.stringify({ schemaVersion: "1.0.0", scratchName: intent.scratchName,
    targetRef: record.cleanupState.targetRef, phase: "CREATED" }), { mode: 0o600 });
  const store = azureProviderOperationStore(storage);
  const options = () => ({ custody: owner, store, stateFile, intent,
    assertSourceFenced: async () => {}, assertTargetInactive: async () => {} });
  try {
    for (const phase of ["SOURCE_FENCED", "CAPTURED", "RESTORED"]) {
      const operation = await owner.begin(phase, evidenceSha256); await owner.complete(operation.operationId, evidenceSha256);
    }
    const pending = await owner.begin("VERIFIED", intent.sha256);
    const first = await openPostgresPromotionCustody(options());
    assert.equal(await first.readOperationIntent(), null);
    await first.persistOperationIntent(record);
    await owner.close(); owner = await openCutoverCustody(adapter, intentSha256);
    const reopened = await openPostgresPromotionCustody(options());
    assert.deepEqual(await reopened.readOperationIntent(), record);
    // This protocol fixture supplies the database observation; actual promotion
    // is exercised separately by the full pinned PostgreSQL18 copy smoke.
    const result = await reopened.recordResult({ status: "PROMOTED", intentSha256: intent.sha256,
      scratchOid: intent.scratchOid, targetIdentity: intent.targetIdentity, connectionCount: 0,
      custodyVerified: true, targetInactiveVerified: true });
    const prefix = `operations/ops/${intentSha256}/${pending.operationId}/`;
    assert.deepEqual(JSON.parse(await store.readOptional(`${prefix}promotion-receipt.json`, owner.signal)), result.record);
    await assert.rejects(store.createOnly(`${prefix}promotion-intent.json`, JSON.stringify(record), owner.signal));
    assert.equal(owner.snapshot().phase, "RESTORED");
  } finally { await owner.close(); }
});

test("real Blob lease and ETag prevent another owner or stale writer", async () => {
  const { adapter } = await journal("single-owner.json");
  const lease = await adapter.acquire(60);
  try {
    const before = await adapter.read(lease);
    await adapter.write(before.text, { lease, etag: before.etag });
    await assert.rejects(adapter.write(before.text, { lease, etag: before.etag }));
    await assert.rejects(openCutoverCustody(adapter, intentSha256), /CUTOVER_ALREADY_OWNED_OR_UNAVAILABLE/);
  } finally { await adapter.release(lease); }
  const owner = await openCutoverCustody(adapter, intentSha256);
  try {
    await owner.assertOwned();
    const operation = await owner.begin("SOURCE_FENCED", evidenceSha256);
    await owner.complete(operation.operationId, evidenceSha256);
    assert.equal(owner.snapshot().phase, "SOURCE_FENCED");
  } finally { await owner.close(); }
});

test("a committed but unacknowledged cloud write is reconciled by the next owner", async () => {
  const { adapter } = await journal("uncertain-write.json");
  const unreliable = { ...adapter, async write(text, options) {
    await adapter.write(text, options);
    throw new Error("synthetic acknowledgement loss");
  } };
  const first = await openCutoverCustody(unreliable, intentSha256);
  await assert.rejects(first.begin("SOURCE_FENCED", evidenceSha256), /CUTOVER_WRITE_RECONCILE/);
  await first.close();
  const recovery = await openCutoverCustody(adapter, intentSha256);
  try {
    assert.equal(recovery.snapshot().pending.to, "SOURCE_FENCED");
    await assert.rejects(recovery.begin("SOURCE_FENCED", evidenceSha256), /CUTOVER_PENDING_RECONCILIATION_REQUIRED/);
    await recovery.complete(recovery.snapshot().pending.operationId, evidenceSha256);
    assert.equal(recovery.snapshot().phase, "SOURCE_FENCED");
  } finally { await recovery.close(); }
});

test("a duplicate creation cannot overwrite existing recovery custody", async () => {
  const { adapter } = await journal("retained.json");
  await assert.rejects(adapter.createOnly(createCutoverJournal({
    domain: "core", intentSha256: "c".repeat(64), evidenceSha256,
  })), /CUTOVER_CREATE_RECONCILE/);
  const owner = await openCutoverCustody(adapter, intentSha256);
  try { assert.equal(owner.snapshot().domain, "ops"); } finally { await owner.close(); }
});

test("provider intent and receipt survive lost acknowledgement through the real Blob adapter", async () => {
  const { adapter } = await journal("provider-operations.json");
  const store = azureProviderOperationStore(storage);
  let effects = 0;
  const operation = {
    kind: "RAILWAY_STOP_SOURCE_DEPLOYMENT", input: { deploymentId: "synthetic-deployment" },
    async apply() { effects++; throw new Error("simulated lost provider acknowledgement"); },
    async verify() { return { complete: effects === 1, evidence: { stopped: true } }; },
  };
  const first = await openCutoverCustody(adapter, intentSha256);
  try {
    await first.begin("SOURCE_FENCED", evidenceSha256);
    const recorder = await openProviderOperationRecorder({ custody: first, store,
      phase: "SOURCE_FENCED", signal: first.signal });
    await assert.rejects(recorder.runRecordedOperation(operation), /PROVIDER_OPERATION_RECONCILE_REQUIRED/);
  } finally { await first.close(); }
  const recovery = await openCutoverCustody(adapter, intentSha256);
  try {
    const recorder = await openProviderOperationRecorder({ custody: recovery, store,
      phase: "SOURCE_FENCED", signal: recovery.signal });
    const intent = await recorder.readIntent(operation.kind, operation.input);
    assert.ok(intent);
    const result = await recorder.runRecordedOperation(operation);
    assert.equal(result.operationId, intent.operationId);
    assert.equal(result.reconciled, true);
    assert.equal(effects, 1);
    await recorder.runRecordedOperation(operation);
    assert.equal(effects, 1);
    const prefix = `operations/ops/${intentSha256}/${recovery.snapshot().pending.operationId}/${intent.operationKey}`;
    const existing = await store.readOptional(`${prefix}/intent.json`, recovery.signal);
    await assert.rejects(store.createOnly(`${prefix}/intent.json`, existing, recovery.signal));
    assert.equal(await store.readOptional(`${prefix}/intent.json`, recovery.signal), existing);
  } finally { await recovery.close(); }
});

test("source descriptors are discovered after reopen and retain content-addressed provider evidence", async () => {
  const { adapter } = await journal("source-descriptors.json");
  const store = azureProviderOperationStore(storage);
  const descriptor = { kind: "RAILWAY_DISABLE_AUTODEPLOY", input: { projectId: randomUUID(), environmentId: randomUUID(),
    serviceId: randomUUID(), enabled: false, sourceLinkSha256: "c".repeat(64) } };
  let effects = 0;
  const first = await openCutoverCustody(adapter, intentSha256);
  try {
    await first.begin("SOURCE_FENCED", evidenceSha256);
    const operations = await openSourceOperations({ custody: first, store });
    await operations.retainPhaseArtifact("phase-plan", { source: descriptor.input });
    await assert.rejects(operations.runRecordedOperation({ ...descriptor,
      async apply() { effects++; throw Error("lost provider acknowledgement"); },
      async verify() { return { complete: effects === 1, evidence: { disabled: true } }; },
    }), /SOURCE_OPERATION_RECONCILE_REQUIRED/);
  } finally { await first.close(); }
  const next = await openCutoverCustody(adapter, intentSha256);
  try {
    const operations = await openSourceOperations({ custody: next, store });
    assert.deepEqual(await operations.pendingDescriptors(), [descriptor]);
    await operations.runRecordedOperation({ ...descriptor,
      async apply() { assert.fail("must not replay"); },
      async verify() { return { complete: effects === 1, evidence: { disabled: true } }; },
    });
    assert.equal((await operations.assertSettled()).completedCount, 1);
    const evidence = { history: "synthetic-provider-observation ".repeat(3000) };
    const original = await operations.retainPhaseArtifact("phase-evidence", evidence);
    assert.equal(await operations.retainPhaseArtifact("phase-evidence", evidence), original);
    const later = await operations.retainPhaseArtifact("phase-evidence", { ...evidence, readback: "fresh" });
    assert.notEqual(later, original);
    assert.equal(effects, 1);
    assert.deepEqual(await operations.pendingDescriptors(), []);
  } finally { await next.close(); }
});
