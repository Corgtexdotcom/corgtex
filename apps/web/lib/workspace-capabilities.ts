import type { MemberRole } from "@prisma/client";
import { requireWorkspaceMembership } from "@corgtex/domain";
import type { AppActor, MembershipSummary } from "@corgtex/shared";

import { getWorkspaceFeatureFlags, type WorkspaceFeatureFlagMap } from "@/lib/workspace-feature-flags";

export type WorkspaceCapabilities = {
  featureFlags: WorkspaceFeatureFlagMap;
  role: MemberRole | null;
  canReviewAgentRuns: boolean;
  canUseOperatorConsole: boolean;
  canManageAgentGovernance: boolean;
};

type BuildWorkspaceCapabilitiesParams = {
  featureFlags: WorkspaceFeatureFlagMap;
  role?: MemberRole | null;
};

type GetWorkspaceCapabilitiesOptions = {
  featureFlags?: WorkspaceFeatureFlagMap;
  membership?: MembershipSummary | null;
};

const AGENT_REVIEW_ROLES = new Set<MemberRole>(["ADMIN", "FACILITATOR"]);

export function buildWorkspaceCapabilities({
  featureFlags,
  role = null,
}: BuildWorkspaceCapabilitiesParams): WorkspaceCapabilities {
  const agentGovernanceEnabled = featureFlags.AGENT_GOVERNANCE;
  const canReviewAgentRuns = agentGovernanceEnabled && Boolean(role && AGENT_REVIEW_ROLES.has(role));

  return {
    featureFlags,
    role,
    canReviewAgentRuns,
    canUseOperatorConsole: canReviewAgentRuns,
    canManageAgentGovernance: agentGovernanceEnabled && role === "ADMIN",
  };
}

export async function getWorkspaceCapabilities(
  actor: AppActor,
  workspaceId: string,
  options: GetWorkspaceCapabilitiesOptions = {},
) {
  const [featureFlags, membership] = await Promise.all([
    options.featureFlags
      ? Promise.resolve(options.featureFlags)
      : getWorkspaceFeatureFlags(workspaceId),
    options.membership !== undefined
      ? Promise.resolve(options.membership)
      : requireWorkspaceMembership({ actor, workspaceId }),
  ]);

  return buildWorkspaceCapabilities({
    featureFlags,
    role: membership?.role ?? null,
  });
}
