import { describe, expect, it, vi } from "vitest";
import { archiveEvidenceHash as hash } from "./ops-core-archive.mjs";
import { runOpsCoreRuntimeAccess, assertOpsCoreRuntimeAccessForActivation, createRuntimeSecretResolver,
  preflightOpsCoreRuntimeAccess } from "./ops-core-runtime-access-controller.mjs";
import { validateRuntimeAccessActivationBinding, validateTransferRuntimeAccessBinding } from "./ops-core-runtime-access-binding.mjs";

const mock = vi.hoisted(() => ({ calls: [], status: "APPLIED", closed: 0 }));
vi.mock("pg", () => ({ default: { Client: class {
  async connect() {} async end() { mock.closed++; }
} } }));
vi.mock("./ops-core-postgres-maintenance.mjs", () => ({ openPostgresMaintenance: async ({ signal, assertOwned }) => {
  await assertOwned(); mock.calls.push("lock");
  return { signal, assertHeld: assertOwned, close: async () => { mock.calls.push("unlock"); } };
} }));
vi.mock("./ops-core-postgres-runtime-access.mjs", async original => ({ ...await original(),
  validatePostgresRuntimeAccessIntent: value => value,
  preparePostgresRuntimeAccess: async ({ plan, assertHeld, assertSourceFenced, assertTargetInactive }) => {
    await assertHeld(); await assertSourceFenced(); await assertTargetInactive(); mock.calls.push("prepare");
    return { plan, sha256: "a".repeat(64) };
  },
  applyPostgresRuntimeAccess: async ({ intent, persistIntent, persistExpectedAfter }) => {
    mock.calls.push("apply"); await persistIntent(intent);
    await persistExpectedAfter({ intentSha256: intent.sha256, manifestSha256: hash({}), manifest: {} });
    return { status: mock.status, intentSha256: intent.sha256, manifestSha256: hash({}) };
  },
  reconcilePostgresRuntimeAccess: async ({ intent, assertHeld, assertSourceFenced, assertTargetInactive }) => {
    await assertHeld(); await assertSourceFenced(); await assertTargetInactive(); mock.calls.push("reconcile");
    return { status: mock.status, intentSha256: intent.sha256, manifestSha256: hash({}) };
  },
  preparePostgresRuntimeAccessPreflight: async ({ inspectAzureQueryStore }) => {
    const historyPresent = inspectAzureQueryStore ? await inspectAzureQueryStore() : null;
    if (historyPresent) throw Error("RUNTIME_ACCESS_AZURE_QUERY_HISTORY_PRESENT");
    return { complete: true, historyPresent };
  },
}));

function fixture() {
  mock.calls.length = 0; mock.status = "APPLIED"; mock.closed = 0;
  const subscriptionId = "00000000-0000-4000-8000-000000000001";
  const resource = (type, name) => `/subscriptions/${subscriptionId}/resourceGroups/fixture/providers/${type}/${name}`;
  const vault = "https://fixture.vault.azure.net/";
  const secret = name => `${vault}secrets/${name}/${"c".repeat(32)}`;
  const policy = { schemaVersion: 1, runtimeRole: "corgtex_core_runtime", applicationSchema: "public",
    runtimeDatabaseSecrets: { web: secret("web"), worker: secret("worker") },
    scaler: { role: "worker_scale_core", connectionSecretVersion: secret("scaler") },
    isolation: { inventorySha256: "e".repeat(64), databases: [{ name: "postgres", oid: "5", owner: "admin",
      action: "replace-public-connect", beforeAclSha256: "f".repeat(64), preserveConnectRoles: [{ name: "admin", oid: "10" }] }] } };
  const azure = { domain: "core", subscriptionId, resourceGroupName: "fixture",
    environmentId: resource("Microsoft.App/managedEnvironments", "environment"), sharedStateBackend: "postgres",
    postgres: { resourceId: resource("Microsoft.DBforPostgreSQL/flexibleServers", "pg"),
      host: "pg.postgres.database.azure.com", major: 18, privateEndpointId: resource("Microsoft.Network/privateEndpoints", "pg-pe"), resourceGroupName: "fixture" },
    redis: null, apps: { web: "core-web", worker: "core-worker" } };
  const activation = { schemaVersion: 2, target: azure, runtimeAccess: policy, runtimeVaultUri: vault,
    workerDemand: { scalerConnectionSecret: { keyVaultUrl: policy.scaler.connectionSecretVersion } },
    roles: Object.fromEntries(["web", "worker"].map(role => [role, { env: [{ name: "DATABASE_URL", secretRef: "db" }],
      secrets: [{ name: "db", keyVaultUrl: policy.runtimeDatabaseSecrets[role] }] }])) };
  const plan = { schemaVersion: 2, domain: "core", azure, activation, transfer: { postgres: {
    target: { host: azure.postgres.host, port: 5432, database: "postgres", user: "admin" }, runtimeAccess: policy } } };
  const phase = { to: "VERIFIED", operationId: "00000000-0000-4000-8000-000000000003" };
  const state = { domain: "core", intentSha256: "d".repeat(64), phase: "RESTORED", pending: phase, history: [], destinationMayHaveWritten: false };
  const custody = { signal: new AbortController().signal, snapshot: () => structuredClone(state), assertOwned: async () => {} };
  const stored = new Map();
  const operationStore = { async assertPrivate() {}, async readOptional(key) { return stored.get(key) ?? null; },
    async createOnly(key, value) { expect(stored.has(key)).toBe(false); stored.set(key, value); } };
  const options = { plan, custody, operationStore, phase, databaseOid: "16401",
    targetAdminConfig: { ...plan.transfer.postgres.target, sslmode: "verify-full", targetTlsRootCert: "fixture-root" },
    resolveSecretVersion: async () => "private value",
    assertSourceFenced: async () => { mock.calls.push("fenced"); }, assertTargetInactive: async () => { mock.calls.push("inactive"); } };
  const verified = result => {
    const evidence = { runtimeAccess: result }, digest = hash(evidence);
    state.phase = "VERIFIED"; state.pending = null;
    state.history.push({ phase: "VERIFIED", operationId: phase.operationId, evidenceSha256: digest });
    stored.set(`operations/core/${state.intentSha256}/${phase.operationId}/phase-evidence-${digest}.json`, JSON.stringify(evidence));
  };
  return { options, state, stored, verified, plan, policy };
}

