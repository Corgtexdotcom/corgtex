import { describe, expect, it } from "vitest";
import {
  extractMeetingTranscriptFile,
  MAX_MEETING_TRANSCRIPT_FILE_BYTES,
  MAX_MEETING_TRANSCRIPT_TEXT_CHARS,
} from "./meeting-transcript-file";

describe("meeting transcript file intake", () => {
  it("keeps a read.ai text transcript beyond the general document extraction cutoff", async () => {
    const commitment = "Andy: I will send the steering update tomorrow.";
    const text = `${"Discussion notes. ".repeat(6_500)}\n${commitment}`;
    expect(text.length).toBeGreaterThan(100_000);

    const transcript = await extractMeetingTranscriptFile(new File([text], "read.ai-transcript.txt", { type: "text/plain" }));

    expect(transcript).toContain(commitment);
    expect(transcript).not.toContain("...[truncated]");
  });

  it("rejects oversized text instead of processing a partial transcript", async () => {
    const file = new File(["A".repeat(MAX_MEETING_TRANSCRIPT_TEXT_CHARS + 1)], "meeting.txt", { type: "text/plain" });

    await expect(extractMeetingTranscriptFile(file)).rejects.toMatchObject({
      status: 413,
      code: "TRANSCRIPT_TEXT_TOO_LONG",
    });
  });

  it("rejects oversized files before reading their content", async () => {
    const file = new File([new Uint8Array(MAX_MEETING_TRANSCRIPT_FILE_BYTES + 1)], "meeting.txt", { type: "text/plain" });
    const read = file.arrayBuffer.bind(file);
    file.arrayBuffer = async () => {
      throw new Error("file content should not be read");
    };

    await expect(extractMeetingTranscriptFile(file)).rejects.toMatchObject({
      status: 413,
      code: "TRANSCRIPT_FILE_TOO_LARGE",
    });
    file.arrayBuffer = read;
  });
});
