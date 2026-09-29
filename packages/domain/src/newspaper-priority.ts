export type PersonalNewspaperItem = {
  id: string;
  kind: "ACTION" | "ADVICE" | "PROPOSAL" | "TENSION";
  title: string;
  href: string;
  status: string;
  reason?: "assigned" | "owner" | "advice";
  priority: number;
  dueAt: Date | null;
  dueAtKind?: "DATE" | "DATETIME";
  updatedAt: Date;
};

export function rankPersonalNewspaperItems<T extends PersonalNewspaperItem>(items: T[], now: Date): T[] {
  const urgency = (item: T) => {
    if (!item.dueAt) return 0;
    const dateOnly = item.dueAtKind === "DATE" || (!item.dueAtKind && item.kind === "ACTION");
    if (!dateOnly) {
      const daysUntilDue = (item.dueAt.getTime() - now.getTime()) / 86_400_000;
      if (daysUntilDue < 0) return 3;
      if (daysUntilDue <= 2) return 2;
      if (daysUntilDue <= 7) return 1;
      return 0;
    }
    const dueDay = item.dueAt
      ? Date.UTC(item.dueAt.getUTCFullYear(), item.dueAt.getUTCMonth(), item.dueAt.getUTCDate())
      : null;
    const today = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate());
    const daysUntilDue = dueDay === null ? null : (dueDay - today) / 86_400_000;
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
