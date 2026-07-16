"use server";

import { createHash, randomUUID } from "node:crypto";
import { enforceDemoGuard } from "@/lib/demo-guard";
import { requirePageActor } from "@/lib/auth";
import { asString, asOptional, refresh } from "../action-utils";
import { redirect } from "next/navigation";
import {
  createMeetingSeries,
  deleteMeeting,
  enqueueMeetingAgendaPreparation,
  importMeetingInvite,
  intakeMeetingTranscript,
  requestMeetingIntelligenceRegeneration,
  requireWorkspaceMembership,
  replayWorkflowJob,
  dismissInsight,
  updateInsight,
  applyInsight,
  postDeliberationEntry,
  resolveDeliberationEntry,
  scheduleMeetingRecording,
  cancelMeetingRecording,
  sendManualMeetingRecorder,
  type MeetingTranscriptIntakeResult,
} from "@corgtex/domain";
import { extractTextFromFileBuffer } from "@corgtex/knowledge";
import { captureTelemetryEvent, getRedisClient, redisKey } from "@corgtex/shared";
import {
  parseMeetingDateTimeInput,
  parseOptionalMeetingDateTimeInput,
  resolveMeetingEndFromDurationOrInput,
} from "@/lib/meeting-timezone";

const PENDING_TRANSCRIPT_TTL_SECONDS = 20 * 60;
const CREATE_NEW_MEETING_CHOICE = "__create_new_meeting__";

export type MeetingTranscriptActionCandidate = {
  meetingId: string;
  title: string | null;
  recordedAt: string;
  score: number;
  reason: string;
};

export type MeetingTranscriptActionValues = {
  title?: string;
  source?: string;
  recordedAt?: string;
  timeZone?: string;
  transcript?: string;
  summaryMd?: string;
  ingestionGuidanceMd?: string;
  participantIds?: string;
  participantEmails?: string;
};

export type MeetingTranscriptActionState = {
  status: "idle" | "success" | "needs_clarification" | "error";
  message?: string | null;
  meetingId?: string | null;
  pendingTranscriptToken?: string | null;
  requiredFields?: Array<"recordedAt" | "meetingId">;
  candidates?: MeetingTranscriptActionCandidate[];
  values?: MeetingTranscriptActionValues;
  retryRequiresTranscriptUpload?: boolean;
};

const initialMeetingTranscriptActionState: MeetingTranscriptActionState = {
  status: "idle",
  message: null,
};

export type ManualMeetingRecordingActionState = {
  status: "idle" | "error";
  message?: string | null;
  values?: {
    meetingUrl?: string;
    title?: string;
    durationMinutes?: string;
    participantEmails?: string;
  };
};

function splitFormList(value: string | null) {
  return (value ?? "")
    .split(/[\n,]+/)
    .map((item) => item.trim())
    .filter(Boolean);
}

function serializeFormList(value: string[] | null | undefined) {
  return (value ?? []).join(", ");
}

function optionalFormString(formData: FormData, key: string) {
  const value = asOptional(formData, key);
  return value && value.trim() ? value.trim() : null;
}

type PendingTranscriptPayload = {
  workspaceId: string;
  transcript: string;
  fileName: string | null;
  title: string | null;
  source: string | null;
  recordedAt: string | null;
  timeZone: string | null;
  summaryMd: string | null;
  ingestionGuidanceMd: string | null;
  participantIds: string[];
  participantEmails: string[];
};

type TranscriptUploadPayload = PendingTranscriptPayload & {
  meetingId: string | null;
  createNewMeeting: boolean;
  pendingTranscriptToken: string | null;
  retryRequiresTranscriptUpload: boolean;
};

type TranscriptUploadPayloadError = MeetingTranscriptActionState & {
  status: "error";
};

function isTranscriptUploadPayload(value: TranscriptUploadPayload | TranscriptUploadPayloadError): value is TranscriptUploadPayload {
  return !("status" in value);
}

function pendingTranscriptKey(workspaceId: string, token: string) {
  return redisKey(`meeting-transcript-upload:${workspaceId}:${token}`);
}

function pendingTranscriptClarificationId(token: string | null | undefined) {
  if (!token) return null;
  return createHash("sha256").update(token).digest("hex").slice(0, 16);
}

