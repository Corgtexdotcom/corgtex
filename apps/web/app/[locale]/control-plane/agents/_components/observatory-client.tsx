"use client";

import { useState } from "react";
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
  runsCount: number;
  costMtd: string;
  lastRun: string;
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
}

export function AgentObservatoryClient({ agents, runs, customers }: ObservatoryProps) {
  const [search, setSearch] = useState("");
  const [selectedCustomerId, setSelectedCustomerId] = useState("");
  const [selectedStatus, setSelectedStatus] = useState("");
  const [selectedRun, setSelectedRun] = useState<Run | null>(null); // Active trace drawer
  const selectedCustomer = customers.find((customer) => customer.id === selectedCustomerId) ?? null;
  const scopedCustomers = selectedCustomer ? [selectedCustomer] : customers;
  const scopedAgents = selectedCustomer ? agents.filter((agent) => agent.customerId === selectedCustomer.id) : agents;
  const scopedRuns = selectedCustomer ? runs.filter((run) => run.customerId === selectedCustomer.id) : runs;
  const completedRuns = scopedRuns.filter((run) => run.status === "COMPLETED").length;
  const successRate = scopedRuns.length > 0 ? `${((completedRuns / scopedRuns.length) * 100).toFixed(1)}%` : "n/a";
  const modelSpend = scopedRuns.reduce((total, run) => total + Number(run.cost.replace(/[^0-9.-]/g, "") || 0), 0);

  // Filter logic
  const filteredAgents = scopedAgents.filter((agent) => {
    const matchesSearch = agent.name.toLowerCase().includes(search.toLowerCase());
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

  return (
    <div className="space-y-6">
      <div className="bg-[#0b0d12] border border-[#1f2430] rounded-xl p-5 shadow-sm flex flex-col lg:flex-row lg:items-center justify-between gap-4">
        <div>
          <h2 className="text-sm font-bold text-white">Customer Scope</h2>
          <p className="text-[10px] text-slate-500 mt-0.5">
            Switch between the whole Corgtex platform and individual customer deployments.
          </p>
        </div>
        <select
          value={selectedCustomerId}
          onChange={(event) => setSelectedCustomerId(event.target.value)}
          className="bg-[#141822] border border-[#202738] text-xs text-slate-200 rounded-lg px-3 py-2 focus:outline-none lg:min-w-72"
        >
          <option value="">Whole platform</option>
          {customers.map((customer) => (
            <option key={customer.id} value={customer.id}>
              {customer.name}
            </option>
          ))}
        </select>
      </div>
      
      {/* Metrics Row */}
      <div className="grid grid-cols-2 lg:grid-cols-4 gap-4">
        {[
          { title: "Customers", value: scopedCustomers.length, detail: selectedCustomer ? selectedCustomer.slug : "visible fleet scope", icon: Bot, tone: "text-slate-400" },
          { title: "Total Agents", value: scopedAgents.length, detail: "known or configured agents", icon: CheckCircle, tone: "text-emerald-400" },
          { title: "Success Rate", value: successRate, detail: "from loaded run traces", icon: CheckCircle, tone: "text-emerald-400" },
          { title: "Model Spend", value: `$${modelSpend.toFixed(2)}`, detail: "from loaded run traces", icon: DollarSign, tone: "text-indigo-400" },
        ].map((metric, i) => {
          const Icon = metric.icon;
          return (
            <div key={i} className="bg-[#0b0d12] border border-[#1f2430] rounded-xl p-4 flex justify-between items-start shadow-sm">
              <div className="space-y-1">
                <span className="text-[10px] text-slate-500 font-semibold uppercase">{metric.title}</span>
                <span className="text-xl font-bold text-white block">{metric.value}</span>
                <span className="text-[10px] text-slate-400 block">{metric.detail}</span>
              </div>
              <div className={cn("p-2 rounded-lg bg-[#141822] border border-[#202738]", metric.tone)}>
                <Icon className="w-4 h-4" />
              </div>
            </div>
          );
        })}
      </div>

      {/* Grid: Agent Registry Table + Trace logs */}
      <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
        
        {/* Agent Registry (Col Span 2) */}
        <div className="lg:col-span-2 space-y-4 bg-[#0b0d12] border border-[#1f2430] rounded-xl p-5 shadow-sm">
          <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3 pb-4 border-b border-[#1f2430]">
            <div>
              <h2 className="text-sm font-bold text-white">Agent Telemetry Registry</h2>
              <p className="text-[10px] text-slate-500 mt-0.5">Filter and review details of all active fleet agent constitutions.</p>
            </div>

            {/* Filter controls */}
            <div className="flex gap-2">
              <input
                type="text"
                placeholder="Search agent name..."
                value={search}
                onChange={(e) => setSearch(e.target.value)}
                className="bg-[#141822] border border-[#202738] text-xs text-slate-300 placeholder-slate-600 rounded-lg px-2.5 py-1.5 focus:border-[#2f3952] focus:outline-none"
              />
              <select
                value={selectedStatus}
                onChange={(e) => setSelectedStatus(e.target.value)}
                className="bg-[#141822] border border-[#202738] text-xs text-slate-400 rounded-lg px-2 py-1.5 focus:outline-none"
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
                <tr className="border-b border-[#1f2430] text-slate-400 text-left font-medium">
                  <th className="p-3">Agent</th>
                  <th className="p-3">Customer</th>
                  <th className="p-3">Status</th>
                  <th className="p-3">Model Config</th>
                  <th className="p-3">Runs</th>
                  <th className="p-3 text-right">Spend</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-[#1f2430]/60">
                {filteredAgents.map((agent) => (
                  <tr key={agent.id} className="hover:bg-[#141822]/40 transition-colors">
                    <td className="p-3">
                      <span className="font-semibold text-white block">{agent.name}</span>
                      <span className="text-[9px] text-slate-500 block mt-0.5">Last run: {agent.lastRun}</span>
                    </td>
                    <td className="p-3">
                      <span className="text-slate-300 font-semibold block">{agent.customerName}</span>
                      <span className="text-[9px] text-slate-500 block mt-0.5">slug: {agent.customerSlug}</span>
                    </td>
                    <td className="p-3">
                      <span className={cn(
                        "px-2 py-0.5 rounded-full text-[9px] font-bold uppercase border",
                        agent.status === "ACTIVE" 
                          ? "text-emerald-400 border-emerald-500/20 bg-emerald-500/10" 
                          : "text-slate-400 border-slate-500/20 bg-slate-500/5"
                      )}>
                        {agent.status}
                      </span>
                    </td>
                    <td className="p-3 text-slate-300 font-mono text-[10px]">
                      {agent.modelOverride}
                    </td>
                    <td className="p-3 text-slate-400 font-semibold">{agent.runsCount}</td>
                    <td className="p-3 text-right font-bold text-white">{agent.costMtd}</td>
                  </tr>
                ))}
                {filteredAgents.length === 0 && (
                  <tr>
                    <td colSpan={6} className="text-center py-6 text-slate-500">No agents found matching this criteria.</td>
                  </tr>
                )}
              </tbody>
            </table>
          </div>
        </div>

        {/* Recent Traces Logs (Col Span 1) */}
        <div className="bg-[#0b0d12] border border-[#1f2430] rounded-xl p-5 shadow-sm space-y-4">
          <div>
            <h3 className="text-sm font-bold text-white flex items-center gap-1.5">
              <Play className="w-4 h-4 text-brand-400 shrink-0" />
              Recent Agent Run Traces
            </h3>
            <p className="text-[10px] text-slate-500 mt-0.5">Telemetry logs of the latest agent completions.</p>
          </div>

          <div className="space-y-2.5 max-h-[360px] overflow-y-auto pr-1 scrollbar-thin">
            {filteredRuns.map((run) => (
              <button
                key={run.id}
                onClick={() => setSelectedRun(run)}
                className="flex flex-col w-full text-left p-3 rounded-lg bg-[#141822] border border-[#202738] hover:border-[#2f3952] hover:bg-[#1a202d] transition-all group"
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
                <div className="flex items-center justify-between text-[9px] text-slate-500 mt-1 w-full">
                  <span>{run.customerName}</span>
                </div>
                <div className="flex items-center justify-between text-[9px] text-slate-500 mt-1 w-full">
                  <span>Tokens: {run.tokens}</span>
                  <span className="font-semibold text-slate-400">{run.cost}</span>
                </div>
                <span className="text-[8px] text-slate-600 block mt-1">Started {run.timestamp}</span>
              </button>
            ))}
            {filteredRuns.length === 0 && (
              <div className="text-center py-6 text-slate-500 text-[10px]">
                No agent run traces are available for this scope.
              </div>
            )}
          </div>
        </div>

      </div>

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
        <div className="bg-[#0b0d12] border border-[#1f2430] rounded-xl p-5 shadow-sm space-y-4">
          <div>
            <h3 className="text-sm font-bold text-white">Connections & MCP</h3>
            <p className="text-[10px] text-slate-500 mt-0.5">Support connectors, customer MCP endpoints, and active agent credentials by customer.</p>
          </div>
          <div className="space-y-2.5 max-h-[360px] overflow-y-auto pr-1 scrollbar-thin">
            {connectionRows.map((connection) => (
              <div key={connection.id} className="rounded-lg bg-[#141822] border border-[#202738] p-3">
                <div className="flex items-start justify-between gap-3">
                  <div>
                    <strong className="text-xs text-white block">{connection.label}</strong>
                    <span className="text-[9px] text-slate-500 block mt-0.5">{connection.customerName} - {connection.kind}</span>
                  </div>
                  <span className="text-[8px] font-bold uppercase text-slate-300 border border-[#2d3548] rounded px-1.5 py-0.5">
                    {connection.status}
                  </span>
                </div>
                <p className="text-[9px] text-slate-500 mt-2 break-all">{connection.detail}</p>
              </div>
            ))}
            {connectionRows.length === 0 && (
              <div className="text-center py-6 text-slate-500 text-[10px]">No connector or MCP records are available for this scope.</div>
            )}
          </div>
        </div>

        <div className="bg-[#0b0d12] border border-[#1f2430] rounded-xl p-5 shadow-sm space-y-4">
          <div>
            <h3 className="text-sm font-bold text-white">Integration Registry</h3>
            <p className="text-[10px] text-slate-500 mt-0.5">Customer integrations and data feeds visible from the control plane.</p>
          </div>
          <div className="space-y-2.5 max-h-[360px] overflow-y-auto pr-1 scrollbar-thin">
            {integrationRows.map((integration) => (
              <div key={integration.id} className="rounded-lg bg-[#141822] border border-[#202738] p-3">
                <div className="flex items-start justify-between gap-3">
                  <div>
                    <strong className="text-xs text-white block">{integration.label}</strong>
                    <span className="text-[9px] text-slate-500 block mt-0.5">{integration.customerName}</span>
                  </div>
                  <span className={cn(
                    "text-[8px] font-bold uppercase border rounded px-1.5 py-0.5",
                    integration.configured ? "text-emerald-400 border-emerald-500/25 bg-emerald-500/10" : "text-slate-400 border-slate-500/20 bg-slate-500/5",
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
              <div className="text-center py-6 text-slate-500 text-[10px]">No integrations are available for this scope.</div>
            )}
          </div>
        </div>
      </div>

      {/* Slide-out active Trace Drawer */}
      {selectedRun && (
        <div className="fixed inset-y-0 right-0 z-50 flex w-full max-w-md bg-[#0b0d13]/95 backdrop-blur-md border-l border-[#1f2430] shadow-2xl text-slate-100 transform transition-transform animate-in slide-in-from-right duration-300">
          <div className="flex flex-col w-full h-full relative p-4 space-y-4">
            {/* Header */}
            <div className="flex items-center justify-between pb-3 border-b border-[#1f2430]">
              <div className="flex items-center gap-2">
                <Code className="w-5 h-5 text-brand-400" />
                <div>
                  <h2 className="text-xs font-bold text-white">Agent Run Trace</h2>
                  <p className="text-[9px] text-slate-500">{selectedRun.agentName}</p>
                </div>
              </div>
              <button
                onClick={() => setSelectedRun(null)}
                className="p-1 rounded hover:bg-[#1a1f2c] border border-transparent hover:border-[#2d3548] text-slate-400 hover:text-white transition-all duration-150"
              >
                <X className="w-4 h-4" />
              </button>
            </div>

            {/* Run details */}
            <div className="grid grid-cols-3 gap-2 py-1 border-b border-[#1f2430]/60">
              <div className="p-2 rounded bg-[#141822] border border-[#202738]">
                <span className="text-[8px] text-slate-500 uppercase font-semibold flex items-center gap-1"><Clock className="w-2.5 h-2.5" /> Duration</span>
                <span className="text-xs font-bold text-white mt-1 block">{selectedRun.duration}</span>
              </div>
              <div className="p-2 rounded bg-[#141822] border border-[#202738]">
                <span className="text-[8px] text-slate-500 uppercase font-semibold flex items-center gap-1"><DollarSign className="w-2.5 h-2.5" /> Cost</span>
                <span className="text-xs font-bold text-white mt-1 block">{selectedRun.cost}</span>
              </div>
              <div className="p-2 rounded bg-[#141822] border border-[#202738]">
                <span className="text-[8px] text-slate-500 uppercase font-semibold flex items-center gap-1"><Cpu className="w-2.5 h-2.5" /> Tokens</span>
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
              <span className="text-[9px] font-bold text-slate-500 uppercase tracking-wider block">Execution Steps</span>
              <div className="space-y-2">
                {selectedRun.steps.map((step, idx) => (
                  <div key={idx} className="flex items-start gap-2.5 p-2 rounded bg-[#141822]/60 border border-[#202738] text-[10px] text-slate-300">
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
                  <span className="text-[9px] font-bold text-slate-500 uppercase tracking-wider block">Tool Invocations</span>
                  {selectedRun.toolCalls.map((call, idx) => (
                    <div key={idx} className="flex items-center justify-between p-2 rounded bg-[#141822]/30 border border-[#202738]/50 text-[10px] text-slate-400 font-mono">
                      <span className="truncate pr-4 text-indigo-400">{call.name}</span>
                      <span className="shrink-0 text-slate-600 text-[9px]">{call.duration}</span>
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
