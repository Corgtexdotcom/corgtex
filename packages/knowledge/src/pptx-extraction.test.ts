import { readFile } from "node:fs/promises";
import JSZip from "jszip";
import { describe, expect, it } from "vitest";
import { extractPptxText, PptxExtractionError } from "./pptx-extraction";

const fixtureUrl = new URL("./fixtures/brain-pptx-ingestion.pptx", import.meta.url);

async function fixture() {
  return readFile(fixtureUrl);
}

async function rewriteFixture(changes: Record<string, (value: string) => string>) {
  const zip = await JSZip.loadAsync(await fixture());
  for (const [path, change] of Object.entries(changes)) {
    const entry = zip.file(path);
    if (!entry) throw new Error(`Missing synthetic fixture part: ${path}`);
    zip.file(path, change(await entry.async("string")));
  }
  return zip.generateAsync({ type: "nodebuffer", compression: "DEFLATE" });
}

async function rewriteFixtureBytes(changes: Record<string, (value: string) => Buffer>) {
  const zip = await JSZip.loadAsync(await fixture());
  for (const [path, change] of Object.entries(changes)) {
    const entry = zip.file(path);
    if (!entry) throw new Error(`Missing synthetic fixture part: ${path}`);
    zip.file(path, change(await entry.async("string")));
  }
  return zip.generateAsync({ type: "nodebuffer", compression: "DEFLATE" });
}

function encodeXml(value: string, encoding: "utf-16le" | "utf-16be") {
  const declared = value.replace(/encoding="UTF-8"/i, "encoding=\"UTF-16\"");
  const littleEndian = Buffer.from(declared, "utf16le");
  if (encoding === "utf-16le") return Buffer.concat([Buffer.from([0xff, 0xfe]), littleEndian]);
  const bigEndian = Buffer.from(littleEndian);
  bigEndian.swap16();
  return Buffer.concat([Buffer.from([0xfe, 0xff]), bigEndian]);
}

async function markFixtureEncrypted() {
  const buffer = Buffer.from(await fixture());
  for (let offset = 0; offset <= buffer.length - 10; offset += 1) {
    const signature = buffer.readUInt32LE(offset);
    const flagOffset = signature === 0x04034b50 ? offset + 6 : signature === 0x02014b50 ? offset + 8 : null;
    if (flagOffset !== null) buffer.writeUInt16LE(buffer.readUInt16LE(flagOffset) | 1, flagOffset);
  }
  return buffer;
}

