import type { Prisma } from "@prisma/client";
import {
  env,
  normalizeWorkspaceSlug,
  prisma,
} from "@corgtex/shared";
import type { AppActor } from "@corgtex/shared";
import { invariant } from "./errors";

type Tx = Prisma.TransactionClient;

type WorkspaceIdentity = {
  id: string;
  name: string;
  slug: string;
};

type CanonicalWorkspaceCreateParams = {
  name: string;
  slug: string;
  description?: string | null;
  data?: Omit<
    Prisma.WorkspaceUncheckedCreateInput,
    "id" | "name" | "slug" | "description" | "createdAt" | "updatedAt"
  >;
};

type CanonicalWorkspaceEnsureParams = CanonicalWorkspaceCreateParams & {
  update?: Prisma.WorkspaceUpdateInput;
};

const DEFAULT_PROPOSAL_POLICY = {
  subjectType: "PROPOSAL",
  mode: "CONSENT",
  quorumPercent: 0,
  minApproverCount: 1,
  decisionWindowHours: 72,
} as const;

export const CANONICAL_WORKSPACE_SYSTEM_PASSWORD_HASH = "disabled$canonical-workspace-system-actor-v1";

export function canonicalWorkspaceSlug(value: string) {
  const slug = normalizeWorkspaceSlug(value);
  invariant(slug.length > 0, 400, "INVALID_INPUT", "Workspace slug is required.");

  const deploymentSlug = env.DEPLOYMENT_WORKSPACE_SCOPE_SLUG;
  invariant(
    !deploymentSlug || slug === normalizeWorkspaceSlug(deploymentSlug),
    403,
    "WORKSPACE_SCOPE_MISMATCH",
    "Workspace creation is restricted to this deployment's configured workspace.",
  );

  return slug;
}

export function canonicalWorkspaceSystemEmail(slug: string) {
  return `system+${normalizeWorkspaceSlug(slug)}@corgtex.local`;
}

export function isCanonicalWorkspaceSystemEmail(email: string) {
  return /^system\+[^@]*@corgtex\.local$/i.test(email.trim());
}

export function assertNonReservedWorkspaceSystemEmail(email: string) {
  invariant(
    !isCanonicalWorkspaceSystemEmail(email),
    409,
    "CANONICAL_SYSTEM_ACTOR_COLLISION",
    "Reserved workspace system identity cannot be used as a human member.",
  );
}

