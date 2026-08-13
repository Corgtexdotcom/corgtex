import { isProxy } from "node:util/types";

const FAILURE = "Managed Azure observation proof is invalid.";
const SENTINEL = "00000000-0000-4000-8000-000000000001";
const DEPENDENCY_KEYS = ["queryResourceObservations", "clock"];
const REQUEST_KEYS = ["deploymentId", "targetClass", "expectedSha", "expectedImageTag", "target", "windowStartUnixMs", "windowEndUnixMs"];
const TARGET_KEYS = ["subscriptionId", "resourceGroup", "webAppName", "workerAppName"];
const RESULT_KEYS = ["complete", "truncated", "pageCount", "continuationToken", "rows"];
const ROW_KEYS = ["deploymentId", "targetClass", "role", "subscriptionId", "resourceGroup", "appName", "gitSha", "imageTag", "status", "observedAtUnixMs"];
const fail = () => { throw new TypeError(FAILURE); };

function exactRecord(value, keys, seen) {
  if (isProxy(value) || value === null || typeof value !== "object" || Array.isArray(value)) fail();
  let prototype; let ownKeys; let descriptors;
  try { prototype = Object.getPrototypeOf(value); ownKeys = Reflect.ownKeys(value); descriptors = Object.getOwnPropertyDescriptors(value); } catch { fail(); }
  if ((prototype !== Object.prototype && prototype !== null) || ownKeys.length !== keys.length || ownKeys.some((key) => typeof key !== "string" || !keys.includes(key))) fail();
  if (seen?.has(value)) fail();
  const output = {};
  for (const key of keys) {
    const descriptor = descriptors[key];
    if (!descriptor?.enumerable || !Object.hasOwn(descriptor, "value")) fail();
    output[key] = descriptor.value;
  }
  seen?.add(value);
  return output;
}

function denseRows(value, seen) {
  if (isProxy(value) || !Array.isArray(value)) fail();
  let prototype; let ownKeys; let descriptors;
  try { prototype = Object.getPrototypeOf(value); ownKeys = Reflect.ownKeys(value); descriptors = Object.getOwnPropertyDescriptors(value); } catch { fail(); }
  const length = descriptors.length?.value;
  if (prototype !== Array.prototype || !Number.isInteger(length) || length < 1 || length > 64) fail();
  const expectedKeys = Array.from({ length }, (_, index) => String(index)).concat("length");
  if (ownKeys.length !== expectedKeys.length || ownKeys.some((key, index) => key !== expectedKeys[index])) fail();
  if (seen.has(value) || descriptors.length.enumerable || !Object.hasOwn(descriptors.length, "value")) fail();
  const rows = [];
  for (let index = 0; index < length; index += 1) {
    const descriptor = descriptors[index];
    if (!descriptor?.enumerable || !Object.hasOwn(descriptor, "value")) fail();
    rows.push(descriptor.value);
  }
  seen.add(value);
  return rows;
}

function pattern(value, min, max, expression) {
  if (typeof value !== "string" || value.length < min || value.length > max || !expression.test(value)) fail();
  return value;
}
const uuid = (value) => pattern(value, 36, 36, /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);
const gitSha = (value) => pattern(value, 40, 40, /^[0-9a-f]{40}$/);
const unixMs = (value) => { if (!Number.isSafeInteger(value) || value <= 0) fail(); return value; };
const resourceGroup = (value) => { const result = pattern(value, 1, 90, /^[A-Za-z0-9][A-Za-z0-9_.()-]*$/); if (result.endsWith(".")) fail(); return result; };
const appName = (value) => { const result = pattern(value, 2, 31, /^[a-z][a-z0-9-]*[a-z0-9]$/); if (result.includes("--")) fail(); return result; };
const token = (value) => pattern(value, 1, 32, /^[a-z][a-z0-9-]*$/);
const role = (value) => { if (value !== "WEB" && value !== "WORKER") fail(); return value; };
const status = (value) => pattern(value, 1, 32, /^[A-Z][A-Z0-9_]*$/);

function canonicalRequest(value) {
  const seen = new WeakSet();
  const input = exactRecord(value, REQUEST_KEYS, seen); const rawTarget = exactRecord(input.target, TARGET_KEYS, seen);
  const expectedSha = gitSha(input.expectedSha); const expectedImageTag = `sha-${expectedSha}`;
  if (input.targetClass !== "azure-managed" || input.expectedImageTag !== expectedImageTag) fail();
  const target = Object.freeze({ subscriptionId: uuid(rawTarget.subscriptionId), resourceGroup: resourceGroup(rawTarget.resourceGroup), webAppName: appName(rawTarget.webAppName), workerAppName: appName(rawTarget.workerAppName) });
  if (target.webAppName === target.workerAppName) fail();
  const windowStartUnixMs = unixMs(input.windowStartUnixMs); const windowEndUnixMs = unixMs(input.windowEndUnixMs);
  if (windowStartUnixMs >= windowEndUnixMs || windowEndUnixMs - windowStartUnixMs > 1_800_000) fail();
  return Object.freeze({ deploymentId: uuid(input.deploymentId), targetClass: "azure-managed", expectedSha, expectedImageTag, target, windowStartUnixMs, windowEndUnixMs });
}

function makeQuery(request, queryRole) {
  return Object.freeze({ deploymentId: request.deploymentId, targetClass: request.targetClass, role: queryRole, subscriptionId: request.target.subscriptionId, resourceGroup: request.target.resourceGroup, appName: queryRole === "WEB" ? request.target.webAppName : request.target.workerAppName, expectedSha: request.expectedSha, expectedImageTag: request.expectedImageTag, windowStartUnixMs: request.windowStartUnixMs, windowEndUnixMs: request.windowEndUnixMs });
}

