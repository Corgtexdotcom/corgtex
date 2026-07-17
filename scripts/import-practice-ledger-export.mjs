#!/usr/bin/env node
/**
 * Native Practice Ledger import path.
 *
 * Consumes a Corgtex-shaped Practice Ledger export and idempotently loads it into
 * native workspace-scoped tables. Every imported row uses
 * `(workspaceId, sourceSatelliteId)` as its stable import key.
 *
 * Usage:
 *   node scripts/import-practice-ledger-export.mjs --file <export.json> --workspace <workspaceId> [--apply]
 *
 * Without --apply the command is a dry run and writes nothing.
 */
import { readFileSync } from "node:fs";
import process from "node:process";
import { Prisma } from "@prisma/client";

export const PRACTICE_FINANCE_MODULE_KEY = "practice-ledger";
export const PRACTICE_FINANCE_SCHEMA_VERSION = "2";

export const ENTITY_ORDER = [
  "clients",
  "billingCodes",
  "consultants",
  "projects",
  "projectLines",
  "purchaseOrders",
  "assignments",
  "sourceDocuments",
  "paymentBatches",
  "timeEntries",
  "expenses",
  "entryReviews",
];

const ENTITY_ALIASES = {
  billingCodes: ["billingCodes", "billing_codes"],
  projectLines: ["projectLines", "budgetLines", "lines"],
  purchaseOrders: ["purchaseOrders", "purchase_orders"],
  assignments: ["assignments", "projectAssignments"],
  sourceDocuments: ["sourceDocuments", "source_documents"],
  paymentBatches: ["paymentBatches", "payment_batches"],
  timeEntries: ["timeEntries", "time_entries"],
  entryReviews: ["entryReviews", "entry_reviews", "reviews"],
  projects: ["projects", "budgets"],
  clients: ["clients"],
  consultants: ["consultants"],
  expenses: ["expenses"],
};

const PORTABLE_RECORD_ENTITY_ALIASES = new Map([
  ["client", "clients"],
  ["clients", "clients"],
  ["practiceclient", "clients"],
  ["billingcode", "billingCodes"],
  ["billingcodes", "billingCodes"],
  ["practicebillingcode", "billingCodes"],
  ["consultant", "consultants"],
  ["consultants", "consultants"],
  ["practiceconsultant", "consultants"],
  ["project", "projects"],
  ["projects", "projects"],
  ["budget", "projects"],
  ["budgets", "projects"],
  ["practiceproject", "projects"],
  ["projectline", "projectLines"],
  ["projectlines", "projectLines"],
  ["budgetline", "projectLines"],
  ["budgetlines", "projectLines"],
  ["practiceprojectline", "projectLines"],
  ["purchaseorder", "purchaseOrders"],
  ["purchaseorders", "purchaseOrders"],
  ["practicepurchaseorder", "purchaseOrders"],
  ["assignment", "assignments"],
  ["assignments", "assignments"],
  ["projectassignment", "assignments"],
  ["practiceprojectassignment", "assignments"],
  ["sourcedocument", "sourceDocuments"],
  ["sourcedocuments", "sourceDocuments"],
  ["practicesourcedocument", "sourceDocuments"],
  ["paymentbatch", "paymentBatches"],
  ["paymentbatches", "paymentBatches"],
  ["practicepaymentbatch", "paymentBatches"],
  ["timeentry", "timeEntries"],
  ["timeentries", "timeEntries"],
  ["practicetimeentry", "timeEntries"],
  ["expense", "expenses"],
  ["expenses", "expenses"],
  ["practiceexpense", "expenses"],
  ["entryreview", "entryReviews"],
  ["entryreviews", "entryReviews"],
  ["review", "entryReviews"],
  ["reviews", "entryReviews"],
  ["practiceentryreview", "entryReviews"],
]);

const VALID_PROJECT_STATUSES = new Set(["ACTIVE", "ON_HOLD", "CLOSED"]);
const VALID_CLIENT_STATUSES = new Set(["ACTIVE", "ARCHIVED"]);
const VALID_LINE_KINDS = new Set(["SERVICES", "EXPENSES", "SUBSCRIPTIONS", "COMMISSION", "INTERNAL"]);
const VALID_ENTRY_STATUSES = new Set(["POSTED", "REVERSED"]);
const VALID_SOURCE_DOCUMENT_TYPES = new Set(["INVOICE", "STATEMENT", "RECEIPT", "TIMESHEET", "OTHER"]);
const VALID_SOURCE_DOCUMENT_STATUSES = new Set(["POSTED", "NEEDS_REVIEW", "ARCHIVED"]);
const VALID_REVIEW_TARGETS = new Set(["TIME_ENTRY", "EXPENSE"]);
const VALID_REVIEW_STATUSES = new Set(["DRAFT", "SUBMITTED", "APPROVED", "SETTLED"]);

