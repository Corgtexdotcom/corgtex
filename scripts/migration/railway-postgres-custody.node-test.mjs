import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { test } from "node:test";
import { createRailwayPostgresCustody, createRailwayPostgresRemoteRead,
  railwayPostgresCustodyDiagnostic } from "./railway-postgres-custody.mjs";

const id = value => `00000000-0000-4000-8000-${String(value).padStart(12, "0")}`;
const binding = () => ({ domain: "core", projectId: id(1), environmentId: id(2), serviceId: id(3),
  deploymentId: id(4), instanceId: id(5), sourceImage: "ghcr.io/railwayapp-templates/postgres-ssl:18",
  startCommand: null, preDeployCommand: [], dataDirectory: "/var/lib/postgresql/data/pgdata",
  systemIdentifier: "7000000000000000001", files: [
    { path: "/usr/local/bin/docker-entrypoint.sh", sha256: "a".repeat(64) },
    // Synthetic fixture paths; production must supply the actually inspected set.
    { path: "/fixture/wrapper.sh", sha256: "b".repeat(64) },
    { path: "/fixture/watcher.sh", sha256: "c".repeat(64) },
    { path: "/fixture/archive.sh", sha256: "d".repeat(64) },
  ] });
const provider = b => ({ environment: { id: b.environmentId, projectId: b.projectId },
  serviceInstance: { serviceId: b.serviceId, environmentId: b.environmentId,
    service: { id: b.serviceId, projectId: b.projectId }, source: { image: b.sourceImage, repo: null },
    startCommand: null, preDeployCommand: [], activeDeployments: [{
      id: b.deploymentId, projectId: b.projectId, environmentId: b.environmentId, serviceId: b.serviceId,
      status: "SUCCESS", deploymentStopped: false, instances: [{ id: b.instanceId, status: "RUNNING" }],
    }] } });
const identity = b => ({ user: "postgres", sessionUser: "postgres", database: "postgres", serverVersionNum: 180006,
  dataDirectory: b.dataDirectory, readOnly: "on", inRecovery: false, passwordEncryption: "scram-sha-256",
  superuser: true, systemIdentifier: b.systemIdentifier, unixSocket: true });
