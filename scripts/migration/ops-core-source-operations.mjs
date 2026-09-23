import { archiveEvidenceHash } from "./ops-core-archive.mjs";
import { openProviderOperationRecorder } from "./ops-core-provider-operations.mjs";

const ID = /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/;
const HASH = /^[a-f0-9]{64}$/;
const LIMIT = 64 * 1024;
class SourceOperationError extends Error {}
const fail = code => { throw new SourceOperationError(code); };
const keys = (value, expected) => value !== null && typeof value === "object" && !Array.isArray(value)
  && Object.keys(value).sort().join(",") === expected.split(",").sort().join(",");
const exact = (value, expected) => { if (!keys(value, expected)) fail("SOURCE_DESCRIPTOR_FIELDS_INVALID"); };
const requireValue = condition => { if (!condition) fail("SOURCE_DESCRIPTOR_BINDING_INVALID"); };
const identifier = value => typeof value === "string" && /^[a-z][a-z0-9_]{0,62}$/.test(value);
function binding(value) {
  exact(value, "projectId,environmentId,serviceIds");
  requireValue(ID.test(value.projectId) && ID.test(value.environmentId) && Array.isArray(value.serviceIds)
    && value.serviceIds.length > 0 && value.serviceIds.length <= 20 && value.serviceIds.every(id => ID.test(id))
    && new Set(value.serviceIds).size === value.serviceIds.length);
}
function links(value, expected) {
  requireValue(Array.isArray(value) && value.length === expected.length);
  for (const link of value) {
    exact(link, "serviceId,sourceLinkSha256");
    requireValue(expected.includes(link.serviceId) && HASH.test(link.sourceLinkSha256));
  }
  requireValue(new Set(value.map(link => link.serviceId)).size === expected.length);
}
function postgres(input, session) {
  exact(input, `expected,intentSha256,retainedSecretVersion,transport${session ? ",pid,backendStartSha256" : ""}`);
  const expected = input.expected;
  exact(expected, "domain,connection,systemIdentifier,databaseOid,readerRole,databaseServiceSha256");
  exact(expected.connection, "host,port,database,user");
  requireValue(["ops", "core"].includes(expected.domain) && HASH.test(expected.databaseServiceSha256)
    && /^[0-9]{1,20}$/.test(expected.systemIdentifier) && /^[1-9][0-9]{0,9}$/.test(expected.databaseOid)
    && identifier(expected.readerRole) && expected.readerRole !== "postgres"
    && typeof expected.connection.host === "string" && /^[a-z0-9][a-z0-9.-]{0,252}$/i.test(expected.connection.host)
    && Number.isInteger(expected.connection.port) && expected.connection.port > 0 && expected.connection.port < 65536
    && identifier(expected.connection.database) && expected.connection.user === "postgres" && HASH.test(input.intentSha256)
    && /^https:\/\/[a-z0-9-]{3,24}\.vault\.azure\.net\/secrets\/[a-zA-Z0-9-]{1,127}\/[a-f0-9]{32}$/.test(input.retainedSecretVersion));
  exact(input.transport, "source,reader");
  for (const transport of Object.values(input.transport)) {
    exact(transport, "mode,certificateSha256");
    requireValue(["disable", "require", "verify-full"].includes(transport.mode)
      && (transport.mode === "disable" ? transport.certificateSha256 === null : HASH.test(transport.certificateSha256)));
  }
  if (session) requireValue(Number.isSafeInteger(input.pid) && input.pid > 0 && HASH.test(input.backendStartSha256));
}

/** Only the known source-fence inputs may be retained. Runtime credentials,
 * connection URLs and arbitrary provider response fields are not descriptors.
 */
