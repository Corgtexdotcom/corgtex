import { createHash } from "node:crypto";
import { deflateSync } from "node:zlib";
import { describe, expect, it } from "vitest";
import { extractFinanceReportFile } from "./finance-file-extraction";

type PdfPage =
  | string
  | null
  | { text: string; rotate?: 90 | 270; vertical?: boolean }
  | { compressedText: string };
type FailureCase = [Buffer, string, string, Parameters<typeof extractFinanceReportFile>[0]["limits"], string];

function renderPdf(objects: Buffer[]) {
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
  return renderPdf(objects);
}

function cidFontPdf(
  encoding = "90ms-RKSJ-H",
  operators = "BT /F1 12 Tf 72 720 Td <93FA> Tj ET",
) {
  const content = Buffer.from(operators);
  return renderPdf([
    Buffer.from("<< /Type /Catalog /Pages 2 0 R >>"),
    Buffer.from("<< /Type /Pages /Kids [9 0 R] /Count 1 >>"),
    Buffer.from(`<< /Type /Font /Subtype /Type0 /BaseFont /HeiseiKakuGo-W5 /Encoding /${encoding} /DescendantFonts [4 0 R] >>`),
    Buffer.from("<< /Type /Font /Subtype /CIDFontType2 /BaseFont /HeiseiKakuGo-W5 /CIDSystemInfo << /Registry (Adobe) /Ordering (Japan1) /Supplement 6 >> /FontDescriptor 5 0 R /CIDToGIDMap /Identity /DW 1000 >>"),
    Buffer.from("<< /Type /FontDescriptor /FontName /HeiseiKakuGo-W5 /Flags 4 /FontBBox [0 -200 1000 900] /ItalicAngle 0 /Ascent 880 /Descent -120 /CapHeight 700 /StemV 80 >>"),
    Buffer.from(`<< /Type /Font /Subtype /Type0 /BaseFont /HeiseiMin-W3 /Encoding /${encoding} /DescendantFonts [7 0 R] >>`),
    Buffer.from("<< /Type /Font /Subtype /CIDFontType2 /BaseFont /HeiseiMin-W3 /CIDSystemInfo << /Registry (Adobe) /Ordering (Japan1) /Supplement 6 >> /FontDescriptor 8 0 R /CIDToGIDMap /Identity /DW 1000 >>"),
    Buffer.from("<< /Type /FontDescriptor /FontName /HeiseiMin-W3 /Flags 4 /FontBBox [0 -200 1000 900] /ItalicAngle 0 /Ascent 880 /Descent -120 /CapHeight 700 /StemV 80 >>"),
    Buffer.from("<< /Type /Page /Parent 2 0 R /MediaBox [0 0 1000 1000] /Resources << /Font << /F1 3 0 R /F2 6 0 R >> >> /Contents 10 0 R >>"),
    Buffer.concat([
      Buffer.from(`<< /Length ${content.length} >>\nstream\n`),
      content,
      Buffer.from("\nendstream"),
    ]),
  ]);
}

