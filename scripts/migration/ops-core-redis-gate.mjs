import { createHash, randomBytes } from "node:crypto";
import { createClient as nodeRedisCreateClient } from "redis";
import { archiveEvidenceHash } from "./ops-core-archive.mjs";

const HASH = /^[a-f0-9]{64}$/;
const RUN_ID = /^[a-f0-9]{40}$/;
const MODES = ["standalone", "azure-enterprise-proxy"];
const resourcePattern = /^\/subscriptions\/[a-f0-9-]{36}\/resourceGroups\/[a-zA-Z0-9_.()-]{1,90}\/providers\/Microsoft\.Cache\/redisEnterprise\/[a-zA-Z0-9-]{1,60}\/databases\/default$/;
class GateError extends Error {
  constructor(code) { super(code); this.name = "RedisEmptyGateError"; this.code = code; }
}
const requireValue = (condition, code) => { if (!condition) throw new GateError(code); };
const keys = (value, expected) => value !== null && typeof value === "object" && !Array.isArray(value)
  && Object.keys(value).sort().join(",") === expected.split(",").sort().join(",");
export const redisEmptyGateDiagnostic = error => error instanceof GateError ? error.code : null;
function validateBinding(value) {
  requireValue(keys(value, "mode,connection,server,resourceId") && MODES.includes(value.mode)
    && keys(value.connection, "host,port,database,username,tls") && keys(value.server, "version,runId"), "REDIS_GATE_BINDING_INVALID");
  const c = value.connection;
  requireValue(typeof c.host === "string" && /^[a-z0-9][a-z0-9.-]{0,252}$/.test(c.host)
    && Number.isInteger(c.port) && c.port > 0 && c.port < 65536
    && Number.isInteger(c.database) && c.database >= 0 && c.database <= 15
    && typeof c.username === "string" && /^[a-zA-Z0-9_.-]{1,128}$/.test(c.username)
    && typeof c.tls === "boolean" && /^\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(value.server.version), "REDIS_GATE_BINDING_INVALID");
  requireValue(value.mode === "standalone" ? value.resourceId === null && RUN_ID.test(value.server.runId)
    : resourcePattern.test(value.resourceId) && c.database === 0 && c.tls
      && (value.server.runId === null || RUN_ID.test(value.server.runId)), "REDIS_GATE_BINDING_INVALID");
  return structuredClone(value);
}
export const redisGateBindingSha256 = binding => archiveEvidenceHash(validateBinding(binding));

function infoProjection(text, binding, side) {
  requireValue(typeof text === "string" && Buffer.byteLength(text) <= 64 * 1024, `REDIS_${side}_INFO_INVALID`);
  const fields = {};
  for (const line of text.split(/\r?\n/)) {
    const separator = line.indexOf(":");
    if (separator < 0) continue;
    const field = line.slice(0, separator);
    if (!["run_id", "redis_version", "redis_mode"].includes(field)) continue;
    requireValue(fields[field] === undefined, `REDIS_${side}_INFO_INVALID`);
    fields[field] = line.slice(separator + 1);
  }
  requireValue(fields.redis_version === binding.server.version
    && (fields.run_id ?? null) === binding.server.runId
    && (binding.mode !== "standalone" || fields.redis_mode === "standalone"), `REDIS_${side}_SERVER_CHANGED`);
  return { version: fields.redis_version, runIdSha256: fields.run_id
    ? createHash("sha256").update(fields.run_id).digest("hex") : null };
}

const signalCheck = signal => requireValue(!signal.aborted, "REDIS_GATE_ABORTED");
const closeClient = client => { try { client.destroy(); } catch {} };
function limits(signal, maxScanPages, connectTimeoutMs) {
  requireValue(signal instanceof AbortSignal && Number.isSafeInteger(maxScanPages) && maxScanPages > 0 && maxScanPages <= 1000
    && Number.isSafeInteger(connectTimeoutMs) && connectTimeoutMs > 0 && connectTimeoutMs <= 30_000, "REDIS_GATE_LIMITS_INVALID");
}