const DEPENDENCIES = {
  billingCodes: [{ field: "clientSourceId", entity: "clients", optional: true }],
  projects: [
    { field: "clientSourceId", entity: "clients", optional: true },
    { field: "billingCodeSourceId", entity: "billingCodes", optional: true },
  ],
  projectLines: [{ field: "projectSourceId", entity: "projects" }],
  purchaseOrders: [{ field: "projectSourceId", entity: "projects" }],
  assignments: [
    { field: "projectSourceId", entity: "projects" },
    { field: "consultantSourceId", entity: "consultants" },
  ],
  paymentBatches: [{ field: "consultantSourceId", entity: "consultants" }],
  timeEntries: [
    { field: "clientSourceId", entity: "clients" },
    { field: "billingCodeSourceId", entity: "billingCodes", optional: true },
    { field: "projectSourceId", entity: "projects" },
    { field: "projectLineSourceId", entity: "projectLines", optional: true },
    { field: "consultantSourceId", entity: "consultants" },
    { field: "sourceDocumentSourceId", entity: "sourceDocuments", optional: true },
    { field: "paymentBatchSourceId", entity: "paymentBatches", optional: true },
  ],
  expenses: [
    { field: "clientSourceId", entity: "clients" },
    { field: "billingCodeSourceId", entity: "billingCodes", optional: true },
    { field: "projectSourceId", entity: "projects" },
    { field: "projectLineSourceId", entity: "projectLines", optional: true },
    { field: "consultantSourceId", entity: "consultants", optional: true },
    { field: "sourceDocumentSourceId", entity: "sourceDocuments", optional: true },
    { field: "paymentBatchSourceId", entity: "paymentBatches", optional: true },
  ],
  entryReviews: [
    { field: "timeEntrySourceId", entity: "timeEntries", optional: true },
    { field: "expenseSourceId", entity: "expenses", optional: true },
  ],
};

export function parseArgs(argv) {
  const args = { file: null, workspaceId: null, apply: false };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--file") args.file = argv[++i] ?? null;
    else if (arg === "--workspace") args.workspaceId = argv[++i] ?? null;
    else if (arg === "--apply") args.apply = true;
  }
  return args;
}

function trim(value) {
  const text = String(value ?? "").trim();
  return text || null;
}

function sourceId(record) {
  return trim(record?.sourceSatelliteId ?? record?.id);
}

function hasOwn(record, key) {
  return Object.prototype.hasOwnProperty.call(record ?? {}, key);
}

function parseFiniteNumber(value) {
  if (value == null || value === "") return null;
  const n = typeof value === "string" ? Number(value) : value;
  return Number.isFinite(n) ? n : null;
}

function toCents(value) {
  const n = parseFiniteNumber(value);
  if (n == null) return 0;
  return Math.round(n);
}

function toOptionalCents(value) {
  if (value == null || value === "") return undefined;
  return toCents(value);
}

function toRequiredCents(value) {
  const n = parseFiniteNumber(value);
  return n == null ? null : Math.round(n);
}

function toBpsOrNull(value) {
  if (value == null || value === "") return null;
  const n = typeof value === "string" ? Number(value) : value;
  if (!Number.isFinite(n)) return null;
  const rounded = Math.round(n);
  if (rounded < 0 || rounded > 10000) return null;
  return rounded;
}

function toDate(value) {
  const text = trim(value);
  if (!text) return null;
  const date = new Date(text);
  return Number.isFinite(date.getTime()) ? date : null;
}

function toJson(value) {
  if (value === undefined) return undefined;
  if (value === null) return Prisma.JsonNull;
  return value;
}

function normalizeEnumStrict(value, valid, fallback) {
  const text = trim(value);
  if (!text) return fallback;
  const normalized = text.toUpperCase().replace(/[\s-]+/g, "_");
  return valid.has(normalized) ? normalized : null;
}

function relationSource(record, ...names) {
  for (const name of names) {
    const value = trim(record?.[name]);
    if (value) return value;
  }
  return null;
}

function optionalRelationSource(record, ...names) {
  for (const name of names) {
    if (hasOwn(record, name)) return trim(record?.[name]);
  }
  return undefined;
}

function portableRecordEntity(record) {
  const raw = trim(record?.entity ?? record?.entityType ?? record?.recordType ?? record?.table ?? record?.model);
  if (!raw) return null;
  const normalized = raw.toLowerCase().replace(/[^a-z0-9]/g, "");
  return PORTABLE_RECORD_ENTITY_ALIASES.get(normalized) ?? null;
}

function portableBatchSchemaVersion(batch) {
  const version = String(batch?.schemaVersion ?? "").trim();
  if (!version || version === "1" || version === PRACTICE_FINANCE_SCHEMA_VERSION) return version;
  throw new Error(`Unsupported Practice Ledger export schema version: ${version}`);
}

function entityRecords(batch, entity) {
  if (Array.isArray(batch)) return entity === "projects" ? batch : [];
  if (!batch || typeof batch !== "object") return [];
  for (const alias of ENTITY_ALIASES[entity] ?? [entity]) {
    const records = batch[alias];
    if (Array.isArray(records)) return records;
  }
  if (Array.isArray(batch.records)) {
    const version = portableBatchSchemaVersion(batch);
    if (version === "1" || !version) return entity === "projects" ? batch.records : [];
    return batch.records.filter((record) => portableRecordEntity(record) === entity);
  }
  return [];
}

