import { requirePageActor } from "@/lib/auth";
import { MarkdownEditor } from "@/lib/components/MarkdownEditor";
import { requireWorkspaceFeature } from "@/lib/workspace-feature-flags";
import {
  listCommunicationSuggestions,
  listContacts,
  listCrmAccounts,
  listDeals,
  listMembers,
  requireWorkspaceMembership,
} from "@corgtex/domain";
import { getTranslations } from "next-intl/server";

import { createCommunicationSuggestionAction } from "../actions";
import { CommunicationSuggestionCard } from "../CommunicationSuggestionCard";
import { CrmChatPageContext } from "../CrmChatPageContext";
import {
  CRM_CHAT_CONTEXT_LIMIT,
  crmFilters,
  crmPageMetrics,
  crmSuggestionContext,
} from "../chat-page-context";
import { relationshipDashboardHref, relationshipFullPageHref } from "../view-model";
import { RelationshipNav, relationshipNavLabels } from "../RelationshipNav";
import {
  CRM_FULL_PAGE_SIZE,
  crmPageCount,
  crmPageHref,
  crmPageOffset,
  normalizeCrmPage,
  optionValue,
  type SearchParamsRecord,
} from "../full-page-utils";

export const dynamic = "force-dynamic";

const SUGGESTION_STATUSES = ["SUGGESTED", "REQUESTED", "SENT", "DECLINED", "FAILED"] as const;

