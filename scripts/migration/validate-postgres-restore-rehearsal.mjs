#!/usr/bin/env node

import { createHash } from "node:crypto";
import { closeSync, constants, fstatSync, openSync, readSync } from "node:fs";
import { pathToFileURL } from "node:url";
import { expectedResourceGroupId } from "./validate-azure-what-if.mjs";

const MAX_INPUT_BYTES = 32 * 1024 * 1024;
const EXPECTED_CLIENT_SHA256 = "707be00bd89b2c0cf1ebdf8c0d389ff24b5f69d9f2ba35a113cddf8f073296bf";
const CONTRIBUTOR_ROLE_ID = "b24988ac-6180-42a0-ab88-20f7382dd24c";
const READER_ROLE_ID = "acdd72a7-3385-48ef-bd42-f606fba81ae7";
const SHA256_PATTERN = /^[0-9a-f]{64}$/u;
const OPAQUE_REF_PATTERN = /^sha256:[0-9a-f]{16}$/u;
const SAFE_IDENTIFIER_PATTERN = /^[a-z][a-z0-9_]{0,62}$/u;
const SCHEMA_TOKEN_ALGORITHM = "PG_DUMP_SQL_TOKENS_V1";
const LOCALE_DEFINITION_FIELDS = ["encoding", "collation", "ctype", "provider", "providerLocale", "icuRules"];
const BLOCKERS = [
  "REDIS_PARITY_UNPROVEN",
  "OBJECT_PARITY_UNPROVEN",
  "DESTINATION_RUNTIME_UNPROVEN",
  "SOURCE_QUIESCENCE_UNPROVEN",
];

const fail = (code) => {
  const error = new Error(code);
  error.code = code;
  throw error;
};

const sha256 = (value) => createHash("sha256").update(value).digest("hex");

const stableJson = (value) => {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stableJson(value[key])}`).join(",")}}`;
  }
  return JSON.stringify(value);
};

const isRecord = (value) => value !== null && typeof value === "object" && !Array.isArray(value);

const expectExactKeys = (value, keys, code) => {
  if (!isRecord(value) || stableJson(Object.keys(value).sort()) !== stableJson([...keys].sort())) fail(code);
};

const normalizeResourceId = (value) => {
  if (typeof value !== "string" || value.length === 0) fail("INVALID_RESOURCE_ID");
  return value.replace(/\/+$/u, "").toLowerCase();
};

const normalizeUuid = (value, code) => {
  if (typeof value !== "string" || !/^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/iu.test(value)) fail(code);
  return value.toLowerCase();
};

const validateAssignmentId = (assignmentId, scope) => {
  const normalizedId = normalizeResourceId(assignmentId);
  const prefix = `${normalizeResourceId(scope)}/providers/microsoft.authorization/roleassignments/`;
  if (!normalizedId.startsWith(prefix)) fail("ASSIGNMENT_ID_SCOPE_MISMATCH");
  normalizeUuid(normalizedId.slice(prefix.length), "INVALID_ASSIGNMENT_ID");
};

