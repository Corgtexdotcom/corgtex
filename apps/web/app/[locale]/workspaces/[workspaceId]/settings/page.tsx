import {
  AppError,
  getMemberInvitePolicy,
  getModelUsageBudget,
  getSsoConfigByWorkspace,
  getUserNotificationPreferences,
  getUserProfile,
  getWorkspacePlanState,
  getAiWorkspaceSelectionState,
  listAgentConfigs,
  listAiWorkspaceToolProviders,
  listMemberInviteRequests,
  listMembersEnriched,
  listModuleAccessRequests,
  listUserSessions,
  listWorkspaceEnterpriseServiceStates,
  requireWorkspaceMembership,
} from "@corgtex/domain";
import { getModuleManifests } from "@corgtex/domain/modules";
import { env } from "@corgtex/shared";
import { requirePageActor } from "@/lib/auth";
import { headers } from "next/headers";
import { getFormatter, getTranslations } from "next-intl/server";
import { notFound } from "next/navigation";
import { getWorkspaceFeatureFlags } from "@/lib/workspace-feature-flags";
import { requestManagedEnterpriseServiceAction } from "../actions";
import { requestModuleAccessAction, decideModuleAccessRequestAction } from "./actions";
import { MembersTable } from "./MembersTable";
import { AgentSettingsClient } from "./agents/AgentSettingsClient";
import { SsoConfigManager } from "./SsoConfigManager";
import { UserSettingsPanel } from "./UserSettingsPanel";
import { OnboardingRestartButton } from "./OnboardingRestartButton";
import { AiWorkspaceManager } from "./AiWorkspaceManager";
import { normalizeSelectedProvider, normalizeSelectedService } from "./ai-workspace-ui";
import { AgentBudgetManager } from "./agents/AgentBudgetManager";

export const dynamic = "force-dynamic";

type SearchParamValue = string | string[] | undefined;

function toolsHref(workspaceId: string, query: string) {
  return `/workspaces/${workspaceId}/tools${query}`;
}

function ToolsMovedPanel({ workspaceId, compact = false }: { workspaceId: string; compact?: boolean }) {
  return (
    <section className="nr-item stack" style={{ gap: 12, padding: 18 }}>
      <div>
        <h2 className="nr-section-header" style={{ marginTop: 0 }}>
          Tools and integrations
        </h2>
        <p className="nr-item-meta" style={{ fontSize: "0.85rem", margin: 0 }}>
          Connector setup, databases, webhooks, apps, and shared tool links now live in Tools.
        </p>
      </div>
      <div className="actions-inline">
        <a className="button secondary small" href={toolsHref(workspaceId, "?type=CONNECTOR")}>Connectors</a>
        <a className="button secondary small" href={toolsHref(workspaceId, "?type=DATA_SOURCE")}>Data sources</a>
        <a className="button secondary small" href={toolsHref(workspaceId, "?type=TOOL&q=webhooks")}>Webhooks</a>
        {!compact && <a className="button secondary small" href={toolsHref(workspaceId, "?type=TOOL&q=meeting%20recorder")}>Meeting recorder</a>}
      </div>
    </section>
  );
}

