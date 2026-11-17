import { archiveEvidenceHash as hash } from "./ops-core-archive.mjs";

const uuid = /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/;
const exact = (value, keys) => value && Object.keys(value).sort().join() === keys.sort().join();
const need = value => { if (!value) throw Error("ACTIVATION_EXTERNAL_RECOVERY_INVALID"); };
const sameId = (a, b) => typeof a === "string" && typeof b === "string" && a.toLowerCase() === b.toLowerCase();

export function opsCoreRevisionSuffix(prefix, app, operationId, role, legacy = false) {
  const nonce = operationId.replaceAll("-", "").slice(0, 16);
  const full = `${prefix}-${nonce}-${role}`;
  const budget = 54 - app.length - 2;
  return legacy || full.length <= budget ? full : `${prefix}-${nonce.slice(0, budget - prefix.length - 3)}-${role[0]}`;
}

export const activationSuffix = (app, operationId, role, legacy) => opsCoreRevisionSuffix("boot", app, operationId, role, legacy);

// These records are produced by the independent one-shot operator under the
// original private custody. The controller can verify the corrected worker,
// never issue an additional create for this inherited provider operation.
export async function readActivationRecovery({ read, domain, intentSha256, operationId, workerId, webId, environmentId, body, createInput }) {
  const recovery = await read("worker-revision-recovery");
  const route = await read("activation-web-route");
  if (!recovery) { need(!route); return { worker: body, evidence: {}, route: null }; }
  const shared = { schemaVersion: 1, domain, intentSha256, activationOperationId: operationId };
  const matches = row => Object.entries(shared).every(([k,v]) => row[k] === v);
  need(domain === "ops" && matches(recovery) && exact(recovery, [...Object.keys(shared), "resourceId", "originalBodySha256",
    "correctedBodySha256", "correctedRevisionName", "originalCreateIntentSha256", "rejectionCorrelationId", "correctedWriteCorrelationId"])
    && sameId(recovery.resourceId, workerId) && recovery.originalBodySha256 === hash(body)
    && uuid.test(recovery.rejectionCorrelationId) && uuid.test(recovery.correctedWriteCorrelationId)
    && recovery.rejectionCorrelationId !== recovery.correctedWriteCorrelationId);
  const name = workerId.split("/").at(-1), previous = body.properties.template.revisionSuffix;
  const suffix = activationSuffix(name, operationId, "worker");
  need(previous === activationSuffix(name, operationId, "worker", true) && previous !== suffix);
  const worker = structuredClone(body);
  worker.properties.template.revisionSuffix = suffix;
  need(recovery.correctedBodySha256 === hash(worker) && recovery.correctedRevisionName === name + "--" + suffix);
  const kind = "azure.create.worker", inputSha256 = hash(createInput), operationKey = hash({ kind, inputSha256 });
  const original = await read(operationKey + "/intent");
  need(original?.schemaVersion === 1 && original.type === "intent" && original.kind === kind && original.operationKey === operationKey
    && original.inputSha256 === inputSha256 && uuid.test(original.operationId) && hash(original) === recovery.originalCreateIntentSha256
    && hash(original.binding) === hash({ domain, intentSha256, phase: "TARGET_ACTIVATING", phaseOperationId: operationId }));
  const evidence = { workerRevisionRecoverySha256: hash(recovery) };
  if (route) {
    const prefix = environmentId.toLowerCase() + "/managedcertificates/";
    need(matches(route) && exact(route, [...Object.keys(shared), "resourceId", "hostname", "certificateId"])
      && sameId(route.resourceId, webId) && route.hostname === "ops.corgtex.com"
      && typeof route.certificateId === "string" && route.certificateId.toLowerCase().startsWith(prefix)
      && /^[a-z0-9-]{1,80}$/i.test(route.certificateId.slice(prefix.length)));
    evidence.earlyWebRouteSha256 = hash(route);
  }
  return { worker, route, evidence, recovery };
}

export function matchesEarlyRoute(ingress, route) {
  const domains = ingress?.customDomains;
  return Array.isArray(domains) && domains.length === 1 && domains[0].name === route.hostname
    && domains[0].bindingType === "SniEnabled" && sameId(domains[0].certificateId, route.certificateId);
}

export function verifyEarlyCertificate(result, route) {
  const c = result.body;
  need(result.status === 200 && sameId(c?.id, route.certificateId)
    && sameId(c.type, "Microsoft.App/managedEnvironments/managedCertificates")
    && c.properties?.subjectName === route.hostname && c.properties.provisioningState === "Succeeded");
}

export function verifyRecoveryActivity(rows, recovery, corrected, originalName) {
  const correlationId = corrected ? recovery.correctedWriteCorrelationId : recovery.rejectionCorrelationId;
  need(Array.isArray(rows) && rows.length > 0 && rows.length < 20);
  const writes = rows.filter(row => sameId(row.resourceId, recovery.resourceId)
    && sameId(row.operationName, "Microsoft.App/containerApps/write") && row.eventName === "EndRequest");
  need(writes.length > 0 && writes.every(row => sameId(row.correlationId, correlationId)
    && sameId(row.scope, recovery.resourceId) && sameId(row.action, "Microsoft.App/containerApps/write")));
  if (corrected) {
    need(writes.some(row => row.status === "Succeeded") && writes.every(row => ["Succeeded","Accepted"].includes(row.status)));
  } else {
    need(writes.length === 1 && writes[0].status === "Failed" && writes[0].subStatus === "BadRequest");
    const error = JSON.parse(writes[0].statusMessage).error;
    need(error.code === "ContainerAppInvalidRevisionName" && error.message.includes("'" + originalName + "'"));
  }
}