export function parsePortableRecord(record) {
  return parseProject(record);
}

function parseClient(record) {
  const sourceSatelliteId = sourceId(record);
  const code = trim(record?.code);
  const name = trim(record?.name);
  const status = normalizeEnumStrict(record?.status, VALID_CLIENT_STATUSES, "ACTIVE");
  if (!status) return null;
  if (!sourceSatelliteId || !code || !name) return null;
  return {
    sourceSatelliteId,
    code,
    name,
    leadName: trim(record?.leadName),
    status,
    crmAccountId: trim(record?.crmAccountId),
  };
}

function parseBillingCode(record) {
  const sourceSatelliteId = sourceId(record);
  const code = trim(record?.code);
  const name = trim(record?.name);
  if (!sourceSatelliteId || !code || !name) return null;
  return {
    sourceSatelliteId,
    code,
    name,
    billable: record?.billable !== false,
    clientSourceId: relationSource(record, "clientSourceId", "clientId"),
  };
}

function parseConsultant(record) {
  const sourceSatelliteId = sourceId(record);
  const name = trim(record?.name);
  if (!sourceSatelliteId || !name) return null;
  return {
    sourceSatelliteId,
    name,
    email: trim(record?.email),
    homeCurrency: trim(record?.homeCurrency) ?? "USD",
    active: record?.active !== false,
  };
}

function parseProject(record) {
  if (!record || typeof record !== "object") return null;
  const sourceSatelliteId = sourceId(record);
  const code = trim(record.code);
  const name = trim(record.name);
  const clientName = trim(record.clientName ?? record.client);
  const status = normalizeEnumStrict(record.status, VALID_PROJECT_STATUSES, "ACTIVE");
  if (!status) return null;
  if (!sourceSatelliteId || !code || !name || !clientName) return null;
  return {
    sourceSatelliteId,
    code,
    name,
    clientName,
    status,
    currency: hasOwn(record, "currency") ? trim(record.currency) ?? undefined : undefined,
    poValueCents: toCents(record.poValueCents ?? record.budgetCents),
    serviceBudgetCents: toCents(record.serviceBudgetCents),
    expenseBudgetCents: toCents(record.expenseBudgetCents),
    usedCents: toCents(record.usedCents),
    weeklyBurnCents: toCents(record.weeklyBurnCents),
    targetMarginBps: toBpsOrNull(record.targetMarginBps),
    currentMarginBps: toBpsOrNull(record.currentMarginBps),
    startsOn: hasOwn(record, "startsOn") ? toDate(record.startsOn) : undefined,
    endsOn: hasOwn(record, "endsOn") ? toDate(record.endsOn) : undefined,
    clientSourceId: optionalRelationSource(record, "clientSourceId", "clientId"),
    billingCodeSourceId: optionalRelationSource(record, "billingCodeSourceId", "billingCodeId"),
  };
}

function parseProjectLine(record) {
  const sourceSatelliteId = sourceId(record);
  const projectSourceId = relationSource(record, "projectSourceId", "projectId", "budgetId");
  const name = trim(record?.name);
  const kind = normalizeEnumStrict(record?.kind, VALID_LINE_KINDS, "SERVICES");
  if (!kind) return null;
  if (!sourceSatelliteId || !projectSourceId || !name) return null;
  return {
    sourceSatelliteId,
    projectSourceId,
    kind,
    name,
    budgetCents: toCents(record?.budgetCents),
    billRateCents: toOptionalCents(record?.billRateCents),
    costRateCents: toOptionalCents(record?.costRateCents),
  };
}

function parsePurchaseOrder(record) {
  const sourceSatelliteId = sourceId(record);
  const projectSourceId = relationSource(record, "projectSourceId", "projectId", "budgetId");
  const poNumber = trim(record?.poNumber);
  if (!sourceSatelliteId || !projectSourceId || !poNumber) return null;
  return {
    sourceSatelliteId,
    projectSourceId,
    poNumber,
    issuedOn: toDate(record?.issuedOn),
    amountCents: toCents(record?.amountCents),
    remainingPriorCents: toCents(record?.remainingPriorCents),
  };
}

function parseAssignment(record) {
  const sourceSatelliteId = sourceId(record);
  const projectSourceId = relationSource(record, "projectSourceId", "projectId", "budgetId");
  const consultantSourceId = relationSource(record, "consultantSourceId", "consultantId");
  if (!sourceSatelliteId || !projectSourceId || !consultantSourceId) return null;
  return {
    sourceSatelliteId,
    projectSourceId,
    consultantSourceId,
    role: trim(record?.role) ?? "Contributor",
  };
}

