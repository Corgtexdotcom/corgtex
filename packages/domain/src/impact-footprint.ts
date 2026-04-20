import { prisma } from "@corgtex/shared";
import type { AppActor } from "@corgtex/shared";
import { requireWorkspaceMembership } from "./auth";

export async function calculateImpactFootprint(workspaceId: string, memberId: string, periodStart: Date, periodEnd: Date) {
  const [
    proposalsAuthored,
    proposalsExecuted,
    adviceGiven,
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
    prisma.adviceRecord.count({
      where: {
        memberId,
        createdAt: { gte: periodStart, lte: periodEnd },
      },
    }),
    // Tensions Resolved
    prisma.tension.count({
      where: {
        workspaceId,
        assigneeMemberId: memberId,
        status: "COMPLETED",
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

  const endorsementsReceived = await prisma.adviceRecord.count({
    where: {
      type: "ENDORSE",
      process: { proposalId: { in: proposalIds } },
      createdAt: { gte: periodStart, lte: periodEnd },
    },
  });

  const concernsRaised = await prisma.adviceRecord.count({
    where: {
      memberId,
      type: "CONCERN",
      createdAt: { gte: periodStart, lte: periodEnd },
    },
  });

  // Since advisorySuggestionsJson is a JSON blob, we can't easily count it in Prisma directly.
  // In a real production system, this could be stored in a separate table, but for now we skip tracking this exact count 
  // or we could load all advice processes and parse JSON. For footprint V1, we will default it to 0 or derive from records.
  const adviceSoughtCount = 0; 

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

export async function refreshImpactFootprints(workspaceId: string, periodStart: Date, periodEnd: Date) {
  const activeMembers = await prisma.member.findMany({
    where: { workspaceId, isActive: true },
    select: { id: true },
  });

  const footprints = [];
  
  // Calculate sequentially to avoid overloading DB
  for (const m of activeMembers) {
    const data = await calculateImpactFootprint(workspaceId, m.id, periodStart, periodEnd);
    const footprint = await prisma.impactFootprint.upsert({
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
    footprints.push(footprint);
  }

  return footprints;
}

export async function getLatestImpactFootprint(actor: AppActor, workspaceId: string, memberId: string) {
  await requireWorkspaceMembership({ actor, workspaceId });
  
  return prisma.impactFootprint.findFirst({
    where: { workspaceId, memberId },
    orderBy: { createdAt: "desc" },
  });
}
