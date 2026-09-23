import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { randomBytes, randomUUID } from "node:crypto";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { before, after, test } from "node:test";
import { BlobServiceClient, StorageSharedKeyCredential } from "@azure/storage-blob";
import { azureOpsCoreReleaseStore, openOpsCoreReleaseCustody, opsCoreReleaseCustodyDiagnostic } from "./ops-core-release-custody.mjs";

// Local emulator only. No ambient Azure credentials, account, public port,
// mounted production data or cloud container is accepted by this fixture.
const runId = randomUUID(), account = "releasefixture", key = randomBytes(64).toString("base64");
let directory, dockerHost, containerId, storage;
const docker = (...args) => execFileSync("docker", ["--config", directory, "--host", dockerHost, ...args], {
  encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], timeout: 30_000,
}).trim();
before(async () => {
  directory = mkdtempSync(join(tmpdir(), "ops-core-release-custody-"));
  dockerHost = execFileSync("docker", ["context", "inspect", "--format", "{{.Endpoints.docker.Host}}"], { encoding: "utf8", timeout: 10_000 }).trim();
  assert.match(dockerHost, /^unix:\/\//);
  writeFileSync(join(directory, "config.json"), "{}", { mode: 0o600 });
  const envFile = join(directory, "emulator.env");
  writeFileSync(envFile, `AZURITE_ACCOUNTS=${account}:${key}\n`, { mode: 0o600 });
  containerId = docker("run", "--detach", "--rm", "--pull=never", "--label", `corgtex.release-custody-test=${runId}`,
    "--env-file", envFile, "--publish", "127.0.0.1::10000", "mcr.microsoft.com/azure-storage/azurite:3.35.0",
    "azurite-blob", "--blobHost", "0.0.0.0", "--skipApiVersionCheck", "--silent");
  assert.match(containerId, /^[a-f0-9]{64}$/);
  const endpoint = docker("port", containerId, "10000/tcp"); assert.match(endpoint, /^127\.0\.0\.1:\d+$/);
  const service = new BlobServiceClient(`http://${endpoint}/${account}`, new StorageSharedKeyCredential(account, key), {
    allowInsecureConnection: true, retryOptions: { maxTries: 1, tryTimeoutInMs: 2000 },
  });
  storage = service.getContainerClient(`release-${runId}`);
  const deadline = Date.now() + 20_000;
  for (;;) {
    try { await storage.create(); break; }
    catch { if (Date.now() > deadline) throw Error("LOCAL_RELEASE_AZURITE_UNAVAILABLE"); await sleep(100); }
  }
});
after(() => {
  if (containerId) {
    const state = JSON.parse(docker("inspect", containerId));
    assert.equal(state[0]?.Config?.Labels?.["corgtex.release-custody-test"], runId); docker("stop", containerId);
  }
  if (directory) rmSync(directory, { recursive: true });
});
const options = domain => ({ container: storage, domain, targetBindingSha256: "a".repeat(64),
  plan: { releaseId: randomUUID(), release: { gitSha: "b".repeat(40), version: "1.2.3" } } });
const result = { complete: true, status: "RELEASED", evidenceSha256: "c".repeat(64) };

test("real SDK/Azurite stable lease, conditional pointer and immutable result survive reopen", async () => {
  const input = options("ops"); let owner = await openOpsCoreReleaseCustody(input);
  try {
    assert.equal(owner.mode, "apply");
    await assert.rejects(openOpsCoreReleaseCustody({ ...input, plan: { ...input.plan, releaseId: randomUUID() } }));
    await owner.assertOwned(); await owner.close();
    owner = await openOpsCoreReleaseCustody(input); assert.equal(owner.mode, "reconcile");
    const snapshot = owner.snapshot(); assert.equal(snapshot.pending.operationId, input.plan.releaseId);
    await owner.finish(result); await owner.close();
    owner = await openOpsCoreReleaseCustody(input); assert.equal(owner.mode, "finished"); assert.deepEqual(owner.result, result);
    await owner.close();
    owner = await openOpsCoreReleaseCustody({ ...input, plan: { ...input.plan, releaseId: randomUUID() } });
    assert.equal(owner.mode, "apply"); assert.equal(owner.lockPath, "release-custody/ops/owner.json");
  } finally { await owner.close(); }
});

test("real SDK retained result after lost acknowledgement requires explicit reconciliation", async () => {
  const input = options("core"), real = azureOpsCoreReleaseStore(storage);
  let loseResult = true;
  const store = { ...real, async createOnly(path, text, signal) {
    await real.createOnly(path, text, signal);
    if (path.endsWith("/result.json") && loseResult) { loseResult = false; throw Error("injected lost response"); }
  } };
  let owner = await openOpsCoreReleaseCustody({ ...input, store });
  try {
    await assert.rejects(owner.finish(result), error => opsCoreReleaseCustodyDiagnostic(error) === "RELEASE_FINISH_UNCERTAIN");
    await owner.close();
    await assert.rejects(openOpsCoreReleaseCustody({ ...input, plan: { ...input.plan, releaseId: randomUUID() } }),
      error => opsCoreReleaseCustodyDiagnostic(error) === "RELEASE_PRIOR_UNFINISHED");
    owner = await openOpsCoreReleaseCustody(input);
    assert.equal(owner.mode, "reconcile"); assert.deepEqual(owner.result, result);
    await owner.finish(result); assert.equal(owner.mode, "finished");
  } finally { await owner.close(); }
});