function parseSourceDocument(record) {
  const sourceSatelliteId = sourceId(record);
  const type = normalizeEnumStrict(record?.type, VALID_SOURCE_DOCUMENT_TYPES, "OTHER");
  const status = normalizeEnumStrict(record?.status, VALID_SOURCE_DOCUMENT_STATUSES, "POSTED");
  if (!type || !status) return null;
  if (!sourceSatelliteId) return null;
  return {
    sourceSatelliteId,
    type,
    status,
    fileName: trim(record?.fileName),
    mimeType: trim(record?.mimeType),
    storageKey: trim(record?.storageKey),
    contentHash: trim(record?.contentHash),
    parserClient: trim(record?.parserClient),
    parserConfidence: record?.parserConfidence ?? undefined,
    submittedPayload: toJson(record?.submittedPayload),
    createdRecords: toJson(record?.createdRecords),
  };
}

function parsePaymentBatch(record) {
  const sourceSatelliteId = sourceId(record);
  const consultantSourceId = relationSource(record, "consultantSourceId", "consultantId");
  if (!sourceSatelliteId || !consultantSourceId) return null;
  return {
    sourceSatelliteId,
    consultantSourceId,
    currency: trim(record?.currency) ?? "USD",
    totalAmountCents: toCents(record?.totalAmountCents),
    cashAmountCents: toCents(record?.cashAmountCents),
    sliceAmountCents: toCents(record?.sliceAmountCents),
    memo: trim(record?.memo),
    settledAt: hasOwn(record, "settledAt") ? toDate(record?.settledAt) : undefined,
  };
}

function parseTimeEntry(record) {
  const sourceSatelliteId = sourceId(record);
  const clientSourceId = relationSource(record, "clientSourceId", "clientId");
  const projectSourceId = relationSource(record, "projectSourceId", "projectId", "budgetId");
  const consultantSourceId = relationSource(record, "consultantSourceId", "consultantId");
  const workedOn = toDate(record?.workedOn);
  const weekEndingOn = toDate(record?.weekEndingOn);
  const hours = parseFiniteNumber(record?.hours);
  const status = normalizeEnumStrict(record?.status, VALID_ENTRY_STATUSES, "POSTED");
  if (!sourceSatelliteId || !clientSourceId || !projectSourceId || !consultantSourceId || !workedOn || !weekEndingOn || hours == null || !status) return null;
  return {
    sourceSatelliteId,
    clientSourceId,
    billingCodeSourceId: relationSource(record, "billingCodeSourceId", "billingCodeId"),
    projectSourceId,
    projectLineSourceId: relationSource(record, "projectLineSourceId", "projectLineId", "budgetLineId"),
    consultantSourceId,
    sourceDocumentSourceId: relationSource(record, "sourceDocumentSourceId", "sourceDocumentId"),
    paymentBatchSourceId: relationSource(record, "paymentBatchSourceId", "paymentBatchId"),
    workedOn,
    weekEndingOn,
    hours,
    assignmentType: trim(record?.assignmentType) ?? "PB",
    currency: trim(record?.currency) ?? "USD",
    billCurrency: trim(record?.billCurrency),
    costCurrency: trim(record?.costCurrency),
    functionalCurrency: trim(record?.functionalCurrency),
    billRateCents: toCents(record?.billRateCents),
    costRateCents: toCents(record?.costRateCents),
    billAmountCents: toOptionalCents(record?.billAmountCents),
    costAmountCents: toOptionalCents(record?.costAmountCents),
    paidAmountCents: toOptionalCents(record?.paidAmountCents),
    status,
    idempotencyKey: trim(record?.idempotencyKey),
  };
}

function parseExpense(record) {
  const sourceSatelliteId = sourceId(record);
  const clientSourceId = relationSource(record, "clientSourceId", "clientId");
  const projectSourceId = relationSource(record, "projectSourceId", "projectId", "budgetId");
  const spentOn = toDate(record?.spentOn);
  const category = trim(record?.category);
  const businessPurpose = trim(record?.businessPurpose);
  const amountCents = toRequiredCents(record?.amountCents);
  const status = normalizeEnumStrict(record?.status, VALID_ENTRY_STATUSES, "POSTED");
  if (!sourceSatelliteId || !clientSourceId || !projectSourceId || !spentOn || !category || !businessPurpose || amountCents == null || !status) return null;
  return {
    sourceSatelliteId,
    clientSourceId,
    billingCodeSourceId: relationSource(record, "billingCodeSourceId", "billingCodeId"),
    projectSourceId,
    projectLineSourceId: relationSource(record, "projectLineSourceId", "projectLineId", "budgetLineId"),
    consultantSourceId: relationSource(record, "consultantSourceId", "consultantId"),
    sourceDocumentSourceId: relationSource(record, "sourceDocumentSourceId", "sourceDocumentId"),
    paymentBatchSourceId: relationSource(record, "paymentBatchSourceId", "paymentBatchId"),
    spentOn,
    vendor: trim(record?.vendor),
    category,
    businessPurpose,
    amountCents,
    currency: trim(record?.currency) ?? "USD",
    amountFunctionalCents: toOptionalCents(record?.amountFunctionalCents),
    functionalCurrency: trim(record?.functionalCurrency),
    billable: record?.billable !== false,
    status,
    idempotencyKey: trim(record?.idempotencyKey),
  };
}

