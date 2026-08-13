import { Buffer } from "node:buffer";
import { types as nodeTypes } from "node:util";

const FAILURE = "MANAGED_AZURE_SOURCE_MANIFEST_RESOLUTION_FAILED";
const MAX_STDOUT_BYTES = 16_384;
const OPTIONS = Object.freeze({
  stdio: Object.freeze(["ignore", "pipe", "pipe"]),
  shell: false,
  detached: false,
  timeoutMs: 10_000,
  maxStdoutBytes: MAX_STDOUT_BYTES,
  maxStderrBytes: 4_096,
});
const ROLES = Object.freeze(["web", "worker"]);

function fail() { throw new Error(FAILURE); }
function hasEnumerable(prototype) {
  return Reflect.ownKeys(Object.getOwnPropertyDescriptors(prototype))
    .some((key) => Object.getOwnPropertyDescriptor(prototype, key)?.enumerable);
}
function exactRecord(value, keys) {
  try {
    if (nodeTypes.isProxy(value) || value === null || typeof value !== "object" || Array.isArray(value)) fail();
    const prototype = Object.getPrototypeOf(value);
    if ((prototype !== Object.prototype && prototype !== null) || hasEnumerable(Object.prototype)) fail();
    const descriptors = Object.getOwnPropertyDescriptors(value); const names = Reflect.ownKeys(descriptors);
    if (names.length !== keys.length || names.some((key) => typeof key !== "string" || !keys.includes(key))
      || keys.some((key) => !descriptors[key]?.enumerable || !Object.hasOwn(descriptors[key], "value"))) fail();
    return Object.fromEntries(keys.map((key) => [key, descriptors[key].value]));
  } catch { fail(); }
}
function wellFormed(value) {
  for (let index = 0; index < value.length; index += 1) {
    const unit = value.charCodeAt(index);
    if (unit >= 0xd800 && unit <= 0xdbff) {
      const next = value.charCodeAt(index + 1);
      if (next < 0xdc00 || next > 0xdfff) return false;
      index += 1;
    } else if (unit >= 0xdc00 && unit <= 0xdfff) return false;
  }
  return true;
}
function countTopLevelDigestKeys(source) {
  let depth = 0; let quote = -1; let escaped = false; let count = 0;
  for (let index = 0; index < source.length; index += 1) {
    const character = source[index];
    if (quote >= 0) {
      if (escaped) escaped = false;
      else if (character === "\\") escaped = true;
      else if (character === "\"") {
        let cursor = index + 1;
        while (/\s/.test(source[cursor] ?? "")) cursor += 1;
        if (depth === 1 && source[cursor] === ":" && JSON.parse(source.slice(quote, index + 1)) === "digest") count += 1;
        quote = -1;
      }
    } else if (character === "\"") quote = index;
    else if (character === "{" || character === "[") depth += 1;
    else if (character === "}" || character === "]") depth -= 1;
  }
  return count;
}
function validateJsonValues(root) {
  const stack = [root]; let count = 0;
  while (stack.length > 0) {
    const value = stack.pop();
    if (typeof value === "string") {
      if (!wellFormed(value) || /[\u0000-\u001f\u007f-\u009f]/.test(value)) fail();
      continue;
    }
    if (value === null || typeof value === "boolean" || (typeof value === "number" && Number.isFinite(value))) continue;
    if (typeof value !== "object" || count >= MAX_STDOUT_BYTES) fail();
    count += 1;
    const array = Array.isArray(value); const prototype = Object.getPrototypeOf(value);
    if ((array ? prototype !== Array.prototype : prototype !== Object.prototype)
      || hasEnumerable(Object.prototype) || hasEnumerable(Array.prototype)) fail();
    const descriptors = Object.getOwnPropertyDescriptors(value);
    for (const key of Reflect.ownKeys(descriptors)) {
      if (array && key === "length") continue;
      const descriptor = descriptors[key];
      if (typeof key !== "string" || !descriptor.enumerable || !Object.hasOwn(descriptor, "value")) fail();
      stack.push(descriptor.value);
    }
  }
}
function manifestRaw(stdout) {
  if (typeof stdout !== "string" || !wellFormed(stdout) || Buffer.byteLength(stdout, "utf8") > MAX_STDOUT_BYTES) fail();
  const source = stdout.endsWith("\n") ? stdout.slice(0, -1) : stdout;
  if (source.length === 0 || source !== source.trim() || hasEnumerable(Object.prototype) || hasEnumerable(Array.prototype)) fail();
  let parsed;
  try { parsed = JSON.parse(source); } catch { fail(); }
  validateJsonValues(parsed);
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)
    || Object.getPrototypeOf(parsed) !== Object.prototype || countTopLevelDigestKeys(source) !== 1) fail();
  const descriptor = Object.getOwnPropertyDescriptor(parsed, "digest");
  if (!descriptor?.enumerable || !Object.hasOwn(descriptor, "value")
    || typeof descriptor.value !== "string" || !/^sha256:[0-9a-f]{64}$/.test(descriptor.value)) fail();
  return source;
}
async function inspect(spawn, sourceTag) {
  const args = ["buildx", "imagetools", "inspect", "--format", "{{json .Manifest}}", sourceTag];
  let handle;
  try { handle = exactRecord(spawn("docker", args, OPTIONS), ["completion", "abort"]); } catch { fail(); }
  if (nodeTypes.isProxy(handle.completion) || !nodeTypes.isPromise(handle.completion)
    || nodeTypes.isProxy(handle.abort) || typeof handle.abort !== "function") fail();
  let raw;
  try { raw = await handle.completion; } catch { fail(); }
  const result = exactRecord(raw, ["code", "signal", "timedOut", "stdout", "stderr", "stdoutOverflow", "stderrOverflow"]);
  if (typeof result.timedOut !== "boolean" || typeof result.stdoutOverflow !== "boolean"
    || typeof result.stderrOverflow !== "boolean") fail();
  if (result.timedOut) {
    try { const aborted = handle.abort(); if (!nodeTypes.isPromise(aborted)) fail(); await aborted; await handle.completion; } catch { fail(); }
    fail();
  }
  if (result.code !== 0 || result.signal !== null || result.stdoutOverflow || result.stderrOverflow
    || typeof result.stderr !== "string" || Buffer.byteLength(result.stderr, "utf8") > OPTIONS.maxStderrBytes
    || result.stderr !== "") fail();
  return manifestRaw(result.stdout);
}
function deepFreeze(value) {
  if (value && typeof value === "object") { for (const child of Object.values(value)) deepFreeze(child); Object.freeze(value); }
  return value;
}

export function createManagedAzureSourceManifestResolver(value) {
  const dependencies = exactRecord(value, ["spawn"]);
  if (nodeTypes.isProxy(dependencies.spawn) || typeof dependencies.spawn !== "function") fail();
  const resolveManagedAzureSourceManifests = async (input) => {
    try {
      const raw = exactRecord(input, ["gitSha"]);
      if (typeof raw.gitSha !== "string" || !/^[0-9a-f]{40}$/.test(raw.gitSha)) fail();
      const manifests = {};
      for (const role of ROLES) {
        const sourceTag = `ghcr.io/corgtexdotcom/corgtex/${role}:sha-${raw.gitSha}`;
        manifests[role] = { sourceTag, raw: await inspect(dependencies.spawn, sourceTag) };
      }
      return deepFreeze({ schemaVersion: 1, gitSha: raw.gitSha, manifests: { web: manifests.web, worker: manifests.worker } });
    } catch { fail(); }
  };
  return Object.freeze({ resolveManagedAzureSourceManifests });
}
