import type { RoleOnboardingStatus } from "@prisma/client";
import {
  DigestReadRelease,
  type LineageKind,
  requireWorkspaceMembership,
  humanMemberIdentityWhere,
  isHumanMemberIdentity,
  isRoleAssignmentActive,
} from "@corgtex/domain";
import { prisma, type AppActor } from "@corgtex/shared";
import type { WorkItemSort, WorkItemSortable } from "@/lib/work-item-view";
import { compareWorkItemSortValues, firstSearchParam } from "@/lib/work-item-view";

type DateLike = Date | string | number;

export const ROLE_STAFFING_FILTERS = [
  "ALL",
  "OPEN",
  "STAFFED",
  "MULTI_HOLDER",
  "NEEDS_ONBOARDING",
  "MINE",
] as const;

export type RoleStaffingFilter = (typeof ROLE_STAFFING_FILTERS)[number];

export const ROLE_KANBAN_COLUMN_IDS = [
  "OPEN",
  "STAFFED",
  "MULTI_HOLDER",
  "NEEDS_ONBOARDING",
] as const;

export type RoleKanbanColumnId = (typeof ROLE_KANBAN_COLUMN_IDS)[number];

export type RoleDirectoryMember = {
  id: string;
  name: string;
  email: string;
};

export type RoleDirectoryCircle = {
  id: string;
  name: string;
};

export type RoleDirectoryAssignment = {
  id: string;
  memberId: string;
  assignedAt?: DateLike | null;
  expiresAt?: DateLike | null;
  transferReason?: string | null;
  member: {
    id: string;
    kind?: "HUMAN" | "SYSTEM" | null;
    isActive?: boolean | null;
    user?: {
      id?: string | null;
      email?: string | null;
      displayName?: string | null;
      avatarUrl?: string | null;
      bio?: string | null;
    } | null;
  };
};

export type RoleDirectoryRole = {
  id: string;
  name: string;
  purposeMd?: string | null;
  accountabilities: string[];
  artifacts: string[];
  coreRoleType?: string | null;
  createdAt: DateLike;
  updatedAt: DateLike;
  circle: RoleDirectoryCircle | null;
  assignments: RoleDirectoryAssignment[];
};

export type RoleDirectoryOnboarding = {
  roleId: string;
  memberId: string;
  conversationId: string | null;
  status: RoleOnboardingStatus | string;
  updatedAt?: DateLike | null;
};

export type RoleDirectoryData = {
  roles: RoleDirectoryRole[];
  circles: RoleDirectoryCircle[];
  members: RoleDirectoryMember[];
  onboardingByRoleMember: Map<string, RoleDirectoryOnboarding>;
};

const ONBOARDING_OPEN_STATUSES = new Set<string>(["PENDING", "ACTIVE"]);

const KANBAN_SORT_PRIORITY: Record<RoleKanbanColumnId, number> = {
  OPEN: 4,
  NEEDS_ONBOARDING: 3,
  MULTI_HOLDER: 2,
  STAFFED: 1,
};

// Identical original projections share admission. Different projections of the
// same ID remain separate: an admitted basic profile cannot certify a stale bio.
const directorySnapshotKey = (record: {id: string}) => JSON.stringify(record);
async function captureDirectoryPage<T extends {id: string}>(release: DigestReadRelease, kind: LineageKind, records: T[]) {
  const unique = [...new Map(records.map(record => [directorySnapshotKey(record), record])).values()];
  const admitted = new Set<string>();
  for (let offset = 0; offset < unique.length; offset += 75) {
    const captured = await release.captureDirectory(kind, unique.slice(offset, offset + 75));
    for (const row of captured.records) admitted.add(directorySnapshotKey(row));
  }
  return records.filter(record => admitted.has(directorySnapshotKey(record)));
}

