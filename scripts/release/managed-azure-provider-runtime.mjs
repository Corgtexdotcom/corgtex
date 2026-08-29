import { types as nodeTypes } from "node:util";

import { canonicalizeManagedAzureImportRequestValueV1 } from "./azure-release-managed-target.mjs";

const FAILURE = "MANAGED_AZURE_PROVIDER_OBSERVATION_FAILED";
const MAX_JSON_BYTES = 16_384;
const SPAWN_OPTIONS = Object.freeze({
  stdio: Object.freeze(["ignore", "pipe", "pipe"]),
  shell: false,
  detached: false,
  timeoutMs: 10_000,
  maxStdoutBytes: MAX_JSON_BYTES,
  maxStderrBytes: 4_096,
});
const TARGET_KEYS = Object.freeze(["subscriptionId", "resourceGroup", "acrResourceGroup", "acrName", "acrServer", "webAppName", "workerAppName"]);

function fail() { throw new Error(FAILURE); }
function hasEnumerable(prototype) {
  const descriptors = Object.getOwnPropertyDescriptors(prototype);
  return Reflect.ownKeys(descriptors).some((key) => descriptors[key].enumerable);
}
function objectDescriptors(value) {
  try {
    if (nodeTypes.isProxy(value) || value === null || typeof value !== "object" || Array.isArray(value)) fail();
    const prototype = Object.getPrototypeOf(value);
    if ((prototype !== Object.prototype && prototype !== null) || hasEnumerable(Object.prototype)) fail();
    return Object.getOwnPropertyDescriptors(value);
  } catch { fail(); }
}
function exactRecord(value, keys) {
  const descriptors = objectDescriptors(value);
  const names = Reflect.ownKeys(descriptors);
  if (names.length !== keys.length || names.some((key) => typeof key !== "string" || !keys.includes(key))
    || keys.some((key) => !descriptors[key]?.enumerable || !Object.hasOwn(descriptors[key], "value"))) fail();
  return Object.fromEntries(keys.map((key) => [key, descriptors[key].value]));
}
function exactArray(value, maxLength = 64) {
  try {
    if (nodeTypes.isProxy(value) || !Array.isArray(value) || Object.getPrototypeOf(value) !== Array.prototype
      || hasEnumerable(Array.prototype) || hasEnumerable(Object.prototype) || value.length > maxLength) fail();
    const descriptors = Object.getOwnPropertyDescriptors(value);
    const names = Reflect.ownKeys(descriptors);
    if (names.length !== value.length + 1 || names[value.length] !== "length") fail();
    return Array.from({ length: value.length }, (_, index) => {
      const descriptor = descriptors[String(index)];
      if (names[index] !== String(index) || !descriptor?.enumerable || !Object.hasOwn(descriptor, "value")) fail();
      return descriptor.value;
    });
  } catch { fail(); }
}
function deepFreeze(value) {
  if (value && typeof value === "object") {
    for (const child of Object.values(value)) deepFreeze(child);
    Object.freeze(value);
  }
  return value;
}
function parseJson(stdout) {
  if (typeof stdout !== "string" || stdout.length === 0 || stdout.length > MAX_JSON_BYTES || stdout.includes("\0")) fail();
  const source = stdout.endsWith("\n") ? stdout.slice(0, -1) : stdout;
  if (source.length === 0 || source !== source.trim()) fail();
  try { return JSON.parse(source); } catch { fail(); }
}
function time(value) {
  if (!Number.isSafeInteger(value) || value < 0 || value > 8_640_000_000_000_000) fail();
  return value;
}
function sameTarget(left, right) { return TARGET_KEYS.every((key) => left[key] === right[key]); }
function imageTag(request) {
  const prefix = `${request.binding.destinationRepository}:`;
  if (!request.binding.destinationTag.startsWith(prefix)) fail();
  return request.binding.destinationTag.slice(prefix.length);
}
function requestSha(request) {
  const match = /:sha-([0-9a-f]{40})$/.exec(request.binding.sourceTag);
  if (!match) fail();
  return match[1];
}
function canonicalRequest(value) {
  try { return canonicalizeManagedAzureImportRequestValueV1(value); } catch { fail(); }
}
async function runRead(spawn, args) {
  let handle;
  try { handle = exactRecord(spawn("az", args, SPAWN_OPTIONS), ["completion", "abort"]); } catch { fail(); }
  if (!nodeTypes.isPromise(handle.completion) || typeof handle.abort !== "function") fail();
  let raw;
  try { raw = await handle.completion; } catch { fail(); }
  const result = exactRecord(raw, ["code", "signal", "timedOut", "stdout", "stderr", "stdoutOverflow", "stderrOverflow"]);
  if (typeof result.timedOut !== "boolean") fail();
  if (result.timedOut) {
    try {
      const aborted = handle.abort();
      if (!nodeTypes.isPromise(aborted)) fail();
      await aborted;
      await handle.completion;
    } catch { fail(); }
    fail();
  }
  if (result.code !== 0 || result.signal !== null || result.stdoutOverflow !== false || result.stderrOverflow !== false
    || typeof result.stdout !== "string" || typeof result.stderr !== "string" || result.stdout.length > MAX_JSON_BYTES
    || result.stderr.length > SPAWN_OPTIONS.maxStderrBytes || result.stderr !== "") fail();
  return parseJson(result.stdout);
}
function digestObservation(value, tag) {
  const rows = exactArray(value);
  if (rows.length === 0) return { state: "ABSENT", digest: null };
  if (rows.length !== 1) fail();
  const row = exactRecord(rows[0], ["digest", "tags"]);
  const tags = exactArray(row.tags);
  if (tags.length !== 1 || tags[0] !== tag || !/^sha256:[0-9a-f]{64}$/.test(row.digest)) fail();
  return { state: "PRESENT", digest: row.digest };
}
function pullIdentity(value) {
  if (value === "system") return { kind: "SYSTEM_ASSIGNED", resourceId: null };
  if (typeof value !== "string" || value.length > 512) fail();
  const match = /^\/subscriptions\/([0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12})\/resource[Gg]roups\/([^/]{1,90})\/providers\/Microsoft\.ManagedIdentity\/userAssignedIdentities\/([^/]{1,128})$/.exec(value);
  if (!match || !/^[A-Za-z0-9][A-Za-z0-9_.()-]*$/.test(match[2]) || match[2].endsWith(".")
    || !/^[A-Za-z0-9][A-Za-z0-9_-]*$/.test(match[3])) fail();
  return { kind: "USER_ASSIGNED", resourceId: value };
}
function absentCredential(value) {
  return value === null || value === "";
}
function registryObservation(value, request, appName) {
  const rows = exactArray(value);
  if (rows.length !== 1) fail();
  const row = exactRecord(rows[0], ["server", "identity", "username", "passwordSecretRef"]);
  if (row.server !== request.target.acrServer || !absentCredential(row.username) || !absentCredential(row.passwordSecretRef)) fail();
  return { binding: { ...request.binding }, appName, registryServer: row.server, pullIdentity: pullIdentity(row.identity) };
}
function registryResourceObservation(value, request) {
  const row = exactRecord(value, ["name", "loginServer"]);
  if (row.name !== request.target.acrName || row.loginServer !== request.target.acrServer) fail();
}
function destinationArgs(request) {
  const tag = imageTag(request);
  return ["acr", "manifest", "list-metadata", "--registry", request.target.acrName, "--name", request.binding.destinationRepository,
    "--query", `[?tags!=null && contains(tags, '${tag}')].{digest:digest,tags:tags}`, "--subscription", request.target.subscriptionId,
    "--output", "json", "--only-show-errors"];
}
function registryResourceArgs(request) {
  return ["acr", "show", "--name", request.target.acrName, "--resource-group", request.target.acrResourceGroup,
    "--subscription", request.target.subscriptionId, "--query", "{name:name,loginServer:loginServer}", "--output", "json", "--only-show-errors"];
}
function registryArgs(request, appName) {
  return ["containerapp", "registry", "list", "--subscription", request.target.subscriptionId, "--resource-group",
    request.target.resourceGroup, "--name", appName, "--query",
    "[].{server:server,identity:identity,username:username,passwordSecretRef:passwordSecretRef}", "--output", "json", "--only-show-errors"];
}

