import type { MemberRole } from "@prisma/client";
import { env, prisma, hashPassword, parseAllowedWorkspaceIds, randomOpaqueToken, sha256, verifyPassword } from "@corgtex/shared";
import type { AppActor, MembershipSummary } from "@corgtex/shared";
import { AppError, invariant } from "./errors";

const SESSION_TTL_MS = 1000 * 60 * 60 * 24 * 14;
export async function loginUserWithPassword(params: { email: string; password: string }) {
  const email = params.email.trim().toLowerCase();
  invariant(email.length > 0, 400, "INVALID_INPUT", "Email is required.");
  invariant(params.password.length >= 8, 400, "INVALID_INPUT", "Password must be at least 8 characters.");

  const user = await prisma.user.findUnique({
    where: { email },
    select: {
      id: true,
      email: true,
      displayName: true,
      globalRole: true,
      passwordHash: true,
    },
  });

  if (!user || !verifyPassword(params.password, user.passwordHash)) {
    throw new AppError(401, "UNAUTHENTICATED", "Invalid email or password.");
  }

  const token = randomOpaqueToken();
  const expiresAt = new Date(Date.now() + SESSION_TTL_MS);

  await prisma.session.create({
    data: {
      userId: user.id,
      tokenHash: sha256(token),
      expiresAt,
    },
  });

  return {
    token,
    expiresAt,
    user: {
      id: user.id,
      email: user.email,
      displayName: user.displayName,
      globalRole: user.globalRole,
    },
  };
}

export async function createSession(userId: string) {
  const token = randomOpaqueToken();
  const expiresAt = new Date(Date.now() + 1000 * 60 * 60 * 24 * 14);

  await prisma.session.create({
    data: {
      userId,
      tokenHash: sha256(token),
      expiresAt,
    },
  });

  return { token, expiresAt };
}

export async function registerUser(params: { email: string; password: string; displayName?: string | null }) {
  const email = params.email.trim().toLowerCase();
  invariant(email.length > 0, 400, "INVALID_INPUT", "Email is required.");
  invariant(params.password.length >= 8, 400, "INVALID_INPUT", "Password must be at least 8 characters.");

  const existing = await prisma.user.findUnique({ where: { email } });
  invariant(!existing, 409, "ALREADY_EXISTS", "A user with that email already exists.");

  return prisma.user.create({
    data: {
      email,
      displayName: params.displayName?.trim() || null,
      passwordHash: hashPassword(params.password),
    },
    select: {
      id: true,
      email: true,
      displayName: true,
    },
  });
}

export async function resolveSessionActor(token: string): Promise<AppActor | null> {
  const now = new Date();
  const session = await prisma.session.findUnique({
    where: { tokenHash: sha256(token) },
    include: {
      user: {
        select: {
          id: true,
          email: true,
          displayName: true,
          globalRole: true,
        },
      },
    },
  });

  if (!session || session.expiresAt <= now) {
    return null;
  }

  const lastSeenRefreshBefore = new Date(now.getTime() - env.SESSION_LAST_SEEN_WRITE_INTERVAL_MS);
  if (session.lastSeenAt <= lastSeenRefreshBefore) {
    await prisma.session.updateMany({
      where: {
        id: session.id,
        lastSeenAt: { lte: lastSeenRefreshBefore },
      },
      data: {
        lastSeenAt: now,
      },
    });
  }

  return {
    kind: "user",
    user: session.user,
  };
}

export function isGlobalOperator(actor: AppActor) {
  return actor.kind === "user" && actor.user.globalRole === "OPERATOR";
}

export function requireGlobalOperator(actor: AppActor) {
  if (!isGlobalOperator(actor)) {
    throw new AppError(403, "FORBIDDEN", "Only global operators can perform this action.");
  }
}

export async function clearSession(token: string) {
  await prisma.session.deleteMany({
    where: {
      tokenHash: sha256(token),
    },
  });
}

