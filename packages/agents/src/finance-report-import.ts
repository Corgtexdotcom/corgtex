import { AGENT_REGISTRY } from "@corgtex/domain";
import type { FinanceFileFormat } from "@corgtex/knowledge";
import { defaultModelGateway, resolveModel, type ExtractionRequest, type ModelGateway } from "@corgtex/models";
import { z } from "zod";

export const FINANCE_REPORT_IMPORT_CONTRACT_VERSION = 1 as const;
const INT_MIN = -2_147_483_648;
const INT_MAX = 2_147_483_647;
const ISO_CODES = new Set(Intl.supportedValuesOf("currency"));
const exact = (max: number) => z.string().min(1).max(max)
  .refine((value) => value.trim().length > 0, "Expected non-blank text.");
const isoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/).refine((value) => {
  const date = new Date(`${value}T00:00:00.000Z`);
  return Number(value.slice(0, 4)) >= 1_000 && !Number.isNaN(date.valueOf())
    && date.toISOString().slice(0, 10) === value;
}, "Expected a supported ISO calendar date.");
const pdfSource = z.object({ kind: z.literal("PDF"), page: z.number().int().positive().max(250),
  evidence: exact(50_000) }).strict();
const cellSource = z.object({ kind: z.literal("CELL"), sheet: exact(200),
  row: z.number().int().positive().max(20_000), column: z.number().int().positive().max(250_000),
  evidence: exact(50_000) }).strict();
const sourceSchema = z.discriminatedUnion("kind", [pdfSource, cellSource]);
const hierarchy = z.array(exact(160)).min(1).max(12);
const candidateSchema = z.object({
  target: z.literal("REPORTED_ACTUAL"), editable: z.literal(true), source: sourceSchema,
  sourceLabel: exact(500), sourceAccountPath: hierarchy, proposedAccountPath: z.array(exact(160)).max(12),
  rowKind: z.enum(["LEAF", "DERIVED"]), periodStart: isoDate, periodEnd: isoDate,
  amountCents: z.number().int().min(INT_MIN).max(INT_MAX),
  mappingStatus: z.enum(["MAPPED", "AMBIGUOUS", "UNMAPPED"]), confidence: z.number().min(0).max(1),
  reviewStatus: z.enum(["VERIFIED", "WARNING"]),
  exceptionCodes: z.array(z.enum(["LOW_CONFIDENCE", "AMBIGUOUS_MAPPING", "UNMAPPED_ACCOUNT",
    "DERIVED_ROW", "OTHER"])).max(8), reviewReasons: z.array(exact(500)).max(8),
}).strict().superRefine((value, context) => {
  if (value.periodStart > value.periodEnd) context.addIssue({ code: "custom", path: ["periodEnd"], message: "Reversed period." });
  if ((value.mappingStatus === "MAPPED" && value.proposedAccountPath.length === 0)
    || (value.mappingStatus === "UNMAPPED" && value.proposedAccountPath.length > 0)) {
    context.addIssue({ code: "custom", path: ["proposedAccountPath"], message: "Mapping and hierarchy disagree." });
  }
  if ((value.reviewStatus === "WARNING" || value.exceptionCodes.length > 0) && value.reviewReasons.length === 0) {
    context.addIssue({ code: "custom", path: ["reviewReasons"], message: "Exceptions require visible detail." });
  }
});
const currencySchema = z.discriminatedUnion("state", [
  z.object({ state: z.literal("EXPLICIT"), code: z.string().regex(/^[A-Z]{3}$/), source: sourceSchema }).strict(),
  z.object({ state: z.literal("UNRESOLVED"), code: z.null(), source: z.null() }).strict(),
]);
export const financeReportImportProposalV1Schema = z.object({
  contractVersion: z.literal(FINANCE_REPORT_IMPORT_CONTRACT_VERSION),
  report: z.object({ title: exact(200),
    reportType: z.enum(["PROFIT_AND_LOSS", "BALANCE_SHEET", "CASH_FLOW", "TRIAL_BALANCE", "OTHER"]),
    basis: z.enum(["CASH", "ACCRUAL", "UNSPECIFIED"]),
    cadence: z.enum(["DAILY", "WEEKLY", "MONTHLY", "QUARTERLY", "ANNUAL", "CUSTOM"]),
    periodStart: isoDate, periodEnd: isoDate, asOfDate: isoDate.nullable(), currency: currencySchema,
  }).strict().superRefine((value, context) => {
    if (value.periodStart > value.periodEnd) context.addIssue({ code: "custom", path: ["periodEnd"], message: "Reversed period." });
    if (value.asOfDate && (value.asOfDate < value.periodStart || value.asOfDate > value.periodEnd)) {
      context.addIssue({ code: "custom", path: ["asOfDate"], message: "As-of date outside report period." });
    }
  }),
  summary: exact(2_000), candidates: z.array(candidateSchema).min(1).max(1_000),
}).strict().superRefine((value, context) => value.candidates.forEach((candidate, index) => {
  if (candidate.periodStart < value.report.periodStart) context.addIssue({ code: "custom",
    path: ["candidates", index, "periodStart"], message: "Candidate starts outside report period." });
  if (candidate.periodEnd > value.report.periodEnd) context.addIssue({ code: "custom",
    path: ["candidates", index, "periodEnd"], message: "Candidate ends outside report period." });
}));
const profileSchema = z.object({ profileId: exact(100), version: z.number().int().positive(),
  layoutFingerprint: exact(256), approvedMappings: z.array(z.object({ sourceLabel: exact(500),
    accountPath: hierarchy }).strict()).max(500) }).strict();
