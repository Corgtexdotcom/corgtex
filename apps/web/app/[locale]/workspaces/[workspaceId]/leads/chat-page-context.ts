import { accountHref } from "./view-model";

export const CRM_CHAT_CONTEXT_LIMIT = 12;

type AccountLike = { id: string; name: string; domain?: string | null; relationshipType?: string | null; lifecycleStage?: string | null; archivedAt?: Date | string | null };
type ContactLike = { id: string; name?: string | null; email?: string | null; title?: string | null; accountId?: string | null; account?: AccountLike | null };
type DealLike = { id: string; title: string; stage?: string | null; accountId?: string | null; account?: AccountLike | null; contactId?: string | null; contact?: ContactLike | null; valueCents?: number | null; ownerUserId?: string | null };
type ActivityLike = { id: string; title: string; type?: string | null; accountId?: string | null; account?: AccountLike | null; contactId?: string | null; contact?: ContactLike | null; dealId?: string | null; deal?: DealLike | null; dueAt?: Date | string | null; completedAt?: Date | string | null; ownerUserId?: string | null };
type SuggestionLike = { id: string; title: string; status?: string | null; accountId?: string | null; account?: AccountLike | null; contactId?: string | null; contact?: ContactLike | null; dealId?: string | null; deal?: DealLike | null; recipientEmail?: string | null; subject?: string | null };

function contactName(contact?: ContactLike | null) {
  return contact?.name || contact?.email || null;
}
function dateString(value: Date | string | null | undefined) {
  const date = value ? value instanceof Date ? value : new Date(value) : null;
  return date && !Number.isNaN(date.getTime()) ? date.toISOString() : null;
}
export function crmFilters(filters: Record<string, string | number | boolean | null | undefined>) {
  return Object.fromEntries(Object.entries(filters)
    .filter(([, value]) => value !== null && value !== undefined && String(value).length > 0)
    .slice(0, CRM_CHAT_CONTEXT_LIMIT)
    .map(([key, value]) => [key, String(value)]));
}
export function crmPageMetrics(metrics: Array<{ label: string; value: string | number; detail?: string | null }>) {
  return metrics.slice(0, CRM_CHAT_CONTEXT_LIMIT).map((metric) => ({ label: metric.label, value: String(metric.value), detail: metric.detail ?? null }));
}
export function crmAccountContext(workspaceId: string, account: AccountLike) {
  return {
    id: account.id,
    name: account.name,
    domain: account.domain ?? null,
    relationshipType: account.relationshipType ?? null,
    lifecycleStage: account.lifecycleStage ?? null,
    webUrl: accountHref(workspaceId, account.id),
  };
}
export function crmContactContext(workspaceId: string, contact: ContactLike) {
  const accountId = contact.accountId ?? contact.account?.id ?? null;
  const accountArchived = Boolean(contact.account?.archivedAt);
  return {
    id: contact.id,
    name: contact.name ?? null,
    email: contact.email ?? null,
    title: contact.title ?? null,
    accountId,
    accountName: contact.account?.name ?? null,
    webUrl: accountId && !accountArchived ? accountHref(workspaceId, accountId) : null,
  };
}
export function crmDealContext(workspaceId: string, deal: DealLike) {
  const accountId = deal.accountId ?? deal.account?.id ?? null;
  const accountArchived = Boolean(deal.account?.archivedAt);
  return {
    id: deal.id,
    title: deal.title,
    stage: deal.stage ?? null,
    accountId,
    accountName: deal.account?.name ?? null,
    contactId: deal.contactId ?? deal.contact?.id ?? null,
    contactName: contactName(deal.contact),
    valueCents: deal.valueCents ?? null,
    ownerUserId: deal.ownerUserId ?? null,
    webUrl: accountId && !accountArchived ? `${accountHref(workspaceId, accountId)}?view=pipeline` : null,
  };
}
export function crmActivityContext(workspaceId: string, activity: ActivityLike) {
  const accountId = activity.accountId ?? activity.account?.id ?? null;
  return {
    id: activity.id,
    title: activity.title,
    type: activity.type ?? null,
    accountId,
    accountName: activity.account?.name ?? null,
    contactId: activity.contactId ?? activity.contact?.id ?? null,
    contactName: contactName(activity.contact),
    dealId: activity.dealId ?? activity.deal?.id ?? null,
    dealTitle: activity.deal?.title ?? null,
    dueAt: dateString(activity.dueAt),
    completedAt: dateString(activity.completedAt),
    ownerUserId: activity.ownerUserId ?? null,
    webUrl: accountId ? `${accountHref(workspaceId, accountId)}?view=activity` : null,
  };
}
export function crmSuggestionContext(workspaceId: string, suggestion: SuggestionLike) {
  const accountId = suggestion.accountId ?? suggestion.account?.id ?? null;
  return {
    id: suggestion.id,
    title: suggestion.title,
    status: suggestion.status ?? null,
    accountId,
    accountName: suggestion.account?.name ?? null,
    contactId: suggestion.contactId ?? suggestion.contact?.id ?? null,
    contactName: contactName(suggestion.contact),
    dealId: suggestion.dealId ?? suggestion.deal?.id ?? null,
    dealTitle: suggestion.deal?.title ?? null,
    recipientEmail: suggestion.recipientEmail ?? suggestion.contact?.email ?? null,
    subject: suggestion.subject ?? null,
    webUrl: accountId ? `${accountHref(workspaceId, accountId)}?view=suggestions` : null,
  };
}
