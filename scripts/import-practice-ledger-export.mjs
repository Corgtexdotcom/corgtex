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
const INVALID_IMPORT_VALUE = Symbol("invalid_import_value");

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
  if (value == null) return null;
  const candidate = typeof value === "string" ? value.trim() : value;
  if (candidate === "") return null;
  const n = typeof candidate === "string" ? Number(candidate) : candidate;
  return Number.isFinite(n) ? n : null;
}

function toCents(value) {
  const n = parseFiniteNumber(value);
  if (n == null) return 0;
  return Math.round(n);
}

function toCentsStrict(value) {
  if (value == null || value === "") return 0;
  const n = parseFiniteNumber(value);
  return n == null ? null : Math.round(n);
}

function toOptionalCents(value) {
  if (value == null || value === "") return undefined;
  return toCents(value);
}

function toOptionalCentsStrict(value) {
  if (value === undefined || value === "") return undefined;
  if (value === null) return null;
  const n = parseFiniteNumber(value);
  return n == null ? INVALID_IMPORT_VALUE : Math.round(n);
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
  const calendarDate = text.match(/^(\d{4})-(\d{2})-(\d{2})(?:$|[T\s])/);
  if (calendarDate) {
    const [, year, month, day] = calendarDate;
    const normalized = new Date(Date.UTC(Number(year), Number(month) - 1, Number(day)));
    if (
      normalized.getUTCFullYear() !== Number(year)
      || normalized.getUTCMonth() + 1 !== Number(month)
      || normalized.getUTCDate() !== Number(day)
    ) {
      return null;
    }
  }
  const date = new Date(text);
  if (!Number.isFinite(date.getTime())) return null;
  return date;
}

function toOptionalDate(value) {
  if (value == null || value === "") return null;
  return toDate(value) ?? INVALID_IMPORT_VALUE;
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
  const moduleKey = trim(batch?.moduleKey);
  if (moduleKey && moduleKey !== PRACTICE_FINANCE_MODULE_KEY) {
    throw new Error(`Unsupported Practice Ledger export module: ${moduleKey}`);
  }
  if (version && moduleKey !== PRACTICE_FINANCE_MODULE_KEY) {
    throw new Error(`Unsupported Practice Ledger export module: ${moduleKey ?? "missing"}`);
  }
  if (!version || version === "1" || version === PRACTICE_FINANCE_SCHEMA_VERSION) return version;
  throw new Error(`Unsupported Practice Ledger export schema version: ${version}`);
}

function unknownPortableRecords(batch) {
  if (!batch || typeof batch !== "object" || !Array.isArray(batch.records)) return [];
  const version = portableBatchSchemaVersion(batch);
  if (version !== PRACTICE_FINANCE_SCHEMA_VERSION) return [];
  return batch.records.filter((record) => !portableRecordEntity(record));
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
  const poValueCents = toCentsStrict(record.poValueCents ?? record.budgetCents);
  const serviceBudgetCents = toCentsStrict(record.serviceBudgetCents);
  const expenseBudgetCents = toCentsStrict(record.expenseBudgetCents);
  const usedCents = toCentsStrict(record.usedCents);
  const weeklyBurnCents = toCentsStrict(record.weeklyBurnCents);
  const startsOn = hasOwn(record, "startsOn") ? toOptionalDate(record.startsOn) : undefined;
  const endsOn = hasOwn(record, "endsOn") ? toOptionalDate(record.endsOn) : undefined;
  if (!status) return null;
  if ([poValueCents, serviceBudgetCents, expenseBudgetCents, usedCents, weeklyBurnCents].some((value) => value == null)) return null;
  if ([startsOn, endsOn].some((value) => value === INVALID_IMPORT_VALUE)) return null;
  if (!sourceSatelliteId || !code || !name || !clientName) return null;
  return {
    sourceSatelliteId,
    code,
    name,
    clientName,
    status,
    currency: hasOwn(record, "currency") ? trim(record.currency) ?? undefined : undefined,
    poValueCents,
    serviceBudgetCents,
    expenseBudgetCents,
    usedCents,
    weeklyBurnCents,
    targetMarginBps: toBpsOrNull(record.targetMarginBps),
    currentMarginBps: toBpsOrNull(record.currentMarginBps),
    startsOn,
    endsOn,
    clientSourceId: optionalRelationSource(record, "clientSourceId", "clientId"),
    billingCodeSourceId: optionalRelationSource(record, "billingCodeSourceId", "billingCodeId"),
  };
}

