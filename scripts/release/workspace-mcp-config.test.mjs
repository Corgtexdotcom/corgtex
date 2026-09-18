import { describe, it, expect } from "vitest";
import { readFileSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parse } from "yaml";
import { TARGET, FLAG, appName, validateInputs, assertIdentity, configHash, revisionTemplateHash, assertFleet, assertRuntime, runConfig } from "./workspace-mcp-config.mjs";
import { acceptance, createAzureIO, inputsFromEnv, parseRuntimeOutput, runtimeProbeSource } from "./workspace-mcp-config-azure.mjs";
import { productionAppReleaseRelevantPath } from "../production-validation-context.mjs";

const sha = "d".repeat(40);
const input = () => ({ operation: "activate", acceptedSha: sha, workflowSha: "e".repeat(40), runId: "123456", attempt: "1", writerAcknowledged: "true",
  images: { web: `${TARGET.server}/corgtex/web@sha256:${"a".repeat(64)}`, worker: `${TARGET.server}/corgtex/worker@sha256:${"b".repeat(64)}` },
  baselines: { web: `${appName("web")}--0000109`, worker: `${appName("worker")}--0000095` } });
const health = role => ({ status: "ok", service: role, database: "up", schema: "ready", phase: "running", lastError: null, lastSuccessfulTickAt: new Date().toISOString(),
  release: { gitSha: sha, runtime: { gitSha: sha, source: "baked", evidence: "baked" }, drift: { gitSha: false, imageTag: false, version: false, details: [] } } });
function model(options = {}) {
  const args = input(); Object.assign(args, options.input);
  const apps = {}, revisions = {}, events = [], receipts = [];
  for (const role of ["web", "worker"]) {
    const revision = args.baselines[role];
    apps[role] = { id: `/subscriptions/${TARGET.subscription}/resourceGroups/${TARGET.group}/providers/Microsoft.App/containerApps/${appName(role)}`, name: appName(role), location: "westus3",
      identity: { type: "UserAssigned", userAssignedIdentities: { existing: {} } }, tags: { retained: "yes" }, properties: {
        configuration: { activeRevisionsMode: "Single", ingress: role === "web" ? { external: true, traffic: [{ latestRevision: true, weight: 100 }] } : null, secrets: [{ name: "existing-secret" }] },
        latestRevisionName: revision, latestReadyRevisionName: revision, provisioningState: "Succeeded", managedEnvironmentId: "existing-environment",
        template: { revisionSuffix: "previous", scale: { minReplicas: 1, maxReplicas: 1 }, containers: [{ name: role, image: `${TARGET.server}/corgtex/${role}:sha-${sha}`,
          resources: { cpu: 0.75, memory: "1.5Gi" }, env: [{ name: "SECRET", value: "PRIVATE_NOT_EVIDENCE" }, { name: "REF", secretRef: "existing-secret" }, { name: FLAG, value: String(options.enabled || false) }] }] } } };
    revisions[role] = [{ name: revision, properties: { active: true, runningState: "Running", healthState: "Healthy", replicas: 1 } },
      { name: `${appName(role)}--old`, properties: { active: false, runningState: "Stopped", healthState: "Healthy", replicas: 0 } }];
  }
  const io = {
    save(r) { receipts.push(structuredClone(r)); },
    async identity() { events.push("identity"); if (options.badIdentity) throw Error("AZURE_IDENTITY_MISMATCH"); },
    async source() { events.push("source"); if (options.badSource) throw Error("SOURCE_COMPATIBILITY_REVIEW_REQUIRED"); },
    async digest(role) { return options.badDigest ? "sha256:wrong" : args.images[role].split("@")[1]; },
    async app(role) { events.push(`app:${role}`); return structuredClone(apps[role]); },
    async revisions(role) { events.push(`revisions:${role}`); return structuredClone(revisions[role]); },
    async revision(role, revision) { return { name: revision, properties: { template: structuredClone(apps[role].properties.template) } }; },
    async replicas(role, revision) { return [{ name: `${revision}-replica`, properties: { containers: [{ name: role, ready: true, runningState: "Running", restartCount: 0 }] } }]; },
    async runtime(role, revision) {
      events.push(`runtime:${role}:${revision}`);
      if (options.workerUnhealthy && role === "worker") throw Error("WORKER_HEALTH_INVALID");
      return { build: { schemaVersion: 1, role, gitSha: sha }, flag: apps[role].properties.template.containers[0].env.find(e => e.name === FLAG).value === "true",
        origin: TARGET.origin, status: 200, health: health(role) };
    },
    async update(role, suffix, image, flag) {
      events.push(`write:${role}:${flag}`);
      expect(receipts.at(-1).intents.at(-1).state).toBe("WRITE_INTENT_RECONCILE_IF_UNCERTAIN");
      if (options.writeFailure === role) throw Error("PROVIDER_COMMAND_FAILED_RECONCILE");
      const p = apps[role].properties, revision = `${appName(role)}--${suffix}`;
      p.latestRevisionName = revision; p.latestReadyRevisionName = revision;
      p.template.revisionSuffix = suffix; p.template.containers[0].image = image;
      p.template.containers[0].env.find(e => e.name === FLAG).value = String(flag);
      for (const r of revisions[role]) Object.assign(r.properties, { active: false, runningState: "Stopped", replicas: 0 });
      revisions[role].push({ name: revision, properties: { active: true, runningState: "Running", healthState: "Healthy", replicas: 1 } });
      if (options.afterWrite) options.afterWrite({ role, apps, revisions });
      return { revision, image };
    },
    async wait(role) { events.push(`wait:${role}`); },
    async settle(prove) { await prove(); },
    async reconcile(role, revision) { events.push(`reconcile:${role}:${revision}`); return { intendedRevisionPresent: revisions[role].some(r => r.name === revision), terminalOperationProved: false }; },
    async acceptance(enabled) { events.push(`acceptance:${enabled}`); if (options.acceptanceFailure && enabled) throw Error("CANONICAL_AUTH_BOUNDARY_FAILED"); },
  };
  return { args, apps, revisions, events, receipts, io };
}

