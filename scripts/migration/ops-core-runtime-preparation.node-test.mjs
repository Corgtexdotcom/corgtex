import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdtemp, writeFile, chmod, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { archiveEvidenceHash } from "./ops-core-archive.mjs";
import { opsCoreAzureTargetBindingSha256 } from "./ops-core-azure-target.mjs";
import { prepareOpsCoreRuntimeValues } from "./ops-core-runtime-config.mjs";
import { readPrivateInput, prepareRuntime, validateRuntimePreparationInput,
  validateRuntimePreparationReceipt, runtimePreparationDiagnostic } from "./prepare-opscore-runtime.mjs";

const subscription = "227eb707-bc46-415e-a09b-7d2b69fb14b2";
const base = `/subscriptions/${subscription}/resourceGroups/rg-corgtex-opscore-hosting/providers/`;

function input(domain = "core") {
  const target = { domain, subscriptionId: subscription, resourceGroupName: "rg-corgtex-opscore-hosting",
    environmentId: `${base}Microsoft.App/managedEnvironments/cae-corgtex-opscore`,
    sharedStateBackend: "postgres", redis: null,
    postgres: { resourceId: `${base}Microsoft.DBforPostgreSQL/flexibleServers/corgtex-opscore-pg18`,
      host: "corgtex-opscore-pg18.postgres.database.azure.com", major: 18,
      privateEndpointId: `${base}Microsoft.Network/privateEndpoints/pe-corgtex-opscore-shared-pg` },
    apps: { web: `ca-corgtex-opscore-${domain}-web`, worker: `ca-corgtex-opscore-${domain}-worker` } };
  const source = { SESSION_COOKIE_SECRET: "session-fixture", ENCRYPTION_KEY: "encryption-fixture" };
  const sourceNames = Object.keys(source);
  return { schemaVersion: 1, domain, target,
    plan: { schemaVersion: 1, domain, targetBindingSha256: opsCoreAzureTargetBindingSha256(target),
      binding: { sharedStateBackend: "postgres", vaultUri: domain === "core"
        ? "https://kv-corgtexopscore-dd43kj.vault.azure.net/" : "https://kv-corgtexopscore-tipmed.vault.azure.net/",
      identityResourceId: `${base}Microsoft.ManagedIdentity/userAssignedIdentities/id-corgtex-opscore-${domain}`,
      identityClientId: "00000000-0000-4000-8000-000000000001",
      storageAccount: domain === "core" ? "ctcorgtexopdd43kje22xbry" : "ctcorgtexoptipmedtany44y",
      storageContainer: "objects", postgresHost: target.postgres.host,
      postgresUser: `corgtex_${domain}_runtime`, redisHost: null },
      roles: { web: { sourceNames, omit: [] }, worker: { sourceNames, omit: [] } } },
    sourceEnvironments: { web: source, worker: structuredClone(source) },
    databaseUrl: `postgresql://corgtex_${domain}_runtime:password@corgtex-opscore-pg18.postgres.database.azure.com/corgtex_${domain}?sslmode=verify-full&connection_limit=5&pool_timeout=10`,
    redisUrl: null };
}

function observe({ appNames = [], publicAccess = "Disabled", clientId = "00000000-0000-4000-8000-000000000001",
  missingGrant = false, domain = "core" } = {}) {
  const principalId = "00000000-0000-4000-8000-000000000002";
  const vault = domain === "core" ? "kv-corgtexopscore-dd43kj" : "kv-corgtexopscore-tipmed";
  const account = domain === "core" ? "ctcorgtexopdd43kje22xbry" : "ctcorgtexoptipmedtany44y";
  const storage = `${base}Microsoft.Storage/storageAccounts/${account}`;
  return async args => {
    if (args[0] === "postgres") return { id: `${base}Microsoft.DBforPostgreSQL/flexibleServers/corgtex-opscore-pg18`,
      state: "Stopped", version: "18", sku: { name: "Standard_D2ds_v5", tier: "GeneralPurpose" },
      network: { publicNetworkAccess: publicAccess } };
    if (args[0] === "containerapp") return appNames.map(name => ({ name }));
    if (args[0] === "identity") return { id: `${base}Microsoft.ManagedIdentity/userAssignedIdentities/id-corgtex-opscore-${domain}`,
      clientId, principalId };
    if (args[0] === "role") {
      assert.ok(args.includes("--include-inherited"));
      const scope = args[args.indexOf("--scope") + 1];
      return [
        { principalId, roleDefinitionName: "Key Vault Secrets User", scope: `${base}Microsoft.KeyVault/vaults/${vault}` },
        { principalId, roleDefinitionName: "Storage Blob Data Contributor",
          scope: `${storage}/blobServices/default/containers/objects` },
        ...missingGrant ? [] : [{ principalId, roleDefinitionName: "Storage Blob Delegator", scope: storage }],
      ].filter(row => row.scope === scope);
    }
    throw new Error("UNEXPECTED_OBSERVATION");
  };
}