function parseEntryReview(record) {
  const sourceSatelliteId = sourceId(record);
  const rawTarget = normalizeEnumStrict(record?.targetType ?? record?.entryType, VALID_REVIEW_TARGETS, "TIME_ENTRY");
  if (!rawTarget) return null;
  const genericEntrySourceId = relationSource(record, "entrySourceId", "entryId");
  const timeEntrySourceId = relationSource(record, "timeEntrySourceId", "timeEntryId")
    ?? (rawTarget === "TIME_ENTRY" ? genericEntrySourceId : null);
  const expenseSourceId = relationSource(record, "expenseSourceId", "expenseId")
    ?? (rawTarget === "EXPENSE" ? genericEntrySourceId : null);
  const inferredTarget = timeEntrySourceId ? "TIME_ENTRY" : expenseSourceId ? "EXPENSE" : undefined;
  const targetType = normalizeEnumStrict(record?.targetType ?? record?.entryType ?? inferredTarget, VALID_REVIEW_TARGETS, inferredTarget ?? "TIME_ENTRY");
  const status = normalizeEnumStrict(record?.status, VALID_REVIEW_STATUSES, "SUBMITTED");
  if (!targetType || !status) return null;
  if (!sourceSatelliteId || (targetType === "TIME_ENTRY" && !timeEntrySourceId) || (targetType === "EXPENSE" && !expenseSourceId)) return null;
  return {
    sourceSatelliteId,
    targetType,
    timeEntrySourceId: targetType === "TIME_ENTRY" ? timeEntrySourceId : null,
    expenseSourceId: targetType === "EXPENSE" ? expenseSourceId : null,
    status,
    note: trim(record?.note),
    reviewedByUserId: trim(record?.reviewedByUserId),
  };
}

const PARSERS = {
  clients: parseClient,
  billingCodes: parseBillingCode,
  consultants: parseConsultant,
  projects: parseProject,
  projectLines: parseProjectLine,
  purchaseOrders: parsePurchaseOrder,
  assignments: parseAssignment,
  sourceDocuments: parseSourceDocument,
  paymentBatches: parsePaymentBatch,
  timeEntries: parseTimeEntry,
  expenses: parseExpense,
  entryReviews: parseEntryReview,
};

function emptyEntityBuckets() {
  return Object.fromEntries(ENTITY_ORDER.map((entity) => [entity, { valid: [], skipped: [] }]));
}

function emptyEntityCounts() {
  return Object.fromEntries(ENTITY_ORDER.map((entity) => [entity, 0]));
}

function dependencyMisses(row, available, entity) {
  return (DEPENDENCIES[entity] ?? []).filter((dependency) => {
    const value = row[dependency.field];
    if (!value) return !dependency.optional;
    return !available[dependency.entity]?.has(value);
  });
}

function uniqueKeys(row, entity) {
  const keys = [`${entity}:sourceSatelliteId:${row.sourceSatelliteId}`];
  if (entity === "clients") keys.push(`clients:code:${row.code}`);
  if (entity === "billingCodes") keys.push(`billingCodes:code:${row.code}`);
  if (entity === "projects") keys.push(`projects:code:${row.code}`);
  if (entity === "purchaseOrders") keys.push(`purchaseOrders:project_po:${row.projectSourceId}:${row.poNumber}`);
  if (entity === "assignments") keys.push(`assignments:project_consultant:${row.projectSourceId}:${row.consultantSourceId}`);
  if (entity === "timeEntries" && row.idempotencyKey) keys.push(`timeEntries:idempotencyKey:${row.idempotencyKey}`);
  if (entity === "expenses" && row.idempotencyKey) keys.push(`expenses:idempotencyKey:${row.idempotencyKey}`);
  if (entity === "entryReviews" && row.timeEntrySourceId) keys.push(`entryReviews:time:${row.timeEntrySourceId}`);
  if (entity === "entryReviews" && row.expenseSourceId) keys.push(`entryReviews:expense:${row.expenseSourceId}`);
  return keys;
}

function relationshipMisses(row, rowsByEntity, entity) {
  const misses = [];
  const client = row.clientSourceId ? rowsByEntity.clients.get(row.clientSourceId) : null;
  const billingCode = row.billingCodeSourceId ? rowsByEntity.billingCodes.get(row.billingCodeSourceId) : null;
  const project = row.projectSourceId ? rowsByEntity.projects.get(row.projectSourceId) : null;
  const projectLine = row.projectLineSourceId ? rowsByEntity.projectLines.get(row.projectLineSourceId) : null;
  const paymentBatch = row.paymentBatchSourceId ? rowsByEntity.paymentBatches.get(row.paymentBatchSourceId) : null;

  if (billingCode?.clientSourceId && client && billingCode.clientSourceId !== row.clientSourceId) {
    misses.push("billing_code_client_mismatch");
  }
  if (project?.clientSourceId && client && project.clientSourceId !== row.clientSourceId) {
    misses.push("project_client_mismatch");
  }
  if (project?.billingCodeSourceId && billingCode && project.billingCodeSourceId !== row.billingCodeSourceId) {
    misses.push("project_billing_code_mismatch");
  }
  if (projectLine && projectLine.projectSourceId !== row.projectSourceId) {
    misses.push("project_line_project_mismatch");
  }
  if (paymentBatch?.consultantSourceId && row.consultantSourceId && paymentBatch.consultantSourceId !== row.consultantSourceId) {
    misses.push("payment_batch_consultant_mismatch");
  }

  if (entity === "projects" && billingCode?.clientSourceId && row.clientSourceId && billingCode.clientSourceId !== row.clientSourceId) {
    misses.push("project_billing_code_client_mismatch");
  }

  return misses;
}

