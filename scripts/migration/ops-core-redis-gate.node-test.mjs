import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { createServer } from "node:net";
import { performance } from "node:perf_hooks";
import { setTimeout as delay } from "node:timers/promises";
import { test } from "node:test";
import { archiveEvidenceHash } from "./ops-core-archive.mjs";
import { assertOpsCoreRedisEmpty, observeRedisEmpty, runRedisTargetProbe,
  redisGateBindingSha256, redisEmptyGateDiagnostic } from "./ops-core-redis-gate.mjs";

const endpoint = (side, enterprise = false) => ({ mode: enterprise ? "azure-enterprise-proxy" : "standalone",
  connection: { host: `${side}.fixture.invalid`, port: enterprise ? 10000 : 6379, database: 0, username: "default", tls: enterprise },
  server: { version: enterprise ? "7.4.0" : "8.2.9", runId: enterprise ? null : (side === "source" ? "a" : "b").repeat(40) },
  resourceId: enterprise ? "/subscriptions/00000000-0000-4000-8000-000000000001/resourceGroups/fixture/providers/Microsoft.Cache/redisEnterprise/fixture/databases/default" : null });
function fixture({ enterprise = false, reply, sourceGuard, targetGuard, enterpriseGuard } = {}) {
  const controller = new AbortController();
  const source = endpoint("source");
  const target = endpoint("target", enterprise);
  const journal = { domain: "core", intentSha256: "c".repeat(64), phase: "SOURCE_FENCED", pending: null,
    history: [{ phase: "SOURCE_FENCED", evidenceSha256: "d".repeat(64) }] };
  const state = { created: [], commands: [], guards: [], destroyed: [], counts: {}, enterpriseReads: 0 };
  const credentials = () => ({ password: randomBytes(32).toString("base64"), tlsCa: null });
  const options = { source, target, sourceCredentials: credentials(), targetCredentials: credentials(),
    custody: { signal: controller.signal, snapshot: () => structuredClone(journal), async assertOwned() {} },
    async assertSourceFenced() {
      state.guards.push("source");
      return sourceGuard ? sourceGuard(state) : { complete: true, domain: journal.domain, intentSha256: journal.intentSha256,
        sourceFenceSha256: journal.history[0].evidenceSha256 };
    },
    async assertTargetInactive() {
      state.guards.push("target");
      return targetGuard ? targetGuard(state) : { complete: true, targetBindingSha256: redisGateBindingSha256(target) };
    },
    async assertEnterpriseBinding({ side, binding }) {
      state.enterpriseReads++;
      if (enterpriseGuard) return enterpriseGuard(state, binding);
      assert.equal(side, "target");
      return { complete: true, resourceId: binding.resourceId, host: binding.connection.host, port: binding.connection.port,
        clusteringPolicy: "EnterpriseCluster", geoReplication: "Disabled" };
    },
    createClient(config) {
      const name = state.created.length ? "target" : "source";
      const binding = name === "source" ? source : target;
      state.created.push(config);
      return { isOpen: false, on() {}, async connect() {}, destroy() { state.destroyed.push(name); },
        async sendCommand(args, commandOptions) {
          assert.equal(commandOptions.abortSignal, controller.signal);
          assert.equal(commandOptions.timeout, 10_000);
          state.commands.push({ side: name, args });
          const key = `${name}:${args[0]}`;
          const count = state.counts[key] = (state.counts[key] ?? 0) + 1;
          const custom = reply?.({ name, args, count, state, binding });
          if (custom !== undefined) return custom;
          if (args[0] === "INFO") return `# Server\r\nredis_version:${binding.server.version}\r\n${binding.server.runId ? `run_id:${binding.server.runId}\r\n` : ""}${enterprise && name === "target" ? "" : "redis_mode:standalone\r\n"}`;
          if (args[0] === "ROLE") return ["master", 0, []];
          if (args[0] === "DBSIZE") return 0;
          if (args[0] === "SCAN") return ["0", []];
          throw new Error("UNEXPECTED_COMMAND");
        },
      };
    },
  };
  return { options, state, journal, controller };
}