export function validateSourceOperationDescriptor(kind, input) {
  if (kind === "RAILWAY_DISABLE_AUTODEPLOY") {
    exact(input, "projectId,environmentId,serviceId,enabled,sourceLinkSha256");
    requireValue(ID.test(input.projectId) && ID.test(input.environmentId) && ID.test(input.serviceId)
      && input.enabled === false && HASH.test(input.sourceLinkSha256));
  } else if (["RAILWAY_STAGE_SOURCE_TRIGGERS", "RAILWAY_COMMIT_SOURCE_TRIGGERS"].includes(kind)) {
    const commit = kind === "RAILWAY_COMMIT_SOURCE_TRIGGERS";
    exact(input, commit ? "binding,patchSha256,links,stagedPatchId,skipDeploys" : "binding,patchSha256,links");
    binding(input.binding);
    links(input.links, input.binding.serviceIds);
    requireValue(HASH.test(input.patchSha256) && (!commit || (ID.test(input.stagedPatchId) && input.skipDeploys === true)));
  } else if (["RAILWAY_STOP_SOURCE_DEPLOYMENT", "RAILWAY_CANCEL_SOURCE_DEPLOYMENT"].includes(kind)) {
    exact(input, "binding,serviceId,deploymentId,sourceLinkSha256");
    binding(input.binding);
    requireValue(input.binding.serviceIds.includes(input.serviceId) && ID.test(input.deploymentId) && HASH.test(input.sourceLinkSha256));
  } else if (["POSTGRES_ROTATE_RUNTIME_PASSWORD", "POSTGRES_TERMINATE_OLD_RUNTIME_SESSION"].includes(kind)) {
    postgres(input, kind === "POSTGRES_TERMINATE_OLD_RUNTIME_SESSION");
  } else fail("SOURCE_DESCRIPTOR_KIND_INVALID");
  return { kind, input };
}

