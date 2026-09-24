import { constants } from "node:fs";
import { open } from "node:fs/promises";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { AzureCliCredential } from "@azure/identity";
import { ContainerClient } from "@azure/storage-blob";
import { archiveEvidenceHash as hash } from "./ops-core-archive.mjs";
import { validateCutoverJournal } from "./ops-core-custody.mjs";
import { opsCoreAzureTargetBindingSha256 } from "./ops-core-azure-target.mjs";
import { azureProviderOperationStore, providerOperationDiagnostic } from "./ops-core-provider-operations.mjs";
import { openOpsCoreReleaseCustody, opsCoreReleaseCustodyDiagnostic } from "./ops-core-release-custody.mjs";
import { buildHealthProbeJobDefinition, createHealthJobDispatcher } from "./ops-core-health-job.mjs";
import { validateOpsCoreUpdatePlan, runOpsCoreUpdate, opsCoreUpdateDiagnostic } from "./ops-core-update.mjs";

const LIMIT = 2 * 1024 * 1024;
const HASH = /^[a-f0-9]{64}$/;
const UUID = /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/;
const exact = (v, keys) => v && typeof v === "object" && !Array.isArray(v)
  && Object.keys(v).sort().join() === keys.split(",").sort().join();
const same = (a, b) => hash(a) === hash(b);
class CliError extends Error {}
const need = (v, code) => { if (!v) throw new CliError(code); };
const containerUrl = value => typeof value === "string"
  && /^https:\/\/[a-z0-9]{3,24}\.blob\.core\.windows\.net\/[a-z0-9][a-z0-9-]{1,61}[a-z0-9]$/.test(value);

export function validateUpdateEnvelope(input) {
  const e = structuredClone(input);
  need(exact(e, "schemaVersion,plan,operator,health") && e.schemaVersion === 1
    && exact(e.operator, "custodyContainerUrl,azureIdentity") && containerUrl(e.operator.custodyContainerUrl)
    && exact(e.operator.azureIdentity, "subscriptionId,tenantId,principalName")
    && [e.operator.azureIdentity.subscriptionId, e.operator.azureIdentity.tenantId].every(v => UUID.test(v))
    && typeof e.operator.azureIdentity.principalName === "string" && e.operator.azureIdentity.principalName.length > 0
    && e.operator.azureIdentity.principalName.length <= 256 && exact(e.health, "baseline,incoming,recovery"), "UPDATE_ENVELOPE_INVALID");
  e.plan = validateOpsCoreUpdatePlan(e.plan);
  need(e.operator.azureIdentity.subscriptionId === e.plan.target.subscriptionId, "UPDATE_IDENTITY_TARGET_MISMATCH");
  const p = e.plan, stem = `/subscriptions/${p.target.subscriptionId}/resourceGroups/${p.target.resourceGroupName}/providers/Microsoft.App/`;
  for (const phase of ["baseline", "incoming", "recovery"]) {
    const h = e.health[phase]; buildHealthProbeJobDefinition(h);
    need(h.worker.appId === `${stem}containerApps/${p.target.apps.worker}` && h.worker.origin === p.origins.worker
      && h.worker.image === p[phase].images.worker && same(h.worker.release, p[phase].release)
      && h.environmentResourceId === p.target.environmentId && h.jobResourceId.startsWith(`${stem}jobs/`), "UPDATE_HEALTH_PLAN_MISMATCH");
  }
  need(new Set(Object.values(e.health).map(h => h.jobResourceId.toLowerCase())).size === 3, "UPDATE_HEALTH_JOBS_NOT_DISTINCT");
  return e;
}

export async function readPrivateUpdateEnvelope(path) {
  let file;
  try {
    file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
    const stat = await file.stat();
    need(stat.isFile() && stat.nlink === 1 && stat.uid === process.getuid() && (stat.mode & 0o077) === 0
      && stat.size > 0 && stat.size <= LIMIT, "UPDATE_INPUT_NOT_PRIVATE");
    return validateUpdateEnvelope(JSON.parse(await file.readFile("utf8")));
  } catch (error) { throw error instanceof CliError ? error : new CliError("UPDATE_INPUT_INVALID"); }
  finally { await file?.close(); }
}

