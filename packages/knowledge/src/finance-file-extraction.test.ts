import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { extractFinanceReportFile } from "./finance-file-extraction";

describe("extractFinanceReportFile", () => {
  it("preserves CSV source locations, quoting, whitespace, empty cells, and exact text", async () => {
    const input = Buffer.from('\uFEFFAccount,Amount,Note\r\n"Sales, Online",001.20,"two\nlines"\r\nCosts,"  ",');
    const result = await extractFinanceReportFile({ fileBuffer: input, fileName: "actuals.csv", mimeType: "text/csv" });
    expect(result.fileHash).toBe(createHash("sha256").update(input).digest("hex"));
    expect(result.sheets?.[0]).toMatchObject({ name: "CSV", rowCount: 3, columnCount: 3 });
    expect(result.sheets?.[0]?.cells).toEqual(expect.arrayContaining([
      { row: 2, column: 1, type: "TEXT", value: "Sales, Online" },
      { row: 2, column: 2, type: "TEXT", value: "001.20" },
      { row: 2, column: 3, type: "TEXT", value: "two\nlines" },
      { row: 3, column: 2, type: "TEXT", value: "  " },
    ]));
  });

  it("hashes, validates, and parses one immutable byte snapshot", async () => {
    const input = Buffer.from("Account,Amount\nRevenue,100");
    const hash = createHash("sha256").update(input).digest("hex");
    const extraction = extractFinanceReportFile({ fileBuffer: input, fileName: "actuals.csv", mimeType: "text/csv" });
    input.fill(0x2c);
    const result = await extraction;
    expect(result.fileHash).toBe(hash);
    expect(result.sheets[0]?.cells).toEqual(expect.arrayContaining([
      { row: 2, column: 1, type: "TEXT", value: "Revenue" },
      { row: 2, column: 2, type: "TEXT", value: "100" },
    ]));
  });

  it("preserves a non-BMP character split across byte chunks", async () => {
    const value = `${"a".repeat(65_535)}\u{1f600}`;
    const result = await extractFinanceReportFile({ fileBuffer: Buffer.from(value), fileName: "actuals.csv", mimeType: "text/csv" });
    expect(result.sheets?.[0]?.cells[0]?.value).toBe(value);
  });

  it("allows valid multibyte CSV text below the character limit", async () => {
    const value = "\u754c".repeat(9);
    const result = await extractFinanceReportFile({ fileBuffer: Buffer.from(value), fileName: "actuals.csv", mimeType: "text/csv", limits: { maxCells: 1, maxTextChars: 10 } });
    expect(result.sheets?.[0]?.cells[0]?.value).toBe(value);
  });

  it.each([
    [Buffer.alloc(0), "report.csv", "text/csv", {}, "EMPTY_FILE"],
    [Buffer.from("a,b\n1"), "report.csv", "text/csv", {}, "MALFORMED_FILE"],
    [Buffer.from("a"), "report.csv", "application/pdf", {}, "FILE_TYPE_MISMATCH"],
    [Buffer.from("a"), "report.txt", "text/plain", {}, "UNSUPPORTED_FILE_TYPE"],
    [Buffer.from("PK"), "report.xlsx", "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet", {}, "UNSUPPORTED_FILE_TYPE"],
    [Buffer.from(",\n,"), "report.csv", "text/csv", {}, "EMPTY_EXTRACTION"],
    [Buffer.from("a,b"), "report.csv", "text/csv", { maxFileBytes: 1 }, "FILE_TOO_LARGE"],
    [Buffer.from("a\n".repeat(20_001)), "report.csv", "text/csv", { maxRows: undefined }, "EXTRACTION_LIMIT_EXCEEDED"],
    [Buffer.from("a\n".repeat(20_001)), "report.csv", "text/csv", { maxRows: Number.NaN }, "EXTRACTION_LIMIT_EXCEEDED"],
    [Buffer.from("a\n".repeat(20_001)), "report.csv", "text/csv", { maxRows: Number.POSITIVE_INFINITY }, "EXTRACTION_LIMIT_EXCEEDED"],
    [Buffer.from("a\n".repeat(20_001)), "report.csv", "text/csv", { maxRows: 20_000.5 }, "EXTRACTION_LIMIT_EXCEEDED"],
    [Buffer.from("a\n".repeat(20_001)), "report.csv", "text/csv", { maxRows: -1 }, "EXTRACTION_LIMIT_EXCEEDED"],
    [Buffer.from("a,b"), "report.csv", "text/csv", { maxCells: 1 }, "EXTRACTION_LIMIT_EXCEEDED"],
    [Buffer.from(",".repeat(250_000)), "report.csv", "text/csv", {}, "EXTRACTION_LIMIT_EXCEEDED"],
    [Buffer.from("ab"), "report.csv", "text/csv", { maxTextChars: 1 }, "EXTRACTION_LIMIT_EXCEEDED"],
    [Buffer.from("%PDF-1.4"), "report.pdf", "application/pdf", {}, "UNSUPPORTED_FILE_TYPE"],
    [Buffer.from([0xff]), "report.csv", "text/csv", {}, "MALFORMED_FILE"],
  ])("fails the whole extraction with a safe code", async (fileBuffer, fileName, mimeType, limits, code) => {
    await expect(extractFinanceReportFile({ fileBuffer, fileName, mimeType, limits })).rejects.toMatchObject({ code });
  });
});
