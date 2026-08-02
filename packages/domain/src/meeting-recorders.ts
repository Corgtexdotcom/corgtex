import { createHash, createHmac, timingSafeEqual } from "node:crypto";
import {
  Prisma,
  type MeetingRecorderProvider,
  type MeetingRecording,
  type MeetingRecordingStatus,
  type OAuthProvider,
} from "@prisma/client";
import { decryptSecret, encryptSecret, env, prisma, randomOpaqueToken } from "@corgtex/shared";
import type { AppActor } from "@corgtex/shared";
import { enterpriseServiceToDb } from "./ai-workspaces";
import { requireWorkspaceMembership } from "./auth";
import { AppError, invariant } from "./errors";
import {
  meetingEndFromDurationMinutes,
  parseMeetingDurationMinutes,
} from "./meeting-durations";
import { intakeMeetingTranscript } from "./meeting-transcript-intake";
import { createScheduledMeeting } from "./meetings";
import {
  extractRecorderMeetingUrlFromText,
  extractSupportedMeetingUrlFromText,
  isMicrosoftTeamsMeetingUrl,
  meetingUrlHash,
  normalizeMeetingUrl,
  normalizeRecorderMeetingUrl,
  TEAMS_FULL_JOIN_LINK_REQUIRED_MESSAGE,
} from "./meeting-urls";
import { ensureWorkspacePermalink, workspaceEntityCanonicalPath } from "./permalinks";

export {
  extractRecorderMeetingUrlFromText,
  extractSupportedMeetingUrlFromText,
  isMicrosoftTeamsMeetingUrl,
  isMicrosoftTeamsRecorderUrl,
  meetingUrlHash,
  normalizeMeetingUrl,
  normalizeRecorderMeetingUrl,
} from "./meeting-urls";

export const MEETING_RECORDERS_FEATURE_FLAG = "MEETING_RECORDERS";

const DEFAULT_BOT_NAME = "Corgtex Recorder";
const DEFAULT_ENTRY_MESSAGE = "Corgtex Recorder is joining to transcribe this meeting for the workspace.";
const DEFAULT_MONTHLY_MINUTE_CAP = 6000;
const AUTO_SCHEDULE_MIN_LEAD_MS = 10 * 60 * 1000;
const STALE_RECORDING_TIMEOUT_MS = 6 * 60 * 60 * 1000;
const MEETING_URL_CHANGED_FAILURE_CODE = "MEETING_URL_CHANGED";
const RECALL_TERMINAL_STATUS_CHECK_GRACE_MS = 30 * 60 * 1000;
const RECALL_TRANSCRIPT_RECOVERY_GRACE_MS = 20 * 60 * 1000;
const RECALL_RECORDING_RETENTION_HOURS = 7 * 24;
const FALLBACK_MEETING_DURATION_MS = 90 * 60 * 1000;
const ACTIVE_RECORDING_STATUSES: MeetingRecordingStatus[] = ["PENDING", "SCHEDULED", "JOINING", "RECORDING"];
const RECOVERABLE_RECALL_RECORDING_STATUSES: MeetingRecordingStatus[] = [...ACTIVE_RECORDING_STATUSES, "COMPLETED"];
const DUPLICATE_RECORDER_FAILURE_CODE = "DUPLICATE_RECORDER";
const RETRYABLE_VENDOR_STATUSES = new Set([408, 409, 425, 429, 500, 502, 503, 504, 507]);
const RECORDER_LOG_COMPONENT = "meeting-recorder";
const RECORDER_CALENDAR_SYNC_LOOKAHEAD_MS = 30 * 24 * 60 * 60 * 1000;
const RECORDER_CALENDAR_SYNC_LOOKBACK_MS = 24 * 60 * 60 * 1000;
const RECORDER_CALENDAR_OAUTH_STATE_TTL_MS = 30 * 60 * 1000;
const RECORDER_PROVIDER_PROOF_MAX_AGE_MS = 30 * 24 * 60 * 60 * 1000;
type DateTimeParts = {
  year: number;
  month: number;
  day: number;
  hour: number;
  minute: number;
  second: number;
  millisecond: number;
};

const WINDOWS_TIME_ZONE_TO_IANA: Record<string, string> = {
  "UTC": "UTC",
  "Coordinated Universal Time": "UTC",
  "Dateline Standard Time": "Etc/GMT+12",
  "UTC-11": "Etc/GMT+11",
  "Aleutian Standard Time": "America/Adak",
  "Hawaiian Standard Time": "Pacific/Honolulu",
  "Marquesas Standard Time": "Pacific/Marquesas",
  "Alaskan Standard Time": "America/Anchorage",
  "UTC-09": "Etc/GMT+9",
  "Pacific Standard Time (Mexico)": "America/Tijuana",
  "UTC-08": "Etc/GMT+8",
  "Pacific Standard Time": "America/Los_Angeles",
  "US Mountain Standard Time": "America/Phoenix",
  "Mountain Standard Time (Mexico)": "America/Chihuahua",
  "Mountain Standard Time": "America/Denver",
  "Central America Standard Time": "America/Guatemala",
  "Central Standard Time": "America/Chicago",
  "Easter Island Standard Time": "Pacific/Easter",
  "Central Standard Time (Mexico)": "America/Mexico_City",
  "Canada Central Standard Time": "America/Regina",
  "SA Pacific Standard Time": "America/Bogota",
  "Eastern Standard Time (Mexico)": "America/Cancun",
  "Eastern Standard Time": "America/New_York",
  "Haiti Standard Time": "America/Port-au-Prince",
  "Cuba Standard Time": "America/Havana",
  "US Eastern Standard Time": "America/Indianapolis",
  "Paraguay Standard Time": "America/Asuncion",
  "Atlantic Standard Time": "America/Halifax",
  "Venezuela Standard Time": "America/Caracas",
  "Central Brazilian Standard Time": "America/Cuiaba",
  "SA Western Standard Time": "America/La_Paz",
  "Pacific SA Standard Time": "America/Santiago",
  "Newfoundland Standard Time": "America/St_Johns",
  "Tocantins Standard Time": "America/Araguaina",
  "E. South America Standard Time": "America/Sao_Paulo",
  "SA Eastern Standard Time": "America/Cayenne",
  "Argentina Standard Time": "America/Argentina/Buenos_Aires",
  "Greenland Standard Time": "America/Godthab",
  "Montevideo Standard Time": "America/Montevideo",
  "Magallanes Standard Time": "America/Punta_Arenas",
  "Saint Pierre Standard Time": "America/Miquelon",
  "Bahia Standard Time": "America/Bahia",
  "UTC-02": "Etc/GMT+2",
  "Mid-Atlantic Standard Time": "Etc/GMT+2",
  "Azores Standard Time": "Atlantic/Azores",
  "Cape Verde Standard Time": "Atlantic/Cape_Verde",
  "GMT Standard Time": "Europe/London",
  "Greenwich Standard Time": "Atlantic/Reykjavik",
  "Sao Tome Standard Time": "Africa/Sao_Tome",
  "Morocco Standard Time": "Africa/Casablanca",
  "W. Europe Standard Time": "Europe/Berlin",
  "Central Europe Standard Time": "Europe/Budapest",
  "Romance Standard Time": "Europe/Madrid",
  "Central European Standard Time": "Europe/Warsaw",
  "W. Central Africa Standard Time": "Africa/Lagos",
  "Jordan Standard Time": "Asia/Amman",
  "GTB Standard Time": "Europe/Bucharest",
  "Middle East Standard Time": "Asia/Beirut",
  "Egypt Standard Time": "Africa/Cairo",
  "E. Europe Standard Time": "Europe/Chisinau",
  "Syria Standard Time": "Asia/Damascus",
  "West Bank Standard Time": "Asia/Hebron",
  "South Africa Standard Time": "Africa/Johannesburg",
  "FLE Standard Time": "Europe/Kyiv",
  "Israel Standard Time": "Asia/Jerusalem",
  "Kaliningrad Standard Time": "Europe/Kaliningrad",
  "Sudan Standard Time": "Africa/Khartoum",
  "Libya Standard Time": "Africa/Tripoli",
  "Namibia Standard Time": "Africa/Windhoek",
  "Arabic Standard Time": "Asia/Baghdad",
  "Turkey Standard Time": "Europe/Istanbul",
  "Arab Standard Time": "Asia/Riyadh",
  "Belarus Standard Time": "Europe/Minsk",
  "Russian Standard Time": "Europe/Moscow",
  "E. Africa Standard Time": "Africa/Nairobi",
  "Iran Standard Time": "Asia/Tehran",
  "Arabian Standard Time": "Asia/Dubai",
  "Astrakhan Standard Time": "Europe/Astrakhan",
  "Azerbaijan Standard Time": "Asia/Baku",
  "Russia Time Zone 3": "Europe/Samara",
  "Mauritius Standard Time": "Indian/Mauritius",
  "Saratov Standard Time": "Europe/Saratov",
  "Georgian Standard Time": "Asia/Tbilisi",
  "Volgograd Standard Time": "Europe/Volgograd",
  "Caucasus Standard Time": "Asia/Yerevan",
  "Afghanistan Standard Time": "Asia/Kabul",
  "West Asia Standard Time": "Asia/Tashkent",
  "Ekaterinburg Standard Time": "Asia/Yekaterinburg",
  "Pakistan Standard Time": "Asia/Karachi",
  "Qyzylorda Standard Time": "Asia/Qyzylorda",
  "India Standard Time": "Asia/Kolkata",
  "Sri Lanka Standard Time": "Asia/Colombo",
  "Nepal Standard Time": "Asia/Kathmandu",
  "Central Asia Standard Time": "Asia/Almaty",
  "Bangladesh Standard Time": "Asia/Dhaka",
  "Omsk Standard Time": "Asia/Omsk",
  "Myanmar Standard Time": "Asia/Yangon",
  "SE Asia Standard Time": "Asia/Bangkok",
  "Altai Standard Time": "Asia/Barnaul",
  "W. Mongolia Standard Time": "Asia/Hovd",
  "North Asia Standard Time": "Asia/Krasnoyarsk",
  "N. Central Asia Standard Time": "Asia/Novosibirsk",
  "Tomsk Standard Time": "Asia/Tomsk",
  "China Standard Time": "Asia/Shanghai",
  "North Asia East Standard Time": "Asia/Irkutsk",
  "Singapore Standard Time": "Asia/Singapore",
  "W. Australia Standard Time": "Australia/Perth",
  "Taipei Standard Time": "Asia/Taipei",
  "Ulaanbaatar Standard Time": "Asia/Ulaanbaatar",
  "Aus Central W. Standard Time": "Australia/Eucla",
  "Transbaikal Standard Time": "Asia/Chita",
  "Tokyo Standard Time": "Asia/Tokyo",
  "North Korea Standard Time": "Asia/Pyongyang",
  "Korea Standard Time": "Asia/Seoul",
  "Yakutsk Standard Time": "Asia/Yakutsk",
  "Cen. Australia Standard Time": "Australia/Adelaide",
  "AUS Central Standard Time": "Australia/Darwin",
  "E. Australia Standard Time": "Australia/Brisbane",
  "AUS Eastern Standard Time": "Australia/Sydney",
  "West Pacific Standard Time": "Pacific/Port_Moresby",
  "Tasmania Standard Time": "Australia/Hobart",
  "Vladivostok Standard Time": "Asia/Vladivostok",
  "Lord Howe Standard Time": "Australia/Lord_Howe",
  "Bougainville Standard Time": "Pacific/Bougainville",
  "Russia Time Zone 10": "Asia/Srednekolymsk",
  "Magadan Standard Time": "Asia/Magadan",
  "Norfolk Standard Time": "Pacific/Norfolk",
  "Sakhalin Standard Time": "Asia/Sakhalin",
  "Central Pacific Standard Time": "Pacific/Guadalcanal",
  "Russia Time Zone 11": "Asia/Kamchatka",
  "New Zealand Standard Time": "Pacific/Auckland",
  "UTC+12": "Etc/GMT-12",
  "Fiji Standard Time": "Pacific/Fiji",
  "Kamchatka Standard Time": "Asia/Kamchatka",
  "Chatham Islands Standard Time": "Pacific/Chatham",
  "UTC+13": "Etc/GMT-13",
  "Tonga Standard Time": "Pacific/Tongatapu",
  "Samoa Standard Time": "Pacific/Apia",
  "Line Islands Standard Time": "Pacific/Kiritimati",
};

export type MeetingRecorderScheduleInput = {
  meetingUrl: string;
  joinAt: Date;
  joinMode?: "immediate" | "scheduled";
  botName: string;
  entryMessage?: string | null;
  metadata: Record<string, string>;
};

export type ProviderWebhookEvent = {
  eventId: string | null;
  eventType: string;
  externalBotId: string | null;
  recordingId: string | null;
  workspaceId: string | null;
  meetingId: string | null;
  status: MeetingRecordingStatus | null;
  failureCode: string | null;
  failureMessage: string | null;
  transcriptId: string | null;
  transcriptUrl: string | null;
  recordingIdForTranscript: string | null;
  startedAt: Date | null;
  endedAt: Date | null;
  durationSeconds: number | null;
};

export type CalendarEventForRecorder = {
  id: string;
  provider: OAuthProvider;
  title: string;
  description: string | null;
  startTime: Date;
  endTime: Date;
  attendees: string[];
  organizerEmail: string | null;
  meetingUrl: string | null;
  htmlLink: string | null;
  status: string | null;
  visibility: string | null;
  transparency: string | null;
  responseStatus: string | null;
};

type SafeRecorderCalendarSource = {
  id: string;
  workspaceId: string;
  provider: OAuthProvider;
  providerAccountId: string;
  providerAccountEmail: string | null;
  displayName: string | null;
  expiresAt: Date | null;
  scopes: string[];
  status: "ACTIVE" | "DISABLED" | "ERROR";
  lastSyncStartedAt: Date | null;
  lastSyncCompletedAt: Date | null;
  lastSyncAt: Date | null;
  lastSyncJobId: string | null;
  lastSyncError: string | null;
  lastDryRunAt: Date | null;
  lastUpcomingEventCount: number;
  lastSchedulableEventCount: number;
  createdAt: Date;
  updatedAt: Date;
};

export type RecorderReadinessCheck = {
  key: string;
  label: string;
  ok: boolean;
  detail: string;
};

type ScheduleAttemptResult = {
  externalBotId: string;
  providerMetadata?: Prisma.InputJsonValue;
};

type RecordingCancelContext = {
  joinAt?: Date | null;
  status?: MeetingRecordingStatus | null;
};

type ProviderFetchOptions = {
  okStatuses?: number[];
};

class ProviderRequestError extends Error {
  readonly status: number;
  readonly responseBody: string;

  constructor(provider: MeetingRecorderProvider, status: number, responseBody: string) {
    super(`${provider} returned ${status}: ${responseBody.slice(0, 240)}`);
    this.status = status;
    this.responseBody = responseBody;
  }
}

type RecorderLogLevel = "info" | "warn" | "error";

