import { FINANCE_SECTIONS, getFinanceReadiness, type FinanceSectionKey } from "@corgtex/domain";
import { prisma, workspaceBranding } from "@corgtex/shared";
import { notFound } from "next/navigation";
import { requirePageActor } from "@/lib/auth";
import { requireWorkspaceFeature } from "@/lib/workspace-feature-flags";
import { FinanceWorkspaceView } from "../FinanceWorkspaceView";

export const dynamic = "force-dynamic";

const SECTION_KEYS = new Set<string>(
  FINANCE_SECTIONS
    .map((section) => section.key)
    .filter((key) => key !== "overview"),
);

function resolveSectionKey(section: string): FinanceSectionKey {
  if (!SECTION_KEYS.has(section)) notFound();
  return section as FinanceSectionKey;
}

export default async function FinanceSectionPage({
  params,
}: {
  params: Promise<{ workspaceId: string; section: string }>;
}) {
  const { workspaceId, section } = await params;
  const sectionKey = resolveSectionKey(section);
  const actor = await requirePageActor();

  await requireWorkspaceFeature(workspaceId, "FINANCE");
  const [readiness, workspace] = await Promise.all([
    getFinanceReadiness(actor, workspaceId),
    prisma.workspace.findUnique({ where: { id: workspaceId }, select: { slug: true, name: true } }),
  ]);

  return <FinanceWorkspaceView workspaceId={workspaceId} sectionKey={sectionKey} readiness={readiness} demoReadOnly={workspace ? workspaceBranding(workspace).isDemo : false} />;
}