describe("governed MCP config sequence", () => {
  function providerViews() {
    const m = model({ input: { operation: "preflight" } });
    for (const app of Object.values(m.apps)) {
      app.properties.workloadProfileName = "Consumption";
      const template = app.properties.template;
      template.customMetricsSettings = null;
      Object.assign(template.scale, { cooldownPeriod: 300, pollingInterval: 30 });
      template.containers[0].imageType = "ContainerImage";
      template.containers[0].resources.ephemeralStorage = "4Gi";
      template.containers[0].env.find(e => e.secretRef).value = "";
    }
    m.io.revision = async (role, revision) => {
      const template = structuredClone(m.apps[role].properties.template);
      template.revisionSuffix = null;
      delete template.customMetricsSettings;
      Object.assign(template.scale, { cooldownPeriod: null, pollingInterval: null });
      delete template.containers[0].imageType;
      delete template.containers[0].resources.ephemeralStorage;
      delete template.containers[0].env.find(e => e.secretRef).value;
      return { name: revision, properties: { template } };
    };
    return m;
  }
  it("accepts observed app/revision provider defaults without any writes", async () => {
    const m = providerViews();
    expect((await runConfig(m.args, m.io)).status).toBe("PREFLIGHT_ONLY");
    expect(m.events.some(e => e.startsWith("write:"))).toBe(false);
  });
  it.each([
    ["secret reference", t => { t.containers[0].env.find(e => e.secretRef).secretRef = "different"; }],
    ["secret literal", t => { t.containers[0].env.find(e => e.secretRef).value = "unexpected"; }],
    ["plain environment", t => { t.containers[0].env[0].value = "changed"; }],
    ["CPU", t => { t.containers[0].resources.cpu = 0.5; }],
    ["memory", t => { t.containers[0].resources.memory = "2Gi"; }],
    ["storage", t => { t.containers[0].resources.ephemeralStorage = "8Gi"; }],
    ["cooldown", t => { t.scale.cooldownPeriod = 301; }],
    ["polling", t => { t.scale.pollingInterval = 31; }],
    ["image type", t => { t.containers[0].imageType = "Artifact"; }],
    ["metrics", t => { t.customMetricsSettings = { enabled: true }; }],
    ["unknown field", t => { t.unrecognized = true; }],
  ])("still rejects real revision %s drift", async (_name, change) => {
    const m = providerViews(), original = m.io.revision;
    m.io.revision = async (...args) => { const r = await original(...args); change(r.properties.template); return r; };
    await expect(runConfig(m.args, m.io)).rejects.toThrow("REVISION_CONFIG_DRIFT");
    expect(m.events.some(e => e.startsWith("write:"))).toBe(false);
  });
  it("normalizes only equivalent provider defaults in the preservation hash", () => {
    const app = providerViews().apps.worker;
    const original = configHash(app), other = structuredClone(app);
    delete other.properties.template.containers[0].resources.ephemeralStorage;
    expect(revisionTemplateHash(other)).toBe(revisionTemplateHash(app));
    expect(configHash(other)).toBe(original);
    other.properties.template.containers[0].resources.cpu = 0.5;
    expect(configHash(other)).not.toBe(original);
  });
  it("preserves secret definitions while accepting their ordering", () => {
    const app = model().apps.worker;
    app.properties.configuration.secrets = [{ name: "a", keyVaultUrl: "https://vault/a", identity: "existing" }, { name: "b" }];
    const hash = configHash(app);
    app.properties.configuration.secrets.reverse();
    expect(configHash(app)).toBe(hash);
    app.properties.configuration.secrets[1].keyVaultUrl = "https://vault/other";
    expect(configHash(app)).not.toBe(hash);
  });
  it("accepts provider default materialization after writes", async () => {
    const m = model({ afterWrite({ role, apps }) {
      const app = apps[role];
      app.properties.template.scale.cooldownPeriod = 300;
      app.properties.template.scale.pollingInterval = 30;
      app.properties.template.customMetricsSettings = null;
      app.properties.template.containers[0].imageType = "ContainerImage";
      app.properties.template.containers[0].env.find(e => e.secretRef).value = "";
    } });
    expect((await runConfig(m.args, m.io)).status).toBe("ACTIVATED");
  });
  function recovery(options = {}) {
    const args = input();
    args.operation = "complete-activation";
    args.baselines.worker = `${appName("worker")}--mcp-123455-1-worker`;
    const m = model({ ...options, input: args });
    m.apps.worker.properties.template.containers[0].env.find(e => e.name === FLAG).value = "true";
    return m;
  }
  it("completes reconciled activation with only a web write", async () => {
    const m = recovery();
    expect((await runConfig(m.args, m.io)).status).toBe("ACTIVATED");
    expect(m.events.filter(e => e.startsWith("write:"))).toEqual(["write:web:true"]);
    expect(m.receipts.at(-1).intents.map(i => i.role)).toEqual(["web"]);
  });
  it.each(["worker-off", "web-on", "old-worker-running", "worker-unhealthy", "unreconciled-baseline"])("rejects unsafe recovery: %s", async defect => {
    const m = recovery({ workerUnhealthy: defect === "worker-unhealthy" });
    if (defect === "worker-off") m.apps.worker.properties.template.containers[0].env.find(e => e.name === FLAG).value = "false";
    if (defect === "web-on") m.apps.web.properties.template.containers[0].env.find(e => e.name === FLAG).value = "true";
    if (defect === "old-worker-running") m.revisions.worker[1].properties.runningState = "Running";
    if (defect === "unreconciled-baseline") m.args.baselines.worker = `${appName("worker")}--0000096`;
    await expect(runConfig(m.args, m.io)).rejects.toThrow();
    expect(m.events.some(e => e.startsWith("write:"))).toBe(false);
  });
  it("does not infer storage for an unknown workload profile", () => {
    const app = providerViews().apps.worker;
    app.properties.workloadProfileName = "Other";
    const revision = structuredClone(app.properties.template);
    delete revision.containers[0].resources.ephemeralStorage;
    expect(revisionTemplateHash(app, revision)).not.toBe(revisionTemplateHash(app));
  });
  it("accepts a healthy RunningAtMaxScale worker baseline", async () => {
    const m = model();
    m.revisions.worker[0].properties.runningState = "RunningAtMaxScale";
    expect((await runConfig(m.args, m.io)).status).toBe("ACTIVATED");
    expect(m.events.filter(e => e.startsWith("write:"))).toEqual(["write:worker:true", "write:web:true"]);
  });
  it("accepts healthy RunningAtMaxScale after both updates with worker-first proof", async () => {
    const m = model({ afterWrite({ role, revisions }) { revisions[role].at(-1).properties.runningState = "RunningAtMaxScale"; } });
    const result = await runConfig(m.args, m.io);
    expect(result.status).toBe("ACTIVATED");
    expect(result.intents.every(x => x.state === "VERIFIED")).toBe(true);
    expect(m.events.filter(e => e.startsWith("write:"))).toEqual(["write:worker:true", "write:web:true"]);
    const between = m.events.slice(m.events.indexOf("write:worker:true") + 1, m.events.indexOf("write:web:true"));
    expect(between.filter(e => e.startsWith("runtime:worker:"))).toHaveLength(2);
    expect(m.events.lastIndexOf("revisions:worker")).toBeGreaterThan(m.events.lastIndexOf("acceptance:true"));
  });
  for (const state of ["Processing", "Activating", "Degraded", "Failed", "Stopped", "Unknown"]) it(`rejects active revision state ${state}`, async () => {
    const m = model(); m.revisions.worker[0].properties.runningState = state;
    await expect(runConfig(m.args, m.io)).rejects.toThrow("REVISION_NOT_READY");
    expect(m.events.some(e => e.startsWith("write:"))).toBe(false);
  });
  for (const defect of ["unhealthy", "zero-replicas", "old-not-stopped"]) it(`RunningAtMaxScale does not bypass ${defect}`, async () => {
    const m = model(); m.revisions.worker[0].properties.runningState = "RunningAtMaxScale";
    if (defect === "unhealthy") m.revisions.worker[0].properties.healthState = "Unhealthy";
    if (defect === "zero-replicas") m.revisions.worker[0].properties.replicas = 0;
    if (defect === "old-not-stopped") m.revisions.worker[1].properties.runningState = "RunningAtMaxScale";
    await expect(runConfig(m.args, m.io)).rejects.toThrow(defect === "old-not-stopped" ? "OLD_REVISION_NOT_STOPPED" : "REVISION_NOT_READY");
    expect(m.events.some(e => e.startsWith("write:"))).toBe(false);
  });
  it("activates worker then web with intervening worker and old-revision proof", async () => {
    const m = model(); const result = await runConfig(m.args, m.io);
    expect(result.status).toBe("ACTIVATED");
    expect(m.events.filter(e => e.startsWith("write:"))).toEqual(["write:worker:true", "write:web:true"]);
    const between = m.events.slice(m.events.indexOf("write:worker:true") + 1, m.events.indexOf("write:web:true"));
    expect(between.filter(e => e.startsWith("runtime:worker:"))).toHaveLength(2);
    expect(between.filter(e => e === "revisions:worker").length).toBeGreaterThanOrEqual(4);
    expect(m.events.lastIndexOf("revisions:worker")).toBeGreaterThan(m.events.lastIndexOf("acceptance:true"));
    expect(result.intents.every(x => x.state === "VERIFIED")).toBe(true);
    expect(JSON.stringify(m.receipts)).not.toContain("PRIVATE_NOT_EVIDENCE");
    expect(result.pendingWorkAssessed).toBe(false);
  });
  it("preflight reads only", async () => {
    const m = model({ input: { operation: "preflight" } });
    expect((await runConfig(m.args, m.io)).status).toBe("PREFLIGHT_ONLY");
    expect(m.events.some(e => e.startsWith("write:"))).toBe(false);
  });
  it("disable-ingress writes only web and leaves unhealthy workers for recovery", async () => {
    const m = model({ enabled: true, workerUnhealthy: true, input: { operation: "disable-ingress" } });
    const result = await runConfig(m.args, m.io);
    expect(m.events.filter(e => e.startsWith("write:"))).toEqual(["write:web:false"]);
    expect(result.status).toBe("INGRESS_DISABLED_WORKER_RECOVERY_HANDOFF");
    expect(result.canonicalIngressEnabled).toBe(false);
    expect(result.workerReadiness).toBe("UNPROVEN_RECOVERY_HANDOFF");
    expect(m.apps.worker.properties.template.containers[0].env.find(e => e.name === FLAG).value).toBe("true");
  });
  it("already-off ingress is verified without creating another revision", async () => {
    const m = model({ input: { operation: "disable-ingress" } });
    expect((await runConfig(m.args, m.io)).canonicalIngressEnabled).toBe(false);
    expect(m.events.some(e => e.startsWith("write:"))).toBe(false);
  });
  for (const key of ["badIdentity", "badSource", "badDigest", "workerUnhealthy"]) it(`blocks ${key} before activation`, async () => {
    const m = model({ [key]: true });
    await expect(runConfig(m.args, m.io)).rejects.toThrow();
    expect(m.events.some(e => e.startsWith("write:"))).toBe(false);
  });
  for (const role of ["worker", "web"]) it(`never resubmits ambiguous ${role} write; retains revision intent`, async () => {
    const m = model({ writeFailure: role });
    await expect(runConfig(m.args, m.io)).rejects.toThrow("PROVIDER_COMMAND_FAILED_RECONCILE");
    expect(m.events.filter(e => e === `write:${role}:true`)).toHaveLength(1);
    expect(m.receipts.at(-1).intents.at(-1)).toMatchObject({ role, revision: `${appName(role)}--mcp-123456-1-${role}`, state: "WRITE_INTENT_RECONCILE_IF_UNCERTAIN" });
    expect(m.receipts.at(-1).status).toBe("STOPPED_OPERATOR_RECONCILIATION_REQUIRED");
    expect(m.receipts.at(-1).reconciliation.at(-1)).toMatchObject({ role, permitsRetry: false, observation: { terminalOperationProved: false } });
    expect(m.events.indexOf(`reconcile:${role}:${appName(role)}--mcp-123456-1-${role}`)).toBeGreaterThan(m.events.indexOf(`write:${role}:true`));
  });
  for (const drift of ["old-worker", "config", "image", "revision"]) it(`stops after worker update on ${drift}`, async () => {
    const m = model({ afterWrite({ role, apps, revisions }) {
      if (role !== "worker") return;
      if (drift === "old-worker") Object.assign(revisions.worker[0].properties, { active: false, replicas: 1, runningState: "Running" });
      if (drift === "config") apps.worker.properties.template.scale.maxReplicas = 2;
      if (drift === "image") apps.worker.properties.template.containers[0].image = "foreign";
      if (drift === "revision") apps.worker.properties.latestRevisionName = "unexpected";
    } });
    await expect(runConfig(m.args, m.io)).rejects.toThrow();
    expect(m.events.filter(e => e.startsWith("write:"))).toEqual(["write:worker:true"]);
  });
  it("does not auto rollback or disable workers after web acceptance failure", async () => {
    const m = model({ acceptanceFailure: true });
    await expect(runConfig(m.args, m.io)).rejects.toThrow("CANONICAL_AUTH_BOUNDARY_FAILED");
    expect(m.events.filter(e => e.startsWith("write:"))).toEqual(["write:worker:true", "write:web:true"]);
  });
  it("old worker reactivation after web update fails final proof", async () => {
    const m = model({ afterWrite({ role, revisions }) { if (role === "web") Object.assign(revisions.worker[0].properties, { runningState: "Running", replicas: 1 }); } });
    await expect(runConfig(m.args, m.io)).rejects.toThrow("OLD_REVISION_NOT_STOPPED");
  });
  it("detects materialized revision config differing from the app template", async () => {
    const m = model(); const read = m.io.revision;
    m.io.revision = async (...args) => { const r = await read(...args); r.properties.template.containers[0].env.find(e => e.name === "REF").secretRef = "rewritten"; return r; };
    await expect(runConfig(m.args, m.io)).rejects.toThrow("REVISION_CONFIG_DRIFT");
    expect(m.events.some(e => e.startsWith("write:"))).toBe(false);
  });
});

