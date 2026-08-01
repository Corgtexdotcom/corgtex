import { describe, expect, it } from "vitest";
import {
  FINANCE_REPORT_ISO_4217_CODES,
  FINANCE_REPORT_ISO_4217_VERSION,
  FINANCE_REPORT_VALUE_EVIDENCE_VERSION,
  validateFinanceReportValueEvidenceV1,
  type FinanceReportNumericFormatV1,
} from "./finance-report-value-evidence";

const DEFAULT_FORMAT: FinanceReportNumericFormatV1 = {
  version: 1,
  decimalSeparator: "DOT",
  groupingSeparator: "COMMA",
  amountScale: 1,
};

function sourceInput(text: string, role: "AMOUNT" | "ISO_CODE" | "TEXT" = "AMOUNT",
  sourceFormat: "PDF" | "CSV" | "XLSX" = "PDF", displayValue?: string) {
  if (sourceFormat === "PDF") return {
    format: "PDF",
    extractedEvidence: JSON.stringify({ page: 1, text }),
    claims: [{ id: "claim-1", role, source: { kind: "PDF", page: 1, lineIndex: 0,
      line: text, start: 0, end: text.length, text } }],
  };
  const sheet = sourceFormat === "CSV" ? "CSV" : "Sheet 1";
  const type = sourceFormat === "XLSX" && role === "AMOUNT" ? "NUMBER" : "TEXT";
  const records = [
    { sheet, rowCount: 1, columnCount: 1 },
    { sheet, row: 1, column: 1, type, value: text, ...(displayValue === undefined ? {} : { displayValue }) },
  ];
  return { format: sourceFormat, extractedEvidence: records.map((record) => JSON.stringify(record)).join("\n"),
    claims: [{ id: "claim-1", role, source: { kind: "CELL", sheet, row: 1, column: 1, evidence: text } }] };
}

function input(text: string, numericFormat: FinanceReportNumericFormatV1 = DEFAULT_FORMAT,
  sourceFormat: "PDF" | "CSV" | "XLSX" = "PDF", displayValue?: string) {
  return { sourceInput: sourceInput(text, "AMOUNT", sourceFormat, displayValue), numericFormat };
}

function amount(text: string, numericFormat: FinanceReportNumericFormatV1 = DEFAULT_FORMAT,
  sourceFormat: "PDF" | "CSV" | "XLSX" = "PDF", displayValue?: string) {
  const result = validateFinanceReportValueEvidenceV1(input(text, numericFormat, sourceFormat, displayValue));
  expect(result.kind).toBe("SUCCESS");
  if (result.kind !== "SUCCESS" || result.facts[0]?.kind !== "AMOUNT") throw new Error("expected amount fact");
  return result.facts[0];
}

function blocker(value: unknown) {
  const result = validateFinanceReportValueEvidenceV1(value);
  expect(result.kind).toBe("BLOCKER");
  if (result.kind !== "BLOCKER") throw new Error("expected blocker");
  return result.facts[0];
}

