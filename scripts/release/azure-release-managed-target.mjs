import { isDeepStrictEqual, types as nodeTypes } from "node:util";
function invalid() { throw new Error("MANAGED_AZURE_RELEASE_INPUT_INVALID"); }
function hasEnumerable(prototype) { const descriptors = Object.getOwnPropertyDescriptors(prototype);
  return Reflect.ownKeys(descriptors).some((key) => descriptors[key].enumerable); }
function objectValue(value) {
  try {
    if (nodeTypes.isProxy(value) || value === null || typeof value !== "object" || Array.isArray(value)) invalid();
    const prototype = Object.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null) invalid();
    if (hasEnumerable(Object.prototype)) invalid();
    return value;
  } catch { invalid(); }
}
function exactRecord(value, keys) {
  const object = objectValue(value);
  try {
    const names = Reflect.ownKeys(object);
    const descriptors = Object.getOwnPropertyDescriptors(object);
    if (names.length !== keys.length || keys.some((key) => !Object.hasOwn(descriptors, key))
      || names.some((key) => typeof key !== "string" || !descriptors[key].enumerable
        || !Object.hasOwn(descriptors[key], "value"))) invalid();
    return Object.fromEntries(keys.map((key) => [key, descriptors[key].value]));
  } catch { invalid(); }
}
function exactArray(value) {
  try {
    if (nodeTypes.isProxy(value) || !Array.isArray(value) || Object.getPrototypeOf(value) !== Array.prototype || value.length > 1_024) invalid();
    if (hasEnumerable(Array.prototype) || hasEnumerable(Object.prototype)) invalid();
    const names = Reflect.ownKeys(value);
    const descriptors = Object.getOwnPropertyDescriptors(value);
    if (names.length !== value.length + 1 || names[value.length] !== "length") invalid();
    return Array.from({ length: value.length }, (_, index) => {
      const key = String(index);
      if (names[index] !== key || !descriptors[key].enumerable || !Object.hasOwn(descriptors[key], "value")) invalid();
      return descriptors[key].value;
    });
  } catch { invalid(); }
}
function safeTopology(value) {
  try {
    const stack = [value]; const seen = new Set();
    while (stack.length > 0) {
      const item = stack.pop();
      if (item === null || typeof item === "string" || typeof item === "boolean"
        || (typeof item === "number" && Number.isFinite(item))) continue;
      const object = objectValue(item);
      if (seen.has(object) || seen.size >= 1_024) invalid();
      seen.add(object);
      const names = Reflect.ownKeys(object); const descriptors = Object.getOwnPropertyDescriptors(object);
      if (names.length > 1_024) invalid();
      for (const key of names) {
        const descriptor = descriptors[key];
        if (typeof key !== "string" || !descriptor.enumerable || !Object.hasOwn(descriptor, "value")) invalid();
        stack.push(descriptor.value);
      }
    }
  } catch { invalid(); }
}
function text(value, expression, maxLength) {
  if (typeof value !== "string" || value.length > maxLength || !expression.test(value)) invalid();
  return value;
}
function uuid(value) { return text(value, /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/, 36); }
function sha(value) { return text(value, /^[0-9a-f]{40}$/, 40); }
function digest(value) { return text(value, /^sha256:[0-9a-f]{64}$/, 71); }
function deepFreeze(value) {
  const seen = new Set();
  const visit = (item) => {
    if (item === null || typeof item !== "object") return;
    if (seen.has(item)) invalid();
    seen.add(item);
    for (const key of Object.keys(item)) visit(item[key]);
    Object.freeze(item);
  };
  visit(value);
  return value;
}
function targetProjection(value) {
  const raw = exactRecord(value, ["subscriptionId", "resourceGroup", "acrResourceGroup", "acrName", "acrServer", "webAppName", "workerAppName"]);
  const acrName = text(raw.acrName, /^[a-z0-9]{5,50}$/, 50);
  const resourceGroup = text(raw.resourceGroup, /^[A-Za-z0-9][A-Za-z0-9_.()-]*$/, 90);
  const acrResourceGroup = text(raw.acrResourceGroup, /^[A-Za-z0-9][A-Za-z0-9_.()-]*$/, 90);
  const webAppName = text(raw.webAppName, /^[a-z][a-z0-9-]{0,29}[a-z0-9]$/, 31);
  const workerAppName = text(raw.workerAppName, /^[a-z][a-z0-9-]{0,29}[a-z0-9]$/, 31);
  const target = { subscriptionId: uuid(raw.subscriptionId), resourceGroup, acrResourceGroup, acrName,
    acrServer: text(raw.acrServer, /^[a-z0-9]{5,50}\.azurecr\.io$/, 64), webAppName, workerAppName };
  if (resourceGroup.endsWith(".") || acrResourceGroup.endsWith(".") || target.acrServer !== `${acrName}.azurecr.io`
    || webAppName.includes("--") || workerAppName.includes("--") || webAppName === workerAppName) invalid();
  return target;
}
function overlapsTarget(target, value) {
  try { const descriptors = Object.getOwnPropertyDescriptors(objectValue(value)); const read = (key) => Object.hasOwn(descriptors, key) ? descriptors[key].value : null;
    const subscriptionId = read("subscriptionId"); const resourceGroup = read("resourceGroup"); const names = [read("webAppName"), read("workerAppName")];
    return typeof subscriptionId === "string" && subscriptionId.toLowerCase() === target.subscriptionId && typeof resourceGroup === "string"
      && resourceGroup.toLowerCase() === target.resourceGroup.toLowerCase()
      && names.some((name) => typeof name === "string" && [target.webAppName, target.workerAppName].includes(name.toLowerCase()));
  } catch { return false; }
}
function deployment(value) {
  const keys = [
    "deploymentId", "deploymentKind", "cloudProvider", "environment", "deploymentStatus",
    "provisioningStatus", "releaseEligible", "provider", "group", "workload", "azure",
  ];
  const object = objectValue(value);
  const row = exactRecord(value, Object.hasOwn(object, "workloadClass") ? [...keys.slice(0, -1), "workloadClass", "azure"] : keys);
  safeTopology(row);
  uuid(row.deploymentId);
  return Object.hasOwn(row, "workloadClass") ? row : { ...row, workloadClass: "ACTIVE_CLIENT_PRIMARY" };
}
function targetFromDeployment(row, deploymentId) {
  if (uuid(row.deploymentId) !== deploymentId || row.cloudProvider !== "AZURE" || row.environment !== "production"
    || row.deploymentStatus !== "ACTIVE" || row.provisioningStatus !== "active" || row.provider !== "azure") invalid();
  const primary = row.workloadClass === "ACTIVE_CLIENT_PRIMARY" && row.deploymentKind === "REMOTE_MANAGED"
    && row.releaseEligible === true && row.group === "managed-customers" && row.workload === "managed-customers";
  const hostedPrimary = row.workloadClass === "ACTIVE_CLIENT_PRIMARY" && row.deploymentKind === "HOSTED_DEDICATED"
    && row.releaseEligible === true && row.group === "hosted-dedicated" && row.workload === "hosted-dedicated";
  const canary = row.workloadClass === "ACTIVE_CLIENT_CANARY" && row.deploymentKind === "HOSTED_DEDICATED"
    && row.group === "hosted-dedicated" && row.workload === "active-client-canary";
  if (!primary && !hostedPrimary && !canary) invalid();
  return targetProjection(row.azure);
}
function manifestDigest(raw) {
  if (typeof raw !== "string" || raw.length === 0 || raw.length > 16_384 || raw !== raw.trim()) invalid();
  let parsed;
  try { parsed = JSON.parse(raw); } catch { invalid(); }
  const object = objectValue(parsed);
  const descriptor = Object.getOwnPropertyDescriptor(object, "digest");
  let depth = 0; let quote = -1; let escaped = false; let count = 0;
  for (let index = 0; index < raw.length; index += 1) {
    const character = raw[index];
    if (quote >= 0) {
      if (escaped) escaped = false;
      else if (character === "\\") escaped = true;
      else if (character === "\"") {
        let cursor = index + 1;
        while (/\s/.test(raw[cursor] ?? "")) cursor += 1;
        if (depth === 1 && raw[cursor] === ":" && JSON.parse(raw.slice(quote, index + 1)) === "digest") count += 1;
        quote = -1;
      }
    } else if (character === "\"") quote = index;
    else if (character === "{" || character === "[") depth += 1;
    else if (character === "}" || character === "]") depth -= 1;
  }
  if (count !== 1 || !descriptor?.enumerable || !Object.hasOwn(descriptor, "value")) invalid();
  return digest(descriptor.value);
}
function expectedBinding(role, gitSha, sourceDigest) {
  const imageTag = `sha-${gitSha}`;
  return { role, sourceTag: `ghcr.io/corgtexdotcom/corgtex/${role}:${imageTag}`, sourceDigest,
    sourceDigestRef: `ghcr.io/corgtexdotcom/corgtex/${role}@${sourceDigest}`,
    destinationRepository: `corgtex/${role}`, destinationTag: `corgtex/${role}:${imageTag}` };
}
function bindingFromManifest(value, role, gitSha) {
  const raw = exactRecord(value, ["sourceTag", "raw"]);
  if (raw.sourceTag !== `ghcr.io/corgtexdotcom/corgtex/${role}:sha-${gitSha}`) invalid();
  return expectedBinding(role, gitSha, manifestDigest(raw.raw));
}
function canonicalBinding(value, expectedRole, expectedSha) {
  const raw = exactRecord(value, ["role", "sourceTag", "sourceDigest", "sourceDigestRef", "destinationRepository", "destinationTag"]);
  if ((raw.role !== "web" && raw.role !== "worker") || typeof raw.sourceTag !== "string") invalid();
  const match = /^ghcr\.io\/corgtexdotcom\/corgtex\/(web|worker):sha-([0-9a-f]{40})$/.exec(raw.sourceTag);
  if (!match || match[1] !== raw.role || (expectedRole && raw.role !== expectedRole)
    || (expectedSha && match[2] !== expectedSha)) invalid();
  const expected = expectedBinding(raw.role, match[2], digest(raw.sourceDigest));
  if (Object.keys(expected).some((key) => raw[key] !== expected[key])) invalid();
  return expected;
}
function canonicalIntent(value) {
  const raw = exactRecord(value, ["schemaVersion", "deploymentId", "target", "gitSha", "imageTag", "roles"]);
  const gitSha = sha(raw.gitSha);
  if (raw.schemaVersion !== 1 || raw.imageTag !== `sha-${gitSha}`) invalid();
  const roles = exactRecord(raw.roles, ["web", "worker"]);
  return deepFreeze({ schemaVersion: 1, deploymentId: uuid(raw.deploymentId), target: targetProjection(raw.target), gitSha,
    imageTag: `sha-${gitSha}`, roles: { web: canonicalBinding(roles.web, "web", gitSha), worker: canonicalBinding(roles.worker, "worker", gitSha) } });
}
export function canonicalizeManagedAzureReleaseIntentV1(input) {
  const raw = exactRecord(input, ["deploymentId", "deployments", "gitSha", "manifests"]);
  const deploymentId = uuid(raw.deploymentId);
  const deployments = exactArray(raw.deployments).map(deployment); const matches = deployments.filter((row) => row.deploymentId === deploymentId);
  if (matches.length !== 1) invalid();
  const target = targetFromDeployment(matches[0], deploymentId); if (deployments.some((row) => row !== matches[0] && overlapsTarget(target, row.azure))) invalid();
  const gitSha = sha(raw.gitSha); const imageTag = `sha-${gitSha}`;
  const manifests = exactRecord(raw.manifests, ["web", "worker"]);
  return deepFreeze({ schemaVersion: 1, deploymentId, target, gitSha, imageTag,
    roles: { web: bindingFromManifest(manifests.web, "web", gitSha), worker: bindingFromManifest(manifests.worker, "worker", gitSha) } });
}
export function canonicalizeManagedAzureImportRequestV1(input) {
  const raw = exactRecord(input, ["intent", "role"]);
  if (raw.role !== "web" && raw.role !== "worker") invalid();
  const intent = canonicalIntent(raw.intent);
  return deepFreeze({ schemaVersion: 1, deploymentId: intent.deploymentId, target: { ...intent.target },
    binding: { ...intent.roles[raw.role] }, mode: "NoForce" });
}
export function canonicalizeManagedAzureImportRequestValueV1(request) {
  const raw = exactRecord(request, ["schemaVersion", "deploymentId", "target", "binding", "mode"]);
  if (raw.schemaVersion !== 1 || raw.mode !== "NoForce") invalid();
  return deepFreeze({ schemaVersion: 1, deploymentId: uuid(raw.deploymentId), target: targetProjection(raw.target),
    binding: canonicalBinding(raw.binding), mode: "NoForce" });
}
export function compareManagedAzureDestinationDigestV1(input) {
  const raw = exactRecord(input, ["expectedRequest", "observedRequest", "destinationDigest"]);
  const request = canonicalizeManagedAzureImportRequestValueV1(raw.expectedRequest);
  const observed = canonicalizeManagedAzureImportRequestValueV1(raw.observedRequest);
  if (!isDeepStrictEqual(request, observed)) invalid();
  const destinationDigest = raw.destinationDigest === null ? null : digest(raw.destinationDigest);
  const state = destinationDigest === null ? "ABSENT" : destinationDigest === request.binding.sourceDigest ? "MATCH" : "CONFLICT";
  return deepFreeze({ schemaVersion: 1, request, state, destinationDigest,
    destinationImage: state === "MATCH" ? `${request.target.acrServer}/${request.binding.destinationRepository}@${destinationDigest}` : null });
}
