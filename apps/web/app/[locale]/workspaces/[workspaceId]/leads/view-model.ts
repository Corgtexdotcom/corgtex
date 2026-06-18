export const RELATIONSHIP_VIEWS = [
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
    : "accounts";
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