export async function assertUpdateAzureIdentity(expected, exec = promisify(execFile)) {
  try {
    const { stdout } = await exec("az", ["account", "show", "--output", "json", "--only-show-errors"],
      { encoding: "utf8", timeout: 15_000, maxBuffer: 65536, shell: false });
    const actual = JSON.parse(stdout);
    need(actual.id === expected.subscriptionId && actual.tenantId === expected.tenantId
      && actual.user?.name === expected.principalName && actual.state === "Enabled", "UPDATE_AZURE_IDENTITY_MISMATCH");
  } catch (error) { throw error instanceof CliError ? error : new CliError("UPDATE_AZURE_IDENTITY_UNPROVEN"); }
}

const client = url => new ContainerClient(url, new AzureCliCredential({ processTimeoutInMs: 10_000 }),
  { retryOptions: { maxTries: 1, tryTimeoutInMs: 20_000 } });

export async function readUpdateBlob(container, key, signal, optional = false) {
  let r;
  try { r = await container.getBlockBlobClient(key).download(0, undefined, { abortSignal: signal }); }
  catch (error) {
    if (optional && error?.statusCode === 404 && error?.code === "BlobNotFound") return null;
    throw new CliError("UPDATE_AUTHORITY_READ_FAILED");
  }
  need(r.readableStreamBody && r.contentLength <= LIMIT, "UPDATE_AUTHORITY_RECORD_INVALID");
  const chunks = []; let bytes = 0;
  for await (const chunk of r.readableStreamBody) {
    signal?.throwIfAborted(); bytes += chunk.length;
    need(bytes <= LIMIT, "UPDATE_AUTHORITY_RECORD_INVALID"); chunks.push(Buffer.from(chunk));
  }
  signal?.throwIfAborted();
  return JSON.parse(Buffer.concat(chunks).toString("utf8"));
}

/** Verifies actual retained acceptance, not a caller's assertion that migration
 * finished. Compatibility is an explicit retained operator/reviewer attestation;
 * it must cover the complete image triples and post-migration recovery schema. */
export async function assertRetainedUpdateAuthority(envelope, container, signal) {
  const { plan: p, operator, health } = envelope, a = p.authority;
  need(!(await container.getAccessPolicy({ abortSignal: signal })).blobPublicAccess, "UPDATE_CUSTODY_PUBLIC");
  const journal = await readUpdateBlob(container, `cutovers/${p.domain}.json`, signal);
  validateCutoverJournal(journal, a.migrationIntentSha256);
  need(journal.domain === p.domain && journal.phase === "ACCEPTED" && journal.pending === null
    && journal.destinationMayHaveWritten === true && hash(journal) === a.acceptedMigrationSha256
    && journal.history.find(v => v.phase === "SOURCE_FENCED")?.evidenceSha256 === a.migrationSourceFenceSha256, "UPDATE_MIGRATION_NOT_ACCEPTED");
  const migration = await readUpdateBlob(container, `plans/${p.domain}/${a.migrationIntentSha256}.json`, signal);
  need(hash(migration) === a.migrationIntentSha256 && migration.domain === p.domain && same(migration.azure, p.target)
    && migration.activation?.acrServer === `${p.acrName}.azurecr.io`
    && migration.operator?.custodyContainerUrl === operator.custodyContainerUrl
    && containerUrl(migration.operator.targetObjectContainerUrl)
    && new URL(migration.operator.targetObjectContainerUrl).origin !== new URL(operator.custodyContainerUrl).origin,
  "UPDATE_MIGRATION_BINDING_MISMATCH");
  for (const h of Object.values(health)) for (const field of ["environmentResourceId", "infrastructureSubnetId", "workspaceId", "identityResourceId", "location"]) {
    need(h[field] === migration.health?.[field], "UPDATE_HEALTH_INFRASTRUCTURE_MISMATCH");
  }
  const proof = await readUpdateBlob(container, `compatible-release-proofs/${a.compatibilitySha256}.json`, signal);
  need(hash(proof) === a.compatibilitySha256 && exact(proof, "schemaVersion,domain,targetBindingSha256,baseline,incoming,recovery,compatibleRecovery")
    && proof.schemaVersion === 1 && proof.domain === p.domain && proof.compatibleRecovery === true
    && proof.targetBindingSha256 === opsCoreAzureTargetBindingSha256(p.target)
    && ["baseline", "incoming", "recovery"].every(phase => same(proof[phase], p[phase])), "UPDATE_COMPATIBILITY_UNPROVEN");
  signal?.throwIfAborted();
}

