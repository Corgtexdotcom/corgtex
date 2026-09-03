import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  validatePostgresRestoreRehearsal,
  validateRecoveryIntent,
  validateRehearsalPrincipal,
} from "./validate-postgres-restore-rehearsal.mjs";

const HASH_A = "a".repeat(64);
const HASH_B = "b".repeat(64);
const CLIENT_ID = "11111111-1111-4111-8111-111111111111";
const PRINCIPAL_ID = "22222222-2222-4222-8222-222222222222";
const SUBSCRIPTION_ID = "33333333-3333-4333-8333-333333333333";
const RESOURCE_GROUP = "rg-corgtex-migration-rehearsal";
const SCOPE = `/subscriptions/${SUBSCRIPTION_ID}/resourceGroups/${RESOURCE_GROUP}`;
const CONTRIBUTOR_ROLE_ID = "b24988ac-6180-42a0-ab88-20f7382dd24c";
const ROLE_ASSIGNMENT_ID = "44444444-4444-4444-8444-444444444444";
const POSTGRES_SERVER = "corgtex-mig-reh-restore-pg";
const POSTGRES_HOST = `${POSTGRES_SERVER}.postgres.database.azure.com`;
const POSTGRES_RESOURCE_ID = `${SCOPE}/providers/Microsoft.DBforPostgreSQL/flexibleServers/${POSTGRES_SERVER}`;

const sha256 = (value) => createHash("sha256").update(value).digest("hex");
const clone = (value) => structuredClone(value);

const databaseEvidence = () => ({
  server: { majorVersion: 18 },
  locale: {
    encoding: "UTF8",
    collation: "C",
    ctype: "C",
    provider: "builtin",
    providerLocale: "C.UTF-8",
    icuRules: null,
    collationVersion: "1",
    actualCollationVersion: "1",
  },
  extensions: [
    { name: "plpgsql", version: "1.0" },
    { name: "vector", version: "0.8.2" },
  ],
  schema: { algorithm: "PG_DUMP_SQL_TOKENS_V1", digest: HASH_A },
  tables: [
    { schema: "public", name: "Event", rowCount: 3, rowSha256: HASH_A },
    { schema: "public", name: "WorkflowJob", rowCount: 5, rowSha256: HASH_B },
  ],
  largeObjects: { count: 0, contentSha256: HASH_A },
  migrations: {
    rows: [{ name: "20260101000000_init", checksum: HASH_B, state: "FINISHED", appliedStepsCount: 1 }],
    counts: { finished: 1, rolledBack: 0, incomplete: 0 },
  },
  queues: {
    event: {
      statuses: [
        { status: "DISPATCHED", count: 3 },
        { status: "FAILED", count: 0 },
        { status: "PENDING", count: 0 },
      ],
      lockedCount: 0,
    },
    workflowJob: {
      statuses: [
        { status: "CANCELLED", count: 0 },
        { status: "COMPLETED", count: 4 },
        { status: "FAILED", count: 0 },
        { status: "PENDING", count: 1 },
        { status: "RUNNING", count: 0 },
      ],
      lockedCount: 0,
    },
  },
});

const evidence = () => {
  const source = databaseEvidence();
  return {
    schemaVersion: "1.0.0",
    domain: "core",
    sourceRef: "sha256:0123456789abcdef",
    targetRef: "sha256:fedcba9876543210",
    source,
    destination: clone(source),
    archiveSequences: {
      tocEntryCount: 1,
      beforeReplay: [{ schema: "public", name: "legacy_id_seq", lastValue: "42", isCalled: true }],
      afterReplay: [{ schema: "public", name: "legacy_id_seq", lastValue: "42", isCalled: true }],
    },
  };
};

const cleanup = () => ({
  scratchDatabase: { nameRef: "sha256:1111111111111111", dropped: true },
  firewallRule: { nameRef: "sha256:2222222222222222", deleted: true },
  credentials: { shredded: true },
});

const principalInput = () => ({
  clientId: CLIENT_ID,
  principalId: PRINCIPAL_ID,
  subscriptionId: SUBSCRIPTION_ID,
  resourceGroup: RESOURCE_GROUP,
  assignments: [{
    id: `${SCOPE}/providers/Microsoft.Authorization/roleAssignments/${ROLE_ASSIGNMENT_ID}`,
    scope: SCOPE,
    principalId: PRINCIPAL_ID,
    principalType: "ServicePrincipal",
    roleDefinitionId: `/subscriptions/${SUBSCRIPTION_ID}/providers/Microsoft.Authorization/roleDefinitions/${CONTRIBUTOR_ROLE_ID}`,
    condition: null,
  }],
});

