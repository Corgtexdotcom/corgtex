import { prisma } from "@corgtex/shared";
import type { AppActor } from "@corgtex/shared";
import { AppError } from "./errors";
import { requestPasswordReset } from "./password-reset";
import { createMember } from "./members";

function requireGlobalAdmin(actor: AppActor) {
  if (actor.kind !== "user" || actor.user.email !== "janbrezina@icloud.com") {
    throw new AppError(403, "FORBIDDEN", "Only global admins can perform this action.");
  }
}

export async function listAllWorkspaces(actor: AppActor) {
  requireGlobalAdmin(actor);
  const workspaces = await prisma.workspace.findMany({
    orderBy: { createdAt: "desc" },
    include: {
      _count: {
        select: { members: true },
      },
    },
  });
  return workspaces.map(w => ({
    id: w.id,
    slug: w.slug,
    name: w.name,
    createdAt: w.createdAt,
    memberCount: w._count.members,
  }));
}

export async function listAllUsers(actor: AppActor) {
  requireGlobalAdmin(actor);
  return prisma.user.findMany({
    orderBy: { email: "asc" },
    include: {
      memberships: {
        include: {
          workspace: { select: { slug: true, name: true } }
        }
      }
    }
  });
}

export async function adminTriggerPasswordReset(actor: AppActor, email: string) {
  requireGlobalAdmin(actor);
  
  const result = await requestPasswordReset(email);
  if (!result) {
    throw new AppError(404, "NOT_FOUND", "User not found.");
  }
  return result.token;
}

export async function adminAddToWorkspace(actor: AppActor, params: {
  userId: string;
  workspaceId: string;
  role: "CONTRIBUTOR" | "FACILITATOR" | "FINANCE_STEWARD" | "ADMIN";
}) {
  requireGlobalAdmin(actor);
  
  const user = await prisma.user.findUnique({
    where: { id: params.userId },
  });
  
  if (!user) throw new AppError(404, "NOT_FOUND", "User not found.");

  return createMember(actor, {
    workspaceId: params.workspaceId,
    email: user.email,
    displayName: user.displayName,
    role: params.role,
    skipAdminCheck: true,
  });
}

export async function adminRemoveFromWorkspace(actor: AppActor, params: {
  memberId: string;
}) {
  requireGlobalAdmin(actor);
  
  // Hard delete member.
  await prisma.member.delete({
    where: { id: params.memberId },
  });
}
