import {
  canManagePracticeContributionPayments,
  canManagePracticeFinanceProjects,
  getNativePracticeFinanceDashboard,
  listPracticeContributionEntries,
  listPracticeProjects,
  listRequestedPracticeContributionPayables,
  requireWorkspaceMembership,
} from "@corgtex/domain";
import { prisma } from "@corgtex/shared";
import { requirePageActor } from "@/lib/auth";
import { isWorkspaceFeatureEnabled, requireWorkspaceFeature } from "@/lib/workspace-feature-flags";
import { PracticeFinanceDashboard } from "./PracticeFinanceDashboard";

export const dynamic = "force-dynamic";

export default async function FinancePage({
  params,
  searchParams,
}: {
  params: Promise<{ workspaceId: string }>;
  searchParams?: Promise<Record<string, string | string[] | undefined>>;
}) {
  const { workspaceId } = await params;
  const query = await searchParams;
  const payablesCursor = Array.isArray(query?.payablesCursor) ? query?.payablesCursor[0] : query?.payablesCursor;
  const actor = await requirePageActor();
  await requireWorkspaceFeature(workspaceId, "FINANCE");

  const [practiceDashboard, projects, slicingPieEnabled, practiceProjectsEnabled, membership, workspace] = await Promise.all([
    getNativePracticeFinanceDashboard(actor, workspaceId),
    listAllPracticeProjects(actor, workspaceId),
    isWorkspaceFeatureEnabled(workspaceId, "SLICING_PIE"),
    isWorkspaceFeatureEnabled(workspaceId, "PRACTICE_PROJECTS"),
    requireWorkspaceMembership({ actor, workspaceId }),
    prisma.workspace.findUnique({
      where: { id: workspaceId },
      select: { slug: true },
    }),
  ]);
  const readOnlyDemo = workspace?.slug === "jnj-demo";
  const canManageProjects = practiceProjectsEnabled && !readOnlyDemo && await canManagePracticeFinanceProjects(actor, workspaceId, {
    resolvedMembership: membership,
  });
  const projectEditRows = canManageProjects
    ? await prisma.practiceProject.findMany({
      where: {
        workspaceId,
        id: { in: practiceDashboard.projectHealth.map((project) => project.projectId) },
      },
      orderBy: [{ status: "asc" }, { code: "asc" }, { id: "asc" }],
    })
    : [];
  const canMarkContributionPaid = !readOnlyDemo && await canManagePracticeContributionPayments(actor, workspaceId, {
    resolvedMembership: membership,
  });
  const requestedPayables = slicingPieEnabled
    ? await listRequestedPracticeContributionPayables(actor, workspaceId, { take: 50, cursor: payablesCursor })
    : { entries: [], nextCursor: null };
  const contributionEntries = slicingPieEnabled
    ? await listPracticeContributionEntries(actor, workspaceId, { take: 50 })
    : [];

  return (
    <PracticeFinanceDashboard
      workspaceId={workspaceId}
      canManageProjects={canManageProjects}
      practiceProjectsEnabled={practiceProjectsEnabled}
      canRecordContributions={!readOnlyDemo}
      canMarkContributionPaid={canMarkContributionPaid}
      slicingPieEnabled={slicingPieEnabled}
      summary={practiceDashboard.summary}
      attention={practiceDashboard.attention}
      projectHealth={practiceDashboard.projectHealth}
      projects={projects}
      projectEditRows={projectEditRows}
      contributionEntries={contributionEntries}
      requestedPayables={requestedPayables.entries}
      requestedPayablesNextCursor={requestedPayables.nextCursor}
    />
  );
}

async function listAllPracticeProjects(actor: Awaited<ReturnType<typeof requirePageActor>>, workspaceId: string) {
  const take = 200;
  return listPracticeProjects(actor, workspaceId, { take });
}