function recorderLog(level: RecorderLogLevel, event: string, fields: Record<string, unknown> = {}) {
  const payload = {
    component: RECORDER_LOG_COMPONENT,
    event,
    ...fields,
  };
  const message = JSON.stringify(payload);
  if (level === "error") {
    console.error(message);
  } else if (level === "warn") {
    console.warn(message);
  } else {
    console.info(message);
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function readString(value: unknown) {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : null;
}

function readNumber(value: unknown) {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function readDate(value: unknown) {
  const raw = readString(value);
  if (!raw) return null;
  const parsed = new Date(raw);
  return Number.isNaN(parsed.valueOf()) ? null : parsed;
}

function normalizeEmail(value: string) {
  return value.trim().toLowerCase();
}

function normalizeEmails(values?: string[] | null) {
  return [...new Set((values ?? []).map(normalizeEmail).filter(Boolean))];
}

function firstRecord(...values: unknown[]) {
  return values.find(isRecord) as Record<string, unknown> | undefined;
}

function jsonValue(value: unknown): Prisma.InputJsonValue {
  return JSON.parse(JSON.stringify(value ?? null)) as Prisma.InputJsonValue;
}

function base64UrlJson(value: Record<string, unknown>) {
  return Buffer.from(JSON.stringify(value)).toString("base64url");
}

function signStatePayload(payload: string) {
  return createHmac("sha256", env.SESSION_COOKIE_SECRET).update(payload).digest("base64url");
}

export function createRecorderCalendarOAuthState(params: { deploymentId: string; actorUserId: string }) {
  const payload = base64UrlJson({
    deploymentId: params.deploymentId,
    actorUserId: params.actorUserId,
    nonce: randomOpaqueToken(18),
    issuedAt: Date.now(),
  });
  return `${payload}.${signStatePayload(payload)}`;
}

export function readRecorderCalendarOAuthState(state: string, now = Date.now()) {
  const parts = state.split(".");
  if (parts.length !== 2) {
    return null;
  }
  const [payload, signature] = parts;
  if (!payload || !signature || !safeEqualString(signature, signStatePayload(payload))) {
    return null;
  }
  try {
    const parsed = JSON.parse(Buffer.from(payload, "base64url").toString("utf8")) as unknown;
    if (!isRecord(parsed)) return null;
    const deploymentId = readString(parsed.deploymentId);
    const actorUserId = readString(parsed.actorUserId);
    const nonce = readString(parsed.nonce);
    const issuedAt = readNumber(parsed.issuedAt);
    if (!deploymentId || !actorUserId || !nonce || !issuedAt) return null;
    if (now - issuedAt > RECORDER_CALENDAR_OAUTH_STATE_TTL_MS) return null;
    return { deploymentId, actorUserId, nonce, issuedAt };
  } catch {
    return null;
  }
}

export function redactProviderArtifactUrls(value: unknown): Prisma.InputJsonValue {
  if (typeof value === "string") {
    return /^https?:\/\//i.test(value) ? "[redacted-url]" : value;
  }
  if (Array.isArray(value)) {
    return value.map((item) => redactProviderArtifactUrls(item)) as Prisma.InputJsonArray;
  }
  if (isRecord(value)) {
    const next: Record<string, Prisma.InputJsonValue> = {};
    for (const [key, item] of Object.entries(value)) {
      const keyLooksLikeArtifact = /(download|artifact|video|audio|transcription|diarization|url)$/i.test(key);
      next[key] = keyLooksLikeArtifact && typeof item === "string"
        ? "[redacted-url]"
        : redactProviderArtifactUrls(item);
    }
    return next;
  }
  if (value === undefined) return null as unknown as Prisma.InputJsonValue;
  return value as Prisma.InputJsonValue;
}

function headerValue(headers: Headers | Record<string, string>, name: string) {
  if (headers instanceof Headers) {
    return headers.get(name);
  }
  const lower = name.toLowerCase();
  return Object.entries(headers).find(([key]) => key.toLowerCase() === lower)?.[1] ?? null;
}

function safeEqualString(left: string, right: string) {
  const leftBuffer = Buffer.from(left);
  const rightBuffer = Buffer.from(right);
  return leftBuffer.length === rightBuffer.length && timingSafeEqual(leftBuffer, rightBuffer);
}

export function verifySvixLikeSignature(params: {
  secret: string;
  headers: Headers | Record<string, string>;
  payload: string;
}) {
  const msgId = headerValue(params.headers, "webhook-id") ?? headerValue(params.headers, "svix-id");
  const timestamp = headerValue(params.headers, "webhook-timestamp") ?? headerValue(params.headers, "svix-timestamp");
  const signatureHeader = headerValue(params.headers, "webhook-signature") ?? headerValue(params.headers, "svix-signature");
  if (!msgId || !timestamp || !signatureHeader) {
    return false;
  }

  const secretValue = params.secret.startsWith("whsec_") ? params.secret.slice("whsec_".length) : params.secret;
  const key = params.secret.startsWith("whsec_") ? Buffer.from(secretValue, "base64") : Buffer.from(secretValue);
  const expected = createHmac("sha256", key)
    .update(`${msgId}.${timestamp}.${params.payload}`)
    .digest("base64");

  return signatureHeader.split(" ").some((entry) => {
    const [version, signature] = entry.split(",");
    return version === "v1" && Boolean(signature) && safeEqualString(signature, expected);
  });
}

export function verifyRecallWebhookSignature(params: { headers: Headers | Record<string, string>; payload: string }) {
  if (!env.RECALL_WEBHOOK_SECRET) {
    throw new AppError(503, "RECORDER_WEBHOOK_SECRET_MISSING", "Recall webhook verification is not configured.");
  }
  return verifySvixLikeSignature({
    secret: env.RECALL_WEBHOOK_SECRET,
    headers: params.headers,
    payload: params.payload,
  });
}

export function verifyMeetingBaasWebhookSignature(params: { headers: Headers | Record<string, string>; payload: string }) {
  if (!env.MEETING_BAAS_WEBHOOK_SECRET) {
    throw new AppError(503, "RECORDER_WEBHOOK_SECRET_MISSING", "Meeting BaaS webhook verification is not configured.");
  }
  const callbackSecret = headerValue(params.headers, "x-mb-secret");
  if (callbackSecret && safeEqualString(callbackSecret, env.MEETING_BAAS_WEBHOOK_SECRET)) {
    return true;
  }
  return verifySvixLikeSignature({
    secret: env.MEETING_BAAS_WEBHOOK_SECRET,
    headers: params.headers,
    payload: params.payload,
  });
}

function requireVendorSecret(provider: MeetingRecorderProvider) {
  const value = provider === "RECALL_AI" ? env.RECALL_API_KEY : env.MEETING_BAAS_API_KEY;
  if (!value) {
    throw new AppError(503, "RECORDER_VENDOR_NOT_CONFIGURED", `${provider} API key is not configured.`);
  }
  return value;
}

function recallAuthorization(apiKey: string) {
  return /^(Token|Bearer)\s+/i.test(apiKey) ? apiKey : `Token ${apiKey}`;
}

export function buildRecallCreateBotRequest(input: MeetingRecorderScheduleInput, apiKey = "test-key", region = env.RECALL_REGION) {
  const body: Record<string, unknown> = {
    meeting_url: input.meetingUrl,
    bot_name: input.botName,
    recording_config: {
      retention: {
        type: "timed",
        hours: RECALL_RECORDING_RETENTION_HOURS,
      },
      transcript: {
        provider: {
          recallai_streaming: {
            mode: "prioritize_accuracy",
            language_code: "auto",
          },
        },
      },
    },
    metadata: input.metadata,
  };
  if (input.joinMode !== "immediate") {
    body.join_at = input.joinAt.toISOString();
  }
  if (input.entryMessage?.trim()) {
    body.chat = {
      on_bot_join: {
        send_to: "everyone",
        message: input.entryMessage.trim(),
        pin: true,
      },
    };
  }

  return {
    url: `https://${region}.recall.ai/api/v1/bot/`,
    init: {
      method: "POST",
      headers: {
        Authorization: recallAuthorization(apiKey),
        accept: "application/json",
        "content-type": "application/json",
      },
      body: JSON.stringify(body),
    },
    body,
  };
}

export function buildMeetingBaasCreateBotRequest(input: MeetingRecorderScheduleInput, apiKey = "test-key") {
  const body: Record<string, unknown> = {
    meeting_url: input.meetingUrl,
    bot_name: input.botName,
    recording_mode: "speaker_view",
    transcription_enabled: true,
    transcription_config: {
      provider: "gladia",
    },
    allow_multiple_bots: false,
    extra: input.metadata,
  };
  if (input.joinMode !== "immediate") {
    body.join_at = input.joinAt.toISOString();
  }
  if (input.entryMessage?.trim()) {
    body.entry_message = input.entryMessage.trim();
  }
  if (env.MEETING_RECORDER_PUBLIC_BASE_URL && env.MEETING_BAAS_WEBHOOK_SECRET) {
    body.callback_enabled = true;
    body.callback_config = {
      url: `${env.MEETING_RECORDER_PUBLIC_BASE_URL.replace(/\/$/, "")}/api/integrations/meeting-recorders/baas/webhook`,
      method: "POST",
      secret: env.MEETING_BAAS_WEBHOOK_SECRET,
    };
  }

  return {
    url: input.joinMode === "immediate"
      ? "https://api.meetingbaas.com/v2/bots"
      : "https://api.meetingbaas.com/v2/bots/scheduled",
    init: {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-meeting-baas-api-key": apiKey,
      },
      body: JSON.stringify(body),
    },
    body,
  };
}

async function fetchJson(url: string, init: RequestInit, options: ProviderFetchOptions = {}) {
  const response = await fetch(url, init);
  const text = await response.text();
  if (!response.ok && !options.okStatuses?.includes(response.status)) {
    throw new ProviderRequestError(url.includes("meetingbaas") ? "MEETING_BAAS" : "RECALL_AI", response.status, text);
  }
  if (!response.ok) {
    return null;
  }
  return text ? JSON.parse(text) as unknown : null;
}

function extractBotId(provider: MeetingRecorderProvider, response: unknown) {
  if (!isRecord(response)) {
    throw new AppError(502, "RECORDER_VENDOR_BAD_RESPONSE", `${provider} returned an invalid response.`);
  }
  const data = isRecord(response.data) ? response.data : response;
  const id = readString(data.id) ?? readString(data.bot_id);
  if (!id) {
    throw new AppError(502, "RECORDER_VENDOR_BAD_RESPONSE", `${provider} response did not include a bot id.`);
  }
  return id;
}

async function scheduleRecallBot(input: MeetingRecorderScheduleInput): Promise<ScheduleAttemptResult> {
  const request = buildRecallCreateBotRequest(input, requireVendorSecret("RECALL_AI"));
  const response = await fetchJson(request.url, request.init);
  return {
    externalBotId: extractBotId("RECALL_AI", response),
    providerMetadata: redactProviderArtifactUrls(response),
  };
}

async function scheduleMeetingBaasBot(input: MeetingRecorderScheduleInput): Promise<ScheduleAttemptResult> {
  const request = buildMeetingBaasCreateBotRequest(input, requireVendorSecret("MEETING_BAAS"));
  const response = await fetchJson(request.url, request.init);
  return {
    externalBotId: extractBotId("MEETING_BAAS", response),
    providerMetadata: redactProviderArtifactUrls(response),
  };
}

function shouldDeleteScheduledRecallBot(context?: RecordingCancelContext) {
  if (context?.status === "JOINING" || context?.status === "RECORDING") {
    return false;
  }
  const joinAtMs = context?.joinAt?.getTime();
  if (joinAtMs && joinAtMs - Date.now() <= AUTO_SCHEDULE_MIN_LEAD_MS) {
    return false;
  }
  return true;
}

function recallDeleteCanFallBackToLeave(error: unknown) {
  return error instanceof ProviderRequestError && [400, 405, 409, 425].includes(error.status);
}

async function deleteScheduledRecallBot(externalBotId: string) {
  const apiKey = requireVendorSecret("RECALL_AI");
  await fetchJson(`https://${env.RECALL_REGION}.recall.ai/api/v1/bot/${externalBotId}/`, {
    method: "DELETE",
    headers: {
      Authorization: recallAuthorization(apiKey),
      accept: "application/json",
    },
  }, { okStatuses: [404] });
}

async function leaveRecallBot(externalBotId: string) {
  const apiKey = requireVendorSecret("RECALL_AI");
  await fetchJson(`https://${env.RECALL_REGION}.recall.ai/api/v1/bot/${externalBotId}/leave_call/`, {
    method: "POST",
    headers: {
      Authorization: recallAuthorization(apiKey),
      accept: "application/json",
      "content-type": "application/json",
    },
  }, { okStatuses: [404] });
}

async function cancelRecallBot(externalBotId: string, context?: RecordingCancelContext) {
  if (shouldDeleteScheduledRecallBot(context)) {
    try {
      await deleteScheduledRecallBot(externalBotId);
      return;
    } catch (error) {
      if (!recallDeleteCanFallBackToLeave(error)) {
        throw error;
      }
      recorderLog("warn", "recall_delete_fell_back_to_leave", {
        externalBotId,
        failureCode: providerFailureCode(error),
      });
    }
  }
  await leaveRecallBot(externalBotId);
}

async function cancelMeetingBaasBot(externalBotId: string) {
  const apiKey = requireVendorSecret("MEETING_BAAS");
  await fetchJson(`https://api.meetingbaas.com/v2/bots/${externalBotId}`, {
    method: "DELETE",
    headers: {
      "x-meeting-baas-api-key": apiKey,
    },
  }, { okStatuses: [404] });
}

async function createRecallAsyncTranscript(recordingId: string) {
  const apiKey = requireVendorSecret("RECALL_AI");
  await fetchJson(`https://${env.RECALL_REGION}.recall.ai/api/v1/recording/${recordingId}/create_transcript/`, {
    method: "POST",
    headers: {
      Authorization: recallAuthorization(apiKey),
      accept: "application/json",
      "content-type": "application/json",
    },
    body: JSON.stringify({
      provider: {
        recallai_async: {
          language_code: "auto",
        },
      },
    }),
  });
}

function recallSignedDownloadUrl(url: string) {
  try {
    const parsed = new URL(url);
    return parsed.searchParams.has("X-Amz-Algorithm") || parsed.searchParams.has("Signature");
  } catch {
    return false;
  }
}

function recallRecordingTimestamp(recording: Record<string, unknown>) {
  const dates = [
    readDate(recording.completed_at),
    readDate(recording.completedAt),
    readDate(recording.ended_at),
    readDate(recording.endedAt),
    readDate(recording.started_at),
    readDate(recording.startedAt),
    readDate(recording.created_at),
    readDate(recording.createdAt),
  ].filter((date): date is Date => Boolean(date));
  return dates.length > 0 ? Math.max(...dates.map((date) => date.getTime())) : null;
}

function recallRecordingCompletionRank(recording: Record<string, unknown>) {
  const status = readString(recording.status)?.toLowerCase();
  return status === "done" || status === "completed" || status === "complete" ? 1 : 0;
}

function recallBotTranscriptDownloadUrls(bot: unknown) {
  const data = isRecord(bot) && isRecord(bot.data) ? bot.data : bot;
  const recordings = isRecord(data) && Array.isArray(data.recordings) ? data.recordings : [];
  const candidates: Array<{ downloadUrl: string; completionRank: number; timestamp: number; index: number }> = [];
  for (const [index, item] of recordings.entries()) {
    const recording = isRecord(item) ? item : {};
    const mediaShortcuts = firstRecord(recording.media_shortcuts, recording.mediaShortcuts);
    const transcript = firstRecord(mediaShortcuts?.transcript);
    const transcriptData = firstRecord(transcript?.data);
    const downloadUrl = readString(transcriptData?.download_url) ?? readString(transcriptData?.downloadUrl);
    if (!downloadUrl) {
      continue;
    }
    const completionRank = recallRecordingCompletionRank(recording);
    const timestamp = recallRecordingTimestamp(recording) ?? Number.NEGATIVE_INFINITY;
    candidates.push({ downloadUrl, completionRank, timestamp, index });
  }
  const bestCompletionRank = Math.max(...candidates.map((candidate) => candidate.completionRank), 0);
  return candidates
    .filter((candidate) => bestCompletionRank === 0 || candidate.completionRank === bestCompletionRank)
    .sort((left, right) => {
      if (left.timestamp !== right.timestamp) return left.timestamp - right.timestamp;
      return left.index - right.index;
    })
    .map((candidate) => candidate.downloadUrl);
}

function combineRecallTranscriptPayloads(payloads: unknown[]) {
  if (payloads.length <= 1) {
    return payloads[0] ?? [];
  }
  if (payloads.every((payload) => typeof payload === "string")) {
    return payloads.map((payload) => String(payload).trim()).filter(Boolean).join("\n\n");
  }
  return payloads.flatMap((payload) => {
    if (Array.isArray(payload)) return payload;
    if (isRecord(payload) && Array.isArray(payload.segments)) return payload.segments;
    if (isRecord(payload) && Array.isArray(payload.transcript)) return payload.transcript;
    if (isRecord(payload) && Array.isArray(payload.words)) return [{ words: payload.words }];
    return [payload];
  });
}

async function fetchRecallTranscriptDownload(downloadUrl: string, apiKey: string) {
  const transcriptPayload = await fetchJson(downloadUrl, {
    headers: recallSignedDownloadUrl(downloadUrl)
      ? { accept: "application/json" }
      : {
          Authorization: recallAuthorization(apiKey),
          accept: "application/json",
        },
  });
  return transcriptPayload;
}

async function fetchRecallTranscriptArtifact(params: { transcriptId?: string | null; transcriptUrl?: string | null; externalBotId?: string | null }) {
  const apiKey = requireVendorSecret("RECALL_AI");
  let downloadUrl = params.transcriptUrl ?? null;
  let metadata: unknown = null;

  if (!downloadUrl && params.transcriptId) {
    metadata = await fetchJson(`https://${env.RECALL_REGION}.recall.ai/api/v1/transcript/${params.transcriptId}/`, {
      headers: {
        Authorization: recallAuthorization(apiKey),
        accept: "application/json",
      },
    });
    downloadUrl = readString(isRecord(metadata) && isRecord(metadata.data) ? metadata.data.download_url : null);
  }

  if (!downloadUrl && params.externalBotId) {
    try {
      metadata = await fetchRecallBot(params.externalBotId);
      const downloadUrls = recallBotTranscriptDownloadUrls(metadata);
      if (downloadUrls.length > 0) {
        const transcriptPayloads = await Promise.all(downloadUrls.map((url) => fetchRecallTranscriptDownload(url, apiKey)));
        return { transcriptPayload: combineRecallTranscriptPayloads(transcriptPayloads), metadata };
      }
    } catch (error) {
      recorderLog("warn", "recall_bot_metadata_fetch_failed", {
        externalBotId: params.externalBotId,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  if (!downloadUrl && params.externalBotId) {
    const transcriptPayload = await fetchJson(`https://${env.RECALL_REGION}.recall.ai/api/v1/bot/${params.externalBotId}/transcript/`, {
      headers: {
        Authorization: recallAuthorization(apiKey),
        accept: "application/json",
      },
    });
    return {
      transcriptPayload,
      metadata: {
        source: "bot_transcript_endpoint",
        externalBotId: params.externalBotId,
      },
    };
  }

  invariant(downloadUrl, 404, "RECORDER_TRANSCRIPT_NOT_READY", "Recall transcript is not ready.");
  const transcriptPayload = await fetchRecallTranscriptDownload(downloadUrl, apiKey);
  return { transcriptPayload, metadata };
}

async function fetchRecallBot(externalBotId: string) {
  const apiKey = requireVendorSecret("RECALL_AI");
  return fetchJson(`https://${env.RECALL_REGION}.recall.ai/api/v1/bot/${externalBotId}/`, {
    headers: {
      Authorization: recallAuthorization(apiKey),
      accept: "application/json",
    },
  });
}

async function fetchMeetingBaasTranscriptArtifact(externalBotId: string, transcriptUrl?: string | null) {
  const apiKey = requireVendorSecret("MEETING_BAAS");
  let downloadUrl = transcriptUrl ?? null;
  let metadata: unknown = null;
  if (!downloadUrl) {
    metadata = await fetchJson(`https://api.meetingbaas.com/v2/bots/${externalBotId}`, {
      headers: {
        "x-meeting-baas-api-key": apiKey,
      },
    });
    const data = isRecord(metadata) && isRecord(metadata.data) ? metadata.data : metadata;
    downloadUrl = readString(isRecord(data) ? data.transcription : null);
  }
  invariant(downloadUrl, 404, "RECORDER_TRANSCRIPT_NOT_READY", "Meeting BaaS transcript is not ready.");
  const transcriptPayload = await fetchJson(downloadUrl, {
    headers: {
      accept: "application/json",
    },
  });
  return { transcriptPayload, metadata };
}

function providerSchedule(provider: MeetingRecorderProvider, input: MeetingRecorderScheduleInput) {
  return provider === "RECALL_AI" ? scheduleRecallBot(input) : scheduleMeetingBaasBot(input);
}

async function providerCancel(provider: MeetingRecorderProvider, externalBotId: string, context?: RecordingCancelContext) {
  if (provider === "RECALL_AI") {
    await cancelRecallBot(externalBotId, context);
    return;
  }
  await cancelMeetingBaasBot(externalBotId);
}

function isRetryableVendorError(error: unknown) {
  return error instanceof ProviderRequestError && RETRYABLE_VENDOR_STATUSES.has(error.status);
}

function providerFailureCode(error: unknown) {
  if (error instanceof ProviderRequestError) {
    if (error.status === 408 || error.status === 425) return "vendor_retry_later";
    if (error.status === 409) return "vendor_conflict";
    if (error.status === 429) return "vendor_rate_limited";
    if (error.status === 507) return "vendor_capacity_exceeded";
    if ([500, 502, 503, 504].includes(error.status)) return "vendor_server_error";
    return "vendor_http_error";
  }
  if (error instanceof AppError) {
    if (error.code === "RECORDER_VENDOR_NOT_CONFIGURED") return "configuration_error";
    if (error.code === "RECORDER_VENDOR_BAD_RESPONSE") return "vendor_bad_response";
    return error.code.toLowerCase();
  }
  return "schedule_failed";
}

function isUniqueConstraintError(error: unknown) {
  return isRecord(error) && error.code === "P2002";
}

function activeRecordingDedupeKey(params: { workspaceId: string; meetingId: string; provider: MeetingRecorderProvider }) {
  return `meeting-recording:${params.workspaceId}:${params.meetingId}:${params.provider}`;
}

function ownedActiveRecordingDedupeKey(recording: Pick<MeetingRecording, "workspaceId" | "meetingId" | "provider" | "status" | "activeDedupeKey">) {
  const activeDedupeKey = activeRecordingDedupeKey(recording);
  return ACTIVE_RECORDING_STATUSES.includes(recording.status) && recording.activeDedupeKey === activeDedupeKey
    ? activeDedupeKey
    : null;
}

type RecordingWithMeetingTime = MeetingRecording & {
  meeting: {
    recordedAt: Date;
    scheduledEndAt: Date | null;
  };
};

type DuplicateRecorderCleanupStats = {
  duplicateRecordersSkipped: number;
  duplicateProviderBotsCancelled: number;
  canonicalRecordingsRestored: number;
  duplicateCancellationFailures: number;
};

function duplicateRecorderFailureMessage(canonicalId: string) {
  return `Duplicate recorder skipped; canonical recording ${canonicalId} retained.`;
}

function recorderJoinInstant(recording: Pick<MeetingRecording, "joinAt"> & { meeting?: { recordedAt: Date } }) {
  return recording.joinAt ?? recording.meeting?.recordedAt ?? null;
}

function duplicateRecorderGroupKey(recording: Pick<MeetingRecording, "workspaceId" | "meetingId" | "provider" | "joinAt"> & {
  meeting?: { recordedAt: Date };
}) {
  const joinAt = recorderJoinInstant(recording);
  if (!joinAt) return null;
  return `${recording.workspaceId}:${recording.meetingId}:${recording.provider}:${joinAt.toISOString()}`;
}

function recordingExpectedEnd(recording: RecordingWithMeetingTime) {
  const durationMs = recording.meeting.scheduledEndAt && recording.meeting.scheduledEndAt > recording.meeting.recordedAt
    ? recording.meeting.scheduledEndAt.getTime() - recording.meeting.recordedAt.getTime()
    : FALLBACK_MEETING_DURATION_MS;
  const startAt = recording.joinAt ?? recording.meeting.recordedAt;
  return new Date(startAt.getTime() + durationMs);
}

function recorderJoinMode(joinAt: Date, now = Date.now()): "immediate" | "scheduled" {
  return joinAt.getTime() - now <= AUTO_SCHEDULE_MIN_LEAD_MS ? "immediate" : "scheduled";
}

function staleRecordingReadyAt(recording: RecordingWithMeetingTime) {
  if (!recording.externalBotId) {
    return new Date(recording.createdAt.getTime() + STALE_RECORDING_TIMEOUT_MS);
  }
  return new Date(recordingExpectedEnd(recording).getTime() + STALE_RECORDING_TIMEOUT_MS);
}

function compareCanonicalRecordings(left: MeetingRecording, right: MeetingRecording) {
  const leftActive = ACTIVE_RECORDING_STATUSES.includes(left.status) ? 1 : 0;
  const rightActive = ACTIVE_RECORDING_STATUSES.includes(right.status) ? 1 : 0;
  if (leftActive !== rightActive) return rightActive - leftActive;

  const leftScheduledAt = left.scheduledAt?.getTime() ?? Number.NEGATIVE_INFINITY;
  const rightScheduledAt = right.scheduledAt?.getTime() ?? Number.NEGATIVE_INFINITY;
  if (leftScheduledAt !== rightScheduledAt) return rightScheduledAt - leftScheduledAt;

  return right.createdAt.getTime() - left.createdAt.getTime();
}

function canonicalRecordingForGroup<T extends MeetingRecording>(recordings: T[]) {
  return [...recordings].sort(compareCanonicalRecordings)[0] ?? null;
}

async function markDuplicateRecordingSkipped(recording: MeetingRecording, canonicalId: string) {
  return prisma.meetingRecording.update({
    where: { id: recording.id },
    data: {
      status: "SKIPPED",
      activeDedupeKey: null,
      endedAt: new Date(),
      failureCode: DUPLICATE_RECORDER_FAILURE_CODE,
      failureMessage: duplicateRecorderFailureMessage(canonicalId),
    },
  });
}

function restoredCanonicalStatus(recording: MeetingRecording) {
  return ACTIVE_RECORDING_STATUSES.includes(recording.status) ? recording.status : "SCHEDULED";
}

async function restoreCanonicalScheduledRecording(recording: MeetingRecording) {
  const activeDedupeKey = activeRecordingDedupeKey({
    workspaceId: recording.workspaceId,
    meetingId: recording.meetingId,
    provider: recording.provider,
  });
  return prisma.meetingRecording.update({
    where: { id: recording.id },
    data: {
      status: restoredCanonicalStatus(recording),
      activeDedupeKey,
      endedAt: null,
      failureCode: null,
      failureMessage: null,
    },
  });
}

type DuplicateRecorderCleanupScope = {
  meetingId?: string;
  provider?: MeetingRecorderProvider;
  joinAt?: Date;
  meetingUrl?: string;
};

function duplicateGroupRestoreRank(group: RecordingWithMeetingTime[]) {
  const canonical = canonicalRecordingForGroup(group);
  if (!canonical) {
    return { matchesMeetingTime: 0, active: 0, joinAtMs: Number.NEGATIVE_INFINITY, canonical };
  }
  const joinAt = recorderJoinInstant(canonical);
  return {
    matchesMeetingTime: joinAt && joinAt.getTime() === canonical.meeting.recordedAt.getTime() ? 1 : 0,
    active: ACTIVE_RECORDING_STATUSES.includes(canonical.status) ? 1 : 0,
    joinAtMs: joinAt?.getTime() ?? Number.NEGATIVE_INFINITY,
    canonical,
  };
}

function compareDuplicateGroupsForRestore(left: RecordingWithMeetingTime[], right: RecordingWithMeetingTime[]) {
  const leftRank = duplicateGroupRestoreRank(left);
  const rightRank = duplicateGroupRestoreRank(right);
  if (leftRank.matchesMeetingTime !== rightRank.matchesMeetingTime) {
    return rightRank.matchesMeetingTime - leftRank.matchesMeetingTime;
  }
  if (leftRank.active !== rightRank.active) {
    return rightRank.active - leftRank.active;
  }
  if (leftRank.joinAtMs !== rightRank.joinAtMs) {
    return rightRank.joinAtMs - leftRank.joinAtMs;
  }
  if (!leftRank.canonical || !rightRank.canonical) {
    return leftRank.canonical ? -1 : rightRank.canonical ? 1 : 0;
  }
  return compareCanonicalRecordings(leftRank.canonical, rightRank.canonical);
}

async function cleanupDuplicateScheduledProviderBots(
  workspaceId: string,
  scope: DuplicateRecorderCleanupScope = {},
): Promise<DuplicateRecorderCleanupStats> {
  const scopedMeetingUrl = scope.meetingUrl ? normalizeMeetingUrl(scope.meetingUrl) : null;
  const recordings = await prisma.meetingRecording.findMany({
    where: {
      workspaceId,
      ...(scope.meetingId ? { meetingId: scope.meetingId } : {}),
      ...(scope.provider ? { provider: scope.provider } : {}),
      ...(scope.joinAt ? { joinAt: scope.joinAt } : {}),
      OR: [
        {
          externalBotId: { not: null },
          ...(scopedMeetingUrl ? { meetingUrl: scopedMeetingUrl } : {}),
          status: { in: ACTIVE_RECORDING_STATUSES },
        },
        {
          externalBotId: { not: null },
          ...(scopedMeetingUrl ? { meetingUrl: scopedMeetingUrl } : {}),
          status: "FAILED",
          failureCode: "STALE_RECORDER",
        },
        {
          activeDedupeKey: { not: null },
          status: { in: ACTIVE_RECORDING_STATUSES },
        },
      ],
    },
    include: {
      meeting: {
        select: {
          recordedAt: true,
          scheduledEndAt: true,
        },
      },
    },
  }) as RecordingWithMeetingTime[];

  const groups = new Map<string, RecordingWithMeetingTime[]>();
  for (const recording of recordings) {
    if (!recording.externalBotId) continue;
    const key = duplicateRecorderGroupKey(recording);
    if (!key) continue;
    groups.set(key, [...(groups.get(key) ?? []), recording]);
  }

  const stats: DuplicateRecorderCleanupStats = {
    duplicateRecordersSkipped: 0,
    duplicateProviderBotsCancelled: 0,
    canonicalRecordingsRestored: 0,
    duplicateCancellationFailures: 0,
  };

  const restoredDedupeKeys = new Set<string>();
  for (const recording of recordings) {
    const ownedKey = ownedActiveRecordingDedupeKey(recording);
    if (ownedKey) {
      restoredDedupeKeys.add(ownedKey);
    }
  }
  for (const group of [...groups.values()].sort(compareDuplicateGroupsForRestore)) {
    if (group.length <= 1) continue;
    const canonical = canonicalRecordingForGroup(group);
    if (!canonical) continue;

    const duplicates = group.filter((recording) => recording.id !== canonical.id);
    let allDuplicatesHandled = true;
    for (const duplicate of duplicates) {
      invariant(duplicate.externalBotId, 409, "RECORDER_DUPLICATE_MISSING_BOT", "Duplicate recorder is missing its provider bot id.");
      try {
        await providerCancel(duplicate.provider, duplicate.externalBotId, {
          joinAt: recorderJoinInstant(duplicate),
          status: duplicate.status,
        });
      } catch (error) {
        allDuplicatesHandled = false;
        stats.duplicateCancellationFailures += 1;
        recorderLog("warn", "reconcile_duplicate_cancel_failed", {
          workspaceId,
          meetingId: duplicate.meetingId,
          recordingId: duplicate.id,
          provider: duplicate.provider,
          canonicalRecordingId: canonical.id,
          failureCode: providerFailureCode(error),
        });
        continue;
      }
      stats.duplicateProviderBotsCancelled += 1;
      await markDuplicateRecordingSkipped(duplicate, canonical.id);
      stats.duplicateRecordersSkipped += 1;
      recorderLog("warn", "reconcile_duplicate_skipped", {
        workspaceId,
        meetingId: duplicate.meetingId,
        recordingId: duplicate.id,
        provider: duplicate.provider,
        canonicalRecordingId: canonical.id,
        failureCode: DUPLICATE_RECORDER_FAILURE_CODE,
      });
    }

    if (!allDuplicatesHandled) {
      continue;
    }

    const activeDedupeKey = activeRecordingDedupeKey({
      workspaceId: canonical.workspaceId,
      meetingId: canonical.meetingId,
      provider: canonical.provider,
    });
    const canonicalAlreadyOwnsKey = canonical.activeDedupeKey === activeDedupeKey
      && ACTIVE_RECORDING_STATUSES.includes(canonical.status);
    if (canonicalAlreadyOwnsKey) {
      restoredDedupeKeys.add(activeDedupeKey);
    }
    if (canonical.status !== "SCHEDULED" || canonical.activeDedupeKey !== activeDedupeKey || canonical.failureCode || canonical.endedAt) {
      if (restoredDedupeKeys.has(activeDedupeKey) && !canonicalAlreadyOwnsKey) {
        recorderLog("warn", "reconcile_canonical_restore_skipped", {
          workspaceId,
          meetingId: canonical.meetingId,
          recordingId: canonical.id,
          provider: canonical.provider,
          failureCode: "RECORDER_DUPLICATE_ACTIVE_KEY_RESERVED",
        });
        continue;
      }
      await restoreCanonicalScheduledRecording(canonical);
      restoredDedupeKeys.add(activeDedupeKey);
      stats.canonicalRecordingsRestored += 1;
      recorderLog("info", "reconcile_canonical_restored", {
        workspaceId,
        meetingId: canonical.meetingId,
        recordingId: canonical.id,
        provider: canonical.provider,
      });
    }
  }

  return stats;
}

async function reuseFutureProviderBotIfPresent(params: {
  workspaceId: string;
  meetingId: string;
  provider: MeetingRecorderProvider;
  meetingUrl: string;
  joinAt: Date;
}) {
  if (params.joinAt.getTime() - Date.now() <= AUTO_SCHEDULE_MIN_LEAD_MS) {
    return null;
  }
  const meetingUrl = normalizeMeetingUrl(params.meetingUrl);

  let recordings = await prisma.meetingRecording.findMany({
    where: {
      workspaceId: params.workspaceId,
      meetingId: params.meetingId,
      provider: params.provider,
      meetingUrl,
      externalBotId: { not: null },
      joinAt: params.joinAt,
      OR: [
        { status: { in: ACTIVE_RECORDING_STATUSES } },
        { status: "FAILED", failureCode: "STALE_RECORDER" },
      ],
    },
    orderBy: { createdAt: "desc" },
  });

  if (recordings.length > 1) {
    await cleanupDuplicateScheduledProviderBots(params.workspaceId, {
      meetingId: params.meetingId,
      provider: params.provider,
      joinAt: params.joinAt,
      meetingUrl,
    });
    const active = await prisma.meetingRecording.findFirst({
      where: {
        workspaceId: params.workspaceId,
        meetingId: params.meetingId,
        provider: params.provider,
        meetingUrl,
        externalBotId: { not: null },
        joinAt: params.joinAt,
        status: { in: ACTIVE_RECORDING_STATUSES },
      },
      orderBy: { createdAt: "desc" },
    });
    if (active) return active;
    recordings = await prisma.meetingRecording.findMany({
      where: {
        workspaceId: params.workspaceId,
        meetingId: params.meetingId,
        provider: params.provider,
        meetingUrl,
        externalBotId: { not: null },
        joinAt: params.joinAt,
        status: "FAILED",
        failureCode: "STALE_RECORDER",
      },
      orderBy: { createdAt: "desc" },
    });
    invariant(recordings.length <= 1, 409, "RECORDER_DUPLICATE_CLEANUP_BLOCKED", "Duplicate recorder cleanup did not finish; a new provider bot was not scheduled.");
  }

  const reusable = canonicalRecordingForGroup(recordings);
  if (!reusable || ACTIVE_RECORDING_STATUSES.includes(reusable.status)) {
    return reusable ?? null;
  }

  const restored = await restoreCanonicalScheduledRecording(reusable);
  recorderLog("info", "schedule_reused_future_provider_bot", {
    workspaceId: params.workspaceId,
    meetingId: params.meetingId,
    recordingId: restored.id,
    provider: restored.provider,
  });
  return restored;
}

async function recorderVendorMetadata(params: { workspaceId: string; meetingId: string; recordingId: string }) {
  const deployment = await prisma.customerDeployment.findUnique({
    where: { managedWorkspaceId: params.workspaceId },
    select: {
      id: true,
      customerAccountId: true,
    },
  }).catch(() => null);
  return {
    workspaceId: params.workspaceId,
    meetingId: params.meetingId,
    recordingId: params.recordingId,
    ...(deployment?.id ? { deploymentId: deployment.id } : {}),
    ...(deployment?.customerAccountId ? { customerId: deployment.customerAccountId } : {}),
  };
}

export function normalizeProviderTranscript(payload: unknown) {
  const hasStructuredTranscript = Array.isArray(payload)
    || (isRecord(payload) && (Array.isArray(payload.segments) || Array.isArray(payload.transcript) || Array.isArray(payload.words)));
  const entries = Array.isArray(payload)
    ? payload
    : isRecord(payload) && Array.isArray(payload.segments)
      ? payload.segments
      : isRecord(payload) && Array.isArray(payload.transcript)
        ? payload.transcript
        : isRecord(payload) && Array.isArray(payload.words)
          ? [{ words: payload.words }]
          : [];

  if (typeof payload === "string") {
    return payload.trim();
  }

  const lines = entries.map((entry) => {
    const record = isRecord(entry) ? entry : {};
    const participant = firstRecord(record.participant, record.speaker);
    const words = Array.isArray(record.words) ? record.words : [];
    const speaker = readString(record.speaker_name)
      ?? readString(record.speaker)
      ?? readString(record.name)
      ?? readString(participant?.name)
      ?? readString(participant?.display_name)
      ?? "Speaker";
    const start = readNumber(record.start)
      ?? readNumber(record.start_time)
      ?? readNumber(record.start_timestamp)
      ?? readNumber(record.start_ms)
      ?? readNumber(firstRecord(words[0])?.start_timestamp)
      ?? readNumber(firstRecord(words[0])?.start)
      ?? 0;
    const text = readString(record.text)
      ?? readString(record.transcript)
      ?? words.map((word) => isRecord(word) ? readString(word.text) ?? readString(word.word) : null).filter(Boolean).join(" ");
    if (!text) {
      return null;
    }
    return `${speaker} [${formatOffset(start)}]: ${text}`;
  }).filter(Boolean);

  if (lines.length > 0) {
    return lines.join("\n");
  }

  if (hasStructuredTranscript) {
    return "";
  }

  return JSON.stringify(payload, null, 2);
}

function formatOffset(value: number) {
  const seconds = value > 10_000 ? Math.floor(value / 1000) : Math.floor(value);
  const hours = Math.floor(seconds / 3600).toString().padStart(2, "0");
  const minutes = Math.floor((seconds % 3600) / 60).toString().padStart(2, "0");
  const remainder = Math.floor(seconds % 60).toString().padStart(2, "0");
  return `${hours}:${minutes}:${remainder}`;
}

function defaultConfigData() {
  return {
    enabled: false,
    defaultProvider: "RECALL_AI" as MeetingRecorderProvider,
    fallbackProvider: "MEETING_BAAS" as MeetingRecorderProvider,
    botName: DEFAULT_BOT_NAME,
    entryMessage: DEFAULT_ENTRY_MESSAGE,
    autoRecordEnabled: true,
    monthlyMinuteCap: DEFAULT_MONTHLY_MINUTE_CAP,
    providerSettings: null as Prisma.JsonValue | null,
  };
}

async function isRecorderFeatureEnabled(workspaceId: string) {
  const flag = await prisma.workspaceFeatureFlag.findUnique({
    where: {
      workspaceId_flag: {
        workspaceId,
        flag: MEETING_RECORDERS_FEATURE_FLAG,
      },
    },
    select: { enabled: true },
  });
  return Boolean(flag?.enabled);
}

async function requireRecorderFeature(workspaceId: string) {
  invariant(await isRecorderFeatureEnabled(workspaceId), 404, "FEATURE_DISABLED", "Meeting recorders are not enabled for this workspace.");
}

const recorderCalendarSourceSelect = {
  id: true,
  workspaceId: true,
  provider: true,
  providerAccountId: true,
  providerAccountEmail: true,
  displayName: true,
  expiresAt: true,
  scopes: true,
  status: true,
  lastSyncStartedAt: true,
  lastSyncCompletedAt: true,
  lastSyncAt: true,
  lastSyncJobId: true,
  lastSyncError: true,
  lastDryRunAt: true,
  lastUpcomingEventCount: true,
  lastSchedulableEventCount: true,
  createdAt: true,
  updatedAt: true,
} satisfies Prisma.WorkspaceRecorderCalendarSourceSelect;

function parseMicrosoftDateTime(value: { dateTime?: string | null; timeZone?: string | null } | null | undefined) {
  const raw = value?.dateTime?.trim();
  if (!raw) return new Date(NaN);
  if (/[zZ]$|[+-]\d{2}:\d{2}$/.test(raw)) return new Date(raw);
  const timeZone = resolveMicrosoftTimeZone(value?.timeZone);
  if (!timeZone) return new Date(raw);
  const parts = parseDateTimeParts(raw);
  if (!parts) return new Date(raw);
  return zonedDateTimeToUtc(parts, timeZone);
}

function resolveMicrosoftTimeZone(timeZone?: string | null) {
  const normalized = timeZone?.trim();
  if (!normalized) return null;
  const mapped = WINDOWS_TIME_ZONE_TO_IANA[normalized] ?? normalized;
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: mapped }).format(new Date(0));
    return mapped;
  } catch {
    return null;
  }
}

function parseDateTimeParts(raw: string): DateTimeParts | null {
  const match = raw.match(/^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})(?::(\d{2})(?:\.(\d{1,9}))?)?$/);
  if (!match) return null;
  const [, year, month, day, hour, minute, second = "0", fraction = "0"] = match;
  return {
    year: Number(year),
    month: Number(month),
    day: Number(day),
    hour: Number(hour),
    minute: Number(minute),
    second: Number(second),
    millisecond: Number(fraction.slice(0, 3).padEnd(3, "0")),
  };
}

function zonedDateTimeToUtc(parts: DateTimeParts, timeZone: string) {
  const target = Date.UTC(parts.year, parts.month - 1, parts.day, parts.hour, parts.minute, parts.second, parts.millisecond);
  let utc = target;
  for (let index = 0; index < 3; index += 1) {
    const rendered = dateTimePartsInZone(new Date(utc), timeZone);
    const renderedAsUtc = Date.UTC(rendered.year, rendered.month - 1, rendered.day, rendered.hour, rendered.minute, rendered.second, rendered.millisecond);
    const offset = renderedAsUtc - target;
    if (offset === 0) break;
    utc -= offset;
  }
  return new Date(utc);
}

function dateTimePartsInZone(date: Date, timeZone: string): DateTimeParts {
  const formatter = new Intl.DateTimeFormat("en-US", {
    timeZone,
    hourCycle: "h23",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    fractionalSecondDigits: 3,
  });
  const values = Object.fromEntries(formatter.formatToParts(date).map((part) => [part.type, part.value]));
  return {
    year: Number(values.year),
    month: Number(values.month),
    day: Number(values.day),
    hour: Number(values.hour),
    minute: Number(values.minute),
    second: Number(values.second),
    millisecond: Number(values.fractionalSecond ?? 0),
  };
}

function microsoftClientCredentials() {
  const clientId = process.env.MICROSOFT_CLIENT_ID?.trim();
  const clientSecret = process.env.MICROSOFT_CLIENT_SECRET?.trim();
  invariant(clientId && clientSecret, 503, "MICROSOFT_NOT_CONFIGURED", "Microsoft calendar OAuth is not configured.");
  return { clientId, clientSecret };
}

async function refreshRecorderCalendarSourceTokenIfNeeded(sourceId: string) {
  const source = await prisma.workspaceRecorderCalendarSource.findUnique({
    where: { id: sourceId },
  });
  invariant(source, 404, "NOT_FOUND", "Recorder calendar source not found.");
  invariant(source.provider === "MICROSOFT", 400, "UNSUPPORTED_PROVIDER", "Only Microsoft recorder calendar sources are supported.");
  invariant(source.status !== "DISABLED", 400, "RECORDER_CALENDAR_DISABLED", "Recorder calendar source is disabled.");

  if (!source.expiresAt || source.expiresAt.getTime() - Date.now() >= 5 * 60 * 1000) {
    return {
      ...source,
      accessToken: decryptSecret(source.accessTokenEnc),
    };
  }

  invariant(source.refreshTokenEnc, 400, "RECORDER_CALENDAR_REFRESH_TOKEN_MISSING", "Recorder calendar source cannot refresh without a refresh token.");
  const { clientId, clientSecret } = microsoftClientCredentials();
  const response = await fetch("https://login.microsoftonline.com/organizations/oauth2/v2.0/token", {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      client_id: clientId,
      client_secret: clientSecret,
      refresh_token: decryptSecret(source.refreshTokenEnc),
      grant_type: "refresh_token",
      scope: ["offline_access", "User.Read", "Calendars.Read"].join(" "),
    }),
  });
  const data = await response.json().catch(() => ({})) as Record<string, unknown>;
  if (!response.ok) {
    throw new AppError(502, "MICROSOFT_TOKEN_REFRESH_FAILED", String(data.error_description ?? data.error ?? "Microsoft token refresh failed."));
  }

  const accessToken = readString(data.access_token);
  invariant(accessToken, 502, "MICROSOFT_TOKEN_REFRESH_FAILED", "Microsoft token refresh did not return an access token.");
  const refreshToken = readString(data.refresh_token);
  const expiresIn = readNumber(data.expires_in);
  const scopes = readString(data.scope)?.split(/\s+/).filter(Boolean) ?? source.scopes;
  const updated = await prisma.workspaceRecorderCalendarSource.update({
    where: { id: source.id },
    data: {
      accessTokenEnc: encryptSecret(accessToken),
      ...(refreshToken ? { refreshTokenEnc: encryptSecret(refreshToken) } : {}),
      expiresAt: expiresIn ? new Date(Date.now() + expiresIn * 1000) : source.expiresAt,
      scopes,
      status: "ACTIVE",
      lastSyncError: null,
    },
  });
  return {
    ...updated,
    accessToken,
  };
}

