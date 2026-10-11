import type { AppActor } from "@corgtex/shared";
import { prisma } from "@corgtex/shared";
import { requireWorkspaceMembership } from "@corgtex/domain";
import { getBrainSearchMeetingIds, type BrainSearchResultLike } from "./view-model";

export async function listLinkableBrainSearchMeetingRefs(params: {
  actor: AppActor;
  workspaceId: string;
  results: BrainSearchResultLike[];
}) {
  const meetingIds = getBrainSearchMeetingIds(params.results);
  if (meetingIds.length === 0) return [];

  await requireWorkspaceMembership({ actor: params.actor, workspaceId: params.workspaceId });
  return prisma.meeting.findMany({
    where: {
      id: { in: meetingIds },
      workspaceId: params.workspaceId,
      archivedAt: null,
    },
    select: { id: true },
  });
}