export function validateRehearsalPrincipal(document, options = {}) {
  if (!isRecord(document)) fail("INVALID_DOCUMENT");
  const expectedClientSha256 = options.expectedClientSha256 ?? EXPECTED_CLIENT_SHA256;
  if (!SHA256_PATTERN.test(expectedClientSha256)) fail("INVALID_EXPECTED_CLIENT_REF");

  const clientId = normalizeUuid(document.clientId, "INVALID_CLIENT_ID");
  if (sha256(clientId) !== expectedClientSha256) fail("UNEXPECTED_AZURE_CLIENT");
  const principalId = normalizeUuid(document.principalId, "INVALID_PRINCIPAL_ID");
  const expectedScope = expectedResourceGroupId(document.subscriptionId, document.resourceGroup).toLowerCase();
  const subscriptionScope = expectedScope.split("/resourcegroups/")[0];
  if (!Array.isArray(document.assignments) || document.assignments.length !== 2) {
    fail("UNEXPECTED_EFFECTIVE_ROLE_ASSIGNMENT_COUNT");
  }

  const expectedRoles = new Map([
    [
      `${subscriptionScope}/providers/microsoft.authorization/roledefinitions/${READER_ROLE_ID}`,
      { kind: "reader", scope: subscriptionScope },
    ],
    [
      `${subscriptionScope}/providers/microsoft.authorization/roledefinitions/${CONTRIBUTOR_ROLE_ID}`,
      { kind: "contributor", scope: expectedScope },
    ],
  ]);
  const seenRoles = new Set();

  for (const assignment of document.assignments) {
    if (!isRecord(assignment)) fail("INVALID_ROLE_ASSIGNMENT");
    const expectedRole = expectedRoles.get(normalizeResourceId(assignment.roleDefinitionId));
    if (!expectedRole || seenRoles.has(expectedRole.kind)) fail("UNEXPECTED_ROLE_DEFINITION");
    seenRoles.add(expectedRole.kind);

    validateAssignmentId(assignment.id, expectedRole.scope);
    if (normalizeResourceId(assignment.scope) !== expectedRole.scope) fail("INHERITED_OR_FOREIGN_ROLE_ASSIGNMENT");
    if (normalizeUuid(assignment.principalId, "ROLE_PRINCIPAL_MISMATCH") !== principalId) fail("ROLE_PRINCIPAL_MISMATCH");
    if (String(assignment.principalType ?? "").toLowerCase() !== "serviceprincipal") {
      fail("ROLE_PRINCIPAL_TYPE_MISMATCH");
    }
    if (assignment.condition !== null && assignment.condition !== undefined) {
      fail(expectedRole.kind === "reader" ? "UNEXPECTED_READER_CONDITION" : "UNEXPECTED_CONTRIBUTOR_CONDITION");
    }
  }

  if (seenRoles.size !== 2) fail("INCOMPLETE_ROLE_SET");

  return {
    schemaVersion: "1.0.0",
    status: "EXACT_REHEARSAL_PRINCIPAL",
    clientRef: `sha256:${expectedClientSha256.slice(0, 16)}`,
    principalRef: `sha256:${sha256(principalId).slice(0, 16)}`,
    scopeRef: `sha256:${sha256(expectedScope).slice(0, 16)}`,
    effectiveRoleAssignmentCount: 2,
  };
}