describe("actual Azure adapter command boundary", () => {
  it("submits only one flag and immutable image; lists ALL revisions; exec binds replica", async () => {
    const output = mkdtempSync(join(tmpdir(), "mcp-config-test-"));
    const calls = [], args = input();
    const io = createAzureIO(args, {}, { output, execFileSync(exe, argv) {
      calls.push({ exe, argv });
      if (exe === "script") return 'Connected\nMCP_CONFIG_PROBE:{"status":200}\n';
      return "[]";
    } });
    try {
      await io.revisions("worker");
      await io.update("worker", "mcp-123456-1-worker", args.images.worker, true);
      await io.runtime("worker", args.baselines.worker, `${args.baselines.worker}-replica`);
      expect(calls[0].argv).toContain("--all");
      const update = calls[1].argv;
      expect(update.slice(update.indexOf("--set-env-vars"), update.indexOf("--query"))).toEqual(["--set-env-vars", `${FLAG}=true`]);
      expect(update[update.indexOf("--image") + 1]).toBe(args.images.worker);
      expect(update[update.indexOf("--revision-suffix") + 1]).toBe("mcp-123456-1-worker");
      for (const forbidden of ["--replace-env-vars", "--secrets", "--cpu", "--memory", "--min-replicas", "--max-replicas"]) expect(update).not.toContain(forbidden);
      const exec = calls[2];
      expect(exec.exe).toBe("script");
      expect(exec.argv[3]).toContain(`'--revision' '${args.baselines.worker}'`);
      expect(exec.argv[3]).toContain(`'--replica' '${args.baselines.worker}-replica'`);
      expect(exec.argv[3]).toContain("'--container' 'worker'");
    } finally { rmSync(output, { recursive: true, force: true }); }
  });
  it("provider errors cannot leak raw stderr and are never retried", async () => {
    const output = mkdtempSync(join(tmpdir(), "mcp-config-test-")); let count = 0;
    const args = input(), io = createAzureIO(args, {}, { output, execFileSync() { count++; throw Error("PRIVATE_PROVIDER_BODY"); } });
    try { await expect(io.update("web", "mcp-123456-1-web", args.images.web, true)).rejects.toThrow("PROVIDER_COMMAND_FAILED_RECONCILE"); expect(count).toBe(1); }
    finally { rmSync(output, { recursive: true, force: true }); }
  });
  it("disable adapter refuses worker writes even if called directly", async () => {
    const output = mkdtempSync(join(tmpdir(), "mcp-config-test-")); let count = 0;
    const args = { ...input(), operation: "disable-ingress" }, io = createAzureIO(args, {}, { output, execFileSync() { count++; return "{}"; } });
    try { await expect(io.update("worker", "suffix", args.images.worker, false)).rejects.toThrow("WRITE_OUTSIDE_OPERATION"); expect(count).toBe(0); }
    finally { rmSync(output, { recursive: true, force: true }); }
  });
  it("recovery adapter permits only the web enable write", async () => {
    const output = mkdtempSync(join(tmpdir(), "mcp-config-test-")); let count = 0;
    const args = { ...input(), operation: "complete-activation" }, io = createAzureIO(args, {}, { output, execFileSync() { count++; return "{}"; } });
    try {
      await expect(io.update("worker", "mcp-123456-1-worker", args.images.worker, true)).rejects.toThrow("WRITE_OUTSIDE_OPERATION");
      await expect(io.update("web", "mcp-123456-1-web", args.images.web, false)).rejects.toThrow("WRITE_OUTSIDE_OPERATION");
      expect(count).toBe(0);
      await io.update("web", "mcp-123456-1-web", args.images.web, true);
      expect(count).toBe(1);
    } finally { rmSync(output, { recursive: true, force: true }); }
  });
  for (const defect of ["worker-off", "tag-image", "foreign-suffix"]) it(`adapter blocks ${defect} before submitting`, async () => {
    const output = mkdtempSync(join(tmpdir(), "mcp-config-test-")); let count = 0;
    const args = input(), io = createAzureIO(args, {}, { output, execFileSync() { count++; return "{}"; } });
    try {
      await expect(io.update("worker", defect === "foreign-suffix" ? "other" : "mcp-123456-1-worker",
        defect === "tag-image" ? `${TARGET.server}/corgtex/worker:latest` : args.images.worker, defect !== "worker-off")).rejects.toThrow();
      expect(count).toBe(0);
    } finally { rmSync(output, { recursive: true, force: true }); }
  });
  for (const role of ["web", "worker"]) it(`executes ${role} probe source with only whitelisted output`, async () => {
    const lines = [], urls = [];
    const fakeProcess = { env: { APP_URL: TARGET.origin, [FLAG]: "true", DATABASE_URL: "PRIVATE_SECRET" } };
    const execute = Function("require", "fetch", "process", "console", `return ${runtimeProbeSource(role)}`);
    await execute(name => { expect(name).toBe("fs"); return { readFileSync(path) { expect(path).toBe("/app/release-build.json"); return JSON.stringify({ schemaVersion: 1, role, gitSha: sha }); } }; },
      async url => { urls.push(url); return new Response(JSON.stringify(health(role))); }, fakeProcess, { log(line) { lines.push(line); } });
    expect(urls).toEqual([role === "worker" ? "http://127.0.0.1:9090/health" : "http://127.0.0.1:3000/api/health"]);
    expect(lines.join("")).not.toContain("PRIVATE_SECRET");
    expect(() => assertRuntime(parseRuntimeOutput(lines.join("\n")), role, sha, true)).not.toThrow();
  });
});