function captureMeetingTranscriptIntakeAdvisory(properties: Record<string, unknown>) {
  void captureTelemetryEvent({
    event: "corgtex_meeting_transcript_intake_advisory",
    distinctId: typeof properties.workspace_id === "string"
      ? `workspace:${properties.workspace_id}`
      : "meeting-transcript-intake",
    properties,
  });
}

function isPendingTranscriptPayload(value: unknown): value is PendingTranscriptPayload {
  if (!value || typeof value !== "object") return false;
  const record = value as Record<string, unknown>;
  return typeof record.workspaceId === "string"
    && typeof record.transcript === "string"
    && (typeof record.fileName === "string" || record.fileName === null)
    && (typeof record.title === "string" || record.title === null)
    && (typeof record.source === "string" || record.source === null)
    && (typeof record.recordedAt === "string" || record.recordedAt === null)
    && (typeof record.timeZone === "string" || record.timeZone === null)
    && (typeof record.summaryMd === "string" || record.summaryMd === null)
    && (typeof record.ingestionGuidanceMd === "string" || record.ingestionGuidanceMd === null)
    && Array.isArray(record.participantIds)
    && Array.isArray(record.participantEmails);
}

async function storePendingTranscriptPayload(payload: PendingTranscriptPayload) {
  try {
    const client = await getRedisClient();
    if (!client) return null;
    const token = randomUUID();
    await client.setEx(
      pendingTranscriptKey(payload.workspaceId, token),
      PENDING_TRANSCRIPT_TTL_SECONDS,
      JSON.stringify(payload),
    );
    return token;
  } catch (error) {
    console.warn("Unable to store pending meeting transcript upload.", error);
    return null;
  }
}

async function readPendingTranscriptPayload(workspaceId: string, token: string) {
  try {
    const client = await getRedisClient();
    if (!client) return null;
    const raw = await client.get(pendingTranscriptKey(workspaceId, token));
    if (!raw) return null;
    const parsed = JSON.parse(raw) as unknown;
    if (!isPendingTranscriptPayload(parsed) || parsed.workspaceId !== workspaceId) return null;
    return parsed;
  } catch (error) {
    console.warn("Unable to read pending meeting transcript upload.", error);
    return null;
  }
}

async function deletePendingTranscriptPayload(workspaceId: string, token: string | null) {
  if (!token) return;
  try {
    const client = await getRedisClient();
    if (!client) return;
    await client.del(pendingTranscriptKey(workspaceId, token));
  } catch (error) {
    console.warn("Unable to clear pending meeting transcript upload.", error);
  }
}

function actionValuesFromPayload(payload: PendingTranscriptPayload): MeetingTranscriptActionValues {
  return {
    title: payload.title ?? undefined,
    source: payload.source ?? undefined,
    recordedAt: payload.recordedAt ?? undefined,
    timeZone: payload.timeZone ?? undefined,
    summaryMd: payload.summaryMd ?? undefined,
    ingestionGuidanceMd: payload.ingestionGuidanceMd ?? undefined,
    participantIds: serializeFormList(payload.participantIds),
    participantEmails: serializeFormList(payload.participantEmails),
  };
}

function actionValuesFromFormData(formData: FormData): MeetingTranscriptActionValues {
  return {
    title: optionalFormString(formData, "title") ?? undefined,
    source: optionalFormString(formData, "source") ?? undefined,
    recordedAt: optionalFormString(formData, "recordedAt") ?? undefined,
    timeZone: optionalFormString(formData, "timeZone") ?? undefined,
    transcript: optionalFormString(formData, "transcript") ?? undefined,
    summaryMd: optionalFormString(formData, "summaryMd") ?? undefined,
    ingestionGuidanceMd: optionalFormString(formData, "ingestionGuidanceMd") ?? undefined,
    participantIds: optionalFormString(formData, "participantIds") ?? undefined,
    participantEmails: optionalFormString(formData, "participantEmails") ?? undefined,
  };
}

function pendingPayloadFromUpload(payload: TranscriptUploadPayload): PendingTranscriptPayload {
  return {
    workspaceId: payload.workspaceId,
    transcript: payload.transcript,
    fileName: payload.fileName,
    title: payload.title,
    source: payload.source,
    recordedAt: payload.recordedAt,
    timeZone: payload.timeZone,
    summaryMd: payload.summaryMd,
    ingestionGuidanceMd: payload.ingestionGuidanceMd,
    participantIds: payload.participantIds,
    participantEmails: payload.participantEmails,
  };
}