function microsoftGraphEventToRecorderEvent(item: Record<string, unknown>): CalendarEventForRecorder {
  const onlineMeeting = firstRecord(item.onlineMeeting);
  const location = firstRecord(item.location);
  const body = firstRecord(item.body);
  const organizer = firstRecord(item.organizer);
  const organizerEmail = firstRecord(organizer?.emailAddress);
  const attendees = Array.isArray(item.attendees) ? item.attendees : [];
  const responseStatus = firstRecord(item.responseStatus);
  const meetingUrl = extractSupportedMeetingUrlFromText(onlineMeeting?.joinUrl as string | null)
    ?? extractSupportedMeetingUrlFromText(location?.displayName as string | null)
    ?? extractSupportedMeetingUrlFromText(item.bodyPreview as string | null)
    ?? extractSupportedMeetingUrlFromText(body?.content as string | null);
  return {
    id: String(item.id ?? ""),
    provider: "MICROSOFT",
    title: typeof item.subject === "string" && item.subject.trim() ? item.subject : "Untitled Event",
    description: typeof item.bodyPreview === "string" ? item.bodyPreview : null,
    startTime: parseMicrosoftDateTime(firstRecord(item.start)),
    endTime: parseMicrosoftDateTime(firstRecord(item.end)),
    attendees: attendees
      .map((attendee) => firstRecord(attendee)?.emailAddress)
      .map((email) => firstRecord(email)?.address)
      .filter((email): email is string => typeof email === "string" && email.trim().length > 0),
    organizerEmail: typeof organizerEmail?.address === "string" ? organizerEmail.address : null,
    meetingUrl,
    htmlLink: typeof item.webLink === "string" ? item.webLink : null,
    status: item.isCancelled === true ? "cancelled" : null,
    visibility: typeof item.sensitivity === "string" ? item.sensitivity : null,
    transparency: typeof item.showAs === "string" ? item.showAs : null,
    responseStatus: typeof responseStatus?.response === "string" ? responseStatus.response : null,
  };
}

