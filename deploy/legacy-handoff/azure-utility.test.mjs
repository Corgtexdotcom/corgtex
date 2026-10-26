import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn, execFileSync } from "node:child_process";
import { mkdtemp, writeFile, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { once } from "node:events";
import http from "node:http";
import { prepareAzureHandoff, digest } from "./azure-utility.mjs";

const baseline = { revisionSuffix: "frozen", containers: [{ name: "web",
  image: `registry.example/web@sha256:${"a".repeat(64)}`, command: ["node"], args: ["-e", "reviewed frozen utility"],
  env: [{ name: "DATABASE_URL", secretRef: "retained-database" }],
  probes: [{ type: "Readiness", httpGet: { path: "/api/health", port: 3000 } }], resources: { cpu: 0.25, memory: "0.5Gi" } }],
  scale: { minReplicas: 1, maxReplicas: 1 } };
const health = { status: "ok", mode: "source-freeze-utility", applicationWrites: false,
  businessWorker: false, role: "web", proofSha256: "b".repeat(64) };
const input = () => ({ baseline: structuredClone(baseline), expectedTemplateSha256: digest(baseline),
  expectedCommandSha256: digest({ command: baseline.containers[0].command, args: baseline.containers[0].args }),
  health, healthPaths: ["/api/health"], hostname: "chirone.corgtex.com",
  resourceId: "/subscriptions/11111111-1111-4111-8111-111111111111/resourceGroups/example/providers/Microsoft.App/containerApps/ca-corgtex-chirone-prod-web",
  observedAt: new Date().toISOString() });

test("offline candidate changes only command/args and leaves the input untouched", () => {
  const value = input(), before = structuredClone(value.baseline), { candidate, summary } = prepareAzureHandoff(value);
  const restored = structuredClone(candidate);
  restored.containers[0].command = before.containers[0].command;
  restored.containers[0].args = before.containers[0].args;
  assert.deepEqual(restored, before);
  assert.deepEqual(value.baseline, before);
  assert.equal(summary.providerWrites, 0);
  assert.deepEqual(candidate.containers[0].command, ["/usr/bin/env", "-u", "NODE_OPTIONS", "-u", "NODE_PATH", "/usr/local/bin/node"]);
});

test("stale evidence, mutable image, worker health and unknown topology are refused", () => {
  for (const modify of [x => { x.expectedTemplateSha256 = "0".repeat(64); },
    x => { x.expectedCommandSha256 = "0".repeat(64); },
    x => { x.hostname = "unverified.example.com"; },
    x => { x.resourceId = x.resourceId.replace("chirone-prod-web", "chirone-prod-worker"); },
    x => { x.observedAt = "2020-01-01T00:00:00.000Z"; },
    x => { x.health = { ...health, applicationWrites: true }; },
    x => { x.health = { ...health, role: "worker" }; },
    x => { x.health = { ...health, token: "must-not-be-copied" }; },
    x => { x.healthPaths = ["/api/auth/callback"]; }]) {
    const value = input(); modify(value); assert.throws(() => prepareAzureHandoff(value), /HANDOFF_/);
  }
  for (const change of [x => { x.containers[0].image = "registry.example/web:latest"; },
    x => { x.containers.push(structuredClone(x.containers[0])); },
    x => { x.initContainers = [{ name: "migrate", command: ["npm"], args: ["run", "migrate"] }]; },
    x => { x.initContainers = null; }, x => { x.initContainers = {}; }]) {
    const value = input(); change(value.baseline); value.expectedTemplateSha256 = digest(value.baseline);
    assert.throws(() => prepareAzureHandoff(value), /HANDOFF_/);
  }
});

test("actual serialized Node utility redirects safely, preserves health and keeps protocols frozen", async () => {
  const { candidate } = prepareAzureHandoff(input());
  const child = spawn(process.execPath, candidate.containers[0].args, {
    env: { PATH: process.env.PATH, PORT: "0" }, stdio: ["ignore", "pipe", "pipe"],
  });
  let errors = ""; child.stderr.on("data", chunk => { errors += chunk; });
  try {
    const port = await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`utility did not start: ${errors}`)), 5000);
      child.once("exit", () => { clearTimeout(timer); reject(new Error(`utility exited: ${errors}`)); });
      child.stdout.on("data", chunk => { const match = String(chunk).match(/HANDOFF_LISTENING:(\d+)/); if (match) { clearTimeout(timer); resolve(match[1]); } });
    });
    const get = (path, method = "GET", host = "chirone.corgtex.com") => new Promise((resolve, reject) => {
      const req = http.request({ hostname: "127.0.0.1", port, path, method,
        headers: { host, accept: "text/html" } }, res => {
        let body = ""; res.setEncoding("utf8"); res.on("data", chunk => { body += chunk; });
        res.on("end", () => resolve(new Response(method === "HEAD" ? null : body, { status: res.statusCode, headers: res.headers })));
      });
      req.on("error", reject); req.end();
    });
    const redirect = await get("/en/workspaces/a928241f-39c9-43a3-8540-b4325d5ea068/actions/old?code=secret&next=https://evil.example");
    assert.equal(redirect.status, 302); assert.equal(redirect.headers.get("location"), "https://selfserve.corgtex.com/#");
    assert.equal(redirect.headers.get("referrer-policy"), "no-referrer");
    for (const section of ["chat", "agents", "agents/old-agent", "decisions", "tools", "maps"]) {
      for (const method of ["GET", "HEAD"]) {
        const result = await get(`/es/workspaces/a928241f-39c9-43a3-8540-b4325d5ea068/${section}?token=secret`, method);
        assert.equal(result.status, 302, `${method} ${section}`);
        assert.equal(result.headers.get("location"), "https://selfserve.corgtex.com/#");
      }
    }
    assert.deepEqual(await (await get("/api/health", "GET", "internal-probe")).json(), health);
    assert.equal((await get("/api/health", "HEAD")).status, 200);
    assert.equal(await (await get("/", "HEAD")).text(), "");
    for (const [path, method] of [["/", "POST"], ["/api/health", "POST"], ["/api/auth/callback?code=secret", "GET"],
      ["/mcp", "POST"], ["/api/webhooks/provider", "POST"], ["/api/session", "GET"], ["/healthz", "GET"]]) {
      const result = await get(path, method); assert.equal(result.status, 503, `${method} ${path}`);
      assert.equal(result.headers.get("location"), null); assert.equal((await result.json()).applicationWrites, false);
    }
    assert.equal((await get("/", "GET", "unverified.example.com")).status, 503);
  } finally { child.kill("SIGTERM"); if (child.exitCode === null) await once(child, "exit"); }
});

