import type { AppActor } from "@corgtex/shared";
import { prisma } from "@corgtex/shared";
import { humanMemberIdentityWhere } from "@corgtex/domain";
import type { DeliberationMentionTarget } from "./deliberation-mentions";

export type DeliberationTargetOption = DeliberationMentionTarget;

export async function getDeliberationTargets(params: {
  actor: AppActor;
  workspaceId: string;
  parentCircleId?: string | null;
}): Promise<{ options: DeliberationTargetOption[]; defaultValue: string; actorMemberId: string | null; actorCircleIds: string[] }> {
  const actorUserId = params.actor.kind === "user" ? params.actor.user.id : null;
  const [circles, members, actorMember] = await Promise.all([
    prisma.circle.findMany({
      where: { workspaceId: params.workspaceId, archivedAt: null },
      select: { id: true, name: true },
      orderBy: { name: "asc" },
    }),
    prisma.member.findMany({
      where: { workspaceId: params.workspaceId, isActive: true, ...humanMemberIdentityWhere() },
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
    ...circles.map((circle) => ({
      value: `circle:${circle.id}`,
      label: `Circle: ${circle.name}`,
      kind: "circle" as const,
      name: circle.name,
    })),
    ...members.map((member) => {
      const name = member.user.displayName || member.user.email;
      return {
        value: `member:${member.id}`,
        label: `Person: ${name}`,
        kind: "member" as const,
        name,
      };
    }),
  ];

  const parentCircle = params.parentCircleId && circles.some((circle) => circle.id === params.parentCircleId)
    ? `circle:${params.parentCircleId}`
    : "";
  const actorCircle = actorMember?.roleAssignments
    .map((assignment) => assignment.role.circle)
    .find((circle) => circle && !circle.archivedAt);
  const actorCircleIds = actorMember?.roleAssignments.flatMap((assignment) => {
    const circle = assignment.role.circle;
    return circle && !circle.archivedAt ? [circle.id] : [];
  }) ?? [];

  return {
    options,
    defaultValue: parentCircle || (actorCircle ? `circle:${actorCircle.id}` : circles[0] ? `circle:${circles[0].id}` : ""),
    actorMemberId: actorMember?.id ?? null,
    actorCircleIds,
  };
}
