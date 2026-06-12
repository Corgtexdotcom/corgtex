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
});