describe("retained runtime access integration", () => {
  it("retains and freshly reconciles exact policy/credential bindings before activation", async () => {
    const f = fixture(); const result = await runOpsCoreRuntimeAccess(f.options);
    expect(result.record.policySha256).toBe(hash(f.policy)); expect(mock.calls).toContain("apply");
    f.verified(result);
    const proof = await assertOpsCoreRuntimeAccessForActivation({ ...f.options, fresh: true });
    expect(proof.complete).toBe(true); expect(proof.freshAcceptance).toBe(true);
    expect(mock.calls.filter(x => x === "reconcile")).toHaveLength(1);
    expect(mock.calls.filter(x => x === "unlock")).toHaveLength(2);
    for (const text of f.stored.values()) expect(text).not.toContain("private value");
  });
  it("reconciliation never prepares or applies when intent is missing", async () => {
    const f = fixture();
    expect(await runOpsCoreRuntimeAccess({ ...f.options, reconcile: true })).toMatchObject({ complete: false,
      status: "CONTINUATION_AVAILABLE", nextAction: "resume-transfer" });
    expect(mock.calls).not.toContain("apply"); expect(mock.calls).not.toContain("prepare");
    expect(mock.calls).toContain("unlock");
    expect((await runOpsCoreRuntimeAccess(f.options)).record.result.status).toBe("APPLIED");
    expect(mock.calls.filter(x => x === "apply")).toHaveLength(1);
  });
  it("an inherited access intent is only reconciled even on explicit continuation", async () => {
    const f = fixture(); await runOpsCoreRuntimeAccess(f.options);
    await runOpsCoreRuntimeAccess(f.options);
    expect(mock.calls.filter(x => x === "apply")).toHaveLength(1);
    expect(mock.calls.filter(x => x === "reconcile")).toHaveLength(1);
  });
  it("missing receipt or changed phase/policy blocks activation", async () => {
    for (const change of ["receipt", "policy", "phase"]) {
      const f = fixture(), result = await runOpsCoreRuntimeAccess(f.options); f.verified(result);
      if (change === "receipt") f.stored.delete([...f.stored.keys()].find(key => key.endsWith("runtime-access-receipt.json")));
      if (change === "policy") f.plan.transfer.postgres.runtimeAccess.runtimeDatabaseSecrets.web = f.policy.runtimeDatabaseSecrets.worker;
      if (change === "phase") f.state.history[0].operationId = "00000000-0000-4000-8000-000000000099";
      await expect(assertOpsCoreRuntimeAccessForActivation({ ...f.options, fresh: true })).rejects.toThrow();
    }
  });
  it("uncertain SQL state cannot produce a verification receipt", async () => {
    const f = fixture(); mock.status = "INDETERMINATE";
    await expect(runOpsCoreRuntimeAccess(f.options)).rejects.toThrow("RECONCILIATION_REQUIRED");
    expect([...f.stored.keys()].some(key => key.endsWith("runtime-access-receipt.json"))).toBe(false);
  });
  it("after target writes, retained proof stays historical without replay or stale catalog assertions", async () => {
    const f = fixture(), result = await runOpsCoreRuntimeAccess(f.options); f.verified(result);
    f.state.destinationMayHaveWritten = true;
    expect((await assertOpsCoreRuntimeAccessForActivation({ ...f.options, fresh: false })).freshAcceptance).toBe(false);
    expect(mock.calls).not.toContain("reconcile");
    await expect(assertOpsCoreRuntimeAccessForActivation({ ...f.options, fresh: true })).rejects.toThrow("ALREADY_ACTIVE");
  });
});

