import { listActions, listProposals } from "@corgtex/domain";
import { requirePageActor } from "@/lib/auth";
import {
  createActionAction,
  updateActionAction,
  deleteActionAction,
  publishActionAction,
} from "../actions";
import { getTranslations } from "next-intl/server";

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
  
  const activeProposals = proposals.filter(p => p.status === "DRAFT" || p.status === "SUBMITTED");

  const resolvedSearch = searchParams ? await searchParams : {};
  const statusFilter = typeof resolvedSearch.status === "string" ? resolvedSearch.status : "OPEN";

  const groupedActions = {
    PERSONAL: actions.filter((a) => a.isPrivate),
    OPEN: actions.filter((a) => a.status === "OPEN" && !a.isPrivate),
    IN_PROGRESS: actions.filter((a) => a.status === "IN_PROGRESS" && !a.isPrivate),
    COMPLETED: actions.filter((a) => a.status === "COMPLETED" && !a.isPrivate),
    ALL: actions,
  };

  const displayActions = statusFilter === "ALL" 
    ? groupedActions.ALL 
    : groupedActions[statusFilter as keyof typeof groupedActions] || groupedActions.OPEN;

  const ageText = (date: Date) => {
    const days = Math.floor((Date.now() - new Date(date).getTime()) / (1000 * 60 * 60 * 24));
    return days === 0 ? "today" : `${days}d ago`;
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
          {(["PERSONAL", "OPEN", "IN_PROGRESS", "COMPLETED", "ALL"] as const).map((s) => (
            <a 
              key={s} 
              href={`?status=${s}`} 
              className={`nr-filter-item ${statusFilter === s ? "nr-filter-active" : ""}`}
            >
              {s === "PERSONAL" ? t("statusPersonal") : s === "OPEN" ? t("statusOpen") : s === "IN_PROGRESS" ? t("statusInProgress") : s === "COMPLETED" ? t("statusCompleted") : t("statusAll")} ({groupedActions[s].length})
            </a>
          ))}
        </div>

        <div>
          {displayActions.length === 0 && <p className="muted">{t("noActionsFound")}</p>}
          {displayActions.map((action) => (
            <div className="nr-item" key={action.id}>
              <div className="row" style={{ alignItems: "center" }}>
                <strong className="nr-item-title">
                  {action.isPrivate && <span title={t("privateTooltip")} style={{ marginRight: 6 }}>◆</span>}
                  {action.title}
                </strong>
                <span className={`tag ${action.status === "OPEN" ? "warning" : action.status === "IN_PROGRESS" ? "info" : "success"}`}>{action.status}</span>
              </div>
              {action.bodyMd && <div className="nr-excerpt">{action.bodyMd}</div>}
              
              <div className="nr-item-meta" style={{ marginTop: 8 }}>
                 {t("metaCreator", { name: action.author.displayName || action.author.email })} · {ageText(action.createdAt)}
                 {action.assigneeMember && ` · ${t("metaAssignee", { name: action.assigneeMember.user.displayName || action.assigneeMember.user.email })}`}
                 {action.dueAt && ` · ${t("metaDue", { date: new Date(action.dueAt).toLocaleDateString() })}`}
                 {action.proposal && ` · ${t("metaLinkedToProposal", { title: action.proposal.title })}`}
              </div>

              <div className="actions-inline" style={{ marginTop: 12 }}>
                {action.isPrivate && (
                  <form action={publishActionAction}>
                    <input type="hidden" name="workspaceId" value={workspaceId} />
                    <input type="hidden" name="actionId" value={action.id} />
                    <button type="submit" className="primary small">{t("btnPublish")}</button>
                  </form>
                )}
                {!action.isPrivate && action.status === "OPEN" && (
                  <form action={updateActionAction}>
                    <input type="hidden" name="workspaceId" value={workspaceId} />
                    <input type="hidden" name="actionId" value={action.id} />
                    <input type="hidden" name="status" value="IN_PROGRESS" />
                    <button type="submit" className="secondary small">{t("btnStart")}</button>
                  </form>
                )}
                {!action.isPrivate && (action.status === "OPEN" || action.status === "IN_PROGRESS") && (
                  <form action={updateActionAction}>
                    <input type="hidden" name="workspaceId" value={workspaceId} />
                    <input type="hidden" name="actionId" value={action.id} />
                    <input type="hidden" name="status" value="COMPLETED" />
                    <button type="submit" className="secondary small">{t("btnComplete")}</button>
                  </form>
                )}
                {!action.isPrivate && (action.status === "OPEN" || action.status === "IN_PROGRESS") && (
                  <form action={updateActionAction}>
                    <input type="hidden" name="workspaceId" value={workspaceId} />
                    <input type="hidden" name="actionId" value={action.id} />
                    <input type="hidden" name="status" value="CANCELLED" />
                    <button type="submit" className="warning small">{t("btnCancel")}</button>
                  </form>
                )}
                <form action={deleteActionAction}>
                  <input type="hidden" name="workspaceId" value={workspaceId} />
                  <input type="hidden" name="actionId" value={action.id} />
                  <button type="submit" className="danger small">{t("btnDelete")}</button>
                </form>
              </div>
            </div>
          ))}
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
            <label style={{ display: "flex", alignItems: "center", gap: "8px", fontWeight: "normal", cursor: "pointer" }}>
              <input type="checkbox" name="isPrivate" defaultChecked />
              <span>{t("formPrivateList")}</span>
            </label>
            <button type="submit">{t("btnCreateAction")}</button>
          </form>
        </details>
      </section>
    </>
  );
}
