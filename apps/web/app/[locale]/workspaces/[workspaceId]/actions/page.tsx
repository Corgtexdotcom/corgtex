import { listActions, listProposals } from "@corgtex/domain";
import { requirePageActor } from "@/lib/auth";
import {
  createActionAction,
  updateActionAction,
  deleteActionAction,
  publishActionAction,
} from "../actions";
import { getTranslations } from "next-intl/server";
import {
  ACTION_STATUS_FILTERS,
  ACTION_STATUS_META,
  groupActionsByStatus,
  normalizeActionStatusFilter,
} from "./view-model";

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
  const [{ items: actions }, { items: proposals }] = await Promise.all([
    listActions(actor, workspaceId, { take: 50 }),
    listProposals(actor, workspaceId, { take: 50 }),
  ]);
  
  const activeProposals = proposals.filter(p => p.status === "DRAFT" || p.status === "OPEN");

  const resolvedSearch = searchParams ? await searchParams : {};
  const statusFilter = normalizeActionStatusFilter(resolvedSearch.status);
  const groupedActions = groupActionsByStatus(actions);
  const displayActions = groupedActions[statusFilter];

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
        <h1 style={{ border: "none", padding: 0, margin: 0, fontSize: "2.5rem" }}>{t("pageTitle")}</h1>
        <div className="nr-masthead-meta">
          <span>{t("pageDescription")}</span>
        </div>
      </header>

      <section className="ws-section">
        <div className="nr-filter-bar">
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

            return (
              <div className="nr-item" key={action.id}>
                <div className="row" style={{ alignItems: "center" }}>
                  <strong className="nr-item-title">
                    {action.status === "DRAFT" && <span title={t("statusDraft")} style={{ marginRight: 6 }}>◆</span>}
                    {action.title}
                  </strong>
                  <span className={`tag ${statusMeta.tagClass}`}>{t(statusMeta.labelKey)}</span>
                </div>
                {action.bodyMd && <div className="nr-excerpt">{action.bodyMd}</div>}
                
                <div className="nr-item-meta" style={{ marginTop: 8 }}>
                  {t("metaCreator", { name: authorName })}
                  {createdAge ? ` · ${createdAge}` : ""}
                  {assigneeName ? ` · ${t("metaAssignee", { name: assigneeName })}` : ""}
                  {dueDate ? ` · ${t("metaDue", { date: dueDate })}` : ""}
                  {action.proposal?.title ? ` · ${t("metaLinkedToProposal", { title: action.proposal.title })}` : ""}
                </div>

                <div className="actions-inline" style={{ marginTop: 12 }}>
                  {action.status === "DRAFT" && (
                    <form action={publishActionAction}>
                      <input type="hidden" name="workspaceId" value={workspaceId} />
                      <input type="hidden" name="actionId" value={action.id} />
                      <button type="submit" className="primary small">{t("btnOpen")}</button>
                    </form>
                  )}
                  {action.status === "OPEN" && (
                    <form action={updateActionAction}>
                      <input type="hidden" name="workspaceId" value={workspaceId} />
                      <input type="hidden" name="actionId" value={action.id} />
                      <input type="hidden" name="status" value="IN_PROGRESS" />
                      <button type="submit" className="secondary small">{t("btnStart")}</button>
                    </form>
                  )}
                  {(action.status === "OPEN" || action.status === "IN_PROGRESS") && (
                    <form action={updateActionAction}>
                      <input type="hidden" name="workspaceId" value={workspaceId} />
                      <input type="hidden" name="actionId" value={action.id} />
                      <input type="hidden" name="status" value="COMPLETED" />
                      <button type="submit" className="secondary small">{t("btnComplete")}</button>
                    </form>
                  )}
                  <form action={deleteActionAction}>
                    <input type="hidden" name="workspaceId" value={workspaceId} />
                    <input type="hidden" name="actionId" value={action.id} />
                    <button type="submit" className="danger small">{t("btnDelete")}</button>
                  </form>
                </div>
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
              <textarea name="bodyMd" />
            </label>
            <label>
              {t("formLinkToProposal")}
              <select name="proposalId" defaultValue="">
                <option value="">{t("formNone")}</option>
                {activeProposals.map((p) => (
                  <option value={p.id} key={p.id}>{p.title}</option>
                ))}
              </select>
            </label>
            <button type="submit">{t("btnCreateAction")}</button>
          </form>
        </details>
      </section>
    </>
  );
}