const remote = (b, value = identity(b), files = b.files, major = "18") => `RAILWAY_PG_CUSTODY_FILES_V1\n${files.map(file => `${file.sha256}  ${file.path}`).join("\n")}\nRAILWAY_PG_CUSTODY_VERSION_V1\n${major}\n\nRAILWAY_PG_CUSTODY_IDENTITY_V1\n${JSON.stringify(value)}\n`;
function fixture({ mutateProvider, mutateIdentity, remoteOutput, remoteRead } = {}) {
  const b = binding();
  const controller = new AbortController();
  const calls = [];
  let reads = 0;
  const adapter = createRailwayPostgresCustody({ binding: b, signal: controller.signal,
    async transport(request) {
      calls.push("provider");
      assert.match(request.query, /^query PostgresCustody/);
      assert.equal(/mutation|config\(|variables\s*\{|password|credential/i.test(request.query), false);
      assert.deepEqual(request.variables, { projectId: b.projectId, environmentId: b.environmentId, serviceId: b.serviceId });
      const result = provider(b);
      mutateProvider?.(result, ++reads);
      return result;
    }, async runRemoteRead(request) {
      calls.push("remote");
      assert.deepEqual(request.binding.files, [...b.files].sort((a, c) => a.path.localeCompare(c.path)));
      if (remoteRead) return remoteRead(request);
      const value = identity(b); mutateIdentity?.(value);
      return remoteOutput ?? remote(b, value);
    },
  });
  return { b, controller, calls, adapter };
}

test("binds immutable canonical files and checks provider before and after the single local recovery read", async () => {
  const f = fixture();
  const receipt = await f.adapter.assertHeld();
  assert.deepEqual(f.calls, ["provider", "remote", "provider"]);
  assert.deepEqual(receipt, { status: "RAILWAY_POSTGRES_CUSTODY_HELD", domain: "core", systemIdentifier: f.b.systemIdentifier,
    bindingSha256: f.adapter.bindingSha256, deploymentId: f.b.deploymentId, instanceId: f.b.instanceId,
    localReadOnlyRecoveryVerified: true, initializedMajor: 18 });
  assert.match(f.adapter.bindingSha256, /^[a-f0-9]{64}$/);
  const reversed = createRailwayPostgresCustody({ binding: { ...f.b, files: [...f.b.files].reverse() },
    signal: f.controller.signal, transport: async () => {}, runRemoteRead: async () => {} });
  assert.equal(reversed.bindingSha256, f.adapter.bindingSha256);
  f.b.files[0].sha256 = "f".repeat(64);
  assert.equal(f.adapter.binding.files.find(file => file.path.endsWith("docker-entrypoint.sh")).sha256, "a".repeat(64));
  assert.throws(() => { f.adapter.binding.files[0].sha256 = "f".repeat(64); }, TypeError);
});

test("accepts the live API null representation of no predeploy commands", async () => {
  const f = fixture({ mutateProvider: data => { data.serviceInstance.preDeployCommand = null; } });
  assert.equal((await f.adapter.assertHeld()).localReadOnlyRecoveryVerified, true);
});

for (const [name, change, code] of [
  ["foreign environment", data => { data.environment.id = id(9); }, "PROVIDER_BINDING_CHANGED"],
  ["foreign project", data => { data.serviceInstance.service.projectId = id(9); }, "PROVIDER_BINDING_CHANGED"],
  ["foreign service", data => { data.serviceInstance.serviceId = id(9); }, "PROVIDER_BINDING_CHANGED"],
  ["source image changed", data => { data.serviceInstance.source.image += "-changed"; }, "STARTUP_CHANGED"],
  ["repository replaces image", data => { data.serviceInstance.source.repo = "fixture/repo"; }, "STARTUP_CHANGED"],
  ["start command changed", data => { data.serviceInstance.startCommand = "custom-entrypoint"; }, "STARTUP_CHANGED"],
  ["predeploy command changed", data => { data.serviceInstance.preDeployCommand = ["custom-predeploy"]; }, "STARTUP_CHANGED"],
  ["missing deployment", data => { data.serviceInstance.activeDeployments = []; }, "ACTIVE_DEPLOYMENT_CHANGED"],
  ["multiple deployments", data => { data.serviceInstance.activeDeployments.push(structuredClone(data.serviceInstance.activeDeployments[0])); }, "ACTIVE_DEPLOYMENT_CHANGED"],
  ["swapped deployment", data => { data.serviceInstance.activeDeployments[0].id = id(9); }, "DEPLOYMENT_CHANGED"],
  ["deployment environment changed", data => { data.serviceInstance.activeDeployments[0].environmentId = id(9); }, "DEPLOYMENT_CHANGED"],
  ["deploying revision", data => { data.serviceInstance.activeDeployments[0].status = "DEPLOYING"; }, "DEPLOYMENT_CHANGED"],
  ["stopped deployment", data => { data.serviceInstance.activeDeployments[0].deploymentStopped = true; }, "DEPLOYMENT_CHANGED"],
  ["swapped instance", data => { data.serviceInstance.activeDeployments[0].instances[0].id = id(9); }, "INSTANCE_CHANGED"],
  ["missing instance", data => { data.serviceInstance.activeDeployments[0].instances = []; }, "INSTANCE_CHANGED"],
  ["multiple instances", data => { data.serviceInstance.activeDeployments[0].instances.push({ id: id(9), status: "RUNNING" }); }, "INSTANCE_CHANGED"],
  ["restarting instance", data => { data.serviceInstance.activeDeployments[0].instances[0].status = "RESTARTING"; }, "INSTANCE_CHANGED"],
]) {
  test(`denies ${name} before remote execution`, async () => {
    const f = fixture({ mutateProvider: change });
    await assert.rejects(f.adapter.assertHeld(), { code: `RAILWAY_PG_${code}` });
    assert.deepEqual(f.calls, ["provider"]);
  });
}

test("rejects an instance transition during the remote probe", async () => {
  const f = fixture({ mutateProvider(data, read) { if (read === 2) data.serviceInstance.activeDeployments[0].instances[0].id = id(9); } });
  await assert.rejects(f.adapter.assertHeld(), { code: "RAILWAY_PG_INSTANCE_CHANGED" });
  assert.deepEqual(f.calls, ["provider", "remote", "provider"]);
});

test("retains inactive instance history while requiring exactly one expected running instance", async () => {
  const f = fixture({ mutateProvider(data) {
    data.serviceInstance.activeDeployments[0].instances.push({ id: id(9), status: "STOPPED" });
  } });
  assert.equal((await f.adapter.assertHeld()).instanceId, f.b.instanceId);
});

for (const [field, changed] of [["user", "reader"], ["sessionUser", "reader"], ["database", "railway"],
  ["serverVersionNum", 170009], ["dataDirectory", "/different"], ["readOnly", "off"], ["inRecovery", true],
  ["passwordEncryption", "md5"], ["superuser", false], ["systemIdentifier", "7000000000000000002"], ["unixSocket", false]]) {
  test(`rejects changed local ${field}`, async () => {
    const f = fixture({ mutateIdentity(value) { value[field] = changed; } });
    await assert.rejects(f.adapter.assertHeld(), { code: "RAILWAY_PG_LOCAL_IDENTITY_CHANGED" });
    assert.deepEqual(f.calls, ["provider", "remote"]);
  });
}

for (const [name, output, code] of [
  ["missing initialized marker", "", "REMOTE_RESPONSE_INVALID"],
  ["wrong initialized major", remote(binding(), identity(binding()), binding().files, "17"), "INITIALIZED_MARKER_CHANGED"],
  ["empty initialized marker", remote(binding(), identity(binding()), binding().files, ""), "INITIALIZED_MARKER_CHANGED"],
  ["changed file hash", remote(binding(), identity(binding()), binding().files.map((file, index) => index ? file : { ...file, sha256: "f".repeat(64) })), "FILE_CUSTODY_CHANGED"],
  ["missing helper", remote(binding(), identity(binding()), binding().files.slice(1)), "FILE_CUSTODY_CHANGED"],
  ["duplicate helper", remote(binding(), identity(binding()), [binding().files[0], binding().files[0], ...binding().files.slice(2)]), "FILE_CUSTODY_CHANGED"],
  ["oversized output", "x".repeat(64 * 1024 + 1), "REMOTE_RESPONSE_INVALID"],
]) {
  test(`denies ${name}`, async () => {
    await assert.rejects(fixture({ remoteOutput: output }).adapter.assertHeld(), { code: `RAILWAY_PG_${code}` });
  });
}

test("explicit SSH instance binding and remote shell quoting preserve the intended read-only script", async () => {
  let recorded;
  const run = createRailwayPostgresRemoteRead({ execFileImpl(executable, args, options, callback) {
    recorded = { executable, args, options }; callback(null, "safe-output", "ignored stderr");
  } });
  const b = binding();
  const signal = new AbortController().signal;
  assert.equal(await run({ binding: b, signal }), "safe-output");
  assert.equal(recorded.executable, "railway");
  assert.deepEqual(recorded.args.slice(0, 12), ["ssh", "-p", b.projectId, "-e", b.environmentId,
    "-s", b.serviceId, "-d", b.instanceId, "--", "sh", "-c"]);
  assert.equal(recorded.options.shell, false);
  assert.equal(recorded.options.signal, signal);
  assert.equal(recorded.options.timeout, 30_000);
  // Parse exactly as Railway's joined remote argv would be parsed, but do not
  // execute the script or any provider command. $3 is the sh -c script argument.
  const parsed = spawnSync("sh", ["-c", `set -- ${recorded.args.slice(10).join(" ")}; printf '%s' "$3"`], { encoding: "utf8" });
  assert.equal(parsed.status, 0);
  const script = parsed.stdout;
  assert.match(script, /^set -eu\n/);
  assert.match(script, /env -i PATH=\/usr\/local\/sbin/);
  assert.match(script, /PGPASSFILE=\/nonexistent/);
  assert.match(script, /default_transaction_read_only=on/);
  assert.match(script, /psql -X -w -h \/var\/run\/postgresql -p 5432 -U postgres -d postgres/);
  const parsedSql = spawnSync("sh", ["-c", `set -- ${script.slice(script.indexOf("env -i "))}; for arg do last=$arg; done; printf '%s' "$last"`], { encoding: "utf8" });
  assert.equal(parsedSql.status, 0);
  assert.match(parsedSql.stdout, /^SELECT json_build_object\(/);
  assert.match(parsedSql.stdout, /'user',current_user/);
  assert.match(parsedSql.stdout, /'unixSocket',inet_client_addr\(\) IS NULL\);$/);
  assert.match(script, /sha256sum -- '\/fixture\/archive.sh'/);
  assert.equal(/PGPASSWORD|ALTER |UPDATE |DELETE |INSERT |CREATE |DROP |pg_authid|rolpassword/.test(script), false);
});

for (const path of ["/fixture/$(touch injected)", "/fixture/helper';echo bad", "/fixture/../helper", "/fixture/a\nb", "//fixture/helper"]) {
  test("rejects unsafe or noncanonical file path before CLI dispatch", () => {
    const b = binding(); b.files[1].path = path;
    assert.throws(() => createRailwayPostgresCustody({ binding: b, signal: new AbortController().signal,
      transport() {}, runRemoteRead() {} }), { code: "RAILWAY_PG_FILES_INVALID" });
  });
}

test("rejects injected IDs, omitted file custody, unknown binding fields, and unobserved profiles", () => {
  for (const mutate of [b => { b.instanceId += ";echo bad"; }, b => { b.files = []; },
    b => { b.password = randomBytes(16).toString("hex"); }, b => { b.startCommand = "postgres"; },
    b => { b.preDeployCommand = null; }, b => { b.sourceImage = "different:18"; }]) {
    const b = binding(); mutate(b);
    assert.throws(() => createRailwayPostgresCustody({ binding: b, signal: new AbortController().signal,
      transport() {}, runRemoteRead() {} }), { code: "RAILWAY_PG_BINDING_INVALID" });
  }
});

test("does not include provider extras or remote identity extras in receipt", async () => {
  const secret = randomBytes(32).toString("base64");
  const f = fixture({ mutateProvider(data) { data.password = secret; }, mutateIdentity(value) { value.password = secret; } });
  assert.equal(JSON.stringify(await f.adapter.assertHeld()).includes(secret), false);
});

test("suppresses raw provider, remote executor, and malformed-response errors", async () => {
  const secret = randomBytes(32).toString("base64");
  const signal = new AbortController().signal;
  for (const options of [{ transport() { throw new Error(secret); } },
    { transport: async () => provider(binding()), runRemoteRead() { throw new Error(secret); } },
    { transport: async () => provider(binding()), runRemoteRead: async () => secret }]) {
    const adapter = createRailwayPostgresCustody({ binding: binding(), signal, ...options });
    await assert.rejects(adapter.assertHeld(), error => {
      assert.ok(railwayPostgresCustodyDiagnostic(error));
      assert.equal(`${error.stack}${JSON.stringify(error)}`.includes(secret), false);
      assert.equal(error.cause, undefined); return true;
    });
  }
  const run = createRailwayPostgresRemoteRead({ execFileImpl(command, args, options, callback) { callback(new Error(secret)); } });
  await assert.rejects(run({ binding: binding(), signal }), { code: "RAILWAY_PG_REMOTE_READ_FAILED" });
});

test("checks abort before dispatch and after remote read", async () => {
  const f = fixture(); f.controller.abort(new Error("private abort cause"));
  await assert.rejects(f.adapter.assertHeld(), { code: "RAILWAY_PG_CUSTODY_ABORTED" });
  assert.deepEqual(f.calls, []);
  const later = fixture({ remoteRead() { later.controller.abort(); return remote(later.b); } });
  await assert.rejects(later.adapter.assertHeld(), { code: "RAILWAY_PG_CUSTODY_ABORTED" });
  assert.deepEqual(later.calls, ["provider", "remote"]);
});
