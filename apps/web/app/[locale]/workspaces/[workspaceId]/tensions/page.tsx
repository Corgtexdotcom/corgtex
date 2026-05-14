import { listMembers, listTensions, listProposals, requireWorkspaceMembership } from "@corgtex/domain";
import { requirePageActor } from "@/lib/auth";
import {
  createTensionAction,
  updateTensionAction,
  upvoteTensionAction,
  deleteTensionAction,
  publishTensionAction,
  returnTensionToDraftAction,
  createProposalFromTensionAction,
} from "../actions";
import { MarkdownEditor } from "@/lib/components/MarkdownEditor";
import { MarkdownExcerpt } from "@/lib/components/MarkdownRenderer";
import { ItemActions } from "@/lib/components/ui/ItemActions";
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
  const tCommon = await getTranslations("common");
  const membership = await requireWorkspaceMembership({ actor, workspaceId });
  const [{ items: tensions }, { items: proposals }, members] = await Promise.all([
    listTensions(actor, workspaceId, { take: 50 }),
    listProposals(actor, workspaceId, { take: 50 }),
    listMembers(workspaceId),
  ]);

  const activeProposals = proposals.filter((p) => p.status === "DRAFT" || p.status === "OPEN");

  const resolvedSearch = searchParams ? await searchParams : {};
  const statusFilter = typeof resolvedSearch.status === "string" ? resolvedSearch.status : "OPEN";

  const groupedTensions = {
    DRAFT: tensions.filter((tension) => tension.status === "DRAFT"),
    OPEN: tensions.filter((t) => t.status === "OPEN" && !t.isPrivate),
    RESOLVED: tensions.filter((tension) => tension.status === "RESOLVED" && !tension.isPrivate),
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
      DRAFT: t("statusDraft"),
      OPEN: t("statusOpen"),
      RESOLVED: t("statusResolved"),
      ALL: t("statusAll"),
    };
    return labels[status] ?? status;
  };

  const statusFilters = (["DRAFT", "OPEN", "RESOLVED", "ALL"] as const).map((status) => ({
    status,
    label: statusLabel(status),
  }));
  const memberName = (member: { user: { displayName: string | null; email: string } }) => member.user.displayName || member.user.email;
  const canManageTension = (tension: { authorUserId: string }) => actor.kind === "agent"
    || membership?.role === "ADMIN"
    || (actor.kind === "user" && tension.authorUserId === actor.user.id);

  return (
    <>
      <header className="nr-masthead" style={{ textAlign: "left", marginBottom: 32 }}>
        <h1>{t("pageTitle")}</h1>
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
          {displayTensions.map((tension) => {
            const authorName = tension.author.displayName || tension.author.email || t("authorUnknown");
            const raisedByName = tension.raisedByMember ? memberName(tension.raisedByMember) : null;
            const canManage = canManageTension(tension);
            const canDraftProposal = !tension.proposal && (canManage || !tension.isPrivate);

            return (
              <div className="nr-item" key={tension.id}>
                <div className="row" style={{ alignItems: "center" }}>
                  <strong className="nr-item-title">
                    {tension.isPrivate && <span title={t("privateInboxTooltip")} style={{ marginRight: 6 }}>◆</span>}
                    <a href={`/workspaces/${workspaceId}/tensions/${tension.id}`} style={{ color: "inherit" }}>
                      {tension.title}
                    </a>
                  </strong>
                  <span className={`tag ${tension.status === "DRAFT" ? "info" : tension.status === "OPEN" ? "neutral" : "success"}`}>{statusLabel(tension.status)}</span>
                </div>
                {tension.bodyMd && <MarkdownExcerpt markdown={tension.bodyMd} maxLength={220} as="div" className="nr-excerpt" />}

                <div className="nr-item-meta" style={{ marginTop: 8 }}>
                  {t("createdByMeta", { name: authorName })}
                  {raisedByName ? ` · ${t("raisedByMeta", { name: raisedByName })}` : ""}
                  {` · ${ageText(tension.createdAt)} · ${t("upvotes", { count: tension.upvotes.length })} · ${t("priorityN", { priority: tension.priority })}`}
                  {tension.proposal && (
                    <>
                      {" · "}
                      <a href={`/workspaces/${workspaceId}/proposals/${tension.proposal.id}`}>{t("linkedProposalMeta", { title: tension.proposal.title })}</a>
                    </>
                  )}
                </div>

                {(() => {
                  let primary: React.ReactNode;
                  if (canManage && tension.status === "DRAFT") {
                    primary = (
                      <form action={publishTensionAction}>
                        <input type="hidden" name="workspaceId" value={workspaceId} />
                        <input type="hidden" name="tensionId" value={tension.id} />
                        <button type="submit" className="primary small">{t("btnOpen")}</button>
                      </form>
                    );
                  } else if (!tension.isPrivate && tension.status === "OPEN") {
                    primary = (
                      <form action={upvoteTensionAction}>
                        <input type="hidden" name="workspaceId" value={workspaceId} />
                        <input type="hidden" name="tensionId" value={tension.id} />
                        <button type="submit" className="primary small">{t("btnUpvote")}</button>
                      </form>
                    );
                  } else {
                    primary = (
                      <a className="link-button small" href={`/workspaces/${workspaceId}/tensions/${tension.id}`}>
                        {tCommon("btnView")}
                      </a>
                    );
                  }
                  const moreItems: React.ReactNode[] = [];
                  if (canDraftProposal) {
                    moreItems.push(
                      <form key="draft-proposal" action={createProposalFromTensionAction}>
                        <input type="hidden" name="workspaceId" value={workspaceId} />
                        <input type="hidden" name="sourceTensionId" value={tension.id} />
                        <button type="submit">{t("btnDraftProposal")}</button>
                      </form>
                    );
                  }
                  if (canManage && tension.status === "OPEN") {
                    moreItems.push(
                      <form key="return-to-draft" action={returnTensionToDraftAction}>
                        <input type="hidden" name="workspaceId" value={workspaceId} />
                        <input type="hidden" name="tensionId" value={tension.id} />
                        <button type="submit">{t("btnReturnToDraft")}</button>
                      </form>
                    );
                  }
                  if (!tension.isPrivate && tension.status === "OPEN") {
                    moreItems.push(
                      <form key="resolve" action={updateTensionAction} className="action-menu-form">
                        <input type="hidden" name="workspaceId" value={workspaceId} />
                        <input type="hidden" name="tensionId" value={tension.id} />
                        <input type="hidden" name="status" value="RESOLVED" />
                        <input name="resolvedVia" placeholder={t("placeholderResolvedVia")} required />
                        <button type="submit" className="secondary small">{t("btnResolve")}</button>
                      </form>
                    );
                  }
                  if (canManage && tension.status === "DRAFT") {
                    moreItems.push(
                      <form key="edit-raised-by" action={updateTensionAction} className="action-menu-form">
                        <input type="hidden" name="workspaceId" value={workspaceId} />
                        <input type="hidden" name="tensionId" value={tension.id} />
                        <span className="action-menu-label">{t("btnEditRaisedBy")}</span>
                        <select name="raisedByMemberId" defaultValue={tension.raisedByMemberId || ""} aria-label={t("formRaisedBy")}>
                          <option value="">{t("formRaisedByNone")}</option>
                          {members.map((member) => (
                            <option value={member.id} key={member.id}>{memberName(member)}</option>
                          ))}
                        </select>
                        <button type="submit" className="secondary small">{t("btnSaveRaisedBy")}</button>
                      </form>
                    );
                    moreItems.push(
                      <details key="edit">
                        <summary className="nr-hide-marker" style={{ cursor: "pointer", padding: "8px 10px", borderRadius: 8, fontSize: "0.88rem", fontWeight: 500 }}>
                          {t("btnEdit")}
                        </summary>
                        <form action={updateTensionAction} className="action-menu-form">
                          <input type="hidden" name="workspaceId" value={workspaceId} />
                          <input type="hidden" name="tensionId" value={tension.id} />
                          <label>
                            {t("formTitle")}
                            <input name="title" defaultValue={tension.title} required />
                          </label>
                          <label>
                            {t("formDescription")}
                            <MarkdownEditor name="bodyMd" defaultValue={tension.bodyMd ?? ""} rows={5} />
                          </label>
                          <label>
                            {t("formPriority")}
                            <input name="priority" type="number" min={0} defaultValue={tension.priority} />
                          </label>
                          <button type="submit" className="secondary small">{t("btnSaveDraft")}</button>
                        </form>
                      </details>
                    );
                  }
                  if (canManage) {
                    if (moreItems.length > 0) moreItems.push(<div key="divider" className="action-menu-divider" />);
                    moreItems.push(
                      <form key="delete" action={deleteTensionAction}>
                        <input type="hidden" name="workspaceId" value={workspaceId} />
                        <input type="hidden" name="tensionId" value={tension.id} />
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
              <MarkdownEditor name="bodyMd" rows={5} />
            </label>
            <label>
              {t("formRaisedBy")}
              <select name="raisedByMemberId" defaultValue="">
                <option value="">{t("formRaisedByNone")}</option>
                {members.map((member) => (
                  <option value={member.id} key={member.id}>{memberName(member)}</option>
                ))}
              </select>
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