/** Split records into importable rows and skipped records, validating dependencies. */
export function planImport(batch) {
  const entities = emptyEntityBuckets();
  const available = Object.fromEntries(ENTITY_ORDER.map((entity) => [entity, new Set()]));
  const rowsByEntity = Object.fromEntries(ENTITY_ORDER.map((entity) => [entity, new Map()]));
  const seenUniqueKeys = new Set();

  for (const entity of ENTITY_ORDER) {
    const parser = PARSERS[entity];
    for (const record of entityRecords(batch, entity)) {
      const parsed = parser(record);
      if (!parsed) {
        entities[entity].skipped.push({ reason: "invalid", record });
        continue;
      }
      const misses = dependencyMisses(parsed, available, entity);
      if (misses.length > 0) {
        entities[entity].skipped.push({
          reason: "missing_dependency",
          missing: misses.map((dependency) => `${dependency.entity}.${parsed[dependency.field] ?? dependency.field}`),
          record,
        });
        continue;
      }
      const duplicateKeys = uniqueKeys(parsed, entity).filter((key) => seenUniqueKeys.has(key));
      if (duplicateKeys.length > 0) {
        entities[entity].skipped.push({
          reason: "duplicate_unique_key",
          duplicate: duplicateKeys,
          record,
        });
        continue;
      }
      const relationshipErrors = relationshipMisses(parsed, rowsByEntity, entity);
      if (relationshipErrors.length > 0) {
        entities[entity].skipped.push({
          reason: "relationship_mismatch",
          mismatches: relationshipErrors,
          record,
        });
        continue;
      }
      entities[entity].valid.push(parsed);
      available[entity].add(parsed.sourceSatelliteId);
      rowsByEntity[entity].set(parsed.sourceSatelliteId, parsed);
      for (const key of uniqueKeys(parsed, entity)) seenUniqueKeys.add(key);
    }
  }

  const counts = { planned: emptyEntityCounts(), skipped: emptyEntityCounts() };
  for (const entity of ENTITY_ORDER) {
    counts.planned[entity] = entities[entity].valid.length;
    counts.skipped[entity] = entities[entity].skipped.length;
  }

  return {
    entities,
    counts,
    valid: entities.projects.valid,
    skipped: entities.projects.skipped,
  };
}

function totalCounts(counts) {
  return Object.values(counts).reduce((sum, count) => sum + count, 0);
}

function sourceWhere(workspaceId, sourceSatelliteId) {
  return { workspaceId_sourceSatelliteId: { workspaceId, sourceSatelliteId } };
}

function connectSource(workspaceId, sourceSatelliteId) {
  return sourceSatelliteId ? { connect: sourceWhere(workspaceId, sourceSatelliteId) } : undefined;
}

function disconnectableSource(workspaceId, sourceSatelliteId) {
  if (sourceSatelliteId === undefined) return undefined;
  return sourceSatelliteId ? { connect: sourceWhere(workspaceId, sourceSatelliteId) } : { disconnect: true };
}

async function crmAccountRelation(prisma, workspaceId, crmAccountId, mode) {
  if (!crmAccountId) return mode === "update" ? { disconnect: true } : undefined;
  const account = await prisma.crmAccount.findFirst({
    where: { id: crmAccountId, workspaceId },
    select: { id: true },
  });
  if (!account) throw new Error("CRM account does not belong to the target workspace.");
  return { connect: { id: crmAccountId } };
}

function withDefinedValues(data) {
  return Object.fromEntries(Object.entries(data).filter(([, value]) => value !== undefined));
}

async function upsertClient(prisma, workspaceId, row) {
  const { sourceSatelliteId, crmAccountId, ...fields } = row;
  const update = withDefinedValues({
    ...fields,
    leadName: row.leadName,
    crmAccount: await crmAccountRelation(prisma, workspaceId, crmAccountId, "update"),
  });
  const create = withDefinedValues({
    workspaceId,
    sourceSatelliteId,
    ...fields,
    leadName: row.leadName,
    crmAccount: await crmAccountRelation(prisma, workspaceId, crmAccountId, "create"),
  });
  return prisma.practiceClient.upsert({
    where: sourceWhere(workspaceId, sourceSatelliteId),
    update,
    create,
  });
}

