import { AGENT_REGISTRY } from "@corgtex/domain";
import { defaultModelGateway, resolveModel, type ExtractionRequest, type ModelGateway } from "@corgtex/models";
import { z } from "zod";

export const FINANCE_REPORT_IMPORT_CONTRACT_VERSION = 1 as const;
export const FINANCE_REPORT_IMPORT_LOW_CONFIDENCE = 0.85;
const POSTGRES_INT_MIN = -2_147_483_648;
const POSTGRES_INT_MAX = 2_147_483_647;
const MAX_PROFILE_HINT_MAPPINGS = 2_000;
const MAX_PROFILE_HINT_CHARS = 200_000;
const ISO_CURRENCY_CODES = new Set(Intl.supportedValuesOf("currency"));
const CURRENCY_NAME_ALIASES: Record<string, string[]> = {
  USD: ["US DOLLAR", "US DOLLARS", "U S DOLLAR", "U S DOLLARS",
    "UNITED STATES DOLLAR", "UNITED STATES DOLLARS"],
  EUR: ["EURO", "EUROS"],
  GBP: ["BRITISH POUND", "BRITISH POUNDS", "POUND STERLING", "POUNDS STERLING", "STERLING"],
  CAD: ["CANADIAN DOLLAR", "CANADIAN DOLLARS"],
  AUD: ["AUSTRALIAN DOLLAR", "AUSTRALIAN DOLLARS"],
  NZD: ["NEW ZEALAND DOLLAR", "NEW ZEALAND DOLLARS"],
  JPY: ["JAPANESE YEN", "YEN"],
  CHF: ["SWISS FRANC", "SWISS FRANCS"],
};
const bounded = (maximum: number) => z.string().trim().min(1).max(maximum);
const sourceIdentifier = (maximum: number) => z.string().min(1).max(maximum)
  .refine((value) => value.trim().length > 0, "Expected a non-blank source identifier.");
