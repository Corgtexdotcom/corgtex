import { createHash, createHmac, timingSafeEqual } from "node:crypto";
import type { MeetingTranscriptSourceProvider, Prisma } from "@prisma/client";
import { decryptSecret, encryptSecret, prisma, toInputJson, type AppActor } from "@corgtex/shared";
import { requireWorkspaceMembership } from "./auth";
import { AppError, invariant } from "./errors";
import { intakeMeetingTranscript, type MeetingTranscriptSegment } from "./meeting-transcript-intake";

export type TranscriptAuthMode = "API_KEY" | "OAUTH_ADMIN" | "MCP" | "MANUAL_EXPORT";
export type TranscriptSourceDataShape = "TRANSCRIPT_TEXT" | "SPEAKER_SEGMENTS" | "SUMMARY" | "ACTION_ITEMS" | "RECORDING_METADATA";
export type TranscriptFormat = "json" | "vtt" | "srt" | "txt" | "docx" | "pdf" | "zip" | "csv";
export const MEETING_TRANSCRIPT_SOURCES_FEATURE_FLAG = "MEETING_TRANSCRIPT_SOURCES";
const LEGACY_MEETING_RECORDERS_FEATURE_FLAG = "MEETING_RECORDERS";
const MEETING_TRANSCRIPT_SOURCE_FEATURE_FLAGS = [
  MEETING_TRANSCRIPT_SOURCES_FEATURE_FLAG,
  LEGACY_MEETING_RECORDERS_FEATURE_FLAG,
] as const;
const V1_TRANSCRIPT_SOURCE_PROVIDERS = new Set<MeetingTranscriptSourceProvider>([
  "READ_AI",
  "FATHOM",
  "FIREFLIES",
  "MANUAL_UPLOAD",
]);
const PROVIDER_BACKFILL_LOOKBACK_DAYS = 90;
const PROVIDER_BACKFILL_MAX_ARTIFACTS = 500;
const TRANSCRIPT_SOURCE_DUPLICATE_MATCH_WINDOW_MS = 2 * 60 * 60 * 1000;
const TRANSCRIPT_SOURCE_DUPLICATE_SCORE_THRESHOLD = 0.7;

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
  ingestionGuidanceMd?: string | null;
  participantEmails?: string[] | null;
  participants?: unknown[] | null;
  segments?: MeetingTranscriptSegment[] | null;
  metadata?: Record<string, unknown> | null;
};

