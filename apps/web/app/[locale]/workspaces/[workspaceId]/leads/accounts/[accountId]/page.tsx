import { requirePageActor } from "@/lib/auth";
import { requireWorkspaceFeature } from "@/lib/workspace-feature-flags";
import { MarkdownEditor } from "@/lib/components/MarkdownEditor";
import { MarkdownRenderer } from "@/lib/components/MarkdownRenderer";
import { normalizeVisibleWorkItemColumns, toggleWorkItemColumnVisibility } from "@/lib/work-item-view";
import { getCrmAccount, listMembers, requireWorkspaceMembership } from "@corgtex/domain";
import { getTranslations } from "next-intl/server";

import {
  createActivityAction,
  createContactAction,
  createDealAction,
  updateCrmAccountAction,
} from "../../actions";
import {
  ACCOUNT_DETAIL_VIEWS,
  CRM_LIFECYCLE_OPTIONS,
  CRM_RELATIONSHIP_OPTIONS,
  activePipelineValueCents,
  labelFromCrmCode,
  normalizeAccountDetailView,
  CRM_DEAL_STAGES,
} from "../../view-model";
import { DealPipelineBoard } from "../../DealPipelineBoard";

export const dynamic = "force-dynamic";

export default async function AccountDetailPage({
  params,
  searchParams,
}: {
  params: Promise<{ locale: string; workspaceId: string; accountId: string }>;
  searchParams?: Promise<Record<string, string | string[] | undefined>>;
}) {
  const { locale, workspaceId, accountId } = await params;
  await requireWorkspaceFeature(workspaceId, "RELATIONSHIPS");
  const actor = await requirePageActor();
  await requireWorkspaceMembership({ actor, workspaceId });
  const t = await getTranslations("leads");
  const tWork = await getTranslations("workItems");
  const resolvedSearch = searchParams ? await searchParams : {};
  const view = normalizeAccountDetailView(resolvedSearch.view);
  const visiblePipelineColumnIds = normalizeVisibleWorkItemColumns(resolvedSearch.columns, CRM_DEAL_STAGES);
  const pipelineColumnHideHrefs = Object.fromEntries(CRM_DEAL_STAGES.map((stage) => {
    const nextColumns = toggleWorkItemColumnVisibility(visiblePipelineColumnIds, stage, CRM_DEAL_STAGES);
    const query = new URLSearchParams({ view: "pipeline" });
    if (nextColumns) query.set("columns", nextColumns.join(","));
    return [stage, `?${query.toString()}`];
  }));
  const [account, members] = await Promise.all([
    getCrmAccount(actor, { workspaceId, accountId }),
    listMembers(workspaceId),
  ]);

  const activeDeals = account.deals.filter((deal) => deal.stage !== "CLOSED_WON" && deal.stage !== "CLOSED_LOST");
  const pipelineValue = activePipelineValueCents(account.deals);

  const formatCurrency = (cents: number) => new Intl.NumberFormat(locale, {
    style: "currency",
    currency: "USD",
    maximumFractionDigits: 0,
  }).format(cents / 100);

  const formatDate = (value: Date | string) => new Intl.DateTimeFormat(locale, {
    month: "short",
    day: "numeric",
    year: "numeric",
  }).format(new Date(value));

  const stageLabels = {
    LEAD: t("stageLead"),
    QUALIFIED: t("stageQualified"),
    PROPOSAL: t("stageProposal"),
    NEGOTIATION: t("stageNegotiate"),
    CLOSED_WON: t("stageWon"),
    CLOSED_LOST: t("stageLost"),
  };

  const relationshipLabelKeys: Record<string, string> = {
    PROSPECT: "relationshipProspect",
    PILOT: "relationshipPilot",
    CLIENT: "relationshipClient",
    PARTNER: "relationshipPartner",
    VENDOR: "relationshipVendor",
    INVESTOR: "relationshipInvestor",
    INTERNAL: "relationshipInternal",
  };

  const lifecycleLabelKeys: Record<string, string> = {
    DISCOVERY: "lifecycleDiscovery",
    QUALIFIED: "lifecycleQualified",
    PILOT: "lifecyclePilot",
    ACTIVE: "lifecycleActive",
    EXPANSION: "lifecycleExpansion",
    PAUSED: "lifecyclePaused",
    CHURNED: "lifecycleChurned",
  };

  const relationshipLabel = (value?: string | null) => {
    if (!value) return t("emptyValue");
    const key = relationshipLabelKeys[value];
    return key ? t(key) : labelFromCrmCode(value);
  };

  const lifecycleLabel = (value?: string | null) => {
    if (!value) return t("emptyValue");
    const key = lifecycleLabelKeys[value];
    return key ? t(key) : labelFromCrmCode(value);
  };

  const detailViewLabels = {
    overview: t("accountTabOverview"),
    contacts: t("tabContacts"),
    pipeline: t("tabPipeline"),
    activity: t("tabActivity"),
    conversations: t("tabConversations"),
    instances: t("tabInstances"),
  };

  const activityIcon = (type: string) => {
    const labels: Record<string, string> = {
      EMAIL: t("activityIconEmail"),
      MEETING: t("activityIconMeeting"),
      CALL: t("activityIconCall"),
      NOTE: t("activityIconNote"),
      TASK: t("activityIconTask"),
    };
    return labels[type] ?? t("activityIconDefault");
  };

  return (
    <>
      <header className="nr-masthead" style={{ textAlign: "left", marginBottom: 32 }}>
        <a href={`/workspaces/${workspaceId}/leads`} className="muted" style={{ fontSize: "0.9rem" }}>
          {t("backToRelationships")}
        </a>
        <div className="row" style={{ alignItems: "flex-start", marginTop: 12 }}>
          <div>
            <h1 style={{ border: "none", padding: 0, margin: 0, fontSize: "2rem" }}>{account.name}</h1>
            <div className="nr-masthead-meta">
              <span>{account.domain || t("noDomain")}</span>
              <span>{relationshipLabel(account.relationshipType)}</span>
              <span>{lifecycleLabel(account.lifecycleStage)}</span>
            </div>
          </div>
        </div>
      </header>

      <section className="ws-section">
        <div className="ws-stat-row">
          <div className="ws-stat-card">
            <strong>{account.contacts.length}</strong>
            <span>{t("statTotalContacts")}</span>
          </div>
          <div className="ws-stat-card">
            <strong>{activeDeals.length}</strong>
            <span>{t("statActiveDeals")}</span>
          </div>
          <div className="ws-stat-card">
            <strong>{formatCurrency(pipelineValue)}</strong>
            <span>{t("statPipelineValue")}</span>
          </div>
          <div className="ws-stat-card">
            <strong>{account.activities.length}</strong>
            <span>{t("statActivities")}</span>
          </div>
        </div>

        <div className="nr-filter-bar">
          {ACCOUNT_DETAIL_VIEWS.map((tab) => (
            <a
              key={tab}
              href={`?view=${tab}`}
              className={`nr-filter-item ${view === tab ? "nr-filter-active" : ""}`}
            >
              {detailViewLabels[tab]}
            </a>
          ))}
        </div>

        {view === "overview" && (
          <div className="stack">
            <div className="item" style={{ padding: 16 }}>
              <div className="row">
                <strong>{t("accountOverview")}</strong>
                <span className="tag">{account.source}</span>
              </div>
              {account.descriptionMd ? (
                <div style={{ marginTop: 12 }}>
                  <MarkdownRenderer markdown={account.descriptionMd} variant="compact" />
                </div>
              ) : (
                <p className="muted">{t("accountNoDescription")}</p>
              )}
              <div className="nr-tag-group" style={{ marginTop: 12 }}>
                <span className="tag-sm">{t("accountCreated", { date: formatDate(account.createdAt) })}</span>
                <span className="tag-sm">{t("accountUpdated", { date: formatDate(account.updatedAt) })}</span>
              </div>
            </div>

            <details>
              <summary className="link-button small" style={{ cursor: "pointer" }}>{t("btnEditAccount")}</summary>
              <form action={updateCrmAccountAction} className="stack nr-form-section" style={{ marginTop: 16 }}>
                <input type="hidden" name="workspaceId" value={workspaceId} />
                <input type="hidden" name="accountId" value={account.id} />
                <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(220px, 1fr))", gap: 16 }}>
                  <label>{t("formAccountName")} <input type="text" name="name" defaultValue={account.name} required /></label>
                  <label>{t("formDomain")} <input type="text" name="domain" defaultValue={account.domain ?? ""} /></label>
                  <label>
                    {t("formRelationshipType")}
                    <select name="relationshipType" defaultValue={account.relationshipType}>
                      {CRM_RELATIONSHIP_OPTIONS.map((option) => (
                        <option key={option} value={option}>{relationshipLabel(option)}</option>
                      ))}
                    </select>
                  </label>
                  <label>
                    {t("formLifecycleStage")}
                    <select name="lifecycleStage" defaultValue={account.lifecycleStage}>
                      {CRM_LIFECYCLE_OPTIONS.map((option) => (
                        <option key={option} value={option}>{lifecycleLabel(option)}</option>
                      ))}
                    </select>
                  </label>
                </div>
                <label>
                  {t("formDescription")}
                  <MarkdownEditor name="descriptionMd" defaultValue={account.descriptionMd ?? ""} rows={4} />
                </label>
                <button type="submit" style={{ width: "fit-content" }}>{t("btnSaveAccount")}</button>
              </form>
            </details>
          </div>
        )}

        {view === "contacts" && (
          <div className="stack">
            <details>
              <summary className="link-button small" style={{ cursor: "pointer" }}>{t("btnNewContact")}</summary>
              <form action={createContactAction} className="stack nr-form-section" style={{ marginTop: 16 }}>
                <input type="hidden" name="workspaceId" value={workspaceId} />
                <input type="hidden" name="accountId" value={account.id} />
                <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(220px, 1fr))", gap: 16 }}>
                  <label>{t("formEmail")} <input type="email" name="email" required /></label>
                  <label>{t("formName")} <input type="text" name="name" /></label>
                  <label>{t("formCompany")} <input type="text" name="company" defaultValue={account.name} /></label>
                  <label>{t("formTitle")} <input type="text" name="title" /></label>
                </div>
                <button type="submit" style={{ width: "fit-content" }}>{t("btnCreateContact")}</button>
              </form>
            </details>

            {account.contacts.length === 0 ? (
              <p className="muted">{t("accountNoContacts")}</p>
            ) : account.contacts.map((contact) => (
              <div key={contact.id} className="item" style={{ padding: 16 }}>
                <div className="row">
                  <strong>{contact.name || t("unknownContact")}</strong>
                  <span className="tag">{contact.source}</span>
                </div>
                <div className="muted" style={{ fontSize: "0.85rem", marginTop: 4 }}>
                  {contact.email}
                  {contact.title ? ` · ${contact.title}` : ""}
                </div>
              </div>
            ))}
          </div>
        )}

        {view === "pipeline" && (
          <div className="stack">
            <details>
              <summary className="link-button small" style={{ cursor: "pointer" }}>{t("btnNewDeal")}</summary>
              <form action={createDealAction} className="stack nr-form-section" style={{ marginTop: 16 }}>
                <input type="hidden" name="workspaceId" value={workspaceId} />
                <input type="hidden" name="accountId" value={account.id} />
                <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(220px, 1fr))", gap: 16 }}>
                  <label>
                    {t("formContact")}
                    <select name="contactId" required>
                      <option value="">{t("selectContact")}</option>
                      {account.contacts.map((contact) => (
                        <option key={contact.id} value={contact.id}>{contact.name || contact.email}</option>
                      ))}
                    </select>
                  </label>
                  <label>{t("formDealTitle")} <input type="text" name="title" required /></label>
                  <label>{t("formValue")} <input type="number" name="value" step="0.01" min="0" /></label>
                  <label>
                    {t("formOwner")}
                    <select name="ownerUserId" defaultValue="">
                      <option value="">{t("selectOwnerOptional")}</option>
                      {members.map((member) => (
                        <option key={member.user.id} value={member.user.id}>
                          {member.user.displayName || member.user.email}
                        </option>
                      ))}
                    </select>
                  </label>
                </div>
                <button type="submit" style={{ width: "fit-content" }}>{t("btnCreateDeal")}</button>
              </form>
            </details>

            <DealPipelineBoard
              workspaceId={workspaceId}
              deals={account.deals}
              members={members}
              locale={locale}
              stageLabels={stageLabels}
              visibleColumnIds={visiblePipelineColumnIds}
              hideColumnHrefs={pipelineColumnHideHrefs}
              storageKey={`relationships:${workspaceId}:account:${account.id}:pipeline`}
              accountFallback={{ id: account.id, name: account.name }}
              labels={{
                account: t("pipelineAccount"),
                contact: t("pipelineContact"),
                emptyStage: t("pipelineNoDealsInStage"),
                noAccount: t("emptyAccount"),
                nextFollowUp: t("pipelineNextFollowUp"),
                noNextFollowUp: t("pipelineNoNextFollowUp"),
                owner: t("pipelineOwner"),
                noOwner: t("pipelineNoOwner"),
                stageAgeToday: t("pipelineStageAgeToday"),
                stageAgeYesterday: t("pipelineStageAgeYesterday"),
                stageAgeDays: (days) => t("pipelineStageAgeDays", { days }),
              }}
              workItemLabels={{
                settingsLabel: tWork("columnSettings"),
                resetLabel: tWork("resetColumns"),
                hideLabel: tWork("hideColumn"),
                moveUpLabel: tWork("moveColumnLeft"),
                moveDownLabel: tWork("moveColumnRight"),
                hideShortLabel: tWork("hideColumnShort"),
                moveUpShortLabel: tWork("moveColumnLeftShort"),
                moveDownShortLabel: tWork("moveColumnRightShort"),
                sortLabel: tWork("sort"),
                sortPriorityLabel: tWork("sortPriority"),
                sortDateLabel: tWork("sortDate"),
                sortAlphaLabel: tWork("sortAlpha"),
                dragUnavailableLabel: tWork("dragUnavailable"),
              }}
            />
          </div>
        )}

        {view === "activity" && (
          <div className="stack">
            <details>
              <summary className="link-button small" style={{ cursor: "pointer" }}>{t("btnNewActivity")}</summary>
              <form action={createActivityAction} className="stack nr-form-section" style={{ marginTop: 16 }}>
                <input type="hidden" name="workspaceId" value={workspaceId} />
                <input type="hidden" name="accountId" value={account.id} />
                <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(220px, 1fr))", gap: 16 }}>
                  <label>{t("formActivityTitle")} <input type="text" name="title" required /></label>
                  <label>
                    {t("formActivityType")}
                    <select name="type" defaultValue="NOTE">
                      <option value="NOTE">{t("activityTypeNote")}</option>
                      <option value="EMAIL">{t("activityTypeEmail")}</option>
                      <option value="MEETING">{t("activityTypeMeeting")}</option>
                      <option value="CALL">{t("activityTypeCall")}</option>
                      <option value="TASK">{t("activityTypeTask")}</option>
                    </select>
                  </label>
                </div>
                <MarkdownEditor name="bodyMd" placeholder={t("formActivityBodyPlaceholder")} rows={3} />
                <button type="submit" style={{ width: "fit-content" }}>{t("btnCreateActivity")}</button>
              </form>
            </details>

            {account.activities.length === 0 ? (
              <p className="muted">{t("accountNoActivity")}</p>
            ) : account.activities.map((activity) => (
              <div key={activity.id} className="item" style={{ display: "flex", gap: 16 }}>
                <div style={{ width: 40, height: 40, borderRadius: "50%", background: "var(--accent-soft)", display: "flex", alignItems: "center", justifyContent: "center", fontSize: "1.2rem", flexShrink: 0 }}>
                  {activityIcon(activity.type)}
                </div>
                <div style={{ minWidth: 0, flex: 1 }}>
                  <div className="row">
                    <strong>{activity.title}</strong>
                    <span className="muted" style={{ fontSize: "0.8rem" }}>{formatDate(activity.createdAt)}</span>
                  </div>
                  {activity.bodyMd && <MarkdownRenderer markdown={activity.bodyMd} variant="compact" />}
                </div>
              </div>
            ))}
          </div>
        )}

        {view === "conversations" && (
          <div className="stack">
            {account.crmConversations.length === 0 ? (
              <p className="muted">{t("accountNoConversations")}</p>
            ) : account.crmConversations.map((conversation) => (
              <div key={conversation.id} className="item" style={{ padding: 16 }}>
                <div className="row">
                  <strong>{conversation.subject || t("untitledConversation")}</strong>
                  <span className="tag">{conversation.status}</span>
                </div>
                {conversation.messages[0] && (
                  <div style={{ marginTop: 12, background: "var(--bg-alt)", padding: 12, borderRadius: 8, fontSize: "0.85rem" }}>
                    <strong>{conversation.messages[0].senderType === "LEAD" ? t("senderLead") : t("senderStaff")}</strong>
                    <MarkdownRenderer markdown={conversation.messages[0].bodyMd} variant="compact" />
                  </div>
                )}
              </div>
            ))}
          </div>
        )}

        {view === "instances" && (
          <div className="stack">
            {account.prospectWorkspaces.length === 0 ? (
              <p className="muted">{t("accountNoInstances")}</p>
            ) : account.prospectWorkspaces.map((prospectWorkspace) => (
              <div key={prospectWorkspace.id} className="item" style={{ padding: 16 }}>
                <div className="row">
                  <strong>{prospectWorkspace.targetWorkspace?.name || t("demoWorkspace")}</strong>
                  <span className="tag">{prospectWorkspace.status}</span>
                </div>
                <div className="muted" style={{ fontSize: "0.85rem", marginTop: 8 }}>
                  <div>{t("instanceAdmin")} {prospectWorkspace.adminEmail}</div>
                  <div>{t("instanceProvisioned")} {formatDate(prospectWorkspace.provisionedAt)}</div>
                </div>
              </div>
            ))}
          </div>
        )}
      </section>
    </>
  );
}