const inputSchema = z.object({ format: z.enum(["PDF", "CSV", "XLSX"]),
  extractedEvidence: z.string().min(1).max(2_000_000), approvedProfileHints: z.array(profileSchema).max(20),
}).strict().superRefine((value, context) => {
  const count = value.approvedProfileHints.reduce((sum, hint) => sum + hint.approvedMappings.length, 0);
  if (count > 2_000 || JSON.stringify(value.approvedProfileHints).length > 200_000) context.addIssue({
    code: "custom", path: ["approvedProfileHints"], message: "Profile hint budget exceeded." });
});
export type FinanceReportImportProposalV1 = z.infer<typeof financeReportImportProposalV1Schema>;
export type FinanceReportImportProfileHint = z.infer<typeof profileSchema>;
type Source = z.infer<typeof sourceSchema>;
type SourceIndex = { pages: Map<number, string>; cells: Map<string, Set<string>> };
type Claim = { key: string; start: number; end: number };

export class FinanceReportImportAgentError extends Error {
  readonly code = "FINANCE_REPORT_IMPORT_AGENT_INVALID_OUTPUT";
  constructor() {
    super("The financial report could not be interpreted safely. Please retry.");
    this.name = "FinanceReportImportAgentError";
  }
}

function fail(): never { throw new FinanceReportImportAgentError(); }
const cellKey = (sheet: string, row: number, column: number) => JSON.stringify([sheet, row, column]);
export function buildFinanceReportSourceIndex(format: FinanceFileFormat, evidence: string): SourceIndex {
  const index: SourceIndex = { pages: new Map(), cells: new Map() };
  const lines = evidence.split("\n");
  if (lines.length > 250_000) fail();
  for (const line of lines) {
    let value: Record<string, unknown>;
    try { value = JSON.parse(line) as Record<string, unknown>; } catch { fail(); }
    if (!value || typeof value !== "object" || Array.isArray(value)) fail();
    if (format === "PDF") {
      if (!Number.isInteger(value.page) || (value.page as number) <= 0 || typeof value.text !== "string"
        || index.pages.has(value.page as number)) fail();
      index.pages.set(value.page as number, value.text);
    } else if (typeof value.sheet === "string" && Number.isInteger(value.rowCount)
      && Number.isInteger(value.columnCount) && value.row === undefined) {
      continue;
    } else {
      if (typeof value.sheet !== "string" || !value.sheet.trim() || !Number.isInteger(value.row)
        || (value.row as number) <= 0 || !Number.isInteger(value.column) || (value.column as number) <= 0) fail();
      const texts = [value.value, value.displayValue].filter((item): item is string => typeof item === "string");
      const key = cellKey(value.sheet, value.row as number, value.column as number);
      if (texts.length === 0 || index.cells.has(key)) fail();
      index.cells.set(key, new Set(texts));
    }
  }
  if ((format === "PDF" ? index.pages.size : index.cells.size) === 0) fail();
  return index;
}
function bind(index: SourceIndex, source: Source, format: FinanceFileFormat): Claim | null {
  if ((format === "PDF") !== (source.kind === "PDF")) return null;
  if (source.kind === "CELL") {
    const key = cellKey(source.sheet, source.row, source.column);
    return index.cells.get(key)?.has(source.evidence) ? { key: `CELL:${key}`, start: 0, end: 1 } : null;
  }
  const text = index.pages.get(source.page);
  const start = text?.indexOf(source.evidence) ?? -1;
  return start >= 0 && text!.lastIndexOf(source.evidence) === start
    ? { key: `PDF:${source.page}`, start, end: start + source.evidence.length } : null;
}
function tokenCents(token: string) {
  const negative = token.includes("(") || token.trimStart().startsWith("-");
  const raw = token.replace(/[()+'\s-]/g, "");
  const comma = raw.lastIndexOf(","); const dot = raw.lastIndexOf("."); const separator = Math.max(comma, dot);
  const tail = separator < 0 ? 0 : raw.length - separator - 1;
  if (separator >= 0 && tail > 2 && !(tail === 3 && /^\d{1,3}(?:[.,]\d{3})+$/.test(raw))) return null;
  const decimal = separator >= 0 && tail <= 2 ? separator : -1;
  let normalized = "";
  for (const [index, char] of [...raw].entries()) {
    if (/\d/.test(char)) normalized += char;
    else if (index === decimal) normalized += ".";
  }
  const cents = Number(normalized) * 100 * (negative ? -1 : 1);
  return Number.isSafeInteger(cents) && cents >= INT_MIN && cents <= INT_MAX ? cents : null;
}
function amountMatches(evidence: string, amountCents: number) {
  const tokens = evidence.match(/(?<![\d.,'])\(?[-+]?\p{Sc}?\s*(?:\d{1,3}(?:[.,']\d{3})+|\d+)(?:[.,]\d+)?\)?(?![\d.,'])/gu) ?? [];
  return tokens.map(tokenCents).filter((value) => value === amountCents).length === 1;
}
function currencyMatches(evidence: string, code: string) {
  const codes = (evidence.match(/\b[A-Z]{3}\b/g) ?? []).filter((token) => ISO_CODES.has(token));
  return ISO_CODES.has(code) && codes.length === 1 && codes[0] === code;
}
function validateEvidence(proposal: FinanceReportImportProposalV1, index: SourceIndex, format: FinanceFileFormat) {
  const claims: Claim[] = [];
  for (const candidate of proposal.candidates) {
    const claim = bind(index, candidate.source, format);
    if (!claim || !amountMatches(candidate.source.evidence, candidate.amountCents)) return false;
    claims.push(claim);
  }
  if (proposal.report.currency.state === "EXPLICIT") {
    const { source, code } = proposal.report.currency; const claim = bind(index, source, format);
    if (!claim || !currencyMatches(source.evidence, code)) return false;
    claims.push(claim);
  }
  claims.sort((left, right) => left.key.localeCompare(right.key) || left.start - right.start);
  return claims.every((claim, index) => index === 0 || claims[index - 1]!.key !== claim.key
    || claims[index - 1]!.end <= claim.start);
}
function visibleExceptions(proposal: FinanceReportImportProposalV1) {
  return { ...proposal, candidates: proposal.candidates.map((candidate) => {
    const codes = new Set(candidate.exceptionCodes); const reasons = [...candidate.reviewReasons];
    const add = (code: (typeof candidate.exceptionCodes)[number], reason: string) => { codes.add(code); reasons.push(reason); };
    if (candidate.confidence < 0.85) add("LOW_CONFIDENCE", "Mapping confidence is below the verified threshold.");
    if (candidate.mappingStatus === "AMBIGUOUS") add("AMBIGUOUS_MAPPING", "More than one mapping is plausible.");
    if (candidate.mappingStatus === "UNMAPPED") add("UNMAPPED_ACCOUNT", "No account mapping is proposed.");
    if (candidate.rowKind === "DERIVED") add("DERIVED_ROW", "Derived rows require review.");
    const warning = codes.size > 0 || reasons.length > 0;
    return { ...candidate, reviewStatus: warning ? "WARNING" as const : candidate.reviewStatus,
      exceptionCodes: [...codes], reviewReasons: [...new Set(reasons)].slice(0, 8) };
  }) };
}
const schemaHint = `Strict JSON only: {contractVersion:1,report:{title:string,reportType:PROFIT_AND_LOSS|BALANCE_SHEET|CASH_FLOW|TRIAL_BALANCE|OTHER,basis:CASH|ACCRUAL|UNSPECIFIED,cadence:DAILY|WEEKLY|MONTHLY|QUARTERLY|ANNUAL|CUSTOM,periodStart:YYYY-MM-DD,periodEnd:YYYY-MM-DD,asOfDate:YYYY-MM-DD|null,currency:{state:EXPLICIT,code:uppercase ISO-4217,source:Source}|{state:UNRESOLVED,code:null,source:null}},summary:string,candidates:[{target:REPORTED_ACTUAL,editable:true,source:Source,sourceLabel:string,sourceAccountPath:string[],proposedAccountPath:string[],rowKind:LEAF|DERIVED,periodStart:YYYY-MM-DD,periodEnd:YYYY-MM-DD,amountCents:integer,mappingStatus:MAPPED|AMBIGUOUS|UNMAPPED,confidence:0..1,reviewStatus:VERIFIED|WARNING,exceptionCodes:(LOW_CONFIDENCE|AMBIGUOUS_MAPPING|UNMAPPED_ACCOUNT|DERIVED_ROW|OTHER)[],reviewReasons:string[]}]}. Source is exactly {kind:PDF,page:integer,evidence:exact substring} or {kind:CELL,sheet:exact string,row:integer,column:integer,evidence:exact cell string}. No other fields.`;
const instruction = (paths: string[]) => `Infer report semantics from deterministic PDF/CSV/XLSX JSONL without a vendor picker. Return editable native Finance Reported Actuals proposals only; never transactions, tools, writes, approval, or application. Preserve source strings exactly. Profile hints are non-authoritative and require fresh validation. Use UNRESOLVED currency unless an uppercase ISO token is explicit in source; never default to USD. Ambiguous, unmapped, low-confidence, and derived rows need visible warnings. Structural uncertainty is invalid.${paths.length ? ` Previous output failed at: ${paths.join(", ")}. Rebuild it.` : ""}`;

export async function interpretFinanceReport(params: { workspaceId: string; workflowJobId?: string; agentRunId?: string;
  model?: string; format: FinanceFileFormat; extractedEvidence: string;
  approvedProfileHints?: FinanceReportImportProfileHint[]; gateway?: Pick<ModelGateway, "extract">;
}): Promise<FinanceReportImportProposalV1> {
  const input = inputSchema.parse({ format: params.format, extractedEvidence: params.extractedEvidence,
    approvedProfileHints: params.approvedProfileHints ?? [] });
  const index = buildFinanceReportSourceIndex(input.format, input.extractedEvidence);
  const gateway = params.gateway ?? defaultModelGateway;
  let paths: string[] = [];
  for (let attempt = 0; attempt < 2; attempt += 1) {
    const request: ExtractionRequest = { workspaceId: params.workspaceId, workflowJobId: params.workflowJobId,
      agentRunId: params.agentRunId, model: params.model ?? resolveModel(AGENT_REGISTRY["finance-report-import"].defaultModelTier),
      instruction: instruction(paths), schemaHint, input: JSON.stringify(input) };
    try {
      const parsed = financeReportImportProposalV1Schema.safeParse((await gateway.extract(request)).output);
      if (parsed.success && validateEvidence(parsed.data, index, input.format)) return visibleExceptions(parsed.data);
      paths = parsed.success ? ["sourceEvidence"]
        : [...new Set(parsed.error.issues.map((issue) => issue.path.join(".") || "root"))].slice(0, 12);
    } catch (error) {
      if (!(error instanceof Error) || error.name !== "ExtractionParseError") throw error;
      paths = ["root"];
    }
  }
  throw new FinanceReportImportAgentError();
}
