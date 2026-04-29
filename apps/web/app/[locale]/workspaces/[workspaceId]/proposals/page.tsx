import { listProposals, requireWorkspaceMembership } from "@corgtex/domain";
import { requirePageActor } from "@/lib/auth";
import { MarkdownEditor } from "@/lib/components/MarkdownEditor";
import {
  createProposalAction,
  archiveProposalAction,
  submitProposalAction,
  returnProposalToDraftAction,
  updateProposalAction,
} from "../actions";
import { getTranslations } from "next-intl/server";
import { prisma } from "@corgtex/shared";

export const dynamic = "force-dynamic";

export default async function ProposalsPage({
  params,
  searchParams,
}: {
  params: Promise<{ workspaceId: string }>;
  searchParams?: Promise<Record<string, string | string[] | undefined>>;
}) {
  const { workspaceId } = await params;
  const actor = await requirePageActor();
  const t = await getTranslations("proposals");
  const resolvedSearch = searchParams ? await searchParams : {};
  const statusFilter = typeof resolvedSearch.status === "string" ? resolvedSearch.status : "OPEN";
  const archiveFilter = statusFilter === "ARCHIVED" ? "archived" : "active";
  const membership = await requireWorkspaceMembership({ actor, workspaceId });

  const [{ items: proposals }, currentWorkspace] = await Promise.all([
    listProposals(actor, workspaceId, { take: 50, archiveFilter }),
    prisma.workspace.findUnique({ where: { id: workspaceId }, select: { slug: true } }),
  ]);
  const isDemo = currentWorkspace?.slug === "jnj-demo";
  const canManageProposal = (proposal: { authorUserId: string }) => actor.kind === "agent"
    || membership?.role === "ADMIN"
    || (actor.kind === "user" && proposal.authorUserId === actor.user.id);

  const groupedProposals = {
    DRAFT: proposals.filter((p) => p.status === "DRAFT"),
    OPEN: proposals.filter((p) => p.status === "OPEN" && !p.isPrivate),
    RESOLVED: proposals.filter((p) => p.status === "RESOLVED" && !p.isPrivate),
    ARCHIVED: proposals.filter((p) => Boolean(p.archivedAt)),
  };

  const displayProposals = groupedProposals[statusFilter as keyof typeof groupedProposals] || groupedProposals.OPEN;

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
          {(["DRAFT", "OPEN", "RESOLVED", "ARCHIVED"] as const).map((s) => (
            <a 
              key={s} 
              href={`?status=${s}`} 
              className={`nr-filter-item ${statusFilter === s ? "nr-filter-active" : ""}`}
            >
              {s === "DRAFT" ? t("statusDraft") : s === "OPEN" ? t("statusOpen") : s === "RESOLVED" ? t("statusResolved") : t("statusArchived")} ({groupedProposals[s].length})
            </a>
          ))}
        </div>

        <div>
          {(!displayProposals || displayProposals.length === 0) && (
            <div className="nr-item" style={{ textAlign: "center", padding: "48px 24px" }}>
              <h3 style={{ margin: "0 0 8px" }}>{t("whatIsProposalTitle")}</h3>
              <p className="muted" style={{ margin: 0, maxWidth: 500, marginInline: "auto" }}>
                {t("whatIsProposalDesc")}
              </p>
            </div>
          )}
          {displayProposals.map((proposal) => {
            const canManage = canManageProposal(proposal);
            return (
            <div className="nr-item hover:bg-bg-alt transition-colors duration-200" key={proposal.id} style={{ position: "relative", padding: "16px", borderRadius: "8px", borderBottom: "1px dashed var(--line)" }}>
              <a href={`/workspaces/${workspaceId}/proposals/${proposal.id}`} style={{ display: "block", textDecoration: "none", color: "inherit" }}>
                <div className="row" style={{ alignItems: "center" }}>
                  <strong className="nr-item-title">
                    {proposal.status === "DRAFT" && <span title={t("privateDraftTooltip")} className="tag info" style={{ marginRight: 6 }}>{t("statusDraft")}</span>}
                    {proposal.title}
                  </strong>
                  <span className={`tag ${proposal.status === "DRAFT" ? "info" : proposal.status === "OPEN" ? "warning" : proposal.resolutionOutcome === "ADOPTED" ? "success" : proposal.status === "RESOLVED" ? "info" : ""}`}>
                    {proposal.status === "RESOLVED" && proposal.resolutionOutcome ? `${proposal.status} · ${proposal.resolutionOutcome.replace("_", " ")}` : proposal.status}
                  </span>
                </div>
                <div className="nr-excerpt" style={{ marginTop: "8px" }}>
                  {proposal.summary ?? proposal.bodyMd.replace(/\0/g, "").slice(0, 150) + "..."}
                </div>
                <div className="nr-item-meta" style={{ marginTop: 8 }}>
                   {proposal.author.displayName || proposal.author.email} · {new Date(proposal.createdAt).toLocaleDateString()}
                </div>
                
                {(proposal.tensions?.length > 0 || proposal.actions?.length > 0) && (
                  <div style={{ marginTop: 8, fontSize: "0.82rem", display: "flex", gap: "8px", flexWrap: "wrap" }}>
                    {proposal.tensions?.map((linkedTension: any) => (
                      <span key={linkedTension.id} className="tag info" style={{ padding: "2px 6px", fontSize: "0.75rem" }}>
                        {t("tensionTag", { title: linkedTension.title })}
                      </span>
                    ))}
                    {proposal.actions?.map((a: any) => (
                      <span key={a.id} className="tag info" style={{ padding: "2px 6px", fontSize: "0.75rem" }}>
                        {t("actionTag", { title: a.title })}
                      </span>
                    ))}
                  </div>
                )}
              </a>

              {!isDemo && canManage && (
                <div className="actions-inline" style={{ marginTop: 12 }}>
                  {proposal.status === "DRAFT" && (
                    <form action={submitProposalAction}>
                      <input type="hidden" name="workspaceId" value={workspaceId} />
                      <input type="hidden" name="proposalId" value={proposal.id} />
                      <button type="submit" className="primary small">{t("btnOpen")}</button>
                    </form>
                  )}
                  {proposal.status === "OPEN" && (
                    <form action={returnProposalToDraftAction}>
                      <input type="hidden" name="workspaceId" value={workspaceId} />
                      <input type="hidden" name="proposalId" value={proposal.id} />
                      <button type="submit" className="secondary small">{t("btnReturnToDraft")}</button>
                    </form>
                  )}
                  {(proposal.status === "DRAFT" || proposal.status === "RESOLVED") && (
                    <form action={archiveProposalAction}>
                      <input type="hidden" name="workspaceId" value={workspaceId} />
                      <input type="hidden" name="proposalId" value={proposal.id} />
                      <button type="submit" className="warning small">{t("btnArchive")}</button>
                    </form>
                  )}
                </div>
              )}

              {!isDemo && canManage && proposal.status === "DRAFT" && (
                <details style={{ marginTop: 12 }}>
                  <summary className="secondary small nr-hide-marker" style={{ cursor: "pointer", display: "inline-block" }}>{t("btnEdit")}</summary>
                  <form action={updateProposalAction} className="stack nr-form-section" style={{ marginTop: 12 }}>
                    <input type="hidden" name="workspaceId" value={workspaceId} />
                    <input type="hidden" name="proposalId" value={proposal.id} />
                    <label>
                      {t("formTitle")}
                      <input name="title" defaultValue={proposal.title} required />
                    </label>
                    <label>
                      {t("formSummary")}
                      <input name="summary" defaultValue={proposal.summary ?? ""} />
                    </label>
                    <label>
                      {t("formBody")}
                      <MarkdownEditor name="bodyMd" defaultValue={proposal.bodyMd} required placeholder={t("formBodyPlaceholder")} />
                    </label>
                    <button type="submit" className="secondary small">{t("btnSaveDraft")}</button>
                  </form>
                </details>
              )}
            </div>
          );})}
        </div>
      </section>

      {!isDemo && (
        <section className="ws-section">
          <details open={resolvedSearch.open === "new"}>
            <summary className="nr-hide-marker" style={{ cursor: "pointer", fontWeight: 600, color: "var(--accent)" }}>
              <span className="nr-section-header" style={{ borderTop: "none", display: "inline-block", padding: 0, margin: 0 }}>{t("newProposalTitle")}</span>
            </summary>
            <form action={createProposalAction} className="stack nr-form-section" style={{ marginTop: "16px" }}>
              <input type="hidden" name="workspaceId" value={workspaceId} />
              <label>
                {t("formTitle")}
                <input name="title" required />
              </label>
              <label>
                {t("formSummary")}
                <input name="summary" />
              </label>
              <label>
                {t("formBody")}
                <MarkdownEditor name="bodyMd" required placeholder={t("formBodyPlaceholder")} />
              </label>
              <label style={{ display: "flex", alignItems: "center", gap: "8px", fontWeight: "normal", cursor: "pointer" }}>
                <input type="checkbox" name="isPrivate" defaultChecked />
                <span>{t("formPrivateDraft")}</span>
              </label>
              <button type="submit">{t("btnCreateDraft")}</button>
            </form>
          </details>
        </section>
      )}
    </>
  );
}
