import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtemp, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { releaseSite, validateTarget, inspectApp, azureCommand } from "./azure-site-image-release.mjs";
import { buildHostingImageReceipt } from "./migration/hosting-image-receipt.mjs";

const subscriptionId = "11111111-2222-3333-4444-555555555555";
const base = `/subscriptions/${subscriptionId}/resourceGroups/site-rg/providers`;
const target = {
  purpose: "corgtex-public-site", subscriptionId, resourceGroup: "site-rg", appName: "public-site",
  containerName: "site", resourceId: `${base}/Microsoft.App/containerApps/public-site`,
  registryResourceId: `${base}/Microsoft.ContainerRegistry/registries/siteregistry`,
  registryServer: "siteregistry.azurecr.io", domains: ["example.com", "www.example.com"],
};
const digest = `sha256:${"a".repeat(64)}`;
const previousImage = `${target.registryServer}/corgtex/site@sha256:${"b".repeat(64)}`;
const image = `${target.registryServer}/corgtex/site@${digest}`;
const secret = "DO_NOT_LOG_this_super_secret_value";
const receipt = buildHostingImageReceipt({ repository: "Corgtexdotcom/corgtex", gitSha: "c".repeat(40),
  runId: "1234", runAttempt: "2", siteDigest: digest, monitorDigest: `sha256:${"d".repeat(64)}` });
const options = { target, receipt, image, expectedCurrentImage: previousImage, waitSeconds: 3, pollSeconds: 1 };

function app() {
  return {
    id: target.resourceId, name: target.appName, type: "Microsoft.App/containerApps", resourceGroup: target.resourceGroup,
    location: "westus3", tags: { owner: secret }, identity: { type: "UserAssigned", userAssignedIdentities: { [`${base}/Microsoft.ManagedIdentity/userAssignedIdentities/site-pull`]: { clientId: "client", principalId: "principal" } } },
    properties: {
      managedEnvironmentId: `${base}/Microsoft.App/managedEnvironments/environment`, workloadProfileName: "Consumption",
      provisioningState: "Succeeded", latestRevisionName: "public-site--old", latestReadyRevisionName: "public-site--old",
      configuration: {
        activeRevisionsMode: "Single", secrets: [{ name: "analytics", value: secret }],
        registries: [{ server: target.registryServer, identity: `${base}/Microsoft.ManagedIdentity/userAssignedIdentities/site-pull` }],
        ingress: { external: true, allowInsecure: false, targetPort: 3000, fqdn: "public-site.example.azurecontainerapps.io",
          traffic: [{ latestRevision: true, weight: 100 }],
          customDomains: target.domains.map((name) => ({ name, bindingType: "SniEnabled", certificateId: `${base}/Microsoft.App/managedEnvironments/environment/managedCertificates/${name}` })),
        },
      },
      template: { revisionSuffix: "old", containers: [{ name: "site", image: previousImage,
        env: [{ name: "PORT", value: "3000" }, { name: "SECRET_PLAINTEXT", value: secret }, { name: "POSTHOG_PROJECT_TOKEN", secretRef: "analytics" }],
        args: [secret], resources: { cpu: 0.25, memory: "0.5Gi" },
        probes: [{ type: "Readiness", httpGet: { path: "/api/health", port: 3000, httpHeaders: [{ name: "Authorization", value: secret }] } }],
      }], scale: { minReplicas: 0, maxReplicas: 2, rules: [{ name: "http", http: { metadata: { concurrentRequests: "50" } } }] } },
    },
  };
}

function harness(custom = {}) {
  const state = { app: app(), calls: [], evidence: {}, clock: 0, shows: 0, writes: 0 };
  const dependencies = {
    now: () => state.clock,
    sleep: async (ms) => { state.clock += ms; },
    save: async (name, data) => { assert.equal(state.evidence[name], undefined); state.evidence[name] = structuredClone(data); },
    az: async (args, controls) => {
      state.calls.push({ args, controls });
      assert.equal(args.includes("--subscription"), true);
      assert.equal(args[args.indexOf("--subscription") + 1], subscriptionId);
      if (args[0] === "account") return { id: subscriptionId, state: "Enabled", ...custom.account };
      if (args[0] === "acr" && args[1] === "show") return { id: target.registryResourceId, loginServer: target.registryServer, ...custom.registry };
      if (args[0] === "acr" && args[1] === "manifest") return { digest, ...custom.manifest };
      if (args[1] === "update") {
        state.writes += 1;
        assert.ok(state.evidence["intent.json"]);
        assert.ok(state.evidence["submitted.json"]);
        state.app.properties.template.containers[0].image = args[args.indexOf("--image") + 1];
        state.app.properties.template.revisionSuffix = "new";
        state.app.properties.latestRevisionName = "public-site--new";
        state.app.properties.latestReadyRevisionName = "public-site--new";
        custom.update?.(state);
        return null;
      }
      if (args[1] === "revision") {
        const result = { id: `${target.resourceId}/revisions/${state.app.properties.latestRevisionName}`,
          name: state.app.properties.latestRevisionName, properties: { template: structuredClone(state.app.properties.template), active: true,
            provisioningState: "Provisioned", healthState: "Healthy", runningState: "Running" } };
        custom.revision?.(result, state);
        return result;
      }
      if (args[1] === "show") {
        state.shows += 1;
        custom.show?.(state);
        return structuredClone(state.app);
      }
      throw new Error("Unexpected command");
    },
  };
  return { state, dependencies };
}

