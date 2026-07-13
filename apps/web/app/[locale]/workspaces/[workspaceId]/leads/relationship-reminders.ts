export type RelationshipReminder = {
  id: string;
  title: string;
  type: string;
  dueAt?: Date | string | null;
  completedAt?: Date | string | null;
  createdAt: Date | string;
};

function isOpenRelationshipReminder(activity: RelationshipReminder) {
  return activity.type === "TASK" && !activity.completedAt;
}

function timeValue(value: Date | string | null | undefined, fallback: Date | string) {
  const raw = value ?? fallback;
  const time = new Date(raw).getTime();
  return Number.isFinite(time) ? time : Number.MAX_SAFE_INTEGER;
}

export function sortRelationshipReminders<T extends RelationshipReminder>(activities: readonly T[]) {
  return [...activities].sort((left, right) => {
    const dueDiff = timeValue(left.dueAt, left.createdAt) - timeValue(right.dueAt, right.createdAt);
    if (dueDiff !== 0) return dueDiff;
    return timeValue(left.createdAt, left.createdAt) - timeValue(right.createdAt, right.createdAt);
  });
}

export function openRelationshipReminders<T extends RelationshipReminder>(activities: readonly T[]) {
  return sortRelationshipReminders(activities.filter(isOpenRelationshipReminder));
}

export function splitRelationshipReminders<T extends RelationshipReminder>(
  activities: readonly T[],
  now: Date | number = Date.now(),
) {
  const nowMs = now instanceof Date ? now.getTime() : now;
  const open = openRelationshipReminders(activities);
  return {
    open,
    overdue: open.filter((activity) => activity.dueAt && timeValue(activity.dueAt, activity.createdAt) < nowMs),
    upcoming: open.filter((activity) => !activity.dueAt || timeValue(activity.dueAt, activity.createdAt) >= nowMs),
  };
}