function formPdf(multiSelect = false, scanned = false, choiceValue = "A") {
  const choice = multiSelect
    ? "/Ff 2097152 /V [(Cash) (Accrual)]"
    : `/V (${choiceValue})`;
  const pageContent = scanned
    ? "q BI /W 1 /H 1 /BPC 1 /CS /DeviceGray ID \x00 EI Q"
    : "";
  return renderPdf([
    Buffer.from("<< /Type /Catalog /Pages 2 0 R /AcroForm 6 0 R >>"),
    Buffer.from("<< /Type /Pages /Kids [4 0 R] /Count 1 >>"),
    Buffer.from("<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>"),
    Buffer.from("<< /Type /Page /Parent 2 0 R /MediaBox [0 0 1000 1000] /Resources << /Font << /F1 3 0 R >> >> /Contents 5 0 R /Annots [7 0 R 8 0 R 9 0 R 10 0 R 11 0 R 12 0 R 13 0 R 14 0 R 15 0 R] >>"),
    Buffer.from(`<< /Length ${pageContent.length} >>\nstream\n${pageContent}\nendstream`),
    Buffer.from("<< /Fields [7 0 R 8 0 R 9 0 R 10 0 R 11 0 R 12 0 R 13 0 R 14 0 R 15 0 R] /NeedAppearances true >>"),
    Buffer.from("<< /Type /Annot /Subtype /Widget /FT /Tx /T (Revenue) /V (123.45) /Rect [72 700 200 720] /P 4 0 R /AA << /K << /S /JavaScript /JS (app.alert\\(secret\\)) >> >> >>"),
    Buffer.from("<< /Type /Annot /Subtype /Widget /FT /Tx /T (Revenue) /V (123.45) /Rect [72 670 200 690] /P 4 0 R >>"),
    Buffer.from(`<< /Type /Annot /Subtype /Widget /FT /Ch /T (Basis) ${choice} /Opt [[(C) (Cash Basis)] [(A) (Accrual Basis)]] /Rect [72 640 200 660] /P 4 0 R >>`),
    Buffer.from("<< /Type /Annot /Subtype /Widget /FT /Btn /T (Approved) /V /Yes /AS /Yes /Rect [72 610 90 628] /P 4 0 R >>"),
    Buffer.from("<< /Type /Annot /Subtype /Widget /FT /Btn /Ff 32768 /T (Scenario) /V /Base /AS /Base /AP << /N << /Base 16 0 R /Off 16 0 R >> >> /Rect [72 580 90 598] /P 4 0 R >>"),
    Buffer.from("<< /Type /Annot /Subtype /Widget /FT /Tx /T (HiddenValue) /V (ignore) /F 2 /Rect [72 550 200 570] /P 4 0 R >>"),
    Buffer.from("<< /Type /Annot /Subtype /Widget /FT /Btn /Ff 65536 /T (RunAction) /Rect [72 520 200 540] /P 4 0 R /A << /S /JavaScript /JS (app.alert\\(ignore\\)) >> >>"),
    Buffer.from("<< /Type /Annot /Subtype /Widget /FT /Sig /T (Signature) /Rect [72 490 200 510] /P 4 0 R >>"),
    Buffer.from("<< /Type /Annot /Subtype /Widget /FT /Tx /Ff 8192 /T (Password) /V (ignore-password) /Rect [72 460 200 480] /P 4 0 R >>"),
    Buffer.from("<< /Type /XObject /Subtype /Form /BBox [0 0 10 10] /Length 0 >>\nstream\n\nendstream"),
  ]);
}

function pagedFormPdf() {
  return renderPdf([
    Buffer.from("<< /Type /Catalog /Pages 2 0 R /AcroForm 8 0 R >>"),
    Buffer.from("<< /Type /Pages /Kids [4 0 R 6 0 R] /Count 2 >>"),
    Buffer.from("<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>"),
    Buffer.from("<< /Type /Page /Parent 2 0 R /MediaBox [0 0 1000 1000] /Contents 5 0 R /Annots [9 0 R] >>"),
    Buffer.from("<< /Length 0 >>\nstream\n\nendstream"),
    Buffer.from("<< /Type /Page /Parent 2 0 R /MediaBox [0 0 1000 1000] /Contents 7 0 R /Annots [10 0 R] >>"),
    Buffer.from("<< /Length 0 >>\nstream\n\nendstream"),
    Buffer.from("<< /Fields [9 0 R 10 0 R] >>"),
    Buffer.from("<< /Type /Annot /Subtype /Widget /FT /Tx /T (PageOne) /V (One) /Rect [72 700 200 720] /P 4 0 R >>"),
    Buffer.from("<< /Type /Annot /Subtype /Widget /FT /Tx /T (PageTwo) /V (Two) /Rect [72 700 200 720] /P 6 0 R >>"),
  ]);
}