const execute = { ...options, execute: true, confirmTarget: target.resourceId };

// Frozen from the pre-normalization script, with the secretRef value key absent.
const historicalFingerprints = {
  configurationFingerprint: "c65118c676d0ff1b2c8289c730b12fc6cc2c9db587f735c0ae8d176deec05af0",
  templateFingerprint: "633f1b145c27a57df7c704c92b5015c34c14b9f82fb25eb617d165d5c1d21218",
};

test("keeps historical absent-value fingerprints and normalizes Azure's empty secretRef value without mutating input", () => {
  const original = app();
  const before = inspectApp(original, target);
  assert.deepEqual({ configurationFingerprint: before.configurationFingerprint, templateFingerprint: before.templateFingerprint }, historicalFingerprints);
  original.properties.template.containers[0].env[2].value = "";
  assert.deepEqual(inspectApp(original, target), before);
  assert.equal(original.properties.template.containers[0].env[2].value, "");
});

test("accepts the observed empty secretRef value after the simulated image-only update", async () => {
  const h = harness({ update: ({ app }) => { app.properties.template.containers[0].env[2].value = ""; } });
  assert.equal((await releaseSite(execute, h.dependencies)).status, "READY");
  assert.equal(h.state.writes, 1);
  assert.equal(h.state.evidence["after.json"].configurationFingerprint, h.state.evidence["intent.json"].before.configurationFingerprint);
  assert.equal(h.state.evidence["after.json"].templateFingerprint, h.state.evidence["intent.json"].before.templateFingerprint);
  assert.deepEqual(h.state.evidence["after.json"].bindings, h.state.evidence["intent.json"].before.bindings);
  assert.equal(JSON.stringify(h.state.evidence).includes(secret), false);
  assert.equal(JSON.stringify(h.state.calls).includes(secret), false);
});

for (const [appEmpty, revisionEmpty] of [[true, true], [true, false], [false, true]]) {
  test(`reconciles historical intent read-only with app empty=${appEmpty}, revision empty=${revisionEmpty}`, async () => {
    const h = harness({ revision: (revision) => {
      revisionResponseFields(revision);
      const env = revision.properties.template.containers[0].env[2];
      if (revisionEmpty) env.value = "";
      else delete env.value;
    } });
    h.state.app.properties.template.containers[0].image = image;
    if (appEmpty) h.state.app.properties.template.containers[0].env[2].value = "";
    const saved = { schemaVersion: 1, target, image, before: { image: previousImage, ...historicalFingerprints } };
    const savedCopy = structuredClone(saved);
    const result = await releaseSite({ target, reconcile: saved }, h.dependencies);
    assert.equal(result.status, "READY");
    assert.equal(result.runtimeHealth, "UNPROVEN");
    assert.equal(result.publicHealth, "UNPROVEN");
    assert.equal(h.state.writes, 0);
    assert.deepEqual(saved, savedCopy);
    assert.equal(h.state.evidence["after.json"].configurationFingerprint, saved.before.configurationFingerprint);
    assert.equal(h.state.evidence["after.json"].templateFingerprint, saved.before.templateFingerprint);
  });
}

for (const value of ["nonempty-literal", " ", 0, false]) test(`rejects secretRef literal ${JSON.stringify(value)}`, () => {
  const original = app();
  original.properties.template.containers[0].env[2].value = value;
  assert.throws(() => inspectApp(original, target), /INVALID_SECRET_REFERENCE/);
});

for (const value of [undefined, null, ""]) test(`rejects a missing registered secret with value ${JSON.stringify(value)}`, () => {
  const original = app();
  original.properties.configuration.secrets = [];
  if (value !== undefined) original.properties.template.containers[0].env[2].value = value;
  assert.throws(() => inspectApp(original, target), /INVALID_SECRET_REFERENCE/);
});