export default async function SettingsPage({
  params,
  searchParams,
}: {
  params: Promise<{ workspaceId: string }>;
  searchParams: Promise<{
    tab?: string;
    provider?: SearchParamValue;
    service?: SearchParamValue;
  }>;
}) {
  const { workspaceId } = await params;
  const search = await searchParams;
  const actor = await requirePageActor();
  const featureFlags = await getWorkspaceFeatureFlags(workspaceId);
  const tab = search.tab ?? (featureFlags.SETTINGS_GENERAL ? "general" : "members");

  if (!featureFlags.AGENT_GOVERNANCE && tab === "agents") {
    notFound();
  }
  if (!featureFlags.SETTINGS_GENERAL && search.tab === "general") {
    notFound();
  }
  if (!featureFlags.AI_WORKSPACES && tab === "ai-workspaces") {
    notFound();
  }

  const [ssoConfigs, planState] = await Promise.all([
    getSsoConfigByWorkspace(actor, workspaceId).catch(() => []),
    getWorkspacePlanState(actor, workspaceId).catch(() => null),
  ]);

  let members: Awaited<ReturnType<typeof listMembersEnriched>> = [];
  let isAdmin = false;
  let invitePolicy: Awaited<ReturnType<typeof getMemberInvitePolicy>> = "ADMINS_ONLY";
  let inviteRequests: Awaited<ReturnType<typeof listMemberInviteRequests>> = [];
  if (tab === "members" || (tab === "ai-workspaces" && featureFlags.MANAGED_ENTERPRISE_SERVICES)) {
    try {
      const membership = await requireWorkspaceMembership({ actor, workspaceId });
      isAdmin = membership?.role === "ADMIN";
    } catch (error) {
      if (error instanceof AppError && error.status === 403) {
        notFound();
      }
      throw error;
    }
  }
  if (tab === "members") {
    try {
      members = await listMembersEnriched(workspaceId, { includeInactive: true });
      invitePolicy = await getMemberInvitePolicy(workspaceId);
      if (isAdmin) {
        inviteRequests = await listMemberInviteRequests(actor, { workspaceId, status: "PENDING" });
      }
    } catch (err) {
      console.error("[SettingsPage] Failed to fetch enriched members:", err);
    }
  }

  let agents: Awaited<ReturnType<typeof listAgentConfigs>> = [];
  let budget = null;
  if (tab === "agents") {
    try {
      [agents, budget] = await Promise.all([
        listAgentConfigs(actor, workspaceId),
        getModelUsageBudget(actor, workspaceId),
      ]);
    } catch (err) {
      console.error("[SettingsPage] Failed to fetch agent configs/budget:", err);
    }
  }

  let userProfile: any = null;
  let userSessions: any[] = [];
  let userPrefs: any[] = [];
  if (tab === "user") {
    try {
      const { sha256, sessionCookieName } = await import("@corgtex/shared");
      const cookieStore = await import("next/headers").then((m) => m.cookies());
      const token = cookieStore.get(sessionCookieName())?.value;
      const tokenHash = token ? sha256(token) : undefined;

      [userProfile, userSessions, userPrefs] = await Promise.all([
        getUserProfile(actor, workspaceId),
        listUserSessions(actor, tokenHash),
        getUserNotificationPreferences(actor),
      ]);
    } catch (err) {
      console.error("[SettingsPage] Failed to fetch user profile data:", err);
    }
  }

  const headersList = await headers();
  const host = headersList.get("host") || "localhost:3000";
  const protocol = host.includes("localhost") ? "http" : "https";
  const origin = `${protocol}://${host}`;
  const connectorUrl = env.MCP_PUBLIC_URL ?? `${origin}/mcp`;
  const t = await getTranslations("settings");
  const format = await getFormatter();
  const aiWorkspaceProviders = featureFlags.AI_WORKSPACES
    ? listAiWorkspaceToolProviders().map((provider) => ({
      ...provider,
      capabilities: [...provider.capabilities],
      supportedOwnershipModes: [...provider.supportedOwnershipModes],
      setupVariants: provider.setupVariants.map((variant) => ({
        ...variant,
        manualSteps: [...variant.manualSteps],
        limitations: [...variant.limitations],
      })),
    }))
    : [];
  const enterpriseServices = tab === "ai-workspaces" && featureFlags.AI_WORKSPACES && featureFlags.MANAGED_ENTERPRISE_SERVICES
    ? (await listWorkspaceEnterpriseServiceStates(actor, workspaceId)).map((service) => ({
      key: service.key,
      label: service.label,
      outcome: service.outcome,
      description: service.description,
      defaultOwnershipMode: service.defaultOwnershipMode,
      persistedId: service.persistedId,
      ownershipMode: service.ownershipMode,
      healthStatus: service.healthStatus,
      providerKey: service.providerKey,
      lastHealthCheckAt: service.lastHealthCheckAt?.toISOString() ?? null,
      lastSuccessfulHealthCheckAt: service.lastSuccessfulHealthCheckAt?.toISOString() ?? null,
      lastSuccessfulSyncAt: service.lastSuccessfulSyncAt?.toISOString() ?? null,
      lastError: service.lastError,
      usageLabel: service.usageLabel,
      usageDetail: service.usageDetail,
      supportEscalationStatus: service.supportEscalationStatus,
      supportEscalatedAt: service.supportEscalatedAt?.toISOString() ?? null,
      supportNotesMd: service.supportNotesMd,
      readinessChecks: service.readinessChecks,
    }))
    : [];
  const aiWorkspaceSelection = tab === "ai-workspaces" && featureFlags.AI_WORKSPACES
    ? await getAiWorkspaceSelectionState(actor, workspaceId).catch(() => ({ activeProviderKey: null, providers: [], connections: [] }))
    : { activeProviderKey: null, providers: [], connections: [] };
  const selectedProviderKey = normalizeSelectedProvider(search.provider, aiWorkspaceProviders);
  const selectedServiceKey = normalizeSelectedService(search.service, enterpriseServices);
  const agentBudget = budget
    ? {
      monthlyCostCapUsd: Number(budget.monthlyCostCapUsd),
      alertThresholdPct: budget.alertThresholdPct,
      periodStartDay: budget.periodStartDay,
    }
    : null;

  let moduleAccessRequests: Awaited<ReturnType<typeof listModuleAccessRequests>> = [];
  let moduleAccessIsAdmin = false;
  const moduleAccessModules = getModuleManifests()
    .filter((moduleManifest) => moduleManifest.nav)
    .map((moduleManifest) => ({ key: moduleManifest.key, title: moduleManifest.title }));
  if (tab === "module-access") {
    try {
      const membership = await requireWorkspaceMembership({ actor, workspaceId });
      moduleAccessIsAdmin = membership?.role === "ADMIN";
      moduleAccessRequests = await listModuleAccessRequests(actor, { workspaceId });
    } catch (error) {
      if (error instanceof AppError && error.status === 403) {
        notFound();
      }
      throw error;
    }
  }

  return (
    <>
      <header className="nr-masthead" style={{ textAlign: "left", marginBottom: 32 }}>
        <h1 style={{ border: "none", padding: 0, margin: 0, fontSize: "2rem" }}>{t("pageTitle")}</h1>
        <div className="nr-masthead-meta">
          <span>{t("pageDescription")}</span>
        </div>
      </header>

      <div className="nr-tab-bar" style={{ marginBottom: 32 }}>
        {featureFlags.SETTINGS_GENERAL && (
          <a href={`/workspaces/${workspaceId}/settings?tab=general`} className={`nr-tab ${tab === "general" ? "nr-tab-active" : ""}`}>
            {t("tabGeneral")}
          </a>
        )}
        <a href={`/workspaces/${workspaceId}/settings?tab=members`} className={`nr-tab ${tab === "members" ? "nr-tab-active" : ""}`}>
          {t("tabMembers")}
        </a>
        <a href={`/workspaces/${workspaceId}/settings?tab=data-sources`} className={`nr-tab ${tab === "data-sources" ? "nr-tab-active" : ""}`}>
          {t("tabKnowledgeSources")}
        </a>
        {featureFlags.AGENT_GOVERNANCE && (
          <a href={`/workspaces/${workspaceId}/settings?tab=agents`} className={`nr-tab ${tab === "agents" ? "nr-tab-active" : ""}`}>
            {t("tabAgents")}
          </a>
        )}
        {featureFlags.AI_WORKSPACES && (
          <a href={`/workspaces/${workspaceId}/settings?tab=ai-workspaces`} className={`nr-tab ${tab === "ai-workspaces" ? "nr-tab-active" : ""}`}>
            {t("tabAiWorkspaces")}
          </a>
        )}
        <a href={`/workspaces/${workspaceId}/settings?tab=user`} className={`nr-tab ${tab === "user" ? "nr-tab-active" : ""}`}>
          {t("tabUser")}
        </a>
        <a href={`/workspaces/${workspaceId}/settings?tab=module-access`} className={`nr-tab ${tab === "module-access" ? "nr-tab-active" : ""}`}>
          Module access
        </a>
      </div>

      {tab === "module-access" && (
        <div className="stack" style={{ gap: 32 }}>
          <section>
            <h2 className="nr-section-header">Request module access</h2>
            <p className="nr-item-meta" style={{ fontSize: "0.82rem", marginBottom: 16 }}>
              Request read or write access to a module. An admin approves; approval grants you access (and turns the module on if it was off).
            </p>
            <form action={requestModuleAccessAction} className="stack" style={{ gap: 12, maxWidth: 520 }}>
              <input type="hidden" name="workspaceId" value={workspaceId} />
              <label className="stack" style={{ gap: 4 }}>
                <span className="nr-item-meta">Module</span>
                <select name="moduleKey" required className="nr-input">
                  {moduleAccessModules.map((moduleOption) => (
                    <option key={moduleOption.key} value={moduleOption.key}>{moduleOption.title}</option>
                  ))}
                </select>
              </label>
              <label className="stack" style={{ gap: 4 }}>
                <span className="nr-item-meta">Access level</span>
                <select name="accessLevel" required className="nr-input">
                  <option value="read">read</option>
                  <option value="write">write</option>
                </select>
              </label>
              <label className="stack" style={{ gap: 4 }}>
                <span className="nr-item-meta">Reason</span>
                <input name="reasonMd" required placeholder="Why you need access" className="nr-input" />
              </label>
              <button type="submit" className="nr-button" style={{ alignSelf: "flex-start" }}>Submit request</button>
            </form>
          </section>

          <section>
            <h2 className="nr-section-header">{moduleAccessIsAdmin ? "Access requests" : "My requests"}</h2>
            {moduleAccessRequests.length === 0 && (
              <p className="nr-item-meta" style={{ fontSize: "0.82rem" }}>No requests yet.</p>
            )}
            <div className="stack" style={{ gap: 12 }}>
              {moduleAccessRequests.map((request) => (
                <div key={request.id} className="nr-item" style={{ padding: "12px 0" }}>
                  <div className="row">
                    <strong className="nr-item-title">{request.moduleKey} · {String(request.requestedAccess).toLowerCase()}</strong>
                    <span className="tag">{request.status}</span>
                  </div>
                  <p className="nr-item-meta" style={{ fontSize: "0.82rem", marginTop: 6 }}>{request.reasonMd}</p>
                  {moduleAccessIsAdmin && request.status === "PENDING" && (
                    <div className="row" style={{ gap: 8, marginTop: 8 }}>
                      <form action={decideModuleAccessRequestAction}>
                        <input type="hidden" name="workspaceId" value={workspaceId} />
                        <input type="hidden" name="requestId" value={request.id} />
                        <input type="hidden" name="status" value="APPROVED" />
                        <button type="submit" className="nr-button">Approve</button>
                      </form>
                      <form action={decideModuleAccessRequestAction}>
                        <input type="hidden" name="workspaceId" value={workspaceId} />
                        <input type="hidden" name="requestId" value={request.id} />
                        <input type="hidden" name="status" value="REJECTED" />
                        <button type="submit" className="nr-button">Reject</button>
                      </form>
                    </div>
                  )}
                </div>
              ))}
            </div>
          </section>
        </div>
      )}

      {tab === "user" && userProfile && (
        <UserSettingsPanel
          workspaceId={workspaceId}
          profile={userProfile}
          sessions={userSessions}
          preferences={userPrefs}
        />
      )}

      {tab === "general" && (
        <div className="stack" style={{ gap: 40 }}>
          <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(340px, 1fr))", gap: 40 }}>
            {planState && (
              <section>
                <h2 className="nr-section-header">Plan and AI usage</h2>
                <div className="nr-item" style={{ padding: "14px 0" }}>
                  <div className="row">
                    <strong className="nr-item-title">{planState.plan.replace(/_/g, " ")}</strong>
                    <span className="tag" style={{ background: planState.aiBudget.enabled ? "var(--accent-soft)" : "transparent" }}>
                      {planState.aiBudget.enabled ? "AI enabled" : "Core only"}
                    </span>
                  </div>
                  <p className="nr-item-meta" style={{ fontSize: "0.82rem", marginTop: 8 }}>
                    {planState.trialEndsAt
                      ? `Trial ends ${format.dateTime(planState.trialEndsAt, { dateStyle: "medium" })}. `
                      : ""}
                    AI spend this period: ${planState.aiBudget.usedUsd.toFixed(2)}
                    {planState.aiBudget.capUsd != null && planState.aiBudget.capUsd >= 0 ? ` of $${planState.aiBudget.capUsd.toFixed(2)}` : ""}.
                  </p>
                  <div className="actions-inline" style={{ marginTop: 12 }}>
                    {planState.plan !== "PAYG_AI" && (
                      <a className="button primary small" href={`/api/billing/checkout?workspaceId=${workspaceId}`}>
                        Enable pay-as-you-go AI
                      </a>
                    )}
                    {planState.billing?.stripeCustomerId && (
                      <a className="button secondary small" href={`/api/billing/portal?workspaceId=${workspaceId}`}>
                        Billing portal
                      </a>
                    )}
                    <OnboardingRestartButton />
                  </div>
                </div>
              </section>
            )}
            <ToolsMovedPanel workspaceId={workspaceId} />
            <SsoConfigManager workspaceId={workspaceId} configs={ssoConfigs} />
          </div>
        </div>
      )}

      {tab === "data-sources" && (
        <ToolsMovedPanel workspaceId={workspaceId} compact />
      )}

      {tab === "members" && (
        <MembersTable
          workspaceId={workspaceId}
          members={members}
          isAdmin={isAdmin}
          invitePolicy={invitePolicy}
          inviteRequests={inviteRequests}
        />
      )}

      {tab === "agents" && (
        <div className="stack" style={{ gap: 24 }}>
          <AgentBudgetManager workspaceId={workspaceId} budget={agentBudget} />
          <AgentSettingsClient workspaceId={workspaceId} agents={agents} />
        </div>
      )}

      {tab === "ai-workspaces" && featureFlags.AI_WORKSPACES && (
        <AiWorkspaceManager
          connectorUrl={connectorUrl}
          origin={origin}
          providers={aiWorkspaceProviders}
          enterpriseServices={enterpriseServices}
          managedServicesEnabled={featureFlags.MANAGED_ENTERPRISE_SERVICES}
          canRequestManagedServices={isAdmin}
          requestManagedServiceAction={requestManagedEnterpriseServiceAction}
          workspaceId={workspaceId}
          connections={aiWorkspaceSelection.connections.map((connection) => ({
            providerKey: connection.providerKey,
            healthStatus: connection.healthStatus,
            isDefault: connection.isDefault,
            connectedAt: connection.connectedAt?.toISOString() ?? null,
            lastCheckedAt: connection.lastCheckedAt?.toISOString() ?? null,
            verificationSource: connection.verificationSource,
          }))}
          selectedProviderKey={selectedProviderKey}
          selectedServiceKey={selectedServiceKey}
        />
      )}
    </>
  );
}
