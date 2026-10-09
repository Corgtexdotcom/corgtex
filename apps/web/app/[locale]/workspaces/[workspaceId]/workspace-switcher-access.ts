import { isGlobalOperator } from "@corgtex/domain";
import { prisma, type AppActor } from "@corgtex/shared";

export async function accessibleSwitcherWorkspaces<T extends { id: string }>(
  actor: AppActor,
  workspaces: T[],
): Promise<T[]> {
  // Operator discovery includes tenants without membership. Workspace routes
  // still require active membership, so discovery alone cannot grant entry.
  if (actor.kind !== "user" || !isGlobalOperator(actor)) return workspaces;
  const memberships = await prisma.member.findMany({
    where: {
      userId: actor.user.id,
      isActive: true,
      workspaceId: { in: workspaces.map((workspace) => workspace.id) },
    },
    select: { workspaceId: true },
  });
  const allowed = new Set(memberships.map((membership) => membership.workspaceId));
  return workspaces.filter((workspace) => allowed.has(workspace.id));
}
