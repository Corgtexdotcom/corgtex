import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";

export const PPTX_MIME_TYPE = "application/vnd.openxmlformats-officedocument.presentationml.presentation";

export type PptxExtractionErrorCode =
  | "FILE_TOO_LARGE"
  | "NOT_PPTX"
  | "MALFORMED_FILE"
  | "EMPTY_EXTRACTION"
  | "EXTRACTION_LIMIT_EXCEEDED"
  | "EXTRACTION_TIMEOUT"
  | "EXTRACTION_FAILED";

const SAFE_MESSAGES: Record<PptxExtractionErrorCode, string> = {
  FILE_TOO_LARGE: "The presentation exceeds the 25 MB upload limit.",
  NOT_PPTX: "The file is not a valid PowerPoint presentation.",
  MALFORMED_FILE: "The presentation is malformed, encrypted, or unreadable.",
  EMPTY_EXTRACTION: "The presentation has no extractable native slide or speaker-note text.",
  EXTRACTION_LIMIT_EXCEEDED: "The presentation exceeds the supported extraction limits.",
  EXTRACTION_TIMEOUT: "Presentation text extraction timed out.",
  EXTRACTION_FAILED: "Presentation text extraction could not be completed safely.",
};

export class PptxExtractionError extends Error {
  constructor(public readonly code: PptxExtractionErrorCode) {
    super(SAFE_MESSAGES[code]);
    this.name = "PptxExtractionError";
  }
}

type PptxExtractionLimits = Partial<{
  maxInputBytes: number;
  maxUncompressedBytes: number;
  maxZipEntries: number;
  maxSlides: number;
  maxTextLength: number;
  processTimeoutMs: number;
}>;

const DEFAULT_LIMITS = {
  maxInputBytes: 25 * 1024 * 1024,
  maxUncompressedBytes: 128 * 1024 * 1024,
  maxZipEntries: 5_000,
  maxSlides: 500,
  maxTextLength: 100_000,
  processTimeoutMs: 30_000,
};
const PROCESS_MAX_OUTPUT_BYTES = 2 * 1024 * 1024;

