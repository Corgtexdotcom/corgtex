import type { MemberRole, Prisma } from "@prisma/client";
import { env, prisma, hashPassword, randomOpaqueToken, sha256, verifyPassword, isPasswordLoginDisabled } from "@corgtex/shared";
import type { AppActor, MembershipSummary } from "@corgtex/shared";
import { getSupportAuthorizationContext, setSupportAuthorizationActor, setSupportAuthorizationGrant, getMcpOrigin, assertMcpOriginActive } from "@corgtex/shared";
import { AppError, invariant } from "./errors";
import { systemActorMemberIdentityWhere } from "./member-identity";

const SESSION_TTL_MS = 1000 * 60 * 60 * 24 * 14;

const PUBLIC_DEMO_EMAIL = "demo@jnj-demo.corgtex.app";

function isPublicDemoUser(user: { email: string }) {
  return user.email.trim().toLowerCase() === PUBLIC_DEMO_EMAIL;
}

async function publicDemoWorkspaceId(userId: string, db: Prisma.TransactionClient | typeof prisma = prisma) {
  const user = await db.user.findUnique({
    where: { id: userId },
    select: {
      email: true,
      globalRole: true,
      memberships: {
        where: { isActive: true },
        select: { workspaceId: true, role: true, workspace: { select: { slug: true } } },
      },
      workspaceSupportGrants: {
        where: { isActive: true },
        select: { workspaceId: true },
      },
    },
  });
  if (!user || !isPublicDemoUser(user) || user.globalRole !== "USER" || user.memberships.length !== 1) return null;
  const membership = user.memberships[0];
  if (membership.workspace.slug !== "jnj-demo" || membership.role !== "CONTRIBUTOR") return null;
  if (user.workspaceSupportGrants.some(grant => grant.workspaceId !== membership.workspaceId)) return null;
  return membership.workspaceId;
}

