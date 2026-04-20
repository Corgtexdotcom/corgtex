"use server";

import { enforceDemoGuard } from "@/lib/demo-guard";
import { requirePageActor } from "@/lib/auth";
import { asString, asOptional, asOptionalInt, refresh } from "../action-utils";
import {
  createMeeting
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