function expectedTranscriptActionErrorMessage(error: unknown) {
  if (
    error instanceof Error
    && "status" in error
    && typeof (error as { status?: unknown }).status === "number"
    && (error as { status: number }).status >= 400
    && (error as { status: number }).status < 500
  ) {
    return error.message;
  }
  console.error("Meeting transcript upload action failed.", error);
  return "Transcript upload is temporarily unavailable. Try again.";
}

function serializeClarificationCandidates(result: Extract<MeetingTranscriptIntakeResult, { status: "needs_clarification" }>) {
  return result.candidates?.map((candidate) => ({
    meetingId: candidate.meetingId,
    title: candidate.title,
    recordedAt: candidate.recordedAt.toISOString(),
    score: candidate.score,
    reason: candidate.reason,
  })) ?? [];
}

async function buildTranscriptUploadPayload(formData: FormData): Promise<TranscriptUploadPayload | TranscriptUploadPayloadError> {
  const workspaceId = asString(formData, "workspaceId");
  const pendingTranscriptToken = optionalFormString(formData, "pendingTranscriptToken");
  const existingPayload = pendingTranscriptToken
    ? await readPendingTranscriptPayload(workspaceId, pendingTranscriptToken)
    : null;

  if (pendingTranscriptToken && !existingPayload) {
    return {
      status: "error",
      message: "The pending transcript upload expired. Upload the transcript again.",
      retryRequiresTranscriptUpload: true,
    };
  }

  const file = formData.get("file");
  const submittedTranscript = asOptional(formData, "transcript");
  let transcript = submittedTranscript?.trim() ? submittedTranscript : existingPayload?.transcript ?? "";
  let fileName = existingPayload?.fileName ?? null;
  let retryRequiresTranscriptUpload = false;

  if (file instanceof File && file.size > 0) {
    const extracted = await extractTextFromFileBuffer({
      fileBuffer: Buffer.from(await file.arrayBuffer()),
      fileName: file.name,
      mimeType: file.type || "application/octet-stream",
    });
    transcript = extracted.textContent ?? transcript;
    fileName = file.name;
    retryRequiresTranscriptUpload = true;
  }

  if (!transcript.trim()) {
    return {
      status: "error",
      message: "Transcript text or a readable transcript file is required.",
      values: existingPayload ? actionValuesFromPayload(existingPayload) : {
        title: optionalFormString(formData, "title") ?? undefined,
        source: optionalFormString(formData, "source") ?? undefined,
        recordedAt: optionalFormString(formData, "recordedAt") ?? undefined,
        timeZone: optionalFormString(formData, "timeZone") ?? undefined,
        summaryMd: optionalFormString(formData, "summaryMd") ?? undefined,
        ingestionGuidanceMd: optionalFormString(formData, "ingestionGuidanceMd") ?? undefined,
        participantIds: optionalFormString(formData, "participantIds") ?? undefined,
        participantEmails: optionalFormString(formData, "participantEmails") ?? undefined,
      },
    };
  }

  const meetingChoice = optionalFormString(formData, "meetingId");
  const createNewMeeting = meetingChoice === CREATE_NEW_MEETING_CHOICE || optionalFormString(formData, "createNewMeeting") === "true";

  return {
    workspaceId,
    pendingTranscriptToken,
    retryRequiresTranscriptUpload,
    transcript,
    fileName,
    meetingId: createNewMeeting ? null : meetingChoice,
    createNewMeeting,
    title: optionalFormString(formData, "title") ?? existingPayload?.title ?? null,
    source: optionalFormString(formData, "source") ?? existingPayload?.source ?? "transcript-upload",
    recordedAt: optionalFormString(formData, "recordedAt") ?? existingPayload?.recordedAt ?? null,
    timeZone: optionalFormString(formData, "timeZone") ?? existingPayload?.timeZone ?? null,
    summaryMd: optionalFormString(formData, "summaryMd") ?? existingPayload?.summaryMd ?? null,
    ingestionGuidanceMd: optionalFormString(formData, "ingestionGuidanceMd") ?? existingPayload?.ingestionGuidanceMd ?? null,
    participantIds: splitFormList(optionalFormString(formData, "participantIds") ?? serializeFormList(existingPayload?.participantIds)),
    participantEmails: splitFormList(optionalFormString(formData, "participantEmails") ?? serializeFormList(existingPayload?.participantEmails)),
  };
}

