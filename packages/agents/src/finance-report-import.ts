import { defaultModelGateway, type ModelGateway } from "@corgtex/models";
import { normalizeFinanceImportCurrency, resolveFinanceImportCurrency } from "@corgtex/domain";
import { z } from "zod";
import { validateFinanceReportEvidenceSourcesV1, type FinanceReportEvidenceFormat, type FinanceReportEvidenceSourceFact } from "./finance-report-evidence";
import {
  FINANCE_REPORT_ISO_4217_CODES,
  validateFinanceReportValueEvidenceV1,
} from "./finance-report-value-evidence";

export const FINANCE_REPORT_MODEL_PROPOSAL_VERSION = 1 as const;
const id = z.string().min(1).max(100);
const text = z.string().min(1).max(500);
const confidence = z.number().min(0).max(1);
const claimIds = z.array(id).min(1).max(50);
const pdfSource = z.strictObject({ kind: z.literal("PDF"), page: z.number().int().min(1).max(250), lineIndex: z.number().int().nonnegative(), line: z.string(), start: z.number().int().nonnegative(), end: z.number().int().positive(), text: z.string().min(1) });
const wholeCellSource = z.strictObject({ kind: z.literal("CELL"), sheet: z.string(), row: z.number().int().positive(), column: z.number().int().positive(), evidence: z.string() });
const cellSource = wholeCellSource.extend({ start: z.number().int().nonnegative().optional(), end: z.number().int().positive().optional(), text: z.string().min(1).optional() });
const evidenceClaim = z.union([
  z.strictObject({ id, role: z.literal("AMOUNT"), source: z.union([pdfSource, wholeCellSource]) }),
  z.strictObject({ id, role: z.enum(["TEXT", "ISO_CODE"]), source: z.union([pdfSource, cellSource]) }),
]);
const classification = z.strictObject({
  reportType: z.enum(["PROFIT_AND_LOSS", "BALANCE_SHEET", "CASH_FLOW", "TRIAL_BALANCE", "OTHER"]),
  basis: z.enum(["CASH", "ACCRUAL", "UNSPECIFIED"]),
  cadence: z.enum(["DAILY", "WEEKLY", "MONTHLY", "QUARTERLY", "ANNUAL", "CUSTOM"]).nullable(),
  reportTypeEvidenceClaimIds: claimIds, basisEvidenceClaimIds: claimIds, cadenceEvidenceClaimIds: z.array(id).max(50), confidence,
});
const numericFormat = z.discriminatedUnion("status", [
  z.strictObject({ status: z.literal("RESOLVED"), version: z.literal(1), decimalSeparator: z.enum(["DOT", "COMMA", "NONE"]), groupingSeparator: z.enum(["COMMA", "DOT", "APOSTROPHE", "SPACE", "NBSP", "NARROW_NBSP", "NONE"]), amountScale: z.union([z.literal(1), z.literal(100), z.literal(1_000), z.literal(1_000_000), z.literal(1_000_000_000)]), evidenceClaimIds: claimIds, confidence: confidence.positive() }),
  z.strictObject({ status: z.literal("UNRESOLVED"), version: z.literal(1), decimalSeparator: z.null(), groupingSeparator: z.null(), amountScale: z.null(), evidenceClaimIds: z.array(id).max(50), confidence }),
]);

export const financeReportModelProposalSchemaV1 = z.strictObject({
  version: z.literal(FINANCE_REPORT_MODEL_PROPOSAL_VERSION), classification, numericFormat,
  currency: z.strictObject({ explicitCode: z.string().regex(/^[A-Z]{3}$/).nullable(), evidenceClaimId: id.nullable(), confidence }),
  periods: z.array(z.strictObject({ id, label: text, periodStart: z.string().regex(/^\d{4}-\d{2}-\d{2}$/), periodEnd: z.string().regex(/^\d{4}-\d{2}-\d{2}$/), evidenceClaimIds: claimIds, confidence })).min(1).max(120),
  hierarchy: z.array(z.strictObject({ id, parentId: id.nullable(), label: text, evidenceClaimIds: claimIds, confidence })).min(1).max(1_000),
  mappings: z.array(z.strictObject({ id, amountClaimId: id, periodId: id, hierarchyId: id, factKind: z.enum(["LEAF", "DERIVED"]), confidence })).min(1).max(1_000),
  evidenceClaims: z.array(evidenceClaim).min(1).max(1_000),
  exceptions: z.array(z.strictObject({ code: z.string().regex(/^[A-Z][A-Z0-9_]{0,63}$/), severity: z.enum(["WARNING", "BLOCKER"]), message: text, evidenceClaimIds: z.array(id).max(50) })).max(200),
});