test("preserves null and ordinary literal-value fingerprint distinctions", () => {
  const before = inspectApp(app(), target);
  for (const mutate of [
    (env) => { env[2].value = null; },
    (env) => { delete env[2].secretRef; env[2].value = ""; },
    (env) => { env[2].secretRef = ""; env[2].value = ""; },
    (env) => { env[0].value = ""; },
  ]) {
    const original = app();
    mutate(original.properties.template.containers[0].env);
    const after = inspectApp(original, target);
    assert.notEqual(after.configurationFingerprint, before.configurationFingerprint);
    assert.notEqual(after.templateFingerprint, before.templateFingerprint);
  }
});

function appResponseFields(template) {
  template.containers[0].imageType = "ContainerImage";
  template.containers[0].resources.ephemeralStorage = "1Gi";
  template.customMetricsSettings = null;
  template.scale.cooldownPeriod = 300;
  template.scale.pollingInterval = 30;
}

function revisionResponseFields(revision) {
  const template = revision.properties.template;
  delete template.containers[0].imageType;
  delete template.containers[0].resources.ephemeralStorage;
  delete template.customMetricsSettings;
  template.scale.cooldownPeriod = null;
  template.scale.pollingInterval = null;
}

test("unchanged-image reconciliation accepts observed app/revision response differences", async () => {
  const plan = harness();
  appResponseFields(plan.state.app.properties.template);
  plan.state.app.properties.template.containers[0].image = image;
  await releaseSite({ ...options, expectedCurrentImage: image }, plan.dependencies);
  const next = harness({ revision: revisionResponseFields });
  next.state.app = structuredClone(plan.state.app);
  const result = await releaseSite({ target, reconcile: plan.state.evidence["intent.json"] }, next.dependencies);
  assert.equal(result.status, "READY");
  assert.equal(next.state.writes, 0);
  assert.equal(next.state.evidence["after.json"].configurationFingerprint, plan.state.evidence["intent.json"].before.configurationFingerprint);
});

test("image update and rollback both compare the observed revision response shape", async () => {
  const first = harness({ revision: revisionResponseFields });
  appResponseFields(first.state.app.properties.template);
  assert.equal((await releaseSite(execute, first.dependencies)).status, "READY");
  const back = harness({ manifest: { digest: previousImage.split("@")[1] }, revision: revisionResponseFields });
  back.state.app = structuredClone(first.state.app);
  assert.equal((await releaseSite({ target, rollback: first.state.evidence["intent.json"], expectedCurrentImage: image,
    execute: true, confirmTarget: target.resourceId }, back.dependencies)).status, "READY");
  assert.equal(back.state.writes, 1);
  assert.equal(back.state.app.properties.template.containers[0].image, previousImage);
});

for (const [name, mutate] of [
  ["nondefault revision cooldown", (t) => { t.scale.cooldownPeriod = 600; }],
  ["nondefault revision polling", (t) => { t.scale.pollingInterval = 60; }],
  ["zero revision cooldown", (t) => { t.scale.cooldownPeriod = 0; }],
  ["string revision polling", (t) => { t.scale.pollingInterval = "30"; }],
  ["revision CPU", (t) => { t.containers[0].resources.cpu = 0.5; }],
  ["revision memory", (t) => { t.containers[0].resources.memory = "1Gi"; }],
  ["explicit revision ephemeral storage", (t) => { t.containers[0].resources.ephemeralStorage = "2Gi"; }],
  ["explicit revision image type", (t) => { t.containers[0].imageType = "OtherImageType"; }],
  ["null revision ephemeral storage", (t) => { t.containers[0].resources.ephemeralStorage = null; }],
  ["revision custom metrics", (t) => { t.customMetricsSettings = { enabled: true }; }],
  ["missing revision resources", (t) => { delete t.containers[0].resources; }],
  ["missing revision scale", (t) => { delete t.scale; }],
  ["revision minimum replicas", (t) => { t.scale.minReplicas = 1; }],
  ["revision maximum replicas", (t) => { t.scale.maxReplicas = 3; }],
  ["revision scale rules", (t) => { t.scale.rules[0].http.metadata.concurrentRequests = "100"; }],
  ["revision secret literal", (t) => { t.containers[0].env[2].value = "nonempty-literal"; }],
  ["revision missing secret reference", (t) => { delete t.containers[0].env[2].secretRef; }],
  ["revision unregistered secret reference", (t) => { t.containers[0].env[2].secretRef = "missing"; }],
  ["revision null secret value", (t) => { t.containers[0].env[2].value = null; }],
]) test(`revision-only normalization preserves detection of ${name} drift`, async () => {
  const h = harness({ revision: (r) => {
    revisionResponseFields(r);
    r.properties.template.containers[0].env[2].value = "";
    mutate(r.properties.template);
  } });
  appResponseFields(h.state.app.properties.template);
  assert.equal((await releaseSite(execute, h.dependencies)).status, "REVISION_CONFIGURATION_DRIFT");
  assert.equal(h.state.evidence["ready.json"], undefined);
  assert.equal(h.state.writes, 1);
});

