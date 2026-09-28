import { AppError } from "@corgtex/domain";
import { extractTextFromFileBuffer } from "@corgtex/knowledge";

export const MAX_MEETING_TRANSCRIPT_FILE_BYTES = 5 * 1024 * 1024;
export const MAX_MEETING_TRANSCRIPT_TEXT_CHARS = 1_000_000;

export async function extractMeetingTranscriptFile(file: File) {
  if (file.size > MAX_MEETING_TRANSCRIPT_FILE_BYTES) {
    throw new AppError(413, "TRANSCRIPT_FILE_TOO_LARGE", "Transcript files must be 5 MB or smaller.");
  }

  const extracted = await extractTextFromFileBuffer({
    fileBuffer: Buffer.from(await file.arrayBuffer()),
    fileName: file.name,
    mimeType: file.type || "application/octet-stream",
    maxExtractBytes: MAX_MEETING_TRANSCRIPT_FILE_BYTES,
    maxTextLength: MAX_MEETING_TRANSCRIPT_TEXT_CHARS + 1,
  });

  if (extracted.truncated || (extracted.textContent?.length ?? 0) > MAX_MEETING_TRANSCRIPT_TEXT_CHARS) {
    throw new AppError(413, "TRANSCRIPT_TEXT_TOO_LONG", "Transcript text is too long to process. Upload a shorter transcript.");
  }
  if (!extracted.textContent?.trim()) {
    throw new AppError(422, "UNREADABLE_TRANSCRIPT", "Use a readable .txt, .md, .csv, .json, .pdf, or .docx transcript file.");
  }

  return extracted.textContent;
}