test("accepts two fully empty bound standalone databases with redacted custody evidence and read-only commands", async () => {
  const f = fixture();
  const result = await assertOpsCoreRedisEmpty(f.options);
  assert.equal(result.status, "REDIS_EMPTY_ACCEPTED");
  assert.equal(result.domain, "core"); assert.equal(result.intentSha256, f.journal.intentSha256);
  assert.equal(result.sourceFenceSha256, f.journal.history[0].evidenceSha256);
  assert.equal(result.source.scope, "standalone-database");
  assert.equal(result.target.bindingSha256, redisGateBindingSha256(f.options.target));
  assert.equal(result.source.scannedKeys, 0); assert.equal(result.target.dbSizeAfter, 0);
  assert.ok(f.state.commands.every(({ args }) => ["INFO", "ROLE", "DBSIZE", "SCAN"].includes(args[0])));
  assert.deepEqual(f.state.destroyed.sort(), ["source", "target"]);
  assert.equal(f.state.guards.filter(name => name === "source").length, 5);
  for (const secret of [f.options.sourceCredentials.password, f.options.targetCredentials.password,
    f.options.source.connection.host, f.options.source.server.runId]) assert.equal(JSON.stringify(result).includes(secret), false);
  for (const config of f.state.created) {
    assert.equal(config.socket.reconnectStrategy, false); assert.equal(config.disableOfflineQueue, true);
    assert.equal(config.disableClientInfo, true); assert.equal(config.url, undefined);
  }
});

test("EnterpriseCluster proxy scans all shards without unsupported ROLE or assumed standalone INFO fields", async () => {
  const f = fixture({ enterprise: true });
  const result = await assertOpsCoreRedisEmpty(f.options);
  assert.equal(result.target.scope, "all-proxy-shards");
  assert.equal(result.target.server.runIdSha256, null);
  assert.equal(f.state.commands.some(value => value.side === "target" && value.args[0] === "ROLE"), false);
  assert.equal(f.state.enterpriseReads, 3);
  assert.equal(f.state.created[1].socket.tls, true);
  assert.equal(f.state.created[1].socket.rejectUnauthorized, true);
  assert.equal(f.state.created[1].socket.servername, f.options.target.connection.host);
});

test("fully paginates empty pages preserving opaque decimal cursor spelling", async () => {
  const cursors = ["00012", "999999999999999999999999999999", "0"];
  const f = fixture({ reply({ args, count, name }) { if (name === "source" && args[0] === "SCAN") return [cursors[count - 1], []]; } });
  assert.equal((await assertOpsCoreRedisEmpty(f.options)).source.scanPages, 3);
  assert.deepEqual(f.state.commands.filter(value => value.side === "source" && value.args[0] === "SCAN").map(value => value.args),
    [["SCAN", "0", "COUNT", "500"], ["SCAN", "00012", "COUNT", "500"], ["SCAN", cursors[1], "COUNT", "500"]]);
});

for (const name of ["source", "target"]) {
  for (const [reason, args, count, response, code] of [
    ["initial nonzero size", "DBSIZE", 1, 1, "NOT_EMPTY"],
    ["size after scan drift", "DBSIZE", 2, 1, "NOT_EMPTY"],
    ["size at final recheck drift", "DBSIZE", 3, 1, "NOT_EMPTY"],
    ["key even if it expires before DBSIZE", "SCAN", 1, ["0", [Buffer.from("synthetic-private-key")]], "NOT_EMPTY"],
    ["unexpected replica", "ROLE", 1, ["slave", "private-host", 6379], "NOT_PRIMARY"],
    ["invalid size", "DBSIZE", 1, -1, "SIZE_INVALID"],
    ["malformed SCAN", "SCAN", 1, { cursor: 0, keys: [] }, "SCAN_INVALID"],
    ["numeric cursor loses precision", "SCAN", 1, [42, []], "SCAN_INVALID"],
  ]) {
    test(`${name}: rejects ${reason}`, async () => {
      const f = fixture({ reply(request) { if (request.name === name && request.args[0] === args && request.count === count) return response; } });
      await assert.rejects(assertOpsCoreRedisEmpty(f.options), { code: `REDIS_${name.toUpperCase()}_${code}` });
      assert.ok(f.state.destroyed.includes(name));
    });
  }
}

