import { createHash } from "node:crypto";
import { defaultModelGateway, type ModelGateway } from "@corgtex/models";
import { AppError, claimFinanceReportImportProposal, failFinanceReportImportProposal, normalizeFinanceImportCurrency,
  persistFinanceReportImportProposal, resolveFinanceImportCurrency } from "@corgtex/domain";
import { z } from "zod";
import { executeAgentRun } from "./runtime";
import { validateFinanceReportEvidenceSourcesV1, validateFinanceReportEvidenceStructureV1, type FinanceReportEvidenceFormat, type FinanceReportEvidenceSourceFact } from "./finance-report-evidence";
import {
  FINANCE_REPORT_ISO_4217_CODES,
  validateFinanceReportValueEvidenceV1,
} from "./finance-report-value-evidence";

export const FINANCE_REPORT_MODEL_PROPOSAL_VERSION = 1 as const;
const id = z.string().min(1).max(100);
const text = z.string().min(1).max(500);
const confidence = z.number().min(0).max(1);
const claimIds = z.array(id).min(1).max(50);
const optionalClaimIds = z.array(id).max(50);
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
  reportTypeEvidenceClaimIds: optionalClaimIds, basisEvidenceClaimIds: optionalClaimIds, cadenceEvidenceClaimIds: optionalClaimIds, confidence,
});
const numericFormat = z.discriminatedUnion("status", [
  z.strictObject({ status: z.literal("RESOLVED"), version: z.literal(1), decimalSeparator: z.enum(["DOT", "COMMA", "NONE"]), groupingSeparator: z.enum(["COMMA", "DOT", "APOSTROPHE", "SPACE", "NBSP", "NARROW_NBSP", "NONE"]), amountScale: z.union([z.literal(1), z.literal(100), z.literal(1_000), z.literal(1_000_000), z.literal(1_000_000_000)]), decimalSeparatorEvidenceClaimIds: optionalClaimIds, groupingSeparatorEvidenceClaimIds: optionalClaimIds, amountScaleEvidenceClaimIds: claimIds, confidence: confidence.positive() }),
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
const INSTRUCTION = "Infer semantics from PDF, CSV, or XLSX extracted evidence without a vendor picker. Return an editable proposal only; never invent transactions or facts. Cite every semantic field and amount with exact report sources. Do not calculate cents. Resolve scale only with exact field-specific report evidence. Cite field-specific separator evidence when amount lexemes do not uniquely determine their roles. Use UNRESOLVED numeric format and null cadence when evidence is ambiguous; never choose values only to complete the schema. Set currency only when an exact ISO code appears in the report; otherwise use null. Surface ambiguity as exceptions and never guess or default to USD.";
const duplicate = (values: string[]) => new Set(values).size !== values.length;
const validDate = (value: string) => { const parsed = new Date(`${value}T00:00:00.000Z`); return Number(value.slice(0, 4)) >= 1_000 && !Number.isNaN(parsed.valueOf()) && parsed.toISOString().slice(0, 10) === value; };
type BoundFact = { kind: "TEXT" | "AMOUNT" | "ISO_CODE"; source: FinanceReportEvidenceSourceFact; amountCents?: number; code?: string };

function bindProposal(raw: unknown, input: FinanceReportImportProposalInputV1, workspaceCurrency: string | null): { proposal?: FinanceReportImportProposalV1; feedback?: string } {
  const parsed = financeReportModelProposalSchemaV1.safeParse(raw);
  if (!parsed.success) return { feedback: parsed.error.issues.slice(0, 12).map((issue) => `${issue.path.join(".")}:${issue.code}`).join(",") };
  const proposal = parsed.data;
  const sourceInput = { format: input.format, extractedEvidence: input.extractedEvidence, claims: proposal.evidenceClaims };
  let facts: Map<string, BoundFact>;
  let numericAmbiguous = false;
  if (proposal.numericFormat.status === "RESOLVED") {
    const { version, decimalSeparator, groupingSeparator, amountScale, decimalSeparatorEvidenceClaimIds, groupingSeparatorEvidenceClaimIds } = proposal.numericFormat;
    const values = validateFinanceReportValueEvidenceV1({ sourceInput, numericFormat: { version, decimalSeparator, groupingSeparator, amountScale } });
    if (values.kind === "BLOCKER") return { feedback: `evidence:${values.facts[0].code}:${values.facts[0].claimId ?? ""}` };
    facts = new Map(values.facts.map((fact) => [fact.source.claimId, fact]));
    const selectedAmounts = values.facts.flatMap((fact) => fact.kind === "AMOUNT" ? [fact.amountCents] : []);
    const alternatives = [...(decimalSeparator === "DOT" ? [{ decimalSeparator: "NONE", groupingSeparator: "DOT" } as const] : decimalSeparator === "COMMA" ? [{ decimalSeparator: "NONE", groupingSeparator: "COMMA" } as const] : []), ...(groupingSeparator === "DOT" ? [{ decimalSeparator: "DOT", groupingSeparator: "NONE" } as const] : groupingSeparator === "COMMA" ? [{ decimalSeparator: "COMMA", groupingSeparator: "NONE" } as const] : []), ...(decimalSeparator === "DOT" && groupingSeparator === "COMMA" ? [{ decimalSeparator: "COMMA", groupingSeparator: "DOT" } as const] : decimalSeparator === "COMMA" && groupingSeparator === "DOT" ? [{ decimalSeparator: "DOT", groupingSeparator: "COMMA" } as const] : [])];
    numericAmbiguous = alternatives.some((alternative) => {
      const alternate = validateFinanceReportValueEvidenceV1({ sourceInput, numericFormat: { version, ...alternative, amountScale } });
      if (alternate.kind === "BLOCKER") return false;
      const alternateAmounts = alternate.facts.flatMap((fact) => fact.kind === "AMOUNT" ? [fact.amountCents] : []);
      const differs = alternateAmounts.some((amount, index) => amount !== selectedAmounts[index]);
      const evidenced = (alternative.decimalSeparator !== decimalSeparator && decimalSeparatorEvidenceClaimIds.length > 0) || (alternative.groupingSeparator !== groupingSeparator && groupingSeparatorEvidenceClaimIds.length > 0);
      return differs && !evidenced;
    });
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
  const numericEvidenceIds = proposal.numericFormat.status === "RESOLVED" ? [...proposal.numericFormat.decimalSeparatorEvidenceClaimIds, ...proposal.numericFormat.groupingSeparatorEvidenceClaimIds, ...proposal.numericFormat.amountScaleEvidenceClaimIds] : proposal.numericFormat.evidenceClaimIds;
  if ((proposal.classification.reportType !== "OTHER" && proposal.classification.reportTypeEvidenceClaimIds.length === 0) || (proposal.classification.basis !== "UNSPECIFIED" && proposal.classification.basisEvidenceClaimIds.length === 0) || !textRefs(proposal.classification.reportTypeEvidenceClaimIds) || !textRefs(proposal.classification.basisEvidenceClaimIds) || (proposal.classification.cadence !== null && proposal.classification.cadenceEvidenceClaimIds.length === 0) || !textRefs(proposal.classification.cadenceEvidenceClaimIds) || !textRefs(numericEvidenceIds) || proposal.periods.some((period) => !textRefs(period.evidenceClaimIds) || !validDate(period.periodStart) || !validDate(period.periodEnd) || period.periodStart > period.periodEnd) || proposal.hierarchy.some((node) => !textRefs(node.evidenceClaimIds) || (node.parentId !== null && !nodes.has(node.parentId))) || proposal.exceptions.some((exception) => !idsValid(exception.evidenceClaimIds))) return { feedback: "references:invalid_semantic_evidence" };
  const paths = new Map<string, string>();
  for (const node of proposal.hierarchy) { const seen = new Set<string>(), labels: string[] = []; let current: typeof node | undefined = node; while (current) { if (seen.has(current.id)) return { feedback: "references:hierarchy_cycle" }; seen.add(current.id); labels.unshift(current.label); current = current.parentId ? nodes.get(current.parentId) : undefined; } paths.set(node.id, JSON.stringify(labels)); }
  const mappings: FinanceReportImportProposalV1["mappings"] = [];
  const targets = new Set<string>();
  for (const mapping of proposal.mappings) { const fact = facts.get(mapping.amountClaimId), period = periods.get(mapping.periodId), path = paths.get(mapping.hierarchyId); if (fact?.kind !== "AMOUNT" || !period || !path) return { feedback: "references:invalid_mapping" }; const target = JSON.stringify([period.periodStart, period.periodEnd, path]); if (targets.has(target)) return { feedback: "references:duplicate_mapping_target" }; targets.add(target); mappings.push({ ...mapping, amountCents: numericAmbiguous ? null : fact.amountCents ?? null, sourceKey: fact.source.sourceKey }); }
  const explicit = proposal.currency.explicitCode;
  const currencyFact = proposal.currency.evidenceClaimId ? facts.get(proposal.currency.evidenceClaimId) : undefined;
  if ((explicit === null) !== (proposal.currency.evidenceClaimId === null) || (explicit !== null && (currencyFact?.kind !== "ISO_CODE" || currencyFact.code !== explicit))) return { feedback: "currency:unverified_explicit_code" };
  const code = explicit ?? workspaceCurrency;
  const exceptions: ProposalException[] = [...proposal.exceptions];
  const addBlocker = (code: string, message: string) => { const blocker = { code, severity: "BLOCKER" as const, message, evidenceClaimIds: [] }; const index = exceptions.findIndex((item) => item.code === code); if (index < 0) exceptions.push(blocker); else exceptions[index] = blocker; };
  if (proposal.classification.reportType === "OTHER") addBlocker("REPORT_TYPE_UNRESOLVED", "Confirm the report type before approval.");
  if (proposal.classification.basis === "UNSPECIFIED") addBlocker("BASIS_UNRESOLVED", "Confirm the accounting basis before approval.");
  if (proposal.classification.cadence === null) addBlocker("CADENCE_UNRESOLVED", "Confirm the reporting cadence before approval.");
  const boundNumericFormat = numericAmbiguous ? { status: "UNRESOLVED" as const, version: 1 as const, decimalSeparator: null, groupingSeparator: null, amountScale: null, evidenceClaimIds: [...new Set(numericEvidenceIds)], confidence: proposal.numericFormat.confidence } : proposal.numericFormat;
  if (boundNumericFormat.status === "UNRESOLVED") addBlocker("NUMERIC_FORMAT_UNRESOLVED", "Confirm the numeric format and scale before calculating amounts.");
  if (proposal.classification.confidence === 0 || proposal.periods.some(({ confidence }) => confidence === 0) || proposal.hierarchy.some(({ confidence }) => confidence === 0) || proposal.mappings.some(({ confidence }) => confidence === 0)) addBlocker("SEMANTIC_PROPOSAL_UNCERTAIN", "Review zero-confidence report semantics before approval.");
  if (code === null) addBlocker("CURRENCY_UNRESOLVED", "Choose the report currency before approval.");
  return { proposal: { ...proposal, numericFormat: boundNumericFormat, currency: { state: code ? "RESOLVED" : "UNRESOLVED", code, source: explicit ? "DOCUMENT" : code ? "WORKSPACE_SINGLE_CURRENCY" : null, evidenceClaimId: proposal.currency.evidenceClaimId, confidence: proposal.currency.confidence }, mappings, exceptions } };
}

export async function proposeFinanceReportImportV1(input: FinanceReportImportProposalInputV1): Promise<FinanceReportImportProposalResultV1> {
  if (!input.workspaceId?.trim() || !new Set(["PDF", "CSV", "XLSX"]).has(input.format) || !input.extractedEvidence || input.extractedEvidence.length > 2_000_000 || !Array.isArray(input.workspaceCurrencyCodes) || input.workspaceCurrencyCodes.some((code) => typeof code !== "string")) return { version: 1, kind: "FAILURE", attempts: 0, code: "INVALID_INPUT" };
  if (validateFinanceReportEvidenceStructureV1({ format: input.format, extractedEvidence: input.extractedEvidence }).kind === "BLOCKER") return { version: 1, kind: "FAILURE", attempts: 0, code: "INVALID_INPUT" };
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

const RESERVED_INTERPRETATION_BLOCKERS = new Set(["REPORT_TYPE_UNRESOLVED", "BASIS_UNRESOLVED", "CADENCE_UNRESOLVED", "NUMERIC_FORMAT_UNRESOLVED", "SEMANTIC_PROPOSAL_UNCERTAIN"]);
function durableInterpretation(proposal: FinanceReportImportProposalV1) {
  const baseIds = new Set([...proposal.classification.reportTypeEvidenceClaimIds, ...proposal.classification.basisEvidenceClaimIds,
    ...proposal.classification.cadenceEvidenceClaimIds, ...(proposal.numericFormat.status === "RESOLVED"
      ? [...proposal.numericFormat.decimalSeparatorEvidenceClaimIds, ...proposal.numericFormat.groupingSeparatorEvidenceClaimIds, ...proposal.numericFormat.amountScaleEvidenceClaimIds]
      : proposal.numericFormat.evidenceClaimIds)]);
  const required = new Set([...(proposal.classification.reportType === "OTHER" ? ["REPORT_TYPE_UNRESOLVED"] : []),
    ...(proposal.classification.basis === "UNSPECIFIED" ? ["BASIS_UNRESOLVED"] : []), ...(proposal.classification.cadence === null ? ["CADENCE_UNRESOLVED"] : []),
    ...(proposal.numericFormat.status === "UNRESOLVED" ? ["NUMERIC_FORMAT_UNRESOLVED"] : []), ...(proposal.classification.confidence === 0 ? ["SEMANTIC_PROPOSAL_UNCERTAIN"] : [])]);
  const codes = new Set<string>();
  const exceptions = proposal.exceptions.filter((exception) => exception.code !== "CURRENCY_UNRESOLVED"
    && (!RESERVED_INTERPRETATION_BLOCKERS.has(exception.code) || required.has(exception.code))
    && !codes.has(exception.code) && Boolean(codes.add(exception.code)));
  for (const exception of exceptions) for (const id of exception.evidenceClaimIds) baseIds.add(id);
  return { version: 1 as const, classification: proposal.classification, numericFormat: proposal.numericFormat,
    evidenceClaims: proposal.evidenceClaims.filter(({ id }) => baseIds.has(id)), exceptions };
}
function candidateDrafts(proposal: FinanceReportImportProposalV1) {
  const claims = new Map(proposal.evidenceClaims.map((claim) => [claim.id, claim]));
  const periods = new Map(proposal.periods.map((period) => [period.id, period]));
  const nodes = new Map(proposal.hierarchy.map((node) => [node.id, node]));
  const path = (id: string) => { const labels: string[] = []; let node = nodes.get(id); while (node) { labels.unshift(node.label); node = node.parentId ? nodes.get(node.parentId) : undefined; } return labels; };
  return proposal.mappings.map((mapping) => {
    const claim = claims.get(mapping.amountClaimId)!, period = periods.get(mapping.periodId)!, accountPath = path(mapping.hierarchyId);
    const source = claim.source, location = source.kind === "PDF" ? `PDF page ${source.page}, line ${source.lineIndex + 1}` : `${source.sheet} R${source.row}C${source.column}`;
    return { sourceKey: createHash("sha256").update(mapping.sourceKey).digest("hex"), sourceLocation: source, sourceLabel: accountPath.at(-1)!,
      sourcePath: accountPath, proposedAccountPath: accountPath, factKind: mapping.factKind, periodStart: period.periodStart, periodEnd: period.periodEnd,
      amountCents: mapping.amountCents!, extractionJson: { claimId: claim.id, sourceKey: mapping.sourceKey, source },
      proposalJson: { version: 1, mappingId: mapping.id, periodId: mapping.periodId, hierarchyId: mapping.hierarchyId, confidence: mapping.confidence },
      confidenceBps: Math.round(mapping.confidence * 10_000), evidenceMd: location };
  });
}

export async function runFinanceReportImportAgentV1(params: { workspaceId: string; batchId: string; expectedVersion: number;
  workflowJobId: string; attempts: number; isFinalAttempt: boolean }) {
  let claim: Awaited<ReturnType<typeof claimFinanceReportImportProposal>> | undefined;
  let runId: string | undefined;
  let providerFailure = false;
  try {
    const run = await executeAgentRun({ agentKey: "finance-report-import", workspaceId: params.workspaceId, triggerType: "EVENT",
      triggerRef: `${params.workflowJobId}:attempt:${params.attempts}`, goal: "Interpret exact Finance report evidence into blocked editable candidates for deterministic reconciliation.",
      payload: { batchId: params.batchId, workflowJobId: params.workflowJobId }, plan: ["claim-import", "propose-semantics", "persist-blocked-candidates"],
      buildContext: async (_helpers, currentRunId) => { runId = currentRunId; claim = await claimFinanceReportImportProposal({ ...params, agentRunId: currentRunId });
        return { batchId: params.batchId, skipped: claim.skipped, version: claim.version, ...(!claim.skipped ? { format: claim.format } : {}) }; },
      execute: async (_context, _helpers, currentRunId, model) => {
        if (!claim || claim.skipped) return { resultJson: { batchId: params.batchId, skipped: true } };
        const result = await proposeFinanceReportImportV1({ workspaceId: params.workspaceId, format: claim.format,
          extractedEvidence: claim.extractedEvidence, workspaceCurrencyCodes: claim.workspaceCurrencyCodes, model,
          workflowJobId: params.workflowJobId, agentRunId: currentRunId });
        if (result.kind === "FAILURE") {
          if (result.code === "PROVIDER_ERROR") { providerFailure = true; throw new Error("Finance report interpretation provider failed."); }
          const failed = await failFinanceReportImportProposal({ ...params, agentRunId: currentRunId, expectedVersion: claim.version, failureCode: result.code });
          return { resultJson: { batchId: params.batchId, kind: "FAILURE", failureCode: failed.failureCode, attempts: result.attempts } };
        }
        const blockers = result.proposal.exceptions.filter(({ severity }) => severity === "BLOCKER");
        const nullAmounts = result.proposal.mappings.some(({ amountCents }) => amountCents === null);
        const needsInput = blockers.length > 0 || nullAmounts;
        const currencyOnly = !nullAmounts && blockers.length === 1 && blockers[0]?.code === "CURRENCY_UNRESOLVED";
        const periods = result.proposal.periods.map(({ periodStart, periodEnd }) => [periodStart, periodEnd]).flat().sort();
        const stored = await persistFinanceReportImportProposal({ ...params, agentRunId: currentRunId, expectedVersion: claim.version,
          interpretation: durableInterpretation(result.proposal), currency: result.proposal.currency, periodStart: periods[0]!, periodEnd: periods.at(-1)!,
          candidates: !needsInput || currencyOnly ? candidateDrafts(result.proposal) : [], warningCount: result.proposal.exceptions.filter(({ severity }) => severity === "WARNING").length,
          blockerCount: needsInput ? Math.max(1, blockers.length) : 0, ...(blockers[0] ? { blocker: { code: blockers[0].code, message: blockers[0].message } } : {}) });
        return { resultJson: { batchId: params.batchId, kind: "SUCCESS", attempts: result.attempts, stage: stored.stage, candidateCount: stored.candidateCount } };
      } });
    if ("skipped" in run && run.skipped) {
      if (!params.isFinalAttempt) throw new Error("Finance report agent runtime policy deferred the run.");
      return failFinanceReportImportProposal({ ...params, expectedVersion: params.expectedVersion, failureCode: "AGENT_UNAVAILABLE" });
    }
    return run;
  } catch (error) {
    if (providerFailure && params.isFinalAttempt && claim && !claim.skipped && runId) await failFinanceReportImportProposal({ ...params, agentRunId: runId,
      expectedVersion: claim.version, failureCode: "PROVIDER_ERROR" });
    if (error instanceof AppError && ["INVALID_INPUT", "INVALID_FINANCE_IMPORT_INTERPRETATION", "INVALID_FINANCE_IMPORT_PROPOSAL"].includes(error.code)
      && claim && !claim.skipped && runId) return failFinanceReportImportProposal({ ...params, agentRunId: runId, expectedVersion: claim.version, failureCode: "INVALID_MODEL_OUTPUT" });
    throw error;
  }
}
