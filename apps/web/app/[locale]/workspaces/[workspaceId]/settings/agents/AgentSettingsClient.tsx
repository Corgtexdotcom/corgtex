"use client";

import { useTransition } from"react";
import { toggleAgentAction, updateAgentModelAction } from"./actions";
import type { AgentConfigSummary } from"@corgtex/domain";
import { useTranslations } from "next-intl";

export function AgentSettingsClient({ workspaceId, agents }: { workspaceId: string, agents: AgentConfigSummary[] }) {
 const [isPending, startTransition] = useTransition();
 const t = useTranslations("settings");

 const handleToggle = (agentKey: string, currentEnabled: boolean) => {
 startTransition(() => {
 toggleAgentAction(workspaceId, agentKey, !currentEnabled);
 });
 };

 const handleModelChange = (agentKey: string, modelOverride: string) => {
 startTransition(() => {
 updateAgentModelAction(workspaceId, agentKey, modelOverride ==="default" ? null : modelOverride);
 });
 };

 return (
 <div className="space-y-6">
 <div>
 <h2 className="text-2xl font-semibold mb-2">{t("titleAgentSettings")}</h2>
 <p className="text-muted mb-6">{t("descAgentSettings")}</p>
 </div>

 <div className="bg-surface-strong border border-line rounded-xl overflow-hidden shadow-sm">
 <ul className="divide-y divide-line">
 {agents.map((agent) => (
 <li key={agent.agentKey} className="p-6 transition-colors hover:bg-surface-sunken/50">
 <div className="flex flex-col lg:flex-row lg:items-start justify-between gap-6">
 
 {/* Info Column */}
 <div className="space-y-2 flex-grow max-w-2xl">
 <div className="flex items-center gap-3">
 <h3 className="text-lg font-medium tracking-tight text-text">{agent.label}</h3>
 <span className="text-xs px-2 py-0.5 bg-accent-soft text-muted rounded-full font-mono uppercase">
 {agent.category}
 </span>
 <span className={`text-xs px-2 py-0.5 rounded-full font-medium ${
 agent.costTier ==="free" ?"bg-green-100 text-green-700" :
 agent.costTier ==="low" ?"bg-blue-100 text-blue-700" :
 agent.costTier ==="medium" ?"bg-yellow-100 text-yellow-700" :
 "bg-red-100 text-red-700"
 }`}>
 {t("lblCost", { tier: agent.costTier })}
 </span>
 </div>
 
 <p className="text-sm text-muted leading-relaxed">
 {agent.description}
 </p>
 
 <div className="text-xs font-mono text-muted flex flex-wrap gap-x-4 gap-y-1 mt-3">
 <div className="flex items-center gap-1.5">
 <span className="text-muted">{t("lblIn")}</span> {agent.inputs.join(",")}
 </div>
 <div className="flex items-center gap-1.5">
 <span className="text-muted">{t("lblOut")}</span> {agent.outputs.join(",")}
 </div>
 </div>
 </div>

 {/* Controls Column */}
 <div className="flex flex-row lg:flex-col items-center lg:items-end justify-between gap-4 shrink-0">
 <div className="flex items-center gap-3">
 <label className="text-sm font-medium text-text">
 {t("lblStatus")}
 </label>
 <button
 type="button"
 disabled={!agent.canDisable || isPending}
 onClick={() => handleToggle(agent.agentKey, agent.enabled)}
 className={`relative inline-flex h-6 w-11 flex-shrink-0 cursor-pointer rounded-full border-2 border-transparent transition-colors duration-200 ease-in-out focus:outline-none focus:ring-2 focus:ring-blue-500 focus:ring-offset-2 disabled:opacity-50 disabled:cursor-not-allowed ${
 agent.enabled ?"bg-black" :"bg-accent-soft"
 }`}
 >
 <span className={`pointer-events-none inline-block h-5 w-5 transform rounded-full bg-surface-strong shadow ring-0 transition duration-200 ease-in-out ${
 agent.enabled ?"translate-x-5" :"translate-x-0"
 }`} />
 </button>
 </div>

 <div className="flex items-center gap-3">
 <label className="text-sm font-medium text-text">
 {t("lblModel")}
 </label>
 <select
 disabled={agent.defaultModelTier ==="none" || isPending}
 value={agent.modelOverride ||"default"}
 onChange={(e) => handleModelChange(agent.agentKey, e.target.value)}
 className="text-sm border border-line rounded-md bg-surface-strong text-text py-1.5 px-3 disabled:opacity-50"
 >
 <option value="default">{t("lblDefault")} ({agent.defaultModelTier})</option>
 <option value="google/gemma-4-12b-it">{t("optFast")} (Gemma 12B)</option>
 <option value="google/gemma-4-31b-it">{t("optStandard")} (Gemma 31B)</option>
 <option value="google/gemini-2.5-flash">{t("optQuality")} (Gemini 2.5 Flash)</option>
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
