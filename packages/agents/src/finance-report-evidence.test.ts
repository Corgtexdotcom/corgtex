import { describe, expect, it } from "vitest";
import * as evidenceApi from "./finance-report-evidence";
import { FINANCE_REPORT_EVIDENCE_VERSION, ISO_4217_REGISTRY_VERSION,
  validateFinanceReportEvidenceV1, type FinanceReportEvidenceClaim,
  type FinanceReportEvidenceFormat, type FinanceReportEvidenceSource } from "./finance-report-evidence";

const jsonl = (records: unknown[]) => records.map((record) => JSON.stringify(record)).join("\n");
const pdf = (text: string, extra: Record<string, unknown> = {}) => jsonl([{ page: 1, text, ...extra }]);
const sheet = (format: FinanceReportEvidenceFormat) => format === "CSV" ? "CSV" : "Synthetic";
function cells(format: "CSV" | "XLSX", records: Array<Record<string, unknown>>, name = sheet(format)) {
  return jsonl([{ sheet: name, rowCount: 10, columnCount: 10 },
    ...records.map((record, index) => ({ sheet: name, row: index + 1, column: 1, ...record }))]);
}
const pdfSource = (text: string): FinanceReportEvidenceSource => ({ kind: "PDF", page: 1, evidence: text });
const cellSource = (format: "CSV" | "XLSX", text: string, row = 1): FinanceReportEvidenceSource =>
  ({ kind: "CELL", sheet: sheet(format), row, column: 1, evidence: text });
const amountClaim = (source: FinanceReportEvidenceSource, amountCents: number, id = "amount"): FinanceReportEvidenceClaim =>
  ({ kind: "AMOUNT", id, source, amountCents });
const currencyClaim = (source: FinanceReportEvidenceSource, id = "currency"): FinanceReportEvidenceClaim =>
  ({ kind: "CURRENCY", id, source });
function validate(format: FinanceReportEvidenceFormat, extractedEvidence: string, claims: FinanceReportEvidenceClaim[]) {
  return validateFinanceReportEvidenceV1({ format, extractedEvidence, claims });
}
function blocker(result: ReturnType<typeof validate>, code?: string) {
  expect(result.facts).toEqual([expect.objectContaining({ kind: "BLOCKER", ...(code ? { code } : {}) })]);
}
function amountResult(format: FinanceReportEvidenceFormat, shown: string, cents: number, raw = shown) {
  if (format === "PDF") return validate(format, pdf(shown), [amountClaim(pdfSource(shown), cents)]);
  const value = format === "XLSX" ? raw : shown;
  const cell = { type: format === "XLSX" ? "NUMBER" : "TEXT", value,
    ...(format === "XLSX" && shown !== raw ? { displayValue: shown } : {}) };
  return validate(format, cells(format, [cell]), [amountClaim(cellSource(format, shown), cents)]);
}