for (const [name, mutate] of [
  ["cooldown", (t) => { t.scale.cooldownPeriod = 600; }],
  ["polling", (t) => { t.scale.pollingInterval = 60; }],
  ["custom metrics", (t) => { t.customMetricsSettings = { enabled: true }; }],
]) test(`revision omission cannot stand in for a configured nondefault ${name}`, async () => {
  const h = harness({ revision: revisionResponseFields });
  appResponseFields(h.state.app.properties.template);
  mutate(h.state.app.properties.template);
  assert.equal((await releaseSite(execute, h.dependencies)).status, "REVISION_CONFIGURATION_DRIFT");
});

test("matching explicit nondefaults remain valid and missing scale defaults normalize narrowly", async () => {
  const explicit = harness();
  appResponseFields(explicit.state.app.properties.template);
  explicit.state.app.properties.template.scale.cooldownPeriod = 600;
  explicit.state.app.properties.template.scale.pollingInterval = 60;
  explicit.state.app.properties.template.containers[0].resources.ephemeralStorage = "2Gi";
  explicit.state.app.properties.template.customMetricsSettings = { enabled: true };
  assert.equal((await releaseSite(execute, explicit.dependencies)).status, "READY");
  const omitted = harness({ revision: (r) => {
    revisionResponseFields(r);
    delete r.properties.template.scale.cooldownPeriod;
    delete r.properties.template.scale.pollingInterval;
  } });
  appResponseFields(omitted.state.app.properties.template);
  assert.equal((await releaseSite(execute, omitted.dependencies)).status, "READY");
});

for (const [name, mutate] of [
  ["image type", (t) => { t.containers[0].imageType = "OtherImageType"; }],
  ["ephemeral storage", (t) => { t.containers[0].resources.ephemeralStorage = "2Gi"; }],
  ["custom metrics null to missing", (t) => { delete t.customMetricsSettings; }],
  ["cooldown default to null", (t) => { t.scale.cooldownPeriod = null; }],
  ["polling default to null", (t) => { t.scale.pollingInterval = null; }],
]) test(`full app fingerprint still rejects ${name} drift, even if revision normalization permits omissions`, async () => {
  const h = harness({ revision: revisionResponseFields, update: ({ app }) => mutate(app.properties.template) });
  appResponseFields(h.state.app.properties.template);
  assert.equal((await releaseSite(execute, h.dependencies)).status, "CONFIGURATION_DRIFT_RECONCILE_REQUIRED");
  assert.equal(h.state.evidence["ready.json"], undefined);
  const reconcile = harness({ revision: revisionResponseFields });
  reconcile.state.app = structuredClone(h.state.app);
  await assert.rejects(releaseSite({ target, reconcile: h.state.evidence["intent.json"] }, reconcile.dependencies), /CONFIGURATION_DRIFT/);
  assert.equal(reconcile.state.writes, 0);
});

test("planning is read-only, preserves min0, emits redacted evidence and leaves health unproven", async () => {
  const { state, dependencies } = harness();
  const result = await releaseSite(options, dependencies);
  assert.equal(result.status, "PLANNED");
  assert.equal(result.publicHealth, "UNPROVEN");
  assert.equal(result.runtimeHealth, "UNPROVEN");
  assert.equal(state.writes, 0);
  assert.equal(state.app.properties.template.scale.minReplicas, 0);
  assert.equal(JSON.stringify(state.evidence).includes(secret), false);
  assert.equal(JSON.stringify(state.calls).includes(secret), false);
  assert.equal(state.evidence["intent.json"].before.image, previousImage);
  assert.deepEqual(state.evidence["intent.json"].before.environment[2], { name: "POSTHOG_PROJECT_TOKEN", secretRef: "analytics" });
});

test("execute issues exactly one image-only update and verifies ready revision and configuration", async () => {
  const { state, dependencies } = harness();
  const result = await releaseSite(execute, dependencies);
  assert.equal(result.status, "READY");
  assert.equal(state.writes, 1);
  assert.deepEqual(state.calls.find((call) => call.args[1] === "update").args, [
    "containerapp", "update", "--subscription", subscriptionId, "--resource-group", "site-rg", "--name", "public-site",
    "--container-name", "site", "--image", image, "--no-wait", "--output", "none",
  ]);
  assert.equal(state.evidence["after.json"].image, image);
  assert.equal(state.evidence["after.json"].configurationFingerprint, state.evidence["intent.json"].before.configurationFingerprint);
  assert.equal(JSON.stringify(state.evidence).includes(secret), false);
});