function manualRecordingFormValues(formData: FormData): NonNullable<ManualMeetingRecordingActionState["values"]> {
  return {
    meetingUrl: asString(formData, "meetingUrl"),
    title: asString(formData, "title"),
    durationMinutes: asString(formData, "durationMinutes"),
    participantEmails: asString(formData, "participantEmails"),
  };
}

function expectedActionErrorMessage(error: unknown) {
  if (
    error instanceof Error
    && "status" in error
    && typeof (error as { status?: unknown }).status === "number"
    && (error as { status: number }).status >= 400
    && (error as { status: number }).status < 500
  ) {
    return error.message;
  }
  if (
    error instanceof Error
    && "code" in error
    && (error as { code?: unknown }).code === "RECORDER_SCHEDULING_FAILED"
  ) {
    return error.message;
  }
  console.error("Manual meeting recorder action failed.", error);
  return "Recorder scheduling is temporarily unavailable. Try again.";
}

export async function createMeetingSeriesAction(formData: FormData) {
  const _demoGuardWsId = formData.get("workspaceId") as string;
  if (_demoGuardWsId) await enforceDemoGuard(_demoGuardWsId);

  const actor = await requirePageActor();
  const workspaceId = asString(formData, "workspaceId");
  const timeZone = asOptional(formData, "timeZone");
  const startsAt = parseMeetingDateTimeInput(asString(formData, "startsAt"), timeZone, "Starts at");
  const scheduledEndAt = resolveMeetingEndFromDurationOrInput({
    start: startsAt,
    durationMinutes: asOptional(formData, "durationMinutes"),
    scheduledEndAt: asOptional(formData, "scheduledEndAt"),
    timeZone,
    durationLabel: "Duration",
    endLabel: "Scheduled end",
  });
  await createMeetingSeries(actor, {
    workspaceId,
    title: asString(formData, "title"),
    description: asOptional(formData, "description"),
    startsAt,
    scheduledEndAt,
    recurrenceRule: asOptional(formData, "recurrenceRule"),
    meetingUrl: asOptional(formData, "meetingUrl"),
    participantIds: asOptional(formData, "participantIds")?.split(",").map((value) => value.trim()).filter(Boolean) ?? [],
    participantEmails: asOptional(formData, "participantEmails")?.split(",").map((value) => value.trim()).filter(Boolean) ?? [],
  });
  await enqueueMeetingAgendaPreparation(actor, { workspaceId });
  refresh(workspaceId);
}

export async function scheduleManualMeetingRecordingAction(
  _previousState: ManualMeetingRecordingActionState,
  formData: FormData,
): Promise<ManualMeetingRecordingActionState> {
  const values = manualRecordingFormValues(formData);
  const _demoGuardWsId = formData.get("workspaceId") as string;
  const workspaceId = asString(formData, "workspaceId");
  let result: Awaited<ReturnType<typeof sendManualMeetingRecorder>>;
  try {
    if (_demoGuardWsId) await enforceDemoGuard(_demoGuardWsId);
    const actor = await requirePageActor();
    result = await sendManualMeetingRecorder(actor, {
      workspaceId,
      meetingUrl: values.meetingUrl ?? "",
      title: values.title,
      durationMinutes: values.durationMinutes,
      participantEmails: splitFormList(values.participantEmails ?? null),
    });
  } catch (error) {
    return {
      status: "error",
      message: expectedActionErrorMessage(error),
      values,
    };
  }
  refresh(workspaceId);
  redirect(`/workspaces/${workspaceId}/meetings?recorderSent=${encodeURIComponent(result.meeting.id)}`);
}

export async function importMeetingInviteAction(formData: FormData) {
  const _demoGuardWsId = formData.get("workspaceId") as string;
  if (_demoGuardWsId) await enforceDemoGuard(_demoGuardWsId);

  const actor = await requirePageActor();
  const workspaceId = asString(formData, "workspaceId");
  const file = formData.get("invite");
  if (!(file instanceof File) || file.size === 0) {
    throw new Error("Invite file is required.");
  }

  const icsText = await file.text();
  await importMeetingInvite(actor, { workspaceId, icsText });
  await enqueueMeetingAgendaPreparation(actor, { workspaceId });
  refresh(workspaceId);
}

export async function uploadMeetingTranscriptAction(formData: FormData) {
  const result = await uploadMeetingTranscriptStateAction(initialMeetingTranscriptActionState, formData);
  if (result.status === "success") return;
  throw new Error(result.message ?? "Transcript upload needs more information.");
}