export function createManagedAzureProviderObservation(value) {
  const dependencies = exactRecord(value, ["spawn", "clock"]);
  if (typeof dependencies.spawn !== "function" || typeof dependencies.clock !== "function") fail();
  const observeDestination = async (input) => {
    try {
      const request = canonicalRequest(input); const startedAt = time(dependencies.clock());
      const observed = digestObservation(await runRead(dependencies.spawn, destinationArgs(request)), imageTag(request));
      const observedAtMs = time(dependencies.clock()); if (observedAtMs < startedAt) fail();
      return deepFreeze({ schemaVersion: 1, request, observedAtMs, state: observed.state, digest: observed.digest });
    } catch { fail(); }
  };
  const observeRegistryPreflight = async (input) => {
    try {
      const raw = exactRecord(input, ["webRequest", "workerRequest"]);
      const webRequest = canonicalRequest(raw.webRequest); const workerRequest = canonicalRequest(raw.workerRequest);
      if (webRequest.binding.role !== "web" || workerRequest.binding.role !== "worker"
        || webRequest.deploymentId !== workerRequest.deploymentId || !sameTarget(webRequest.target, workerRequest.target)
        || webRequest.mode !== workerRequest.mode || requestSha(webRequest) !== requestSha(workerRequest)) fail();
      const startedAt = time(dependencies.clock());
      registryResourceObservation(await runRead(dependencies.spawn, registryResourceArgs(webRequest)), webRequest);
      const web = registryObservation(await runRead(dependencies.spawn, registryArgs(webRequest, webRequest.target.webAppName)), webRequest, webRequest.target.webAppName);
      const worker = registryObservation(await runRead(dependencies.spawn, registryArgs(workerRequest, workerRequest.target.workerAppName)), workerRequest, workerRequest.target.workerAppName);
      const observedAtMs = time(dependencies.clock()); if (observedAtMs < startedAt) fail();
      return deepFreeze({ schemaVersion: 1, deploymentId: webRequest.deploymentId, target: { ...webRequest.target }, observedAtMs, web, worker });
    } catch { fail(); }
  };
  return Object.freeze({ observeDestination, observeRegistryPreflight });
}