test("every retained HTTP probe must use a reviewed served health path", () => {
  for (const type of ["Readiness", "Liveness", "Startup"]) {
    for (const httpGet of [{ path: "/api/health", port: 3000 }, { port: 3000 }, { path: "/", port: 3000 }, null]) {
      const value = input();
      value.healthPaths = ["/healthz"];
      value.baseline.containers[0].probes = [{ type, httpGet }];
      value.expectedTemplateSha256 = digest(value.baseline);
      assert.throws(() => prepareAzureHandoff(value), /HANDOFF_RETAINED_PROBE_PATH_NOT_SERVED/, `${type} ${JSON.stringify(httpGet)}`);
    }
  }
  const value = input();
  value.healthPaths = ["/api/health", "/healthz"];
  value.baseline.containers[0].probes.push({ type: "Liveness", httpGet: { path: "/healthz", port: 3000 } },
    { type: "Startup", tcpSocket: { port: 3000 } });
  value.expectedTemplateSha256 = digest(value.baseline);
  assert.deepEqual(prepareAzureHandoff(value).candidate.containers[0].probes, value.baseline.containers[0].probes);
});

test("evidence cannot override the preparation clock", () => {
  const value = input();
  value.observedAt = "2020-01-01T00:00:00.000Z";
  value.now = Date.parse(value.observedAt);
  assert.throws(() => prepareAzureHandoff(value), /HANDOFF_FRESH_BASELINE_REQUIRED/);
});

test("CLI refuses stale evidence even when it supplies a matching now field", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "handoff-stale-test-"));
  const inputPath = path.join(directory, "input.json"), outputPath = path.join(directory, "plan.json");
  try {
    const value = input();
    value.observedAt = "2020-01-01T00:00:00.000Z";
    value.now = Date.parse(value.observedAt);
    await writeFile(inputPath, JSON.stringify(value), { mode: 0o600 });
    const cli = fileURLToPath(new URL("../../scripts/prepare-legacy-azure-handoff.mjs", import.meta.url));
    assert.throws(() => execFileSync(process.execPath, [cli, inputPath, outputPath], { stdio: "pipe" }),
      error => error.status === 1 && error.stderr.toString().trim() === "HANDOFF_FRESH_BASELINE_REQUIRED");
    await assert.rejects(stat(outputPath), { code: "ENOENT" });
  } finally { await rm(directory, { recursive: true, force: true }); }
});


test("offline CLI emits only a new private command delta, never baseline environment values", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "handoff-test-"));
  const inputPath = path.join(directory, "input.json"), outputPath = path.join(directory, "plan.json");
  try {
    const value = input();
    value.baseline.containers[0].env.push({ name: "EXAMPLE_PRIVATE_VALUE", value: "synthetic-private-sentinel" });
    value.expectedTemplateSha256 = digest(value.baseline);
    await writeFile(inputPath, JSON.stringify(value), { mode: 0o600 });
    const cli = fileURLToPath(new URL("../../scripts/prepare-legacy-azure-handoff.mjs", import.meta.url));
    const stdout = execFileSync(process.execPath, [cli, inputPath, outputPath], { encoding: "utf8" });
    const saved = await readFile(outputPath, "utf8"), artifact = JSON.parse(saved);
    assert.deepEqual(Object.keys(artifact).sort(), ["containerCommandDelta", "summary"]);
    assert.equal(saved.includes("synthetic-private-sentinel"), false);
    assert.equal(stdout.includes("synthetic-private-sentinel"), false);
    assert.equal((await stat(outputPath)).mode & 0o777, 0o600);
    assert.throws(() => execFileSync(process.execPath, [cli, inputPath, outputPath], { stdio: "pipe" }));
    assert.equal(await readFile(outputPath, "utf8"), saved);
  } finally { await rm(directory, { recursive: true, force: true }); }
});
