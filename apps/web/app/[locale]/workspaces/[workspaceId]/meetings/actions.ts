"use server";

import { enforceDemoGuard } from "@/lib/demo-guard";
import { requirePageActor } from "@/lib/auth";
import { asString, asOptional, asOptionalInt, refresh } from "../action-utils";
import {
  createMeeting,
  extractMeetingInsights,
  confirmInsight,
  dismissInsight,
  applyInsight,
  confirmAllInsights,
} from "@corgtex/domain";

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
    participantIds: asString(formData, "participantIds")
      .split(",")
      .map((value) => value.trim())
      .filter(Boolean),
  });
  refresh(workspaceId);
}

export async function extractInsightsAction(formData: FormData) {
  const actor = await requirePageActor();
  const workspaceId = formData.get("workspaceId") as string;
  const meetingId = formData.get("meetingId") as string;
  
  await extractMeetingInsights(actor, { workspaceId, meetingId });
  refresh(workspaceId);
}

export async function confirmInsightAction(formData: FormData) {
  const actor = await requirePageActor();
  const workspaceId = formData.get("workspaceId") as string;
  const insightId = formData.get("insightId") as string;
  
  await confirmInsight(actor, { workspaceId, insightId });
  refresh(workspaceId);
}

export async function dismissInsightAction(formData: FormData) {
  const actor = await requirePageActor();
  const workspaceId = formData.get("workspaceId") as string;
  const insightId = formData.get("insightId") as string;
  
  await dismissInsight(actor, { workspaceId, insightId });
  refresh(workspaceId);
}

export async function applyInsightAction(formData: FormData) {
  const actor = await requirePageActor();
  const workspaceId = formData.get("workspaceId") as string;
  const insightId = formData.get("insightId") as string;
  
  await applyInsight(actor, { workspaceId, insightId });
  refresh(workspaceId);
}

export async function confirmAllInsightsAction(formData: FormData) {
  const actor = await requirePageActor();
  const workspaceId = formData.get("workspaceId") as string;
  const meetingId = formData.get("meetingId") as string;
  
  await confirmAllInsights(actor, { workspaceId, meetingId });
  refresh(workspaceId);
}
