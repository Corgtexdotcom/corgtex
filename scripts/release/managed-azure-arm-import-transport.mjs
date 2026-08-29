import { types as nodeTypes } from "node:util";
import { canonicalizeManagedAzureImportRequestValueV1 } from "./azure-release-managed-target.mjs";
const REQUEST_TIMEOUT_MS = 15_000;
const DEADLINE_MS = 120_000;
const MAX_POLLS = 12;
const DEFAULT_DELAY_MS = 1_000;
const MAX_RETRY_AFTER_MS = 30_000;
const MAX_REJECTION_BODY_CHARS = 8_192;
const ABORTED = Object.freeze({ kind: "ABORTED" });
const FAILED = Object.freeze({ kind: "FAILED" });
const TIMED_OUT = Object.freeze({ kind: "TIMED_OUT" });
function invalid() { throw new Error("MANAGED_AZURE_ARM_IMPORT_TRANSPORT_INPUT_INVALID"); }
function exactRecord(value, keys) {
  try {
    if (nodeTypes.isProxy(value) || value === null || typeof value !== "object" || Array.isArray(value)) invalid();
    const prototype = Object.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null) invalid();
    const names = Reflect.ownKeys(value); const descriptors = Object.getOwnPropertyDescriptors(value);
    if (names.length !== keys.length || names.some((key) => typeof key !== "string" || !keys.includes(key)
      || !descriptors[key].enumerable || !Object.hasOwn(descriptors[key], "value"))) invalid();
    return Object.fromEntries(keys.map((key) => [key, descriptors[key].value]));
  } catch { invalid(); }
}
function boundedText(value, maximum) {
  if (typeof value !== "string" || value.length === 0 || value.length > maximum || value.trim().length === 0) invalid();
  return value;
}
function bearer(value) {
  const token = boundedText(value, 8_192);
  if (!/^[\x21-\x7e]+$/.test(token)) invalid();
  return token;
}
function credentials(value) {
  const raw = exactRecord(value, ["username", "password"]);
  return { username: boundedText(raw.username, 1_024), password: boundedText(raw.password, 8_192) };
}
function nullRecord(entries) { return Object.assign(Object.create(null), entries); }
function postBody(request, sourceCredentials) {
  const tags = [request.binding.destinationTag]; Object.setPrototypeOf(tags, null);
  return JSON.stringify(nullRecord({
    source: nullRecord({ registryUri: "ghcr.io", sourceImage: request.binding.sourceDigestRef.slice(8), credentials: nullRecord(sourceCredentials) }),
    targetTags: tags,
    mode: "NoForce",
  }));
}
function header(response, name, maximum) {
  const value = response.headers.get(name);
  if (value !== null && (typeof value !== "string" || value.length === 0 || value.length > maximum)) throw FAILED;
  return value;
}
function responseDetails(response, expectedUrl) {
  try {
    if (nodeTypes.isProxy(response) || response === null || typeof response !== "object"
      || response.redirected !== false || response.url !== expectedUrl || !Number.isInteger(response.status)
      || response.status < 100 || response.status > 599 || nodeTypes.isProxy(response.headers)
      || response.headers === null || typeof response.headers?.get !== "function") return null;
    return { status: response.status, location: header(response, "location", 8_192),
      retryAfter: header(response, "retry-after", 32), asyncUrl: header(response, "azure-asyncoperation", 8_192) };
  } catch { return null; }
}
function pollSearch(url) {
  if (url.search === "?api-version=2025-11-01") return true;
  const entries = [...url.searchParams.entries()];
  if (entries.length !== 5) return false;
  const seen = new Set();
  for (const [key, value] of entries) {
    if (seen.has(key)) return false;
    seen.add(key);
    if (key === "api-version") {
      if (value !== "2025-11-01") return false;
    } else if (!["t", "c", "s", "h"].includes(key) || !/^[A-Za-z0-9._~-]{1,8192}$/.test(value)) return false;
  }
  return ["api-version", "t", "c", "s", "h"].every((key) => seen.has(key));
}
function pollLocation(raw, request) {
  try {
    if (typeof raw !== "string" || raw !== raw.trim() || raw.length === 0 || raw.length > 8_192) return null;
    const url = new URL(raw);
    if (url.href !== raw || url.origin !== "https://management.azure.com" || url.username || url.password || url.port
      || url.hash || !pollSearch(url)) return null;
    const parts = url.pathname.split("/");
    const segment = /^[A-Za-z0-9][A-Za-z0-9._~-]{0,127}$/;
    if (parts[0] !== "" || parts[1] !== "subscriptions" || parts[2] !== request.target.subscriptionId) return null;
    let providerIndex = 3;
    if (parts[3] === "resourceGroups") {
      if (parts[4]?.toLowerCase() !== request.target.acrResourceGroup.toLowerCase()) return null;
      providerIndex = 5;
    }
    if (parts[providerIndex] !== "providers" || parts[providerIndex + 1] !== "Microsoft.ContainerRegistry"
      || parts[providerIndex + 2] !== "locations" || !segment.test(parts[providerIndex + 3])) return null;
    if (parts[providerIndex + 4] === "operationResults") {
      if (parts.length === providerIndex + 6) return segment.test(parts[providerIndex + 5]) ? raw : null;
      if (parts.length === providerIndex + 7 && parts[providerIndex + 5] === "operationStatuses")
        return segment.test(parts[providerIndex + 6]) ? raw : null;
    }
    if (parts[providerIndex + 4] === "operationStatuses" && parts.length === providerIndex + 6)
      return segment.test(parts[providerIndex + 5]) ? raw : null;
    return null;
  } catch { return null; }
}
function retryDelay(raw) {
  if (raw === null) return DEFAULT_DELAY_MS;
  if (!/^(0|[1-9][0-9]*)$/.test(raw)) return null;
  const milliseconds = Number(raw) * 1_000;
  return Number.isSafeInteger(milliseconds) && milliseconds <= MAX_RETRY_AFTER_MS ? milliseconds : null;
}
function pair(outcome, reason, detail = {}) { return Object.freeze([outcome, reason, detail]); }
function initialMapping(status) {
  if (status >= 400 && status <= 499 && status !== 408 && status !== 429) return pair("CONFIRMED_POST_REJECTION", "POST_REJECTED");
  if (status === 408 || status === 429 || status >= 500) return pair("UNVERIFIED", "POST_TRANSPORT_AMBIGUITY");
  return pair("UNVERIFIED", "PROTOCOL_LOCATION_VIOLATION");
}
function pollMapping(status) {
  if (status >= 400 && status <= 499 && status !== 408 && status !== 429) return pair("UNVERIFIED", "POLL_REJECTION");
  if (status === 408 || status === 429 || status >= 500) return pair("UNVERIFIED", "POLL_TRANSPORT_AMBIGUITY");
  return pair("UNVERIFIED", "PROTOCOL_LOCATION_VIOLATION");
}
function providerErrorCode(body) {
  const details = Array.isArray(body?.error?.details) ? body.error.details : [];
  const codes = [...details.map((detail) => detail?.code), body?.error?.code];
  return codes.find((code) => typeof code === "string" && /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(code));
}
async function boundedResponseText(response) {
  if (response.body && typeof response.body.getReader === "function") {
    let reader;
    try { reader = response.body.getReader(); } catch { return null; }
    const decoder = new TextDecoder(); let text = "";
    try {
      for (;;) {
        const chunk = await reader.read();
        if (chunk === null || typeof chunk !== "object") return null;
        if (chunk.done === true) break;
        if (!(chunk.value instanceof Uint8Array)) return null;
        text += decoder.decode(chunk.value, { stream: true });
        if (text.length > MAX_REJECTION_BODY_CHARS) { try { await reader.cancel(); } catch {} return null; }
      }
      text += decoder.decode();
      return text.length > MAX_REJECTION_BODY_CHARS ? null : text;
    } catch { return null; }
  }
  if (typeof response.text !== "function") return null;
  try {
    const text = await response.text();
    return typeof text === "string" && text.length <= MAX_REJECTION_BODY_CHARS ? text : null;
  } catch { return null; }
}
async function rejectionDetail(response) {
  const detail = { providerStatus: response.status };
  const text = await boundedResponseText(response);
  if (typeof text !== "string" || text.trim().length === 0) return detail;
  let parsed;
  try { parsed = JSON.parse(text); } catch { return detail; }
  const providerCode = providerErrorCode(parsed);
  return providerCode ? { ...detail, providerCode } : detail;
}
async function asyncOperationDetail(response) {
  const text = await boundedResponseText(response);
  if (typeof text !== "string" || text.trim().length === 0) return { kind: "INVALID" };
  let parsed;
  try { parsed = JSON.parse(text); } catch { return { kind: "INVALID" }; }
  if (parsed?.status === "Succeeded") return { kind: "SUCCEEDED" };
  if (parsed?.status === "Failed" || parsed?.status === "Canceled") {
    const providerCode = providerErrorCode(parsed);
    return providerCode ? { kind: "FAILED", providerCode } : { kind: "FAILED" };
  }
  return typeof parsed?.status === "string" && /^[A-Za-z][A-Za-z0-9 ._-]{0,127}$/.test(parsed.status)
    ? { kind: "PENDING" } : { kind: "INVALID" };
}
export function createManagedAzureArmImportTransport(dependencies) {
  const raw = exactRecord(dependencies, ["fetchImpl", "getAzureAccessToken", "getSourceCredentials", "clock", "sleep"]);
  if (Object.values(raw).some((value) => typeof value !== "function")) invalid();
  const { fetchImpl, getAzureAccessToken, getSourceCredentials, clock, sleep } = raw;
  function startManagedAzureImport(value) {
    let request;
    try { request = canonicalizeManagedAzureImportRequestValueV1(value); } catch { invalid(); }
    const controller = new AbortController(); let resolveAbort; let aborted = false; let polling = false; let terminal = null; let lastTime = -1;
    const abortGate = new Promise((resolve) => { resolveAbort = () => resolve(ABORTED); });
    const now = () => { const current = clock();
      if (!Number.isSafeInteger(current) || current < 0 || current < lastTime) throw FAILED;
      lastTime = current; return current; };
    const timed = async (task, milliseconds) => {
      const timer = new AbortController(); const timeout = Promise.resolve().then(() => sleep(milliseconds, timer.signal)).then(() => TIMED_OUT, () => FAILED);
      const settled = await Promise.race([task, timeout, abortGate]); timer.abort(); await timeout; return aborted ? ABORTED : settled;
    };
    const invoke = async (provider, validator, milliseconds = REQUEST_TIMEOUT_MS) => {
      const settled = await timed(Promise.resolve().then(provider).then((result) => ({ result }), () => FAILED), milliseconds);
      if (settled === ABORTED || settled === FAILED || settled === TIMED_OUT) return settled; try { return { result: validator(settled.result) }; } catch { return FAILED; }
    };
    const wait = async (milliseconds) => {
      const timer = new AbortController(); const task = Promise.resolve().then(() => sleep(milliseconds, timer.signal)).then(() => null, () => FAILED);
      const settled = await Promise.race([task, abortGate]); timer.abort(); await task; return settled;
    };
    const send = async (url, options, milliseconds = REQUEST_TIMEOUT_MS) => {
      const task = Promise.resolve().then(() => fetchImpl(url, options)).then((response) => ({ response }), () => FAILED);
      const settled = await timed(task, milliseconds);
      if (settled === TIMED_OUT) controller.abort(); return settled;
    };
    const readRejectionDetail = async (response) => {
      const task = Promise.resolve().then(() => rejectionDetail(response)).then((result) => ({ result }), () => FAILED);
      const settled = await timed(task, REQUEST_TIMEOUT_MS);
      return settled === ABORTED || settled === FAILED || settled === TIMED_OUT ? { providerStatus: response.status } : settled.result;
    };
    const readAsyncOperationDetail = async (response, milliseconds) => {
      const task = Promise.resolve().then(() => asyncOperationDetail(response)).then((result) => ({ result }), () => FAILED);
      const settled = await timed(task, milliseconds);
      return settled === ABORTED || settled === FAILED || settled === TIMED_OUT ? { kind: "INVALID" } : settled.result;
    };
    const finish = ([outcome, reason, detail = {}]) => {
      if (terminal) return terminal;
      if (aborted) { outcome = "UNVERIFIED"; reason = "LOCAL_ABORT"; }
      let completedAtMs = lastTime < 0 ? 0 : lastTime;
      try { completedAtMs = now(); } catch { if (!aborted) { outcome = "UNVERIFIED"; reason = polling ? "POLL_TRANSPORT_AMBIGUITY" : "POST_TRANSPORT_AMBIGUITY"; } }
      terminal = Object.freeze({ schemaVersion: 1, request, outcome, reason, ...detail, completedAtMs });
      return terminal;
    };
    const run = async () => {
      let startedAt;
      try { startedAt = now(); } catch { return pair("UNVERIFIED", "POST_TRANSPORT_AMBIGUITY"); }
      if (aborted) return pair("UNVERIFIED", "LOCAL_ABORT");
      const azure = await invoke(getAzureAccessToken, bearer); if (azure === ABORTED) return pair("UNVERIFIED", "LOCAL_ABORT"); if (azure === FAILED || azure === TIMED_OUT) return pair("UNVERIFIED", "POST_TRANSPORT_AMBIGUITY");
      const source = await invoke(getSourceCredentials, credentials);
      if (source === ABORTED) return pair("UNVERIFIED", "LOCAL_ABORT");
      if (source === FAILED || source === TIMED_OUT) return pair("UNVERIFIED", "POST_TRANSPORT_AMBIGUITY");
      const url = `https://management.azure.com/subscriptions/${request.target.subscriptionId}/resourceGroups/${request.target.acrResourceGroup}/providers/Microsoft.ContainerRegistry/registries/${request.target.acrName}/importImage?api-version=2025-11-01`;
      let body;
      try { body = postBody(request, source.result); } catch { return pair("UNVERIFIED", "POST_TRANSPORT_AMBIGUITY"); }
      const post = await send(url, { method: "POST", headers: nullRecord({ Authorization: `Bearer ${azure.result}`, "Content-Type": "application/json" }),
        redirect: "manual", signal: controller.signal, body });
      if (post === ABORTED) return pair("UNVERIFIED", "LOCAL_ABORT");
      if (post === FAILED || post === TIMED_OUT) return pair("UNVERIFIED", "POST_TRANSPORT_AMBIGUITY");
      const initial = responseDetails(post.response, url);
      if (!initial) return pair("UNVERIFIED", "PROTOCOL_LOCATION_VIOLATION");
      if (initial.status === 200) return pair("CONFIRMED_SUCCESS", "ARM_COMPLETED");
      if (initial.status !== 202) {
        const [outcome, reason] = initialMapping(initial.status);
        return pair(outcome, reason, initial.status >= 400 && initial.status < 500 ? await readRejectionDetail(post.response) : {});
      }
      const asyncOperation = initial.asyncUrl !== null;
      const location = pollLocation(asyncOperation ? initial.asyncUrl : initial.location, request);
      let delay = retryDelay(initial.retryAfter);
      if (!location || delay === null) return pair("UNVERIFIED", "PROTOCOL_LOCATION_VIOLATION"); polling = true;
      let refreshed = false;
      for (let polls = 0; polls < MAX_POLLS; polls += 1) {
        let current;
        try { current = now(); } catch { return pair("UNVERIFIED", "POLL_TRANSPORT_AMBIGUITY"); }
        if (current - startedAt >= DEADLINE_MS || delay > DEADLINE_MS - (current - startedAt)) return pair("UNVERIFIED", "POLL_EXHAUSTION");
        const paused = await wait(delay); if (paused === ABORTED) return pair("UNVERIFIED", "LOCAL_ABORT");
        if (paused === FAILED) return pair("UNVERIFIED", "POLL_TRANSPORT_AMBIGUITY");
        try { current = now(); } catch { return pair("UNVERIFIED", "POLL_TRANSPORT_AMBIGUITY"); }
        if (current - startedAt >= DEADLINE_MS) return pair("UNVERIFIED", "POLL_EXHAUSTION");
        let details;
        let pollResponse;
        for (let attempt = 0; attempt < 2; attempt += 1) {
          let remaining = DEADLINE_MS - (current - startedAt);
          if (REQUEST_TIMEOUT_MS * 2 > remaining) return pair("UNVERIFIED", "POLL_EXHAUSTION");
          const token = await invoke(getAzureAccessToken, bearer, Math.min(REQUEST_TIMEOUT_MS, remaining));
          if (token === ABORTED) return pair("UNVERIFIED", "LOCAL_ABORT"); try { current = now(); } catch { return pair("UNVERIFIED", "POLL_TRANSPORT_AMBIGUITY"); }
          if (current - startedAt >= DEADLINE_MS) return pair("UNVERIFIED", "POLL_EXHAUSTION");
          if (token === FAILED || token === TIMED_OUT) return pair("UNVERIFIED", "POLL_TRANSPORT_AMBIGUITY");
          remaining = DEADLINE_MS - (current - startedAt);
          const polled = await send(location, { method: "GET", headers: nullRecord({ Authorization: `Bearer ${token.result}` }), redirect: "manual", signal: controller.signal }, Math.min(REQUEST_TIMEOUT_MS, remaining));
          if (polled === ABORTED) return pair("UNVERIFIED", "LOCAL_ABORT"); try { current = now(); } catch { return pair("UNVERIFIED", "POLL_TRANSPORT_AMBIGUITY"); }
          if (current - startedAt >= DEADLINE_MS) return pair("UNVERIFIED", "POLL_EXHAUSTION");
          if (polled === FAILED || polled === TIMED_OUT) return pair("UNVERIFIED", "POLL_TRANSPORT_AMBIGUITY");
          pollResponse = polled.response;
          details = responseDetails(pollResponse, location);
          if (!details || (details.location !== null && details.location !== location)
            || (details.asyncUrl !== null && (!asyncOperation || details.asyncUrl !== location))) return pair("UNVERIFIED", "PROTOCOL_LOCATION_VIOLATION");
          if (details.status !== 401 || refreshed || attempt === 1) break;
          refreshed = true;
        }
        if (details.status === 204) return pair("CONFIRMED_SUCCESS", "ARM_COMPLETED");
        if (details.status === 200 && !asyncOperation) return pair("CONFIRMED_SUCCESS", "ARM_COMPLETED");
        if (details.status === 200 && asyncOperation) {
          let remaining;
          try { current = now(); } catch { return pair("UNVERIFIED", "POLL_TRANSPORT_AMBIGUITY"); }
          if (current - startedAt >= DEADLINE_MS) return pair("UNVERIFIED", "POLL_EXHAUSTION");
          remaining = DEADLINE_MS - (current - startedAt);
          const operation = await readAsyncOperationDetail(pollResponse, Math.min(REQUEST_TIMEOUT_MS, remaining));
          try { current = now(); } catch { return pair("UNVERIFIED", "POLL_TRANSPORT_AMBIGUITY"); }
          if (current - startedAt >= DEADLINE_MS) return pair("UNVERIFIED", "POLL_EXHAUSTION");
          if (operation.kind === "SUCCEEDED") return pair("CONFIRMED_SUCCESS", "ARM_COMPLETED");
          if (operation.kind === "FAILED") return pair("CONFIRMED_POST_REJECTION", "POLL_REJECTION",
            operation.providerCode ? { providerCode: operation.providerCode } : {});
          if (operation.kind !== "PENDING") return pair("UNVERIFIED", "PROTOCOL_LOCATION_VIOLATION");
        } else if (details.status !== 202) return pollMapping(details.status);
        delay = retryDelay(details.retryAfter);
        if (delay === null) return pair("UNVERIFIED", "PROTOCOL_LOCATION_VIOLATION");
      }
      return pair("UNVERIFIED", "POLL_EXHAUSTION");
    };
    const completion = Promise.resolve().then(run).then(finish, () => finish(pair("UNVERIFIED", "POST_TRANSPORT_AMBIGUITY")));
    async function abort() { if (!terminal && !aborted) { aborted = true; controller.abort(); resolveAbort(); } return completion; }
    return Object.freeze({ completion, abort });
  }
  return Object.freeze({ startManagedAzureImport });
}
