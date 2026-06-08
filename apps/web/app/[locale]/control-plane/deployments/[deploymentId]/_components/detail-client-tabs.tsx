"use client";

import { useEffect, useState } from "react";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { useTranslations } from "next-intl";
import { cn } from "@/lib/utils";
import {
  DisabledActionHint,
  StatusBadge,
  controlPlaneButtonClass,
  controlPlaneInputClass,
  controlPlaneLabel,
} from "../../../_components/control-plane-ui";
import {
  configureSupportConnectorAction,
  runSupportOperationAction,
  recordBreakGlassAction,
  createControlPlaneMemberAction,
  resendControlPlaneAccessLinkAction,
  updateControlPlaneMemberStatusAction,
  setControlPlaneFeatureFlagAction,
  updateControlPlaneModelBudgetAction,
  updateControlPlaneAgentPolicyAction,
  revokeControlPlaneAgentCredentialAction,
  updateControlPlaneAgentCredentialScopesAction,
  deployLatestControlPlaneReleaseAction,
  runReleaseOperationAction,
  installEnterpriseAppFromControlPlaneAction,
  updateEnterpriseAppFromControlPlaneAction,
  setEnterpriseAppSurfaceFromControlPlaneAction,
  probeEnterpriseAppHealthFromControlPlaneAction,
  revokeEnterpriseAppSessionsFromControlPlaneAction,
} from "../../../actions";

type DetailTabId = "overview" | "agents" | "config" | "users" | "releases" | "logs";

const detailPanelClass = "rounded-lg border border-line bg-bg-alt p-4";
const detailInnerPanelClass = "rounded-md border border-line bg-surface p-3";
const detailDangerButtonClass =
  "inline-flex min-h-8 items-center justify-center rounded-md border border-rose-500/30 bg-rose-950/10 px-3 py-1.5 text-xs font-semibold text-rose-400 transition-colors hover:bg-rose-950/20 disabled:cursor-not-allowed disabled:opacity-50";
const detailPrimaryButtonClass = controlPlaneButtonClass;

interface TabProps {
  customer: any;
  integrations: any;
  context: any;
  aiGovernance: any;
  releases: any;
  members: { members: any[] };
  featureFlags: { flags: any[] };
  enterpriseApps: { canManage?: boolean; installations: any[]; error?: string | null };
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
  deployPreflight,
  rollouts,
  locale,
  initialTab,
}: TabProps) {
  const t = useTranslations("controlPlane");
  const router = useRouter();
  const pathname = usePathname() || "";
  const searchParams = useSearchParams();
  const [activeTab, setActiveTab] = useState<DetailTabId>(initialTab);

  // Local state for interactive details
  const [selectedAction, setSelectedAction] = useState("members.list");

  const tabs = [
    { id: "overview", label: "Overview" },
    { id: "agents", label: "Agents & Governance" },
    { id: "config", label: "Configuration & Flags" },
    { id: "users", label: "Users & Access" },
    { id: "releases", label: "Releases & Matrix" },
    { id: "logs", label: "Support & Audit" },
  ] as const;

  useEffect(() => {
    setActiveTab(initialTab);
  }, [initialTab]);

  const selectTab = (tabId: DetailTabId) => {
    setActiveTab(tabId);
    const params = new URLSearchParams(searchParams?.toString() ?? "");
    params.set("tab", tabId);
    router.replace(`${pathname}?${params.toString()}`, { scroll: false });
  };

  const isPreflightPassed = Boolean(deployPreflight.eligible);
  const preflightChecks = Array.isArray(deployPreflight.checks)
    ? deployPreflight.checks
    : [];
  const canManageEnterpriseApps = Boolean(enterpriseApps.canManage && customer.managedWorkspaceId);

  return (
    <div className="space-y-6">
      
      <div className="flex overflow-x-auto border-b border-line scrollbar-none">
        {tabs.map((tab) => {
          const isActive = activeTab === tab.id;
          return (
            <button
              key={tab.id}
              onClick={() => selectTab(tab.id)}
              className={cn(
                "!min-h-0 !rounded-none !border-x-0 !border-t-0 !bg-transparent !shadow-none border-b-2 px-4 py-2.5 text-xs font-semibold transition-colors whitespace-nowrap",
                isActive
                  ? "border-brand-500 text-white"
                  : "border-transparent text-muted hover:!bg-surface/30 hover:text-text"
              )}
            >
              {tab.label}
            </button>
          );
        })}
      </div>

      {/* Tab Panels */}
      <div className="space-y-6">
        
        {/* OVERVIEW TAB */}
        {activeTab === "overview" && (
          <div className="grid grid-cols-1 gap-5 lg:grid-cols-3">
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
                  <form action={installEnterpriseAppFromControlPlaneAction} className={`${detailInnerPanelClass} grid grid-cols-1 gap-3 lg:grid-cols-5`}>
                    <input type="hidden" name="deploymentId" value={customer.id} />
                    <input type="hidden" name="workspaceId" value={customer.managedWorkspaceId} />
                    <input type="hidden" name="appKey" value="practice-ledger" />
                    <input type="hidden" name="runtimeMode" value="SELF_MANAGED_EXTERNAL" />
                    <input type="hidden" name="surface" value="FINANCE" />
                    <input name="runtimeBaseUrl" placeholder="Runtime URL" className={controlPlaneInputClass} />
                    <input name="tenantExternalId" placeholder="Tenant / org id" className={controlPlaneInputClass} />
                    <input name="launchPath" placeholder="/dashboard?embedded=1" className={controlPlaneInputClass} />
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

              <div className="space-y-3 max-h-[460px] overflow-y-auto pr-1 scrollbar-thin">
                {customer.supportOperations.map((op: any) => (
                  <div key={op.id} className={`${detailInnerPanelClass} space-y-2`}>
                    <div className="flex items-center justify-between">
                      <strong className="text-xs text-white font-semibold">{op.action}</strong>
                      <StatusBadge status={op.status}>{controlPlaneLabel(op.status)}</StatusBadge>
                    </div>
                    <p className="text-[10px] text-muted">{op.reason}</p>
                    <div className="text-[9px] text-muted">
                      <span>Recorded: {new Date(op.createdAt).toLocaleString()}</span>
                      {op.error && <span className="text-rose-400 block mt-1 font-mono">{op.error}</span>}
                    </div>
                  </div>
                ))}
                {customer.supportOperations.length === 0 && (
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
