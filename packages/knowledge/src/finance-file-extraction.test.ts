import { createHash } from "node:crypto";
import { deflateSync } from "node:zlib";
import { describe, expect, it } from "vitest";
import { extractFinanceReportFile } from "./finance-file-extraction";

type PdfPage =
  | string
  | null
  | { text: string; rotate?: 90 | 270; vertical?: boolean }
  | { compressedText: string };

function pdf(...pages: PdfPage[]) {
  const pageIds = pages.map((_, index) => 4 + (index * 2));
  const objects: Buffer[] = [
    Buffer.from("<< /Type /Catalog /Pages 2 0 R >>"),
    Buffer.from(`<< /Type /Pages /Kids [${pageIds.map((id) => `${id} 0 R`).join(" ")}] /Count ${pages.length} >>`),
    Buffer.from("<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>"),
  ];
  for (const [index, page] of pages.entries()) {
    const value = typeof page === "object" && page !== null && "text" in page ? page.text : page;
    const parts = typeof value === "string" ? value.split("|").map((part) => part.replace(/[()\\]/g, "\\$&")) : [];
    const vertical = typeof page === "object" && page !== null && "vertical" in page && page.vertical;
    const compressed = typeof page === "object" && page !== null && "compressedText" in page;
    const content = page === null
      ? Buffer.from("q BI /W 1 /H 1 /BPC 1 /CS /DeviceGray ID \x00 EI Q")
      : compressed
        ? deflateSync(Buffer.from(`BT /F1 12 Tf 72 720 Td (${(page as { compressedText: string }).compressedText}) Tj ET`))
        : Buffer.from(vertical
          ? `BT /F1 12 Tf 0 12 -12 0 72 100 Tm (${parts[0]}) Tj ET BT /F1 12 Tf 0 12 -12 0 72 244 Tm (${parts[1]}) Tj ET`
          : `BT /F1 12 Tf 72 720 Td (${parts[0]}) Tj${parts[1] === undefined ? "" : ` 144 0 Td (${parts[1]}) Tj`} ET`);
    const rotate = typeof page === "object" && page !== null && "rotate" in page && page.rotate
      ? `/Rotate ${page.rotate} `
      : "";
    objects.push(
      Buffer.from(`<< /Type /Page /Parent 2 0 R /MediaBox [0 0 1000 1000] /Resources << /Font << /F1 3 0 R >> >> ${rotate}/Contents ${pageIds[index] + 1} 0 R >>`),
      Buffer.concat([
        Buffer.from(`<< /Length ${content.length}${compressed ? " /Filter /FlateDecode" : ""} >>\nstream\n`),
        content,
        Buffer.from("\nendstream"),
      ]),
    );
  }
  const chunks: Uint8Array[] = [Buffer.from("%PDF-1.4\n")];
  const offsets: number[] = [];
  for (const [index, object] of objects.entries()) {
    offsets.push(chunks.reduce((total, chunk) => total + chunk.length, 0));
    chunks.push(Buffer.from(`${index + 1} 0 obj\n`), object, Buffer.from("\nendobj\n"));
  }
  const xref = chunks.reduce((total, chunk) => total + chunk.length, 0);
  const size = objects.length + 1;
  chunks.push(Buffer.from(`xref\n0 ${size}\n0000000000 65535 f \n${offsets.map((offset) => `${String(offset).padStart(10, "0")} 00000 n `).join("\n")}\ntrailer\n<< /Size ${size} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF`));
  return Buffer.concat(chunks);
}

describe("extractFinanceReportFile", () => {
  it("extracts ordered PDF pages while retaining genuine blank pages", async () => {
    const input = pdf("Revenue|100.00", "");
    const result = await extractFinanceReportFile({ fileBuffer: input, fileName: "actuals.pdf", mimeType: "application/pdf" });
    expect(result).toMatchObject({
      fileHash: createHash("sha256").update(input).digest("hex"),
      format: "PDF",
      mimeType: "application/pdf",
      pages: [{ page: 1, text: "Revenue 100.00" }, { page: 2, text: "" }],
    });
  });

  it("preserves same-line layout for page and text-matrix rotation", async () => {
    const pageRotated = await extractFinanceReportFile({ fileBuffer: pdf({ text: "Revenue|100.00", rotate: 90 }), fileName: "rotated.pdf", mimeType: "application/pdf" });
    const textRotated = await extractFinanceReportFile({ fileBuffer: pdf({ text: "Revenue|100.00", vertical: true }), fileName: "vertical.pdf", mimeType: "application/pdf" });
    expect(pageRotated.pages?.[0]?.text).not.toContain("\n");
    expect(textRotated.pages?.[0]?.text).not.toContain("\n");
  });

  it("rejects image-only pages and highly compressed over-limit text without partial output", async () => {
    await expect(extractFinanceReportFile({ fileBuffer: pdf("Revenue", null), fileName: "scan.pdf", mimeType: "application/pdf" })).rejects.toMatchObject({ code: "SCANNED_PDF_UNSUPPORTED" });
    await expect(extractFinanceReportFile({
      fileBuffer: pdf({ compressedText: "A".repeat(4_000_000) }),
      fileName: "compressed.pdf",
      mimeType: "application/pdf",
      limits: { maxTextChars: 64 },
    })).rejects.toMatchObject({ code: "EXTRACTION_LIMIT_EXCEEDED" });
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

  it("hashes, validates, and parses one immutable byte snapshot", async () => {
    const input = Buffer.from("Account,Amount\nRevenue,100");
    const hash = createHash("sha256").update(input).digest("hex");
    const extraction = extractFinanceReportFile({ fileBuffer: input, fileName: "actuals.csv", mimeType: "text/csv" });
    input.fill(0x2c);
    const result = await extraction;
    expect(result.fileHash).toBe(hash);
    expect(result.sheets?.[0]?.cells).toEqual(expect.arrayContaining([
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

  it("uses the same CRLF, LF, and CR record boundaries as the preflight", async () => {
    const result = await extractFinanceReportFile({
      fileBuffer: Buffer.from("Account,Amount\r\nRevenue,100\nCosts,40\rMargin,60"),
      fileName: "actuals.csv",
      mimeType: "text/csv",
    });
    expect(result.sheets?.[0]).toMatchObject({ rowCount: 4, columnCount: 2 });
    expect(result.sheets?.[0]?.cells).toContainEqual({ row: 4, column: 1, type: "TEXT", value: "Margin" });
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
    [pdf("Revenue"), "report.pdf", "application/pdf", { maxPages: 0 }, "EXTRACTION_LIMIT_EXCEEDED"],
    [pdf("Revenue"), "report.pdf", "application/pdf", { maxTextChars: 1 }, "EXTRACTION_LIMIT_EXCEEDED"],
    [pdf(), "report.pdf", "application/pdf", {}, "EMPTY_EXTRACTION"],
    [pdf(""), "report.pdf", "application/pdf", {}, "EMPTY_EXTRACTION"],
    [Buffer.from("%PDF-broken"), "report.pdf", "application/pdf", {}, "MALFORMED_FILE"],
    [Buffer.from([0xff]), "report.csv", "text/csv", {}, "MALFORMED_FILE"],
  ])("fails the whole extraction with a safe code", async (fileBuffer, fileName, mimeType, limits, code) => {
    await expect(extractFinanceReportFile({ fileBuffer, fileName, mimeType, limits })).rejects.toMatchObject({ code });
  });
});
