// Execute with `npx tsx`: object-transfer adapters are shared TypeScript code.
import { constants } from "node:fs";
import { open, mkdir } from "node:fs/promises";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { createHash } from "node:crypto";
import { AzureCliCredential } from "@azure/identity";
import { ContainerClient } from "@azure/storage-blob";
import { archiveEvidenceHash, azureArchiveStore, validateArchiveKeyVersion } from "./ops-core-archive.mjs";
import { createCutoverJournal, validateCutoverJournal, azureBlobCustodyAdapter, openCutoverCustody } from "./ops-core-custody.mjs";
import { azureProviderOperationStore } from "./ops-core-provider-operations.mjs";
import { runOpsCoreSourceFence, assertOpsCoreSourceFenced, recoverOpsCoreSource } from "./ops-core-source-controller.mjs";
import { runOpsCoreDataTransfer, resumeOpsCoreDataTransfer, reconcileOpsCoreDataTransfer, validateOpsCoreTransferPlan } from "./ops-core-transfer-controller.mjs";
import { createOpsCoreActivation, validateOpsCoreActivationPlan } from "./ops-core-activation.mjs";
import { buildHealthProbeJobDefinition, createHealthJobDispatcher } from "./ops-core-health-job.mjs";
import { runOpsCoreAcceptance, validateOpsCoreAcceptanceBinding } from "./ops-core-acceptance.mjs";
import { createOpsCoreAzureTarget, opsCoreAzureTargetBindingSha256 } from "./ops-core-azure-target.mjs";
import { runOpsCoreTransferPreflight } from "./ops-core-preflight.mjs";
import { createOpsCoreSourceHealthObserver, validateOpsCoreSourceHealthPlan } from "./ops-core-source-health.mjs";
import { RailwayObjectSource } from "./railway-object-source.ts";
import { AzureBlobObjectStore } from "./shared-tenant-objects.ts";
import { createRuntimeSecretResolver, assertOpsCoreRuntimeAccessForActivation } from "./ops-core-runtime-access-controller.mjs";

class OperatorError extends Error {}
const need = (condition, code) => { if (!condition) throw new OperatorError(code); };
const same = (left, right) => archiveEvidenceHash(left) === archiveEvidenceHash(right);
const containerUrl = value => typeof value === "string"
  && /^https:\/\/[a-z0-9]{3,24}\.blob\.core\.windows\.net\/[a-z0-9][a-z0-9-]{1,61}[a-z0-9]$/.test(value);
const GUID = /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/;

export async function readPrivateMigrationJson(path) {
  let handle;
  try {
    handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
    const stat = await handle.stat();
    need(stat.isFile() && stat.nlink === 1 && (stat.mode & 0o077) === 0
      && stat.uid === process.getuid() && stat.size > 0 && stat.size <= 2 * 1024 * 1024, "MIGRATION_INPUT_NOT_PRIVATE");
    return JSON.parse(await handle.readFile("utf8"));
  } catch (error) { throw error instanceof OperatorError ? error : new OperatorError("MIGRATION_INPUT_INVALID"); }
  finally { await handle?.close(); }
}