const currencyCodesNamed = (evidence: string) => {
  const normalized = ` ${evidence.toUpperCase().replace(/[^A-Z0-9]+/g, " ").trim()} `;
  const tokens = normalized.trim().split(/\s+/); const currencyIndex = tokens.indexOf("CURRENCY");
  const amountsInIndex = tokens.findIndex((token, index) =>
    token === "IN" && ["AMOUNT", "AMOUNTS"].includes(tokens[index - 1] ?? ""));
  const scoped = currencyIndex >= 0 ? tokens.slice(currencyIndex + 1) : amountsInIndex >= 0
    ? tokens.slice(amountsInIndex + 1) : tokens.filter((token) => token in CURRENCY_NAME_ALIASES);
  const codes = new Set(scoped.filter((token) => ISO_CURRENCY_CODES.has(token)));
  for (const [code, aliases] of Object.entries(CURRENCY_NAME_ALIASES)) {
    if (aliases.some((name) => normalized.includes(` ${name} `))) codes.add(code);
  }
  return codes;
};
const isoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/).refine((value) => {
  const parsed = new Date(`${value}T00:00:00.000Z`);
  return Number(value.slice(0, 4)) >= 1_000
    && !Number.isNaN(parsed.valueOf())
    && parsed.toISOString().slice(0, 10) === value;
}, "Expected a valid ISO calendar date.");
const sourceLocationSchema = z.object({
  page: z.number().int().positive().max(100_000).nullable(),
  sheet: sourceIdentifier(200).nullable(),
  row: z.number().int().positive().max(1_000_000).nullable(),
  column: z.number().int().positive().max(100_000).nullable(),
  evidence: sourceIdentifier(1_000),
}).strict().superRefine((value, context) => {
  if (value.page !== null && (value.sheet !== null || value.row !== null || value.column !== null)) {
    context.addIssue({ code: "custom", message: "PDF and spreadsheet source coordinates cannot be mixed." });
  } else if (value.page === null && (value.sheet === null || value.row === null)) {
    context.addIssue({ code: "custom", message: "Source evidence requires a page or sheet and row." });
  }
  if (value.column !== null && value.row === null) {
    context.addIssue({ code: "custom", path: ["column"], message: "A source column requires a row." });
  }
});
const currencySchema = z.object({
  state: z.enum(["EXPLICIT", "UNRESOLVED"]),
  code: z.string().regex(/^[A-Z]{3}$/).refine((code) => ISO_CURRENCY_CODES.has(code)).nullable(),
  evidence: z.array(sourceLocationSchema).max(5),
}).strict().superRefine((value, context) => {
  const explicit = value.state === "EXPLICIT";
  if ((explicit && (value.code === null || value.evidence.length === 0))
    || (!explicit && (value.code !== null || value.evidence.length > 0))) {
    context.addIssue({ code: "custom", message: "Currency state, code, and evidence do not agree." });
  }
  const namedCurrencies = new Set(value.evidence.flatMap((location) =>
    [...currencyCodesNamed(location.evidence)]));
  if (explicit && value.code && (namedCurrencies.size !== 1 || !namedCurrencies.has(value.code))) {
    context.addIssue({ code: "custom", path: ["evidence"],
      message: "Explicit currency evidence must name one unambiguous proposed currency." });
  }
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
  if (value.periodStart > value.periodEnd) {
    context.addIssue({ code: "custom", path: ["periodEnd"], message: "Candidate period is reversed." });
  }
  if (value.mappingStatus === "MAPPED" && value.proposedAccountPath.length === 0) {
    context.addIssue({ code: "custom", path: ["proposedAccountPath"], message: "Mapped rows require a hierarchy." });
  }
  if (value.mappingStatus === "UNMAPPED" && value.proposedAccountPath.length > 0) {
    context.addIssue({ code: "custom", path: ["proposedAccountPath"], message: "Unmapped rows cannot claim a hierarchy." });
  }
  if (value.reviewStatus !== "VERIFIED" && value.reviewReasons.length === 0) {
    context.addIssue({ code: "custom", path: ["reviewReasons"], message: "Review exceptions require a reason." });
  }
  if (value.exceptionCodes.length > 0 && value.reviewReasons.length === 0) {
    context.addIssue({ code: "custom", path: ["reviewReasons"], message: "Every exception requires a visible reason." });
  }
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
    amountScale: z.enum(["UNITS", "THOUSANDS", "MILLIONS"]),
    currency: currencySchema,
  }).strict().superRefine((value, context) => {
    if (value.periodStart > value.periodEnd) {
      context.addIssue({ code: "custom", path: ["periodEnd"], message: "Report period is reversed." });
    }
    if (value.asOfDate && (value.asOfDate < value.periodStart || value.asOfDate > value.periodEnd)) {
      context.addIssue({ code: "custom", path: ["asOfDate"], message: "As-of date is outside the report period." });
    }
  }),
  summary: bounded(2_000),
  candidates: z.array(candidateSchema).min(1).max(1_000),
}).strict().superRefine((value, context) => {
  const candidateIdentities = new Set<string>();
  value.candidates.forEach((candidate, index) => {
    if (candidate.periodStart < value.report.periodStart) {
      context.addIssue({ code: "custom", path: ["candidates", index, "periodStart"],
        message: "Candidate period starts before the report period." });
    }
    if (candidate.periodEnd > value.report.periodEnd) {
      context.addIssue({ code: "custom", path: ["candidates", index, "periodEnd"],
        message: "Candidate period ends after the report period." });
    }
    const identity = JSON.stringify(candidate.sourceLocation.page !== null
      ? ["PDF", candidate.sourceLocation.page, candidate.sourceLabel, candidate.amountCents]
      : ["SHEET", candidate.sourceLocation.sheet, candidate.sourceLocation.row, candidate.sourceLocation.column]);
    if (candidateIdentities.has(identity)) {
      context.addIssue({ code: "custom", path: ["candidates", index],
        message: "Duplicate proposal candidate." });
    }
    candidateIdentities.add(identity);
  });
});

const profileHintSchema = z.object({
  profileId: bounded(100), version: z.number().int().positive(), layoutFingerprint: bounded(256),
  approvedMappings: z.array(z.object({ sourceLabel: bounded(500), accountPath: hierarchy }).strict()).max(500),
}).strict();
const inputSchema = z.object({
  fileName: bounded(255), mimeType: bounded(200), extractedEvidence: z.string().min(1).max(2_000_000),
  approvedProfileHints: z.array(profileHintSchema).max(20),
}).strict().superRefine((value, context) => {
  const mappingCount = value.approvedProfileHints.reduce((count, hint) => count + hint.approvedMappings.length, 0);
  if (mappingCount > MAX_PROFILE_HINT_MAPPINGS
    || JSON.stringify(value.approvedProfileHints).length > MAX_PROFILE_HINT_CHARS) {
    context.addIssue({ code: "custom", path: ["approvedProfileHints"],
      message: "Approved profile hints exceed the aggregate request budget." });
  }
});
export type FinanceReportImportProposalV1 = z.infer<typeof financeReportImportProposalV1Schema>;
export type FinanceReportImportProfileHint = z.infer<typeof profileHintSchema>;
type ExtractionGateway = Pick<ModelGateway, "extract">;