for (const [reason, response] of [["changed run id", "redis_version:8.2.9\nrun_id:" + "e".repeat(40) + "\nredis_mode:standalone"],
  ["OSS cluster hidden as standalone", "redis_version:8.2.9\nrun_id:" + "a".repeat(40) + "\nredis_mode:cluster"],
  ["missing run id", "redis_version:8.2.9\nredis_mode:standalone"],
  ["changed version", "redis_version:8.0.0\nrun_id:" + "a".repeat(40) + "\nredis_mode:standalone"]]) {
  test(`rejects ${reason} on final source identity read`, async () => {
    const f = fixture({ reply({ name, args, count }) { if (name === "source" && args[0] === "INFO" && count === 3) return response; } });
    await assert.rejects(assertOpsCoreRedisEmpty(f.options), { code: "REDIS_SOURCE_SERVER_CHANGED" });
  });
}

for (const limit of [false, true]) test(`bounds ${limit ? "page count" : "repeated cursors"}`, async () => {
  const f = fixture({ reply({ args, count }) { if (args[0] === "SCAN") return [limit ? String(count) : "5", []]; } });
  f.options.maxScanPages = 2;
  await assert.rejects(assertOpsCoreRedisEmpty(f.options), { code: "REDIS_SOURCE_SCAN_BOUND_EXCEEDED" });
  assert.equal(f.state.commands.filter(value => value.args[0] === "SCAN").length, 2);
});

for (const field of ["complete", "resourceId", "host", "port", "clusteringPolicy", "geoReplication"]) {
  test(`rejects Enterprise proxy ${field} drift after complete scan`, async () => {
    const f = fixture({ enterprise: true, enterpriseGuard(state, binding) {
      const result = { complete: true, resourceId: binding.resourceId, host: binding.connection.host,
        port: binding.connection.port, clusteringPolicy: "EnterpriseCluster", geoReplication: "Disabled" };
      if (state.enterpriseReads === 2) result[field] = field === "complete" ? false : "changed";
      return result;
    } });
    await assert.rejects(assertOpsCoreRedisEmpty(f.options), { code: "REDIS_TARGET_ENTERPRISE_POLICY_UNPROVEN" });
  });
}

test("never substitutes a standalone scan when Enterprise policy proof is missing", async () => {
  const f = fixture({ enterprise: true }); delete f.options.assertEnterpriseBinding;
  await assert.rejects(assertOpsCoreRedisEmpty(f.options), { code: "REDIS_TARGET_ENTERPRISE_POLICY_UNPROVEN" });
  assert.equal(f.state.created.length, 1);
});

test("source fencing and target inactivity must be actual affirmative exact-binding receipts", async () => {
  for (const [options, code] of [[{ sourceGuard: () => undefined }, "REDIS_GATE_SOURCE_UNFENCED"],
    [{ sourceGuard: () => ({ complete: false }) }, "REDIS_GATE_SOURCE_UNFENCED"],
    [{ targetGuard: () => ({ complete: true, targetBindingSha256: "f".repeat(64) }) }, "REDIS_GATE_TARGET_ACTIVE"]]) {
    const f = fixture(options);
    await assert.rejects(assertOpsCoreRedisEmpty(f.options), { code });
    assert.equal(f.state.created.length, 0);
  }
});

