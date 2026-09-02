#!/usr/bin/env node

import { createHash } from "node:crypto";
import { closeSync, constants, fstatSync, openSync, readSync } from "node:fs";
import { pathToFileURL } from "node:url";

const MAX_INPUT_BYTES = 16 * 1024 * 1024;
const MAX_CHANGES = 128;
const SHA256_PATTERN = /^[0-9a-f]{64}$/;
export const EXPECTED_RESOURCE_TYPE_COUNTS = Object.freeze({
  "microsoft.authorization/roleassignments": 2,
  "microsoft.dbforpostgresql/flexibleservers": 1,
  "microsoft.dbforpostgresql/flexibleservers/configurations": 1,
  "microsoft.dbforpostgresql/flexibleservers/databases": 1,
  "microsoft.insights/components": 1,
  "microsoft.keyvault/vaults": 1,
  "microsoft.managedidentity/userassignedidentities": 1,
  "microsoft.operationalinsights/workspaces": 1,
  "microsoft.storage/storageaccounts": 1,
  "microsoft.storage/storageaccounts/blobservices": 1,
  "microsoft.storage/storageaccounts/blobservices/containers": 2,
});
const EXPECTED_CHANGE_COUNT = Object.values(EXPECTED_RESOURCE_TYPE_COUNTS)
  .reduce((total, count) => total + count, 0);
const ALLOWED_RESOURCE_TYPES = new Set(Object.keys(EXPECTED_RESOURCE_TYPE_COUNTS));

const fail = (code) => {
  const error = new Error(code);
  error.code = code;
  throw error;
};

const sha256 = (value) => createHash("sha256").update(value).digest("hex");

const hasOwn = (value, key) => Object.prototype.hasOwnProperty.call(value, key);

const assertEmptyProviderField = (document, key) => {
  if (!hasOwn(document, key)) fail("MISSING_COMPLETENESS_FIELD");
  const value = document[key];
  if (value !== null && (!Array.isArray(value) || value.length !== 0)) fail("INCOMPLETE_PROVIDER_RESULT");
};

const sortedObject = (value) => Object.fromEntries(
  Object.entries(value).sort(([left], [right]) => left.localeCompare(right)),
);

export function expectedResourceGroupId(subscriptionId, resourceGroup) {
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(subscriptionId)) {
    fail("INVALID_SUBSCRIPTION_ID");
  }
  if (!/^rg-corgtex-migration-[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(resourceGroup)) {
    fail("INVALID_RESOURCE_GROUP");
  }
  return `/subscriptions/${subscriptionId}/resourceGroups/${resourceGroup}`;
}

export function resourceTypeFromId(resourceId, resourceGroupId) {
  const normalizedId = resourceId.toLowerCase();
  const normalizedGroup = resourceGroupId.toLowerCase();
  if (!normalizedId.startsWith(`${normalizedGroup}/providers/`)) fail("FOREIGN_RESOURCE");

  const segments = resourceId.split("/").filter(Boolean);
  let providerIndex = -1;
  for (let index = 0; index < segments.length; index += 1) {
    if (segments[index]?.toLowerCase() === "providers") providerIndex = index;
  }
  if (providerIndex < 0 || providerIndex + 3 >= segments.length) fail("INVALID_RESOURCE_ID");

  const provider = segments[providerIndex + 1];
  const tail = segments.slice(providerIndex + 2);
  if (!provider || tail.length === 0 || tail.length % 2 !== 0) fail("INVALID_RESOURCE_ID");
  const typeSegments = [];
  for (let index = 0; index < tail.length; index += 2) {
    if (!tail[index] || !tail[index + 1]) fail("INVALID_RESOURCE_ID");
    typeSegments.push(tail[index]);
  }
  return `${provider}/${typeSegments.join("/")}`.toLowerCase();
}

