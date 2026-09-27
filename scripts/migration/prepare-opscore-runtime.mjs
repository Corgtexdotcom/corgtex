import { constants } from "node:fs";
import { open, writeFile } from "node:fs/promises";
import { execFile as execFileCallback } from "node:child_process";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { promisify } from "node:util";
import { archiveEvidenceHash } from "./ops-core-archive.mjs";
import { opsCoreAzureTargetBindingSha256 } from "./ops-core-azure-target.mjs";
import { prepareOpsCoreRuntimeValues, retainOpsCoreRuntimeConfig } from "./ops-core-runtime-config.mjs";

const execFile = promisify(execFileCallback);
const SUBSCRIPTION = "227eb707-bc46-415e-a09b-7d2b69fb14b2";
const GROUP = "rg-corgtex-opscore-hosting";
const SERVER = "corgtex-opscore-pg18";
const HOST = `${SERVER}.postgres.database.azure.com`;
const ENVIRONMENT = `cae-corgtex-opscore`;
const GUID = /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/;
const need = (condition, code) => { if (!condition) throw new Error(code); };
const exactKeys = (value, names) => value && typeof value === "object" && !Array.isArray(value)
  && Object.keys(value).sort().join() === [...names].sort().join();

export async function readPrivateInput(path) {
  let handle;
  try {
    handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
    const stat = await handle.stat();
    need(stat.isFile() && stat.nlink === 1 && stat.uid === process.getuid()
      && (stat.mode & 0o077) === 0 && stat.size > 0 && stat.size <= 48_000,
    "RUNTIME_INPUT_NOT_PRIVATE");
    return JSON.parse(await handle.readFile("utf8"));
  } catch (error) {
    if (error?.message === "RUNTIME_INPUT_NOT_PRIVATE") throw error;
    throw new Error("RUNTIME_INPUT_INVALID");
  } finally { await handle?.close(); }
}

export function validateRuntimePreparationInput(input, domain) {
  need(["core", "ops"].includes(domain)
    && exactKeys(input, ["schemaVersion", "domain", "target", "plan", "sourceEnvironments", "databaseUrl", "redisUrl"])
    && input.schemaVersion === 1 && input.domain === domain && input.redisUrl === null,
  "RUNTIME_PREPARATION_INPUT_INVALID");
  const target = input.target;
  const expectedBase = `/subscriptions/${SUBSCRIPTION}/resourceGroups/${GROUP}/providers/`;
  need(target?.domain === domain && target.subscriptionId === SUBSCRIPTION
    && target.resourceGroupName === GROUP
    && target.environmentId === `${expectedBase}Microsoft.App/managedEnvironments/${ENVIRONMENT}`
    && target.sharedStateBackend === "postgres" && target.redis === null
    && target.postgres?.resourceId === `${expectedBase}Microsoft.DBforPostgreSQL/flexibleServers/${SERVER}`
    && target.postgres?.host === HOST && target.postgres?.major === 18
    && target.postgres?.privateEndpointId === `${expectedBase}Microsoft.Network/privateEndpoints/pe-corgtex-opscore-shared-pg`
    && target.apps?.web === `ca-corgtex-opscore-${domain}-web`
    && target.apps?.worker === `ca-corgtex-opscore-${domain}-worker`,
  "RUNTIME_PREPARATION_TARGET_INVALID");
  const targetBindingSha256 = opsCoreAzureTargetBindingSha256(target);
  const plan = input.plan;
  need(plan?.domain === domain && plan.targetBindingSha256 === targetBindingSha256
    && plan.binding?.sharedStateBackend === "postgres"
    && plan.binding?.postgresHost === HOST
    && plan.binding?.redisHost === null
    && plan.binding?.vaultUri === (domain === "core"
      ? "https://kv-corgtexopscore-dd43kj.vault.azure.net/"
      : "https://kv-corgtexopscore-tipmed.vault.azure.net/")
    && plan.binding?.identityResourceId === `${expectedBase}Microsoft.ManagedIdentity/userAssignedIdentities/id-corgtex-opscore-${domain}`
    && GUID.test(plan.binding?.identityClientId ?? "")
    && plan.binding?.postgresUser === `corgtex_${domain}_runtime`
    && plan.binding?.storageAccount === (domain === "core" ? "ctcorgtexopdd43kje22xbry" : "ctcorgtexoptipmedtany44y")
    && plan.binding?.storageContainer === "objects",
  "RUNTIME_PREPARATION_PLAN_INVALID");
  const prepared = prepareOpsCoreRuntimeValues(input);
  return { domain, target, plan, targetBindingSha256, prepared };
}

