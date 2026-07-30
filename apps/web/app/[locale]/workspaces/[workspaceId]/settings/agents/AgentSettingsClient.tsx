"use client";

import { useTransition } from"react";
import {
 toggleAgentAction,
 updateAgentModelAction,
 updateAgentNewspaperScheduleAction,
 updateCompanyUnderstandingGoalApplyModeAction,
} from"./actions";
import type { AgentConfigSummary, CompanyUnderstandingGoalApplyMode, NewspaperWeekday } from"@corgtex/domain";
import type { AgentModelOverrideOption } from "../../agents/model-override-options";
import { useTranslations } from "next-intl";

type NewspaperCadence = "DAILY" | "WEEKLY" | "OFF";

function newspaperCadenceValue(value: unknown): NewspaperCadence {
 return value ==="DAILY" || value ==="OFF" ? value : "WEEKLY";
}

function newspaperWeekdayValue(value: unknown): NewspaperWeekday {
 const weekdays: NewspaperWeekday[] = ["MONDAY","TUESDAY","WEDNESDAY","THURSDAY","FRIDAY","SATURDAY","SUNDAY"];
 return weekdays.includes(value as NewspaperWeekday) ? value as NewspaperWeekday : "MONDAY";
}

function newspaperLocalTimeValue(value: unknown) {
 return typeof value ==="string" && /^\d{2}:\d{2}$/.test(value) ? value : "08:00";
}

function newspaperTimeZoneValue(value: unknown) {
 return typeof value ==="string" && value.trim().length > 0 ? value : "UTC";
}

export function AgentSettingsClient({
 workspaceId,
 agents,
 modelOverrideOptions,
}: {
 workspaceId: string,
 agents: AgentConfigSummary[],
 modelOverrideOptions: AgentModelOverrideOption[],
}) {
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

 const handleNewspaperScheduleChange = (schedule: {
 cadence?: NewspaperCadence;
 weekday?: NewspaperWeekday;
 localTime?: string;
 timeZone?: string;
 }) => {
 startTransition(() => {
 updateAgentNewspaperScheduleAction(workspaceId, schedule);
 });
 };

 const handleGoalApplyModeChange = (mode: string) => {
 startTransition(() => {
 const normalized: CompanyUnderstandingGoalApplyMode = mode ==="MANUAL" ?"MANUAL" :"AUTO";
 updateCompanyUnderstandingGoalApplyModeAction(workspaceId, normalized);
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
 (() => {
 const hasUnsupportedOverride = Boolean(agent.modelOverride)
 && !modelOverrideOptions.some((option) => option.value === agent.modelOverride);
 return (
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
 {hasUnsupportedOverride && agent.modelOverride ? (
 <option value={agent.modelOverride} disabled>{t("optUnsupported", { model: agent.modelOverride })}</option>
 ) : null}
 {modelOverrideOptions.map((option) => (
 <option key={option.value} value={option.value}>{t(option.settingsLabelKey)}</option>
 ))}
 </select>
 </div>

 {agent.agentKey ==="daily-digest" && (
 <div className="flex flex-col items-start lg:items-end gap-2">
 <label className="text-sm font-medium text-text">
 {t("lblNewspaperCadence")}
 </label>
 <select
 disabled={isPending}
 value={newspaperCadenceValue(agent.configJson?.newspaperCadence)}
 onChange={(e) => handleNewspaperScheduleChange({ cadence: newspaperCadenceValue(e.target.value) })}
 className="text-sm border border-line rounded-md bg-surface-strong text-text py-1.5 px-3 disabled:opacity-50"
 >
 <option value="DAILY">{t("newspaperCadenceDaily")}</option>
 <option value="WEEKLY">{t("newspaperCadenceWeekly")}</option>
 <option value="OFF">{t("newspaperCadenceOff")}</option>
 </select>
 <div className="grid grid-cols-1 gap-2 sm:grid-cols-3 lg:grid-cols-1">
 <label className="flex flex-col gap-1 text-xs text-muted">
 {t("newspaperWeekday")}
 <select
 disabled={isPending}
 value={newspaperWeekdayValue(agent.configJson?.newspaperWeekday)}
 onChange={(e) => handleNewspaperScheduleChange({ weekday: newspaperWeekdayValue(e.target.value) })}
 className="text-sm border border-line rounded-md bg-surface-strong text-text py-1.5 px-3 disabled:opacity-50"
 >
 <option value="MONDAY">{t("weekdayMonday")}</option>
 <option value="TUESDAY">{t("weekdayTuesday")}</option>
 <option value="WEDNESDAY">{t("weekdayWednesday")}</option>
 <option value="THURSDAY">{t("weekdayThursday")}</option>
 <option value="FRIDAY">{t("weekdayFriday")}</option>
 <option value="SATURDAY">{t("weekdaySaturday")}</option>
 <option value="SUNDAY">{t("weekdaySunday")}</option>
 </select>
 </label>
 <label className="flex flex-col gap-1 text-xs text-muted">
 {t("newspaperLocalTime")}
 <input
 disabled={isPending}
 type="time"
 defaultValue={newspaperLocalTimeValue(agent.configJson?.newspaperLocalTime)}
 onBlur={(e) => handleNewspaperScheduleChange({ localTime: e.target.value })}
 className="text-sm border border-line rounded-md bg-surface-strong text-text py-1.5 px-3 disabled:opacity-50"
 />
 </label>
 <label className="flex flex-col gap-1 text-xs text-muted">
 {t("newspaperTimeZone")}
 <input
 disabled={isPending}
 type="text"
 defaultValue={newspaperTimeZoneValue(agent.configJson?.newspaperTimeZone)}
 onBlur={(e) => handleNewspaperScheduleChange({ timeZone: e.target.value })}
 className="text-sm border border-line rounded-md bg-surface-strong text-text py-1.5 px-3 disabled:opacity-50"
 />
 </label>
 </div>
 <p className="text-xs text-muted max-w-56 text-left lg:text-right">
 {t("newspaperCadenceAdminHelp")}
 </p>
 </div>
 )}

 {agent.agentKey ==="company-understanding" && (
 <div className="flex flex-col items-start lg:items-end gap-2">
 <label className="text-sm font-medium text-text">
 {t("lblGoalApplyMode")}
 </label>
 <select
 disabled={isPending}
 value={agent.configJson?.goalApplyMode ==="MANUAL" ?"MANUAL" :"AUTO"}
 onChange={(e) => handleGoalApplyModeChange(e.target.value)}
 className="text-sm border border-line rounded-md bg-surface-strong text-text py-1.5 px-3 disabled:opacity-50"
 >
 <option value="AUTO">{t("goalApplyModeAuto")}</option>
 <option value="MANUAL">{t("goalApplyModeManual")}</option>
 </select>
 <p className="text-xs text-muted max-w-64 text-left lg:text-right">
 {t("goalApplyModeHelp")}
 </p>
 </div>
 )}
 </div>

 </div>
 </li>
 );
 })()
 ))}
 </ul>
 </div>
 </div>
);
}
