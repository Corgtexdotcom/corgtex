import { createHash, createHmac, timingSafeEqual } from "node:crypto";
import type { MeetingTranscriptSourceProvider, Prisma } from "@prisma/client";
import { decryptSecret, encryptSecret, prisma, toInputJson, type AppActor } from "@corgtex/shared";
import { requireWorkspaceMembership } from "./auth";
import { AppError, invariant } from "./errors";
import { intakeMeetingTranscript, type MeetingTranscriptSegment } from "./meeting-transcript-intake";

export type TranscriptAuthMode = "API_KEY" | "OAUTH_ADMIN" | "MCP" | "MANUAL_EXPORT";
export type TranscriptSourceDataShape = "TRANSCRIPT_TEXT" | "SPEAKER_SEGMENTS" | "SUMMARY" | "ACTION_ITEMS" | "RECORDING_METADATA";
export type TranscriptFormat = "json" | "vtt" | "srt" | "txt" | "docx" | "pdf" | "zip" | "csv";

export type MeetingTranscriptProviderCatalogEntry = {
  provider: MeetingTranscriptSourceProvider;
  slug: string;
  label: string;
  popularityRank: number;
  implementationEaseRank: number;
  authModes: TranscriptAuthMode[];
  dataShapes: TranscriptSourceDataShape[];
  transcriptFormats: TranscriptFormat[];
  supportsHistoricalImport: boolean;
  supportsFutureSync: boolean;
  firstPath: string;
  connectionStatus: "ready" | "scaffolded" | "manual";
  manualExportInstructions: string[];
  expectedFields: string[];
  notes: string;
};

export type MeetingTranscriptSourceArtifact = {
  fileName?: string | null;
  mimeType?: string | null;
  text?: string | null;
  json?: unknown;
  externalId?: string | null;
  title?: string | null;
  recordedAt?: Date | string | null;
  sourceUpdatedAt?: Date | string | null;
  sourceUrl?: string | null;
  meetingUrl?: string | null;
  calendarExternalId?: string | null;
  summaryMd?: string | null;
  participantEmails?: string[] | null;
  participants?: unknown[] | null;
  segments?: MeetingTranscriptSegment[] | null;
  metadata?: Record<string, unknown> | null;
};

export type NormalizedMeetingTranscriptSourceArtifact = {
  provider: MeetingTranscriptSourceProvider;
  externalId: string;
  title: string | null;
  recordedAt: Date;
  sourceUpdatedAt: Date | null;
  sourceUrl: string | null;
  meetingUrl: string | null;
  calendarExternalId: string | null;
  transcript: string;
  summaryMd: string | null;
  participantEmails: string[];
  participants: unknown[];
  segments: MeetingTranscriptSegment[];
  rawMetadata: Record<string, unknown>;
  contentHash: string;
};

const PROVIDER_SLUGS: Record<string, MeetingTranscriptSourceProvider> = {
  fireflies: "FIREFLIES",
  fathom: "FATHOM",
  otter: "OTTER",
  granola: "GRANOLA",
  zoom: "ZOOM",
  "microsoft-teams": "MICROSOFT_TEAMS",
  teams: "MICROSOFT_TEAMS",
  "google-meet": "GOOGLE_MEET",
  meet: "GOOGLE_MEET",
  "read-ai": "READ_AI",
  readai: "READ_AI",
  tldv: "TLDV",
  "tl-dv": "TLDV",
  avoma: "AVOMA",
  gong: "GONG",
  fellow: "FELLOW",
  meetgeek: "MEETGEEK",
  "recall-ai": "RECALL_AI",
  recall: "RECALL_AI",
  "meeting-baas": "MEETING_BAAS",
  manual: "MANUAL_UPLOAD",
  "manual-upload": "MANUAL_UPLOAD",
};

