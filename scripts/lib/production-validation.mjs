import { randomUUID } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";

export const VALIDATION_RESULT_STATUSES = Object.freeze([
  "pass",
  "partial",
  "blocked",
  "not production-applicable",
]);

export const CLEANUP_STATUSES = Object.freeze([
  "pending",
  "running",
  "completed",
  "skipped",
  "failed",
]);

const VALIDATION_RESULT_SET = new Set(VALIDATION_RESULT_STATUSES);
const CLEANUP_STATUS_SET = new Set(CLEANUP_STATUSES);

function assertObject(value, label) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${label} must be an object.`);
  }
}

function nonEmptyString(value, label) {
  const normalized = String(value ?? "").trim();
  if (!normalized) throw new Error(`${label} is required.`);
  return normalized;
}

function optionalString(value) {
  const normalized = String(value ?? "").trim();
  return normalized || null;
}

function normalizeRunId(value) {
  const runId = nonEmptyString(value, "runId");
  if (/\s/.test(runId)) {
    throw new Error("runId must not contain whitespace.");
  }
  return runId;
}

function normalizeValidationDate(value) {
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) {
    throw new Error(`Invalid validation date: ${value}`);
  }
  return date.toISOString().slice(0, 10);
}

export function defaultValidationRunId(prefix = "prod-verify") {
  const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
  return `${prefix}-${timestamp}-${randomUUID().slice(0, 8)}`;
}

export function normalizePrNumber(value) {
  const raw = String(value ?? "").trim();
  if (!/^\d+$/.test(raw)) {
    throw new Error(`PR number must be a positive integer, got: ${value ?? "<empty>"}`);
  }
  const parsed = Number(raw);
  if (!Number.isSafeInteger(parsed) || parsed < 1) {
    throw new Error(`PR number must be a positive integer, got: ${value}`);
  }
  return parsed;
}

export function parseValidationPrNumbers(value) {
  if (value === undefined || value === null || value === "") return [];
  const rawValues = Array.isArray(value)
    ? value
    : String(value).split(",");
  return [...new Set(rawValues.map((item) => normalizePrNumber(item)))];
}

export function productionValidationTag({ date = new Date(), prNumber, runId }) {
  return `PROD-VERIFY ${normalizeValidationDate(date)} PR-${normalizePrNumber(prNumber)} ${normalizeRunId(runId)}`;
}

export function isValidationResultStatus(value) {
  return VALIDATION_RESULT_SET.has(value);
}

export function normalizeValidationResultStatus(value) {
  const normalized = String(value ?? "").trim();
  if (!VALIDATION_RESULT_SET.has(normalized)) {
    throw new Error(`Validation result must be one of ${VALIDATION_RESULT_STATUSES.join(", ")}, got: ${value ?? "<empty>"}`);
  }
  return normalized;
}

function normalizeCleanupStatus(value) {
  const normalized = String(value ?? "").trim();
  if (!CLEANUP_STATUS_SET.has(normalized)) {
    throw new Error(`Cleanup status must be one of ${CLEANUP_STATUSES.join(", ")}, got: ${value ?? "<empty>"}`);
  }
  return normalized;
}

function normalizeTenant(tenant = {}) {
  if (typeof tenant === "string") {
    return { id: null, slug: tenant, label: tenant };
  }
  assertObject(tenant, "tenant");
  return {
    id: optionalString(tenant.id),
    slug: optionalString(tenant.slug),
    label: optionalString(tenant.label ?? tenant.name ?? tenant.slug ?? tenant.id),
  };
}

function normalizeEvidence(evidence = []) {
  const items = Array.isArray(evidence) ? evidence : [evidence];
  return items.filter(Boolean).map((item) => {
    if (typeof item === "string") {
      return { type: "note", summary: item, path: null, url: null };
    }
    assertObject(item, "evidence item");
    return {
      type: optionalString(item.type ?? item.kind) ?? "evidence",
      summary: optionalString(item.summary ?? item.label ?? item.path ?? item.url),
      path: optionalString(item.path),
      url: optionalString(item.url),
    };
  });
}

function normalizeArtifact(artifact) {
  assertObject(artifact, "artifact");
  return {
    type: optionalString(artifact.type ?? artifact.kind) ?? "artifact",
    path: optionalString(artifact.path),
    url: optionalString(artifact.url),
    summary: optionalString(artifact.summary ?? artifact.label),
  };
}

function normalizeCreatedRecord(record) {
  assertObject(record, "created record");
  return {
    type: nonEmptyString(record.type, "created record type"),
    id: nonEmptyString(record.id, "created record id"),
    label: optionalString(record.label ?? record.title ?? record.name),
    prNumbers: parseValidationPrNumbers(record.prNumbers),
    tenant: record.tenant ? normalizeTenant(record.tenant) : null,
    cleanupActionId: optionalString(record.cleanupActionId),
    createdAt: optionalString(record.createdAt) ?? new Date().toISOString(),
  };
}

export function createValidationRun({
  runId = defaultValidationRunId(),
  tenant = {},
  prNumbers = [],
  baseUrl = null,
  environment = process.env.NODE_ENV || null,
  startedAt = new Date(),
  metadata = {},
} = {}) {
  return {
    schemaVersion: 1,
    runId: normalizeRunId(runId),
    status: "running",
    startedAt: startedAt instanceof Date ? startedAt.toISOString() : new Date(startedAt).toISOString(),
    finishedAt: null,
    environment: optionalString(environment),
    baseUrl: optionalString(baseUrl),
    tenant: normalizeTenant(tenant),
    prNumbers: parseValidationPrNumbers(prNumbers),
    metadata: { ...metadata },
    results: [],
    createdRecords: [],
    cleanupActions: [],
    artifacts: [],
    blockers: [],
  };
}

export function recordArtifact(run, artifact) {
  const normalized = normalizeArtifact(artifact);
  const existing = run.artifacts.find((item) => item.type === normalized.type && item.path === normalized.path && item.url === normalized.url);
  if (existing) return existing;
  run.artifacts.push(normalized);
  return normalized;
}

export function recordCreatedRecord(run, record) {
  const normalized = normalizeCreatedRecord(record);
  const existing = run.createdRecords.find((item) => item.type === normalized.type && item.id === normalized.id);
  if (existing) {
    Object.assign(existing, {
      label: normalized.label ?? existing.label,
      cleanupActionId: normalized.cleanupActionId ?? existing.cleanupActionId,
    });
    return existing;
  }
  run.createdRecords.push(normalized);
  return normalized;
}

export function recordValidationResult(run, result) {
  assertObject(result, "validation result");
  const status = normalizeValidationResultStatus(result.result ?? result.status);
  const blocker = optionalString(result.blocker ?? result.blockerReason);
  if ((status === "partial" || status === "blocked") && !blocker) {
    throw new Error(`${status} validation results must include a blocker reason.`);
  }

  const prNumber = result.prNumber === undefined || result.prNumber === null
    ? (run.prNumbers.length === 1 ? run.prNumbers[0] : null)
    : normalizePrNumber(result.prNumber);

  const normalized = {
    prNumber,
    intent: nonEmptyString(result.intent, "validation result intent"),
    tenant: result.tenant ? normalizeTenant(result.tenant) : run.tenant,
    method: nonEmptyString(result.method, "validation result method"),
    evidence: normalizeEvidence(result.evidence),
    result: status,
    blocker,
    createdRecordIds: (result.createdRecordIds ?? []).map((id) => nonEmptyString(id, "created record id")),
    cleanupActionIds: (result.cleanupActionIds ?? []).map((id) => nonEmptyString(id, "cleanup action id")),
    checkedAt: optionalString(result.checkedAt) ?? new Date().toISOString(),
  };

  run.results.push(normalized);
  if (blocker) run.blockers.push({ prNumber, intent: normalized.intent, blocker });
  return normalized;
}

function cleanupActionKey(input) {
  if (input.id) return nonEmptyString(input.id, "cleanup action id");
  const targetType = nonEmptyString(input.target?.type ?? input.targetType, "cleanup target type");
  const targetId = nonEmptyString(input.target?.id ?? input.targetId, "cleanup target id");
  const action = nonEmptyString(input.action, "cleanup action");
  return `${action}:${targetType}:${targetId}`;
}

function normalizeCleanupEntry(input, id) {
  const target = input.target ?? {
    type: input.targetType,
    id: input.targetId,
    label: input.targetLabel,
  };
  assertObject(target, "cleanup target");
  return {
    id,
    action: nonEmptyString(input.action, "cleanup action"),
    target: {
      type: nonEmptyString(target.type, "cleanup target type"),
      id: nonEmptyString(target.id, "cleanup target id"),
      label: optionalString(target.label ?? target.title ?? target.name),
    },
    status: normalizeCleanupStatus(input.status ?? "pending"),
    attempts: 0,
    message: optionalString(input.message),
    startedAt: null,
    finishedAt: null,
  };
}

export function createValidationCleanupRegistry(run) {
  const actions = new Map();

  function add(input) {
    assertObject(input, "cleanup action");
    const id = cleanupActionKey(input);
    const existing = actions.get(id);
    if (existing) return existing.entry;

    const entry = normalizeCleanupEntry(input, id);
    const runner = input.runner;
    if (typeof runner !== "function") {
      throw new Error(`Cleanup action ${id} must include a runner function.`);
    }
    actions.set(id, { entry, runner });
    run.cleanupActions.push(entry);

    if (input.recordCreated !== false) {
      recordCreatedRecord(run, {
        type: entry.target.type,
        id: entry.target.id,
        label: entry.target.label,
        tenant: input.tenant ?? run.tenant,
        prNumbers: input.prNumbers ?? run.prNumbers,
        cleanupActionId: id,
      });
    }

    return entry;
  }

  function find(id) {
    const action = actions.get(id);
    if (!action) throw new Error(`Cleanup action not found: ${id}`);
    return action;
  }

  function markCompleted(id, message = "Cleanup completed during validation.") {
    const { entry } = find(id);
    entry.status = "completed";
    entry.message = optionalString(message);
    entry.finishedAt = new Date().toISOString();
    return entry;
  }

  function markSkipped(id, message = "Cleanup was not required.") {
    const { entry } = find(id);
    entry.status = "skipped";
    entry.message = optionalString(message);
    entry.finishedAt = new Date().toISOString();
    return entry;
  }

  async function runAction(id) {
    const { entry, runner } = find(id);
    if (entry.status === "completed" || entry.status === "skipped") return entry;
    entry.status = "running";
    entry.attempts += 1;
    entry.startedAt = new Date().toISOString();
    try {
      const output = await runner(entry);
      entry.status = "completed";
      entry.message = optionalString(output?.message ?? output) ?? entry.message ?? "Cleanup completed.";
      entry.finishedAt = new Date().toISOString();
      return entry;
    } catch (error) {
      entry.status = "failed";
      entry.message = serializeError(error).message;
      entry.finishedAt = new Date().toISOString();
      throw error;
    }
  }

  async function runAll({ throwOnFailure = false } = {}) {
    const completed = [];
    const failed = [];
    const skipped = [];
    for (const { entry } of [...actions.values()].reverse()) {
      if (entry.status === "completed") {
        completed.push(entry);
        continue;
      }
      if (entry.status === "skipped") {
        skipped.push(entry);
        continue;
      }
      try {
        const result = await runAction(entry.id);
        completed.push(result);
      } catch (error) {
        failed.push({ entry, error });
      }
    }
    if (failed.length > 0 && throwOnFailure) {
      throw new Error(`Validation cleanup failed for ${failed.map(({ entry }) => entry.id).join(", ")}`);
    }
    return { completed, failed, skipped };
  }

  return {
    add,
    markCompleted,
    markSkipped,
    runAction,
    runAll,
    entries: () => [...actions.values()].map(({ entry }) => entry),
  };
}

export async function runWithValidationCleanup(registry, operation, options = {}) {
  let operationError = null;
  try {
    return await operation();
  } catch (error) {
    operationError = error;
    throw error;
  } finally {
    const cleanup = await registry.runAll({ throwOnFailure: false });
    if (!operationError && cleanup.failed.length > 0 && options.throwOnCleanupFailure !== false) {
      throw new Error(`Validation cleanup failed for ${cleanup.failed.map(({ entry }) => entry.id).join(", ")}`);
    }
  }
}

export function serializeError(error) {
  return {
    name: error?.name ?? "Error",
    message: error instanceof Error ? error.message : String(error),
    stack: error instanceof Error ? error.stack : null,
  };
}

export function aggregateValidationRunStatus(run) {
  if (run.results.length === 0) return "partial";
  if (run.cleanupActions.some((entry) => entry.status === "failed" || entry.status === "pending" || entry.status === "running")) {
    return "partial";
  }
  if (run.results.some((result) => result.result === "blocked")) return "blocked";
  if (run.results.some((result) => result.result === "partial")) return "partial";
  if (run.results.every((result) => result.result === "not production-applicable")) {
    return "not production-applicable";
  }
  return "pass";
}

export function finalizeValidationRun(run, { status = null, finishedAt = new Date() } = {}) {
  run.status = status ? normalizeValidationResultStatus(status) : aggregateValidationRunStatus(run);
  run.finishedAt = finishedAt instanceof Date ? finishedAt.toISOString() : new Date(finishedAt).toISOString();
  return run;
}

function tableCell(value) {
  const text = String(value ?? "n/a").replace(/\s+/g, " ").trim() || "n/a";
  return text.replace(/\|/g, "\\|");
}

function tenantLabel(tenant) {
  return tenant?.label ?? tenant?.slug ?? tenant?.id ?? "n/a";
}

function evidenceLabel(items) {
  if (!items?.length) return "n/a";
  return items
    .map((item) => item.url ?? item.path ?? item.summary ?? item.type)
    .filter(Boolean)
    .join("<br>");
}

export function formatValidationReport(run) {
  const lines = [
    `# Production Validation Run ${run.runId}`,
    "",
    `- Status: ${run.status}`,
    `- Started: ${run.startedAt}`,
    `- Finished: ${run.finishedAt ?? "n/a"}`,
    `- Tenant: ${tenantLabel(run.tenant)}`,
    `- PRs: ${run.prNumbers.length ? run.prNumbers.map((number) => `#${number}`).join(", ") : "n/a"}`,
    "",
    "## Matrix",
    "",
    "| PR | Intent | Tenant | Method | Result | Blocker | Evidence |",
    "| --- | --- | --- | --- | --- | --- | --- |",
    ...run.results.map((result) => [
      `| ${tableCell(result.prNumber ? `#${result.prNumber}` : "n/a")}`,
      tableCell(result.intent),
      tableCell(tenantLabel(result.tenant)),
      tableCell(result.method),
      tableCell(result.result),
      tableCell(result.blocker),
      `${tableCell(evidenceLabel(result.evidence))} |`,
    ].join(" | ")),
  ];

  if (run.results.length === 0) {
    lines.push("| n/a | No validation results recorded | n/a | n/a | partial | No validation result was recorded | n/a |");
  }

  lines.push(
    "",
    "## Created Records",
    "",
    "| Type | ID | Label | Cleanup Action |",
    "| --- | --- | --- | --- |",
  );
  if (run.createdRecords.length === 0) {
    lines.push("| n/a | n/a | n/a | n/a |");
  } else {
    for (const record of run.createdRecords) {
      lines.push(`| ${tableCell(record.type)} | ${tableCell(record.id)} | ${tableCell(record.label)} | ${tableCell(record.cleanupActionId)} |`);
    }
  }

  lines.push(
    "",
    "## Cleanup",
    "",
    "| Action | Target | Status | Message |",
    "| --- | --- | --- | --- |",
  );
  if (run.cleanupActions.length === 0) {
    lines.push("| n/a | n/a | n/a | n/a |");
  } else {
    for (const cleanup of run.cleanupActions) {
      lines.push(`| ${tableCell(cleanup.action)} | ${tableCell(`${cleanup.target.type}:${cleanup.target.id}`)} | ${tableCell(cleanup.status)} | ${tableCell(cleanup.message)} |`);
    }
  }

  if (run.blockers.length > 0) {
    lines.push("", "## Blockers", "");
    for (const blocker of run.blockers) {
      lines.push(`- ${blocker.prNumber ? `#${blocker.prNumber}: ` : ""}${blocker.intent}: ${blocker.blocker}`);
    }
  }

  return `${lines.join("\n")}\n`;
}

export async function writeValidationArtifacts(run, outDir, { jsonFileName = null, markdownFileName = null } = {}) {
  const targetDir = path.resolve(outDir);
  await mkdir(targetDir, { recursive: true });
  finalizeValidationRun(run);

  const jsonPath = path.join(targetDir, jsonFileName ?? `${run.runId}.matrix.json`);
  const markdownPath = path.join(targetDir, markdownFileName ?? `${run.runId}.report.md`);
  recordArtifact(run, { type: "matrix-json", path: jsonPath, summary: "Machine-readable validation matrix" });
  recordArtifact(run, { type: "report-markdown", path: markdownPath, summary: "Human-readable validation report" });

  await writeFile(jsonPath, `${JSON.stringify(run, null, 2)}\n`);
  await writeFile(markdownPath, formatValidationReport(run));
  return { jsonPath, markdownPath };
}
