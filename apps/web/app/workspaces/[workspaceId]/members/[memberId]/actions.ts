"use server";

import { requirePageActor } from "@/lib/auth";
import { generateMemberBriefing } from "@corgtex/domain";

export async function getAIProfileBriefingAction(workspaceId: string, memberId: string) {
  const actor = await requirePageActor();
  if (!actor || actor.kind !== "user") {
    throw new Error("Unauthorized");
  }

  return generateMemberBriefing(actor, workspaceId, memberId);
}
