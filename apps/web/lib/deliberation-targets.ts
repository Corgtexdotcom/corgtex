import type { AppActor } from "@corgtex/shared";
import { prisma } from "@corgtex/shared";

export type DeliberationTargetOption = {
  value: string;
  label: string;
};

export async function getDeliberationTargets(params: {
  actor: AppActor;
  workspaceId: string;
  parentCircleId?: string | null;
}): Promise<{ options: DeliberationTargetOption[]; defaultValue: string }> {
  const actorUserId = params.actor.kind === "user" ? params.actor.user.id : null;
  const [circles, members, actorMember] = await Promise.all([
    prisma.circle.findMany({
      where: { workspaceId: params.workspaceId, archivedAt: null },
      select: { id: true, name: true },
      orderBy: { name: "asc" },
    }),
    prisma.member.findMany({
      where: { workspaceId: params.workspaceId, isActive: true },
      include: { user: { select: { displayName: true, email: true } } },
      orderBy: { joinedAt: "asc" },
    }),
    actorUserId
      ? prisma.member.findUnique({
          where: { workspaceId_userId: { workspaceId: params.workspaceId, userId: actorUserId } },
          include: {
            roleAssignments: {
              include: { role: { include: { circle: { select: { id: true, name: true, archivedAt: true } } } } },
              orderBy: { assignedAt: "asc" },
            },
          },
        })
      : null,
  ]);

  const options = [
    ...circles.map((circle) => ({ value: `circle:${circle.id}`, label: `Circle: ${circle.name}` })),
    ...members.map((member) => ({
      value: `member:${member.id}`,
      label: `Person: ${member.user.displayName || member.user.email}`,
    })),
  ];

  const parentCircle = params.parentCircleId && circles.some((circle) => circle.id === params.parentCircleId)
    ? `circle:${params.parentCircleId}`
    : "";
  const actorCircle = actorMember?.roleAssignments
    .map((assignment) => assignment.role.circle)
    .find((circle) => circle && !circle.archivedAt);

  return {
    options,
    defaultValue: parentCircle || (actorCircle ? `circle:${actorCircle.id}` : circles[0] ? `circle:${circles[0].id}` : ""),
  };
}
