import { createHash } from "node:crypto";
import { Readable } from "node:stream";
import { parse } from "csv-parse";
import { strFromU8, unzipSync } from "fflate";
import { PDFParse } from "pdf-parse";
import readXlsxFile from "read-excel-file/node";
export type FinanceFileFormat = "PDF" | "CSV" | "XLSX";
export type FinanceExtractedCellType = "TEXT" | "NUMBER" | "BOOLEAN" | "DATE";
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
  maxFileBytes: number; maxPages: number; maxSheets: number; maxRows: number; maxCells: number;
  maxTextChars: number; maxZipEntries: number; maxZipUncompressedBytes: number;
};
const DEFAULT_LIMITS: FinanceFileExtractionLimits = {
  maxFileBytes: 25 * 1024 * 1024,
  maxPages: 250,
  maxSheets: 25,
  maxRows: 20_000,
  maxCells: 250_000,
  maxTextChars: 2_000_000,
  maxZipEntries: 2_048,
  maxZipUncompressedBytes: 100 * 1024 * 1024,
};
const SAFE_MESSAGES: Record<FinanceFileExtractionErrorCode, string> = {
  EMPTY_FILE: "The report file is empty.",
  FILE_TOO_LARGE: "The report file exceeds the supported size limit.",
  UNSUPPORTED_FILE_TYPE: "Only PDF, CSV, and XLSX finance reports are supported.",
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
      : name.endsWith(".xlsx") ? "XLSX" : undefined;
  const byMime = mime === "application/pdf" ? "PDF"
    : mime === "text/csv" || mime === "application/csv" || ((mime === "text/plain" || mime === "application/vnd.ms-excel") && byName === "CSV") ? "CSV"
      : mime === "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" || mime === "application/zip" ? "XLSX" : undefined;
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
  if (format === "XLSX" && (buffer.length < 4 || buffer.readUInt32LE(0) !== 0x04034b50)) fail("MALFORMED_FILE");
}
function assertXlsxArchiveLimits(buffer: Buffer, limits: FinanceFileExtractionLimits) {
  const first = Math.max(0, buffer.length - 65_557);
  let end = -1;
  for (let offset = buffer.length - 22; offset >= first; offset -= 1) {
    if (buffer.readUInt32LE(offset) === 0x06054b50) {
      end = offset;
      break;
    }
  }
  if (end < 0) fail("MALFORMED_FILE");
  const entries = buffer.readUInt16LE(end + 10);
  const centralSize = buffer.readUInt32LE(end + 12);
  let offset = buffer.readUInt32LE(end + 16);
  if (entries === 0xffff || centralSize === 0xffffffff || offset === 0xffffffff) fail("EXTRACTION_LIMIT_EXCEEDED");
  if (offset + centralSize > end) fail("MALFORMED_FILE");
  if (entries > limits.maxZipEntries) fail("EXTRACTION_LIMIT_EXCEEDED");
  let uncompressed = 0;
  for (let index = 0; index < entries; index += 1) {
    if (offset + 46 > end || buffer.readUInt32LE(offset) !== 0x02014b50) fail("MALFORMED_FILE");
    if ((buffer.readUInt16LE(offset + 8) & 1) !== 0) fail("MALFORMED_FILE");
    const size = buffer.readUInt32LE(offset + 24);
    if (size === 0xffffffff) fail("EXTRACTION_LIMIT_EXCEEDED");
    uncompressed += size;
    if (uncompressed > limits.maxZipUncompressedBytes) fail("EXTRACTION_LIMIT_EXCEEDED");
    offset += 46 + buffer.readUInt16LE(offset + 28) + buffer.readUInt16LE(offset + 30) + buffer.readUInt16LE(offset + 32);
  }
  if (offset !== end) fail("MALFORMED_FILE");
}
function assertXlsxSheetLimits(buffer: Buffer, limits: FinanceFileExtractionLimits) {
  const files = unzipSync(buffer, { filter: ({ name }) => /^xl\/worksheets\/[^/]+\.xml$/i.test(name) });
  if (Object.keys(files).length > limits.maxSheets) fail("EXTRACTION_LIMIT_EXCEEDED");
  let rows = 0;
  let cells = 0;
  for (const bytes of Object.values(files)) {
    const xml = strFromU8(bytes);
    let lastRow = 0;
    let lastColumn = 0;
    for (const match of xml.matchAll(/<dimension\b[^>]*\bref="\$?([A-Z]+)\$?(\d+)(?::\$?([A-Z]+)\$?(\d+))?"|<c\b[^>]*\br="\$?([A-Z]+)\$?(\d+)"/gi)) {
      const letters = match[3] ?? match[1] ?? match[5];
      lastColumn = Math.max(lastColumn, [...letters].reduce((n, letter) => (n * 26) + letter.charCodeAt(0) - 64, 0));
      lastRow = Math.max(lastRow, Number(match[4] ?? match[2] ?? match[6]));
    }
    rows += lastRow;
    cells += lastRow * lastColumn;
    if (rows > limits.maxRows || cells > limits.maxCells) fail("EXTRACTION_LIMIT_EXCEEDED");
  }
}
type ExactNumber = { exactNumber: string };
type RawCell = string | ExactNumber | boolean | Date | typeof Date | null;
function normalizeSheets(sheets: Array<{ sheet: string; data: RawCell[][] }>, limits: FinanceFileExtractionLimits) {
  if (sheets.length > limits.maxSheets) fail("EXTRACTION_LIMIT_EXCEEDED");
  let rows = 0;
  let cellsSeen = 0;
  let textChars = 0;
  const extracted = sheets.map(({ sheet, data }) => {
    rows += data.length;
    if (rows > limits.maxRows) fail("EXTRACTION_LIMIT_EXCEEDED");
    const cells: FinanceExtractedCell[] = [];
    let columnCount = 0;
    data.forEach((row, rowIndex) => {
      columnCount = Math.max(columnCount, row.length);
      cellsSeen += row.length;
      if (cellsSeen > limits.maxCells) fail("EXTRACTION_LIMIT_EXCEEDED");
      row.forEach((raw, columnIndex) => {
        if (raw === null || (typeof raw === "string" && !raw.trim())) return;
        if (typeof raw === "function") fail("MALFORMED_FILE");
        const type = typeof raw === "object" ? raw instanceof Date ? "DATE" : "NUMBER" : typeof raw === "boolean" ? "BOOLEAN" : "TEXT";
        const value = raw instanceof Date ? raw.toISOString() : typeof raw === "object" ? raw.exactNumber : typeof raw === "boolean" ? raw ? "TRUE" : "FALSE" : raw;
        textChars += value.length;
        if (textChars > limits.maxTextChars) fail("EXTRACTION_LIMIT_EXCEEDED");
        cells.push({ row: rowIndex + 1, column: columnIndex + 1, type, value });
      });
    });
    return { name: sheet, rowCount: data.length, columnCount, cells };
  }).filter((sheet) => sheet.cells.length > 0);
  if (extracted.length === 0) fail("EMPTY_EXTRACTION");
  return extracted;
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
    max_record_size: limits.maxTextChars,
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
      : format === "CSV" ? "text/csv"
        : "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  };
  try {
    if (format === "PDF") return { ...base, pages: await extractPdf(params.fileBuffer, limits) };
    if (format === "CSV") return { ...base, sheets: await extractCsv(params.fileBuffer, limits) };
    assertXlsxArchiveLimits(params.fileBuffer, limits);
    assertXlsxSheetLimits(params.fileBuffer, limits);
    const sheets = await readXlsxFile<ExactNumber>(params.fileBuffer, {
      trim: false,
      parseNumber: (value) => ({ exactNumber: value }),
    });
    return { ...base, sheets: normalizeSheets(sheets, limits) };
  } catch (error) {
    if (error instanceof FinanceFileExtractionError) throw error;
    fail("MALFORMED_FILE");
  }
}
