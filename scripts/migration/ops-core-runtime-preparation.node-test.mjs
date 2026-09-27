import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, writeFile, chmod, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { archiveEvidenceHash } from "./ops-core-archive.mjs";
import { opsCoreAzureTargetBindingSha256 } from "./ops-core-azure-target.mjs";
import { prepareOpsCoreRuntimeValues } from "./ops-core-runtime-config.mjs";
import { readPrivateInput, prepareRuntime, validateRuntimePreparationInput,
  validateRuntimePreparationReceipt } from "./prepare-opscore-runtime.mjs";

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

function observe({ active = false, publicAccess = "Disabled", clientId = "00000000-0000-4000-8000-000000000001",
  missingGrant = false, domain = "core" } = {}) {
  const principalId = "00000000-0000-4000-8000-000000000002";
  const vault = domain === "core" ? "kv-corgtexopscore-dd43kj" : "kv-corgtexopscore-tipmed";
  const account = domain === "core" ? "ctcorgtexopdd43kje22xbry" : "ctcorgtexoptipmedtany44y";
  const storage = `${base}Microsoft.Storage/storageAccounts/${account}`;
  return async args => {
    if (args[0] === "postgres") return { id: `${base}Microsoft.DBforPostgreSQL/flexibleServers/corgtex-opscore-pg18`,
      state: "Stopped", version: "18", sku: { name: "Standard_D2ds_v5", tier: "GeneralPurpose" },
      network: { publicNetworkAccess: publicAccess } };
    if (args[0] === "containerapp") return active ? [{ name: "unexpected-app" }] : [];
    if (args[0] === "identity") return { id: `${base}Microsoft.ManagedIdentity/userAssignedIdentities/id-corgtex-opscore-${domain}`,
      clientId, principalId };
    if (args[0] === "role") return [
      { principalId, roleDefinitionName: "Key Vault Secrets User", scope: `${base}Microsoft.KeyVault/vaults/${vault}` },
      { principalId, roleDefinitionName: "Storage Blob Data Contributor",
        scope: `${storage}/blobServices/default/containers/objects` },
      ...missingGrant ? [] : [{ principalId, roleDefinitionName: "Storage Blob Delegator", scope: storage }],
    ];
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
  await assert.rejects(prepareRuntime(prepared, "core", { observe: observe({ active: true }), retain }), /RUNTIME_TARGET_ACTIVE/);
  await assert.rejects(prepareRuntime(prepared, "core", { observe: observe({ publicAccess: "Enabled" }), retain }), /RUNTIME_TARGET_CHANGED/);
  prepared.plan.binding.vaultUri = "https://other.vault.azure.net/";
  assert.throws(() => validateRuntimePreparationInput(prepared, "core"), /RUNTIME_PREPARATION_PLAN_INVALID/);
  assert.equal(calls, 0);
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
