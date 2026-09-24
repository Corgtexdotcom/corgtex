import { AzureCliCredential } from "@azure/identity";
import { SecretClient } from "@azure/keyvault-secrets";
import { archiveEvidenceHash } from "./ops-core-archive.mjs";

class RuntimeConfigError extends Error {}
const need = (condition, code) => { if (!condition) throw new RuntimeConfigError(code); };
const same = (a, b) => archiveEvidenceHash(a) === archiveEvidenceHash(b);
const ENV_NAME = /^[A-Z][A-Z0-9_]{0,100}$/;
const GUID = /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/;
const OMIT = /^(?:RAILWAY_[A-Z0-9_]+|S3_(?:BUCKET_NAME|ENDPOINT|ACCESS_KEY_ID|ACCESS_KEY|SECRET_ACCESS_KEY|SECRET_KEY|REGION|FORCE_PATH_STYLE)|R2_(?:BUCKET_NAME|ACCOUNT_ID|ACCESS_KEY_ID|SECRET_ACCESS_KEY|ENDPOINT)|AWS_S3_BUCKET_NAME|ACCESS_KEY_ID|SECRET_ACCESS_KEY|BUCKET|BUCKET_ENDPOINT|BUCKET_REGION|PORT|HOSTNAME|SEED_SCRIPTS|CORGTEX_AUTO_SEED_[A-Z0-9_]+)$/;
const url = value => { try { return new URL(value); } catch { throw new RuntimeConfigError("RUNTIME_URL_INVALID"); } };
const secretName = (domain, role, name) => `migration-${domain}-${role}-${archiveEvidenceHash({ name }).slice(0, 32)}`;

/** The inventory contains names only. Every source value is either retained
 * exactly or explicitly replaced/omitted. Unknown application settings are
 * preserved as secrets, so adding a provider does not silently lose its config.
 */
