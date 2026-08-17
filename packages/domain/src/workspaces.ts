import type { Prisma } from "@prisma/client";
import {
  env,
  hashPassword,
  normalizeWorkspaceSlug,
  prisma,
  randomOpaqueToken,
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

export function assertNonReservedWorkspaceSystemEmail(email: string) {
  invariant(
    !/^system\+[^@]*@corgtex\.local$/i.test(email.trim()),
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
      ssoIdentities: {
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
        && existingUser.memberships.length === 1
        && targetMembership?.kind === "SYSTEM"
        && targetMembership.mergedAt === null
        && targetMembership.mergedIntoMemberId === null,
      409,
      "CANONICAL_SYSTEM_ACTOR_COLLISION",
      "Canonical workspace system identity is already associated with an incompatible member.",
    );
  }

  const systemUser = existingUser ?? await tx.user.create({
    data: {
      email,
      displayName: `${workspace.name} System`,
      passwordHash: hashPassword(randomOpaqueToken()),
    },
    select: { id: true },
  });

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

  const existing = await tx.workspace.findUnique({ where: { slug } });
  const workspace = existing
    ? params.update
      ? await tx.workspace.update({ where: { id: existing.id }, data: params.update })
      : existing
    : await tx.workspace.create({
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
