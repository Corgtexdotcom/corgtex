import { prisma } from "@corgtex/shared";
import type { AppActor } from "@corgtex/shared";
import { withAgentRunModelUsageSummary } from "./agent-run-usage";
import { requireWorkspaceMembership } from "./auth";
import { invariant } from "./errors";

export async function createWorkspace(actor: AppActor, params: {
  name: string;
  slug: string;
  description?: string | null;
}) {
  invariant(actor.kind === "user", 400, "INVALID_ACTOR", "Only users can create workspaces.");

  const name = params.name.trim();
  const slug = params.slug.trim().toLowerCase().replace(/[^a-z0-9-]/g, "-");
  invariant(name.length > 0, 400, "INVALID_INPUT", "Workspace name is required.");
  invariant(slug.length > 0, 400, "INVALID_INPUT", "Workspace slug is required.");

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
        {
          workspaceId: workspace.id,
          subjectType: "SPEND",
          mode: "SINGLE",
          quorumPercent: 0,
          minApproverCount: 1,
          decisionWindowHours: 72,
          requireProposalLink: false,
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

