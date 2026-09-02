#!/usr/bin/env node

import { createHash } from "node:crypto";
import { closeSync, constants, fstatSync, openSync, readSync } from "node:fs";
import { pathToFileURL } from "node:url";
import { expectedResourceGroupId } from "./validate-azure-what-if.mjs";

const MAX_INPUT_BYTES = 1024 * 1024;
const EXPECTED_CLIENT_SHA256 = "707be00bd89b2c0cf1ebdf8c0d389ff24b5f69d9f2ba35a113cddf8f073296bf";
const CONTRIBUTOR_ROLE_ID = "b24988ac-6180-42a0-ab88-20f7382dd24c";
const RBAC_ADMIN_ROLE_ID = "f58310d9-a9f6-439a-9e8d-f62e7b41a168";
const KEY_VAULT_SECRETS_USER_ROLE_ID = "4633458b-17de-408a-b874-0445c86b69e6";
const STORAGE_BLOB_DATA_CONTRIBUTOR_ROLE_ID = "ba92f5b4-2d11-453d-a403-e96b0029c9fe";

export const EXPECTED_RBAC_CONDITION = `((!(ActionMatches{'Microsoft.Authorization/roleAssignments/write'})) OR (@Request[Microsoft.Authorization/roleAssignments:RoleDefinitionId] ForAnyOfAnyValues:GuidEquals {${KEY_VAULT_SECRETS_USER_ROLE_ID}, ${STORAGE_BLOB_DATA_CONTRIBUTOR_ROLE_ID}} AND @Request[Microsoft.Authorization/roleAssignments:PrincipalType] ForAnyOfAnyValues:StringEqualsIgnoreCase {'ServicePrincipal'})) AND ((!(ActionMatches{'Microsoft.Authorization/roleAssignments/delete'})) OR (@Resource[Microsoft.Authorization/roleAssignments:RoleDefinitionId] ForAnyOfAnyValues:GuidEquals {${KEY_VAULT_SECRETS_USER_ROLE_ID}, ${STORAGE_BLOB_DATA_CONTRIBUTOR_ROLE_ID}} AND @Resource[Microsoft.Authorization/roleAssignments:PrincipalType] ForAnyOfAnyValues:StringEqualsIgnoreCase {'ServicePrincipal'}))`;

const fail = (code) => {
  const error = new Error(code);
  error.code = code;
  throw error;
};

const sha256 = (value) => createHash("sha256").update(value).digest("hex");

const normalizeResourceId = (value) => {
  if (typeof value !== "string" || value.length === 0) fail("INVALID_RESOURCE_ID");
  return value.replace(/\/+$/u, "").toLowerCase();
};

const normalizeUuid = (value, code) => {
  if (typeof value !== "string" || !/^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/iu.test(value)) {
    fail(code);
  }
  return value.toLowerCase();
};

export const canonicalizeCondition = (value) => {
  if (typeof value !== "string" || value.trim().length === 0) fail("INVALID_CONDITION");
  let canonical = "";
  let inQuotedLiteral = false;
  for (const character of value) {
    if (character === "'") inQuotedLiteral = !inQuotedLiteral;
    if (!inQuotedLiteral && /\s/u.test(character)) continue;
    canonical += character.toLowerCase();
  }
  if (inQuotedLiteral) fail("INVALID_CONDITION");
  return canonical;
};

const validateAssignmentId = (assignmentId, scope) => {
  const normalizedId = normalizeResourceId(assignmentId);
  const prefix = `${normalizeResourceId(scope)}/providers/microsoft.authorization/roleassignments/`;
  if (!normalizedId.startsWith(prefix)) fail("ASSIGNMENT_ID_SCOPE_MISMATCH");
  normalizeUuid(normalizedId.slice(prefix.length), "INVALID_ASSIGNMENT_ID");
};