export function validateRuntimePreparationReceipt(result, validated) {
  need(exactKeys(result, ["schemaVersion", "domain", "planSha256", "roles"])
    && result.schemaVersion === 1 && result.domain === validated.domain
    && result.planSha256 === archiveEvidenceHash(validated.plan)
    && exactKeys(result.roles, ["web", "worker"]), "RUNTIME_RECEIPT_INVALID");
  for (const role of ["web", "worker"]) {
    const produced = result.roles[role];
    const expected = validated.prepared.roles[role];
    need(exactKeys(produced, ["env", "secrets"]) && Array.isArray(produced.env)
      && Array.isArray(produced.secrets), "RUNTIME_RECEIPT_INVALID");
    const byName = new Map(produced.env.map(row => [row?.name, row]));
    const byRef = new Map(produced.secrets.map(row => [row?.name, row]));
    need(byName.size === produced.env.length && byRef.size === produced.secrets.length
      && byName.size === Object.keys(expected.generated).length + Object.keys(expected.values).length
      && byRef.size === Object.keys(expected.values).length, "RUNTIME_RECEIPT_INVALID");
    for (const [name, value] of Object.entries(expected.generated)) {
      need(exactKeys(byName.get(name), ["name", "value"]) && byName.get(name).value === value,
        "RUNTIME_RECEIPT_INVALID");
    }
    for (const name of Object.keys(expected.values)) {
      const env = byName.get(name);
      need(exactKeys(env, ["name", "secretRef"]) && typeof env.secretRef === "string"
        && /^env-[a-f0-9]{32}$/.test(env.secretRef), "RUNTIME_RECEIPT_INVALID");
      const secret = byRef.get(env.secretRef);
      need(exactKeys(secret, ["name", "keyVaultUrl", "identity"])
        && secret.identity === validated.plan.binding.identityResourceId
        && typeof secret.keyVaultUrl === "string"
        && secret.keyVaultUrl.startsWith(`${validated.plan.binding.vaultUri}secrets/migration-${validated.domain}-${role}-`)
        && /\/[a-f0-9]{32}$/.test(secret.keyVaultUrl), "RUNTIME_RECEIPT_INVALID");
    }
  }
  return result;
}

async function azureJson(args) {
  try {
    const { stdout } = await execFile("az", [...args, "--output", "json", "--only-show-errors"],
      { encoding: "utf8", timeout: 30_000, maxBuffer: 2 * 1024 * 1024, shell: false });
    return JSON.parse(stdout);
  } catch { throw new Error("RUNTIME_TARGET_OBSERVATION_FAILED"); }
}

export async function assertRuntimePreparationTarget({ domain, targetBindingSha256 }, observe = azureJson) {
  const server = await observe(["postgres", "flexible-server", "show", "--resource-group", GROUP, "--name", SERVER]);
  need(server?.id?.toLowerCase() === `/subscriptions/${SUBSCRIPTION}/resourcegroups/${GROUP}/providers/microsoft.dbforpostgresql/flexibleservers/${SERVER}`.toLowerCase()
    && ["Ready", "Stopped"].includes(server.state) && server.version === "18"
    && server.sku?.name === "Standard_D2ds_v5" && server.sku?.tier === "GeneralPurpose"
    && server.network?.publicNetworkAccess === "Disabled", "RUNTIME_TARGET_CHANGED");
  const apps = await observe(["containerapp", "list", "--resource-group", GROUP]);
  const other = domain === "core" ? "ops" : "core";
  const allowed = new Set([`ca-corgtex-opscore-${other}-web`, `ca-corgtex-opscore-${other}-worker`]);
  need(Array.isArray(apps) && apps.every(app => allowed.has(app?.name))
    && new Set(apps.map(app => app.name)).size === apps.length, "RUNTIME_TARGET_ACTIVE");
  return { complete: true, domain, targetBindingSha256 };
}

