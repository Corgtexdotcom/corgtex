import { createHash } from "node:crypto";

const ENDPOINT = "https://backboard.railway.com/graphql/v2";
const ID = /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/;
const HASH = /^[0-9a-f]{64}$/;
const DEPLOYMENT_STATUSES = new Set(["BUILDING", "CRASHED", "DEPLOYING", "FAILED", "INITIALIZING", "NEEDS_APPROVAL", "QUEUED", "REMOVED", "REMOVING", "SKIPPED", "SLEEPING", "SUCCESS", "WAITING"]);
const CANCEL_STATUSES = new Set(["BUILDING", "INITIALIZING", "NEEDS_APPROVAL", "QUEUED", "WAITING"]);
const UNFINISHED_STATUSES = new Set([...CANCEL_STATUSES, "DEPLOYING", "REMOVING"]);
const INSTANCE_STATUSES = new Set(["CRASHED", "CREATED", "EXITED", "INITIALIZING", "REMOVED", "REMOVING", "RESTARTING", "RUNNING", "SKIPPED", "STOPPED"]);
const INACTIVE_INSTANCES = new Set(["CRASHED", "EXITED", "REMOVED", "SKIPPED", "STOPPED"]);
const DEPLOYMENT_FIELDS = "id projectId environmentId serviceId status createdAt updatedAt deploymentStopped instances { id status }";
const ENV_BINDING = "environment(id:$environmentId,projectId:$projectId) { id projectId }";
const pendingFields = (depth) => `id environmentId kind status ${depth ? `children { ${pendingFields(depth - 1)} }` : "children { id }"}`;
const QUERIES = {
  environment: `query FenceEnvironment($projectId:String!,$environmentId:String!) {
    environment(id:$environmentId,projectId:$projectId) { id projectId config(decryptVariables:false) }
    environmentStagedChanges(environmentId:$environmentId) { id environmentId status patch(decryptVariables:false) }
    environmentPendingWork(environmentId:$environmentId) { ${pendingFields(3)} }
  }`,
  service: `query FenceService($projectId:String!,$environmentId:String!,$serviceId:String!) {
    ${ENV_BINDING}
    serviceInstance(environmentId:$environmentId,serviceId:$serviceId) {
      id serviceId environmentId service { id projectId } source { image repo }
      cronSchedule nextCronRunAt restartPolicyType restartPolicyMaxRetries drainingSeconds overlapSeconds
      resolvedFileConfig { deploymentId fileManifest resolvedAt }
      activeDeployments { ${DEPLOYMENT_FIELDS} }
    }
    serviceInstanceAutoDeployStatus(projectId:$projectId,environmentId:$environmentId,serviceId:$serviceId) { enabled }
  }`,
  deployments: `query FenceDeployments($projectId:String!,$environmentId:String!,$serviceId:String!,$after:String) {
    ${ENV_BINDING}
    deployments(input:{projectId:$projectId,environmentId:$environmentId,serviceId:$serviceId,includeDeleted:true},first:100,after:$after) {
      edges { cursor node { ${DEPLOYMENT_FIELDS} } } pageInfo { hasNextPage endCursor }
    }
  }`,
  deployment: `query FenceDeployment($projectId:String!,$environmentId:String!,$id:String!) {
    ${ENV_BINDING} deployment(id:$id) { ${DEPLOYMENT_FIELDS} }
  }`,
};
const MUTATIONS = {
  autoDeploy: "mutation FenceAutoDeploy($input:ServiceInstanceAutoDeployUpdateInput!) { serviceInstanceAutoDeployUpdate(input:$input) { enabled } }",
  stage: "mutation FenceStage($environmentId:String!,$input:EnvironmentConfig!) { environmentStageChanges(environmentId:$environmentId,input:$input,merge:false) { id environmentId } }",
  commit: "mutation FenceCommit($environmentId:String!) { environmentPatchCommitStaged(environmentId:$environmentId,skipDeploys:true) }",
  cancel: "mutation FenceCancel($id:String!) { deploymentCancel(id:$id) }",
  stop: "mutation FenceStop($id:String!) { deploymentStop(id:$id) }",
};