export async function requireDeploymentWorkspaceScope(workspaceId: string, db: Prisma.TransactionClient | typeof prisma = prisma) {
  const workspaceSlug = env.DEPLOYMENT_WORKSPACE_SCOPE_SLUG;
  if (!workspaceSlug) {
    return;
  }

  const scopedWorkspace = await db.workspace.findFirst({
    where: {
      id: workspaceId,
      slug: workspaceSlug,
    },
    select: { id: true },
  });

  invariant(
    scopedWorkspace,
    403,
    "WORKSPACE_SCOPE_MISMATCH",
    "This deployment is restricted to its configured workspace.",
  );
}
export async function loginUserWithPassword(params: {
  email: string;
  password: string;
  ipAddress?: string | null;
  userAgent?: string | null;
}) {
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

  const { token, expiresAt } = await createSession(user.id, {
    ipAddress: params.ipAddress,
    userAgent: params.userAgent,
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

export async function createSession(
  userId: string,
  meta: { ipAddress?: string | null; userAgent?: string | null } = {}
) {
  const user = await prisma.user.findUnique({ where: { id: userId }, select: { passwordHash: true, email: true } });
  invariant(user && !isPasswordLoginDisabled(user.passwordHash), 401, "UNAUTHENTICATED", "This account cannot sign in.");
  if (isPublicDemoUser(user)) {
    invariant(await publicDemoWorkspaceId(userId), 401, "UNAUTHENTICATED", "This demo account is unavailable.");
  }

  const token = randomOpaqueToken();
  const expiresAt = new Date(Date.now() + SESSION_TTL_MS);

  await prisma.session.create({
    data: {
      userId,
      tokenHash: sha256(token),
      expiresAt,
      ipAddress: meta.ipAddress,
      userAgent: meta.userAgent,
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
          isSupportAccount: true,
          passwordHash: true,
        },
      },
    },
  });

  if (!session || session.expiresAt <= now || isPasswordLoginDisabled(session.user.passwordHash ?? "")) {
    return null;
  }

  if (isPublicDemoUser(session.user) && !await publicDemoWorkspaceId(session.user.id)) return null;

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

  const { passwordHash: _passwordHash, ...sessionUser } = session.user;
  return {
    kind: "user",
    user: sessionUser,
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
  tx?: Prisma.TransactionClient;
}) {
  const db = params.tx ?? prisma;
  const mcpOrigin = getMcpOrigin();
  if (mcpOrigin) await assertMcpOriginActive(db, mcpOrigin, params.workspaceId);
  setSupportAuthorizationActor(params.actor);
  await requireDeploymentWorkspaceScope(params.workspaceId, db);
  if (params.actor.kind === "user" && isPublicDemoUser(params.actor.user)) {
    invariant(await publicDemoWorkspaceId(params.actor.user.id, db) === params.workspaceId, 403, "FORBIDDEN", "The public demo is restricted to its dedicated workspace.");
  }

  if (params.actor.kind === "agent") {
    if (params.actor.supportOrigin) {
      const origin = params.actor.supportOrigin;
      const grant = await db.workspaceSupportGrant.findUnique({
        where: { workspaceId_userId: { workspaceId: params.workspaceId, userId: origin.userId } },
        select: { role: true, isActive: true, version: true },
      });
      invariant(origin.workspaceId === params.workspaceId && grant?.isActive && grant.role === "FULL" && grant.version === origin.version,
        403, "SUPPORT_AUTHORIZATION_REVOKED", "Support authorization is unavailable.");
    }
    const allowed = new Set(params.actor.workspaceIds ?? []);
    if (allowed.size === 0) {
      throw new AppError(403, "AGENT_WORKSPACE_SCOPE_REQUIRED", "Agent is not scoped to any workspace.");
    }
    if (!allowed.has(params.workspaceId)) {
      throw new AppError(403, "FORBIDDEN", "Agent is not allowed for this workspace.");
    }
    if (params.allowedRoles && params.allowedRoles.length > 0) {
      if (!params.actor.scopes?.includes("support:write")) {
        throw new AppError(403, "FORBIDDEN", "Agent cannot perform this human-gated action.");
      }
    }
    return null;
  }

  const supportGrant = await db.workspaceSupportGrant.findUnique({
      where: { workspaceId_userId: { workspaceId: params.workspaceId, userId: params.actor.user.id } },
      select: { role: true, isActive: true, version: true },
  });
  if (supportGrant) {
    if (!supportGrant.isActive || supportGrant.role !== "FULL") {
      throw new AppError(403, "SUPPORT_CONTENT_RESTRICTED", "Content access is restricted.");
    }
    const origin = getSupportAuthorizationContext()?.origin;
    invariant(!origin || (origin.userId === params.actor.user.id && origin.workspaceId === params.workspaceId && origin.version === supportGrant.version),
      403, "SUPPORT_AUTHORIZATION_REVOKED", "Support authorization is unavailable.");
    setSupportAuthorizationGrant({ userId: params.actor.user.id, workspaceId: params.workspaceId, version: supportGrant.version });
  }

  if (params.resolvedMembership !== undefined && !supportGrant) {
    if (params.allowedRoles && params.allowedRoles.length > 0) {
      if (!params.resolvedMembership || !params.allowedRoles.includes(params.resolvedMembership.role as MemberRole)) {
        throw new AppError(403, "FORBIDDEN", "Insufficient permissions.");
      }
    }
    invariant(params.resolvedMembership?.isActive, 403, "NOT_A_MEMBER", "You are not an active member of this workspace.");
    return params.resolvedMembership;
  }

  const membership = await db.member.findUnique({
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
      ...systemActorMemberIdentityWhere(),
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
  const deploymentSlug = env.DEPLOYMENT_WORKSPACE_SCOPE_SLUG;
  if (actor.kind === "user" && isPublicDemoUser(actor.user)) {
    const workspaceId = await publicDemoWorkspaceId(actor.user.id);
    if (!workspaceId || (deploymentSlug && deploymentSlug !== "jnj-demo")) return [];
    return prisma.workspace.findMany({
      where: { id: workspaceId, slug: "jnj-demo" },
      select: { id: true, slug: true, name: true, description: true },
      orderBy: { name: "asc" },
    });
  }

  if (actor.kind === "agent") {
    const allowed = new Set(actor.workspaceIds ?? []);
    if (allowed.size === 0) {
      return [];
    }
    return prisma.workspace.findMany({
      where: {
        id: { in: [...allowed] },
        ...(deploymentSlug ? { slug: deploymentSlug } : {}),
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

  if (isGlobalOperator(actor)) {
    return prisma.workspace.findMany({
      where: {
        ...(deploymentSlug ? { slug: deploymentSlug } : {}),
        supportGrants: { none: { userId: actor.user.id, OR: [{ isActive: false }, { role: "SETUP" }] } },
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

  return prisma.workspace.findMany({
    where: {
      ...(deploymentSlug ? { slug: deploymentSlug } : {}),
      members: {
        some: {
          userId: actor.user.id,
          isActive: true,
        },
      },
      supportGrants: { none: { userId: actor.user.id, OR: [{ isActive: false }, { role: "SETUP" }] } },
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
