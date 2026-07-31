import { createHash } from "node:crypto";
import { spawn } from "node:child_process";
import { createRequire } from "node:module";
import { Readable } from "node:stream";
import { pathToFileURL } from "node:url";
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
  | "SCANNED_PDF_UNSUPPORTED"
  | "UNSUPPORTED_PDF_FEATURE"
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
  UNSUPPORTED_PDF_FEATURE: "This PDF uses a structured or vertical text mode that is not supported yet.",
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
  const byName = name.endsWith(".pdf") ? "PDF" : name.endsWith(".csv") ? "CSV" : undefined;
  const byMime = mime === "application/pdf" ? "PDF" : mime === "text/csv" || mime === "application/csv"
    || ((mime === "text/plain" || mime === "application/vnd.ms-excel") && byName === "CSV")
    ? "CSV"
    : undefined;
  if (/\.[^./]+$/.test(name) && !byName) fail("UNSUPPORTED_FILE_TYPE");
  if (byName && !genericMime && byName !== byMime) fail("FILE_TYPE_MISMATCH");
  const format = byName ?? byMime;
  if (!format) fail("UNSUPPORTED_FILE_TYPE");
  return format;
}
const PDF_PROCESS_TIMEOUT_MS = 30_000;
const PDF_PROCESS_MAX_OUTPUT_BYTES = 16 * 1024 * 1024;
const PDF_PROCESS_MAX_DATA_KIB = 256 * 1024;
const PDF_PROCESS_SOURCE = String.raw`
const fail = (code) => { const error = new Error(code); error.code = code; throw error; };
(async () => {
  const [moduleUrl, cMapUrl, standardFontDataUrl, maxPagesValue, maxTextCharsValue] = process.argv.slice(1);
  const maxPages = Number(maxPagesValue);
  const maxTextChars = Number(maxTextCharsValue);
  const chunks = [];
  for await (const chunk of process.stdin) chunks.push(chunk);
  const { getDocument, OPS, VerbosityLevel } = await import(moduleUrl);
  const imageOps = new Set(Object.entries(OPS)
    .filter(([name]) => /image/i.test(name) && !name.startsWith("end"))
    .map(([, value]) => value));
  const task = getDocument({
    data: new Uint8Array(Buffer.concat(chunks)),
    cMapPacked: true,
    cMapUrl,
    enableXfa: true,
    isEvalSupported: false,
    standardFontDataUrl,
    stopAtErrors: true,
    useSystemFonts: false,
    verbosity: VerbosityLevel.ERRORS,
  });
  try {
    const document = await task.promise;
    if (document.numPages === 0) fail("EMPTY_EXTRACTION");
    if (document.numPages > maxPages) fail("EXTRACTION_LIMIT_EXCEEDED");
    if (document.isPureXfa || await document.getFieldObjects()) fail("UNSUPPORTED_PDF_FEATURE");
    const pages = [];
    let textChars = 0;
    for (let pageNumber = 1; pageNumber <= document.numPages; pageNumber += 1) {
      const page = await document.getPage(pageNumber);
      let text = "";
      let previous;
      let sawVerticalText = false;
      const verticalFonts = new Set();
      const append = (value) => {
        textChars += value.length;
        if (textChars > maxTextChars) fail("EXTRACTION_LIMIT_EXCEEDED");
        text += value;
      };
      const consume = (content) => {
        for (const [fontName, style] of Object.entries(content.styles || {})) {
          if (style.vertical) verticalFonts.add(fontName);
        }
        for (const item of content.items) {
          if (!("str" in item)) continue;
          if (!Array.isArray(item.transform)) {
            if (text && !text.endsWith("\n")) append("\n");
            append(item.str);
            continue;
          }
          const [a, b, c, d, x, y] = item.transform;
          const vertical = verticalFonts.has(item.fontName);
          if (vertical) sawVerticalText = true;
          const axisX = vertical ? -c : a;
          const axisY = vertical ? -d : b;
          const scale = Math.hypot(axisX, axisY) || 1;
          const ux = axisX / scale;
          const uy = axisY / scale;
          if (previous) {
            const dx = x - previous.x;
            const dy = y - previous.y;
            const cross = Math.abs((-uy * dx) + (ux * dy));
            const alignment = (previous.ux * ux) + (previous.uy * uy);
            if ((alignment < 0.98 || cross > 4.6) && !text.endsWith("\n")) append("\n");
            else if (Math.abs((ux * dx) + (uy * dy)) > 7) append("\t");
          }
          append(item.str);
          if (item.hasEOL && !text.endsWith("\n")) append("\n");
          const advance = vertical
            ? item.height * (scale / (Math.hypot(a, b) || 1))
            : item.width;
          previous = item.hasEOL ? undefined : {
            x: x + (ux * advance),
            y: y + (uy * advance),
            ux,
            uy,
          };
        }
      };
      try {
        const reader = page.streamTextContent().getReader();
        while (true) {
          const chunk = await reader.read();
          if (chunk.done) break;
          consume(chunk.value);
        }
        if (sawVerticalText || !text.trim()) {
          const operators = await page.getOperatorList();
          if (operators.fnArray.some((operator) => imageOps.has(operator))) {
            fail("SCANNED_PDF_UNSUPPORTED");
          }
          if (sawVerticalText && operators.fnArray.some((operator, index) =>
            operator === OPS.setTextRenderingMode
            && (Number(operators.argsArray[index]?.[0]) & 3) === 3)) {
            fail("UNSUPPORTED_PDF_FEATURE");
          }
        }
      } finally {
        page.cleanup();
      }
      pages.push({ page: pageNumber, text });
    }
    if (!pages.some((page) => page.text.trim())) fail("EMPTY_EXTRACTION");
    return pages;
  } finally {
    await task.destroy();
  }
})().then(
  (pages) => process.stdout.write(JSON.stringify({ ok: true, pages })),
  (error) => {
    const known = new Set(["EMPTY_EXTRACTION", "SCANNED_PDF_UNSUPPORTED", "UNSUPPORTED_PDF_FEATURE", "EXTRACTION_LIMIT_EXCEEDED"]);
    process.stdout.write(JSON.stringify({ ok: false, code: known.has(error?.code) ? error.code : "MALFORMED_FILE" }));
  },
);
`;
function extractPdf(buffer: Buffer, limits: FinanceFileExtractionLimits) {
  if (process.platform !== "linux") fail("EXTRACTION_LIMIT_EXCEEDED");
  const resolveModule = createRequire(import.meta.url).resolve;
  const moduleUrl = pathToFileURL(
    resolveModule("pdfjs-dist/legacy/build/pdf.mjs"),
  ).href;
  const cMapUrl = resolveModule("pdfjs-dist/cmaps/LICENSE")
    .replaceAll("\\", "/")
    .replace(/LICENSE$/, "");
  const standardFontDataUrl = resolveModule("pdfjs-dist/standard_fonts/LICENSE_FOXIT")
    .replaceAll("\\", "/")
    .replace(/LICENSE_FOXIT$/, "");
  return new Promise<Array<{ page: number; text: string }>>((resolve, reject) => {
    const nodeArgs = [
      "--max-old-space-size=128",
      "--max-semi-space-size=16",
      "--stack-size=4096",
      "-e",
      PDF_PROCESS_SOURCE,
      moduleUrl,
      cMapUrl,
      standardFontDataUrl,
      String(limits.maxPages),
      String(limits.maxTextChars),
    ];
    const child = spawn("/bin/sh", [
      "-c",
      `ulimit -d ${PDF_PROCESS_MAX_DATA_KIB} || exit 70; exec "$@"`,
      "finance-pdf",
      process.execPath,
      ...nodeArgs,
    ], {
      stdio: ["pipe", "pipe", "ignore"],
      windowsHide: true,
    });
    const output: Buffer[] = [];
    let outputBytes = 0;
    let settled = false;
    const finish = (callback: () => void, kill = true) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      if (kill) {
        child.stdin.destroy();
        if (!child.killed) child.kill("SIGKILL");
      }
      callback();
    };
    const timeout = setTimeout(() => {
      finish(() => reject(new FinanceFileExtractionError("EXTRACTION_LIMIT_EXCEEDED")));
    }, PDF_PROCESS_TIMEOUT_MS);
    child.stdout.on("data", (chunk: Buffer) => {
      if (settled) return;
      outputBytes += chunk.length;
      if (outputBytes > PDF_PROCESS_MAX_OUTPUT_BYTES) {
        finish(() => reject(new FinanceFileExtractionError("EXTRACTION_LIMIT_EXCEEDED")));
      } else {
        output.push(chunk);
      }
    });
    child.on("error", (error: NodeJS.ErrnoException) => {
      const resourceErrors = new Set(["EAGAIN", "EMFILE", "ENFILE", "ENOMEM"]);
      const code = error.code && resourceErrors.has(error.code)
        ? "EXTRACTION_LIMIT_EXCEEDED"
        : "MALFORMED_FILE";
      finish(() => reject(new FinanceFileExtractionError(code)));
    });
    child.on("close", (code, signal) => {
      if (settled) return;
      if (code !== 0 || signal) {
        finish(() => reject(new FinanceFileExtractionError("EXTRACTION_LIMIT_EXCEEDED")), false);
        return;
      }
      try {
        const message = JSON.parse(Buffer.concat(output).toString("utf8")) as {
          ok?: boolean;
          pages?: Array<{ page: number; text: string }>;
          code?: FinanceFileExtractionErrorCode;
        };
        const safeCodes = new Set<FinanceFileExtractionErrorCode>([
          "EMPTY_EXTRACTION",
          "SCANNED_PDF_UNSUPPORTED",
          "UNSUPPORTED_PDF_FEATURE",
          "EXTRACTION_LIMIT_EXCEEDED",
          "MALFORMED_FILE",
        ]);
        if (message.ok && Array.isArray(message.pages)) {
          finish(() => resolve(message.pages!), false);
        } else {
          const errorCode = message.code && safeCodes.has(message.code) ? message.code : "MALFORMED_FILE";
          finish(() => reject(new FinanceFileExtractionError(errorCode)), false);
        }
      } catch {
        finish(() => reject(new FinanceFileExtractionError("MALFORMED_FILE")), false);
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
    if (override !== undefined && Number.isSafeInteger(override) && override >= 0) limits[key] = override;
  }
  if (params.fileBuffer.length === 0) fail("EMPTY_FILE");
  if (params.fileBuffer.length > limits.maxFileBytes) fail("FILE_TOO_LARGE");
  const fileBuffer = Buffer.from(params.fileBuffer);
  const format = detectFormat(params.fileName, params.mimeType);
  if (format === "PDF" && !fileBuffer.subarray(0, 1024).includes(Buffer.from("%PDF-"))) fail("MALFORMED_FILE");
  const base = {
    fileHash: createHash("sha256").update(fileBuffer).digest("hex"),
    fileSizeBytes: fileBuffer.length,
    format,
    mimeType: format === "PDF" ? "application/pdf" : "text/csv",
  };
  try {
    if (format === "PDF") return { ...base, pages: await extractPdf(fileBuffer, limits) };
    return { ...base, sheets: await extractCsv(fileBuffer, limits) };
  } catch (error) {
    if (error instanceof FinanceFileExtractionError) throw error;
    fail("MALFORMED_FILE");
  }
}