for (const [name, change] of [
  ["subscription", { target: { ...target, subscriptionId: "00000000-2222-3333-4444-555555555555" } }],
  ["container", { target: { ...target, containerName: "web" } }],
  ["purpose", { target: { ...target, purpose: "selfserve" } }],
  ["missing confirmation", { confirmTarget: undefined }],
  ["wrong confirmation", { confirmTarget: `${target.resourceId}-other` }],
  ["tag", { image: `${target.registryServer}/corgtex/site:latest` }],
  ["monitor repository", { image: `${target.registryServer}/corgtex/ops-monitor@${digest}` }],
  ["foreign ACR", { image: `otherregistry.azurecr.io/corgtex/site@${digest}` }],
  ["missing current digest", { expectedCurrentImage: undefined }],
  ["wrong receipt digest", { receipt: { ...receipt, images: { ...receipt.images, site: { ...receipt.images.site, digest: `sha256:${"e".repeat(64)}` } } } }],
  ["missing receipt", { receipt: null }],
  ["wrong workflow", { receipt: { ...receipt, workflowRun: { ...receipt.workflowRun, url: "https://github.com/other/repo/actions/runs/1" } } }],
  ["unbounded wait", { waitSeconds: Infinity }],
  ["zero polling interval", { pollSeconds: 0 }],
]) test(`rejects ${name} before Azure access`, async () => {
  const { state, dependencies } = harness();
  await assert.rejects(releaseSite({ ...execute, ...change }, dependencies));
  assert.equal(state.calls.length, 0);
});

for (const [name, setup] of [
  ["wrong account", { account: { id: "other" } }],
  ["disabled account", { account: { state: "Disabled" } }],
  ["wrong registry", { registry: { id: "other" } }],
  ["wrong imported digest", { manifest: { digest: `sha256:${"e".repeat(64)}` } }],
  ["wrong app", { show: ({ app }) => { app.id += "-other"; } }],
  ["wrong current digest", { show: ({ app }) => { app.properties.template.containers[0].image = image; } }],
  ["unready baseline", { show: ({ app }) => { app.properties.latestReadyRevisionName = "old-other"; } }],
  ["missing domain", { show: ({ app }) => { app.properties.configuration.ingress.customDomains.pop(); } }],
  ["unbound certificate", { show: ({ app }) => { app.properties.configuration.ingress.customDomains[0].bindingType = "Disabled"; } }],
  ["missing secret reference", { show: ({ app }) => { app.properties.configuration.secrets = []; } }],
  ["multiple revisions", { show: ({ app }) => { app.properties.configuration.activeRevisionsMode = "Multiple"; } }],
]) test(`refuses ${name} without writing`, async () => {
  const { state, dependencies } = harness(setup);
  await assert.rejects(releaseSite(execute, dependencies));
  assert.equal(state.writes, 0);
});

test("prewrite reread catches concurrent config or revision changes", async () => {
  const { state, dependencies } = harness({ show: (s) => { if (s.shows === 2) s.app.properties.template.containers[0].env[0].value = "3001"; } });
  assert.equal((await releaseSite(execute, dependencies)).status, "PREWRITE_DRIFT_NO_UPDATE");
  assert.equal(state.writes, 0);
});

test("evidence must be saved before any update can be submitted", async () => {
  for (const failFile of ["intent.json", "submitted.json"]) {
    const { state, dependencies } = harness();
    const save = dependencies.save;
    dependencies.save = async (name, data) => {
      if (name === failFile) throw new Error("Disk unavailable");
      await save(name, data);
    };
    await assert.rejects(releaseSite(execute, dependencies), /Disk unavailable/);
    assert.equal(state.writes, 0);
  }
});

for (const [name, mutate] of [
  ["env value", (a) => { a.properties.template.containers[0].env[1].value = "changed"; }],
  ["secret ref", (a) => { a.properties.template.containers[0].env[2].secretRef = "second"; a.properties.configuration.secrets.push({ name: "second" }); }],
  ["secret metadata", (a) => { a.properties.configuration.secrets[0].keyVaultUrl = "https://vault.example/secrets/new"; }],
  ["certificate", (a) => { a.properties.configuration.ingress.customDomains[0].certificateId += "-new"; }],
  ["identity", (a) => { a.identity.type = "SystemAssigned"; }],
  ["registry", (a) => { a.properties.configuration.registries[0].identity += "-new"; }],
  ["resources", (a) => { a.properties.template.containers[0].resources.cpu = 0.5; }],
  ["minimum replicas", (a) => { a.properties.template.scale.minReplicas = 1; }],
  ["maximum replicas", (a) => { a.properties.template.scale.maxReplicas = 3; }],
  ["scale rules", (a) => { a.properties.template.scale.rules[0].http.metadata.concurrentRequests = "100"; }],
  ["command", (a) => { a.properties.template.containers[0].command = ["new"]; }],
  ["traffic", (a) => { a.properties.configuration.ingress.traffic[0].weight = 90; }],
  ["tags", (a) => { a.tags.owner = "changed"; }],
]) test(`detects ${name} drift alongside empty secretRef normalization without a corrective mutation`, async () => {
  const { state, dependencies } = harness({ update: ({ app }) => {
    app.properties.template.containers[0].env[2].value = "";
    mutate(app);
  } });
  assert.equal((await releaseSite(execute, dependencies)).status, "CONFIGURATION_DRIFT_RECONCILE_REQUIRED");
  assert.equal(state.writes, 1);
  assert.equal(state.evidence["ready.json"], undefined);
});

