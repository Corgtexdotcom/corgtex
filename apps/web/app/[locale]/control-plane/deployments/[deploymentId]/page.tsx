import { notFound } from "next/navigation";
import { getTranslations } from "next-intl/server";
import {
  AppError,
  getControlPlaneDeployLatestPreflight,
  getControlPlaneAiGovernanceStatus,
  getControlPlaneContextHealth,
  getControlPlaneDeployment,
  getControlPlaneIntegrationStatus,
  getControlPlaneReleaseStatus,
  listControlPlaneCustomerMembers,
  listControlPlaneFeatureFlags,
  listControlPlaneReleaseRolloutJobs,
  requireControlPlaneAccess,
} from "@corgtex/domain";
import { requirePageActor } from "@/lib/auth";
import { getControlPlaneHref } from "@/lib/control-plane-url";
import {
  configureMeetingRecorderIntegrationAction,
  configureSupportConnectorAction,
  createControlPlaneMemberAction,
  deployLatestControlPlaneReleaseAction,
  recordBreakGlassAction,
  refreshSupportSnapshotAction,
  resendControlPlaneAccessLinkAction,
  runContextOperationAction,
  runMeetingRecorderOperationAction,
  runReleaseOperationAction,
  runSupportOperationAction,
  setControlPlaneFeatureFlagAction,
  updateControlPlaneMemberStatusAction,
  updateControlPlaneModelBudgetAction,
  updateControlPlaneAgentPolicyAction,
  revokeControlPlaneAgentCredentialAction,
  updateControlPlaneAgentCredentialScopesAction,
} from "../../actions";
import { CustomerDetailClientTabs } from "./_components/detail-client-tabs";

export const dynamic = "force-dynamic";

export default async function ControlPlaneCustomerPage({
  params,
}: {
  params: Promise<{ locale: string; deploymentId: string }>;
}) {
  const { locale, deploymentId } = await params;
  const actor = await requirePageActor();
  try {
    await requireControlPlaneAccess(actor, { deploymentId });
  } catch {
    notFound();
  }

  // Parallel server side data fetching
  const [
    customer,
    integrations,
    context,
    aiGovernance,
    releases,
    membersRaw,
    featureFlagsRaw,
    deployPreflight,
    rollouts,
    t,
  ] = await Promise.all([
    getControlPlaneDeployment(actor, deploymentId),
    getControlPlaneIntegrationStatus(actor, deploymentId),
    getControlPlaneContextHealth(actor, deploymentId),
    getControlPlaneAiGovernanceStatus(actor, deploymentId),
    getControlPlaneReleaseStatus(actor, deploymentId),
    listControlPlaneCustomerMembers(actor, deploymentId).catch((err: unknown) => ({
      deploymentId,
      source: "unavailable" as const,
      members: [],
      error: err instanceof Error ? err.message : "Unable to load members.",
    })),
    listControlPlaneFeatureFlags(actor, deploymentId).catch((err: unknown) => ({
      deploymentId,
      source: "unavailable" as const,
      flags: [],
      error: err instanceof Error ? err.message : "Unable to load feature flags.",
    })),
    getControlPlaneDeployLatestPreflight(actor, deploymentId),
    listControlPlaneReleaseRolloutJobs(actor, { deploymentId, take: 8 }),
    getTranslations("controlPlane"),
  ]).catch((error: unknown) => {
    if (error instanceof AppError && error.status === 404) {
      notFound();
    }
    throw error;
  });

  // Standardize response types for client component
  const members = "members" in membersRaw ? membersRaw : { members: [] };
  const featureFlags = "flags" in featureFlagsRaw ? featureFlagsRaw : { flags: [] };

  return (
    <div className="space-y-6 pb-12 animate-in fade-in duration-300">
      
      {/* Detail Header area */}
      <div className="flex flex-col md:flex-row md:items-center justify-between gap-4 border-b border-line pb-6">
        <div>
          <span className="text-[10px] font-bold tracking-widest text-brand-400 uppercase">
            {t("customerDetail.eyebrow")}
          </span>
          <h1 className="text-2xl font-bold tracking-tight text-white mt-1">
            {customer.label}
          </h1>
          <p className="text-xs text-muted mt-1 max-w-2xl">
            Public URL: <a href={customer.url} target="_blank" rel="noreferrer" className="text-brand-400 hover:underline">{customer.url}</a>
          </p>
        </div>

        {/* Global Live support refresh actions */}
        <div className="flex gap-2">
          <a
            href={customer.url}
            target="_blank"
            rel="noreferrer"
            className="bg-surface hover:bg-surface-strong border border-line text-text hover:text-white px-3.5 py-2 rounded-lg text-xs font-semibold transition-all"
          >
            {t("customerDetail.openCustomer")}
          </a>
          {customer.hasSupportCredential && (
            <form action={refreshSupportSnapshotAction}>
              <input type="hidden" name="deploymentId" value={customer.id} />
              <button
                type="submit"
                className="bg-brand-600 hover:bg-brand-500 text-white font-semibold text-xs px-3.5 py-2 rounded-lg shadow transition-all duration-150"
              >
                {t("customerDetail.refreshSnapshot")}
              </button>
            </form>
          )}
        </div>
      </div>

      {/* Render Client-Side Tab Switcher component */}
      <CustomerDetailClientTabs
        customer={customer}
        integrations={integrations}
        context={context}
        aiGovernance={aiGovernance}
        releases={releases}
        members={members}
        featureFlags={featureFlags}
        deployPreflight={deployPreflight}
        rollouts={rollouts}
        locale={locale}
      />

    </div>
  );
}