const isRecord = (value) => value !== null && typeof value === "object" && !Array.isArray(value);
const canonical = (value) => {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (isRecord(value)) return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonical(value[key])}`).join(",")}}`;
  return JSON.stringify(value);
};
const digest = (value) => createHash("sha256").update(canonical(value)).digest("hex");
const freeze = (value) => {
  if (value !== null && typeof value === "object") { Object.values(value).forEach(freeze); Object.freeze(value); }
  return value;
};

export class RailwaySourceFenceError extends Error {
  constructor(code) { super(`Railway source fence failed: ${code}.`); this.name = "RailwaySourceFenceError"; this.code = code; }
}
const requireValue = (value, code) => { if (!value) throw new RailwaySourceFenceError(code); };
const checkSignal = (signal) => requireValue(!signal.aborted, "RAILWAY_FENCE_ABORTED");
const nullableText = (value) => {
  requireValue(value === null || (typeof value === "string" && value.length <= 256 && !/[\x00-\x1f\x7f]/.test(value)), "INVALID_PROVIDER_POLICY");
  return value;
};
const noOpPatch = (value) => isRecord(value) && Object.values(value).every((item) => noOpPatch(item));
const stopped = (deployment) => deployment.deploymentStopped && !UNFINISHED_STATUSES.has(deployment.status)
  && deployment.instances.every((instance) => INACTIVE_INSTANCES.has(instance.status));

/** No redirects/retries; token and provider error bodies never enter evidence. */
export function createRailwayFenceTransport({ token, fetchImpl = globalThis.fetch, maxResponseBytes = 32 * 1024 * 1024 }) {
  requireValue(typeof token === "string" && token.length > 0 && !/[\r\n]/.test(token), "RAILWAY_AUTH_REQUIRED");
  requireValue(Number.isSafeInteger(maxResponseBytes) && maxResponseBytes > 0 && maxResponseBytes <= 32 * 1024 * 1024, "INVALID_RESPONSE_LIMIT");
  return async ({ query, variables, signal }) => {
    try {
      const response = await fetchImpl(ENDPOINT, { method: "POST", redirect: "error",
        headers: { "content-type": "application/json", authorization: `Bearer ${token}` },
        body: JSON.stringify({ query, variables }), signal: AbortSignal.any([signal, AbortSignal.timeout(30_000)]) });
      requireValue(response.ok, "RAILWAY_TRANSPORT_FAILED");
      const reader = response.body.getReader();
      const chunks = [];
      let size = 0;
      try {
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          size += value.byteLength;
          requireValue(size <= maxResponseBytes, "RAILWAY_RESPONSE_LIMIT");
          chunks.push(Buffer.from(value));
        }
      } finally { await reader.cancel().catch(() => {}); }
      const result = JSON.parse(Buffer.concat(chunks, size).toString("utf8"));
      requireValue(!result.errors?.length && isRecord(result.data), "RAILWAY_GRAPHQL_FAILED");
      return result.data;
    } catch (error) {
      if (error instanceof RailwaySourceFenceError) throw error;
      throw new RailwaySourceFenceError("RAILWAY_TRANSPORT_FAILED");
    }
  };
}

/** GraphQL fields verified against Railway's public schema. EnvironmentConfig is
 * a JSON scalar: it stays in-process and only the policy projection is returned.
 * A provider fence does not disable manual deploys or replace a database fence.
 */