describe("PPTX extraction", () => {
  it("extracts ordered native slide, table, and labeled speaker-note text", async () => {
    const result = await extractPptxText(await fixture());

    expect(result.textContent).toBe([
      "Slide 1",
      "Brain PPTX ingestion",
      "First slide native body",
      "Metric | Value",
      "Adoption | 42",
      "Speaker notes",
      "First slide speaker rationale",
      "",
      "Slide 2",
      "Second slide",
      "NEBULA-LATE-SLIDE-7421 searchable phrase",
      "Speaker notes",
      "Second slide speaker decision context",
    ].join("\n"));
    expect(result.extraction).toEqual({
      format: "PPTX",
      parser: "officeparser",
      parserVersion: "7.6.2",
      slideCount: 2,
      notesIncluded: true,
      supported: true,
      hasTextContent: true,
      truncated: false,
    });
  });

  it("uses presentation order and excludes hidden slides", async () => {
    const buffer = await rewriteFixture({
      "ppt/presentation.xml": (xml) => xml.replace(
        /(<p:sldId id="256" r:id="rId2"\/>)(<p:sldId id="257" r:id="rId3"\/>)/,
        "$2$1",
      ),
      "ppt/slides/slide1.xml": (xml) => xml.replace("<p:sld ", "<p:sld show=\"0\" "),
    });

    const result = await extractPptxText(buffer);
    expect(result.textContent).toContain("Slide 1\nSecond slide");
    expect(result.textContent).not.toContain("First slide native body");
    expect(result.extraction.slideCount).toBe(1);
  });

  it("resolves presentation relationships by namespace instead of prefix", async () => {
    const buffer = await rewriteFixture({
      "ppt/presentation.xml": (xml) => xml
        .replace("xmlns:r=\"http://schemas.openxmlformats.org/officeDocument/2006/relationships\"", "xmlns:rel=\"http://schemas.openxmlformats.org/officeDocument/2006/relationships\"")
        .replaceAll("r:id=", "rel:id="),
    });

    const result = await extractPptxText(buffer);
    expect(result.textContent).toContain("NEBULA-LATE-SLIDE-7421 searchable phrase");
    expect(result.extraction.slideCount).toBe(2);
  });

  it("accepts strict relationship namespaces and rejects conflicting relationship IDs", async () => {
    const strict = await rewriteFixture({
      "ppt/presentation.xml": (xml) => xml.replace(
        "http://schemas.openxmlformats.org/officeDocument/2006/relationships",
        "http://purl.oclc.org/ooxml/officeDocument/relationships",
      ),
    });
    const conflicting = await rewriteFixture({
      "ppt/presentation.xml": (xml) => xml
        .replace(
          "xmlns:r=\"http://schemas.openxmlformats.org/officeDocument/2006/relationships\"",
          "xmlns:r=\"http://schemas.openxmlformats.org/officeDocument/2006/relationships\" xmlns:strict=\"http://purl.oclc.org/ooxml/officeDocument/relationships\"",
        )
        .replace('r:id="rId2"', 'r:id="rId2" strict:id="rId999"'),
    });

    await expect(extractPptxText(strict)).resolves.toMatchObject({
      textContent: expect.stringContaining("NEBULA-LATE-SLIDE-7421 searchable phrase"),
    });
    await expect(extractPptxText(conflicting)).rejects.toMatchObject({ code: "MALFORMED_FILE" });
  });

  it("resolves package-absolute speaker-note targets", async () => {
    const buffer = await rewriteFixture({
      "ppt/slides/_rels/slide1.xml.rels": (xml) => xml.replace(
        'Target="../notesSlides/notesSlide1.xml"',
        'Target="/ppt/notesSlides/notesSlide1.xml"',
      ),
    });

    await expect(extractPptxText(buffer)).resolves.toMatchObject({
      textContent: expect.stringContaining("First slide speaker rationale"),
      extraction: expect.objectContaining({ notesIncluded: true }),
    });
  });

  it("removes only actual slide-number placeholders from speaker notes", async () => {
    const buffer = await rewriteFixture({
      "ppt/notesSlides/notesSlide1.xml": (xml) => xml.replace(
        "First slide speaker rationale",
        "1",
      ),
    });

    const result = await extractPptxText(buffer);
    expect(result.textContent).toContain("Speaker notes\n1");
    expect(result.textContent.match(/^1$/gm)).toHaveLength(1);
  });

  it("normalizes UTF-16LE and UTF-16BE XML parts before parsing", async () => {
    const buffer = await rewriteFixtureBytes({
      "[Content_Types].xml": (xml) => encodeXml(xml, "utf-16le"),
      "ppt/presentation.xml": (xml) => encodeXml(xml, "utf-16be"),
      "ppt/_rels/presentation.xml.rels": (xml) => encodeXml(xml, "utf-16le"),
      "ppt/slides/slide1.xml": (xml) => encodeXml(xml, "utf-16be"),
      "ppt/slides/_rels/slide1.xml.rels": (xml) => encodeXml(xml, "utf-16le"),
      "ppt/notesSlides/notesSlide1.xml": (xml) => encodeXml(xml, "utf-16be"),
    });

    const result = await extractPptxText(buffer);
    expect(result.textContent).toContain("First slide native body");
    expect(result.textContent).toContain("First slide speaker rationale");
    expect(result.textContent).toContain("NEBULA-LATE-SLIDE-7421 searchable phrase");
  });

  it("truncates deterministically inside the child output bound", async () => {
    const result = await extractPptxText(await fixture(), { maxTextLength: 80 });
    expect(result.textContent).toHaveLength(95);
    expect(result.textContent.endsWith("\n...[truncated]")).toBe(true);
    expect(result.extraction.truncated).toBe(true);
  });

  it("hashes complete extracted text independently from indexed-text truncation", async () => {
    const first = await extractPptxText(await fixture(), { maxTextLength: 80 });
    const secondBuffer = await rewriteFixture({
      "ppt/slides/slide2.xml": (xml) => xml.replace(
        "NEBULA-LATE-SLIDE-7421 searchable phrase",
        "ORBIT-LATE-SLIDE-9184 different searchable phrase",
      ),
    });
    const second = await extractPptxText(secondBuffer, { maxTextLength: 80 });

    expect(first.textContent).toBe(second.textContent);
    expect(first.contentHash).toMatch(/^[a-f0-9]{64}$/);
    expect(second.contentHash).toMatch(/^[a-f0-9]{64}$/);
    expect(first.contentHash).not.toBe(second.contentHash);
  });

  it("stops highly compressed XML while streaming at the inflated-byte limit", async () => {
    const buffer = await rewriteFixture({
      "ppt/slides/slide1.xml": (xml) => xml.replace(
        "First slide native body",
        "A".repeat(2 * 1024 * 1024),
      ),
    });

    await expect(extractPptxText(buffer, { maxUncompressedBytes: 128 * 1024 }))
      .rejects.toMatchObject({ code: "EXTRACTION_LIMIT_EXCEEDED" });
  });

  it.each([
    ["compressed input", { maxInputBytes: 100 }, "FILE_TOO_LARGE"],
    ["decompressed content", { maxUncompressedBytes: 1_000 }, "EXTRACTION_LIMIT_EXCEEDED"],
    ["ZIP entries", { maxZipEntries: 5 }, "EXTRACTION_LIMIT_EXCEEDED"],
    ["slide count", { maxSlides: 1 }, "EXTRACTION_LIMIT_EXCEEDED"],
  ] as const)("fails safely when %s exceeds its bound", async (_label, limits, code) => {
    await expect(extractPptxText(await fixture(), limits)).rejects.toMatchObject({ code });
  });

  it("rejects non-PPTX, malformed, and zero-native-text inputs without leaking content", async () => {
    const malformed = await rewriteFixture({
      "[Content_Types].xml": (xml) => xml,
    });
    const malformedZip = await JSZip.loadAsync(malformed);
    malformedZip.remove("ppt/presentation.xml");
    const empty = await rewriteFixture(Object.fromEntries([
      "ppt/slides/slide1.xml",
      "ppt/slides/slide2.xml",
      "ppt/notesSlides/notesSlide1.xml",
      "ppt/notesSlides/notesSlide2.xml",
    ].map((path) => [path, (xml: string) => xml.replace(/<a:t>.*?<\/a:t>/g, "<a:t></a:t>")])));

    await expect(extractPptxText(Buffer.from("PRIVATE-DECK-CONTENT"))).rejects.toMatchObject({ code: "NOT_PPTX" });
    await expect(extractPptxText(await malformedZip.generateAsync({ type: "nodebuffer" })))
      .rejects.toMatchObject({ code: "MALFORMED_FILE" });
    await expect(extractPptxText(empty)).rejects.toMatchObject({ code: "EMPTY_EXTRACTION" });
    await expect(extractPptxText(await markFixtureEncrypted())).rejects.toMatchObject({ code: "NOT_PPTX" });
    try {
      await extractPptxText(Buffer.from("PRIVATE-DECK-CONTENT"));
    } catch (error) {
      expect(error).toBeInstanceOf(PptxExtractionError);
      expect(String(error)).not.toContain("PRIVATE-DECK-CONTENT");
      expect(String(error)).not.toContain("ppt/");
    }
  });

  it("terminates an over-time child with a safe timeout", async () => {
    await expect(extractPptxText(await fixture(), { processTimeoutMs: 1 }))
      .rejects.toMatchObject({ code: "EXTRACTION_TIMEOUT" });
  });
});
