import { identityHash, sha256, validatePin, validateReceipt } from "../accepted-core-baseline.mjs";

const ROLES = ["web", "worker"];
const VARIABLE_KEYS = ["CORGTEX_RELEASE_VERSION", "CORGTEX_RELEASE_IMAGE_TAG", "CORGTEX_RELEASE_GIT_SHA", "CORGTEX_STARTUP_MODE"];
const SHA = /^[a-f0-9]{40}$/;
const UUID = /^[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}$/;
const check = (ok, code) => { if (!ok) throw new Error(`CORE_RECOVERY_${code}`); };
const same = (a, b) => identityHash(a) === identityHash(b);
const image = (role, sha) => `ghcr.io/corgtexdotcom/corgtex/${role}:sha-${sha}`;
const restoredImage = (role, evidence) => `ghcr.io/corgtexdotcom/corgtex/${role}@${evidence.images[role].digest}`;
const settings = (sha) => ({
  CORGTEX_RELEASE_VERSION: `main-${sha.slice(0, 12)}`,
  CORGTEX_RELEASE_IMAGE_TAG: `sha-${sha}`,
  CORGTEX_RELEASE_GIT_SHA: sha,
  // Deliberately choose the established no-migration startup mode. This does
  // not claim that an uncaptured historical startup variable had this value.
  CORGTEX_STARTUP_MODE: "web",
});

export function validateRecoveryRequest(request, receipt, pin, receiptBytes) {
  validatePin(pin);
  check((typeof receiptBytes === "string" || Buffer.isBuffer(receiptBytes))
    && Buffer.byteLength(receiptBytes) <= 64000 && sha256(receiptBytes) === pin.receiptSha256, "RECEIPT_BYTES");
  check(same(JSON.parse(receiptBytes.toString()), receipt), "RECEIPT_CONTENT");
  validateReceipt(receipt, pin);
  check(request?.schemaVersion === 1 && request.failedRunId === 36757068293
    && request.failedCandidateSha === "6b9c848e3742007891e8bb859bb9f4b4cf30f293"
    && request.failedWebDeploymentId === "7c566687-39c3-44d1-a481-3882c12e991f", "INCIDENT_BINDING");
  check(SHA.test(receipt?.evidence?.sourceSha) && receipt.evidence.sourceSha === pin?.sourceSha
    && request.acceptedReceiptSha256 === pin.receiptSha256, "BASELINE_BINDING");
  check(receipt.evidence.target.origin === "https://app.corgtex.com"
    && receipt.evidence.target.id === "backup-app" && receipt.evidence.target.provider === "railway", "TARGET_BINDING");
  check([receipt.evidence.target.projectId, receipt.evidence.target.environmentId,
    receipt.evidence.target.webServiceId, receipt.evidence.target.workerServiceId].every(id => UUID.test(id)), "TARGET_IDENTITY");
  check(same(request.releaseSettings, settings(receipt.evidence.sourceSha)), "RELEASE_SETTINGS");
  check(ROLES.every(role => UUID.test(receipt.evidence.images[role].deploymentId)
    && /^sha256:[a-f0-9]{64}$/.test(receipt.evidence.images[role].digest)), "IMAGE_BINDING");
  return request;
}

export const RECOVERY_STATE_QUERY = `query CoreRecoveryState($projectId: String!, $environmentId: String!, $serviceId: String!) {
  instance: serviceInstance(environmentId: $environmentId, serviceId: $serviceId) {
    source { image repo } startCommand preDeployCommand
    latestDeployment { id status } activeDeployments { id status }
  }
  variables(projectId: $projectId, environmentId: $environmentId, serviceId: $serviceId, unrendered: true)
  environment(id: $environmentId) { id projectId config }
  deployments(first: 100, input: { projectId: $projectId, environmentId: $environmentId, serviceId: $serviceId }) {
    edges { node { id status meta } } pageInfo { hasNextPage }
  }
  pending: deployments(first: 1, input: { projectId: $projectId, environmentId: $environmentId, serviceId: $serviceId,
    status: { notIn: [SUCCESS, REMOVED, FAILED, CRASHED, SKIPPED] } }) {
    edges { node { id status } } pageInfo { hasNextPage }
  }
}`;

function scope(target, role) {
  return { projectId: target.projectId, environmentId: target.environmentId, serviceId: target[`${role}ServiceId`] };
}