const recoveryDocument = () => {
  const runId = "123456789";
  const runAttempt = "2";
  const domain = "core";
  const scratchName = `corgtex_rehearsal_${runId}_${runAttempt}_${domain}`;
  const firewallName = `corgtex-rehearsal-${runId}-${runAttempt}`;
  return {
    intent: {
      schemaVersion: "1.0.0",
      runId,
      runAttempt,
      domain,
      subscriptionId: SUBSCRIPTION_ID,
      target: {
        resourceGroup: RESOURCE_GROUP,
        serverName: POSTGRES_SERVER,
        resourceId: POSTGRES_RESOURCE_ID,
      },
      databaseState: {
        schemaVersion: "1.0.0",
        scratchName,
        targetRef: `sha256:${sha256(`${POSTGRES_HOST}\0${scratchName}`).slice(0, 16)}`,
        phase: "ABSENCE_VERIFIED",
      },
      firewallState: { schemaVersion: "1.0.0", name: firewallName, phase: "ABSENCE_VERIFIED" },
    },
    current: {
      subscriptionId: SUBSCRIPTION_ID,
      resourceGroup: RESOURCE_GROUP,
      serverName: POSTGRES_SERVER,
      postgresResourceId: POSTGRES_RESOURCE_ID,
      postgresHost: POSTGRES_HOST,
      runId,
      runAttempt,
      domain,
      scratchName,
      firewallName,
    },
  };
};

describe("validateRehearsalPrincipal", () => {
  it("accepts only the pinned UAMI with one exact RG-scoped Contributor assignment", () => {
    const receipt = validateRehearsalPrincipal(principalInput(), { expectedClientSha256: sha256(CLIENT_ID) });
    expect(receipt).toMatchObject({ status: "EXACT_REHEARSAL_PRINCIPAL", effectiveRoleAssignmentCount: 1 });
    expect(JSON.stringify(receipt)).not.toContain(CLIENT_ID);
    expect(JSON.stringify(receipt)).not.toContain(PRINCIPAL_ID);
    expect(JSON.stringify(receipt)).not.toContain(RESOURCE_GROUP);
  });

  it.each([
    ["duplicate effective assignment", (value) => value.assignments.push(clone(value.assignments[0])), "UNEXPECTED_EFFECTIVE_ROLE_ASSIGNMENT_COUNT"],
    ["foreign scope", (value) => { value.assignments[0].scope = `${SCOPE}-foreign`; }, "INHERITED_OR_FOREIGN_ROLE_ASSIGNMENT"],
    ["foreign target assignment id", (value) => { value.assignments[0].id = value.assignments[0].id.replace(RESOURCE_GROUP, `${RESOURCE_GROUP}-foreign`); }, "ASSIGNMENT_ID_SCOPE_MISMATCH"],
    ["conditioned Contributor", (value) => { value.assignments[0].condition = "true"; }, "UNEXPECTED_CONTRIBUTOR_CONDITION"],
  ])("rejects %s", (_label, mutate, code) => {
    const input = principalInput();
    mutate(input);
    expect(() => validateRehearsalPrincipal(input, { expectedClientSha256: sha256(CLIENT_ID) })).toThrow(code);
  });
});

describe("validateRecoveryIntent", () => {
  it("accepts the exact persisted subscription, parent resource, and run-derived targets", () => {
    expect(validateRecoveryIntent(recoveryDocument())).toMatchObject({ status: "EXACT_RECOVERY_INTENT" });
  });

  it.each([
    ["missing subscription", (value) => { delete value.intent.subscriptionId; }, "INVALID_RECOVERY_INTENT"],
    ["cross subscription", (value) => { value.intent.subscriptionId = "55555555-5555-4555-8555-555555555555"; }, "RECOVERY_SUBSCRIPTION_MISMATCH"],
    ["foreign persisted parent", (value) => { value.intent.target.resourceId = value.intent.target.resourceId.replace(RESOURCE_GROUP, `${RESOURCE_GROUP}-foreign`); }, "RECOVERY_TARGET_RESOURCE_MISMATCH"],
    ["fresh readback drift", (value) => { value.current.postgresResourceId = value.current.postgresResourceId.replace(POSTGRES_SERVER, `${POSTGRES_SERVER}-other`); }, "RECOVERY_POSTGRES_RESOURCE_MISMATCH"],
    ["wrong server name", (value) => { value.intent.target.serverName = `${POSTGRES_SERVER}-other`; }, "RECOVERY_TARGET_NAME_MISMATCH"],
  ])("rejects %s before cleanup", (_label, mutate, code) => {
    const value = recoveryDocument();
    mutate(value);
    expect(() => validateRecoveryIntent(value)).toThrow(code);
  });
});