const PROCESS_SOURCE = String.raw`
const { posix: path } = require("node:path");
const fail = (code) => { const error = new Error(code); error.code = code; throw error; };
const elements = (node, localName) => Array.from(node.getElementsByTagName("*")).filter((item) => item.localName === localName);
const normalizeText = (value) => String(value || "").replace(/\s+/g, " ").trim();
const OFFICE_RELATIONSHIPS_NS = "http://schemas.openxmlformats.org/officeDocument/2006/relationships";

(async () => {
  const [packageAnchor, maxInputValue, maxUncompressedValue, maxEntriesValue, maxSlidesValue, maxTextValue] = process.argv.slice(1);
  const maxInputBytes = Number(maxInputValue);
  const maxUncompressedBytes = Number(maxUncompressedValue);
  const maxZipEntries = Number(maxEntriesValue);
  const maxSlides = Number(maxSlidesValue);
  const maxTextLength = Number(maxTextValue);
  const chunks = [];
  let inputBytes = 0;
  for await (const chunk of process.stdin) {
    inputBytes += chunk.length;
    if (inputBytes > maxInputBytes) fail("FILE_TOO_LARGE");
    chunks.push(chunk);
  }
  const buffer = Buffer.concat(chunks);
  let JSZip;
  let DOMParser;
  let OfficeParser;
  try {
    const packageRequire = require("node:module").createRequire(packageAnchor);
    const officeParserPath = packageRequire.resolve("officeparser");
    const jsZipPath = packageRequire.resolve("jszip");
    const xmlDomPath = packageRequire.resolve("@xmldom/xmldom");
    JSZip = require(jsZipPath);
    ({ DOMParser } = require(xmlDomPath));
    ({ OfficeParser } = require(officeParserPath));
  } catch {
    fail("EXTRACTION_FAILED");
  }
  let zip;
  try {
    zip = await JSZip.loadAsync(buffer, { checkCRC32: false, createFolders: false });
  } catch {
    fail("NOT_PPTX");
  }
  const entries = Object.values(zip.files).filter((entry) => !entry.dir);
  if (entries.length > maxZipEntries) fail("EXTRACTION_LIMIT_EXCEEDED");
  let inspectedBytes = 0;
  let needsXmlNormalization = false;
  const partCache = new Map();
  const decodeXml = (content) => {
    let encoding = "utf-8";
    let offset = 0;
    if (content[0] === 0xff && content[1] === 0xfe) {
      encoding = "utf-16le";
      offset = 2;
    } else if (content[0] === 0xfe && content[1] === 0xff) {
      encoding = "utf-16be";
      offset = 2;
    } else if (content[0] === 0x3c && content[1] === 0x00 && content[2] === 0x3f && content[3] === 0x00) {
      encoding = "utf-16le";
    } else if (content[0] === 0x00 && content[1] === 0x3c && content[2] === 0x00 && content[3] === 0x3f) {
      encoding = "utf-16be";
    }
    let text;
    try {
      text = new TextDecoder(encoding, { fatal: true }).decode(content.subarray(offset));
    } catch {
      fail("MALFORMED_FILE");
    }
    const declared = text.match(/^<\?xml\s+[^>]*encoding\s*=\s*["']([^"']+)["']/i)?.[1]?.toLowerCase();
    const declaredEncoding = declared === "utf8" ? "utf-8" : declared;
    if (declaredEncoding && !["utf-8", "utf-16", "utf-16le", "utf-16be"].includes(declaredEncoding)) {
      fail("MALFORMED_FILE");
    }
    if (declaredEncoding === "utf-8" && encoding !== "utf-8") fail("MALFORMED_FILE");
    if (declaredEncoding?.startsWith("utf-16") && encoding === "utf-8") fail("MALFORMED_FILE");
    if (declaredEncoding === "utf-16le" && encoding !== "utf-16le") fail("MALFORMED_FILE");
    if (declaredEncoding === "utf-16be" && encoding !== "utf-16be") fail("MALFORMED_FILE");
    if (encoding !== "utf-8") needsXmlNormalization = true;
    return text;
  };
  const readPart = async (partName, required = true) => {
    if (partCache.has(partName)) return partCache.get(partName);
    const entry = zip.file(partName);
    if (!entry) {
      if (required) fail("MALFORMED_FILE");
      return null;
    }
    const content = await entry.async("nodebuffer");
    inspectedBytes += content.length;
    if (inspectedBytes > Math.min(maxUncompressedBytes, 16 * 1024 * 1024)) fail("EXTRACTION_LIMIT_EXCEEDED");
    const text = decodeXml(content);
    partCache.set(partName, text);
    return text;
  };
  const parseXml = (value) => {
    let invalid = false;
    const document = new DOMParser({
      onError: (level) => { if (level !== "warning") invalid = true; },
    }).parseFromString(value, "application/xml");
    if (invalid || !document?.documentElement) fail("MALFORMED_FILE");
    return document;
  };
  const contentTypes = parseXml(await readPart("[Content_Types].xml"));
  const isPptx = elements(contentTypes, "Override").some((node) =>
    node.getAttribute("PartName") === "/ppt/presentation.xml"
      && node.getAttribute("ContentType") === "application/vnd.openxmlformats-officedocument.presentationml.presentation.main+xml");
  if (!isPptx) fail("NOT_PPTX");

  const presentation = parseXml(await readPart("ppt/presentation.xml"));
  const relationships = parseXml(await readPart("ppt/_rels/presentation.xml.rels"));
  const slideTargets = new Map();
  for (const relation of elements(relationships, "Relationship")) {
    if (!relation.getAttribute("Type")?.endsWith("/slide")) continue;
    if ((relation.getAttribute("TargetMode") || "Internal") !== "Internal") continue;
    const target = relation.getAttribute("Target") || "";
    const normalized = path.normalize(target.startsWith("/") ? target.slice(1) : path.join("ppt", target));
    if (!/^ppt\/slides\/slide\d+\.xml$/.test(normalized)) fail("MALFORMED_FILE");
    slideTargets.set(relation.getAttribute("Id"), normalized);
  }
  const orderedSlides = elements(presentation, "sldId").map((node) =>
    slideTargets.get(node.getAttributeNS(OFFICE_RELATIONSHIPS_NS, "id")));
  if (orderedSlides.some((target) => !target) || new Set(orderedSlides).size !== orderedSlides.length) fail("MALFORMED_FILE");
  if (orderedSlides.length > maxSlides) fail("EXTRACTION_LIMIT_EXCEEDED");

  const visibleSlides = [];
  for (const target of orderedSlides) {
    const match = target.match(/slide(\d+)\.xml$/);
    if (!match) fail("MALFORMED_FILE");
    const slideNumber = Number(match[1]);
    const slideDocument = parseXml(await readPart(target));
    const show = slideDocument.documentElement.getAttribute("show");
    if (show === "0" || show === "false") continue;
    const relationPath = target.replace("/slides/", "/slides/_rels/") + ".rels";
    const relationXml = await readPart(relationPath, false);
    let noteNumber;
    if (relationXml) {
      const relationDocument = parseXml(relationXml);
      const noteRelation = elements(relationDocument, "Relationship").find((node) =>
        node.getAttribute("Type")?.endsWith("/notesSlide")
          && (node.getAttribute("TargetMode") || "Internal") === "Internal");
      const noteTarget = noteRelation?.getAttribute("Target");
      if (noteTarget) {
        const normalized = path.normalize(path.join(path.dirname(target), noteTarget));
        const noteMatch = normalized.match(/^ppt\/notesSlides\/notesSlide(\d+)\.xml$/);
        if (!noteMatch) fail("MALFORMED_FILE");
        noteNumber = Number(noteMatch[1]);
      }
    }
    visibleSlides.push({ slideNumber, noteNumber });
  }

  const parserPartPattern = /^(?:ppt\/(?:presentation\.xml|slides\/slide\d+\.xml|notesSlides\/notesSlide\d+\.xml|slides\/_rels\/slide\d+\.xml\.rels)|docProps\/(?:core|custom|app)\.xml)$/;
  for (const entry of entries) {
    if (!parserPartPattern.test(entry.name)) continue;
    parseXml(await readPart(entry.name));
  }
  let parserBuffer = buffer;
  if (needsXmlNormalization) {
    const normalizedZip = new JSZip();
    normalizedZip.file("[Content_Types].xml", await readPart("[Content_Types].xml"));
    for (const [partName, text] of partCache) {
      if (parserPartPattern.test(partName)) normalizedZip.file(partName, text);
    }
    parserBuffer = await normalizedZip.generateAsync({
      type: "nodebuffer",
      compression: "DEFLATE",
      compressionOptions: { level: 6 },
    });
  }

  const ast = await OfficeParser.parseOffice(parserBuffer, {
    fileType: "pptx",
    ignoreComments: true,
    ignoreSlideMasters: true,
    extractAttachments: false,
    includeRawContent: false,
    ocr: false,
    outputErrorToConsole: false,
    onWarning: () => undefined,
    decompressionLimits: { maxUncompressedBytes, maxZipEntries, maxTableCells: 100_000 },
  });
  const slides = new Map();
  const notes = new Map();
  for (const slide of ast.content || []) {
    if (slide.type !== "slide") continue;
    const number = Number(slide.metadata?.slideNumber);
    if (Number.isFinite(number)) slides.set(number, slide);
    for (const note of slide.notes || []) {
      const noteNumber = Number(note.metadata?.slideNumber);
      if (Number.isFinite(noteNumber)) notes.set(noteNumber, note);
    }
  }
  const renderNode = (node) => {
    if (!node || ["image", "chart", "drawing", "comment", "embed", "slideMaster"].includes(node.type)) return [];
    if (node.type === "table") {
      return (node.children || []).map((row) => (row.children || [])
        .map((cell) => normalizeText(cell.text || renderNode(cell).join(" ")))
        .filter(Boolean).join(" | ")).filter(Boolean);
    }
    const direct = normalizeText(node.text);
    return direct ? [direct] : (node.children || []).flatMap(renderNode);
  };
  const blocks = [];
  let notesIncluded = false;
  visibleSlides.forEach(({ slideNumber, noteNumber }, index) => {
    const body = (slides.get(slideNumber)?.children || []).flatMap(renderNode).filter(Boolean);
    const note = noteNumber ? notes.get(noteNumber) : undefined;
    const noteLines = (note?.children || []).flatMap(renderNode)
      .filter((line) => line !== String(slideNumber) && line !== String(index + 1));
    if (body.length === 0 && noteLines.length === 0) return;
    if (noteLines.length > 0) notesIncluded = true;
    blocks.push(["Slide " + (index + 1), ...body, ...(noteLines.length ? ["Speaker notes", ...noteLines] : [])].join("\n"));
  });
  const fullText = blocks.join("\n\n").trim();
  if (!fullText) fail("EMPTY_EXTRACTION");
  const truncated = fullText.length > maxTextLength;
  const textContent = truncated ? fullText.slice(0, maxTextLength) + "\n...[truncated]" : fullText;
  return { textContent, slideCount: visibleSlides.length, notesIncluded, truncated };
})().then(
  (value) => process.stdout.write(JSON.stringify({ ok: true, value })),
  (error) => {
    const known = new Set(["FILE_TOO_LARGE", "NOT_PPTX", "MALFORMED_FILE", "EMPTY_EXTRACTION", "EXTRACTION_LIMIT_EXCEEDED", "EXTRACTION_FAILED"]);
    process.stdout.write(JSON.stringify({ ok: false, code: known.has(error?.code) ? error.code : "MALFORMED_FILE" }));
  },
);
`;

