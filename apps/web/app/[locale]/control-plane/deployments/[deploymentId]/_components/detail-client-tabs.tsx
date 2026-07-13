"use client";

import { useEffect, useState, useTransition } from "react";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { cn } from "@/lib/utils";
import {
  DisabledActionHint,
  StatusBadge,
  controlPlaneButtonClass,
  controlPlaneInputClass,
  controlPlaneLabel,
} from "../../../_components/control-plane-ui";
import {
  configureMeetingRecorderIntegrationAction,
  configureSupportConnectorAction,
  disconnectControlPlaneSlackInstallationAction,
  runSupportOperationAction,
  runMeetingRecorderOperationAction,
  recordBreakGlassAction,
  createControlPlaneMemberAction,
  resendControlPlaneAccessLinkAction,
  updateControlPlaneMemberStatusAction,
  setControlPlaneFeatureFlagAction,
  setControlPlaneModuleGrantAction,
  deleteControlPlaneModuleGrantAction,
  updateControlPlaneModelBudgetAction,
  updateControlPlaneAgentPolicyAction,
  revokeControlPlaneAgentCredentialAction,
  deployLatestControlPlaneReleaseAction,
  runReleaseOperationAction,
  installEnterpriseAppFromControlPlaneAction,
  updateEnterpriseAppFromControlPlaneAction,
  setEnterpriseAppSurfaceFromControlPlaneAction,
  probeEnterpriseAppHealthFromControlPlaneAction,
  revokeEnterpriseAppSessionsFromControlPlaneAction,
  updateControlPlaneSlackAgendaSettingsAction,
} from "../../../actions";

type DetailTabId = "overview" | "agents" | "config" | "tools" | "users" | "recorders" | "releases" | "logs";

const detailPanelClass = "rounded-lg border border-line bg-bg-alt p-4";
const detailInnerPanelClass = "rounded-md border border-line bg-surface p-3";
const detailDangerButtonClass =
  "inline-flex min-h-8 items-center justify-center rounded-md border border-rose-500/30 bg-rose-950/10 px-3 py-1.5 text-xs font-semibold text-rose-400 transition-colors hover:bg-rose-950/20 disabled:cursor-not-allowed disabled:opacity-50";
const detailPrimaryButtonClass = controlPlaneButtonClass;

type NewspaperDeliveryAlert = Record<string, unknown>;

function recordValue(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : null;
}

function optionalTextValue(value: unknown) {
  if (value === null || value === undefined) return null;
  const text = String(value).trim();
  return text.length > 0 ? text : null;
}

function numberValue(value: unknown) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : 0;
}

function newspaperDeliveryAlertFromPayload(value: unknown): NewspaperDeliveryAlert | null {
  const source = recordValue(value);
  if (!source) return null;
  const diagnostics = recordValue(source.diagnostics);
  const newspaperDiagnostics = recordValue(source.newspaperDiagnostics);
  const nestedNewspaperDiagnostics = recordValue(newspaperDiagnostics?.diagnostics);
  return [
    recordValue(source.deliveryAlert),
    recordValue(diagnostics?.deliveryAlert),
    recordValue(newspaperDiagnostics?.deliveryAlert),
    recordValue(nestedNewspaperDiagnostics?.deliveryAlert),
  ].find((alert) => optionalTextValue(alert?.state)) ?? null;
}

function newspaperDeliveryAttentionAlertFromPayload(value: unknown): NewspaperDeliveryAlert | null {
  const alert = newspaperDeliveryAlertFromPayload(value);
  return optionalTextValue(alert?.state) === "attention" ? alert : null;
}

function newspaperAffectedRecipients(alert: NewspaperDeliveryAlert | null) {
  return Array.isArray(alert?.affectedRecipients)
    ? alert.affectedRecipients.map(recordValue).filter(Boolean)
    : [];
}

function latestNewspaperDeliveryAlertError(alert: NewspaperDeliveryAlert | null) {
  const recipient = newspaperAffectedRecipients(alert)
    .find((item) => optionalTextValue(item?.error));
  return optionalTextValue(recipient?.error) ?? optionalTextValue(alert?.reason);
}

function NewspaperDeliveryAttentionBanner({
  alert,
  className,
}: {
  alert: NewspaperDeliveryAlert;
  className?: string;
}) {
  const latestError = latestNewspaperDeliveryAlertError(alert);
  const latestRunKey = optionalTextValue(alert.latestRunKey) ?? "unknown";
  const affectedRecipients = newspaperAffectedRecipients(alert).length;

  return (
    <div className={cn("rounded-md border border-amber-500/30 bg-amber-500/10 px-3 py-2 text-xs text-amber-100", className)}>
      <div className="flex flex-wrap items-center justify-between gap-2">
        <strong className="font-semibold text-amber-100">Newspaper delivery needs attention</strong>
        <StatusBadge status="attention">Attention</StatusBadge>
      </div>
      <p className="mt-1 text-[10px] text-amber-100/80">
        Fix email/provider/runtime configuration before the next scheduled newspaper. This path does not retry or resend old sends.
      </p>
      <div className="mt-2 grid grid-cols-2 gap-2 text-[10px] sm:grid-cols-4">
        <span>Run: <strong className="font-mono text-amber-50">{latestRunKey}</strong></span>
        <span>Failed: <strong className="text-amber-50">{numberValue(alert.failedCount)}</strong></span>
        <span>Skipped: <strong className="text-amber-50">{numberValue(alert.skippedAttentionCount)}</strong></span>
        <span>Provider: <strong className="text-amber-50">{numberValue(alert.providerFailureCount)}</strong></span>
      </div>
      <p className="mt-1 text-[10px] text-amber-100/80">
        Affected recipients: {affectedRecipients}
        {latestError ? ` / Latest error: ${latestError.slice(0, 180)}` : ""}
      </p>
    </div>
  );
}

interface TabProps {
  customer: any;
  integrations: any;
  context: any;
  aiGovernance: any;
  releases: any;
  members: { members: any[] };
  featureFlags: { flags: any[] };
  enterpriseApps: { canManage?: boolean; installations: any[]; error?: string | null };
  moduleGrants: {
    modules?: { key: string; title: string; tier: string }[];
    principalTypes?: string[];
    accessLevels?: readonly string[] | string[];
    grants: any[];
    error?: string | null;
  };
  deployPreflight: any;
  rollouts: any[];
  locale: string;
  initialTab: DetailTabId;
}

