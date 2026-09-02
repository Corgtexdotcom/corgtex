import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  validatePostgresRestoreRehearsal,
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

const sha256 = (value) => createHash("sha256").update(value).digest("hex");
const clone = (value) => structuredClone(value);

const databaseEvidence = () => ({
  server: { majorVersion: 18 },
  extensions: [
    { name: "plpgsql", version: "1.0" },
    { name: "vector", version: "0.8.2" },
  ],
  schema: { digest: HASH_A },
  tables: [
    { schema: "public", name: "Event", rowCount: 3, rowSha256: HASH_A },
    { schema: "public", name: "WorkflowJob", rowCount: 5, rowSha256: HASH_B },
  ],
  sequences: [{ schema: "public", name: "legacy_id_seq", lastValue: "42", isCalled: true }],
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
      redis: "UNPROVEN",
      objects: "UNPROVEN",
      providerCutoverStatus: "PLANNED",
      cutoverReady: false,
      cleanup: "VERIFIED",
      tableCount: 2,
      totalRowCount: 8,
    });
    const publicJson = JSON.stringify(receipt);
    expect(publicJson).not.toContain("private.invalid");
    expect(publicJson).not.toContain("top-secret");
    expect(publicJson).not.toContain("Event");
  });

  it.each([
    ["server", (value) => { value.destination.server.majorVersion = 17; }, "DESTINATION_POSTGRES_VERSION_MISMATCH"],
    ["extension", (value) => { value.destination.extensions[1].version = "0.9.0"; }, "EXTENSION_MISMATCH"],
    ["schema", (value) => { value.destination.schema.digest = HASH_B; }, "SCHEMA_DIGEST_MISMATCH"],
    ["table identity", (value) => { value.destination.tables[0].name = "EventCopy"; }, "TABLE_PARITY_MISMATCH"],
    ["table count", (value) => { value.destination.tables[0].rowCount += 1; }, "TABLE_PARITY_MISMATCH"],
    ["row hash", (value) => { value.destination.tables[0].rowSha256 = HASH_B; }, "TABLE_PARITY_MISMATCH"],
    ["sequence", (value) => { value.destination.sequences[0].lastValue = "43"; }, "SEQUENCE_PARITY_MISMATCH"],
    ["large object", (value) => { value.destination.largeObjects.contentSha256 = HASH_B; }, "LARGE_OBJECT_PARITY_MISMATCH"],
    ["migration", (value) => { value.destination.migrations.rows[0].checksum = HASH_A; }, "MIGRATION_PARITY_MISMATCH"],
    ["queue", (value) => { value.destination.queues.event.statuses[0].count += 1; }, "QUEUE_PARITY_MISMATCH"],
  ])("rejects %s mismatch", (_label, mutate, code) => {
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