describe("shared runtime credential binding", () => {
  it("requires policy for an existing shared server and rejects version mismatches", () => {
    const f = fixture(); expect(validateTransferRuntimeAccessBinding(f.plan)).toEqual(f.policy);
    f.plan.activation.roles.web.secrets[0].keyVaultUrl = f.policy.runtimeDatabaseSecrets.worker;
    expect(() => validateRuntimeAccessActivationBinding(f.plan.activation)).toThrow("CREDENTIAL_BINDING_MISMATCH");
    delete f.plan.transfer.postgres.runtimeAccess;
    expect(() => validateTransferRuntimeAccessBinding(f.plan)).toThrow("POLICY_REQUIRED");
  });
  it("a scaler secret cannot masquerade as the application connection", () => {
    const f = fixture(); f.plan.activation.workerDemand.scalerConnectionSecret.keyVaultUrl = f.policy.runtimeDatabaseSecrets.web;
    expect(() => validateRuntimeAccessActivationBinding(f.plan.activation)).toThrow("SCALER_BINDING_MISMATCH");
  });
  it("reads exact Key Vault versions and suppresses upstream secret diagnostics", async () => {
    const f = fixture(), seen = [], reference = f.policy.runtimeDatabaseSecrets.web;
    const resolve = createRuntimeSecretResolver({ vaultUri: f.plan.activation.runtimeVaultUri, signal: f.options.custody.signal,
      secretClient: { async getSecret(name, options) { seen.push([name, options.version]);
        return { value: "retained-private-value", properties: { id: reference, version: "c".repeat(32), enabled: true } }; } } });
    expect(await resolve(reference)).toBe("retained-private-value"); expect(seen).toEqual([["web", "c".repeat(32)]]);
    await expect(resolve(reference.replace(/\/[a-f0-9]{32}$/, ""))).rejects.toThrow("SECRET_UNAVAILABLE");
    const broken = createRuntimeSecretResolver({ vaultUri: f.plan.activation.runtimeVaultUri, signal: f.options.custody.signal,
      secretClient: { async getSecret() { throw new Error("private-provider-value"); } } });
    await expect(broken(reference)).rejects.toThrow(/^RUNTIME_ACCESS_SECRET_UNAVAILABLE$/);
  });
});

describe("Azure provider Query Store readback", () => {
  it("uses strict TLS and exact azure_sys identity, and rejects history, view errors and connection drift", async () => {
    for (const variant of ["empty", "rows", "view-error", "oid", "tls"]) {
      const f = fixture(); f.policy.schemaVersion = 2; f.policy.providerProfile = "azure-flexible-postgres-18";
      f.policy.isolation.databases.push({ name: "azure_sys", oid: "42", owner: "azuresu", action: "allow-provider-connect",
        beforeAclSha256: "f".repeat(64), preserveConnectRoles: [] });
      const calls = [];
      const clientFactory = config => ({
        connectionParameters: config,
        connection: { stream: { encrypted: true, authorized: variant !== "tls" } },
        async connect() { calls.push(`connect:${config.database}`); },
        async end() { calls.push(`end:${config.database}`); },
        async query(sql) {
          if (sql.includes("current_database() AS database,current_user AS administrator"))
            return { rows: [{ database: "azure_sys", administrator: "admin", sessionUser: "admin", version: 180006,
              oid: variant === "oid" ? "99" : "42" }] };
          if (sql.startsWith("SELECT EXISTS")) {
            calls.push(sql);
            if (variant === "view-error") throw Error("unreadable");
            return { rows: [{ hasRows: variant === "rows" }] };
          }
          return { rows: [] };
        },
      });
      const run = () => preflightOpsCoreRuntimeAccess({ ...f.options, assertOwned: async () => {}, clientFactory });
      if (variant === "empty") {
        expect((await run()).historyPresent).toBe(false);
        expect(calls.filter(call => call.startsWith("SELECT EXISTS"))).toHaveLength(4);
        expect(calls).toContain("end:azure_sys");
      } else await expect(run()).rejects.toThrow(variant === "rows"
        ? "RUNTIME_ACCESS_AZURE_QUERY_HISTORY_PRESENT" : "RUNTIME_ACCESS_AZURE_QUERY_STORE_READBACK_INVALID");
    }
  });
});
