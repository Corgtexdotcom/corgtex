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
  await requireWorkspaceFeature(workspaceId, "PRACTICE_PROJECTS");

  const [practiceDashboard, projects, slicingPieEnabled, membership, workspace] = await Promise.all([
    getNativePracticeFinanceDashboard(actor, workspaceId),
    listPracticeProjects(actor, workspaceId, { take: 100 }),
    isWorkspaceFeatureEnabled(workspaceId, "SLICING_PIE"),
    requireWorkspaceMembership({ actor, workspaceId }),
    prisma.workspace.findUnique({
      where: { id: workspaceId },
      select: { slug: true },
    }),
  ]);
  const readOnlyDemo = workspace?.slug === "jnj-demo";
  const canManageProjects = !readOnlyDemo && await canManagePracticeFinanceProjects(actor, workspaceId, {
    resolvedMembership: membership,
  });
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
      canRecordContributions={!readOnlyDemo}
      canMarkContributionPaid={canMarkContributionPaid}
      slicingPieEnabled={slicingPieEnabled}
      summary={practiceDashboard.summary}
      attention={practiceDashboard.attention}
      projectHealth={practiceDashboard.projectHealth}
      projects={projects}
      contributionEntries={contributionEntries}
      requestedPayables={requestedPayables.entries}
      requestedPayablesNextCursor={requestedPayables.nextCursor}
    />
  );
}
