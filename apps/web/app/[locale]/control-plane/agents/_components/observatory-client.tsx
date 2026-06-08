"use client";

import { useEffect, useState, useTransition } from "react";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import {
  Bot,
  CheckCircle,
  AlertTriangle,
  Play,
  Cpu,
  DollarSign,
  Clock,
  Code,
  X,
} from "lucide-react";
import { cn } from "@/lib/utils";

interface Agent {
  id: string;
  customerId: string;
  customerName: string;
  customerSlug: string;
  name: string;
  status: string;
  modelTier: string;
  modelOverride: string;
  authority: string;
  access: string;
  dataScope: string;
  limits: string;
  approval: string;
  pendingApprovals: number;
  runsCount: number;
  costMtd: string;
  lastRun: string;
  latestRunStatus: string;
}

interface Run {
  id: string;
  customerId: string;
  customerName: string;
  agentName: string;
  status: string;
  duration: string;
  cost: string;
  tokens: string;
  timestamp: string;
  steps: Array<{ title: string; ok: boolean }>;
  toolCalls: Array<{ name: string; duration: string }>;
  error?: string;
}

interface CustomerSummary {
  id: string;
  name: string;
  slug: string;
  healthStatus: string;
  supportConnectorStatus: string;
  supportMcpUrl?: string | null;
  accessMode: string;
  hasManagedWorkspace: boolean;
  agentCount: number;
  runCount: number;
  credentialCount: number;
  integrationCount: number;
  modelSpend: string | number | null;
  errors: string[];
  credentials: Array<{
    id: string;
    label: string;
    isActive: boolean;
    scopes: string[];
  }>;
  integrations: Array<{
    key: string;
    label: string;
    status: string;
    configured: boolean;
    lastError?: string | null;
  }>;
}

interface ObservatoryProps {
  agents: Agent[];
  runs: Run[];
  customers: CustomerSummary[];
  initialCustomerId?: string | null;
}