export function validateRecoveryIntent(document) {
  expectExactKeys(document, ["intent", "current"], "INVALID_RECOVERY_DOCUMENT");
  const { intent, current } = document;
  expectExactKeys(current, ["subscriptionId", "resourceGroup", "serverName", "postgresResourceId", "postgresHost", "runId", "runAttempt", "domain", "scratchName", "firewallName"], "INVALID_RECOVERY_CURRENT");
  const subscriptionId = normalizeUuid(current.subscriptionId, "INVALID_RECOVERY_SUBSCRIPTION");
  if (typeof current.resourceGroup !== "string" || current.resourceGroup.length === 0) fail("INVALID_RECOVERY_RESOURCE_GROUP");
  if (typeof current.serverName !== "string" || !/^[a-z0-9-]{3,63}$/u.test(current.serverName)) fail("INVALID_RECOVERY_SERVER_NAME");
  if (typeof current.postgresHost !== "string" || current.postgresHost.length === 0) fail("INVALID_RECOVERY_POSTGRES_HOST");
  if (!/^[1-9][0-9]*$/u.test(current.runId) || !/^[1-9][0-9]*$/u.test(current.runAttempt)) fail("INVALID_RECOVERY_RUN_IDENTITY");
  if (!new Set(["core", "ops"]).has(current.domain)) fail("INVALID_DOMAIN");
  const expectedScratchName = `corgtex_rehearsal_${current.runId}_${current.runAttempt}_${current.domain}`;
  const expectedFirewallName = `corgtex-rehearsal-${current.runId}-${current.runAttempt}`;
  if (current.scratchName !== expectedScratchName || !SAFE_IDENTIFIER_PATTERN.test(current.scratchName)) fail("INVALID_RECOVERY_SCRATCH_NAME");
  if (current.firewallName !== expectedFirewallName) fail("INVALID_RECOVERY_FIREWALL_NAME");

  const expectedPostgresResourceId = `${expectedResourceGroupId(subscriptionId, current.resourceGroup)}/providers/Microsoft.DBforPostgreSQL/flexibleServers/${current.serverName}`;
  if (normalizeResourceId(current.postgresResourceId) !== normalizeResourceId(expectedPostgresResourceId)) {
    fail("RECOVERY_POSTGRES_RESOURCE_MISMATCH");
  }

  expectExactKeys(intent, ["schemaVersion", "runId", "runAttempt", "domain", "subscriptionId", "target", "databaseState", "firewallState"], "INVALID_RECOVERY_INTENT");
  if (intent.schemaVersion !== "1.0.0") fail("RECOVERY_SCHEMA_VERSION_MISMATCH");
  if (normalizeUuid(intent.subscriptionId, "INVALID_INTENT_SUBSCRIPTION") !== subscriptionId) fail("RECOVERY_SUBSCRIPTION_MISMATCH");
  if (intent.runId !== current.runId || intent.runAttempt !== current.runAttempt || intent.domain !== current.domain) {
    fail("RECOVERY_RUN_IDENTITY_MISMATCH");
  }
  expectExactKeys(intent.target, ["resourceGroup", "serverName", "resourceId"], "INVALID_RECOVERY_TARGET");
  if (intent.target.resourceGroup !== current.resourceGroup || intent.target.serverName !== current.serverName) {
    fail("RECOVERY_TARGET_NAME_MISMATCH");
  }
  if (normalizeResourceId(intent.target.resourceId) !== normalizeResourceId(current.postgresResourceId)) {
    fail("RECOVERY_TARGET_RESOURCE_MISMATCH");
  }
  const targetRef = `sha256:${sha256(`${current.postgresHost}\0${current.scratchName}`).slice(0, 16)}`;
  compareExact(intent.databaseState, {
    schemaVersion: "1.0.0",
    scratchName: current.scratchName,
    targetRef,
    phase: "ABSENCE_VERIFIED",
  }, "INVALID_RECOVERY_DATABASE_STATE");
  compareExact(intent.firewallState, {
    schemaVersion: "1.0.0",
    name: current.firewallName,
    phase: "ABSENCE_VERIFIED",
  }, "INVALID_RECOVERY_FIREWALL_STATE");

  return {
    schemaVersion: "1.0.0",
    status: "EXACT_RECOVERY_INTENT",
    subscriptionRef: `sha256:${sha256(subscriptionId).slice(0, 16)}`,
    postgresResourceRef: `sha256:${sha256(normalizeResourceId(current.postgresResourceId)).slice(0, 16)}`,
    scratchRef: `sha256:${sha256(current.scratchName).slice(0, 16)}`,
    firewallRef: `sha256:${sha256(current.firewallName).slice(0, 16)}`,
  };
}

const validateHash = (value, code) => {
  if (typeof value !== "string" || !SHA256_PATTERN.test(value)) fail(code);
  return value;
};

const validateOpaqueRef = (value, code) => {
  if (typeof value !== "string" || !OPAQUE_REF_PATTERN.test(value)) fail(code);
  return value;
};

const validateCount = (value, code) => {
  if (!Number.isSafeInteger(value) || value < 0) fail(code);
  return value;
};

const compareExact = (left, right, code) => {
  if (stableJson(left) !== stableJson(right)) fail(code);
};

const localeDefinition = (locale) => Object.fromEntries(
  LOCALE_DEFINITION_FIELDS.map((field) => [field, locale[field]]),
);

const isCurrentCollationVersion = (locale) =>
  locale.collationVersion === locale.actualCollationVersion;

const classifyCollationVersionRelation = (source, destination) => {
  if (source.collationVersion === null || destination.collationVersion === null) return "UNVERSIONED";
  return source.collationVersion === destination.collationVersion ? "MATCH" : "DIFFERENT";
};

