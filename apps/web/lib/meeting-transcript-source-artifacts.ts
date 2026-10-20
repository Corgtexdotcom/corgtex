import JSZip from "jszip";
import { AppError, type MeetingTranscriptSourceArtifact } from "@corgtex/domain";
import { extractTextFromFileBuffer } from "@corgtex/knowledge";
import { normalizeOptionalMeetingDateTimeInput } from "@/lib/meeting-timezone";

export function transcriptArtifactByteBudget(value: unknown, remaining: number): number {
  const pending = [value]; let bytes = 0;
  while (pending.length) {
    const item = pending.pop();
    if (typeof item === "string") {
      bytes += Buffer.byteLength(item) + 2;
      for (let index = 0; index < item.length && bytes <= remaining; index += 1) {
        const code = item.charCodeAt(index);
        if (code < 32 || code === 34 || code === 92) bytes += 5;
      }
    }
    else if (Array.isArray(item)) { bytes += item.length + 2; for (const child of item) pending.push(child); }
    else if (item && typeof item === "object") { for (const [key, child] of Object.entries(item)) { bytes += key.length * 6 + 4; pending.push(child); } }
    else bytes += 32;
    if (bytes > remaining) throw new AppError(413, "TRANSCRIPT_TOO_LARGE", "Transcript import exceeds its aggregate byte limit.");
  }
  return bytes;
}

