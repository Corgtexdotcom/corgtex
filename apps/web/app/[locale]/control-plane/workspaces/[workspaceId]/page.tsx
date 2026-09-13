import { notFound } from "next/navigation";
import { getTranslations } from "next-intl/server";
import { ArrowLeft, ArrowRight } from "lucide-react";
import { getControlPlaneWorkspaceSummary } from "@corgtex/domain";
import { Link } from "@/i18n/routing";
import { requirePageActor } from "@/lib/auth";
import { ControlPlanePageHeader, controlPlaneButtonClass } from "../../_components/control-plane-ui";

export const dynamic = "force-dynamic";

export default async function ControlPlaneWorkspacePage({ params }: { params: Promise<{ workspaceId: string }> }) {
  const actor = await requirePageActor();
  const { workspaceId } = await params;
  const t = await getTranslations("controlPlane.workspaces");
  let workspace: Awaited<ReturnType<typeof getControlPlaneWorkspaceSummary>>;
  try {
    workspace = await getControlPlaneWorkspaceSummary(actor, workspaceId);
  } catch (error) {
    if (error && typeof error === "object" && "status" in error && (error.status === 403 || error.status === 404)) notFound();
    throw error;
  }
  const fields = [
    [t("workspaceId"), workspace.workspaceId],
    [t("account"), workspace.managedDeployment?.accountLabel ?? t("unlinked")],
    [t("plan"), workspace.plan.replace(/_/g, " ")],
    [t("members"), String(workspace.memberCount)],
    [t("created"), workspace.createdAt],
    [t("updated"), workspace.updatedAt],
  ];
  return <div className="space-y-5 pb-10">
    <Link href="/control-plane/workspaces" className={controlPlaneButtonClass}><ArrowLeft size={14} aria-hidden="true" />{t("back")}</Link>
    <ControlPlanePageHeader title={workspace.name} />
    <p className="break-all text-sm text-muted">{workspace.slug}</p>
    <dl aria-label={t("details")} className="grid gap-x-6 gap-y-3 border-y border-line py-5 text-sm sm:grid-cols-[180px_1fr]">
      {fields.map(([label, value]) => <div key={label} className="contents">
        <dt className="text-muted">{label}</dt><dd className="min-w-0 break-all text-text-strong">{value}</dd>
      </div>)}
    </dl>
    {workspace.managedDeployment && <Link href={`/control-plane/deployments/${encodeURIComponent(workspace.managedDeployment.deploymentId)}`}
      className={controlPlaneButtonClass}>{t("deployment")}<ArrowRight size={14} aria-hidden="true" /></Link>}
  </div>;
}
