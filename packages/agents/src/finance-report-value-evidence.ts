import { types as nodeTypes } from "node:util";
import {
  validateFinanceReportEvidenceSourcesV1,
  type FinanceReportEvidenceBlockerCode,
  type FinanceReportEvidenceSourceFact,
} from "./finance-report-evidence";

export const FINANCE_REPORT_VALUE_EVIDENCE_VERSION = 1 as const;
export const FINANCE_REPORT_ISO_4217_VERSION = "2026-01-01" as const;

// SIX ISO 4217 Maintenance Agency, List One, published 2026-01-01.
export const FINANCE_REPORT_ISO_4217_CODES: readonly string[] = Object.freeze("AED AFN ALL AMD AOA ARS AUD AWG AZN BAM BBD BDT BHD BIF BMD BND BOB BOV BRL BSD BTN BWP BYN BZD CAD CDF CHE CHF CHW CLF CLP CNY COP COU CRC CUP CVE CZK DJF DKK DOP DZD EGP ERN ETB EUR FJD FKP GBP GEL GHS GIP GMD GNF GTQ GYD HKD HNL HTG HUF IDR ILS INR IQD IRR ISK JMD JOD JPY KES KGS KHR KMF KPW KRW KWD KYD KZT LAK LBP LKR LRD LSL LYD MAD MDL MGA MKD MMK MNT MOP MRU MUR MVR MWK MXN MXV MYR MZN NAD NGN NIO NOK NPR NZD OMR PAB PEN PGK PHP PKR PLN PYG QAR RON RSD RUB RWF SAR SBD SCR SDG SEK SGD SHP SLE SOS SRD SSP STN SVC SYP SZL THB TJS TMT TND TOP TRY TTD TWD TZS UAH UGX USD USN UYI UYU UYW UZS VED VES VND VUV WST XAD XAF XAG XAU XBA XBB XBC XBD XCD XCG XDR XOF XPD XPF XPT XSU XTS XUA XXX YER ZAR ZMW ZWG".split(" "));

export type FinanceReportDecimalSeparator = "DOT" | "COMMA" | "NONE";
export type FinanceReportGroupingSeparator = "COMMA" | "DOT" | "APOSTROPHE" | "SPACE" | "NBSP" | "NARROW_NBSP" | "NONE";
export type FinanceReportAmountScale = 1 | 100 | 1_000 | 1_000_000 | 1_000_000_000;
export type FinanceReportNumericFormatV1 = {
  version: typeof FINANCE_REPORT_VALUE_EVIDENCE_VERSION;
  decimalSeparator: FinanceReportDecimalSeparator;
  groupingSeparator: FinanceReportGroupingSeparator;
  amountScale: FinanceReportAmountScale;
};
export type FinanceReportValueEvidenceBlockerCode = FinanceReportEvidenceBlockerCode
  | "INVALID_NUMERIC_FORMAT" | "INVALID_AMOUNT" | "UNSUPPORTED_PRESENTATION"
  | "FRACTIONAL_CENTS" | "AMOUNT_OUT_OF_RANGE" | "INVALID_ISO_CODE";
export type FinanceReportValueEvidenceFact =
  | { kind: "TEXT"; source: FinanceReportEvidenceSourceFact }
  | { kind: "AMOUNT"; source: FinanceReportEvidenceSourceFact; amountCents: number; numericFormat: FinanceReportNumericFormatV1; lexemeFormat: "REPORT" | "XLSX_CANONICAL" }
  | { kind: "ISO_CODE"; source: FinanceReportEvidenceSourceFact; code: string; registryVersion: typeof FINANCE_REPORT_ISO_4217_VERSION };
type BlockerFact = { kind: "BLOCKER"; code: FinanceReportValueEvidenceBlockerCode; claimId?: string };
export type FinanceReportValueEvidenceResultV1 =
  | { version: typeof FINANCE_REPORT_VALUE_EVIDENCE_VERSION; kind: "SUCCESS"; facts: FinanceReportValueEvidenceFact[] }
  | { version: typeof FINANCE_REPORT_VALUE_EVIDENCE_VERSION; kind: "BLOCKER"; facts: [BlockerFact] };

