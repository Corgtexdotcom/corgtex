"use server";

import { enforceDemoGuard } from "@/lib/demo-guard";
import { requirePageActor } from "@/lib/auth";
import { asString, asOptional, refresh } from "../action-utils";
import { redirect } from "next/navigation";
import {
  createMeeting,
  createMeetingSeries,
  deleteMeeting,
  enqueueMeetingAgendaPreparation,
  extractMeetingInsights,
  importMeetingInvite,
  intakeMeetingTranscript,
  requestMeetingIntelligenceRegeneration,
  confirmInsight,
  dismissInsight,
  updateInsight,
  applyInsight,
  confirmAllInsights,
  postDeliberationEntry,
  resolveDeliberationEntry,
  scheduleMeetingRecording,
  cancelMeetingRecording,
  sendManualMeetingRecorder,
} from "@corgtex/domain";
import { extractTextFromFileBuffer } from "@corgtex/knowledge";
import {
  parseMeetingDateTimeInput,
  parseOptionalMeetingDateTimeInput,
  resolveMeetingEndFromDurationOrInput,
} from "@/lib/meeting-timezone";

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

export async function createMeetingAction(formData: FormData) {
  const _demoGuardWsId = formData.get("workspaceId") as string;
  if (_demoGuardWsId) await enforceDemoGuard(_demoGuardWsId);

  const actor = await requirePageActor();
  const workspaceId = asString(formData, "workspaceId");
  const timeZone = asOptional(formData, "timeZone");
  await createMeeting(actor, {
    workspaceId,
    title: asOptional(formData, "title"),
    source: asString(formData, "source"),
    recordedAt: parseMeetingDateTimeInput(asString(formData, "recordedAt"), timeZone, "Recorded at"),
    transcript: asOptional(formData, "transcript"),
    summaryMd: asOptional(formData, "summaryMd"),
    ingestionGuidanceMd: asOptional(formData, "ingestionGuidanceMd"),
    participantIds: asString(formData, "participantIds")
      .split(",")
      .map((value) => value.trim())
      .filter(Boolean),
  });
  refresh(workspaceId);
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
  const _demoGuardWsId = formData.get("workspaceId") as string;
  if (_demoGuardWsId) await enforceDemoGuard(_demoGuardWsId);

  const actor = await requirePageActor();
  const workspaceId = asString(formData, "workspaceId");
  const file = formData.get("file");
  let transcript = asOptional(formData, "transcript") ?? "";
  if (file instanceof File && file.size > 0) {
    const extracted = await extractTextFromFileBuffer({
      fileBuffer: Buffer.from(await file.arrayBuffer()),
      fileName: file.name,
      mimeType: file.type || "application/octet-stream",
    });
    transcript = extracted.textContent ?? transcript;
  }
  const result = await intakeMeetingTranscript(actor, {
    workspaceId,
    meetingId: asOptional(formData, "meetingId"),
    title: asOptional(formData, "title"),
    source: asOptional(formData, "source") || "transcript-upload",
    recordedAt: parseOptionalMeetingDateTimeInput(asOptional(formData, "recordedAt"), asOptional(formData, "timeZone"), "Recorded at"),
    transcript,
    summaryMd: asOptional(formData, "summaryMd"),
    ingestionGuidanceMd: asOptional(formData, "ingestionGuidanceMd"),
    participantIds: asOptional(formData, "participantIds")?.split(",").map((value) => value.trim()).filter(Boolean) ?? [],
    participantEmails: asOptional(formData, "participantEmails")?.split(",").map((value) => value.trim()).filter(Boolean) ?? [],
  });

  if (result.status === "needs_clarification") {
    throw new Error(result.message);
  }

  refresh(workspaceId);
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

export async function extractInsightsAction(formData: FormData) {
  const _demoGuardWsId = formData.get("workspaceId") as string;
  if (_demoGuardWsId) await enforceDemoGuard(_demoGuardWsId);

  const actor = await requirePageActor();
  const workspaceId = formData.get("workspaceId") as string;
  const meetingId = formData.get("meetingId") as string;
  
  await extractMeetingInsights(actor, { workspaceId, meetingId });
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

export async function confirmInsightAction(formData: FormData) {
  const _demoGuardWsId = formData.get("workspaceId") as string;
  if (_demoGuardWsId) await enforceDemoGuard(_demoGuardWsId);

  const actor = await requirePageActor();
  const workspaceId = formData.get("workspaceId") as string;
  const insightId = formData.get("insightId") as string;
  
  await confirmInsight(actor, { workspaceId, insightId });
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

export async function applyAllHighConfidenceInsightsAction(formData: FormData) {
  const _demoGuardWsId = formData.get("workspaceId") as string;
  if (_demoGuardWsId) await enforceDemoGuard(_demoGuardWsId);

  const actor = await requirePageActor();
  const workspaceId = formData.get("workspaceId") as string;
  const meetingId = formData.get("meetingId") as string;
  const { autoApplyMeetingInsights } = await import("@corgtex/domain");

  await autoApplyMeetingInsights(actor, { workspaceId, meetingId });
  refresh(workspaceId);
}

export async function confirmAllInsightsAction(formData: FormData) {
  const _demoGuardWsId = formData.get("workspaceId") as string;
  if (_demoGuardWsId) await enforceDemoGuard(_demoGuardWsId);

  const actor = await requirePageActor();
  const workspaceId = formData.get("workspaceId") as string;
  const meetingId = formData.get("meetingId") as string;
  
  await confirmAllInsights(actor, { workspaceId, meetingId });
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
