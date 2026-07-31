import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { extractFinanceReportFile } from "./finance-file-extraction";

function pdf(...texts: string[]) {
  const pageIds = texts.map((_, index) => 4 + (index * 2));
  const objects = [
    "<< /Type /Catalog /Pages 2 0 R >>",
    `<< /Type /Pages /Kids [${pageIds.map((id) => `${id} 0 R`).join(" ")}] /Count ${texts.length} >>`,
    "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>",
    ...texts.flatMap((text, index) => {
      const parts = text.split("|").map((part) => part.replace(/[()\\]/g, "\\$&"));
      const stream = `BT /F1 12 Tf 72 720 Td (${parts[0]}) Tj${parts[1] === undefined ? "" : ` 144 0 Td (${parts[1]}) Tj`} ET`;
      return [
        `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 3 0 R >> >> /Contents ${pageIds[index] + 1} 0 R >>`,
        `<< /Length ${Buffer.byteLength(stream)} >>\nstream\n${stream}\nendstream`,
      ];
    }),
  ];
  let body = "%PDF-1.4\n";
  const offsets = objects.map((object, index) => {
    const offset = Buffer.byteLength(body);
    body += `${index + 1} 0 obj\n${object}\nendobj\n`;
    return offset;
  });
  const xref = Buffer.byteLength(body);
  const size = objects.length + 1;
  body += `xref\n0 ${size}\n0000000000 65535 f \n${offsets.map((offset) => `${String(offset).padStart(10, "0")} 00000 n `).join("\n")}\n`;
  return Buffer.from(`${body}trailer\n<< /Size ${size} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF`);
}

describe("extractFinanceReportFile", () => {
  it("streams PDF pages without trimming and rejects partial scans or excess pages", async () => {
    const result = await extractFinanceReportFile({ fileBuffer: pdf("Revenue|100.00"), fileName: "report.pdf", mimeType: "application/pdf" });
    expect(result).toMatchObject({ format: "PDF", mimeType: "application/pdf", pages: [{ page: 1, text: "Revenue 100.00" }] });
    await expect(extractFinanceReportFile({ fileBuffer: pdf("Revenue", ""), fileName: "mixed.pdf", mimeType: "application/pdf" })).rejects.toMatchObject({ code: "SCANNED_PDF_UNSUPPORTED" });
    await expect(extractFinanceReportFile({ fileBuffer: pdf("one", "two"), fileName: "long.pdf", mimeType: "application/pdf", limits: { maxPages: 1 } })).rejects.toMatchObject({ code: "EXTRACTION_LIMIT_EXCEEDED" });
  });

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

  it("preserves a non-BMP character split across byte chunks", async () => {
    const value = `${"a".repeat(65_535)}\u{1f600}`;
    const result = await extractFinanceReportFile({ fileBuffer: Buffer.from(value), fileName: "actuals.csv", mimeType: "text/csv" });
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
    [Buffer.from("a,b"), "report.csv", "text/csv", { maxCells: 1 }, "EXTRACTION_LIMIT_EXCEEDED"],
    [Buffer.from(",".repeat(250_000)), "report.csv", "text/csv", {}, "EXTRACTION_LIMIT_EXCEEDED"],
    [Buffer.from("ab"), "report.csv", "text/csv", { maxTextChars: 1 }, "EXTRACTION_LIMIT_EXCEEDED"],
    [pdf("Revenue"), "report.pdf", "application/pdf", { maxTextChars: 1 }, "EXTRACTION_LIMIT_EXCEEDED"],
    [Buffer.from("%PDF-broken"), "report.pdf", "application/pdf", {}, "MALFORMED_FILE"],
    [Buffer.from([0xff]), "report.csv", "text/csv", {}, "MALFORMED_FILE"],
  ])("fails the whole extraction with a safe code", async (fileBuffer, fileName, mimeType, limits, code) => {
    await expect(extractFinanceReportFile({ fileBuffer, fileName, mimeType, limits })).rejects.toMatchObject({ code });
  });
});