const CATALOG: MeetingTranscriptProviderCatalogEntry[] = [
  {
    provider: "FIREFLIES",
    slug: "fireflies",
    label: "Fireflies",
    popularityRank: 1,
    implementationEaseRank: 1,
    authModes: ["API_KEY"],
    dataShapes: ["TRANSCRIPT_TEXT", "SPEAKER_SEGMENTS", "SUMMARY", "ACTION_ITEMS", "RECORDING_METADATA"],
    transcriptFormats: ["json", "txt", "vtt", "srt", "zip"],
    supportsHistoricalImport: true,
    supportsFutureSync: true,
    firstPath: "API key plus signed meeting.transcribed webhook.",
    connectionStatus: "ready",
    manualExportInstructions: [
      "Export transcript files from Fireflies or paste the transcript URL into the batch upload.",
      "For a first batch, upload a ZIP containing JSON, VTT, SRT, or TXT exports.",
    ],
    expectedFields: ["transcript id", "title", "recorded date", "sentences with speaker/time", "participants", "summary"],
    notes: "Official GraphQL transcript query and signed webhook are the first supported future-sync path.",
  },
  {
    provider: "FATHOM",
    slug: "fathom",
    label: "Fathom",
    popularityRank: 2,
    implementationEaseRank: 2,
    authModes: ["API_KEY"],
    dataShapes: ["TRANSCRIPT_TEXT", "SPEAKER_SEGMENTS", "SUMMARY", "ACTION_ITEMS", "RECORDING_METADATA"],
    transcriptFormats: ["json", "txt", "vtt", "srt", "zip"],
    supportsHistoricalImport: true,
    supportsFutureSync: true,
    firstPath: "API key plus signed recording webhook.",
    connectionStatus: "ready",
    manualExportInstructions: [
      "Export recordings/transcripts from Fathom as text or structured transcript files.",
      "Upload the export ZIP here; Corgtex imports files oldest to newest.",
    ],
    expectedFields: ["recording id", "title", "recording date", "transcript entries", "summary", "action items"],
    notes: "Webhook payloads can include transcript, summary, and action data; API fallback can fetch by recording id.",
  },
  {
    provider: "OTTER",
    slug: "otter",
    label: "Otter",
    popularityRank: 3,
    implementationEaseRank: 5,
    authModes: ["API_KEY", "MANUAL_EXPORT"],
    dataShapes: ["TRANSCRIPT_TEXT", "SPEAKER_SEGMENTS", "SUMMARY", "RECORDING_METADATA"],
    transcriptFormats: ["txt", "docx", "pdf", "zip"],
    supportsHistoricalImport: true,
    supportsFutureSync: true,
    firstPath: "API beta when available; Business/Enterprise bulk ZIP export otherwise.",
    connectionStatus: "scaffolded",
    manualExportInstructions: [
      "Use Otter Business/Enterprise bulk export for conversations, audio, or Takeaways.",
      "Upload the ZIP export. Corgtex extracts DOCX, PDF, TXT, VTT, SRT, and JSON files.",
    ],
    expectedFields: ["conversation id", "title", "conversation date", "speaker text", "participants"],
    notes: "Public API exists but customer access can vary; bulk export is the reliable onboarding fallback.",
  },
  {
    provider: "GRANOLA",
    slug: "granola",
    label: "Granola",
    popularityRank: 4,
    implementationEaseRank: 3,
    authModes: ["API_KEY", "MCP", "MANUAL_EXPORT"],
    dataShapes: ["TRANSCRIPT_TEXT", "SUMMARY", "RECORDING_METADATA"],
    transcriptFormats: ["json", "txt", "zip"],
    supportsHistoricalImport: true,
    supportsFutureSync: true,
    firstPath: "API key or customer-authorized MCP assisted import.",
    connectionStatus: "scaffolded",
    manualExportInstructions: [
      "Use the API or MCP path for full notes/transcripts.",
      "CSV export is useful for metadata, but it does not include complete transcript text.",
    ],
    expectedFields: ["note id", "title", "meeting date", "note body", "participants"],
    notes: "MCP is useful for assisted first-batch import where the customer authorizes data access.",
  },
  {
    provider: "ZOOM",
    slug: "zoom",
    label: "Zoom native",
    popularityRank: 5,
    implementationEaseRank: 6,
    authModes: ["OAUTH_ADMIN", "MANUAL_EXPORT"],
    dataShapes: ["TRANSCRIPT_TEXT", "SPEAKER_SEGMENTS", "RECORDING_METADATA"],
    transcriptFormats: ["vtt", "txt", "zip"],
    supportsHistoricalImport: true,
    supportsFutureSync: true,
    firstPath: "OAuth/admin connector using cloud recording transcript download URLs.",
    connectionStatus: "scaffolded",
    manualExportInstructions: [
      "From Zoom cloud recordings, download transcript files as VTT/TXT.",
      "Upload a ZIP of transcript files when admin OAuth is not available.",
    ],
    expectedFields: ["recording id", "meeting UUID", "meeting URL", "start time", "VTT transcript"],
    notes: "Very popular, but production sync needs admin OAuth and recording-webhook configuration.",
  },
  {
    provider: "MICROSOFT_TEAMS",
    slug: "microsoft-teams",
    label: "Microsoft Teams",
    popularityRank: 6,
    implementationEaseRank: 7,
    authModes: ["OAUTH_ADMIN", "MANUAL_EXPORT"],
    dataShapes: ["TRANSCRIPT_TEXT", "SPEAKER_SEGMENTS", "RECORDING_METADATA"],
    transcriptFormats: ["vtt", "docx", "zip"],
    supportsHistoricalImport: true,
    supportsFutureSync: true,
    firstPath: "Admin/RSC Graph connector and change notifications.",
    connectionStatus: "scaffolded",
    manualExportInstructions: [
      "Export Teams meeting transcripts from the meeting recap or compliance export path.",
      "Upload DOCX, VTT, or ZIP exports here.",
    ],
    expectedFields: ["meeting id", "organizer", "transcript id", "created date/time", "speaker lines"],
    notes: "Powerful but admin-heavy; Graph transcript APIs and change notifications are the official path.",
  },
  {
    provider: "GOOGLE_MEET",
    slug: "google-meet",
    label: "Google Meet",
    popularityRank: 7,
    implementationEaseRank: 8,
    authModes: ["OAUTH_ADMIN", "MANUAL_EXPORT"],
    dataShapes: ["TRANSCRIPT_TEXT", "SPEAKER_SEGMENTS", "RECORDING_METADATA"],
    transcriptFormats: ["docx", "txt", "zip"],
    supportsHistoricalImport: true,
    supportsFutureSync: true,
    firstPath: "Google OAuth plus Meet transcript APIs and Workspace Events.",
    connectionStatus: "scaffolded",
    manualExportInstructions: [
      "Download transcript documents from Drive or Meet artifacts.",
      "Upload DOCX, TXT, or ZIP exports here.",
    ],
    expectedFields: ["conference record", "transcript name", "start time", "Drive artifact", "participants"],
    notes: "Workspace Events can tell Corgtex when transcripts are generated.",
  },
  {
    provider: "READ_AI",
    slug: "read-ai",
    label: "Read.ai",
    popularityRank: 8,
    implementationEaseRank: 4,
    authModes: ["API_KEY", "MCP", "MANUAL_EXPORT"],
    dataShapes: ["TRANSCRIPT_TEXT", "SPEAKER_SEGMENTS", "SUMMARY", "ACTION_ITEMS", "RECORDING_METADATA"],
    transcriptFormats: ["json", "txt", "zip"],
    supportsHistoricalImport: true,
    supportsFutureSync: true,
    firstPath: "Catalog now; REST API and MCP connector after beta access is approved.",
    connectionStatus: "scaffolded",
    manualExportInstructions: [
      "Use Read.ai export or API/MCP beta access to collect transcript files.",
      "Upload JSON/TXT/ZIP exports here for first-batch processing.",
    ],
    expectedFields: ["meeting id", "title", "start time", "transcript", "summary", "action items"],
    notes: "REST API and MCP are in open beta; keep the catalog and manual path ready.",
  },
  ...[
    ["TLDV", "tldv", "tl;dv", 9],
    ["AVOMA", "avoma", "Avoma", 10],
    ["GONG", "gong", "Gong", 11],
    ["FELLOW", "fellow", "Fellow", 12],
    ["MEETGEEK", "meetgeek", "MeetGeek", 13],
  ].map(([provider, slug, label, rank]) => ({
    provider: provider as MeetingTranscriptSourceProvider,
    slug: slug as string,
    label: label as string,
    popularityRank: rank as number,
    implementationEaseRank: rank as number,
    authModes: ["API_KEY", "MANUAL_EXPORT"] as TranscriptAuthMode[],
    dataShapes: ["TRANSCRIPT_TEXT", "SPEAKER_SEGMENTS", "SUMMARY", "RECORDING_METADATA"] as TranscriptSourceDataShape[],
    transcriptFormats: ["json", "txt", "vtt", "srt", "zip"] as TranscriptFormat[],
    supportsHistoricalImport: true,
    supportsFutureSync: true,
    firstPath: "Catalog and manual/API playbook until top connectors are proven.",
    connectionStatus: "manual" as const,
    manualExportInstructions: ["Export available transcript files from the provider and upload JSON, TXT, VTT, SRT, or ZIP here."],
    expectedFields: ["meeting id", "title", "recorded date", "transcript text", "participants"],
    notes: "API path is deferred until Fireflies/Fathom/manual batches are stable.",
  })),
  {
    provider: "MANUAL_UPLOAD",
    slug: "manual-upload",
    label: "Manual upload",
    popularityRank: 99,
    implementationEaseRank: 1,
    authModes: ["MANUAL_EXPORT"],
    dataShapes: ["TRANSCRIPT_TEXT", "SPEAKER_SEGMENTS", "SUMMARY", "RECORDING_METADATA"],
    transcriptFormats: ["json", "txt", "vtt", "srt", "docx", "pdf", "zip"],
    supportsHistoricalImport: true,
    supportsFutureSync: false,
    firstPath: "ZIP or file upload.",
    connectionStatus: "ready",
    manualExportInstructions: ["Upload transcript files directly. ZIP batches are processed oldest to newest."],
    expectedFields: ["title", "recorded date", "transcript text", "participants"],
    notes: "Fallback for any recorder that cannot be connected yet.",
  },
];

