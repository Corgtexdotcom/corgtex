import { listActions, listProposals, requireWorkspaceMembership } from "@corgtex/domain";
import { requirePageActor } from "@/lib/auth";
import {
  createActionAction,
  updateActionAction,
  deleteActionAction,
  publishActionAction,
  returnActionToDraftAction,
} from "../actions";
import { getTranslations } from "next-intl/server";
import {
  ACTION_STATUS_FILTERS,
  ACTION_STATUS_META,
  groupActionsByStatus,
  normalizeActionStatusFilter,
} from "./view-model";
import { MarkdownEditor } from "@/lib/components/MarkdownEditor";
import { MarkdownExcerpt } from "@/lib/components/MarkdownRenderer";
import { ItemActions } from "@/lib/components/ui/ItemActions";

export const dynamic = "force-dynamic";

export default async function ActionsPage({
  params,
  searchParams,
}: {
  params: Promise<{ workspaceId: string }>;
  searchParams?: Promise<Record<string, string | string[] | undefined>>;
}) {
  const { workspaceId } = await params;
  const actor = await requirePageActor();
  const t = await getTranslations("actions");
  const tCommon = await getTranslations("common");
  const membership = await requireWorkspaceMembership({ actor, workspaceId });
  const [{ items: actions }, { items: proposals }] = await Promise.all([
    listActions(actor, workspaceId, { take: 50 }),
    listProposals(actor, workspaceId, { take: 50 }),
  ]);
  
  const activeProposals = proposals.filter(p => p.status === "DRAFT" || p.status === "OPEN");

  const resolvedSearch = searchParams ? await searchParams : {};
  const statusFilter = normalizeActionStatusFilter(resolvedSearch.status);
  const groupedActions = groupActionsByStatus(actions);
  const displayActions = groupedActions[statusFilter];
  const canManageAction = (action: { authorUserId: string }) => actor.kind === "agent"
    || membership?.role === "ADMIN"
    || (actor.kind === "user" && action.authorUserId === actor.user.id);

  const ageText = (date: Date) => {
    const timestamp = new Date(date).getTime();
    if (Number.isNaN(timestamp)) return "";
    const days = Math.floor((Date.now() - timestamp) / (1000 * 60 * 60 * 24));
    if (days === 0) return t("ageToday");
    if (days === 1) return t("ageYesterday");
    return t("ageDaysAgo", { count: days });
  };

  return (
    <>
      <header className="nr-masthead" style={{ textAlign: "left", marginBottom: 32 }}>
        <h1 style={{ border: "none", padding: 0, margin: 0, fontSize: "2rem" }}>{t("pageTitle")}</h1>
        <div className="nr-masthead-meta">
          <span>{t("pageDescription")}</span>
        </div>
      </header>

      <section className="ws-section">
        <div className="nr-filter-bar nr-filter-bar-wrap">
          {ACTION_STATUS_FILTERS.map((s) => (
            <a 
              key={s} 
              href={`?status=${s}`} 
              className={`nr-filter-item ${statusFilter === s ? "nr-filter-active" : ""}`}
            >
              {t(ACTION_STATUS_META[s].labelKey)} ({groupedActions[s].length})
            </a>
          ))}
        </div>

        <div>
          {displayActions.length === 0 && <p className="muted">{t("noActionsFound")}</p>}
          {displayActions.map((action) => {
            const statusMeta = ACTION_STATUS_META[action.status as keyof typeof ACTION_STATUS_META] ?? ACTION_STATUS_META.OPEN;
            const authorName = action.author?.displayName || action.author?.email || "Unknown";
            const assigneeName = action.assigneeMember?.user?.displayName || action.assigneeMember?.user?.email;
            const createdAge = ageText(action.createdAt);
            const dueDate = action.dueAt ? new Date(action.dueAt).toLocaleDateString() : null;
            const canManage = canManageAction(action);

            return (
              <div className="nr-item" key={action.id}>
                <div className="row" style={{ alignItems: "center" }}>
                  <strong className="nr-item-title">
                    {action.status === "DRAFT" && <span title={t("statusDraft")} style={{ marginRight: 6 }}>◆</span>}
                    {action.title}
                  </strong>
                  <span className={`tag ${statusMeta.tagClass}`}>{t(statusMeta.labelKey)}</span>
                </div>
                {action.bodyMd && <MarkdownExcerpt markdown={action.bodyMd} maxLength={220} as="div" className="nr-excerpt" />}
                
                <div className="nr-item-meta" style={{ marginTop: 8 }}>
                  {t("metaCreator", { name: authorName })}
                  {createdAge ? ` · ${createdAge}` : ""}
                  {assigneeName ? ` · ${t("metaAssignee", { name: assigneeName })}` : ""}
                  {dueDate ? ` · ${t("metaDue", { date: dueDate })}` : ""}
                  {action.proposal?.title ? ` · ${t("metaLinkedToProposal", { title: action.proposal.title })}` : ""}
                </div>

                {(() => {
                  let primary: React.ReactNode = null;
                  if (canManage && action.status === "DRAFT") {
                    primary = (
                      <form action={publishActionAction}>
                        <input type="hidden" name="workspaceId" value={workspaceId} />
                        <input type="hidden" name="actionId" value={action.id} />
                        <button type="submit" className="primary small">{t("btnOpen")}</button>
                      </form>
                    );
                  } else if (action.status === "OPEN") {
                    primary = (
                      <form action={updateActionAction}>
                        <input type="hidden" name="workspaceId" value={workspaceId} />
                        <input type="hidden" name="actionId" value={action.id} />
                        <input type="hidden" name="status" value="IN_PROGRESS" />
                        <button type="submit" className="primary small">{t("btnStart")}</button>
                      </form>
                    );
                  } else if (action.status === "IN_PROGRESS") {
                    primary = (
                      <form action={updateActionAction}>
                        <input type="hidden" name="workspaceId" value={workspaceId} />
                        <input type="hidden" name="actionId" value={action.id} />
                        <input type="hidden" name="status" value="COMPLETED" />
                        <button type="submit" className="primary small">{t("btnComplete")}</button>
                      </form>
                    );
                  } else if (action.status === "COMPLETED" && canManage) {
                    primary = (
                      <form action={returnActionToDraftAction}>
                        <input type="hidden" name="workspaceId" value={workspaceId} />
                        <input type="hidden" name="actionId" value={action.id} />
                        <button type="submit" className="secondary small">{t("btnReturnToDraft")}</button>
                      </form>
                    );
                  }
                  const moreItems: React.ReactNode[] = [];
                  if (action.status === "OPEN") {
                    moreItems.push(
                      <form key="complete" action={updateActionAction}>
                        <input type="hidden" name="workspaceId" value={workspaceId} />
                        <input type="hidden" name="actionId" value={action.id} />
                        <input type="hidden" name="status" value="COMPLETED" />
                        <button type="submit">{t("btnComplete")}</button>
                      </form>
                    );
                  }
                  if (canManage && (action.status === "OPEN" || action.status === "IN_PROGRESS")) {
                    moreItems.push(
                      <form key="return-to-draft" action={returnActionToDraftAction}>
                        <input type="hidden" name="workspaceId" value={workspaceId} />
                        <input type="hidden" name="actionId" value={action.id} />
                        <button type="submit">{t("btnReturnToDraft")}</button>
                      </form>
                    );
                  }
                  if (canManage && action.status === "DRAFT") {
                    moreItems.push(
                      <details key="edit">
                        <summary className="nr-hide-marker" style={{ cursor: "pointer", padding: "8px 10px", borderRadius: 8, fontSize: "0.88rem", fontWeight: 500 }}>
                          {t("btnEdit")}
                        </summary>
                        <form action={updateActionAction} className="action-menu-form">
                          <input type="hidden" name="workspaceId" value={workspaceId} />
                          <input type="hidden" name="actionId" value={action.id} />
                          <label>
                            {t("formTitle")}
                            <input name="title" defaultValue={action.title} required />
                          </label>
                          <label>
                            {t("formNotes")}
                            <MarkdownEditor name="bodyMd" defaultValue={action.bodyMd ?? ""} rows={5} />
                          </label>
                          <button type="submit" className="secondary small">{t("btnSaveDraft")}</button>
                        </form>
                      </details>
                    );
                  }
                  if (canManage) {
                    if (moreItems.length > 0) moreItems.push(<div key="divider" className="action-menu-divider" />);
                    moreItems.push(
                      <form key="delete" action={deleteActionAction}>
                        <input type="hidden" name="workspaceId" value={workspaceId} />
                        <input type="hidden" name="actionId" value={action.id} />
                        <button type="submit" className="danger">{t("btnDelete")}</button>
                      </form>
                    );
                  }
                  return (
                    <ItemActions
                      moreLabel={tCommon("moreActions")}
                      primary={primary}
                      more={moreItems.length > 0 ? moreItems : null}
                    />
                  );
                })()}
              </div>
            );
          })}
        </div>
      </section>

      <section className="ws-section">
        <details open={resolvedSearch.open === "new"}>
          <summary className="nr-hide-marker" style={{ cursor: "pointer", fontWeight: 600, color: "var(--accent)" }}>
            <span className="nr-section-header" style={{ borderTop: "none", display: "inline-block", padding: 0, margin: 0 }}>{t("newActionTitle")}</span>
          </summary>
          <form action={createActionAction} className="stack nr-form-section">
            <input type="hidden" name="workspaceId" value={workspaceId} />
            <label>
              {t("formTitle")}
              <input name="title" required />
            </label>
            <label>
              {t("formNotes")}
              <MarkdownEditor name="bodyMd" rows={5} />
            </label>
            <details>
              <summary className="secondary small nr-hide-marker" style={{ cursor: "pointer", display: "inline-block" }}>{t("formOptionalMetadata")}</summary>
              <label style={{ marginTop: 12 }}>
                {t("formLinkToProposal")}
                <select name="proposalId" defaultValue="">
                  <option value="">{t("formNone")}</option>
                  {activeProposals.map((p) => (
                    <option value={p.id} key={p.id}>{p.title}</option>
                  ))}
                </select>
              </label>
            </details>
            <button type="submit">{t("btnCreateAction")}</button>
          </form>
        </details>
      </section>
    </>
  );
}
