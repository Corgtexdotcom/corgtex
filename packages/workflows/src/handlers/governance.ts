import { recordGovernanceScore } from "@corgtex/domain";
import { prisma } from "@corgtex/shared";

export async function handleGovernanceScoring(workspaceId: string) {
  const now = new Date();
  const thirtyDaysAgo = new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000);
  await recordGovernanceScore(workspaceId, thirtyDaysAgo, now);
}

