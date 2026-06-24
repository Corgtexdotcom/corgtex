import type { MeetingAgendaItem } from "@corgtex/domain";

export type MeetingTab = "agenda" | "summary" | "raised" | "evidence";

export function hasMeetingAgendaTab(params: {
  agendaExists: boolean;
  status: string;
  recurrenceRule?: string | null;
}) {
  return params.agendaExists || (params.status === "SCHEDULED" && Boolean(params.recurrenceRule));
}

export function normalizeMeetingTab(value: string | string[] | undefined, defaultTab: MeetingTab, allowAgenda: boolean): MeetingTab {
  const candidate = Array.isArray(value) ? value[0] : value;
  if (candidate === "agenda" && allowAgenda) return "agenda";
  if (candidate === "raised" || candidate === "evidence") return candidate;
  return defaultTab;
}

export function meetingTabHref(baseHref: string, tab: MeetingTab) {
  return tab === "summary" ? baseHref : `${baseHref}?tab=${tab}`;
}

export function agendaItemHref(workspaceId: string, item: MeetingAgendaItem) {
  if (!item.sourceType || !item.sourceId) return null;
  if (item.sourceType === "Tension") return `/workspaces/${workspaceId}/tensions/${item.sourceId}`;
  if (item.sourceType === "Proposal") return `/workspaces/${workspaceId}/proposals/${item.sourceId}`;
  if (item.sourceType === "Action") return `/workspaces/${workspaceId}/actions/${item.sourceId}`;
  return null;
}
