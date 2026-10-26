import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { test } from "node:test";

// Like ops-core/infra.node-test.mjs, inspect compiled ARM, not Bicep source text.
// Use an installed standalone compiler; never restore modules or contact Azure.
const template = JSON.parse(execFileSync(process.env.BICEP_CLI_PATH || "bicep", [
  "build", fileURLToPath(new URL("./monitor.bicep", import.meta.url)), "--stdout", "--no-restore",
], { encoding: "utf8", timeout: 60_000, maxBuffer: 4 * 1024 * 1024 }));

function monitorJob() {
  const resources = Object.values(template.resources);
  assert.equal(resources.length, 1);
  const job = resources[0];
  assert.equal(job.type, "Microsoft.App/jobs");
  assert.equal(job.condition, undefined);
  assert.equal(job.copy, undefined);
  return job;
}

function monitorContainer() {
  const runtime = monitorJob().properties.template;
  assert.equal(runtime.containers.length, 1);
  assert.equal(runtime.initContainers, undefined);
  return runtime.containers[0];
}

test("bootstrap is a bounded Manual job with no scheduled or event execution", () => {
  const config = monitorJob().properties.configuration;
  assert.equal(config.triggerType, "Manual");
  assert.equal(config.scheduleTriggerConfig, undefined);
  assert.equal(config.eventTriggerConfig, undefined);
  assert.deepEqual(config.manualTriggerConfig, { parallelism: 1, replicaCompletionCount: 1 });
  assert.equal(config.replicaRetryLimit, 0);
  assert.equal(config.replicaTimeout, 600);
});

test("bootstrap overrides the image command with dry-run and has no incident credentials", () => {
  const job = monitorJob();
  const container = monitorContainer();
  assert.deepEqual(container.command, ["node", "/app/scripts/ops/health-sweep.mjs"]);
  assert.deepEqual(container.args, ["--dry-run"]);
  assert.deepEqual(container.env, [
    { name: "OPS_HEALTH_TARGETS_JSON", value: "[string(parameters('healthTargets'))]" },
    { name: "OPS_CREATE_GITHUB_ISSUES", value: "false" },
  ]);
  assert.equal(job.properties.configuration.secrets, undefined);
  assert.deepEqual(job.properties.configuration.registries, [{
    server: "[parameters('registryServer')]", identity: "[parameters('identityResourceId')]",
  }]);
});

test("effective bootstrap command parses synthetic targets without probes or issue subprocesses", () => {
  const container = monitorContainer();
  const targets = [
    { name: "fixture-site", service: "site", url: "https://monitor-fixture.invalid/api/health", expectJson: { status: "ok" } },
    { name: "fixture-demo", service: "demo", url: "https://monitor-fixture.invalid/demo" },
  ];
  // Resolve only this asserted parameter binding; unsupported expressions fail.
  const env = Object.fromEntries(container.env.map(({ name, value }) => {
    if (name === "OPS_HEALTH_TARGETS_JSON") {
      assert.equal(value, "[string(parameters('healthTargets'))]");
      return [name, JSON.stringify(targets)];
    }
    assert.equal(typeof value, "string");
    assert.equal(value.startsWith("["), false);
    return [name, value];
  }));
  // Fail before any request or subprocess can run, even if dry-run regresses.
  const guard = `
    import childProcess from "node:child_process";
    import { syncBuiltinESMExports } from "node:module";
    const forbidden = () => {
      process.exitCode = 99;
      console.error("Unexpected monitor probe or subprocess");
      throw new Error("Unexpected monitor probe or subprocess");
    };
    globalThis.fetch = forbidden;
    childProcess.spawnSync = forbidden;
    syncBuiltinESMExports();
  `;
  assert.deepEqual(container.command, ["node", "/app/scripts/ops/health-sweep.mjs"]);
  const script = fileURLToPath(new URL("../../../scripts/ops/health-sweep.mjs", import.meta.url));
  const output = JSON.parse(execFileSync(process.execPath, [
    "--import", `data:text/javascript,${encodeURIComponent(guard)}`, script, ...container.args,
  ], { env, encoding: "utf8", timeout: 10_000, maxBuffer: 1024 * 1024 }));
  assert.equal(output.dryRun, true);
  assert.deepEqual(output.targets.map(({ name, service, url }) => ({ name, service, url })),
    targets.map(({ name, service, url }) => ({ name, service, url })));
  assert.deepEqual(output.results, targets.map(({ name }) => ({
    name, ok: true, status: "dry-run", elapsedMs: 0, httpStatus: null, attempts: 0,
  })));
  assert.deepEqual(output.controlPlane, { customers: 0, incidents: 0 });
  assert.deepEqual(output.incidents, []);
  assert.equal(output.publishedIncidents, 0);
});
