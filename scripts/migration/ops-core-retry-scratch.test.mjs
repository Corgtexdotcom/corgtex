import { afterEach, describe, expect, it } from "vitest";
import { mkdtemp, writeFile, rm, chmod, realpath } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { archiveEvidenceHash as hash } from "./ops-core-archive.mjs";
import { postgresRuntimeAccessIsolationInventory } from "./ops-core-postgres-runtime-access.mjs";
import { resolveRetryScratchAdmission } from "./ops-core-retry-scratch.mjs";

const dirs = [];
afterEach(async () => { for (const dir of dirs.splice(0)) await rm(dir, { recursive: true, force: true }); });
const ref = value => `sha256:${createHash("sha256").update(value).digest("hex").slice(0, 16)}`;

async function fixture() {
  const dir = await realpath(await mkdtemp(join(tmpdir(), "retry-scratch-"))); dirs.push(dir);
  await chmod(dir, 0o700);
  const target = { host: "pg.postgres.database.azure.com", port: 5432, database: "postgres", user: "admin" };
  const source = { host: "source.local", port: 5432, database: "source", user: "reader" };
  const oldName = "corgtex_rehearsal_1_1_core", newName = "corgtex_rehearsal_1_2_core";
  const baseRow = { name: "postgres", oid: "5", owner: "admin", allowConnections: true,
    isTemplate: false, ownerAuthority: true, acl: [{ grantee: "10", privilege: "CONNECT" }] };
  const oldRow = { name: oldName, oid: "277613", owner: "admin", allowConnections: true,
    isTemplate: false, ownerAuthority: true, acl: [{ grantee: "10", privilege: "CONNECT" }] };
  const isolation = postgresRuntimeAccessIsolationInventory({ databases: [baseRow] }, "core");
  const vault = "https://fixture.vault.azure.net/", secret = name => `${vault}secrets/${name}/${"a".repeat(32)}`;
  const policy = { schemaVersion: 2, providerProfile: "azure-flexible-postgres-18", runtimeRole: "corgtex_core_runtime",
    applicationSchema: "public", runtimeDatabaseSecrets: { web: secret("web"), worker: secret("worker") },
    scaler: { role: "worker_scale_core", connectionSecretVersion: secret("scaler") },
    isolation: { inventorySha256: isolation.inventorySha256, databases: [{ name: "postgres", oid: "5", owner: "admin",
      action: "replace-public-connect", beforeAclSha256: hash(baseRow.acl), preserveConnectRoles: [] }] } };
  const predecessorPlan = { domain: "core", transfer: { postgres: { scratchName: oldName, source, target, archiveStoreId: "archive",
    keyVersion: secret("archive") } } };
  const intent = { domain: "core", scratchName: oldName, source, target, archiveStoreId: "archive", keyVersion: secret("archive") };
  const abandoned = { operationId: "00000000-0000-4000-8000-000000000001", to: "CAPTURED", intentSha256: hash(intent) };
  const predecessorJournal = { phase: "SOURCE_RECOVERED", destinationMayHaveWritten: false,
    recovery: { abandonedPending: abandoned } };
  const plan = { domain: "core", transfer: { postgres: { target, scratchName: newName, runtimeAccess: policy } },
    activation: { runtimeVaultUri: vault }, azure: { domain: "core" }, operator: { retryOf: {
      intentSha256: hash(predecessorPlan), journalSha256: hash(predecessorJournal) } } };
  const evidence = { copy: { capture: abandoned, intent }, state: { phase: "MIGRATION_RETAINED", scratchName: oldName,
    scratchOid: oldRow.oid, scratchOwner: target.user, targetRef: ref(`${target.host}\0${oldName}`) } };
  await writeFile(join(dir, "copy-intent.json"), JSON.stringify(evidence.copy), { mode: 0o600 });
  await writeFile(join(dir, "scratch-state.json"), JSON.stringify(evidence.state), { mode: 0o600 });
  const state = { phase: "PREPARED", pending: null, destinationMayHaveWritten: false };
  const custody = { signal: new AbortController().signal, snapshot: () => state, assertOwned: async () => {} };
  const saved = new Map(), operationStore = { assertPrivate: async () => {}, readOptional: async key => saved.get(key) ?? null,
    createOnly: async (key, value) => { if (saved.has(key)) throw Error("EXISTS"); saved.set(key, value); } };
  const options = { plan, predecessorPlan, predecessorJournal, custody, operationStore,
    targetAdminConfig: { ...target, sslmode: "verify-full", targetTlsRootCert: "fixture-ca" },
    evidenceDirectory: dir, create: true, targetFactory: () => ({ assertInactive: async () => ({ complete: true }) }),
    openMaintenance: async () => ({ signal: custody.signal, assertHeld: async () => {}, close: async () => {} }),
    inspect: async () => ({ databaseOid: oldRow.oid, databaseOwner: target.user, empty: true, protectedAccess: true }),
    clientFactory: () => ({ connect: async () => {}, query: async sql => sql === "BEGIN READ ONLY" || sql === "ROLLBACK"
      ? { rows: [] } : { rows: [baseRow, oldRow] }, end: async () => {} }) };
  return { options, saved, state, oldRow, baseRow };
}

describe("preserved retry scratch admission", () => {
  it("retains an exact receipt and carries the complete verify-only policy into transfer", async () => {
    const f = await fixture();
    const first = await resolveRetryScratchAdmission(f.options);
    expect(first.policy.isolation.databases.find(row => row.name === f.oldRow.name)).toMatchObject({ action: "verify-only",
      oid: f.oldRow.oid, beforeAclSha256: hash(f.oldRow.acl) });
    expect(f.saved.size).toBe(1);
    f.state.phase = "SOURCE_FENCED";
    const continued = await resolveRetryScratchAdmission({ ...f.options, create: false,
      targetFactory: () => { throw Error("SHOULD_NOT_READ_BASELINE_AFTER_FENCE"); } });
    expect(continued).toEqual(first);
  });
  it("rejects every unrelated database inventory change before writing a receipt", async () => {
    const f = await fixture();
    const changed = { ...f.baseRow, oid: "6" };
    await expect(resolveRetryScratchAdmission({ ...f.options, clientFactory: () => ({ connect: async () => {},
      query: async sql => sql === "BEGIN READ ONLY" || sql === "ROLLBACK" ? { rows: [] } : { rows: [changed, f.oldRow] },
      end: async () => {} }) })).rejects.toThrow("RETRY_SCRATCH_OTHER_DATABASE_DRIFT");
    expect(f.saved.size).toBe(0);
  });
});