function retained(input) {
  const prepared = prepareOpsCoreRuntimeValues(input);
  const roles = {};
  for (const role of ["web", "worker"]) {
    const env = Object.entries(prepared.roles[role].generated).map(([name, value]) => ({ name, value }));
    const secrets = [];
    for (const name of Object.keys(prepared.roles[role].values)) {
      const ref = `env-${archiveEvidenceHash({ role, name }).slice(0, 32)}`;
      env.push({ name, secretRef: ref });
      secrets.push({ name: ref,
        keyVaultUrl: `${input.plan.binding.vaultUri}secrets/migration-${input.domain}-${role}-${archiveEvidenceHash({ name }).slice(0, 32)}/${"a".repeat(32)}`,
        identity: input.plan.binding.identityResourceId });
    }
    roles[role] = { env, secrets };
  }
  return { schemaVersion: 1, domain: input.domain, planSha256: archiveEvidenceHash(input.plan), roles };
}

test("runtime preparation retains only after the exact inactive target is observed", async () => {
  const prepared = input();
  let calls = 0;
  const receipt = await prepareRuntime(prepared, "core", { observe: observe(),
    retain: async options => {
      calls++;
      assert.equal(options.plan.targetBindingSha256, prepared.plan.targetBindingSha256);
      await options.assertTargetInactive();
      return retained(prepared);
    } });
  assert.equal(calls, 1);
  assert.equal(receipt.domain, "core");
  assert.equal(receipt.targetBindingSha256, prepared.plan.targetBindingSha256);
});

test("receipt refuses source values in the artifact", () => {
  const prepared = input();
  const receipt = retained(prepared);
  const secret = receipt.roles.web.env.find(row => row.name === "SESSION_COOKIE_SECRET");
  delete secret.secretRef;
  secret.value = "session-fixture";
  const validated = validateRuntimePreparationInput(prepared, "core");
  assert.throws(() => validateRuntimePreparationReceipt(receipt, validated), /RUNTIME_RECEIPT_INVALID/);
});

test("active apps, open public access, and wrong runtime custody fail before secrets", async () => {
  const prepared = input();
  let calls = 0;
  const retain = async () => { calls++; };
  await assert.rejects(prepareRuntime(prepared, "core", {
    observe: observe({ appNames: ["ca-corgtex-opscore-core-web"] }), retain,
  }), /RUNTIME_TARGET_ACTIVE/);
  await assert.rejects(prepareRuntime(prepared, "core", {
    observe: observe({ appNames: ["unknown-app"] }), retain,
  }), /RUNTIME_TARGET_ACTIVE/);
  await assert.rejects(prepareRuntime(prepared, "core", { observe: observe({ publicAccess: "Enabled" }), retain }), /RUNTIME_TARGET_CHANGED/);
  prepared.plan.binding.vaultUri = "https://other.vault.azure.net/";
  assert.throws(() => validateRuntimePreparationInput(prepared, "core"), /RUNTIME_PREPARATION_PLAN_INVALID/);
  assert.equal(calls, 0);
});

test("Ops preparation permits only the already deployed Core apps", async () => {
  const prepared = input("ops");
  const coreApps = ["ca-corgtex-opscore-core-web", "ca-corgtex-opscore-core-worker"];
  const receipt = await prepareRuntime(prepared, "ops", {
    observe: observe({ domain: "ops", appNames: coreApps }),
    retain: async () => retained(prepared),
  });
  assert.equal(receipt.domain, "ops");
  await assert.rejects(prepareRuntime(prepared, "ops", {
    observe: observe({ domain: "ops", appNames: [...coreApps, "ca-corgtex-opscore-ops-web"] }),
    retain: async () => retained(prepared),
  }), /RUNTIME_TARGET_ACTIVE/);
});