type ModelProposal = z.infer<typeof financeReportModelProposalSchemaV1>;
type ProposalException = ModelProposal["exceptions"][number];
export type FinanceReportImportProposalV1 = Omit<ModelProposal, "currency" | "mappings"> & {
  currency: { state: "RESOLVED" | "UNRESOLVED"; code: string | null; source: "DOCUMENT" | "WORKSPACE_SINGLE_CURRENCY" | null; evidenceClaimId: string | null; confidence: number };
  mappings: Array<ModelProposal["mappings"][number] & { amountCents: number | null; sourceKey: string }>;
};
export type FinanceReportImportProposalResultV1 =
  | { version: 1; kind: "SUCCESS"; attempts: 1 | 2; proposal: FinanceReportImportProposalV1 }
  | { version: 1; kind: "FAILURE"; attempts: 0 | 1 | 2; code: "INVALID_INPUT" | "INVALID_MODEL_OUTPUT" | "PROVIDER_ERROR" };
export type FinanceReportImportProposalInputV1 = { workspaceId: string; format: FinanceReportEvidenceFormat; extractedEvidence: string; workspaceCurrencyCodes: string[]; model?: string; workflowJobId?: string; agentRunId?: string; gateway?: ModelGateway };

const ISO_CODES = new Set(FINANCE_REPORT_ISO_4217_CODES);
const SCHEMA_HINT = JSON.stringify(z.toJSONSchema(financeReportModelProposalSchemaV1));
const INSTRUCTION = "Infer semantics from PDF, CSV, or XLSX extracted evidence without a vendor picker. Return an editable proposal only; never invent transactions or facts. Cite every semantic field and amount with exact report sources. Do not calculate cents. Use UNRESOLVED numeric format and null cadence when evidence is ambiguous; never choose values only to complete the schema. Set currency only when an exact ISO code appears in the report; otherwise use null. Surface ambiguity as exceptions and never guess or default to USD.";
const duplicate = (values: string[]) => new Set(values).size !== values.length;
const validDate = (value: string) => { const parsed = new Date(`${value}T00:00:00.000Z`); return Number(value.slice(0, 4)) >= 1_000 && !Number.isNaN(parsed.valueOf()) && parsed.toISOString().slice(0, 10) === value; };
type BoundFact = { kind: "TEXT" | "AMOUNT" | "ISO_CODE"; source: FinanceReportEvidenceSourceFact; amountCents?: number; code?: string };