async function upsertBillingCode(prisma, workspaceId, row) {
  const { sourceSatelliteId, clientSourceId, ...fields } = row;
  const update = withDefinedValues({
    ...fields,
    client: disconnectableSource(workspaceId, clientSourceId),
  });
  const create = withDefinedValues({
    workspaceId,
    sourceSatelliteId,
    ...fields,
    client: connectSource(workspaceId, clientSourceId),
  });
  return prisma.practiceBillingCode.upsert({
    where: sourceWhere(workspaceId, sourceSatelliteId),
    update,
    create,
  });
}

async function upsertConsultant(prisma, workspaceId, row) {
  const { sourceSatelliteId, ...fields } = row;
  return prisma.practiceConsultant.upsert({
    where: sourceWhere(workspaceId, sourceSatelliteId),
    update: fields,
    create: { workspaceId, sourceSatelliteId, ...fields },
  });
}

async function upsertProject(prisma, workspaceId, row) {
  const { sourceSatelliteId, clientSourceId, billingCodeSourceId, ...fields } = row;
  const update = withDefinedValues({
    ...fields,
    client: disconnectableSource(workspaceId, clientSourceId),
    billingCode: disconnectableSource(workspaceId, billingCodeSourceId),
  });
  const create = withDefinedValues({
    workspaceId,
    sourceSatelliteId,
    ...fields,
    client: connectSource(workspaceId, clientSourceId),
    billingCode: connectSource(workspaceId, billingCodeSourceId),
  });
  return prisma.practiceProject.upsert({
    where: sourceWhere(workspaceId, sourceSatelliteId),
    update,
    create,
  });
}

async function upsertProjectLine(prisma, workspaceId, row) {
  const { sourceSatelliteId, projectSourceId, ...fields } = row;
  const data = withDefinedValues({
    ...fields,
    project: connectSource(workspaceId, projectSourceId),
  });
  return prisma.practiceProjectLine.upsert({
    where: sourceWhere(workspaceId, sourceSatelliteId),
    update: data,
    create: { workspaceId, sourceSatelliteId, ...data },
  });
}

async function upsertPurchaseOrder(prisma, workspaceId, row) {
  const { sourceSatelliteId, projectSourceId, ...fields } = row;
  const data = withDefinedValues({
    ...fields,
    project: connectSource(workspaceId, projectSourceId),
  });
  return prisma.practicePurchaseOrder.upsert({
    where: sourceWhere(workspaceId, sourceSatelliteId),
    update: data,
    create: { workspaceId, sourceSatelliteId, ...data },
  });
}

async function upsertAssignment(prisma, workspaceId, row) {
  const { sourceSatelliteId, projectSourceId, consultantSourceId, ...fields } = row;
  const data = {
    ...fields,
    project: connectSource(workspaceId, projectSourceId),
    consultant: connectSource(workspaceId, consultantSourceId),
  };
  return prisma.practiceProjectAssignment.upsert({
    where: sourceWhere(workspaceId, sourceSatelliteId),
    update: data,
    create: { workspaceId, sourceSatelliteId, ...data },
  });
}

async function upsertSourceDocument(prisma, workspaceId, row) {
  const { sourceSatelliteId, ...fields } = row;
  const data = withDefinedValues(fields);
  return prisma.practiceSourceDocument.upsert({
    where: sourceWhere(workspaceId, sourceSatelliteId),
    update: data,
    create: { workspaceId, sourceSatelliteId, ...data },
  });
}

async function upsertPaymentBatch(prisma, workspaceId, row) {
  const { sourceSatelliteId, consultantSourceId, ...fields } = row;
  const data = withDefinedValues({
    ...fields,
    consultant: connectSource(workspaceId, consultantSourceId),
  });
  return prisma.practicePaymentBatch.upsert({
    where: sourceWhere(workspaceId, sourceSatelliteId),
    update: data,
    create: { workspaceId, sourceSatelliteId, ...data },
  });
}

async function upsertTimeEntry(prisma, workspaceId, row) {
  const {
    sourceSatelliteId,
    clientSourceId,
    billingCodeSourceId,
    projectSourceId,
    projectLineSourceId,
    consultantSourceId,
    sourceDocumentSourceId,
    paymentBatchSourceId,
    ...fields
  } = row;
  const update = withDefinedValues({
    ...fields,
    client: connectSource(workspaceId, clientSourceId),
    billingCode: disconnectableSource(workspaceId, billingCodeSourceId),
    project: connectSource(workspaceId, projectSourceId),
    projectLine: disconnectableSource(workspaceId, projectLineSourceId),
    consultant: connectSource(workspaceId, consultantSourceId),
    sourceDocument: disconnectableSource(workspaceId, sourceDocumentSourceId),
    paymentBatch: disconnectableSource(workspaceId, paymentBatchSourceId),
  });
  const create = withDefinedValues({
    workspaceId,
    sourceSatelliteId,
    ...fields,
    client: connectSource(workspaceId, clientSourceId),
    billingCode: connectSource(workspaceId, billingCodeSourceId),
    project: connectSource(workspaceId, projectSourceId),
    projectLine: connectSource(workspaceId, projectLineSourceId),
    consultant: connectSource(workspaceId, consultantSourceId),
    sourceDocument: connectSource(workspaceId, sourceDocumentSourceId),
    paymentBatch: connectSource(workspaceId, paymentBatchSourceId),
  });
  return prisma.practiceTimeEntry.upsert({
    where: sourceWhere(workspaceId, sourceSatelliteId),
    update,
    create,
  });
}