async function fetchRecorderCalendarSourceEvents(sourceId: string, timeMin: Date, timeMax: Date) {
  const source = await refreshRecorderCalendarSourceTokenIfNeeded(sourceId);
  const calendarViewUrl = new URL("https://graph.microsoft.com/v1.0/me/calendarView");
  calendarViewUrl.searchParams.set("startDateTime", timeMin.toISOString());
  calendarViewUrl.searchParams.set("endDateTime", timeMax.toISOString());
  calendarViewUrl.searchParams.set("$orderby", "start/dateTime");
  calendarViewUrl.searchParams.set("$top", "100");
  const items: unknown[] = [];
  const seenUrls = new Set<string>();
  let url: string | null = calendarViewUrl.toString();
  while (url) {
    if (seenUrls.has(url)) {
      throw new AppError(502, "MICROSOFT_GRAPH_PAGINATION_LOOP", "Microsoft Graph calendar pagination returned a repeated page URL.");
    }
    seenUrls.add(url);
    const response = await fetch(url, {
      headers: {
        Authorization: `Bearer ${source.accessToken}`,
        Prefer: 'outlook.timezone="UTC"',
      },
    });
    const data = await response.json().catch(() => ({})) as unknown;
    const record = isRecord(data) ? data : {};
    if (!response.ok) {
      const error = firstRecord(record.error);
      throw new AppError(502, "MICROSOFT_GRAPH_FAILED", String(error?.message ?? "Microsoft Graph calendar request failed."));
    }
    if (Array.isArray(record.value)) {
      items.push(...record.value);
    }
    url = readString(record["@odata.nextLink"]) ?? null;
  }
  return items
    .filter((item): item is Record<string, unknown> => isRecord(item))
    .map(microsoftGraphEventToRecorderEvent)
    .filter((event) => event.id && !Number.isNaN(event.startTime.valueOf()) && !Number.isNaN(event.endTime.valueOf()));
}

export async function upsertRecorderCalendarSource(params: {
  workspaceId: string;
  providerAccountId: string;
  providerAccountEmail?: string | null;
  displayName?: string | null;
  accessToken: string;
  refreshToken?: string | null;
  expiresIn?: number | null;
  scopes?: string[];
}) {
  const expiresAt = params.expiresIn ? new Date(Date.now() + params.expiresIn * 1000) : null;
  return prisma.workspaceRecorderCalendarSource.upsert({
    where: {
      workspaceId_provider: {
        workspaceId: params.workspaceId,
        provider: "MICROSOFT",
      },
    },
    update: {
      providerAccountId: params.providerAccountId,
      providerAccountEmail: params.providerAccountEmail ?? null,
      displayName: params.displayName ?? null,
      accessTokenEnc: encryptSecret(params.accessToken),
      refreshTokenEnc: params.refreshToken ? encryptSecret(params.refreshToken) : null,
      expiresAt,
      scopes: params.scopes ?? [],
      status: "ACTIVE",
      lastSyncError: null,
    },
    create: {
      workspaceId: params.workspaceId,
      provider: "MICROSOFT",
      providerAccountId: params.providerAccountId,
      providerAccountEmail: params.providerAccountEmail ?? null,
      displayName: params.displayName ?? null,
      accessTokenEnc: encryptSecret(params.accessToken),
      refreshTokenEnc: params.refreshToken ? encryptSecret(params.refreshToken) : null,
      expiresAt,
      scopes: params.scopes ?? [],
      status: "ACTIVE",
    },
    select: recorderCalendarSourceSelect,
  }) as Promise<SafeRecorderCalendarSource>;
}

export async function getRecorderCalendarSource(workspaceId: string) {
  return prisma.workspaceRecorderCalendarSource.findUnique({
    where: {
      workspaceId_provider: {
        workspaceId,
        provider: "MICROSOFT",
      },
    },
    select: recorderCalendarSourceSelect,
  }) as Promise<SafeRecorderCalendarSource | null>;
}

export async function enqueueRecorderCalendarSync(params: { workspaceId: string; sourceId: string; reason?: string | null }) {
  const runAfter = new Date();
  return prisma.workflowJob.upsert({
    where: { dedupeKey: `meeting-recorders:calendar-sync:${params.sourceId}:${Math.floor(runAfter.getTime() / 60_000)}` },
    update: {},
    create: {
      workspaceId: params.workspaceId,
      type: "meeting-recorders.calendar.sync",
      payload: {
        sourceId: params.sourceId,
        reason: params.reason ?? "manual",
      },
      dedupeKey: `meeting-recorders:calendar-sync:${params.sourceId}:${Math.floor(runAfter.getTime() / 60_000)}`,
    },
  });
}

export async function scanRecorderCalendarSource(params: { workspaceId: string; sourceId: string; now?: Date }) {
  const now = params.now ?? new Date();
  const source = await prisma.workspaceRecorderCalendarSource.findFirst({
    where: { id: params.sourceId, workspaceId: params.workspaceId },
    select: recorderCalendarSourceSelect,
  });
  invariant(source, 404, "NOT_FOUND", "Recorder calendar source not found.");
  const events = await fetchRecorderCalendarSourceEvents(
    source.id,
    new Date(now.getTime() - RECORDER_CALENDAR_SYNC_LOOKBACK_MS),
    new Date(now.getTime() + RECORDER_CALENDAR_SYNC_LOOKAHEAD_MS),
  );
  const teamsEvents = events.filter((event) => isMicrosoftTeamsMeetingUrl(event.meetingUrl));
  const schedulable = teamsEvents.filter((event) => calendarEventIsEligible(event, now));
  const updated = await prisma.workspaceRecorderCalendarSource.update({
    where: { id: source.id },
    data: {
      lastDryRunAt: new Date(),
      lastUpcomingEventCount: teamsEvents.length,
      lastSchedulableEventCount: schedulable.length,
      status: "ACTIVE",
      lastSyncError: null,
    },
    select: recorderCalendarSourceSelect,
  });
  return {
    source: updated,
    upcomingEventCount: teamsEvents.length,
    schedulableEventCount: schedulable.length,
    skippedEventCount: Math.max(0, events.length - schedulable.length),
    provider: "MICROSOFT" as const,
  };
}

export async function syncRecorderCalendarSource(params: { workspaceId: string; sourceId: string; workflowJobId?: string | null; now?: Date }) {
  const now = params.now ?? new Date();
  const source = await prisma.workspaceRecorderCalendarSource.findFirst({
    where: { id: params.sourceId, workspaceId: params.workspaceId },
    select: recorderCalendarSourceSelect,
  });
  if (!source || source.status === "DISABLED") {
    return { action: "skipped" as const, reason: "source_unavailable" };
  }

  await prisma.workspaceRecorderCalendarSource.update({
    where: { id: source.id },
    data: {
      lastSyncStartedAt: new Date(),
      lastSyncJobId: params.workflowJobId ?? null,
    },
  });

  try {
    const events = await fetchRecorderCalendarSourceEvents(
      source.id,
      new Date(now.getTime() - RECORDER_CALENDAR_SYNC_LOOKBACK_MS),
      new Date(now.getTime() + RECORDER_CALENDAR_SYNC_LOOKAHEAD_MS),
    );
    const teamsEvents = events.filter((event) => isMicrosoftTeamsMeetingUrl(event.meetingUrl));
    let scheduled = 0;
    let skipped = 0;
    let cancelled = 0;
    for (const event of teamsEvents) {
      const result = await syncCalendarEventRecorder({
        workspaceId: params.workspaceId,
        connectionId: source.id,
        event,
        now,
      });
      if (result.action === "scheduled") scheduled += 1;
      if (result.action === "skipped") skipped += 1;
      if (result.action === "config_disabled" || result.action === "feature_disabled") skipped += 1;
      if (result.action === "cancelled") cancelled += 1;
    }
    const completedAt = new Date();
    await prisma.workspaceRecorderCalendarSource.update({
      where: { id: source.id },
      data: {
        status: "ACTIVE",
        lastSyncCompletedAt: completedAt,
        lastSyncAt: completedAt,
        lastSyncError: null,
        lastUpcomingEventCount: teamsEvents.length,
        lastSchedulableEventCount: scheduled,
      },
    });
    recorderLog("info", "calendar_source_synced", {
      workspaceId: params.workspaceId,
      sourceId: source.id,
      workflowJobId: params.workflowJobId,
      teamsEvents: teamsEvents.length,
      scheduled,
      skipped,
      cancelled,
    });
    return { action: "synced" as const, teamsEvents: teamsEvents.length, scheduled, skipped, cancelled };
  } catch (error) {
    const message = error instanceof Error ? error.message : "Recorder calendar sync failed.";
    await prisma.workspaceRecorderCalendarSource.update({
      where: { id: source.id },
      data: {
        status: "ERROR",
        lastSyncCompletedAt: new Date(),
        lastSyncError: message,
      },
    });
    recorderLog("error", "calendar_source_sync_failed", {
      workspaceId: params.workspaceId,
      sourceId: source.id,
      workflowJobId: params.workflowJobId,
    });
    throw error;
  }
}

export async function getMeetingRecorderConfig(actor: AppActor, workspaceId: string) {
  await requireWorkspaceMembership({ actor, workspaceId });
  const [featureEnabled, config, usage] = await Promise.all([
    isRecorderFeatureEnabled(workspaceId),
    prisma.workspaceMeetingRecorderConfig.findUnique({ where: { workspaceId } }),
    getMeetingRecorderMonthlyUsage(workspaceId),
  ]);
  return {
    featureEnabled,
    config: config ?? {
      id: null,
      workspaceId,
      ...defaultConfigData(),
      createdAt: null,
      updatedAt: null,
    },
    usage,
  };
}

export async function updateMeetingRecorderConfig(actor: AppActor, params: {
  workspaceId: string;
  enabled?: boolean;
  defaultProvider?: MeetingRecorderProvider;
  fallbackProvider?: MeetingRecorderProvider | null;
  botName?: string | null;
  entryMessage?: string | null;
  autoRecordEnabled?: boolean;
  monthlyMinuteCap?: number;
  providerSettings?: Prisma.InputJsonValue | null;
}) {
  await requireWorkspaceMembership({ actor, workspaceId: params.workspaceId, allowedRoles: ["ADMIN"] });
  await requireRecorderFeature(params.workspaceId);

  const defaults = defaultConfigData();
  const config = await prisma.workspaceMeetingRecorderConfig.upsert({
    where: { workspaceId: params.workspaceId },
    update: {
      enabled: params.enabled,
      defaultProvider: params.defaultProvider,
      fallbackProvider: params.fallbackProvider,
      botName: params.botName === undefined ? undefined : params.botName?.trim() || DEFAULT_BOT_NAME,
      entryMessage: params.entryMessage === undefined ? undefined : params.entryMessage?.trim() || null,
      autoRecordEnabled: params.autoRecordEnabled,
      monthlyMinuteCap: params.monthlyMinuteCap === undefined ? undefined : Math.max(0, Math.round(params.monthlyMinuteCap)),
      providerSettings: params.providerSettings === undefined
        ? undefined
        : params.providerSettings === null
          ? Prisma.JsonNull
          : params.providerSettings,
    },
    create: {
      workspaceId: params.workspaceId,
      enabled: params.enabled ?? defaults.enabled,
      defaultProvider: params.defaultProvider ?? defaults.defaultProvider,
      fallbackProvider: params.fallbackProvider === undefined ? defaults.fallbackProvider : params.fallbackProvider,
      botName: params.botName?.trim() || defaults.botName,
      entryMessage: params.entryMessage?.trim() || defaults.entryMessage,
      autoRecordEnabled: params.autoRecordEnabled ?? defaults.autoRecordEnabled,
      monthlyMinuteCap: params.monthlyMinuteCap === undefined ? defaults.monthlyMinuteCap : Math.max(0, Math.round(params.monthlyMinuteCap)),
      providerSettings: params.providerSettings === null ? Prisma.JsonNull : params.providerSettings ?? undefined,
    },
  });
  if (config.enabled) {
    await prisma.workflowJob.upsert({
      where: { dedupeKey: `meeting-recorders:reconcile:${params.workspaceId}:initial` },
      update: {},
      create: {
        workspaceId: params.workspaceId,
        type: "meeting-recorders.reconcile",
        payload: {},
        dedupeKey: `meeting-recorders:reconcile:${params.workspaceId}:initial`,
      },
    });
  }
  await syncMeetingRecorderEnterpriseService(params.workspaceId).catch((error) => {
    recorderLog("warn", "enterprise_service_sync_failed", {
      workspaceId: params.workspaceId,
      error: error instanceof Error ? error.message : String(error),
    });
  });
  return config;
}

export async function enableMeetingRecorderForWorkspace(actor: AppActor, params: { workspaceId: string; enabled?: boolean }) {
  await requireWorkspaceMembership({ actor, workspaceId: params.workspaceId, allowedRoles: ["ADMIN"] });
  await prisma.workspaceFeatureFlag.upsert({
    where: {
      workspaceId_flag: {
        workspaceId: params.workspaceId,
        flag: MEETING_RECORDERS_FEATURE_FLAG,
      },
    },
    update: { enabled: params.enabled ?? true },
    create: {
      workspaceId: params.workspaceId,
      flag: MEETING_RECORDERS_FEATURE_FLAG,
      enabled: params.enabled ?? true,
    },
  });
  return updateMeetingRecorderConfig(actor, {
    workspaceId: params.workspaceId,
    enabled: params.enabled ?? true,
  });
}

function monthBounds(now = new Date()) {
  const start = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
  const end = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 1));
  return { start, end };
}

export async function getMeetingRecorderMonthlyUsage(workspaceId: string, now = new Date()) {
  const { start, end } = monthBounds(now);
  const aggregate = await prisma.meetingRecording.aggregate({
    where: {
      workspaceId,
      createdAt: { gte: start, lt: end },
      status: { in: ["COMPLETED", "RECORDING"] },
    },
    _sum: { durationSeconds: true },
  });
  const usedSeconds = aggregate._sum.durationSeconds ?? 0;
  return {
    periodStart: start,
    periodEnd: end,
    usedSeconds,
    usedMinutes: Math.ceil(usedSeconds / 60),
  };
}

function providerRuntimeChecks(config: {
  defaultProvider: MeetingRecorderProvider;
  fallbackProvider?: MeetingRecorderProvider | null;
}): RecorderReadinessCheck[] {
  const providers = new Set<MeetingRecorderProvider>([config.defaultProvider]);
  if (config.fallbackProvider) providers.add(config.fallbackProvider);
  const checks: RecorderReadinessCheck[] = [
    {
      key: "public_base_url",
      label: "Public recorder URL",
      ok: Boolean(env.MEETING_RECORDER_PUBLIC_BASE_URL),
      detail: env.MEETING_RECORDER_PUBLIC_BASE_URL ? "Configured." : "MEETING_RECORDER_PUBLIC_BASE_URL is missing.",
    },
  ];
  if (providers.has("RECALL_AI")) {
    checks.push(
      {
        key: "recall_api_key",
        label: "Recall API key",
        ok: Boolean(env.RECALL_API_KEY),
        detail: env.RECALL_API_KEY ? "Configured." : "RECALL_API_KEY is missing.",
      },
      {
        key: "recall_webhook_secret",
        label: "Recall webhook secret",
        ok: Boolean(env.RECALL_WEBHOOK_SECRET),
        detail: env.RECALL_WEBHOOK_SECRET ? "Configured." : "RECALL_WEBHOOK_SECRET is missing.",
      },
    );
  }
  if (providers.has("MEETING_BAAS")) {
    checks.push(
      {
        key: "meeting_baas_api_key",
        label: "Meeting BaaS API key",
        ok: Boolean(env.MEETING_BAAS_API_KEY),
        detail: env.MEETING_BAAS_API_KEY ? "Configured." : "MEETING_BAAS_API_KEY is missing.",
      },
      {
        key: "meeting_baas_webhook_secret",
        label: "Meeting BaaS webhook secret",
        ok: Boolean(env.MEETING_BAAS_WEBHOOK_SECRET),
        detail: env.MEETING_BAAS_WEBHOOK_SECRET ? "Configured." : "MEETING_BAAS_WEBHOOK_SECRET is missing.",
      },
    );
  }
  return checks;
}