export function CustomerDetailClientTabs({
  customer,
  integrations,
  context,
  aiGovernance,
  releases,
  members,
  featureFlags,
  enterpriseApps,
  moduleGrants,
  deployPreflight,
  rollouts,
  locale,
  initialTab,
}: TabProps) {
  const router = useRouter();
  const pathname = usePathname() || "";
  const searchParams = useSearchParams();
  const [activeTab, setActiveTab] = useState<DetailTabId>(initialTab);
  const [pendingTab, setPendingTab] = useState<DetailTabId | null>(null);
  const [isPending, startTransition] = useTransition();

  // Local state for interactive details
  const [selectedAction, setSelectedAction] = useState("members.list");
  const [timezoneOffsetMinutes, setTimezoneOffsetMinutes] = useState("0");

  const tabs = [
    { id: "overview", label: "Overview" },
    { id: "agents", label: "Agents & Governance" },
    { id: "config", label: "Config" },
    { id: "tools", label: "Tools & Integrations" },
    { id: "users", label: "Users & Access" },
    { id: "recorders", label: "Recorders" },
    { id: "releases", label: "Releases & Matrix" },
    { id: "logs", label: "Support & Audit" },
  ] as const;

  useEffect(() => {
    setActiveTab(initialTab);
    setPendingTab(null);
  }, [initialTab]);

  useEffect(() => {
    setTimezoneOffsetMinutes(String(new Date().getTimezoneOffset()));
  }, []);

  const selectTab = (tabId: DetailTabId) => {
    if (tabId === activeTab && !pendingTab) return;
    setPendingTab(tabId);
    const params = new URLSearchParams(searchParams?.toString() ?? "");
    params.set("tab", tabId);
    startTransition(() => {
      router.replace(`${pathname}?${params.toString()}`, { scroll: false });
    });
  };

  const isPreflightPassed = Boolean(deployPreflight.eligible);
  const preflightChecks = Array.isArray(deployPreflight.checks)
    ? deployPreflight.checks
    : [];
  const canManageEnterpriseApps = Boolean(enterpriseApps.canManage && customer.managedWorkspaceId);
  const integrationRows = Array.isArray(integrations.integrations) ? integrations.integrations : [];
  const availableConnectors = Array.isArray(integrations.availableConnectors) ? integrations.availableConnectors : [];
  const slackConnector = availableConnectors.find((connector: any) => connector.key === "slack") ?? null;
  const slackIntegration = integrationRows.find((integration: any) => integration.label === "SLACK") ?? null;
  const slackSettings = slackIntegration?.settings && typeof slackIntegration.settings === "object" && !Array.isArray(slackIntegration.settings)
    ? slackIntegration.settings as Record<string, unknown>
    : {};
  const recorderIntegration = integrationRows.find((integration: any) => integration.key === "meeting_recorders") ?? null;
  const recorderReadiness = recorderIntegration?.readiness ?? null;
  const recorderFailedChecks = Array.isArray(recorderReadiness?.failedChecks)
    ? recorderReadiness.failedChecks
    : [];
  const recorderCalendarSource = recorderIntegration?.calendarSource ?? null;
  const recorderLastSmokeRun = recorderIntegration?.lastSmokeRun ?? null;
  const fleetSnapshots = Array.isArray(customer.fleetSnapshots) ? customer.fleetSnapshots : [];
  const latestSnapshot = (kind: string) => fleetSnapshots.find((snapshot: any) => snapshot.snapshotKind === kind) ?? null;
  const healthSnapshot = latestSnapshot("HEALTH");
  const releaseSnapshot = latestSnapshot("RELEASE");
  const supportReadySnapshot = latestSnapshot("SUPPORT_READY");
  const contextSnapshot = latestSnapshot("CONTEXT");
  const integrationSnapshot = latestSnapshot("INTEGRATION");
  const latestRollout = Array.isArray(rollouts) ? rollouts[0] : null;
  const healthSummary = healthSnapshot?.summary && typeof healthSnapshot.summary === "object" ? healthSnapshot.summary : {};
  const releaseSummary = releaseSnapshot?.summary && typeof releaseSnapshot.summary === "object" ? releaseSnapshot.summary : {};
  const liveRelease = healthSummary?.health?.release ?? releaseSummary?.observedRelease ?? null;
  const intendedRelease = releaseSummary?.expectedReleaseImageTag ?? releaseSummary?.expectedReleaseVersion ?? null;
  const schemaStatus = healthSummary?.health?.schema ?? "unknown";
  const supportOperations = Array.isArray(customer.supportOperations) ? customer.supportOperations : [];
  const latestNewspaperDiagnosticsOperation = supportOperations
    .filter((operation: any) => operation?.action === "newspaper.diagnostics" && operation?.status === "COMPLETED")
    .sort((a: any, b: any) => (
      new Date(b.completedAt ?? b.updatedAt ?? b.createdAt ?? 0).getTime()
      - new Date(a.completedAt ?? a.updatedAt ?? a.createdAt ?? 0).getTime()
    ))[0] ?? null;
  const snapshotNewspaperDeliveryAlert = newspaperDeliveryAttentionAlertFromPayload(
    recordValue(supportReadySnapshot?.summary)?.newspaperDiagnostics ?? supportReadySnapshot?.summary,
  );
  const operationNewspaperDeliveryAlert = newspaperDeliveryAttentionAlertFromPayload(latestNewspaperDiagnosticsOperation?.resultSummary);
  const newspaperDeliveryAlert = operationNewspaperDeliveryAlert ?? snapshotNewspaperDeliveryAlert;

  return (
    <div className="space-y-6">
      
      <div className="flex overflow-x-auto border-b border-line scrollbar-none">
        {tabs.map((tab) => {
          const isActive = activeTab === tab.id;
          const isPendingTab = pendingTab === tab.id;
          return (
            <button
              key={tab.id}
              onClick={() => selectTab(tab.id)}
              className={cn(
                "!min-h-0 !rounded-none !border-x-0 !border-t-0 !bg-transparent !shadow-none border-b-2 px-4 py-2.5 text-xs font-semibold transition-colors whitespace-nowrap",
                isActive
                  ? "border-brand-500 text-white"
                  : isPendingTab
                    ? "border-amber-500/70 text-amber-200"
                  : "border-transparent text-muted hover:!bg-surface/30 hover:text-text"
              )}
            >
              {tab.label}
            </button>
          );
        })}
      </div>

      {(pendingTab || isPending) && (
        <div className="rounded-md border border-amber-500/25 bg-amber-500/10 px-3 py-2 text-[10px] font-medium text-amber-200">
          Loading {tabs.find((tab) => tab.id === pendingTab)?.label ?? "tab"} details...
        </div>
      )}

      {/* Tab Panels */}
      <div className="space-y-6">
        
        {/* OVERVIEW TAB */}
        {activeTab === "overview" && (
          <div className="grid grid-cols-1 gap-5 lg:grid-cols-3">
            {newspaperDeliveryAlert && (
              <div className="lg:col-span-3">
                <NewspaperDeliveryAttentionBanner alert={newspaperDeliveryAlert} />
              </div>
            )}
            <div className="lg:col-span-2 space-y-6">
              <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
                <div className={detailPanelClass}>
                  <span className="text-[10px] text-muted font-semibold uppercase">Runtime Health</span>
                  <div className="mt-2">
                    <StatusBadge status={customer.lastHealthStatus || customer.provisioningStatus} />
                  </div>
                  <span className="text-[10px] text-muted block truncate">{customer.lastHealthError || "No errors recorded"}</span>
                </div>
                <div className={detailPanelClass}>
                  <span className="text-[10px] text-muted font-semibold uppercase">Active Release</span>
                  <strong className="mt-2 block truncate text-sm font-semibold text-white">
                    {customer.releaseImageTag || customer.releaseVersion || "Unknown"}
                  </strong>
                  <span className="text-[10px] text-muted block">Rollout aligned</span>
                </div>
              </div>

              <div className={`${detailPanelClass} space-y-4`}>
                <h3 className="text-sm font-semibold text-white">Health & Deployment Readiness Checks</h3>
                <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                  {[
                    { label: "Customer Deployment Record", ok: !!customer.url, desc: customer.url || "Missing URL" },
                    { label: "Managed Workspace Link", ok: !!customer.managedWorkspace, desc: customer.managedWorkspace ? `${customer.managedWorkspace.name} / ${customer.managedWorkspace.slug}` : "Remote only" },
                    { label: "Deployment Residency Policy", ok: !!customer.region && !!customer.dataResidency, desc: [customer.region, customer.dataResidency].filter(Boolean).join(" / ") || "Not set" },
                    { label: "Runtime Telemetry Probes", ok: customer.lastHealthStatus === "ok", desc: customer.lastHealthStatus || "No telemetry logged" },
                  ].map((check, idx) => (
                    <div key={idx} className={detailInnerPanelClass}>
                      <div className="mb-2">
                        <StatusBadge status={check.ok ? "ok" : "attention"}>{check.ok ? "Ready" : "Needs work"}</StatusBadge>
                      </div>
                      <div>
                        <h4 className="text-xs font-semibold text-white">{check.label}</h4>
                        <p className="text-[10px] text-muted mt-0.5">{check.desc}</p>
                      </div>
                    </div>
                  ))}
                </div>
              </div>
            </div>

            <div className={`${detailPanelClass} h-fit space-y-4`}>
              <div>
                <h3 className="text-sm font-semibold text-white">Quick Telemetry Actions</h3>
                <p className="text-[10px] text-muted mt-0.5">Run reasoned support operations directly.</p>
              </div>

              <form action={runSupportOperationAction} className="space-y-4">
                <input type="hidden" name="deploymentId" value={customer.id} />
                <div>
                  <label className="text-[10px] font-bold text-muted uppercase tracking-wider block mb-1.5">
                    Operational Action
                  </label>
                  <select
                    name="action"
                    value={selectedAction}
                    onChange={(e) => setSelectedAction(e.target.value)}
                    className={`${controlPlaneInputClass} w-full`}
                  >
                    <option value="members.list">List workspace members</option>
                    <option value="integrations.list">Inspect active integrations</option>
                    <option value="data_feeds.list">Inspect context data feeds</option>
                    <option value="runtime.list_failed_jobs">List failing background jobs</option>
                    <option value="model_budget.get">Query model budget overview</option>
                    <option value="newspaper.diagnostics">Inspect newspaper diagnostics</option>
                  </select>
                </div>
                <div>
                  <label className="text-[10px] font-bold text-muted uppercase tracking-wider block mb-1.5">
                    Mutation Reason
                  </label>
                  <input
                    name="reason"
                    required
                    placeholder="Audit reason for support probe"
                    className={`${controlPlaneInputClass} w-full`}
                  />
                  <input type="hidden" name="argumentsJson" value="{}" />
                </div>
                <button
                  type="submit"
                  className={`${detailPrimaryButtonClass} w-full`}
                >
                  Execute support action
                </button>
              </form>
            </div>
          </div>
        )}

        {/* AGENTS TAB (GOVERNANCE) */}
        {activeTab === "agents" && (
          <div className="grid grid-cols-1 gap-5 lg:grid-cols-3">
            <div className="lg:col-span-2 space-y-6">
              <div className={`${detailPanelClass} space-y-4`}>
                <div className="flex items-center justify-between">
                  <div>
                    <h3 className="text-sm font-semibold text-white">Model Budget Limits</h3>
                    <p className="text-[10px] text-muted mt-0.5">Control monthly cap limits and alert thresholds.</p>
                  </div>
                  <StatusBadge status="active">Spend active</StatusBadge>
                </div>

                <form action={updateControlPlaneModelBudgetAction} className="grid grid-cols-1 sm:grid-cols-2 md:grid-cols-4 gap-4 items-end">
                  <input type="hidden" name="deploymentId" value={customer.id} />
                  <input type="hidden" name="periodStartDay" value={aiGovernance.spend.budget?.periodStartDay ?? 1} />
                  <div>
                    <label className="text-[10px] font-bold text-muted uppercase tracking-wider block mb-1.5">Monthly Cap (USD)</label>
                    <input
                      name="monthlyCostCapUsd"
                      type="number"
                      defaultValue={aiGovernance.spend.budget?.monthlyCostCapUsd ?? ""}
                      className={`${controlPlaneInputClass} w-full`}
                      required
                    />
                  </div>
                  <div>
                    <label className="text-[10px] font-bold text-muted uppercase tracking-wider block mb-1.5">Alert Threshold (%)</label>
                    <input
                      name="alertThresholdPct"
                      type="number"
                      defaultValue={aiGovernance.spend.budget?.alertThresholdPct ?? 80}
                      className={`${controlPlaneInputClass} w-full`}
                    />
                  </div>
                  <div>
                    <label className="text-[10px] font-bold text-muted uppercase tracking-wider block mb-1.5">Reason</label>
                    <input
                      name="reason"
                      required
                      placeholder="Budget policy change"
                      className={`${controlPlaneInputClass} w-full`}
                    />
                  </div>
                  <button
                    type="submit"
                    className={`${controlPlaneButtonClass} w-full`}
                  >
                    Save cap
                  </button>
                </form>
              </div>

              <div className={`${detailPanelClass} space-y-4`}>
                <h3 className="text-sm font-semibold text-white">Fleet Agents & Constitutional Policies</h3>
                <div className="space-y-4 divide-y divide-line">
                  {aiGovernance.agents.configs.map((agent: any) => (
                    <div key={agent.agentKey} className="pt-4 first:pt-0 space-y-3">
                      <div className="flex items-center justify-between">
                        <div>
                          <strong className="text-white text-xs font-semibold">{agent.label}</strong>
                          <span className="text-[10px] text-muted block">{agent.agentKey} / {agent.category}</span>
                        </div>
                        <StatusBadge status={agent.enabled ? "enabled" : "disabled"} />
                      </div>

                      <p className="text-[10px] text-muted italic">
                        Model: {agent.modelOverride || `default ${agent.defaultModelTier}`} / Governance constitution active
                      </p>

                      {/* Modify policy action inline form */}
                      <form action={updateControlPlaneAgentPolicyAction} className="grid grid-cols-1 sm:grid-cols-3 gap-3 items-end pt-1.5">
                        <input type="hidden" name="deploymentId" value={customer.id} />
                        <input type="hidden" name="agentKey" value={agent.agentKey} />
                        <div>
                          <label className="text-[9px] font-bold text-muted uppercase tracking-wider block mb-1">Model Override</label>
                          <input
                            name="modelOverride"
                            defaultValue={agent.modelOverride ?? ""}
                            placeholder="openrouter/gpt-4o"
                            className={`${controlPlaneInputClass} w-full`}
                          />
                        </div>
                        <div>
                          <label className="text-[9px] font-bold text-muted uppercase tracking-wider block mb-1">Reason</label>
                          <input
                            name="reason"
                            required
                            placeholder="Reason for policy override"
                            className={`${controlPlaneInputClass} w-full`}
                          />
                        </div>
                        <button
                          type="submit"
                          className={`${controlPlaneButtonClass} w-full`}
                        >
                          Override policy
                        </button>
                      </form>
                    </div>
                  ))}
                </div>
              </div>
            </div>

            <div className={`${detailPanelClass} h-fit space-y-4`}>
              <div>
                <h3 className="text-sm font-semibold text-white">MCP Access & Scopes</h3>
                <p className="text-[10px] text-muted mt-0.5">Least-privilege API credentials and write scopes.</p>
              </div>

              <div className="space-y-4">
                {aiGovernance.access.credentials.map((cred: any) => (
                  <div key={cred.id} className={`${detailInnerPanelClass} space-y-2`}>
                    <div className="flex items-center justify-between">
                      <strong className="text-xs text-white tracking-wide">{cred.label}</strong>
                      <StatusBadge status={cred.isActive ? "active" : "disabled"}>{cred.isActive ? "active" : "revoked"}</StatusBadge>
                    </div>
                    <div className="text-[9px] text-muted">
                      <span>Scopes active: {cred.scopes.length} / last used {cred.lastUsedAt ? new Date(cred.lastUsedAt).toLocaleDateString() : "never"}</span>
                    </div>

                    {cred.isActive && (
                      <form action={revokeControlPlaneAgentCredentialAction} className="pt-2 border-t border-line">
                        <input type="hidden" name="deploymentId" value={customer.id} />
                        <input type="hidden" name="credentialId" value={cred.id} />
                        <div className="flex gap-2">
                          <input
                            name="reason"
                            required
                            placeholder="Reason for revocation"
                            className={`${controlPlaneInputClass} w-full`}
                          />
                          <button
                            type="submit"
                            className={`${detailDangerButtonClass} shrink-0`}
                          >
                            Revoke
                          </button>
                        </div>
                      </form>
                    )}
                  </div>
                ))}
              </div>
            </div>
          </div>
        )}

        {/* CONFIGURATION & FEATURE FLAGS TAB */}
        {activeTab === "config" && (
          <div className="grid grid-cols-1 gap-5 lg:grid-cols-3">
            <div className="lg:col-span-2 space-y-6">
              <div className={`${detailPanelClass} space-y-4`}>
                <div>
                  <h3 className="text-sm font-semibold text-white">Enterprise Apps</h3>
                  <p className="text-[10px] text-muted mt-0.5">Installed customer apps, runtime posture, and workspace surface assignments.</p>
                </div>

                {enterpriseApps.error && (
                  <div className="rounded-lg border border-amber-500/25 bg-amber-500/10 px-3 py-2 text-[11px] text-amber-300">
                    {enterpriseApps.error}
                  </div>
                )}

                {canManageEnterpriseApps && (
                  <form action={installEnterpriseAppFromControlPlaneAction} className={`${detailInnerPanelClass} grid grid-cols-1 gap-3 lg:grid-cols-6`}>
                    <input type="hidden" name="deploymentId" value={customer.id} />
                    <input type="hidden" name="workspaceId" value={customer.managedWorkspaceId} />
                    <input type="hidden" name="runtimeMode" value="SELF_MANAGED_EXTERNAL" />
                    <input type="hidden" name="surface" value="FINANCE" />
                    <input name="appKey" required placeholder="App key" className={controlPlaneInputClass} />
                    <input name="runtimeBaseUrl" placeholder="Runtime URL" className={controlPlaneInputClass} />
                    <input name="tenantExternalId" placeholder="Tenant / org id" className={controlPlaneInputClass} />
                    <input name="launchPath" placeholder="/embedded" className={controlPlaneInputClass} />
                    <input name="reason" required placeholder="Audit reason" className={controlPlaneInputClass} />
                    <button type="submit" className={detailPrimaryButtonClass}>Install app</button>
                  </form>
                )}

                <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                  {enterpriseApps.installations.map((installation: any) => {
                    const runtime = installation.runtime;
                    const surfaces = Array.isArray(installation.surfaces) ? installation.surfaces.filter((surface: any) => surface.enabled) : [];
                    const financeAssigned = surfaces.some((surface: any) => surface.surface === "FINANCE");
                    const statusStyle = installation.status === "INSTALLED"
                      ? "text-emerald-400 border-emerald-500/20 bg-emerald-500/10"
                      : installation.status === "UNHEALTHY" || installation.status === "DISABLED"
                        ? "text-rose-400 border-rose-500/20 bg-rose-500/10"
                        : "text-amber-400 border-amber-500/20 bg-amber-500/10";
                    return (
                      <div key={installation.id} className={`${detailInnerPanelClass} space-y-3`}>
                        <div className="flex items-start justify-between gap-3">
                          <div>
                            <strong className="text-xs text-white block">{installation.app?.title ?? "Enterprise app"}</strong>
                            <span className="text-[10px] text-muted">{installation.app?.appKey ?? installation.id}</span>
                          </div>
                          <span className={cn("text-[9px] font-bold px-1.5 py-0.5 rounded border", statusStyle)}>
                            {String(installation.status).replace(/_/g, " ")}
                          </span>
                        </div>

                        <div className="grid grid-cols-2 gap-2 text-[10px] text-muted">
                          <div>
                            <span className="block uppercase tracking-wider text-[9px]">Runtime</span>
                            <span className="text-text">{runtime?.mode ? String(runtime.mode).replace(/_/g, " ") : "Not configured"}</span>
                          </div>
                          <div>
                            <span className="block uppercase tracking-wider text-[9px]">Health</span>
                            <span className="text-text">{runtime?.lastHealthStatus ?? installation.lastHealthStatus ?? runtime?.status ?? "Unknown"}</span>
                          </div>
                          <div>
                            <span className="block uppercase tracking-wider text-[9px]">Tenant</span>
                            <span className="text-text">{installation.tenantExternalId ?? "Not mapped"}</span>
                          </div>
                          <div>
                            <span className="block uppercase tracking-wider text-[9px]">Surface</span>
                            <span className="text-text">{surfaces.length ? surfaces.map((surface: any) => String(surface.surface).toLowerCase()).join(", ") : "None"}</span>
                          </div>
                        </div>

                        {runtime?.baseUrl && (
                          <a href={runtime.baseUrl} target="_blank" rel="noreferrer" className="inline-flex items-center text-[10px] text-brand-400 hover:underline">
                            Open runtime
                          </a>
                        )}

                        {canManageEnterpriseApps && (
                          <div className="space-y-3 border-t border-line pt-3">
                            <form action={updateEnterpriseAppFromControlPlaneAction} className="grid grid-cols-1 gap-2">
                              <input type="hidden" name="deploymentId" value={customer.id} />
                              <input type="hidden" name="workspaceId" value={customer.managedWorkspaceId} />
                              <input type="hidden" name="appInstallationId" value={installation.id} />
                              <div className="grid grid-cols-2 gap-2">
                                <select name="status" defaultValue={installation.status} className={controlPlaneInputClass}>
                                  {["INSTALLED", "NEEDS_SETUP", "UNHEALTHY", "DISABLED"].map((status) => (
                                    <option key={status} value={status}>{status.replace(/_/g, " ")}</option>
                                  ))}
                                </select>
                                <select name="runtimeStatus" defaultValue={runtime?.status ?? "ACTIVE"} className={controlPlaneInputClass}>
                                  {["ACTIVE", "UNHEALTHY", "DISABLED"].map((status) => (
                                    <option key={status} value={status}>{status.replace(/_/g, " ")}</option>
                                  ))}
                                </select>
                              </div>
                              <input name="runtimeBaseUrl" defaultValue={runtime?.baseUrl ?? ""} placeholder="Runtime URL" className={controlPlaneInputClass} />
                              <input name="runtimeHealthUrl" defaultValue={runtime?.healthUrl ?? ""} placeholder="Health URL" className={controlPlaneInputClass} />
                              <input name="runtimeMcpUrl" defaultValue={runtime?.mcpUrl ?? ""} placeholder="MCP URL" className={controlPlaneInputClass} />
                              <div className="grid grid-cols-2 gap-2">
                                <input name="tenantExternalId" defaultValue={installation.tenantExternalId ?? ""} placeholder="Tenant / org id" className={controlPlaneInputClass} />
                                <input name="launchPath" defaultValue={installation.launchPath ?? ""} placeholder="Launch path" className={controlPlaneInputClass} />
                              </div>
                              <div className="flex gap-2">
                                <input name="reason" required placeholder="Audit reason" className={`${controlPlaneInputClass} w-full`} />
                                <button type="submit" className={`${detailPrimaryButtonClass} shrink-0`}>Save</button>
                              </div>
                            </form>

                            <form action={probeEnterpriseAppHealthFromControlPlaneAction} className="flex gap-2">
                              <input type="hidden" name="deploymentId" value={customer.id} />
                              <input type="hidden" name="workspaceId" value={customer.managedWorkspaceId} />
                              <input type="hidden" name="appInstallationId" value={installation.id} />
                              <input name="reason" required placeholder="Health probe reason" className={`${controlPlaneInputClass} w-full`} />
                              <button type="submit" className={`${detailPrimaryButtonClass} shrink-0`}>Probe</button>
                            </form>

                            <form action={setEnterpriseAppSurfaceFromControlPlaneAction} className="flex gap-2">
                              <input type="hidden" name="deploymentId" value={customer.id} />
                              <input type="hidden" name="workspaceId" value={customer.managedWorkspaceId} />
                              <input type="hidden" name="appInstallationId" value={installation.id} />
                              <input type="hidden" name="surface" value="FINANCE" />
                              <input type="hidden" name="enabled" value={financeAssigned ? "false" : "true"} />
                              <input name="reason" required placeholder="Surface reason" className={`${controlPlaneInputClass} w-full`} />
                              <button type="submit" className={`${detailPrimaryButtonClass} shrink-0`}>{financeAssigned ? "Unassign" : "Assign"}</button>
                            </form>

                            <form action={revokeEnterpriseAppSessionsFromControlPlaneAction} className="flex gap-2">
                              <input type="hidden" name="deploymentId" value={customer.id} />
                              <input type="hidden" name="workspaceId" value={customer.managedWorkspaceId} />
                              <input type="hidden" name="appInstallationId" value={installation.id} />
                              <input name="reason" required placeholder="Session revoke reason" className={`${controlPlaneInputClass} w-full`} />
                              <button type="submit" className={`${detailDangerButtonClass} shrink-0`}>Revoke sessions</button>
                            </form>
                          </div>
                        )}
                      </div>
                    );
                  })}
                </div>

                {enterpriseApps.installations.length === 0 && !enterpriseApps.error && (
                  <p className="text-[11px] text-muted">No enterprise apps are installed for this customer workspace.</p>
                )}
              </div>

              <div className={`${detailPanelClass} space-y-4`}>
                <div>
                  <h3 className="text-sm font-semibold text-white">Audited Feature Flags</h3>
                  <p className="text-[10px] text-muted mt-0.5">Toggle customer feature flags with audited operations trail.</p>
                </div>

                <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                  {featureFlags.flags.map((flag: any) => (
                    <form
                      key={flag.flag}
                      action={setControlPlaneFeatureFlagAction}
                      className={`${detailInnerPanelClass} flex flex-col justify-between space-y-3`}
                    >
                      <input type="hidden" name="deploymentId" value={customer.id} />
                      <input type="hidden" name="flag" value={flag.flag} />
                      <input type="hidden" name="enabled" value={flag.enabled ? "false" : "true"} />
                      
                      <div className="space-y-1">
                        <div className="flex items-center justify-between">
                          <strong className="text-xs text-white">{flag.label}</strong>
                          <StatusBadge status={flag.enabled ? "enabled" : "disabled"} />
                        </div>
                        <p className="text-[10px] text-muted mt-0.5">{flag.description}</p>
                      </div>

                      <div className="pt-2 border-t border-line/60 space-y-2">
                        <label className="text-[9px] font-bold text-muted uppercase tracking-wider block">Audit Reason</label>
                        <div className="flex gap-2">
                          <input
                            name="reason"
                            required
                            placeholder="Reason for toggling flag"
                            className={`${controlPlaneInputClass} w-full`}
                          />
                          <button
                            type="submit"
                            className={cn(flag.enabled ? detailDangerButtonClass : controlPlaneButtonClass, "shrink-0")}
                          >
                            {flag.enabled ? "Disable" : "Enable"}
                          </button>
                        </div>
                      </div>
                    </form>
                  ))}
                </div>
              </div>

              <div className={`${detailPanelClass} space-y-4`}>
                <div>
                  <h3 className="text-sm font-semibold text-white">Module Access Grants</h3>
                  <p className="text-[10px] text-muted mt-0.5">Grant read/write access to a member, member role, governance role, or circle for a module. Audited; manifest defaults apply when no grant exists.</p>
                </div>

                {moduleGrants.error && (
                  <p className="text-[10px] text-amber-400">{moduleGrants.error}</p>
                )}

                {!moduleGrants.error && (
                  <>
                    <div className="space-y-2">
                      {moduleGrants.grants.map((grant: any) => (
                        <form
                          key={grant.id}
                          action={deleteControlPlaneModuleGrantAction}
                          className={`${detailInnerPanelClass} flex flex-wrap items-center justify-between gap-2`}
                        >
                          <input type="hidden" name="deploymentId" value={customer.id} />
                          <input type="hidden" name="grantId" value={grant.id} />
                          <div className="space-y-0.5">
                            <strong className="text-xs text-white">{grant.moduleKey}</strong>
                            <p className="text-[10px] text-muted">
                              {grant.principalType}: <span className="text-white">{grant.principalId}</span> {"\u2192"} {String(grant.accessLevel).toLowerCase()}
                            </p>
                          </div>
                          <div className="flex items-center gap-2">
                            <input name="reason" required placeholder="Reason" className={controlPlaneInputClass} />
                            <button type="submit" className={cn(detailDangerButtonClass, "shrink-0")}>Remove</button>
                          </div>
                        </form>
                      ))}
                      {moduleGrants.grants.length === 0 && (
                        <p className="text-[10px] text-muted">No grants yet. Module manifest defaults apply.</p>
                      )}
                    </div>

                    <form action={setControlPlaneModuleGrantAction} className={`${detailInnerPanelClass} space-y-3`}>
                      <input type="hidden" name="deploymentId" value={customer.id} />
                      <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
                        <div>
                          <label className="mb-1.5 block text-[10px] font-bold uppercase tracking-wider text-muted">Module</label>
                          <select name="moduleKey" required className={`${controlPlaneInputClass} w-full`}>
                            {(moduleGrants.modules ?? []).map((mod) => (
                              <option key={mod.key} value={mod.key}>{mod.title} ({mod.key})</option>
                            ))}
                          </select>
                        </div>
                        <div>
                          <label className="mb-1.5 block text-[10px] font-bold uppercase tracking-wider text-muted">Principal type</label>
                          <select name="principalType" required className={`${controlPlaneInputClass} w-full`}>
                            {(moduleGrants.principalTypes ?? []).map((pt) => (
                              <option key={pt} value={pt}>{pt}</option>
                            ))}
                          </select>
                        </div>
                        <div>
                          <label className="mb-1.5 block text-[10px] font-bold uppercase tracking-wider text-muted">Principal id</label>
                          <input name="principalId" required placeholder="member id / role / circle id" className={`${controlPlaneInputClass} w-full`} />
                        </div>
                        <div>
                          <label className="mb-1.5 block text-[10px] font-bold uppercase tracking-wider text-muted">Access level</label>
                          <select name="accessLevel" required className={`${controlPlaneInputClass} w-full`}>
                            {(moduleGrants.accessLevels ?? ["none", "read", "write"]).map((lvl) => (
                              <option key={lvl} value={lvl}>{lvl}</option>
                            ))}
                          </select>
                        </div>
                      </div>
                      <div className="flex gap-2">
                        <input name="reason" required placeholder="Audit reason" className={`${controlPlaneInputClass} w-full`} />
                        <button type="submit" className={cn(controlPlaneButtonClass, "shrink-0")}>Grant</button>
                      </div>
                    </form>
                  </>
                )}
              </div>
            </div>

            <div className={`${detailPanelClass} h-fit space-y-4`}>
              <div>
                <h3 className="text-sm font-semibold text-white">Support Connector Settings</h3>
                <p className="text-[10px] text-muted mt-0.5">Encrypt credentials for secure live queries.</p>
              </div>

              <form action={configureSupportConnectorAction} className="space-y-4 text-xs">
                <input type="hidden" name="deploymentId" value={customer.id} />
                <input type="hidden" name="supportNotes" value={customer.supportNotes ?? ""} />
                <div>
                  <label className="text-[10px] font-bold text-muted uppercase tracking-wider block mb-1.5">Base URL</label>
                  <input
                    name="supportBaseUrl"
                    defaultValue={customer.supportBaseUrl ?? ""}
                    className={`${controlPlaneInputClass} w-full`}
                  />
                </div>
                <div>
                  <label className="text-[10px] font-bold text-muted uppercase tracking-wider block mb-1.5">MCP Endpoint URL</label>
                  <input
                    name="supportMcpUrl"
                    defaultValue={customer.supportMcpUrl ?? ""}
                    className={`${controlPlaneInputClass} w-full`}
                  />
                </div>
                <div>
                  <label className="text-[10px] font-bold text-muted uppercase tracking-wider block mb-1.5">Support Secret Token</label>
                  <input
                    name="supportCredential"
                    type="password"
                    placeholder="Enter new credential token to rotate"
                    className={`${controlPlaneInputClass} w-full`}
                  />
                </div>
                <div>
                  <label className="text-[10px] font-bold text-muted uppercase tracking-wider block mb-1.5">Credential Label</label>
                  <input
                    name="supportCredentialLabel"
                    defaultValue={customer.supportCredentialLabel ?? ""}
                    placeholder="e.g. Production primary"
                    className={`${controlPlaneInputClass} w-full`}
                  />
                </div>
                <button
                  type="submit"
                  className={`${detailPrimaryButtonClass} w-full`}
                >
                  Save settings
                </button>
              </form>
            </div>
          </div>
        )}

        {/* TOOLS & INTEGRATIONS TAB */}
        {activeTab === "tools" && (
          <div className="grid grid-cols-1 gap-5 lg:grid-cols-3">
            <div className="space-y-6 lg:col-span-2">
              <div className={`${detailPanelClass} space-y-4`}>
                <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
                  <div>
                    <h3 className="text-sm font-semibold text-white">Managed Connector Setup</h3>
                    <p className="mt-0.5 text-[10px] text-muted">Installable customer tools, OAuth accounts, data sources, and managed workspace state.</p>
                  </div>
                  <StatusBadge status={customer.managedWorkspaceId ? "ready" : "requires_connector"}>
                    {customer.managedWorkspaceId ? "Managed workspace" : "Inspect only"}
                  </StatusBadge>
                </div>

                {integrations.error && <DisabledActionHint>{integrations.error}</DisabledActionHint>}

                <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
                  {availableConnectors.map((connector: any) => (
                    <div key={connector.key} className={detailInnerPanelClass}>
                      <div className="flex items-start justify-between gap-3">
                        <div>
                          <strong className="block text-xs font-semibold text-white">{connector.label}</strong>
                          <span className="mt-0.5 block text-[10px] text-muted">
                            {connector.kind === "communication"
                              ? "Public-channel workspace connection"
                              : connector.kind === "oauth"
                                ? "Human-owned provider consent"
                                : "Workspace-scoped data feeds"}
                          </span>
                        </div>
                        <StatusBadge status={connector.configured ? "connected" : "not_configured"}>
                          {connector.configured ? "Connected" : "Not set"}
                        </StatusBadge>
                      </div>
                      {connector.key === "slack" && (
                        <div className="mt-3 border-t border-line/60 pt-3">
                          {connector.canManageFromControlPlane ? (
                            <a
                              href={`/api/control-plane/deployments/${customer.id}/integrations/slack/install`}
                              className={controlPlaneButtonClass}
                            >
                              {connector.configured ? "Reconnect Slack" : "Connect Slack"}
                            </a>
                          ) : (
                            <DisabledActionHint>
                              {customer.managedWorkspaceId ? "Slack OAuth is not configured in this environment." : "A managed workspace is required before Control Plane can connect Slack."}
                            </DisabledActionHint>
                          )}
                        </div>
                      )}
                      {connector.requiresHumanConsent && connector.key !== "slack" && (
                        <p className="mt-3 border-t border-line/60 pt-3 text-[10px] text-muted">
                          Provider consent must be completed by a human account with the required tenant permissions.
                        </p>
                      )}
                    </div>
                  ))}
                  {availableConnectors.length === 0 && (
                    <p className="text-[11px] text-muted">No connector definitions are available for this deployment.</p>
                  )}
                </div>
              </div>

              <div className={`${detailPanelClass} space-y-4`}>
                <h3 className="text-sm font-semibold text-white">Current Integration State</h3>
                <div className="overflow-x-auto">
                  <table className="w-full border-collapse text-xs">
                    <thead>
                      <tr className="border-b border-line text-left font-medium text-muted">
                        <th className="p-3">Integration</th>
                        <th className="p-3">Status</th>
                        <th className="p-3">Account or Team</th>
                        <th className="p-3">Last Activity</th>
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-line">
                      {integrationRows.map((integration: any) => (
                        <tr key={integration.key} className="hover:bg-surface/40">
                          <td className="p-3">
                            <strong className="block text-xs text-white">{integration.label}</strong>
                            <span className="mt-0.5 block text-[10px] text-muted">{integration.key}</span>
                          </td>
                          <td className="p-3">
                            <StatusBadge status={integration.status ?? (integration.configured ? "active" : "not_configured")}>
                              {controlPlaneLabel(integration.status ?? (integration.configured ? "active" : "not configured"))}
                            </StatusBadge>
                          </td>
                          <td className="p-3 text-muted">
                            {integration.team ?? integration.account ?? integration.driverType ?? integration.provider ?? "n/a"}
                          </td>
                          <td className="p-3 text-muted">
                            {integration.lastEventAt || integration.lastSyncAt
                              ? new Date(integration.lastEventAt ?? integration.lastSyncAt).toLocaleString()
                              : integration.lastError ?? "No activity"}
                          </td>
                        </tr>
                      ))}
                      {integrationRows.length === 0 && (
                        <tr>
                          <td colSpan={4} className="py-6 text-center text-muted">No integrations are configured for this deployment.</td>
                        </tr>
                      )}
                    </tbody>
                  </table>
                </div>
              </div>
            </div>

            <div className={`${detailPanelClass} h-fit space-y-5`}>
              <div>
                <h3 className="text-sm font-semibold text-white">Slack Administration</h3>
                <p className="mt-0.5 text-[10px] text-muted">Audited settings for public-channel Slack ingestion and agenda posting.</p>
              </div>

              {slackIntegration ? (
                <div className="space-y-4 text-xs">
                  <div className={detailInnerPanelClass}>
                    <div className="flex items-start justify-between gap-3">
                      <div>
                        <strong className="block text-xs text-white">{slackIntegration.team ?? slackIntegration.externalWorkspaceId ?? "Slack workspace"}</strong>
                        <span className="mt-0.5 block text-[10px] text-muted">
                          Public channels only. Private channels and DMs stay out of ingestion.
                        </span>
                      </div>
                      <StatusBadge status={slackIntegration.status}>{controlPlaneLabel(slackIntegration.status)}</StatusBadge>
                    </div>
                    <p className="mt-3 text-[10px] text-muted">
                      Scopes: {Array.isArray(slackIntegration.scopes) && slackIntegration.scopes.length > 0 ? slackIntegration.scopes.join(", ") : "none recorded"}
                    </p>
                  </div>

                  <form action={updateControlPlaneSlackAgendaSettingsAction} className="space-y-3">
                    <input type="hidden" name="deploymentId" value={customer.id} />
                    <input type="hidden" name="installationId" value={slackIntegration.installationId ?? String(slackIntegration.key).replace("communication_", "")} />
                    <label className="space-y-1 block">
                      <span className="block text-[9px] font-bold uppercase tracking-wider text-muted">Default agenda channel ID</span>
                      <input
                        name="defaultAgendaChannelId"
                        defaultValue={typeof slackSettings.defaultAgendaChannelId === "string" ? slackSettings.defaultAgendaChannelId : ""}
                        placeholder="C0123456789"
                        className={`${controlPlaneInputClass} w-full`}
                      />
                    </label>
                    <label className="space-y-1 block">
                      <span className="block text-[9px] font-bold uppercase tracking-wider text-muted">Agenda timezone</span>
                      <input
                        name="agendaTimezone"
                        defaultValue={typeof slackSettings.agendaTimezone === "string" ? slackSettings.agendaTimezone : "UTC"}
                        placeholder="UTC"
                        className={`${controlPlaneInputClass} w-full`}
                      />
                    </label>
                    <input name="reason" required placeholder="Audit reason" className={`${controlPlaneInputClass} w-full`} />
                    <button type="submit" className={`${detailPrimaryButtonClass} w-full`}>
                      Save Slack settings
                    </button>
                  </form>

                  <form action={disconnectControlPlaneSlackInstallationAction} className="space-y-3 border-t border-line pt-4">
                    <input type="hidden" name="deploymentId" value={customer.id} />
                    <input type="hidden" name="installationId" value={slackIntegration.installationId ?? String(slackIntegration.key).replace("communication_", "")} />
                    <input name="reason" required placeholder="Disconnect reason" className={`${controlPlaneInputClass} w-full`} />
                    <button type="submit" className={`${detailDangerButtonClass} w-full`}>
                      Disconnect Slack
                    </button>
                  </form>
                </div>
              ) : slackConnector?.canManageFromControlPlane ? (
                <a href={`/api/control-plane/deployments/${customer.id}/integrations/slack/install`} className={`${detailPrimaryButtonClass} w-full`}>
                  Connect Slack
                </a>
              ) : (
                <DisabledActionHint>
                  {customer.managedWorkspaceId ? "Slack OAuth is not configured in this environment." : "Slack administration requires a managed workspace."}
                </DisabledActionHint>
              )}
            </div>
          </div>
        )}

        {/* USERS & ACCESS TAB */}
        {activeTab === "users" && (
          <div className="grid grid-cols-1 gap-5 lg:grid-cols-3">
            <div className={`${detailPanelClass} space-y-4 lg:col-span-2`}>
              <h3 className="text-sm font-semibold text-white">Customer Workspace Members</h3>
              
              <div className="overflow-x-auto">
                <table className="w-full border-collapse text-xs">
                  <thead>
                    <tr className="border-b border-line text-muted text-left font-medium">
                      <th className="p-3">Member</th>
                      <th className="p-3">Role</th>
                      <th className="p-3">Status</th>
                      <th className="p-3 text-right">Access Link Operations</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-line">
                    {members.members.map((member: any) => {
                      const displayName = typeof member.displayName === "string" ? member.displayName.trim() : "";
                      const email = typeof member.email === "string" ? member.email.trim() : "";
                      const canRunMemberAction = Boolean(email);
                      const statusAction = member.isActive ? "Deactivate" : "Activate";

                      return (
                        <tr key={member.id} className="hover:bg-surface/40">
                          <td className="p-3">
                            <strong className="text-white text-xs block">{displayName || email || "Member identity unavailable"}</strong>
                            <span className={cn("text-[10px] block mt-0.5", email ? "text-muted" : "text-amber-400")}>
                              {email || `Email unavailable for ${String(member.id).slice(0, 8)}`}
                            </span>
                          </td>
                          <td className="p-3 text-text font-semibold">{member.role}</td>
                          <td className="p-3">
                            <StatusBadge status={member.isActive ? "active" : "disabled"}>{member.isActive ? "Active" : "Inactive"}</StatusBadge>
                          </td>
                          <td className="p-3 text-right">
                            {canRunMemberAction ? (
                              <div className="flex flex-col items-end gap-2">
                                <form action={resendControlPlaneAccessLinkAction} className="flex flex-wrap justify-end gap-2">
                                  <input type="hidden" name="deploymentId" value={customer.id} />
                                  <input type="hidden" name="memberId" value={member.id} />
                                  <input
                                    name="reason"
                                    required
                                    aria-label={`Reason to resend access link for ${displayName || email}`}
                                    placeholder="Reason to resend link"
                                    className={`${controlPlaneInputClass} min-w-44`}
                                  />
                                  <button type="submit" className={controlPlaneButtonClass}>
                                    Resend Link
                                  </button>
                                </form>
                                <form action={updateControlPlaneMemberStatusAction} className="flex flex-wrap justify-end gap-2">
                                  <input type="hidden" name="deploymentId" value={customer.id} />
                                  <input type="hidden" name="memberId" value={member.id} />
                                  <input type="hidden" name="isActive" value={member.isActive ? "false" : "true"} />
                                  <input
                                    name="reason"
                                    required
                                    aria-label={`Reason to ${statusAction.toLowerCase()} ${displayName || email}`}
                                    placeholder={`Reason to ${statusAction.toLowerCase()}`}
                                    className={`${controlPlaneInputClass} min-w-44`}
                                  />
                                  <button type="submit" className={member.isActive ? detailDangerButtonClass : controlPlaneButtonClass}>
                                    {statusAction}
                                  </button>
                                </form>
                              </div>
                            ) : (
                              <DisabledActionHint>Email identity required</DisabledActionHint>
                            )}
                          </td>
                        </tr>
                      );
                    })}
                    {members.members.length === 0 && (
                      <tr>
                        <td colSpan={4} className="text-center py-6 text-muted">No members registered under this deployment.</td>
                      </tr>
                    )}
                  </tbody>
                </table>
              </div>
            </div>

            <div className={`${detailPanelClass} h-fit space-y-4`}>
              <div>
                <h3 className="text-sm font-semibold text-white">Add New Workspace Member</h3>
                <p className="text-[10px] text-muted mt-0.5">Invites human actor, emailing encrypted setup link.</p>
              </div>

              <form action={createControlPlaneMemberAction} className="space-y-4 text-xs">
                <input type="hidden" name="deploymentId" value={customer.id} />
                <div>
                  <label className="text-[10px] font-bold text-muted uppercase tracking-wider block mb-1.5">Display Name</label>
                  <input
                    name="displayName"
                    required
                    placeholder="e.g. Jane Doe"
                    className={`${controlPlaneInputClass} w-full`}
                  />
                </div>
                <div>
                  <label className="text-[10px] font-bold text-muted uppercase tracking-wider block mb-1.5">Email Address</label>
                  <input
                    name="email"
                    type="email"
                    required
                    placeholder="jane@company.com"
                    className={`${controlPlaneInputClass} w-full`}
                  />
                </div>
                <div>
                  <label className="text-[10px] font-bold text-muted uppercase tracking-wider block mb-1.5">Workspace Role</label>
                  <select
                    name="role"
                    defaultValue="CONTRIBUTOR"
                    className={`${controlPlaneInputClass} w-full`}
                  >
                    <option value="CONTRIBUTOR">Contributor</option>
                    <option value="FACILITATOR">Facilitator</option>
                    <option value="FINANCE_STEWARD">Finance steward</option>
                    <option value="ADMIN">Admin</option>
                  </select>
                </div>
                <div>
                  <label className="text-[10px] font-bold text-muted uppercase tracking-wider block mb-1.5">Audit Request Reason</label>
                  <input
                    name="reason"
                    required
                    placeholder="e.g. Add company billing manager"
                    className={`${controlPlaneInputClass} w-full`}
                  />
                </div>
                <button
                  type="submit"
                  className={`${detailPrimaryButtonClass} w-full`}
                >
                  Invite member
                </button>
              </form>
            </div>
          </div>
        )}

        {/* RECORDERS TAB */}
        {activeTab === "recorders" && (
          <div className="grid grid-cols-1 gap-5 lg:grid-cols-3">
            <div className="space-y-6 lg:col-span-2">
              <div className={`${detailPanelClass} space-y-4`}>
                <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
                  <div>
                    <h3 className="text-sm font-semibold text-white">Meeting Recorder Readiness</h3>
                    <p className="mt-0.5 text-[10px] text-muted">Loaded only when this customer recorder tab is opened.</p>
                  </div>
                  <StatusBadge status={recorderIntegration?.vendorReadiness ? "ready" : recorderIntegration?.status ?? "not_configured"}>
                    {recorderIntegration?.vendorReadiness ? "Ready" : controlPlaneLabel(recorderIntegration?.status ?? "not_configured")}
                  </StatusBadge>
                </div>

                {integrations.error && <DisabledActionHint>{integrations.error}</DisabledActionHint>}

                <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 xl:grid-cols-3">
                  {[
                    { label: "Entitlement", value: recorderIntegration?.entitlementEnabled ? "Enabled" : "Disabled" },
                    { label: "Configuration", value: recorderIntegration?.configured ? "Configured" : "Not configured" },
                    { label: "Provider", value: recorderIntegration?.provider ?? "Not set" },
                    { label: "Fallback", value: recorderIntegration?.fallbackProvider ?? "None" },
                    { label: "Monthly cap", value: recorderIntegration?.monthlyMinuteCap ? `${recorderIntegration.monthlyMinuteCap} minutes` : "Not set" },
                    { label: "Usage", value: recorderIntegration?.usage?.minutesUsed !== undefined ? `${recorderIntegration.usage.minutesUsed} minutes` : "No usage recorded" },
                    { label: "Failures", value: recorderIntegration?.failures ?? 0 },
                    { label: "Auto record", value: recorderIntegration?.autoRecordEnabled ? "Enabled" : "Disabled" },
                    { label: "Calendar", value: recorderCalendarSource?.providerAccountEmail ?? recorderCalendarSource?.status ?? "Not connected" },
                  ].map((item) => (
                    <div key={item.label} className={detailInnerPanelClass}>
                      <span className="block text-[9px] font-bold uppercase tracking-wider text-muted">{item.label}</span>
                      <strong className="mt-1 block truncate text-xs text-white">{item.value}</strong>
                    </div>
                  ))}
                </div>

                <div className={detailInnerPanelClass}>
                  <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
                    <div>
                      <h4 className="text-xs font-semibold text-white">Readiness Checks</h4>
                      <p className="mt-0.5 text-[10px] text-muted">
                        {recorderReadiness?.detail ?? "Recorder readiness has not been recorded yet."}
                      </p>
                    </div>
                    <StatusBadge status={recorderReadiness?.ready ? "ready" : "needs_setup"}>
                      {recorderReadiness?.ready ? "Ready" : "Needs setup"}
                    </StatusBadge>
                  </div>
                  <div className="mt-3 space-y-2">
                    {recorderFailedChecks.map((check: any) => (
                      <div key={check.key ?? check.label} className="rounded-md border border-amber-500/20 bg-amber-500/10 p-2">
                        <strong className="block text-[10px] text-amber-200">{check.label ?? "Recorder check"}</strong>
                        <span className="mt-0.5 block text-[10px] text-amber-100/80">{check.detail ?? "Needs operator review."}</span>
                      </div>
                    ))}
                    {recorderFailedChecks.length === 0 && (
                      <p className="text-[10px] text-muted">No failed recorder readiness checks recorded.</p>
                    )}
                  </div>
                </div>

                <div className={detailInnerPanelClass}>
                  <h4 className="text-xs font-semibold text-white">Last Smoke Run</h4>
                  <div className="mt-2 grid grid-cols-1 gap-2 text-[10px] text-muted sm:grid-cols-3">
                    <span>Status: <strong className="text-text">{recorderLastSmokeRun?.status ?? "Not run"}</strong></span>
                    <span>Provider: <strong className="text-text">{recorderLastSmokeRun?.provider ?? recorderIntegration?.provider ?? "Not set"}</strong></span>
                    <span>Updated: <strong className="text-text">{recorderLastSmokeRun?.createdAt ? new Date(recorderLastSmokeRun.createdAt).toLocaleString() : "n/a"}</strong></span>
                  </div>
                </div>
              </div>
            </div>

            <div className={`${detailPanelClass} h-fit space-y-5`}>
              <div>
                <h3 className="text-sm font-semibold text-white">Recorder Configuration</h3>
                <p className="mt-0.5 text-[10px] text-muted">Changes are audited and require a managed workspace.</p>
              </div>

              <form action={configureMeetingRecorderIntegrationAction} className="space-y-3 text-xs">
                <input type="hidden" name="deploymentId" value={customer.id} />
                <div className="grid grid-cols-2 gap-2">
                  <label className="space-y-1">
                    <span className="block text-[9px] font-bold uppercase tracking-wider text-muted">Entitlement</span>
                    <select name="entitlementEnabled" defaultValue={String(Boolean(recorderIntegration?.entitlementEnabled))} className={`${controlPlaneInputClass} w-full`}>
                      <option value="true">Enabled</option>
                      <option value="false">Disabled</option>
                    </select>
                  </label>
                  <label className="space-y-1">
                    <span className="block text-[9px] font-bold uppercase tracking-wider text-muted">Recorder</span>
                    <select name="enabled" defaultValue={String(Boolean(recorderIntegration?.status === "enabled" || recorderIntegration?.configured))} className={`${controlPlaneInputClass} w-full`}>
                      <option value="true">Enabled</option>
                      <option value="false">Disabled</option>
                    </select>
                  </label>
                </div>
                <label className="space-y-1 block">
                  <span className="block text-[9px] font-bold uppercase tracking-wider text-muted">Auto record</span>
                  <select name="autoRecordEnabled" defaultValue={String(Boolean(recorderIntegration?.autoRecordEnabled))} className={`${controlPlaneInputClass} w-full`}>
                    <option value="false">Disabled</option>
                    <option value="true">Enabled</option>
                  </select>
                </label>
                <div className="grid grid-cols-2 gap-2">
                  <input name="defaultProvider" defaultValue={recorderIntegration?.provider ?? "RECALL_AI"} placeholder="Default provider" className={controlPlaneInputClass} />
                  <input name="fallbackProvider" defaultValue={recorderIntegration?.fallbackProvider ?? ""} placeholder="Fallback provider" className={controlPlaneInputClass} />
                </div>
                <input name="monthlyMinuteCap" type="number" min={0} defaultValue={recorderIntegration?.monthlyMinuteCap ?? 6000} className={`${controlPlaneInputClass} w-full`} />
                <input name="botName" defaultValue={recorderIntegration?.botName ?? ""} placeholder="Recorder bot name" className={`${controlPlaneInputClass} w-full`} />
                <input name="entryMessage" defaultValue={recorderIntegration?.entryMessage ?? ""} placeholder="Recorder entry message" className={`${controlPlaneInputClass} w-full`} />
                <input name="reason" required placeholder="Audit reason" className={`${controlPlaneInputClass} w-full`} />
                <button type="submit" disabled={!customer.managedWorkspaceId} className={`${detailPrimaryButtonClass} w-full`}>
                  Save recorder config
                </button>
              </form>

              <div className="border-t border-line pt-4">
                <h3 className="text-sm font-semibold text-white">Recorder Operations</h3>
                <form action={runMeetingRecorderOperationAction} className="mt-3 space-y-3 text-xs">
                  <input type="hidden" name="deploymentId" value={customer.id} />
                  <input type="hidden" name="joinAtTimezoneOffsetMinutes" value={timezoneOffsetMinutes} />
                  <select name="operation" defaultValue="enqueue_calendar_sync" className={`${controlPlaneInputClass} w-full`}>
                    <option value="enqueue_calendar_sync">Queue calendar sync</option>
                    <option value="dry_run_scan">Dry-run calendar scan</option>
                    <option value="live_smoke">Live smoke test</option>
                    <option value="enable_auto_recording_after_smoke">Enable auto-recording after smoke</option>
                  </select>
                  <input name="provider" defaultValue={recorderIntegration?.provider ?? "RECALL_AI"} placeholder="Provider" className={`${controlPlaneInputClass} w-full`} />
                  <input name="meetingUrl" placeholder="Meeting URL for live smoke" className={`${controlPlaneInputClass} w-full`} />
                  <input name="joinAt" type="datetime-local" className={`${controlPlaneInputClass} w-full`} />
                  <input name="reason" required placeholder="Audit reason" className={`${controlPlaneInputClass} w-full`} />
                  <button type="submit" disabled={!customer.managedWorkspaceId} className={`${detailPrimaryButtonClass} w-full`}>
                    Run recorder operation
                  </button>
                </form>
              </div>
            </div>
          </div>
        )}

        {/* RELEASES & DEPLOYMENT TAB */}
        {activeTab === "releases" && (
          <div className="grid grid-cols-1 gap-5 lg:grid-cols-3">
            <div className="lg:col-span-2 space-y-6">
              <div className={`${detailPanelClass} space-y-4`}>
                <div>
                  <h3 className="text-sm font-semibold text-white">Record Release Upgrade Intention</h3>
                  <p className="text-[10px] text-muted mt-0.5">Locks staged upgrade intents inside deployment logs (Does not execute deploy).</p>
                </div>

                <form action={runReleaseOperationAction} className="grid grid-cols-1 sm:grid-cols-2 md:grid-cols-4 gap-4 items-end">
                  <input type="hidden" name="deploymentId" value={customer.id} />
                  <input type="hidden" name="operation" value="prepare_upgrade" />
                  <div>
                    <label className="text-[10px] font-bold text-muted uppercase tracking-wider block mb-1.5">Target Image Tag</label>
                    <input
                      name="targetReleaseImageTag"
                      required
                      placeholder="e.g. main-abcd12"
                      className={`${controlPlaneInputClass} w-full`}
                    />
                  </div>
                  <div>
                    <label className="text-[10px] font-bold text-muted uppercase tracking-wider block mb-1.5">Target Version</label>
                    <input
                      name="targetReleaseVersion"
                      placeholder="e.g. v1.3.0"
                      className={`${controlPlaneInputClass} w-full`}
                    />
                  </div>
                  <div>
                    <label className="text-[10px] font-bold text-muted uppercase tracking-wider block mb-1.5">Audit Reason</label>
                    <input
                      name="reason"
                      required
                      placeholder="Operator intent detail"
                      className={`${controlPlaneInputClass} w-full`}
                    />
                  </div>
                  <button
                    type="submit"
                    className={`${controlPlaneButtonClass} w-full`}
                  >
                    Log upgrade intent
                  </button>
                </form>
              </div>

              <div className={`${detailPanelClass} space-y-4`}>
                <div>
                  <h3 className="text-sm font-semibold text-white">Release Verification Evidence</h3>
                  <p className="text-[10px] text-muted mt-0.5">Latest health, schema, customer-read probe, recorder, and workflow signals.</p>
                </div>

                <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
                  {[
                    {
                      label: "Intended release",
                      value: intendedRelease ?? "Not recorded",
                      status: releaseSnapshot?.status ?? "unknown",
                      detail: releaseSnapshot?.observedAt ? new Date(releaseSnapshot.observedAt).toLocaleString() : "n/a",
                    },
                    {
                      label: "Live release",
                      value: liveRelease?.imageTag ?? customer.releaseImageTag ?? customer.releaseVersion ?? "Unknown",
                      status: customer.lastHealthStatus ?? healthSnapshot?.status ?? "unknown",
                      detail: liveRelease?.gitSha ?? customer.releaseVersion ?? "No live SHA recorded",
                    },
                    {
                      label: "Schema readiness",
                      value: schemaStatus,
                      status: schemaStatus === "ready" ? "ready" : "attention",
                      detail: healthSnapshot?.error ?? "No schema error recorded",
                    },
                    {
                      label: "Post-deploy probe",
                      value: supportReadySnapshot?.status ?? "Not run",
                      status: supportReadySnapshot?.status ?? "unknown",
                      detail: supportReadySnapshot?.error ?? (supportReadySnapshot?.observedAt ? new Date(supportReadySnapshot.observedAt).toLocaleString() : "No probe snapshot"),
                    },
                    {
                      label: "Recorder readiness",
                      value: recorderIntegration?.vendorReadiness ? "Ready" : (integrationSnapshot?.status ?? recorderIntegration?.status ?? "Unknown"),
                      status: recorderIntegration?.vendorReadiness ? "ready" : (integrationSnapshot?.status ?? recorderIntegration?.status ?? "unknown"),
                      detail: recorderLastSmokeRun?.status ? `Smoke ${recorderLastSmokeRun.status}` : (integrationSnapshot?.error ?? "No smoke status recorded"),
                    },
                    {
                      label: "Release workflow",
                      value: latestRollout?.status ?? "Not recorded",
                      status: latestRollout?.status ?? "unknown",
                      detail: latestRollout?.createdAt ? new Date(latestRollout.createdAt).toLocaleString() : "No rollout row",
                    },
                    {
                      label: "Context probe",
                      value: contextSnapshot?.status ?? "Not run",
                      status: contextSnapshot?.status ?? "unknown",
                      detail: contextSnapshot?.error ?? (contextSnapshot?.observedAt ? new Date(contextSnapshot.observedAt).toLocaleString() : "No context snapshot"),
                    },
                  ].map((item) => (
                    <div key={item.label} className={detailInnerPanelClass}>
                      <div className="mb-2">
                        <StatusBadge status={item.status}>{controlPlaneLabel(String(item.status ?? "unknown"))}</StatusBadge>
                      </div>
                      <h4 className="text-xs font-semibold text-white">{item.label}</h4>
                      <strong className="mt-1 block truncate text-xs font-semibold text-white">{String(item.value)}</strong>
                      <p className="mt-0.5 truncate text-[10px] text-muted">{item.detail}</p>
                    </div>
                  ))}
                </div>
              </div>

              <div className={`${detailPanelClass} space-y-4`}>
                <h3 className="text-sm font-semibold text-white">Preflight Upgrade Deploy Checks</h3>

                <div className="space-y-2">
                  {preflightChecks.map((chk: any, i: number) => (
                    <div key={i} className={`${detailInnerPanelClass} flex items-start justify-between gap-3`}>
                      <div>
                        <h4 className="text-xs font-semibold text-white">{chk.label}</h4>
                        <p className="text-[10px] text-muted mt-0.5">{chk.detail}</p>
                      </div>
                      <StatusBadge status={chk.ok ? "passed" : "blocked"}>{chk.ok ? "pass" : "blocked"}</StatusBadge>
                    </div>
                  ))}
                </div>
              </div>
            </div>

            <div className={`${detailPanelClass} h-fit space-y-4`}>
              <div>
                <h3 className="text-sm font-semibold text-white">Execute Staged Release Rollout</h3>
                <p className="text-[10px] text-muted mt-0.5">Deploy the configured latest stable tag to this client.</p>
              </div>

              <form action={deployLatestControlPlaneReleaseAction} className="space-y-4">
                <input type="hidden" name="deploymentId" value={customer.id} />
                <div>
                  <label className="text-[10px] font-bold text-muted uppercase tracking-wider block mb-1.5">
                    Deploy Reason (Audited)
                  </label>
                  <input
                    name="reason"
                    required
                    placeholder="Customer approved production rollout"
                    className={`${controlPlaneInputClass} w-full`}
                  />
                </div>

                <button
                  type="submit"
                  disabled={!isPreflightPassed}
                  className={`${isPreflightPassed ? detailPrimaryButtonClass : controlPlaneButtonClass} w-full`}
                >
                  {isPreflightPassed ? "Deploy latest stable tag" : "Resolve preflight blocks"}
                </button>
              </form>
            </div>
          </div>
        )}

        {/* SUPPORT LOG & AUDIT TAB */}
        {activeTab === "logs" && (
          <div className="grid grid-cols-1 gap-5 lg:grid-cols-3">
            <div className={`${detailPanelClass} space-y-4 lg:col-span-2`}>
              <h3 className="text-sm font-semibold text-white">Deployment Operational Audit History</h3>
              {newspaperDeliveryAlert && (
                <NewspaperDeliveryAttentionBanner alert={newspaperDeliveryAlert} />
              )}

              <div className="space-y-3 max-h-[460px] overflow-y-auto pr-1 scrollbar-thin">
                {supportOperations.map((op: any) => {
                  const operationAlert = op?.action === "newspaper.diagnostics"
                    ? newspaperDeliveryAttentionAlertFromPayload(op.resultSummary)
                    : null;
                  return (
                    <div key={op.id} className={`${detailInnerPanelClass} space-y-2`}>
                      <div className="flex items-center justify-between">
                        <strong className="text-xs text-white font-semibold">{op.action}</strong>
                        <StatusBadge status={operationAlert ? "attention" : op.status}>
                          {operationAlert ? "Attention" : controlPlaneLabel(op.status)}
                        </StatusBadge>
                      </div>
                      <p className="text-[10px] text-muted">{op.reason}</p>
                      {operationAlert && (
                        <p className="rounded border border-amber-500/25 bg-amber-500/10 px-2 py-1 text-[10px] text-amber-100">
                          Newspaper delivery attention for run {optionalTextValue(operationAlert.latestRunKey) ?? "unknown"}:
                          {" "}
                          {latestNewspaperDeliveryAlertError(operationAlert)?.slice(0, 180) ?? "provider/runtime issue detected"}
                        </p>
                      )}
                      <div className="text-[9px] text-muted">
                        <span>Recorded: {new Date(op.createdAt).toLocaleString()}</span>
                        {op.error && <span className="text-rose-400 block mt-1 font-mono">{op.error}</span>}
                      </div>
                    </div>
                  );
                })}
                {supportOperations.length === 0 && (
                  <div className="text-center py-8 text-muted text-[10px]">No support operations recorded.</div>
                )}
              </div>
            </div>

            <div className={`${detailPanelClass} h-fit space-y-4`}>
              <div>
                <h3 className="text-sm font-semibold text-white">Log Break-Glass Incident</h3>
                <p className="text-[10px] text-muted mt-0.5">Audits emergency mutations performed directly.</p>
              </div>

              <form action={recordBreakGlassAction} className="space-y-4 text-xs">
                <input type="hidden" name="deploymentId" value={customer.id} />
                <div>
                  <label className="text-[10px] font-bold text-muted uppercase tracking-wider block mb-1.5">Razón / Incident Title</label>
                  <input
                    name="reason"
                    required
                    placeholder="e.g. Urgent database repair"
                    className={`${controlPlaneInputClass} w-full`}
                  />
                </div>
                <div>
                  <label className="text-[10px] font-bold text-muted uppercase tracking-wider block mb-1.5">Audit Narrative Description</label>
                  <textarea
                    name="notes"
                    required
                    rows={4}
                    placeholder="Provide a full explanation of why emergency direct access was utilized and exactly what tables or nodes were updated. Avoid pasting raw secrets."
                    className={`${controlPlaneInputClass} min-h-24 w-full`}
                  />
                </div>
                <button
                  type="submit"
                  className={`${controlPlaneButtonClass} w-full border-amber-500/30 text-amber-300`}
                >
                  Log incident
                </button>
              </form>
            </div>
          </div>
        )}

      </div>

    </div>
  );
}
