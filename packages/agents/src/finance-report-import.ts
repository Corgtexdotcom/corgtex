import { AGENT_REGISTRY } from "@corgtex/domain";
import { defaultModelGateway, resolveModel, type ExtractionRequest, type ModelGateway } from "@corgtex/models";
import { z } from "zod";
export const FINANCE_REPORT_IMPORT_CONTRACT_VERSION = 1 as const;
export const FINANCE_REPORT_IMPORT_LOW_CONFIDENCE = 0.85;
const POSTGRES_INT_MIN = -2_147_483_648, POSTGRES_INT_MAX = 2_147_483_647;
const bounded = (maximum: number) => z.string().trim().min(1).max(maximum);
const isoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/).refine((value) => {
  const parsed = new Date(`${value}T00:00:00.000Z`);
  return Number(value.slice(0, 4)) >= 1_000 && !Number.isNaN(parsed.valueOf()) && parsed.toISOString().slice(0, 10) === value;
}, "Expected a valid ISO calendar date.");
const sourceLocationSchema = z.object({
  page: z.number().int().positive().max(100_000).nullable(),
  sheet: bounded(200).nullable(),
  row: z.number().int().positive().max(1_000_000).nullable(),
  column: z.number().int().positive().max(100_000).nullable(),
  evidence: bounded(1_000),
}).strict().superRefine((value, context) => {
  if (value.page === null && (value.sheet === null || value.row === null)) context.addIssue({ code: "custom",
    message: "Source evidence requires a page or sheet and row." });
  if (value.column !== null && value.row === null) context.addIssue({ code: "custom", path: ["column"],
    message: "A source column requires a row." });
});
const currencySchema = z.object({
  state: z.enum(["EXPLICIT", "UNRESOLVED"]),
  code: z.string().regex(/^[A-Z]{3}$/).nullable(),
  evidence: z.array(sourceLocationSchema).max(5),
}).strict().superRefine((value, context) => {
  const explicit = value.state === "EXPLICIT";
  if ((explicit && (!value.code || value.evidence.length === 0))
    || (!explicit && (value.code !== null || value.evidence.length > 0))) context.addIssue({ code: "custom",
    message: "Currency state, code, and evidence do not agree." });
});
const hierarchy = z.array(bounded(160)).min(1).max(12);
const proposedHierarchy = z.array(bounded(160)).max(12);
const exceptionCode = z.enum(["LOW_CONFIDENCE", "AMBIGUOUS_MAPPING", "UNMAPPED_ACCOUNT", "OTHER"]);
const candidateSchema = z.object({
  sourceLocation: sourceLocationSchema,
  sourceLabel: bounded(500),
  sourceAccountPath: hierarchy,
  proposedAccountPath: proposedHierarchy,
  rowKind: z.enum(["LEAF", "DERIVED"]),
  periodStart: isoDate,
  periodEnd: isoDate,
  amountCents: z.number().int().min(POSTGRES_INT_MIN).max(POSTGRES_INT_MAX),
  mappingStatus: z.enum(["MAPPED", "AMBIGUOUS", "UNMAPPED"]),
  confidence: z.number().min(0).max(1),
  reviewStatus: z.enum(["VERIFIED", "WARNING", "BLOCKER"]),
  exceptionCodes: z.array(exceptionCode).max(8),
  reviewReasons: z.array(bounded(500)).max(8),
}).strict().superRefine((value, context) => {
  if (value.periodStart > value.periodEnd) context.addIssue({ code: "custom", path: ["periodEnd"], message: "Candidate period is reversed." });
  if (value.mappingStatus === "MAPPED" && value.proposedAccountPath.length === 0) context.addIssue({ code: "custom", path: ["proposedAccountPath"], message: "Mapped rows require a hierarchy." });
  if (value.mappingStatus === "UNMAPPED" && value.proposedAccountPath.length > 0) context.addIssue({ code: "custom", path: ["proposedAccountPath"], message: "Unmapped rows cannot claim a hierarchy." });
  if (value.reviewStatus !== "VERIFIED" && value.reviewReasons.length === 0) context.addIssue({ code: "custom", path: ["reviewReasons"], message: "Review exceptions require a reason." });
  if (value.exceptionCodes.length > 0 && value.reviewReasons.length === 0) context.addIssue({ code: "custom", path: ["reviewReasons"], message: "Every exception requires a visible reason." });
});
export const financeReportImportProposalV1Schema = z.object({
  contractVersion: z.literal(FINANCE_REPORT_IMPORT_CONTRACT_VERSION),
  report: z.object({
    title: bounded(200),
    reportType: z.enum(["PROFIT_AND_LOSS", "BALANCE_SHEET", "CASH_FLOW", "TRIAL_BALANCE", "OTHER"]),
    basis: z.enum(["CASH", "ACCRUAL", "UNSPECIFIED"]),
    cadence: z.enum(["DAILY", "WEEKLY", "MONTHLY", "QUARTERLY", "ANNUAL", "CUSTOM"]),
    periodStart: isoDate,
    periodEnd: isoDate,
    asOfDate: isoDate.nullable(),
    currency: currencySchema,
  }).strict().superRefine((value, context) => {
    if (value.periodStart > value.periodEnd) context.addIssue({ code: "custom", path: ["periodEnd"], message: "Report period is reversed." });
    if (value.asOfDate && (value.asOfDate < value.periodStart || value.asOfDate > value.periodEnd)) context.addIssue({ code: "custom", path: ["asOfDate"], message: "As-of date is outside the report period." });
  }),
  summary: bounded(2_000),
  candidates: z.array(candidateSchema).min(1).max(1_000),
}).strict().superRefine((value, context) => {
  const sourceKeys = new Set<string>();
  value.candidates.forEach((candidate, index) => {
    const location = candidate.sourceLocation;
    const sourceKey = JSON.stringify(location.page === null ? [location.sheet, location.row, location.column] : [location.page, location.evidence]);
    if (sourceKeys.has(sourceKey)) context.addIssue({ code: "custom", path: ["candidates", index, "sourceLocation"], message: "Candidate source location is duplicated." });
    sourceKeys.add(sourceKey);
    if (candidate.periodStart < value.report.periodStart) context.addIssue({ code: "custom", path: ["candidates", index, "periodStart"], message: "Candidate period starts before the report period." });
    if (candidate.periodEnd > value.report.periodEnd) context.addIssue({ code: "custom", path: ["candidates", index, "periodEnd"], message: "Candidate period ends after the report period." });
  });
});
const profileHintSchema = z.object({
  profileId: bounded(100), version: z.number().int().positive(), layoutFingerprint: bounded(256),
  approvedMappings: z.array(z.object({ sourceLabel: bounded(500), accountPath: hierarchy }).strict()).max(500),
}).strict();
const inputSchema = z.object({
  fileName: bounded(255), mimeType: bounded(200), extractedEvidence: z.string().min(1).max(2_000_000),
  approvedProfileHints: z.array(profileHintSchema).max(20),
}).strict();
export type FinanceReportImportProposalV1 = z.infer<typeof financeReportImportProposalV1Schema>;
export type FinanceReportImportProfileHint = z.infer<typeof profileHintSchema>;
type ExtractionGateway = Pick<ModelGateway, "extract">;
export class FinanceReportImportAgentError extends Error {
  readonly code = "FINANCE_REPORT_IMPORT_AGENT_INVALID_OUTPUT";
  constructor() { super("The financial report could not be interpreted safely. Please retry.");
    this.name = "FinanceReportImportAgentError"; }
}
const instruction = (retryPaths: string[]) => `Interpret deterministic PDF/CSV/XLSX evidence as an editable
Finance Reported Actuals proposal. Infer type, basis, cadence, dates, hierarchy, leaf/derived rows, integer cents,
and source-located currency evidence without a vendor picker. Return proposals only; never create transactions,
apply Finance records, or claim human approval. Profile hints are non-authoritative and every mapping must be
revalidated. If currency is not explicit, return UNRESOLVED/null and never default to USD. Uncertain mappings must
be AMBIGUOUS or UNMAPPED with visible exceptions. Only a source ISO code token proves explicit currency; otherwise
return UNRESOLVED. Return strict contract v1 with no unknown fields.${retryPaths.length
  ? ` The previous response failed validation at ${retryPaths.join(", ")}; rebuild it.` : ""}`;
