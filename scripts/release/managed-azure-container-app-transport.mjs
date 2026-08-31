import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const API_VERSION = "2025-01-01";
const MANAGEMENT_ORIGIN = "https://management.azure.com";
const MAX_JSON_BYTES = 256 * 1024;
const REQUEST_TIMEOUT_MS = 20_000;
const OPERATION_TIMEOUT_MS = 180_000;
const PATCH_CONTENT_TYPE = "application/json";
const RELEASE_ENV = Object.freeze([
  "CORGTEX_RELEASE_GIT_SHA",
  "CORGTEX_RELEASE_IMAGE_TAG",
  "CORGTEX_RELEASE_VERSION",
]);

export class ManagedAzureContainerAppError extends Error {
  constructor(code, ambiguous = false) {
    super(code);
    this.name = "ManagedAzureContainerAppError";
    this.code = code;
    this.ambiguous = ambiguous;
  }
}

function fail(code, ambiguous = false) {
  throw new ManagedAzureContainerAppError(code, ambiguous);
}

function safeJsonClone(value) {
  let text;
  try { text = JSON.stringify(value); } catch { fail("AZURE_TEMPLATE_INVALID"); }
  if (!text || Buffer.byteLength(text, "utf8") > MAX_JSON_BYTES) fail("AZURE_TEMPLATE_INVALID");
  let clone;
  try { clone = JSON.parse(text); } catch { fail("AZURE_TEMPLATE_INVALID"); }
  const stack = [{ value: clone, depth: 0 }];
  let count = 0;
  while (stack.length) {
    const item = stack.pop();
    if (item.value === null || typeof item.value === "boolean") continue;
    if (typeof item.value === "number") {
      if (!Number.isFinite(item.value)) fail("AZURE_TEMPLATE_INVALID");
      continue;
    }
    if (typeof item.value === "string") {
      if (item.value.length > 32_768 || /\u0000|[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(^|[^\uD800-\uDBFF])[\uDC00-\uDFFF]/.test(item.value)) fail("AZURE_TEMPLATE_INVALID");
      continue;
    }
    if (typeof item.value !== "object" || item.depth > 32 || count > 4_096) fail("AZURE_TEMPLATE_INVALID");
    count += 1;
    if (Array.isArray(item.value)) {
      if (item.value.length > 256) fail("AZURE_TEMPLATE_INVALID");
      item.value.forEach((child) => stack.push({ value: child, depth: item.depth + 1 }));
      continue;
    }
    const keys = Object.keys(item.value);
    if (keys.length > 256 || keys.some((key) => key.length > 256 || ["__proto__", "prototype", "constructor"].includes(key))) fail("AZURE_TEMPLATE_INVALID");
    keys.forEach((key) => stack.push({ value: item.value[key], depth: item.depth + 1 }));
  }
  return clone;
}

function canonicalJson(value) {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(",")}}`;
}

export function managedAzureTemplateDigest(template) {
  return `sha256:${createHash("sha256").update(canonicalJson(safeJsonClone(template))).digest("hex")}`;
}

function targetValue(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) fail("AZURE_TARGET_INVALID");
  const keys = ["subscriptionId", "resourceGroup", "acrName", "acrServer", "webAppName", "workerAppName"];
  if (Object.keys(value).length !== keys.length || keys.some((key) => !Object.hasOwn(value, key))) fail("AZURE_TARGET_INVALID");
  if (!/^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/.test(value.subscriptionId)
    || !/^[A-Za-z0-9][A-Za-z0-9_.()-]{0,89}$/.test(value.resourceGroup) || value.resourceGroup.endsWith(".")
    || !/^[a-z0-9]{5,50}$/.test(value.acrName) || value.acrServer !== `${value.acrName}.azurecr.io`
    || !/^[a-z][a-z0-9-]{0,29}[a-z0-9]$/.test(value.webAppName) || value.webAppName.includes("--")
    || !/^[a-z][a-z0-9-]{0,29}[a-z0-9]$/.test(value.workerAppName) || value.workerAppName.includes("--")
    || value.webAppName === value.workerAppName) fail("AZURE_TARGET_INVALID");
  return Object.freeze({ ...value });
}

function releaseValue(value) {
  if (!value || typeof value !== "object" || Array.isArray(value) || Object.keys(value).length !== 3) fail("AZURE_RELEASE_IDENTITY_INVALID");
  if (!/^[0-9a-f]{40}$/.test(value.gitSha) || value.imageTag !== `sha-${value.gitSha}`
    || typeof value.version !== "string" || !/^[A-Za-z0-9][A-Za-z0-9._+-]{0,127}$/.test(value.version)) fail("AZURE_RELEASE_IDENTITY_INVALID");
  return Object.freeze({ gitSha: value.gitSha, imageTag: value.imageTag, version: value.version });
}

function expectedImage(target, role, digest) {
  if ((role !== "web" && role !== "worker") || !/^sha256:[0-9a-f]{64}$/.test(digest)) fail("AZURE_RELEASE_IDENTITY_INVALID");
  return `${target.acrServer}/corgtex/${role}@${digest}`;
}

function releaseEnvironment(container) {
  if (!Array.isArray(container.env) || container.env.length > 256) fail("AZURE_TEMPLATE_INVALID");
  const entries = new Map();
  for (const entry of container.env) {
    if (!entry || typeof entry !== "object" || Array.isArray(entry) || typeof entry.name !== "string") fail("AZURE_TEMPLATE_INVALID");
    if (entries.has(entry.name)) fail("AZURE_TEMPLATE_INVALID");
    entries.set(entry.name, entry);
  }
  return entries;
}

function assertReleaseEnvironment(container, release) {
  const entries = releaseEnvironment(container);
  const expected = {
    CORGTEX_RELEASE_GIT_SHA: release.gitSha,
    CORGTEX_RELEASE_IMAGE_TAG: release.imageTag,
    CORGTEX_RELEASE_VERSION: release.version,
  };
  for (const name of RELEASE_ENV) {
    const entry = entries.get(name);
    if (!entry || Object.keys(entry).some((key) => !["name", "value"].includes(key)) || entry.value !== expected[name]) fail("AZURE_RELEASE_IDENTITY_MISMATCH");
  }
}

function appNameFor(target, role) {
  return role === "web" ? target.webAppName : target.workerAppName;
}

export function canonicalizeManagedAzureContainerAppState(raw, input) {
  const target = targetValue(input.target);
  const release = releaseValue(input.release);
  const role = input.role;
  const appName = appNameFor(target, role);
  const value = safeJsonClone(raw);
  const properties = value?.properties;
  const template = properties?.template;
  if (typeof value?.location !== "string" || !/^[A-Za-z0-9 ._-]{1,128}$/.test(value.location)
    || !properties || !template || properties.configuration?.activeRevisionsMode !== "Single"
    || properties.provisioningState !== "Succeeded"
    || typeof properties.latestRevisionName !== "string"
    || properties.latestRevisionName !== properties.latestReadyRevisionName
    || !Array.isArray(template.containers) || template.containers.length !== 1
    || typeof template.revisionSuffix !== "string"
    || properties.latestRevisionName !== `${appName}--${template.revisionSuffix}`) fail("AZURE_BASELINE_NOT_READY");
  const container = template.containers[0];
  let imageDigest = input.imageDigest;
  if (imageDigest === undefined) {
    const match = new RegExp(`^${target.acrServer.replaceAll(".", "\\.")}\\/corgtex\\/${role}@(sha256:[0-9a-f]{64})$`).exec(container?.image);
    if (!match) fail("AZURE_IMAGE_MISMATCH");
    imageDigest = match[1];
  }
  const expected = expectedImage(target, role, imageDigest);
  if (!container || typeof container.name !== "string" || !/^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(container.name)
    || container.image !== expected) fail("AZURE_IMAGE_MISMATCH");
  assertReleaseEnvironment(container, release);
  return Object.freeze({
    appName,
    location: value.location,
    role,
    revisionName: properties.latestRevisionName,
    revisionSuffix: template.revisionSuffix,
    containerName: container.name,
    image: container.image,
    imageDigest,
    template,
    templateDigest: managedAzureTemplateDigest(template),
  });
}

export function managedAzureRevisionSuffix({ leaseId, fence, role, phase }) {
  if (!/^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/.test(leaseId)
    || !Number.isSafeInteger(fence) || fence < 1 || (role !== "web" && role !== "worker")
    || (phase !== "forward" && phase !== "rollback")) fail("AZURE_REVISION_SUFFIX_INVALID");
  const suffix = `mr-${fence.toString(36)}-${leaseId.replaceAll("-", "").slice(0, 16)}-${role[0]}-${phase[0]}`;
  if (suffix.length > 64) fail("AZURE_REVISION_SUFFIX_INVALID");
  return suffix;
}

export function buildManagedAzureReleaseTemplate({ baseline, role, image, release, revisionSuffix }) {
  const canonicalRelease = releaseValue(release);
  if (!baseline?.template || baseline.role !== role || typeof image !== "string" || !/^[a-z0-9]+\.azurecr\.io\/corgtex\/(web|worker)@sha256:[0-9a-f]{64}$/.test(image)
    || !/^[a-z0-9](?:[a-z0-9-]{0,62}[a-z0-9])?$/.test(revisionSuffix)) fail("AZURE_TEMPLATE_INVALID");
  const template = safeJsonClone(baseline.template);
  template.revisionSuffix = revisionSuffix;
  const container = template.containers[0];
  container.image = image;
  const entries = releaseEnvironment(container);
  const expected = {
    CORGTEX_RELEASE_GIT_SHA: canonicalRelease.gitSha,
    CORGTEX_RELEASE_IMAGE_TAG: canonicalRelease.imageTag,
    CORGTEX_RELEASE_VERSION: canonicalRelease.version,
  };
  for (const name of RELEASE_ENV) {
    const entry = entries.get(name);
    if (!entry || Object.keys(entry).some((key) => !["name", "value"].includes(key))) fail("AZURE_TEMPLATE_INVALID");
    entry.value = expected[name];
  }
  return template;
}

export function assertManagedAzureTemplateDelta(baseline, candidate, expected) {
  const rebuilt = buildManagedAzureReleaseTemplate({ baseline, ...expected });
  if (managedAzureTemplateDigest(rebuilt) !== managedAzureTemplateDigest(candidate)) fail("AZURE_TEMPLATE_DRIFT");
  return true;
}

function resourceUrl(target, appName) {
  return `${MANAGEMENT_ORIGIN}/subscriptions/${target.subscriptionId}/resourceGroups/${encodeURIComponent(target.resourceGroup)}/providers/Microsoft.App/containerApps/${appName}?api-version=${API_VERSION}`;
}

function validOperationSearch(url) {
  const entries = [...url.searchParams.entries()];
  if (entries.length !== 1 && entries.length !== 2) return false;
  const seen = new Set();
  for (const [key, value] of entries) {
    if (seen.has(key)) return false;
    seen.add(key);
    if (key === "api-version") {
      if (!/^20[0-9]{2}-[0-9]{2}-[0-9]{2}(?:-preview)?$/.test(value)) return false;
    } else if (key !== "monitor" || value !== "true") return false;
  }
  return seen.has("api-version");
}

function validOperationPath(url, target) {
  const parts = url.pathname.split("/");
  const segment = /^[A-Za-z0-9][A-Za-z0-9._~-]{0,127}$/;
  if (parts[0] !== "" || parts[1] !== "subscriptions" || parts[2] !== target.subscriptionId) return false;
  let providerIndex = 3;
  if (parts[3] === "resourceGroups") {
    try {
      if (decodeURIComponent(parts[4]).toLowerCase() !== target.resourceGroup.toLowerCase()) return false;
    } catch {
      return false;
    }
    providerIndex = 5;
  }
  if (parts[providerIndex] !== "providers" || parts[providerIndex + 1] !== "Microsoft.App") return false;
  if (parts[providerIndex + 2] === "containerApps" && parts.length === providerIndex + 4)
    return [target.webAppName, target.workerAppName].includes(parts[providerIndex + 3]);
  if (parts[providerIndex + 2] !== "locations" || !segment.test(parts[providerIndex + 3])) return false;
  if (parts[providerIndex + 4] === "operationStatuses" && parts.length === providerIndex + 6)
    return segment.test(parts[providerIndex + 5]);
  if (parts[providerIndex + 4] === "containerappOperationStatuses" && parts.length === providerIndex + 6)
    return segment.test(parts[providerIndex + 5]);
  if (parts[providerIndex + 4] === "containerappOperationResults" && parts.length === providerIndex + 6)
    return segment.test(parts[providerIndex + 5]);
  if (parts[providerIndex + 4] === "operationResults") {
    if (parts.length === providerIndex + 6) return segment.test(parts[providerIndex + 5]);
    if (parts.length === providerIndex + 7 && parts[providerIndex + 5] === "operationStatuses")
      return segment.test(parts[providerIndex + 6]);
  }
  return false;
}

function operationUrl(raw, target) {
  try {
    if (typeof raw !== "string" || raw !== raw.trim() || raw.length === 0 || raw.length > 8_192) fail("AZURE_OPERATION_LOCATION_INVALID", true);
    const url = new URL(raw);
    if (url.href !== raw || url.origin !== MANAGEMENT_ORIGIN || url.username || url.password || url.port || url.hash
      || !validOperationSearch(url) || !validOperationPath(url, target)) fail("AZURE_OPERATION_LOCATION_INVALID", true);
    return url.href;
  } catch (error) {
    if (error instanceof ManagedAzureContainerAppError) throw error;
    fail("AZURE_OPERATION_LOCATION_INVALID", true);
  }
}

async function defaultAccessToken() {
  try {
    const { stdout, stderr } = await execFileAsync("az", ["account", "get-access-token", "--resource", MANAGEMENT_ORIGIN, "--query", "accessToken", "--output", "tsv"], {
      timeout: REQUEST_TIMEOUT_MS,
      maxBuffer: 16_384,
      encoding: "utf8",
    });
    if (stderr || !/^[\x21-\x7e]{20,8192}\n?$/.test(stdout)) fail("AZURE_ACCESS_TOKEN_UNAVAILABLE");
    return stdout.trim();
  } catch (error) {
    if (error instanceof ManagedAzureContainerAppError) throw error;
    fail("AZURE_ACCESS_TOKEN_UNAVAILABLE");
  }
}

async function responseBody(response) {
  const text = await response.text();
  if (Buffer.byteLength(text, "utf8") > MAX_JSON_BYTES) fail("AZURE_RESPONSE_INVALID", true);
  if (!text) return null;
  try { return safeJsonClone(JSON.parse(text)); } catch (error) {
    if (error instanceof ManagedAzureContainerAppError) throw error;
    fail("AZURE_RESPONSE_INVALID", true);
  }
}

function providerErrorCode(body) {
  const details = Array.isArray(body?.error?.details) ? body.error.details : [];
  const codes = [...details.map((detail) => detail?.code), body?.error?.code];
  return codes.find((code) => typeof code === "string" && /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(code));
}

function patchResult(terminal, succeeded, code, body = null) {
  const providerCode = providerErrorCode(body);
  return Object.freeze({ terminal, succeeded, code, ...(providerCode ? { providerCode } : {}) });
}

export function createManagedAzureContainerAppTransport(dependencies = {}) {
  const fetchImpl = dependencies.fetchImpl ?? fetch;
  const getAccessToken = dependencies.getAccessToken ?? defaultAccessToken;
  const sleep = dependencies.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
  const clock = dependencies.clock ?? Date.now;

  async function request(url, init, ambiguous) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
    try {
      const token = await getAccessToken();
      return await fetchImpl(url, {
        ...init,
        headers: { authorization: `Bearer ${token}`, ...(init.headers ?? {}) },
        redirect: "error",
        signal: controller.signal,
      });
    } catch {
      fail(ambiguous ? "AZURE_REQUEST_AMBIGUOUS" : "AZURE_READ_FAILED", ambiguous);
    } finally {
      clearTimeout(timer);
    }
  }

  async function readApp(input) {
    const target = targetValue(input.target);
    const appName = appNameFor(target, input.role);
    const url = resourceUrl(target, appName);
    const response = await request(url, { method: "GET" }, input.ambiguous === true);
    if (response.status !== 200) fail(input.ambiguous === true ? "AZURE_READBACK_AMBIGUOUS" : "AZURE_READ_FAILED", input.ambiguous === true);
    return canonicalizeManagedAzureContainerAppState(await responseBody(response), input);
  }

  async function patchTemplate(input) {
    const target = targetValue(input.target);
    const appName = appNameFor(target, input.role);
    const url = resourceUrl(target, appName);
    const template = safeJsonClone(input.template);
    if (typeof input.location !== "string" || !/^[A-Za-z0-9 ._-]{1,128}$/.test(input.location)) fail("AZURE_TARGET_INVALID");
    let response;
    try {
      response = await request(url, { method: "PATCH", headers: { "content-type": PATCH_CONTENT_TYPE }, body: JSON.stringify({ location: input.location, properties: { template } }) }, true);
    } catch {
      return Object.freeze({ terminal: false, succeeded: false, code: "AZURE_PATCH_AMBIGUOUS" });
    }
    if (response.status === 200) {
      await responseBody(response);
      return patchResult(true, true, "AZURE_PATCH_SUCCEEDED");
    }
    if (response.status !== 202) {
      const body = await responseBody(response).catch(() => null);
      return patchResult(response.status >= 400 && response.status < 500, false,
        response.status >= 400 && response.status < 500 ? "AZURE_PATCH_REJECTED" : "AZURE_PATCH_AMBIGUOUS", body);
    }
    try { await responseBody(response); } catch {
      return Object.freeze({ terminal: false, succeeded: false, code: "AZURE_OPERATION_AMBIGUOUS" });
    }
    let location;
    try { location = operationUrl(response.headers.get("azure-asyncoperation") ?? response.headers.get("location"), target); } catch {
      return Object.freeze({ terminal: false, succeeded: false, code: "AZURE_OPERATION_LOCATION_INVALID" });
    }
    let retryAfter = response.headers.get("retry-after");
    const startedAt = clock();
    for (let poll = 0; poll < 60 && clock() - startedAt < OPERATION_TIMEOUT_MS; poll += 1) {
      const delay = retryAfter && /^(?:0|[1-9][0-9]?)$/.test(retryAfter) ? Math.min(Number(retryAfter) * 1_000, 30_000) : 1_000;
      await sleep(delay);
      if (input.onProgress !== undefined) {
        if (typeof input.onProgress !== "function") fail("AZURE_PROGRESS_INVALID", true);
        await input.onProgress();
      }
      let polled;
      try { polled = await request(location, { method: "GET" }, true); } catch {
        return Object.freeze({ terminal: false, succeeded: false, code: "AZURE_OPERATION_AMBIGUOUS" });
      }
      retryAfter = polled.headers.get("retry-after");
      let body;
      try { body = await responseBody(polled); } catch {
        return Object.freeze({ terminal: false, succeeded: false, code: "AZURE_OPERATION_AMBIGUOUS" });
      }
      if (polled.status === 202) continue;
      if (polled.status === 204) return patchResult(true, true, "AZURE_PATCH_SUCCEEDED");
      if (polled.status !== 200) return patchResult(false, false, "AZURE_OPERATION_AMBIGUOUS", body);
      const status = body?.status ?? body?.properties?.provisioningState;
      if (status === "Succeeded") return patchResult(true, true, "AZURE_PATCH_SUCCEEDED");
      if (["Failed", "Canceled", "Cancelled"].includes(status)) return patchResult(true, false, "AZURE_PATCH_FAILED", body);
      if (status === undefined) return patchResult(true, true, "AZURE_PATCH_SUCCEEDED");
      if (!["InProgress", "Running", "Accepted"].includes(status)) return patchResult(false, false, "AZURE_OPERATION_AMBIGUOUS", body);
    }
    return Object.freeze({ terminal: false, succeeded: false, code: "AZURE_OPERATION_TIMEOUT" });
  }

  async function waitForState(input) {
    const startedAt = clock();
    let lastCode = "AZURE_READBACK_TIMEOUT";
    while (clock() - startedAt < OPERATION_TIMEOUT_MS) {
      if (input.onProgress !== undefined) {
        if (typeof input.onProgress !== "function") fail("AZURE_PROGRESS_INVALID", true);
        await input.onProgress();
      }
      try {
        const state = await readApp({ ...input, ambiguous: true });
        if (state.templateDigest === managedAzureTemplateDigest(input.expectedTemplate)
          && state.revisionName === `${state.appName}--${input.expectedTemplate.revisionSuffix}`) return state;
        lastCode = "AZURE_READBACK_MISMATCH";
      } catch (error) {
        lastCode = error instanceof ManagedAzureContainerAppError ? error.code : "AZURE_READBACK_AMBIGUOUS";
      }
      await sleep(1_000);
    }
    fail(lastCode, true);
  }

  return Object.freeze({ readApp, patchTemplate, waitForState });
}