export function recoveryStage(data, target, role) {
  check(data?.environment?.id === target.environmentId && data.environment.projectId === target.projectId, "PROVIDER_TARGET");
  const instance = data.instance;
  const config = data.environment.config?.services?.[target[`${role}ServiceId`]];
  const credentials = config?.deploy?.registryCredentials;
  check(credentials && Object.keys(credentials).length > 0
    && Object.values(credentials).every(value => typeof value === "string" && /^\*+$/.test(value)), "REGISTRY_AUTHORIZATION");
  check(instance?.source?.image === config?.source?.image && !instance.source.repo && !config.source.repo
    && config.source.autoUpdates == null, "SOURCE_CONFIGURATION");
  check(instance.startCommand === `npm run start --workspace=@corgtex/${role}`
    && instance.preDeployCommand == null, "STARTUP_COMMAND");
  check(Array.isArray(data.pending?.edges) && data.pending.edges.length === 0
    && data.pending.pageInfo?.hasNextPage === false, "PENDING_DEPLOYMENT");
  check(Array.isArray(data.deployments?.edges) && typeof data.deployments.pageInfo?.hasNextPage === "boolean", "HISTORY_MISSING");
  const history = data.deployments.edges.map(({ node }) => ({ id: node.id, status: node.status, digest: node.meta?.imageDigest ?? null }));
  check(history.every(item => UUID.test(item.id) && typeof item.status === "string"), "HISTORY_INVALID");
  check(data.variables && typeof data.variables === "object" && !Array.isArray(data.variables), "VARIABLES_MISSING");
  const releaseSettings = {};
  for (const key of VARIABLE_KEYS) {
    check(typeof data.variables[key] === "string", "RELEASE_VARIABLE_MISSING");
    releaseSettings[key] = data.variables[key];
  }
  // Never return raw provider variables, metadata or credential scalars.
  return { image: instance.source.image, startCommand: instance.startCommand, preDeployCommand: instance.preDeployCommand ?? null,
    registryCredentialsPresent: true, releaseSettings, latestDeployment: instance.latestDeployment,
    activeDeployments: instance.activeDeployments, history, hasMoreHistory: data.deployments.pageInfo.hasNextPage };
}

function assertIncidentStages(stages, request, evidence) {
  for (const role of ROLES) {
    const stage = stages[role];
    const anchor = role === "web" ? { id: request.failedWebDeploymentId, status: "CRASHED" }
      : { id: evidence.images.worker.deploymentId, status: "SUCCESS" };
    check(same(stage.latestDeployment, anchor) && same(stage.activeDeployments, [anchor]), "DEPLOYMENT_CHANGED");
    check(stage.history.some(item => item.id === anchor.id && item.status === anchor.status), "DEPLOYMENT_HISTORY");
    check(stage.history.some(item => item.id === evidence.images[role].deploymentId
      && item.status === (role === "web" ? "REMOVED" : "SUCCESS") && item.digest === evidence.images[role].digest), "BASELINE_HISTORY");
    check([image(role, request.failedCandidateSha), image(role, evidence.sourceSha), restoredImage(role, evidence)].includes(stage.image), "UNBOUND_IMAGE");
    // A rerun can reconcile only the exact staged recovery values. Every other
    // configuration change remains a stop-and-reconcile condition.
    check([settings(request.failedCandidateSha), request.releaseSettings].some(values => same(values, stage.releaseSettings)), "UNBOUND_SETTINGS");
  }
}