const validateDatabaseEvidence = (value, side) => {
  const prefix = side.toUpperCase();
  expectExactKeys(value, ["server", "locale", "extensions", "schema", "tables", "largeObjects", "migrations", "queues"], `${prefix}_EVIDENCE_SHAPE_MISMATCH`);

  expectExactKeys(value.server, ["majorVersion"], `${prefix}_SERVER_SHAPE_MISMATCH`);
  if (value.server.majorVersion !== 18) fail(`${prefix}_POSTGRES_VERSION_MISMATCH`);

  expectExactKeys(value.locale, [
    "encoding",
    "collation",
    "ctype",
    "provider",
    "providerLocale",
    "icuRules",
    "collationVersion",
    "actualCollationVersion",
  ], `${prefix}_LOCALE_SHAPE_MISMATCH`);
  for (const key of ["encoding", "collation", "ctype"]) {
    if (typeof value.locale[key] !== "string" || value.locale[key].length === 0) fail(`${prefix}_LOCALE_INVALID`);
  }
  if (!["builtin", "icu", "libc"].includes(value.locale.provider)) fail(`${prefix}_LOCALE_PROVIDER_INVALID`);
  for (const key of ["providerLocale", "icuRules", "collationVersion", "actualCollationVersion"]) {
    if (value.locale[key] !== null && (typeof value.locale[key] !== "string" || value.locale[key].length === 0)) {
      fail(`${prefix}_LOCALE_INVALID`);
    }
  }
  if (value.locale.provider === "libc" && (value.locale.providerLocale !== null || value.locale.icuRules !== null)) {
    fail(`${prefix}_LOCALE_INVALID`);
  }
  if (value.locale.provider !== "libc" && value.locale.providerLocale === null) fail(`${prefix}_LOCALE_INVALID`);
  if (value.locale.provider !== "icu" && value.locale.icuRules !== null) fail(`${prefix}_LOCALE_INVALID`);

  if (!Array.isArray(value.extensions) || value.extensions.length === 0) fail(`${prefix}_EXTENSIONS_INVALID`);
  const extensionKeys = new Set();
  for (const extension of value.extensions) {
    expectExactKeys(extension, ["name", "version"], `${prefix}_EXTENSION_SHAPE_MISMATCH`);
    if (typeof extension.name !== "string" || !SAFE_IDENTIFIER_PATTERN.test(extension.name)) fail(`${prefix}_EXTENSION_INVALID`);
    if (typeof extension.version !== "string" || extension.version.length === 0 || extension.version.length > 64) fail(`${prefix}_EXTENSION_INVALID`);
    if (extensionKeys.has(extension.name)) fail(`${prefix}_EXTENSION_DUPLICATE`);
    extensionKeys.add(extension.name);
  }
  if (!extensionKeys.has("plpgsql") || !extensionKeys.has("vector")) fail(`${prefix}_REQUIRED_EXTENSION_MISSING`);

  expectExactKeys(value.schema, ["algorithm", "digest"], `${prefix}_SCHEMA_SHAPE_MISMATCH`);
  if (value.schema.algorithm !== SCHEMA_TOKEN_ALGORITHM) fail(`${prefix}_SCHEMA_ALGORITHM_MISMATCH`);
  validateHash(value.schema.digest, `${prefix}_SCHEMA_DIGEST_INVALID`);

  if (!Array.isArray(value.tables) || value.tables.length === 0) fail(`${prefix}_TABLES_INVALID`);
  const tableKeys = new Set();
  for (const table of value.tables) {
    expectExactKeys(table, ["schema", "name", "rowCount", "rowSha256"], `${prefix}_TABLE_SHAPE_MISMATCH`);
    if (typeof table.schema !== "string" || !SAFE_IDENTIFIER_PATTERN.test(table.schema)) fail(`${prefix}_TABLE_IDENTITY_INVALID`);
    if (typeof table.name !== "string" || table.name.length === 0 || table.name.length > 128) fail(`${prefix}_TABLE_IDENTITY_INVALID`);
    validateCount(table.rowCount, `${prefix}_TABLE_COUNT_INVALID`);
    validateHash(table.rowSha256, `${prefix}_TABLE_DIGEST_INVALID`);
    const key = `${table.schema}\0${table.name}`;
    if (tableKeys.has(key)) fail(`${prefix}_TABLE_DUPLICATE`);
    tableKeys.add(key);
  }

  validateDatabaseTail(value, side);
  return value;
};