export async function executeOpsCoreUpdate(action, input, dependencies = {}) {
  need(["apply", "reconcile", "recover"].includes(action), "UPDATE_ACTION_INVALID");
  const envelope = validateUpdateEnvelope(input), p = envelope.plan;
  await (dependencies.identityCheck ?? assertUpdateAzureIdentity)(envelope.operator.azureIdentity);
  const container = (dependencies.containerFactory ?? client)(envelope.operator.custodyContainerUrl);
  await assertRetainedUpdateAuthority(envelope, container);
  // Bind health definitions and CLI identity once per release as well as the
  // controller plan. A different probe job cannot bypass an uncertain start.
  const envelopeKey = `update-envelopes/${p.domain}/${p.releaseId}.json`;
  const existing = await readUpdateBlob(container, envelopeKey, undefined, true);
  if (existing === null) {
    const text = JSON.stringify(envelope);
    await container.getBlockBlobClient(envelopeKey).upload(text, Buffer.byteLength(text), { conditions: { ifNoneMatch: "*" },
      blobHTTPHeaders: { blobContentType: "application/json" } });
  } else need(same(existing, envelope), "UPDATE_ENVELOPE_CHANGED");
  need(same(await readUpdateBlob(container, envelopeKey), envelope), "UPDATE_ENVELOPE_CHANGED");
  const custody = await (dependencies.openCustody ?? openOpsCoreReleaseCustody)({ container, domain: p.domain,
    targetBindingSha256: opsCoreAzureTargetBindingSha256(p.target), plan: p });
  try {
    if (custody.mode === "finished") return { status: "RETAINED_RESULT", freshAcceptance: false,
      domain: p.domain, releaseId: p.releaseId, resultSha256: hash(custody.result) };
    const operationStore = azureProviderOperationStore(container);
    const binding = { domain: p.domain, intentSha256: hash(p), releaseId: p.releaseId,
      targetBindingSha256: opsCoreAzureTargetBindingSha256(p.target), ...p.authority };
    const authority = async request => {
      await custody.assertOwned(); custody.signal.throwIfAborted();
      need(same(request, binding), "UPDATE_AUTHORITY_REQUEST_MISMATCH");
      await assertRetainedUpdateAuthority(envelope, container, custody.signal);
      need(same(await readUpdateBlob(container, envelopeKey, custody.signal), envelope), "UPDATE_ENVELOPE_CHANGED");
      await custody.assertOwned(); custody.signal.throwIfAborted();
      return { complete: true, binding };
    };
    const dispatchers = {};
    for (const phase of ["baseline", "incoming", "recovery"]) {
      const h = envelope.health[phase];
      dispatchers[phase] = (dependencies.healthFactory ?? createHealthJobDispatcher)({ mode: "release", plan: h, custody, operationStore,
        ...(p.workerDemand ? { workerDemand: { plan: p.workerDemand, target: p.target } } : {}),
        releaseContext: { migrationSourceFenceSha256: p.authority.migrationSourceFenceSha256, acceptedMigrationSha256: p.authority.acceptedMigrationSha256 },
        assertDeploymentAuthority: async request => {
          await authority(binding);
          const expected = { domain: p.domain, intentSha256: hash(p), releaseId: p.releaseId, targetSha256: hash(h.worker),
            acceptedMigrationSha256: p.authority.acceptedMigrationSha256, migrationSourceFenceSha256: p.authority.migrationSourceFenceSha256 };
          need(same(request, expected), "UPDATE_HEALTH_AUTHORITY_MISMATCH");
          return { complete: true, ...expected };
        } });
    }
    const result = await (dependencies.runUpdate ?? runOpsCoreUpdate)({ plan: p, custody, operationStore, action,
      assertDeploymentAuthority: authority,
      prepareHealth: async ({ phase }) => {
        const phases = phase === "baseline" ? ["baseline"] : ["baseline", "incoming", "recovery"];
        for (const name of phases) await dispatchers[name].prepare();
      },
      workerHealth: async ({ phase, invocationContext, revisionName, signal }) => {
        need(Object.hasOwn(dispatchers, phase), "UPDATE_HEALTH_PHASE_INVALID");
        const h = envelope.health[phase];
        return dispatchers[phase].probeHealth({ role: "worker", ...h.worker, revisionName, invocationContext, signal });
      } });
    return { status: result.outcome, freshAcceptance: true, domain: p.domain, releaseId: p.releaseId, resultSha256: hash(result) };
  } finally { await custody.close(); }
}