async function openRedisReadSession({ binding, credentials, side, signal, createClient, maxScanPages, connectTimeoutMs }) {
  limits(signal, maxScanPages, connectTimeoutMs);
  signalCheck(signal);
  requireValue(credentials && keys(credentials, "password,tlsCa") && typeof credentials.password === "string"
    && credentials.password.length > 0 && credentials.password.length <= 16384
    && (credentials.tlsCa === null || (binding.connection.tls && typeof credentials.tlsCa === "string")),
  `REDIS_${side}_CREDENTIALS_INVALID`);
  const c = binding.connection;
  const client = createClient({ username: c.username, password: credentials.password, database: c.database,
    disableOfflineQueue: true, disableClientInfo: true,
    socket: { host: c.host, port: c.port, connectTimeout: connectTimeoutMs, reconnectStrategy: false,
      ...(c.tls ? { tls: true, servername: c.host, rejectUnauthorized: true,
        ...(credentials.tlsCa ? { ca: credentials.tlsCa } : {}) } : { tls: false }) } });
  requireValue(client && typeof client.connect === "function" && typeof client.sendCommand === "function"
    && typeof client.destroy === "function" && typeof client.on === "function" && !client.isOpen, `REDIS_${side}_CLIENT_INVALID`);
  client.on("error", () => {});
  let rejectConnect;
  let timer;
  let closed = false;
  const abort = () => {
    rejectConnect?.(new GateError("REDIS_GATE_ABORTED"));
    closeClient(client);
  };
  const close = () => {
    if (closed) return;
    closed = true;
    clearTimeout(timer); signal.removeEventListener("abort", abort); closeClient(client);
  };
  signal.addEventListener("abort", abort, { once: true });
  try {
    signalCheck(signal);
    // node-redis socket.connectTimeout ends after TCP/TLS establishment. AUTH
    // and the rest of its handshake need an independent whole-connect deadline.
    const deadline = new Promise((_, reject) => {
      rejectConnect = reject;
      timer = setTimeout(() => { reject(new GateError(`REDIS_${side}_CONNECT_TIMEOUT`)); closeClient(client); }, connectTimeoutMs);
    });
    await Promise.race([Promise.resolve().then(() => { signalCheck(signal); return client.connect(); }), deadline]);
    clearTimeout(timer); rejectConnect = null; signalCheck(signal);
  } catch (error) { close(); throw error; }
  async function command(args) {
    signalCheck(signal);
    const reply = await client.sendCommand(args, { abortSignal: signal, timeout: 10_000 });
    signalCheck(signal); return reply;
  }
  async function identity() {
    const server = infoProjection(await command(["INFO", "server"]), binding, side);
    if (binding.mode === "standalone") {
      const role = await command(["ROLE"]);
      requireValue(Array.isArray(role) && role[0] === "master", `REDIS_${side}_NOT_PRIMARY`);
    }
    return server;
  }
  async function emptySize() {
    const size = await command(["DBSIZE"]);
    requireValue(Number.isSafeInteger(size) && size >= 0, `REDIS_${side}_SIZE_INVALID`);
    requireValue(size === 0, `REDIS_${side}_NOT_EMPTY`);
  }
  return { close, async recheck() { await emptySize(); await identity(); }, async observe() {
    const server = await identity();
    await emptySize();
    let cursor = "0";
    let pages = 0;
    const cursors = new Set();
    do {
      requireValue(++pages <= maxScanPages && !cursors.has(cursor), `REDIS_${side}_SCAN_BOUND_EXCEEDED`);
      cursors.add(cursor);
      const reply = await command(["SCAN", cursor, "COUNT", "500"]);
      requireValue(Array.isArray(reply) && reply.length === 2 && typeof reply[0] === "string"
        && /^\d{1,64}$/.test(reply[0]) && Array.isArray(reply[1]), `REDIS_${side}_SCAN_INVALID`);
      requireValue(reply[1].length === 0, `REDIS_${side}_NOT_EMPTY`);
      cursor = reply[0];
    } while (cursor !== "0");
    await emptySize();
    requireValue(archiveEvidenceHash(await identity()) === archiveEvidenceHash(server), `REDIS_${side}_SERVER_CHANGED`);
    return { bindingSha256: redisGateBindingSha256(binding), mode: binding.mode, server,
      scanPages: pages, scannedKeys: 0, dbSizeBefore: 0, dbSizeAfter: 0,
      scope: binding.mode === "azure-enterprise-proxy" ? "all-proxy-shards" : "standalone-database" };
  } };
}