function providerCanSchedule(config: {
  defaultProvider: MeetingRecorderProvider;
}) {
  return providerRuntimeChecks({ defaultProvider: config.defaultProvider, fallbackProvider: null }).every((check) => check.ok);
}

function recorderProofObservedAt(recording: {
  status?: string | null;
  endedAt?: Date | null;
  startedAt?: Date | null;
  scheduledAt?: Date | null;
  updatedAt?: Date | null;
  createdAt: Date;
}) {
  if (recording.status === "JOINING") {
    return recording.endedAt ?? recording.startedAt ?? recording.updatedAt ?? recording.scheduledAt ?? recording.createdAt;
  }
  return recording.endedAt ?? recording.startedAt ?? recording.scheduledAt ?? recording.createdAt;
}

function newestRecorderProofRecording<T extends {
  status?: string | null;
  endedAt?: Date | null;
  startedAt?: Date | null;
  scheduledAt?: Date | null;
  updatedAt?: Date | null;
  createdAt: Date;
}>(recordings: T[]) {
  return recordings.reduce<T | null>((latest, recording) => {
    if (!latest) return recording;
    return recorderProofObservedAt(recording) > recorderProofObservedAt(latest) ? recording : latest;
  }, null);
}

function newestRecorderProofAt(...dates: Array<Date | null | undefined>) {
  return dates.reduce<Date | null>((latest, date) => {
    if (!date) return latest;
    if (!latest || date > latest) return date;
    return latest;
  }, null);
}

function isRecorderAuthFailure(recording: { failureCode: string | null; failureMessage: string | null }) {
  const text = `${recording.failureCode ?? ""}\n${recording.failureMessage ?? ""}`.toLowerCase();
  return text.includes("authentication_failed")
    || text.includes("invalid api token")
    || text.includes("invalid_auth")
    || text.includes("unauthorized")
    || text.includes("401")
    || text.includes("region")
    || recording.failureCode === "configuration_error";
}

function sanitizeRecorderFailureDetail(recording: { failureCode: string | null; failureMessage: string | null }) {
  if (recording.failureCode === "configuration_error") return "Recorder provider credential is not configured.";
  const message = recording.failureMessage ?? recording.failureCode ?? "Recorder provider authentication failed.";
  if (/recall/i.test(message) && /401|authentication_failed|invalid api token|region/i.test(message)) {
    return "Recall authentication failed; verify the configured API token and region.";
  }
  return message.replace(/https?:\/\/\S+/g, "[url]").slice(0, 500);
}

function compactRecorderProof(recording: {
  id: string;
  provider: MeetingRecorderProvider;
  status: string;
  createdAt: Date;
  updatedAt: Date;
  scheduledAt?: Date | null;
  startedAt?: Date | null;
  endedAt?: Date | null;
} | null) {
  if (!recording) return null;
  return {
    id: recording.id,
    provider: recording.provider,
    status: recording.status,
    observedAt: recorderProofObservedAt(recording),
    createdAt: recording.createdAt,
    updatedAt: recording.updatedAt,
  };
}

function compactRecorderAuthFailure(recording: {
  id: string;
  provider: MeetingRecorderProvider;
  status: string;
  failureCode: string | null;
  failureMessage: string | null;
  updatedAt: Date;
} | null) {
  if (!recording) return null;
  return {
    id: recording.id,
    provider: recording.provider,
    status: recording.status,
    failureCode: recording.failureCode,
    detail: sanitizeRecorderFailureDetail(recording),
    updatedAt: recording.updatedAt,
  };
}

type RecorderCoverageReadiness = Awaited<ReturnType<typeof getMeetingRecorderCoverageReadiness>>;

function recorderCoverageAlreadyCoveredCount(coverage: RecorderCoverageReadiness) {
  return coverage.counts.blockers.already_covered ?? 0;
}

function recorderScheduleSourceCheck(params: {
  coverage: RecorderCoverageReadiness;
  calendarSource: Awaited<ReturnType<typeof getRecorderCalendarSource>>;
  failedSyncJobs: number;
}): RecorderReadinessCheck {
  const { coverage, calendarSource, failedSyncJobs } = params;
  const alreadyCovered = recorderCoverageAlreadyCoveredCount(coverage);
  const internalScheduleReady = coverage.counts.eligible + alreadyCovered > 0;
  const calendarImportReady = Boolean(calendarSource?.status === "ACTIVE" && calendarSource.lastSyncAt && !calendarSource.lastSyncError && failedSyncJobs === 0);
  if (internalScheduleReady) {
    return {
      key: "recording_schedule",
      label: "Corgtex recorder schedule",
      ok: true,
      detail: alreadyCovered > 0
        ? `${alreadyCovered} upcoming Corgtex scheduled meeting(s) already have recorder coverage.`
        : `${coverage.counts.eligible} upcoming Corgtex scheduled meeting(s) are eligible for recorder scheduling.`,
    };
  }
  if (calendarImportReady) {
    return {
      key: "recording_schedule",
      label: "Corgtex recorder schedule",
      ok: true,
      detail: "Optional calendar sync is connected and can import recorder meetings into Corgtex.",
    };
  }
  if (coverage.counts.total > 0) {
    const blocker = Object.entries(coverage.counts.blockers)
      .filter(([key, count]) => key !== "already_covered" && count > 0)
      .sort((left, right) => right[1] - left[1])[0];
    return {
      key: "recording_schedule",
      label: "Corgtex recorder schedule",
      ok: false,
      detail: blocker
        ? `${coverage.counts.total} upcoming Corgtex scheduled meeting(s) exist, but none are recordable because ${blocker[1]} are blocked by ${blocker[0]}.`
        : "Upcoming Corgtex scheduled meetings exist, but none are ready for recorder scheduling.",
    };
  }
  const calendarDetail = calendarSource?.lastSyncError
    ?? (calendarSource
      ? `${calendarSource.providerAccountEmail ?? calendarSource.providerAccountId} is ${calendarSource.status.toLowerCase()} and has not produced recordable meetings.`
      : "No optional calendar sync is connected.");
  return {
    key: "recording_schedule",
    label: "Corgtex recorder schedule",
    ok: false,
    detail: `No upcoming Corgtex scheduled meetings found. Add the meeting to Corgtex before recording; optional calendar sync is not required. ${calendarDetail}`,
  };
}

export async function getMeetingRecorderEnterpriseReadiness(workspaceId: string) {
  const now = new Date();
  const proofSince = new Date(now.getTime() - RECORDER_PROVIDER_PROOF_MAX_AGE_MS);
  const [featureEnabled, config, calendarSource, coverage, lastSmokeRun, lastSuccessfulSmokeRun, providerProofRecordings, failedRecordings] = await Promise.all([
    isRecorderFeatureEnabled(workspaceId),
    getEffectiveRecorderConfig(workspaceId),
    getRecorderCalendarSource(workspaceId),
    getMeetingRecorderCoverageReadiness(workspaceId),
    prisma.meetingRecorderSmokeRun.findFirst({
      where: { workspaceId },
      orderBy: { createdAt: "desc" },
    }),
    prisma.meetingRecorderSmokeRun.findFirst({
      where: {
        workspaceId,
        status: "COMPLETED",
        completedAt: { gte: proofSince },
      },
      orderBy: { completedAt: "desc" },
    }),
    prisma.meetingRecording.findMany({
      where: {
        workspaceId,
        OR: [
          {
            status: { in: ["COMPLETED", "RECORDING"] },
            OR: [
              { endedAt: { gte: proofSince } },
              { startedAt: { gte: proofSince } },
              { scheduledAt: { gte: proofSince } },
              { createdAt: { gte: proofSince } },
            ],
          },
          {
            status: "SCHEDULED",
            externalBotId: { not: null },
            OR: [
              { scheduledAt: { gte: now } },
              { joinAt: { gte: now } },
            ],
          },
          {
            status: "JOINING",
            externalBotId: { not: null },
            OR: [
              { scheduledAt: { gte: now } },
              { joinAt: { gte: now } },
              { startedAt: { gte: proofSince } },
              { updatedAt: { gte: proofSince } },
            ],
          },
        ],
	      },
	      orderBy: { updatedAt: "desc" },
	      select: {
        id: true,
        provider: true,
        status: true,
        scheduledAt: true,
        joinAt: true,
        startedAt: true,
        endedAt: true,
        createdAt: true,
        updatedAt: true,
      },
    }),
    prisma.meetingRecording.findMany({
      where: {
        workspaceId,
        status: "FAILED",
      },
      orderBy: { updatedAt: "desc" },
      take: 10,
      select: {
        id: true,
        provider: true,
        status: true,
        failureCode: true,
        failureMessage: true,
        updatedAt: true,
      },
    }),
  ]);
  const lastProviderProofRecording = newestRecorderProofRecording(providerProofRecordings);
  const lastProviderAuthFailure = failedRecordings.find(isRecorderAuthFailure) ?? null;
  const proofObservedAt = newestRecorderProofAt(
    lastSuccessfulSmokeRun?.completedAt,
    lastProviderProofRecording ? recorderProofObservedAt(lastProviderProofRecording) : null,
  );
  const providerProofBlocked = Boolean(lastProviderAuthFailure && (!proofObservedAt || lastProviderAuthFailure.updatedAt > proofObservedAt));
  const providerProofOk = Boolean(proofObservedAt && proofObservedAt >= proofSince && !providerProofBlocked);
  const failedSyncJobs = calendarSource
    ? await prisma.workflowJob.count({
      where: {
        workspaceId,
        type: "meeting-recorders.calendar.sync",
        status: "FAILED",
        ...(calendarSource.lastSyncAt ? { updatedAt: { gt: calendarSource.lastSyncAt } } : {}),
      },
    })
    : 0;
  const scheduleSourceCheck = recorderScheduleSourceCheck({ coverage, calendarSource, failedSyncJobs });
  const checks: RecorderReadinessCheck[] = [
    {
      key: "entitlement",
      label: "Recorder entitlement",
      ok: featureEnabled,
      detail: featureEnabled ? "MEETING_RECORDERS is enabled." : "MEETING_RECORDERS feature flag is disabled.",
    },
    {
      key: "recorder_config",
      label: "Recorder config",
      ok: Boolean(config.enabled),
      detail: config.enabled ? `${config.defaultProvider} enabled.` : "Workspace recorder config is disabled.",
    },
    ...providerRuntimeChecks(config),
    scheduleSourceCheck,
    {
      key: "provider_proof",
      label: "Recorder provider proof",
      ok: providerProofOk,
      detail: providerProofBlocked && lastProviderAuthFailure
        ? sanitizeRecorderFailureDetail(lastProviderAuthFailure)
        : proofObservedAt
          ? `Recent recorder provider proof at ${proofObservedAt.toISOString()}.`
          : "No recent successful recorder smoke, scheduled provider bot, or real recording in the last 30 days.",
    },
  ];
  return {
    workspaceId,
    ready: checks.every((check) => check.ok),
    checks,
    calendarSource,
    coverage,
    lastSmokeRun,
    lastSuccessfulSmokeRun,
    lastSuccessfulRecording: compactRecorderProof(lastProviderProofRecording),
    lastProviderAuthFailure: compactRecorderAuthFailure(lastProviderAuthFailure),
    config,
  };
}

function failedRecorderChecks(checks: RecorderReadinessCheck[]) {
  return checks.filter((check) => !check.ok);
}

function recorderServiceHealthStatus(params: {
  featureEnabled: boolean;
  configEnabled: boolean;
  checks: RecorderReadinessCheck[];
}) {
  if (!params.featureEnabled || !params.configEnabled) return "NEEDS_SETUP" as const;
  const failed = failedRecorderChecks(params.checks);
  if (failed.length === 0) return "ACTIVE" as const;
  if (failed.some((check) => check.key === "recording_schedule")) return "NEEDS_SETUP" as const;
  if (failed.some((check) => check.key === "worker_sync" || check.key === "provider_proof")) return "UNHEALTHY" as const;
  return "UNHEALTHY" as const;
}

function recorderServiceLastError(checks: RecorderReadinessCheck[]) {
  const failed = failedRecorderChecks(checks);
  if (failed.length === 0) return null;
  return failed.map((check) => `${check.label}: ${check.detail}`).join("\n");
}

export async function getMeetingRecorderEnterpriseServiceSnapshot(workspaceId: string, now = new Date()) {
  const [readiness, usage] = await Promise.all([
    getMeetingRecorderEnterpriseReadiness(workspaceId),
    getMeetingRecorderMonthlyUsage(workspaceId, now),
  ]);
  const entitlement = readiness.checks.find((check) => check.key === "entitlement")?.ok ?? false;
  const healthStatus = recorderServiceHealthStatus({
    featureEnabled: entitlement,
    configEnabled: readiness.config.enabled,
    checks: readiness.checks,
  });
  const usageJson = {
    recorder: {
      periodStart: usage.periodStart.toISOString(),
      periodEnd: usage.periodEnd.toISOString(),
      usedSeconds: usage.usedSeconds,
      usedMinutes: usage.usedMinutes,
      monthlyMinuteCap: readiness.config.monthlyMinuteCap,
      remainingMinutes: Math.max(0, readiness.config.monthlyMinuteCap - usage.usedMinutes),
    },
    readiness: {
      ready: readiness.ready,
      failedChecks: failedRecorderChecks(readiness.checks).map((check) => ({
        key: check.key,
        label: check.label,
        detail: check.detail,
      })),
    },
  };

  return {
    serviceKey: "MEETING_RECORDER" as const,
    displayName: "Meeting recorder",
    providerKey: readiness.config.defaultProvider,
    ownershipMode: "CUSTOMER_MANAGED" as const,
    healthStatus,
    lastHealthCheckAt: now,
    lastSuccessfulHealthCheckAt: readiness.ready ? now : null,
    lastSuccessfulSyncAt: readiness.calendarSource?.lastSyncAt ?? null,
    lastError: recorderServiceLastError(readiness.checks),
    usageJson,
    usageLabel: `${usage.usedMinutes} min this month`,
    usageDetail: `${usage.usedMinutes} of ${readiness.config.monthlyMinuteCap} recorder minutes used in the current billing period.`,
    readinessChecks: readiness.checks,
  };
}

export async function syncMeetingRecorderEnterpriseService(workspaceId: string, now = new Date()) {
  const snapshot = await getMeetingRecorderEnterpriseServiceSnapshot(workspaceId, now);

  return prisma.workspaceEnterpriseService.upsert({
    where: {
      workspaceId_serviceKey: {
        workspaceId,
        serviceKey: enterpriseServiceToDb("meeting_recorder"),
      },
    },
    update: {
      displayName: snapshot.displayName,
      providerKey: snapshot.providerKey,
      healthStatus: snapshot.healthStatus,
      lastHealthCheckAt: snapshot.lastHealthCheckAt,
      lastSuccessfulHealthCheckAt: snapshot.lastSuccessfulHealthCheckAt,
      lastSuccessfulSyncAt: snapshot.lastSuccessfulSyncAt,
      lastError: snapshot.lastError,
      usageJson: jsonValue(snapshot.usageJson),
    },
    create: {
      workspaceId,
      serviceKey: enterpriseServiceToDb("meeting_recorder"),
      ownershipMode: snapshot.ownershipMode,
      displayName: snapshot.displayName,
      providerKey: snapshot.providerKey,
      healthStatus: snapshot.healthStatus,
      lastHealthCheckAt: snapshot.lastHealthCheckAt,
      lastSuccessfulHealthCheckAt: snapshot.lastSuccessfulHealthCheckAt,
      lastSuccessfulSyncAt: snapshot.lastSuccessfulSyncAt,
      lastError: snapshot.lastError,
      usageJson: jsonValue(snapshot.usageJson),
    },
  });
}

export async function runMeetingRecorderSmoke(params: {
  workspaceId: string;
  deploymentId?: string | null;
  meetingUrl: string;
  joinAt: Date;
  provider?: MeetingRecorderProvider | null;
  liveVendorCall?: boolean;
}) {
  const provider = params.provider ?? "RECALL_AI";
  const config = await getEffectiveRecorderConfig(params.workspaceId);
  const featureEnabled = await isRecorderFeatureEnabled(params.workspaceId);
  const recorderUrl = extractRecorderMeetingUrlFromText(params.meetingUrl);
  const url = recorderUrl?.providerSchedulable ? recorderUrl.url : null;
  const checks: RecorderReadinessCheck[] = [
    {
      key: "entitlement",
      label: "Recorder entitlement",
      ok: featureEnabled,
      detail: featureEnabled ? "MEETING_RECORDERS is enabled." : "MEETING_RECORDERS feature flag is disabled.",
    },
    {
      key: "config_enabled",
      label: "Recorder config",
      ok: config.enabled,
      detail: config.enabled ? "Recorder config is enabled." : "Recorder config is disabled.",
    },
    {
      key: "meeting_url",
      label: "Supported meeting URL",
      ok: Boolean(url && isMicrosoftTeamsMeetingUrl(url)),
      detail: url && isMicrosoftTeamsMeetingUrl(url)
        ? "Business Microsoft Teams URL detected."
        : "A supported Microsoft Teams meeting URL is required.",
    },
    {
      key: "join_time",
      label: "Future join time",
      ok: params.joinAt.getTime() - Date.now() > AUTO_SCHEDULE_MIN_LEAD_MS,
      detail: params.joinAt.toISOString(),
    },
    ...providerRuntimeChecks({ ...config, defaultProvider: provider, fallbackProvider: null }),
  ];
  const checksOk = checks.every((check) => check.ok);
  const initialStatus = checksOk ? (params.liveVendorCall ? "PENDING" : "DRY_RUN_READY") : "FAILED";
  const smokeRun = await prisma.meetingRecorderSmokeRun.create({
    data: {
      workspaceId: params.workspaceId,
      deploymentId: params.deploymentId ?? null,
      provider,
      status: initialStatus,
      meetingUrlHash: url ? meetingUrlHash(url) : null,
      joinAt: params.joinAt,
      liveVendorCall: Boolean(params.liveVendorCall),
      checks: jsonValue({ checks }),
      failureMessage: checksOk ? null : checks.filter((check) => !check.ok).map((check) => check.detail).join(" "),
      completedAt: params.liveVendorCall && checksOk ? null : new Date(),
    },
  });
  if (!params.liveVendorCall || !checksOk) {
    return smokeRun;
  }

  try {
    const recorderActor = systemRecorderActor(params.workspaceId);
    const meeting = await prisma.$transaction(async (tx) => {
      const created = await tx.meeting.create({
        data: {
          workspaceId: params.workspaceId,
          title: "[SMOKE] Meeting recorder",
          source: "meeting-recorder-smoke",
          externalId: `meeting-recorder-smoke:${smokeRun.id}`,
          calendarExternalId: `meeting-recorder-smoke:${smokeRun.id}`,
          meetingUrl: url,
          meetingUrlHash: meetingUrlHash(url as string),
          status: "SCHEDULED",
          recordedAt: params.joinAt,
          scheduledEndAt: new Date(params.joinAt.getTime() + 30 * 60 * 1000),
          participantIds: [],
          participantEmails: [],
        },
      });
      await ensureWorkspacePermalink(tx, recorderActor, {
        workspaceId: params.workspaceId,
        entityType: "Meeting",
        entityId: created.id,
        canonicalPath: workspaceEntityCanonicalPath(params.workspaceId, "Meeting", created),
      });
      return created;
    });
    const recording = await scheduleMeetingRecording(recorderActor, {
      workspaceId: params.workspaceId,
      meetingId: meeting.id,
      provider,
      mode: "manual",
    });
    return prisma.meetingRecorderSmokeRun.update({
      where: { id: smokeRun.id },
      data: {
        status: recording.status === "FAILED" ? "FAILED" : "SCHEDULED",
        meetingId: meeting.id,
        recordingId: recording.id,
        failureMessage: recording.failureMessage,
        completedAt: recording.status === "FAILED" ? new Date() : null,
        checks: jsonValue({
          checks,
          recording: {
            id: recording.id,
            status: recording.status,
            provider: recording.provider,
            externalBotScheduled: Boolean(recording.externalBotId),
          },
        }),
      },
    });
  } catch (error) {
    return prisma.meetingRecorderSmokeRun.update({
      where: { id: smokeRun.id },
      data: {
        status: "FAILED",
        failureMessage: error instanceof Error ? error.message : "Meeting recorder smoke failed.",
        completedAt: new Date(),
      },
    });
  }
}

