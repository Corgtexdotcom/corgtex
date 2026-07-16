import { canManagePracticeFinanceProjects, getPracticeFinanceDashboard, requireWorkspaceMembership } from "@corgtex/domain";
import { prisma } from "@corgtex/shared";
import { requirePageActor } from "@/lib/auth";
import { requireWorkspaceFeature } from "@/lib/workspace-feature-flags";
import { PracticeFinanceDashboard } from "./PracticeFinanceDashboard";

export const dynamic = "force-dynamic";

export default async function FinancePage({
  params,
}: {
  params: Promise<{ workspaceId: string }>;
  searchParams?: Promise<Record<string, string | string[] | undefined>>;
}) {
  const { workspaceId } = await params;
  const actor = await requirePageActor();
  await requireWorkspaceFeature(workspaceId, "FINANCE");

  const [practiceDashboard, membership, workspace] = await Promise.all([
    getPracticeFinanceDashboard(actor, workspaceId),
    requireWorkspaceMembership({ actor, workspaceId }),
    prisma.workspace.findUnique({
      where: { id: workspaceId },
      select: { slug: true },
    }),
  ]);
  const canManageProjects = workspace?.slug !== "jnj-demo" && await canManagePracticeFinanceProjects(actor, workspaceId, {
    resolvedMembership: membership,
  });

  return (
    <PracticeFinanceDashboard
      workspaceId={workspaceId}
      canManageProjects={canManageProjects}
      summary={practiceDashboard.summary}
      attention={practiceDashboard.attention}
      projects={practiceDashboard.projects}
    />
  );
}