describe("closed bindings and runtime proof", () => {
  for (const [key, value] of [["acceptedSha", "latest"], ["attempt", "2"], ["writerAcknowledged", "false"], ["operation", "rollback"]]) it(`rejects ${key}`, () => {
    expect(() => validateInputs({ ...input(), [key]: value })).toThrow();
  });
  it("rejects tag inputs and swapped role images", () => {
    const i = input(); i.images.web = i.images.worker;
    expect(() => validateInputs(i)).toThrow("IMMUTABLE_IMAGE_REQUIRED");
    i.images.web = `${TARGET.server}/corgtex/web:sha-${sha}`;
    expect(() => validateInputs(i)).toThrow("IMMUTABLE_IMAGE_REQUIRED");
  });
  it("checks actual service principal, subscription and tenant", () => {
    const id = "11111111-1111-4111-8111-111111111111";
    const a = { id: TARGET.subscription, tenantId: TARGET.tenant, state: "Enabled", user: { type: "servicePrincipal", name: id } };
    expect(() => assertIdentity(a, id)).not.toThrow();
    for (const changed of [{ id: "foreign" }, { tenantId: "foreign" }, { user: { type: "user", name: id } }]) expect(() => assertIdentity({ ...a, ...changed }, id)).toThrow();
    expect(() => assertIdentity(a, "22222222-2222-4222-8222-222222222222")).toThrow();
  });
  it("all non-controlled configuration participates in drift hash", () => {
    const { apps } = model(); const before = configHash(apps.web);
    apps.web.properties.template.containers[0].image = "permitted-reference-change";
    apps.web.properties.template.containers[0].env.find(e => e.name === FLAG).value = "true";
    apps.web.properties.template.revisionSuffix = "new";
    expect(configHash(apps.web)).toBe(before);
    apps.web.properties.template.containers[0].env.find(e => e.name === "REF").secretRef = "other-secret";
    expect(configHash(apps.web)).not.toBe(before);
  });
  it("unknown/missing stopped-replica count is not stop proof", async () => {
    const m = model(); delete m.revisions.worker[1].properties.replicas;
    const replicas = await m.io.replicas("worker", m.args.baselines.worker);
    expect(() => assertFleet(m.revisions.worker, replicas, "worker", m.args.baselines.worker)).toThrow("OLD_REVISION_NOT_STOPPED");
  });
  for (const defect of ["wrong-role", "configured-fallback", "drift", "stale-tick", "wrong-origin", "flag-off"]) it(`rejects runtime ${defect}`, async () => {
    const m = model(); const p = await m.io.runtime("worker", m.args.baselines.worker);
    if (defect === "wrong-role") p.build.role = "web";
    if (defect === "configured-fallback") p.health.release.runtime.evidence = "legacy_provider";
    if (defect === "drift") p.health.release.drift.version = true;
    if (defect === "stale-tick") p.health.lastSuccessfulTickAt = "2000-01-01T00:00:00Z";
    if (defect === "wrong-origin") p.origin = "https://other.example";
    if (defect === "flag-off") p.flag = true;
    expect(() => assertRuntime(p, "worker", sha, false)).toThrow();
  });
  it("requires main manual dispatch and rejects reruns", () => {
    expect(() => inputsFromEnv({ GITHUB_ACTIONS: "true", GITHUB_REPOSITORY: "Corgtexdotcom/corgtex", GITHUB_REF: "refs/pull/1/merge", GITHUB_EVENT_NAME: "workflow_dispatch" })).toThrow();
  });
  it("parses only a unique bounded marker, not CLI chatter", () => {
    expect(parseRuntimeOutput('Connected\nMCP_CONFIG_PROBE:{"status":200}\nDisconnected')).toEqual({ status: 200 });
    expect(() => parseRuntimeOutput('MCP_CONFIG_PROBE:{}\nMCP_CONFIG_PROBE:{}')).toThrow();
    expect(() => parseRuntimeOutput('No response')).toThrow();
    expect(runtimeProbeSource("worker")).not.toContain("DATABASE_URL");
  });
});