const locationHint = "{page:positive-int|null,sheet:string|null,row:positive-int|null,column:positive-int|null,evidence:page-excerpt-or-exact-cell-text}";
const schemaHint = `Strict contract v1 JSON; no additional fields. {contractVersion:1,report:{title:string,
reportType:PROFIT_AND_LOSS|BALANCE_SHEET|CASH_FLOW|TRIAL_BALANCE|OTHER,basis:CASH|ACCRUAL|UNSPECIFIED,
cadence:DAILY|WEEKLY|MONTHLY|QUARTERLY|ANNUAL|CUSTOM,periodStart:YYYY-MM-DD,periodEnd:YYYY-MM-DD,
asOfDate:YYYY-MM-DD|null,currency:{state:EXPLICIT|UNRESOLVED,code:uppercase-3-letter|null,evidence:${locationHint}[]}},
summary:string,candidates:[{sourceLocation:${locationHint},sourceLabel:string,sourceAccountPath:string[],
proposedAccountPath:string[],rowKind:LEAF|DERIVED,periodStart:YYYY-MM-DD,periodEnd:YYYY-MM-DD,
amountCents:integer[-2147483648..2147483647],mappingStatus:MAPPED|AMBIGUOUS|UNMAPPED,confidence:number[0..1],
reviewStatus:VERIFIED|WARNING|BLOCKER,exceptionCodes:(LOW_CONFIDENCE|AMBIGUOUS_MAPPING|UNMAPPED_ACCOUNT|OTHER)[],reviewReasons:string[]}]}`;
const issuePaths = (error: z.ZodError) => [...new Set(error.issues.map((issue) => issue.path.join(".") || "root"))].slice(0, 12);
type SourceLocation = z.infer<typeof sourceLocationSchema>;
function evidenceIndex(extractedEvidence: string) {
  const index = new Map<string, string[]>();
  const add = (key: string, values: string[]) => { const existing = index.get(key); if (existing) existing.push(...values); else index.set(key, [...values]); };
  for (const line of extractedEvidence.split("\n")) {
    try {
      const parsed: unknown = JSON.parse(line);
      if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) continue;
      const record = parsed as Record<string, unknown>;
      const values = [record.text, record.value, record.displayValue, record.formula].filter((value): value is string => typeof value === "string");
      if (typeof record.page === "number") add(`p:${record.page}`, values);
      if (typeof record.sheet === "string" && typeof record.row === "number") {
        add(`r:${JSON.stringify([record.sheet, record.row])}`, values);
        if (typeof record.column === "number") add(`c:${JSON.stringify([record.sheet, record.row, record.column])}`, values);
      }
    } catch { continue; }
  }
  return index;
}
function locationMatches(index: Map<string, string[]>, location: SourceLocation) {
  const key = location.page !== null ? `p:${location.page}` : location.column === null ? `r:${JSON.stringify([location.sheet, location.row])}` : `c:${JSON.stringify([location.sheet, location.row, location.column])}`;
  return (index.get(key) ?? []).some((value) => location.page !== null ? value.includes(location.evidence) : value === location.evidence);
}
function unmatchedEvidencePaths(proposal: FinanceReportImportProposalV1, extractedEvidence: string) {
  const index = evidenceIndex(extractedEvidence);
  const paths = proposal.candidates.flatMap((candidate, candidateIndex) =>
    locationMatches(index, candidate.sourceLocation) ? [] : [`candidates.${candidateIndex}.sourceLocation`]);
  const code = proposal.report.currency.code;
  const currency = proposal.report.currency.evidence.flatMap((location, locationIndex) =>
    locationMatches(index, location) && (!code || new RegExp(`(^|[^A-Z])${code}([^A-Z]|$)`, "i").test(location.evidence))
      ? [] : [`report.currency.evidence.${locationIndex}`]);
  return [...paths, ...currency].slice(0, 12);
}
function forceVisibleExceptions(proposal: FinanceReportImportProposalV1) {
  return { ...proposal, candidates: proposal.candidates.map((candidate) => {
    const codes = new Set(candidate.exceptionCodes);
    const reasons = [...candidate.reviewReasons];
    if (candidate.confidence < FINANCE_REPORT_IMPORT_LOW_CONFIDENCE) {
      codes.add("LOW_CONFIDENCE"); reasons.push("Mapping confidence is below the verified threshold.");
    }
    if (candidate.mappingStatus === "AMBIGUOUS") {
      codes.add("AMBIGUOUS_MAPPING"); reasons.push("More than one account mapping is plausible.");
    }
    if (candidate.mappingStatus === "UNMAPPED") {
      codes.add("UNMAPPED_ACCOUNT"); reasons.push("No account mapping is proposed.");
    }
    const needsReview = codes.size > 0 || reasons.length > 0;
    return { ...candidate, reviewStatus: candidate.reviewStatus === "VERIFIED" && needsReview ? "WARNING" as const
      : candidate.reviewStatus, exceptionCodes: [...codes], reviewReasons: [...new Set(reasons)].slice(0, 8) };
  }) };
}
export async function interpretFinanceReport(params: {
  workspaceId: string; workflowJobId?: string; agentRunId?: string; model?: string;
  fileName: string; mimeType: string; extractedEvidence: string;
  approvedProfileHints?: FinanceReportImportProfileHint[]; gateway?: ExtractionGateway;
}): Promise<FinanceReportImportProposalV1> {
  const input = inputSchema.parse({ fileName: params.fileName, mimeType: params.mimeType,
    extractedEvidence: params.extractedEvidence, approvedProfileHints: params.approvedProfileHints ?? [] });
  const model = params.model ?? resolveModel(AGENT_REGISTRY["finance-report-import"].defaultModelTier);
  const gateway = params.gateway ?? defaultModelGateway;
  let paths: string[] = [];
  for (let attempt = 0; attempt < 2; attempt += 1) {
    const request: ExtractionRequest = { workspaceId: params.workspaceId, workflowJobId: params.workflowJobId,
      agentRunId: params.agentRunId, model, instruction: instruction(paths), schemaHint, input: JSON.stringify(input) };
    try {
      const parsed = financeReportImportProposalV1Schema.safeParse((await gateway.extract(request)).output);
      if (parsed.success) {
        paths = unmatchedEvidencePaths(parsed.data, input.extractedEvidence);
        if (paths.length === 0) return forceVisibleExceptions(parsed.data);
      } else {
        paths = issuePaths(parsed.error);
      }
    } catch (error) {
      if (!(error instanceof Error) || error.name !== "ExtractionParseError") throw error;
      paths = ["root"];
    }
  }
  throw new FinanceReportImportAgentError();
}
