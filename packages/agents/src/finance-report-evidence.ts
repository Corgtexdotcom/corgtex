export const FINANCE_REPORT_EVIDENCE_VERSION = 1 as const;
export const ISO_4217_REGISTRY_VERSION = "2026-01-01";
const ISO_CODES = new Set(`AED AFN ALL AMD AOA ARS AUD AWG AZN BAM BBD BDT BHD BIF BMD BND BOB BOV BRL BSD BTN BWP BYN BZD CAD CDF CHE CHF CHW CLF CLP CNY COP COU CRC CUP CVE CZK DJF DKK DOP DZD EGP ERN ETB EUR FJD FKP GBP GEL GHS GIP GMD GNF GTQ GYD HKD HNL HTG HUF IDR ILS INR IQD IRR ISK JMD JOD JPY KES KGS KHR KMF KPW KRW KWD KYD KZT LAK LBP LKR LRD LSL LYD MAD MDL MGA MKD MMK MNT MOP MRU MUR MVR MWK MXN MXV MYR MZN NAD NGN NIO NOK NPR NZD OMR PAB PEN PGK PHP PKR PLN PYG QAR RON RSD RUB RWF SAR SBD SCR SDG SEK SGD SHP SLE SOS SRD SSP STN SVC SYP SZL THB TJS TMT TND TOP TRY TTD TWD TZS UAH UGX USD USN UYI UYU UYW UZS VED VES VND VUV WST XAD XAF XAG XAU XBA XBB XBC XBD XCD XCG XDR XOF XPD XPF XPT XSU XTS XUA XXX YER ZAR ZMW ZWG`.split(" "));
const INT_MIN = -2_147_483_648;
const INT_MAX = 2_147_483_647;
const TYPES = new Set(["BOOLEAN", "DATE", "ERROR", "FORMULA", "NUMBER", "TEXT"]);

export type FinanceReportEvidenceFormat = "PDF" | "CSV" | "XLSX";
export type FinanceReportEvidenceSource =
  | { kind: "PDF"; page: number; evidence: string }
  | { kind: "CELL"; sheet: string; row: number; column: number; evidence: string };
export type FinanceReportEvidenceClaim =
  | { kind: "SOURCE"; id: string; source: FinanceReportEvidenceSource }
  | { kind: "AMOUNT"; id: string; source: FinanceReportEvidenceSource; amountCents: number }
  | { kind: "CURRENCY"; id: string; source: FinanceReportEvidenceSource };
export type FinanceReportEvidenceBlockerCode = "INVALID_INPUT" | "LIMIT_EXCEEDED" | "MALFORMED_EVIDENCE"
  | "SOURCE_NOT_FOUND" | "AMBIGUOUS_SOURCE" | "DUPLICATE_CLAIM" | "UNSAFE_AMOUNT"
  | "AMOUNT_MISMATCH" | "INVALID_CURRENCY" | "MULTI_CURRENCY";
export type FinanceReportEvidenceFact =
  | { kind: "SOURCE"; claimId: string; source: FinanceReportEvidenceSource }
  | { kind: "MATCH"; claimId: string; sourceKey: string }
  | { kind: "AMOUNT"; claimId: string; amountCents: number }
  | { kind: "CURRENCY"; claimId: string; state: "EXPLICIT"; code: string; registryVersion: string }
  | { kind: "CURRENCY"; claimId: string; state: "UNRESOLVED"; code: null; registryVersion: string }
  | { kind: "BLOCKER"; claimId?: string; code: FinanceReportEvidenceBlockerCode };
export type FinanceReportEvidenceResultV1 = { version: typeof FINANCE_REPORT_EVIDENCE_VERSION;
  facts: FinanceReportEvidenceFact[] };

type Cell = { type: string; resultType?: string; value: string; displayValue?: string };
type Index = { pages: Map<number, Map<string, string | null>>; cells: Map<string, Cell> };
type Match = { key: string; amountText: string; rawNumber: boolean; cell?: Cell };
class EvidenceError extends Error {
  constructor(public readonly code: FinanceReportEvidenceBlockerCode, public readonly claimId?: string) { super(code); }
}
function fail(code: FinanceReportEvidenceBlockerCode, claimId?: string): never { throw new EvidenceError(code, claimId); }
const record = (value: unknown): value is Record<string, unknown> => !!value && typeof value === "object" && !Array.isArray(value);
function keys(value: Record<string, unknown>, allowed: string[], required = allowed) {
  if (!required.every((key) => key in value) || Object.keys(value).some((key) => !allowed.includes(key))) fail("MALFORMED_EVIDENCE");
}
function text(value: unknown, max: number) {
  if (typeof value !== "string" || value.length === 0 || value.length > max || !value.trim()) fail("MALFORMED_EVIDENCE");
  return value;
}
function integer(value: unknown, min: number, max: number) {
  if (!Number.isSafeInteger(value) || (value as number) < min || (value as number) > max) fail("MALFORMED_EVIDENCE");
  return value as number;
}
const cellKey = (sheet: string, row: number, column: number) => JSON.stringify([sheet, row, column]);

