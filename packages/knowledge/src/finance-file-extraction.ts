import { createHash } from "node:crypto";
import { Readable } from "node:stream";
import { parse } from "csv-parse";
import { PDFParse } from "pdf-parse";
export type FinanceFileFormat = "PDF" | "CSV";
export type FinanceExtractedCellType = "TEXT";
export type FinanceFileExtractionErrorCode =
  | "EMPTY_FILE"
  | "FILE_TOO_LARGE"
  | "UNSUPPORTED_FILE_TYPE"
  | "FILE_TYPE_MISMATCH"
  | "MALFORMED_FILE"
  | "EMPTY_EXTRACTION"
  | "SCANNED_PDF_UNSUPPORTED"
  | "EXTRACTION_LIMIT_EXCEEDED";
export type FinanceExtractedCell = { row: number; column: number; type: FinanceExtractedCellType; value: string };
export type FinanceExtractedSheet = { name: string; rowCount: number; columnCount: number; cells: FinanceExtractedCell[] };
export type FinanceFileExtraction = { fileHash: string; fileSizeBytes: number; format: FinanceFileFormat; mimeType: string; pages?: Array<{ page: number; text: string }>; sheets?: FinanceExtractedSheet[] };
export type FinanceFileExtractionLimits = {
  maxFileBytes: number; maxPages: number; maxRows: number; maxCells: number; maxTextChars: number;
};
const DEFAULT_LIMITS: FinanceFileExtractionLimits = {
  maxFileBytes: 25 * 1024 * 1024,
  maxPages: 250,
  maxRows: 20_000,
  maxCells: 250_000,
  maxTextChars: 2_000_000,
};
const SAFE_MESSAGES: Record<FinanceFileExtractionErrorCode, string> = {
  EMPTY_FILE: "The report file is empty.",
  FILE_TOO_LARGE: "The report file exceeds the supported size limit.",
  UNSUPPORTED_FILE_TYPE: "Only PDF and CSV finance reports are supported.",
  FILE_TYPE_MISMATCH: "The report filename and content type do not match.",
  MALFORMED_FILE: "The report file is malformed or unreadable.",
  EMPTY_EXTRACTION: "The report contains no extractable data.",
  SCANNED_PDF_UNSUPPORTED: "Image-only or scanned PDFs are not supported yet.",
  EXTRACTION_LIMIT_EXCEEDED: "The report exceeds the supported extraction limits.",
};
export class FinanceFileExtractionError extends Error {
  constructor(public readonly code: FinanceFileExtractionErrorCode) {
    super(SAFE_MESSAGES[code]);
    this.name = "FinanceFileExtractionError";
  }
}
function fail(code: FinanceFileExtractionErrorCode): never {
  throw new FinanceFileExtractionError(code);
}
function detectFormat(fileName: string, mimeType: string): FinanceFileFormat {
  const name = fileName.trim().toLowerCase();
  const mime = mimeType.split(";")[0]?.trim().toLowerCase();
  const genericMime = !mime || mime === "application/octet-stream";
  const byName = name.endsWith(".pdf") ? "PDF"
    : name.endsWith(".csv") ? "CSV"
      : undefined;
  const byMime = mime === "application/pdf" ? "PDF"
    : mime === "text/csv" || mime === "application/csv" || ((mime === "text/plain" || mime === "application/vnd.ms-excel") && byName === "CSV") ? "CSV"
      : undefined;
  if (/\.[^./]+$/.test(name) && !byName) fail("UNSUPPORTED_FILE_TYPE");
  if (byName && !genericMime && byName !== byMime) fail("FILE_TYPE_MISMATCH");
  const format = byName ?? byMime;
  if (!format) fail("UNSUPPORTED_FILE_TYPE");
  return format;
}
function assertSignature(buffer: Buffer, format: FinanceFileFormat) {
  if (format === "PDF" && !buffer.subarray(0, 1024).includes(Buffer.from("%PDF-"))) {
    fail("MALFORMED_FILE");
  }
}
async function extractPdf(buffer: Buffer, limits: FinanceFileExtractionLimits) {
  const parser = new PDFParse({ data: buffer });
  try {
    const result = await parser.getText();
    if (result.total > limits.maxPages) fail("EXTRACTION_LIMIT_EXCEEDED");
    const pages = result.pages.map(({ num, text }) => ({ page: num, text: text.trim() }));
    const textLength = pages.reduce((total, page) => total + page.text.length, 0);
    if (textLength > limits.maxTextChars) fail("EXTRACTION_LIMIT_EXCEEDED");
    if (!pages.some((page) => page.text)) fail("SCANNED_PDF_UNSUPPORTED");
    return pages;
  } finally {
    await parser.destroy();
  }
}
async function extractCsv(buffer: Buffer, limits: FinanceFileExtractionLimits) {
  const text = new TextDecoder("utf-8", { fatal: true }).decode(buffer);
  if (text.includes("\0")) fail("MALFORMED_FILE");

  function* chunks() {
    for (let offset = 0; offset < text.length; offset += 65_536) {
      yield text.slice(offset, offset + 65_536);
    }
  }

  const input = Readable.from(chunks());
  const parser = input.pipe(parse({
    bom: true,
    relax_column_count: false,
  }));
  const cells: FinanceExtractedCell[] = [];
  let rowCount = 0;
  let columnCount = 0;
  let cellsSeen = 0;
  let textChars = 0;
  try {
    for await (const record of parser) {
      const row = record as string[];
      rowCount += 1;
      cellsSeen += row.length;
      columnCount = Math.max(columnCount, row.length);
      if (rowCount > limits.maxRows || cellsSeen > limits.maxCells) fail("EXTRACTION_LIMIT_EXCEEDED");
      row.forEach((value, columnIndex) => {
        if (!value.trim()) return;
        textChars += value.length;
        if (textChars > limits.maxTextChars) fail("EXTRACTION_LIMIT_EXCEEDED");
        cells.push({ row: rowCount, column: columnIndex + 1, type: "TEXT", value });
      });
    }
  } finally {
    input.destroy();
    parser.destroy();
  }
  if (cells.length === 0) fail("EMPTY_EXTRACTION");
  return [{ name: "CSV", rowCount, columnCount, cells }];
}
export async function extractFinanceReportFile(params: {
  fileBuffer: Buffer;
  fileName: string;
  mimeType: string;
  limits?: Partial<FinanceFileExtractionLimits>;
}): Promise<FinanceFileExtraction> {
  const limits = { ...DEFAULT_LIMITS };
  for (const key of Object.keys(DEFAULT_LIMITS) as Array<keyof FinanceFileExtractionLimits>) {
    limits[key] = params.limits?.[key] ?? limits[key];
  }
  if (params.fileBuffer.length === 0) fail("EMPTY_FILE");
  if (params.fileBuffer.length > limits.maxFileBytes) fail("FILE_TOO_LARGE");
  const format = detectFormat(params.fileName, params.mimeType);
  assertSignature(params.fileBuffer, format);
  const base = {
    fileHash: createHash("sha256").update(params.fileBuffer).digest("hex"),
    fileSizeBytes: params.fileBuffer.length,
    format,
    mimeType: format === "PDF" ? "application/pdf"
      : "text/csv",
  };
  try {
    if (format === "PDF") return { ...base, pages: await extractPdf(params.fileBuffer, limits) };
    return { ...base, sheets: await extractCsv(params.fileBuffer, limits) };
  } catch (error) {
    if (error instanceof FinanceFileExtractionError) throw error;
    fail("MALFORMED_FILE");
  }
}
