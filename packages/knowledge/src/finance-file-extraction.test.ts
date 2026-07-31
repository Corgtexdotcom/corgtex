import { createHash } from "node:crypto";
import { deflateSync } from "node:zlib";
import { describe, expect, it } from "vitest";
import { extractFinanceReportFile } from "./finance-file-extraction";

function assemblePdf(objects: Buffer[]) {
  const chunks = [Buffer.from("%PDF-1.7\n")];
  const offsets = [0];
  let offset = chunks[0]?.length ?? 0;
  objects.forEach((object, index) => {
    offsets.push(offset);
    const wrapped = Buffer.concat([Buffer.from(`${index + 1} 0 obj\n`), object, Buffer.from("\nendobj\n")]);
    chunks.push(wrapped);
    offset += wrapped.length;
  });
  const xrefOffset = offset;
  const xref = offsets.slice(1).map((entry) => `${String(entry).padStart(10, "0")} 00000 n \n`).join("");
  chunks.push(Buffer.from(`xref\n0 ${objects.length + 1}\n0000000000 65535 f \n${xref}`
    + `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xrefOffset}\n%%EOF\n`));
  return Buffer.concat(chunks);
}

function createTextPdf(pages: Array<{ text?: string; rotation?: number; userUnit?: number; mediaBox?: string }>, font = "Helvetica") {
  const fontId = 3 + (pages.length * 2);
  const pageIds = pages.map((_, index) => 3 + (index * 2));
  const objects = [Buffer.from("<< /Type /Catalog /Pages 2 0 R >>"),
    Buffer.from(`<< /Type /Pages /Kids [${pageIds.map((id) => `${id} 0 R`).join(" ")}] /Count ${pages.length} >>`)];
  pages.forEach((page, index) => {
    const streamId = 4 + (index * 2);
    const content = page.text === undefined ? "" : `BT /F1 12 Tf 50 700 Td (${page.text}) Tj ET`;
    objects.push(Buffer.from(
      `<< /Type /Page /Parent 2 0 R /MediaBox [${page.mediaBox ?? "0 0 612 792"}]`
      + ` /Resources << /Font << /F1 ${fontId} 0 R >> >>`
      + ` /Contents ${streamId} 0 R${page.rotation ? ` /Rotate ${page.rotation}` : ""}${page.userUnit ? ` /UserUnit ${page.userUnit}` : ""} >>`,
    ));
    objects.push(Buffer.from(`<< /Length ${Buffer.byteLength(content)} >>\nstream\n${content}\nendstream`));
  });
  objects.push(Buffer.from(`<< /Type /Font /Subtype /Type1 /BaseFont /${font} >>`));
  return assemblePdf(objects);
}

function createImagePdf(text?: string, size = 1, count = 1) {
  const names = Array.from({ length: count }, (_, index) => `Im${index}`);
  const content = names.map((name) => `q 10 0 0 10 0 0 cm /${name} Do Q`).join("\n") + (text ? `\nBT /F1 12 Tf 20 80 Td (${text}) Tj ET` : "");
  const pixels = deflateSync(Buffer.alloc(size * size));
  return assemblePdf([
    Buffer.from("<< /Type /Catalog /Pages 2 0 R >>"),
    Buffer.from("<< /Type /Pages /Kids [3 0 R] /Count 1 >>"),
    Buffer.from(`<< /Type /Page /Parent 2 0 R /MediaBox [0 0 100 100] /Resources << /XObject << ${names.map((name, index) => `/${name} ${index + 5} 0 R`).join(" ")} >> /Font << /F1 ${count + 5} 0 R >> >> /Contents 4 0 R >>`),
    Buffer.from(`<< /Length ${Buffer.byteLength(content)} >>\nstream\n${content}\nendstream`),
    ...names.map(() => Buffer.concat([Buffer.from(`<< /Type /XObject /Subtype /Image /Width ${size} /Height ${size} /ColorSpace /DeviceGray /BitsPerComponent 8 /Filter /FlateDecode /Length ${pixels.length} >>\nstream\n`), pixels, Buffer.from("\nendstream")])),
    Buffer.from("<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>"),
  ]);
}

