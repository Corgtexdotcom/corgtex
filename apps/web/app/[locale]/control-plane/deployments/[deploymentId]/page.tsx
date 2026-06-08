import { notFound } from "next/navigation";
import { getTranslations } from "next-intl/server";
import {
  AppError,
  getControlPlaneDeployLatestPreflight,
  getControlPlaneAiGovernanceStatus,
  getControlPlaneClientOptions,
  getControlPlaneContextHealth,
  getControlPlaneDeployment,
  getControlPlaneIntegrationStatus,
  getControlPlaneReleaseStatus,
  listControlPlaneCustomerMembers,
  listControlPlaneFeatureFlags,
  listControlPlaneReleaseRolloutJobs,
  listWorkspaceEnterpriseApps,
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
import { ClientContextSwitcher } from "../../_components/client-context-switcher";
import {
  ControlPlanePageHeader,
  controlPlaneButtonClass,
} from "../../_components/control-plane-ui";
import { CustomerDetailClientTabs } from "./_components/detail-client-tabs";

export const dynamic = "force-dynamic";

const CONTROL_PLANE_DETAIL_TABS = new Set(["overview", "agents", "config", "users", "releases", "logs"]);

function normalizeDetailTab(tab?: string) {
  return tab && CONTROL_PLANE_DETAIL_TABS.has(tab) ? tab as "overview" | "agents" | "config" | "users" | "releases" | "logs" : "overview";
}

export default async function ControlPlaneCustomerPage({
  params,
  searchParams,
}: {
  params: Promise<{ locale: string; deploymentId: string }>;
  searchParams?: Promise<{ tab?: string }>;
}) {
  const { locale, deploymentId } = await params;
  const rawSearchParams = await searchParams;
  const activeTab = normalizeDetailTab(rawSearchParams?.tab);
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
    clientOptions,
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
    getControlPlaneClientOptions(actor),
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
  const enterpriseApps = customer.managedWorkspaceId
    ? await listWorkspaceEnterpriseApps(actor, customer.managedWorkspaceId).catch((err: unknown) => ({
        canManage: false,
        installations: [],
        error: err instanceof Error ? err.message : "Unable to load enterprise apps.",
      }))
    : {
        canManage: false,
        installations: [],
        error: "Enterprise app inspection requires a managed workspace.",
      };

  return (
    <div className="space-y-5 pb-10">
      <ControlPlanePageHeader
        eyebrow={t("customerDetail.eyebrow")}
        title={customer.label}
        description={`Public URL: ${customer.url}`}
        actions={
          <div className="flex flex-wrap items-center gap-2">
            <ClientContextSwitcher
              clients={clientOptions}
              selectedClientId={customer.id}
              mode="detail"
              className="rounded-md border border-line bg-surface px-2.5 py-1.5"
              label="Inspect"
            />
            <a
              href={customer.url}
              target="_blank"
              rel="noreferrer"
              className={controlPlaneButtonClass}
            >
              {t("customerDetail.openCustomer")}
            </a>
            {customer.hasSupportCredential && (
              <form action={refreshSupportSnapshotAction}>
                <input type="hidden" name="deploymentId" value={customer.id} />
                <button type="submit" className={controlPlaneButtonClass}>
                  {t("customerDetail.refreshSnapshot")}
                </button>
              </form>
            )}
          </div>
        }
      />

      <CustomerDetailClientTabs
        customer={customer}
        integrations={integrations}
        context={context}
        aiGovernance={aiGovernance}
        releases={releases}
        members={members}
        featureFlags={featureFlags}
        enterpriseApps={enterpriseApps}
        deployPreflight={deployPreflight}
        rollouts={rollouts}
        locale={locale}
        initialTab={activeTab}
      />
    </div>
  );
}
