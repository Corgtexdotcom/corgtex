import { prisma, toInputJson } from "@corgtex/shared";
import type { AppActor } from "@corgtex/shared";
import { requireWorkspaceMembership } from "./auth";
import { refreshImpactFootprints } from "./impact-footprint";

/**
 * Governance maturity score (0-100) composed of 5 dimensions:
 * - participationPct: Average approval participation rate
 * - decisionVelocityHrs: Average hours to finalize approval flows
 * - policyCoverage: Ratio of approved policies to total proposals
 * - tensionResolutionPct: Percentage of tensions resolved
 * - constitutionFreshness: Score based on how recently the constitution was updated
 */

export async function calculateGovernanceScore(workspaceId: string, periodStart: Date, periodEnd: Date) {
  const [
    approvalFlows,
    totalMembers,
    proposalCount,
    policyCount,
    tensions,
    latestConstitution,
  ] = await Promise.all([
    prisma.approvalFlow.findMany({
      where: {
        workspaceId,
        closedAt: { gte: periodStart, lte: periodEnd },
        status: { in: ["APPROVED", "REJECTED"] },
      },
      include: {
        decisions: true,
      },
    }),
    prisma.member.count({ where: { workspaceId, isActive: true } }),
    prisma.proposal.count({
      where: { workspaceId, createdAt: { gte: periodStart, lte: periodEnd } },
    }),
    prisma.policyCorpus.count({
      where: { workspaceId, acceptedAt: { gte: periodStart, lte: periodEnd } },
    }),
    prisma.tension.findMany({
      where: { workspaceId, createdAt: { gte: periodStart, lte: periodEnd } },
      select: { status: true },
    }),
    prisma.constitution.findFirst({
      where: { workspaceId },
      orderBy: { createdAt: "desc" },
      select: { createdAt: true },
    }),
  ]);

  // 1. Participation rate (0-100)
  let participationPct = 0;
  if (approvalFlows.length > 0 && totalMembers > 0) {
    const totalParticipation = approvalFlows.reduce((sum, flow) => {
      return sum + (flow.decisions.length / totalMembers) * 100;
    }, 0);
    participationPct = Math.round(totalParticipation / approvalFlows.length);
  }

  // 2. Decision velocity (0-100, lower hours = higher score)
  let decisionVelocityHrs = 0;
  let velocityScore = 0;
  if (approvalFlows.length > 0) {
    const totalHours = approvalFlows.reduce((sum, flow) => {
      if (!flow.openedAt || !flow.closedAt) return sum;
      const hours = (flow.closedAt.getTime() - flow.openedAt.getTime()) / (1000 * 60 * 60);
      return sum + hours;
    }, 0);
    decisionVelocityHrs = Math.round(totalHours / approvalFlows.length);
    // Target: under 24h = 100, 72h = 50, 168h+ = 0
    velocityScore = Math.max(0, Math.min(100, Math.round(100 - (decisionVelocityHrs / 168) * 100)));
  }

  // 3. Policy coverage (0-100)
  let policyCoverage = 0;
  if (proposalCount > 0) {
    policyCoverage = Math.min(100, Math.round((policyCount / proposalCount) * 100));
  }

  // 4. Tension resolution (0-100)
  let tensionResolutionPct = 0;
  if (tensions.length > 0) {
    const resolved = tensions.filter((t) => t.status === "COMPLETED").length;
    tensionResolutionPct = Math.round((resolved / tensions.length) * 100);
  }

  // 5. Constitution freshness (0-100)
  let constitutionFreshness = 0;
  if (latestConstitution) {
    const daysSinceUpdate = (periodEnd.getTime() - latestConstitution.createdAt.getTime()) / (1000 * 60 * 60 * 24);
    // Under 30 days = 100, 90 days = 50, 180+ days = 0
    constitutionFreshness = Math.max(0, Math.min(100, Math.round(100 - (daysSinceUpdate / 180) * 100)));
  }

  // Overall score: weighted average
  const overallScore = Math.round(
    participationPct * 0.25 +
    velocityScore * 0.20 +
    policyCoverage * 0.20 +
    tensionResolutionPct * 0.20 +
    constitutionFreshness * 0.15
  );

  return {
    overallScore,
    participationPct,
    decisionVelocityHrs,
    policyCoverage,
    tensionResolutionPct,
    constitutionFreshness,
  };
}

export async function recordGovernanceScore(workspaceId: string, periodStart: Date, periodEnd: Date) {
  const score = await calculateGovernanceScore(workspaceId, periodStart, periodEnd);

  const newScore = await prisma.governanceScore.create({
    data: {
      workspaceId,
      periodStart,
      periodEnd,
      overallScore: score.overallScore,
      participationPct: score.participationPct,
      decisionVelocityHrs: score.decisionVelocityHrs,
      policyCoverage: score.policyCoverage,
      tensionResolutionPct: score.tensionResolutionPct,
      constitutionFreshness: score.constitutionFreshness,
      detailJson: toInputJson(score),
    },
  });

  // Calculate and update individual member impact footprints automatically
  await refreshImpactFootprints(workspaceId, periodStart, periodEnd).catch(err => {
    console.error("Failed to refresh impact footprints during governance scoring", err);
  });

  return newScore;
}

export async function recalculateGovernanceScore(actor: AppActor, workspaceId: string, periodStart: Date, periodEnd: Date) {
  await requireWorkspaceMembership({
    actor,
    workspaceId,
    allowedRoles: ["FACILITATOR", "ADMIN"],
  });

  return recordGovernanceScore(workspaceId, periodStart, periodEnd);
}

export async function listGovernanceScores(actor: AppActor, workspaceId: string, opts?: {
  take?: number;
}) {
  await requireWorkspaceMembership({ actor, workspaceId });

  return prisma.governanceScore.findMany({
    where: { workspaceId },
    orderBy: { periodEnd: "desc" },
    take: opts?.take ?? 12,
  });
}

export async function getLatestGovernanceScore(workspaceId: string) {
  return prisma.governanceScore.findFirst({
    where: { workspaceId },
    orderBy: { periodEnd: "desc" },
  });
}
