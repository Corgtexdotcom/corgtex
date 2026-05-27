import JSZip from "jszip";
import type { MeetingTranscriptSourceArtifact } from "@corgtex/domain";
import { extractTextFromFileBuffer } from "@corgtex/knowledge";

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
  };
}

async function artifactsFromZip(params: {
  buffer: Buffer;
  defaults: Omit<MeetingTranscriptSourceArtifact, "fileName" | "mimeType" | "text" | "json">;
}) {
  const zip = await JSZip.loadAsync(params.buffer);
  const artifacts: MeetingTranscriptSourceArtifact[] = [];
  for (const entry of Object.values(zip.files)) {
    if (entry.dir || artifacts.length >= 500) continue;
    const buffer = await entry.async("nodebuffer");
    const artifact = await artifactFromBuffer({
      buffer,
      fileName: entry.name,
      defaults: params.defaults,
    });
    if (artifact) artifacts.push(artifact);
  }
  return artifacts;
}

export async function meetingTranscriptArtifactsFromFormData(formData: FormData) {
  const defaults: Omit<MeetingTranscriptSourceArtifact, "fileName" | "mimeType" | "text" | "json"> = {
    externalId: formString(formData, "externalId"),
    title: formString(formData, "title"),
    recordedAt: formString(formData, "recordedAt"),
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
  const pastedTranscript = formString(formData, "transcript");
  if (pastedTranscript) {
    artifacts.push({
      ...defaults,
      fileName: "pasted-transcript.txt",
      mimeType: "text/plain",
      text: pastedTranscript,
    });
  }

  for (const value of [...formData.getAll("file"), ...formData.getAll("files")]) {
    if (!(value instanceof File) || value.size === 0) continue;
    const buffer = Buffer.from(await value.arrayBuffer());
    if (isZip(value.name, value.type)) {
      artifacts.push(...await artifactsFromZip({ buffer, defaults }));
      continue;
    }
    const artifact = await artifactFromBuffer({
      buffer,
      fileName: value.name,
      mimeType: value.type,
      defaults,
    });
    if (artifact) artifacts.push(artifact);
  }

  return artifacts;
}