export function prepareOpsCoreRuntimeValues({ plan, sourceEnvironments, databaseUrl, redisUrl }) {
  const p = structuredClone(plan);
  need(p?.schemaVersion === 1 && ["core", "ops"].includes(p.domain) && /^[a-f0-9]{64}$/.test(p.targetBindingSha256), "RUNTIME_PLAN_INVALID");
  const b = p.binding;
  const backend = b?.sharedStateBackend ?? "redis";
  need(["redis", "postgres"].includes(backend), "RUNTIME_SHARED_STATE_INVALID");
  // An inactive target may opt into a two-connection process pool for a
  // separately qualified shared server. Retained plans keep the five-connection
  // default. Never silently resize a supplied URL or an existing vault secret.
  const postgresConnectionLimit = b?.postgresConnectionLimit ?? 5;
  need(!Object.hasOwn(b ?? {}, "postgresConnectionLimit")
    || backend === "postgres" && [2, 5].includes(b.postgresConnectionLimit), "RUNTIME_DATABASE_POOL_BINDING_INVALID");
  need(b && /^https:\/\/[a-z0-9-]{3,24}\.vault\.azure\.net\/$/.test(b.vaultUri)
    && /^\/subscriptions\/[a-f0-9-]{36}\/resourceGroups\/[a-zA-Z0-9_.()-]+\/providers\/Microsoft\.ManagedIdentity\/userAssignedIdentities\/[a-zA-Z0-9-]+$/.test(b.identityResourceId)
    && GUID.test(b.identityClientId) && /^[a-z0-9]{3,24}$/.test(b.storageAccount)
    && /^[a-z0-9][a-z0-9-]{1,61}[a-z0-9]$/.test(b.storageContainer)
    && /^[a-z0-9-]+\.postgres\.database\.azure\.com$/.test(b.postgresHost)
    && (backend === "postgres" ? b.redisHost === null : /^[a-z0-9.-]+\.redis\.azure\.net$/.test(b.redisHost)), "RUNTIME_BINDING_INVALID");
  const database = url(databaseUrl);
  if (Object.hasOwn(b, "postgresUser")) {
    let user;
    try { user = decodeURIComponent(database.username); } catch { throw new RuntimeConfigError("RUNTIME_DATABASE_USER_INVALID"); }
    need(b.postgresUser === `corgtex_${p.domain}_runtime` && user === b.postgresUser,
      "RUNTIME_DATABASE_USER_INVALID");
  }
  need(["postgres:", "postgresql:"].includes(database.protocol) && database.hostname === b.postgresHost
    && (!database.port || database.port === "5432") && database.pathname === `/corgtex_${p.domain}`
    && database.username.length > 0 && database.password.length > 0 && !database.hash
    && database.searchParams.get("sslmode") === "verify-full"
    && [...database.searchParams.keys()].every(key => ["sslmode", "schema", "connection_limit", "pool_timeout"].includes(key))
    && [...new Set(database.searchParams.keys())].every(key => database.searchParams.getAll(key).length === 1), "RUNTIME_DATABASE_INVALID");
  for (const [name, maximum] of [["connection_limit", 5], ["pool_timeout", 30]]) {
    const value = database.searchParams.get(name);
    need(value === null || /^[1-9][0-9]*$/.test(value) && Number(value) <= maximum, "RUNTIME_DATABASE_POOL_INVALID");
  }
  if (backend === "postgres") {
    need(redisUrl == null && database.searchParams.get("connection_limit") === String(postgresConnectionLimit)
      && database.searchParams.get("pool_timeout") === "10", "RUNTIME_POSTGRES_STATE_INVALID");
  } else {
    const redis = url(redisUrl);
    need(redis.protocol === "rediss:" && redis.hostname === b.redisHost && redis.port === "10000"
      && redis.password.length > 0 && ["", "/", "/0"].includes(redis.pathname)
      && !redis.search && !redis.hash, "RUNTIME_REDIS_INVALID");
  }
  const roles = {};
  for (const role of ["web", "worker"]) {
    const source = sourceEnvironments?.[role]; const inventory = p.roles?.[role];
    need(source && typeof source === "object" && !Array.isArray(source) && inventory
      && Array.isArray(inventory.sourceNames) && Array.isArray(inventory.omit)
      && new Set(inventory.sourceNames).size === inventory.sourceNames.length
      && same([...inventory.sourceNames].sort(), Object.keys(source).sort())
      && inventory.sourceNames.every(name => ENV_NAME.test(name) && typeof source[name] === "string"
        && Buffer.byteLength(source[name]) <= 25_000 && !source[name].includes("\0"))
      && new Set(inventory.omit).size === inventory.omit.length
      && inventory.omit.every(name => inventory.sourceNames.includes(name) && OMIT.test(name)), "RUNTIME_SOURCE_INVENTORY_MISMATCH");
    // Railway build identity and source infrastructure must not masquerade as
    // the new runtime. Require explicit decisions even for injected metadata.
    need(inventory.sourceNames.filter(name => OMIT.test(name)).every(name => inventory.omit.includes(name)), "RUNTIME_SOURCE_INFRASTRUCTURE_UNCLASSIFIED");
    need((source.SHARED_STATE_BACKEND ?? "redis") === "redis", "RUNTIME_SOURCE_SHARED_STATE_UNSUPPORTED");
    const generated = {
      SHARED_STATE_BACKEND: backend,
      NODE_ENV: "production", STORAGE_PROVIDER: "azure_blob", AZURE_STORAGE_AUTH_MODE: "managed_identity",
      AZURE_STORAGE_ACCOUNT_NAME: b.storageAccount, AZURE_STORAGE_CONTAINER_NAME: b.storageContainer,
      AZURE_STORAGE_BLOB_ENDPOINT: `https://${b.storageAccount}.blob.core.windows.net/`,
      AZURE_CLIENT_ID: b.identityClientId, AZURE_STORAGE_CLIENT_ID: b.identityClientId,
      ...(role === "web" ? { CORGTEX_STARTUP_MODE: "migrate-and-web", PORT: "3000", HOSTNAME: "0.0.0.0" }
        : { WORKER_HEALTH_PORT: "9090" }),
    };
    const retained = Object.fromEntries(Object.entries(source).filter(([name]) => !inventory.omit.includes(name)
      && !Object.hasOwn(generated, name) && !["DATABASE_URL", "REDIS_URL", "CORGTEX_RELEASE_GIT_SHA", "CORGTEX_RELEASE_IMAGE_TAG", "CORGTEX_RELEASE_VERSION", "CORGTEX_STARTUP_MODE"].includes(name)));
    // Existing application credentials and external origins are not regenerated.
    need(typeof retained.SESSION_COOKIE_SECRET === "string" && retained.SESSION_COOKIE_SECRET.length > 0
      && typeof retained.ENCRYPTION_KEY === "string" && retained.ENCRYPTION_KEY.length > 0, "RUNTIME_CONTINUITY_SECRET_MISSING");
    const values = { ...retained, DATABASE_URL: databaseUrl, ...(backend === "redis" ? { REDIS_URL: redisUrl } : {}) };
    roles[role] = { generated, values };
  }
  for (const name of ["ENCRYPTION_KEY", "SESSION_COOKIE_SECRET"]) {
    need(roles.web.values[name] === roles.worker.values[name], "RUNTIME_CONTINUITY_SECRET_MISMATCH");
  }
  need((roles.web.values.REDIS_KEY_PREFIX ?? "corgtex") === (roles.worker.values.REDIS_KEY_PREFIX ?? "corgtex"), "RUNTIME_REDIS_PREFIX_MISMATCH");
  return { plan: p, roles };
}