export async function recoverCore({ request, receipt, receiptBytes, pin, dryRun = true }, deps) {
  validateRecoveryRequest(request, receipt, pin, receiptBytes);
  check(["graphql", "assertContext", "verifyDatabase", "verifyRegistry", "verifyRuntime", "reserveDeployment"].every(key => typeof deps?.[key] === "function"), "DEPENDENCIES_REQUIRED");
  const evidence = receipt.evidence;
  const target = evidence.target;
  const readStages = async () => {
    const result = {};
    for (const role of ROLES) result[role] = recoveryStage(await deps.graphql(RECOVERY_STATE_QUERY, scope(target, role)), target, role);
    return result;
  };
  await deps.assertContext(request, target);
  const schemaBefore = await deps.verifyDatabase(evidence, receipt.schema);
  check(same(schemaBefore, receipt.schema), "BASELINE_SCHEMA");
  await deps.verifyRegistry(evidence);
  let stages = await readStages();
  assertIncidentStages(stages, request, evidence);
  const initial = structuredClone(stages);
  if (dryRun) return { kind: "core-recovery-plan", dryRun: true, mutations: 0, failedRunId: request.failedRunId,
    baselineReceiptSha256: pin.receiptSha256, sourceSha: evidence.sourceSha, target, stages,
    deployRoles: ["web"], releaseSettings: request.releaseSettings };

  const writes = [];
  const mutate = async (query, variables, operation) => {
    await deps.assertContext(request, target);
    const fresh = await readStages();
    assertIncidentStages(fresh, request, evidence);
    check(same(fresh, stages), "STAGING_DRIFT");
    const result = await deps.graphql(query, variables);
    writes.push(operation);
    return result;
  };
  for (const role of ROLES) {
    if (same(stages[role].releaseSettings, request.releaseSettings)) continue;
    await mutate(`mutation CoreRecoveryVariables($projectId: String!, $environmentId: String!, $serviceId: String!, $variables: EnvironmentVariables!) {
      variableCollectionUpsert(input: { projectId: $projectId, environmentId: $environmentId, serviceId: $serviceId,
        variables: $variables, replace: false, skipDeploys: true })
    }`, { ...scope(target, role), variables: request.releaseSettings }, `variables:${role}`);
    const expected = structuredClone(stages);
    expected[role].releaseSettings = request.releaseSettings;
    stages = await readStages();
    check(same(stages, expected), "VARIABLE_READBACK");
  }
  for (const role of ROLES) {
    const restored = restoredImage(role, evidence);
    if (stages[role].image === restored) continue;
    await mutate(`mutation CoreRecoveryImage($environmentId: String!, $serviceId: String!, $input: ServiceInstanceUpdateInput!) {
      serviceInstanceUpdate(serviceId: $serviceId, environmentId: $environmentId, input: $input)
    }`, { environmentId: target.environmentId, serviceId: target[`${role}ServiceId`], input: { source: { image: restored } } }, `image:${role}`);
    const expected = structuredClone(stages);
    expected[role].image = restored;
    stages = await readStages();
    check(same(stages, expected), "IMAGE_READBACK");
  }
  await deps.assertContext(request, target);
  const staged = await readStages();
  assertIncidentStages(staged, request, evidence);
  check(same(staged, stages), "STAGING_DRIFT");
  const intent = { failedRunId: request.failedRunId, failedWebDeploymentId: request.failedWebDeploymentId,
    targetSha256: identityHash(target), sourceSha: evidence.sourceSha, stagedStateSha256: identityHash(stages) };
  // The protected adapter must durably reserve this incident before submission,
  // and refuse another reservation across jobs/runs. A local ephemeral journal
  // alone is insufficient. Unknown outcomes require operator reconciliation.
  const reservation = await deps.reserveDeployment(intent);
  check(reservation?.reserved === true && same(reservation.intent, intent), "DEPLOYMENT_INTENT_REQUIRED");
  const result = await deps.graphql(`mutation CoreRecoveryDeploy($environmentId: String!, $serviceId: String!) {
    deploymentId: serviceInstanceDeployV2(serviceId: $serviceId, environmentId: $environmentId)
  }`, { environmentId: target.environmentId, serviceId: target.webServiceId });
  writes.push("deploy:web");
  check(UUID.test(result?.deploymentId), "DEPLOYMENT_RESULT_UNCERTAIN");
  // Never blindly retry an uncertain deployment request. A new ID is a separate
  // recovered-runtime expectation; the accepted receipt stays byte-for-byte fixed.
  const runtime = { sourceSha: evidence.sourceSha, target, images: {
    web: { deploymentId: result.deploymentId, digest: evidence.images.web.digest }, worker: structuredClone(evidence.images.worker),
  } };
  await deps.verifyRuntime(runtime, request.releaseSettings);
  const schemaAfter = await deps.verifyDatabase(evidence, receipt.schema);
  check(same(schemaAfter, schemaBefore), "DATABASE_CHANGED");
  return { kind: "core-recovery-verified", sourceSha: evidence.sourceSha, failedRunId: request.failedRunId,
    baselineReceiptSha256: pin.receiptSha256, recoveredRuntime: runtime, schema: schemaAfter, writes,
    previousWorkerDeploymentId: initial.worker.latestDeployment.id,
    originalBaselinePinUnchanged: true, baselineAdoptionRequired: true };
}
