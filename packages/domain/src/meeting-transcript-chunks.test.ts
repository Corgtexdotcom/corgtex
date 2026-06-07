import { describe, expect, it } from "vitest";
import { buildMeetingTranscriptChunks } from "./meeting-transcript-chunks";

describe("buildMeetingTranscriptChunks", () => {
  it("returns one chunk for short transcripts", () => {
    const transcript = "Alice: We should follow up.\nBob: Agreed.";

    expect(buildMeetingTranscriptChunks(transcript, { targetChars: 1_000 })).toEqual([{
      chunkIndex: 1,
      chunkCount: 1,
      startChar: 0,
      endChar: transcript.length,
      text: transcript,
    }]);
  });

  it("covers the full transcript without gaps", () => {
    const transcript = [
      "Alice: Opening updates.",
      "Bob: " + "b".repeat(90),
      "Casey: TEAM_UPDATE_MARKER " + "c".repeat(90),
      "Dana: " + "d".repeat(90),
      "Eli: Closing notes.",
    ].join("\n");

    const chunks = buildMeetingTranscriptChunks(transcript, {
      targetChars: 120,
      overlapChars: 15,
    });

    expect(chunks.length).toBeGreaterThan(1);
    expect(chunks[0]?.startChar).toBe(0);
    expect(chunks.at(-1)?.endChar).toBe(transcript.length);

    for (let index = 0; index < transcript.length; index += 1) {
      expect(chunks.some((chunk) => index >= chunk.startChar && index < chunk.endChar)).toBe(true);
    }
  });

  it("overlaps adjacent chunks", () => {
    const transcript = "A: " + "a".repeat(300);

    const chunks = buildMeetingTranscriptChunks(transcript, {
      targetChars: 120,
      overlapChars: 20,
    });

    expect(chunks.length).toBeGreaterThan(1);
    for (let index = 1; index < chunks.length; index += 1) {
      const previous = chunks[index - 1]!;
      const current = chunks[index]!;
      expect(current.startChar).toBeLessThan(previous.endChar);
      expect(transcript.slice(current.startChar, previous.endChar)).toBe(previous.text.slice(current.startChar - previous.startChar));
    }
  });

  it("prefers speaker turn boundaries when possible", () => {
    const transcript = [
      "Alice: " + "a".repeat(80),
      "Bob: " + "b".repeat(30),
      "Casey: " + "c".repeat(80),
    ].join("\n");

    const chunks = buildMeetingTranscriptChunks(transcript, {
      targetChars: 125,
      overlapChars: 10,
    });

    expect(chunks[0]?.text.endsWith("\n")).toBe(true);
    expect(chunks[0]?.text).not.toContain("Bob:");
    expect(chunks[0]?.text).not.toContain("Casey:");
    expect(chunks[1]?.text).toContain("Bob:");
  });
});