/** Populate a new runtime vault before freezing the global cutover plan. Source
 * services are untouched. Existing different values are never overwritten. An
 * uncertain set is reconciled by a later read; SDK write retries are disabled.
 * Only exact version references leave this function, never secret values.
 */
export async function retainOpsCoreRuntimeConfig(options) {
  try {
    const prepared = prepareOpsCoreRuntimeValues(options);
    const { plan, roles } = prepared;
    const { signal, assertTargetInactive } = options;
    need(signal instanceof AbortSignal && typeof assertTargetInactive === "function", "RUNTIME_GUARD_REQUIRED");
    const client = options.secretClient ?? new SecretClient(plan.binding.vaultUri,
      new AzureCliCredential({ processTimeoutInMs: 10_000 }), { retryOptions: { maxRetries: 0 } });
    const check = async () => {
      signal.throwIfAborted(); const evidence = await assertTargetInactive(); signal.throwIfAborted();
      need(evidence?.complete === true && evidence.domain === plan.domain
        && evidence.targetBindingSha256 === plan.targetBindingSha256, "RUNTIME_TARGET_UNPROVEN");
    };
    const read = async name => {
      try { return await client.getSecret(name, { abortSignal: signal }); }
      catch (error) { if (error?.statusCode === 404 && error?.code === "SecretNotFound") return null; throw error; }
    };
    const result = { schemaVersion: 1, domain: plan.domain, planSha256: archiveEvidenceHash(plan), roles: {} };
    await check();
    for (const role of ["web", "worker"]) {
      const env = Object.entries(roles[role].generated).map(([name, value]) => ({ name, value }));
      const secrets = [];
      for (const [name, value] of Object.entries(roles[role].values).sort(([a], [b]) => a.localeCompare(b))) {
        const key = secretName(plan.domain, role, name);
        await check(); let found = await read(key); await check();
        if (found === null) {
          await client.setSecret(key, value, { abortSignal: signal,
            tags: { corgtexMigrationDomain: plan.domain, corgtexMigrationRole: role } });
          await check(); found = await read(key); await check();
        }
        need(found?.value === value && found.properties?.enabled !== false
          && typeof found.properties?.version === "string" && /^[a-f0-9]{32}$/.test(found.properties.version)
          && found.properties?.id === `${plan.binding.vaultUri}secrets/${key}/${found.properties.version}`
          && (!found.properties.expiresOn || found.properties.expiresOn.getTime() > Date.now() + 86_400_000), "RUNTIME_SECRET_READBACK_MISMATCH");
        // A short deterministic ACA secret name avoids its 253-char name cap.
        const ref = `env-${archiveEvidenceHash({ role, name }).slice(0, 32)}`;
        secrets.push({ name: ref, keyVaultUrl: found.properties.id, identity: plan.binding.identityResourceId });
        env.push({ name, secretRef: ref });
      }
      result.roles[role] = { env: env.sort((a, b) => a.name.localeCompare(b.name)), secrets };
    }
    await check();
    return result;
  } catch (error) {
    throw error instanceof RuntimeConfigError ? error : new RuntimeConfigError("RUNTIME_CONFIG_RECONCILIATION_REQUIRED");
  }
}