export async function ensureCanonicalWorkspaceBaseline(tx: Tx, workspace: WorkspaceIdentity) {
  const slug = canonicalWorkspaceSlug(workspace.slug);
  invariant(
    slug === workspace.slug,
    409,
    "CANONICAL_WORKSPACE_SLUG_MISMATCH",
    "Workspace slug must be normalized before establishing its system actor.",
  );

  const email = canonicalWorkspaceSystemEmail(slug);
  const matchingUsers = await tx.user.findMany({
    where: {
      email: {
        equals: email,
        mode: "insensitive",
      },
    },
    select: {
      id: true,
      email: true,
      globalRole: true,
      passwordHash: true,
      ssoIdentities: {
        select: { id: true },
      },
      oauthConnections: {
        select: { id: true },
      },
      externalMcpConnections: {
        select: { id: true },
      },
      memberships: {
        select: {
          workspaceId: true,
          role: true,
          kind: true,
          isActive: true,
          mergedAt: true,
          mergedIntoMemberId: true,
        },
      },
    },
  });

  const existingUser = matchingUsers.find((user) => user.email === email);
  if (matchingUsers.length > 0) {
    const targetMembership = existingUser?.memberships.find((membership) => membership.workspaceId === workspace.id);
    invariant(
      matchingUsers.length === 1
        && existingUser
        && existingUser.globalRole === "USER"
        && existingUser.ssoIdentities.length === 0
        && existingUser.oauthConnections.length === 0
        && existingUser.externalMcpConnections.length === 0
        && existingUser.memberships.length === 1
        && targetMembership?.kind === "SYSTEM"
        && targetMembership.mergedAt === null
        && targetMembership.mergedIntoMemberId === null,
      409,
      "CANONICAL_SYSTEM_ACTOR_COLLISION",
      "Canonical workspace system identity is already associated with an incompatible member.",
    );
  }

  const systemUser = existingUser
    ? existingUser.passwordHash === CANONICAL_WORKSPACE_SYSTEM_PASSWORD_HASH
      ? existingUser
      : await tx.user.update({
          where: { id: existingUser.id },
          data: { passwordHash: CANONICAL_WORKSPACE_SYSTEM_PASSWORD_HASH },
          select: { id: true },
        })
    : await tx.user.create({
        data: {
          email,
          displayName: `${workspace.name} System`,
          passwordHash: CANONICAL_WORKSPACE_SYSTEM_PASSWORD_HASH,
        },
        select: { id: true },
      });

  if (existingUser) {
    const revokedAt = new Date();
    await tx.session.deleteMany({ where: { userId: systemUser.id } });
    await tx.passwordResetToken.updateMany({
      where: { userId: systemUser.id, usedAt: null },
      data: { usedAt: revokedAt },
    });
    await tx.oAuthAuthorizationCode.updateMany({
      where: { userId: systemUser.id, usedAt: null },
      data: { usedAt: revokedAt },
    });
    await tx.oAuthAccessToken.updateMany({
      where: { userId: systemUser.id, revokedAt: null },
      data: { revokedAt },
    });
    await tx.mcpOAuthAuthorizationCode.updateMany({
      where: { userId: systemUser.id, usedAt: null },
      data: { usedAt: revokedAt },
    });
    await tx.mcpOAuthAccessToken.updateMany({
      where: { userId: systemUser.id, revokedAt: null },
      data: { revokedAt },
    });
    await tx.appSession.updateMany({
      where: { actorUserId: systemUser.id, revokedAt: null },
      data: { revokedAt },
    });
  }

  await tx.member.upsert({
    where: {
      workspaceId_userId: {
        workspaceId: workspace.id,
        userId: systemUser.id,
      },
    },
    update: {
      role: "ADMIN",
      kind: "SYSTEM",
      isActive: true,
    },
    create: {
      workspaceId: workspace.id,
      userId: systemUser.id,
      role: "ADMIN",
      kind: "SYSTEM",
      isActive: true,
    },
  });

  await tx.approvalPolicy.createMany({
    data: [{ workspaceId: workspace.id, ...DEFAULT_PROPOSAL_POLICY }],
    skipDuplicates: true,
  });

  return workspace;
}

export async function createCanonicalWorkspace(tx: Tx, params: CanonicalWorkspaceCreateParams) {
  const name = params.name.trim();
  const slug = canonicalWorkspaceSlug(params.slug);
  invariant(name.length > 0, 400, "INVALID_INPUT", "Workspace name is required.");

  const existing = await tx.workspace.findUnique({ where: { slug } });
  invariant(!existing, 409, "CONFLICT", "A workspace with this slug already exists.");

  const workspace = await tx.workspace.create({
    data: {
      ...params.data,
      name,
      slug,
      description: params.description?.trim() || null,
    },
  });

  await ensureCanonicalWorkspaceBaseline(tx, workspace);
  return workspace;
}

export async function ensureCanonicalWorkspace(tx: Tx, params: CanonicalWorkspaceEnsureParams) {
  const name = params.name.trim();
  const slug = canonicalWorkspaceSlug(params.slug);
  invariant(name.length > 0, 400, "INVALID_INPUT", "Workspace name is required.");

  const workspace = await tx.workspace.upsert({
    where: { slug },
    update: params.update ?? { slug },
    create: {
      ...params.data,
      name,
      slug,
      description: params.description?.trim() || null,
    },
  });

  await ensureCanonicalWorkspaceBaseline(tx, workspace);
  return workspace;
}

export async function createWorkspace(actor: AppActor, params: {
  name: string;
  slug: string;
  description?: string | null;
}) {
  invariant(actor.kind === "user", 400, "INVALID_ACTOR", "Only users can create workspaces.");
  const slug = canonicalWorkspaceSlug(params.slug);
  assertNonReservedWorkspaceSystemEmail(actor.user.email);

  return prisma.$transaction(async (tx) => {
    const workspace = await createCanonicalWorkspace(tx, { ...params, slug });

    await tx.member.create({
      data: {
        workspaceId: workspace.id,
        userId: actor.user.id,
        role: "ADMIN",
        isActive: true,
      },
    });

    return workspace;
  });
}

export async function listWorkspaces(actor: AppActor) {
  invariant(actor.kind === "user", 400, "INVALID_ACTOR", "Only users can list workspaces.");

  return prisma.workspace.findMany({
    where: {
      members: {
        some: {
          userId: actor.user.id,
          isActive: true,
        },
      },
    },
    orderBy: { createdAt: "desc" },
  });
}