const validateSequences = (value, side) => {
  const prefix = side.toUpperCase();
  if (!Array.isArray(value)) fail(`${prefix}_SEQUENCES_INVALID`);
  const sequenceKeys = new Set();
  for (const sequence of value) {
    expectExactKeys(sequence, ["schema", "name", "lastValue", "isCalled"], `${prefix}_SEQUENCE_SHAPE_MISMATCH`);
    if (typeof sequence.schema !== "string" || !SAFE_IDENTIFIER_PATTERN.test(sequence.schema)) fail(`${prefix}_SEQUENCE_IDENTITY_INVALID`);
    if (typeof sequence.name !== "string" || sequence.name.length === 0 || sequence.name.length > 128) fail(`${prefix}_SEQUENCE_IDENTITY_INVALID`);
    if (typeof sequence.lastValue !== "string" || !/^-?[0-9]+$/u.test(sequence.lastValue)) fail(`${prefix}_SEQUENCE_VALUE_INVALID`);
    if (typeof sequence.isCalled !== "boolean") fail(`${prefix}_SEQUENCE_VALUE_INVALID`);
    const key = `${sequence.schema}\0${sequence.name}`;
    if (sequenceKeys.has(key)) fail(`${prefix}_SEQUENCE_DUPLICATE`);
    sequenceKeys.add(key);
  }
  return value;
};

const validateDatabaseTail = (value, side) => {
  const prefix = side.toUpperCase();
  expectExactKeys(value.largeObjects, ["count", "contentSha256"], `${prefix}_LARGE_OBJECT_SHAPE_MISMATCH`);
  validateCount(value.largeObjects.count, `${prefix}_LARGE_OBJECT_COUNT_INVALID`);
  validateHash(value.largeObjects.contentSha256, `${prefix}_LARGE_OBJECT_DIGEST_INVALID`);

  expectExactKeys(value.migrations, ["rows", "counts"], `${prefix}_MIGRATION_SHAPE_MISMATCH`);
  if (!Array.isArray(value.migrations.rows)) fail(`${prefix}_MIGRATIONS_INVALID`);
  const migrationKeys = new Set();
  const derivedMigrationCounts = { finished: 0, rolledBack: 0, incomplete: 0 };
  for (const migration of value.migrations.rows) {
    expectExactKeys(migration, ["name", "checksum", "state", "appliedStepsCount"], `${prefix}_MIGRATION_ROW_SHAPE_MISMATCH`);
    if (typeof migration.name !== "string" || migration.name.length === 0 || migration.name.length > 256) fail(`${prefix}_MIGRATION_IDENTITY_INVALID`);
    validateHash(migration.checksum, `${prefix}_MIGRATION_CHECKSUM_INVALID`);
    if (!["FINISHED", "ROLLED_BACK", "INCOMPLETE"].includes(migration.state)) fail(`${prefix}_MIGRATION_STATE_INVALID`);
    validateCount(migration.appliedStepsCount, `${prefix}_MIGRATION_STEPS_INVALID`);
    if (migrationKeys.has(migration.name)) fail(`${prefix}_MIGRATION_DUPLICATE`);
    migrationKeys.add(migration.name);
    if (migration.state === "FINISHED") derivedMigrationCounts.finished += 1;
    if (migration.state === "ROLLED_BACK") derivedMigrationCounts.rolledBack += 1;
    if (migration.state === "INCOMPLETE") derivedMigrationCounts.incomplete += 1;
  }
  expectExactKeys(value.migrations.counts, ["finished", "rolledBack", "incomplete"], `${prefix}_MIGRATION_COUNTS_SHAPE_MISMATCH`);
  for (const [key, count] of Object.entries(value.migrations.counts)) validateCount(count, `${prefix}_MIGRATION_COUNT_INVALID`);
  compareExact(value.migrations.counts, derivedMigrationCounts, `${prefix}_MIGRATION_COUNT_MISMATCH`);

  expectExactKeys(value.queues, ["event", "workflowJob"], `${prefix}_QUEUE_SHAPE_MISMATCH`);
  for (const [queueName, queue] of Object.entries(value.queues)) {
    expectExactKeys(queue, ["statuses", "lockedCount"], `${prefix}_${queueName.toUpperCase()}_QUEUE_SHAPE_MISMATCH`);
    if (!Array.isArray(queue.statuses) || queue.statuses.length === 0) fail(`${prefix}_${queueName.toUpperCase()}_STATUSES_INVALID`);
    const statuses = new Set();
    for (const status of queue.statuses) {
      expectExactKeys(status, ["status", "count"], `${prefix}_${queueName.toUpperCase()}_STATUS_SHAPE_MISMATCH`);
      if (typeof status.status !== "string" || !/^[A-Z_]+$/u.test(status.status)) fail(`${prefix}_${queueName.toUpperCase()}_STATUS_INVALID`);
      validateCount(status.count, `${prefix}_${queueName.toUpperCase()}_COUNT_INVALID`);
      if (statuses.has(status.status)) fail(`${prefix}_${queueName.toUpperCase()}_STATUS_DUPLICATE`);
      statuses.add(status.status);
    }
    validateCount(queue.lockedCount, `${prefix}_${queueName.toUpperCase()}_LOCKED_COUNT_INVALID`);
  }
};