export async function loadRoleDirectoryData(
  actor: AppActor,
  workspaceId: string,
  opts: { roleIds?: string[] } = {},
): Promise<RoleDirectoryData> {
  await requireWorkspaceMembership({ actor, workspaceId });
  const release = new DigestReadRelease(actor, workspaceId);
  const roleIdFilter = opts.roleIds ? { id: { in: opts.roleIds } } : {};
  const onboardingRoleFilter = opts.roleIds ? { roleId: { in: opts.roleIds } } : {};

  const [roles, circles, members, onboardingSessions] = await Promise.all([
    prisma.role.findMany({
      where: {
        ...roleIdFilter,
        archivedAt: null,
        circle: {
          workspaceId,
          archivedAt: null,
        },
      },
      include: {
        circle: true,
        assignments: {
          include: {
            member: {
              include: {
                user: {
                  select: {
                    id: true,
                    email: true,
                    displayName: true,
                    avatarUrl: true,
                    bio: true,
                  },
                },
              },
            },
          },
          orderBy: { assignedAt: "desc" },
        },
      },
      orderBy: [{ circle: { sortOrder: "asc" } }, { sortOrder: "asc" }, { createdAt: "asc" }],
    }),
    prisma.circle.findMany({
      where: { workspaceId, archivedAt: null },
      orderBy: [{ sortOrder: "asc" }, { createdAt: "asc" }],
    }),
    prisma.member.findMany({
      where: {
        workspaceId,
        isActive: true,
        ...humanMemberIdentityWhere(),
      },
      include: {
        user: {
          select: {
            id: true,
            email: true,
            displayName: true,
          },
        },
      },
      orderBy: { joinedAt: "asc" },
    }),
    prisma.roleOnboardingSession.findMany({
      where: {
        workspaceId,
        ...onboardingRoleFilter,
        status: { in: ["PENDING", "ACTIVE"] },
      },
      orderBy: { updatedAt: "desc" },
    }),
  ]);

  const admittedRoles = await captureDirectoryPage(release, "Role", roles);
  const admittedCircles = await captureDirectoryPage(release, "Circle", circles);
  const circleById = new Map(admittedCircles.map((circle) => [circle.id, circle]));
  const admittedAssignments = await captureDirectoryPage(release, "RoleAssignment", admittedRoles.flatMap(role => role.assignments));
  const assignmentMembers = new Map(admittedAssignments.map(assignment => [assignment.id, {
    ...assignment.member, user: {id: assignment.member.user.id, email: assignment.member.user.email, displayName: assignment.member.user.displayName},
  }]));
  const admittedMembers = await captureDirectoryPage(release, "Member", [...members, ...assignmentMembers.values()]);
  const memberKeys = new Set(admittedMembers.map(directorySnapshotKey));
  const memberOptions = members.filter(member => memberKeys.has(directorySnapshotKey(member)));
  const memberAssignments = admittedAssignments.filter(assignment => memberKeys.has(directorySnapshotKey(assignmentMembers.get(assignment.id)!)));
  const admittedUsers = await captureDirectoryPage(release, "User", [...memberOptions.map(member => member.user),
    ...memberAssignments.map(assignment => assignment.member.user)]);
  const profileKeys = new Set(admittedUsers.map(directorySnapshotKey));
  const assignmentsByRole = new Map<string, typeof admittedAssignments>();
  for (const assignment of memberAssignments) {
    if (!profileKeys.has(directorySnapshotKey(assignment.member.user))) continue;
    const group = assignmentsByRole.get(assignment.roleId) ?? [];
    group.push(assignment); assignmentsByRole.set(assignment.roleId, group);
  }
  const directoryRoles: RoleDirectoryRole[] = [];
  for (const role of admittedRoles) {
    const assignments = assignmentsByRole.get(role.id) ?? [];
    const circle = circleById.get(role.circle.id);
    directoryRoles.push({
      id: role.id, name: role.name, purposeMd: role.purposeMd,
      accountabilities: role.accountabilities, artifacts: role.artifacts, coreRoleType: role.coreRoleType,
      createdAt: role.createdAt, updatedAt: role.updatedAt,
      circle: circle ? { id: circle.id, name: circle.name } : null,
      assignments: assignments.map((assignment) => ({
          id: assignment.id, memberId: assignment.memberId, assignedAt: assignment.assignedAt,
          expiresAt: assignment.expiresAt, transferReason: assignment.transferReason,
          member: { id: assignment.member.id, kind: assignment.member.kind, isActive: assignment.member.isActive,
            user: assignment.member.user },
        })),
    });
  }
  const sourceRoleById = new Map(admittedRoles.map((role) => [role.id, role]));
  directoryRoles.sort((left, right) => {
    const leftSource = sourceRoleById.get(left.id)!;
    const rightSource = sourceRoleById.get(right.id)!;
    const leftOrder = left.circle ? circleById.get(left.circle.id)!.sortOrder : 0;
    const rightOrder = right.circle ? circleById.get(right.circle.id)!.sortOrder : 0;
    return leftOrder - rightOrder || leftSource.sortOrder - rightSource.sortOrder
      || new Date(left.createdAt).getTime() - new Date(right.createdAt).getTime();
  });
  const roleIds = new Set(directoryRoles.map((role) => role.id));
  const assignments = new Set(directoryRoles.flatMap((role) => role.assignments.map((assignment) => roleOnboardingKey(role.id, assignment.memberId))));
  const sessions = await captureDirectoryPage(release, "RoleOnboardingSession", onboardingSessions.filter((session) =>
    roleIds.has(session.roleId) && assignments.has(roleOnboardingKey(session.roleId, session.memberId))));
  return release.finish({
    roles: directoryRoles,
    circles: admittedCircles.map((circle) => ({ id: circle.id, name: circle.name })),
    members: memberOptions.filter(member => profileKeys.has(directorySnapshotKey(member.user))).map((member) => ({
      id: member.id, name: member.user.displayName ?? member.user.email, email: member.user.email,
    })),
    onboardingByRoleMember: latestOnboardingByRoleMember(sessions.map((session) => ({
      roleId: session.roleId, memberId: session.memberId, conversationId: session.conversationId,
      status: session.status, updatedAt: session.updatedAt,
    }))),
  });
}