test("ambiguous command response reconciles the same ready digest without reissuing update", async () => {
  const { state, dependencies } = harness({ update: () => { throw new Error(secret); } });
  assert.equal((await releaseSite(execute, dependencies)).status, "READY");
  assert.equal(state.writes, 1);
  assert.equal(JSON.stringify(state.evidence).includes(secret), false);
});

test("ambiguous response and readiness timeout never roll back or report success", async () => {
  const { state, dependencies } = harness({ update: ({ app }) => {
    app.properties.latestReadyRevisionName = "public-site--old";
    throw new Error(secret);
  } });
  assert.equal((await releaseSite(execute, dependencies)).status, "UPDATE_AMBIGUOUS_RECONCILE_REQUIRED");
  assert.equal(state.writes, 1);
  assert.equal(state.clock, 3000);
  assert.equal(state.evidence["ready.json"], undefined);
  assert.equal(JSON.stringify(state.evidence).includes(secret), false);
});

for (const [name, mutate] of [
  ["unhealthy revision", (r) => { r.properties.healthState = "Unhealthy"; }],
  ["inactive revision", (r) => { r.properties.active = false; }],
  ["unprovisioned revision", (r) => { r.properties.provisioningState = "Provisioning"; }],
]) test(`does not mistake ${name} for readiness`, async () => {
  const { state, dependencies } = harness({ revision: mutate });
  assert.equal((await releaseSite(execute, dependencies)).status, "READINESS_TIMEOUT_RECONCILE_REQUIRED");
  assert.equal(state.writes, 1);
});

test("ready pointer with the wrong revision digest fails without success", async () => {
  const { state, dependencies } = harness({ revision: (r) => { r.properties.template.containers[0].image = previousImage; } });
  assert.equal((await releaseSite(execute, dependencies)).status, "REVISION_IMAGE_MISMATCH");
  assert.equal(state.writes, 1);
});

test("revision from another target fails even if image and health match", async () => {
  const { dependencies } = harness({ revision: (r) => { r.id = `${target.resourceId}-other/revisions/${r.name}`; } });
  assert.equal((await releaseSite(execute, dependencies)).status, "REVISION_TARGET_MISMATCH");
});

test("revision configuration is checked independently from app desired configuration", async () => {
  const { dependencies } = harness({ revision: (r) => { r.properties.template.containers[0].env[0].value = "3001"; } });
  assert.equal((await releaseSite(execute, dependencies)).status, "REVISION_CONFIGURATION_DRIFT");
});

test("late provider result cannot exceed deadline and become success", async () => {
  const { state, dependencies } = harness({ revision: (_, s) => { s.clock += 3000; } });
  assert.equal((await releaseSite(execute, dependencies)).status, "READINESS_TIMEOUT_RECONCILE_REQUIRED");
  assert.ok(state.calls.filter((c) => c.controls).every((c) => c.controls.timeoutMs > 0 && c.controls.timeoutMs <= 30_000));
});

test("readback failure is redacted and requires reconciliation", async () => {
  const { state, dependencies } = harness({ show: (s) => { if (s.writes) throw new Error(secret); } });
  assert.equal((await releaseSite(execute, dependencies)).status, "READBACK_FAILED_RECONCILE_REQUIRED");
  assert.equal(state.writes, 1);
  assert.equal(JSON.stringify(state.evidence).includes(secret), false);
});

test("final read closes a concurrent change between app and revision observations", async () => {
  const { dependencies } = harness({ revision: (_, s) => { s.app.properties.template.scale.maxReplicas = 4; } });
  assert.equal((await releaseSite(execute, dependencies)).status, "FINAL_READBACK_DRIFT_RECONCILE_REQUIRED");
});