export function validateMigrationPrincipal(document, options = {}) {
  if (!document || typeof document !== "object" || Array.isArray(document)) fail("INVALID_DOCUMENT");
  const expectedClientSha256 = options.expectedClientSha256 ?? EXPECTED_CLIENT_SHA256;
  if (!/^[0-9a-f]{64}$/u.test(expectedClientSha256)) fail("INVALID_EXPECTED_CLIENT_REF");

  const clientId = normalizeUuid(document.clientId, "INVALID_CLIENT_ID");
  if (sha256(clientId) !== expectedClientSha256) fail("UNEXPECTED_AZURE_CLIENT");

  const principalId = normalizeUuid(document.principalId, "INVALID_PRINCIPAL_ID");
  const expectedScope = expectedResourceGroupId(document.subscriptionId, document.resourceGroup).toLowerCase();
  if (!Array.isArray(document.assignments)) fail("MISSING_ROLE_ASSIGNMENTS");
  if (document.assignments.length !== 2) fail("UNEXPECTED_EFFECTIVE_ROLE_ASSIGNMENT_COUNT");

  const expectedRoleDefinitions = new Map([
    [
      `${expectedScope.split("/resourcegroups/")[0]}/providers/microsoft.authorization/roledefinitions/${CONTRIBUTOR_ROLE_ID}`,
      "contributor",
    ],
    [
      `${expectedScope.split("/resourcegroups/")[0]}/providers/microsoft.authorization/roledefinitions/${RBAC_ADMIN_ROLE_ID}`,
      "conditioned-rbac-admin",
    ],
  ]);
  const seenRoles = new Set();

  for (const assignment of document.assignments) {
    if (!assignment || typeof assignment !== "object" || Array.isArray(assignment)) fail("INVALID_ROLE_ASSIGNMENT");
    validateAssignmentId(assignment.id, expectedScope);
    if (normalizeResourceId(assignment.scope) !== expectedScope) fail("INHERITED_OR_FOREIGN_ROLE_ASSIGNMENT");
    if (normalizeUuid(assignment.principalId, "ROLE_PRINCIPAL_MISMATCH") !== principalId) {
      fail("ROLE_PRINCIPAL_MISMATCH");
    }
    if (String(assignment.principalType ?? "").toLowerCase() !== "serviceprincipal") {
      fail("ROLE_PRINCIPAL_TYPE_MISMATCH");
    }

    const roleDefinitionId = normalizeResourceId(assignment.roleDefinitionId);
    const roleKind = expectedRoleDefinitions.get(roleDefinitionId);
    if (!roleKind || seenRoles.has(roleKind)) fail("UNEXPECTED_ROLE_DEFINITION");
    seenRoles.add(roleKind);

    if (roleKind === "contributor") {
      if (assignment.condition !== null && assignment.condition !== undefined) fail("UNEXPECTED_CONTRIBUTOR_CONDITION");
    } else {
      if (assignment.conditionVersion !== "2.0") fail("RBAC_CONDITION_VERSION_MISMATCH");
      if (canonicalizeCondition(assignment.condition) !== canonicalizeCondition(EXPECTED_RBAC_CONDITION)) {
        fail("RBAC_CONDITION_MISMATCH");
      }
    }
  }

  if (seenRoles.size !== 2) fail("INCOMPLETE_ROLE_SET");
  return {
    schemaVersion: "1.0.0",
    status: "EXACT_MIGRATION_PRINCIPAL",
    clientRef: `sha256:${expectedClientSha256.slice(0, 16)}`,
    principalRef: `sha256:${sha256(principalId).slice(0, 16)}`,
    scopeRef: `sha256:${sha256(expectedScope).slice(0, 16)}`,
    conditionSha256: sha256(canonicalizeCondition(EXPECTED_RBAC_CONDITION)),
    effectiveRoleAssignmentCount: 2,
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
        // The validator already fails closed; do not expose local descriptor details.
      }
    }
  }
};

export function main(tokens = process.argv.slice(2)) {
  if (tokens.length !== 1 || !tokens[0].startsWith("--input=")) fail("INVALID_ARGS");
  const inputPath = tokens[0].slice("--input=".length);
  if (!inputPath) fail("INVALID_ARGS");
  let document;
  try {
    document = JSON.parse(readBoundedFile(inputPath).toString("utf8"));
  } catch (error) {
    if (error?.code) throw error;
    fail("INVALID_JSON");
  }
  const receipt = validateMigrationPrincipal(document);
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
