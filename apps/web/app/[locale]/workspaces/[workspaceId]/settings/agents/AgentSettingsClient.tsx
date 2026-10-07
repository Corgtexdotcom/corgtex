"use client";

import { useState, useTransition } from"react";
import {
 toggleAgentAction,
 updateAgentModelAction,
 updateAgentNewspaperScheduleAction,
 updateSlackNudgeWindowAction,
 updateCompanyUnderstandingGoalApplyModeAction,
} from"./actions";
import type { AgentConfigSummary, CompanyUnderstandingGoalApplyMode, NewspaperWeekday, SlackNudgeWindow } from"@corgtex/domain";
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

function SlackNudgeWindowSettings({ workspaceId, savedWindow }: {
 workspaceId: string;
 savedWindow: SlackNudgeWindow | null;
}) {
 const t = useTranslations("settings");
 const [isPending, startTransition] = useTransition();
 const [timeZone, setTimeZone] = useState(savedWindow?.timeZone ?? "");
 const [weekdays, setWeekdays] = useState(savedWindow?.weekdays ?? [1, 2, 3, 4, 5]);
 const [startLocalTime, setStartLocalTime] = useState(savedWindow?.startLocalTime ?? "09:00");
 const [endLocalTime, setEndLocalTime] = useState(savedWindow?.endLocalTime ?? "17:00");
 const [activeWindow, setActiveWindow] = useState(savedWindow !== null);
 const [error, setError] = useState(false);
 const minuteOfDay = (value: string) => {
  if (!/^([01]\d|2[0-3]):[0-5]\d$/.test(value)) return NaN;
  const [hour, minute] = value.split(":").map(Number);
  return hour * 60 + minute;
 };
 const windowMinutes = minuteOfDay(endLocalTime) - minuteOfDay(startLocalTime);
 const weekdayLabels = ["weekdayMonday", "weekdayTuesday", "weekdayWednesday", "weekdayThursday", "weekdayFriday", "weekdaySaturday", "weekdaySunday"] as const;
 const save = () => startTransition(async () => {
  try { await updateSlackNudgeWindowAction(workspaceId, { timeZone, weekdays, startLocalTime, endLocalTime }); setActiveWindow(true); setError(false); }
  catch { setError(true); }
 });
 const clear = () => startTransition(async () => {
  try { await updateSlackNudgeWindowAction(workspaceId, null); setActiveWindow(false); setError(false); }
  catch { setError(true); }
 });
 return <div className="flex flex-col items-start lg:items-end gap-2 w-full max-w-72">
  <label className="text-sm font-medium text-text">{t("slackNudgeWindow")}</label>
  <p className="text-xs text-muted text-left lg:text-right">{t("slackNudgeWindowHelp")}</p>
  <label className="flex flex-col gap-1 text-xs text-muted w-full">
   {t("newspaperTimeZone")}
   <input type="text" required disabled={isPending} value={timeZone} onChange={(e) => setTimeZone(e.target.value)} placeholder="America/Toronto" className="text-sm border border-line rounded-md bg-surface-strong text-text py-1.5 px-3" />
  </label>
  <div className="flex flex-col gap-2 w-full">
   <label className="flex flex-col gap-1 text-xs text-muted min-w-0 w-full">{t("slackNudgeStart")}<input type="time" required disabled={isPending} value={startLocalTime} onChange={(e) => setStartLocalTime(e.target.value)} className="w-full min-w-0 text-sm border border-line rounded-md bg-surface-strong text-text py-1.5 px-3" /></label>
   <label className="flex flex-col gap-1 text-xs text-muted min-w-0 w-full">{t("slackNudgeEnd")}<input type="time" required disabled={isPending} value={endLocalTime} onChange={(e) => setEndLocalTime(e.target.value)} className="w-full min-w-0 text-sm border border-line rounded-md bg-surface-strong text-text py-1.5 px-3" /></label>
  </div>
  <div className="flex flex-wrap gap-2 justify-start lg:justify-end">
   {weekdayLabels.map((label, index) => <label key={label} className="flex items-center gap-1 text-xs text-muted">
    <input type="checkbox" disabled={isPending} checked={weekdays.includes(index + 1)} onChange={(e) => setWeekdays((days) => e.target.checked ? [...days, index + 1].sort() : days.filter((day) => day !== index + 1))} className="h-4 w-4 shrink-0" />
    {t(label)}
   </label>)}
  </div>
  <div className="flex gap-2">
   <button type="button" disabled={isPending || !timeZone.trim() || !weekdays.length || !Number.isFinite(windowMinutes) || windowMinutes < 60} onClick={save} className="text-sm border border-line rounded-md px-3 py-1.5 disabled:opacity-50">{t("slackNudgeSave")}</button>
   {activeWindow && <button type="button" disabled={isPending} onClick={clear} className="text-sm border border-line rounded-md px-3 py-1.5 disabled:opacity-50">{t("slackNudgeRemove")}</button>}
  </div>
  {error && <p role="alert" className="text-xs text-red-700">{t("slackNudgeSaveError")}</p>}
 </div>;
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
 <div className={`flex justify-between gap-4 ${agent.agentKey === "slack-agent" ? "flex-col items-stretch lg:items-end w-full lg:w-auto" : "flex-row lg:flex-col items-center lg:items-end shrink-0"}`}>
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

 {agent.agentKey ==="slack-agent" && (
  <SlackNudgeWindowSettings workspaceId={workspaceId} savedWindow={agent.configJson?.proactiveNudgeWindow ?? null} />
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