type TranscriptSourceConnectionForProviderApi = {
  id: string;
  provider: MeetingTranscriptSourceProvider;
  apiKeyEnc: string | null;
  webhookSecretEnc?: string | null;
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
  ingestionGuidanceMd: string | null;
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

async function meetingTranscriptSourcesFeatureEnabled(workspaceId: string) {
  const flags = await prisma.workspaceFeatureFlag.findMany({
    where: {
      workspaceId,
      flag: { in: [...MEETING_TRANSCRIPT_SOURCE_FEATURE_FLAGS] },
    },
    select: { flag: true, enabled: true },
  });
  return flags.some((flag) => flag.enabled);
}

export async function getMeetingTranscriptSourcesFeatureState(actor: AppActor, workspaceId: string) {
  await requireWorkspaceMembership({ actor, workspaceId });
  return { featureEnabled: await meetingTranscriptSourcesFeatureEnabled(workspaceId) };
}

async function requireMeetingTranscriptSourcesFeature(workspaceId: string) {
  invariant(
    await meetingTranscriptSourcesFeatureEnabled(workspaceId),
    403,
    "FEATURE_DISABLED",
    "Meeting transcript sources are not enabled for this workspace.",
  );
}

export async function enableMeetingTranscriptSourcesForWorkspace(actor: AppActor, params: {
  workspaceId: string;
  enabled?: boolean;
}) {
  await requireWorkspaceMembership({ actor, workspaceId: params.workspaceId, allowedRoles: ["ADMIN"] });
  const enabled = params.enabled ?? true;
  const flag = await prisma.workspaceFeatureFlag.upsert({
    where: {
      workspaceId_flag: {
        workspaceId: params.workspaceId,
        flag: MEETING_TRANSCRIPT_SOURCES_FEATURE_FLAG,
      },
    },
    create: {
      workspaceId: params.workspaceId,
      flag: MEETING_TRANSCRIPT_SOURCES_FEATURE_FLAG,
      enabled,
    },
    update: { enabled },
  });
  await prisma.auditLog.create({
    data: {
      workspaceId: params.workspaceId,
      actorUserId: actor.kind === "user" ? actor.user.id : null,
      action: "meeting-transcript-sources.feature-updated",
      entityType: "WorkspaceFeatureFlag",
      entityId: flag.id,
      meta: {
        flag: MEETING_TRANSCRIPT_SOURCES_FEATURE_FLAG,
        enabled,
      } satisfies Prisma.InputJsonObject,
    },
  });
  return { featureEnabled: enabled };
}

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
    firstPath: "Workspace webhook for post-call transcripts; Corgtex analyzes transcript and cross-checks Read.ai action items.",
    connectionStatus: "ready",
    manualExportInstructions: [
      "Create a Read.ai workspace webhook with the meeting_end trigger and paste this Corgtex webhook URL.",
      "Store the Read.ai signing key as the webhook secret. Historical backfill can still use JSON/TXT/ZIP exports.",
    ],
    expectedFields: ["meeting id", "title", "start time", "transcript", "summary", "action items"],
    notes: "Read.ai handles meeting attendance. Corgtex ingests completed reports, runs its own extraction, and uses provider action items as a cross-check.",
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

export function getV1MeetingTranscriptProviderCatalog() {
  return getMeetingTranscriptProviderCatalog()
    .filter((entry) => V1_TRANSCRIPT_SOURCE_PROVIDERS.has(entry.provider))
    .sort((left, right) => {
      const order = ["READ_AI", "FATHOM", "FIREFLIES", "MANUAL_UPLOAD"];
      return order.indexOf(left.provider) - order.indexOf(right.provider);
    });
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

function asNumber(value: unknown): number | null {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string" && value.trim()) {
    const parsed = Number(value.trim());
    return Number.isFinite(parsed) ? parsed : null;
  }
  return null;
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

function emailSearchStrings(value: unknown, depth = 0): string[] {
  if (depth > 4 || value == null) return [];
  if (typeof value === "string" || typeof value === "number") return [String(value)];
  if (Array.isArray(value)) return value.flatMap((item) => emailSearchStrings(item, depth + 1));
  if (typeof value === "object") {
    const record = value as Record<string, unknown>;
    const direct = [
      record.email,
      record.emailAddress,
      record.mail,
      asRecord(record.user).email,
      asRecord(record.profile).email,
    ].flatMap((item) => emailSearchStrings(item, depth + 1));
    return direct.length > 0 ? direct : Object.values(record).flatMap((item) => emailSearchStrings(item, depth + 1));
  }
  return [];
}

function uniqueEmails(values: unknown[]) {
  const emails = values
    .flatMap((value) => emailSearchStrings(value))
    .flatMap((value) => value.match(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi) ?? []);
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

function failedArtifactFingerprint(provider: MeetingTranscriptSourceProvider, artifact: MeetingTranscriptSourceArtifact) {
  return stableHash({
    provider,
    fileName: artifact.fileName ?? null,
    externalId: artifact.externalId ?? null,
    recordedAt: artifact.recordedAt ?? null,
    text: artifact.text ?? null,
    json: artifact.json ?? null,
  });
}

function failedRecordInputFromArtifact(provider: MeetingTranscriptSourceProvider, artifact: MeetingTranscriptSourceArtifact) {
  const transcriptText = artifact.text?.trim()
    || (artifact.json ? JSON.stringify(artifact.json) : "")
    || artifact.fileName?.trim()
    || "Transcript artifact could not be normalized.";
  const recordedAt = asDate(artifact.recordedAt)
    ?? parseDateFromText(`${artifact.fileName ?? ""}\n${artifact.text ?? ""}`)
    ?? new Date();
  const fingerprint = failedArtifactFingerprint(provider, artifact);
  const participants = artifact.participants ?? [];
  const participantEmails = artifact.participantEmails ?? [];
  const rawMetadata = {
    ...(artifact.metadata ?? {}),
    fileName: artifact.fileName ?? null,
    mimeType: artifact.mimeType ?? null,
    normalizationFailed: true,
    originalArtifact: artifact,
  };
  return {
    externalId: artifact.externalId?.trim() || `normalization-failed:${fingerprint.slice(0, 32)}`,
    title: artifact.title?.trim() || artifact.fileName?.trim() || "Unrecognized transcript export",
    recordedAt,
    sourceUpdatedAt: asDate(artifact.sourceUpdatedAt),
    sourceUrl: artifact.sourceUrl?.trim() || null,
    contentHash: contentHashFor({
      transcript: transcriptText,
      summaryMd: artifact.summaryMd?.trim() || null,
      segments: artifact.segments ?? [],
    }),
    transcriptText,
    summaryMd: artifact.summaryMd?.trim() || null,
    segmentsJson: artifact.segments && artifact.segments.length > 0 ? toInputJson(artifact.segments) : undefined,
    participantsJson: participants.length > 0 || participantEmails.length > 0
      ? toInputJson({ participants, participantEmails })
      : undefined,
    rawMetadataJson: toInputJson(rawMetadata),
  };
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
  const speakerRecord = asRecord(record.speaker);
  const speaker = asString(record.speaker)
    ?? asString(speakerRecord.display_name)
    ?? asString(speakerRecord.name)
    ?? asString(record.speaker_name)
    ?? asString(record.name);
  const startMs = typeof record.startMs === "number"
    ? record.startMs
    : typeof record.start_time === "number"
      ? record.start_time * 1000
      : asString(record.timestamp)
        ? parseTimestampMs(asString(record.timestamp) ?? "")
        : null;
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

function readAiTimestampMs(value: unknown) {
  const parsed = asNumber(value);
  if (parsed == null) return null;
  return parsed > 10_000_000_000 ? parsed : parsed * 1000;
}

function readAiTextItem(value: unknown) {
  const record = asRecord(value);
  return asString(record.text) ?? asString(record.title) ?? (typeof value === "string" ? value.trim() : null);
}

function readAiTextItems(value: unknown) {
  return asArray(value)
    .map(readAiTextItem)
    .filter((item): item is string => Boolean(item));
}

function markdownList(title: string, items: string[]) {
  return items.length > 0 ? [`## ${title}`, ...items.map((item) => `- ${item}`)].join("\n") : null;
}

function readAiSummaryMdFromPayload(payload: Record<string, unknown>) {
  const summary = asString(payload.summary);
  const actionItems = readAiTextItems(payload.action_items);
  const keyQuestions = readAiTextItems(payload.key_questions);
  const topics = readAiTextItems(payload.topics);
  const chapterSummaries = asArray(payload.chapter_summaries)
    .map((value) => {
      const record = asRecord(value);
      const title = asString(record.title);
      const description = asString(record.description);
      if (!title && !description) return null;
      return [title ? `### ${title}` : null, description].filter(Boolean).join("\n");
    })
    .filter((item): item is string => Boolean(item));
  const sections = [
    summary ? `## Read.ai summary\n${summary}` : null,
    markdownList("Read.ai action items", actionItems),
    markdownList("Read.ai key questions", keyQuestions),
    markdownList("Read.ai topics", topics),
    chapterSummaries.length > 0 ? ["## Read.ai chapter summaries", ...chapterSummaries].join("\n") : null,
  ].filter(Boolean);
  return sections.length > 0 ? sections.join("\n\n") : null;
}

function readAiIngestionGuidanceFromPayload(payload: Record<string, unknown>) {
  const actionItems = readAiTextItems(payload.action_items);
  if (actionItems.length === 0) return null;
  return [
    "Read.ai supplied action items for this meeting. Run Corgtex extraction from the transcript as the source of truth, then cross-check these provider-supplied items so concrete owner-backed commitments are not missed. Do not create vague awareness-only actions.",
    "",
    ...actionItems.map((item) => `- ${item}`),
  ].join("\n");
}

function readAiSegmentsFromPayload(payload: Record<string, unknown>): MeetingTranscriptSegment[] {
  const transcript = asRecord(payload.transcript);
  return asArray(transcript.speaker_blocks)
    .map((block): MeetingTranscriptSegment | null => {
      const record = asRecord(block);
      const text = asString(record.words) ?? asString(record.text);
      if (!text) return null;
      const speaker = asString(asRecord(record.speaker).name) ?? asString(record.speaker);
      return {
        speaker,
        startMs: readAiTimestampMs(record.start_time),
        endMs: readAiTimestampMs(record.end_time),
        text,
      };
    })
    .filter((segment): segment is MeetingTranscriptSegment => Boolean(segment));
}

function readAiPlatformMeetingUrl(platform: string | null, platformMeetingId: string | null) {
  if (!platformMeetingId) return null;
  const normalizedPlatform = platform?.trim().toLowerCase() ?? "";
  if (normalizedPlatform === "meet" || normalizedPlatform === "google_meet" || normalizedPlatform === "google meet") {
    return `https://meet.google.com/${platformMeetingId.trim()}`;
  }
  if (normalizedPlatform === "zoom") {
    return `https://zoom.us/j/${platformMeetingId.trim()}`;
  }
  return null;
}

function readAiWebhookArtifactFromPayload(payload: Record<string, unknown>): MeetingTranscriptSourceArtifact | null {
  const trigger = asString(payload.trigger);
  if (trigger === "meeting_start") return null;
  const segments = readAiSegmentsFromPayload(payload);
  const transcriptText = transcriptTextFromSegments(segments);
  const platform = asString(payload.platform);
  const platformMeetingId = asString(payload.platform_meeting_id);
  const summaryMd = readAiSummaryMdFromPayload(payload);
  const participants = asArray(payload.participants);
  const owner = asRecord(payload.owner);
  const participantEmails = uniqueEmails([participants, owner]);
  return {
    json: payload,
    externalId: asString(payload.session_id) ?? asString(payload.id),
    title: asString(payload.title),
    recordedAt: asDate(payload.start_time),
    sourceUpdatedAt: asDate(payload.end_time) ?? new Date(),
    sourceUrl: asString(payload.report_url),
    meetingUrl: readAiPlatformMeetingUrl(platform, platformMeetingId),
    summaryMd,
    ingestionGuidanceMd: readAiIngestionGuidanceFromPayload(payload),
    text: transcriptText || null,
    participantEmails,
    participants,
    segments,
    metadata: {
      provider: "READ_AI",
      webhookPayload: payload,
      requestId: asString(payload.request_id),
      platform,
      platformMeetingId,
      trigger,
      owner,
      readAiSummaryMd: summaryMd,
      readAiActionItems: readAiTextItems(payload.action_items),
    },
  };
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
    ?? asString(jsonRecord.transcript)
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
    || (asNumber(jsonRecord.recording_id) != null ? String(asNumber(jsonRecord.recording_id)) : null)
    || asString(jsonRecord.meeting_id)
    || asString(jsonRecord.meetingId)
    || asString(nestedMeeting.id)
    || asString(nestedRecording.id);
  const title = artifact.title?.trim()
    || asString(jsonRecord.title)
    || asString(jsonRecord.meeting_title)
    || asString(jsonRecord.name)
    || asString(nestedMeeting.title)
    || asString(nestedRecording.title)
    || titleFromFileName(artifact.fileName);
  const recordedAt = asDate(artifact.recordedAt)
    || asDate(jsonRecord.recordedAt)
    || asDate(jsonRecord.recorded_at)
    || asDate(jsonRecord.date)
    || asDate(jsonRecord.start_time)
    || asDate(jsonRecord.recording_start_time)
    || asDate(jsonRecord.scheduled_start_time)
    || asDate(jsonRecord.created_at)
    || asDate(jsonRecord.timestamp)
    || asDate(nestedMeeting.start_time)
    || parseDateFromText(`${artifact.fileName ?? ""}\n${text.slice(0, 2000)}`);
  invariant(recordedAt, 400, "RECORDED_AT_REQUIRED", `Recorded date is required for ${artifact.fileName || explicitExternalId || "transcript artifact"}.`);
  const externalId = explicitExternalId
    || `${provider.toLowerCase()}:${stableHash({
      fileName: artifact.fileName,
      recordedAt: recordedAt.toISOString(),
      title,
      sourceUrl: artifact.sourceUrl?.trim() || asString(jsonRecord.url) || asString(jsonRecord.sourceUrl) || asString(jsonRecord.transcript_url) || null,
    }).slice(0, 24)}`;
  const sourceUpdatedAt = asDate(artifact.sourceUpdatedAt)
    || asDate(jsonRecord.updatedAt)
    || asDate(jsonRecord.updated_at)
    || asDate(jsonRecord.modified_at)
    || asDate(jsonRecord.recording_end_time)
    || asDate(jsonRecord.created_at)
    || null;
  const sourceUrl = artifact.sourceUrl?.trim()
    || asString(jsonRecord.url)
    || asString(jsonRecord.sourceUrl)
    || asString(jsonRecord.share_url)
    || asString(jsonRecord.transcript_url)
    || null;
  const meetingUrl = artifact.meetingUrl?.trim()
    || asString(jsonRecord.meetingUrl)
    || asString(jsonRecord.meeting_url)
    || asString(jsonRecord.meeting_link)
    || asString(nestedMeeting.url)
    || null;
  const participantEmails = [
    ...(artifact.participantEmails ?? []),
    ...uniqueEmails([
      jsonRecord.participants,
      jsonRecord.attendees,
      jsonRecord.calendar_invitees,
      jsonRecord.meeting_attendees,
      jsonRecord.recorded_by,
      jsonRecord.transcript,
      jsonRecord.action_items,
      nestedMeeting.participants,
      nestedRecording.participants,
      text.slice(0, 6000),
    ]),
  ].map((email) => email.trim().toLowerCase()).filter(Boolean);
  const participants = artifact.participants
    ?? asArray(jsonRecord.participants)
      .concat(asArray(jsonRecord.attendees))
      .concat(asArray(jsonRecord.calendar_invitees))
      .concat(asArray(jsonRecord.meeting_attendees));
  const summaryMd = artifact.summaryMd?.trim()
    || asString(jsonRecord.summary)
    || asString(jsonRecord.summaryMd)
    || asString(asRecord(jsonRecord.summary).overview)
    || asString(asRecord(jsonRecord.default_summary).markdown_formatted)
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
    ingestionGuidanceMd: artifact.ingestionGuidanceMd?.trim() || null,
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

async function createFathomWebhook(params: { apiKey: string; webhookUrl: string }) {
  const response = await fetch("https://api.fathom.ai/external/v1/webhooks", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "X-Api-Key": params.apiKey,
    },
    body: JSON.stringify({
      destination_url: params.webhookUrl,
      triggered_for: [
        "my_recordings",
        "my_shared_with_team_recordings",
        "shared_external_recordings",
      ],
      include_action_items: true,
      include_summary: true,
      include_transcript: true,
    }),
  });
  const body = await response.json().catch(() => null);
  if (!response.ok) {
    const message = asString(asRecord(body).message)
      ?? asString(asRecord(body).error)
      ?? "Fathom webhook registration failed.";
    throw new AppError(502, "PROVIDER_WEBHOOK_REGISTRATION_FAILED", message);
  }
  const secret = asString(asRecord(body).secret);
  invariant(secret, 502, "PROVIDER_WEBHOOK_REGISTRATION_FAILED", "Fathom did not return a webhook secret.");
  return secret;
}

export async function connectMeetingTranscriptSource(actor: AppActor, params: {
  workspaceId: string;
  provider: MeetingTranscriptSourceProvider | string;
  displayName?: string | null;
  apiKey?: string | null;
  accessToken?: string | null;
  refreshToken?: string | null;
  webhookSecret?: string | null;
  webhookUrl?: string | null;
}) {
  await requireWorkspaceMembership({ actor, workspaceId: params.workspaceId, allowedRoles: ["ADMIN"] });
  await requireMeetingTranscriptSourcesFeature(params.workspaceId);
  const provider = typeof params.provider === "string" ? normalizeMeetingTranscriptSourceProvider(params.provider) : params.provider;
  const catalogEntry = getMeetingTranscriptProviderCatalogEntry(provider);
  const apiKey = params.apiKey?.trim();
  const accessToken = params.accessToken?.trim();
  const refreshToken = params.refreshToken?.trim();
  let webhookSecret = params.webhookSecret?.trim();
  const webhookUrl = params.webhookUrl?.trim();
  if (provider === "FATHOM" && apiKey && webhookUrl && !webhookSecret) {
    webhookSecret = await createFathomWebhook({ apiKey, webhookUrl });
  }
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

function normalizeMatchText(value?: string | null) {
  return (value ?? "").trim().toLowerCase().replace(/[^a-z0-9]+/g, " ").replace(/\s+/g, " ").trim();
}

function normalizeMatchKey(value: unknown) {
  const text = asString(value);
  return text ? text.toLowerCase().replace(/\/+$/, "") : null;
}

function meetingKeysFromMetadata(metadataValue: unknown) {
  const metadata = asRecord(metadataValue);
  return [
    normalizeMatchKey(metadata.meetingUrl),
    normalizeMatchKey(metadata.meeting_url),
    normalizeMatchKey(metadata.calendarExternalId),
    normalizeMatchKey(metadata.calendar_id),
    normalizeMatchKey(metadata.platformMeetingId),
    normalizeMatchKey(metadata.platform_meeting_id),
  ].filter((value): value is string => Boolean(value));
}

function participantEmailsFromJson(value: unknown) {
  const record = asRecord(value);
  return uniqueEmails([record.participantEmails, record.participants]);
}

function scoreTranscriptSourceDuplicate(params: {
  artifact: NormalizedMeetingTranscriptSourceArtifact;
  record: {
    title: string | null;
    recordedAt: Date;
    contentHash: string;
    participantsJson: Prisma.JsonValue | null;
    rawMetadataJson: Prisma.JsonValue | null;
  };
}) {
  const artifactKeys = new Set([
    normalizeMatchKey(params.artifact.meetingUrl),
    normalizeMatchKey(params.artifact.calendarExternalId),
    ...meetingKeysFromMetadata(params.artifact.rawMetadata),
  ].filter((value): value is string => Boolean(value)));
  const recordKeys = meetingKeysFromMetadata(params.record.rawMetadataJson);
  if (recordKeys.some((key) => artifactKeys.has(key))) return 1;
  if (params.record.contentHash === params.artifact.contentHash) return 1;

  const artifactTitle = normalizeMatchText(params.artifact.title);
  const recordTitle = normalizeMatchText(params.record.title);
  let titleScore = 0;
  if (artifactTitle && recordTitle) {
    titleScore = artifactTitle === recordTitle
      ? 0.3
      : artifactTitle.includes(recordTitle) || recordTitle.includes(artifactTitle)
        ? 0.18
        : 0;
  }
  const diff = Math.abs(params.record.recordedAt.getTime() - params.artifact.recordedAt.getTime());
  const timeScore = Math.max(0, 0.4 * (1 - diff / TRANSCRIPT_SOURCE_DUPLICATE_MATCH_WINDOW_MS));
  const artifactEmails = params.artifact.participantEmails;
  const recordEmails = new Set(participantEmailsFromJson(params.record.participantsJson));
  const overlap = artifactEmails.filter((email) => recordEmails.has(email)).length;
  const attendeeScore = artifactEmails.length > 0
    ? 0.25 * (overlap / artifactEmails.length)
    : 0.05;
  return Number(Math.min(1, titleScore + timeScore + attendeeScore).toFixed(3));
}

async function findLikelyExistingMeetingIdForArtifact(params: {
  workspaceId: string;
  artifact: NormalizedMeetingTranscriptSourceArtifact;
}) {
  const start = new Date(params.artifact.recordedAt.getTime() - TRANSCRIPT_SOURCE_DUPLICATE_MATCH_WINDOW_MS);
  const end = new Date(params.artifact.recordedAt.getTime() + TRANSCRIPT_SOURCE_DUPLICATE_MATCH_WINDOW_MS);
  const candidates = await prisma.meetingTranscriptSourceRecord.findMany({
    where: {
      workspaceId: params.workspaceId,
      status: "ACTIVE",
      meetingId: { not: null },
      recordedAt: { gte: start, lte: end },
    },
    orderBy: [{ recordedAt: "asc" }, { createdAt: "asc" }],
    take: 30,
    select: {
      id: true,
      meetingId: true,
      title: true,
      recordedAt: true,
      contentHash: true,
      participantsJson: true,
      rawMetadataJson: true,
    },
  });

  const [best] = candidates
    .map((record) => ({
      meetingId: record.meetingId,
      score: scoreTranscriptSourceDuplicate({
        artifact: params.artifact,
        record,
      }),
    }))
    .filter((candidate): candidate is { meetingId: string; score: number } => Boolean(candidate.meetingId))
    .sort((left, right) => right.score - left.score);
  return best && best.score >= TRANSCRIPT_SOURCE_DUPLICATE_SCORE_THRESHOLD ? best.meetingId : null;
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
  const likelyExistingMeetingId = activeRecord?.meetingId ?? await findLikelyExistingMeetingIdForArtifact({
    workspaceId: params.workspaceId,
    artifact,
  });
  const incomingUpdatedAt = artifact.sourceUpdatedAt ?? artifact.recordedAt;
  const activeUpdatedAt = activeRecord ? activeRecord.sourceUpdatedAt ?? activeRecord.recordedAt : null;
  const hasChangedContent = Boolean(activeRecord && activeRecord.contentHash !== artifact.contentHash);
  const isOlderRevision = Boolean(activeRecord && !hasChangedContent && activeUpdatedAt && incomingUpdatedAt < activeUpdatedAt);
  const recordData = {
    workspaceId: params.workspaceId,
    connectionId: params.connectionId ?? null,
    batchId: params.batchId ?? null,
    meetingId: likelyExistingMeetingId,
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

  let supersededActiveRecordBeforeIntake = false;
  if (activeRecord && activeRecord.id !== record.id) {
    await prisma.meetingTranscriptSourceRecord.updateMany({
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
    supersededActiveRecordBeforeIntake = true;
  }

  let result: Awaited<ReturnType<typeof intakeMeetingTranscript>>;
  try {
    result = await intakeMeetingTranscript(actor, {
      workspaceId: params.workspaceId,
      meetingId: likelyExistingMeetingId,
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
      summaryMd: artifact.provider === "READ_AI" ? null : artifact.summaryMd,
      ingestionGuidanceMd: artifact.ingestionGuidanceMd,
      participantEmails: artifact.participantEmails,
      segments: artifact.segments,
      batchId: params.batchId,
      sourceRecordId: record.id,
      replaceTranscript: Boolean(activeRecord && activeRecord.contentHash !== artifact.contentHash),
    });
  } catch (error) {
    if (supersededActiveRecordBeforeIntake && activeRecord) {
      await prisma.meetingTranscriptSourceRecord.update({
        where: { id: activeRecord.id },
        data: { status: "ACTIVE", supersededByRecordId: null },
      });
    }
    throw error;
  }

  if (result.status === "needs_clarification") {
    if (supersededActiveRecordBeforeIntake && activeRecord) {
      await prisma.meetingTranscriptSourceRecord.update({
        where: { id: activeRecord.id },
        data: { status: "ACTIVE", supersededByRecordId: null },
      });
    }
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
  await requireMeetingTranscriptSourcesFeature(params.workspaceId);
  const provider = typeof params.provider === "string" ? normalizeMeetingTranscriptSourceProvider(params.provider) : params.provider;
  invariant(params.artifacts.length > 0, 400, "INVALID_INPUT", "At least one transcript artifact is required.");
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

  const normalized: NormalizedMeetingTranscriptSourceArtifact[] = [];
  let failedCount = 0;
  for (const artifact of params.artifacts) {
    try {
      normalized.push(normalizeMeetingTranscriptSourceArtifact(provider, artifact));
    } catch (error) {
      failedCount += 1;
      const failedRecord = failedRecordInputFromArtifact(provider, artifact);
      await prisma.meetingTranscriptSourceRecord.upsert({
        where: {
          workspaceId_provider_externalId_contentHash: {
            workspaceId: params.workspaceId,
            provider,
            externalId: failedRecord.externalId,
            contentHash: failedRecord.contentHash,
          },
        },
        update: {
          connectionId: params.connectionId ?? null,
          batchId: batch.id,
          title: failedRecord.title,
          recordedAt: failedRecord.recordedAt,
          sourceUpdatedAt: failedRecord.sourceUpdatedAt,
          sourceUrl: failedRecord.sourceUrl,
          transcriptText: failedRecord.transcriptText,
          summaryMd: failedRecord.summaryMd,
          segmentsJson: failedRecord.segmentsJson,
          participantsJson: failedRecord.participantsJson,
          rawMetadataJson: failedRecord.rawMetadataJson,
          status: "FAILED",
          processedAt: null,
          error: error instanceof Error ? error.message : "Transcript normalization failed.",
        },
        create: {
          workspaceId: params.workspaceId,
          connectionId: params.connectionId ?? null,
          batchId: batch.id,
          provider,
          externalId: failedRecord.externalId,
          title: failedRecord.title,
          recordedAt: failedRecord.recordedAt,
          sourceUpdatedAt: failedRecord.sourceUpdatedAt,
          sourceUrl: failedRecord.sourceUrl,
          contentHash: failedRecord.contentHash,
          transcriptText: failedRecord.transcriptText,
          summaryMd: failedRecord.summaryMd,
          segmentsJson: failedRecord.segmentsJson,
          participantsJson: failedRecord.participantsJson,
          rawMetadataJson: failedRecord.rawMetadataJson,
          status: "FAILED",
          error: error instanceof Error ? error.message : "Transcript normalization failed.",
        },
      });
    }
  }
  normalized.sort((left, right) => left.recordedAt.getTime() - right.recordedAt.getTime());

  let importedCount = 0;
  let skippedCount = 0;
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
      const existing = await prisma.meetingTranscriptSourceRecord.findUnique({
        where: {
          workspaceId_provider_externalId_contentHash: {
            workspaceId: params.workspaceId,
            provider,
            externalId: artifact.externalId,
            contentHash: artifact.contentHash,
          },
        },
      });
      if (existing && existing.status !== "FAILED" && (existing.meetingId || existing.processedAt)) {
        skippedCount += 1;
        results.push({ status: "skipped", record: existing, meeting: null, reason: "duplicate_content" });
        continue;
      }
      failedCount += 1;
      const failedData = {
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
        status: "FAILED" as const,
        processedAt: null,
        error: error instanceof Error ? error.message : "Transcript import failed.",
      };
      if (existing) {
        await prisma.meetingTranscriptSourceRecord.update({
          where: { id: existing.id },
          data: failedData,
        });
      } else {
        await prisma.meetingTranscriptSourceRecord.create({
          data: {
            ...failedData,
            workspaceId: params.workspaceId,
            provider,
            externalId: artifact.externalId,
            contentHash: artifact.contentHash,
          },
        });
      }
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
  await requireMeetingTranscriptSourcesFeature(params.workspaceId);
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
      const originalArtifact = asRecord(metadata.originalArtifact);
      if (metadata.normalizationFailed && Object.keys(originalArtifact).length > 0) {
        return {
          fileName: asString(originalArtifact.fileName),
          mimeType: asString(originalArtifact.mimeType),
          externalId: asString(originalArtifact.externalId) ?? record.externalId,
          title: asString(originalArtifact.title) ?? record.title,
          recordedAt: asDate(originalArtifact.recordedAt) ?? asString(originalArtifact.recordedAt),
          sourceUpdatedAt: asDate(originalArtifact.sourceUpdatedAt) ?? asString(originalArtifact.sourceUpdatedAt),
          sourceUrl: asString(originalArtifact.sourceUrl),
          meetingUrl: asString(originalArtifact.meetingUrl),
          calendarExternalId: asString(originalArtifact.calendarExternalId),
          text: asString(originalArtifact.text),
          json: originalArtifact.json,
          summaryMd: asString(originalArtifact.summaryMd),
          participantEmails: asArray(originalArtifact.participantEmails)
            .map(asString)
            .filter((email): email is string => Boolean(email)),
          participants: asArray(originalArtifact.participants),
          segments: asArray(originalArtifact.segments)
            .map(normalizeSegment)
            .filter((segment): segment is MeetingTranscriptSegment => Boolean(segment)),
          metadata: asRecord(originalArtifact.metadata),
        };
      }
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

function providerBackfillWindowStart(now = new Date()) {
  return new Date(now.getTime() - PROVIDER_BACKFILL_LOOKBACK_DAYS * 24 * 60 * 60 * 1000);
}

async function createProviderBackfillBatch(params: {
  workspaceId: string;
  connectionId: string;
  provider: MeetingTranscriptSourceProvider;
  status: "COMPLETED" | "FAILED";
  error?: string | null;
}) {
  const now = new Date();
  return prisma.meetingTranscriptImportBatch.create({
    data: {
      workspaceId: params.workspaceId,
      connectionId: params.connectionId,
      provider: params.provider,
      sourceKind: "provider_backfill",
      status: params.status,
      startedAt: now,
      finishedAt: now,
      importedCount: 0,
      skippedCount: 0,
      failedCount: params.status === "FAILED" ? 1 : 0,
      error: params.error ?? null,
    },
  });
}

async function finishProviderBackfillConnection(params: {
  connectionId: string;
  error?: string | null;
}) {
  await prisma.meetingTranscriptSourceConnection.update({
    where: { id: params.connectionId },
    data: {
      lastBackfillAt: new Date(),
      lastError: params.error ?? null,
    },
  });
}

function providerErrorMessage(error: unknown, fallback: string) {
  return error instanceof Error && error.message.trim() ? error.message : fallback;
}

function fathomMeetingArtifact(value: unknown): MeetingTranscriptSourceArtifact {
  const meeting = asRecord(value);
  const recordingId = asNumber(meeting.recording_id);
  return {
    json: meeting,
    externalId: recordingId != null ? String(recordingId) : asString(meeting.recording_id) ?? asString(meeting.id),
    title: asString(meeting.title) ?? asString(meeting.meeting_title),
    recordedAt: asDate(meeting.recording_start_time) ?? asDate(meeting.scheduled_start_time) ?? asDate(meeting.created_at),
    sourceUpdatedAt: asDate(meeting.recording_end_time) ?? asDate(meeting.created_at),
    sourceUrl: asString(meeting.share_url) ?? asString(meeting.url),
    meetingUrl: asString(meeting.meeting_url),
    summaryMd: asString(asRecord(meeting.default_summary).markdown_formatted),
    participantEmails: uniqueEmails([
      meeting.calendar_invitees,
      meeting.recorded_by,
      meeting.transcript,
      meeting.action_items,
    ]),
    participants: asArray(meeting.calendar_invitees),
    metadata: {
      provider: "FATHOM",
      providerBackfill: true,
      rawMeeting: meeting,
    },
  };
}

async function fetchFathomBackfillArtifacts(connection: TranscriptSourceConnectionForProviderApi) {
  invariant(connection.apiKeyEnc, 400, "CREDENTIAL_REQUIRED", "Add a Fathom API key before running backfill.");
  const apiKey = decryptSecret(connection.apiKeyEnc);
  const artifacts: MeetingTranscriptSourceArtifact[] = [];
  let cursor: string | null = null;
  for (let page = 0; page < 20 && artifacts.length < PROVIDER_BACKFILL_MAX_ARTIFACTS; page += 1) {
    const url = new URL("https://api.fathom.ai/external/v1/meetings");
    url.searchParams.set("created_after", providerBackfillWindowStart().toISOString());
    url.searchParams.set("include_transcript", "true");
    url.searchParams.set("include_summary", "true");
    url.searchParams.set("include_action_items", "true");
    if (cursor) url.searchParams.set("cursor", cursor);
    const response = await fetch(url, {
      headers: { "X-Api-Key": apiKey },
    });
    const body = await response.json().catch(() => null);
    if (!response.ok) {
      throw new AppError(
        502,
        "PROVIDER_BACKFILL_FAILED",
        asString(asRecord(body).message) ?? asString(asRecord(body).error) ?? "Fathom backfill request failed.",
      );
    }
    const items = asArray(asRecord(body).items);
    artifacts.push(...items.map(fathomMeetingArtifact));
    cursor = asString(asRecord(body).next_cursor);
    if (!cursor || items.length === 0) break;
  }
  return artifacts.slice(0, PROVIDER_BACKFILL_MAX_ARTIFACTS);
}

function firefliesTranscriptArtifact(value: unknown): MeetingTranscriptSourceArtifact {
  const transcript = asRecord(value);
  return {
    json: transcript,
    externalId: asString(transcript.id),
    title: asString(transcript.title),
    recordedAt: asDate(transcript.date),
    sourceUpdatedAt: asDate(transcript.date),
    sourceUrl: asString(transcript.transcript_url),
    meetingUrl: asString(transcript.meeting_link),
    calendarExternalId: asString(transcript.calendar_id) ?? asString(transcript.cal_id),
    summaryMd: asString(asRecord(transcript.summary).overview),
    participantEmails: uniqueEmails([
      transcript.participants,
      transcript.meeting_attendees,
      transcript.user,
    ]),
    participants: asArray(transcript.participants).concat(asArray(transcript.meeting_attendees)),
    metadata: {
      provider: "FIREFLIES",
      providerBackfill: true,
      rawTranscript: transcript,
    },
  };
}

async function fetchFirefliesBackfillArtifacts(connection: TranscriptSourceConnectionForProviderApi) {
  invariant(connection.apiKeyEnc, 400, "CREDENTIAL_REQUIRED", "Add a Fireflies API key before running backfill.");
  const apiKey = decryptSecret(connection.apiKeyEnc);
  const artifacts: MeetingTranscriptSourceArtifact[] = [];
  const limit = 50;
  for (let skip = 0; skip < PROVIDER_BACKFILL_MAX_ARTIFACTS; skip += limit) {
    const response = await fetch("https://api.fireflies.ai/graphql", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify({
        query: `query BackfillTranscripts($fromDate: DateTime!, $limit: Int!, $skip: Int!) {
          transcripts(fromDate: $fromDate, limit: $limit, skip: $skip) {
            id
            title
            date
            transcript_url
            meeting_link
            calendar_id
            cal_id
            participants
            meeting_attendees { displayName email name }
            user { email name }
            sentences { speaker_name text start_time end_time }
            summary { overview action_items }
          }
        }`,
        variables: {
          fromDate: providerBackfillWindowStart().toISOString(),
          limit,
          skip,
        },
      }),
    });
    const body = await response.json().catch(() => null);
    if (!response.ok || asArray(asRecord(body).errors).length > 0) {
      const firstError = asRecord(asArray(asRecord(body).errors)[0]);
      throw new AppError(
        502,
        "PROVIDER_BACKFILL_FAILED",
        asString(firstError.message) ?? asString(asRecord(body).error) ?? "Fireflies backfill request failed.",
      );
    }
    const transcripts = asArray(asRecord(asRecord(body).data).transcripts);
    artifacts.push(...transcripts.map(firefliesTranscriptArtifact));
    if (transcripts.length < limit) break;
  }
  return artifacts.slice(0, PROVIDER_BACKFILL_MAX_ARTIFACTS);
}

export async function runMeetingTranscriptSourceBackfill(actor: AppActor, params: {
  workspaceId: string;
  provider: MeetingTranscriptSourceProvider | string;
}) {
  await requireWorkspaceMembership({ actor, workspaceId: params.workspaceId, allowedRoles: ["ADMIN", "FACILITATOR"] });
  await requireMeetingTranscriptSourcesFeature(params.workspaceId);
  const provider = typeof params.provider === "string" ? normalizeMeetingTranscriptSourceProvider(params.provider) : params.provider;
  const connection = await prisma.meetingTranscriptSourceConnection.findUnique({
    where: { workspaceId_provider: { workspaceId: params.workspaceId, provider } },
  });
  invariant(connection, 404, "NOT_FOUND", "Meeting transcript source is not connected.");
  if (provider !== "FATHOM" && provider !== "FIREFLIES") {
    const error = provider === "READ_AI"
      ? "Read.ai automatic historical import is deferred until the OAuth/API milestone. Upload a Read.ai JSON, TXT, or ZIP export for historical meetings."
      : "Automatic historical backfill is not enabled for this provider yet. Upload the provider export ZIP for first-batch processing.";
    const batch = await createProviderBackfillBatch({
      workspaceId: params.workspaceId,
      connectionId: connection.id,
      provider,
      status: "FAILED",
      error,
    });
    await finishProviderBackfillConnection({ connectionId: connection.id, error });
    return { batch };
  }
  try {
    const artifacts = provider === "FATHOM"
      ? await fetchFathomBackfillArtifacts(connection)
      : await fetchFirefliesBackfillArtifacts(connection);
    if (artifacts.length === 0) {
      const batch = await createProviderBackfillBatch({
        workspaceId: params.workspaceId,
        connectionId: connection.id,
        provider,
        status: "COMPLETED",
      });
      await finishProviderBackfillConnection({ connectionId: connection.id });
      return { batch };
    }
    const result = await importMeetingTranscriptSourceArtifacts(actor, {
      workspaceId: params.workspaceId,
      provider,
      connectionId: connection.id,
      sourceKind: "provider_backfill",
      artifacts,
    });
    const error = result.batch.status === "FAILED" ? result.batch.error : null;
    await finishProviderBackfillConnection({ connectionId: connection.id, error });
    return { batch: result.batch };
  } catch (error) {
    const message = providerErrorMessage(error, "Provider backfill failed.");
    const batch = await createProviderBackfillBatch({
      workspaceId: params.workspaceId,
      connectionId: connection.id,
      provider,
      status: "FAILED",
      error: message,
    });
    await finishProviderBackfillConnection({ connectionId: connection.id, error: message });
    return { batch };
  }
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

function verifyFathomWebhookSignature(params: {
  rawBody: string;
  header: (name: string) => string | null;
  secret: string;
}) {
  const webhookId = params.header("webhook-id")?.trim();
  const webhookTimestamp = params.header("webhook-timestamp")?.trim();
  const webhookSignature = params.header("webhook-signature")?.trim();
  if (!webhookId || !webhookTimestamp || !webhookSignature || !params.secret.trim()) return false;
  const timestamp = Number(webhookTimestamp);
  if (!Number.isFinite(timestamp) || Math.abs(Math.floor(Date.now() / 1000) - timestamp) > 300) return false;
  const secretSuffix = params.secret.trim().startsWith("whsec_")
    ? params.secret.trim().slice("whsec_".length)
    : params.secret.trim();
  const secretBytes = Buffer.from(secretSuffix, "base64");
  if (secretBytes.length === 0) return false;
  const expected = createHmac("sha256", secretBytes)
    .update(`${webhookId}.${webhookTimestamp}.${params.rawBody}`)
    .digest("base64");
  return webhookSignature
    .split(" ")
    .map((signature) => signature.includes(",") ? signature.split(",").at(-1) ?? "" : signature)
    .some((signature) => safeEqual(expected, signature.trim()));
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
  if (provider === "READ_AI") {
    const actual = header("x-read-signature")?.trim().toLowerCase().replace(/^sha256=/, "");
    if (!actual || !params.secret.trim()) return false;
    const keyBytes = Buffer.from(params.secret.trim(), "base64");
    if (keyBytes.length === 0) return false;
    const expected = createHmac("sha256", keyBytes).update(params.rawBody).digest("hex");
    return safeEqual(expected, actual);
  }
  if (provider === "FATHOM") {
    return verifyFathomWebhookSignature({
      rawBody: params.rawBody,
      header,
      secret: params.secret,
    });
  }
  const headerNames = provider === "FIREFLIES"
    ? ["x-fireflies-signature", "x-hub-signature", "x-hub-signature-256", "x-webhook-signature"]
    : ["x-webhook-signature", "x-hub-signature-256"];
  const actual = headerNames.map(header).find(Boolean)?.trim();
  if (!actual || !params.secret.trim()) return false;
  return signatures(params.rawBody, params.secret.trim()).some((expected) => safeEqual(expected, actual));
}

function webhookArtifactFromPayload(provider: MeetingTranscriptSourceProvider, payload: Record<string, unknown>): MeetingTranscriptSourceArtifact {
  if (provider === "READ_AI") {
    const artifact = readAiWebhookArtifactFromPayload(payload);
    invariant(artifact, 202, "WEBHOOK_IGNORED", "Read.ai meeting_start webhook does not include a transcript.");
    return artifact;
  }
  const data = asRecord(payload.data);
  const source = Object.keys(data).length > 0 ? data : payload;
  const transcript = Object.keys(asRecord(payload.transcript)).length > 0
    ? asRecord(payload.transcript)
    : asRecord(source.transcript);
  const recording = Object.keys(asRecord(payload.recording)).length > 0
    ? asRecord(payload.recording)
    : asRecord(source.recording);
  const meeting = Object.keys(asRecord(payload.meeting)).length > 0
    ? asRecord(payload.meeting)
    : asRecord(source.meeting);
  const sourceJson = Object.keys(transcript).length > 0
    ? {
      ...source,
      transcript,
      sentences: source.sentences ?? transcript.sentences,
      segments: source.segments ?? transcript.segments,
    }
    : source;
  return {
    json: sourceJson,
    externalId: asString(source.transcript_id)
      ?? asString(source.transcriptId)
      ?? asString(source.meeting_id)
      ?? asString(source.meetingId)
      ?? asString(transcript.id)
      ?? asString(source.recording_id)
      ?? asString(source.recordingId)
      ?? (asNumber(source.recording_id) != null ? String(asNumber(source.recording_id)) : null)
      ?? asString(recording.id)
      ?? asString(meeting.id)
      ?? asString(source.id),
    title: asString(source.title) ?? asString(recording.title) ?? asString(meeting.title),
    recordedAt: asDate(source.recordedAt)
      ?? asDate(source.recorded_at)
      ?? asDate(source.date)
      ?? asDate(source.started_at)
      ?? asDate(source.recording_start_time)
      ?? asDate(source.scheduled_start_time)
      ?? asDate(source.created_at)
      ?? asDate(source.timestamp)
      ?? asDate(recording.started_at)
      ?? asDate(meeting.start_time),
    sourceUpdatedAt: asDate(source.updatedAt) ?? asDate(source.updated_at) ?? asDate(source.recording_end_time) ?? new Date(),
    sourceUrl: asString(source.url) ?? asString(source.share_url) ?? asString(source.transcript_url),
    meetingUrl: asString(source.meeting_url) ?? asString(source.meeting_link),
    text: asString(source.transcript_text)
      ?? asString(source.text)
      ?? asString(transcript.transcript_text)
      ?? asString(transcript.text)
      ?? asString(transcript.transcript)
      ?? null,
    summaryMd: asString(source.summary) ?? asString(asRecord(source.summary).overview),
    metadata: { provider, webhookPayload: payload },
  };
}

async function fetchProviderTranscriptArtifact(connection: TranscriptSourceConnectionForProviderApi, payloadArtifact: MeetingTranscriptSourceArtifact) {
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
      headers: { "X-Api-Key": apiKey },
    });
    if (response.ok) {
      const body = await response.json() as Record<string, unknown>;
      return {
        ...payloadArtifact,
        json: {
          ...asRecord(payloadArtifact.json),
          ...body,
        },
      };
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
  if (provider !== "FIREFLIES" && provider !== "FATHOM" && provider !== "READ_AI") {
    throw new AppError(400, "UNSUPPORTED_PROVIDER_WEBHOOK", "This provider webhook is not enabled yet.");
  }
  const connection = await prisma.meetingTranscriptSourceConnection.findUnique({
    where: { workspaceId_provider: { workspaceId: params.workspaceId, provider } },
  });
  invariant(connection?.webhookSecretEnc, 404, "NOT_FOUND", "Webhook secret is not configured for this meeting transcript source.");
  const secret = decryptSecret(connection.webhookSecretEnc);
  invariant(verifyMeetingTranscriptWebhookSignature({ provider, rawBody: params.rawBody, headers: params.headers, secret }), 401, "INVALID_SIGNATURE", "Invalid meeting transcript webhook signature.");
  const payload = JSON.parse(params.rawBody) as Record<string, unknown>;
  if (provider === "READ_AI" && asString(payload.trigger) === "meeting_start") {
    await prisma.meetingTranscriptSourceConnection.update({
      where: { id: connection.id },
      data: {
        lastSyncAt: new Date(),
        lastError: null,
      },
    });
    return {
      ignored: true,
      reason: "meeting_start",
      provider,
    };
  }
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