export function AgentObservatoryClient({ agents, runs, customers, initialCustomerId }: ObservatoryProps) {
  const router = useRouter();
  const pathname = usePathname() || "";
  const searchParams = useSearchParams();
  const [search, setSearch] = useState("");
  const [selectedCustomerId, setSelectedCustomerId] = useState(initialCustomerId ?? "");
  const [pendingCustomerId, setPendingCustomerId] = useState<string | null>(null);
  const [selectedStatus, setSelectedStatus] = useState("");
  const [selectedRun, setSelectedRun] = useState<Run | null>(null); // Active trace drawer
  const [isPending, startTransition] = useTransition();
  const selectedCustomer = customers.find((customer) => customer.id === selectedCustomerId) ?? null;
  const scopedCustomers = selectedCustomer ? [selectedCustomer] : customers;
  const scopedAgents = selectedCustomer ? agents.filter((agent) => agent.customerId === selectedCustomer.id) : agents;
  const scopedRuns = selectedCustomer ? runs.filter((run) => run.customerId === selectedCustomer.id) : runs;
  const summaryAgentCount = scopedCustomers.reduce((total, customer) => total + customer.agentCount, 0);
  const summaryRunCount = scopedCustomers.reduce((total, customer) => total + customer.runCount, 0);
  const completedRuns = scopedRuns.filter((run) => run.status === "COMPLETED").length;
  const successRate = scopedRuns.length > 0 ? `${((completedRuns / scopedRuns.length) * 100).toFixed(1)}%` : "n/a";
  const modelSpend = scopedRuns.reduce((total, run) => total + Number(run.cost.replace(/[^0-9.-]/g, "") || 0), 0);

  // Filter logic
  const filteredAgents = scopedAgents.filter((agent) => {
    const query = search.toLowerCase();
    const matchesSearch = [
      agent.name,
      agent.customerName,
      agent.customerSlug,
      agent.authority,
      agent.access,
      agent.dataScope,
    ].some((value) => value.toLowerCase().includes(query));
    const matchesStatus = selectedStatus === "" || agent.status === selectedStatus;
    return matchesSearch && matchesStatus;
  });
  const filteredRuns = scopedRuns;
  const connectionRows = scopedCustomers.flatMap((customer) => ([
    {
      id: `${customer.id}:support`,
      customerName: customer.name,
      label: customer.supportMcpUrl ? "Customer MCP endpoint" : "Support connector",
      kind: customer.accessMode,
      status: customer.supportConnectorStatus,
      detail: customer.supportMcpUrl ?? "No MCP endpoint recorded",
    },
    ...customer.credentials.map((credential) => ({
      id: `${customer.id}:credential:${credential.id}`,
      customerName: customer.name,
      label: credential.label,
      kind: "MCP credential",
      status: credential.isActive ? "active" : "disabled",
      detail: credential.scopes.length > 0 ? credential.scopes.join(", ") : "No scopes recorded",
    })),
  ]));
  const integrationRows = scopedCustomers.flatMap((customer) => customer.integrations.map((integration) => ({
    ...integration,
    id: `${customer.id}:integration:${integration.key}`,
    customerName: customer.name,
  })));

  useEffect(() => {
    setSelectedCustomerId(initialCustomerId ?? "");
    setPendingCustomerId(null);
  }, [initialCustomerId]);

  const selectCustomer = (customerId: string) => {
    if (customerId === selectedCustomerId) return;
    setSelectedCustomerId(customerId);
    setPendingCustomerId(customerId);
    const params = new URLSearchParams(searchParams?.toString() ?? "");
    if (customerId) {
      params.set("client", customerId);
    } else {
      params.delete("client");
    }
    const query = params.toString();
    startTransition(() => {
      router.replace(query ? `${pathname}?${query}` : pathname, { scroll: false });
    });
  };

  return (
    <div className="space-y-6">
      <div className="bg-bg-alt border border-line rounded-xl p-5 shadow-sm flex flex-col lg:flex-row lg:items-center justify-between gap-4">
        <div>
          <h2 className="text-sm font-bold text-white">Customer Scope</h2>
          <p className="text-[10px] text-muted mt-0.5">
            Switch between the whole Corgtex platform and individual customer deployments.
          </p>
        </div>
        <select
          value={selectedCustomerId}
          onChange={(event) => selectCustomer(event.target.value)}
          className="bg-surface border border-line text-xs text-text rounded-lg px-3 py-2 focus:outline-none lg:min-w-72"
        >
          <option value="">Whole platform</option>
          {customers.map((customer) => (
            <option key={customer.id} value={customer.id}>
              {customer.name}
            </option>
          ))}
        </select>
        {(pendingCustomerId !== null || isPending) && (
          <span className="text-[10px] font-semibold text-amber-300">Loading customer scope...</span>
        )}
      </div>
      
      {/* Metrics Row */}
      <div className="grid grid-cols-2 lg:grid-cols-4 gap-4">
        {[
          { title: "Customers", value: scopedCustomers.length, detail: selectedCustomer ? selectedCustomer.slug : "visible fleet scope", icon: Bot, tone: "text-muted" },
          { title: "Total Agents", value: scopedAgents.length || summaryAgentCount, detail: "known or configured agents", icon: CheckCircle, tone: "text-emerald-400" },
          { title: "Run Traces", value: scopedRuns.length || summaryRunCount, detail: scopedRuns.length ? successRate : "summary count", icon: CheckCircle, tone: "text-emerald-400" },
          { title: "Model Spend", value: `$${modelSpend.toFixed(2)}`, detail: "from loaded run traces", icon: DollarSign, tone: "text-indigo-400" },
        ].map((metric, i) => {
          const Icon = metric.icon;
          return (
            <div key={i} className="bg-bg-alt border border-line rounded-xl p-4 flex justify-between items-start shadow-sm">
              <div className="space-y-1">
                <span className="text-[10px] text-muted font-semibold uppercase">{metric.title}</span>
                <span className="text-xl font-bold text-white block">{metric.value}</span>
                <span className="text-[10px] text-muted block">{metric.detail}</span>
              </div>
              <div className={cn("p-2 rounded-lg bg-surface border border-line", metric.tone)}>
                <Icon className="w-4 h-4" />
              </div>
            </div>
          );
        })}
      </div>

      {/* Grid: Agent Registry Table + Trace logs */}
      <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
        
        {/* Agent Registry (Col Span 2) */}
        <div className="lg:col-span-2 space-y-4 bg-bg-alt border border-line rounded-xl p-5 shadow-sm">
          <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3 pb-4 border-b border-line">
            <div>
              <h2 className="text-sm font-bold text-white">Agent Authority Registry</h2>
              <p className="text-[10px] text-muted mt-0.5">Review who each agent serves, what it can access, its limits, approvals, and latest activity.</p>
            </div>

            {/* Filter controls */}
            <div className="flex gap-2">
              <input
                type="text"
                placeholder="Search agents..."
                value={search}
                onChange={(e) => setSearch(e.target.value)}
                className="bg-surface border border-line text-xs text-text placeholder-slate-600 rounded-lg px-2.5 py-1.5 focus:border-line focus:outline-none"
              />
              <select
                value={selectedStatus}
                onChange={(e) => setSelectedStatus(e.target.value)}
                className="bg-surface border border-line text-xs text-muted rounded-lg px-2 py-1.5 focus:outline-none"
              >
                <option value="">Any status</option>
                <option value="ACTIVE">Active</option>
                <option value="AVAILABLE">Available</option>
                <option value="DISABLED">Disabled</option>
                <option value="ARCHIVED">Archived</option>
              </select>
            </div>
          </div>

          <div className="overflow-x-auto">
            <table className="w-full border-collapse text-xs">
              <thead>
                <tr className="border-b border-line text-muted text-left font-medium">
                  <th className="p-3">Agent</th>
                  <th className="p-3">Customer</th>
                  <th className="p-3">Status</th>
                  <th className="p-3">Authority</th>
                  <th className="p-3">Access</th>
                  <th className="p-3">Limits</th>
                  <th className="p-3">Approval</th>
                  <th className="p-3 text-right">Activity</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-line">
                {filteredAgents.map((agent) => (
                  <tr key={agent.id} className="hover:bg-surface/40 transition-colors">
                    <td className="p-3">
                      <span className="font-semibold text-white block">{agent.name}</span>
                      <span className="text-[9px] text-muted block mt-0.5">Last run: {agent.lastRun}</span>
                    </td>
                    <td className="p-3">
                      <span className="text-text font-semibold block">{agent.customerName}</span>
                      <span className="text-[9px] text-muted block mt-0.5">slug: {agent.customerSlug}</span>
                    </td>
                    <td className="p-3">
                      <span className={cn(
                        "px-2 py-0.5 rounded-full text-[9px] font-bold uppercase border",
                        agent.status === "ACTIVE" 
                          ? "text-emerald-400 border-emerald-500/20 bg-emerald-500/10" 
                          : "text-muted border-slate-500/20 bg-slate-500/5"
                      )}>
                        {agent.status}
                      </span>
                    </td>
                    <td className="p-3 text-text text-[10px] max-w-[180px]">
                      <span className="line-clamp-2">{agent.authority}</span>
                    </td>
                    <td className="p-3 text-text text-[10px] max-w-[180px]">
                      <span className="font-semibold block truncate">{agent.access}</span>
                      <span className="text-muted block mt-0.5">{agent.dataScope}</span>
                    </td>
                    <td className="p-3 text-muted text-[10px] max-w-[170px]">{agent.limits}</td>
                    <td className="p-3 text-[10px] max-w-[170px]">
                      <span className={cn(
                        agent.pendingApprovals > 0 ? "text-amber-300" : "text-muted"
                      )}>
                        {agent.approval}
                      </span>
                    </td>
                    <td className="p-3 text-right">
                      <span className="font-bold text-white block">{agent.costMtd}</span>
                      <span className="text-[9px] text-muted block">{agent.runsCount} runs / {agent.latestRunStatus}</span>
                    </td>
                  </tr>
                ))}
                {filteredAgents.length === 0 && (
                  <tr>
                    <td colSpan={8} className="text-center py-6 text-muted">No agents found matching this criteria.</td>
                  </tr>
                )}
              </tbody>
            </table>
          </div>
        </div>

        {/* Recent Traces Logs (Col Span 1) */}
        <div className="bg-bg-alt border border-line rounded-xl p-5 shadow-sm space-y-4">
          <div>
            <h3 className="text-sm font-bold text-white flex items-center gap-1.5">
              <Play className="w-4 h-4 text-brand-400 shrink-0" />
              Recent Agent Run Traces
            </h3>
            <p className="text-[10px] text-muted mt-0.5">Telemetry logs of the latest agent completions.</p>
          </div>

          <div className="space-y-2.5 max-h-[360px] overflow-y-auto pr-1 scrollbar-thin">
            {filteredRuns.map((run) => (
              <button
                key={run.id}
                onClick={() => setSelectedRun(run)}
                className="flex flex-col w-full text-left p-3 rounded-lg bg-surface border border-line hover:border-line hover:bg-surface-strong transition-all group"
              >
                <div className="flex items-center justify-between w-full">
                  <strong className="text-white text-xs font-semibold group-hover:text-brand-400 transition-colors">
                    {run.agentName}
                  </strong>
                  <span className={cn(
                    "text-[8px] font-bold px-1.5 py-0.5 border rounded uppercase shrink-0",
                    run.status === "COMPLETED" 
                      ? "text-emerald-400 border-emerald-500/25 bg-emerald-500/10" 
                      : "text-rose-400 border-rose-500/25 bg-rose-500/10"
                  )}>
                    {run.status}
                  </span>
                </div>
                <div className="flex items-center justify-between text-[9px] text-muted mt-1 w-full">
                  <span>{run.customerName}</span>
                </div>
                <div className="flex items-center justify-between text-[9px] text-muted mt-1 w-full">
                  <span>Tokens: {run.tokens}</span>
                  <span className="font-semibold text-muted">{run.cost}</span>
                </div>
                <span className="text-[8px] text-muted block mt-1">Started {run.timestamp}</span>
              </button>
            ))}
            {filteredRuns.length === 0 && (
              <div className="text-center py-6 text-muted text-[10px]">
                No agent run traces are available for this scope.
              </div>
            )}
          </div>
        </div>

      </div>

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
        <div className="bg-bg-alt border border-line rounded-xl p-5 shadow-sm space-y-4">
          <div>
            <h3 className="text-sm font-bold text-white">Connections & MCP</h3>
            <p className="text-[10px] text-muted mt-0.5">Support connectors, customer MCP endpoints, and active agent credentials by customer.</p>
          </div>
          <div className="space-y-2.5 max-h-[360px] overflow-y-auto pr-1 scrollbar-thin">
            {connectionRows.map((connection) => (
              <div key={connection.id} className="rounded-lg bg-surface border border-line p-3">
                <div className="flex items-start justify-between gap-3">
                  <div>
                    <strong className="text-xs text-white block">{connection.label}</strong>
                    <span className="text-[9px] text-muted block mt-0.5">{connection.customerName} - {connection.kind}</span>
                  </div>
                  <span className="text-[8px] font-bold uppercase text-text border border-line rounded px-1.5 py-0.5">
                    {connection.status}
                  </span>
                </div>
                <p className="text-[9px] text-muted mt-2 break-all">{connection.detail}</p>
              </div>
            ))}
            {connectionRows.length === 0 && (
              <div className="text-center py-6 text-muted text-[10px]">No connector or MCP records are available for this scope.</div>
            )}
          </div>
        </div>

        <div className="bg-bg-alt border border-line rounded-xl p-5 shadow-sm space-y-4">
          <div>
            <h3 className="text-sm font-bold text-white">Integration Registry</h3>
            <p className="text-[10px] text-muted mt-0.5">Customer integrations and data feeds visible from the control plane.</p>
          </div>
          <div className="space-y-2.5 max-h-[360px] overflow-y-auto pr-1 scrollbar-thin">
            {integrationRows.map((integration) => (
              <div key={integration.id} className="rounded-lg bg-surface border border-line p-3">
                <div className="flex items-start justify-between gap-3">
                  <div>
                    <strong className="text-xs text-white block">{integration.label}</strong>
                    <span className="text-[9px] text-muted block mt-0.5">{integration.customerName}</span>
                  </div>
                  <span className={cn(
                    "text-[8px] font-bold uppercase border rounded px-1.5 py-0.5",
                    integration.configured ? "text-emerald-400 border-emerald-500/25 bg-emerald-500/10" : "text-muted border-slate-500/20 bg-slate-500/5",
                  )}>
                    {integration.status}
                  </span>
                </div>
                {integration.lastError && (
                  <p className="text-[9px] text-rose-400 mt-2">{integration.lastError}</p>
                )}
              </div>
            ))}
            {integrationRows.length === 0 && (
              <div className="text-center py-6 text-muted text-[10px]">No integrations are available for this scope.</div>
            )}
          </div>
        </div>
      </div>

      {/* Slide-out active Trace Drawer */}
      {selectedRun && (
        <div className="fixed inset-y-0 right-0 z-50 flex w-full max-w-md bg-bg-alt/95 backdrop-blur-md border-l border-line shadow-2xl text-text-strong transform transition-transform animate-in slide-in-from-right duration-300">
          <div className="flex flex-col w-full h-full relative p-4 space-y-4">
            {/* Header */}
            <div className="flex items-center justify-between pb-3 border-b border-line">
              <div className="flex items-center gap-2">
                <Code className="w-5 h-5 text-brand-400" />
                <div>
                  <h2 className="text-xs font-bold text-white">Agent Run Trace</h2>
                  <p className="text-[9px] text-muted">{selectedRun.agentName}</p>
                </div>
              </div>
              <button
                onClick={() => setSelectedRun(null)}
                className="p-1 rounded hover:bg-surface-strong border border-transparent hover:border-line text-muted hover:text-white transition-all duration-150"
              >
                <X className="w-4 h-4" />
              </button>
            </div>

            {/* Run details */}
            <div className="grid grid-cols-3 gap-2 py-1 border-b border-line/60">
              <div className="p-2 rounded bg-surface border border-line">
                <span className="text-[8px] text-muted uppercase font-semibold flex items-center gap-1"><Clock className="w-2.5 h-2.5" /> Duration</span>
                <span className="text-xs font-bold text-white mt-1 block">{selectedRun.duration}</span>
              </div>
              <div className="p-2 rounded bg-surface border border-line">
                <span className="text-[8px] text-muted uppercase font-semibold flex items-center gap-1"><DollarSign className="w-2.5 h-2.5" /> Cost</span>
                <span className="text-xs font-bold text-white mt-1 block">{selectedRun.cost}</span>
              </div>
              <div className="p-2 rounded bg-surface border border-line">
                <span className="text-[8px] text-muted uppercase font-semibold flex items-center gap-1"><Cpu className="w-2.5 h-2.5" /> Tokens</span>
                <span className="text-xs font-bold text-white mt-1 block">{selectedRun.tokens}</span>
              </div>
            </div>

            {/* Error logs block */}
            {selectedRun.error && (
              <div className="p-3 rounded-lg bg-rose-950/15 border border-rose-500/20 text-rose-400 space-y-1 select-text">
                <div className="flex items-center gap-1">
                  <AlertTriangle className="w-3.5 h-3.5 text-rose-400 shrink-0" />
                  <span className="text-[9px] font-bold uppercase tracking-wider">Trace Error Logs</span>
                </div>
                <p className="text-[10px] font-mono leading-tight whitespace-pre-wrap">{selectedRun.error}</p>
              </div>
            )}

            {/* Steps stream checklist */}
            <div className="space-y-2 flex-1 overflow-y-auto scrollbar-thin">
              <span className="text-[9px] font-bold text-muted uppercase tracking-wider block">Execution Steps</span>
              <div className="space-y-2">
                {selectedRun.steps.map((step, idx) => (
                  <div key={idx} className="flex items-start gap-2.5 p-2 rounded bg-surface/60 border border-line text-[10px] text-text">
                    {step.ok ? (
                      <CheckCircle className="w-3.5 h-3.5 text-emerald-400 shrink-0 mt-0.5" />
                    ) : (
                      <AlertTriangle className="w-3.5 h-3.5 text-rose-400 shrink-0 mt-0.5" />
                    )}
                    <span>{step.title}</span>
                  </div>
                ))}
              </div>

              {/* Tool Calls block */}
              {selectedRun.toolCalls.length > 0 && (
                <div className="space-y-2 pt-3">
                  <span className="text-[9px] font-bold text-muted uppercase tracking-wider block">Tool Invocations</span>
                  {selectedRun.toolCalls.map((call, idx) => (
                    <div key={idx} className="flex items-center justify-between p-2 rounded bg-surface/30 border border-line/50 text-[10px] text-muted font-mono">
                      <span className="truncate pr-4 text-indigo-400">{call.name}</span>
                      <span className="shrink-0 text-muted text-[9px]">{call.duration}</span>
                    </div>
                  ))}
                </div>
              )}
            </div>
          </div>
        </div>
      )}

    </div>
  );
}