function parseProjectLine(record) {
  const sourceSatelliteId = sourceId(record);
  const projectSourceId = relationSource(record, "projectSourceId", "projectId", "budgetId");
  const name = trim(record?.name);
  const kind = normalizeEnumStrict(record?.kind, VALID_LINE_KINDS, "SERVICES");
  const budgetCents = toCentsStrict(record?.budgetCents);
  const billRateCents = toOptionalCentsStrict(record?.billRateCents);
  const costRateCents = toOptionalCentsStrict(record?.costRateCents);
  if (!kind) return null;
  if (budgetCents == null || [billRateCents, costRateCents].some((value) => value === INVALID_IMPORT_VALUE)) return null;
  if (!sourceSatelliteId || !projectSourceId || !name) return null;
  return {
    sourceSatelliteId,
    projectSourceId,
    kind,
    name,
    budgetCents,
    billRateCents,
    costRateCents,
  };
}

function parsePurchaseOrder(record) {
  const sourceSatelliteId = sourceId(record);
  const projectSourceId = relationSource(record, "projectSourceId", "projectId", "budgetId");
  const poNumber = trim(record?.poNumber);
  const amountCents = toCentsStrict(record?.amountCents);
  const remainingPriorCents = toCentsStrict(record?.remainingPriorCents);
  const issuedOn = hasOwn(record, "issuedOn") ? toOptionalDate(record?.issuedOn) : undefined;
  if ([amountCents, remainingPriorCents].some((value) => value == null)) return null;
  if (issuedOn === INVALID_IMPORT_VALUE) return null;
  if (!sourceSatelliteId || !projectSourceId || !poNumber) return null;
  return {
    sourceSatelliteId,
    projectSourceId,
    poNumber,
    issuedOn,
    amountCents,
    remainingPriorCents,
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
  const totalAmountCents = toCentsStrict(record?.totalAmountCents);
  const cashAmountCents = toCentsStrict(record?.cashAmountCents);
  const sliceAmountCents = toCentsStrict(record?.sliceAmountCents);
  const settledAt = hasOwn(record, "settledAt") ? toOptionalDate(record?.settledAt) : undefined;
  if ([totalAmountCents, cashAmountCents, sliceAmountCents].some((value) => value == null)) return null;
  if (settledAt === INVALID_IMPORT_VALUE) return null;
  if (!sourceSatelliteId || !consultantSourceId) return null;
  return {
    sourceSatelliteId,
    consultantSourceId,
    currency: trim(record?.currency) ?? "USD",
    totalAmountCents,
    cashAmountCents,
    sliceAmountCents,
    memo: trim(record?.memo),
    settledAt,
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
  const billRateCents = toCentsStrict(record?.billRateCents);
  const costRateCents = toCentsStrict(record?.costRateCents);
  const billAmountCents = toOptionalCentsStrict(record?.billAmountCents);
  const costAmountCents = toOptionalCentsStrict(record?.costAmountCents);
  const paidAmountCents = toOptionalCentsStrict(record?.paidAmountCents);
  if (!sourceSatelliteId || !clientSourceId || !projectSourceId || !consultantSourceId || !workedOn || !weekEndingOn || hours == null || !status) return null;
  if (billRateCents == null || costRateCents == null || [billAmountCents, costAmountCents, paidAmountCents].some((value) => value === INVALID_IMPORT_VALUE)) return null;
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
    billRateCents,
    costRateCents,
    billAmountCents,
    costAmountCents,
    paidAmountCents,
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
  const amountFunctionalCents = toOptionalCentsStrict(record?.amountFunctionalCents);
  if (!sourceSatelliteId || !clientSourceId || !projectSourceId || !spentOn || !category || !businessPurpose || amountCents == null || !status) return null;
  if (amountFunctionalCents === INVALID_IMPORT_VALUE) return null;
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
    amountFunctionalCents,
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

function totalCounts(counts) {
  return Object.values(counts).reduce((sum, count) => sum + count, 0);
}

function importTotals(counts) {
  return {
    total: totalCounts(counts),
    byEntity: counts,
  };
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
  portableBatchSchemaVersion(batch);
  const entities = emptyEntityBuckets();
  const sourceCounts = emptyEntityCounts();
  const reconciliationSourceIds = Object.fromEntries(ENTITY_ORDER.map((entity) => [entity, []]));
  const available = Object.fromEntries(ENTITY_ORDER.map((entity) => [entity, new Set()]));
  const rowsByEntity = Object.fromEntries(ENTITY_ORDER.map((entity) => [entity, new Map()]));
  const seenUniqueKeys = new Set();
  const unknownSkipped = unknownPortableRecords(batch).map((record) => ({ reason: "unknown_record_type", record }));

  for (const entity of ENTITY_ORDER) {
    const parser = PARSERS[entity];
    const records = entityRecords(batch, entity);
    sourceCounts[entity] = records.length;
    for (const record of records) {
      const parsed = parser(record);
      if (!parsed) {
        entities[entity].skipped.push({ reason: "invalid", record });
        continue;
      }
      reconciliationSourceIds[entity].push(parsed.sourceSatelliteId);
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
  if (unknownSkipped.length > 0) {
    entities.unknownRecords = { valid: [], skipped: unknownSkipped };
    sourceCounts.unknownRecords = unknownSkipped.length;
    counts.planned.unknownRecords = 0;
    counts.skipped.unknownRecords = unknownSkipped.length;
  }

  return {
    entities,
    reconciliationSourceIds,
    counts: {
      source: sourceCounts,
      planned: counts.planned,
      skipped: counts.skipped,
    },
    valid: entities.projects.valid,
    skipped: [...entities.projects.skipped, ...unknownSkipped],
  };
}

function rowKey(entity, row) {
  return `${entity}:${row.sourceSatelliteId}`;
}

function addConflict(conflicts, entity, row, key) {
  const id = rowKey(entity, row);
  const current = conflicts.get(id) ?? [];
  current.push(key);
  conflicts.set(id, current);
}

function collectUnique(values) {
  return [...new Set(values.filter(Boolean))];
}

function rowsByValue(rows, field) {
  const grouped = new Map();
  for (const row of rows) {
    const value = row[field];
    if (!value) continue;
    const current = grouped.get(value) ?? [];
    current.push(row);
    grouped.set(value, current);
  }
  return grouped;
}

function conflictingSource(existing, row) {
  return existing.sourceSatelliteId !== row.sourceSatelliteId;
}

async function addCodeConflicts({ conflicts, delegate, workspaceId, entity, rows, keyPrefix }) {
  const codes = collectUnique(rows.map((row) => row.code));
  if (codes.length === 0) return;
  const existingRows = await delegate.findMany({
    where: { workspaceId, code: { in: codes } },
    select: { code: true, sourceSatelliteId: true },
  });
  const incoming = rowsByValue(rows, "code");
  for (const existing of existingRows) {
    for (const row of incoming.get(existing.code) ?? []) {
      if (conflictingSource(existing, row)) addConflict(conflicts, entity, row, `${keyPrefix}:${existing.code}`);
    }
  }
}

async function sourceIdMap(delegate, workspaceId, sourceSatelliteIds) {
  const ids = collectUnique(sourceSatelliteIds);
  if (ids.length === 0) return new Map();
  const rows = await delegate.findMany({
    where: { workspaceId, sourceSatelliteId: { in: ids } },
    select: { id: true, sourceSatelliteId: true },
  });
  return new Map(rows.map((row) => [row.sourceSatelliteId, row.id]));
}

async function targetUniqueConflicts(prisma, workspaceId, plan) {
  const conflicts = new Map();
  await addCodeConflicts({
    conflicts,
    delegate: prisma.practiceClient,
    workspaceId,
    entity: "clients",
    rows: plan.entities.clients.valid,
    keyPrefix: "clients:code",
  });
  await addCodeConflicts({
    conflicts,
    delegate: prisma.practiceBillingCode,
    workspaceId,
    entity: "billingCodes",
    rows: plan.entities.billingCodes.valid,
    keyPrefix: "billingCodes:code",
  });
  await addCodeConflicts({
    conflicts,
    delegate: prisma.practiceProject,
    workspaceId,
    entity: "projects",
    rows: plan.entities.projects.valid,
    keyPrefix: "projects:code",
  });

  const purchaseOrders = plan.entities.purchaseOrders.valid;
  const purchaseOrderProjectIds = await sourceIdMap(prisma.practiceProject, workspaceId, purchaseOrders.map((row) => row.projectSourceId));
  const purchaseOrderProjectDbIds = collectUnique(purchaseOrders.map((row) => purchaseOrderProjectIds.get(row.projectSourceId)));
  const purchaseOrderNumbers = collectUnique(purchaseOrders.map((row) => row.poNumber));
  if (purchaseOrderProjectDbIds.length > 0 && purchaseOrderNumbers.length > 0) {
    const existingPurchaseOrders = await prisma.practicePurchaseOrder.findMany({
      where: { workspaceId, projectId: { in: purchaseOrderProjectDbIds }, poNumber: { in: purchaseOrderNumbers } },
      select: { projectId: true, poNumber: true, sourceSatelliteId: true },
    });
    for (const row of purchaseOrders) {
      const projectId = purchaseOrderProjectIds.get(row.projectSourceId);
      if (!projectId) continue;
      const existing = existingPurchaseOrders.find((candidate) => candidate.projectId === projectId && candidate.poNumber === row.poNumber);
      if (existing && conflictingSource(existing, row)) addConflict(conflicts, "purchaseOrders", row, `purchaseOrders:project_po:${row.projectSourceId}:${row.poNumber}`);
    }
  }

  const assignments = plan.entities.assignments.valid;
  const assignmentProjectIds = await sourceIdMap(prisma.practiceProject, workspaceId, assignments.map((row) => row.projectSourceId));
  const assignmentConsultantIds = await sourceIdMap(prisma.practiceConsultant, workspaceId, assignments.map((row) => row.consultantSourceId));
  const assignmentProjectDbIds = collectUnique(assignments.map((row) => assignmentProjectIds.get(row.projectSourceId)));
  const assignmentConsultantDbIds = collectUnique(assignments.map((row) => assignmentConsultantIds.get(row.consultantSourceId)));
  if (assignmentProjectDbIds.length > 0 && assignmentConsultantDbIds.length > 0) {
    const existingAssignments = await prisma.practiceProjectAssignment.findMany({
      where: { workspaceId, projectId: { in: assignmentProjectDbIds }, consultantId: { in: assignmentConsultantDbIds } },
      select: { projectId: true, consultantId: true, sourceSatelliteId: true },
    });
    for (const row of assignments) {
      const projectId = assignmentProjectIds.get(row.projectSourceId);
      const consultantId = assignmentConsultantIds.get(row.consultantSourceId);
      if (!projectId || !consultantId) continue;
      const existing = existingAssignments.find((candidate) => candidate.projectId === projectId && candidate.consultantId === consultantId);
      if (existing && conflictingSource(existing, row)) addConflict(conflicts, "assignments", row, `assignments:project_consultant:${row.projectSourceId}:${row.consultantSourceId}`);
    }
  }

  for (const [entity, delegate, keyPrefix] of [
    ["timeEntries", prisma.practiceTimeEntry, "timeEntries:idempotencyKey"],
    ["expenses", prisma.practiceExpense, "expenses:idempotencyKey"],
  ]) {
    const rows = plan.entities[entity].valid.filter((row) => row.idempotencyKey);
    const idempotencyKeys = collectUnique(rows.map((row) => row.idempotencyKey));
    if (idempotencyKeys.length === 0) continue;
    const existingRows = await delegate.findMany({
      where: { workspaceId, idempotencyKey: { in: idempotencyKeys } },
      select: { idempotencyKey: true, sourceSatelliteId: true },
    });
    const incoming = rowsByValue(rows, "idempotencyKey");
    for (const existing of existingRows) {
      for (const row of incoming.get(existing.idempotencyKey) ?? []) {
        if (conflictingSource(existing, row)) addConflict(conflicts, entity, row, `${keyPrefix}:${existing.idempotencyKey}`);
      }
    }
  }

  const timeReviews = plan.entities.entryReviews.valid.filter((row) => row.timeEntrySourceId);
  const timeEntryIds = await sourceIdMap(prisma.practiceTimeEntry, workspaceId, timeReviews.map((row) => row.timeEntrySourceId));
  const timeEntryDbIds = collectUnique(timeReviews.map((row) => timeEntryIds.get(row.timeEntrySourceId)));
  if (timeEntryDbIds.length > 0) {
    const existingReviews = await prisma.practiceEntryReview.findMany({
      where: { workspaceId, targetType: "TIME_ENTRY", timeEntryId: { in: timeEntryDbIds } },
      select: { timeEntryId: true, sourceSatelliteId: true },
    });
    for (const row of timeReviews) {
      const timeEntryId = timeEntryIds.get(row.timeEntrySourceId);
      const existing = existingReviews.find((candidate) => candidate.timeEntryId === timeEntryId);
      if (existing && conflictingSource(existing, row)) addConflict(conflicts, "entryReviews", row, `entryReviews:time:${row.timeEntrySourceId}`);
    }
  }

  const expenseReviews = plan.entities.entryReviews.valid.filter((row) => row.expenseSourceId);
  const expenseIds = await sourceIdMap(prisma.practiceExpense, workspaceId, expenseReviews.map((row) => row.expenseSourceId));
  const expenseDbIds = collectUnique(expenseReviews.map((row) => expenseIds.get(row.expenseSourceId)));
  if (expenseDbIds.length > 0) {
    const existingReviews = await prisma.practiceEntryReview.findMany({
      where: { workspaceId, targetType: "EXPENSE", expenseId: { in: expenseDbIds } },
      select: { expenseId: true, sourceSatelliteId: true },
    });
    for (const row of expenseReviews) {
      const expenseId = expenseIds.get(row.expenseSourceId);
      const existing = existingReviews.find((candidate) => candidate.expenseId === expenseId);
      if (existing && conflictingSource(existing, row)) addConflict(conflicts, "entryReviews", row, `entryReviews:expense:${row.expenseSourceId}`);
    }
  }

  return conflicts;
}

function applyTargetUniqueConflicts(plan, conflicts) {
  if (conflicts.size === 0) return;
  for (const entity of ENTITY_ORDER) {
    const valid = [];
    for (const row of plan.entities[entity].valid) {
      const duplicate = conflicts.get(rowKey(entity, row));
      if (!duplicate) {
        valid.push(row);
        continue;
      }
      plan.entities[entity].skipped.push({ reason: "existing_unique_key", duplicate, record: row });
    }
    plan.entities[entity].valid = valid;
    plan.counts.planned[entity] = valid.length;
    plan.counts.skipped[entity] = plan.entities[entity].skipped.length;
  }
  plan.valid = plan.entities.projects.valid;
  plan.skipped = [...plan.entities.projects.skipped, ...(plan.entities.unknownRecords?.skipped ?? [])];
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

const TARGET_SOURCE_DELEGATES = {
  clients: "practiceClient",
  billingCodes: "practiceBillingCode",
  consultants: "practiceConsultant",
  projects: "practiceProject",
  projectLines: "practiceProjectLine",
  purchaseOrders: "practicePurchaseOrder",
  assignments: "practiceProjectAssignment",
  sourceDocuments: "practiceSourceDocument",
  paymentBatches: "practicePaymentBatch",
  timeEntries: "practiceTimeEntry",
  expenses: "practiceExpense",
  entryReviews: "practiceEntryReview",
};

const TARGET_SOURCE_ID_CHUNK_SIZE = 1000;

function chunked(values, size) {
  const chunks = [];
  for (let index = 0; index < values.length; index += size) {
    chunks.push(values.slice(index, index + size));
  }
  return chunks;
}

function reconciliationSourceIds(plan) {
  return Object.fromEntries(ENTITY_ORDER.map((entity) => [
    entity,
    collectUnique(plan.reconciliationSourceIds?.[entity] ?? plan.entities[entity].valid.map((row) => row.sourceSatelliteId)),
  ]));
}

function reconciliationSourceCounts(sourceIdsByEntity) {
  return Object.fromEntries(ENTITY_ORDER.map((entity) => [entity, sourceIdsByEntity[entity]?.length ?? 0]));
}

async function targetSourceReconciliation(prisma, workspaceId, sourceIdsByEntity) {
  const matched = emptyEntityCounts();
  const missing = emptyEntityCounts();

  for (const entity of ENTITY_ORDER) {
    const sourceSatelliteIds = sourceIdsByEntity[entity] ?? [];
    if (sourceSatelliteIds.length === 0) continue;
    const delegateName = TARGET_SOURCE_DELEGATES[entity];
    const found = new Set();
    for (const chunk of chunked(sourceSatelliteIds, TARGET_SOURCE_ID_CHUNK_SIZE)) {
      const rows = await prisma[delegateName].findMany({
        where: { workspaceId, sourceSatelliteId: { in: chunk } },
        select: { sourceSatelliteId: true },
      });
      for (const row of rows) found.add(row.sourceSatelliteId);
    }
    matched[entity] = found.size;
    missing[entity] = sourceSatelliteIds.filter((sourceSatelliteId) => !found.has(sourceSatelliteId)).length;
  }

  return {
    matched: importTotals(matched),
    missing: importTotals(missing),
  };
}

/**
 * Idempotently upsert a Practice Ledger export batch.
 * Dry run (apply=false) plans only and writes nothing.
 */
export async function importPracticeLedgerExport({ prisma, workspaceId, batch, apply = false }) {
  if (!workspaceId) throw new Error("workspaceId is required.");
  const plan = planImport(batch);
  const sourceIdsByEntity = reconciliationSourceIds(plan);
  const sourceIdCounts = reconciliationSourceCounts(sourceIdsByEntity);
  applyTargetUniqueConflicts(plan, await targetUniqueConflicts(prisma, workspaceId, plan));
  const targetBefore = await targetSourceReconciliation(prisma, workspaceId, sourceIdsByEntity);
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

  const targetAfter = apply ? await targetSourceReconciliation(prisma, workspaceId, sourceIdsByEntity) : null;

  return {
    dryRun: !apply,
    planned: totalCounts(plan.counts.planned),
    imported: apply ? totalCounts(imported) : 0,
    skipped: totalCounts(skipped),
    counts: {
      source: plan.counts.source,
      planned: plan.counts.planned,
      imported,
      skipped,
    },
    reconciliation: {
      source: importTotals(sourceIdCounts),
      targetBefore,
      targetAfter,
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
      console.error(
        `Dry run: ${result.planned} record(s) planned, ${result.skipped} skipped, `
        + `${result.reconciliation.targetBefore.matched.total} already present, `
        + `${result.reconciliation.targetBefore.missing.total} missing. Re-run with --apply to write.`,
      );
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
