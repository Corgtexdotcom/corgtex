import { createHash } from "node:crypto";
import JSZip from "jszip";
import { describe, expect, it } from "vitest";
import { extractFinanceReportFile } from "./finance-file-extraction";

function pdf(text: string) {
  const escaped = text.replace(/[()\\]/g, "\\$&");
  const stream = `BT /F1 12 Tf 72 720 Td (${escaped}) Tj ET`;
  const objects = [
    "<< /Type /Catalog /Pages 2 0 R >>",
    "<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
    "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >>",
    "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>",
    `<< /Length ${Buffer.byteLength(stream)} >>\nstream\n${stream}\nendstream`,
  ];
  let body = "%PDF-1.4\n";
  const offsets = objects.map((object, index) => {
    const offset = Buffer.byteLength(body);
    body += `${index + 1} 0 obj\n${object}\nendobj\n`;
    return offset;
  });
  const xref = Buffer.byteLength(body);
  body += `xref\n0 6\n0000000000 65535 f \n${offsets.map((offset) => `${String(offset).padStart(10, "0")} 00000 n `).join("\n")}\n`;
  return Buffer.from(`${body}trailer\n<< /Size 6 /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF`);
}

async function xlsx(firstDimension = "A1:B2") {
  const zip = new JSZip();
  zip.file("[Content_Types].xml", `<?xml version="1.0"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/><Override PartName="/xl/worksheets/sheet1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/><Override PartName="/xl/worksheets/sheet2.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/></Types>`);
  zip.file("_rels/.rels", `<?xml version="1.0"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/></Relationships>`);
  zip.file("xl/workbook.xml", `<?xml version="1.0"?><workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets><sheet name="Actuals" sheetId="1" r:id="rId1"/><sheet name="Notes" sheetId="2" r:id="rId2"/></sheets></workbook>`);
  zip.file("xl/_rels/workbook.xml.rels", `<?xml version="1.0"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/><Relationship Id="rId2" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet2.xml"/></Relationships>`);
  const sheet = (cells: string, dimension = "A1:B2") => `<?xml version="1.0"?><worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><dimension ref="${dimension}"/><sheetData>${cells}</sheetData><dataValidations count="1"><dataValidation type="whole" sqref="A1:XFD1048576"/></dataValidations></worksheet>`;
  zip.file("xl/worksheets/sheet1.xml", sheet(`<row r="1"><c r="A1" t="inlineStr"><is><t>Revenue</t></is></c><c r="B1" t="inlineStr"><is><t>Amount</t></is></c></row><row r="2"><c r="B2"><v>9007199254740993.01</v></c></row>`, firstDimension));
  zip.file("xl/worksheets/sheet2.xml", sheet(`<row r="1"><c r="A1" t="inlineStr"><is><t>Reviewed</t></is></c></row>`, "A1"));
  return zip.generateAsync({ type: "nodebuffer" });
}
describe("extractFinanceReportFile", () => {
  it("extracts machine-readable PDF pages and rejects scanned PDFs", async () => {
    const result = await extractFinanceReportFile({ fileBuffer: pdf("Revenue 100.00"), fileName: "report.pdf", mimeType: "application/pdf" });
    expect(result).toMatchObject({ format: "PDF", mimeType: "application/pdf", pages: [{ page: 1, text: expect.stringContaining("Revenue 100.00") }] });
    await expect(extractFinanceReportFile({ fileBuffer: pdf(""), fileName: "scan.pdf", mimeType: "application/pdf" })).rejects.toMatchObject({ code: "SCANNED_PDF_UNSUPPORTED" });
  });
  it("preserves CSV source locations, quoting, empty cells, and exact text", async () => {
    const input = Buffer.from('\uFEFFAccount,Amount,Note\r\n"Sales, Online",001.20,"two\nlines"\r\nCosts,,ok');
    const result = await extractFinanceReportFile({ fileBuffer: input, fileName: "actuals.csv", mimeType: "text/csv" });
    expect(result.fileHash).toBe(createHash("sha256").update(input).digest("hex"));
    expect(result.sheets?.[0]).toMatchObject({ name: "CSV", rowCount: 3, columnCount: 3 });
    expect(result.sheets?.[0]?.cells).toEqual(expect.arrayContaining([
      { row: 2, column: 1, type: "TEXT", value: "Sales, Online" },
      { row: 2, column: 2, type: "TEXT", value: "001.20" },
      { row: 2, column: 3, type: "TEXT", value: "two\nlines" },
      { row: 3, column: 3, type: "TEXT", value: "ok" },
    ]));
  });
  it("extracts all non-empty XLSX sheets without floating-point coercion", async () => {
    const result = await extractFinanceReportFile({ fileBuffer: await xlsx(), fileName: "actuals.xlsx", mimeType: "application/octet-stream" });
    expect(result.sheets?.map((sheet) => sheet.name)).toEqual(["Actuals", "Notes"]);
    expect(result.sheets?.[0]?.cells).toContainEqual({ row: 2, column: 2, type: "NUMBER", value: "9007199254740993.01" });
  });
  it.each([
    [Buffer.alloc(0), "report.csv", "text/csv", {}, "EMPTY_FILE"],
    [Buffer.from("a,b\n1"), "report.csv", "text/csv", {}, "MALFORMED_FILE"],
    [Buffer.from("a"), "report.csv", "application/pdf", {}, "FILE_TYPE_MISMATCH"],
    [Buffer.from("a"), "report.txt", "text/plain", {}, "UNSUPPORTED_FILE_TYPE"],
    [Buffer.from(",\n,"), "report.csv", "text/csv", {}, "EMPTY_EXTRACTION"],
    [Buffer.from("a,b"), "report.csv", "text/csv", { maxFileBytes: 1 }, "FILE_TOO_LARGE"],
    [Buffer.from("a\n".repeat(20_001)), "report.csv", "text/csv", { maxRows: undefined }, "EXTRACTION_LIMIT_EXCEEDED"],
    [Buffer.from("a,b"), "report.csv", "text/csv", { maxCells: 1 }, "EXTRACTION_LIMIT_EXCEEDED"],
    [pdf("Revenue"), "report.pdf", "application/pdf", { maxPages: 0 }, "EXTRACTION_LIMIT_EXCEEDED"],
    [pdf("Revenue"), "report.pdf", "application/pdf", { maxTextChars: 1 }, "EXTRACTION_LIMIT_EXCEEDED"],
  ])("fails the whole extraction with a safe code", async (fileBuffer, fileName, mimeType, limits, code) => {
    await expect(extractFinanceReportFile({ fileBuffer, fileName, mimeType, limits })).rejects.toMatchObject({ code });
  });

  it("rejects XLSX limits and distinguishes corrupt archive structure", async () => {
    const fileBuffer = await xlsx();
    await expect(extractFinanceReportFile({ fileBuffer, fileName: "report.xlsx", mimeType: "", limits: { maxZipEntries: 1 } })).rejects.toMatchObject({ code: "EXTRACTION_LIMIT_EXCEEDED" });
    await expect(extractFinanceReportFile({ fileBuffer: await xlsx("A1:XFD1048576"), fileName: "report.xlsx", mimeType: "" })).rejects.toMatchObject({ code: "EXTRACTION_LIMIT_EXCEEDED" });
    const malformed = Buffer.from(fileBuffer);
    const end = malformed.lastIndexOf(Buffer.from([0x50, 0x4b, 0x05, 0x06]));
    malformed.writeUInt32LE(malformed.length, end + 12);
    await expect(extractFinanceReportFile({ fileBuffer: malformed, fileName: "report.xlsx", mimeType: "" })).rejects.toMatchObject({ code: "MALFORMED_FILE" });
  });
});
