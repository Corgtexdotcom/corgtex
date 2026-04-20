import { prisma } from "@corgtex/shared";
import type { AppActor } from "@corgtex/shared";
import { requireWorkspaceMembership } from "./auth";
import { invariant } from "./errors";
import { appendEvents } from "./events";

export async function createCheckIn(actor: AppActor, params: {
  workspaceId: string;
  memberId: string;
  questionText: string;
  questionSource: string;
}) {
  await requireWorkspaceMembership({ actor, workspaceId: params.workspaceId });
  
  const questionText = params.questionText.trim();
  invariant(questionText.length > 0, 400, "INVALID_INPUT", "Question text is required.");

  return prisma.checkIn.create({
    data: {
      workspaceId: params.workspaceId,
      memberId: params.memberId,
      questionText,
      questionSource: params.questionSource,
    },
  });
}

export async function respondToCheckIn(actor: AppActor, params: {
  workspaceId: string;
  checkInId: string;
  responseMd: string;
  sentiment?: string;
}) {
  const membership = await requireWorkspaceMembership({ actor, workspaceId: params.workspaceId });

  return prisma.$transaction(async (tx) => {
    const checkIn = await tx.checkIn.findUnique({
      where: { id: params.checkInId },
    });

    invariant(checkIn && checkIn.workspaceId === params.workspaceId, 404, "NOT_FOUND", "Check-in not found.");
    invariant(membership && checkIn.memberId === membership.id, 403, "FORBIDDEN", "You can only respond to your own check-ins.");

    const updated = await tx.checkIn.update({
      where: { id: checkIn.id },
      data: {
        responseMd: params.responseMd.trim() || null,
        sentiment: params.sentiment,
        respondedAt: new Date(),
      },
    });

    await appendEvents(tx, [
      {
        workspaceId: params.workspaceId,
        type: "checkin.response_received",
        aggregateType: "CheckIn",
        aggregateId: updated.id,
        payload: { checkInId: updated.id, memberId: updated.memberId },
      },
    ]);

    return updated;
  });
}

export async function getOverwhelmSignals(workspaceId: string, memberId: string) {
  const sevenDaysAgo = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000);

  const recentCheckIns = await prisma.checkIn.findMany({
    where: {
      workspaceId,
      memberId,
      respondedAt: {
        gte: sevenDaysAgo,
      },
      sentiment: {
        in: ["NEGATIVE", "OVERWHELMED"],
      },
    },
    orderBy: { respondedAt: "desc" },
  });

  const recentNegativeCount = recentCheckIns.length;
  // Flag overwhelm if 3+ negative/overwhelmed signals, or at least 1 explicit OVERWHELMED
  const isOverwhelmed = recentNegativeCount >= 3 || recentCheckIns.some(c => c.sentiment === "OVERWHELMED");

  return {
    isOverwhelmed,
    recentNegativeCount,
    signals: recentCheckIns,
  };
}
