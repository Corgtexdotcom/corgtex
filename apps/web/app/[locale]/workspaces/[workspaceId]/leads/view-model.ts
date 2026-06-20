export const RELATIONSHIP_VIEWS = [
  "dashboard",
  "accounts",
  "contacts",
  "pipeline",
  "activity",
  "suggestions",
  "review",
  "conversations",
  "instances",
] as const;

export type RelationshipView = (typeof RELATIONSHIP_VIEWS)[number];

export const RELATIONSHIP_FULL_PAGE_VIEWS = [
  "accounts",
  "pipeline",
  "activity",
  "suggestions",
] as const;

export type RelationshipFullPageView = (typeof RELATIONSHIP_FULL_PAGE_VIEWS)[number];

export const ACCOUNT_DETAIL_VIEWS = [
  "overview",
  "contacts",
  "pipeline",
  "activity",
  "suggestions",
  "conversations",
  "instances",
] as const;

export type AccountDetailView = (typeof ACCOUNT_DETAIL_VIEWS)[number];

export const CRM_DEAL_STAGES = [
  "LEAD",
  "QUALIFIED",
  "PROPOSAL",
  "NEGOTIATION",
  "CLOSED_WON",
  "CLOSED_LOST",
] as const;

export const CRM_CREATABLE_DEAL_STAGES = [
  "LEAD",
  "QUALIFIED",
  "PROPOSAL",
  "NEGOTIATION",
] as const;

export const CRM_ACTIVITY_TYPES = ["NOTE", "EMAIL", "CALL", "MEETING", "TASK"] as const;

export const CRM_RELATIONSHIP_OPTIONS = [
  "PROSPECT",
  "PILOT",
  "CLIENT",
  "PARTNER",
  "VENDOR",
  "INVESTOR",
  "INTERNAL",
] as const;

export const CRM_LIFECYCLE_OPTIONS = [
  "DISCOVERY",
  "QUALIFIED",
  "PILOT",
  "ACTIVE",
  "EXPANSION",
  "PAUSED",
  "CHURNED",
] as const;

export function normalizeRelationshipView(value: string | string[] | undefined): RelationshipView {
  const candidate = Array.isArray(value) ? value[0] : value;
  return RELATIONSHIP_VIEWS.includes(candidate as RelationshipView)
    ? candidate as RelationshipView
    : "dashboard";
}

export function normalizeAccountDetailView(value: string | string[] | undefined): AccountDetailView {
  const candidate = Array.isArray(value) ? value[0] : value;
  return ACCOUNT_DETAIL_VIEWS.includes(candidate as AccountDetailView)
    ? candidate as AccountDetailView
    : "overview";
}

export function accountHref(workspaceId: string, accountId: string) {
  return `/workspaces/${workspaceId}/leads/accounts/${accountId}`;
}

export function relationshipDashboardHref(workspaceId: string) {
  return `/workspaces/${workspaceId}/leads`;
}

export function relationshipFullPageHref(workspaceId: string, view: RelationshipFullPageView) {
  return `/workspaces/${workspaceId}/leads/${view}`;
}

export function relationshipViewHref(workspaceId: string, view: RelationshipView) {
  if (view === "dashboard") return relationshipDashboardHref(workspaceId);
  if (RELATIONSHIP_FULL_PAGE_VIEWS.includes(view as RelationshipFullPageView)) {
    return relationshipFullPageHref(workspaceId, view as RelationshipFullPageView);
  }
  return `/workspaces/${workspaceId}/leads?view=${view}`;
}

export function labelFromCrmCode(value?: string | null) {
  if (!value) return "";
  return value
    .toLowerCase()
    .split("_")
    .filter(Boolean)
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(" ");
}

export function activePipelineValueCents(deals: Array<{ stage: string; valueCents?: number | null }>) {
  return deals
    .filter((deal) => deal.stage !== "CLOSED_WON" && deal.stage !== "CLOSED_LOST")
    .reduce((sum, deal) => sum + (deal.valueCents ?? 0), 0);
}
