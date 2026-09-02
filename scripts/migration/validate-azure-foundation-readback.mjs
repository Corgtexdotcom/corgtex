#!/usr/bin/env node

import { createHash } from "node:crypto";
import { closeSync, constants, fstatSync, openSync, readSync } from "node:fs";
import { pathToFileURL } from "node:url";
import { expectedResourceGroupId, validateWhatIfBytes } from "./validate-azure-what-if.mjs";

const MAX_INPUT_BYTES = 32 * 1024 * 1024;

const fail = (code) => {
  const error = new Error(code);
  error.code = code;
  throw error;
};

const sha256 = (value) => createHash("sha256").update(value).digest("hex");

const parseJson = (bytes) => {
  try {
    return JSON.parse(bytes.toString("utf8"));
  } catch {
    fail("INVALID_JSON");
  }
};

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
        // The validator is already fail-closed; do not expose runner details.
      }
    }
  }
};

const expectedTagsMatch = (expected, actual) => {
  if (!expected || typeof expected !== "object" || Array.isArray(expected)) return false;
  if (!actual || typeof actual !== "object" || Array.isArray(actual)) return false;
  return Object.entries(expected).every(([key, value]) => actual[key] === value);
};

export function validateFoundationReadback(previewBytes, readbackBytes, options) {
  const preview = parseJson(previewBytes);
  const previewReceipt = validateWhatIfBytes(previewBytes, options);
  const readback = parseJson(readbackBytes);
  if (!Array.isArray(readback)) fail("INVALID_READBACK");
  if (readback.length !== preview.changes.length) fail("INCOMPLETE_READBACK");

  const expectedResourceGroupIdValue = expectedResourceGroupId(options.subscriptionId, options.resourceGroup);
  const expectedById = new Map(preview.changes.map((change) => [change.resourceId.toLowerCase(), change]));
  const observedIds = new Set();
  let tagsChecked = 0;
  let postgresVersion = null;
  let postgresBackupRetentionDays = null;

  for (const resource of readback) {
    if (!resource || typeof resource !== "object" || Array.isArray(resource)) fail("INVALID_READBACK_RESOURCE");
    if (typeof resource.id !== "string" || typeof resource.type !== "string") fail("INVALID_READBACK_RESOURCE");
    const normalizedId = resource.id.toLowerCase();
    if (observedIds.has(normalizedId)) fail("DUPLICATE_READBACK_RESOURCE");
    observedIds.add(normalizedId);

    const expected = expectedById.get(normalizedId);
    if (!expected) fail("UNEXPECTED_READBACK_RESOURCE");
    if (resource.type.toLowerCase() !== expected.after.type.toLowerCase()) fail("READBACK_TYPE_MISMATCH");

    if (expected.after.tags !== undefined) {
      if (!expectedTagsMatch(expected.after.tags, resource.tags)) fail("READBACK_TAG_MISMATCH");
      tagsChecked += 1;
    }

    if (resource.type.toLowerCase() === "microsoft.dbforpostgresql/flexibleservers") {
      postgresVersion = String(resource.properties?.version ?? "");
      postgresBackupRetentionDays = resource.properties?.backup?.backupRetentionDays;
      if (postgresVersion !== "18") fail("POSTGRES_VERSION_MISMATCH");
      if (postgresBackupRetentionDays !== 7) fail("POSTGRES_BACKUP_MISMATCH");
    }
  }

  if (observedIds.size !== expectedById.size) fail("INCOMPLETE_READBACK");
  if (!observedIds.has(expectedResourceGroupIdValue.toLowerCase())) fail("MISSING_RESOURCE_GROUP_READBACK");
  if (tagsChecked === 0) fail("MISSING_TAGGED_READBACK");
  if (postgresVersion === null || postgresBackupRetentionDays === null) fail("MISSING_POSTGRES_READBACK");

  return {
    schemaVersion: "1.0.0",
    status: "EXACT_CREATE_READ_BACK",
    resourceCount: observedIds.size,
    taggedResourceCount: tagsChecked,
    resourceSetSha256: sha256([...observedIds].sort().join("\n")),
    readbackSha256: sha256(readbackBytes),
    postgresVersion,
    postgresBackupRetentionDays,
    templateSha256: previewReceipt.templateSha256,
    parametersSha256: previewReceipt.parametersSha256,
    targetSha256: previewReceipt.targetSha256,
    subscriptionRef: previewReceipt.subscriptionRef,
    resourceGroupRef: previewReceipt.resourceGroupRef,
  };
}

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
  const required = [
    "preview",
    "input",
    "subscription-id",
    "resource-group",
    "template-digest",
    "parameters-digest",
    "target-digest",
  ];
  if (values.size !== required.length || required.some((key) => !values.has(key))) fail("INVALID_ARGS");
  return {
    preview: values.get("preview"),
    input: values.get("input"),
    subscriptionId: values.get("subscription-id"),
    resourceGroup: values.get("resource-group"),
    templateDigest: values.get("template-digest"),
    parametersDigest: values.get("parameters-digest"),
    targetDigest: values.get("target-digest"),
  };
};

export function main(tokens = process.argv.slice(2)) {
  const args = parseArgs(tokens);
  const receipt = validateFoundationReadback(
    readBoundedFile(args.preview),
    readBoundedFile(args.input),
    args,
  );
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