export async function requireWorkspaceMembership(params: {
  actor: AppActor;
  workspaceId: string;
  allowedRoles?: MemberRole[];
  resolvedMembership?: MembershipSummary | null;
}) {
  if (params.resolvedMembership !== undefined) {
    if (params.allowedRoles && params.allowedRoles.length > 0) {
      if (!params.resolvedMembership || !params.allowedRoles.includes(params.resolvedMembership.role as MemberRole)) {
        throw new AppError(403, "FORBIDDEN", "Insufficient permissions.");
      }
    }
    invariant(params.resolvedMembership?.isActive, 403, "NOT_A_MEMBER", "You are not an active member of this workspace.");
    return params.resolvedMembership;
  }

  if (params.actor.kind === "agent") {
    const allowed = params.actor.workspaceIds?.length
      ? new Set(params.actor.workspaceIds)
      : parseAllowedWorkspaceIds();
    if (allowed.size > 0 && !allowed.has(params.workspaceId)) {
      throw new AppError(403, "FORBIDDEN", "Agent is not allowed for this workspace.");
    }
    if (params.allowedRoles && params.allowedRoles.length > 0) {
      throw new AppError(403, "FORBIDDEN", "Agent cannot perform this human-gated action.");
    }
    return null;
  }

  if (isGlobalOperator(params.actor)) {
    return {
      id: "global-operator",
      workspaceId: params.workspaceId,
      userId: params.actor.user.id,
      role: "ADMIN",
      isActive: true,
    } as MembershipSummary;
  }

  const membership = await prisma.member.findUnique({
    where: {
      workspaceId_userId: {
        workspaceId: params.workspaceId,
        userId: params.actor.user.id,
      },
    },
    select: {
      id: true,
      workspaceId: true,
      userId: true,
      role: true,
      isActive: true,
    },
  });

  invariant(membership?.isActive, 403, "NOT_A_MEMBER", "You are not an active member of this workspace.");

  if (params.allowedRoles && params.allowedRoles.length > 0 && !params.allowedRoles.includes(membership.role)) {
    throw new AppError(403, "FORBIDDEN", "Insufficient permissions.");
  }

  return membership as MembershipSummary;
}

export async function actorUserIdForWorkspace(actor: AppActor, workspaceId: string) {
  if (actor.kind === "user") {
    return actor.user.id;
  }

  const systemMember = await prisma.member.findFirst({
    where: {
      workspaceId,
      isActive: true,
      role: "ADMIN",
      user: {
        email: {
          startsWith: "system+",
        },
      },
    },
    select: {
      userId: true,
    },
  });

  if (systemMember) {
    return systemMember.userId;
  }

  const fallbackAdmin = await prisma.member.findFirst({
    where: {
      workspaceId,
      isActive: true,
      role: "ADMIN",
    },
    select: {
      userId: true,
    },
  });

  invariant(fallbackAdmin, 500, "CONFIG_ERROR", "Workspace has no admin member available for system actions.");
  return fallbackAdmin.userId;
}

export async function listActorWorkspaces(actor: AppActor) {
  if (actor.kind === "agent") {
    const allowed = actor.workspaceIds?.length
      ? new Set(actor.workspaceIds)
      : parseAllowedWorkspaceIds();
    return prisma.workspace.findMany({
      where: allowed.size > 0 ? { id: { in: [...allowed] } } : undefined,
      select: {
        id: true,
        slug: true,
        name: true,
        description: true,
      },
      orderBy: { name: "asc" },
    });
  }

  if (isGlobalOperator(actor)) {
    return prisma.workspace.findMany({
      select: {
        id: true,
        slug: true,
        name: true,
        description: true,
      },
      orderBy: { name: "asc" },
    });
  }

  return prisma.workspace.findMany({
    where: {
      members: {
        some: {
          userId: actor.user.id,
          isActive: true,
        },
      },
    },
    select: {
      id: true,
      slug: true,
      name: true,
      description: true,
    },
    orderBy: { name: "asc" },
  });
}
