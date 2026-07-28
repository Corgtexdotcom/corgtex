import { requireWorkspaceMembership } from "@corgtex/domain";
import { requirePageActor } from "@/lib/auth";
import { WorkspaceEmptyState, WorkspacePageHeader } from "@/lib/components/ControlPrimitives";
import { requireWorkspaceFeature } from "@/lib/workspace-feature-flags";

export const dynamic = "force-dynamic";

export default async function FinancePage({
  params,
}: {
  params: Promise<{ workspaceId: string }>;
}) {
  const { workspaceId } = await params;
  const actor = await requirePageActor();

  await requireWorkspaceFeature(workspaceId, "FINANCE");
  await requireWorkspaceMembership({ actor, workspaceId });

  return (
    <div className="stack">
      <WorkspacePageHeader
        title="Finance"
        description="A clean Finance workspace surface is available. Detailed finance workflows are not configured in this version."
      />
      <WorkspaceEmptyState
        title="No finance records are active"
        description="The legacy ledger data has been retired from the live product surface."
      />
    </div>
  );
}