describe("validatePostgresRestoreRehearsal", () => {
  it("returns a bounded non-cutover public receipt after exact parity and cleanup", () => {
    const input = evidence();
    input.source.tables[0].name = "postgres://user:secret@private.invalid/Event";
    input.destination.tables[0].name = input.source.tables[0].name;
    input.source.migrations.rows[0].name = "credential=top-secret";
    input.destination.migrations.rows[0].name = input.source.migrations.rows[0].name;

    const receipt = validatePostgresRestoreRehearsal(input, cleanup());
    expect(receipt).toMatchObject({
      status: "POSTGRES_REHEARSAL_VERIFIED",
      postgres: "VERIFIED",
      collationVersionStatus: "SOURCE_AND_TARGET_CURRENT",
      crossRuntimeVersionRelation: "MATCH",
      redis: "UNPROVEN",
      objects: "UNPROVEN",
      providerCutoverStatus: "PLANNED",
      cutoverReady: false,
      cleanup: "VERIFIED",
      tableCount: 2,
      totalRowCount: 8,
      sequenceCount: 1,
    });
    const publicJson = JSON.stringify(receipt);
    expect(publicJson).not.toContain("private.invalid");
    expect(publicJson).not.toContain("top-secret");
    expect(publicJson).not.toContain("Event");
  });

  it.each([
    ["server", (value) => { value.destination.server.majorVersion = 17; }, "DESTINATION_POSTGRES_VERSION_MISMATCH"],
    ["encoding", (value) => { value.destination.locale.encoding = "LATIN1"; }, "LOCALE_PARITY_MISMATCH"],
    ["collation", (value) => { value.destination.locale.collation = "POSIX"; }, "LOCALE_PARITY_MISMATCH"],
    ["character classification", (value) => { value.destination.locale.ctype = "POSIX"; }, "LOCALE_PARITY_MISMATCH"],
    ["locale provider", (value) => { value.destination.locale.provider = "icu"; }, "LOCALE_PARITY_MISMATCH"],
    ["locale", (value) => { value.destination.locale.providerLocale = "PG_UNICODE_FAST"; }, "LOCALE_PARITY_MISMATCH"],
    ["extension", (value) => { value.destination.extensions[1].version = "0.9.0"; }, "EXTENSION_MISMATCH"],
    ["schema", (value) => { value.destination.schema.digest = HASH_B; }, "SCHEMA_DIGEST_MISMATCH"],
    ["schema algorithm", (value) => { value.destination.schema.algorithm = "LEGACY"; }, "DESTINATION_SCHEMA_ALGORITHM_MISMATCH"],
    ["table identity", (value) => { value.destination.tables[0].name = "EventCopy"; }, "TABLE_PARITY_MISMATCH"],
    ["table count", (value) => { value.destination.tables[0].rowCount += 1; }, "TABLE_PARITY_MISMATCH"],
    ["row hash", (value) => { value.destination.tables[0].rowSha256 = HASH_B; }, "TABLE_PARITY_MISMATCH"],
    ["archive sequence replay", (value) => { value.archiveSequences.afterReplay[0].lastValue = "43"; }, "ARCHIVE_SEQUENCE_REPLAY_MISMATCH"],
    ["large object", (value) => { value.destination.largeObjects.contentSha256 = HASH_B; }, "LARGE_OBJECT_PARITY_MISMATCH"],
    ["migration", (value) => { value.destination.migrations.rows[0].checksum = HASH_A; }, "MIGRATION_PARITY_MISMATCH"],
    ["queue", (value) => { value.destination.queues.event.statuses[0].count += 1; }, "QUEUE_PARITY_MISMATCH"],
  ])("rejects %s mismatch", (_label, mutate, code) => {
    const input = evidence();
    mutate(input);
    expect(() => validatePostgresRestoreRehearsal(input, cleanup())).toThrow(code);
  });

  it("rejects an ICU rules mismatch independently of provider-version metadata", () => {
    const input = evidence();
    for (const side of [input.source, input.destination]) {
      side.locale.provider = "icu";
      side.locale.providerLocale = "en-US";
      side.locale.icuRules = null;
    }
    input.destination.locale.icuRules = "&a < b";

    expect(() => validatePostgresRestoreRehearsal(input, cleanup())).toThrow("LOCALE_PARITY_MISMATCH");
  });

  it("accepts different cross-runtime collation versions when both sides are current", () => {
    const input = evidence();
    input.destination.locale.collationVersion = "2";
    input.destination.locale.actualCollationVersion = "2";

    expect(validatePostgresRestoreRehearsal(input, cleanup())).toMatchObject({
      collationVersionStatus: "SOURCE_AND_TARGET_CURRENT",
      crossRuntimeVersionRelation: "DIFFERENT",
      cutoverReady: false,
    });
  });

  it("accepts null-safe unversioned locale metadata", () => {
    const input = evidence();
    for (const side of [input.source, input.destination]) {
      side.locale.collationVersion = null;
      side.locale.actualCollationVersion = null;
    }

    expect(validatePostgresRestoreRehearsal(input, cleanup())).toMatchObject({
      collationVersionStatus: "SOURCE_AND_TARGET_CURRENT",
      crossRuntimeVersionRelation: "UNVERSIONED",
    });
  });

  it("fails closed when actual collation-version evidence is absent", () => {
    const input = evidence();
    delete input.destination.locale.actualCollationVersion;
    expect(() => validatePostgresRestoreRehearsal(input, cleanup())).toThrow("DESTINATION_LOCALE_SHAPE_MISMATCH");
  });

  it.each([
    ["source", (value) => { value.source.locale.actualCollationVersion = "2"; }, "SOURCE_COLLATION_VERSION_STALE"],
    ["target", (value) => { value.destination.locale.actualCollationVersion = "2"; }, "TARGET_COLLATION_VERSION_STALE"],
  ])("rejects a stale %s recorded collation version", (_label, mutate, code) => {
    const input = evidence();
    mutate(input);
    expect(() => validatePostgresRestoreRehearsal(input, cleanup())).toThrow(code);
  });

  it("rejects duplicate table identities", () => {
    const input = evidence();
    input.source.tables.push(clone(input.source.tables[0]));
    input.destination.tables.push(clone(input.destination.tables[0]));
    expect(() => validatePostgresRestoreRehearsal(input, cleanup())).toThrow("SOURCE_TABLE_DUPLICATE");
  });

  it("rejects archive sequence coverage drift", () => {
    const input = evidence();
    input.archiveSequences.tocEntryCount = 2;
    expect(() => validatePostgresRestoreRehearsal(input, cleanup())).toThrow("ARCHIVE_SEQUENCE_COVERAGE_MISMATCH");
  });

  it("rejects duplicate archive sequence identities", () => {
    const input = evidence();
    input.archiveSequences.tocEntryCount = 2;
    input.archiveSequences.beforeReplay.push(clone(input.archiveSequences.beforeReplay[0]));
    input.archiveSequences.afterReplay.push(clone(input.archiveSequences.afterReplay[0]));
    expect(() => validatePostgresRestoreRehearsal(input, cleanup())).toThrow("ARCHIVE_BEFORE_REPLAY_SEQUENCE_DUPLICATE");
  });

  it.each(["scratchDatabase", "firewallRule", "credentials"])("requires verified %s cleanup", (kind) => {
    const cleanupEvidence = cleanup();
    if (kind === "scratchDatabase") cleanupEvidence.scratchDatabase.dropped = false;
    if (kind === "firewallRule") cleanupEvidence.firewallRule.deleted = false;
    if (kind === "credentials") cleanupEvidence.credentials.shredded = false;
    expect(() => validatePostgresRestoreRehearsal(evidence(), cleanupEvidence)).toThrow("RECOVERY_REQUIRED");
  });

  it("rejects unhealthy source migrations even when the restore matches", () => {
    const input = evidence();
    for (const side of [input.source, input.destination]) {
      side.migrations.rows[0].state = "INCOMPLETE";
      side.migrations.counts = { finished: 0, rolledBack: 0, incomplete: 1 };
    }
    expect(() => validatePostgresRestoreRehearsal(input, cleanup())).toThrow("SOURCE_MIGRATIONS_UNHEALTHY");
  });
});