/** One database observation for a read-only private-network probe. This is not a
 * source fence or final acceptance. The external owner verifies current custody,
 * source fencing, target inactivity and Enterprise proxy policy around the probe.
 */
export async function observeRedisEmpty({ binding: value, credentials, side = "TARGET", signal,
  createClient = nodeRedisCreateClient, maxScanPages = 100, connectTimeoutMs = 10_000 }) {
  let session;
  try {
    requireValue(["SOURCE", "TARGET"].includes(side) && typeof createClient === "function", "REDIS_GATE_OBSERVER_INVALID");
    const binding = validateBinding(value);
    session = await openRedisReadSession({ binding, credentials, side, signal, createClient, maxScanPages, connectTimeoutMs });
    return await session.observe();
  } catch (error) {
    if (error instanceof GateError) throw error;
    throw new GateError(`REDIS_${side}_READ_FAILED`);
  } finally { session?.close(); }
}

const JOB_ID = /^\/subscriptions\/[a-f0-9-]{36}\/resourceGroups\/[a-zA-Z0-9_.()-]{1,90}\/providers\/Microsoft\.App\/jobs\/[a-z][a-z0-9-]{0,30}[a-z0-9]$/;
function probeIdentity(value) {
  requireValue(keys(value, "jobResourceId,imageDigest,probeSha256") && JOB_ID.test(value.jobResourceId)
    && /^sha256:[a-f0-9]{64}$/.test(value.imageDigest) && HASH.test(value.probeSha256), "REDIS_REMOTE_IDENTITY_INVALID");
  return structuredClone(value);
}
function validateChallenge(challenge) {
  requireValue(keys(challenge, "schemaVersion,nonce,domain,intentSha256,sourceFenceSha256,targetBindingSha256,identity,issuedAt,expiresAt")
    && challenge.schemaVersion === 1 && HASH.test(challenge.nonce) && ["core", "ops"].includes(challenge.domain)
    && [challenge.intentSha256, challenge.sourceFenceSha256, challenge.targetBindingSha256].every(value => HASH.test(value))
    && Number.isSafeInteger(challenge.issuedAt) && Number.isSafeInteger(challenge.expiresAt)
    && challenge.expiresAt > challenge.issuedAt && challenge.expiresAt - challenge.issuedAt <= 300_000,
  "REDIS_REMOTE_CHALLENGE_INVALID");
  probeIdentity(challenge.identity);
  requireValue(Date.now() >= challenge.issuedAt && Date.now() <= challenge.expiresAt, "REDIS_REMOTE_CHALLENGE_EXPIRED");
}

/** Called inside the bounded ACA job. identity must come from the pinned probe
 * build/config, independently of challenge input. The dispatcher must separately
 * verify actual image/config and execution identity through the provider API.
 * No custody lease or fictitious source/target callbacks enter this read process.
 */
export async function runRedisTargetProbe({ binding, credentials, challenge: value, identity: actualIdentity,
  signal, createClient = nodeRedisCreateClient, maxScanPages = 100, connectTimeoutMs = 10_000 }) {
  try {
    const challenge = structuredClone(value);
    validateChallenge(challenge);
    const identity = probeIdentity(actualIdentity);
    requireValue(archiveEvidenceHash(identity) === archiveEvidenceHash(challenge.identity)
      && redisGateBindingSha256(binding) === challenge.targetBindingSha256, "REDIS_REMOTE_PROBE_BINDING_MISMATCH");
    const observation = await observeRedisEmpty({ binding, credentials, side: "TARGET", signal, createClient, maxScanPages, connectTimeoutMs });
    validateChallenge(challenge);
    return { schemaVersion: 1, type: "REDIS_TARGET_EMPTY_OBSERVATION", challengeSha256: archiveEvidenceHash(challenge),
      nonce: challenge.nonce, domain: challenge.domain, intentSha256: challenge.intentSha256,
      sourceFenceSha256: challenge.sourceFenceSha256, targetBindingSha256: challenge.targetBindingSha256,
      identity, observedAt: Date.now(), observation };
  } catch (error) {
    if (error instanceof GateError) throw error;
    throw new GateError("REDIS_REMOTE_PROBE_FAILED");
  }
}

