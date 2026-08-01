import { defaultModelGateway, type ModelGateway } from "@corgtex/models";
import { z } from "zod";
import { type FinanceReportEvidenceFormat } from "./finance-report-evidence";
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
  cadence: z.enum(["DAILY", "WEEKLY", "MONTHLY", "QUARTERLY", "ANNUAL", "CUSTOM"]),
  reportTypeEvidenceClaimIds: claimIds, basisEvidenceClaimIds: claimIds, cadenceEvidenceClaimIds: claimIds, confidence,
});
const numericFormat = z.strictObject({ version: z.literal(1), decimalSeparator: z.enum(["DOT", "COMMA", "NONE"]), groupingSeparator: z.enum(["COMMA", "DOT", "APOSTROPHE", "SPACE", "NBSP", "NARROW_NBSP", "NONE"]), amountScale: z.union([z.literal(1), z.literal(100), z.literal(1_000), z.literal(1_000_000), z.literal(1_000_000_000)]), evidenceClaimIds: claimIds, confidence });

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
  mappings: Array<ModelProposal["mappings"][number] & { amountCents: number; sourceKey: string }>;
};
export type FinanceReportImportProposalResultV1 =
  | { version: 1; kind: "SUCCESS"; attempts: 1 | 2; proposal: FinanceReportImportProposalV1 }
  | { version: 1; kind: "FAILURE"; attempts: 0 | 1 | 2; code: "INVALID_INPUT" | "INVALID_MODEL_OUTPUT" | "PROVIDER_ERROR" };
export type FinanceReportImportProposalInputV1 = { workspaceId: string; format: FinanceReportEvidenceFormat; extractedEvidence: string; workspaceCurrencyCodes: string[]; model?: string; workflowJobId?: string; agentRunId?: string; gateway?: ModelGateway };

const ISO_CODES = new Set(FINANCE_REPORT_ISO_4217_CODES);
const SCHEMA_HINT = JSON.stringify(z.toJSONSchema(financeReportModelProposalSchemaV1));
const INSTRUCTION = "Infer semantics from PDF, CSV, or XLSX extracted evidence without a vendor picker. Return an editable proposal only; never invent transactions or facts. Cite every semantic field and amount with exact report sources. Propose numeric format and scale, but do not calculate cents. Set currency only when an exact ISO code appears in the report; otherwise use null. Surface ambiguity as exceptions and never guess or default to USD.";
const duplicate = (values: string[]) => new Set(values).size !== values.length;
const validDate = (value: string) => { const parsed = new Date(`${value}T00:00:00.000Z`); return Number(value.slice(0, 4)) >= 1_000 && !Number.isNaN(parsed.valueOf()) && parsed.toISOString().slice(0, 10) === value; };

