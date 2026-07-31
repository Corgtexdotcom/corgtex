import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { Readable } from "node:stream";
import { CsvError, parse } from "csv-parse";
export type FinanceFileFormat = "CSV" | "PDF";
export type FinanceExtractedCellType = "TEXT";
export type FinanceFileExtractionErrorCode =
  | "EMPTY_FILE"
  | "FILE_TOO_LARGE"
  | "UNSUPPORTED_FILE_TYPE"
  | "FILE_TYPE_MISMATCH"
  | "MALFORMED_FILE"
  | "EMPTY_EXTRACTION"
  | "EXTRACTION_LIMIT_EXCEEDED"
  | "EXTRACTION_FAILED";
export type FinanceExtractedCell = {
  row: number;
  column: number;
  type: FinanceExtractedCellType;
  value: string;
  layout?: {
    x: number;
    y: number;
    width: number;
    height: number;
    transform: [number, number, number, number, number, number];
  };
};
export type FinanceExtractedSheet = {
  name: string;
  rowCount: number;
  columnCount: number;
  cells: FinanceExtractedCell[];
  page?: { width: number; height: number; rotation: number };
};
export type FinanceFileExtraction = { fileHash: string; fileSizeBytes: number; format: FinanceFileFormat; mimeType: string; sheets: FinanceExtractedSheet[] };
export type FinanceFileExtractionLimits = {
  maxFileBytes: number; maxRows: number; maxCells: number; maxTextChars: number;
  maxPdfPages: number; maxPdfItems: number; maxPdfOutputBytes: number; maxPdfParseMs: number;
};
const DEFAULT_LIMITS: FinanceFileExtractionLimits = {
  maxFileBytes: 25 * 1024 * 1024,
  maxRows: 20_000,
  maxCells: 250_000,
  maxTextChars: 2_000_000,
  maxPdfPages: 500,
  maxPdfItems: 250_000,
  maxPdfOutputBytes: 24 * 1024 * 1024,
  maxPdfParseMs: 15_000,
};
const PDF_MAX_HEAP_MB = 96;
const PDF_MAX_IMAGE_PIXELS = 4_000_000;
const PDF_MAX_STDERR_BYTES = 8_192;
const SAFE_MESSAGES: Record<FinanceFileExtractionErrorCode, string> = {
  EMPTY_FILE: "The report file is empty.",
  FILE_TOO_LARGE: "The report file exceeds the supported size limit.",
  UNSUPPORTED_FILE_TYPE: "Only CSV and machine-readable PDF finance reports are supported.",
  FILE_TYPE_MISMATCH: "The report filename and content type do not match.",
  MALFORMED_FILE: "The report file is malformed or unreadable.",
  EMPTY_EXTRACTION: "The report contains no extractable data.",
  EXTRACTION_LIMIT_EXCEEDED: "The report exceeds the supported extraction limits.",
  EXTRACTION_FAILED: "The report could not be extracted safely.",
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
  const byName: FinanceFileFormat | undefined = name.endsWith(".csv")
    ? "CSV"
    : name.endsWith(".pdf") ? "PDF" : undefined;
  const byMime = mime === "text/csv" || mime === "application/csv"
    || ((mime === "text/plain" || mime === "application/vnd.ms-excel") && byName === "CSV")
    ? "CSV"
    : mime === "application/pdf" ? "PDF"
    : undefined;
  if (/\.[^./]+$/.test(name) && !byName) fail("UNSUPPORTED_FILE_TYPE");
  if (byName && !genericMime && byName !== byMime) fail("FILE_TYPE_MISMATCH");
  const format = byName ?? byMime;
  if (!format) fail("UNSUPPORTED_FILE_TYPE");
  return format;
}
const PDF_WORKER_SOURCE = String.raw`
const limits = JSON.parse(process.env.CORGTEX_FINANCE_PDF_LIMITS || "{}");
class ControlledError extends Error { constructor(code) { super(code); this.code = code; } }
const stop = (code) => { throw new ControlledError(code); };
const round = (value) => {
  const rounded = Math.round(value * 1000) / 1000;
  if (!Number.isFinite(rounded)) stop("MALFORMED_FILE");
  return rounded;
};
async function main() {
  const chunks = [];
  for await (const chunk of process.stdin) chunks.push(chunk);
  const data = new Uint8Array(Buffer.concat(chunks));
  const { getDocument, OPS, Util } = await import("pdfjs-dist/legacy/build/pdf.mjs");
  const imageOps = new Set(Object.entries(OPS)
    .filter(([name]) => /^paint.*image/i.test(name))
    .map(([, value]) => value));
  const loadingTask = getDocument({
    data,
    disableFontFace: true,
    isEvalSupported: false,
    maxImageSize: ${PDF_MAX_IMAGE_PIXELS},
    stopAtErrors: false,
    useSystemFonts: true,
    verbosity: 1,
  });
  let document;
  try {
    document = await loadingTask.promise;
    if (document.numPages === 0) stop("EMPTY_EXTRACTION");
    if (document.numPages > limits.maxPdfPages) stop("EXTRACTION_LIMIT_EXCEEDED");
    const sheets = [];
    let itemCount = 0;
    let textChars = 0;
    for (let pageNumber = 1; pageNumber <= document.numPages; pageNumber += 1) {
      const page = await document.getPage(pageNumber);
      try {
        const operators = await page.getOperatorList();
        const hasImage = operators.fnArray.some((operator) => imageOps.has(operator));
        const viewport = page.getViewport({ scale: 1 });
        const content = await page.getTextContent();
        const cells = [];
        for (const item of content.items) {
          if (!("str" in item) || item.str.trim() === "") continue;
          itemCount += 1;
          textChars += item.str.length;
          if (itemCount > limits.maxPdfItems || textChars > limits.maxTextChars) {
            stop("EXTRACTION_LIMIT_EXCEEDED");
          }
          const transform = Util.transform(viewport.transform, item.transform).map(round);
          const width = Math.abs(item.width * viewport.scale * viewport.userUnit);
          const height = Math.abs(item.height * viewport.scale * viewport.userUnit);
          const xLength = Math.hypot(transform[0], transform[1]) || 1;
          const yLength = Math.hypot(transform[2], transform[3]) || 1;
          const xVector = [transform[0] / xLength * width, transform[1] / xLength * width];
          const yVector = [transform[2] / yLength * height, transform[3] / yLength * height];
          const xOffsets = [0, xVector[0], yVector[0], xVector[0] + yVector[0]];
          const yOffsets = [0, xVector[1], yVector[1], xVector[1] + yVector[1]];
          cells.push({
            row: cells.length + 1,
            column: 1,
            type: "TEXT",
            value: item.str,
            layout: {
              x: round(transform[4] + Math.min(...xOffsets)),
              y: round(transform[5] + Math.min(...yOffsets)),
              width: round(Math.max(...xOffsets) - Math.min(...xOffsets)),
              height: round(Math.max(...yOffsets) - Math.min(...yOffsets)),
              transform,
            },
          });
        }
        if (hasImage && cells.length === 0) stop("UNSUPPORTED_FILE_TYPE");
        sheets.push({
          name: "Page " + pageNumber,
          rowCount: cells.length,
          columnCount: cells.length === 0 ? 0 : 1,
          cells,
          page: { width: round(viewport.width), height: round(viewport.height), rotation: viewport.rotation },
        });
      } finally {
        page.cleanup();
      }
    }
    if (itemCount === 0) stop("EMPTY_EXTRACTION");
    return { ok: true, sheets };
  } finally {
    if (document) await document.destroy();
    else await loadingTask.destroy();
  }
}
try {
  process.stdout.write(JSON.stringify(await main()));
} catch (error) {
  const controlled = error instanceof ControlledError ? error.code
    : error instanceof RangeError ? "EXTRACTION_LIMIT_EXCEEDED"
    : "MALFORMED_FILE";
  process.stdout.write(JSON.stringify({ ok: false, code: controlled }));
}
`;
async function extractPdf(buffer: Buffer, limits: FinanceFileExtractionLimits) {
  return new Promise<FinanceExtractedSheet[]>((resolve, reject) => {
    const child = spawn(process.execPath, [
      `--max-old-space-size=${PDF_MAX_HEAP_MB}`,
      "--input-type=module",
      "--eval",
      PDF_WORKER_SOURCE,
    ], {
      cwd: process.cwd(),
      env: {
        CORGTEX_FINANCE_PDF_LIMITS: JSON.stringify({
          maxPdfItems: limits.maxPdfItems,
          maxPdfPages: limits.maxPdfPages,
          maxTextChars: limits.maxTextChars,
        }),
        NODE_ENV: "production",
        NODE_NO_WARNINGS: "1",
      },
      stdio: ["pipe", "pipe", "pipe"] as const,
    });
    const stdoutChunks: Buffer[] = [];
    let stdoutBytes = 0;
    let stderrBytes = 0;
    let stderr = "";
    let failure: FinanceFileExtractionErrorCode | undefined;
    const terminate = (code: FinanceFileExtractionErrorCode) => {
      failure ??= code;
      child.kill("SIGKILL");
    };
    const timer = setTimeout(() => terminate("EXTRACTION_LIMIT_EXCEEDED"), limits.maxPdfParseMs);
    child.stdout.on("data", (chunk: Buffer) => {
      stdoutBytes += chunk.length;
      if (stdoutBytes > limits.maxPdfOutputBytes) terminate("EXTRACTION_LIMIT_EXCEEDED");
      else stdoutChunks.push(Buffer.from(chunk));
    });
    child.stderr.on("data", (chunk: Buffer) => {
      stderrBytes += chunk.length;
      stderr += chunk.toString("utf8");
      if (stderrBytes > PDF_MAX_STDERR_BYTES) terminate("EXTRACTION_LIMIT_EXCEEDED");
    });
    child.on("error", () => {
      failure ??= "EXTRACTION_FAILED";
    });
    child.on("close", (code, signal) => {
      clearTimeout(timer);
      if (failure) return reject(new FinanceFileExtractionError(failure));
      if (stderr) return reject(new FinanceFileExtractionError(/Image exceeded maximum allowed size|heap out of memory/i.test(stderr)
        ? "EXTRACTION_LIMIT_EXCEEDED" : "MALFORMED_FILE"));
      if (signal) return reject(new FinanceFileExtractionError("EXTRACTION_LIMIT_EXCEEDED"));
      if (code !== 0) return reject(new FinanceFileExtractionError("EXTRACTION_FAILED"));
      try {
        const stdout = Buffer.concat(stdoutChunks, stdoutBytes).toString("utf8");
        const result = JSON.parse(stdout) as { ok?: boolean; code?: string; sheets?: FinanceExtractedSheet[] };
        if (result.ok === false && [
          "EMPTY_EXTRACTION", "EXTRACTION_LIMIT_EXCEEDED", "MALFORMED_FILE", "UNSUPPORTED_FILE_TYPE",
        ].includes(result.code ?? "")) {
          return reject(new FinanceFileExtractionError(result.code as FinanceFileExtractionErrorCode));
        }
        if (result.ok !== true || !Array.isArray(result.sheets)) {
          return reject(new FinanceFileExtractionError("EXTRACTION_FAILED"));
        }
        resolve(result.sheets);
      } catch {
        reject(new FinanceFileExtractionError("EXTRACTION_FAILED"));
      }
    });
    child.stdin.on("error", () => undefined);
    child.stdin.end(buffer);
  });
}
function assertCsvStructureLimits(text: string, limits: FinanceFileExtractionLimits) {
  let inQuotes = false;
  let atFieldStart = true;
  let rowCells = 1;
  let rows = 0;
  let cells = 0;
  let endedRecord = false;
  for (let index = text.charCodeAt(0) === 0xfeff ? 1 : 0; index < text.length; index += 1) {
    const character = text[index];
    if (inQuotes) {
      if (character === "\"" && text[index + 1] === "\"") index += 1;
      else if (character === "\"") inQuotes = false;
      endedRecord = false;
      continue;
    }
    if (character === "\"" && atFieldStart) {
      inQuotes = true;
      endedRecord = false;
    } else if (character === ",") {
      rowCells += 1;
      atFieldStart = true;
      endedRecord = false;
      if (cells + rowCells > limits.maxCells) fail("EXTRACTION_LIMIT_EXCEEDED");
    } else if (character === "\n" || character === "\r") {
      if (character === "\r" && text[index + 1] === "\n") index += 1;
      rows += 1;
      cells += rowCells;
      if (rows > limits.maxRows || cells > limits.maxCells) fail("EXTRACTION_LIMIT_EXCEEDED");
      rowCells = 1;
      atFieldStart = true;
      endedRecord = true;
    } else {
      atFieldStart = false;
      endedRecord = false;
    }
  }
  if (!endedRecord && (rows + 1 > limits.maxRows || cells + rowCells > limits.maxCells)) {
    fail("EXTRACTION_LIMIT_EXCEEDED");
  }
}
async function extractCsv(buffer: Buffer, limits: FinanceFileExtractionLimits) {
  const text = new TextDecoder("utf-8", { fatal: true }).decode(buffer);
  if (text.includes("\0")) fail("MALFORMED_FILE");
  assertCsvStructureLimits(text, limits);

  function* chunks() {
    for (let offset = 0; offset < buffer.length; offset += 65_536) {
      yield buffer.subarray(offset, offset + 65_536);
    }
  }

  const input = Readable.from(chunks());
  const parser = input.pipe(parse({
    bom: true,
    relax_column_count: false,
    record_delimiter: ["\r\n", "\n", "\r"],
    max_record_size: Math.max(1, (limits.maxTextChars * 3) + (limits.maxCells * 3) + 4),
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
        if (value === "") return;
        textChars += value.length;
        if (textChars > limits.maxTextChars) fail("EXTRACTION_LIMIT_EXCEEDED");
        cells.push({ row: rowCount, column: columnIndex + 1, type: "TEXT", value });
      });
    }
  } catch (error) {
    if (error instanceof CsvError && error.code === "CSV_MAX_RECORD_SIZE") fail("EXTRACTION_LIMIT_EXCEEDED");
    throw error;
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
    const override = params.limits?.[key];
    if (override !== undefined && Number.isSafeInteger(override) && override >= 0
      && (key !== "maxPdfParseMs" || override <= 2_147_483_647)) limits[key] = override;
  }
  if (params.fileBuffer.length === 0) fail("EMPTY_FILE");
  if (params.fileBuffer.length > limits.maxFileBytes) fail("FILE_TOO_LARGE");
  const fileBuffer = Buffer.from(params.fileBuffer);
  const format = detectFormat(params.fileName, params.mimeType);
  if (format === "PDF" && !fileBuffer.subarray(0, 1024).includes(Buffer.from("%PDF-"))) {
    fail("FILE_TYPE_MISMATCH");
  }
  const base = {
    fileHash: createHash("sha256").update(fileBuffer).digest("hex"),
    fileSizeBytes: fileBuffer.length,
    format,
    mimeType: format === "CSV" ? "text/csv" : "application/pdf",
  };
  try {
    return {
      ...base,
      sheets: format === "CSV" ? await extractCsv(fileBuffer, limits) : await extractPdf(fileBuffer, limits),
    };
  } catch (error) {
    if (error instanceof FinanceFileExtractionError) throw error;
    fail("MALFORMED_FILE");
  }
}
