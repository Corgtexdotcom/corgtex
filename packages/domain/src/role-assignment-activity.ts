import type { Prisma } from "@prisma/client";

export function activeRoleAssignmentWhere(now: Date = new Date()): Prisma.RoleAssignmentWhereInput {
  return {
    OR: [
      { expiresAt: null },
      { expiresAt: { gt: now } },
    ],
  };
}

export function isRoleAssignmentActive(
  assignment: { expiresAt?: Date | string | number | null },
  now: Date = new Date(),
) {
  if (!assignment.expiresAt) return true;
  const expiresAt = assignment.expiresAt instanceof Date
    ? assignment.expiresAt
    : new Date(assignment.expiresAt);
  return !Number.isNaN(expiresAt.getTime()) && expiresAt.getTime() > now.getTime();
}