export function validateOperatorPlan(plan) {
  const p = structuredClone(plan); const o = p?.operator;
  need([1, 2].includes(p?.schemaVersion) && ["core", "ops"].includes(p.domain) && o
    && Object.keys(o).sort().join() === "archiveContainerUrl,azureIdentity,custodyContainerUrl,sourceObjects,targetObjectContainerUrl"
    && [o.custodyContainerUrl, o.archiveContainerUrl, o.targetObjectContainerUrl].every(containerUrl)
    && new Set([o.custodyContainerUrl, o.archiveContainerUrl, o.targetObjectContainerUrl]).size === 3
    && new URL(o.custodyContainerUrl).origin !== new URL(o.targetObjectContainerUrl).origin
    && new URL(o.archiveContainerUrl).origin !== new URL(o.targetObjectContainerUrl).origin
    && GUID.test(o.azureIdentity?.subscriptionId) && o.azureIdentity.subscriptionId === p.azure?.subscriptionId && GUID.test(o.azureIdentity?.tenantId)
    && typeof o.azureIdentity?.principalName === "string" && o.azureIdentity.principalName.length > 0
    && p.azure?.domain === p.domain && same(p.activation?.target, p.azure)
    && o.sourceObjects && Object.keys(o.sourceObjects).sort().join() === "bucket,endpoint,identity"
    && o.sourceObjects.endpoint === "https://t3.storageapi.dev"
    && o.sourceObjects.identity === p.transfer?.objects?.sourceStoreId, "MIGRATION_PLAN_INVALID");
  const storageIdentity = value => createHash("sha256").update(value).digest("hex");
  need(p.transfer.postgres.archiveStoreId === storageIdentity(o.archiveContainerUrl)
    && p.transfer.objects.targetStoreId === storageIdentity(o.targetObjectContainerUrl), "MIGRATION_STORAGE_BINDING_MISMATCH");
  const workerId = `/subscriptions/${p.azure.subscriptionId}/resourceGroups/${p.azure.resourceGroupName}/providers/Microsoft.App/containerApps/${p.azure.apps.worker}`;
  need(p.health?.worker?.appId === workerId && p.health.environmentResourceId === p.azure.environmentId
    && p.health.worker.image === p.activation.roles.worker.image
    && same(p.health.worker.release, p.activation.release), "MIGRATION_HEALTH_BINDING_MISMATCH");
  const sourcePassword = p.source?.postgres;
  need(sourcePassword && sourcePassword.originalSecretVersion !== sourcePassword.retainedSecretVersion,
    "MIGRATION_SOURCE_RECOVERY_BINDING_INVALID");
  validateArchiveKeyVersion(sourcePassword.originalSecretVersion, sourcePassword.vaultName);
  validateArchiveKeyVersion(sourcePassword.retainedSecretVersion, sourcePassword.vaultName);
  validateOpsCoreSourceHealthPlan(p.source.health, p.source.writers?.binding);
  buildHealthProbeJobDefinition(p.health);
  validateOpsCoreTransferPlan(p);
  validateOpsCoreActivationPlan(p.activation);
  return p;
}

export async function fetchWebActivationHealth({ role, origin, signal }, fetchImpl = fetch) {
  need(role === "web" && /^https:\/\/[a-z0-9-]+\.[a-z0-9.-]+\.azurecontainerapps\.io$/.test(origin), "MIGRATION_HEALTH_ORIGIN_INVALID");
  const bounded = AbortSignal.any([signal, AbortSignal.timeout(20_000)]);
  const response = await fetchImpl(`${origin}/api/health`, { method: "GET", redirect: "error", signal: bounded,
    headers: { Accept: "application/json" } });
  need(response.status === 200 && !response.redirected && response.url === `${origin}/api/health`
    && /^application\/json(?:\s*;|$)/i.test(response.headers.get("content-type") ?? ""), "MIGRATION_WEB_HEALTH_UNPROVEN");
  const reader = response.body?.getReader(); need(reader, "MIGRATION_WEB_HEALTH_UNPROVEN");
  const parts = []; let bytes = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read(); if (done) break;
      bytes += value.byteLength; need(bytes <= 32768, "MIGRATION_WEB_HEALTH_TOO_LARGE"); parts.push(Buffer.from(value));
    }
    bounded.throwIfAborted();
    const body = JSON.parse(Buffer.concat(parts).toString("utf8"));
    return { health: { status: response.status, body }, evidence: { observedAt: new Date().toISOString(),
      origin, responseSha256: archiveEvidenceHash(body) } };
  } finally { await reader.cancel().catch(() => {}); }
}