function pagedRadioFormPdf() {
  const appearance = Buffer.from("<< /Type /XObject /Subtype /Form /BBox [0 0 10 10] /Length 0 >>\nstream\n\nendstream");
  return renderPdf([
    Buffer.from("<< /Type /Catalog /Pages 2 0 R /AcroForm 8 0 R >>"),
    Buffer.from("<< /Type /Pages /Kids [4 0 R 6 0 R] /Count 2 >>"),
    Buffer.from("<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>"),
    Buffer.from("<< /Type /Page /Parent 2 0 R /MediaBox [0 0 1000 1000] /Contents 5 0 R /Annots [10 0 R] >>"),
    Buffer.from("<< /Length 0 >>\nstream\n\nendstream"),
    Buffer.from("<< /Type /Page /Parent 2 0 R /MediaBox [0 0 1000 1000] /Contents 7 0 R /Annots [11 0 R] >>"),
    Buffer.from("<< /Length 0 >>\nstream\n\nendstream"),
    Buffer.from("<< /Fields [9 0 R] >>"),
    Buffer.from("<< /FT /Btn /Ff 32768 /T (Scenario) /V /A /Kids [10 0 R 11 0 R] >>"),
    Buffer.from("<< /Type /Annot /Subtype /Widget /Parent 9 0 R /AS /A /AP << /N << /A 12 0 R /Off 12 0 R >> >> /Rect [72 700 90 718] /P 4 0 R >>"),
    Buffer.from("<< /Type /Annot /Subtype /Widget /Parent 9 0 R /AS /Off /AP << /N << /C 12 0 R /Off 12 0 R >> >> /Rect [72 700 90 718] /P 6 0 R >>"),
    appearance,
  ]);
}

function xfaPdf(values: string[], controlValue?: string, richText = false) {
  const draws = values.map((value, index) => `<subform name="line${index}">
    ${index === 0 ? "" : '<breakBefore targetType="pageArea" startNew="1"/>'}
    <draw w="300pt" h="20pt"><value>${richText
    ? `<exData contentType="text/html"><body xmlns="http://www.w3.org/1999/xhtml"><p>${value}</p></body></exData>`
    : `<text>${value}</text>`}</value></draw>
  </subform>`)
    .join("");
  const control = controlValue
    ? `<field name="amount" w="100pt" h="20pt"><ui><textEdit/></ui><value><text>${controlValue}</text></value></field>`
    : "";
  const xml = `<?xml version="1.0"?>
<xdp:xdp xmlns:xdp="http://ns.adobe.com/xdp/">
  <template xmlns="http://www.xfa.org/schema/xfa-template/3.3">
    <subform name="root" mergeMode="matchTemplate" layout="tb">
      <pageSet><pageArea><contentArea x="0pt" w="456pt" h="789pt"/><medium short="456pt" long="789pt"/></pageArea></pageSet>
      ${draws}${control}
    </subform>
  </template>
  <xfa:datasets xmlns:xfa="http://www.xfa.org/schema/xfa-data/1.0/"><xfa:data/></xfa:datasets>
</xdp:xdp>`;
  const content = Buffer.from(xml);
  return renderPdf([
    Buffer.from("<< /Type /Catalog /Pages 2 0 R /NeedsRendering true /AcroForm 6 0 R >>"),
    Buffer.from("<< /Type /Pages /Kids [4 0 R] /Count 1 >>"),
    Buffer.from("<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>"),
    Buffer.from("<< /Type /Page /Parent 2 0 R /MediaBox [0 0 456 789] /Resources << /Font << /F1 3 0 R >> >> /Contents 5 0 R >>"),
    Buffer.from("<< /Length 0 >>\nstream\n\nendstream"),
    Buffer.from("<< /Fields [] /XFA 7 0 R >>"),
    Buffer.concat([
      Buffer.from(`<< /Length ${content.length} >>\nstream\n`),
      content,
      Buffer.from("\nendstream"),
    ]),
  ]);
}

