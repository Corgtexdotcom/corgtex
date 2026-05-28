export type DashboardAttentionCounts = {
  unreadNotificationsCount: number;
};

export function getDashboardAttentionCounts({
  unreadNotificationsCount,
}: DashboardAttentionCounts) {
  return {
    totalAttentionItems: unreadNotificationsCount,
  };
}