async function assertAzureIdentity(plan) {
  try {
    const { stdout } = await promisify(execFile)("az", ["account", "show", "--output", "json", "--only-show-errors"],
      { timeout: 15_000, maxBuffer: 65536, encoding: "utf8", shell: false });
    const account = JSON.parse(stdout); const expected = plan.operator.azureIdentity;
    need(account.id === expected.subscriptionId && account.tenantId === expected.tenantId
      && account.user?.name === expected.principalName && account.state === "Enabled", "MIGRATION_AZURE_IDENTITY_MISMATCH");
  } catch (error) { throw error instanceof OperatorError ? error : new OperatorError("MIGRATION_AZURE_IDENTITY_UNPROVEN"); }
}

async function readBlobJson(blob) {
  const r = await blob.download(); const parts = []; let bytes = 0;
  need(r.readableStreamBody && r.contentLength <= 2 * 1024 * 1024, "MIGRATION_RETAINED_PLAN_INVALID");
  for await (const part of r.readableStreamBody) {
    bytes += part.length; need(bytes <= 2 * 1024 * 1024, "MIGRATION_RETAINED_PLAN_INVALID"); parts.push(Buffer.from(part));
  }
  return JSON.parse(Buffer.concat(parts).toString("utf8"));
}
async function readOptionalBlobJson(blob) {
  try { return await readBlobJson(blob); }
  catch (error) { if (error?.statusCode === 404 && error?.code === "BlobNotFound") return null; throw error; }
}

/** Actual operator dispatch. The one stable per-domain journal serializes all
 * steps outside Ops. Each invocation reopens its exact retained global plan.
 * initialize is create-only; subsequent actions never overwrite a plan or
 * automatically replay incomplete effects. Routing/acceptance record independently
 * checked evidence; DNS changes and retirement remain separate operations.
 */