function bindProposal(raw: unknown, input: FinanceReportImportProposalInputV1, workspaceCurrency: string | null): { proposal?: FinanceReportImportProposalV1; feedback?: string } {
  const parsed = financeReportModelProposalSchemaV1.safeParse(raw);
  if (!parsed.success) return { feedback: parsed.error.issues.slice(0, 12).map((issue) => `${issue.path.join(".")}:${issue.code}`).join(",") };
  const proposal = parsed.data;
  const sourceInput = { format: input.format, extractedEvidence: input.extractedEvidence, claims: proposal.evidenceClaims };
  let facts: Map<string, BoundFact>;
  if (proposal.numericFormat.status === "RESOLVED") {
    const { version, decimalSeparator, groupingSeparator, amountScale } = proposal.numericFormat;
    const values = validateFinanceReportValueEvidenceV1({ sourceInput, numericFormat: { version, decimalSeparator, groupingSeparator, amountScale } });
    if (values.kind === "BLOCKER") return { feedback: `evidence:${values.facts[0].code}:${values.facts[0].claimId ?? ""}` };
    facts = new Map(values.facts.map((fact) => [fact.source.claimId, fact]));
  } else {
    const sources = validateFinanceReportEvidenceSourcesV1(sourceInput);
    if (sources.kind === "BLOCKER") return { feedback: `evidence:${sources.facts[0].code}:${sources.facts[0].claimId ?? ""}` };
    facts = new Map(sources.facts.map((source) => [source.claimId, { kind: source.role, source, ...(source.role === "ISO_CODE" && ISO_CODES.has(source.selectedText) ? { code: source.selectedText } : {}) }]));
  }
  const textRefs = (ids: string[]) => ids.every((claimId) => facts.get(claimId)?.kind === "TEXT");
  const idsValid = (ids: string[]) => ids.every((claimId) => facts.has(claimId));
  const periods = new Map(proposal.periods.map((period) => [period.id, period]));
  const nodes = new Map(proposal.hierarchy.map((node) => [node.id, node]));
  if (duplicate(proposal.periods.map(({ id }) => id)) || duplicate(proposal.hierarchy.map(({ id }) => id)) || duplicate(proposal.mappings.map(({ id }) => id)) || duplicate(proposal.mappings.map(({ amountClaimId }) => amountClaimId))) return { feedback: "references:duplicate_semantic_id" };
  if (!textRefs(proposal.classification.reportTypeEvidenceClaimIds) || !textRefs(proposal.classification.basisEvidenceClaimIds) || (proposal.classification.cadence !== null && proposal.classification.cadenceEvidenceClaimIds.length === 0) || !textRefs(proposal.classification.cadenceEvidenceClaimIds) || !textRefs(proposal.numericFormat.evidenceClaimIds) || proposal.periods.some((period) => !textRefs(period.evidenceClaimIds) || !validDate(period.periodStart) || !validDate(period.periodEnd) || period.periodStart > period.periodEnd) || proposal.hierarchy.some((node) => !textRefs(node.evidenceClaimIds) || (node.parentId !== null && !nodes.has(node.parentId))) || proposal.exceptions.some((exception) => !idsValid(exception.evidenceClaimIds))) return { feedback: "references:invalid_semantic_evidence" };
  const paths = new Map<string, string>();
  for (const node of proposal.hierarchy) { const seen = new Set<string>(), labels: string[] = []; let current: typeof node | undefined = node; while (current) { if (seen.has(current.id)) return { feedback: "references:hierarchy_cycle" }; seen.add(current.id); labels.unshift(current.label); current = current.parentId ? nodes.get(current.parentId) : undefined; } paths.set(node.id, JSON.stringify(labels)); }
  const mappings: FinanceReportImportProposalV1["mappings"] = [];
  const targets = new Set<string>();
  for (const mapping of proposal.mappings) { const fact = facts.get(mapping.amountClaimId), period = periods.get(mapping.periodId), path = paths.get(mapping.hierarchyId); if (fact?.kind !== "AMOUNT" || !period || !path) return { feedback: "references:invalid_mapping" }; const target = JSON.stringify([period.periodStart, period.periodEnd, path]); if (targets.has(target)) return { feedback: "references:duplicate_mapping_target" }; targets.add(target); mappings.push({ ...mapping, amountCents: fact.amountCents ?? null, sourceKey: fact.source.sourceKey }); }
  const explicit = proposal.currency.explicitCode;
  const currencyFact = proposal.currency.evidenceClaimId ? facts.get(proposal.currency.evidenceClaimId) : undefined;
  if ((explicit === null) !== (proposal.currency.evidenceClaimId === null) || (explicit !== null && (currencyFact?.kind !== "ISO_CODE" || currencyFact.code !== explicit))) return { feedback: "currency:unverified_explicit_code" };
  const code = explicit ?? workspaceCurrency;
  const exceptions: ProposalException[] = [...proposal.exceptions];
  const addBlocker = (code: string, message: string) => { const blocker = { code, severity: "BLOCKER" as const, message, evidenceClaimIds: [] }; const index = exceptions.findIndex((item) => item.code === code); if (index < 0) exceptions.push(blocker); else exceptions[index] = blocker; };
  if (proposal.classification.reportType === "OTHER") addBlocker("REPORT_TYPE_UNRESOLVED", "Confirm the report type before approval.");
  if (proposal.classification.basis === "UNSPECIFIED") addBlocker("BASIS_UNRESOLVED", "Confirm the accounting basis before approval.");
  if (proposal.classification.cadence === null) addBlocker("CADENCE_UNRESOLVED", "Confirm the reporting cadence before approval.");
  if (proposal.numericFormat.status === "UNRESOLVED") addBlocker("NUMERIC_FORMAT_UNRESOLVED", "Confirm the numeric format and scale before calculating amounts.");
  if (proposal.classification.confidence === 0 || proposal.periods.some(({ confidence }) => confidence === 0) || proposal.hierarchy.some(({ confidence }) => confidence === 0) || proposal.mappings.some(({ confidence }) => confidence === 0)) addBlocker("SEMANTIC_PROPOSAL_UNCERTAIN", "Review zero-confidence report semantics before approval.");
  if (code === null) addBlocker("CURRENCY_UNRESOLVED", "Choose the report currency before approval.");
  return { proposal: { ...proposal, currency: { state: code ? "RESOLVED" : "UNRESOLVED", code, source: explicit ? "DOCUMENT" : code ? "WORKSPACE_SINGLE_CURRENCY" : null, evidenceClaimId: proposal.currency.evidenceClaimId, confidence: proposal.currency.confidence }, mappings, exceptions } };
}

