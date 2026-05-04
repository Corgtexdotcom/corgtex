import { createHash, createHmac, timingSafeEqual } from "node:crypto";
import { Prisma, type MeetingRecorderProvider, type MeetingRecording, type MeetingRecordingStatus, type OAuthProvider } from "@prisma/client";
import { env, prisma } from "@corgtex/shared";
import type { AppActor } from "@corgtex/shared";
import { requireWorkspaceMembership } from "./auth";
import { AppError, invariant } from "./errors";
import { uploadMeetingTranscript } from "./meetings";

export const MEETING_RECORDERS_FEATURE_FLAG = "MEETING_RECORDERS";

const DEFAULT_BOT_NAME = "Corgtex Recorder";
const DEFAULT_ENTRY_MESSAGE = "Corgtex Recorder is joining to transcribe this meeting for the workspace.";
const DEFAULT_MONTHLY_MINUTE_CAP = 6000;
const AUTO_SCHEDULE_MIN_LEAD_MS = 10 * 60 * 1000;
const STALE_RECORDING_TIMEOUT_MS = 6 * 60 * 60 * 1000;
const ACTIVE_RECORDING_STATUSES: MeetingRecordingStatus[] = ["PENDING", "SCHEDULED", "JOINING", "RECORDING"];
const RETRYABLE_VENDOR_STATUSES = new Set([408, 409, 425, 429, 500, 502, 503, 504, 507]);