const DECIMALS: Record<FinanceReportDecimalSeparator, string> = { DOT: ".", COMMA: ",", NONE: "" };
const GROUPS: Record<FinanceReportGroupingSeparator, string> = {
  COMMA: ",", DOT: ".", APOSTROPHE: "'", SPACE: " ", NBSP: "\u00a0", NARROW_NBSP: "\u202f", NONE: "",
};
const SCALES = new Set<FinanceReportAmountScale>([1, 100, 1_000, 1_000_000, 1_000_000_000]);
const SYMBOLS = new Set(["$", "€", "£", "¥", "₹"]);
const ISO_CODES = new Set(FINANCE_REPORT_ISO_4217_CODES);
const INT_MIN = -2_147_483_648n;
const INT_MAX = 2_147_483_647n;
const BOUNDARY_SPACE = /^[ \t\u00a0\u202f]+|[ \t\u00a0\u202f]+$/g;

class ValueError extends Error {
  constructor(public readonly code: FinanceReportValueEvidenceBlockerCode, public readonly claimId?: string) {
    super(code);
  }
}

function fail(code: FinanceReportValueEvidenceBlockerCode, claimId?: string): never {
  throw new ValueError(code, claimId);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value)
    && !nodeTypes.isProxy(value) && [Object.prototype, null].includes(Object.getPrototypeOf(value));
}

function exactObject(value: unknown, keys: string[], code: FinanceReportValueEvidenceBlockerCode) {
  if (!isRecord(value)) fail(code);
  const descriptors = Object.getOwnPropertyDescriptors(value);
  const ownKeys = Reflect.ownKeys(descriptors);
  if (ownKeys.length !== keys.length || ownKeys.some((key) => typeof key !== "string" || !keys.includes(key))
    || keys.some((key) => !Object.hasOwn(descriptors, key))
    || Object.values(descriptors).some((descriptor) => !("value" in descriptor))) fail(code);
  return Object.fromEntries(keys.map((key) => [key, descriptors[key]!.value]));
}

function parseFormat(value: unknown) {
  const raw = exactObject(value, ["version", "decimalSeparator", "groupingSeparator", "amountScale"], "INVALID_NUMERIC_FORMAT");
  const decimals = new Set(Object.keys(DECIMALS));
  const groups = new Set(Object.keys(GROUPS));
  if (raw.version !== FINANCE_REPORT_VALUE_EVIDENCE_VERSION
    || typeof raw.decimalSeparator !== "string" || !decimals.has(raw.decimalSeparator)
    || typeof raw.groupingSeparator !== "string" || !groups.has(raw.groupingSeparator)
    || !SCALES.has(raw.amountScale as FinanceReportAmountScale)) fail("INVALID_NUMERIC_FORMAT");
  const format: FinanceReportNumericFormatV1 = {
    version: FINANCE_REPORT_VALUE_EVIDENCE_VERSION,
    decimalSeparator: raw.decimalSeparator as FinanceReportDecimalSeparator,
    groupingSeparator: raw.groupingSeparator as FinanceReportGroupingSeparator,
    amountScale: raw.amountScale as FinanceReportAmountScale,
  };
  const decimal = DECIMALS[format.decimalSeparator];
  const grouping = GROUPS[format.groupingSeparator];
  if (decimal && decimal === grouping) fail("INVALID_NUMERIC_FORMAT");
  return { format, decimal, grouping };
}

function trimBoundary(value: string) {
  return value.replace(BOUNDARY_SPACE, "");
}