export async function openSourceOperations({ custody, store }) {
  const initial = custody.snapshot();
  if (initial.pending?.to !== "SOURCE_FENCED") fail("SOURCE_PHASE_REQUIRED");
  const phaseBinding = { domain: initial.domain, intentSha256: initial.intentSha256,
    phase: "SOURCE_FENCED", phaseOperationId: initial.pending.operationId };
  const prefix = `operations/${initial.domain}/${initial.intentSha256}/${initial.pending.operationId}/`;
  const recorder = await openProviderOperationRecorder({ custody, store, phase: "SOURCE_FENCED", signal: custody.signal });
  let uncertain = false;
  let busy = false;
  const check = async () => {
    if (uncertain) fail("SOURCE_OPERATION_RECONCILE_REQUIRED");
    custody.signal.throwIfAborted();
    await custody.assertOwned();
    const current = custody.snapshot();
    if (current.intentSha256 !== initial.intentSha256 || current.domain !== initial.domain
      || current.pending?.operationId !== initial.pending.operationId || current.pending?.to !== "SOURCE_FENCED") fail("SOURCE_PHASE_CHANGED");
  };
  const guarded = async action => {
    if (busy) fail("SOURCE_OPERATION_CONCURRENT");
    busy = true;
    try { await check(); const result = await action(); await check(); return result; }
    catch { uncertain = true; fail("SOURCE_OPERATION_RECONCILE_REQUIRED"); }
    finally { busy = false; }
  };
  const text = (value, limit = LIMIT) => {
    const encoded = JSON.stringify(value);
    if (Buffer.byteLength(encoded) > limit) fail("SOURCE_DESCRIPTOR_TOO_LARGE");
    return encoded;
  };
  async function read(key) {
    await check();
    const value = await store.readOptional(key, custody.signal);
    await check();
    if (value === null) return null;
    const limit = /\/phase-evidence-[a-f0-9]{64}\.json$/.test(key) ? 32 * 1024 * 1024 : LIMIT;
    if (typeof value !== "string" || Buffer.byteLength(value) > limit) fail("SOURCE_RECORD_INVALID");
    const record = JSON.parse(value);
    if (record === null || typeof record !== "object" || Array.isArray(record)) fail("SOURCE_RECORD_INVALID");
    return record;
  }
  async function retain(key, value, limit = LIMIT) {
    const existing = await read(key);
    if (existing !== null) {
      if (archiveEvidenceHash(existing) !== archiveEvidenceHash(value)) fail("SOURCE_RECORD_MISMATCH");
      return;
    }
    await store.assertPrivate();
    await check();
    await store.createOnly(key, text(value, limit), custody.signal);
    await check();
    if (archiveEvidenceHash(await read(key)) !== archiveEvidenceHash(value)) fail("SOURCE_RECORD_READBACK_MISMATCH");
  }
  function descriptor(kind, supplied) {
    const input = JSON.parse(text(supplied));
    validateSourceOperationDescriptor(kind, input);
    if (kind.startsWith("POSTGRES_") && (input.expected.domain !== initial.domain
      || input.intentSha256 !== initial.intentSha256)) fail("SOURCE_DESCRIPTOR_CUSTODY_MISMATCH");
    const inputSha256 = archiveEvidenceHash(input);
    return { schemaVersion: 1, type: "descriptor", binding: phaseBinding,
      kind, input, inputSha256, operationKey: archiveEvidenceHash({ kind, inputSha256 }) };
  }
  async function inventory() {
    const names = await store.listDescriptors(prefix, custody.signal);
    await check();
    if (!Array.isArray(names) || names.length > 5000 || new Set(names).size !== names.length) fail("SOURCE_DESCRIPTOR_LIST_INVALID");
    const result = [];
    for (const name of names) {
      await check();
      if (typeof name !== "string" || !name.startsWith(prefix)
        || !/^[a-f0-9]{64}\/descriptor\.json$/.test(name.slice(prefix.length))) fail("SOURCE_DESCRIPTOR_KEY_INVALID");
      const record = await read(name);
      if (!record || archiveEvidenceHash(record) !== archiveEvidenceHash(descriptor(record.kind, record.input))
        || name !== `${prefix}${record.operationKey}/descriptor.json`) fail("SOURCE_DESCRIPTOR_MISMATCH");
      const status = await recorder.readStatus(record.kind, record.input);
      result.push({ descriptor: { kind: record.kind, input: record.input }, operationKey: record.operationKey,
        intent: status.intent, receipt: status.receipt });
    }
    return result;
  }
  return {
    readIntent: (...args) => guarded(() => recorder.readIntent(...args)),
    async runRecordedOperation(operation) {
      return guarded(async () => {
        const record = descriptor(operation.kind, operation.input);
        await retain(`${prefix}${record.operationKey}/descriptor.json`, record);
        await check();
        return recorder.runRecordedOperation({ ...operation, input: record.input });
      });
    },
    async pendingDescriptors() {
      return guarded(async () => (await inventory()).filter(record => record.intent && !record.receipt).map(record => record.descriptor));
    },
    async recordedDescriptors() {
      return guarded(async () => (await inventory()).filter(record => record.intent !== null)
        .map(record => ({ ...record.descriptor, completed: record.receipt !== null })));
    },
    async assertSettled() {
      return guarded(async () => {
        const records = await inventory();
        if (records.some(record => record.intent && !record.receipt)) fail("SOURCE_OPERATIONS_PENDING");
        const evidence = records.map(({ operationKey, intent, receipt }) => ({ operationKey,
          operationId: intent?.operationId ?? null, receiptSha256: receipt ? archiveEvidenceHash(receipt) : null }));
        return { descriptorCount: records.length, completedCount: records.filter(record => record.receipt).length,
          sha256: archiveEvidenceHash(evidence) };
      });
    },
    async retainPhaseArtifact(name, value) {
      if (!["phase-plan", "phase-evidence"].includes(name)) fail("SOURCE_ARTIFACT_NAME_INVALID");
      return guarded(async () => {
        const digest = archiveEvidenceHash(value);
        const filename = name === "phase-evidence" ? `${name}-${digest}` : name;
        // Provider deployment history can exceed the descriptor-size bound.
        // Content-addressed evidence preserves each fresh recovery observation.
        await retain(`${prefix}${filename}.json`, value, name === "phase-evidence" ? 32 * 1024 * 1024 : LIMIT);
        return digest;
      });
    },
  };
}