function buildIndex(format: FinanceReportEvidenceFormat, jsonl: string): Index {
  if (!jsonl || jsonl.length > 2_000_000) fail(jsonl.length > 2_000_000 ? "LIMIT_EXCEEDED" : "INVALID_INPUT");
  const lines = jsonl.split("\n");
  if (lines.length > 250_000) fail("LIMIT_EXCEEDED");
  const index: Index = { pages: new Map(), cells: new Map() };
  const sheets = new Map<string, { rows: number; columns: number }>();
  let rows = 0;
  for (const line of lines) {
    let value: unknown;
    try { value = JSON.parse(line); } catch { fail("MALFORMED_EVIDENCE"); }
    if (!record(value)) fail("MALFORMED_EVIDENCE");
    if (format === "PDF") {
      keys(value, ["page", "text"]);
      const page = integer(value.page, 1, 250);
      if (typeof value.text !== "string" || index.pages.has(page)) fail("MALFORMED_EVIDENCE");
      const occurrences = new Map<string, string | null>();
      for (const lineText of value.text.split("\n")) if (lineText.trim()) {
        occurrences.set(lineText, occurrences.has(lineText) ? null : `PDF:${page}:${JSON.stringify(lineText)}`);
      }
      index.pages.set(page, occurrences);
      continue;
    }
    if (!("row" in value)) {
      keys(value, ["sheet", "rowCount", "columnCount"]);
      const sheet = text(value.sheet, 200);
      const rowCount = integer(value.rowCount, 0, 20_000);
      const columnCount = integer(value.columnCount, 0, 250_000);
      rows += rowCount;
      if (sheets.has(sheet)) fail("MALFORMED_EVIDENCE");
      if (sheets.size >= 100 || rows > 20_000) fail("LIMIT_EXCEEDED");
      sheets.set(sheet, { rows: rowCount, columns: columnCount });
      continue;
    }
    keys(value, ["sheet", "row", "column", "type", "value", "displayValue", "formula", "resultType"],
      ["sheet", "row", "column", "type", "value"]);
    const sheet = text(value.sheet, 200); const bounds = sheets.get(sheet);
    const row = integer(value.row, 1, 20_000); const column = integer(value.column, 1, 250_000);
    const type = text(value.type, 20);
    if (typeof value.value !== "string" || value.value.length > 50_000) fail("MALFORMED_EVIDENCE");
    const cellValue = value.value;
    if (!bounds || row > bounds.rows || column > bounds.columns || !TYPES.has(type)) fail("MALFORMED_EVIDENCE");
    const formula = value.formula; const resultType = value.resultType;
    if (type === "FORMULA" ? !(typeof formula === "string" && !!formula
      && typeof resultType === "string" && TYPES.has(resultType) && resultType !== "FORMULA")
      : formula !== undefined || resultType !== undefined) {
      fail("MALFORMED_EVIDENCE");
    }
    if (format === "CSV" && (type !== "TEXT" || value.displayValue !== undefined)) fail("MALFORMED_EVIDENCE");
    if (value.displayValue !== undefined && (typeof value.displayValue !== "string" || value.displayValue.length > 50_000)) fail("MALFORMED_EVIDENCE");
    const displayValue = value.displayValue as string | undefined;
    const key = cellKey(sheet, row, column);
    if (index.cells.has(key) || index.cells.size >= 250_000) fail(index.cells.size >= 250_000 ? "LIMIT_EXCEEDED" : "MALFORMED_EVIDENCE");
    index.cells.set(key, { type, resultType: resultType as string | undefined, value: cellValue, displayValue });
  }
  if (format === "PDF" ? ![...index.pages.values()].some((page) => page.size) : index.cells.size === 0) fail("MALFORMED_EVIDENCE");
  return index;
}

