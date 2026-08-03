import { getFinanceReadiness } from "@corgtex/domain";
import { prisma, workspaceBranding } from "@corgtex/shared";
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
  const [readiness, workspace] = await Promise.all([
    getFinanceReadiness(actor, workspaceId),
    prisma.workspace.findUnique({ where: { id: workspaceId }, select: { slug: true, name: true } }),
  ]);

  return <FinanceWorkspaceView workspaceId={workspaceId} sectionKey="overview" readiness={readiness} demoReadOnly={workspace ? workspaceBranding(workspace).isDemo : false} />;
}