test("rechecks source fencing after scan and does not open target after loss", async () => {
  const f = fixture({ sourceGuard(state) {
    return { complete: state.guards.length === 1, domain: "core", intentSha256: "c".repeat(64), sourceFenceSha256: "d".repeat(64) };
  } });
  await assert.rejects(assertOpsCoreRedisEmpty(f.options), { code: "REDIS_GATE_SOURCE_UNFENCED" });
  assert.equal(f.state.created.length, 1);
});

test("callback-time custody phase drift is rejected before opening either database", async () => {
  const f = fixture({ targetGuard() {
    f.journal.phase = "RESTORED";
    return { complete: true, targetBindingSha256: redisGateBindingSha256(f.options.target) };
  } });
  await assert.rejects(assertOpsCoreRedisEmpty(f.options), { code: "REDIS_GATE_CUSTODY_CHANGED" });
  assert.equal(f.state.created.length, 0);
});

test("rejects unsupported policy, alias endpoints, unexpected fields and absent source fence", async () => {
  for (const [mutate, code] of [[f => { f.options.target.mode = "OSSCluster"; }, "REDIS_GATE_BINDING_INVALID"],
    [f => { f.options.target.connection.host = f.options.source.connection.host; }, "REDIS_GATE_SOURCE_TARGET_ALIAS"],
    [f => { f.options.target.server.runId = f.options.source.server.runId; }, "REDIS_GATE_SOURCE_TARGET_ALIAS"],
    [f => { f.options.source.connection.url = "forbidden"; }, "REDIS_GATE_BINDING_INVALID"],
    [f => { f.journal.history = []; }, "REDIS_GATE_SOURCE_FENCE_REQUIRED"]]) {
    const f = fixture(); mutate(f);
    await assert.rejects(assertOpsCoreRedisEmpty(f.options), { code });
    assert.equal(f.state.created.length, 0);
  }
});

test("redacts Redis error bodies and key names and never sends a write command", async () => {
  const secret = randomBytes(32).toString("base64");
  const f = fixture({ reply() { throw new Error(secret); } });
  await assert.rejects(assertOpsCoreRedisEmpty(f.options), error => {
    assert.equal(redisEmptyGateDiagnostic(error), "REDIS_SOURCE_READ_FAILED");
    assert.equal(`${error.stack}${JSON.stringify(error)}`.includes(secret), false);
    assert.equal(error.cause, undefined); return true;
  });
  assert.ok(f.state.commands.every(value => ["INFO", "ROLE", "DBSIZE", "SCAN"].includes(value.args[0])));
});

test("abort before connect and abort after a SCAN reply both prevent acceptance and destroy clients", async () => {
  const first = fixture(); first.controller.abort(new Error("private reason"));
  await assert.rejects(assertOpsCoreRedisEmpty(first.options), { code: "REDIS_GATE_ABORTED" });
  assert.equal(first.state.created.length, 0);
  const second = fixture({ reply({ args }) { if (args[0] === "SCAN") { second.controller.abort(); return ["0", []]; } } });
  await assert.rejects(assertOpsCoreRedisEmpty(second.options), { code: "REDIS_GATE_ABORTED" });
  assert.ok(second.state.destroyed.includes("source"));
});

