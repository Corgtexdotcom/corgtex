import { prisma } from "@corgtex/shared";
import type { AppActor } from "@corgtex/shared";
import { requireWorkspaceMembership } from "./auth";

export async function calculateImpactFootprint(workspaceId: string, memberId: string, periodStart: Date, periodEnd: Date) {
  const member = await prisma.member.findUnique({
    where: { id: memberId },
    select: { userId: true },
  });
  const memberUserId = member?.userId ?? "__missing_member_user__";

  const [
    proposalsAuthored,
    proposalsExecuted,
    adviceGiven,
    adviceSoughtCount,
    tensionsResolved,
    actionsCompleted,
    meetingsParticipated,
    expertiseEndorsements
  ] = await Promise.all([
    // Proposals Authored (submitted in this period)
    prisma.proposal.count({
      where: {
        workspaceId,
        author: { memberships: { some: { id: memberId } } },
        createdAt: { gte: periodStart, lte: periodEnd },
        status: { not: "DRAFT" },
      },
    }),
    // Proposals Executed via Advice Process
    prisma.adviceProcess.count({
      where: {
        workspaceId,
        authorMemberId: memberId,
        status: "EXECUTED",
        executedAt: { gte: periodStart, lte: periodEnd },
      },
    }),
    // Advice Given
    prisma.deliberationEntry.count({
      where: {
        workspaceId,
        parentType: "PROPOSAL",
        authorUserId: memberUserId,
        createdAt: { gte: periodStart, lte: periodEnd },
      },
    }),
    // Advice/Input Requests Created
    prisma.adviceRequest.count({
      where: {
        workspaceId,
        requestedByUserId: memberUserId,
        createdAt: { gte: periodStart, lte: periodEnd },
      },
    }),
    // Tensions Resolved
    prisma.tension.count({
      where: {
        workspaceId,
        assigneeMemberId: memberId,
        status: "RESOLVED",
        updatedAt: { gte: periodStart, lte: periodEnd },
      },
    }),
    // Actions Completed
    prisma.action.count({
      where: {
        workspaceId,
        assigneeMemberId: memberId,
        status: "COMPLETED",
        updatedAt: { gte: periodStart, lte: periodEnd },
      },
    }),
    // Meetings Participated
    prisma.meeting.count({
      where: {
        workspaceId,
        participantIds: { has: memberId },
        recordedAt: { gte: periodStart, lte: periodEnd },
      },
    }),
    // Expertise Endorsements Received
    prisma.memberExpertise.aggregate({
      where: { memberId },
      _sum: { endorsedCount: true },
    })
  ]);

  // Count endorsements received and concerns raised separately, since this requires more complex joins
  const authoredProposals = await prisma.proposal.findMany({
    where: { workspaceId, author: { memberships: { some: { id: memberId } } } },
    select: { id: true },
  });
  
  const proposalIds = authoredProposals.map(p => p.id);

  const endorsementsReceived = await prisma.deliberationEntry.count({
    where: {
      workspaceId,
      parentType: "PROPOSAL",
      parentId: { in: proposalIds },
      entryType: "REACTION",
      createdAt: { gte: periodStart, lte: periodEnd },
    },
  });

  const concernsRaised = await prisma.deliberationEntry.count({
    where: {
      workspaceId,
      parentType: "PROPOSAL",
      authorUserId: memberUserId,
      entryType: "OBJECTION",
      createdAt: { gte: periodStart, lte: periodEnd },
    },
  });

  const footprintData = {
    proposalsAuthored,
    proposalsExecuted,
    adviceGiven,
    adviceSoughtCount,
    tensionsResolved,
    actionsCompleted,
    endorsementsReceived,
    concernsRaised,
    meetingsParticipated,
    detailJson: { expertiseEndorsementsCount: expertiseEndorsements._sum.endorsedCount || 0 },
  };

  return footprintData;
}

// Maximum number of per-member footprint computations in flight at once. Each
// member's computation is independent; the cap bounds DB load while still
// avoiding the fully-serialized round-trip latency of the previous loop.
const MEMBER_FOOTPRINT_CONCURRENCY = 5;

// Maps over `items` running at most `limit` async tasks concurrently, returning
// results in the original input order.
async function mapWithConcurrency<T, R>(
  items: readonly T[],
  limit: number,
  task: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
  const results = new Array<R>(items.length);
  let nextIndex = 0;

  async function worker() {
    while (true) {
      const current = nextIndex++;
      if (current >= items.length) return;
      results[current] = await task(items[current], current);
    }
  }

  const workerCount = Math.max(1, Math.min(limit, items.length));
  await Promise.all(Array.from({ length: workerCount }, () => worker()));
  return results;
}

export async function refreshImpactFootprints(workspaceId: string, periodStart: Date, periodEnd: Date) {
  const activeMembers = await prisma.member.findMany({
    where: { workspaceId, isActive: true },
    select: { id: true },
  });

  // Compute members with bounded concurrency; results stay in member order.
  return mapWithConcurrency(activeMembers, MEMBER_FOOTPRINT_CONCURRENCY, async (m) => {
    const data = await calculateImpactFootprint(workspaceId, m.id, periodStart, periodEnd);
    return prisma.impactFootprint.upsert({
      where: {
        workspaceId_memberId_periodStart_periodEnd: {
          workspaceId,
          memberId: m.id,
          periodStart,
          periodEnd,
        },
      },
      update: data,
      create: {
        workspaceId,
        memberId: m.id,
        periodStart,
        periodEnd,
        ...data,
      },
    });
  });
}

export async function getLatestImpactFootprint(actor: AppActor, workspaceId: string, memberId: string) {
  await requireWorkspaceMembership({ actor, workspaceId });
  
  return prisma.impactFootprint.findFirst({
    where: { workspaceId, memberId },
    orderBy: { createdAt: "desc" },
  });
}