async function upsertExpense(prisma, workspaceId, row) {
  const {
    sourceSatelliteId,
    clientSourceId,
    billingCodeSourceId,
    projectSourceId,
    projectLineSourceId,
    consultantSourceId,
    sourceDocumentSourceId,
    paymentBatchSourceId,
    ...fields
  } = row;
  const update = withDefinedValues({
    ...fields,
    client: connectSource(workspaceId, clientSourceId),
    billingCode: disconnectableSource(workspaceId, billingCodeSourceId),
    project: connectSource(workspaceId, projectSourceId),
    projectLine: disconnectableSource(workspaceId, projectLineSourceId),
    consultant: disconnectableSource(workspaceId, consultantSourceId),
    sourceDocument: disconnectableSource(workspaceId, sourceDocumentSourceId),
    paymentBatch: disconnectableSource(workspaceId, paymentBatchSourceId),
  });
  const create = withDefinedValues({
    workspaceId,
    sourceSatelliteId,
    ...fields,
    client: connectSource(workspaceId, clientSourceId),
    billingCode: connectSource(workspaceId, billingCodeSourceId),
    project: connectSource(workspaceId, projectSourceId),
    projectLine: connectSource(workspaceId, projectLineSourceId),
    consultant: connectSource(workspaceId, consultantSourceId),
    sourceDocument: connectSource(workspaceId, sourceDocumentSourceId),
    paymentBatch: connectSource(workspaceId, paymentBatchSourceId),
  });
  return prisma.practiceExpense.upsert({
    where: sourceWhere(workspaceId, sourceSatelliteId),
    update,
    create,
  });
}

async function upsertEntryReview(prisma, workspaceId, row) {
  const { sourceSatelliteId, timeEntrySourceId, expenseSourceId, ...fields } = row;
  const update = withDefinedValues({
    ...fields,
    timeEntry: disconnectableSource(workspaceId, timeEntrySourceId),
    expense: disconnectableSource(workspaceId, expenseSourceId),
  });
  const create = withDefinedValues({
    workspaceId,
    sourceSatelliteId,
    ...fields,
    timeEntry: connectSource(workspaceId, timeEntrySourceId),
    expense: connectSource(workspaceId, expenseSourceId),
  });
  return prisma.practiceEntryReview.upsert({
    where: sourceWhere(workspaceId, sourceSatelliteId),
    update,
    create,
  });
}

const UPSERTS = {
  clients: upsertClient,
  billingCodes: upsertBillingCode,
  consultants: upsertConsultant,
  projects: upsertProject,
  projectLines: upsertProjectLine,
  purchaseOrders: upsertPurchaseOrder,
  assignments: upsertAssignment,
  sourceDocuments: upsertSourceDocument,
  paymentBatches: upsertPaymentBatch,
  timeEntries: upsertTimeEntry,
  expenses: upsertExpense,
  entryReviews: upsertEntryReview,
};

/**
 * Idempotently upsert a Practice Ledger export batch.
 * Dry run (apply=false) plans only and writes nothing.
 */
export async function importPracticeLedgerExport({ prisma, workspaceId, batch, apply = false }) {
  if (!workspaceId) throw new Error("workspaceId is required.");
  const plan = planImport(batch);
  const imported = emptyEntityCounts();
  const skipped = { ...plan.counts.skipped };

  if (apply) {
    for (const entity of ENTITY_ORDER) {
      for (const row of plan.entities[entity].valid) {
        try {
          await UPSERTS[entity](prisma, workspaceId, row);
          imported[entity] += 1;
        } catch {
          skipped[entity] += 1;
        }
      }
    }
  }

  return {
    dryRun: !apply,
    planned: totalCounts(plan.counts.planned),
    imported: apply ? totalCounts(imported) : 0,
    skipped: totalCounts(skipped),
    counts: {
      planned: plan.counts.planned,
      imported,
      skipped,
    },
  };
}

async function main() {
  const { file, workspaceId, apply } = parseArgs(process.argv.slice(2));
  if (!file || !workspaceId) {
    console.error("Usage: node scripts/import-practice-ledger-export.mjs --file <export.json> --workspace <workspaceId> [--apply]");
    process.exit(1);
    return;
  }

  const raw = JSON.parse(readFileSync(file, "utf8"));
  const { PrismaClient } = await import("@prisma/client");
  const prisma = new PrismaClient();
  try {
    const result = await importPracticeLedgerExport({ prisma, workspaceId, batch: raw, apply });
    console.log(JSON.stringify(result));
    if (result.dryRun) {
      console.error(`Dry run: ${result.planned} record(s) would import, ${result.skipped} skipped. Re-run with --apply to write.`);
    }
  } finally {
    await prisma.$disconnect();
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((error) => {
    console.error(error);
    process.exit(1);
  });
}