for (const abortAfterAuth of [false, true]) {
  test(`actual node-redis client ${abortAfterAuth ? "abort" : "whole connect deadline"} destroys stalled AUTH socket`, { timeout: 5_000 }, async () => {
    const sockets = new Set();
    const controller = new AbortController();
    let sawAuth = false;
    let closeObserved = false;
    let abortTimer;
    let watchdog;
    const server = createServer(socket => {
      sockets.add(socket);
      socket.on("error", () => {});
      socket.on("close", () => { sockets.delete(socket); closeObserved = true; });
      socket.on("data", data => {
        // Never retain/print AUTH payloads. This server intentionally never
        // acknowledges AUTH, after TCP connection establishment has succeeded.
        if (data.includes(Buffer.from("AUTH"))) {
          sawAuth = true;
          if (abortAfterAuth) abortTimer = setTimeout(() => controller.abort(), 10);
        }
      });
    });
    try {
      await new Promise((resolve, reject) => { server.once("error", reject); server.listen(0, "127.0.0.1", resolve); });
      const binding = endpoint("target");
      binding.connection.host = "127.0.0.1"; binding.connection.port = server.address().port;
      const start = performance.now();
      const work = observeRedisEmpty({ binding, credentials: { password: randomBytes(32).toString("base64"), tlsCa: null },
        signal: controller.signal, connectTimeoutMs: abortAfterAuth ? 1000 : 100 });
      const bounded = Promise.race([work, new Promise((_, reject) => {
        watchdog = setTimeout(() => reject(new Error("ACTUAL_CLIENT_DEADLINE_REGRESSION")), 2000);
      })]);
      await assert.rejects(bounded, { code: abortAfterAuth ? "REDIS_GATE_ABORTED" : "REDIS_TARGET_CONNECT_TIMEOUT" });
      assert.equal(sawAuth, true);
      assert.ok(performance.now() - start < 1500);
      for (let attempt = 0; attempt < 50 && !closeObserved; attempt++) await delay(10);
      assert.equal(closeObserved, true, "stalled authenticated connection must actually close");
    } finally {
      clearTimeout(watchdog); clearTimeout(abortTimer);
      for (const socket of sockets) socket.destroy();
      await new Promise(resolve => server.close(resolve));
    }
  });
}

function probeClient(binding, calls = []) {
  return () => ({ isOpen: false, on() {}, async connect() { calls.push("connect"); }, destroy() { calls.push("destroy"); },
    async sendCommand(args) {
      calls.push(args);
      if (args[0] === "INFO") return `redis_version:${binding.server.version}\n${binding.server.runId ? `run_id:${binding.server.runId}\nredis_mode:standalone\n` : ""}`;
      if (args[0] === "ROLE") return ["master", 0, []];
      if (args[0] === "DBSIZE") return 0;
      if (args[0] === "SCAN") return ["0", []];
      throw new Error("UNEXPECTED_PROBE_COMMAND");
    },
  });
}
const remoteIdentity = () => ({ jobResourceId: "/subscriptions/00000000-0000-4000-8000-000000000001/resourceGroups/fixture/providers/Microsoft.App/jobs/redis-proof",
  imageDigest: `sha256:${"e".repeat(64)}`, probeSha256: "f".repeat(64) });
function remoteFixture({ mutate, reply } = {}) {
  const f = fixture({ enterprise: true, reply });
  const calls = [];
  const identity = remoteIdentity();
  const challenges = [];
  const credentials = { password: randomBytes(32).toString("base64"), tlsCa: null };
  f.options.remoteTarget = { identity, async runProbe({ challenge, binding, signal }) {
    challenges.push(structuredClone(challenge));
    const startedAt = Date.now();
    const receipt = await runRedisTargetProbe({ binding, credentials, challenge,
      identity, signal, createClient: probeClient(binding, calls) });
    const execution = { jobResourceId: identity.jobResourceId, executionResourceId: `${identity.jobResourceId}/executions/fixture-run`,
      imageDigest: identity.imageDigest, probeSha256: identity.probeSha256,
      challengeSha256: archiveEvidenceHash(challenge), status: "Succeeded", replicaCount: 1, completionCount: 1,
      startedAt, finishedAt: Date.now() };
    const response = { receipt, execution };
    mutate?.(response, challenge);
    return response;
  } };
  delete f.options.targetCredentials; // Remote secret delivery belongs to the job.
  // The simulated job has its own credentials and client; the external gate has
  // neither a target password nor a target network connection.
  return { ...f, calls, challenges };
}

