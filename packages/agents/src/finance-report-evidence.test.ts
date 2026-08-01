import { describe, expect, it } from "vitest";
import { validateFinanceReportEvidenceSourcesV1 } from "./finance-report-evidence";

const jsonl = (...records: unknown[]) => records.map((record) => JSON.stringify(record)).join("\n");
const pdfSource = (line: string, text: string, lineIndex = 0, page = 1) => {
  const start = line.indexOf(text);
  return { kind: "PDF", page, lineIndex, line, start, end: start + text.length, text } as const;
};
const cellSource = (evidence: string, extra: Record<string, unknown> = {}) =>
  ({ kind: "CELL", sheet: "Report", row: 1, column: 1, evidence, ...extra } as const);
const validate = (format: "PDF" | "CSV" | "XLSX", extractedEvidence: string, claims: unknown[]) =>
  validateFinanceReportEvidenceSourcesV1({ format, extractedEvidence, claims });
const code = (result: ReturnType<typeof validate>) => result.facts[0]?.kind === "BLOCKER"
  ? result.facts[0].code : undefined;
const astral = String.fromCodePoint(0x1f600);

describe("validateFinanceReportEvidenceSourcesV1", () => {
  it("binds repeated PDF lines and multiple non-overlapping UTF-16 spans", () => {
    const line = `Revenue ${astral} 100 200`;
    const extracted = jsonl({ page: 1, text: `Header\n\n${line}\n${line}` });
    const result = validate("PDF", extracted, [
      { id: "current", role: "AMOUNT", source: pdfSource(line, "100", 2) },
      { id: "prior", role: "AMOUNT", source: pdfSource(line, "200", 2) },
      { id: "repeat", role: "TEXT", source: pdfSource(line, astral, 3) },
    ]);
    expect(result.facts.map((fact) => fact.kind)).toEqual(["SOURCE", "SOURCE", "SOURCE"]);
    expect(result.facts.map((fact) => fact.kind === "SOURCE" && fact.sourceKey)).toEqual([
      '["PDF",1,2,11,14]', '["PDF",1,2,15,18]', '["PDF",1,3,8,10]',
    ]);
  });

  it("blocks missing, overlapping, duplicate, blank, and unsafe UTF-16 PDF claims", () => {
    const line = `${astral} 100 200`;
    const extracted = jsonl({ page: 1, text: `${line}\n\n${line}` });
    const base = { id: "a", role: "TEXT", source: pdfSource(line, "100") };
    const cases: Array<[unknown[], string]> = [
      [[base, { ...base }], "DUPLICATE_CLAIM"],
      [[base, { id: "b", role: "TEXT", source: { ...pdfSource(line, "100"), end: 8, text: "100 2" } }], "OVERLAPPING_SOURCE"],
      [[{ id: "a", role: "TEXT", source: { ...pdfSource(line, astral), start: 1 } }], "SOURCE_NOT_FOUND"],
      [[{ id: "a", role: "TEXT", source: { ...pdfSource(line, "100"), lineIndex: 1, line: "" } }], "INVALID_INPUT"],
      [[{ id: "a", role: "TEXT", source: { ...pdfSource(line, "100"), page: 2 } }], "SOURCE_NOT_FOUND"],
    ];
    for (const [claims, expected] of cases) expect(code(validate("PDF", extracted, claims))).toBe(expected);
  });

  it("binds exact CSV amount cells and text subspans", () => {
    const extracted = jsonl(
      { sheet: "Report", rowCount: 1, columnCount: 2 },
      { sheet: "Report", row: 1, column: 1, type: "TEXT", value: "1,234.50" },
      { sheet: "Report", row: 1, column: 2, type: "TEXT", value: "Currency USD" },
    );
    const result = validate("CSV", extracted, [
      { id: "amount", role: "AMOUNT", source: cellSource("1,234.50") },
      { id: "iso", role: "ISO_CODE", source: cellSource("Currency USD",
        { column: 2, start: 9, end: 12, text: "USD" }) },
    ]);
    expect(result.facts).toMatchObject([
      { kind: "SOURCE", selectedText: "1,234.50", cell: { type: "TEXT", rawValue: "1,234.50" } },
      { kind: "SOURCE", sourceKey: '["CELL","Report",1,2,9,12]', selectedText: "USD",
        cell: { rawValue: "Currency USD" } },
    ]);
  });

  it("uses only raw XLSX numbers or numeric formula results for amount roles", () => {
    const extracted = jsonl(
      { sheet: "Report", rowCount: 1, columnCount: 3 },
      { sheet: "Report", row: 1, column: 1, type: "NUMBER", value: "1234.5", displayValue: "$1,234.50" },
      { sheet: "Report", row: 1, column: 2, type: "FORMULA", value: "20", displayValue: "$20", formula: "A1/2", resultType: "NUMBER" },
      { sheet: "Report", row: 1, column: 3, type: "TEXT", value: "30" },
    );
    const good = validate("XLSX", extracted, [
      { id: "raw", role: "AMOUNT", source: cellSource("1234.5") },
      { id: "formula", role: "AMOUNT", source: cellSource("20", { column: 2 }) },
    ]);
    expect(good.facts).toMatchObject([
      { kind: "SOURCE", selectedText: "1234.5", cell: { rawValue: "1234.5", displayValue: "$1,234.50" } },
      { kind: "SOURCE", cell: { type: "FORMULA", resultType: "NUMBER" } },
    ]);
    expect(code(validate("XLSX", extracted,
      [{ id: "display", role: "AMOUNT", source: cellSource("$1,234.50") }]))).toBe("SOURCE_NOT_FOUND");
    expect(code(validate("XLSX", extracted,
      [{ id: "text", role: "AMOUNT", source: cellSource("30", { column: 3 }) }]))).toBe("UNSAFE_CELL");
  });

  it("blocks incompatible whole-cell reuse and mixed source formats", () => {
    const extracted = jsonl({ sheet: "Report", rowCount: 1, columnCount: 1 },
      { sheet: "Report", row: 1, column: 1, type: "TEXT", value: "USD 10" });
    expect(code(validate("CSV", extracted, [
      { id: "amount", role: "AMOUNT", source: cellSource("USD 10") },
      { id: "iso", role: "ISO_CODE", source: cellSource("USD 10", { start: 0, end: 3, text: "USD" }) },
    ]))).toBe("OVERLAPPING_SOURCE");
    expect(code(validate("CSV", extracted,
      [{ id: "pdf", role: "TEXT", source: pdfSource("USD 10", "USD") }]))).toBe("SOURCE_NOT_FOUND");
  });

  it("fails closed on malformed extractor JSONL and bounded input", () => {
    const validCell = { sheet: "Report", row: 1, column: 1, type: "TEXT", value: "10" };
    const malformed = [
      "not-json",
      jsonl({ page: 1, text: "10", extra: true }),
      jsonl({ page: 1, text: "10" }, { page: 1, text: "20" }),
      jsonl(validCell, { sheet: "Report", rowCount: 1, columnCount: 1 }),
      jsonl({ sheet: "Report", rowCount: 1, columnCount: 1 }, validCell, validCell),
      jsonl({ sheet: "Report", rowCount: 1, columnCount: 1 },
        { ...validCell, type: "FORMULA", formula: "1+1" }),
    ];
    expect(code(validate("PDF", malformed[0]!, [{ id: "a", role: "TEXT", source: pdfSource("10", "10") }]))).toBe("MALFORMED_EVIDENCE");
    for (const evidence of malformed.slice(1, 3)) {
      expect(code(validate("PDF", evidence, [{ id: "a", role: "TEXT", source: pdfSource("10", "10") }]))).toBe("MALFORMED_EVIDENCE");
    }
    for (const evidence of malformed.slice(3)) {
      expect(code(validate("CSV", evidence, [{ id: "a", role: "AMOUNT", source: cellSource("10") }]))).toBe("MALFORMED_EVIDENCE");
    }
    expect(code(validate("PDF", "x".repeat(2_000_001),
      [{ id: "a", role: "TEXT", source: pdfSource("x", "x") }]))).toBe("LIMIT_EXCEEDED");
    expect(code(validate("PDF", jsonl({ page: 1, text: "\n".repeat(250_000) }),
      [{ id: "a", role: "TEXT", source: pdfSource("x", "x") }]))).toBe("LIMIT_EXCEEDED");
  });

  it("returns deterministic source-only facts and validates the closed input shape", () => {
    const extracted = jsonl({ page: 1, text: "Revenue 10" });
    const claims = [{ id: "amount", role: "AMOUNT", source: pdfSource("Revenue 10", "10") }];
    const first = validate("PDF", extracted, claims);
    expect(validate("PDF", extracted, claims)).toEqual(first);
    expect(Object.keys(first.facts[0] ?? {})).not.toEqual(expect.arrayContaining([
      "amountCents", "currency", "proposal", "transaction", "persistence",
    ]));
    expect(code(validateFinanceReportEvidenceSourcesV1({ format: "PDF", extractedEvidence: extracted,
      claims, extra: true }))).toBe("INVALID_INPUT");
    expect(code(validate("PDF", extracted, [{ ...claims[0], source: { ...claims[0]!.source, extra: true } }]))).toBe("INVALID_INPUT");
    expect(code(validate("PDF", extracted, Array.from({ length: 1_001 }, (_, index) =>
      ({ id: String(index), role: "TEXT", source: pdfSource("Revenue 10", "10") }))))).toBe("INVALID_INPUT");
  });
});