function formString(formData: FormData, key: string) {
  const value = formData.get(key);
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function formList(formData: FormData, key: string) {
  return (formString(formData, key) ?? "")
    .split(",")
    .map((value) => value.trim())
    .filter(Boolean);
}

function isZip(fileName: string, mimeType?: string | null) {
  return fileName.toLowerCase().endsWith(".zip") || mimeType === "application/zip" || mimeType === "application/x-zip-compressed";
}

function isPlainTextLike(fileName: string, mimeType?: string | null) {
  const lower = fileName.toLowerCase();
  return mimeType?.startsWith("text/")
    || lower.endsWith(".txt")
    || lower.endsWith(".json")
    || lower.endsWith(".vtt")
    || lower.endsWith(".srt")
    || lower.endsWith(".md")
    || lower.endsWith(".csv");
}

async function artifactFromBuffer(params: {
  buffer: Buffer;
  fileName: string;
  mimeType?: string | null;
  defaults: Omit<MeetingTranscriptSourceArtifact, "fileName" | "mimeType" | "text" | "json">;
}): Promise<MeetingTranscriptSourceArtifact | null> {
  if (params.buffer.length > 5 * 1024 * 1024) throw new AppError(413, "TRANSCRIPT_TOO_LARGE", "Transcript file exceeds its byte limit.");
  let text: string | null = null;
  let json: unknown;
  if (isPlainTextLike(params.fileName, params.mimeType)) {
    text = params.buffer.toString("utf8");
    if (params.fileName.toLowerCase().endsWith(".json")) {
      try {
        json = JSON.parse(text);
      } catch {
        json = undefined;
      }
    }
  } else {
    const extracted = await extractTextFromFileBuffer({
      fileBuffer: params.buffer,
      fileName: params.fileName,
      mimeType: params.mimeType || "application/octet-stream",
    });
    text = extracted.textContent ?? null;
  }
  if (!text?.trim() && !json) return null;
  return {
    ...params.defaults,
    fileName: params.fileName,
    mimeType: params.mimeType,
    text,
    json,
    rawFileBase64: params.buffer.toString("base64"),
    rawFileMimeType: params.mimeType || "application/octet-stream",
  };
}

async function artifactsFromZip(params: {
  buffer: Buffer;
  defaults: Omit<MeetingTranscriptSourceArtifact, "fileName" | "mimeType" | "text" | "json">;
  remaining: number;
}) {
  const zip = await JSZip.loadAsync(params.buffer);
  const artifacts: MeetingTranscriptSourceArtifact[] = [];
  let admitted = 0;
  const rawArchiveBase64 = params.buffer.toString("base64");
  for (const entry of Object.values(zip.files)) {
    if (entry.dir || artifacts.length >= 500) continue;
    const declaredSize = (entry as unknown as { _data?: { uncompressedSize?: number } })._data?.uncompressedSize;
    if (declaredSize == null || declaredSize > 5 * 1024 * 1024) throw new AppError(413, "TRANSCRIPT_TOO_LARGE", "Transcript archive entry exceeds its byte limit.");
    // Decompress at most one bounded entry, then charge its exact captured
    // projection before retaining it. Avoid a second, lower implied file limit.
    const minimumEntryBytes = declaredSize + rawArchiveBase64.length;
    if (admitted + minimumEntryBytes > params.remaining) throw new AppError(413, "TRANSCRIPT_TOO_LARGE", "Transcript archive exceeds its aggregate custody byte limit.");
    const buffer = await entry.async("nodebuffer");
    const artifact = await artifactFromBuffer({
      buffer,
      fileName: entry.name,
      defaults: params.defaults,
    });
    if (artifact) {
      const captured = { ...artifact, rawArchiveBase64 };
      admitted += transcriptArtifactByteBudget(captured, params.remaining - admitted);
      artifacts.push(captured);
    }
  }
  return artifacts;
}

export async function meetingTranscriptArtifactsFromFormData(formData: FormData) {
  const defaults: Omit<MeetingTranscriptSourceArtifact, "fileName" | "mimeType" | "text" | "json"> = {
    externalId: formString(formData, "externalId"),
    title: formString(formData, "title"),
    recordedAt: normalizeOptionalMeetingDateTimeInput(
      formString(formData, "recordedAt"),
      formString(formData, "timeZone"),
      "Recorded at",
    ),
    sourceUpdatedAt: formString(formData, "sourceUpdatedAt"),
    sourceUrl: formString(formData, "sourceUrl"),
    meetingUrl: formString(formData, "meetingUrl"),
    calendarExternalId: formString(formData, "calendarExternalId"),
    summaryMd: formString(formData, "summaryMd"),
    participantEmails: formList(formData, "participantEmails"),
    metadata: {
      uploadSource: formString(formData, "sourceKind") ?? "settings-upload",
    },
  };
  const artifacts: MeetingTranscriptSourceArtifact[] = [];
  let admitted = 2;
  const admit = (artifact: MeetingTranscriptSourceArtifact) => {
    admitted += transcriptArtifactByteBudget(artifact, 20 * 1024 * 1024 - admitted) + 1;
    artifacts.push(artifact);
  };
  const pastedValue = formData.get("transcript");
  const pastedTranscript = typeof pastedValue === "string" && pastedValue.trim() ? pastedValue : null;
  if (pastedTranscript) {
    admit({
      ...defaults,
      fileName: "pasted-transcript.txt",
      mimeType: "text/plain",
      text: pastedTranscript,
    });
  }

  for (const value of [...formData.getAll("file"), ...formData.getAll("files")]) {
    if (!(value instanceof File) || value.size === 0) continue;
    if (value.size > 5 * 1024 * 1024) throw new AppError(413, "TRANSCRIPT_TOO_LARGE", "Transcript file exceeds its byte limit.");
    const buffer = Buffer.from(await value.arrayBuffer());
    if (isZip(value.name, value.type)) {
      for (const artifact of await artifactsFromZip({ buffer, defaults, remaining: 20 * 1024 * 1024 - admitted })) admit(artifact);
      continue;
    }
    const artifact = await artifactFromBuffer({
      buffer,
      fileName: value.name,
      mimeType: value.type,
      defaults,
    });
    if (artifact) admit(artifact);
  }

  transcriptArtifactByteBudget(artifacts, 20 * 1024 * 1024);
  return artifacts;
}