export class FinanceReportImportAgentError extends Error {
  readonly code = "FINANCE_REPORT_IMPORT_AGENT_INVALID_OUTPUT";
  constructor() {
    super("The financial report could not be interpreted safely. Please retry.");
    this.name = "FinanceReportImportAgentError";
  }
}

const instruction = (retryPaths: string[]) => `Interpret deterministic PDF/CSV/XLSX evidence as an editable
Finance Reported Actuals proposal. Infer type, basis, cadence, dates, amount scale, hierarchy, leaf/derived rows, integer cents,
and source-located currency evidence without a vendor picker. Return proposals only; never create transactions,
apply Finance records, or claim human approval. Profile hints are non-authoritative and every mapping must be
revalidated. If currency is not explicit, return UNRESOLVED/null and never default to USD. Uncertain mappings must
be AMBIGUOUS or UNMAPPED with visible exceptions. Classify budget-versus-actual or general-ledger layouts as OTHER,
and a mixed accounting basis as UNSPECIFIED. Return strict contract v1 with no unknown fields.${retryPaths.length
  ? ` The previous response failed validation at ${retryPaths.join(", ")}; rebuild it.` : ""}`;
const schemaHint = `Strict contract v1 JSON with no additional fields:
{
  "contractVersion": 1,
  "report": {
    "title": "string",
    "reportType": "PROFIT_AND_LOSS|BALANCE_SHEET|CASH_FLOW|TRIAL_BALANCE|OTHER",
    "basis": "CASH|ACCRUAL|UNSPECIFIED",
    "cadence": "DAILY|WEEKLY|MONTHLY|QUARTERLY|ANNUAL|CUSTOM",
    "periodStart": "YYYY-MM-DD", "periodEnd": "YYYY-MM-DD", "asOfDate": "YYYY-MM-DD|null",
    "amountScale": "UNITS|THOUSANDS|MILLIONS",
    "currency": {
      "state": "EXPLICIT|UNRESOLVED", "code": "three uppercase letters|null",
      "evidence": [{ "page": "positive integer|null", "sheet": "string|null",
        "row": "positive integer|null", "column": "positive integer|null", "evidence": "exact source text" }]
    }
  },
  "summary": "string",
  "candidates": [{
    "sourceLocation": { "page": "positive integer|null", "sheet": "string|null",
      "row": "positive integer|null", "column": "positive integer|null", "evidence": "exact source text" },
    "sourceLabel": "string", "sourceAccountPath": ["string"], "proposedAccountPath": ["string"],
    "rowKind": "LEAF|DERIVED", "periodStart": "YYYY-MM-DD", "periodEnd": "YYYY-MM-DD",
    "amountCents": "PostgreSQL Int", "mappingStatus": "MAPPED|AMBIGUOUS|UNMAPPED",
    "confidence": "number 0..1", "reviewStatus": "VERIFIED|WARNING|BLOCKER",
    "exceptionCodes": ["LOW_CONFIDENCE|AMBIGUOUS_MAPPING|UNMAPPED_ACCOUNT|OTHER"],
    "reviewReasons": ["string"]
  }]
}`;
const issuePaths = (error: z.ZodError) => [...new Set(error.issues.map((issue) => issue.path.join(".") || "root"))].slice(0, 12);
type SourceLocation = z.infer<typeof sourceLocationSchema>;
type EvidenceIndex = Map<string, string[]>;
const evidenceKey = (...parts: Array<string | number>) => JSON.stringify(parts);
function appendEvidence(index: EvidenceIndex, key: string, record: Record<string, unknown>) {
  const sourceText = ["text", "value", "displayValue"].flatMap((field) =>
    typeof record[field] === "string" ? [record[field] as string] : []);
  if (sourceText.length === 0) return;
  const existing = index.get(key);
  if (existing) existing.push(...sourceText);
  else index.set(key, sourceText);
}
function buildEvidenceIndex(extractedEvidence: string) {
  const index: EvidenceIndex = new Map();
  for (const line of extractedEvidence.split("\n")) {
    try {
      const parsed: unknown = JSON.parse(line);
      if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) continue;
      const record = parsed as Record<string, unknown>;
      if (typeof record.page === "number") {
        appendEvidence(index, evidenceKey("page", record.page), record);
      }
      if (typeof record.sheet === "string" && typeof record.row === "number") {
        appendEvidence(index, evidenceKey("row", record.sheet, record.row), record);
        if (typeof record.column === "number") {
          appendEvidence(index, evidenceKey("cell", record.sheet, record.row, record.column), record);
        }
      }
    } catch {
      continue;
    }
  }
  return index;
}
function locationMatches(index: EvidenceIndex, location: SourceLocation) {
  const key = location.page !== null
    ? evidenceKey("page", location.page)
    : location.column === null
      ? evidenceKey("row", location.sheet!, location.row!)
      : evidenceKey("cell", location.sheet!, location.row!, location.column);
  return index.get(key)?.some((sourceText) => location.page !== null
    ? sourceText.includes(location.evidence) : sourceText === location.evidence) ?? false;
}
function labelMatches(index: EvidenceIndex, location: SourceLocation, label: string) {
  const key = location.page !== null ? evidenceKey("page", location.page) : evidenceKey("row", location.sheet!, location.row!);
  return index.get(key)?.some((sourceText) => location.page !== null
    ? sourceText.includes(label) : sourceText.trim() === label) ?? false;
}
function evidenceAmountScale(index: EvidenceIndex) {
  const text = [...index.values()].flat().join(" ").toUpperCase();
  const scales = [["THOUSANDS", /\bIN\s+THOUSANDS?\b/], ["MILLIONS", /\bIN\s+MILLIONS?\b/]]
    .flatMap(([scale, pattern]) => (pattern as RegExp).test(text) ? [scale as "THOUSANDS" | "MILLIONS"] : []);
  return scales.length === 0 ? "UNITS" as const : scales.length === 1 ? scales[0]! : null;
}
function parseMoneyToken(token: string) {
  const negative = token.startsWith("-") || token.startsWith("(") || token.endsWith("-");
  let value = token.replace(/\p{Sc}/gu, "").replace(/[()\s\u00a0]/g, "").replace(/^[+-]/, "").replace(/-$/, "");
  const comma = value.lastIndexOf(","); const dot = value.lastIndexOf(".");
  if (comma >= 0 && dot >= 0) {
    const decimal = comma > dot ? "," : ".";
    value = value.replace(decimal === "," ? /\./g : /,/g, "").replace(decimal, ".");
  } else if (comma >= 0 || dot >= 0) {
    const separator = comma >= 0 ? "," : "."; const parts = value.split(separator);
    value = parts.at(-1)!.length <= 2 ? `${parts.slice(0, -1).join("")}.${parts.at(-1)}` : parts.join("");
  }
  const rawCents = Number(value) * 100; const cents = Math.round(rawCents) * (negative ? -1 : 1);
  return /^\d+(?:\.\d{1,2})?$/.test(value) && Number.isSafeInteger(cents)
    && Math.abs(rawCents - Math.round(rawCents)) < 1e-6 ? cents : null;
}
function evidenceAmountsCents(evidence: string) {
  const withoutDates = evidence.replace(/\b\d{4}-\d{2}-\d{2}(?:T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})?)?/g, " ");
  return [...withoutDates.matchAll(/[+-]?\(?\s*\p{Sc}?\s*(?:\d{1,3}(?:[ ,.\u00a0]\d{3})+(?:[.,]\d{1,2})?|\d+(?:[.,]\d{1,2})?)\)?-?/gu)]
    .flatMap((match) => { const cents = parseMoneyToken(match[0]); return /^\s*%/.test(withoutDates.slice((match.index ?? 0) + match[0].length)) || cents === null ? [] : [cents]; });
}
function unmatchedEvidencePaths(proposal: FinanceReportImportProposalV1, extractedEvidence: string) {
  const evidenceIndex = buildEvidenceIndex(extractedEvidence);
  const detectedScale = evidenceAmountScale(evidenceIndex);
  const scale = detectedScale === proposal.report.amountScale
    ? ({ UNITS: 1, THOUSANDS: 1_000, MILLIONS: 1_000_000 } as const)[detectedScale] : null;
  const paths = proposal.candidates.flatMap((candidate, candidateIndex) => [
    ...(locationMatches(evidenceIndex, candidate.sourceLocation) ? [] : [`candidates.${candidateIndex}.sourceLocation`]),
    ...(labelMatches(evidenceIndex, candidate.sourceLocation, candidate.sourceLabel)
      ? [] : [`candidates.${candidateIndex}.sourceLabel`]),
    ...(scale !== null && evidenceAmountsCents(candidate.sourceLocation.evidence)
      .some((amount) => amount * scale === candidate.amountCents)
      ? [] : [`candidates.${candidateIndex}.amountCents`]),
  ]);
  return [...(scale === null ? ["report.amountScale"] : []), ...paths,
    ...proposal.report.currency.evidence.flatMap((location, currencyIndex) =>
    locationMatches(evidenceIndex, location) ? [] : [`report.currency.evidence.${currencyIndex}`])].slice(0, 12);
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