export class RailwaySourceFence {
  #binding;
  #transport;
  #record;
  #signal;
  #maxPages;
  #maxDeployments;
  #expectedLinks = null;
  constructor({ binding, expectedSourceLinks = null, transport, token, runRecordedOperation, signal, maxDeploymentPages = 100, maxDeployments = 10_000 }) {
    requireValue(binding && ID.test(binding.projectId) && ID.test(binding.environmentId)
      && Array.isArray(binding.serviceIds) && binding.serviceIds.length > 0 && binding.serviceIds.length <= 100
      && binding.serviceIds.every((id) => ID.test(id)) && new Set(binding.serviceIds).size === binding.serviceIds.length, "INVALID_RAILWAY_BINDING");
    requireValue(typeof runRecordedOperation === "function" && signal instanceof AbortSignal, "RAILWAY_CUSTODY_REQUIRED");
    requireValue(Number.isSafeInteger(maxDeploymentPages) && maxDeploymentPages > 0 && maxDeploymentPages <= 1000
      && Number.isSafeInteger(maxDeployments) && maxDeployments > 0 && maxDeployments <= 100_000, "INVALID_DEPLOYMENT_LIMITS");
    this.#binding = freeze({ projectId: binding.projectId, environmentId: binding.environmentId, serviceIds: [...binding.serviceIds].sort() });
    if (expectedSourceLinks !== null) {
      requireValue(Array.isArray(expectedSourceLinks) && expectedSourceLinks.length === this.#binding.serviceIds.length
        && expectedSourceLinks.every((entry) => isRecord(entry) && this.#binding.serviceIds.includes(entry.serviceId)
          && HASH.test(entry.sourceLinkSha256) && Object.keys(entry).length === 2)
        && new Set(expectedSourceLinks.map((entry) => entry.serviceId)).size === expectedSourceLinks.length, "INVALID_EXPECTED_SOURCE_LINKS");
      this.#expectedLinks = new Map(expectedSourceLinks.map((entry) => [entry.serviceId, entry.sourceLinkSha256]));
    }
    this.#transport = transport ?? createRailwayFenceTransport({ token });
    requireValue(typeof this.#transport === "function", "INVALID_RAILWAY_TRANSPORT");
    this.#record = runRecordedOperation;
    this.#signal = signal;
    this.#maxPages = maxDeploymentPages;
    this.#maxDeployments = maxDeployments;
  }
  get binding() { return this.#binding; }
  #requireExpectedLinks() { requireValue(this.#expectedLinks !== null, "DURABLE_SOURCE_LINKS_REQUIRED"); }
  #links() { return this.#binding.serviceIds.map((serviceId) => ({ serviceId, sourceLinkSha256: this.#expectedLinks.get(serviceId) })); }
  #triggerPatch(services) {
    return { services: Object.fromEntries(services.map((service) => [service.serviceId, {
      ...(service.sourceKind === "image" ? { source: { autoUpdates: { type: "disabled" } } } : {}),
      deploy: { cronSchedule: null },
    }])) };
  }
  async #request(query, variables) {
    checkSignal(this.#signal);
    try {
      const data = await this.#transport({ query, variables, signal: this.#signal });
      checkSignal(this.#signal);
      requireValue(isRecord(data), "INVALID_RAILWAY_RESPONSE");
      return data;
    } catch (error) {
      if (error instanceof RailwaySourceFenceError) throw error;
      throw new RailwaySourceFenceError("RAILWAY_REQUEST_FAILED");
    }
  }
  #environmentBinding(data) {
    requireValue(data?.environment?.id === this.#binding.environmentId
      && data.environment.projectId === this.#binding.projectId, "RAILWAY_ENVIRONMENT_BINDING_MISMATCH");
  }
  #deployment(value, serviceId) {
    requireValue(value && ID.test(value.id) && value.projectId === this.#binding.projectId
      && value.environmentId === this.#binding.environmentId && value.serviceId === serviceId, "RAILWAY_DEPLOYMENT_BINDING_MISMATCH");
    requireValue(DEPLOYMENT_STATUSES.has(value.status) && typeof value.deploymentStopped === "boolean"
      && Array.isArray(value.instances) && value.instances.length <= 10_000, "INVALID_DEPLOYMENT_STATE");
    requireValue(typeof value.createdAt === "string" && Number.isFinite(Date.parse(value.createdAt))
      && typeof value.updatedAt === "string" && Number.isFinite(Date.parse(value.updatedAt)), "INVALID_DEPLOYMENT_STATE");
    const instances = value.instances.map((item) => {
      requireValue(typeof item.id === "string" && item.id.length <= 256 && INSTANCE_STATUSES.has(item.status), "INVALID_INSTANCE_STATE");
      return { idRef: digest(item.id), status: item.status };
    });
    return { id: value.id, serviceId, environmentId: value.environmentId, projectId: value.projectId,
      status: value.status, createdAt: value.createdAt, updatedAt: value.updatedAt, deploymentStopped: value.deploymentStopped, instances };
  }
  async #environment() {
    const data = await this.#request(QUERIES.environment, this.#binding);
    this.#environmentBinding(data);
    requireValue(isRecord(data.environment.config) && isRecord(data.environment.config.services), "INVALID_ENVIRONMENT_CONFIG");
    const staged = data.environmentStagedChanges;
    requireValue(staged && ID.test(staged.id) && staged.environmentId === this.#binding.environmentId
      && ["STAGED", "COMMITTED", "APPLYING", "FAILED"].includes(staged.status) && isRecord(staged.patch), "INVALID_STAGED_PATCH");
    const work = data.environmentPendingWork;
    requireValue(Array.isArray(work) && work.length <= 1000, "INVALID_PENDING_WORK");
    let count = 0;
    const projectWork = (node, depth = 0) => {
      requireValue(++count <= 1000 && depth <= 3, "PENDING_WORK_DEPTH_EXCEEDED");
      requireValue(node.environmentId === this.#binding.environmentId && typeof node.id === "string"
        && typeof node.kind === "string" && ["applied", "applying", "failed", "staged"].includes(node.status)
        && Array.isArray(node.children), "INVALID_PENDING_WORK");
      return { idRef: digest(node.id), kindRef: digest(node.kind), status: node.status, children: node.children.map((child) => projectWork(child, depth + 1)) };
    };
    return { config: data.environment.config, staged, pendingWork: work.map((node) => projectWork(node)) };
  }
  async #service(serviceId, environment) {
    const data = await this.#request(QUERIES.service, { ...this.#binding, serviceId });
    this.#environmentBinding(data);
    const value = data.serviceInstance;
    requireValue(value?.serviceId === serviceId && value.environmentId === this.#binding.environmentId
      && value.service?.id === serviceId && value.service.projectId === this.#binding.projectId, "RAILWAY_SERVICE_BINDING_MISMATCH");
    requireValue(typeof data.serviceInstanceAutoDeployStatus?.enabled === "boolean" && Array.isArray(value.activeDeployments), "INVALID_SERVICE_STATE");
    const config = environment.config.services[serviceId];
    requireValue(isRecord(config) && (config.source === undefined || config.source === null || isRecord(config.source)), "INVALID_SERVICE_CONFIG");
    const { autoUpdates: _autoUpdates, ...preservedSource } = config.source ?? {};
    const sourceLinkSha256 = digest({ instanceSource: value.source, preservedSource });
    if (this.#expectedLinks !== null) requireValue(this.#expectedLinks.get(serviceId) === sourceLinkSha256, "RAILWAY_SOURCE_LINK_CHANGED");
    const sourceKind = value.source?.image ? "image" : value.source?.repo ? "repo" : "none";
    const file = value.resolvedFileConfig;
    requireValue(file === null || (isRecord(file) && isRecord(file.fileManifest)), "INVALID_RESOLVED_FILE_CONFIG");
    requireValue(file === null || (ID.test(file.deploymentId) && typeof file.resolvedAt === "string"
      && Number.isFinite(Date.parse(file.resolvedAt))), "INVALID_RESOLVED_FILE_CONFIG");
    const result = { serviceId, sourceKind, sourceLinkSha256,
      autoDeployEnabled: data.serviceInstanceAutoDeployStatus.enabled,
      autoUpdatesType: nullableText(config.source?.autoUpdates?.type ?? null),
      configuredCronSchedule: nullableText(config.deploy?.cronSchedule ?? null),
      cronSchedule: nullableText(value.cronSchedule), nextCronRunAt: nullableText(value.nextCronRunAt),
      restartPolicyType: nullableText(value.restartPolicyType), restartPolicyMaxRetries: value.restartPolicyMaxRetries,
      drainingSeconds: value.drainingSeconds, overlapSeconds: value.overlapSeconds,
      fileConfig: file === null ? null : { deploymentId: file.deploymentId, resolvedAt: file.resolvedAt,
        manifestSha256: digest(file.fileManifest), cronSchedule: nullableText(file.fileManifest.deploy?.cronSchedule ?? null) },
      activeDeployments: value.activeDeployments.map((entry) => this.#deployment(entry, serviceId)) };
    for (const key of ["restartPolicyMaxRetries", "drainingSeconds", "overlapSeconds"]) {
      requireValue(result[key] === null || (Number.isSafeInteger(result[key]) && result[key] >= 0), "INVALID_PROVIDER_POLICY");
    }
    return result;
  }
  async #deployments(serviceId) {
    let after = null;
    const cursors = new Set();
    const ids = new Set();
    const deployments = [];
    for (let page = 0; page < this.#maxPages; page++) {
      const data = await this.#request(QUERIES.deployments, { ...this.#binding, serviceId, after });
      this.#environmentBinding(data);
      const connection = data.deployments;
      requireValue(Array.isArray(connection?.edges) && connection.edges.length <= 100
        && typeof connection.pageInfo?.hasNextPage === "boolean", "INVALID_DEPLOYMENT_PAGE");
      for (const edge of connection.edges) {
        const item = this.#deployment(edge.node, serviceId);
        requireValue(!ids.has(item.id) && deployments.length < this.#maxDeployments, "DEPLOYMENT_INVENTORY_LIMIT");
        ids.add(item.id); deployments.push(item);
      }
      if (!connection.pageInfo.hasNextPage) return deployments;
      after = connection.pageInfo.endCursor;
      requireValue(typeof after === "string" && after.length > 0 && after.length <= 8192 && !cursors.has(after)
        && connection.edges.at(-1)?.cursor === after, "INVALID_DEPLOYMENT_CURSOR");
      cursors.add(after);
    }
    throw new RailwaySourceFenceError("DEPLOYMENT_PAGE_LIMIT");
  }
  async read() {
    const environment = await this.#environment();
    const services = [];
    let totalDeployments = 0;
    for (const serviceId of this.#binding.serviceIds) {
      const service = await this.#service(serviceId, environment);
      const deployments = await this.#deployments(serviceId);
      totalDeployments += deployments.length;
      requireValue(totalDeployments <= this.#maxDeployments, "DEPLOYMENT_INVENTORY_LIMIT");
      const indexed = new Map(deployments.map((item) => [item.id, item]));
      for (const active of service.activeDeployments) {
        requireValue(indexed.has(active.id), "ACTIVE_DEPLOYMENT_NOT_IN_INVENTORY");
      }
      services.push({ ...service, deployments });
    }
    const result = { schemaVersion: "1.0.0", binding: this.#binding, services,
      staged: { id: environment.staged.id, status: environment.staged.status,
        empty: noOpPatch(environment.staged.patch), patchSha256: digest(environment.staged.patch) },
      pendingWork: environment.pendingWork };
    return freeze(result);
  }
  async #operation(kind, input, apply, verify) {
    let dispatched = false;
    try {
      await this.#record({ kind, input: freeze(structuredClone(input)),
        apply: async () => {
          requireValue(!dispatched, "RAILWAY_MUTATION_REPLAY_FORBIDDEN");
          checkSignal(this.#signal);
          dispatched = true;
          return apply();
        }, verify });
      const result = await verify();
      requireValue(result.complete === true, "RAILWAY_OPERATION_REQUIRES_RECONCILIATION");
      return result.evidence;
    } catch (error) {
      if (error instanceof RailwaySourceFenceError) throw error;
      throw new RailwaySourceFenceError("RAILWAY_OPERATION_REQUIRES_RECONCILIATION");
    }
  }
  #triggersDisabled(snapshot) {
    return snapshot.services.every((service) => !service.autoDeployEnabled
      && (service.sourceKind !== "image" || service.autoUpdatesType === "disabled")
      && service.configuredCronSchedule === null && service.cronSchedule === null && service.nextCronRunAt === null);
  }
  async #policyRead() {
    const environment = await this.#environment();
    const services = [];
    for (const id of this.#binding.serviceIds) services.push(await this.#service(id, environment));
    return { environment, services };
  }
  /** resumeStagedPatch is permitted only when recovered from the owner's verified
   * durable stage intent. Matching provider staging alone establishes no ownership.
   * resumeCommit likewise requires readIntent with the exact retained commit input;
   * the controller must preserve its stagedPatchId/descriptor independently because
   * the recorder deliberately stores only input digests. Recovery never restages.
   * The owner must serialize environment staging; Railway's commit consumes it all.
   */
  async disableTriggers({ resumeStagedPatch = null, resumeCommit = null, readIntent = null } = {}) {
    this.#requireExpectedLinks();
    const initial = await this.read();
    requireValue(!["APPLYING", "FAILED"].includes(initial.staged.status), "RAILWAY_STAGING_BUSY");
    const patch = this.#triggerPatch(initial.services);
    const patchSha256 = digest(patch);
    const links = this.#links();
    if (resumeStagedPatch !== null) {
      requireValue(resumeStagedPatch.environmentId === this.#binding.environmentId
        && resumeStagedPatch.patchSha256 === patchSha256, "INVALID_STAGE_RECOVERY_BINDING");
    }
    if (resumeCommit !== null) {
      requireValue(resumeCommit.environmentId === this.#binding.environmentId
        && resumeCommit.patchSha256 === patchSha256 && ID.test(resumeCommit.stagedPatchId), "INVALID_COMMIT_RECOVERY_BINDING");
    }
    if (!initial.staged.empty) {
      requireValue(initial.staged.patchSha256 === patchSha256 && (
        (resumeStagedPatch?.environmentId === this.#binding.environmentId && resumeStagedPatch.patchSha256 === patchSha256)
        || (resumeCommit !== null && resumeCommit.stagedPatchId === initial.staged.id)),
      "PREEXISTING_RAILWAY_STAGING");
    }
    if (resumeCommit !== null) {
      await this.reconcileRecordedOperation({ kind: "RAILWAY_COMMIT_SOURCE_TRIGGERS",
        input: { binding: this.#binding, patchSha256, stagedPatchId: resumeCommit.stagedPatchId, skipDeploys: true, links }, readIntent });
      const result = await this.read();
      requireValue(this.#triggersDisabled(result) && result.staged.empty, "RAILWAY_TRIGGERS_UNPROVEN");
      return result;
    }
    if (resumeStagedPatch !== null) {
      await this.reconcileRecordedOperation({ kind: "RAILWAY_STAGE_SOURCE_TRIGGERS",
        input: { binding: this.#binding, patchSha256, links }, readIntent });
    }
    for (const service of initial.services) {
      if (!service.autoDeployEnabled) continue;
      const variables = { input: { projectId: this.#binding.projectId, environmentId: this.#binding.environmentId,
        serviceId: service.serviceId, enabled: false } };
      const verify = async () => {
        const environment = await this.#environment();
        const current = await this.#service(service.serviceId, environment);
        return { complete: current.autoDeployEnabled === false,
          evidence: { binding: this.#binding, serviceId: service.serviceId, autoDeployEnabled: current.autoDeployEnabled,
            sourceLinkSha256: current.sourceLinkSha256 } };
      };
      await this.#operation("RAILWAY_DISABLE_AUTODEPLOY", { ...variables.input, sourceLinkSha256: service.sourceLinkSha256 }, async () => {
        const current = await verify();
        if (current.complete) return;
        await this.#request(MUTATIONS.autoDeploy, variables);
      }, verify);
    }
    const current = await this.#policyRead();
    const configDisabled = current.services.every((service) => service.configuredCronSchedule === null
      && (service.sourceKind !== "image" || service.autoUpdatesType === "disabled"));
    const runCommit = async (stagedPatchId) => {
      const verifyCommit = async () => {
        const readback = await this.#policyRead();
        const snapshot = { services: readback.services };
        return { complete: noOpPatch(readback.environment.staged.patch) && this.#triggersDisabled(snapshot),
          evidence: { binding: this.#binding, patchSha256, links, stagingEmpty: noOpPatch(readback.environment.staged.patch),
            triggersDisabled: this.#triggersDisabled(snapshot) } };
      };
      await this.#operation("RAILWAY_COMMIT_SOURCE_TRIGGERS", { binding: this.#binding, patchSha256,
        stagedPatchId, skipDeploys: true, links }, async () => {
        await this.#policyRead();
        const staged = (await this.#environment()).staged;
        requireValue(staged.id === stagedPatchId && staged.status === "STAGED"
          && digest(staged.patch) === patchSha256, "RAILWAY_STAGED_PATCH_CHANGED");
        await this.#request(MUTATIONS.commit, { environmentId: this.#binding.environmentId });
      }, verifyCommit);
    };
    if (!configDisabled || !noOpPatch(current.environment.staged.patch)) {
      const verifyStage = async () => {
        const readback = await this.#policyRead();
        const staged = readback.environment.staged;
        return { complete: staged.status === "STAGED" && digest(staged.patch) === patchSha256,
          evidence: { binding: this.#binding, stagedPatchId: staged.id, patchSha256: digest(staged.patch), links } };
      };
      const stageInput = { binding: this.#binding, patchSha256, links };
      if (resumeStagedPatch === null) {
        await this.#operation("RAILWAY_STAGE_SOURCE_TRIGGERS", stageInput, async () => {
          await this.#policyRead();
          const preflight = await this.#environment();
          requireValue(preflight.staged.status === "STAGED" && noOpPatch(preflight.staged.patch), "PREEXISTING_RAILWAY_STAGING");
          await this.#request(MUTATIONS.stage, { environmentId: this.#binding.environmentId, input: patch });
        }, verifyStage);
      }
      const stageEvidence = (await verifyStage()).evidence;
      await runCommit(stageEvidence.stagedPatchId);
    }
    const result = await this.read();
    requireValue(this.#triggersDisabled(result) && result.staged.empty, "RAILWAY_TRIGGERS_UNPROVEN");
    return result;
  }
  async #readDeployment(id, serviceId) {
    const environment = await this.#environment();
    await this.#service(serviceId, environment);
    const data = await this.#request(QUERIES.deployment, { ...this.#binding, id });
    this.#environmentBinding(data);
    const deployment = this.#deployment(data.deployment, serviceId);
    requireValue(deployment.id === id, "RAILWAY_DEPLOYMENT_BINDING_MISMATCH");
    return deployment;
  }
  /** The controller must retain exact descriptors independently of this adapter.
   * readIntent must be the reopened recorder's verifier of global phase/intent and
   * input binding. Every supported kind has a read-only recovery path; a matching
   * provider state alone cannot establish ownership or create a new operation.
   */
  async reconcileRecordedOperation({ kind, input, readIntent }) {
    this.#requireExpectedLinks();
    requireValue(typeof readIntent === "function" && isRecord(input), "RAILWAY_DURABLE_INTENT_REQUIRED");
    input = freeze(structuredClone(input));
    const auto = kind === "RAILWAY_DISABLE_AUTODEPLOY";
    const stage = kind === "RAILWAY_STAGE_SOURCE_TRIGGERS";
    const commit = kind === "RAILWAY_COMMIT_SOURCE_TRIGGERS";
    const cancel = kind === "RAILWAY_CANCEL_SOURCE_DEPLOYMENT";
    const stop = kind === "RAILWAY_STOP_SOURCE_DEPLOYMENT";
    requireValue(auto || stage || commit || cancel || stop, "INVALID_RAILWAY_RECOVERY_KIND");
    const links = this.#links();
    let verify;
    let expectedInput;
    if (auto || cancel || stop) {
      requireValue(this.#binding.serviceIds.includes(input.serviceId), "RAILWAY_RECOVERY_BINDING_MISMATCH");
      const sourceLinkSha256 = this.#expectedLinks.get(input.serviceId);
      if (auto) {
        expectedInput = { projectId: this.#binding.projectId, environmentId: this.#binding.environmentId,
          serviceId: input.serviceId, enabled: false, sourceLinkSha256 };
        verify = async () => {
          const environment = await this.#environment();
          const service = await this.#service(input.serviceId, environment);
          return { complete: !service.autoDeployEnabled, evidence: { binding: this.#binding,
            serviceId: input.serviceId, autoDeployEnabled: service.autoDeployEnabled, sourceLinkSha256 } };
        };
      } else {
        requireValue(ID.test(input.deploymentId), "RAILWAY_RECOVERY_BINDING_MISMATCH");
        expectedInput = { binding: this.#binding, serviceId: input.serviceId, deploymentId: input.deploymentId, sourceLinkSha256 };
        verify = async () => {
          const deployment = await this.#readDeployment(input.deploymentId, input.serviceId);
          return { complete: cancel ? !CANCEL_STATUSES.has(deployment.status) : stopped(deployment), evidence: { deployment, sourceLinkSha256 } };
        };
      }
    } else {
      const policy = await this.#policyRead();
      const patchSha256 = digest(this.#triggerPatch(policy.services));
      expectedInput = stage ? { binding: this.#binding, patchSha256, links }
        : { binding: this.#binding, patchSha256, stagedPatchId: input.stagedPatchId, skipDeploys: true, links };
      if (commit) requireValue(ID.test(input.stagedPatchId), "RAILWAY_RECOVERY_BINDING_MISMATCH");
      verify = async () => {
        const readback = await this.#policyRead();
        const staged = readback.environment.staged;
        if (stage) return { complete: staged.status === "STAGED" && digest(staged.patch) === patchSha256,
          evidence: { binding: this.#binding, stagedPatchId: staged.id, patchSha256: digest(staged.patch), links } };
        const stagingEmpty = noOpPatch(staged.patch);
        const triggersDisabled = this.#triggersDisabled({ services: readback.services });
        return { complete: stagingEmpty && triggersDisabled && !["APPLYING", "FAILED"].includes(staged.status),
          evidence: { binding: this.#binding, patchSha256, links, stagingEmpty, triggersDisabled } };
      };
    }
    requireValue(canonical(input) === canonical(expectedInput), "RAILWAY_RECOVERY_BINDING_MISMATCH");
    expectedInput = freeze(expectedInput);
    checkSignal(this.#signal);
    let intent;
    try { intent = await readIntent(kind, expectedInput); }
    catch { throw new RailwaySourceFenceError("RAILWAY_DURABLE_INTENT_UNPROVEN"); }
    checkSignal(this.#signal);
    requireValue(intent?.schemaVersion === 1 && intent.type === "intent" && intent.kind === kind
      && intent.inputSha256 === digest(expectedInput), "RAILWAY_DURABLE_INTENT_UNPROVEN");
    return this.#operation(kind, expectedInput, async () => {
      throw new RailwaySourceFenceError("RAILWAY_RECOVERY_APPLY_FORBIDDEN");
    }, verify);
  }
  async stopWriters() {
    this.#requireExpectedLinks();
    const initial = await this.read();
    requireValue(this.#triggersDisabled(initial) && initial.staged.empty, "RAILWAY_TRIGGERS_NOT_FENCED");
    for (const service of initial.services) for (const original of service.deployments) {
      let current = await this.#readDeployment(original.id, service.serviceId);
      const operationInput = { binding: this.#binding, serviceId: service.serviceId, deploymentId: original.id,
        sourceLinkSha256: service.sourceLinkSha256 };
      if (CANCEL_STATUSES.has(current.status)) {
        const verify = async () => {
          const deployment = await this.#readDeployment(original.id, service.serviceId);
          return { complete: !CANCEL_STATUSES.has(deployment.status), evidence: { deployment, sourceLinkSha256: service.sourceLinkSha256 } };
        };
        await this.#operation("RAILWAY_CANCEL_SOURCE_DEPLOYMENT", operationInput, async () => {
          const preflight = await this.#readDeployment(original.id, service.serviceId);
          if (!CANCEL_STATUSES.has(preflight.status)) return;
          await this.#request(MUTATIONS.cancel, { id: original.id });
        }, verify);
        current = await this.#readDeployment(original.id, service.serviceId);
      }
      if (!stopped(current)) {
        const verify = async () => {
          const deployment = await this.#readDeployment(original.id, service.serviceId);
          return { complete: stopped(deployment), evidence: { deployment, sourceLinkSha256: service.sourceLinkSha256 } };
        };
        await this.#operation("RAILWAY_STOP_SOURCE_DEPLOYMENT", operationInput, async () => {
          const preflight = await this.#readDeployment(original.id, service.serviceId);
          if (stopped(preflight)) return;
          requireValue(!CANCEL_STATUSES.has(preflight.status), "RAILWAY_DEPLOYMENT_TRANSITION_REQUIRES_REPLAN");
          await this.#request(MUTATIONS.stop, { id: original.id });
        }, verify);
      }
    }
    // Fresh, fully paginated inventory detects deployments created during fencing.
    return this.assertFenced();
  }
  async assertFenced() {
    this.#requireExpectedLinks();
    const snapshot = await this.read();
    const blockers = [];
    if (!this.#triggersDisabled(snapshot)) blockers.push("TRIGGERS_NOT_FENCED");
    if (!snapshot.staged.empty) blockers.push("STAGED_CHANGES_PRESENT");
    if (["APPLYING", "FAILED"].includes(snapshot.staged.status)) blockers.push("STAGING_NOT_IDLE");
    if (snapshot.pendingWork.length !== 0) blockers.push("PENDING_ENVIRONMENT_WORK");
    if (snapshot.services.some((service) => service.activeDeployments.length > 0)) blockers.push("ACTIVE_DEPLOYMENTS_PRESENT");
    if (snapshot.services.some((service) => service.deployments.some((deployment) => !stopped(deployment)))) blockers.push("DEPLOYMENTS_NOT_STOPPED");
    return freeze({ complete: blockers.length === 0, evidence: { ...snapshot, providerFence: blockers.length === 0 ? "VERIFIED" : "UNPROVEN",
      databaseFence: "UNPROVEN", manualDeployPrevention: "UNPROVEN", blockers } });
  }
}