export function validateWhatIfDocument(document, options) {
  if (!document || typeof document !== "object" || Array.isArray(document)) fail("INVALID_DOCUMENT");
  if (document.status !== "Succeeded") fail("WHAT_IF_NOT_SUCCEEDED");
  assertEmptyProviderField(document, "diagnostics");
  assertEmptyProviderField(document, "potentialChanges");
  if (!hasOwn(document, "error")) fail("MISSING_COMPLETENESS_FIELD");
  if (document.error !== null) fail("INCOMPLETE_PROVIDER_RESULT");
  if (!Array.isArray(document.changes)) fail("MISSING_CHANGES");
  if (document.changes.length > MAX_CHANGES) fail("TOO_MANY_CHANGES");
  if (document.changes.length !== EXPECTED_CHANGE_COUNT) fail("INCOMPLETE_RESOURCE_SET");

  const resourceGroupId = expectedResourceGroupId(options.subscriptionId, options.resourceGroup);
  const seenResourceIds = new Set();
  const changeCounts = {};
  const resourceTypeCounts = {};

  for (const change of document.changes) {
    if (!change || typeof change !== "object" || Array.isArray(change)) fail("INVALID_CHANGE");
    if (typeof change.resourceId !== "string" || change.resourceId.length === 0 || change.resourceId.length > 2_048) {
      fail("INVALID_RESOURCE_ID");
    }
    if (change.changeType !== "Create") fail("UNSAFE_CHANGE_TYPE");

    const normalizedId = change.resourceId.toLowerCase();
    if (seenResourceIds.has(normalizedId)) fail("DUPLICATE_RESOURCE");
    seenResourceIds.add(normalizedId);

    const resourceType = resourceTypeFromId(change.resourceId, resourceGroupId);
    if (!ALLOWED_RESOURCE_TYPES.has(resourceType)) fail("UNEXPECTED_RESOURCE_TYPE");
    if (!change.after || typeof change.after !== "object" || Array.isArray(change.after)) fail("MISSING_AFTER_STATE");
    if (typeof change.after.type !== "string" || change.after.type.toLowerCase() !== resourceType) {
      fail("RESOURCE_TYPE_MISMATCH");
    }
    if (typeof change.after.apiVersion !== "string" || change.after.apiVersion.length === 0) {
      fail("MISSING_API_VERSION");
    }

    changeCounts[change.changeType] = (changeCounts[change.changeType] ?? 0) + 1;
    resourceTypeCounts[resourceType] = (resourceTypeCounts[resourceType] ?? 0) + 1;
  }

  if (JSON.stringify(sortedObject(resourceTypeCounts)) !== JSON.stringify(sortedObject(EXPECTED_RESOURCE_TYPE_COUNTS))) {
    fail("INCOMPLETE_RESOURCE_SET");
  }

  for (const digest of [options.templateDigest, options.parametersDigest, options.targetDigest]) {
    if (typeof digest !== "string" || !SHA256_PATTERN.test(digest)) fail("INVALID_BINDING_DIGEST");
  }

  return {
    schemaVersion: "2.0.0",
    status: "SAFE_EXACT_CREATE",
    changeCount: document.changes.length,
    changeCounts: sortedObject(changeCounts),
    resourceSetSha256: sha256([...seenResourceIds].sort().join("\n")),
    templateSha256: options.templateDigest,
    parametersSha256: options.parametersDigest,
    targetSha256: options.targetDigest,
    subscriptionRef: `sha256:${sha256(options.subscriptionId).slice(0, 16)}`,
    resourceGroupRef: `sha256:${sha256(resourceGroupId.toLowerCase()).slice(0, 16)}`,
  };
}

export function validateWhatIfBytes(bytes, options) {
  if (!Buffer.isBuffer(bytes) || bytes.length === 0 || bytes.length > MAX_INPUT_BYTES) fail("INVALID_INPUT_SIZE");
  let document;
  try {
    document = JSON.parse(bytes.toString("utf8"));
  } catch {
    fail("INVALID_JSON");
  }
  return {
    ...validateWhatIfDocument(document, options),
    previewSha256: sha256(bytes),
  };
}

function readBoundedFile(filePath) {
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
    if (error?.code && String(error.code).startsWith("INVALID_")) throw error;
    if (error?.code === "TRUNCATED_INPUT") throw error;
    fail("READ_FAILED");
  } finally {
    if (fileDescriptor !== null) {
      try {
        closeSync(fileDescriptor);
      } catch {
        // The validation result already fails closed; do not expose local details.
      }
    }
  }
}

function parseArgs(tokens) {
  const values = new Map();
  for (const token of tokens) {
    const separator = token.indexOf("=");
    if (!token.startsWith("--") || separator < 3) fail("INVALID_ARGS");
    const key = token.slice(2, separator);
    const value = token.slice(separator + 1);
    if (!value || values.has(key)) fail("INVALID_ARGS");
    values.set(key, value);
  }
  const required = [
    "input",
    "subscription-id",
    "resource-group",
    "template-digest",
    "parameters-digest",
    "target-digest",
  ];
  if (values.size !== required.length || required.some((key) => !values.has(key))) {
    fail("INVALID_ARGS");
  }
  return {
    input: values.get("input"),
    subscriptionId: values.get("subscription-id"),
    resourceGroup: values.get("resource-group"),
    templateDigest: values.get("template-digest"),
    parametersDigest: values.get("parameters-digest"),
    targetDigest: values.get("target-digest"),
  };
}

export function main(tokens = process.argv.slice(2)) {
  const args = parseArgs(tokens);
  const receipt = validateWhatIfBytes(readBoundedFile(args.input), args);
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