function createCompressedTokenPdf(textBytes: number) {
  const content = deflateSync(Buffer.concat(
    [Buffer.from("BT /F1 12 Tf 50 700 Td ("), Buffer.alloc(textBytes, 0x61), Buffer.from(") Tj ET")],
  ));
  return assemblePdf([
    Buffer.from("<< /Type /Catalog /Pages 2 0 R >>"),
    Buffer.from("<< /Type /Pages /Kids [3 0 R] /Count 1 >>"),
    Buffer.from("<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 5 0 R >> >> /Contents 4 0 R >>"),
    Buffer.concat([Buffer.from(`<< /Filter /FlateDecode /Length ${content.length} >>\nstream\n`), content, Buffer.from("\nendstream")]),
    Buffer.from("<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>"),
  ]);
}

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

  it("uses the same CRLF, LF, and CR record boundaries as the preflight", async () => {
    const result = await extractFinanceReportFile({
      fileBuffer: Buffer.from("Account,Amount\r\nRevenue,100\nCosts,40\rMargin,60"),
      fileName: "actuals.csv",
      mimeType: "text/csv",
    });
    expect(result.sheets[0]).toMatchObject({ rowCount: 4, columnCount: 2 });
    expect(result.sheets[0]?.cells).toContainEqual({ row: 4, column: 1, type: "TEXT", value: "Margin" });
  });

  it("extracts machine-readable PDF text, source pages, layout, rotation, and exact bytes", async () => {
    const input = createTextPdf([{ text: "Revenue" }, {}, { text: "Revenue", rotation: 90, userUnit: 2 }]);
    const result = await extractFinanceReportFile({ fileBuffer: input, fileName: "actuals.pdf", mimeType: "application/pdf" });
    expect(result).toMatchObject({
      fileHash: createHash("sha256").update(input).digest("hex"),
      fileSizeBytes: input.length,
      format: "PDF",
      mimeType: "application/pdf",
    });
    expect(result.sheets.map(({ name, rowCount, columnCount, page }) => ({ name, rowCount, columnCount, page }))).toEqual([
      { name: "Page 1", rowCount: 1, columnCount: 1, page: { width: 612, height: 792, rotation: 0 } },
      { name: "Page 2", rowCount: 0, columnCount: 0, page: { width: 612, height: 792, rotation: 0 } },
      { name: "Page 3", rowCount: 1, columnCount: 1, page: { width: 1584, height: 1224, rotation: 90 } },
    ]);
    expect(result.sheets[0]?.cells[0]).toMatchObject({ row: 1, column: 1, type: "TEXT", value: "Revenue" });
    expect(result.sheets[2]?.cells[0]?.layout?.transform).toHaveLength(6);
    const normal = result.sheets[0]?.cells[0]?.layout, rotated = result.sheets[2]?.cells[0]?.layout;
    expect([rotated?.width, rotated?.height]).toEqual([(normal?.height ?? 0) * 2, (normal?.width ?? 0) * 2]);
  });

  it("hashes and parses an immutable PDF byte snapshot", async () => {
    const input = createTextPdf([{ text: "Margin" }]);
    const hash = createHash("sha256").update(input).digest("hex");
    const extraction = extractFinanceReportFile({ fileBuffer: input, fileName: "actuals.pdf", mimeType: "application/pdf" });
    input.fill(0x20);
    await expect(extraction).resolves.toMatchObject({ fileHash: hash, sheets: [{ cells: [expect.objectContaining({ value: "Margin" })] }] });
  });

  it("preserves multibyte PDF text across child stdout chunks", async () => {
    const result = await extractFinanceReportFile({
      fileBuffer: createTextPdf(Array.from({ length: 300 }, () => ({ text: "é".repeat(100) }))),
      fileName: "large.pdf",
      mimeType: "application/pdf",
    });
    const value = result.sheets.flatMap((sheet) => sheet.cells).map((cell) => cell.value).join("");
    expect(Buffer.byteLength(value, "utf8")).toBeGreaterThan(65_536);
    expect(value).not.toContain("\uFFFD");
  });

  it("retains secure PDF defaults for invalid partial limit overrides", async () => {
    await expect(extractFinanceReportFile({
      fileBuffer: createTextPdf([{ text: "Operating income" }], "Symbol"),
      fileName: "actuals.pdf",
      mimeType: "application/pdf",
      limits: {
        maxPdfItems: -1,
        maxPdfOutputBytes: Number.POSITIVE_INFINITY,
        maxPdfPages: Number.NaN,
        maxPdfParseMs: 2_147_483_648,
      },
    })).resolves.toMatchObject({ format: "PDF" });
  });

  it("accepts machine-readable text on a page that also contains an image", async () => {
    await expect(extractFinanceReportFile({
      fileBuffer: createImagePdf("Net income"),
      fileName: "actuals.pdf",
      mimeType: "application/pdf",
    })).resolves.toMatchObject({ sheets: [{ cells: [expect.objectContaining({ value: "Net income" })] }] });
  });

  it.each([
    [createTextPdf([]), {}, "EMPTY_EXTRACTION"],
    [createTextPdf([{ text: "One" }, { text: "Two" }]), { maxPdfPages: 1 }, "EXTRACTION_LIMIT_EXCEEDED"],
    [createTextPdf([{ text: "Long" }]), { maxTextChars: 3 }, "EXTRACTION_LIMIT_EXCEEDED"],
    [createTextPdf([{ text: "Text" }]), { maxPdfItems: 0 }, "EXTRACTION_LIMIT_EXCEEDED"],
    [createTextPdf([{ text: "Text" }]), { maxPdfOutputBytes: 16 }, "EXTRACTION_LIMIT_EXCEEDED"],
    [createTextPdf([{ text: "Text" }]), { maxPdfParseMs: 1 }, "EXTRACTION_LIMIT_EXCEEDED"],
    [createImagePdf(), {}, "UNSUPPORTED_FILE_TYPE"],
    [createImagePdf(" "), {}, "UNSUPPORTED_FILE_TYPE"],
    [createImagePdf("Text", 2_001), {}, "EXTRACTION_LIMIT_EXCEEDED"],
    [createImagePdf("Text", 1_000, 40), {}, "EXTRACTION_LIMIT_EXCEEDED"],
    [createTextPdf([{ text: "Text", mediaBox: `0 0 ${"1".padEnd(307, "0")} 792` }]), {}, "MALFORMED_FILE"],
  ])("rejects an incomplete or over-limit PDF as one safe failure", async (fileBuffer, limits, code) => {
    await expect(extractFinanceReportFile({
      fileBuffer,
      fileName: "actuals.pdf",
      mimeType: "application/pdf",
      limits,
    })).rejects.toMatchObject({ code });
  });

  it("contains a compressed expanded token inside the bounded parser process", async () => {
    const input = createCompressedTokenPdf(70 * 1024 * 1024);
    expect(input.length).toBeLessThan(100_000);
    await expect(extractFinanceReportFile({
      fileBuffer: input,
      fileName: "actuals.pdf",
      mimeType: "application/pdf",
      limits: { maxPdfParseMs: 10_000 },
    })).rejects.toMatchObject({ code: "EXTRACTION_LIMIT_EXCEEDED" });
  }, 20_000);

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
    [Buffer.from("%PDF-1.4"), "report.pdf", "application/pdf", {}, "MALFORMED_FILE"],
    [Buffer.from("not a pdf"), "report.pdf", "application/pdf", {}, "FILE_TYPE_MISMATCH"],
    [createTextPdf([{ text: "Text" }]), "report.pdf", "text/csv", {}, "FILE_TYPE_MISMATCH"],
    [Buffer.from([0xff]), "report.csv", "text/csv", {}, "MALFORMED_FILE"],
  ])("fails the whole extraction with a safe code", async (fileBuffer, fileName, mimeType, limits, code) => {
    await expect(extractFinanceReportFile({ fileBuffer, fileName, mimeType, limits })).rejects.toMatchObject({ code });
  });
});