export function getMeetingTranscriptProviderCatalog() {
  return [...CATALOG].sort((left, right) => left.popularityRank - right.popularityRank);
}

export function normalizeMeetingTranscriptSourceProvider(value: string): MeetingTranscriptSourceProvider {
  const normalized = value.trim().toLowerCase().replace(/_/g, "-");
  const provider = PROVIDER_SLUGS[normalized] ?? PROVIDER_SLUGS[normalized.replace(/\./g, "")];
  invariant(provider, 400, "INVALID_PROVIDER", "Unsupported meeting transcript provider.");
  return provider;
}

export function getMeetingTranscriptProviderCatalogEntry(provider: MeetingTranscriptSourceProvider | string) {
  const normalized = typeof provider === "string" ? normalizeMeetingTranscriptSourceProvider(provider) : provider;
  const entry = CATALOG.find((item) => item.provider === normalized);
  invariant(entry, 400, "INVALID_PROVIDER", "Unsupported meeting transcript provider.");
  return entry;
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function asArray(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

function asString(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function asDate(value: unknown): Date | null {
  if (value instanceof Date && !Number.isNaN(value.valueOf())) return value;
  if (typeof value === "number" && Number.isFinite(value)) {
    const date = new Date(value > 10_000_000_000 ? value : value * 1000);
    return Number.isNaN(date.valueOf()) ? null : date;
  }
  if (typeof value === "string" && value.trim()) {
    const date = new Date(value.trim());
    return Number.isNaN(date.valueOf()) ? null : date;
  }
  return null;
}

function uniqueEmails(values: unknown[]) {
  const emails = values.flatMap((value) => String(value ?? "").match(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi) ?? []);
  return [...new Set(emails.map((email) => email.toLowerCase()))];
}

function parseDateFromText(input: string) {
  const iso = input.match(/\b20\d{2}-\d{2}-\d{2}(?:[T\s]\d{1,2}:\d{2}(?::\d{2})?(?:\.\d{3})?(?:Z|[+-]\d{2}:?\d{2})?)?\b/);
  if (iso) return asDate(iso[0]);
  const slash = input.match(/\b(0?[1-9]|1[0-2])\/(0?[1-9]|[12]\d|3[01])\/(20\d{2})\b/);
  if (slash) return asDate(`${slash[3]}-${slash[1].padStart(2, "0")}-${slash[2].padStart(2, "0")}`);
  return null;
}

function stableHash(value: unknown) {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

function contentHashFor(value: Pick<NormalizedMeetingTranscriptSourceArtifact, "transcript" | "summaryMd" | "segments">) {
  return stableHash({
    transcript: value.transcript.trim().replace(/\s+/g, " "),
    summaryMd: value.summaryMd?.trim() ?? null,
    segments: value.segments,
  });
}

function parseTimestampMs(value: string) {
  const match = value.match(/(?:(\d{1,2}):)?(\d{1,2}):(\d{2})(?:[,.](\d{1,3}))?/);
  if (!match) return null;
  const hours = Number(match[1] ?? 0);
  const minutes = Number(match[2] ?? 0);
  const seconds = Number(match[3] ?? 0);
  const millis = Number((match[4] ?? "0").padEnd(3, "0"));
  return (((hours * 60 + minutes) * 60) + seconds) * 1000 + millis;
}

function segmentsFromTimedText(input: string): MeetingTranscriptSegment[] {
  const lines = input.replace(/\r/g, "").split("\n");
  const segments: MeetingTranscriptSegment[] = [];
  let startMs: number | null = null;
  let endMs: number | null = null;
  let buffer: string[] = [];
  const flush = () => {
    const text = buffer.join(" ").replace(/\s+/g, " ").trim();
    if (text) {
      const speakerMatch = text.match(/^([^:]{1,80}):\s+(.+)$/);
      segments.push({
        speaker: speakerMatch ? speakerMatch[1].trim() : null,
        startMs,
        endMs,
        text: speakerMatch ? speakerMatch[2].trim() : text,
      });
    }
    buffer = [];
  };

  for (const rawLine of lines) {
    const line = rawLine.trim();
    if (!line || line === "WEBVTT" || /^\d+$/.test(line)) {
      continue;
    }
    if (line.includes("-->")) {
      flush();
      const [start, end] = line.split("-->").map((part) => part.trim());
      startMs = parseTimestampMs(start);
      endMs = parseTimestampMs(end);
      continue;
    }
    buffer.push(line.replace(/<[^>]+>/g, ""));
  }
  flush();
  return segments;
}

function normalizeSegment(value: unknown): MeetingTranscriptSegment | null {
  const record = asRecord(value);
  const text = asString(record.text) ?? asString(record.sentence) ?? asString(record.content) ?? asString(record.transcript);
  if (!text) return null;
  const speaker = asString(record.speaker) ?? asString(record.speaker_name) ?? asString(record.name);
  const startMs = typeof record.startMs === "number" ? record.startMs : typeof record.start_time === "number" ? record.start_time * 1000 : null;
  const endMs = typeof record.endMs === "number" ? record.endMs : typeof record.end_time === "number" ? record.end_time * 1000 : null;
  return { speaker, startMs, endMs, text };
}

function transcriptTextFromSegments(segments: MeetingTranscriptSegment[]) {
  return segments
    .map((segment) => `${segment.speaker ? `${segment.speaker}: ` : ""}${segment.text}`.trim())
    .filter(Boolean)
    .join("\n");
}

function parseJsonText(value: string): unknown | null {
  try {
    return JSON.parse(value);
  } catch {
    return null;
  }
}

function metadataFromJson(value: unknown): Record<string, unknown> {
  const record = asRecord(value);
  return {
    ...record,
    meeting: asRecord(record.meeting),
    recording: asRecord(record.recording),
  };
}

function titleFromFileName(fileName?: string | null) {
  const title = fileName?.trim().replace(/\.[A-Za-z0-9]+$/, "").replace(/[-_]+/g, " ");
  return title ? title.replace(/\b(transcript|meeting|notes|minutes)\b/gi, "").replace(/\s+/g, " ").trim() || title : null;
}

export function normalizeMeetingTranscriptSourceArtifact(
  provider: MeetingTranscriptSourceProvider,
  artifact: MeetingTranscriptSourceArtifact,
): NormalizedMeetingTranscriptSourceArtifact {
  const text = artifact.text?.trim() ?? "";
  const parsedJson = artifact.json ?? parseJsonText(text);
  const jsonRecord = asRecord(parsedJson);
  const metadata = {
    ...metadataFromJson(parsedJson),
    ...(artifact.metadata ?? {}),
    fileName: artifact.fileName ?? null,
    mimeType: artifact.mimeType ?? null,
  };
  const candidateSegments = [
    ...asArray(jsonRecord.segments),
    ...asArray(jsonRecord.sentences),
    ...asArray(jsonRecord.transcript),
    ...asArray(jsonRecord.entries),
  ].map(normalizeSegment).filter((segment): segment is MeetingTranscriptSegment => Boolean(segment));
  const timedSegments = candidateSegments.length > 0 ? [] : segmentsFromTimedText(text);
  const segments = artifact.segments?.length ? artifact.segments : candidateSegments.length > 0 ? candidateSegments : timedSegments;
  const jsonTranscript = asString(jsonRecord.transcript_text)
    ?? asString(jsonRecord.transcriptText)
    ?? asString(jsonRecord.text)
    ?? asString(jsonRecord.content)
    ?? asString(jsonRecord.markdown);
  const segmentTranscript = transcriptTextFromSegments(segments);
  const transcript = (jsonTranscript ?? (segmentTranscript || text))
    .replace(/\r/g, "")
    .trim();
  invariant(transcript.length > 0, 400, "INVALID_INPUT", "Transcript text is required.");

  const nestedMeeting = asRecord(jsonRecord.meeting);
  const nestedRecording = asRecord(jsonRecord.recording);
  const explicitExternalId = artifact.externalId?.trim()
    || asString(jsonRecord.id)
    || asString(jsonRecord.transcript_id)
    || asString(jsonRecord.transcriptId)
    || asString(jsonRecord.recording_id)
    || asString(jsonRecord.recordingId)
    || asString(nestedMeeting.id)
    || asString(nestedRecording.id);
  const title = artifact.title?.trim()
    || asString(jsonRecord.title)
    || asString(jsonRecord.name)
    || asString(nestedMeeting.title)
    || asString(nestedRecording.title)
    || titleFromFileName(artifact.fileName);
  const recordedAt = asDate(artifact.recordedAt)
    || asDate(jsonRecord.recordedAt)
    || asDate(jsonRecord.recorded_at)
    || asDate(jsonRecord.date)
    || asDate(jsonRecord.start_time)
    || asDate(nestedMeeting.start_time)
    || parseDateFromText(`${artifact.fileName ?? ""}\n${text.slice(0, 2000)}`);
  invariant(recordedAt, 400, "RECORDED_AT_REQUIRED", `Recorded date is required for ${artifact.fileName || explicitExternalId || "transcript artifact"}.`);
  const externalId = explicitExternalId
    || `${provider.toLowerCase()}:${stableHash({
      fileName: artifact.fileName,
      recordedAt: recordedAt.toISOString(),
      transcript,
    }).slice(0, 24)}`;
  const sourceUpdatedAt = asDate(artifact.sourceUpdatedAt)
    || asDate(jsonRecord.updatedAt)
    || asDate(jsonRecord.updated_at)
    || asDate(jsonRecord.modified_at)
    || null;
  const sourceUrl = artifact.sourceUrl?.trim()
    || asString(jsonRecord.url)
    || asString(jsonRecord.sourceUrl)
    || asString(jsonRecord.transcript_url)
    || null;
  const meetingUrl = artifact.meetingUrl?.trim()
    || asString(jsonRecord.meetingUrl)
    || asString(jsonRecord.meeting_url)
    || asString(nestedMeeting.url)
    || null;
  const participantEmails = [
    ...(artifact.participantEmails ?? []),
    ...uniqueEmails([
      jsonRecord.participants,
      jsonRecord.attendees,
      nestedMeeting.participants,
      nestedRecording.participants,
      text.slice(0, 6000),
    ]),
  ].map((email) => email.trim().toLowerCase()).filter(Boolean);
  const participants = artifact.participants ?? asArray(jsonRecord.participants).concat(asArray(jsonRecord.attendees));
  const summaryMd = artifact.summaryMd?.trim()
    || asString(jsonRecord.summary)
    || asString(jsonRecord.summaryMd)
    || asString(asRecord(jsonRecord.summary).overview)
    || null;
  const normalized = {
    provider,
    externalId,
    title,
    recordedAt,
    sourceUpdatedAt,
    sourceUrl,
    meetingUrl,
    calendarExternalId: artifact.calendarExternalId?.trim() || asString(jsonRecord.calendarExternalId) || asString(jsonRecord.calendar_id),
    transcript,
    summaryMd,
    participantEmails: [...new Set(participantEmails)],
    participants,
    segments,
    rawMetadata: {
      ...metadata,
      meetingUrl,
      calendarExternalId: artifact.calendarExternalId?.trim() || asString(jsonRecord.calendarExternalId) || asString(jsonRecord.calendar_id),
      participantEmails: [...new Set(participantEmails)],
      participants,
    },
    contentHash: "",
  };
  return { ...normalized, contentHash: contentHashFor(normalized) };
}

export async function connectMeetingTranscriptSource(actor: AppActor, params: {
  workspaceId: string;
  provider: MeetingTranscriptSourceProvider | string;
  displayName?: string | null;
  apiKey?: string | null;
  accessToken?: string | null;
  refreshToken?: string | null;
  webhookSecret?: string | null;
}) {
  await requireWorkspaceMembership({ actor, workspaceId: params.workspaceId, allowedRoles: ["ADMIN", "FACILITATOR"] });
  const provider = typeof params.provider === "string" ? normalizeMeetingTranscriptSourceProvider(params.provider) : params.provider;
  const catalogEntry = getMeetingTranscriptProviderCatalogEntry(provider);
  const apiKey = params.apiKey?.trim();
  const accessToken = params.accessToken?.trim();
  const refreshToken = params.refreshToken?.trim();
  const webhookSecret = params.webhookSecret?.trim();
  invariant(apiKey || accessToken || webhookSecret || catalogEntry.authModes.includes("MANUAL_EXPORT"), 400, "CREDENTIAL_REQUIRED", "Add an API key, access token, or webhook secret.");

  const connection = await prisma.meetingTranscriptSourceConnection.upsert({
    where: { workspaceId_provider: { workspaceId: params.workspaceId, provider } },
    update: {
      displayName: params.displayName?.trim() || catalogEntry.label,
      status: "ACTIVE",
      authMode: catalogEntry.authModes[0],
      ...(apiKey ? { apiKeyEnc: encryptSecret(apiKey) } : {}),
      ...(accessToken ? { accessTokenEnc: encryptSecret(accessToken) } : {}),
      ...(refreshToken ? { refreshTokenEnc: encryptSecret(refreshToken) } : {}),
      ...(webhookSecret ? { webhookSecretEnc: encryptSecret(webhookSecret) } : {}),
      lastError: null,
    },
    create: {
      workspaceId: params.workspaceId,
      provider,
      displayName: params.displayName?.trim() || catalogEntry.label,
      status: "ACTIVE",
      authMode: catalogEntry.authModes[0],
      apiKeyEnc: apiKey ? encryptSecret(apiKey) : null,
      accessTokenEnc: accessToken ? encryptSecret(accessToken) : null,
      refreshTokenEnc: refreshToken ? encryptSecret(refreshToken) : null,
      webhookSecretEnc: webhookSecret ? encryptSecret(webhookSecret) : null,
    },
  });

  return {
    connection: {
      ...connection,
      apiKeyEnc: Boolean(connection.apiKeyEnc),
      accessTokenEnc: Boolean(connection.accessTokenEnc),
      refreshTokenEnc: Boolean(connection.refreshTokenEnc),
      webhookSecretEnc: Boolean(connection.webhookSecretEnc),
    },
    catalogEntry,
  };
}

function transcriptMeetingExternalId(provider: MeetingTranscriptSourceProvider, externalId: string) {
  return `meeting-transcript:${provider}:${externalId}`;
}

function actorUserId(actor: AppActor) {
  return actor.kind === "user" ? actor.user.id : null;
}

async function importOneNormalizedTranscript(actor: AppActor, params: {
  workspaceId: string;
  connectionId?: string | null;
  batchId?: string | null;
  sourceKind: string;
  artifact: NormalizedMeetingTranscriptSourceArtifact;
}) {
  const artifact = params.artifact;
  const existingSameHash = await prisma.meetingTranscriptSourceRecord.findUnique({
    where: {
      workspaceId_provider_externalId_contentHash: {
        workspaceId: params.workspaceId,
        provider: artifact.provider,
        externalId: artifact.externalId,
        contentHash: artifact.contentHash,
      },
    },
  });
  if (existingSameHash && existingSameHash.status !== "FAILED") {
    return { status: "skipped" as const, record: existingSameHash, meeting: null, reason: "duplicate_content" };
  }

  const activeRecord = await prisma.meetingTranscriptSourceRecord.findFirst({
    where: {
      workspaceId: params.workspaceId,
      provider: artifact.provider,
      externalId: artifact.externalId,
      status: "ACTIVE",
    },
    orderBy: [{ sourceUpdatedAt: "desc" }, { createdAt: "desc" }],
  });
  const incomingUpdatedAt = artifact.sourceUpdatedAt ?? artifact.recordedAt;
  const activeUpdatedAt = activeRecord ? activeRecord.sourceUpdatedAt ?? activeRecord.recordedAt : null;
  const isOlderRevision = Boolean(activeRecord && activeUpdatedAt && incomingUpdatedAt < activeUpdatedAt);
  const recordData = {
    workspaceId: params.workspaceId,
    connectionId: params.connectionId ?? null,
    batchId: params.batchId ?? null,
    meetingId: activeRecord?.meetingId ?? null,
    provider: artifact.provider,
    externalId: artifact.externalId,
    externalRevisionId: artifact.sourceUpdatedAt?.toISOString() ?? artifact.contentHash.slice(0, 16),
    title: artifact.title,
    recordedAt: artifact.recordedAt,
    sourceUpdatedAt: artifact.sourceUpdatedAt,
    sourceUrl: artifact.sourceUrl,
    contentHash: artifact.contentHash,
    transcriptText: artifact.transcript,
    summaryMd: artifact.summaryMd,
    segmentsJson: artifact.segments.length > 0 ? toInputJson(artifact.segments) : undefined,
    participantsJson: artifact.participants.length > 0 || artifact.participantEmails.length > 0
      ? toInputJson({ participants: artifact.participants, participantEmails: artifact.participantEmails })
      : undefined,
    rawMetadataJson: toInputJson(artifact.rawMetadata),
    status: isOlderRevision ? "SKIPPED" as const : "ACTIVE" as const,
    supersededByRecordId: isOlderRevision ? activeRecord?.id ?? null : null,
    processedAt: null,
    error: null,
  };
  const record = existingSameHash?.status === "FAILED"
    ? await prisma.meetingTranscriptSourceRecord.update({
      where: { id: existingSameHash.id },
      data: recordData,
    })
    : await prisma.meetingTranscriptSourceRecord.create({
      data: recordData,
    });
  if (isOlderRevision) {
    return { status: "skipped" as const, record, meeting: null, reason: "older_revision" };
  }

  const result = await intakeMeetingTranscript(actor, {
    workspaceId: params.workspaceId,
    transcript: artifact.transcript,
    fileName: artifact.rawMetadata.fileName as string | null,
    title: artifact.title,
    source: `meeting-transcript:${artifact.provider.toLowerCase()}`,
    provider: artifact.provider,
    externalId: transcriptMeetingExternalId(artifact.provider, artifact.externalId),
    sourceUpdatedAt: artifact.sourceUpdatedAt,
    sourceUrl: artifact.sourceUrl,
    meetingUrl: artifact.meetingUrl,
    calendarExternalId: artifact.calendarExternalId,
    recordedAt: artifact.recordedAt,
    summaryMd: artifact.summaryMd,
    participantEmails: artifact.participantEmails,
    segments: artifact.segments,
    batchId: params.batchId,
    sourceRecordId: record.id,
    replaceTranscript: Boolean(activeRecord && activeRecord.contentHash !== artifact.contentHash),
  });

  if (result.status === "needs_clarification") {
    await prisma.meetingTranscriptSourceRecord.update({
      where: { id: record.id },
      data: {
        status: "FAILED",
        error: result.message,
      },
    });
    return { status: "failed" as const, record, meeting: null, reason: result.message };
  }

  await prisma.$transaction(async (tx) => {
    if (activeRecord && activeRecord.id !== record.id) {
      await tx.meetingTranscriptSourceRecord.updateMany({
        where: {
          workspaceId: params.workspaceId,
          provider: artifact.provider,
          externalId: artifact.externalId,
          id: { not: record.id },
          status: "ACTIVE",
        },
        data: {
          status: "SUPERSEDED",
          supersededByRecordId: record.id,
        },
      });
    }
    await tx.meetingTranscriptSourceRecord.update({
      where: { id: record.id },
      data: {
        meetingId: result.meeting.id,
        processedAt: new Date(),
      },
    });
    await tx.auditLog.create({
      data: {
        workspaceId: params.workspaceId,
        actorUserId: actorUserId(actor),
        action: "meeting-transcript-source.imported",
        entityType: "MeetingTranscriptSourceRecord",
        entityId: record.id,
        meta: {
          provider: artifact.provider,
          externalId: artifact.externalId,
          meetingId: result.meeting.id,
          sourceKind: params.sourceKind,
          supersededRecordId: activeRecord?.id ?? null,
        } satisfies Prisma.InputJsonObject,
      },
    });
  });

  return { status: "imported" as const, record: { ...record, meetingId: result.meeting.id }, meeting: result.meeting, reason: null };
}

export async function importMeetingTranscriptSourceArtifacts(actor: AppActor, params: {
  workspaceId: string;
  provider: MeetingTranscriptSourceProvider | string;
  connectionId?: string | null;
  sourceKind?: string | null;
  artifacts: MeetingTranscriptSourceArtifact[];
}) {
  await requireWorkspaceMembership({ actor, workspaceId: params.workspaceId });
  const provider = typeof params.provider === "string" ? normalizeMeetingTranscriptSourceProvider(params.provider) : params.provider;
  invariant(params.artifacts.length > 0, 400, "INVALID_INPUT", "At least one transcript artifact is required.");
  const normalized = params.artifacts
    .map((artifact) => normalizeMeetingTranscriptSourceArtifact(provider, artifact))
    .sort((left, right) => left.recordedAt.getTime() - right.recordedAt.getTime());
  const sourceKind = params.sourceKind?.trim() || "manual_upload";
  const batch = await prisma.meetingTranscriptImportBatch.create({
    data: {
      workspaceId: params.workspaceId,
      connectionId: params.connectionId ?? null,
      provider,
      sourceKind,
      status: "RUNNING",
      startedAt: new Date(),
    },
  });

  let importedCount = 0;
  let skippedCount = 0;
  let failedCount = 0;
  const results: Array<Awaited<ReturnType<typeof importOneNormalizedTranscript>>> = [];
  for (const artifact of normalized) {
    try {
      const result = await importOneNormalizedTranscript(actor, {
        workspaceId: params.workspaceId,
        connectionId: params.connectionId,
        batchId: batch.id,
        sourceKind,
        artifact,
      });
      results.push(result);
      if (result.status === "imported") importedCount += 1;
      if (result.status === "skipped") skippedCount += 1;
      if (result.status === "failed") failedCount += 1;
    } catch (error) {
      failedCount += 1;
      await prisma.meetingTranscriptSourceRecord.upsert({
        where: {
          workspaceId_provider_externalId_contentHash: {
            workspaceId: params.workspaceId,
            provider,
            externalId: artifact.externalId,
            contentHash: artifact.contentHash,
          },
        },
        update: {
          connectionId: params.connectionId ?? null,
          batchId: batch.id,
          title: artifact.title,
          recordedAt: artifact.recordedAt,
          sourceUpdatedAt: artifact.sourceUpdatedAt,
          sourceUrl: artifact.sourceUrl,
          transcriptText: artifact.transcript,
          summaryMd: artifact.summaryMd,
          segmentsJson: artifact.segments.length > 0 ? toInputJson(artifact.segments) : undefined,
          participantsJson: artifact.participants.length > 0 || artifact.participantEmails.length > 0
            ? toInputJson({ participants: artifact.participants, participantEmails: artifact.participantEmails })
            : undefined,
          rawMetadataJson: toInputJson(artifact.rawMetadata),
          status: "FAILED",
          processedAt: null,
          error: error instanceof Error ? error.message : "Transcript import failed.",
        },
        create: {
          workspaceId: params.workspaceId,
          connectionId: params.connectionId ?? null,
          batchId: batch.id,
          provider,
          externalId: artifact.externalId,
          title: artifact.title,
          recordedAt: artifact.recordedAt,
          sourceUpdatedAt: artifact.sourceUpdatedAt,
          sourceUrl: artifact.sourceUrl,
          contentHash: artifact.contentHash,
          transcriptText: artifact.transcript,
          summaryMd: artifact.summaryMd,
          segmentsJson: artifact.segments.length > 0 ? toInputJson(artifact.segments) : undefined,
          participantsJson: artifact.participants.length > 0 || artifact.participantEmails.length > 0
            ? toInputJson({ participants: artifact.participants, participantEmails: artifact.participantEmails })
            : undefined,
          rawMetadataJson: toInputJson(artifact.rawMetadata),
          status: "FAILED",
          error: error instanceof Error ? error.message : "Transcript import failed.",
        },
      });
    }
  }

  const finalStatus = failedCount > 0 && importedCount === 0
    ? "FAILED"
    : failedCount > 0
      ? "PARTIAL"
      : "COMPLETED";
  const updatedBatch = await prisma.meetingTranscriptImportBatch.update({
    where: { id: batch.id },
    data: {
      status: finalStatus,
      finishedAt: new Date(),
      importedCount,
      skippedCount,
      failedCount,
      error: finalStatus === "FAILED" ? "All transcript imports failed." : null,
    },
  });

  return { batch: updatedBatch, results };
}

export async function retryMeetingTranscriptImportBatch(actor: AppActor, params: {
  workspaceId: string;
  batchId: string;
}) {
  await requireWorkspaceMembership({ actor, workspaceId: params.workspaceId });
  const batch = await prisma.meetingTranscriptImportBatch.findFirst({
    where: { id: params.batchId, workspaceId: params.workspaceId },
    include: {
      records: {
        where: { status: "FAILED" },
        orderBy: { recordedAt: "asc" },
      },
    },
  });
  invariant(batch, 404, "NOT_FOUND", "Import batch not found.");
  invariant(batch.records.length > 0, 400, "INVALID_STATE", "This batch has no failed transcript records to retry.");
  return importMeetingTranscriptSourceArtifacts(actor, {
    workspaceId: params.workspaceId,
    provider: batch.provider,
    connectionId: batch.connectionId,
    sourceKind: "retry",
    artifacts: batch.records.map((record) => {
      const metadata = asRecord(record.rawMetadataJson);
      const participants = asRecord(record.participantsJson);
      return {
        externalId: record.externalId,
        title: record.title,
        recordedAt: record.recordedAt,
        sourceUpdatedAt: record.sourceUpdatedAt,
        sourceUrl: record.sourceUrl,
        meetingUrl: asString(metadata.meetingUrl) || asString(metadata.meeting_url),
        calendarExternalId: asString(metadata.calendarExternalId) || asString(metadata.calendar_id),
        text: record.transcriptText,
        summaryMd: record.summaryMd,
        participantEmails: asArray(participants.participantEmails)
          .map(asString)
          .filter((email): email is string => Boolean(email)),
        participants: asArray(participants.participants),
        segments: asArray(record.segmentsJson)
          .map(normalizeSegment)
          .filter((segment): segment is MeetingTranscriptSegment => Boolean(segment)),
        metadata,
      };
    }),
  });
}

export async function runMeetingTranscriptSourceBackfill(actor: AppActor, params: {
  workspaceId: string;
  provider: MeetingTranscriptSourceProvider | string;
}) {
  await requireWorkspaceMembership({ actor, workspaceId: params.workspaceId, allowedRoles: ["ADMIN", "FACILITATOR"] });
  const provider = typeof params.provider === "string" ? normalizeMeetingTranscriptSourceProvider(params.provider) : params.provider;
  const connection = await prisma.meetingTranscriptSourceConnection.findUnique({
    where: { workspaceId_provider: { workspaceId: params.workspaceId, provider } },
  });
  invariant(connection, 404, "NOT_FOUND", "Meeting transcript source is not connected.");
  const batch = await prisma.meetingTranscriptImportBatch.create({
    data: {
      workspaceId: params.workspaceId,
      connectionId: connection.id,
      provider,
      sourceKind: "provider_backfill",
      status: "FAILED",
      startedAt: new Date(),
      finishedAt: new Date(),
      error: "Automatic historical backfill is not enabled for this provider yet. Upload the provider export ZIP for first-batch processing.",
    },
  });
  await prisma.meetingTranscriptSourceConnection.update({
    where: { id: connection.id },
    data: {
      lastBackfillAt: new Date(),
      lastError: batch.error,
    },
  });
  return { batch };
}

export async function listMeetingTranscriptSourceState(actor: AppActor, workspaceId: string) {
  await requireWorkspaceMembership({ actor, workspaceId });
  const [connections, batches, records] = await Promise.all([
    prisma.meetingTranscriptSourceConnection.findMany({
      where: { workspaceId },
      orderBy: { updatedAt: "desc" },
      select: {
        id: true,
        provider: true,
        displayName: true,
        status: true,
        authMode: true,
        apiKeyEnc: true,
        accessTokenEnc: true,
        refreshTokenEnc: true,
        webhookSecretEnc: true,
        lastSyncAt: true,
        lastBackfillAt: true,
        lastError: true,
        createdAt: true,
        updatedAt: true,
      },
    }),
    prisma.meetingTranscriptImportBatch.findMany({
      where: { workspaceId },
      orderBy: { createdAt: "desc" },
      take: 20,
    }),
    prisma.meetingTranscriptSourceRecord.findMany({
      where: { workspaceId },
      orderBy: [{ recordedAt: "desc" }, { createdAt: "desc" }],
      take: 30,
      select: {
        id: true,
        provider: true,
        externalId: true,
        title: true,
        recordedAt: true,
        sourceUpdatedAt: true,
        sourceUrl: true,
        status: true,
        meetingId: true,
        processedAt: true,
        error: true,
        createdAt: true,
      },
    }),
  ]);

  return {
    catalog: getMeetingTranscriptProviderCatalog(),
    connections: connections.map((connection) => ({
      ...connection,
      hasApiKey: Boolean(connection.apiKeyEnc),
      hasAccessToken: Boolean(connection.accessTokenEnc),
      hasRefreshToken: Boolean(connection.refreshTokenEnc),
      hasWebhookSecret: Boolean(connection.webhookSecretEnc),
      apiKeyEnc: undefined,
      accessTokenEnc: undefined,
      refreshTokenEnc: undefined,
      webhookSecretEnc: undefined,
    })),
    batches,
    records,
  };
}

function signatures(raw: string, secret: string) {
  const digest = createHmac("sha256", secret).update(raw).digest();
  return [
    digest.toString("hex"),
    digest.toString("base64"),
    `sha256=${digest.toString("hex")}`,
    `sha256=${digest.toString("base64")}`,
  ];
}

function safeEqual(left: string, right: string) {
  const leftBuffer = Buffer.from(left);
  const rightBuffer = Buffer.from(right);
  return leftBuffer.length === rightBuffer.length && timingSafeEqual(leftBuffer, rightBuffer);
}

export function verifyMeetingTranscriptWebhookSignature(params: {
  provider: MeetingTranscriptSourceProvider | string;
  rawBody: string;
  headers: Headers | Record<string, string | string[] | undefined>;
  secret: string;
}) {
  const provider = typeof params.provider === "string" ? normalizeMeetingTranscriptSourceProvider(params.provider) : params.provider;
  const header = (name: string) => {
    if (params.headers instanceof Headers) return params.headers.get(name);
    const value = params.headers[name] ?? params.headers[name.toLowerCase()];
    return Array.isArray(value) ? value[0] : value ?? null;
  };
  const headerNames = provider === "FIREFLIES"
    ? ["x-fireflies-signature", "x-hub-signature-256", "x-webhook-signature"]
    : provider === "FATHOM"
      ? ["x-fathom-signature", "x-webhook-signature", "x-hub-signature-256"]
      : ["x-webhook-signature", "x-hub-signature-256"];
  const actual = headerNames.map(header).find(Boolean)?.trim();
  if (!actual || !params.secret.trim()) return false;
  return signatures(params.rawBody, params.secret.trim()).some((expected) => safeEqual(expected, actual));
}

function webhookArtifactFromPayload(provider: MeetingTranscriptSourceProvider, payload: Record<string, unknown>): MeetingTranscriptSourceArtifact {
  const data = asRecord(payload.data);
  const transcript = asRecord(payload.transcript);
  const recording = asRecord(payload.recording);
  const meeting = asRecord(payload.meeting);
  const source = Object.keys(data).length > 0 ? data : payload;
  return {
    json: source,
    externalId: asString(source.transcript_id)
      ?? asString(source.transcriptId)
      ?? asString(source.recording_id)
      ?? asString(source.recordingId)
      ?? asString(source.id)
      ?? asString(transcript.id)
      ?? asString(recording.id)
      ?? asString(meeting.id),
    title: asString(source.title) ?? asString(recording.title) ?? asString(meeting.title),
    recordedAt: asDate(source.recordedAt)
      ?? asDate(source.recorded_at)
      ?? asDate(source.date)
      ?? asDate(source.started_at)
      ?? asDate(recording.started_at)
      ?? asDate(meeting.start_time),
    sourceUpdatedAt: asDate(source.updatedAt) ?? asDate(source.updated_at) ?? new Date(),
    sourceUrl: asString(source.url) ?? asString(source.transcript_url),
    text: asString(source.transcript_text) ?? asString(source.text) ?? null,
    summaryMd: asString(source.summary) ?? asString(asRecord(source.summary).overview),
    metadata: { provider, webhookPayload: payload },
  };
}

async function fetchProviderTranscriptArtifact(connection: { provider: MeetingTranscriptSourceProvider; apiKeyEnc: string | null }, payloadArtifact: MeetingTranscriptSourceArtifact) {
  if (payloadArtifact.text || payloadArtifact.json && (asArray(asRecord(payloadArtifact.json).sentences).length > 0 || asArray(asRecord(payloadArtifact.json).segments).length > 0)) {
    return payloadArtifact;
  }
  if (!connection.apiKeyEnc || !payloadArtifact.externalId) return payloadArtifact;
  const apiKey = decryptSecret(connection.apiKeyEnc);
  if (connection.provider === "FIREFLIES") {
    const response = await fetch("https://api.fireflies.ai/graphql", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify({
        query: `query Transcript($id: String!) { transcript(id: $id) { id title date transcript_url participants sentences { speaker_name text start_time end_time } summary { overview action_items } } }`,
        variables: { id: payloadArtifact.externalId },
      }),
    });
    if (response.ok) {
      const body = await response.json() as Record<string, unknown>;
      return { ...payloadArtifact, json: asRecord(asRecord(body.data).transcript) };
    }
  }
  if (connection.provider === "FATHOM") {
    const response = await fetch(`https://api.fathom.ai/external/v1/recordings/${encodeURIComponent(payloadArtifact.externalId)}/transcript`, {
      headers: { authorization: `Bearer ${apiKey}` },
    });
    if (response.ok) {
      return { ...payloadArtifact, json: await response.json() };
    }
  }
  return payloadArtifact;
}

export async function processMeetingTranscriptSourceWebhook(params: {
  provider: MeetingTranscriptSourceProvider | string;
  workspaceId: string;
  rawBody: string;
  headers: Headers | Record<string, string | string[] | undefined>;
}) {
  const provider = typeof params.provider === "string" ? normalizeMeetingTranscriptSourceProvider(params.provider) : params.provider;
  if (provider !== "FIREFLIES" && provider !== "FATHOM") {
    throw new AppError(400, "UNSUPPORTED_PROVIDER_WEBHOOK", "This provider webhook is not enabled yet.");
  }
  const connection = await prisma.meetingTranscriptSourceConnection.findUnique({
    where: { workspaceId_provider: { workspaceId: params.workspaceId, provider } },
  });
  invariant(connection?.webhookSecretEnc, 404, "NOT_FOUND", "Webhook secret is not configured for this meeting transcript source.");
  const secret = decryptSecret(connection.webhookSecretEnc);
  invariant(verifyMeetingTranscriptWebhookSignature({ provider, rawBody: params.rawBody, headers: params.headers, secret }), 401, "INVALID_SIGNATURE", "Invalid meeting transcript webhook signature.");
  const payload = JSON.parse(params.rawBody) as Record<string, unknown>;
  const artifact = await fetchProviderTranscriptArtifact(connection, webhookArtifactFromPayload(provider, payload));
  const actor: AppActor = {
    kind: "agent",
    authProvider: "bootstrap",
    label: `${provider.toLowerCase()}-meeting-transcript-webhook`,
    workspaceIds: [params.workspaceId],
    scopes: ["support:write"],
  };
  const result = await importMeetingTranscriptSourceArtifacts(actor, {
    workspaceId: params.workspaceId,
    provider,
    connectionId: connection.id,
    sourceKind: "webhook",
    artifacts: [artifact],
  });
  await prisma.meetingTranscriptSourceConnection.update({
    where: { id: connection.id },
    data: {
      lastSyncAt: new Date(),
      lastError: result.batch.status === "FAILED" ? result.batch.error : null,
    },
  });
  return result;
}