export function roleOnboardingKey(roleId: string, memberId: string) {
  return `${roleId}:${memberId}`;
}

export function latestOnboardingByRoleMember(sessions: readonly RoleDirectoryOnboarding[]) {
  const onboardingByRoleMember = new Map<string, RoleDirectoryOnboarding>();
  for (const session of sessions) {
    const key = roleOnboardingKey(session.roleId, session.memberId);
    if (!onboardingByRoleMember.has(key)) {
      onboardingByRoleMember.set(key, session);
    }
  }
  return onboardingByRoleMember;
}

export function normalizeRoleStaffingFilter(value: string | string[] | undefined): RoleStaffingFilter {
  const candidate = firstSearchParam(value);
  return ROLE_STAFFING_FILTERS.includes(candidate as RoleStaffingFilter)
    ? candidate as RoleStaffingFilter
    : "ALL";
}

export function roleMemberName(member: RoleDirectoryAssignment["member"], fallback: string) {
  return member.user?.displayName?.trim() || member.user?.email?.trim() || fallback;
}

export function activeHumanRoleAssignments(role: RoleDirectoryRole, now = new Date()) {
  return role.assignments.filter((assignment) => (
    isRoleAssignmentActive(assignment, now)
      && assignment.member.isActive !== false
      && isHumanMemberIdentity(assignment.member)
  ));
}

function roleNeedsOnboarding(
  role: RoleDirectoryRole,
  onboardingByRoleMember: ReadonlyMap<string, RoleDirectoryOnboarding>,
  now = new Date(),
) {
  return activeHumanRoleAssignments(role, now).some((assignment) => {
    const onboarding = onboardingByRoleMember.get(roleOnboardingKey(role.id, assignment.memberId));
    return onboarding ? ONBOARDING_OPEN_STATUSES.has(String(onboarding.status)) : false;
  });
}

export function roleKanbanColumnId(
  role: RoleDirectoryRole,
  onboardingByRoleMember: ReadonlyMap<string, RoleDirectoryOnboarding>,
  now = new Date(),
): RoleKanbanColumnId {
  const activeAssignments = activeHumanRoleAssignments(role, now);
  if (activeAssignments.length === 0) return "OPEN";
  if (roleNeedsOnboarding(role, onboardingByRoleMember, now)) return "NEEDS_ONBOARDING";
  if (activeAssignments.length > 1) return "MULTI_HOLDER";
  return "STAFFED";
}

export function roleMatchesStaffingFilter(params: {
  role: RoleDirectoryRole;
  filter: RoleStaffingFilter;
  currentMemberId?: string | null;
  onboardingByRoleMember: ReadonlyMap<string, RoleDirectoryOnboarding>;
  now?: Date;
}) {
  const now = params.now ?? new Date();
  const activeAssignments = activeHumanRoleAssignments(params.role, now);
  if (params.filter === "ALL") return true;
  if (params.filter === "OPEN") return activeAssignments.length === 0;
  if (params.filter === "STAFFED") return activeAssignments.length > 0;
  if (params.filter === "MULTI_HOLDER") return activeAssignments.length > 1;
  if (params.filter === "NEEDS_ONBOARDING") {
    return roleNeedsOnboarding(params.role, params.onboardingByRoleMember, now);
  }
  return Boolean(params.currentMemberId && activeAssignments.some((assignment) => assignment.memberId === params.currentMemberId));
}

export function roleMatchesCircleFilter(role: RoleDirectoryRole, circleIds: readonly string[]) {
  return circleIds.length === 0 || Boolean(role.circle && circleIds.includes(role.circle.id));
}

export function roleMatchesMemberFilter(role: RoleDirectoryRole, memberIds: readonly string[], now = new Date()) {
  if (memberIds.length === 0) return true;
  return activeHumanRoleAssignments(role, now).some((assignment) => memberIds.includes(assignment.memberId));
}

export function roleDirectorySort(
  role: RoleDirectoryRole,
  onboardingByRoleMember: ReadonlyMap<string, RoleDirectoryOnboarding>,
  now = new Date(),
): WorkItemSortable {
  const columnId = roleKanbanColumnId(role, onboardingByRoleMember, now);
  const activeAssignments = activeHumanRoleAssignments(role, now);
  return {
    priority: (KANBAN_SORT_PRIORITY[columnId] * 1000) + (role.accountabilities.length * 10) + activeAssignments.length,
    date: role.updatedAt ?? role.createdAt ?? null,
    alpha: `${role.circle?.name ?? ""} ${role.name}`,
  };
}

export function sortRoleDirectoryRoles(
  roles: readonly RoleDirectoryRole[],
  sort: WorkItemSort,
  onboardingByRoleMember: ReadonlyMap<string, RoleDirectoryOnboarding>,
  now = new Date(),
) {
  return [...roles].sort((left, right) => compareWorkItemSortValues(
    roleDirectorySort(left, onboardingByRoleMember, now),
    roleDirectorySort(right, onboardingByRoleMember, now),
    sort,
  ));
}