test("stale identity client ID or missing runtime grants fail before vault writes", async () => {
  const prepared = input();
  let calls = 0;
  const retain = async () => { calls++; };
  await assert.rejects(prepareRuntime(prepared, "core", {
    observe: observe({ clientId: "00000000-0000-4000-8000-000000000003" }), retain,
  }), /RUNTIME_IDENTITY_CHANGED/);
  await assert.rejects(prepareRuntime(prepared, "core", {
    observe: observe({ missingGrant: true }), retain,
  }), /RUNTIME_IDENTITY_GRANTS_MISSING/);
  assert.equal(calls, 0);
});

test("removed runtime grant after vault retention blocks the final receipt", async () => {
  const prepared = input();
  let retainedSecrets = false;
  const normal = observe();
  const missing = observe({ missingGrant: true });
  await assert.rejects(prepareRuntime(prepared, "core", {
    observe: args => (retainedSecrets ? missing : normal)(args),
    retain: async () => { retainedSecrets = true; return retained(prepared); },
  }), /RUNTIME_IDENTITY_GRANTS_MISSING/);
  assert.equal(retainedSecrets, true);
});

test("private input rejects a group-readable file", async () => {
  const directory = await mkdtemp(join(tmpdir(), "opscore-runtime-"));
  try {
    const path = join(directory, "input.json");
    await writeFile(path, JSON.stringify(input()), { mode: 0o600 });
    assert.equal((await readPrivateInput(path)).domain, "core");
    await chmod(path, 0o644);
    await assert.rejects(readPrivateInput(path), /RUNTIME_INPUT_NOT_PRIVATE/);
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test("workflow input rejects a file larger than one Actions secret", async () => {
  const directory = await mkdtemp(join(tmpdir(), "opscore-runtime-"));
  try {
    const path = join(directory, "input.json");
    await writeFile(path, "x".repeat(48_001), { mode: 0o600 });
    await assert.rejects(readPrivateInput(path), /RUNTIME_INPUT_NOT_PRIVATE/);
  } finally { await rm(directory, { recursive: true, force: true }); }
});

async function runPreparationCli(prepared, text = JSON.stringify(prepared)) {
  const directory = await mkdtemp(join(tmpdir(), "opscore-runtime-cli-"));
  try {
    const inputPath = join(directory, "input.json"), receiptPath = join(directory, "receipt.json");
    await writeFile(inputPath, text, { mode: 0o600 });
    const script = fileURLToPath(new URL("./prepare-opscore-runtime.mjs", import.meta.url));
    // No inherited credentials or provider executables: validation must fail
    // before observation, and a regression cannot invoke a real Azure CLI.
    const result = spawnSync(process.execPath, [script, prepared.domain, inputPath, receiptPath], {
      encoding: "utf8", env: { PATH: directory }, timeout: 10_000,
    });
    assert.equal(result.error, undefined);
    assert.equal(result.signal, null);
    assert.equal(result.status, 1);
    assert.equal(result.stdout, "");
    assert.equal(existsSync(receiptPath), false);
    return result.stderr;
  } finally { await rm(directory, { recursive: true, force: true }); }
}

const cliSecrets = ["synthetic-private-user", "synthetic-private-password", "synthetic-private-token",
  "synthetic-session-secret", "synthetic-encryption-key", "fixture.up.railway.app", "old.example.test"];
function assertCliRedaction(text) {
  for (const secret of cliSecrets) assert.equal(text.includes(secret), false);
}

for (const domain of ["core", "ops"]) for (const role of ["web", "worker"]) for (const [code, url] of [
  ["RAILWAY_HOST", "https://synthetic-private-user:synthetic-private-password@fixture.up.railway.app:8443/mcp?token=synthetic-private-token"],
  ["LEGACY_ORIGIN", "http://synthetic-private-user:synthetic-private-password@old.example.test:8080/mcp?token=synthetic-private-token"],
  ["INVALID_ENDPOINT", "https://synthetic-private-user:synthetic-private-password@old.example.test:999999/mcp?token=synthetic-private-token"],
]) test(`runtime preparation CLI preserves ${code} for ${domain} ${role}`, async () => {
  const prepared = input(domain);
  prepared.plan.azureOnly = { enabled: true, legacyOrigins: ["https://old.example.test"] };
  for (const runtimeRole of ["web", "worker"]) Object.assign(prepared.sourceEnvironments[runtimeRole], {
    SESSION_COOKIE_SECRET: "synthetic-session-secret", ENCRYPTION_KEY: "synthetic-encryption-key",
  });
  prepared.sourceEnvironments[role].MCP_PUBLIC_URL = url;
  prepared.plan.roles[role].sourceNames = Object.keys(prepared.sourceEnvironments[role]);
  const stderr = await runPreparationCli(prepared);
  assertCliRedaction(stderr);
  assert.deepEqual(JSON.parse(stderr), { status: "RUNTIME_PREPARATION_FAILED", code: "RUNTIME_AZURE_ONLY_CONFIGURATION_INVALID",
    findings: [{ role, setting: "MCP_PUBLIC_URL", code }] });
});

test("runtime preparation CLI preserves a policy reason without serializing its private origin", async () => {
  const prepared = input();
  prepared.plan.azureOnly = { enabled: true,
    legacyOrigins: ["https://synthetic-private-user:synthetic-private-password@old.example.test?token=synthetic-private-token"] };
  const stderr = await runPreparationCli(prepared);
  assertCliRedaction(stderr);
  assert.deepEqual(JSON.parse(stderr), { status: "RUNTIME_PREPARATION_FAILED", code: "RUNTIME_AZURE_ONLY_CONFIGURATION_INVALID",
    findings: [{ role: "web", code: "POLICY_INVALID" }] });
});

test("runtime preparation CLI keeps unrelated input failures generic and redacted", async () => {
  const stderr = await runPreparationCli(input(), '{"private":"synthetic-private-password"');
  assertCliRedaction(stderr);
  assert.deepEqual(JSON.parse(stderr), { status: "RUNTIME_PREPARATION_FAILED", code: "RUNTIME_INPUT_INVALID" });
});

test("runtime preparation diagnostics omit extra finding fields and unrecognized diagnostic values", () => {
  const report = runtimePreparationDiagnostic({ message: "RUNTIME_AZURE_ONLY_CONFIGURATION_INVALID",
    stack: "synthetic-private-password", cause: { value: "synthetic-private-token" }, findings: [
      { role: "web", setting: "MCP_PUBLIC_URL", code: "RAILWAY_HOST", value: "synthetic-private-password",
        details: { url: "https://old.example.test" } },
      { role: "worker", code: "CONFIG_INVALID", value: "synthetic-private-token" },
      { role: "synthetic-private-user", setting: "APP_URL", code: "RAILWAY_HOST" },
      { role: "web", setting: "synthetic-private-password", code: "RAILWAY_HOST" },
      { role: "web", setting: "APP_URL", code: "synthetic-private-token" },
      null,
    ] });
  assertCliRedaction(JSON.stringify(report));
  assert.deepEqual(report, { status: "RUNTIME_PREPARATION_FAILED", code: "RUNTIME_AZURE_ONLY_CONFIGURATION_INVALID",
    findings: [{ role: "web", setting: "MCP_PUBLIC_URL", code: "RAILWAY_HOST" }, { role: "worker", code: "CONFIG_INVALID" }] });
});

test("runtime preparation diagnostics attach findings only to the recognized guard failure", () => {
  for (const message of ["RUNTIME_INPUT_INVALID", "synthetic-private-password"]) {
    const report = runtimePreparationDiagnostic({ message,
      findings: [{ role: "web", setting: "APP_URL", code: "RAILWAY_HOST", value: "synthetic-private-password" }] });
    assertCliRedaction(JSON.stringify(report));
    assert.deepEqual(report, { status: "RUNTIME_PREPARATION_FAILED",
      code: message === "RUNTIME_INPUT_INVALID" ? message : "RUNTIME_PREPARATION_UNEXPECTED" });
  }
});