export async function uploadMeetingTranscriptStateAction(
  previousState: MeetingTranscriptActionState,
  formData: FormData,
): Promise<MeetingTranscriptActionState> {
  const _demoGuardWsId = formData.get("workspaceId") as string;
  const workspaceId = asString(formData, "workspaceId");

  try {
    if (_demoGuardWsId) await enforceDemoGuard(_demoGuardWsId);

    const actor = await requirePageActor();
    await requireWorkspaceMembership({ actor, workspaceId });
    const payload = await buildTranscriptUploadPayload(formData);
    if (!isTranscriptUploadPayload(payload)) return payload;

    const result = await intakeMeetingTranscript(actor, {
      workspaceId,
      meetingId: payload.meetingId,
      title: payload.title,
      source: payload.source || "transcript-upload",
      recordedAt: parseOptionalMeetingDateTimeInput(payload.recordedAt, payload.timeZone, "Recorded at"),
      transcript: payload.transcript,
      fileName: payload.fileName,
      createNewMeeting: payload.createNewMeeting,
      summaryMd: payload.summaryMd,
      ingestionGuidanceMd: payload.ingestionGuidanceMd,
      participantIds: payload.participantIds,
      participantEmails: payload.participantEmails,
    });

    if (result.status === "needs_clarification") {
      const pendingPayload = pendingPayloadFromUpload(payload);
      const nextToken = await storePendingTranscriptPayload(pendingPayload);
      if (nextToken) {
        await deletePendingTranscriptPayload(workspaceId, payload.pendingTranscriptToken);
      }
      captureMeetingTranscriptIntakeAdvisory({
        kind: "needs_clarification",
        workspace_id: workspaceId,
        surface: "server_action",
        source: pendingPayload.source,
        required_fields: result.requiredFields,
        candidate_count: result.candidates?.length ?? 0,
        pending_upload_stored: Boolean(nextToken),
        clarification_id: pendingTranscriptClarificationId(nextToken),
      });
      return {
        status: "needs_clarification",
        message: result.message,
        pendingTranscriptToken: nextToken,
        requiredFields: result.requiredFields,
        candidates: serializeClarificationCandidates(result),
        values: actionValuesFromPayload(pendingPayload),
        retryRequiresTranscriptUpload: !nextToken,
      };
    }

    if (payload.pendingTranscriptToken) {
      captureMeetingTranscriptIntakeAdvisory({
        kind: "needs_clarification_completed",
        workspace_id: workspaceId,
        surface: "server_action",
        source: payload.source,
        meeting_id: result.meeting.id,
        create_new_meeting: payload.createNewMeeting,
        clarification_id: pendingTranscriptClarificationId(payload.pendingTranscriptToken),
      });
    }
    await deletePendingTranscriptPayload(workspaceId, payload.pendingTranscriptToken);
    refresh(workspaceId);
    return {
      status: "success",
      message: result.message,
      meetingId: result.meeting.id,
    };
  } catch (error) {
    const pendingTranscriptToken = previousState.status === "needs_clarification"
      ? previousState.pendingTranscriptToken
      : null;
    return {
      status: "error",
      message: expectedTranscriptActionErrorMessage(error),
      pendingTranscriptToken,
      values: pendingTranscriptToken ? actionValuesFromFormData(formData) : undefined,
      retryRequiresTranscriptUpload: pendingTranscriptToken ? previousState.retryRequiresTranscriptUpload : undefined,
    };
  }
}

export async function archiveMeetingAction(formData: FormData) {
  const _demoGuardWsId = formData.get("workspaceId") as string;
  if (_demoGuardWsId) await enforceDemoGuard(_demoGuardWsId);

  const actor = await requirePageActor();
  const workspaceId = asString(formData, "workspaceId");
  await deleteMeeting(actor, {
    workspaceId,
    meetingId: asString(formData, "meetingId"),
  });
  refresh(workspaceId);
}

export async function scheduleMeetingRecordingAction(formData: FormData) {
  const _demoGuardWsId = formData.get("workspaceId") as string;
  if (_demoGuardWsId) await enforceDemoGuard(_demoGuardWsId);

  const actor = await requirePageActor();
  const workspaceId = asString(formData, "workspaceId");
  await scheduleMeetingRecording(actor, {
    workspaceId,
    meetingId: asString(formData, "meetingId"),
    mode: "manual",
  });
  refresh(workspaceId);
}