test("read-only reconciliation can complete interrupted intent with original config proof", async () => {
  const first = harness({ update: ({ app }) => { app.properties.latestReadyRevisionName = "public-site--old"; } });
  await releaseSite(execute, first.dependencies);
  const next = harness();
  next.state.app = structuredClone(first.state.app);
  next.state.app.properties.latestReadyRevisionName = "public-site--new";
  assert.equal((await releaseSite({ target, reconcile: first.state.evidence["intent.json"], waitSeconds: 3 }, next.dependencies)).status, "READY");
  assert.equal(next.state.writes, 0);
  assert.equal(next.state.evidence["intent.json"].before.image, previousImage);
});

test("reconciliation rejects changed target and drift since the original intent", async () => {
  const first = harness();
  await releaseSite(execute, first.dependencies);
  const saved = first.state.evidence["intent.json"];
  const wrong = harness();
  await assert.rejects(releaseSite({ target: { ...target, domains: ["other.example.com"] }, reconcile: saved }, wrong.dependencies));
  assert.equal(wrong.state.calls.length, 0);
  const drift = harness();
  drift.state.app.properties.template.containers[0].env[0].value = "changed";
  await assert.rejects(releaseSite({ target, reconcile: saved }, drift.dependencies), /CONFIGURATION_DRIFT/);
  assert.equal(drift.state.writes, 0);
});

test("rollback uses saved previous digest through identical guarded image-only path", async () => {
  const first = harness();
  await releaseSite(execute, first.dependencies);
  const saved = first.state.evidence["intent.json"];
  const rollbackOptions = { target, rollback: saved, expectedCurrentImage: image };
  const plan = harness({ manifest: { digest: previousImage.split("@")[1] } });
  plan.state.app = structuredClone(first.state.app);
  assert.equal((await releaseSite(rollbackOptions, plan.dependencies)).status, "PLANNED");
  assert.equal(plan.state.writes, 0);
  const back = harness({ manifest: { digest: previousImage.split("@")[1] } });
  back.state.app = structuredClone(first.state.app);
  assert.equal((await releaseSite({ ...rollbackOptions, execute: true, confirmTarget: target.resourceId }, back.dependencies)).status, "READY");
  assert.equal(back.state.app.properties.template.containers[0].image, previousImage);
  assert.equal(back.state.writes, 1);
  const unready = harness({ manifest: { digest: previousImage.split("@")[1] }, revision: (r) => { r.properties.healthState = "Unhealthy"; } });
  unready.state.app = structuredClone(first.state.app);
  await assert.rejects(releaseSite(rollbackOptions, unready.dependencies), /ROLLBACK_TARGET_NOT_RECONCILED/);
  assert.equal(unready.state.writes, 0);
});

test("explicit rollback reconciles a terminal failed revision before recovering the previous digest", async () => {
  const first = harness({ update: ({ app }) => { app.properties.provisioningState = "Failed"; app.properties.latestReadyRevisionName = "public-site--old"; } });
  assert.equal((await releaseSite(execute, first.dependencies)).status, "PROVISIONING_FAILED_RECONCILE_REQUIRED");
  const saved = first.state.evidence["intent.json"];
  const back = harness({ manifest: { digest: previousImage.split("@")[1] },
    revision: (r, s) => { if (!s.writes) { r.properties.provisioningState = "Failed"; r.properties.runningState = "ActivationFailed"; } },
    update: ({ app }) => { app.properties.provisioningState = "Succeeded"; },
  });
  back.state.app = structuredClone(first.state.app);
  assert.equal((await releaseSite({ target, rollback: saved, expectedCurrentImage: image, execute: true, confirmTarget: target.resourceId }, back.dependencies)).status, "READY");
  assert.equal(back.state.writes, 1);
  assert.equal(back.state.app.properties.template.containers[0].image, previousImage);
  const pending = harness({ manifest: { digest: previousImage.split("@")[1] } });
  pending.state.app = structuredClone(first.state.app);
  pending.state.app.properties.provisioningState = "Updating";
  await assert.rejects(releaseSite({ target, rollback: saved, expectedCurrentImage: image }, pending.dependencies), /BASELINE_NOT_READY_RECONCILE_FIRST/);
  assert.equal(pending.state.writes, 0);
});

test("rollback refuses a ready revision from another digest or changed original config", async () => {
  const first = harness();
  await releaseSite(execute, first.dependencies);
  const back = harness({ manifest: { digest: previousImage.split("@")[1] }, revision: (r) => { r.properties.template.containers[0].image = previousImage; } });
  back.state.app = structuredClone(first.state.app);
  const rollback = { target, rollback: first.state.evidence["intent.json"], expectedCurrentImage: image, execute: true, confirmTarget: target.resourceId };
  await assert.rejects(releaseSite(rollback, back.dependencies), /REVISION_IMAGE_MISMATCH/);
  assert.equal(back.state.writes, 0);
  back.state.app.properties.template.scale.minReplicas = 1;
  await assert.rejects(releaseSite(rollback, back.dependencies), /CONFIGURATION_DRIFT/);
  assert.equal(back.state.writes, 0);
});