const sumRows = (tables) => tables.reduce((sum, table) => sum + table.rowCount, 0);
const sumStatuses = (statuses) => statuses.reduce((sum, status) => sum + status.count, 0);

export function validatePostgresRestoreRehearsal(document, cleanup) {
  expectExactKeys(document, ["schemaVersion", "domain", "sourceRef", "targetRef", "source", "destination", "archiveSequences"], "INVALID_DOCUMENT");
  if (document.schemaVersion !== "1.0.0") fail("SCHEMA_VERSION_MISMATCH");
  if (!new Set(["core", "ops"]).has(document.domain)) fail("INVALID_DOMAIN");
  validateOpaqueRef(document.sourceRef, "INVALID_SOURCE_REF");
  validateOpaqueRef(document.targetRef, "INVALID_TARGET_REF");
  const source = validateDatabaseEvidence(document.source, "source");
  const destination = validateDatabaseEvidence(document.destination, "destination");
  expectExactKeys(document.archiveSequences, ["tocEntryCount", "beforeReplay", "afterReplay"], "ARCHIVE_SEQUENCES_SHAPE_MISMATCH");
  const tocEntryCount = validateCount(document.archiveSequences.tocEntryCount, "ARCHIVE_SEQUENCE_COUNT_INVALID");
  const beforeReplay = validateSequences(document.archiveSequences.beforeReplay, "archive_before_replay");
  const afterReplay = validateSequences(document.archiveSequences.afterReplay, "archive_after_replay");
  if (beforeReplay.length !== tocEntryCount || afterReplay.length !== tocEntryCount) {
    fail("ARCHIVE_SEQUENCE_COVERAGE_MISMATCH");
  }
  compareExact(beforeReplay, afterReplay, "ARCHIVE_SEQUENCE_REPLAY_MISMATCH");

  compareExact(source.server, destination.server, "SERVER_VERSION_MISMATCH");
  if (!isCurrentCollationVersion(source.locale)) fail("SOURCE_COLLATION_VERSION_STALE");
  if (!isCurrentCollationVersion(destination.locale)) fail("TARGET_COLLATION_VERSION_STALE");
  compareExact(localeDefinition(source.locale), localeDefinition(destination.locale), "LOCALE_PARITY_MISMATCH");
  const crossRuntimeVersionRelation = classifyCollationVersionRelation(source.locale, destination.locale);
  compareExact(source.extensions, destination.extensions, "EXTENSION_MISMATCH");
  compareExact(source.schema, destination.schema, "SCHEMA_DIGEST_MISMATCH");
  compareExact(source.tables, destination.tables, "TABLE_PARITY_MISMATCH");
  compareExact(source.largeObjects, destination.largeObjects, "LARGE_OBJECT_PARITY_MISMATCH");
  compareExact(source.migrations, destination.migrations, "MIGRATION_PARITY_MISMATCH");
  compareExact(source.queues, destination.queues, "QUEUE_PARITY_MISMATCH");
  if (source.migrations.counts.rolledBack !== 0 || source.migrations.counts.incomplete !== 0) {
    fail("SOURCE_MIGRATIONS_UNHEALTHY");
  }

  expectExactKeys(cleanup, ["scratchDatabase", "firewallRule", "credentials"], "CLEANUP_EVIDENCE_INVALID");
  expectExactKeys(cleanup.scratchDatabase, ["nameRef", "dropped"], "DATABASE_CLEANUP_EVIDENCE_INVALID");
  expectExactKeys(cleanup.firewallRule, ["nameRef", "deleted"], "FIREWALL_CLEANUP_EVIDENCE_INVALID");
  expectExactKeys(cleanup.credentials, ["shredded"], "CREDENTIAL_CLEANUP_EVIDENCE_INVALID");
  validateOpaqueRef(cleanup.scratchDatabase.nameRef, "DATABASE_CLEANUP_REF_INVALID");
  validateOpaqueRef(cleanup.firewallRule.nameRef, "FIREWALL_CLEANUP_REF_INVALID");
  if (cleanup.scratchDatabase.dropped !== true || cleanup.firewallRule.deleted !== true || cleanup.credentials.shredded !== true) {
    fail("RECOVERY_REQUIRED");
  }

  const evidenceSha256 = sha256(stableJson(document));
  return {
    schemaVersion: "1.0.0",
    status: "POSTGRES_REHEARSAL_VERIFIED",
    domainRef: `sha256:${sha256(document.domain).slice(0, 16)}`,
    sourceRef: document.sourceRef,
    targetRef: document.targetRef,
    tableCount: source.tables.length,
    totalRowCount: sumRows(source.tables),
    sequenceCount: tocEntryCount,
    migrationCount: source.migrations.rows.length,
    eventCount: sumStatuses(source.queues.event.statuses),
    workflowJobCount: sumStatuses(source.queues.workflowJob.statuses),
    evidenceSha256,
    cleanup: "VERIFIED",
    postgres: "VERIFIED",
    collationVersionStatus: "SOURCE_AND_TARGET_CURRENT",
    crossRuntimeVersionRelation,
    redis: "UNPROVEN",
    objects: "UNPROVEN",
    providerCutoverStatus: "PLANNED",
    cutoverReady: false,
    blockers: BLOCKERS,
  };
}