function estimatedMeetingMinutes(meeting: { recordedAt: Date; scheduledEndAt: Date | null }) {
  if (meeting.scheduledEndAt && meeting.scheduledEndAt > meeting.recordedAt) {
    return Math.ceil((meeting.scheduledEndAt.getTime() - meeting.recordedAt.getTime()) / 60_000);
  }
  return 60;
}

async function getEffectiveRecorderConfig(workspaceId: string) {
  const config = await prisma.workspaceMeetingRecorderConfig.findUnique({ where: { workspaceId } });
  return config ?? defaultConfigData();
}

async function enforceMonthlyCap(params: {
  workspaceId: string;
  config: Awaited<ReturnType<typeof getEffectiveRecorderConfig>>;
  estimatedMinutes: number;
  allowOverride: boolean;
}) {
  if (params.config.monthlyMinuteCap <= 0) {
    return;
  }
  const usage = await getMeetingRecorderMonthlyUsage(params.workspaceId);
  if (usage.usedMinutes + params.estimatedMinutes <= params.config.monthlyMinuteCap) {
    return;
  }
  invariant(params.allowOverride, 402, "RECORDER_MONTHLY_CAP_EXCEEDED", "The workspace meeting recorder monthly minute cap has been reached.");
}

async function createRecordingAttempt(params: {
  workspaceId: string;
  meetingId: string;
  meetingUrl: string;
  joinAt: Date;
  provider: MeetingRecorderProvider;
}) {
  const activeDedupeKey = activeRecordingDedupeKey(params);
  try {
    const recording = await prisma.meetingRecording.create({
      data: {
        workspaceId: params.workspaceId,
        meetingId: params.meetingId,
        provider: params.provider,
        activeDedupeKey,
        meetingUrl: normalizeMeetingUrl(params.meetingUrl),
        joinAt: params.joinAt,
        status: "PENDING",
      },
    });
    return { recording, reused: false };
  } catch (error) {
    if (!isUniqueConstraintError(error)) {
      throw error;
    }
    const existing = await prisma.meetingRecording.findFirst({
      where: {
        workspaceId: params.workspaceId,
        meetingId: params.meetingId,
        provider: params.provider,
        activeDedupeKey,
        status: { in: ACTIVE_RECORDING_STATUSES },
      },
      orderBy: { createdAt: "desc" },
    });
    invariant(existing, 409, "RECORDER_ALREADY_SCHEDULING", "A recorder is already being scheduled for this meeting.");
    return { recording: existing, reused: true };
  }
}

async function retireMismatchedActiveRecordings(params: {
  workspaceId: string;
  meetingId: string;
  meetingUrl: string;
  recordedAt: Date;
}) {
  const normalizedMeetingUrl = normalizeMeetingUrl(params.meetingUrl);
  const recordings = await prisma.meetingRecording.findMany({
    where: {
      workspaceId: params.workspaceId,
      meetingId: params.meetingId,
      status: { in: ACTIVE_RECORDING_STATUSES },
      NOT: { meetingUrl: normalizedMeetingUrl },
    },
  });

  for (const recording of recordings) {
    if (recording.externalBotId) {
      try {
        await providerCancel(recording.provider, recording.externalBotId, {
          joinAt: recorderJoinInstant({ joinAt: recording.joinAt, meeting: { recordedAt: params.recordedAt } }),
          status: recording.status,
        });
      } catch (error) {
        recorderLog("warn", "schedule_url_changed_cancel_failed", {
          workspaceId: params.workspaceId,
          meetingId: params.meetingId,
          recordingId: recording.id,
          provider: recording.provider,
          failureCode: providerFailureCode(error),
        });
        throw recorderSchedulingFailedError();
      }
    }
    await prisma.meetingRecording.update({
      where: { id: recording.id },
      data: {
        status: "FAILED",
        activeDedupeKey: null,
        failureCode: MEETING_URL_CHANGED_FAILURE_CODE,
        failureMessage: "Recorder rescheduled because the meeting URL changed.",
        endedAt: new Date(),
      },
    });
    recorderLog("warn", "schedule_url_changed_retired", {
      workspaceId: params.workspaceId,
      meetingId: params.meetingId,
      recordingId: recording.id,
      provider: recording.provider,
    });
  }

  return recordings.length;
}

function unsupportedRecorderMeetingUrlError() {
  return new AppError(
    400,
    "RECORDER_UNSUPPORTED_MEETING_URL",
    "Paste a supported live meeting link from Microsoft Teams, Google Meet, or Zoom.",
  );
}

function recorderSchedulingFailedError() {
  return new AppError(
    502,
    "RECORDER_SCHEDULING_FAILED",
    "Recorder scheduling failed. Try again or contact support if it keeps happening.",
  );
}

export async function sendManualMeetingRecorder(actor: AppActor, params: {
  workspaceId: string;
  meetingUrl: string;
  title?: string | null;
  durationMinutes?: string | number | null;
  participantEmails?: string[] | null;
}) {
  const membership = await requireWorkspaceMembership({
    actor,
    workspaceId: params.workspaceId,
    allowedRoles: ["ADMIN", "FACILITATOR"],
  });
  await requireRecorderFeature(params.workspaceId);

  const recorderUrl = normalizeRecorderMeetingUrl(params.meetingUrl);
  if (!recorderUrl) {
    throw unsupportedRecorderMeetingUrlError();
  }
  if (!recorderUrl.providerSchedulable) {
    throw new AppError(400, "RECORDER_TEAMS_FULL_JOIN_LINK_REQUIRED", TEAMS_FULL_JOIN_LINK_REQUIRED_MESSAGE);
  }

  const config = await getEffectiveRecorderConfig(params.workspaceId);
  invariant(config.enabled, 403, "RECORDER_DISABLED", "Meeting recorder is disabled for this workspace.");

  const durationMinutes = parseMeetingDurationMinutes(params.durationMinutes, "Duration");
  const isAdmin = actor.kind === "user"
    ? membership?.role === "ADMIN"
    : actor.scopes?.includes("support:write");
  await enforceMonthlyCap({
    workspaceId: params.workspaceId,
    config,
    estimatedMinutes: durationMinutes,
    allowOverride: Boolean(isAdmin),
  });

  const joinAt = new Date();
  const meeting = await createScheduledMeeting(actor, {
    workspaceId: params.workspaceId,
    title: params.title?.trim() || "Live meeting",
    startsAt: joinAt,
    scheduledEndAt: meetingEndFromDurationMinutes(joinAt, durationMinutes),
    meetingUrl: recorderUrl.url,
    participantEmails: normalizeEmails(params.participantEmails),
    source: "manual-recorder",
  });

  try {
    const recording = await scheduleMeetingRecording(actor, {
      workspaceId: params.workspaceId,
      meetingId: meeting.id,
      mode: "manual",
    });
    return { meeting, recording };
  } catch (error) {
    if (error instanceof AppError) {
      throw error;
    }
    throw recorderSchedulingFailedError();
  }
}

export async function scheduleMeetingRecording(actor: AppActor, params: {
  workspaceId: string;
  meetingId: string;
  provider?: MeetingRecorderProvider | null;
  mode?: "manual" | "auto";
}) {
  const membership = await requireWorkspaceMembership({
    actor,
    workspaceId: params.workspaceId,
    allowedRoles: ["ADMIN", "FACILITATOR"],
  });
  await requireRecorderFeature(params.workspaceId);

  const [config, meeting] = await Promise.all([
    getEffectiveRecorderConfig(params.workspaceId),
    prisma.meeting.findFirst({
      where: { id: params.meetingId, workspaceId: params.workspaceId, archivedAt: null },
      select: {
        id: true,
        title: true,
        recordedAt: true,
        scheduledEndAt: true,
        meetingUrl: true,
        participantEmails: true,
        series: {
          select: {
            meetingUrl: true,
          },
        },
      },
    }),
  ]);
  invariant(config.enabled, 403, "RECORDER_DISABLED", "Meeting recorder is disabled for this workspace.");
  invariant(meeting, 404, "NOT_FOUND", "Meeting not found.");
  const meetingUrl = meeting.meetingUrl ?? meeting.series?.meetingUrl ?? null;
  invariant(meetingUrl, 400, "MEETING_URL_REQUIRED", "A meeting URL is required before a recorder can be scheduled.");

  const existing = await prisma.meetingRecording.findFirst({
    where: {
      workspaceId: params.workspaceId,
      meetingId: params.meetingId,
      status: { in: ACTIVE_RECORDING_STATUSES },
      meetingUrl: normalizeMeetingUrl(meetingUrl),
    },
    orderBy: { createdAt: "desc" },
  });
  if (existing) {
    recorderLog("info", "schedule_reused", {
      workspaceId: params.workspaceId,
      meetingId: params.meetingId,
      recordingId: existing.id,
      provider: existing.provider,
      status: existing.status,
    });
    return existing;
  }

  const provider = params.provider ?? config.defaultProvider;
  const fallbackProvider = !params.provider && config.fallbackProvider && config.fallbackProvider !== provider
    ? config.fallbackProvider
    : null;
  const isAdmin = actor.kind === "user"
    ? membership?.role === "ADMIN"
    : actor.scopes?.includes("support:write");
  await enforceMonthlyCap({
    workspaceId: params.workspaceId,
    config,
    estimatedMinutes: estimatedMeetingMinutes(meeting),
    allowOverride: params.mode !== "auto" && Boolean(isAdmin),
  });
  await retireMismatchedActiveRecordings({
    workspaceId: params.workspaceId,
    meetingId: params.meetingId,
    meetingUrl,
    recordedAt: meeting.recordedAt,
  });

  const reusable = await reuseFutureProviderBotIfPresent({
    workspaceId: params.workspaceId,
    meetingId: params.meetingId,
    provider,
    meetingUrl,
    joinAt: meeting.recordedAt,
  });
  if (reusable) {
    return reusable;
  }

  const inputBase = {
    meetingUrl,
    joinAt: meeting.recordedAt,
    joinMode: recorderJoinMode(meeting.recordedAt),
    botName: config.botName || DEFAULT_BOT_NAME,
    entryMessage: config.entryMessage,
  };

  const first = await attemptProviderSchedule({
    ...inputBase,
    workspaceId: params.workspaceId,
    meetingId: params.meetingId,
    provider,
  });
  if (first.status !== "FAILED" || !fallbackProvider || !first.retryable) {
    return first.recording;
  }

  const reusableFallback = await reuseFutureProviderBotIfPresent({
    workspaceId: params.workspaceId,
    meetingId: params.meetingId,
    provider: fallbackProvider,
    meetingUrl,
    joinAt: meeting.recordedAt,
  });
  if (reusableFallback) {
    recorderLog("warn", "schedule_fallback", {
      workspaceId: params.workspaceId,
      meetingId: params.meetingId,
      fromProvider: provider,
      toProvider: fallbackProvider,
      failedRecordingId: first.recording.id,
      fallbackRecordingId: reusableFallback.id,
      fallbackStatus: reusableFallback.status,
    });
    return reusableFallback;
  }

  const fallback = await attemptProviderSchedule({
    ...inputBase,
    workspaceId: params.workspaceId,
    meetingId: params.meetingId,
    provider: fallbackProvider,
  });
  recorderLog("warn", "schedule_fallback", {
    workspaceId: params.workspaceId,
    meetingId: params.meetingId,
    fromProvider: provider,
    toProvider: fallbackProvider,
    failedRecordingId: first.recording.id,
    fallbackRecordingId: fallback.recording.id,
    fallbackStatus: fallback.recording.status,
  });
  return fallback.recording;
}

type RecorderCoverageBlockerReason =
  | "no_url"
  | "url_unsupported"
  | "auto_recording_off"
  | "recorder_disabled"
  | "no_provider_config"
  | "within_lead_window"
  | "already_covered"
  | "provider_scheduling_failed";

const RECORDER_COVERAGE_BLOCKER_REASONS: RecorderCoverageBlockerReason[] = [
  "no_url",
  "url_unsupported",
  "auto_recording_off",
  "recorder_disabled",
  "no_provider_config",
  "within_lead_window",
  "already_covered",
  "provider_scheduling_failed",
];

function emptyRecorderCoverageCounts() {
  return Object.fromEntries(RECORDER_COVERAGE_BLOCKER_REASONS.map((reason) => [reason, 0])) as Record<RecorderCoverageBlockerReason, number>;
}

function effectiveMeetingRecorderUrl(meeting: {
  meetingUrl?: string | null;
  series?: { meetingUrl?: string | null } | null;
}) {
  return meeting.meetingUrl ?? meeting.series?.meetingUrl ?? null;
}

function recordingUrlMatchesMeeting(recording: { meetingUrl?: string | null }, meetingUrl: string | null) {
  return Boolean(recording.meetingUrl && meetingUrl && normalizeMeetingUrl(recording.meetingUrl) === normalizeMeetingUrl(meetingUrl));
}

function recordingCoversMeeting(recording: { status: MeetingRecordingStatus; meetingUrl?: string | null }, meetingUrl: string | null) {
  return recordingUrlMatchesMeeting(recording, meetingUrl) && (ACTIVE_RECORDING_STATUSES.includes(recording.status) || recording.status === "COMPLETED");
}

function recordingShowsSchedulingFailure(recording: { status: MeetingRecordingStatus; failureCode?: string | null }) {
  return recording.status === "FAILED"
    && recording.failureCode !== "STALE_RECORDER"
    && recording.failureCode !== MEETING_URL_CHANGED_FAILURE_CODE
    && recording.failureCode !== DUPLICATE_RECORDER_FAILURE_CODE;
}

export async function getMeetingRecorderCoverageReadiness(workspaceId: string, now = new Date()) {
  const [featureEnabled, config] = await Promise.all([
    isRecorderFeatureEnabled(workspaceId),
    getEffectiveRecorderConfig(workspaceId),
  ]);
  const providerChecks = providerRuntimeChecks(config);
  const providerConfigOk = providerCanSchedule(config);
  const to = new Date(now.getTime() + RECORDER_CALENDAR_SYNC_LOOKAHEAD_MS);
  const meetings = await prisma.meeting.findMany({
    where: {
      workspaceId,
      status: "SCHEDULED",
      archivedAt: null,
      recordedAt: { gte: now, lte: to },
    },
    orderBy: { recordedAt: "asc" },
    take: 100,
    select: {
      id: true,
      seriesId: true,
      recordedAt: true,
      scheduledEndAt: true,
      meetingUrl: true,
      series: {
        select: {
          meetingUrl: true,
        },
      },
      recordings: {
        where: {
          status: { in: [...ACTIVE_RECORDING_STATUSES, "COMPLETED", "FAILED"] },
        },
        select: {
          status: true,
          meetingUrl: true,
          failureCode: true,
        },
      },
    },
  });

  const blockerCounts = emptyRecorderCoverageCounts();
  let eligible = 0;
  const coverage = meetings.map((meeting) => {
    const effectiveUrl = effectiveMeetingRecorderUrl(meeting);
    const recorderUrl = normalizeRecorderMeetingUrl(effectiveUrl);
    const blockers = new Set<RecorderCoverageBlockerReason>();
    if (!effectiveUrl) {
      blockers.add("no_url");
    } else if (!recorderUrl?.providerSchedulable) {
      blockers.add("url_unsupported");
    }
    if (!featureEnabled || !config.enabled) {
      blockers.add("recorder_disabled");
    }
    if (!config.autoRecordEnabled) {
      blockers.add("auto_recording_off");
    }
    if (!providerConfigOk) {
      blockers.add("no_provider_config");
    }
    if (meeting.recordedAt.getTime() - now.getTime() <= AUTO_SCHEDULE_MIN_LEAD_MS) {
      blockers.add("within_lead_window");
    }

    const normalizedEffectiveUrl = recorderUrl?.url ?? null;
    const covered = meeting.recordings.some((recording) => recordingCoversMeeting(recording, normalizedEffectiveUrl));
    if (covered) {
      blockers.add("already_covered");
    } else if (meeting.recordings.some(recordingShowsSchedulingFailure)) {
      blockers.add("provider_scheduling_failed");
    }

    const blockerReasons = [...blockers];
    if (blockerReasons.length === 0) {
      eligible += 1;
    } else {
      for (const reason of blockerReasons) {
        blockerCounts[reason] += 1;
      }
    }

    return {
      meetingId: meeting.id,
      seriesId: meeting.seriesId,
      recordedAt: meeting.recordedAt,
      scheduledEndAt: meeting.scheduledEndAt,
      urlKind: recorderUrl?.kind ?? null,
      hasOccurrenceUrl: Boolean(meeting.meetingUrl),
      hasSeriesUrl: Boolean(!meeting.meetingUrl && meeting.series?.meetingUrl),
      hasRecorderCoverage: covered,
      blockerReasons,
    };
  });

  return {
    workspaceId,
    generatedAt: now,
    window: { from: now, to },
    featureEnabled,
    configEnabled: Boolean(config.enabled),
    autoRecordEnabled: Boolean(config.autoRecordEnabled),
    providerConfigOk,
    providerChecks,
    counts: {
      total: coverage.length,
      eligible,
      blockers: blockerCounts,
    },
    meetings: coverage,
  };
}

export async function setMeetingRecorderAutoRecordingForSupport(workspaceId: string, enabled: boolean) {
  if (enabled) {
    const latestSmoke = await prisma.meetingRecorderSmokeRun.findFirst({
      where: {
        workspaceId,
        status: "COMPLETED",
      },
      orderBy: { createdAt: "desc" },
    });
    invariant(latestSmoke, 400, "RECORDER_SMOKE_REQUIRED", "A completed recorder smoke run is required before enabling auto-recording.");
  }

  const defaults = defaultConfigData();
  const config = await prisma.workspaceMeetingRecorderConfig.upsert({
    where: { workspaceId },
    update: { autoRecordEnabled: enabled },
    create: {
      workspaceId,
      ...defaults,
      autoRecordEnabled: enabled,
      providerSettings: Prisma.JsonNull,
    },
  });
  const readiness = await getMeetingRecorderCoverageReadiness(workspaceId);
  return {
    workspaceId,
    autoRecordEnabled: config.autoRecordEnabled,
    configEnabled: config.enabled,
    readiness,
  };
}

export async function ensureUpcomingScheduledMeetingRecorderCoverage(workspaceId: string, now = new Date()) {
  const readiness = await getMeetingRecorderCoverageReadiness(workspaceId, now);
  let scheduled = 0;
  let providerSchedulingFailed = 0;
  const attemptedMeetingIds: string[] = [];

  for (const meeting of readiness.meetings) {
    if (meeting.blockerReasons.length > 0) continue;
    attemptedMeetingIds.push(meeting.meetingId);
    try {
      const recording = await scheduleMeetingRecording(systemRecorderActor(workspaceId), {
        workspaceId,
        meetingId: meeting.meetingId,
        mode: "auto",
      });
      if (recording.status === "FAILED") {
        providerSchedulingFailed += 1;
      } else {
        scheduled += 1;
      }
    } catch (error) {
      providerSchedulingFailed += 1;
      recorderLog("warn", "coverage_schedule_failed", {
        workspaceId,
        meetingId: meeting.meetingId,
        failureCode: providerFailureCode(error),
      });
    }
  }

  return {
    ...readiness,
    attemptedMeetingIds,
    scheduled,
    providerSchedulingFailed,
  };
}

