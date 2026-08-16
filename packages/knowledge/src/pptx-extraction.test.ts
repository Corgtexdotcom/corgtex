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

  it("truncates deterministically inside the child output bound", async () => {
    const result = await extractPptxText(await fixture(), { maxTextLength: 80 });
    expect(result.textContent).toHaveLength(95);
    expect(result.textContent.endsWith("\n...[truncated]")).toBe(true);
    expect(result.extraction.truncated).toBe(true);
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
