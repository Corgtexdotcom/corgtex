import type { WorkItemSortable } from "@/lib/work-item-view";

export const ROLE_STAFFING_COLUMN_IDS = ["open", "staffed", "shared"] as const;

export type RoleStaffingColumnId = (typeof ROLE_STAFFING_COLUMN_IDS)[number];

type DateLike = Date | string | number;

export type RoleStaffingAssignment = {
  member?: {
    user?: {
      email?: string | null;
      displayName?: string | null;
    } | null;
  } | null;
};

export type RoleStaffingRole = {
  id: string;
  name: string;
  purposeMd?: string | null;
  accountabilities?: string[] | null;
  assignments?: RoleStaffingAssignment[] | null;
  createdAt?: DateLike | null;
  updatedAt?: DateLike | null;
};

export type RoleStaffingCircle = {
  id: string;
  name: string;
  roles?: RoleStaffingRole[] | null;
  childCircles?: RoleStaffingCircle[] | null;
};

export type RoleStaffingCard = {
  id: string;
  status: RoleStaffingColumnId;
  role: RoleStaffingRole;
  circle: {
    id: string;
    name: string;
  };
  holderCount: number;
  holderNames: string[];
  accountabilityCount: number;
};

const STATUS_SORT_PRIORITY: Record<RoleStaffingColumnId, number> = {
  open: 3,
  staffed: 2,
  shared: 1,
};

export function roleStaffingStatus(holderCount: number): RoleStaffingColumnId {
  if (holderCount <= 0) return "open";
  if (holderCount === 1) return "staffed";
  return "shared";
}

export function roleAssignmentDisplayName(assignment: RoleStaffingAssignment) {
  const user = assignment.member?.user;
  return user?.displayName?.trim() || user?.email?.trim() || null;
}

export function flattenRoleStaffingCards(circles: readonly RoleStaffingCircle[]) {
  const cards: RoleStaffingCard[] = [];

  function walk(circle: RoleStaffingCircle) {
    for (const role of circle.roles ?? []) {
      const holderNames = (role.assignments ?? [])
        .map(roleAssignmentDisplayName)
        .filter((name): name is string => Boolean(name));
      const holderCount = role.assignments?.length ?? 0;
      cards.push({
        id: role.id,
        status: roleStaffingStatus(holderCount),
        role,
        circle: {
          id: circle.id,
          name: circle.name,
        },
        holderCount,
        holderNames,
        accountabilityCount: role.accountabilities?.length ?? 0,
      });
    }

    for (const child of circle.childCircles ?? []) {
      walk(child);
    }
  }

  for (const circle of circles) {
    walk(circle);
  }

  return cards;
}

export function roleStaffingSort(card: RoleStaffingCard): WorkItemSortable {
  return {
    priority: (STATUS_SORT_PRIORITY[card.status] * 1000) + (card.accountabilityCount * 10) + card.holderCount,
    date: card.role.updatedAt ?? card.role.createdAt ?? null,
    alpha: `${card.circle.name} ${card.role.name}`,
  };
}