export type MeetingRecorderScheduleInput = {
  meetingUrl: string;
  joinAt: Date;
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

type CalendarEventForRecorder = {
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

type ScheduleAttemptResult = {
  externalBotId: string;
  providerMetadata?: Prisma.InputJsonValue;
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

export function normalizeMeetingUrl(value: string) {
  try {
    const url = new URL(value.trim());
    url.hash = "";
    url.hostname = url.hostname.toLowerCase();
    if (url.hostname.includes("zoom.us")) {
      url.searchParams.sort();
    }
    return url.toString();
  } catch {
    return value.trim();
  }
}

export function meetingUrlHash(value: string) {
  return createHash("sha256").update(normalizeMeetingUrl(value)).digest("hex");
}

function firstRecord(...values: unknown[]) {
  return values.find(isRecord) as Record<string, unknown> | undefined;
}

function jsonValue(value: unknown): Prisma.InputJsonValue {
  return JSON.parse(JSON.stringify(value ?? null)) as Prisma.InputJsonValue;
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
    join_at: input.joinAt.toISOString(),
    recording_config: {
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
    join_at: input.joinAt.toISOString(),
    transcription_enabled: true,
    transcription_config: {
      provider: "gladia",
    },
    allow_multiple_bots: false,
    extra: input.metadata,
  };
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
    url: "https://api.meetingbaas.com/v2/bots/scheduled",
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

async function fetchJson(url: string, init: RequestInit) {
  const response = await fetch(url, init);
  const text = await response.text();
  if (!response.ok) {
    throw new ProviderRequestError(url.includes("meetingbaas") ? "MEETING_BAAS" : "RECALL_AI", response.status, text);
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

async function cancelRecallBot(externalBotId: string) {
  const apiKey = requireVendorSecret("RECALL_AI");
  await fetchJson(`https://${env.RECALL_REGION}.recall.ai/api/v1/bot/${externalBotId}/leave_call/`, {
    method: "POST",
    headers: {
      Authorization: recallAuthorization(apiKey),
      accept: "application/json",
      "content-type": "application/json",
    },
  });
}

async function cancelMeetingBaasBot(externalBotId: string) {
  const apiKey = requireVendorSecret("MEETING_BAAS");
  await fetchJson(`https://api.meetingbaas.com/v2/bots/${externalBotId}`, {
    method: "DELETE",
    headers: {
      "x-meeting-baas-api-key": apiKey,
    },
  });
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
    metadata = await fetchJson(`https://${env.RECALL_REGION}.recall.ai/api/v1/bot/${params.externalBotId}/`, {
      headers: {
        Authorization: recallAuthorization(apiKey),
        accept: "application/json",
      },
    });
    downloadUrl = findFirstUrl(metadata, "download_url");
  }

  invariant(downloadUrl, 404, "RECORDER_TRANSCRIPT_NOT_READY", "Recall transcript is not ready.");
  const transcriptPayload = await fetchJson(downloadUrl, {
    headers: {
      Authorization: recallAuthorization(apiKey),
      accept: "application/json",
    },
  });
  return { transcriptPayload, metadata };
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

function findFirstUrl(value: unknown, keyHint: string): string | null {
  if (isRecord(value)) {
    for (const [key, item] of Object.entries(value)) {
      if (key === keyHint && typeof item === "string" && item.startsWith("http")) {
        return item;
      }
      const nested = findFirstUrl(item, keyHint);
      if (nested) return nested;
    }
  }
  if (Array.isArray(value)) {
    for (const item of value) {
      const nested = findFirstUrl(item, keyHint);
      if (nested) return nested;
    }
  }
  return null;
}

function providerSchedule(provider: MeetingRecorderProvider, input: MeetingRecorderScheduleInput) {
  return provider === "RECALL_AI" ? scheduleRecallBot(input) : scheduleMeetingBaasBot(input);
}

async function providerCancel(provider: MeetingRecorderProvider, externalBotId: string) {
  if (provider === "RECALL_AI") {
    await cancelRecallBot(externalBotId);
    return;
  }
  await cancelMeetingBaasBot(externalBotId);
}

function isRetryableVendorError(error: unknown) {
  return error instanceof ProviderRequestError && RETRYABLE_VENDOR_STATUSES.has(error.status);
}

export function normalizeProviderTranscript(payload: unknown) {
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
  return prisma.meetingRecording.create({
    data: {
      workspaceId: params.workspaceId,
      meetingId: params.meetingId,
      provider: params.provider,
      meetingUrl: normalizeMeetingUrl(params.meetingUrl),
      joinAt: params.joinAt,
      status: "PENDING",
    },
  });
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
      },
    }),
  ]);
  invariant(config.enabled, 403, "RECORDER_DISABLED", "Meeting recorder is disabled for this workspace.");
  invariant(meeting, 404, "NOT_FOUND", "Meeting not found.");
  invariant(meeting.meetingUrl, 400, "MEETING_URL_REQUIRED", "A meeting URL is required before a recorder can be scheduled.");

  const existing = await prisma.meetingRecording.findFirst({
    where: {
      workspaceId: params.workspaceId,
      meetingId: params.meetingId,
      status: { in: ACTIVE_RECORDING_STATUSES },
    },
    orderBy: { createdAt: "desc" },
  });
  if (existing) {
    return existing;
  }

  const isAdmin = actor.kind === "user"
    ? membership?.role === "ADMIN"
    : actor.scopes?.includes("support:write");
  await enforceMonthlyCap({
    workspaceId: params.workspaceId,
    config,
    estimatedMinutes: estimatedMeetingMinutes(meeting),
    allowOverride: params.mode !== "auto" && Boolean(isAdmin),
  });

  const provider = params.provider ?? config.defaultProvider;
  const fallbackProvider = !params.provider && config.fallbackProvider && config.fallbackProvider !== provider
    ? config.fallbackProvider
    : null;
  const inputBase = {
    meetingUrl: meeting.meetingUrl,
    joinAt: meeting.recordedAt,
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

  const fallback = await attemptProviderSchedule({
    ...inputBase,
    workspaceId: params.workspaceId,
    meetingId: params.meetingId,
    provider: fallbackProvider,
  });
  return fallback.recording;
}

async function attemptProviderSchedule(params: {
  workspaceId: string;
  meetingId: string;
  meetingUrl: string;
  joinAt: Date;
  botName: string;
  entryMessage?: string | null;
  provider: MeetingRecorderProvider;
}) {
  const recording = await createRecordingAttempt(params);
  try {
    const scheduled = await providerSchedule(params.provider, {
      meetingUrl: params.meetingUrl,
      joinAt: params.joinAt,
      botName: params.botName,
      entryMessage: params.entryMessage,
      metadata: {
        workspaceId: params.workspaceId,
        meetingId: params.meetingId,
        recordingId: recording.id,
      },
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
    return { status: updated.status, recording: updated, retryable: false };
  } catch (error) {
    const retryable = isRetryableVendorError(error);
    const failed = await prisma.meetingRecording.update({
      where: { id: recording.id },
      data: {
        status: "FAILED",
        failureCode: error instanceof ProviderRequestError ? `HTTP_${error.status}` : "SCHEDULE_FAILED",
        failureMessage: error instanceof Error ? error.message : "Unknown recorder scheduling error.",
      },
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
    await providerCancel(recording.provider, recording.externalBotId);
  }

  return prisma.meetingRecording.update({
    where: { id: recording.id },
    data: {
      status: "CANCELLED",
      endedAt: new Date(),
    },
  });
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
        await providerCancel(recording.provider, recording.externalBotId);
      } catch (error) {
        console.warn("Failed to cancel recorder bot during calendar sync.", error);
      }
    }
    await prisma.meetingRecording.update({
      where: { id: recording.id },
      data: {
        status: "CANCELLED",
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
  invariant(verified, 401, "INVALID_SIGNATURE", "Meeting recorder webhook signature is invalid.");

  const payload = JSON.parse(params.rawBody) as unknown;
  const event = provider === "RECALL_AI" ? normalizeRecallWebhook(payload) : normalizeMeetingBaasWebhook(payload);
  const dedupeKey = `${provider}:${event.eventId ?? createHash("sha256").update(params.rawBody).digest("hex")}`;

  const existingEvent = await prisma.meetingRecorderProviderEvent.findUnique({
    where: { dedupeKey },
    select: { id: true, processedAt: true },
  });
  if (existingEvent?.processedAt) {
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
    return { processed: false, duplicate: false };
  }

  recording = await applyWebhookState(recording, event);

  if (provider === "RECALL_AI" && event.eventType === "recording.done" && event.recordingIdForTranscript) {
    await createRecallAsyncTranscript(event.recordingIdForTranscript);
  }

  if (shouldFetchTranscript(provider, event)) {
    await ingestProviderTranscript(provider, recording, event);
  }

  await prisma.meetingRecorderProviderEvent.update({
    where: { id: providerEvent.id },
    data: { processedAt: new Date(), recordingId: recording.id, workspaceId: recording.workspaceId },
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
  const data: Prisma.MeetingRecordingUpdateInput = {};
  if (event.externalBotId && !recording.externalBotId) data.externalBotId = event.externalBotId;
  if (event.status) data.status = event.status;
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

function shouldFetchTranscript(provider: MeetingRecorderProvider, event: ProviderWebhookEvent) {
  if (provider === "RECALL_AI") {
    return event.eventType === "transcript.done";
  }
  return event.eventType === "bot.completed" || event.status === "COMPLETED";
}

async function ingestProviderTranscript(provider: MeetingRecorderProvider, recording: MeetingRecording, event: ProviderWebhookEvent) {
  if (recording.transcriptProcessedAt) {
    return;
  }
  const artifact = provider === "RECALL_AI"
    ? await fetchRecallTranscriptArtifact({
      transcriptId: event.transcriptId,
      transcriptUrl: event.transcriptUrl,
      externalBotId: recording.externalBotId,
    })
    : await fetchMeetingBaasTranscriptArtifact(recording.externalBotId ?? event.externalBotId ?? "", event.transcriptUrl);
  const transcript = normalizeProviderTranscript(artifact.transcriptPayload);
  invariant(transcript.trim().length > 0, 422, "RECORDER_TRANSCRIPT_EMPTY", "Provider transcript was empty.");

  const actor = systemRecorderActor(recording.workspaceId);
  await uploadMeetingTranscript(actor, {
    workspaceId: recording.workspaceId,
    meetingId: recording.meetingId,
    source: `recorder:${provider.toLowerCase()}`,
    recordedAt: recording.startedAt ?? recording.joinAt ?? recording.createdAt,
    transcript,
  });

  await prisma.meetingRecording.update({
    where: { id: recording.id },
    data: {
      status: "COMPLETED",
      transcriptProcessedAt: new Date(),
      providerMetadata: redactProviderArtifactUrls(artifact.metadata),
    },
  });
}

export function extractSupportedMeetingUrlFromText(value?: string | null) {
  if (!value) return null;
  const patterns = [
    /https:\/\/meet\.google\.com\/[a-z0-9-]+/i,
    /https:\/\/(?:[\w.-]+\.)?zoom\.us\/j\/[^\s<>"']+/i,
    /https:\/\/teams\.microsoft\.com\/l\/meetup-join\/[^\s<>"']+/i,
  ];
  for (const pattern of patterns) {
    const match = value.match(pattern);
    if (match?.[0]) {
      return normalizeMeetingUrl(match[0]);
    }
  }
  return null;
}

function calendarEventIsEligible(event: CalendarEventForRecorder, now = new Date()) {
  if (!event.meetingUrl) return false;
  if (event.status?.toLowerCase() === "cancelled" || event.status?.toLowerCase() === "canceled") return false;
  if (event.responseStatus?.toLowerCase() === "declined") return false;
  if (event.transparency?.toLowerCase() === "transparent" || event.transparency?.toLowerCase() === "free") return false;
  if (event.endTime <= now || event.startTime.getTime() - now.getTime() <= AUTO_SCHEDULE_MIN_LEAD_MS) return false;
  if (event.visibility?.toLowerCase() === "private" && !event.title && !event.meetingUrl) return false;
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
  return { action: "scheduled" as const, meeting, recording };
}

export async function reconcileMeetingRecorders(workspaceId: string) {
  const staleBefore = new Date(Date.now() - STALE_RECORDING_TIMEOUT_MS);
  const stale = await prisma.meetingRecording.findMany({
    where: {
      workspaceId,
      status: { in: ACTIVE_RECORDING_STATUSES },
      createdAt: { lt: staleBefore },
    },
  });
  for (const recording of stale) {
    await prisma.meetingRecording.update({
      where: { id: recording.id },
      data: {
        status: "FAILED",
        failureCode: "STALE_RECORDER",
        failureMessage: "Recorder did not complete before the reconciliation timeout.",
        endedAt: new Date(),
      },
    });
  }
  await prisma.meetingRecorderProviderEvent.updateMany({
    where: {
      workspaceId,
      redactedAt: null,
    },
    data: {
      redactedAt: new Date(),
    },
  });
  return { staleFailed: stale.length };
}