export async function proposeFinanceReportImportV1(input: FinanceReportImportProposalInputV1): Promise<FinanceReportImportProposalResultV1> {
  if (!input.workspaceId?.trim() || !new Set(["PDF", "CSV", "XLSX"]).has(input.format) || !input.extractedEvidence || input.extractedEvidence.length > 2_000_000 || !Array.isArray(input.workspaceCurrencyCodes) || input.workspaceCurrencyCodes.some((code) => typeof code !== "string")) return { version: 1, kind: "FAILURE", attempts: 0, code: "INVALID_INPUT" };
  let workspaceCurrency: string | null;
  try { const normalized = input.workspaceCurrencyCodes.filter((code) => code.trim()).map((code) => normalizeFinanceImportCurrency(code)); if (normalized.some((code) => !ISO_CODES.has(code))) throw new Error("INVALID_INPUT"); const resolution = resolveFinanceImportCurrency({ workspaceCurrencies: normalized }); workspaceCurrency = resolution.state === "RESOLVED" ? resolution.currency : null; } catch { return { version: 1, kind: "FAILURE", attempts: 0, code: "INVALID_INPUT" }; }
  const gateway = input.gateway ?? defaultModelGateway;
  let previous: unknown; let feedback: string | undefined;
  for (const attempts of [1, 2] as const) {
    try {
      const response = await gateway.extract({ workspaceId: input.workspaceId, model: input.model, workflowJobId: input.workflowJobId, agentRunId: input.agentRunId, instruction: attempts === 1 ? INSTRUCTION : `${INSTRUCTION} Repair the previous object using this validation feedback: ${feedback}.`, schemaHint: SCHEMA_HINT, input: JSON.stringify({ format: input.format, extractedEvidence: input.extractedEvidence, ...(attempts === 2 ? { previous } : {}) }) });
      previous = response.output;
    } catch { return { version: 1, kind: "FAILURE", attempts, code: "PROVIDER_ERROR" }; }
    const bound = bindProposal(previous, input, workspaceCurrency);
    if (bound.proposal) return { version: 1, kind: "SUCCESS", attempts, proposal: bound.proposal };
    feedback = bound.feedback;
  }
  return { version: 1, kind: "FAILURE", attempts: 2, code: "INVALID_MODEL_OUTPUT" };
}
