export type DashboardAttentionCounts = {
  unreadNotificationsCount: number;
  proposalReviewRequestsCount?: number;
};

export function getDashboardAttentionCounts({
  unreadNotificationsCount,
  proposalReviewRequestsCount = 0,
}: DashboardAttentionCounts) {
  return {
    totalAttentionItems: unreadNotificationsCount + proposalReviewRequestsCount,
  };
}