export default async function RelationshipSuggestionsPage({
  params,
  searchParams,
}: {
  params: Promise<{ locale: string; workspaceId: string }>;
  searchParams?: Promise<SearchParamsRecord>;
}) {
  const { locale, workspaceId } = await params;
  await requireWorkspaceFeature(workspaceId, "RELATIONSHIPS");
  const actor = await requirePageActor();
  await requireWorkspaceMembership({ actor, workspaceId });
  const t = await getTranslations("leads");
  const resolvedSearch = searchParams ? await searchParams : {};
  const page = normalizeCrmPage(resolvedSearch.page);
  const status = optionValue(resolvedSearch.status, SUGGESTION_STATUSES);
  const pagePath = relationshipFullPageHref(workspaceId, "suggestions");

  const [suggestionResult, accountResult, contactResult, dealResult, members] = await Promise.all([
    listCommunicationSuggestions(actor, workspaceId, {
      take: CRM_FULL_PAGE_SIZE,
      skip: crmPageOffset(page),
      status,
    }),
    listCrmAccounts(actor, workspaceId, { take: 200 }),
    listContacts(actor, workspaceId, { take: 200 }),
    listDeals(actor, workspaceId, { take: 200 }),
    listMembers(workspaceId),
  ]);

  const formatDate = (value: Date | string) => new Intl.DateTimeFormat(locale, {
    month: "short",
    day: "numeric",
    year: "numeric",
  }).format(new Date(value));
  const communicationStatusLabels = {
    SUGGESTED: t("suggestionStatusSuggested"),
    REQUESTED: t("suggestionStatusRequested"),
    SENT: t("suggestionStatusSent"),
    DECLINED: t("suggestionStatusDeclined"),
    FAILED: t("suggestionStatusFailed"),
  };
  const communicationCardLabels = {
    title: t("formSuggestionTitle"),
    status: communicationStatusLabels,
    recipient: t("formSuggestionRecipient"),
    subject: t("formSuggestionSubject"),
    body: t("formSuggestionBody"),
    source: t("colSource"),
    account: t("pipelineAccount"),
    contact: t("pipelineContact"),
    deal: t("activityDeal"),
    noRecipient: t("suggestionNoRecipient"),
    noSubject: t("suggestionNoSubject"),
    copyDraft: t("suggestionCopyDraft"),
    edit: t("btnEditSuggestion"),
    save: t("btnSaveSuggestion"),
    requestExecution: t("btnRequestExternalExecution"),
    markSent: t("btnMarkSuggestionSent"),
    decline: t("btnDeclineSuggestion"),
    failureReason: t("formFailureReason"),
    fail: t("btnFailSuggestion"),
    requestedAt: t("suggestionRequestedAt"),
    sentAt: t("suggestionSentAt"),
    declinedAt: t("suggestionDeclinedAt"),
    failedAt: t("suggestionFailedAt"),
    externalExecutionNote: t("suggestionExternalExecutionNote"),
  };
  const pageCount = crmPageCount(suggestionResult.total);
  const previousHref = crmPageHref(pagePath, resolvedSearch, { page: Math.max(page - 1, 1) });
  const nextHref = crmPageHref(pagePath, resolvedSearch, { page: Math.min(page + 1, pageCount) });
  const crmChatPageContext = {
    surface: "crm" as const,
    workspaceId,
    view: "suggestions",
    section: "suggestions",
    selectedIds: {},
    filters: crmFilters({ status, page }),
    pagination: { page, pageCount, total: suggestionResult.total },
    visibleContext: {
      metrics: crmPageMetrics([
        { label: "suggestionsVisible", value: suggestionResult.items.length },
        { label: "suggestionsTotal", value: suggestionResult.total },
      ]),
      suggestions: suggestionResult.items
        .slice(0, CRM_CHAT_CONTEXT_LIMIT)
        .map((suggestion) => crmSuggestionContext(workspaceId, suggestion)),
    },
  };

  return (
    <>
      <CrmChatPageContext context={crmChatPageContext} />
      <header className="nr-masthead" style={{ textAlign: "left", marginBottom: 32 }}>
        <a href={relationshipDashboardHref(workspaceId)} className="muted" style={{ fontSize: "0.9rem" }}>
          {t("backToRelationships")}
        </a>
        <h1 style={{ border: "none", padding: 0, margin: "12px 0 0", fontSize: "2rem" }}>{t("fullSuggestionsTitle")}</h1>
        <div className="nr-masthead-meta"><span>{t("fullSuggestionsDescription")}</span></div>
      </header>

      <section className="ws-section">
        <RelationshipNav workspaceId={workspaceId} active="suggestions" labels={relationshipNavLabels(t)} />

        <form method="get" className="nr-form-section" style={{ marginBottom: 20 }}>
          <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(180px, 1fr))", gap: 12 }}>
            <label>
              {t("filterStatus")}
              <select name="status" defaultValue={status ?? ""}>
                <option value="">{t("statusAll")}</option>
                {SUGGESTION_STATUSES.map((option) => (
                  <option key={option} value={option}>{communicationStatusLabels[option]}</option>
                ))}
              </select>
            </label>
          </div>
          <div className="row" style={{ justifyContent: "flex-start", gap: 8, marginTop: 12 }}>
            <button type="submit" className="small">{t("filterApply")}</button>
            <a href={pagePath} className="link-button small">{t("filterClear")}</a>
          </div>
        </form>

        <details style={{ marginBottom: 20 }}>
          <summary className="link-button small" style={{ cursor: "pointer", width: "fit-content" }}>
            {t("btnNewSuggestion")}
          </summary>
          <form action={createCommunicationSuggestionAction} className="stack nr-form-section" style={{ marginTop: 16 }}>
            <input type="hidden" name="workspaceId" value={workspaceId} />
            <input type="hidden" name="channel" value="EMAIL" />
            <input type="hidden" name="source" value="manual" />
            <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(220px, 1fr))", gap: 16 }}>
              <label>{t("formAccount")} <select name="accountId" required><option value="">{t("selectAccount")}</option>{accountResult.items.map((account) => <option key={account.id} value={account.id}>{account.name}</option>)}</select></label>
              <label>{t("formContact")} <select name="contactId" defaultValue=""><option value="">{t("selectContactOptional")}</option>{contactResult.items.map((contact) => <option key={contact.id} value={contact.id}>{contact.name || contact.email}</option>)}</select></label>
              <label>{t("activityDeal")} <select name="dealId" defaultValue=""><option value="">{t("selectDealOptional")}</option>{dealResult.items.map((deal) => <option key={deal.id} value={deal.id}>{deal.title}</option>)}</select></label>
              <label>{t("formOwner")} <select name="ownerUserId" defaultValue=""><option value="">{t("selectOwnerOptional")}</option>{members.map((member) => <option key={member.user.id} value={member.user.id}>{member.user.displayName || member.user.email}</option>)}</select></label>
              <label>{t("formSuggestionTitle")} <input name="title" required /></label>
              <label>{t("formSuggestionRecipient")} <input type="email" name="recipientEmail" /></label>
              <label>{t("formSuggestionSubject")} <input name="subject" /></label>
            </div>
            <label>{t("formSuggestionBody")} <MarkdownEditor name="bodyMd" placeholder={t("formSuggestionBodyPlaceholder")} rows={5} required /></label>
            <button type="submit" style={{ width: "fit-content" }}>{t("btnCreateSuggestion")}</button>
          </form>
        </details>

        <div className="stack">
          {suggestionResult.items.length === 0 ? (
            <p className="muted">{t("noSuggestions")}</p>
          ) : suggestionResult.items.map((suggestion) => (
            <CommunicationSuggestionCard
              key={suggestion.id}
              workspaceId={workspaceId}
              suggestion={suggestion}
              labels={communicationCardLabels}
              formatDate={formatDate}
            />
          ))}
        </div>

        <div className="row" style={{ marginTop: 16, fontSize: "0.85rem" }}>
          <span className="muted">{t("paginationSummary", { page, pageCount, count: suggestionResult.items.length, total: suggestionResult.total })}</span>
          <div className="row" style={{ gap: 8 }}>
            {page > 1 ? <a href={previousHref} className="link-button small">{t("paginationPrevious")}</a> : <span className="tag-sm">{t("paginationPrevious")}</span>}
            {page < pageCount ? <a href={nextHref} className="link-button small">{t("paginationNext")}</a> : <span className="tag-sm">{t("paginationNext")}</span>}
          </div>
        </div>
      </section>
    </>
  );
}