function canonicalRow(value, seen) {
  const row = exactRecord(value, ROW_KEYS, seen); const rowSha = gitSha(row.gitSha);
  if (row.imageTag !== `sha-${rowSha}`) fail();
  return Object.freeze({ deploymentId: uuid(row.deploymentId), targetClass: token(row.targetClass), role: role(row.role), subscriptionId: uuid(row.subscriptionId), resourceGroup: resourceGroup(row.resourceGroup), appName: appName(row.appName), gitSha: rowSha, imageTag: row.imageTag, status: status(row.status), observedAtUnixMs: unixMs(row.observedAtUnixMs) });
}

function parseResult(value, query, request, seen) {
  const result = exactRecord(value, RESULT_KEYS, seen);
  if (result.complete !== true || result.truncated !== false || result.pageCount !== 1 || result.continuationToken !== null) fail();
  let selectedAt; let selectedCount = 0; const siblings = new Set();
  for (const valueRow of denseRows(result.rows, seen)) {
    const row = canonicalRow(valueRow, seen);
    const overlapsTarget = row.subscriptionId === request.target.subscriptionId && row.resourceGroup.toLowerCase() === request.target.resourceGroup.toLowerCase() && (row.appName === request.target.webAppName || row.appName === request.target.workerAppName);
    if (row.deploymentId !== request.deploymentId) { if (overlapsTarget) fail(); siblings.add(row.deploymentId); continue; }
    if (row.targetClass !== request.targetClass || row.role !== query.role || row.subscriptionId !== query.subscriptionId || row.resourceGroup !== query.resourceGroup || row.appName !== query.appName || row.gitSha !== query.expectedSha || row.imageTag !== query.expectedImageTag || row.status !== "READY" || row.observedAtUnixMs < query.windowStartUnixMs || row.observedAtUnixMs > query.windowEndUnixMs) fail();
    selectedCount += 1; selectedAt = row.observedAtUnixMs;
  }
  if (selectedCount !== 1) fail();
  return { selectedAt, siblings };
}

export function createManagedAzureObservationVerifier(value) {
  const dependencies = exactRecord(value, DEPENDENCY_KEYS, new WeakSet());
  if (typeof dependencies.queryResourceObservations !== "function" || isProxy(dependencies.queryResourceObservations) || typeof dependencies.clock !== "function" || isProxy(dependencies.clock)) fail();
  const { queryResourceObservations, clock } = dependencies;
  const verifyManagedAzureObservation = async (input) => {
    try {
      const request = canonicalRequest(input); const now = unixMs(clock());
      if (request.windowEndUnixMs > now || now - request.windowEndUnixMs > 300_000) fail();
      const webQuery = makeQuery(request, "WEB"); const workerQuery = makeQuery(request, "WORKER");
      const settled = await Promise.allSettled([webQuery, workerQuery].map((query) => Promise.resolve().then(() => queryResourceObservations(query))));
      if (settled.some((result) => result.status !== "fulfilled")) fail();
      const [webValue, workerValue] = settled.map((result) => result.value);
      const seen = new WeakSet(); const web = parseResult(webValue, webQuery, request, seen); const worker = parseResult(workerValue, workerQuery, request, seen);
      const siblingIds = new Set([...web.siblings, ...worker.siblings]); if (siblingIds.size > 126) fail();
      return Object.freeze({ status: "VERIFIED", targetClass: "azure-managed", deploymentId: request.deploymentId, expectedSha: request.expectedSha, expectedImageTag: request.expectedImageTag, windowStartUnixMs: request.windowStartUnixMs, windowEndUnixMs: request.windowEndUnixMs, web: Object.freeze({ ready: true, observedAtUnixMs: web.selectedAt }), worker: Object.freeze({ ready: true, observedAtUnixMs: worker.selectedAt }), ignoredSiblingCount: siblingIds.size });
    } catch { fail(); }
  };
  return Object.freeze({ verifyManagedAzureObservation });
}

async function runSyntheticCli(args) {
  if (args.length !== 8 || args[0] !== "--synthetic" || args[1] !== "--dry-run" || args[2] !== "--deployment-id" || args[3] !== SENTINEL || args[4] !== "--release-sha" || args[6] !== "--window-minutes") fail();
  const expectedSha = gitSha(args[5]); const minutes = ["5", "10", "20", "30"].includes(args[7]) ? Number(args[7]) : fail();
  const windowEndUnixMs = 1_700_000_000_000; const windowStartUnixMs = windowEndUnixMs - minutes * 60_000;
  const target = { subscriptionId: "00000000-0000-4000-8000-000000000002", resourceGroup: "rg-corgtex-synthetic", webAppName: "corgtex-synth-web", workerAppName: "corgtex-synth-worker" };
  const verifier = createManagedAzureObservationVerifier({ clock: () => windowEndUnixMs, queryResourceObservations: (query) => ({ complete: true, truncated: false, pageCount: 1, continuationToken: null, rows: [{ deploymentId: query.deploymentId, targetClass: query.targetClass, role: query.role, subscriptionId: query.subscriptionId, resourceGroup: query.resourceGroup, appName: query.appName, gitSha: query.expectedSha, imageTag: query.expectedImageTag, status: "READY", observedAtUnixMs: windowEndUnixMs }] }) });
  return verifier.verifyManagedAzureObservation({ deploymentId: SENTINEL, targetClass: "azure-managed", expectedSha, expectedImageTag: `sha-${expectedSha}`, target, windowStartUnixMs, windowEndUnixMs });
}

if (import.meta.main) runSyntheticCli(process.argv.slice(2)).then((result) => process.stdout.write(`${JSON.stringify(result)}\n`), () => { process.exitCode = 1; });