test("target-only job probe and external remote acceptance use fresh challenge and fully rescan source", async () => {
  const f = remoteFixture();
  const result = await assertOpsCoreRedisEmpty(f.options);
  assert.equal(result.status, "REDIS_EMPTY_ACCEPTED");
  assert.equal(f.state.created.length, 1, "external controller opens only source Redis");
  assert.equal(f.state.counts["source:SCAN"], 2, "a fresh complete source scan follows remote execution");
  assert.equal(f.challenges.length, 1);
  assert.match(f.challenges[0].nonce, /^[a-f0-9]{64}$/);
  assert.equal(f.challenges[0].targetBindingSha256, redisGateBindingSha256(f.options.target));
  assert.match(result.target.remoteProof.receiptSha256, /^[a-f0-9]{64}$/);
  assert.equal(f.calls.filter(call => call === "connect").length, 1);
  assert.equal(f.calls.filter(call => call === "destroy").length, 1);
  assert.equal(f.calls.some(call => Array.isArray(call) && call[0] === "ROLE"), false);
  assert.equal(JSON.stringify(result).includes(remoteIdentity().jobResourceId), false);
});

for (const [name, mutate, code] of [
  ["nonce", value => { value.receipt.nonce = "0".repeat(64); }, "RECEIPT_MISMATCH"],
  ["global intent", value => { value.receipt.intentSha256 = "0".repeat(64); }, "RECEIPT_MISMATCH"],
  ["source fence", value => { value.receipt.sourceFenceSha256 = "0".repeat(64); }, "RECEIPT_MISMATCH"],
  ["target binding", value => { value.receipt.targetBindingSha256 = "0".repeat(64); }, "RECEIPT_MISMATCH"],
  ["job identity", value => { value.execution.jobResourceId += "-other"; }, "EXECUTION_UNPROVEN"],
  ["foreign execution", value => { value.execution.executionResourceId = "/unrelated/execution"; }, "EXECUTION_UNPROVEN"],
  ["image digest", value => { value.execution.imageDigest = `sha256:${"0".repeat(64)}`; }, "EXECUTION_UNPROVEN"],
  ["probe hash", value => { value.execution.probeSha256 = "0".repeat(64); }, "EXECUTION_UNPROVEN"],
  ["execution challenge", value => { value.execution.challengeSha256 = "0".repeat(64); }, "EXECUTION_UNPROVEN"],
  ["running execution", value => { value.execution.status = "Running"; }, "EXECUTION_UNPROVEN"],
  ["multiple replicas", value => { value.execution.replicaCount = 2; }, "EXECUTION_UNPROVEN"],
  ["incomplete execution", value => { value.execution.completionCount = 0; }, "EXECUTION_UNPROVEN"],
  ["old execution", (value, challenge) => { value.execution.startedAt = challenge.issuedAt - 1; }, "EXECUTION_STALE"],
  ["future execution", value => { value.execution.finishedAt = Date.now() + 60000; }, "EXECUTION_STALE"],
  ["observed key", value => { value.receipt.observation.scannedKeys = 1; }, "OBSERVATION_INVALID"],
  ["wrong server", value => { value.receipt.observation.server.version = "0.0.0"; }, "OBSERVATION_INVALID"],
  ["incomplete scan", value => { value.receipt.observation.scanPages = 0; }, "OBSERVATION_INVALID"],
]) {
  test(`remote acceptance rejects ${name}`, async () => {
    const f = remoteFixture({ mutate });
    await assert.rejects(assertOpsCoreRedisEmpty(f.options), { code: `REDIS_REMOTE_${code}` });
  });
}

test("saved successful receipt cannot satisfy a second fresh challenge", async () => {
  let retained;
  const first = remoteFixture({ mutate(response) { retained = structuredClone(response); } });
  await assertOpsCoreRedisEmpty(first.options);
  const second = remoteFixture();
  let nextNonce;
  second.options.remoteTarget.runProbe = async ({ challenge }) => { nextNonce = challenge.nonce; return retained; };
  await assert.rejects(assertOpsCoreRedisEmpty(second.options), { code: "REDIS_REMOTE_RECEIPT_MISMATCH" });
  assert.notEqual(nextNonce, first.challenges[0].nonce);
});