function verifyRemoteResponse(response, challenge, binding, maxScanPages) {
  validateChallenge(challenge);
  requireValue(keys(response, "receipt,execution"), "REDIS_REMOTE_RESPONSE_INVALID");
  const { receipt, execution } = response;
  const challengeSha256 = archiveEvidenceHash(challenge);
  requireValue(keys(receipt, "schemaVersion,type,challengeSha256,nonce,domain,intentSha256,sourceFenceSha256,targetBindingSha256,identity,observedAt,observation")
    && receipt.schemaVersion === 1 && receipt.type === "REDIS_TARGET_EMPTY_OBSERVATION"
    && receipt.challengeSha256 === challengeSha256 && receipt.nonce === challenge.nonce && receipt.domain === challenge.domain
    && receipt.intentSha256 === challenge.intentSha256 && receipt.sourceFenceSha256 === challenge.sourceFenceSha256
    && receipt.targetBindingSha256 === challenge.targetBindingSha256
    && archiveEvidenceHash(receipt.identity) === archiveEvidenceHash(challenge.identity), "REDIS_REMOTE_RECEIPT_MISMATCH");
  const observed = receipt.observation;
  const expectedServer = { version: binding.server.version, runIdSha256: binding.server.runId
    ? createHash("sha256").update(binding.server.runId).digest("hex") : null };
  requireValue(keys(observed, "bindingSha256,mode,server,scanPages,scannedKeys,dbSizeBefore,dbSizeAfter,scope")
    && observed.bindingSha256 === challenge.targetBindingSha256 && observed.mode === binding.mode
    && archiveEvidenceHash(observed.server) === archiveEvidenceHash(expectedServer)
    && Number.isSafeInteger(observed.scanPages) && observed.scanPages > 0 && observed.scanPages <= maxScanPages
    && observed.scannedKeys === 0 && observed.dbSizeBefore === 0 && observed.dbSizeAfter === 0
    && observed.scope === (binding.mode === "azure-enterprise-proxy" ? "all-proxy-shards" : "standalone-database"), "REDIS_REMOTE_OBSERVATION_INVALID");
  requireValue(keys(execution, "jobResourceId,executionResourceId,imageDigest,probeSha256,challengeSha256,status,replicaCount,completionCount,startedAt,finishedAt")
    && execution.jobResourceId === challenge.identity.jobResourceId
    && typeof execution.executionResourceId === "string"
    && execution.executionResourceId.startsWith(`${execution.jobResourceId}/executions/`)
    && /^[a-z0-9][a-z0-9-]{0,79}$/.test(execution.executionResourceId.slice(`${execution.jobResourceId}/executions/`.length))
    && execution.imageDigest === challenge.identity.imageDigest && execution.probeSha256 === challenge.identity.probeSha256
    && execution.challengeSha256 === challengeSha256 && execution.status === "Succeeded"
    && execution.replicaCount === 1 && execution.completionCount === 1, "REDIS_REMOTE_EXECUTION_UNPROVEN");
  requireValue([receipt.observedAt, execution.startedAt, execution.finishedAt].every(Number.isSafeInteger)
    && execution.startedAt >= challenge.issuedAt && receipt.observedAt >= execution.startedAt
    && execution.finishedAt >= receipt.observedAt && execution.finishedAt <= Date.now()
    && execution.finishedAt <= challenge.expiresAt, "REDIS_REMOTE_EXECUTION_STALE");
  return { ...observed, remoteProof: { challengeSha256, receiptSha256: archiveEvidenceHash(receipt),
    executionSha256: archiveEvidenceHash(execution) } };
}