function source(value: unknown): FinanceReportEvidenceSource {
  if (!record(value) || (value.kind !== "PDF" && value.kind !== "CELL")) fail("INVALID_INPUT");
  if (value.kind === "PDF") {
    keys(value, ["kind", "page", "evidence"]);
    return { kind: "PDF", page: integer(value.page, 1, 250), evidence: text(value.evidence, 50_000) };
  }
  keys(value, ["kind", "sheet", "row", "column", "evidence"]);
  return { kind: "CELL", sheet: text(value.sheet, 200), row: integer(value.row, 1, 20_000),
    column: integer(value.column, 1, 250_000), evidence: text(value.evidence, 50_000) };
}
function claim(value: unknown): FinanceReportEvidenceClaim {
  if (!record(value) || !["SOURCE", "AMOUNT", "CURRENCY"].includes(value.kind as string)) fail("INVALID_INPUT");
  const allowed = value.kind === "AMOUNT" ? ["kind", "id", "source", "amountCents"] : ["kind", "id", "source"];
  if (Object.keys(value).some((key) => !allowed.includes(key)) || typeof value.id !== "string"
    || !value.id.trim() || value.id.length > 100) fail("INVALID_INPUT");
  const parsedSource = source(value.source);
  if (value.kind === "AMOUNT") {
    if (!Number.isInteger(value.amountCents) || (value.amountCents as number) < INT_MIN || (value.amountCents as number) > INT_MAX) fail("INVALID_INPUT");
    return { kind: "AMOUNT", id: value.id, source: parsedSource, amountCents: value.amountCents as number };
  }
  return { kind: value.kind, id: value.id, source: parsedSource } as FinanceReportEvidenceClaim;
}
function bind(index: Index, format: FinanceReportEvidenceFormat, claimSource: FinanceReportEvidenceSource, id: string): Match {
  if ((format === "PDF") !== (claimSource.kind === "PDF")) fail("SOURCE_NOT_FOUND", id);
  if (claimSource.kind === "PDF") {
    const key = index.pages.get(claimSource.page)?.get(claimSource.evidence);
    if (key === undefined) fail("SOURCE_NOT_FOUND", id);
    if (key === null) fail("AMBIGUOUS_SOURCE", id);
    return { key, amountText: claimSource.evidence, rawNumber: false };
  }
  const key = cellKey(claimSource.sheet, claimSource.row, claimSource.column); const cell = index.cells.get(key);
  if (!cell || (cell.value !== claimSource.evidence && cell.displayValue !== claimSource.evidence)) fail("SOURCE_NOT_FOUND", id);
  return { key: `CELL:${key}`, amountText: format === "XLSX" ? cell.value : claimSource.evidence,
    rawNumber: format === "XLSX", cell };
}