describe("read-only canonical and legacy acceptance", () => {
  function responses(enabled, alter = x => x) {
    return async (url, options) => {
      expect(url.startsWith(TARGET.origin + "/")).toBe(true); expect(options.method).toBe("GET"); expect(options.redirect).toBe("error");
      expect(options.headers.Authorization).toBeUndefined();
      const path = new URL(url).pathname;
      const resource = TARGET.origin + `/mcp/workspaces/${TARGET.workspace}`;
      let r;
      if (path === "/api/health") r = { status: 200, body: health("web") };
      else if (path.includes("/workspaces/")) r = !enabled ? { status: 503, body: { error: { code: "MCP_WORKSPACE_CONNECTIONS_DISABLED" } } }
        : path.startsWith("/.well-known") ? { status: 200, body: { resource, authorization_servers: [TARGET.origin], bearer_methods_supported: ["header"] } }
          : { status: 401, body: { error: "invalid_token" }, authenticate: `Bearer resource_metadata="${TARGET.origin}/.well-known/oauth-protected-resource/mcp/workspaces/${TARGET.workspace}"` };
      else r = { status: 200, body: { name: "corgtex-mcp", capabilities: { tools: true, resources: true } } };
      r = alter(r, path);
      return new Response(JSON.stringify(r.body), { status: r.status, headers: r.authenticate ? { "www-authenticate": r.authenticate } : {} });
    };
  }
  it("accepts enabled unauthenticated boundary and retained legacy discovery", async () => { await acceptance(responses(true), true, sha); });
  it("proves disabled endpoint AND metadata", async () => { await acceptance(responses(false), false, sha); });
  it("rejects 503 for a different reason", async () => { await expect(acceptance(responses(false, (r, p) => p.includes("/workspaces/") ? { status: 503, body: { error: { code: "DATABASE_DOWN" } } } : r), false, sha)).rejects.toThrow("CANONICAL_INGRESS_NOT_DISABLED"); });
  it("rejects wrong discovery resource", async () => { await expect(acceptance(responses(true, (r, p) => p.startsWith("/.well-known") ? { ...r, body: { ...r.body, resource: "foreign" } } : r), true, sha)).rejects.toThrow("CANONICAL_DISCOVERY_FAILED"); });
  it("rejects a canonical anonymous 200", async () => { await expect(acceptance(responses(true, (r, p) => p.startsWith("/mcp/workspaces") ? { ...r, status: 200 } : r), true, sha)).rejects.toThrow("CANONICAL_AUTH_BOUNDARY_FAILED"); });
});

