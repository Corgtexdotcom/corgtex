import { notFound } from "next/navigation";
import { getTranslations } from "next-intl/server";
import {
  AppError,
  getControlPlaneDeployLatestPreflight,
  getControlPlaneAiGovernanceStatus,
  getControlPlaneClientOptions,
  getControlPlaneDeployment,
  listControlPlaneCustomerMembers,
  listControlPlaneFeatureFlags,
  listControlPlaneReleaseRolloutJobs,
  listWorkspaceEnterpriseApps,
  requireControlPlaneAccess,
} from "@corgtex/domain";
import { Link } from "@/i18n/routing";
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
  ControlPlaneCacheMeta,
  ControlPlanePageHeader,
  controlPlaneButtonClass,
} from "../../_components/control-plane-ui";
import { controlPlaneActorCacheKey, readControlPlaneCached, shouldRefreshControlPlaneCache } from "../../cache";
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
  searchParams?: Promise<{ tab?: string; refresh?: string }>;
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

  const refresh = shouldRefreshControlPlaneCache(rawSearchParams?.refresh);
  const actorCacheKey = controlPlaneActorCacheKey(actor);
  const [customerRead, clientOptionsRead, t] = await Promise.all([
    readControlPlaneCached(["control-plane", "deployment", actorCacheKey, deploymentId], refresh, () => (
      getControlPlaneDeployment(actor, deploymentId)
    )),
    readControlPlaneCached(["control-plane", "client-options", actorCacheKey], refresh, () => (
      getControlPlaneClientOptions(actor)
    )),
    getTranslations("controlPlane"),
  ]).catch((error: unknown) => {
    if (error instanceof AppError && error.status === 404) {
      notFound();
    }
    throw error;
  });
  const customer = customerRead.data;
  const clientOptions = clientOptionsRead.data;
  const emptyIntegrations = {
    deploymentId,
    accessMode: "inactive_tab",
    hasManagedWorkspace: Boolean(customer.managedWorkspaceId),
    integrations: [],
  };
  const emptyContext = {
    deploymentId,
    accessMode: "inactive_tab",
    hasManagedWorkspace: Boolean(customer.managedWorkspaceId),
    summary: null,
    sources: [],
  };
  const emptyAiGovernance = {
    deploymentId,
    accessMode: "inactive_tab",
    hasManagedWorkspace: Boolean(customer.managedWorkspaceId),
    agents: { identities: [], configs: [] },
    access: { credentials: [] },
    spend: { budget: null, recentModelUsage: [] },
    activity: { recentRuns: [] },
    summary: null,
  };
  const emptyDeployPreflight = {
    deploymentId,
    eligible: false,
    checks: [],
    blockers: [],
    target: null,
  };

  const [aiGovernanceRead, membersRead, featureFlagsRead, deployPreflightRead, rolloutsRead] = await Promise.all([
    activeTab === "agents"
      ? readControlPlaneCached(["control-plane", "deployment", "agents", actorCacheKey, deploymentId], refresh, () => (
        getControlPlaneAiGovernanceStatus(actor, deploymentId)
      ))
      : Promise.resolve({ data: emptyAiGovernance, cachedAt: customerRead.cachedAt, cacheStatus: customerRead.cacheStatus }),
    activeTab === "users"
      ? readControlPlaneCached(["control-plane", "deployment", "members", actorCacheKey, deploymentId], refresh, async () => (
        listControlPlaneCustomerMembers(actor, deploymentId).catch((err: unknown) => ({
          deploymentId,
          source: "unavailable" as const,
          members: [],
          error: err instanceof Error ? err.message : "Unable to load members.",
        }))
      ))
      : Promise.resolve({ data: { deploymentId, source: "inactive_tab" as const, members: [] }, cachedAt: customerRead.cachedAt, cacheStatus: customerRead.cacheStatus }),
    activeTab === "config"
      ? readControlPlaneCached(["control-plane", "deployment", "flags", actorCacheKey, deploymentId], refresh, async () => (
        listControlPlaneFeatureFlags(actor, deploymentId).catch((err: unknown) => ({
          deploymentId,
          source: "unavailable" as const,
          flags: [],
          error: err instanceof Error ? err.message : "Unable to load feature flags.",
        }))
      ))
      : Promise.resolve({ data: { deploymentId, source: "inactive_tab" as const, flags: [] }, cachedAt: customerRead.cachedAt, cacheStatus: customerRead.cacheStatus }),
    activeTab === "releases"
      ? readControlPlaneCached(["control-plane", "deployment", "preflight", actorCacheKey, deploymentId], refresh, () => (
        getControlPlaneDeployLatestPreflight(actor, deploymentId)
      ))
      : Promise.resolve({ data: emptyDeployPreflight, cachedAt: customerRead.cachedAt, cacheStatus: customerRead.cacheStatus }),
    activeTab === "releases"
      ? readControlPlaneCached(["control-plane", "deployment", "rollouts", actorCacheKey, deploymentId], refresh, () => (
        listControlPlaneReleaseRolloutJobs(actor, { deploymentId, take: 8 })
      ))
      : Promise.resolve({ data: [], cachedAt: customerRead.cachedAt, cacheStatus: customerRead.cacheStatus }),
  ]);

  // Standardize response types for client component
  const members = "members" in membersRead.data ? membersRead.data : { members: [] };
  const featureFlags = "flags" in featureFlagsRead.data ? featureFlagsRead.data : { flags: [] };
  const enterpriseWorkspaceId = activeTab === "config" ? customer.managedWorkspaceId : null;
  const enterpriseApps = enterpriseWorkspaceId
    ? (await readControlPlaneCached(["control-plane", "deployment", "enterprise-apps", actorCacheKey, enterpriseWorkspaceId], refresh, async () => (
      listWorkspaceEnterpriseApps(actor, enterpriseWorkspaceId).catch((err: unknown) => ({
        canManage: false,
        installations: [],
        error: err instanceof Error ? err.message : "Unable to load enterprise apps.",
      }))
    ))).data
    : {
        canManage: false,
        installations: [],
        error: activeTab === "config" ? "Enterprise app inspection requires a managed workspace." : null,
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

      <ControlPlaneCacheMeta
        cachedAt={customerRead.cachedAt}
        cacheStatus={customerRead.cacheStatus}
        refreshAction={<Link href={`?tab=${activeTab}&refresh=1`} className={controlPlaneButtonClass}>Refresh live data</Link>}
      />

      <CustomerDetailClientTabs
        customer={customer}
        integrations={emptyIntegrations}
        context={emptyContext}
        aiGovernance={aiGovernanceRead.data}
        releases={{ deploymentId }}
        members={members}
        featureFlags={featureFlags}
        enterpriseApps={enterpriseApps}
        deployPreflight={deployPreflightRead.data}
        rollouts={rolloutsRead.data}
        locale={locale}
        initialTab={activeTab}
      />
    </div>
  );
}