async function attemptProviderSchedule(params: {
  workspaceId: string;
  meetingId: string;
  meetingUrl: string;
  joinAt: Date;
  joinMode: "immediate" | "scheduled";
  botName: string;
  entryMessage?: string | null;
  provider: MeetingRecorderProvider;
}) {
  const attempt = await createRecordingAttempt(params);
  const recording = attempt.recording;
  if (attempt.reused) {
    recorderLog("info", "schedule_dedupe_reused", {
      workspaceId: params.workspaceId,
      meetingId: params.meetingId,
      recordingId: recording.id,
      provider: params.provider,
      status: recording.status,
    });
    return { status: recording.status, recording, retryable: false };
  }
  recorderLog("info", "schedule_attempt", {
    workspaceId: params.workspaceId,
    meetingId: params.meetingId,
    recordingId: recording.id,
    provider: params.provider,
  });
  try {
    const scheduled = await providerSchedule(params.provider, {
      meetingUrl: params.meetingUrl,
      joinAt: params.joinAt,
      joinMode: params.joinMode,
      botName: params.botName,
      entryMessage: params.entryMessage,
      metadata: await recorderVendorMetadata({
        workspaceId: params.workspaceId,
        meetingId: params.meetingId,
        recordingId: recording.id,
      }),
    });
    const updated = await prisma.meetingRecording.update({
      where: { id: recording.id },
      data: {
        status: "SCHEDULED",
        externalBotId: scheduled.externalBotId,
        scheduledAt: new Date(),
        providerMetadata: scheduled.providerMetadata,
      },
    });
    recorderLog("info", "schedule_succeeded", {
      workspaceId: params.workspaceId,
      meetingId: params.meetingId,
      recordingId: updated.id,
      provider: updated.provider,
      externalBotId: updated.externalBotId,
    });
    return { status: updated.status, recording: updated, retryable: false };
  } catch (error) {
    const retryable = isRetryableVendorError(error);
    const failureCode = providerFailureCode(error);
    const failed = await prisma.meetingRecording.update({
      where: { id: recording.id },
      data: {
        status: "FAILED",
        activeDedupeKey: null,
        failureCode,
        failureMessage: error instanceof Error ? error.message : "Unknown recorder scheduling error.",
      },
    });
    recorderLog(retryable ? "warn" : "error", "schedule_failed", {
      workspaceId: params.workspaceId,
      meetingId: params.meetingId,
      recordingId: failed.id,
      provider: params.provider,
      failureCode,
      retryable,
    });
    return { status: failed.status, recording: failed, retryable };
  }
}

export async function cancelMeetingRecording(actor: AppActor, params: { workspaceId: string; meetingId: string }) {
  await requireWorkspaceMembership({
    actor,
    workspaceId: params.workspaceId,
    allowedRoles: ["ADMIN", "FACILITATOR"],
  });
  const recording = await prisma.meetingRecording.findFirst({
    where: {
      workspaceId: params.workspaceId,
      meetingId: params.meetingId,
      status: { in: ACTIVE_RECORDING_STATUSES },
    },
    orderBy: { createdAt: "desc" },
  });
  invariant(recording, 404, "NOT_FOUND", "No active recorder is scheduled for this meeting.");

  if (recording.externalBotId) {
    try {
      await providerCancel(recording.provider, recording.externalBotId, {
        joinAt: recording.joinAt,
        status: recording.status,
      });
    } catch (error) {
      recorderLog("error", "cancel_failed", {
        workspaceId: params.workspaceId,
        meetingId: params.meetingId,
        recordingId: recording.id,
        provider: recording.provider,
        failureCode: providerFailureCode(error),
      });
      throw error;
    }
  }

  const cancelled = await prisma.meetingRecording.update({
    where: { id: recording.id },
    data: {
      status: "CANCELLED",
      activeDedupeKey: null,
      endedAt: new Date(),
    },
  });
  recorderLog("info", "cancel_succeeded", {
    workspaceId: params.workspaceId,
    meetingId: params.meetingId,
    recordingId: cancelled.id,
    provider: cancelled.provider,
  });
  return cancelled;
}

async function cancelAutoRecordingsForMeeting(workspaceId: string, meetingId: string) {
  const recordings = await prisma.meetingRecording.findMany({
    where: {
      workspaceId,
      meetingId,
      status: { in: ACTIVE_RECORDING_STATUSES },
    },
  });
  for (const recording of recordings) {
    if (recording.externalBotId) {
      try {
        await providerCancel(recording.provider, recording.externalBotId, {
          joinAt: recording.joinAt,
          status: recording.status,
        });
      } catch (error) {
        recorderLog("warn", "calendar_cancel_failed", {
          workspaceId,
          meetingId,
          recordingId: recording.id,
          provider: recording.provider,
          failureCode: providerFailureCode(error),
        });
      }
    }
    await prisma.meetingRecording.update({
      where: { id: recording.id },
      data: {
        status: "CANCELLED",
        activeDedupeKey: null,
        endedAt: new Date(),
      },
    });
  }
}

export async function listMeetingRecordings(workspaceId: string, meetingIds: string[]) {
  if (meetingIds.length === 0) return [];
  return prisma.meetingRecording.findMany({
    where: {
      workspaceId,
      meetingId: { in: meetingIds },
    },
    orderBy: { createdAt: "desc" },
  });
}

function systemRecorderActor(workspaceId: string): AppActor {
  return {
    kind: "agent",
    authProvider: "bootstrap",
    label: "meeting-recorder",
    workspaceIds: [workspaceId],
    scopes: ["support:write"],
  };
}

export function normalizeRecallWebhook(payload: unknown): ProviderWebhookEvent {
  const root = isRecord(payload) ? payload : {};
  const data = isRecord(root.data) ? root.data : {};
  const bot = firstRecord(data.bot, root.bot);
  const transcript = firstRecord(data.transcript, root.transcript);
  const recording = firstRecord(data.recording, root.recording);
  const statusData = firstRecord(data.data, root.status);
  const metadata = firstRecord(bot?.metadata, transcript?.metadata, recording?.metadata);
  const eventType = readString(root.event) ?? "unknown";
  const status = recallStatus(eventType, readString(statusData?.code));

  return {
    eventId: readString(root.id) ?? null,
    eventType,
    externalBotId: readString(bot?.id) ?? readString(data.bot_id) ?? null,
    recordingId: readString(metadata?.recordingId),
    workspaceId: readString(metadata?.workspaceId),
    meetingId: readString(metadata?.meetingId),
    status,
    failureCode: readString(statusData?.sub_code),
    failureMessage: readString(statusData?.message) ?? readString(root.message),
    transcriptId: readString(transcript?.id),
    transcriptUrl: readString(firstRecord(transcript?.data)?.download_url),
    recordingIdForTranscript: readString(recording?.id),
    startedAt: readDate(statusData?.started_at) ?? readDate(data.started_at),
    endedAt: readDate(statusData?.updated_at) ?? readDate(data.ended_at),
    durationSeconds: readNumber(data.duration_seconds),
  };
}

function recallStatus(eventType: string, code: string | null): MeetingRecordingStatus | null {
  if (eventType === "bot.joining") return "JOINING";
  if (eventType === "bot.in_call_recording" || eventType === "recording.processing") return "RECORDING";
  if (eventType === "bot.done" || eventType === "recording.done" || eventType === "transcript.done") return "COMPLETED";
  if (eventType === "bot.failed" || eventType === "recording.failed" || eventType === "transcript.failed" || code === "failed") return "FAILED";
  if (eventType === "bot.call_ended" || eventType === "recording.deleted") return "CANCELLED";
  return null;
}

export function normalizeMeetingBaasWebhook(payload: unknown): ProviderWebhookEvent {
  const root = isRecord(payload) ? payload : {};
  const data = isRecord(root.data) ? root.data : root;
  const extra = firstRecord(data.extra, data.metadata);
  const eventType = readString(root.type) ?? readString(root.event) ?? readString(data.event) ?? "unknown";
  const externalBotId = readString(data.bot_id) ?? readString(data.id) ?? readString(root.bot_id);
  const statusRaw = readString(data.status) ?? readString(data.bot_status);
  const status = meetingBaasStatus(eventType, statusRaw);

  return {
    eventId: readString(root.id) ?? readString(data.event_id),
    eventType,
    externalBotId,
    recordingId: readString(extra?.recordingId),
    workspaceId: readString(extra?.workspaceId),
    meetingId: readString(extra?.meetingId),
    status,
    failureCode: readString(data.error_code) ?? readString(data.failure_code),
    failureMessage: readString(data.error) ?? readString(data.failure_message),
    transcriptId: null,
    transcriptUrl: readString(data.transcription),
    recordingIdForTranscript: null,
    startedAt: readDate(data.started_at),
    endedAt: readDate(data.ended_at) ?? readDate(data.updated_at),
    durationSeconds: readNumber(data.duration_seconds),
  };
}

function meetingBaasStatus(eventType: string, status: string | null): MeetingRecordingStatus | null {
  const normalized = (status ?? eventType).toLowerCase();
  if (normalized.includes("waiting") || normalized.includes("joining")) return "JOINING";
  if (normalized.includes("in_call") || normalized.includes("recording")) return "RECORDING";
  if (normalized.includes("completed") || normalized.includes("done")) return "COMPLETED";
  if (normalized.includes("failed") || normalized.includes("error")) return "FAILED";
  if (normalized.includes("cancel")) return "CANCELLED";
  return null;
}

export async function processMeetingRecorderWebhook(provider: MeetingRecorderProvider, params: {
  headers: Headers | Record<string, string>;
  rawBody: string;
}) {
  const verified = provider === "RECALL_AI"
    ? verifyRecallWebhookSignature({ headers: params.headers, payload: params.rawBody })
    : verifyMeetingBaasWebhookSignature({ headers: params.headers, payload: params.rawBody });
  if (!verified) {
    recorderLog("warn", "webhook_signature_invalid", { provider });
  }
  invariant(verified, 401, "INVALID_SIGNATURE", "Meeting recorder webhook signature is invalid.");

  const payload = JSON.parse(params.rawBody) as unknown;
  const event = provider === "RECALL_AI" ? normalizeRecallWebhook(payload) : normalizeMeetingBaasWebhook(payload);
  const dedupeKey = `${provider}:${event.eventId ?? createHash("sha256").update(params.rawBody).digest("hex")}`;
  recorderLog("info", "webhook_received", {
    provider,
    eventType: event.eventType,
    externalBotId: event.externalBotId,
    workspaceId: event.workspaceId,
    meetingId: event.meetingId,
    recordingId: event.recordingId,
  });

  const existingEvent = await prisma.meetingRecorderProviderEvent.findUnique({
    where: { dedupeKey },
    select: { id: true, processedAt: true },
  });
  if (existingEvent?.processedAt) {
    recorderLog("info", "webhook_duplicate", {
      provider,
      eventType: event.eventType,
      externalBotId: event.externalBotId,
    });
    return { processed: false, duplicate: true };
  }

  let recording = await findRecordingForWebhook(provider, event);
  const providerEvent = await prisma.meetingRecorderProviderEvent.upsert({
    where: { dedupeKey },
    update: {},
    create: {
      workspaceId: recording?.workspaceId ?? event.workspaceId,
      recordingId: recording?.id ?? event.recordingId,
      provider,
      externalEventId: event.eventId,
      externalBotId: event.externalBotId,
      eventType: event.eventType,
      dedupeKey,
      payload: redactProviderArtifactUrls(payload),
      redactedAt: new Date(),
    },
  });

  if (!recording) {
    await prisma.meetingRecorderProviderEvent.update({
      where: { id: providerEvent.id },
      data: {
        processedAt: new Date(),
        error: "No matching MeetingRecording found.",
      },
    });
    recorderLog("warn", "webhook_unmatched", {
      provider,
      eventType: event.eventType,
      externalBotId: event.externalBotId,
      workspaceId: event.workspaceId,
      meetingId: event.meetingId,
      recordingId: event.recordingId,
    });
    return { processed: false, duplicate: false };
  }

  recording = await applyWebhookState(recording, event);

  if (provider === "RECALL_AI" && event.eventType === "recording.done" && event.recordingIdForTranscript) {
    await createRecallAsyncTranscript(event.recordingIdForTranscript);
  }

  if (shouldFetchTranscript(provider, event)) {
    await ingestProviderTranscript(provider, recording, event);
  } else {
    await updateSmokeRunsForTerminalRecording(recording);
  }

  await prisma.meetingRecorderProviderEvent.update({
    where: { id: providerEvent.id },
    data: { processedAt: new Date(), recordingId: recording.id, workspaceId: recording.workspaceId },
  });
  recorderLog("info", "webhook_processed", {
    provider,
    eventType: event.eventType,
    workspaceId: recording.workspaceId,
    meetingId: recording.meetingId,
    recordingId: recording.id,
    status: recording.status,
  });
  return { processed: true, duplicate: false, recordingId: recording.id };
}

async function findRecordingForWebhook(provider: MeetingRecorderProvider, event: ProviderWebhookEvent) {
  if (event.recordingId) {
    const recording = await prisma.meetingRecording.findUnique({ where: { id: event.recordingId } });
    if (recording) return recording;
  }
  if (event.externalBotId) {
    const recording = await prisma.meetingRecording.findFirst({
      where: { provider, externalBotId: event.externalBotId },
      orderBy: { createdAt: "desc" },
    });
    if (recording) return recording;
  }
  if (event.workspaceId && event.meetingId) {
    return prisma.meetingRecording.findFirst({
      where: { workspaceId: event.workspaceId, meetingId: event.meetingId, provider },
      orderBy: { createdAt: "desc" },
    });
  }
  return null;
}

async function applyWebhookState(recording: MeetingRecording, event: ProviderWebhookEvent) {
  if (recording.failureCode === DUPLICATE_RECORDER_FAILURE_CODE) {
    return recording;
  }

  const data: Prisma.MeetingRecordingUpdateInput = {};
  if (event.externalBotId && !recording.externalBotId) data.externalBotId = event.externalBotId;
  if (event.status) data.status = event.status;
  if (event.status && !ACTIVE_RECORDING_STATUSES.includes(event.status)) data.activeDedupeKey = null;
  if (event.startedAt) data.startedAt = event.startedAt;
  if (event.endedAt) data.endedAt = event.endedAt;
  if (event.durationSeconds !== null) data.durationSeconds = Math.max(0, Math.round(event.durationSeconds));
  if (event.failureCode) data.failureCode = event.failureCode;
  if (event.failureMessage) data.failureMessage = event.failureMessage;
  if (Object.keys(data).length === 0) return recording;
  return prisma.meetingRecording.update({
    where: { id: recording.id },
    data,
  });
}

async function updateSmokeRunsForTerminalRecording(recording: MeetingRecording) {
  if (recording.status !== "FAILED" && recording.status !== "CANCELLED") {
    return;
  }

  await prisma.meetingRecorderSmokeRun.updateMany({
    where: {
      recordingId: recording.id,
      status: { in: ["PENDING", "SCHEDULED"] },
    },
    data: {
      status: recording.status === "CANCELLED" ? "CANCELLED" : "FAILED",
      failureMessage: recording.failureMessage ?? (recording.status === "CANCELLED"
        ? "Recorder run was cancelled before transcript ingestion."
        : "Recorder run failed before transcript ingestion."),
      completedAt: new Date(),
    },
  });
}

function shouldFetchTranscript(provider: MeetingRecorderProvider, event: ProviderWebhookEvent) {
  if (provider === "RECALL_AI") {
    return event.eventType === "transcript.done";
  }
  return event.eventType === "bot.completed" || event.status === "COMPLETED";
}

async function markRecordingTranscriptEmpty(
  provider: MeetingRecorderProvider,
  recording: MeetingRecording,
  artifact: { metadata: unknown },
  tx: Prisma.TransactionClient,
) {
  await tx.meetingRecording.update({
    where: { id: recording.id },
    data: {
      status: "COMPLETED",
      activeDedupeKey: null,
      transcriptProcessedAt: new Date(),
      failureCode: "RECORDER_TRANSCRIPT_EMPTY",
      failureMessage: "Provider transcript was empty.",
      providerMetadata: redactProviderArtifactUrls(artifact.metadata),
    },
  });
  await tx.meetingRecorderSmokeRun.updateMany({
    where: {
      recordingId: recording.id,
      status: { in: ["PENDING", "SCHEDULED"] },
    },
    data: {
      status: "FAILED",
      failureMessage: "Provider transcript was empty.",
      completedAt: new Date(),
    },
  });
  recorderLog("info", "transcript_empty", {
    workspaceId: recording.workspaceId,
    meetingId: recording.meetingId,
    recordingId: recording.id,
    provider,
  });
}