describe("protected workflow and runner-only classification", () => {
  it("uses existing noncancelled fleet lock, protection and Azure identity only", () => {
    const workflow = readFileSync(new URL("../../.github/workflows/workspace-mcp-config.yml", import.meta.url), "utf8");
    const parsed = parse(workflow);
    expect(parsed.concurrency).toEqual({ group: "fleet-release", "cancel-in-progress": false });
    expect(parsed.permissions).toEqual({ contents: "read", "id-token": "write" });
    expect(parsed.jobs.configure.environment).toBe("fleet-release-production");
    expect(Object.keys(parsed.on)).toEqual(["workflow_dispatch"]);
    expect(Object.keys(parsed.jobs.configure.env).filter(k => k.startsWith("AZURE_"))).toEqual(["AZURE_CLIENT_ID", "AZURE_TENANT_ID", "AZURE_SUBSCRIPTION_ID"]);
    expect(workflow).toContain("group: fleet-release\n  cancel-in-progress: false");
    expect(workflow).toContain("environment: fleet-release-production");
    expect(workflow).toContain("uses: azure/login@v2");
    expect(workflow).toContain("github.ref == 'refs/heads/main' && github.run_attempt == 1");
    expect(workflow).toContain("if-no-files-found: error");
    for (const forbidden of ["DATABASE_URL", "CONTROL_PLANE_AGENT", "GHCR_IMPORT_TOKEN", "ADMIN_PASSWORD", "npm ci", "secrets: inherit", "continue-on-error"]) expect(workflow).not.toContain(forbidden);
  });
  it("new operational runner files do not require app redeployment", () => {
    for (const path of ["scripts/release/workspace-mcp-config.mjs", "scripts/release/workspace-mcp-config-azure.mjs", "scripts/release/workspace-mcp-config.test.mjs"]) expect(productionAppReleaseRelevantPath(path)).toBe(false);
    expect(productionAppReleaseRelevantPath("apps/worker/src/index.ts")).toBe(true);
  });
});