test("no static remote receipt option can replace a dispatch callback", async () => {
  const f = fixture(); f.options.remoteTarget = { identity: remoteIdentity(), receipt: {} };
  await assert.rejects(assertOpsCoreRedisEmpty(f.options), { code: "REDIS_REMOTE_DISPATCH_REQUIRED" });
  assert.equal(f.state.created.length, 0);
});

test("keys appearing only on post-job source SCAN block acceptance", async () => {
  const f = remoteFixture({ reply({ args, count }) { if (args[0] === "SCAN" && count === 2) return ["0", ["private-fixture-key"]]; } });
  await assert.rejects(assertOpsCoreRedisEmpty(f.options), { code: "REDIS_SOURCE_NOT_EMPTY" });
});

test("external source/target guards and Enterprise policy remain authoritative after remote receipt", async () => {
  for (const guard of ["source", "target", "policy"]) {
    const f = remoteFixture();
    // Mutate the closures used by the already-entered gate instead of replacing
    // options after destructuring.
    let probeDone = false;
    const originalRun = f.options.remoteTarget.runProbe;
    f.options.remoteTarget.runProbe = async request => { const value = await originalRun(request); probeDone = true; return value; };
    const field = guard === "source" ? "assertSourceFenced" : guard === "target" ? "assertTargetInactive" : "assertEnterpriseBinding";
    const originalGuard = f.options[field];
    f.options[field] = async (...args) => probeDone ? { complete: false } : originalGuard(...args);
    await assert.rejects(assertOpsCoreRedisEmpty(f.options), { code: guard === "source" ? "REDIS_GATE_SOURCE_UNFENCED"
      : guard === "target" ? "REDIS_GATE_TARGET_ACTIVE" : "REDIS_TARGET_ENTERPRISE_POLICY_UNPROVEN" });
  }
});

test("probe rejects mismatched embedded identity or expired challenge before any Redis connection", async () => {
  const target = endpoint("target", true);
  const identity = remoteIdentity();
  const challenge = { schemaVersion: 1, nonce: "a".repeat(64), domain: "core", intentSha256: "b".repeat(64),
    sourceFenceSha256: "c".repeat(64), targetBindingSha256: redisGateBindingSha256(target), identity,
    issuedAt: Date.now() - 100, expiresAt: Date.now() + 60000 };
  const calls = [];
  const options = { binding: target, credentials: { password: randomBytes(32).toString("base64"), tlsCa: null },
    challenge, identity: { ...identity, probeSha256: "0".repeat(64) }, signal: new AbortController().signal,
    createClient: probeClient(target, calls) };
  await assert.rejects(runRedisTargetProbe(options), { code: "REDIS_REMOTE_PROBE_BINDING_MISMATCH" });
  options.identity = identity; options.challenge = { ...challenge, issuedAt: Date.now() - 1000, expiresAt: Date.now() - 1 };
  await assert.rejects(runRedisTargetProbe(options), { code: "REDIS_REMOTE_CHALLENGE_EXPIRED" });
  assert.deepEqual(calls, []);
});

test("remote dispatcher deadline rejects hanging readback and closes only owned local clients", async () => {
  const f = remoteFixture();
  let dispatchSignal;
  f.options.remoteTimeoutMs = 25;
  f.options.remoteTarget.runProbe = ({ signal }) => { dispatchSignal = signal; return new Promise(() => {}); };
  await assert.rejects(assertOpsCoreRedisEmpty(f.options), { code: "REDIS_REMOTE_TIMEOUT" });
  assert.equal(dispatchSignal.aborted, true);
  assert.deepEqual(f.state.destroyed, ["source"]);
});

test("remote receipt expiring during final source rescan cannot become acceptance", async () => {
  const f = remoteFixture({ reply({ name, args, count }) {
    if (name === "source" && args[0] === "SCAN" && count === 2) return delay(120).then(() => ["0", []]);
  } });
  f.options.remoteTimeoutMs = 100;
  await assert.rejects(assertOpsCoreRedisEmpty(f.options), { code: "REDIS_REMOTE_CHALLENGE_EXPIRED" });
});