export async function cancelMeetingRecordingAction(formData: FormData) {
  const _demoGuardWsId = formData.get("workspaceId") as string;
  if (_demoGuardWsId) await enforceDemoGuard(_demoGuardWsId);

  const actor = await requirePageActor();
  const workspaceId = asString(formData, "workspaceId");
  await cancelMeetingRecording(actor, {
    workspaceId,
    meetingId: asString(formData, "meetingId"),
  });
  refresh(workspaceId);
}

export async function regenerateMeetingIntelligenceAction(formData: FormData) {
  const _demoGuardWsId = formData.get("workspaceId") as string;
  if (_demoGuardWsId) await enforceDemoGuard(_demoGuardWsId);

  const actor = await requirePageActor();
  const workspaceId = asString(formData, "workspaceId");
  await requestMeetingIntelligenceRegeneration(actor, {
    workspaceId,
    meetingId: asString(formData, "meetingId"),
    guidanceMd: asString(formData, "guidanceMd"),
  });
  refresh(workspaceId);
}

export async function retryMeetingProcessingJobAction(formData: FormData) {
  const _demoGuardWsId = formData.get("workspaceId") as string;
  if (_demoGuardWsId) await enforceDemoGuard(_demoGuardWsId);

  const actor = await requirePageActor();
  const workspaceId = asString(formData, "workspaceId");
  await requireWorkspaceMembership({
    actor,
    workspaceId,
    allowedRoles: ["ADMIN"],
  });
  await replayWorkflowJob(actor, {
    workspaceId,
    workflowJobId: asString(formData, "workflowJobId"),
  });
  refresh(workspaceId);
}

export async function dismissInsightAction(formData: FormData) {
  const _demoGuardWsId = formData.get("workspaceId") as string;
  if (_demoGuardWsId) await enforceDemoGuard(_demoGuardWsId);

  const actor = await requirePageActor();
  const workspaceId = formData.get("workspaceId") as string;
  const insightId = formData.get("insightId") as string;
  
  await dismissInsight(actor, { workspaceId, insightId });
  refresh(workspaceId);
}

export async function updateInsightAction(formData: FormData) {
  const _demoGuardWsId = formData.get("workspaceId") as string;
  if (_demoGuardWsId) await enforceDemoGuard(_demoGuardWsId);

  const actor = await requirePageActor();
  const workspaceId = asString(formData, "workspaceId");
  await updateInsight(actor, {
    workspaceId,
    insightId: asString(formData, "insightId"),
    title: asString(formData, "title"),
    bodyMd: asString(formData, "bodyMd"),
    assigneeHint: asOptional(formData, "assigneeHint"),
  });
  refresh(workspaceId);
}

export async function applyInsightAction(formData: FormData) {
  const _demoGuardWsId = formData.get("workspaceId") as string;
  if (_demoGuardWsId) await enforceDemoGuard(_demoGuardWsId);

  const actor = await requirePageActor();
  const workspaceId = formData.get("workspaceId") as string;
  const insightId = formData.get("insightId") as string;
  
  await applyInsight(actor, { workspaceId, insightId });
  refresh(workspaceId);
}

export async function postMeetingDeliberationAction(formData: FormData) {
  const _demoGuardWsId = formData.get("workspaceId") as string;
  if (_demoGuardWsId) await enforceDemoGuard(_demoGuardWsId);

  const actor = await requirePageActor();
  const workspaceId = asString(formData, "workspaceId");
  
  await postDeliberationEntry(actor, {
    workspaceId,
    parentType: "MEETING",
    parentId: asString(formData, "parentId"),
    entryType: asString(formData, "entryType") as any,
    bodyMd: asString(formData, "bodyMd"),
    targetMemberId: asOptional(formData, "targetMemberId") || undefined,
    targetCircleId: asOptional(formData, "targetCircleId") || undefined,
  });
  refresh(workspaceId);
}

export async function resolveMeetingDeliberationAction(formData: FormData) {
  const _demoGuardWsId = formData.get("workspaceId") as string;
  if (_demoGuardWsId) await enforceDemoGuard(_demoGuardWsId);

  const actor = await requirePageActor();
  const workspaceId = asString(formData, "workspaceId");
  
  await resolveDeliberationEntry(actor, {
    workspaceId,
    entryId: asString(formData, "entryId"),
    resolvedNote: asString(formData, "resolvedNote"),
  });
  refresh(workspaceId);
}