export async function runOpsCoreMigration({ action, plan: input, credentials, artifactDir, healthProbe,
  containerFactory, identityCheck = assertAzureIdentity, runtime = {}, acceptanceArtifact }) {
  let custody;
  try {
    need(["initialize", "status", "preflight", "fence", "transfer", "activate", "reconcile-transfer", "resume-transfer",
      "reconcile-activate", "resume-activate", "recover-source", "reconcile-source-recovery", "record-routing", "accept", "retain-acceptance-evidence"].includes(action), "MIGRATION_ACTION_INVALID");
    const plan = validateOperatorPlan(input); const intentSha256 = archiveEvidenceHash(plan);
    await identityCheck(plan);
    const azureCredential = new AzureCliCredential({ processTimeoutInMs: 10_000 });
    const container = containerFactory ?? (url => new ContainerClient(url, azureCredential, { retryOptions: { maxTries: 1 } }));
    const custodyContainer = container(plan.operator.custodyContainerUrl);
    need(!(await custodyContainer.getAccessPolicy()).blobPublicAccess, "MIGRATION_CUSTODY_PUBLIC");
    const retainedPlan = custodyContainer.getBlockBlobClient(`plans/${plan.domain}/${intentSha256}.json`);
    const journalBlob = custodyContainer.getBlockBlobClient(`cutovers/${plan.domain}.json`);
    const journal = azureBlobCustodyAdapter(journalBlob);
    if (action === "initialize") {
      const text = JSON.stringify(plan);
      const existing = await readOptionalBlobJson(retainedPlan);
      if (existing === null) await retainedPlan.upload(text, Buffer.byteLength(text), { conditions: { ifNoneMatch: "*" },
        blobHTTPHeaders: { blobContentType: "application/json" } });
      else need(same(existing, plan), "MIGRATION_RETAINED_PLAN_MISMATCH");
      need(same(await readBlobJson(retainedPlan), plan), "MIGRATION_RETAINED_PLAN_MISMATCH");
      const existingJournal = await readOptionalBlobJson(journalBlob);
      if (existingJournal === null) await journal.createOnly(createCutoverJournal({ domain: plan.domain, intentSha256,
        evidenceSha256: archiveEvidenceHash({ schemaVersion: 1, type: "RETAINED_MIGRATION_PLAN", intentSha256 }) }));
      else validateCutoverJournal(existingJournal, intentSha256);
    }
    need(same(await readBlobJson(retainedPlan), plan), "MIGRATION_RETAINED_PLAN_MISMATCH");
    custody = await openCutoverCustody(journal, intentSha256);
    if (["initialize", "status"].includes(action)) {
      const state = custody.snapshot();
      return { status: state.phase, domain: plan.domain, intentSha256, pending: state.pending,
        destinationMayHaveWritten: state.destinationMayHaveWritten };
    }
    need(credentials && credentials.sourceConfig && credentials.readerConfig, "MIGRATION_CREDENTIALS_REQUIRED");
    const operationStore = azureProviderOperationStore(custodyContainer);
    const railway = credentials.railwayToken ? { token: credentials.railwayToken } : {};
    let sourceHealth;
    const assertSourceHealthy = runtime.assertSourceHealthy ?? (request => {
      sourceHealth ??= createOpsCoreSourceHealthObserver({ plan, signal: custody.signal,
        assertOwned: () => custody.assertOwned(), ...railway, redisSourceCredentials: credentials.redisSource });
      return sourceHealth(request);
    });
    const sourceOptions = { plan, custody, operationStore, sourceConfig: credentials.sourceConfig,
      readerConfig: credentials.readerConfig, railway, assertSourceHealthy };
    const resolveRuntimeSecretVersion = plan.transfer.postgres.runtimeAccess
      ? runtime.resolveRuntimeSecretVersion ?? createRuntimeSecretResolver({ vaultUri: plan.activation.runtimeVaultUri, signal: custody.signal })
      : undefined;
    if (["recover-source", "reconcile-source-recovery"].includes(action)) {
      need(!custody.snapshot().destinationMayHaveWritten, "MIGRATION_SOURCE_RECOVERY_FORBIDDEN");
      const target = createOpsCoreAzureTarget({ binding: plan.azure, custody,
        ...(runtime.azureTransport ? { transport: runtime.azureTransport } : {}) });
      const assertTargetInactive = async () => {
        await custody.assertOwned();
        need(!custody.snapshot().destinationMayHaveWritten, "MIGRATION_SOURCE_RECOVERY_FORBIDDEN");
        const evidence = await target.assertInactive();
        need(evidence.complete === true && evidence.domain === plan.domain && evidence.intentSha256 === intentSha256
          && evidence.targetBindingSha256 === opsCoreAzureTargetBindingSha256(plan.azure), "MIGRATION_RECOVERY_TARGET_UNPROVEN");
        return evidence;
      };
      return await (runtime.recoverSource ?? recoverOpsCoreSource)({ ...sourceOptions, assertTargetInactive,
        action: action === "recover-source" ? "apply" : "reconcile" });
    }
    const transferOptions = () => ({ plan, custody, operationStore, artifactDir, railway,
      sourceCredentials: { sourceConfig: credentials.sourceConfig, readerConfig: credentials.readerConfig },
      targetAdminConfig: credentials.targetAdminConfig, redisSourceCredentials: credentials.redisSource,
      ...(resolveRuntimeSecretVersion ? { resolveRuntimeSecretVersion } : {}),
      archiveStore: azureArchiveStore(container(plan.operator.archiveContainerUrl)),
      objectSource: new RailwayObjectSource({ ...plan.operator.sourceObjects,
        verifiedBinding: plan.operator.sourceObjects, credentials: credentials.objectSource }),
      objectTarget: new AzureBlobObjectStore(container(plan.operator.targetObjectContainerUrl)) });
    if (["preflight", "fence"].includes(action)) {
      const preflight = await (runtime.transferPreflight ?? runOpsCoreTransferPreflight)(transferOptions(), runtime.preflightDependencies);
      if (action === "preflight") return preflight;
      return await (runtime.fence ?? runOpsCoreSourceFence)(sourceOptions);
    }
    if (["transfer", "reconcile-transfer", "resume-transfer"].includes(action)) {
      need(typeof artifactDir === "string" && artifactDir.length > 0, "MIGRATION_ARTIFACT_DIRECTORY_REQUIRED");
      await mkdir(artifactDir, { recursive: true, mode: 0o700 });
      const transfer = action === "transfer" ? runtime.transfer ?? runOpsCoreDataTransfer
        : action === "resume-transfer" ? runtime.resumeTransfer ?? resumeOpsCoreDataTransfer
          : runtime.reconcileTransfer ?? reconcileOpsCoreDataTransfer;
      return await transfer(transferOptions());
    }
    const assertSourceFenced = async () => {
      const proof = await (runtime.assertSource ?? assertOpsCoreSourceFenced)(sourceOptions);
      need(proof.domain === plan.domain && proof.intentSha256 === intentSha256
        && proof.railway?.complete === true, "MIGRATION_SOURCE_UNPROVEN");
      const sourceFenceSha256 = custody.snapshot().history.find(entry => entry.phase === "SOURCE_FENCED")?.evidenceSha256;
      need(/^[a-f0-9]{64}$/.test(sourceFenceSha256), "MIGRATION_SOURCE_UNPROVEN");
      return { complete: true, domain: plan.domain, intentSha256, sourceFenceSha256 };
    };
    let workerHealth;
    const actualHealthProbe = healthProbe ?? (request => {
      if (request.role === "web") return fetchWebActivationHealth(request);
      workerHealth ??= createHealthJobDispatcher({ plan: plan.health, custody, operationStore, assertSourceFenced,
        mode: custody.snapshot().pending?.to === "TARGET_ACTIVATING" ? "migration" : "acceptance",
        ...(plan.activation.workerDemand ? { workerDemand: { plan: plan.activation.workerDemand, target: plan.azure } } : {}),
        ...(runtime.healthTransport ? { transport: runtime.healthTransport } : {}) });
      return workerHealth.probeHealth(request);
    });
    const activation = () => (runtime.activate ?? createOpsCoreActivation)({ plan: plan.activation, custody,
      operationStore, assertSourceFenced, healthProbe: actualHealthProbe,
      ...(plan.transfer.postgres.runtimeAccess ? { assertRuntimeAccess: ({ fresh }) => assertOpsCoreRuntimeAccessForActivation({
        plan, custody, operationStore, targetAdminConfig: credentials.targetAdminConfig,
        resolveSecretVersion: resolveRuntimeSecretVersion, assertSourceFenced, fresh,
        assertTargetInactive: () => createOpsCoreAzureTarget({ binding: plan.azure, custody,
          ...(runtime.azureTransport ? { transport: runtime.azureTransport } : {}) }).assertInactive(),
      }) } : {}) });
    if (["record-routing", "accept", "retain-acceptance-evidence"].includes(action)) {
      need(acceptanceArtifact, "MIGRATION_ACCEPTANCE_ARTIFACT_REQUIRED");
      const binding = validateOpsCoreAcceptanceBinding(acceptanceArtifact.binding);
      const state = custody.snapshot();
      need(binding.domain === plan.domain && binding.intentSha256 === intentSha256
        && binding.targetBindingSha256 === archiveEvidenceHash(plan.azure)
        && same(binding.release, plan.activation.release)
        && binding.sourceFenceSha256 === state.history.find(x => x.phase === "SOURCE_FENCED")?.evidenceSha256,
        "MIGRATION_ACCEPTANCE_BINDING_MISMATCH");
      const evidenceStore = {
        async assertPrivate() { need(!(await custodyContainer.getAccessPolicy()).blobPublicAccess, "MIGRATION_CUSTODY_PUBLIC"); },
        async readOptional(key) { validKey(key); const value = await readOptionalBlobJson(custodyContainer.getBlockBlobClient(key));
          return value === null ? null : JSON.stringify(value); },
        async createOnly(key,text,signal) { validKey(key); signal.throwIfAborted();
          need(Buffer.byteLength(text) <= 512 * 1024, "MIGRATION_ACCEPTANCE_EVIDENCE_TOO_LARGE");
          await custodyContainer.getBlockBlobClient(key).upload(text,Buffer.byteLength(text), { abortSignal:signal,
            conditions:{ifNoneMatch:"*"},blobHTTPHeaders:{blobContentType:"application/json"} }); },
      };
      function validKey(key) { need(new RegExp(`^acceptance/${plan.domain}/${intentSha256}/[a-f0-9]{64}\\.json$`).test(key),
        "MIGRATION_ACCEPTANCE_KEY_INVALID"); }
      if (action === "retain-acceptance-evidence") {
        need(state.destinationMayHaveWritten && ["TARGET_ACTIVE", "ROUTED"].includes(state.phase), "MIGRATION_ACCEPTANCE_PHASE_INVALID");
        const evidenceSha256 = archiveEvidenceHash(acceptanceArtifact), key = `acceptance/${plan.domain}/${intentSha256}/${evidenceSha256}.json`;
        await custody.assertOwned(); await evidenceStore.assertPrivate();
        const prior = await evidenceStore.readOptional(key);
        if (prior === null) await evidenceStore.createOnly(key, JSON.stringify(acceptanceArtifact), custody.signal);
        need(archiveEvidenceHash(JSON.parse(await evidenceStore.readOptional(key))) === evidenceSha256, "MIGRATION_ACCEPTANCE_EVIDENCE_CHANGED");
        await custody.assertOwned(); return {status:"EVIDENCE_RETAINED",domain:plan.domain,evidenceSha256};
      }
      return await (runtime.acceptance ?? runOpsCoreAcceptance)({ phase:action === "record-routing" ? "ROUTED" : "ACCEPTED",
        binding,custody,evidenceStore,artifact:acceptanceArtifact,assertSourceFenced,
        observeRuntime: options => activation().observe(options) });
    }
    const method = action === "reconcile-activate" ? "reconcile" : action === "resume-activate" ? "resume" : "activate";
    return await activation()[method]();
  } catch (error) { throw error instanceof OperatorError ? error : new OperatorError("MIGRATION_RECONCILIATION_REQUIRED"); }
  finally { await custody?.close(); }
}