const UNSAFE_AMOUNT = /(?:\d[\d.,']*\s*(?:[%‰¢]|(?:k|m|b|bn|mm|million|billion)\b|cents?\b)|\d(?:[.,]\d+)?[eE][+\-−]?\d+|\d\s*[-/:]\s*\d)/iu;
const MONEY = /(?<![\p{L}\p{N}.,'])\(?[+\-−]?\s*\p{Sc}?\s*\d(?:[\d.,']*\d)?\s*[\-−]?\)?(?![\p{L}\p{N}.,'])/gu;
function tokenCents(token: string, rawNumber: boolean) {
  const trimmed = token.trim();
  if (rawNumber && !/^[+-]?\d+(?:\.\d+)?$/.test(trimmed)) return null;
  const match = trimmed.match(/^(\()?([+\-−])?\s*\p{Sc}?\s*(\d[\d.,']*)\s*([\-−])?(\))?$/u);
  if (!match || Boolean(match[1]) !== Boolean(match[5])) return null;
  const negatives = Number(Boolean(match[1])) + Number(match[2] === "-" || match[2] === "−") + Number(Boolean(match[4]));
  if (negatives > 1 || (match[2] === "+" && (match[1] || match[4]))) return null;
  const core = match[3]!; const comma = core.lastIndexOf(","); const dot = core.lastIndexOf(".");
  const separator = Math.max(comma, dot); const tail = separator < 0 ? 0 : core.length - separator - 1;
  const count = [...core].filter((char) => char === "," || char === ".").length;
  const decimal = rawNumber ? dot : comma >= 0 && dot >= 0 ? separator : count === 1 && tail <= 2 ? separator : -1;
  if (rawNumber && (comma >= 0 || (dot >= 0 && tail > 2))) return null;
  const whole = core.slice(0, decimal < 0 ? core.length : decimal); const fraction = decimal < 0 ? "" : core.slice(decimal + 1);
  const marks = [...new Set([...whole].filter((char) => !/\d/.test(char)))];
  if (marks.length > 1 || (marks.length === 1 && !whole.split(marks[0]!).every((part, index) => /^\d+$/.test(part)
    && (index === 0 ? part.length >= 1 && part.length <= 3 : part.length === 3)))) return null;
  const digits = whole.replace(/[.,']/g, "");
  if (!/^\d{1,10}$/.test(digits) || !/^\d{0,2}$/.test(fraction)) return null;
  const magnitude = (BigInt(digits) * 100n) + BigInt(fraction.padEnd(2, "0") || "0");
  const cents = negatives === 1 ? -magnitude : magnitude;
  return cents < BigInt(INT_MIN) || cents > BigInt(INT_MAX) ? null : Number(cents);
}
function amountMatches(evidence: string, expected: number, rawNumber: boolean) {
  if (UNSAFE_AMOUNT.test(evidence)) return false;
  const tokens = evidence.match(MONEY) ?? [];
  const values = tokens.map((token) => tokenCents(token, rawNumber));
  return values.length === 1 && values[0] === expected;
}

function currencyFact(evidence: string, claimId: string): FinanceReportEvidenceFact {
  const trim = evidence.trim(); const contextual = new Set<string>();
  const words = [...evidence.matchAll(/\b[A-Z]{3}\b/g)].filter((match) => ISO_CODES.has(match[0]));
  for (const match of words) {
    const before = evidence.slice(Math.max(0, match.index! - 24), match.index);
    const after = evidence.slice(match.index! + 3, match.index! + 27);
    if (trim === match[0] || /(?:currency|ccy|in)\s*[:=-]?\s*$/i.test(before)
      || /\/\s*$/.test(before) || /^\s*\//.test(after)) contextual.add(match[0]);
  }
  const stated = [...evidence.matchAll(/\b(?:currency|ccy|in)\s*[:=-]?\s*([A-Za-z]{2,4})\b/gi)].map((match) => match[1]!);
  const slash = evidence.match(/\b([A-Z]{3})\s*\/\s*([A-Z]{3})\b/);
  if (stated.some((code) => code !== code.toUpperCase() || !ISO_CODES.has(code))
    || (slash && (!ISO_CODES.has(slash[1]!) || !ISO_CODES.has(slash[2]!)))
    || (/^[A-Za-z]{2,4}$/.test(trim) && (!/^[A-Z]{3}$/.test(trim) || !ISO_CODES.has(trim)))) fail("INVALID_CURRENCY", claimId);
  if (contextual.size > 1) fail("MULTI_CURRENCY", claimId);
  const code = contextual.values().next().value as string | undefined;
  return code ? { kind: "CURRENCY", claimId, state: "EXPLICIT", code, registryVersion: ISO_4217_REGISTRY_VERSION }
    : { kind: "CURRENCY", claimId, state: "UNRESOLVED", code: null, registryVersion: ISO_4217_REGISTRY_VERSION };
}

export function validateFinanceReportEvidenceV1(params: { format: FinanceReportEvidenceFormat;
  extractedEvidence: string; claims: FinanceReportEvidenceClaim[] }): FinanceReportEvidenceResultV1 {
  try {
    if (!record(params) || Object.keys(params).some((key) => !["format", "extractedEvidence", "claims"].includes(key))
      || !["PDF", "CSV", "XLSX"].includes(params.format) || !Array.isArray(params.claims)
      || params.claims.length === 0 || params.claims.length > 1_000) fail("INVALID_INPUT");
    const index = buildIndex(params.format, params.extractedEvidence); const facts: FinanceReportEvidenceFact[] = [];
    const ids = new Set<string>(); const sources = new Set<string>();
    for (const rawClaim of params.claims as unknown[]) {
      const item = claim(rawClaim);
      if (ids.has(item.id)) fail("DUPLICATE_CLAIM", item.id); ids.add(item.id);
      const match = bind(index, params.format, item.source, item.id);
      if (sources.has(match.key)) fail("DUPLICATE_CLAIM", item.id); sources.add(match.key);
      facts.push({ kind: "SOURCE", claimId: item.id, source: item.source }, { kind: "MATCH", claimId: item.id, sourceKey: match.key });
      if (item.kind === "AMOUNT") {
        const resultType = match.cell?.type === "FORMULA" ? match.cell.resultType : match.cell?.type;
        if (params.format === "XLSX" && resultType !== "NUMBER") fail("UNSAFE_AMOUNT", item.id);
        if (!amountMatches(match.amountText, item.amountCents, match.rawNumber)) fail("AMOUNT_MISMATCH", item.id);
        facts.push({ kind: "AMOUNT", claimId: item.id, amountCents: item.amountCents });
      } else if (item.kind === "CURRENCY") facts.push(currencyFact(item.source.evidence, item.id));
    }
    return { version: FINANCE_REPORT_EVIDENCE_VERSION, facts };
  } catch (error) {
    const blocker = error instanceof EvidenceError ? error : new EvidenceError("INVALID_INPUT");
    return { version: FINANCE_REPORT_EVIDENCE_VERSION,
      facts: [{ kind: "BLOCKER", code: blocker.code, ...(blocker.claimId ? { claimId: blocker.claimId } : {}) }] };
  }
}
