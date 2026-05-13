"use server";

import { enforceDemoGuard } from "@/lib/demo-guard";
import { requirePageActor } from "@/lib/auth";
import { asString, asOptional, refresh } from "../action-utils";
import {
  createMeeting,
  createMeetingSeries,
  createScheduledMeeting,
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
} from "@corgtex/domain";
import { extractTextFromFileBuffer } from "@corgtex/knowledge";

const LOCAL_DATETIME_PATTERN = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})(?::(\d{2}))?$/;

function parseDateTimeLocalWithOffset(value: string, offsetMinutesRaw: string | null) {
  const match = value.match(LOCAL_DATETIME_PATTERN);
  const offsetMinutes = offsetMinutesRaw === null ? NaN : Number(offsetMinutesRaw);
  if (!match || !Number.isInteger(offsetMinutes)) {
    throw new Error("Meeting time must be a valid local datetime.");
  }
  const [, year, month, day, hour, minute, second = "0"] = match;
  const parsed = new Date(Date.UTC(
    Number(year),
    Number(month) - 1,
    Number(day),
    Number(hour),
    Number(minute),
    Number(second),
  ) + offsetMinutes * 60_000);
  if (Number.isNaN(parsed.valueOf())) {
    throw new Error("Meeting time must be a valid local datetime.");
  }
  return parsed;
}

export async function createMeetingAction(formData: FormData) {
  const _demoGuardWsId = formData.get("workspaceId") as string;
  if (_demoGuardWsId) await enforceDemoGuard(_demoGuardWsId);

  const actor = await requirePageActor();
  const workspaceId = asString(formData, "workspaceId");
  await createMeeting(actor, {
    workspaceId,
    title: asOptional(formData, "title"),
    source: asString(formData, "source"),
    recordedAt: new Date(asString(formData, "recordedAt")),
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
  await createMeetingSeries(actor, {
    workspaceId,
    title: asString(formData, "title"),
    description: asOptional(formData, "description"),
    startsAt: new Date(asString(formData, "startsAt")),
    scheduledEndAt: asOptional(formData, "scheduledEndAt")
      ? new Date(asString(formData, "scheduledEndAt"))
      : null,
    recurrenceRule: asOptional(formData, "recurrenceRule"),
    participantIds: asOptional(formData, "participantIds")?.split(",").map((value) => value.trim()).filter(Boolean) ?? [],
    participantEmails: asOptional(formData, "participantEmails")?.split(",").map((value) => value.trim()).filter(Boolean) ?? [],
  });
  await enqueueMeetingAgendaPreparation(actor, { workspaceId });
  refresh(workspaceId);
}

export async function scheduleManualMeetingRecordingAction(formData: FormData) {
  const _demoGuardWsId = formData.get("workspaceId") as string;
  if (_demoGuardWsId) await enforceDemoGuard(_demoGuardWsId);

  const actor = await requirePageActor();
  const workspaceId = asString(formData, "workspaceId");
  const joinAt = parseDateTimeLocalWithOffset(
    asString(formData, "joinAt"),
    asOptional(formData, "joinAtTimezoneOffsetMinutes"),
  );
  const scheduledEndAtRaw = asOptional(formData, "scheduledEndAt");
  const scheduledEndAt = scheduledEndAtRaw
    ? parseDateTimeLocalWithOffset(scheduledEndAtRaw, asOptional(formData, "joinAtTimezoneOffsetMinutes"))
    : null;
  const meeting = await createScheduledMeeting(actor, {
    workspaceId,
    title: asString(formData, "title"),
    startsAt: joinAt,
    scheduledEndAt,
    meetingUrl: asString(formData, "meetingUrl"),
    participantEmails: asOptional(formData, "participantEmails")?.split(",").map((value) => value.trim()).filter(Boolean) ?? [],
    source: "manual-recorder",
  });
  await scheduleMeetingRecording(actor, {
    workspaceId,
    meetingId: meeting.id,
    mode: "manual",
  });
  refresh(workspaceId);
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
    recordedAt: asOptional(formData, "recordedAt"),
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