const pdfIt = it.runIf(process.platform === "linux");
describe("extractFinanceReportFile", () => {
  pdfIt("extracts ordered PDF pages while retaining genuine blank pages", async () => {
    const input = pdf("Revenue|100.00", "");
    const result = await extractFinanceReportFile({ fileBuffer: input, fileName: "actuals.pdf", mimeType: "application/pdf" });
    expect(result).toMatchObject({
      fileHash: createHash("sha256").update(input).digest("hex"),
      format: "PDF",
      mimeType: "application/pdf",
      pages: [{ page: 1, text: "Revenue 100.00" }, { page: 2, text: "" }],
    });
  });

  pdfIt("preserves same-line layout for page and text-matrix rotation", async () => {
    const pageRotated = await extractFinanceReportFile({ fileBuffer: pdf({ text: "Revenue|100.00", rotate: 90 }), fileName: "rotated.pdf", mimeType: "application/pdf" });
    const textRotated = await extractFinanceReportFile({ fileBuffer: pdf({ text: "Revenue|100.00", vertical: true }), fileName: "vertical.pdf", mimeType: "application/pdf" });
    expect(pageRotated.pages?.[0]?.text).not.toContain("\n");
    expect(textRotated.pages?.[0]?.text).not.toContain("\n");
  });

  pdfIt("loads packaged predefined CMaps for valid CID-font text", async () => {
    const result = await extractFinanceReportFile({
      fileBuffer: cidFontPdf(),
      fileName: "cjk-actuals.pdf",
      mimeType: "application/pdf",
    });
    expect(result.pages?.[0]?.text).toBe("日");
  });

  pdfIt("extracts supported AcroForm values once without action or hidden metadata", async () => {
    const result = await extractFinanceReportFile({
      fileBuffer: formPdf(),
      fileName: "form.pdf",
      mimeType: "application/pdf",
    });
    expect(result.pages?.[0]?.text).toBe([
      '[AcroForm]\t["Approved","Yes"]',
      '[AcroForm]\t["Basis","Accrual Basis"]',
      '[AcroForm]\t["Revenue","123.45"]',
      '[AcroForm]\t["Scenario","Base"]',
    ].join("\n"));
    expect(result.pages?.[0]?.text).not.toMatch(/secret|ignore|Password|RunAction|Signature/);
  });

  pdfIt("attaches AcroForm values to their one-based source pages", async () => {
    const result = await extractFinanceReportFile({
      fileBuffer: pagedFormPdf(),
      fileName: "paged-form.pdf",
      mimeType: "application/pdf",
    });
    expect(result.pages).toEqual([
      { page: 1, text: '[AcroForm]\t["PageOne","One"]' },
      { page: 2, text: '[AcroForm]\t["PageTwo","Two"]' },
    ]);
  });

  pdfIt("attaches a radio-group value only to its selected widget page", async () => {
    const result = await extractFinanceReportFile({
      fileBuffer: pagedRadioFormPdf(),
      fileName: "paged-radio.pdf",
      mimeType: "application/pdf",
    });
    expect(result.pages).toEqual([
      { page: 1, text: '[AcroForm]\t["Scenario","A"]' },
      { page: 2, text: "" },
    ]);
  });

  pdfIt("fails multi-select AcroForms instead of returning partial choices", async () => {
    await expect(extractFinanceReportFile({
      fileBuffer: formPdf(true),
      fileName: "multi-select.pdf",
      mimeType: "application/pdf",
    })).rejects.toMatchObject({ code: "UNSUPPORTED_PDF_FEATURE" });
  });

  pdfIt("fails a non-editable choice whose value is absent from its visible options", async () => {
    await expect(extractFinanceReportFile({
      fileBuffer: formPdf(false, false, "INTERNAL"),
      fileName: "unmatched-choice.pdf",
      mimeType: "application/pdf",
    })).rejects.toMatchObject({ code: "UNSUPPORTED_PDF_FEATURE" });
  });

  pdfIt("extracts pure XFA text in page order and enforces the shared character limit", async () => {
    const input = xfaPdf(["Revenue", "123.45"]);
    const result = await extractFinanceReportFile({
      fileBuffer: input,
      fileName: "xfa.pdf",
      mimeType: "application/pdf",
    });
    expect(result.pages).toEqual([
      { page: 1, text: "Revenue" },
      { page: 2, text: "123.45" },
    ]);
    await expect(extractFinanceReportFile({
      fileBuffer: input,
      fileName: "xfa.pdf",
      mimeType: "application/pdf",
      limits: { maxTextChars: 5 },
    })).rejects.toMatchObject({ code: "EXTRACTION_LIMIT_EXCEEDED" });
  });

  pdfIt("preserves inline rich-text XFA runs on one visual line", async () => {
    const result = await extractFinanceReportFile({
      fileBuffer: xfaPdf(["Revenue <span style=\"font-weight: bold\">123</span>"], undefined, true),
      fileName: "xfa-rich-text.pdf",
      mimeType: "application/pdf",
    });
    expect(result.pages).toEqual([{ page: 1, text: "Revenue 123" }]);
  });

  pdfIt("fails pure XFA controls closed instead of omitting their values", async () => {
    await expect(extractFinanceReportFile({
      fileBuffer: xfaPdf(["Revenue"], "123.45"),
      fileName: "xfa-control.pdf",
      mimeType: "application/pdf",
    })).rejects.toMatchObject({ code: "UNSUPPORTED_PDF_FEATURE" });
  });

  pdfIt("rejects scanned page content even when a visible form value exists", async () => {
    await expect(extractFinanceReportFile({
      fileBuffer: formPdf(false, true),
      fileName: "scanned-form.pdf",
      mimeType: "application/pdf",
    })).rejects.toMatchObject({ code: "SCANNED_PDF_UNSUPPORTED" });
  });

  pdfIt("keeps native vertical rows together and separates columns", async () => {
    const input = cidFontPdf(
      "90ms-RKSJ-V",
      "BT /F1 12 Tf 72 720 Td <93FA> Tj ET BT /F2 12 Tf 72 706 Td <93FA> Tj ET BT /F1 12 Tf 96 720 Td <93FA> Tj ET",
    );
    const result = await extractFinanceReportFile({
      fileBuffer: input,
      fileName: "vertical.pdf",
      mimeType: "application/pdf",
    });
    expect(result.pages?.[0]?.text).not.toContain("\t");
    expect(result.pages?.[0]?.text.replaceAll(" ", "")).toBe("日日\n日");
  });

  pdfIt("counts structured field names and values toward the character limit", async () => {
    await expect(extractFinanceReportFile({
      fileBuffer: formPdf(),
      fileName: "form.pdf",
      mimeType: "application/pdf",
      limits: { maxTextChars: 10 },
    })).rejects.toMatchObject({ code: "EXTRACTION_LIMIT_EXCEEDED" });
  });

  pdfIt("contains decompression with a kernel data limit", async () => {
    await expect(extractFinanceReportFile({
      fileBuffer: pdf({ compressedText: "A".repeat(128 * 1024 * 1024) }),
      fileName: "decompression-bomb.pdf",
      mimeType: "application/pdf",
      limits: { maxTextChars: 256 * 1024 * 1024 },
    })).rejects.toMatchObject({ code: "EXTRACTION_LIMIT_EXCEEDED" });
  });

  pdfIt("rejects image-only pages and highly compressed over-limit text without partial output", async () => {
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
    ...((process.platform === "linux" ? [
      [pdf("Revenue"), "report.pdf", "application/pdf", { maxPages: 0 }, "EXTRACTION_LIMIT_EXCEEDED"],
      [pdf("Revenue"), "report.pdf", "application/pdf", { maxTextChars: 1 }, "EXTRACTION_LIMIT_EXCEEDED"],
      [pdf(), "report.pdf", "application/pdf", {}, "EMPTY_EXTRACTION"],
      [pdf(""), "report.pdf", "application/pdf", {}, "EMPTY_EXTRACTION"],
      [xfaPdf([]), "report.pdf", "application/pdf", {}, "EMPTY_EXTRACTION"],
      [Buffer.from("%PDF-broken"), "report.pdf", "application/pdf", {}, "MALFORMED_FILE"],
    ] : [[pdf("Revenue"), "report.pdf", "application/pdf", {}, "EXTRACTION_LIMIT_EXCEEDED"]]) as FailureCase[]),
    [Buffer.from([0xff]), "report.csv", "text/csv", {}, "MALFORMED_FILE"],
  ])("fails the whole extraction with a safe code", async (fileBuffer, fileName, mimeType, limits, code) => {
    await expect(extractFinanceReportFile({ fileBuffer, fileName, mimeType, limits })).rejects.toMatchObject({ code });
  });
});