describe("validateFinanceReportValueEvidenceV1", () => {
  it("proves PDF, CSV, and authoritative XLSX raw amounts", () => {
    expect(amount("1,234.50").amountCents).toBe(123_450);
    expect(amount("1,234.50", DEFAULT_FORMAT, "CSV").amountCents).toBe(123_450);
    const xlsx = amount("1234.5", { ...DEFAULT_FORMAT, decimalSeparator: "COMMA", groupingSeparator: "DOT" }, "XLSX", "€1.234,50");
    expect(xlsx.amountCents).toBe(123_450);
    expect(xlsx.lexemeFormat).toBe("XLSX_CANONICAL");
    expect(xlsx.source.selectedText).toBe("1234.5");
    expect((xlsx.source as { cell?: { displayValue?: string } }).cell?.displayValue).toBe("€1.234,50");
  });

  it("uses canonical raw results from XLSX numeric formulas", () => {
    const records = [{ sheet: "S", rowCount: 1, columnCount: 1 },
      { sheet: "S", row: 1, column: 1, type: "FORMULA", value: "1234.5", displayValue: "€1.234,50", formula: "A1*2", resultType: "NUMBER" }];
    const source = { format: "XLSX", extractedEvidence: records.map((record) => JSON.stringify(record)).join("\n"),
      claims: [{ id: "formula", role: "AMOUNT", source: { kind: "CELL", sheet: "S", row: 1, column: 1, evidence: "1234.5" } }] };
    const result = validateFinanceReportValueEvidenceV1({ sourceInput: source,
      numericFormat: { ...DEFAULT_FORMAT, decimalSeparator: "COMMA", groupingSeparator: "DOT" } });
    expect(result).toMatchObject({ kind: "SUCCESS", facts: [{ kind: "AMOUNT", amountCents: 123_450, lexemeFormat: "XLSX_CANONICAL" }] });
  });

  it("evaluates source-validated XLSX canonical exponents with exact scale arithmetic", () => {
    const scaled = { ...DEFAULT_FORMAT, amountScale: 1_000_000_000 } as const;
    expect(amount("1e-7", scaled, "XLSX").amountCents).toBe(10_000);
    expect(blocker(input("1e-7", DEFAULT_FORMAT, "XLSX")).code).toBe("FRACTIONAL_CENTS");
    const records = [{ sheet: "S", rowCount: 1, columnCount: 1 },
      { sheet: "S", row: 1, column: 1, type: "FORMULA", value: "-1.25e-7", formula: "A1*2", resultType: "NUMBER" }];
    const source = { format: "XLSX", extractedEvidence: records.map((record) => JSON.stringify(record)).join("\n"),
      claims: [{ id: "formula-exp", role: "AMOUNT", source: { kind: "CELL", sheet: "S", row: 1, column: 1, evidence: "-1.25e-7" } }] };
    expect(validateFinanceReportValueEvidenceV1({ sourceInput: source, numericFormat: scaled }))
      .toMatchObject({ kind: "SUCCESS", facts: [{ kind: "AMOUNT", amountCents: -12_500, lexemeFormat: "XLSX_CANONICAL" }] });
  });

  it.each([
    ["DOT", "COMMA", "1,234,567.89", 123_456_789],
    ["COMMA", "DOT", "1.234.567,89", 123_456_789],
    ["DOT", "APOSTROPHE", "1'234'567.89", 123_456_789],
    ["DOT", "SPACE", "1 234 567.89", 123_456_789],
    ["COMMA", "NBSP", "1\u00a0234\u00a0567,89", 123_456_789],
    ["COMMA", "NARROW_NBSP", "1\u202f234\u202f567,89", 123_456_789],
    ["NONE", "COMMA", "1,234,567", 123_456_700],
    ["DOT", "NONE", "1234567.89", 123_456_789],
  ] as const)("uses explicit %s/%s separators", (decimalSeparator, groupingSeparator, text, expected) => {
    expect(amount(text, { version: 1, decimalSeparator, groupingSeparator, amountScale: 1 }).amountCents).toBe(expected);
  });

  it("allows ungrouped values under a configured optional grouping separator", () => {
    expect(amount("1234.56").amountCents).toBe(123_456);
    expect(amount("1234,56", { version: 1, decimalSeparator: "COMMA", groupingSeparator: "DOT", amountScale: 1 }).amountCents).toBe(123_456);
  });

  it.each([1, 100, 1_000, 1_000_000, 1_000_000_000] as const)("applies exact scale %i", (amountScale) => {
    const fact = amount("0.01", { ...DEFAULT_FORMAT, amountScale });
    expect(fact.amountCents).toBe(amountScale);
    expect(fact.numericFormat).toEqual({ ...DEFAULT_FORMAT, amountScale });
  });

  it.each([
    ["-1.23", -123], ["−1.23", -123], ["1.23-", -123], ["(1.23)", -123],
    ["$1.23", 123], ["1.23€", 123], ["£ 1.23", 123], ["¥1.23", 123], ["₹1.23", 123], ["-0", 0],
  ] as const)("parses closed sign and symbol form %s", (text, expected) => {
    expect(amount(text, { ...DEFAULT_FORMAT, groupingSeparator: "NONE" }).amountCents).toBe(expected);
  });

  it("uses exact cents and PostgreSQL Int boundaries", () => {
    const plain = { ...DEFAULT_FORMAT, groupingSeparator: "NONE" } as const;
    expect(amount("21474836.47", plain).amountCents).toBe(2_147_483_647);
    expect(amount("-21474836.48", plain).amountCents).toBe(-2_147_483_648);
    expect(blocker(input("21474836.48", plain)).code).toBe("AMOUNT_OUT_OF_RANGE");
    expect(blocker(input("-21474836.49", plain)).code).toBe("AMOUNT_OUT_OF_RANGE");
    expect(blocker(input("0.001", plain)).code).toBe("FRACTIONAL_CENTS");
    expect(amount("0.001", { ...plain, amountScale: 100 }).amountCents).toBe(10);
  });

  it.each(["--1", "(1)-", "-1-", "$€1", "₽1", "1,23,4.00", "1.", ".1", "1.2.3"])("blocks malformed amount %s", (text) => {
    expect(blocker(input(text)).code).toBe("INVALID_AMOUNT");
  });

  it("blocks unconfigured separators and conflicting formats", () => {
    expect(blocker(input("1,234", { ...DEFAULT_FORMAT, groupingSeparator: "NONE" })).code).toBe("INVALID_AMOUNT");
    expect(blocker(input("1", { ...DEFAULT_FORMAT, groupingSeparator: "DOT" })).code).toBe("INVALID_NUMERIC_FORMAT");
    expect(blocker(input("1", { ...DEFAULT_FORMAT, decimalSeparator: "COMMA" })).code).toBe("INVALID_NUMERIC_FORMAT");
  });

  it.each(["1e3", "1E+3", "1%", "1‰", "1‱", "1bp", "1c", "1K", "1 million", "1CR", "1 DR"])("blocks presentation modifier %s", (text) => {
    expect(blocker(input(text)).code).toBe("UNSUPPORTED_PRESENTATION");
  });

  it("validates the complete pinned ISO registry without resolving currency", () => {
    const text = FINANCE_REPORT_ISO_4217_CODES.join("\n");
    const claims = FINANCE_REPORT_ISO_4217_CODES.map((code, lineIndex) => ({ id: `iso-${lineIndex}`, role: "ISO_CODE",
      source: { kind: "PDF", page: 1, lineIndex, line: code, start: 0, end: 3, text: code } }));
    const result = validateFinanceReportValueEvidenceV1({ sourceInput: { format: "PDF",
      extractedEvidence: JSON.stringify({ page: 1, text }), claims }, numericFormat: DEFAULT_FORMAT });
    expect(FINANCE_REPORT_ISO_4217_VERSION).toBe("2026-01-01");
    expect(FINANCE_REPORT_ISO_4217_CODES).toHaveLength(178);
    expect(new Set(FINANCE_REPORT_ISO_4217_CODES).size).toBe(178);
    expect(result.kind).toBe("SUCCESS");
    if (result.kind === "SUCCESS") expect(result.facts.map((fact) => fact.kind === "ISO_CODE" ? fact.code : "")).toEqual(FINANCE_REPORT_ISO_4217_CODES);
  });

  it.each(["BGN", "ANG", "usd", "US", "ZZZ", "USD "])("blocks non-current or malformed ISO code %s", (code) => {
    expect(blocker({ sourceInput: sourceInput(code, "ISO_CODE"), numericFormat: DEFAULT_FORMAT }).code).toBe("INVALID_ISO_CODE");
  });

  it("preserves R1a blockers and successful fact order", () => {
    expect(blocker({ sourceInput: {}, numericFormat: DEFAULT_FORMAT }).code).toBe("INVALID_INPUT");
    const lines = ["Revenue", "1.00", "USD"];
    const claims = lines.map((text, lineIndex) => ({ id: `c-${lineIndex}`, role: ["TEXT", "AMOUNT", "ISO_CODE"][lineIndex],
      source: { kind: "PDF", page: 1, lineIndex, line: text, start: 0, end: text.length, text } }));
    const result = validateFinanceReportValueEvidenceV1({ sourceInput: { format: "PDF",
      extractedEvidence: JSON.stringify({ page: 1, text: lines.join("\n") }), claims }, numericFormat: DEFAULT_FORMAT });
    expect(result).toMatchObject({ version: FINANCE_REPORT_VALUE_EVIDENCE_VERSION, kind: "SUCCESS" });
    if (result.kind === "SUCCESS") expect(result.facts.map((fact) => fact.kind)).toEqual(["TEXT", "AMOUNT", "ISO_CODE"]);
  });

  it("fails closed on adversarial R1b shapes and length, deterministically", () => {
    expect(blocker({ ...input("1"), extra: true }).code).toBe("INVALID_INPUT");
    expect(blocker(new Proxy(input("1"), {})).code).toBe("INVALID_INPUT");
    let getterCalled = false;
    const accessorFormat = Object.defineProperties({}, {
      version: { value: 1, enumerable: true }, decimalSeparator: { value: "DOT", enumerable: true },
      groupingSeparator: { value: "NONE", enumerable: true },
      amountScale: { get: () => { getterCalled = true; return 1; }, enumerable: true },
    });
    expect(blocker({ sourceInput: sourceInput("1"), numericFormat: accessorFormat }).code).toBe("INVALID_NUMERIC_FORMAT");
    expect(getterCalled).toBe(false);
    expect(blocker(input("1", { ...DEFAULT_FORMAT, amountScale: 10 as 1 })).code).toBe("INVALID_NUMERIC_FORMAT");
    expect(blocker(input("1", { ...DEFAULT_FORMAT, version: 2 as 1 })).code).toBe("INVALID_NUMERIC_FORMAT");
    expect(blocker(input("1".repeat(129), { ...DEFAULT_FORMAT, groupingSeparator: "NONE" })).code).toBe("LIMIT_EXCEEDED");
    expect(validateFinanceReportValueEvidenceV1(input("1.23"))).toEqual(validateFinanceReportValueEvidenceV1(input("1.23")));
  });
});
