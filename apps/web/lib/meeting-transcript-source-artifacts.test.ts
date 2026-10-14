import JSZip from "jszip";
import { describe, expect, it, vi } from "vitest";
import { meetingTranscriptArtifactsFromFormData } from "./meeting-transcript-source-artifacts";

vi.mock("@corgtex/knowledge", () => ({
  extractTextFromFileBuffer: vi.fn(),
}));

describe("meetingTranscriptArtifactsFromFormData", () => {
  it("converts recorded-at fallback from selected timezone before importing artifacts", async () => {
    const formData = new FormData();
    formData.set("recordedAt", "2026-06-11T14:07");
    formData.set("timeZone", "America/Los_Angeles");
    formData.set("transcript", "Jan: Import this transcript.");

    const artifacts = await meetingTranscriptArtifactsFromFormData(formData);

    expect(artifacts).toHaveLength(1);
    expect(artifacts[0]).toMatchObject({
      recordedAt: "2026-06-11T21:07:00.000Z",
      text: "Jan: Import this transcript.",
    });
  });
  it("preserves pasted whitespace and exact individual file bytes", async () => {
    const form = new FormData();
    form.set("transcript", "  Alice: original pasted bytes.\r\n");
    form.append("file", new File(["  Bob: exact file.\r\n"], "original.txt", { type: "text/plain" }));
    const artifacts = await meetingTranscriptArtifactsFromFormData(form);
    expect(artifacts[0].text).toBe("  Alice: original pasted bytes.\r\n");
    expect(artifacts[1].rawFileBase64).toBe(Buffer.from("  Bob: exact file.\r\n").toString("base64"));
  });

  it("rejects a compressed archive before extracting an oversized entry", async () => {
    const zip = new JSZip();
    zip.file("oversized.txt", "x".repeat(6 * 1024 * 1024));
    const file = await zip.generateAsync({ type: "uint8array", compression: "DEFLATE" });
    const form = new FormData(); form.append("file", new File([new Uint8Array(file).buffer], "original.zip"));
    await expect(meetingTranscriptArtifactsFromFormData(form)).rejects.toMatchObject({ code: "TRANSCRIPT_TOO_LARGE" });
  });

  it("charges repeated original archive custody incrementally across many small entries", async () => {
    const zip = new JSZip();
    zip.file("padding.txt", "x".repeat(500000));
    for (let i = 0; i < 40; i += 1) zip.file(`small-${i}.txt`, `Alice: ${i}`);
    const file = await zip.generateAsync({ type: "uint8array", compression: "STORE" });
    const form = new FormData(); form.append("file", new File([new Uint8Array(file).buffer], "original.zip"));
    await expect(meetingTranscriptArtifactsFromFormData(form)).rejects.toMatchObject({ code: "TRANSCRIPT_TOO_LARGE" });
  });

  it("accepts a normal 2.2 MiB zipped transcript whose exact captured custody fits the aggregate limit", async () => {
    const zip = new JSZip(); const original = "x".repeat(Math.floor(2.2 * 1024 * 1024));
    zip.file("normal.txt", original);
    const bytes = await zip.generateAsync({ type: "uint8array", compression: "DEFLATE" });
    const form = new FormData(); form.append("file", new File([new Uint8Array(bytes).buffer], "original.zip"));
    const artifacts = await meetingTranscriptArtifactsFromFormData(form);
    expect(artifacts).toHaveLength(1);
    expect(artifacts[0].text).toBe(original);
    expect(artifacts[0].rawArchiveBase64).toBe(Buffer.from(bytes).toString("base64"));
  });

});
