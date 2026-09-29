export type PersonalNewspaperItem = {
  id: string;
  kind: "ACTION" | "ADVICE" | "PROPOSAL" | "TENSION";
  title: string;
  href: string;
  status: string;
  reason?: "assigned" | "owner" | "advice";
  priority: number;
  dueAt: Date | null;
  updatedAt: Date;
};

export function rankPersonalNewspaperItems<T extends PersonalNewspaperItem>(items: T[], now: Date): T[] {
  const urgency = (item: T) => {
    const daysUntilDue = item.dueAt
      ? (item.dueAt.getTime() - now.getTime()) / 86_400_000
      : null;
    if (daysUntilDue !== null && daysUntilDue < 0) return 3;
    if (daysUntilDue !== null && daysUntilDue <= 2) return 2;
    if (daysUntilDue !== null && daysUntilDue <= 7) return 1;
    return 0;
  };

  return [...items].sort((left, right) =>
    urgency(right) - urgency(left)
    || right.priority - left.priority
    || (left.dueAt?.getTime() ?? Infinity) - (right.dueAt?.getTime() ?? Infinity)
    || right.updatedAt.getTime() - left.updatedAt.getTime()
    || left.id.localeCompare(right.id));
}