function parseAmount(selectedText: string, parsed: ReturnType<typeof parseFormat>, claimId: string) {
  if (selectedText.length > 128) fail("LIMIT_EXCEEDED", claimId);
  if (/[A-Za-z%‰‱¢]/u.test(selectedText)) fail("UNSUPPORTED_PRESENTATION", claimId);
  let token = trimBoundary(selectedText);
  let negative = false;
  if (token.startsWith("(") && token.endsWith(")")) {
    negative = true;
    token = trimBoundary(token.slice(1, -1));
  } else if (token.includes("(") || token.includes(")")) fail("INVALID_AMOUNT", claimId);
  if (token.startsWith("-") || token.startsWith("−")) {
    if (negative) fail("INVALID_AMOUNT", claimId);
    negative = true;
    token = trimBoundary(token.slice(1));
  } else if (token.endsWith("-")) {
    if (negative) fail("INVALID_AMOUNT", claimId);
    negative = true;
    token = trimBoundary(token.slice(0, -1));
  }
  if (/[-−+]/u.test(token)) fail("INVALID_AMOUNT", claimId);
  const first = [...token][0];
  const last = [...token].at(-1);
  if (first && SYMBOLS.has(first)) token = trimBoundary(token.slice(first.length));
  if (last && SYMBOLS.has(last)) {
    if (first && SYMBOLS.has(first)) fail("INVALID_AMOUNT", claimId);
    token = trimBoundary(token.slice(0, -last.length));
  }
  const decimalParts = parsed.decimal ? token.split(parsed.decimal) : [token];
  if (decimalParts.length > 2) fail("INVALID_AMOUNT", claimId);
  const [integerPart = "", fraction = ""] = decimalParts;
  if (!integerPart || (decimalParts.length === 2 && !fraction)) fail("INVALID_AMOUNT", claimId);
  const groups = parsed.grouping ? integerPart.split(parsed.grouping) : [integerPart];
  if (!groups.every((group) => /^\d+$/.test(group))
    || (groups.length > 1 && (!/^\d{1,3}$/.test(groups[0]!) || groups.slice(1).some((group) => group.length !== 3)))) fail("INVALID_AMOUNT", claimId);
  const digits = groups.join("");
  if (!digits || (fraction && !/^\d+$/.test(fraction)) || digits.length + fraction.length > 100) fail("INVALID_AMOUNT", claimId);
  const denominator = 10n ** BigInt(fraction.length);
  const numerator = BigInt(digits + fraction) * BigInt(parsed.format.amountScale) * 100n;
  if (numerator % denominator !== 0n) fail("FRACTIONAL_CENTS", claimId);
  const signed = (negative ? -1n : 1n) * (numerator / denominator);
  if (signed < INT_MIN || signed > INT_MAX) fail("AMOUNT_OUT_OF_RANGE", claimId);
  return Number(signed);
}

function parseFact(fact: FinanceReportEvidenceSourceFact, parsed: ReturnType<typeof parseFormat>): FinanceReportValueEvidenceFact {
  if (fact.role === "TEXT") return { kind: "TEXT", source: fact };
  if (fact.role === "ISO_CODE") {
    if (!/^[A-Z]{3}$/.test(fact.selectedText) || !ISO_CODES.has(fact.selectedText)) fail("INVALID_ISO_CODE", fact.claimId);
    return { kind: "ISO_CODE", source: fact, code: fact.selectedText, registryVersion: FINANCE_REPORT_ISO_4217_VERSION };
  }
  const xlsxCanonical = fact.source.kind === "CELL" && fact.cell !== undefined
    && (fact.cell.type === "NUMBER" || (fact.cell.type === "FORMULA" && fact.cell.resultType === "NUMBER"));
  const lexemeFormat = xlsxCanonical ? "XLSX_CANONICAL" : "REPORT";
  const amountFormat = xlsxCanonical ? { ...parsed, decimal: ".", grouping: "" } : parsed;
  return { kind: "AMOUNT", source: fact, amountCents: parseAmount(fact.selectedText, amountFormat, fact.claimId),
    numericFormat: { ...parsed.format }, lexemeFormat };
}

export function validateFinanceReportValueEvidenceV1(input: unknown): FinanceReportValueEvidenceResultV1 {
  try {
    const raw = exactObject(input, ["sourceInput", "numericFormat"], "INVALID_INPUT");
    const parsed = parseFormat(raw.numericFormat);
    const sourceResult = validateFinanceReportEvidenceSourcesV1(raw.sourceInput);
    if (sourceResult.kind === "BLOCKER") {
      const blocker = sourceResult.facts[0];
      return { version: FINANCE_REPORT_VALUE_EVIDENCE_VERSION, kind: "BLOCKER", facts: [{ ...blocker }] };
    }
    return { version: FINANCE_REPORT_VALUE_EVIDENCE_VERSION, kind: "SUCCESS",
      facts: sourceResult.facts.map((fact) => parseFact(fact, parsed)) };
  } catch (error) {
    const blocker = error instanceof ValueError ? error : new ValueError("INVALID_INPUT");
    return { version: FINANCE_REPORT_VALUE_EVIDENCE_VERSION, kind: "BLOCKER",
      facts: [{ kind: "BLOCKER", code: blocker.code, ...(blocker.claimId ? { claimId: blocker.claimId } : {}) }] };
  }
}
