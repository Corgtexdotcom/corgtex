"use client";

import { useState } from "react";
import {
  Bot,
  CheckCircle,
  AlertTriangle,
  Play,
  TrendingUp,
  Cpu,
  Search,
  DollarSign,
  ArrowRight,
  Clock,
  Code,
  X,
  FileText,
} from "lucide-react";
import { cn } from "@/lib/utils";

interface Agent {
  id: string;
  name: string;
  workspaceName: string;
  workspaceSlug: string;
  status: string;
  modelTier: string;
  modelOverride: string;
  runsCount: number;
  costMtd: string;
  lastRun: string;
}

interface Run {
  id: string;
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

interface ObservatoryProps {
  agents: Agent[];
  runs: Run[];
  workspaces: Array<{ id: string; name: string; slug: string }>;
}

export function AgentObservatoryClient({ agents, runs, workspaces }: ObservatoryProps) {
  const [search, setSearch] = useState("");
  const [selectedWorkspace, setSelectedWorkspace] = useState("");
  const [selectedStatus, setSelectedStatus] = useState("");
  const [selectedRun, setSelectedRun] = useState<Run | null>(null); // Active trace drawer

  // Filter logic
  const filteredAgents = agents.filter((agent) => {
    const matchesSearch = agent.name.toLowerCase().includes(search.toLowerCase());
    const matchesWorkspace = selectedWorkspace === "" || agent.workspaceSlug === selectedWorkspace;
    const matchesStatus = selectedStatus === "" || agent.status === selectedStatus;
    return matchesSearch && matchesWorkspace && matchesStatus;
  });

  return (
    <div className="space-y-6">
      
      {/* Metrics Row */}
      <div className="grid grid-cols-2 lg:grid-cols-4 gap-4">
        {[
          { title: "Total Agents", value: agents.length, detail: "across active instances", icon: Bot, tone: "text-slate-400" },
          { title: "Success Rate", value: "98.4%", detail: "last 30d operations", icon: CheckCircle, tone: "text-emerald-400" },
          { title: "30d Model Spend", value: "$114.95", detail: "aggregated API costs", icon: DollarSign, tone: "text-indigo-400" },
          { title: "Call Volume", value: "1,862", tone: "text-brand-400", detail: "LLM completions MTD", icon: Cpu },
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
                value={selectedWorkspace}
                onChange={(e) => setSelectedWorkspace(e.target.value)}
                className="bg-[#141822] border border-[#202738] text-xs text-slate-400 rounded-lg px-2 py-1.5 focus:outline-none"
              >
                <option value="">Any Customer</option>
                {workspaces.map((ws) => (
                  <option key={ws.slug} value={ws.slug}>{ws.name}</option>
                ))}
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
                  <th className="p-3">Runs (MTD)</th>
                  <th className="p-3 text-right">Gasto (MTD)</th>
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
                      <span className="text-slate-300 font-semibold block">{agent.workspaceName}</span>
                      <span className="text-[9px] text-slate-500 block mt-0.5">slug: {agent.workspaceSlug}</span>
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
            {runs.map((run) => (
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
                  <span>Tokens: {run.tokens}</span>
                  <span className="font-semibold text-slate-400">{run.cost}</span>
                </div>
                <span className="text-[8px] text-slate-600 block mt-1">Started {run.timestamp}</span>
              </button>
            ))}
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
