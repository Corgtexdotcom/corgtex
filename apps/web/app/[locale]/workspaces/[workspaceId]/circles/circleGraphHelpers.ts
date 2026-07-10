export type CircleGraphUser = {
  id?: string;
  email?: string | null;
  displayName?: string | null;
  avatarUrl?: string | null;
  bio?: string | null;
};

export type CircleGraphMember = {
  id?: string;
  kind?: "HUMAN" | "SYSTEM" | null;
  user?: CircleGraphUser | null;
};

export type CircleGraphAssignment = {
  id: string;
  member?: CircleGraphMember | null;
};

export type CircleGraphRole = {
  id: string;
  name: string;
  purposeMd?: string | null;
  accountabilities?: string[];
  assignments?: CircleGraphAssignment[];
};

export type CircleGraphCircle = {
  id: string;
  workspaceId: string;
  parentCircleId?: string | null;
  name: string;
  purposeMd?: string | null;
  domainMd?: string | null;
  maturityStage: string;
  roles?: CircleGraphRole[];
  childCircles?: CircleGraphCircle[];
};

export type CircleMemberPreview = {
  memberId: string;
  userId?: string;
  kind?: "HUMAN" | "SYSTEM" | null;
  displayName: string;
  email: string;
  avatarUrl?: string | null;
  bio?: string | null;
  roleNames: string[];
  workspaceId: string;
};

export function getInitials(name?: string | null, email?: string | null) {
  const source = name?.trim() || email?.trim() || "?";
  const parts = source.split(/\s+/).filter(Boolean);
  if (parts.length >= 2) return `${parts[0][0]}${parts[1][0]}`.toUpperCase();
  return source.slice(0, 2).toUpperCase();
}

export function getDisplayName(user?: CircleGraphUser | null) {
  return user?.displayName?.trim() || user?.email?.trim() || "Unknown";
}

export function collectCircleMembers(circle: CircleGraphCircle): CircleMemberPreview[] {
  const people = new Map<string, CircleMemberPreview>();

  for (const role of circle.roles ?? []) {
    for (const assignment of role.assignments ?? []) {
      const member = assignment.member;
      if (!member?.id) continue;

      const user = member.user;
      const existing = people.get(member.id);
      if (existing) {
        if (!existing.roleNames.includes(role.name)) {
          existing.roleNames.push(role.name);
        }
        continue;
      }

      people.set(member.id, {
        memberId: member.id,
        userId: user?.id,
        kind: member.kind,
        displayName: getDisplayName(user),
        email: user?.email || "",
        avatarUrl: user?.avatarUrl,
        bio: user?.bio,
        roleNames: [role.name],
        workspaceId: circle.workspaceId,
      });
    }
  }

  return [...people.values()].sort((a, b) => a.displayName.localeCompare(b.displayName));
}

export function countAccountabilities(circle: CircleGraphCircle) {
  return (circle.roles ?? []).reduce((total, role) => total + (role.accountabilities?.length ?? 0), 0);
}
