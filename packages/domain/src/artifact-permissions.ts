import { prisma } from "@corgtex/shared";

export async function checkArtifactPermission(params: {
  workspaceId: string;
  artifactName: string;
  actorMemberId: string;
}): Promise<{ allowed: boolean; gatekeeperRoleId?: string; gatekeeperMemberIds?: string[] }> {
  // Find a role that claims this artifact
  const roles = await prisma.role.findMany({
    where: {
      circle: { workspaceId: params.workspaceId },
      artifacts: { has: params.artifactName },
    },
    include: {
      assignments: {
        select: { memberId: true },
      },
    },
  });

  if (roles.length === 0) {
    // If no role claims exclusive control, anyone is implicitly allowed to act on it
    return { allowed: true };
  }

  // If a role claims the artifact, the actor must be assigned to at least one such role
  for (const role of roles) {
    const isHolder = role.assignments.some(a => a.memberId === params.actorMemberId);
    if (isHolder) {
      return { allowed: true };
    }
  }

  // The actor is not a holder of any role claiming this artifact.
  // Pick the first claiming role as the gatekeeper to report back.
  const gatekeeperRole = roles[0];
  const gatekeeperMemberIds = gatekeeperRole.assignments.map(a => a.memberId);

  return {
    allowed: false,
    gatekeeperRoleId: gatekeeperRole.id,
    gatekeeperMemberIds,
  };
}