function bindProposal(raw: unknown, input: FinanceReportImportProposalInputV1, workspaceCurrencies: string[]): { proposal?: FinanceReportImportProposalV1; feedback?: string } {
  const parsed = financeReportModelProposalSchemaV1.safeParse(raw);
  if (!parsed.success) return { feedback: parsed.error.issues.slice(0, 12).map((issue) => `${issue.path.join(".")}:${issue.code}`).join(",") };
  const proposal = parsed.data;
  const valueFormat = { version: proposal.numericFormat.version, decimalSeparator: proposal.numericFormat.decimalSeparator, groupingSeparator: proposal.numericFormat.groupingSeparator, amountScale: proposal.numericFormat.amountScale };
  const values = validateFinanceReportValueEvidenceV1({ sourceInput: { format: input.format, extractedEvidence: input.extractedEvidence, claims: proposal.evidenceClaims }, numericFormat: valueFormat });
  if (values.kind === "BLOCKER") return { feedback: `evidence:${values.facts[0].code}:${values.facts[0].claimId ?? ""}` };
  const facts = new Map(values.facts.map((fact) => [fact.source.claimId, fact]));
  const textRefs = (ids: string[]) => ids.every((claimId) => facts.get(claimId)?.kind === "TEXT");
  const idsValid = (ids: string[]) => ids.every((claimId) => facts.has(claimId));
  const periods = new Map(proposal.periods.map((period) => [period.id, period]));
  const nodes = new Map(proposal.hierarchy.map((node) => [node.id, node]));
  if (duplicate(proposal.periods.map(({ id }) => id)) || duplicate(proposal.hierarchy.map(({ id }) => id)) || duplicate(proposal.mappings.map(({ id }) => id)) || duplicate(proposal.mappings.map(({ amountClaimId }) => amountClaimId)) || duplicate(proposal.mappings.map(({ periodId, hierarchyId }) => JSON.stringify([periodId, hierarchyId])))) return { feedback: "references:duplicate_semantic_id" };
  if (!textRefs(proposal.classification.reportTypeEvidenceClaimIds) || !textRefs(proposal.classification.basisEvidenceClaimIds) || !textRefs(proposal.classification.cadenceEvidenceClaimIds) || !textRefs(proposal.numericFormat.evidenceClaimIds) || proposal.periods.some((period) => !textRefs(period.evidenceClaimIds) || !validDate(period.periodStart) || !validDate(period.periodEnd) || period.periodStart > period.periodEnd) || proposal.hierarchy.some((node) => !textRefs(node.evidenceClaimIds) || (node.parentId !== null && !nodes.has(node.parentId))) || proposal.exceptions.some((exception) => !idsValid(exception.evidenceClaimIds))) return { feedback: "references:invalid_semantic_evidence" };
  for (const node of proposal.hierarchy) { const seen = new Set<string>(); let current: typeof node | undefined = node; while (current?.parentId) { if (seen.has(current.id)) return { feedback: "references:hierarchy_cycle" }; seen.add(current.id); current = nodes.get(current.parentId); } }
  const mappings: FinanceReportImportProposalV1["mappings"] = [];
  for (const mapping of proposal.mappings) { const fact = facts.get(mapping.amountClaimId); if (fact?.kind !== "AMOUNT" || !periods.has(mapping.periodId) || !nodes.has(mapping.hierarchyId)) return { feedback: "references:invalid_mapping" }; mappings.push({ ...mapping, amountCents: fact.amountCents, sourceKey: fact.source.sourceKey }); }
  const explicit = proposal.currency.explicitCode;
  const currencyFact = proposal.currency.evidenceClaimId ? facts.get(proposal.currency.evidenceClaimId) : undefined;
  if ((explicit === null) !== (proposal.currency.evidenceClaimId === null) || (explicit !== null && (currencyFact?.kind !== "ISO_CODE" || currencyFact.code !== explicit))) return { feedback: "currency:unverified_explicit_code" };
  const code = explicit ?? (workspaceCurrencies.length === 1 ? workspaceCurrencies[0]! : null);
  const exceptions: ProposalException[] = [...proposal.exceptions];
  const addBlocker = (code: string, message: string) => { const blocker = { code, severity: "BLOCKER" as const, message, evidenceClaimIds: [] }; const index = exceptions.findIndex((item) => item.code === code); if (index < 0) exceptions.push(blocker); else exceptions[index] = blocker; };
  if (proposal.classification.reportType === "OTHER") addBlocker("REPORT_TYPE_UNRESOLVED", "Confirm the report type before approval.");
  if (proposal.classification.basis === "UNSPECIFIED") addBlocker("BASIS_UNRESOLVED", "Confirm the accounting basis before approval.");
  if (code === null) addBlocker("CURRENCY_UNRESOLVED", "Choose the report currency before approval.");
  return { proposal: { ...proposal, currency: { state: code ? "RESOLVED" : "UNRESOLVED", code, source: explicit ? "DOCUMENT" : code ? "WORKSPACE_SINGLE_CURRENCY" : null, evidenceClaimId: proposal.currency.evidenceClaimId, confidence: proposal.currency.confidence }, mappings, exceptions } };
}

export async function proposeFinanceReportImportV1(input: FinanceReportImportProposalInputV1): Promise<FinanceReportImportProposalResultV1> {
  const currencies = Array.isArray(input.workspaceCurrencyCodes) ? [...new Set(input.workspaceCurrencyCodes)] : [];
  if (!input.workspaceId?.trim() || !new Set(["PDF", "CSV", "XLSX"]).has(input.format) || !input.extractedEvidence || input.extractedEvidence.length > 2_000_000 || !Array.isArray(input.workspaceCurrencyCodes) || currencies.some((code) => !ISO_CODES.has(code))) return { version: 1, kind: "FAILURE", attempts: 0, code: "INVALID_INPUT" };
  const gateway = input.gateway ?? defaultModelGateway;
  let previous: unknown; let feedback: string | undefined;
  for (const attempts of [1, 2] as const) {
    try {
      const response = await gateway.extract({ workspaceId: input.workspaceId, model: input.model, workflowJobId: input.workflowJobId, agentRunId: input.agentRunId, instruction: attempts === 1 ? INSTRUCTION : `${INSTRUCTION} Repair the previous object using this validation feedback: ${feedback}.`, schemaHint: SCHEMA_HINT, input: JSON.stringify({ format: input.format, extractedEvidence: input.extractedEvidence, ...(attempts === 2 ? { previous } : {}) }) });
      previous = response.output;
    } catch { return { version: 1, kind: "FAILURE", attempts, code: "PROVIDER_ERROR" }; }
    const bound = bindProposal(previous, input, currencies);
    if (bound.proposal) return { version: 1, kind: "SUCCESS", attempts, proposal: bound.proposal };
    feedback = bound.feedback;
  }
  return { version: 1, kind: "FAILURE", attempts: 2, code: "INVALID_MODEL_OUTPUT" };
}