function boundedLimit(value: number | undefined, maximum: number) {
  return value && Number.isFinite(value) && value > 0 ? Math.min(Math.floor(value), maximum) : maximum;
}

function findKnowledgePackageAnchor() {
  let current = process.cwd();
  for (;;) {
    const candidate = join(current, "packages/knowledge/package.json");
    if (existsSync(candidate)) return candidate;
    const parent = dirname(current);
    if (parent === current) throw new PptxExtractionError("EXTRACTION_FAILED");
    current = parent;
  }
}

export async function extractPptxText(fileBuffer: Buffer, requested: PptxExtractionLimits = {}) {
  const limits = {
    maxInputBytes: boundedLimit(requested.maxInputBytes, DEFAULT_LIMITS.maxInputBytes),
    maxUncompressedBytes: boundedLimit(requested.maxUncompressedBytes, DEFAULT_LIMITS.maxUncompressedBytes),
    maxZipEntries: boundedLimit(requested.maxZipEntries, DEFAULT_LIMITS.maxZipEntries),
    maxSlides: boundedLimit(requested.maxSlides, DEFAULT_LIMITS.maxSlides),
    maxTextLength: boundedLimit(requested.maxTextLength, DEFAULT_LIMITS.maxTextLength),
    processTimeoutMs: boundedLimit(requested.processTimeoutMs, DEFAULT_LIMITS.processTimeoutMs),
  };
  if (fileBuffer.byteLength > limits.maxInputBytes) throw new PptxExtractionError("FILE_TOO_LARGE");
  const args = [
    findKnowledgePackageAnchor(),
    String(limits.maxInputBytes),
    String(limits.maxUncompressedBytes),
    String(limits.maxZipEntries),
    String(limits.maxSlides),
    String(limits.maxTextLength),
  ];

  const value = await new Promise<{ textContent: string; slideCount: number; notesIncluded: boolean; truncated: boolean }>((resolve, reject) => {
    const child = spawn(process.execPath, [
      "--max-old-space-size=192",
      "--max-semi-space-size=16",
      "--stack-size=4096",
      "-e",
      PROCESS_SOURCE,
      ...args,
    ], { stdio: ["pipe", "pipe", "ignore"], windowsHide: true });
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
    const timeout = setTimeout(() => finish(() => reject(new PptxExtractionError("EXTRACTION_TIMEOUT"))), limits.processTimeoutMs);
    child.stdout.on("data", (chunk: Buffer) => {
      outputBytes += chunk.length;
      if (outputBytes > PROCESS_MAX_OUTPUT_BYTES) {
        finish(() => reject(new PptxExtractionError("EXTRACTION_LIMIT_EXCEEDED")));
      } else {
        output.push(chunk);
      }
    });
    child.on("error", () => finish(() => reject(new PptxExtractionError("EXTRACTION_FAILED"))));
    child.on("close", (code, signal) => {
      if (settled) return;
      if (code !== 0 || signal) {
        finish(() => reject(new PptxExtractionError("EXTRACTION_FAILED")), false);
        return;
      }
      try {
        const message = JSON.parse(Buffer.concat(output).toString("utf8")) as {
          ok?: boolean;
          value?: { textContent: string; slideCount: number; notesIncluded: boolean; truncated: boolean };
          code?: PptxExtractionErrorCode;
        };
        if (message.ok && message.value) {
          finish(() => resolve(message.value!), false);
          return;
        }
        const safeCodes = new Set<PptxExtractionErrorCode>([
          "FILE_TOO_LARGE", "NOT_PPTX", "MALFORMED_FILE", "EMPTY_EXTRACTION", "EXTRACTION_LIMIT_EXCEEDED",
          "EXTRACTION_FAILED",
        ]);
        finish(() => reject(new PptxExtractionError(message.code && safeCodes.has(message.code) ? message.code : "MALFORMED_FILE")), false);
      } catch {
        finish(() => reject(new PptxExtractionError("MALFORMED_FILE")), false);
      }
    });
    child.stdin.on("error", () => undefined);
    child.stdin.end(fileBuffer);
  });

  return {
    textContent: value.textContent,
    extraction: {
      format: "PPTX",
      parser: "officeparser",
      parserVersion: "7.6.2",
      slideCount: value.slideCount,
      notesIncluded: value.notesIncluded,
      supported: true,
      hasTextContent: true,
      truncated: value.truncated,
    },
  } as const;
}
