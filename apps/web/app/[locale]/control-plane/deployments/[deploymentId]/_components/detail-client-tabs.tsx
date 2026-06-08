"use client";

import { useEffect, useState } from "react";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { useTranslations } from "next-intl";
import {
  Activity,
  Bot,
  Settings,
  Users as UsersIcon,
  GitBranch,
  ShieldCheck,
  CheckCircle,
  AlertTriangle,
  Lock,
  Cpu,
  RefreshCw,
  Sliders,
  DollarSign,
  Briefcase,
  ExternalLink,
} from "lucide-react";
import { cn } from "@/lib/utils";
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
} from "../../../actions";

type DetailTabId = "overview" | "agents" | "config" | "users" | "releases" | "logs";

interface TabProps {
  customer: any;
  integrations: any;
  context: any;
  aiGovernance: any;
  releases: any;
  members: { members: any[] };
  featureFlags: { flags: any[] };
  enterpriseApps: { installations: any[]; error?: string | null };
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
    { id: "overview", label: "Overview", icon: Activity },
    { id: "agents", label: "Agents & Governance", icon: Bot },
    { id: "config", label: "Configuration & Flags", icon: Settings },
    { id: "users", label: "Users & Access", icon: UsersIcon },
    { id: "releases", label: "Releases & Matrix", icon: GitBranch },
    { id: "logs", label: "Support & Audit", icon: ShieldCheck },
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

  const tone = (status?: string | null) => {
    if (status === "ready" || status === "COMPLETED" || status === "ok" || status === "connected" || status === "active" || status === "enabled") return "text-emerald-400 border-emerald-500/20 bg-emerald-500/10";
    if (status === "attention" || status === "RUNNING" || status === "configured" || status === "pending") return "text-amber-400 border-amber-500/20 bg-amber-500/10";
    return "text-rose-400 border-rose-500/20 bg-rose-500/10";
  };

  const isPreflightPassed = Boolean(deployPreflight.eligible);
  const preflightChecks = Array.isArray(deployPreflight.checks)
    ? deployPreflight.checks
    : [];

