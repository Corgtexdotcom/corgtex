import assert from "node:assert/strict";
import { test } from "node:test";
import { readFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { INTENDED_OPS_TARGETS as targets, collectOpsAzureInventory } from "./ops-core-azure-inventory.mjs";
import { createAzureTargetArmTransport } from "./ops-core-azure-target.mjs";
import { OPSCORE_SUBSCRIPTION } from "./ops-core-runtime-targets.mjs";
import { TARGETS } from "./ops-core-target-profile.mjs";

const secret = "DO-NOT-RETAIN-customer-password-or-provider-error";
const digestImage = `registry.example.test/corgtex/web@sha256:${"a".repeat(64)}`;
const template = () => ({ containers: [{ name: secret, image: digestImage, command: [secret], args: [secret],
  env: [{ name: "DATABASE_URL", value: secret }, { name: "SHARED_STATE_BACKEND", value: secret }, { name: "RELEASE_SHA", secretRef: secret }, { name: secret, value: secret }],
  resources: { cpu: 0.5, memory: "1Gi" } }], scale: { minReplicas: 0, maxReplicas: 1, rules: [{ metadata: { password: secret } }] } });
function fixture() {
  const responses = new Map(), calls = [];
  function set(key, properties, extra = {}) {
    const target = targets[key];
    responses.set(target.id, { status: 200, body: { id: target.id, type: target.type, name: target.id.split("/").at(-1),
      properties, tags: { customer: secret }, ...extra } });
  }
  set("postgres", { state: "Stopped", version: "18", fullyQualifiedDomainName: "corgtex-opscore-pg18.postgres.database.azure.com",
    storage: { storageSizeGB: 32 }, backup: { backupRetentionDays: 14, geoRedundantBackup: "Disabled" }, network: { publicNetworkAccess: "Disabled" }, administratorLogin: secret },
  { sku: { name: "Standard_D2ds_v5", tier: "GeneralPurpose" } });
  set("environment", { provisioningState: "Succeeded", vnetConfiguration: { infrastructureSubnetId: secret, internal: false }, appLogsConfiguration: { sharedKey: secret } });
  set("postgresEndpoint", { provisioningState: "Succeeded", privateLinkServiceConnections: [{ properties: {
    privateLinkServiceId: targets.postgres.id, groupIds: ["postgresqlServer"], privateLinkServiceConnectionState: { status: "Approved", description: secret } } }] });
  set("identity", { clientId: secret, principalId: secret });
  set("vault", { enableRbacAuthorization: true, enablePurgeProtection: true, softDeleteRetentionInDays: 90, publicNetworkAccess: "Enabled", accessPolicies: [secret] });
  set("storage", { allowSharedKeyAccess: false, allowBlobPublicAccess: false, supportsHttpsTrafficOnly: true, minimumTlsVersion: "TLS1_2", publicNetworkAccess: "Enabled", keys: [secret] });
  set("blobService", { isVersioningEnabled: true, deleteRetentionPolicy: { enabled: true, days: 14 }, containerDeleteRetentionPolicy: { enabled: true, days: 14 } });
  set("objects", { publicAccess: "None", metadata: { customer: secret } });
  for (const role of ["web", "worker"]) {
    set(role, { provisioningState: "Succeeded", environmentId: targets.environment.id, template: template(), configuration: { secrets: [{ name: secret, value: secret }], ingress: { external: role === "web" } } });
    const id = `${targets[role].id}/revisions/rev-one`;
    responses.set(`${targets[role].id}/revisions`, { status: 200, body: { value: [{ id, name: "rev-one", type: "Microsoft.App/containerApps/revisions", properties: { active: true, replicas: 1, template: template() } }] } });
  }
  responses.set(`${targets.postgres.id}/firewallRules`, { status: 200, body: { value: [] } });
  const transport = async request => {
    calls.push(request);
    const response = responses.get(request.nextLink ?? request.resourceId);
    assert.ok(response, `Unexpected request ${request.resourceId}`);
    return structuredClone(response);
  };
  return { responses, calls, transport, set, run: options => collectOpsAzureInventory({ transport, ...options }) };
}

test("complete sanitized ARM capture remains explicitly incomplete migration acceptance", async () => {
  const f = fixture(), receipt = await f.run();
  assert.equal(receipt.inventoryComplete, true);
  assert.equal(receipt.armChecksPassed, true);
  assert.equal(receipt.productionAccepted, false);
  assert.equal(receipt.railwayRetirementAccepted, false);
  assert.equal(receipt.observed.postgres.metadata.state, "Stopped");
  assert.equal(receipt.observed.webRevisions.revisions[0].containers[0].image, digestImage);
  assert.equal(receipt.observed.web.metadata.containers[0].secretReferenceCount, 1);
  assert.equal(JSON.stringify(receipt).includes(secret), false);
  assert.ok(receipt.evidenceGaps.length >= 6);
  assert.equal(f.calls.length, 13);
  assert.ok(f.calls.every(call => call.signal instanceof AbortSignal && !/core-(?:web|worker)|listKeys|listSecrets|\/databases\//i.test(call.resourceId)));
});

test("intended targets match existing qualification/runtime preparation contract, not live claims", () => {
  assert.ok(targets.postgres.id.endsWith(`/resourceGroups/${TARGETS.opscore.group}/providers/Microsoft.DBforPostgreSQL/flexibleServers/${TARGETS.opscore.server}`));
  const source = readFileSync(new URL("./prepare-opscore-runtime.mjs", import.meta.url), "utf8");
  assert.match(source, /ops-core-runtime-targets\.mjs/);
  for (const key of ["vault", "storage"]) assert.ok(source.includes(targets[key].id.split("/").at(-1)));
  for (const target of Object.values(targets)) assert.ok(target.id.startsWith(`/subscriptions/${OPSCORE_SUBSCRIPTION}/resourceGroups/rg-corgtex-opscore-hosting/`));
});

test("exact ResourceNotFound means absent; denied and other 404 responses remain unknown", async () => {
  const f = fixture();
  f.responses.set(targets.web.id, { status: 404, body: { error: { code: "ResourceNotFound", message: secret } } });
  f.responses.set(targets.worker.id, { status: 403, body: { error: { message: secret } } });
  f.responses.set(targets.vault.id, { status: 404, body: { error: { code: "ResourceGroupNotFound", message: secret } } });
  const result = await f.run();
  assert.equal(result.observed.web.status, "ABSENT");
  assert.equal(result.observed.worker.status, "UNKNOWN");
  assert.equal(result.observed.vault.status, "UNKNOWN");
  assert.equal(result.inventoryComplete, false);
  assert.equal(result.checks.find(row => row.name === "web_present").status, "FAIL");
  assert.equal(result.checks.find(row => row.name === "worker_present").status, "UNKNOWN");
  assert.equal(JSON.stringify(result).includes(secret), false);
  assert.ok(!f.calls.some(call => call.resourceId.includes("/revisions")));
});

test("identity drift, unknown field shapes, unsafe images and foreign environments cannot pass", async () => {
  const f = fixture();
  f.responses.get(targets.identity.id).body.id += "-foreign";
  f.responses.get(targets.web.id).body.properties.template.containers[0].image = `https://user:${secret}@example.test/image`;
  f.responses.get(targets.worker.id).body.properties.environmentId += "-foreign";
  f.responses.get(targets.vault.id).body.properties.enablePurgeProtection = secret;
  const result = await f.run();
  assert.equal(result.observed.identity.code, "RESOURCE_IDENTITY_MISMATCH");
  assert.equal(result.observed.web.metadata.containers[0].image, null);
  assert.equal(result.armChecksPassed, false);
  assert.equal(JSON.stringify(result).includes(secret), false);
});

test("network, backup, old image and storage protection drift produce failed checks without mutations", async () => {
  const f = fixture();
  f.responses.get(targets.postgres.id).body.properties.network.publicNetworkAccess = "Enabled";
  f.responses.get(targets.postgres.id).body.properties.backup.backupRetentionDays = 7;
  f.responses.get(targets.storage.id).body.properties.allowSharedKeyAccess = true;
  f.responses.get(targets.worker.id).body.properties.template.containers[0].image = "registry.example.test/corgtex/worker:mutable";
  const result = await f.run();
  assert.equal(result.inventoryComplete, true);
  for (const name of ["postgres_private_pg18_backup", "object_storage_protection", "worker_image_metadata"]) {
    assert.equal(result.checks.find(row => row.name === name).status, "FAIL");
  }
});

test("collections are paginated and firewall bodies are never retained", async () => {
  const f = fixture(), path = `${targets.postgres.id}/firewallRules`, next = `https://management.azure.com${path}?api-version=2025-08-01&$skiptoken=next`;
  f.responses.set(path, { status: 200, body: { value: [], nextLink: next } });
  f.responses.set(next, { status: 200, body: { value: [{ name: secret, properties: { startIpAddress: secret } }] } });
  const result = await f.run();
  assert.equal(result.observed.firewallRules.count, 1);
  assert.equal(result.checks.find(row => row.name === "postgres_private_pg18_backup").status, "FAIL");
  assert.equal(JSON.stringify(result).includes(secret), false);
});

test("cross-origin/resource/version pagination is rejected before sending a request", async () => {
  for (const link of ["https://evil.example.test/", `https://management.azure.com${targets.postgres.id}/configurations?api-version=2025-08-01`,
    `https://management.azure.com${targets.postgres.id}/firewallRules?api-version=wrong`]) {
    const f = fixture(), path = `${targets.postgres.id}/firewallRules`;
    f.responses.set(path, { status: 200, body: { value: [], nextLink: link } });
    const result = await f.run();
    assert.equal(result.observed.firewallRules.code, "PAGINATION_INVALID");
    assert.ok(!f.calls.some(call => call.nextLink));
  }
});

test("pagination cycles, oversized collections and malformed revisions fail closed", async () => {
  for (const mode of ["cycle", "limit", "revision"]) {
    const f = fixture(), path = `${targets.postgres.id}/firewallRules`;
    if (mode === "cycle") f.responses.set(path, { status: 200, body: { value: [], nextLink: `https://management.azure.com${path}?api-version=2025-08-01` } });
    if (mode === "limit") f.responses.set(path, { status: 200, body: { value: Array(501).fill({}) } });
    if (mode === "revision") f.responses.get(`${targets.web.id}/revisions`).body.value[0].id += "foreign";
    const result = await f.run();
    assert.equal(result.inventoryComplete, false);
    assert.equal(result.observed[mode === "revision" ? "webRevisions" : "firewallRules"].status, "UNKNOWN");
  }
});

test("provider exceptions and cancellation retain only fixed diagnostics", async () => {
  const f = fixture();
  const failed = await collectOpsAzureInventory({ transport: async () => { throw new Error(secret); } });
  assert.equal(failed.inventoryComplete, false);
  assert.equal(JSON.stringify(failed).includes(secret), false);
  const controller = new AbortController(); controller.abort();
  const canceled = await f.run({ signal: controller.signal });
  assert.equal(canceled.observed.postgres.code, "DEADLINE");
  assert.equal(f.calls.length, 0);
});

test("new ARM API versions use the existing bounded GET-only token transport", async () => {
  const calls = [];
  const transport = createAzureTargetArmTransport({ subscriptionId: OPSCORE_SUBSCRIPTION,
    execFileImpl(command, args, options, callback) {
      assert.equal(command, "az"); assert.deepEqual(args.slice(0, 2), ["account", "get-access-token"]);
      assert.equal(options.shell, false); callback(null, JSON.stringify({ accessToken: secret }));
    },
    fetchImpl: async (url, options) => { calls.push({ url, options }); return new Response('{"properties":{}}', { status: 200 }); },
  });
  for (const key of ["storage", "vault", "identity"]) await transport({ resourceId: targets[key].id, apiVersion: targets[key].apiVersion, signal: AbortSignal.timeout(1000) });
  assert.equal(calls.length, 3);
  assert.ok(calls.every(call => call.options.method === "GET" && call.options.redirect === "error"));
});

test("CLI defaults offline and rejects arbitrary selectors before any Azure token access", () => {
  const script = new URL("./ops-core-azure-inventory.mjs", import.meta.url);
  const offline = spawnSync(process.execPath, [script.pathname], { encoding: "utf8", env: { PATH: "" } });
  assert.equal(offline.status, 0);
  assert.equal(JSON.parse(offline.stdout).status, "NO_EXECUTION");
  for (const args of [["--subscription", "foreign"], ["--execute", "extra"], ["--execute"]]) {
    const result = spawnSync(process.execPath, [script.pathname, ...args], { encoding: "utf8", env: { PATH: "", AZURE_SUBSCRIPTION_ID: "foreign" } });
    assert.equal(result.status, 1);
    assert.ok(["INVALID_ARGUMENTS", "SUBSCRIPTION_MISMATCH"].includes(JSON.parse(result.stdout).code));
    assert.equal(result.stderr, "");
  }
});

test("workflow remains manual protected-main OIDC only with no data-plane credentials or writes", () => {
  const workflow = readFileSync(new URL("../../.github/workflows/azure-ops-inventory.yml", import.meta.url), "utf8");
  assert.match(workflow, /workflow_dispatch:/);
  assert.doesNotMatch(workflow, /pull_request|push:|schedule:|secrets\.|RAILWAY|OPS_API|az (?:rest|role|deployment|containerapp|postgres)/);
  assert.match(workflow, /if: github.ref == 'refs\/heads\/main'/);
  assert.match(workflow, /environment: azure-migration-foundation/);
  assert.match(workflow, /persist-credentials: false/);
  assert.match(workflow, /id-token: write/);
  assert.match(workflow, /azure\/login@v2/);
  assert.match(workflow, /ops-core-azure-inventory.mjs --execute/);
  assert.match(workflow, /path: \.artifacts\/azure-ops-inventory\/summary.json/);
  assert.match(readFileSync(new URL("../../package.json", import.meta.url), "utf8"), /ops-core-\*\.node-test\.mjs/);
});

test("resource presence remains proven while missing or malformed predicate metadata is UNKNOWN", async () => {
  for (const [key, name, mutate] of [
    ["vault", "vault_protection", p => { delete p.enablePurgeProtection; }],
    ["vault", "vault_protection", p => { p.enablePurgeProtection = "unexpected"; }],
    ["postgres", "postgres_private_pg18_backup", p => { delete p.backup; }],
    ["storage", "object_storage_protection", p => { p.minimumTlsVersion = {}; }],
    ["environment", "environment_provisioned", p => { delete p.vnetConfiguration; }],
    ["postgresEndpoint", "postgres_endpoint_approved", p => { delete p.privateLinkServiceConnections[0].properties.groupIds; }],
    ["postgresEndpoint", "postgres_endpoint_approved", p => { delete p.privateLinkServiceConnections; }],
    ["web", "web_image_metadata", p => { delete p.template.containers[0].image; }],
    ["web", "web_image_metadata", p => { p.template.containers = {}; }],
  ]) {
    const f = fixture(); mutate(f.responses.get(targets[key].id).body.properties);
    const result = await f.run();
    assert.equal(result.observed[key].status, "PRESENT", key);
    assert.equal(result.checks.find(row => row.name === `${key}_present`).status, "PASS", key);
    assert.equal(result.checks.find(row => row.name === name).status, "UNKNOWN", name);
    assert.equal(result.armChecksPassed, false);
    assert.equal(result.inventoryComplete, false);
    assert.equal(result.status, "INVENTORY_INCOMPLETE");
  }
});


test("long but bounded ACA revision names retain their exact image metadata", async () => {
  const f = fixture(), path = `${targets.web.id}/revisions`;
  const row = f.responses.get(path).body.value[0];
  row.name = `${targets.web.id.split("/").at(-1)}--${"a".repeat(64)}`;
  row.id = `${path}/${row.name}`;
  const result = await f.run();
  assert.equal(result.inventoryComplete, true);
  assert.equal(result.observed.webRevisions.revisions[0].id, row.id);
});


test("positively absent targets are a complete failed preflight, not fabricated child evidence", async () => {
  const f = fixture();
  for (const target of Object.values(targets)) f.responses.set(target.id, { status: 404, body: { error: { code: "ResourceNotFound" } } });
  const result = await f.run();
  assert.equal(result.inventoryComplete, true);
  assert.equal(result.armChecksPassed, false);
  assert.ok(result.checks.every(row => row.status === "FAIL"));
  assert.equal(result.observed.firewallRules.status, "NOT_OBSERVED");
  assert.equal(f.calls.length, 10);
});
