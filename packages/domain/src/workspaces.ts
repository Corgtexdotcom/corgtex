import { env, normalizeWorkspaceSlug, prisma } from "@corgtex/shared";
import type { AppActor } from "@corgtex/shared";
import { invariant } from "./errors";
import { assertCustomerAssignableWorkspaceSlug } from "./workspace-slugs";

export async function createWorkspace(actor: AppActor, params: {
  name: string;
  slug: string;
  description?: string | null;
}) {
  invariant(actor.kind === "user", 400, "INVALID_ACTOR", "Only users can create workspaces.");

  const name = params.name.trim();
  const slug = normalizeWorkspaceSlug(params.slug);
  invariant(name.length > 0, 400, "INVALID_INPUT", "Workspace name is required.");
  invariant(slug.length > 0, 400, "INVALID_INPUT", "Workspace slug is required.");
  assertCustomerAssignableWorkspaceSlug(slug);

  const deploymentSlug = env.DEPLOYMENT_WORKSPACE_SCOPE_SLUG;
  invariant(
    !deploymentSlug || slug === normalizeWorkspaceSlug(deploymentSlug),
    403,
    "WORKSPACE_SCOPE_MISMATCH",
    "Workspace creation is restricted to this deployment's configured workspace.",
  );

  return prisma.$transaction(async (tx) => {
    const existing = await tx.workspace.findUnique({ where: { slug } });
    invariant(!existing, 409, "CONFLICT", "A workspace with this slug already exists.");

    const workspace = await tx.workspace.create({
      data: {
        name,
        slug,
        description: params.description?.trim() || null,
      },
    });

    await tx.member.create({
      data: {
        workspaceId: workspace.id,
        userId: actor.user.id,
        role: "ADMIN",
        isActive: true,
      },
    });

    await tx.approvalPolicy.createMany({
      data: [
        {
          workspaceId: workspace.id,
          subjectType: "PROPOSAL",
          mode: "CONSENT",
          quorumPercent: 0,
          minApproverCount: 1,
          decisionWindowHours: 72,
        },
      ],
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