export async function downloadUpdateEnvelope({ domain, sha256, output, env = process.env, containerFactory = client, identityCheck = assertUpdateAzureIdentity }) {
  need(["core", "ops"].includes(domain) && HASH.test(sha256) && containerUrl(env.OPS_CORE_CUSTODY_CONTAINER_URL), "UPDATE_DOWNLOAD_INPUT_INVALID");
  const expected = { subscriptionId: env.AZURE_SUBSCRIPTION_ID, tenantId: env.AZURE_TENANT_ID, principalName: env.AZURE_CLIENT_ID };
  need(UUID.test(expected.subscriptionId) && UUID.test(expected.tenantId) && UUID.test(expected.principalName), "UPDATE_DOWNLOAD_IDENTITY_INVALID");
  await identityCheck(expected);
  const container = containerFactory(env.OPS_CORE_CUSTODY_CONTAINER_URL);
  need(!(await container.getAccessPolicy()).blobPublicAccess, "UPDATE_CUSTODY_PUBLIC");
  const value = await readUpdateBlob(container, `update-plans/${domain}/${sha256}.json`);
  const e = validateUpdateEnvelope(value);
  need(hash(value) === sha256 && e.plan.domain === domain && same(e.operator.azureIdentity, expected)
    && e.operator.custodyContainerUrl === env.OPS_CORE_CUSTODY_CONTAINER_URL, "UPDATE_DOWNLOAD_BINDING_MISMATCH");
  const file = await open(output, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | constants.O_NOFOLLOW, 0o600);
  try { await file.writeFile(JSON.stringify(e)); await file.sync(); } finally { await file.close(); }
}

export async function updateMain(argv = process.argv.slice(2)) {
  try {
    if (argv[0] === "fetch-envelope") {
      need(argv.length === 4, "UPDATE_ARGUMENTS_INVALID");
      await downloadUpdateEnvelope({ domain: argv[1], sha256: argv[2], output: argv[3] });
      process.stdout.write("UPDATE_ENVELOPE_VERIFIED\n");
    } else {
      need(argv.length === 2, "UPDATE_ARGUMENTS_INVALID");
      const result = await executeOpsCoreUpdate(argv[0], await readPrivateUpdateEnvelope(argv[1]));
      process.stdout.write(`${JSON.stringify(result)}\n`);
    }
  } catch (error) {
    const code = error instanceof CliError ? error.message : opsCoreUpdateDiagnostic(error)
      ?? opsCoreReleaseCustodyDiagnostic(error) ?? providerOperationDiagnostic(error) ?? "UPDATE_RECONCILIATION_REQUIRED";
    process.stderr.write(`${code}\n`); process.exitCode = 1;
  }
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) await updateMain();