  return (
    <div className="space-y-6">
      
      {/* Dynamic Tab Bar */}
      <div className="flex border-b border-line overflow-x-auto scrollbar-none">
        {tabs.map((tab) => {
          const Icon = tab.icon;
          const isActive = activeTab === tab.id;
          return (
            <button
              key={tab.id}
              onClick={() => selectTab(tab.id)}
              className={cn(
                "flex items-center gap-2 px-6 py-3 border-b-2 font-medium text-xs tracking-wide transition-all whitespace-nowrap",
                isActive
                  ? "border-brand-500 text-white bg-brand-500/5 font-semibold"
                  : "border-transparent text-muted hover:text-text hover:bg-surface/40"
              )}
            >
              <Icon className="w-4 h-4" />
              {tab.label}
            </button>
          );
        })}
      </div>

      {/* Tab Panels */}
      <div className="space-y-6">
        
        {/* OVERVIEW TAB */}
        {activeTab === "overview" && (
          <div className="grid grid-cols-1 lg:grid-cols-3 gap-6 animate-in fade-in duration-200">
            {/* Main Stats Left */}
            <div className="lg:col-span-2 space-y-6">
              {/* Telemetry Metrics Row */}
              <div className="grid grid-cols-2 gap-4">
                <div className="bg-bg-alt border border-line rounded-xl p-4 space-y-1">
                  <span className="text-[10px] text-muted font-semibold uppercase">Runtime Health</span>
                  <strong className={cn("text-lg font-bold block capitalize", tone(customer.lastHealthStatus || customer.provisioningStatus))}>
                    {customer.lastHealthStatus || customer.provisioningStatus || "unknown"}
                  </strong>
                  <span className="text-[10px] text-muted block truncate">{customer.lastHealthError || "No errors recorded"}</span>
                </div>
                <div className="bg-bg-alt border border-line rounded-xl p-4 space-y-1">
                  <span className="text-[10px] text-muted font-semibold uppercase">Active Release</span>
                  <strong className="text-lg font-bold text-white block">
                    {customer.releaseImageTag || customer.releaseVersion || "Unknown"}
                  </strong>
                  <span className="text-[10px] text-muted block">Rollout aligned</span>
                </div>
              </div>

              {/* Health Readiness Checklist */}
              <div className="bg-bg-alt border border-line rounded-xl p-5 space-y-4">
                <h3 className="text-sm font-bold text-white flex items-center gap-2">
                  <ShieldCheck className="w-4.5 h-4.5 text-brand-400" />
                  Health & Deployment Readiness Checks
                </h3>
                <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                  {[
                    { label: "Customer Deployment Record", ok: !!customer.url, desc: customer.url || "Missing URL" },
                    { label: "Managed Workspace Link", ok: !!customer.managedWorkspace, desc: customer.managedWorkspace ? `${customer.managedWorkspace.name} / ${customer.managedWorkspace.slug}` : "Remote only" },
                    { label: "Deployment Residency Policy", ok: !!customer.region && !!customer.dataResidency, desc: [customer.region, customer.dataResidency].filter(Boolean).join(" / ") || "Not set" },
                    { label: "Runtime Telemetry Probes", ok: customer.lastHealthStatus === "ok", desc: customer.lastHealthStatus || "No telemetry logged" },
                  ].map((check, idx) => (
                    <div key={idx} className="bg-surface border border-line rounded-xl p-3 flex items-start gap-3">
                      {check.ok ? (
                        <CheckCircle className="w-4 h-4 text-emerald-400 shrink-0 mt-0.5" />
                      ) : (
                        <AlertTriangle className="w-4 h-4 text-amber-400 shrink-0 mt-0.5" />
                      )}
                      <div>
                        <h4 className="text-xs font-semibold text-white">{check.label}</h4>
                        <p className="text-[10px] text-muted mt-0.5">{check.desc}</p>
                      </div>
                    </div>
                  ))}
                </div>
              </div>
            </div>

            {/* Quick Actions Panel Right */}
            <div className="bg-bg-alt border border-line rounded-xl p-5 shadow-sm space-y-4 h-fit">
              <div>
                <h3 className="text-sm font-bold text-white flex items-center gap-1.5">
                  <Sliders className="w-4 h-4 text-brand-400" />
                  Quick Telemetry Actions
                </h3>
                <p className="text-[10px] text-muted mt-0.5">Run reasoned support operations directly.</p>
              </div>

              {/* Support Snapshot Form */}
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
                    className="bg-surface border border-line text-xs text-text rounded-lg px-2.5 py-2 w-full focus:border-line focus:outline-none"
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
                    className="bg-surface border border-line text-xs text-text placeholder-slate-600 rounded-lg px-2.5 py-2 w-full focus:border-line focus:outline-none"
                  />
                  <input type="hidden" name="argumentsJson" value="{}" />
                </div>
                <button
                  type="submit"
                  className="bg-brand-600 hover:bg-brand-500 text-white font-semibold text-xs px-4 py-2.5 rounded-lg shadow-md w-full transition-colors"
                >
                  Execute support action
                </button>
              </form>
            </div>
          </div>
        )}

        {/* AGENTS TAB (GOVERNANCE) */}
        {activeTab === "agents" && (
          <div className="grid grid-cols-1 lg:grid-cols-3 gap-6 animate-in fade-in duration-200">
            {/* Top overview metrics column 2 */}
            <div className="lg:col-span-2 space-y-6">
              {/* Telemetry budgets cards */}
              <div className="bg-bg-alt border border-line rounded-xl p-5 space-y-4">
                <div className="flex items-center justify-between">
                  <div>
                    <h3 className="text-sm font-bold text-white flex items-center gap-1.5">
                      <DollarSign className="w-4 h-4 text-brand-400" />
                      Model Budget Limits
                    </h3>
                    <p className="text-[10px] text-muted mt-0.5">Control monthly cap limits and alert thresholds.</p>
                  </div>
                  <span className="px-2 py-0.5 rounded bg-brand-500/10 border border-brand-500/20 text-[9px] font-bold text-brand-400">
                    Spend active
                  </span>
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
                      className="bg-surface border border-line text-xs text-text rounded-lg px-2.5 py-1.5 w-full focus:outline-none"
                      required
                    />
                  </div>
                  <div>
                    <label className="text-[10px] font-bold text-muted uppercase tracking-wider block mb-1.5">Alert Threshold (%)</label>
                    <input
                      name="alertThresholdPct"
                      type="number"
                      defaultValue={aiGovernance.spend.budget?.alertThresholdPct ?? 80}
                      className="bg-surface border border-line text-xs text-text rounded-lg px-2.5 py-1.5 w-full focus:outline-none"
                    />
                  </div>
                  <div>
                    <label className="text-[10px] font-bold text-muted uppercase tracking-wider block mb-1.5">Reason</label>
                    <input
                      name="reason"
                      required
                      placeholder="Budget policy change"
                      className="bg-surface border border-line text-xs text-text placeholder-slate-600 rounded-lg px-2.5 py-1.5 w-full focus:outline-none"
                    />
                  </div>
                  <button
                    type="submit"
                    className="bg-surface-strong hover:bg-surface border border-line text-text text-xs py-1.5 px-3 rounded-lg font-semibold transition-colors w-full h-8"
                  >
                    Save cap
                  </button>
                </form>
              </div>

              {/* Agent policy configurations */}
              <div className="bg-bg-alt border border-line rounded-xl p-5 space-y-4">
                <h3 className="text-sm font-bold text-white flex items-center gap-1.5">
                  <Bot className="w-4.5 h-4.5 text-brand-400" />
                  Fleet Agents & Constitutional Policies
                </h3>
                <div className="space-y-4 divide-y divide-line">
                  {aiGovernance.agents.configs.map((agent: any) => (
                    <div key={agent.agentKey} className="pt-4 first:pt-0 space-y-3">
                      <div className="flex items-center justify-between">
                        <div>
                          <strong className="text-white text-xs font-semibold">{agent.label}</strong>
                          <span className="text-[10px] text-muted block">{agent.agentKey} / {agent.category}</span>
                        </div>
                        <span className="px-2 py-0.5 rounded text-[9px] font-bold uppercase tracking-wider text-emerald-400 bg-emerald-500/10 border border-emerald-500/20">
                          {agent.enabled ? "enabled" : "disabled"}
                        </span>
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
                            className="bg-surface border border-line text-[10px] text-text rounded-lg px-2.5 py-1 w-full focus:outline-none"
                          />
                        </div>
                        <div>
                          <label className="text-[9px] font-bold text-muted uppercase tracking-wider block mb-1">Reason</label>
                          <input
                            name="reason"
                            required
                            placeholder="Reason for policy override"
                            className="bg-surface border border-line text-[10px] text-text placeholder-slate-600 rounded-lg px-2.5 py-1 w-full focus:outline-none"
                          />
                        </div>
                        <button
                          type="submit"
                          className="bg-surface hover:bg-surface border border-line text-[10px] text-text py-1 px-3 rounded-lg font-semibold transition-colors w-full h-7"
                        >
                          Override policy
                        </button>
                      </form>
                    </div>
                  ))}
                </div>
              </div>
            </div>

            {/* MCP Credentials Panel Right */}
            <div className="bg-bg-alt border border-line rounded-xl p-5 shadow-sm space-y-4 h-fit">
              <div>
                <h3 className="text-sm font-bold text-white flex items-center gap-1.5">
                  <Lock className="w-4 h-4 text-brand-400" />
                  MCP Access & Scopes
                </h3>
                <p className="text-[10px] text-muted mt-0.5">Least-privilege API credentials and write scopes.</p>
              </div>

              <div className="space-y-4">
                {aiGovernance.access.credentials.map((cred: any) => (
                  <div key={cred.id} className="p-3 bg-surface border border-line rounded-xl space-y-2">
                    <div className="flex items-center justify-between">
                      <strong className="text-xs text-white tracking-wide">{cred.label}</strong>
                      <span className={cn("text-[9px] font-bold uppercase px-1.5 py-0.5 rounded border", cred.isActive ? "text-emerald-400 border-emerald-500/25 bg-emerald-500/10" : "text-muted border-slate-500/25")}>
                        {cred.isActive ? "active" : "revoked"}
                      </span>
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
                            className="bg-bg-alt border border-line text-[9px] text-text rounded px-2 py-1 w-full focus:outline-none"
                          />
                          <button
                            type="submit"
                            className="bg-rose-950/20 hover:bg-rose-950/40 border border-rose-500/30 text-rose-400 text-[9px] font-bold px-2 py-1 rounded transition-colors shrink-0"
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
          <div className="grid grid-cols-1 lg:grid-cols-3 gap-6 animate-in fade-in duration-200">
            {/* Feature Flags Grid left */}
            <div className="lg:col-span-2 space-y-6">
              <div className="bg-bg-alt border border-line rounded-xl p-5 space-y-4">
                <div>
                  <h3 className="text-sm font-bold text-white flex items-center gap-1.5">
                    <Briefcase className="w-4 h-4 text-brand-400" />
                    Enterprise Apps
                  </h3>
                  <p className="text-[10px] text-muted mt-0.5">Installed customer apps, runtime posture, and workspace surface assignments.</p>
                </div>

                {enterpriseApps.error && (
                  <div className="rounded-lg border border-amber-500/25 bg-amber-500/10 px-3 py-2 text-[11px] text-amber-300">
                    {enterpriseApps.error}
                  </div>
                )}

                <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                  {enterpriseApps.installations.map((installation: any) => {
                    const runtime = installation.runtime;
                    const surfaces = Array.isArray(installation.surfaces) ? installation.surfaces.filter((surface: any) => surface.enabled) : [];
                    const statusStyle = installation.status === "INSTALLED"
                      ? "text-emerald-400 border-emerald-500/20 bg-emerald-500/10"
                      : installation.status === "UNHEALTHY" || installation.status === "DISABLED"
                        ? "text-rose-400 border-rose-500/20 bg-rose-500/10"
                        : "text-amber-400 border-amber-500/20 bg-amber-500/10";
                    return (
                      <div key={installation.id} className="bg-surface border border-line rounded-xl p-4 space-y-3">
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
                          <a href={runtime.baseUrl} target="_blank" rel="noreferrer" className="inline-flex items-center gap-1 text-[10px] text-brand-400 hover:underline">
                            <ExternalLink className="w-3 h-3" />
                            Open runtime
                          </a>
                        )}
                      </div>
                    );
                  })}
                </div>

                {enterpriseApps.installations.length === 0 && !enterpriseApps.error && (
                  <p className="text-[11px] text-muted">No enterprise apps are installed for this customer workspace.</p>
                )}
              </div>

              <div className="bg-bg-alt border border-line rounded-xl p-5 space-y-4">
                <div>
                  <h3 className="text-sm font-bold text-white flex items-center gap-1.5">
                    <Sliders className="w-4 h-4 text-brand-400" />
                    Audited Feature Flags
                  </h3>
                  <p className="text-[10px] text-muted mt-0.5">Toggle customer feature flags with audited operations trail.</p>
                </div>

                <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                  {featureFlags.flags.map((flag: any) => (
                    <form
                      key={flag.flag}
                      action={setControlPlaneFeatureFlagAction}
                      className="bg-surface border border-line rounded-xl p-4 space-y-3 flex flex-col justify-between"
                    >
                      <input type="hidden" name="deploymentId" value={customer.id} />
                      <input type="hidden" name="flag" value={flag.flag} />
                      <input type="hidden" name="enabled" value={flag.enabled ? "false" : "true"} />
                      
                      <div className="space-y-1">
                        <div className="flex items-center justify-between">
                          <strong className="text-xs text-white">{flag.label}</strong>
                          <span className={cn("text-[9px] font-bold px-1.5 py-0.5 rounded border capitalize", flag.enabled ? "text-emerald-400 border-emerald-500/20 bg-emerald-500/10" : "text-muted border-slate-500/20 bg-slate-500/5")}>
                            {flag.enabled ? "Enabled" : "Disabled"}
                          </span>
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
                            className="bg-bg-alt border border-line text-[10px] text-text rounded-lg px-2 py-1 w-full focus:outline-none placeholder-slate-600"
                          />
                          <button
                            type="submit"
                            className={cn(
                              "text-[10px] font-bold px-3 py-1 rounded-lg border transition-colors shrink-0",
                              flag.enabled 
                                ? "bg-rose-950/20 border-rose-500/30 text-rose-400 hover:bg-rose-950/40" 
                                : "bg-emerald-950/20 border-emerald-500/30 text-emerald-400 hover:bg-emerald-950/40"
                            )}
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

            {/* Support Connector Settings Right */}
            <div className="bg-bg-alt border border-line rounded-xl p-5 shadow-sm space-y-4 h-fit">
              <div>
                <h3 className="text-sm font-bold text-white flex items-center gap-1.5">
                  <Lock className="w-4 h-4 text-brand-400" />
                  Support Connector Settings
                </h3>
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
                    className="bg-surface border border-line text-xs text-text rounded-lg px-2.5 py-1.5 w-full focus:outline-none"
                  />
                </div>
                <div>
                  <label className="text-[10px] font-bold text-muted uppercase tracking-wider block mb-1.5">MCP Endpoint URL</label>
                  <input
                    name="supportMcpUrl"
                    defaultValue={customer.supportMcpUrl ?? ""}
                    className="bg-surface border border-line text-xs text-text rounded-lg px-2.5 py-1.5 w-full focus:outline-none"
                  />
                </div>
                <div>
                  <label className="text-[10px] font-bold text-muted uppercase tracking-wider block mb-1.5">Support Secret Token</label>
                  <input
                    name="supportCredential"
                    type="password"
                    placeholder="Enter new credential token to rotate"
                    className="bg-surface border border-line text-xs text-text rounded-lg px-2.5 py-1.5 w-full focus:outline-none"
                  />
                </div>
                <div>
                  <label className="text-[10px] font-bold text-muted uppercase tracking-wider block mb-1.5">Credential Label</label>
                  <input
                    name="supportCredentialLabel"
                    defaultValue={customer.supportCredentialLabel ?? ""}
                    placeholder="e.g. Production primary"
                    className="bg-surface border border-line text-xs text-text rounded-lg px-2.5 py-1.5 w-full focus:outline-none"
                  />
                </div>
                <button
                  type="submit"
                  className="bg-brand-600 hover:bg-brand-500 text-white font-semibold text-xs px-4 py-2 w-full rounded-lg transition-colors"
                >
                  Save settings
                </button>
              </form>
            </div>
          </div>
        )}

        {/* USERS & ACCESS TAB */}
        {activeTab === "users" && (
          <div className="grid grid-cols-1 lg:grid-cols-3 gap-6 animate-in fade-in duration-200">
            {/* Customer specific members list */}
            <div className="lg:col-span-2 space-y-4 bg-bg-alt border border-line rounded-xl p-5 shadow-sm">
              <h3 className="text-sm font-bold text-white flex items-center gap-1.5">
                <UsersIcon className="w-4.5 h-4.5 text-brand-400" />
                Customer Workspace Members
              </h3>
              
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
                        <tr key={member.id} className="hover:bg-surface/40 transition-colors">
                          <td className="p-3">
                            <strong className="text-white text-xs block">{displayName || email || "Member identity unavailable"}</strong>
                            <span className={cn("text-[10px] block mt-0.5", email ? "text-muted" : "text-amber-400")}>
                              {email || `Email unavailable for ${String(member.id).slice(0, 8)}`}
                            </span>
                          </td>
                          <td className="p-3 text-text font-semibold">{member.role}</td>
                          <td className="p-3">
                            <span className={cn("px-2 py-0.5 rounded-full text-[10px] font-semibold border", member.isActive ? "text-emerald-400 border-emerald-500/20 bg-emerald-500/10" : "text-muted border-slate-500/20 bg-slate-500/5")}>
                              {member.isActive ? "Active" : "Inactive"}
                            </span>
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
                                    className="min-w-44 bg-surface border border-line text-[10px] text-text placeholder-slate-600 rounded px-2 py-1 focus:outline-none"
                                  />
                                  <button type="submit" className="bg-surface hover:bg-surface-strong border border-line text-text hover:text-white px-2 py-1 rounded text-[10px] font-medium transition-colors">
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
                                    className="min-w-44 bg-surface border border-line text-[10px] text-text placeholder-slate-600 rounded px-2 py-1 focus:outline-none"
                                  />
                                  <button type="submit" className={cn("px-2 py-1 rounded text-[10px] font-medium transition-colors border", member.isActive ? "bg-rose-950/10 border-rose-500/30 text-rose-400 hover:bg-rose-950/20" : "bg-emerald-950/10 border-emerald-500/30 text-emerald-400 hover:bg-emerald-950/20")}>
                                    {statusAction}
                                  </button>
                                </form>
                              </div>
                            ) : (
                              <span className="inline-flex rounded border border-amber-500/25 bg-amber-500/10 px-2 py-1 text-[10px] font-medium text-amber-300">
                                Email identity required
                              </span>
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

            {/* Invite New Member form */}
            <div className="bg-bg-alt border border-line rounded-xl p-5 shadow-sm space-y-4 h-fit">
              <div>
                <h3 className="text-sm font-bold text-white flex items-center gap-1.5">
                  <Sliders className="w-4 h-4 text-brand-400" />
                  Add New Workspace Member
                </h3>
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
                    className="bg-surface border border-line text-xs text-text rounded-lg px-2.5 py-1.5 w-full focus:outline-none"
                  />
                </div>
                <div>
                  <label className="text-[10px] font-bold text-muted uppercase tracking-wider block mb-1.5">Email Address</label>
                  <input
                    name="email"
                    type="email"
                    required
                    placeholder="jane@company.com"
                    className="bg-surface border border-line text-xs text-text rounded-lg px-2.5 py-1.5 w-full focus:outline-none"
                  />
                </div>
                <div>
                  <label className="text-[10px] font-bold text-muted uppercase tracking-wider block mb-1.5">Workspace Role</label>
                  <select
                    name="role"
                    defaultValue="CONTRIBUTOR"
                    className="bg-surface border border-line text-xs text-text rounded-lg px-2 py-1.5 w-full focus:outline-none"
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
                    className="bg-surface border border-line text-xs text-text placeholder-slate-600 rounded-lg px-2.5 py-1.5 w-full focus:outline-none"
                  />
                </div>
                <button
                  type="submit"
                  className="bg-brand-600 hover:bg-brand-500 text-white font-semibold text-xs px-4 py-2 w-full rounded-lg transition-colors"
                >
                  Invite member
                </button>
              </form>
            </div>
          </div>
        )}

        {/* RELEASES & DEPLOYMENT TAB */}
        {activeTab === "releases" && (
          <div className="grid grid-cols-1 lg:grid-cols-3 gap-6 animate-in fade-in duration-200">
            {/* Deploy target preflights left */}
            <div className="lg:col-span-2 space-y-6">
              {/* Telemetry release upgrade prep */}
              <div className="bg-bg-alt border border-line rounded-xl p-5 space-y-4">
                <div>
                  <h3 className="text-sm font-bold text-white flex items-center gap-1.5">
                    <GitBranch className="w-4.5 h-4.5 text-brand-400" />
                    Record Release Upgrade Intention
                  </h3>
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
                      className="bg-surface border border-line text-xs text-text rounded-lg px-2.5 py-1.5 w-full focus:outline-none"
                    />
                  </div>
                  <div>
                    <label className="text-[10px] font-bold text-muted uppercase tracking-wider block mb-1.5">Target Version</label>
                    <input
                      name="targetReleaseVersion"
                      placeholder="e.g. v1.3.0"
                      className="bg-surface border border-line text-xs text-text rounded-lg px-2.5 py-1.5 w-full focus:outline-none"
                    />
                  </div>
                  <div>
                    <label className="text-[10px] font-bold text-muted uppercase tracking-wider block mb-1.5">Audit Reason</label>
                    <input
                      name="reason"
                      required
                      placeholder="Operator intent detail"
                      className="bg-surface border border-line text-xs text-text placeholder-slate-600 rounded-lg px-2.5 py-1.5 w-full focus:outline-none"
                    />
                  </div>
                  <button
                    type="submit"
                    className="bg-surface-strong hover:bg-surface border border-line text-text text-xs py-1.5 px-3 rounded-lg font-semibold transition-colors w-full h-8"
                  >
                    Log upgrade intent
                  </button>
                </form>
              </div>

              {/* Preflight checks checklist */}
              <div className="bg-bg-alt border border-line rounded-xl p-5 space-y-4">
                <h3 className="text-sm font-bold text-white flex items-center gap-1.5">
                  <ShieldCheck className="w-4.5 h-4.5 text-brand-400" />
                  Preflight Upgrade Deploy Checks
                </h3>

                <div className="space-y-2">
                  {preflightChecks.map((chk: any, i: number) => (
                    <div key={i} className="flex items-start justify-between p-3 rounded-lg bg-surface border border-line">
                      <div>
                        <h4 className="text-xs font-semibold text-white">{chk.label}</h4>
                        <p className="text-[10px] text-muted mt-0.5">{chk.detail}</p>
                      </div>
                      <span className={cn("px-2 py-0.5 rounded text-[8px] font-bold uppercase border tracking-wider shrink-0", chk.ok ? "text-emerald-400 border-emerald-500/25 bg-emerald-500/10" : "text-rose-400 border-rose-500/25 bg-rose-500/10")}>
                        {chk.ok ? "pass" : "blocked"}
                      </span>
                    </div>
                  ))}
                </div>
              </div>
            </div>

            {/* Execute Deploy Panel Right */}
            <div className="bg-bg-alt border border-line rounded-xl p-5 shadow-sm space-y-4 h-fit">
              <div>
                <h3 className="text-sm font-bold text-white flex items-center gap-1.5">
                  <Cpu className="w-4 h-4 text-brand-400" />
                  Execute Staged Release Rollout
                </h3>
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
                    className="bg-surface border border-line text-xs text-text placeholder-slate-600 rounded-lg px-2.5 py-2.5 w-full focus:outline-none focus:border-line"
                  />
                </div>

                <button
                  type="submit"
                  disabled={!isPreflightPassed}
                  className={cn(
                    "text-xs font-semibold px-4 py-2.5 rounded-lg shadow-md w-full transition-all duration-150",
                    isPreflightPassed
                      ? "bg-brand-600 hover:bg-brand-500 text-white shadow-brand-950/20"
                      : "bg-surface/40 border border-line/60 text-muted cursor-not-allowed"
                  )}
                >
                  {isPreflightPassed ? "Deploy latest stable tag" : "Resolve preflight blocks"}
                </button>
              </form>
            </div>
          </div>
        )}

        {/* SUPPORT LOG & AUDIT TAB */}
        {activeTab === "logs" && (
          <div className="grid grid-cols-1 lg:grid-cols-3 gap-6 animate-in fade-in duration-200">
            {/* Audit support operations logs left */}
            <div className="lg:col-span-2 space-y-4 bg-bg-alt border border-line rounded-xl p-5 shadow-sm">
              <h3 className="text-sm font-bold text-white flex items-center gap-1.5">
                <ShieldCheck className="w-4.5 h-4.5 text-brand-400" />
                Deployment Operational Audit History
              </h3>

              <div className="space-y-3 max-h-[460px] overflow-y-auto pr-1 scrollbar-thin">
                {customer.supportOperations.map((op: any) => (
                  <div key={op.id} className="p-3 rounded-lg bg-surface border border-line space-y-2">
                    <div className="flex items-center justify-between">
                      <strong className="text-xs text-white font-semibold">{op.action}</strong>
                      <span className={cn("text-[9px] font-bold uppercase px-1.5 py-0.5 rounded border tracking-wider shrink-0", tone(op.status))}>
                        {op.status}
                      </span>
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

            {/* Record Break-glass note form Right */}
            <div className="bg-bg-alt border border-line rounded-xl p-5 shadow-sm space-y-4 h-fit">
              <div>
                <h3 className="text-sm font-bold text-white flex items-center gap-1.5">
                  <AlertTriangle className="w-4 h-4 text-amber-500" />
                  Log Break-Glass Incident
                </h3>
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
                    className="bg-surface border border-line text-xs text-text rounded-lg px-2.5 py-1.5 w-full focus:outline-none"
                  />
                </div>
                <div>
                  <label className="text-[10px] font-bold text-muted uppercase tracking-wider block mb-1.5">Audit Narrative Description</label>
                  <textarea
                    name="notes"
                    required
                    rows={4}
                    placeholder="Provide a full explanation of why emergency direct access was utilized and exactly what tables or nodes were updated. Avoid pasting raw secrets."
                    className="bg-surface border border-line text-xs text-text rounded-lg p-2.5 w-full focus:outline-none"
                  />
                </div>
                <button
                  type="submit"
                  className="bg-amber-600 hover:bg-amber-500 text-white font-semibold text-xs px-4 py-2 w-full rounded-lg transition-colors shadow shadow-amber-950/20"
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
