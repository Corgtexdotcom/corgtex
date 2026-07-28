import { getFinanceReadiness } from "@corgtex/domain";
import { requirePageActor } from "@/lib/auth";
import { requireWorkspaceFeature } from "@/lib/workspace-feature-flags";
import { FinanceWorkspaceView } from "./FinanceWorkspaceView";

export const dynamic = "force-dynamic";

export default async function FinancePage({
  params,
}: {
  params: Promise<{ workspaceId: string }>;
}) {
  const { workspaceId } = await params;
  const actor = await requirePageActor();

  await requireWorkspaceFeature(workspaceId, "FINANCE");
  const readiness = await getFinanceReadiness(actor, workspaceId);

  return <FinanceWorkspaceView workspaceId={workspaceId} sectionKey="overview" readiness={readiness} />;
}