describe("Finance report evidence validator v1", () => {
  it("exports only a dependency-free typed validation boundary", () => {
    expect(Object.keys(evidenceApi).sort()).toEqual([
      "FINANCE_REPORT_EVIDENCE_VERSION", "ISO_4217_REGISTRY_VERSION", "validateFinanceReportEvidenceV1",
    ]);
    const result = amountResult("PDF", "Revenue 1,250.00", 125_000);
    expect(result).toEqual({ version: 1, facts: [
      { kind: "SOURCE", claimId: "amount", source: pdfSource("Revenue 1,250.00") },
      { kind: "MATCH", claimId: "amount", sourceKey: expect.any(String) },
      { kind: "AMOUNT", claimId: "amount", amountCents: 125_000 },
    ] });
    expect(FINANCE_REPORT_EVIDENCE_VERSION).toBe(1);
  });

  it.each([
    ["19.99", 1_999], ["10.12", 1_012], ["0.29", 29], ["0", 0], ["1,250.00", 125_000],
    ["1.250,00", 125_000], ["($1,250.00)", -125_000], ["−$1,250.00", -125_000],
    ["$1,250.00-", -125_000], ["$1,250", 125_000], ["€1.250", 125_000],
    ["Revenue was $100.", 10_000], ["Revenue was $100, excluding tax", 10_000],
    ["€1 250,00", 125_000], ["€1 250,00", 125_000], ["€1 250,00", 125_000],
  ] as const)("binds complete exact amount lexeme %s", (shown, cents) => {
    for (const format of ["PDF", "CSV"] as const) expect(amountResult(format, shown, cents).facts.at(-1)).toMatchObject({ kind: "AMOUNT", amountCents: cents });
  });

  it("uses authoritative XLSX raw numeric values while supporting display formatting and numeric formulas", () => {
    expect(amountResult("XLSX", "$1,250.00", 125_000, "1250").facts.at(-1)).toMatchObject({ kind: "AMOUNT" });
    blocker(amountResult("XLSX", "$999.00", 99_900, "1250"), "AMOUNT_MISMATCH");
    const formula = cells("XLSX", [{ type: "FORMULA", value: "1250", displayValue: "$1,250",
      formula: "SUM(A2:A3)", resultType: "NUMBER" }]);
    expect(validate("XLSX", formula, [amountClaim(cellSource("XLSX", "$1,250"), 125_000)]).facts.at(-1))
      .toMatchObject({ kind: "AMOUNT" });
  });

  it.each([
    ["raw fractional", { type: "NUMBER", value: "1.234" }, "1.234", 123_400],
    ["date", { type: "DATE", value: "2026-01-01T00:00:00.000Z" }, "2026-01-01T00:00:00.000Z", 202_600],
    ["error", { type: "ERROR", value: "#DIV/0!" }, "#DIV/0!", 0],
    ["boolean", { type: "BOOLEAN", value: "1" }, "1", 100],
    ["text", { type: "TEXT", value: "19.99" }, "19.99", 1_999],
    ["nonnumeric formula", { type: "FORMULA", value: "19.99", formula: "A1", resultType: "TEXT" }, "19.99", 1_999],
  ] as const)("blocks unsafe XLSX %s amount source", (_label, cell, shown, cents) => {
    blocker(validate("XLSX", cells("XLSX", [cell]), [amountClaim(cellSource("XLSX", shown), cents)]));
  });

  it.each([
    ["scientific fraction", "1e-7", 100], ["scientific overflow", "1e+21", 100],
    ["spaced scientific", "1e 3", 300], ["spaced signed scientific", "1e+ 3", 300],
    ["NBSP scientific", "1e+ 3", 300],
    ["percent", "Gross margin 19.99%", 1_999], ["per-mille", "Loss 2‰", 200],
    ["percent word", "Gross margin 19.99 percent", 1_999], ["per cent words", "Margin 19.99 per cent", 1_999],
    ["per mille words", "Loss 2 per mille", 200], ["basis points", "Change 25 bps", 2_500],
    ["date fragment", "2026-01-01", 202_600], ["compound", "100/200", 10_000], ["colon compound", "12:30", 1_200],
    ["fiscal year", "FY 2026", 202_600], ["month year", "January 2026", 202_600],
    ["quarter year", "Q1 2026", 202_600], ["year fiscal", "2026 fiscal year", 202_600],
    ["thousands suffix", "$1.2M", 120], ["unit suffix", "1,250k", 125_000],
    ["million suffix", "$1 million", 100], ["billion suffix", "2 billion", 200], ["bn suffix", "3 bn", 300], ["mm suffix", "4 mm", 400],
    ["crore suffix", "1 crore", 100], ["lakh suffix", "2 lakh", 200], ["lac suffix", "3 lacs", 300],
    ["cent symbol", "50¢", 5_000], ["cent word", "50 cents", 5_000],
    ["prefix cent", "¢50", 5_000], ["prefix percent", "%19.99", 1_999], ["prefix per-mille", "‰2", 200],
    ["compact date", "20260101", 2_026_010_100], ["identifier", "GL-100", 10_000], ["trailing identifier", "100-GL", 10_000],
    ["decimal identifier", "INV-19.99", 1_999],
    ["typographic identifier", "GL–100", 10_000], ["typographic decimal identifier", "INV‐19.99", 1_999],
    ["underscore identifier", "GL_100", 10_000], ["slash identifier", "INV/19.99", 1_999],
    ["colon identifier", "PO:100", 10_000], ["hash identifier", "GL#100", 10_000],
    ["zero decimal ambiguity", "0.125", 12_500], ["zero comma ambiguity", "0,125", 12_500],
    ["thousand word", "1 thousand", 100], ["trillion word", "2 trillion", 200], ["tn suffix", "3 tn", 300], ["mn suffix", "5 mn", 500],
    ["bounded long token", "1".repeat(50_000), 0],
    ["fractional cents", "1.2345", 123], ["separator ambiguity", "1,23,4", 123_400],
    ["overflow", "21,474,836.48", 0], ["repeated amount", "10.00 10.00", 1_000],
    ["multiple values", "Actual 10.00 Budget 20.00", 1_000],
  ] as const)("blocks unsafe PDF/CSV amount evidence: %s", (_label, shown, cents) => {
    for (const format of ["PDF", "CSV"] as const) blocker(amountResult(format, shown, cents));
  });

  it("supports PostgreSQL Int amount bounds", () => {
    expect(amountResult("PDF", "21,474,836.47", 2_147_483_647).facts.at(-1)).toMatchObject({ kind: "AMOUNT" });
    expect(amountResult("CSV", "(21,474,836.48)", -2_147_483_648).facts.at(-1)).toMatchObject({ kind: "AMOUNT" });
  });

  it.each([
    ["ALL AMOUNTS IN USD", "USD"], ["Currency: ALL", "ALL"], ["XAU", "XAU"], ["Currency: CLF", "CLF"],
    ["Currency: USN", "USN"], ["Currency: CHE", "CHE"], ["Currency: CHW", "CHW"],
  ])("resolves contextual complete-registry currency evidence %s", (shown, code) => {
    const result = validate("CSV", cells("CSV", [{ type: "TEXT", value: shown }]), [currencyClaim(cellSource("CSV", shown))]);
    expect(result.facts.at(-1)).toEqual({ kind: "CURRENCY", claimId: "currency", state: "EXPLICIT", code,
      registryVersion: ISO_4217_REGISTRY_VERSION });
  });

  it("rejects true mixed or malformed currency and never defaults unresolved evidence", () => {
    for (const shown of ["USD / EUR", "USD and EUR", "USD, EUR", "USD & EUR",
      "Amounts in USD; prior year in EUR", "Currency: USD and EUR", "Currency: USD, EUR"]) {
      blocker(validate("PDF", pdf(shown), [currencyClaim(pdfSource(shown))]), "MULTI_CURRENCY");
    }
    for (const shown of ["Currency: ZZZ", "Currency: usd", "Currency: USD and ZZZ", "Currency: USD and eur",
      "USD and ZZZ", "Amounts in ZZZ", "Currency: US1", "Currency: U", "Currency: USDXX", "CCY=12"]) {
      blocker(validate("CSV", cells("CSV", [{ type: "TEXT", value: shown }]), [currencyClaim(cellSource("CSV", shown))]), "INVALID_CURRENCY");
    }
    const unresolved = validate("PDF", pdf("Denomination unavailable"), [currencyClaim(pdfSource("Denomination unavailable"))]);
    expect(unresolved.facts.at(-1)).toMatchObject({ kind: "CURRENCY", state: "UNRESOLVED", code: null });
    const ordinaryAll = validate("PDF", pdf("Amounts included in ALL departments"), [currencyClaim(pdfSource("Amounts included in ALL departments"))]);
    expect(ordinaryAll.facts.at(-1)).toMatchObject({ kind: "CURRENCY", state: "UNRESOLVED", code: null });
    for (const shown of ["Currency unavailable", "CCY: not specified"]) {
      expect(validate("PDF", pdf(shown), [currencyClaim(pdfSource(shown))]).facts.at(-1))
        .toMatchObject({ kind: "CURRENCY", state: "UNRESOLVED", code: null });
    }
  });

  it("limits currency lists to the actual contextual clause", () => {
    for (const shown of ["Amounts in USD, reported in the notes", "Currency: USD and tax excluded",
      "Currency: USD and VAT excluded"]) {
      expect(validate("PDF", pdf(shown), [currencyClaim(pdfSource(shown))]).facts.at(-1))
        .toMatchObject({ kind: "CURRENCY", state: "EXPLICIT", code: "USD" });
    }
    expect(validate("PDF", pdf("Narrative reported in PDF"), [currencyClaim(pdfSource("Narrative reported in PDF"))]).facts.at(-1))
      .toMatchObject({ kind: "CURRENCY", state: "UNRESOLVED", code: null });
  });

  it("indexes once by exact identifiers and rejects duplicate, ambiguous, or overlapping claims", () => {
    const spaced = cells("CSV", [{ type: "TEXT", value: "10.00" }, { type: "TEXT", value: "  " }], " CSV ");
    const exact = { kind: "CELL", sheet: " CSV ", row: 1, column: 1, evidence: "10.00" } as const;
    expect(validate("CSV", spaced, [amountClaim(exact, 1_000)]).facts[0]).toMatchObject({ source: exact });
    blocker(validate("PDF", pdf("Revenue 10.00\nRevenue 10.00"), [amountClaim(pdfSource("Revenue 10.00"), 1_000)]), "AMBIGUOUS_SOURCE");
    const duplicate = amountClaim(exact, 1_000, "duplicate");
    blocker(validate("CSV", spaced, [amountClaim(exact, 1_000), duplicate]), "DUPLICATE_CLAIM");
    const many = Array.from({ length: 100 }, (_, index) => `${index + 1}.00`);
    const claims = many.map((line, index) => amountClaim(pdfSource(line), (index + 1) * 100, `claim-${index}`));
    expect(validate("PDF", pdf(many.join("\n")), claims).facts.filter((fact) => fact.kind === "MATCH")).toHaveLength(100);
  });

  it.each([
    ["malformed JSON", "PDF", "{bad", amountClaim(pdfSource("x"), 0)],
    ["unknown page field", "PDF", pdf("10", { secret: true }), amountClaim(pdfSource("10"), 1_000)],
    ["blank PDF", "PDF", pdf(" \n"), amountClaim(pdfSource(" "), 0)],
    ["duplicate coordinate", "CSV", `${cells("CSV", [{ type: "TEXT", value: "10" }])}\n${JSON.stringify({ sheet: "CSV", row: 1, column: 1, type: "TEXT", value: "10" })}`, amountClaim(cellSource("CSV", "10"), 1_000)],
    ["result type on non-formula", "XLSX", cells("XLSX", [{ type: "NUMBER", value: "10", resultType: "NUMBER" }]), amountClaim(cellSource("XLSX", "10"), 1_000)],
  ] as const)("fails closed on %s", (_label, format, extracted, claim) => blocker(validate(format, extracted, [claim])));

  it("rejects aliases, mixed coordinates, sheet metadata claims, unknown input, and budgets", () => {
    const source = cellSource("CSV", "10") as any; source.page = 1;
    blocker(validate("CSV", cells("CSV", [{ type: "TEXT", value: "10" }]), [amountClaim(source, 1_000)]));
    const alias = { kind: "CELL", sheet: "CSV", row: 1, columnName: "A", evidence: "10" } as any;
    blocker(validate("CSV", cells("CSV", [{ type: "TEXT", value: "10" }]), [amountClaim(alias, 1_000)]));
    blocker(validate("CSV", jsonl([{ sheet: "CSV", rowCount: 1, columnCount: 1 }]),
      [{ kind: "SOURCE", id: "meta", source: cellSource("CSV", "CSV") }]));
    blocker(validateFinanceReportEvidenceV1({ format: "PDF", extractedEvidence: pdf("10"), claims: [], extra: true } as any), "INVALID_INPUT");
    blocker(validateFinanceReportEvidenceV1({ format: "PDF", extractedEvidence: "x".repeat(2_000_001),
      claims: [amountClaim(pdfSource("x"), 0)] }), "LIMIT_EXCEEDED");
    const tooMany = Array.from({ length: 1_001 }, (_, index) => amountClaim(pdfSource("10"), 1_000, `c${index}`));
    blocker(validate("PDF", pdf("10"), tooMany), "INVALID_INPUT");
  });
});
