export type DashboardAttentionCounts = {
  pendingFlowsCount: number;
  pendingAgentApprovalsCount: number;
  unreadNotificationsCount: number;
  advisoryRequestsCount: number;
  canReviewAgentRuns: boolean;
};

export function getDashboardAttentionCounts({
  pendingFlowsCount,
  pendingAgentApprovalsCount,
  unreadNotificationsCount,
  advisoryRequestsCount,
  canReviewAgentRuns,
}: DashboardAttentionCounts) {
  const visiblePendingAgentApprovalsCount = canReviewAgentRuns ? pendingAgentApprovalsCount : 0;

  return {
    pendingAgentApprovalsCount: visiblePendingAgentApprovalsCount,
    totalAttentionItems:
      pendingFlowsCount
      + visiblePendingAgentApprovalsCount
      + unreadNotificationsCount
      + advisoryRequestsCount,
  };
}