async function completeRecordingWithTranscriptArtifact(
  provider: MeetingRecorderProvider,
  recording: MeetingRecording,
  artifact: { transcriptPayload: unknown; metadata: unknown },
) {
  const transcript = normalizeProviderTranscript(artifact.transcriptPayload);
  const completed = await prisma.$transaction(async (tx) => {
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${`${recording.workspaceId}:${recording.meetingId}:${provider}:transcript`}, 0))`;
    const current = await tx.meetingRecording.findUnique({
      where: { id: recording.id },
      select: {
        id: true,
        workspaceId: true,
        meetingId: true,
        provider: true,
        joinAt: true,
        failureCode: true,
        transcriptProcessedAt: true,
        meeting: {
          select: {
            workspaceId: true,
          },
        },
      },
    });
    if (!current || current.transcriptProcessedAt) {
      return false;
    }
    if (current.failureCode === DUPLICATE_RECORDER_FAILURE_CODE) {
      recorderLog("info", "transcript_duplicate_ignored", {
        workspaceId: current.workspaceId,
        meetingId: current.meetingId,
        recordingId: current.id,
        provider,
        failureCode: DUPLICATE_RECORDER_FAILURE_CODE,
      });
      return false;
    }

    invariant(
      current.workspaceId === recording.workspaceId
      && current.meetingId === recording.meetingId
      && current.meeting?.workspaceId === recording.workspaceId,
      409,
      "RECORDER_WORKSPACE_MISMATCH",
      "Recorder transcript target does not match the recording workspace.",
    );

    const alreadyProcessedDuplicate = await tx.meetingRecording.findFirst({
      where: {
        workspaceId: current.workspaceId,
        meetingId: current.meetingId,
        provider: current.provider,
        id: { not: current.id },
        transcriptProcessedAt: { not: null },
        failureCode: null,
        ...(current.joinAt ? { joinAt: current.joinAt } : {}),
      },
      select: { id: true },
    });
    if (alreadyProcessedDuplicate) {
      await tx.meetingRecording.update({
        where: { id: current.id },
        data: {
          status: "SKIPPED",
          activeDedupeKey: null,
          endedAt: new Date(),
          failureCode: DUPLICATE_RECORDER_FAILURE_CODE,
          failureMessage: duplicateRecorderFailureMessage(alreadyProcessedDuplicate.id),
        },
      });
      recorderLog("warn", "transcript_duplicate_skipped", {
        workspaceId: current.workspaceId,
        meetingId: current.meetingId,
        recordingId: current.id,
        provider,
        canonicalRecordingId: alreadyProcessedDuplicate.id,
        failureCode: DUPLICATE_RECORDER_FAILURE_CODE,
      });
      return false;
    }

    if (transcript.trim().length === 0) {
      await markRecordingTranscriptEmpty(provider, recording, artifact, tx);
      return false;
    }

    const actor = systemRecorderActor(recording.workspaceId);
    await intakeMeetingTranscript(actor, {
      workspaceId: recording.workspaceId,
      meetingId: recording.meetingId,
      source: `recorder:${provider.toLowerCase()}`,
      recordedAt: recording.startedAt ?? recording.joinAt ?? recording.createdAt,
      transcript,
      allowTranscriptAppend: true,
    });

    await tx.meetingRecording.update({
      where: { id: recording.id },
      data: {
        status: "COMPLETED",
        activeDedupeKey: null,
        transcriptProcessedAt: new Date(),
        failureCode: null,
        failureMessage: null,
        providerMetadata: redactProviderArtifactUrls(artifact.metadata),
      },
    });
    await tx.meetingRecorderSmokeRun.updateMany({
      where: {
        recordingId: recording.id,
        status: { in: ["PENDING", "SCHEDULED"] },
      },
      data: {
        status: "COMPLETED",
        completedAt: new Date(),
      },
    });
    return true;
  }, { timeout: 120_000 });

  if (completed) {
    recorderLog("info", "transcript_ingested", {
      workspaceId: recording.workspaceId,
      meetingId: recording.meetingId,
      recordingId: recording.id,
      provider,
    });
  }
  return completed;
}

async function ingestProviderTranscript(provider: MeetingRecorderProvider, recording: MeetingRecording, event: ProviderWebhookEvent) {
  if (recording.transcriptProcessedAt || recording.failureCode === DUPLICATE_RECORDER_FAILURE_CODE) {
    return;
  }
  const artifact = provider === "RECALL_AI"
    ? await fetchRecallTranscriptArtifact({
      transcriptId: event.transcriptId,
      transcriptUrl: event.transcriptUrl,
      externalBotId: recording.externalBotId,
    })
    : await fetchMeetingBaasTranscriptArtifact(recording.externalBotId ?? event.externalBotId ?? "", event.transcriptUrl);
  await completeRecordingWithTranscriptArtifact(provider, recording, artifact);
}

export function calendarEventIsEligible(event: CalendarEventForRecorder, now = new Date()) {
  if (!event.meetingUrl) return false;
  if (event.status?.toLowerCase() === "cancelled" || event.status?.toLowerCase() === "canceled") return false;
  if (event.responseStatus?.toLowerCase() === "declined") return false;
  if (event.transparency?.toLowerCase() === "transparent" || event.transparency?.toLowerCase() === "free") return false;
  if (event.endTime <= now || event.startTime.getTime() - now.getTime() <= AUTO_SCHEDULE_MIN_LEAD_MS) return false;
  if (event.visibility?.toLowerCase() === "private") return false;
  return true;
}

export async function syncCalendarEventRecorder(params: {
  workspaceId: string;
  connectionId: string;
  event: CalendarEventForRecorder;
  now?: Date;
}) {
  if (!await isRecorderFeatureEnabled(params.workspaceId)) {
    return { action: "feature_disabled" as const };
  }

  const config = await getEffectiveRecorderConfig(params.workspaceId);
  if (!config.enabled || !config.autoRecordEnabled) {
    return { action: "config_disabled" as const };
  }

  const event = params.event;
  const externalId = `calendar:${event.provider.toLowerCase()}:${event.id}`;
  const existingByExternal = await prisma.meeting.findFirst({
    where: {
      workspaceId: params.workspaceId,
      OR: [
        { externalId },
        { calendarExternalId: event.id },
      ],
    },
    select: { id: true },
  });

  if (!calendarEventIsEligible(event, params.now)) {
    if (existingByExternal) {
      await cancelAutoRecordingsForMeeting(params.workspaceId, existingByExternal.id);
      return { action: "cancelled" as const, meetingId: existingByExternal.id };
    }
    return { action: "skipped" as const };
  }

  const url = event.meetingUrl as string;
  const urlHash = meetingUrlHash(url);
  const existingByUrl = await prisma.meeting.findFirst({
    where: {
      workspaceId: params.workspaceId,
      meetingUrlHash: urlHash,
      recordedAt: event.startTime,
      archivedAt: null,
    },
    select: { id: true, participantEmails: true },
  });

  const participantEmails = normalizeEmails([
    ...event.attendees,
    event.organizerEmail ?? "",
  ]);
  const meeting = existingByUrl
    ? await prisma.meeting.update({
      where: { id: existingByUrl.id },
      data: {
        title: event.title || "Untitled meeting",
        source: `calendar:${event.provider.toLowerCase()}`,
        calendarExternalId: event.id,
        meetingUrl: url,
        meetingUrlHash: urlHash,
        recordedAt: event.startTime,
        scheduledEndAt: event.endTime,
        participantEmails: normalizeEmails([...existingByUrl.participantEmails, ...participantEmails]),
      },
    })
    : await prisma.meeting.upsert({
      where: { externalId },
      update: {
        title: event.title || "Untitled meeting",
        source: `calendar:${event.provider.toLowerCase()}`,
        calendarExternalId: event.id,
        meetingUrl: url,
        meetingUrlHash: urlHash,
        recordedAt: event.startTime,
        scheduledEndAt: event.endTime,
        participantEmails,
      },
      create: {
        workspaceId: params.workspaceId,
        title: event.title || "Untitled meeting",
        source: `calendar:${event.provider.toLowerCase()}`,
        externalId,
        calendarExternalId: event.id,
        meetingUrl: url,
        meetingUrlHash: urlHash,
        status: "SCHEDULED",
        recordedAt: event.startTime,
        scheduledEndAt: event.endTime,
        participantIds: [],
        participantEmails,
      },
    });

  const recording = await scheduleMeetingRecording(systemRecorderActor(params.workspaceId), {
    workspaceId: params.workspaceId,
    meetingId: meeting.id,
    mode: "auto",
  });
  recorderLog("info", "calendar_event_scheduled", {
    workspaceId: params.workspaceId,
    meetingId: meeting.id,
    recordingId: recording.id,
    provider: recording.provider,
  });
  return { action: "scheduled" as const, meeting, recording };
}

type RecoverableRecallRecording = MeetingRecording & {
  meeting: {
    recordedAt: Date;
    scheduledEndAt: Date | null;
  };
};

function recallRecoveryReadyAt(recording: RecoverableRecallRecording) {
  const expectedEnd = recordingExpectedEnd(recording);
  return new Date(expectedEnd.getTime() + RECALL_TRANSCRIPT_RECOVERY_GRACE_MS);
}

function groupRecoverableRecallRecordings(recordings: RecoverableRecallRecording[]) {
  const groups = new Map<string, RecoverableRecallRecording[]>();
  for (const recording of recordings) {
    const key = duplicateRecorderGroupKey(recording);
    if (!key) continue;
    groups.set(key, [...(groups.get(key) ?? []), recording]);
  }
  return groups;
}

async function markDuplicateRecoveredRecordingsSkipped(group: RecoverableRecallRecording[], canonicalId: string) {
  let skipped = 0;
  for (const recording of group.filter((item) => item.id !== canonicalId && !item.transcriptProcessedAt)) {
    if (ACTIVE_RECORDING_STATUSES.includes(recording.status)) {
      if (!recording.externalBotId) {
        recorderLog("warn", "reconcile_recall_duplicate_active_missing_bot", {
          workspaceId: recording.workspaceId,
          meetingId: recording.meetingId,
          recordingId: recording.id,
          provider: recording.provider,
          canonicalRecordingId: canonicalId,
        });
        continue;
      }
      try {
        await providerCancel(recording.provider, recording.externalBotId, {
          joinAt: recorderJoinInstant(recording),
          status: recording.status,
        });
      } catch (error) {
        recorderLog("warn", "reconcile_recall_duplicate_cancel_failed", {
          workspaceId: recording.workspaceId,
          meetingId: recording.meetingId,
          recordingId: recording.id,
          provider: recording.provider,
          canonicalRecordingId: canonicalId,
          failureCode: providerFailureCode(error),
        });
        continue;
      }
    }
    await prisma.meetingRecording.update({
      where: { id: recording.id },
      data: {
        status: "SKIPPED",
        activeDedupeKey: null,
        endedAt: new Date(),
        failureCode: DUPLICATE_RECORDER_FAILURE_CODE,
        failureMessage: duplicateRecorderFailureMessage(canonicalId),
      },
    });
    skipped += 1;
  }
  return skipped;
}

async function findRecoverableRecallRecording(recordingId: string) {
  const recording = await prisma.meetingRecording.findUnique({
    where: { id: recordingId },
    include: {
      meeting: {
        select: {
          recordedAt: true,
          scheduledEndAt: true,
        },
      },
    },
  });
  if (!recording || recording.provider !== "RECALL_AI") {
    return null;
  }
  return recording as RecoverableRecallRecording;
}

function recallBotTerminalStatus(bot: unknown) {
  const data = isRecord(bot) && isRecord(bot.data) ? bot.data : bot;
  if (!isRecord(data)) return null;

  const direct = readString(data.status) ?? readString(data.status_code);
  if (direct) return direct.toLowerCase();

  const changes = Array.isArray(data.status_changes) ? data.status_changes : [];
  for (let index = changes.length - 1; index >= 0; index -= 1) {
    const change = isRecord(changes[index]) ? changes[index] : {};
    const nested = firstRecord(change.data, change.status);
    const code = readString(change.code)
      ?? readString(change.status)
      ?? readString(nested?.code)
      ?? readString(nested?.status);
    if (code) return code.toLowerCase();
  }
  return null;
}

function recallBotIsDone(bot: unknown) {
  return recallBotTerminalStatus(bot) === "done";
}

function normalizedRecallFailureCode(value: string | null | undefined) {
  const normalized = value?.toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_+|_+$/g, "");
  return normalized || "recall_bot_failed";
}

function recallBotTerminalFailure(bot: unknown) {
  const status = recallBotTerminalStatus(bot);
  if (status !== "fatal" && status !== "failed") {
    return null;
  }

  const data = isRecord(bot) && isRecord(bot.data) ? bot.data : bot;
  const changes = isRecord(data) && Array.isArray(data.status_changes) ? data.status_changes : [];
  const latest = changes.length > 0 && isRecord(changes[changes.length - 1]) ? changes[changes.length - 1] : {};
  const nested = firstRecord(latest.data, latest.status);
  const vendorCode = readString(latest.sub_code)
    ?? readString(nested?.sub_code)
    ?? readString(latest.code)
    ?? readString(latest.status)
    ?? readString(nested?.code)
    ?? readString(nested?.status)
    ?? status;
  const message = readString(latest.message)
    ?? readString(nested?.message)
    ?? `Recall bot reached terminal status: ${vendorCode}.`;

  return {
    failureCode: normalizedRecallFailureCode(vendorCode),
    failureMessage: message,
  };
}

function terminalRecallCheckReady(recording: RecordingWithMeetingTime) {
  const joinAt = recorderJoinInstant(recording);
  if (!joinAt) return false;
  const deltaMs = joinAt.getTime() - Date.now();
  return deltaMs <= AUTO_SCHEDULE_MIN_LEAD_MS && deltaMs >= -RECALL_TERMINAL_STATUS_CHECK_GRACE_MS;
}

function transcriptRecoveryIsPending(error: unknown) {
  if (error instanceof AppError) {
    return error.code === "RECORDER_TRANSCRIPT_NOT_READY";
  }
  if (error instanceof ProviderRequestError) {
    return error.status === 404 || RETRYABLE_VENDOR_STATUSES.has(error.status);
  }
  return false;
}

async function terminalizeRecordingWithLock(
  recording: { id: string; workspaceId: string; meetingId: string; provider: string },
  failureCode: string,
  failureMessage: string,
) {
  return await prisma.$transaction(async (tx) => {
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${`${recording.workspaceId}:${recording.meetingId}:${recording.provider}:transcript`}, 0))`;
    const current = await tx.meetingRecording.findUnique({
      where: { id: recording.id },
      select: { transcriptProcessedAt: true, status: true, failureCode: true },
    });
    if (!current || current.transcriptProcessedAt) {
      return false;
    }

    const isRecoverableStatus = (RECOVERABLE_RECALL_RECORDING_STATUSES as string[]).includes(current.status);
    const isStaleFailed = current.status === "FAILED" && current.failureCode === "STALE_RECORDER";

    if (!isRecoverableStatus && !isStaleFailed) {
      return false;
    }

    await tx.meetingRecording.update({
      where: { id: recording.id },
      data: {
        status: "FAILED",
        activeDedupeKey: null,
        failureCode,
        failureMessage,
        transcriptProcessedAt: new Date(),
      },
    });

    await tx.meetingRecorderSmokeRun.updateMany({
      where: {
        recordingId: recording.id,
        status: { in: ["PENDING", "SCHEDULED"] },
      },
      data: {
        status: "FAILED",
        failureMessage,
        completedAt: new Date(),
      },
    });
    return true;
  });
}

async function recoverRecallTranscripts(workspaceId: string) {
  const now = new Date();
  const recordings = await prisma.meetingRecording.findMany({
    where: {
      workspaceId,
      provider: "RECALL_AI",
      transcriptProcessedAt: null,
      externalBotId: { not: null },
      OR: [
        { status: { in: RECOVERABLE_RECALL_RECORDING_STATUSES } },
        { status: "FAILED", failureCode: "STALE_RECORDER" },
      ],
    },
    include: {
      meeting: {
        select: {
          recordedAt: true,
          scheduledEndAt: true,
        },
      },
    },
  }) as RecoverableRecallRecording[];

  let recovered = 0;
  for (const group of groupRecoverableRecallRecordings(recordings).values()) {
    const candidates = [...group]
      .filter((recording) => recording.externalBotId && recallRecoveryReadyAt(recording) <= now)
      .sort(compareCanonicalRecordings);

    for (const recording of candidates) {
      if (!recording.externalBotId) {
        continue;
      }

      const expectedEnd = recordingExpectedEnd(recording);
      if (now.getTime() - expectedEnd.getTime() >= 24 * 60 * 60 * 1000) {
        const terminalized = await terminalizeRecordingWithLock(
          recording,
          "RECORDER_TRANSCRIPT_RECOVERY_EXPIRED",
          "Transcript recovery expired after 24 hours.",
        );
        if (terminalized) {
          recorderLog("warn", "reconcile_recall_transcript_expired", {
            workspaceId,
            meetingId: recording.meetingId,
            recordingId: recording.id,
            provider: recording.provider,
          });
        }
        continue;
      }

      try {
        const current = await findRecoverableRecallRecording(recording.id);
        if (!current || current.transcriptProcessedAt || !current.externalBotId) {
          continue;
        }

        try {
          const bot = await fetchRecallBot(current.externalBotId);
          if (!recallBotIsDone(bot)) {
            continue;
          }
        } catch (error) {
          if (transcriptRecoveryIsPending(error)) {
            recorderLog("warn", "recall_bot_status_fetch_failed", {
              workspaceId,
              meetingId: recording.meetingId,
              recordingId: recording.id,
              provider: recording.provider,
              failureCode: providerFailureCode(error),
            });
            continue;
          }
          throw error;
        }
        const artifact = await fetchRecallTranscriptArtifact({ externalBotId: current.externalBotId });
        const latest = await findRecoverableRecallRecording(recording.id);
        if (!latest || latest.transcriptProcessedAt || !latest.externalBotId) {
          continue;
        }

        const completed = await completeRecordingWithTranscriptArtifact("RECALL_AI", latest, artifact);
        if (completed) {
          recovered += 1;
          const skipped = await markDuplicateRecoveredRecordingsSkipped(group, latest.id);
          recorderLog("info", "reconcile_recall_transcript_recovered", {
            workspaceId,
            meetingId: latest.meetingId,
            recordingId: latest.id,
            provider: latest.provider,
            duplicateRecordersSkipped: skipped,
          });
          break;
        }
      } catch (error) {
        if (transcriptRecoveryIsPending(error)) {
          recorderLog("info", "reconcile_recall_transcript_pending", {
            workspaceId,
            meetingId: recording.meetingId,
            recordingId: recording.id,
            provider: recording.provider,
            failureCode: providerFailureCode(error),
          });
          continue;
        }
        if (error instanceof ProviderRequestError) {
          const terminalized = await terminalizeRecordingWithLock(
            recording,
            "RECORDER_TRANSCRIPT_FETCH_FAILED",
            "Non-retryable transcript fetch error.",
          );
          if (terminalized) {
            recorderLog("warn", "reconcile_recall_transcript_failed", {
              workspaceId,
              meetingId: recording.meetingId,
              recordingId: recording.id,
              provider: recording.provider,
              failureCode: providerFailureCode(error),
            });
          }
          continue;
        }
        recorderLog("warn", "reconcile_recall_transcript_failed", {
          workspaceId,
          meetingId: recording.meetingId,
          recordingId: recording.id,
          provider: recording.provider,
          failureCode: providerFailureCode(error),
        });
      }
    }
  }

  return recovered;
}

export async function reconcileMeetingRecorders(workspaceId: string) {
  const recoveredTranscripts = await recoverRecallTranscripts(workspaceId);
  const duplicateCleanup = await cleanupDuplicateScheduledProviderBots(workspaceId);
  const staleCandidates = await prisma.meetingRecording.findMany({
    where: {
      workspaceId,
      status: { in: ACTIVE_RECORDING_STATUSES },
      OR: [
        {
          externalBotId: null,
          createdAt: { lt: new Date(Date.now() - STALE_RECORDING_TIMEOUT_MS) },
        },
        {
          externalBotId: { not: null },
        },
      ],
    },
    include: {
      meeting: {
        select: {
          recordedAt: true,
          scheduledEndAt: true,
        },
      },
    },
  }) as RecordingWithMeetingTime[];
  let terminalFailed = 0;
  const terminalFailedIds = new Set<string>();
  for (const recording of staleCandidates) {
    if (recording.provider !== "RECALL_AI" || !recording.externalBotId || !terminalRecallCheckReady(recording)) {
      continue;
    }
    try {
      const bot = await fetchRecallBot(recording.externalBotId);
      const failure = recallBotTerminalFailure(bot);
      if (!failure) {
        continue;
      }
      await prisma.meetingRecording.update({
        where: { id: recording.id },
        data: {
          status: "FAILED",
          activeDedupeKey: null,
          failureCode: failure.failureCode,
          failureMessage: failure.failureMessage,
          endedAt: new Date(),
        },
      });
      terminalFailed += 1;
      terminalFailedIds.add(recording.id);
      recorderLog("warn", "reconcile_recall_terminal_failed", {
        workspaceId,
        meetingId: recording.meetingId,
        recordingId: recording.id,
        provider: recording.provider,
        previousStatus: recording.status,
        failureCode: failure.failureCode,
      });
    } catch (error) {
      recorderLog("warn", "reconcile_recall_terminal_check_failed", {
        workspaceId,
        meetingId: recording.meetingId,
        recordingId: recording.id,
        provider: recording.provider,
        failureCode: providerFailureCode(error),
      });
    }
  }

  const stale = staleCandidates.filter((recording) => !terminalFailedIds.has(recording.id) && staleRecordingReadyAt(recording).getTime() <= Date.now());
  let staleFailed = 0;
  for (const recording of stale) {
    if (recording.externalBotId) {
      try {
        await providerCancel(recording.provider, recording.externalBotId, {
          joinAt: recorderJoinInstant(recording),
          status: recording.status,
        });
      } catch (error) {
        recorderLog("warn", "reconcile_stale_cancel_failed", {
          workspaceId,
          meetingId: recording.meetingId,
          recordingId: recording.id,
          provider: recording.provider,
          failureCode: providerFailureCode(error),
        });
      }
    }
    await prisma.meetingRecording.update({
      where: { id: recording.id },
      data: {
        status: "FAILED",
        activeDedupeKey: null,
        failureCode: "STALE_RECORDER",
        failureMessage: "Recorder did not complete before the reconciliation timeout.",
        endedAt: new Date(),
      },
    });
    await prisma.meetingRecorderSmokeRun.updateMany({
      where: {
        recordingId: recording.id,
        status: { in: ["PENDING", "SCHEDULED"] },
      },
      data: {
        status: "FAILED",
        failureMessage: "Recorder did not complete before the reconciliation timeout.",
        completedAt: new Date(),
      },
    });
    staleFailed += 1;
    recorderLog("warn", "reconcile_stale_failed", {
      workspaceId,
      meetingId: recording.meetingId,
      recordingId: recording.id,
      provider: recording.provider,
      previousStatus: recording.status,
      failureCode: "stale_recorder",
    });
  }
  const coverage = await ensureUpcomingScheduledMeetingRecorderCoverage(workspaceId);
  await prisma.meetingRecorderProviderEvent.updateMany({
    where: {
      workspaceId,
      redactedAt: null,
    },
    data: {
      redactedAt: new Date(),
    },
  });
  return {
    staleFailed,
    terminalFailed,
    recoveredTranscripts,
    scheduledUpcomingRecorders: coverage.scheduled,
    upcomingRecorderCoverage: coverage.counts,
    providerSchedulingFailures: coverage.providerSchedulingFailed,
    duplicateRecordersSkipped: duplicateCleanup.duplicateRecordersSkipped,
    duplicateProviderBotsCancelled: duplicateCleanup.duplicateProviderBotsCancelled,
    canonicalRecordingsRestored: duplicateCleanup.canonicalRecordingsRestored,
    duplicateCancellationFailures: duplicateCleanup.duplicateCancellationFailures,
  };
}
