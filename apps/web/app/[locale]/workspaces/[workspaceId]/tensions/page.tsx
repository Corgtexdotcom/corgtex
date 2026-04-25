import { listTensions, listProposals } from "@corgtex/domain";
import { requirePageActor } from "@/lib/auth";
import {
  createTensionAction,
  updateTensionAction,
  upvoteTensionAction,
  deleteTensionAction,
  publishTensionAction,
} from "../actions";
import { getTranslations } from "next-intl/server";

export const dynamic = "force-dynamic";

export default async function TensionsPage({
  params,
  searchParams,
}: {
  params: Promise<{ workspaceId: string }>;
  searchParams?: Promise<Record<string, string | string[] | undefined>>;
}) {
  const { workspaceId } = await params;
  const actor = await requirePageActor();
  const t = await getTranslations("tensions");
  const [{ items: tensions }, { items: proposals }] = await Promise.all([
    listTensions(actor, workspaceId, { take: 50 }),
    listProposals(actor, workspaceId, { take: 50 }),
  ]);

  const activeProposals = proposals.filter(p => p.status === "DRAFT" || p.status === "SUBMITTED");

  const resolvedSearch = searchParams ? await searchParams : {};
  const statusFilter = typeof resolvedSearch.status === "string" ? resolvedSearch.status : "OPEN";

  const groupedTensions = {
    MY_INBOX: tensions.filter((t) => t.isPrivate),
    OPEN: tensions.filter((t) => t.status === "OPEN" && !t.isPrivate),
    IN_PROGRESS: tensions.filter((t) => t.status === "IN_PROGRESS" && !t.isPrivate),
    COMPLETED: tensions.filter((t) => t.status === "COMPLETED" && !t.isPrivate),
    ALL: tensions,
  };

  const displayTensions = statusFilter === "ALL" 
    ? groupedTensions.ALL 
    : groupedTensions[statusFilter as keyof typeof groupedTensions] || groupedTensions.OPEN;

  const ageText = (date: Date) => {
    const days = Math.floor((Date.now() - new Date(date).getTime()) / (1000 * 60 * 60 * 24));
    return days === 0 ? t("ageToday") : t("ageDaysAgo", { days });
  };

  const statusLabel = (status: string) => {
    const labels: Record<string, string> = {
      MY_INBOX: t("statusMyInbox"),
      OPEN: t("statusOpen"),
      IN_PROGRESS: t("statusInProgress"),
      COMPLETED: t("statusCompleted"),
      ALL: t("statusAll"),
    };
    return labels[status] ?? status;
  };

  const statusFilters = (["MY_INBOX", "OPEN", "IN_PROGRESS", "COMPLETED", "ALL"] as const).map((status) => ({
    status,
    label: statusLabel(status),
  }));

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
          {statusFilters.map(({ status, label }) => (
            <a 
              key={status}
              href={`?status=${status}`}
              className={`nr-filter-item ${statusFilter === status ? "nr-filter-active" : ""}`}
            >
              {t("filterWithCount", { label, count: groupedTensions[status].length })}
            </a>
          ))}
        </div>

        <div>
          {(!displayTensions || displayTensions.length === 0) && (
            <div className="nr-item" style={{ textAlign: "center", padding: "48px 24px" }}>
              <h3 style={{ margin: "0 0 8px" }}>{t("whatIsTensionTitle")}</h3>
              <p className="muted" style={{ margin: 0, maxWidth: 500, marginInline: "auto" }}>
                {t("whatIsTensionDesc")}
              </p>
            </div>
          )}
          {displayTensions.map((tension) => (
            <div className="nr-item" key={tension.id}>
              <div className="row" style={{ alignItems: "center" }}>
                <strong className="nr-item-title">
                  {tension.isPrivate && <span title={t("privateInboxTooltip")} style={{ marginRight: 6 }}>◆</span>}
                  <a href={`/workspaces/${workspaceId}/tensions/${tension.id}`} style={{ color: "inherit" }}>
                    {tension.title}
                  </a>
                </strong>
                <span className={`tag ${tension.status === "OPEN" ? "warning" : tension.status === "IN_PROGRESS" ? "info" : "success"}`}>{statusLabel(tension.status)}</span>
              </div>
              {tension.bodyMd && <div className="nr-excerpt">{tension.bodyMd}</div>}
              
              <div className="nr-item-meta" style={{ marginTop: 8 }}>
                {t("tensionMeta", {
                  author: tension.author.displayName || tension.author.email || t("authorUnknown"),
                  age: ageText(tension.createdAt),
                  upvotes: t("upvotes", { count: tension.upvotes.length }),
                  priority: t("priorityN", { priority: tension.priority }),
                })}
                {tension.proposal && t("linkedProposalMeta", { title: tension.proposal.title })}
              </div>

              <div className="actions-inline" style={{ marginTop: 12 }}>
                {tension.isPrivate && (
                  <form action={publishTensionAction}>
                    <input type="hidden" name="workspaceId" value={workspaceId} />
                    <input type="hidden" name="tensionId" value={tension.id} />
                    <button type="submit" className="primary small">{t("btnPublish")}</button>
                  </form>
                )}
                {!tension.isPrivate && tension.status === "OPEN" && (
                  <form action={updateTensionAction}>
                    <input type="hidden" name="workspaceId" value={workspaceId} />
                    <input type="hidden" name="tensionId" value={tension.id} />
                    <input type="hidden" name="status" value="IN_PROGRESS" />
                    <button type="submit" className="secondary small">{t("btnStart")}</button>
                  </form>
                )}
                {!tension.isPrivate && (tension.status === "OPEN" || tension.status === "IN_PROGRESS") && (
                  <form action={updateTensionAction}>
                    <input type="hidden" name="workspaceId" value={workspaceId} />
                    <input type="hidden" name="tensionId" value={tension.id} />
                    <input type="hidden" name="status" value="COMPLETED" />
                    <button type="submit" className="secondary small">{t("btnResolve")}</button>
                  </form>
                )}
                {!tension.isPrivate && (
                <form action={upvoteTensionAction}>
                  <input type="hidden" name="workspaceId" value={workspaceId} />
                  <input type="hidden" name="tensionId" value={tension.id} />
                  <button type="submit" className="secondary small">{t("btnUpvote")}</button>
                </form>
                )}
                <form action={deleteTensionAction}>
                  <input type="hidden" name="workspaceId" value={workspaceId} />
                  <input type="hidden" name="tensionId" value={tension.id} />
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
            <span className="nr-section-header" style={{ borderTop: "none", display: "inline-block", padding: 0, margin: 0 }}>{t("newTensionTitle")}</span>
          </summary>
          <form action={createTensionAction} className="stack nr-form-section">
            <input type="hidden" name="workspaceId" value={workspaceId} />
            <label>
              {t("formTitle")}
              <input name="title" required />
            </label>
            <label>
              {t("formDescription")}
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
              <span>{t("formPrivateInbox")}</span>
            </label>
            <button type="submit">{t("btnCreateTension")}</button>
          </form>
        </details>
      </section>
    </>
  );
}
