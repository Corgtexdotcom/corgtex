import { types as nodeTypes } from "node:util";
import type { Prisma } from "@prisma/client";
import { prisma } from "@corgtex/shared";
import { z } from "zod";
import { invariant } from "./errors";

export const FINANCE_IMPORT_INTERPRETATION_VERSION = 1 as const;
const PRISMA_INT_MAX = 2_147_483_647;
const MAX_INTERPRETATION_JSON_CHARS = 4_500_000;
const unique = (values: readonly string[]) => new Set(values).size === values.length;
const boundedId = z.string().min(1).max(100).refine((value) => value.trim() === value, "Identifier whitespace is invalid.");
const evidenceIds = z.array(boundedId).max(50).refine(unique, "Evidence identifiers must be unique.");
const requiredEvidenceIds = z.array(boundedId).min(1).max(50).refine(unique, "Evidence identifiers must be unique.");
const confidence = z.number().min(0).max(1);
const boundedEvidenceText = z.string().max(2_000_000);
const selectedEvidenceText = z.string().min(1).max(2_000_000);

function isBoundedPlainJson(value: unknown, state = { nodes: 0, seen: new Set<object>() }): boolean {
  if (++state.nodes > 50_000) return false;
  if (value === null || typeof value === "string" || typeof value === "boolean") return true;
  if (typeof value === "number") return Number.isFinite(value);
  if (typeof value !== "object" || nodeTypes.isProxy(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  if (state.seen.has(value) || (!Array.isArray(value) && prototype !== Object.prototype && prototype !== null)) return false;
  if (Array.isArray(value) && prototype !== Array.prototype) return false;
  state.seen.add(value);
  const descriptors = Object.getOwnPropertyDescriptors(value);
  const keys = Reflect.ownKeys(descriptors);
  if (Array.isArray(value)) {
    const length = descriptors.length;
    const indices = keys.filter((key) => key !== "length");
    if (!length || !("value" in length) || length.value > 50_000 || indices.length !== length.value) return false;
    return indices.every((key, index) => typeof key === "string" && key === String(index)
      && descriptors[key]!.enumerable && "value" in descriptors[key]!
      && isBoundedPlainJson(descriptors[key]!.value, state));
  }
  return keys.every((key) => typeof key === "string" && descriptors[key]!.enumerable
    && "value" in descriptors[key]! && isBoundedPlainJson(descriptors[key]!.value, state));
}

const pdfSourceSchema = z.strictObject({
  kind: z.literal("PDF"),
  page: z.number().int().min(1).max(250),
  lineIndex: z.number().int().min(0).max(2_000_000),
  line: boundedEvidenceText,
  start: z.number().int().nonnegative(),
  end: z.number().int().positive(),
  text: selectedEvidenceText,
}).superRefine((source, context) => {
  if (source.start >= source.end || source.line.slice(source.start, source.end) !== source.text) {
    context.addIssue({ code: "custom", path: ["text"], message: "PDF evidence span is inconsistent." });
  }
});

const cellSourceSchema = z.strictObject({
  kind: z.literal("CELL"),
  sheet: boundedEvidenceText,
  row: z.number().int().min(1).max(20_000),
  column: z.number().int().min(1).max(4_294_967_295),
  evidence: boundedEvidenceText,
  start: z.number().int().nonnegative().optional(),
  end: z.number().int().positive().optional(),
  text: selectedEvidenceText.optional(),
}).superRefine((source, context) => {
  const span = [source.start, source.end, source.text];
  if (span.some((value) => value !== undefined) && span.some((value) => value === undefined)) {
    context.addIssue({ code: "custom", path: ["text"], message: "Cell evidence span must be complete." });
  } else if (source.start !== undefined && source.end !== undefined && source.text !== undefined
    && (source.start >= source.end || source.evidence.slice(source.start, source.end) !== source.text)) {
    context.addIssue({ code: "custom", path: ["text"], message: "Cell evidence span is inconsistent." });
  }
});

const evidenceClaimSchema = z.strictObject({
  id: boundedId,
  role: z.enum(["TEXT", "AMOUNT", "ISO_CODE"]),
  source: z.union([pdfSourceSchema, cellSourceSchema]),
}).superRefine((claim, context) => {
  if (claim.role === "AMOUNT" && claim.source.kind === "CELL" && claim.source.start !== undefined) {
    context.addIssue({ code: "custom", path: ["source"], message: "Cell amount evidence must use the whole cell." });
  }
});

const classificationSchema = z.strictObject({
  reportType: z.enum(["PROFIT_AND_LOSS", "BALANCE_SHEET", "CASH_FLOW", "TRIAL_BALANCE", "OTHER"]),
  basis: z.enum(["CASH", "ACCRUAL", "UNSPECIFIED"]),
  cadence: z.enum(["DAILY", "WEEKLY", "MONTHLY", "QUARTERLY", "ANNUAL", "CUSTOM"]).nullable(),
  reportTypeEvidenceClaimIds: evidenceIds,
  basisEvidenceClaimIds: evidenceIds,
  cadenceEvidenceClaimIds: evidenceIds,
  confidence,
}).superRefine((value, context) => {
  if (value.reportType !== "OTHER" && value.reportTypeEvidenceClaimIds.length === 0) {
    context.addIssue({ code: "custom", path: ["reportTypeEvidenceClaimIds"], message: "Resolved report type requires evidence." });
  }
  if (value.basis !== "UNSPECIFIED" && value.basisEvidenceClaimIds.length === 0) {
    context.addIssue({ code: "custom", path: ["basisEvidenceClaimIds"], message: "Resolved basis requires evidence." });
  }
  if (value.cadence !== null && value.cadenceEvidenceClaimIds.length === 0) {
    context.addIssue({ code: "custom", path: ["cadenceEvidenceClaimIds"], message: "Resolved cadence requires evidence." });
  }
});

const resolvedNumericFormatSchema = z.strictObject({
  status: z.literal("RESOLVED"),
  version: z.literal(FINANCE_IMPORT_INTERPRETATION_VERSION),
  decimalSeparator: z.enum(["DOT", "COMMA", "NONE"]),
  groupingSeparator: z.enum(["COMMA", "DOT", "APOSTROPHE", "SPACE", "NBSP", "NARROW_NBSP", "NONE"]),
  amountScale: z.union([z.literal(1), z.literal(100), z.literal(1_000), z.literal(1_000_000), z.literal(1_000_000_000)]),
  decimalSeparatorEvidenceClaimIds: evidenceIds,
  groupingSeparatorEvidenceClaimIds: evidenceIds,
  amountScaleEvidenceClaimIds: requiredEvidenceIds,
  confidence: confidence.positive(),
}).refine(
  (value) => value.decimalSeparator === "NONE" || value.decimalSeparator !== value.groupingSeparator,
  { path: ["groupingSeparator"], message: "Decimal and grouping separators cannot conflict." },
);

const unresolvedNumericFormatSchema = z.strictObject({
  status: z.literal("UNRESOLVED"),
  version: z.literal(FINANCE_IMPORT_INTERPRETATION_VERSION),
  decimalSeparator: z.null(),
  groupingSeparator: z.null(),
  amountScale: z.null(),
  evidenceClaimIds: evidenceIds,
  confidence,
});

const exceptionSchema = z.strictObject({
  code: z.string().regex(/^[A-Z][A-Z0-9_]{0,63}$/),
  severity: z.enum(["WARNING", "BLOCKER"]),
  message: z.string().min(1).max(500).refine((value) => value.trim() === value, "Message whitespace is invalid."),
  evidenceClaimIds: evidenceIds,
});

export const financeImportInterpretationSchemaV1 = z.strictObject({
  version: z.literal(FINANCE_IMPORT_INTERPRETATION_VERSION),
  classification: classificationSchema,
  numericFormat: z.discriminatedUnion("status", [resolvedNumericFormatSchema, unresolvedNumericFormatSchema]),
  evidenceClaims: z.array(evidenceClaimSchema).max(1_000).refine(
    (values) => unique(values.map(({ id }) => id)),
    "Evidence claim identifiers must be unique.",
  ),
  exceptions: z.array(exceptionSchema).max(200).refine(
    (values) => unique(values.map(({ code }) => code)),
    "Exception codes must be unique.",
  ),
}).superRefine((value, context) => {
  const classificationIds = [
    ...value.classification.reportTypeEvidenceClaimIds,
    ...value.classification.basisEvidenceClaimIds,
    ...value.classification.cadenceEvidenceClaimIds,
  ];
  const numericIds = value.numericFormat.status === "RESOLVED"
    ? [...value.numericFormat.decimalSeparatorEvidenceClaimIds, ...value.numericFormat.groupingSeparatorEvidenceClaimIds, ...value.numericFormat.amountScaleEvidenceClaimIds]
    : value.numericFormat.evidenceClaimIds;
  const exceptionIds = value.exceptions.flatMap(({ evidenceClaimIds }) => evidenceClaimIds);
  const textIds = new Set([...classificationIds, ...numericIds]);
  const referencedIds = new Set([...textIds, ...exceptionIds]);
  const claims = new Map(value.evidenceClaims.map((claim) => [claim.id, claim]));
  for (const id of referencedIds) {
    if (!claims.has(id)) context.addIssue({ code: "custom", path: ["evidenceClaims"], message: `Referenced evidence claim ${id} is missing.` });
  }
  for (const id of textIds) {
    if (claims.get(id)?.role !== "TEXT") context.addIssue({ code: "custom", path: ["evidenceClaims"], message: `Evidence claim ${id} must be text.` });
  }
  if (value.evidenceClaims.some(({ id }) => !referencedIds.has(id))) {
    context.addIssue({ code: "custom", path: ["evidenceClaims"], message: "Unused evidence claims are not durable interpretation state." });
  }
  if (JSON.stringify(value).length > MAX_INTERPRETATION_JSON_CHARS) {
    context.addIssue({ code: "custom", message: "Finance report interpretation exceeds the storage limit." });
  }
});

export type FinanceImportInterpretationV1 = z.infer<typeof financeImportInterpretationSchemaV1>;

export function parseFinanceImportInterpretationV1(value: unknown): FinanceImportInterpretationV1 {
  invariant(isBoundedPlainJson(value), 400, "INVALID_FINANCE_IMPORT_INTERPRETATION", "Finance report interpretation is invalid.");
  const parsed = financeImportInterpretationSchemaV1.safeParse(value);
  invariant(parsed.success, 400, "INVALID_FINANCE_IMPORT_INTERPRETATION", "Finance report interpretation is invalid.");
  return parsed.data;
}

export async function updateFinanceImportInterpretationV1(params: {
  workspaceId: string;
  batchId: string;
  expectedVersion: number;
  interpretation: unknown;
}) {
  const validId = (value: unknown) => typeof value === "string" && value.length <= 100 && value.trim() === value && value.length > 0;
  invariant(validId(params.workspaceId), 400, "INVALID_INPUT", "Workspace is required.");
  invariant(validId(params.batchId), 400, "INVALID_INPUT", "Finance import batch is required.");
  invariant(Number.isInteger(params.expectedVersion) && params.expectedVersion > 0 && params.expectedVersion < PRISMA_INT_MAX, 400, "INVALID_INPUT", "An incrementable Finance import version is required.");
  const interpretation = parseFinanceImportInterpretationV1(params.interpretation);
  const updated = await prisma.financeImportBatch.updateMany({
    where: { id: params.batchId, workspaceId: params.workspaceId, version: params.expectedVersion },
    data: {
      interpretationJson: interpretation as unknown as Prisma.InputJsonObject,
      version: { increment: 1 },
    },
  });
  invariant(updated.count === 1, 409, "FINANCE_IMPORT_INTERPRETATION_CONFLICT", "The Finance report import changed. Refresh and try again.");
  return { batchId: params.batchId, version: params.expectedVersion + 1, interpretation };
}