export async function runOpsCoreMigrationCli(argv = process.argv.slice(2)) {
  need(argv.length >= 2 && argv.length <= 5, "MIGRATION_USAGE_ACTION_PLAN_CREDENTIALS_ARTIFACTS");
  const [action, planPath, credentialPath, artifacts, acceptancePath] = argv;
  const plan = await readPrivateMigrationJson(planPath);
  const credentials = credentialPath ? await readPrivateMigrationJson(credentialPath) : undefined;
  const result = await runOpsCoreMigration({ action, plan, credentials, artifactDir: artifacts && resolve(artifacts),
    acceptanceArtifact: acceptancePath ? await readPrivateMigrationJson(acceptancePath) : undefined });
  // Keep customer/provider evidence in the private stores, not CI stdout.
  process.stdout.write(`${JSON.stringify({ status: result.status ?? result.phase, domain: plan.domain,
    intentSha256: archiveEvidenceHash(plan), evidenceSha256: result.evidenceSha256 ?? null, complete: result.complete ?? null,
    code: result.code ?? null, nextAction: result.nextAction ?? null, historical: result.historical ?? false })}\n`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  runOpsCoreMigrationCli().catch(() => { process.stderr.write("MIGRATION_RECONCILIATION_REQUIRED\n"); process.exitCode = 1; });
}