export async function assertRuntimePreparationAccess({ domain, plan }, observe = azureJson) {
  const identity = await observe(["identity", "show", "--resource-group", GROUP,
    "--name", `id-corgtex-opscore-${domain}`, "--subscription", SUBSCRIPTION]);
  need(identity?.id?.toLowerCase() === plan.binding.identityResourceId.toLowerCase()
    && identity.clientId === plan.binding.identityClientId
    && GUID.test(identity.principalId ?? ""), "RUNTIME_IDENTITY_CHANGED");
  const base = `/subscriptions/${SUBSCRIPTION}/resourceGroups/${GROUP}/providers/`;
  const vaultName = new URL(plan.binding.vaultUri).hostname.split(".")[0];
  const storage = `${base}Microsoft.Storage/storageAccounts/${plan.binding.storageAccount}`;
  const required = [
    ["Key Vault Secrets User", `${base}Microsoft.KeyVault/vaults/${vaultName}`],
    ["Storage Blob Data Contributor", `${storage}/blobServices/default/containers/${plan.binding.storageContainer}`],
    ["Storage Blob Delegator", storage],
  ];
  for (const [role, scope] of required) {
    const assignments = await observe(["role", "assignment", "list", "--assignee-object-id",
      identity.principalId, "--scope", scope, "--include-inherited", "--subscription", SUBSCRIPTION]);
    need(Array.isArray(assignments) && assignments.some(row => row?.principalId === identity.principalId
      && row.roleDefinitionName === role && row.scope?.toLowerCase() === scope.toLowerCase()),
    "RUNTIME_IDENTITY_GRANTS_MISSING");
  }
}

export async function prepareRuntime(input, domain, { retain = retainOpsCoreRuntimeConfig,
  observe = azureJson, signal = AbortSignal.timeout(30 * 60_000) } = {}) {
  const validated = validateRuntimePreparationInput(input, domain);
  const assertTargetInactive = () => assertRuntimePreparationTarget(validated, observe);
  await assertTargetInactive();
  await assertRuntimePreparationAccess(validated, observe);
  const result = await retain({ plan: validated.plan, sourceEnvironments: input.sourceEnvironments,
    databaseUrl: input.databaseUrl, redisUrl: null, signal, assertTargetInactive });
  await assertTargetInactive();
  await assertRuntimePreparationAccess(validated, observe);
  return { schemaVersion: 1, domain, targetBindingSha256: validated.targetBindingSha256,
    inputSha256: archiveEvidenceHash(input), result: validateRuntimePreparationReceipt(result, validated) };
}

async function main() {
  const [domain, inputPath, receiptPath] = process.argv.slice(2);
  need(["core", "ops"].includes(domain) && inputPath && receiptPath && process.argv.length === 5,
    "RUNTIME_PREPARATION_USAGE_INVALID");
  const input = await readPrivateInput(inputPath);
  const receipt = await prepareRuntime(input, domain);
  await writeFile(receiptPath, `${JSON.stringify(receipt)}\n`, { flag: "wx", mode: 0o600 });
  console.log(JSON.stringify({ status: "RUNTIME_CONFIG_RETAINED", domain,
    targetBindingSha256: receipt.targetBindingSha256, inputSha256: receipt.inputSha256,
    secretCounts: Object.fromEntries(Object.entries(receipt.result.roles).map(([role, value]) => [role, value.secrets.length])) }));
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  main().catch(error => {
    console.error(JSON.stringify({ status: "RUNTIME_PREPARATION_FAILED",
      code: /^[A-Z0-9_]+$/.test(error?.message ?? "") ? error.message : "RUNTIME_PREPARATION_UNEXPECTED" }));
    process.exitCode = 1;
  });
}