const readBoundedFile = (filePath) => {
  let fileDescriptor = null;
  try {
    fileDescriptor = openSync(filePath, constants.O_RDONLY | constants.O_NOFOLLOW);
    const stat = fstatSync(fileDescriptor);
    if (!stat.isFile() || stat.size <= 0 || stat.size > MAX_INPUT_BYTES) fail("INVALID_INPUT_FILE");
    const buffer = Buffer.allocUnsafe(stat.size);
    let offset = 0;
    while (offset < buffer.length) {
      const bytesRead = readSync(fileDescriptor, buffer, offset, buffer.length - offset, null);
      if (bytesRead === 0) fail("TRUNCATED_INPUT");
      offset += bytesRead;
    }
    return buffer;
  } catch (error) {
    if (error?.code && (String(error.code).startsWith("INVALID_") || error.code === "TRUNCATED_INPUT")) throw error;
    fail("READ_FAILED");
  } finally {
    if (fileDescriptor !== null) {
      try {
        closeSync(fileDescriptor);
      } catch {
        // Validation already fails closed; never expose local descriptor details.
      }
    }
  }
};

const parseJsonFile = (filePath) => {
  try {
    return JSON.parse(readBoundedFile(filePath).toString("utf8"));
  } catch (error) {
    if (error?.code) throw error;
    fail("INVALID_JSON");
  }
};

const parseArgs = (tokens) => {
  const values = new Map();
  for (const token of tokens) {
    const separator = token.indexOf("=");
    if (!token.startsWith("--") || separator < 3) fail("INVALID_ARGS");
    const key = token.slice(2, separator);
    const value = token.slice(separator + 1);
    if (!value || values.has(key)) fail("INVALID_ARGS");
    values.set(key, value);
  }
  return values;
};

export function main(tokens = process.argv.slice(2)) {
  const args = parseArgs(tokens);
  const mode = args.get("mode");
  let receipt;
  if (mode === "principal" && args.size === 2 && args.has("input")) {
    receipt = validateRehearsalPrincipal(parseJsonFile(args.get("input")));
  } else if (mode === "recovery-intent" && args.size === 2 && args.has("input")) {
    receipt = validateRecoveryIntent(parseJsonFile(args.get("input")));
  } else if (mode === "parity" && args.size === 3 && args.has("input") && args.has("cleanup")) {
    receipt = validatePostgresRestoreRehearsal(parseJsonFile(args.get("input")), parseJsonFile(args.get("cleanup")));
  } else {
    fail("INVALID_ARGS");
  }
  process.stdout.write(`${JSON.stringify({ ok: true, receipt })}\n`);
}

const invokedScriptUrl = process.argv[1] ? pathToFileURL(process.argv[1]).href : null;
if (import.meta.url === invokedScriptUrl) {
  try {
    main();
  } catch (error) {
    process.stdout.write(`${JSON.stringify({ ok: false, error: error?.code ?? "VALIDATION_FAILED" })}\n`);
    process.exitCode = 1;
  }
}