test("already-targeted image verifies readiness without another update", async () => {
  const { state, dependencies } = harness();
  state.app.properties.template.containers[0].image = image;
  assert.equal((await releaseSite({ ...execute, expectedCurrentImage: image }, dependencies)).status, "READY");
  assert.equal(state.writes, 0);
});

test("config fingerprint ignores secret payloads and generated suffix but captures env changes", () => {
  const original = app();
  const before = inspectApp(original, target);
  original.properties.configuration.secrets[0].value = "provider-hidden";
  original.properties.template.revisionSuffix = "new";
  assert.equal(inspectApp(original, target).configurationFingerprint, before.configurationFingerprint);
  original.properties.template.containers[0].env[1].value = "changed";
  assert.notEqual(inspectApp(original, target).configurationFingerprint, before.configurationFingerprint);
  assert.deepEqual(validateTarget({ ...target, extra: secret }), target);
});

test("real CLI path writes private redacted planning evidence; child stderr never escapes", async () => {
  const directory = await mkdtemp(join(tmpdir(), "site-release-test-"));
  try {
    const fixture = join(directory, "fixture.json");
    await writeFile(fixture, JSON.stringify(app()), { mode: 0o600 });
    await writeFile(join(directory, "az"), `#!/usr/bin/env node
import fs from 'node:fs';
const args = process.argv.slice(2);
if (process.env.FAIL_AZ) { console.error('${secret}'); process.exit(1); }
if (args.includes('update')) { console.error('unexpected write'); process.exit(1); }
const app = JSON.parse(fs.readFileSync(process.env.SITE_TEST_FIXTURE, 'utf8'));
console.log(JSON.stringify(args[0] === 'account' ? { id: '${subscriptionId}', state: 'Enabled' }
  : args[0] === 'acr' && args[1] === 'show' ? { id: '${target.registryResourceId}', loginServer: '${target.registryServer}' }
  : args[0] === 'acr' ? { digest: '${digest}' } : app));
`, { mode: 0o700 });
    await writeFile(join(directory, "target.json"), JSON.stringify(target));
    await writeFile(join(directory, "receipt.json"), JSON.stringify(receipt));
    const args = ["scripts/azure-site-image-release.mjs", "--target", join(directory, "target.json"), "--receipt", join(directory, "receipt.json"),
      "--image", image, "--expected-current-image", previousImage, "--out", join(directory, "evidence")];
    const env = { ...process.env, PATH: `${directory}:${process.env.PATH}`, SITE_TEST_FIXTURE: fixture };
    const output = await promisify(execFile)(process.execPath, args, { env });
    assert.equal(JSON.parse(output.stdout).status, "PLANNED");
    assert.equal((await stat(join(directory, "evidence"))).mode & 0o777, 0o700);
    for (const file of await readdir(join(directory, "evidence"))) {
      assert.equal((await stat(join(directory, "evidence", file))).mode & 0o777, 0o600);
      assert.equal((await readFile(join(directory, "evidence", file), "utf8")).includes(secret), false);
    }
    await assert.rejects(promisify(execFile)(process.execPath, [...args.slice(0, -1), join(directory, "failed")], { env: { ...env, FAIL_AZ: "1" } }), (error) => {
      assert.equal(`${error.stdout}${error.stderr}`.includes(secret), false);
      assert.match(error.stderr, /AZURE_COMMAND_FAILED_OR_TIMED_OUT/);
      return true;
    });
    await assert.rejects(promisify(execFile)(process.execPath, args, { env }), /SITE_RELEASE_FAILED/);
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test("Azure transport bounds subprocess duration and suppresses provider diagnostics", async () => {
  // A missing subcommand fails without forwarding Azure CLI diagnostics. Use a fake
  // binary so this test never depends on login, network, or the installed Azure CLI.
  const directory = await mkdtemp(join(tmpdir(), "site-release-transport-"));
  const previousPath = process.env.PATH;
  try {
    await writeFile(join(directory, "az"), "#!/bin/sh\nexec /bin/sleep 20\n", { mode: 0o700 });
    process.env.PATH = `${directory}:${previousPath}`;
    await assert.rejects(azureCommand(["account", "show"], { timeoutMs: 0 }), /AZURE_COMMAND_DEADLINE_EXPIRED/);
    await assert.rejects(azureCommand(["account", "show"], { timeoutMs: 30 }), /AZURE_COMMAND_FAILED_OR_TIMED_OUT/);
  } finally {
    process.env.PATH = previousPath;
    await rm(directory, { recursive: true, force: true });
  }
});
