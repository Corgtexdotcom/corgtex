"use client";

import { useTransition } from "react";
import { toggleAgentAction, updateAgentModelAction } from "./actions";
import type { AgentConfigSummary } from "@corgtex/domain";

export function AgentSettingsClient({ workspaceId, agents }: { workspaceId: string, agents: AgentConfigSummary[] }) {
  const [isPending, startTransition] = useTransition();

  const handleToggle = (agentKey: string, currentEnabled: boolean) => {
    startTransition(() => {
      toggleAgentAction(workspaceId, agentKey, !currentEnabled);
    });
  };

  const handleModelChange = (agentKey: string, modelOverride: string) => {
    startTransition(() => {
      updateAgentModelAction(workspaceId, agentKey, modelOverride === "default" ? null : modelOverride);
    });
  };

  return (
    <div className="space-y-6">
      <div>
        <h2 className="text-2xl font-semibold mb-2">Agent Settings</h2>
        <p className="text-zinc-500 mb-6">Manage AI agents, set model overrides, and monitor cost implications for your workspace.</p>
      </div>

      <div className="bg-white dark:bg-zinc-900 border border-zinc-200 dark:border-zinc-800 rounded-xl overflow-hidden shadow-sm">
        <ul className="divide-y divide-zinc-200 dark:divide-zinc-800">
          {agents.map((agent) => (
            <li key={agent.agentKey} className="p-6 transition-colors hover:bg-zinc-50/50 dark:hover:bg-zinc-800/20">
              <div className="flex flex-col lg:flex-row lg:items-start justify-between gap-6">
                
                {/* Info Column */}
                <div className="space-y-2 flex-grow max-w-2xl">
                  <div className="flex items-center gap-3">
                    <h3 className="text-lg font-medium tracking-tight text-zinc-900 dark:text-zinc-100">{agent.label}</h3>
                    <span className="text-xs px-2 py-0.5 bg-zinc-100 dark:bg-zinc-800 text-zinc-600 dark:text-zinc-400 rounded-full font-mono uppercase">
                      {agent.category}
                    </span>
                    <span className={`text-xs px-2 py-0.5 rounded-full font-medium ${
                      agent.costTier === "free" ? "bg-green-100 text-green-700 dark:bg-green-900/30 dark:text-green-400" :
                      agent.costTier === "low" ? "bg-blue-100 text-blue-700 dark:bg-blue-900/30 dark:text-blue-400" :
                      agent.costTier === "medium" ? "bg-yellow-100 text-yellow-700 dark:bg-yellow-900/30 dark:text-yellow-400" :
                      "bg-red-100 text-red-700 dark:bg-red-900/30 dark:text-red-400"
                    }`}>
                      {agent.costTier} cost
                    </span>
                  </div>
                  
                  <p className="text-sm text-zinc-600 dark:text-zinc-400 leading-relaxed">
                    {agent.description}
                  </p>
                  
                  <div className="text-xs font-mono text-zinc-500 flex flex-wrap gap-x-4 gap-y-1 mt-3">
                    <div className="flex items-center gap-1.5">
                      <span className="text-zinc-400">IN:</span> {agent.inputs.join(", ")}
                    </div>
                    <div className="flex items-center gap-1.5">
                      <span className="text-zinc-400">OUT:</span> {agent.outputs.join(", ")}
                    </div>
                  </div>
                </div>

                {/* Controls Column */}
                <div className="flex flex-row lg:flex-col items-center lg:items-end justify-between gap-4 shrink-0">
                  <div className="flex items-center gap-3">
                    <label className="text-sm font-medium text-zinc-700 dark:text-zinc-300">
                      Status
                    </label>
                    <button
                      type="button"
                      disabled={!agent.canDisable || isPending}
                      onClick={() => handleToggle(agent.agentKey, agent.enabled)}
                      className={`relative inline-flex h-6 w-11 flex-shrink-0 cursor-pointer rounded-full border-2 border-transparent transition-colors duration-200 ease-in-out focus:outline-none focus:ring-2 focus:ring-blue-500 focus:ring-offset-2 disabled:opacity-50 disabled:cursor-not-allowed ${
                        agent.enabled ? "bg-black dark:bg-white" : "bg-zinc-200 dark:bg-zinc-800"
                      }`}
                    >
                      <span className={`pointer-events-none inline-block h-5 w-5 transform rounded-full bg-white dark:bg-zinc-950 shadow ring-0 transition duration-200 ease-in-out ${
                        agent.enabled ? "translate-x-5" : "translate-x-0"
                      }`} />
                    </button>
                  </div>

                  <div className="flex items-center gap-3">
                    <label className="text-sm font-medium text-zinc-700 dark:text-zinc-300">
                      Model
                    </label>
                    <select
                      disabled={agent.defaultModelTier === "none" || isPending}
                      value={agent.modelOverride || "default"}
                      onChange={(e) => handleModelChange(agent.agentKey, e.target.value)}
                      className="text-sm border border-zinc-300 dark:border-zinc-700 rounded-md bg-white dark:bg-zinc-900 text-zinc-900 dark:text-zinc-100 py-1.5 px-3 disabled:opacity-50"
                    >
                      <option value="default">Default ({agent.defaultModelTier})</option>
                      <option value="google/gemma-4-12b-it">Fast (Gemma 12B)</option>
                      <option value="google/gemma-4-31b-it">Standard (Gemma 31B)</option>
                      <option value="google/gemini-2.5-flash">Quality (Gemini 2.5 Flash)</option>
                    </select>
                  </div>
                </div>

              </div>
            </li>
          ))}
        </ul>
      </div>
    </div>
  );
}