/** Final empty-state acceptance. EnterpriseCluster proxy SCAN/DBSIZE cover all
 * shards only with OSS Cluster API disabled; ROLE is unsupported in this mode.
 * https://redis.io/docs/latest/develop/using-commands/multi-key-operations/
 * https://redis.io/docs/latest/operate/rs/references/compatibility/commands/server/
 * https://learn.microsoft.com/en-us/azure/redis/architecture
 *
 * remoteTarget.runProbe must DISPATCH a fresh bounded job for the supplied random
 * challenge and READ BACK its exact provider execution/config plus one receipt.
 * A caller-supplied saved receipt is not this callback's contract. No dispatcher
 * is implemented here. The external owner keeps the lease and actual guards.
 */
export async function assertOpsCoreRedisEmpty({ source: sourceValue, target: targetValue,
  sourceCredentials, targetCredentials, custody, assertSourceFenced, assertTargetInactive,
  assertEnterpriseBinding, createClient = nodeRedisCreateClient, maxScanPages = 100, connectTimeoutMs = 10_000,
  remoteTarget = null, remoteTimeoutMs = 120_000 }) {
  const sessions = [];
  let side = "GATE";
  try {
    const source = validateBinding(sourceValue);
    const target = validateBinding(targetValue);
    requireValue(source.connection.host !== target.connection.host || source.connection.port !== target.connection.port,
      "REDIS_GATE_SOURCE_TARGET_ALIAS");
    requireValue(!source.server.runId || !target.server.runId || source.server.runId !== target.server.runId,
      "REDIS_GATE_SOURCE_TARGET_ALIAS");
    requireValue(custody?.signal instanceof AbortSignal && typeof custody.assertOwned === "function"
      && typeof custody.snapshot === "function" && typeof assertSourceFenced === "function"
      && typeof assertTargetInactive === "function" && typeof createClient === "function", "REDIS_GATE_CUSTODY_REQUIRED");
    limits(custody.signal, maxScanPages, connectTimeoutMs);
    if (remoteTarget !== null) requireValue(keys(remoteTarget, "identity,runProbe") && typeof remoteTarget.runProbe === "function"
      && Number.isSafeInteger(remoteTimeoutMs) && remoteTimeoutMs > 0 && remoteTimeoutMs <= 300_000, "REDIS_REMOTE_DISPATCH_REQUIRED");
    const remoteIdentity = remoteTarget === null ? null : probeIdentity(remoteTarget.identity);
    const initial = custody.snapshot();
    const sourceFenceSha256 = initial.history?.find(entry => entry.phase === "SOURCE_FENCED")?.evidenceSha256;
    requireValue(["core", "ops"].includes(initial.domain) && HASH.test(initial.intentSha256)
      && HASH.test(sourceFenceSha256) && initial.phase !== "PREPARED", "REDIS_GATE_SOURCE_FENCE_REQUIRED");
    const bindingHashes = { source: redisGateBindingSha256(source), target: redisGateBindingSha256(target) };
    const signal = custody.signal;
    function snapshotCheck() {
      const current = custody.snapshot();
      requireValue(current.domain === initial.domain && current.intentSha256 === initial.intentSha256
        && current.history?.find(entry => entry.phase === "SOURCE_FENCED")?.evidenceSha256 === sourceFenceSha256
        && current.phase === initial.phase && current.pending?.operationId === initial.pending?.operationId, "REDIS_GATE_CUSTODY_CHANGED");
    }
    async function check() {
      signalCheck(signal); await custody.assertOwned(); signalCheck(signal); snapshotCheck();
      const fenced = await assertSourceFenced(); signalCheck(signal);
      requireValue(fenced?.complete === true && fenced.domain === initial.domain && fenced.intentSha256 === initial.intentSha256
        && fenced.sourceFenceSha256 === sourceFenceSha256, "REDIS_GATE_SOURCE_UNFENCED");
      const inactive = await assertTargetInactive(); signalCheck(signal);
      requireValue(inactive?.complete === true && inactive.targetBindingSha256 === bindingHashes.target, "REDIS_GATE_TARGET_ACTIVE");
      await custody.assertOwned(); signalCheck(signal); snapshotCheck();
    }
    async function enterprise(binding, name) {
      if (binding.mode !== "azure-enterprise-proxy") return;
      requireValue(typeof assertEnterpriseBinding === "function", `REDIS_${name}_ENTERPRISE_POLICY_UNPROVEN`);
      signalCheck(signal);
      const evidence = await assertEnterpriseBinding({ side: name.toLowerCase(), binding: structuredClone(binding) });
      signalCheck(signal);
      requireValue(evidence?.complete === true && evidence.resourceId === binding.resourceId
        && evidence.host === binding.connection.host && evidence.port === binding.connection.port
        && evidence.clusteringPolicy === "EnterpriseCluster" && evidence.geoReplication === "Disabled", `REDIS_${name}_ENTERPRISE_POLICY_UNPROVEN`);
    }
    const results = {};
    const opened = {};
    let remoteChallenge;
    for (const [name, binding, credentials] of [["SOURCE", source, sourceCredentials], ["TARGET", target, targetCredentials]]) {
      side = name;
      await check(); await enterprise(binding, name);
      if (name === "TARGET" && remoteTarget !== null) {
        const issuedAt = Date.now();
        const challenge = { schemaVersion: 1, nonce: randomBytes(32).toString("hex"), domain: initial.domain,
          intentSha256: initial.intentSha256, sourceFenceSha256, targetBindingSha256: bindingHashes.target,
          identity: remoteIdentity, issuedAt, expiresAt: issuedAt + remoteTimeoutMs };
        remoteChallenge = challenge;
        const timeoutController = new AbortController();
        const timer = setTimeout(() => timeoutController.abort(), remoteTimeoutMs);
        const dispatchSignal = AbortSignal.any([signal, timeoutController.signal]);
        let abort;
        const cancelled = new Promise((_, reject) => {
          abort = () => reject(new GateError(signal.aborted ? "REDIS_GATE_ABORTED" : "REDIS_REMOTE_TIMEOUT"));
          dispatchSignal.addEventListener("abort", abort, { once: true });
        });
        let response;
        try {
          response = await Promise.race([Promise.resolve().then(() => {
            requireValue(!dispatchSignal.aborted, signal.aborted ? "REDIS_GATE_ABORTED" : "REDIS_REMOTE_TIMEOUT");
            return remoteTarget.runProbe({ challenge: structuredClone(challenge), binding: structuredClone(binding), signal: dispatchSignal });
          }), cancelled]);
          signalCheck(signal);
        } finally { clearTimeout(timer); dispatchSignal.removeEventListener("abort", abort); }
        results.target = verifyRemoteResponse(response, challenge, binding, maxScanPages);
      } else {
        const session = await openRedisReadSession({ binding, credentials, side: name, signal, createClient, maxScanPages, connectTimeoutMs });
        sessions.push(session); opened[name] = session;
        results[name.toLowerCase()] = await session.observe();
      }
      await enterprise(binding, name); await check();
    }
    if (remoteTarget !== null) {
      side = "SOURCE";
      // A new full scan brackets the remote target execution; a source observation
      // from before that execution is never reused as the final source proof.
      await check(); await enterprise(source, "SOURCE");
      results.source = await opened.SOURCE.observe();
      await enterprise(source, "SOURCE"); await check();
    }
    for (const [name, binding] of [["SOURCE", source], ["TARGET", target]]) {
      side = name;
      if (opened[name]) await opened[name].recheck();
      await enterprise(binding, name);
    }
    side = "GATE"; await check();
    if (remoteChallenge) validateChallenge(remoteChallenge);
    return { status: "REDIS_EMPTY_ACCEPTED", domain: initial.domain, intentSha256: initial.intentSha256,
      sourceFenceSha256, source: results.source, target: results.target };
  } catch (error) {
    if (error instanceof GateError) throw error;
    throw new GateError(`REDIS_${side}_READ_FAILED`);
  } finally { for (const session of sessions) session.close(); }
}
