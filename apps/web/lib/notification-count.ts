export function notificationUnreadCountLabel(summary: { count: number; complete: boolean; available?: boolean }) {
  if (summary.available === false || (!summary.complete && summary.count === 0)) return "…";
  return `${summary.count}${summary.complete ? "" : "+"}`;
}
