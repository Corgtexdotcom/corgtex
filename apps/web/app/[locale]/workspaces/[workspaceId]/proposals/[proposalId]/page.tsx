import { notFound } from "next/navigation";
import Link from "next/link";
import { getProposal, listDeliberationEntries, requireWorkspaceMembership } from "@corgtex/domain";
import { requirePageActor } from "@/lib/auth";
import { renderMarkdown } from "@/lib/markdown";
import { MarkdownEditor } from "@/lib/components/MarkdownEditor";
import { DeliberationThread } from "@/lib/components/DeliberationThread";
import { DeliberationComposer } from "@/lib/components/DeliberationComposer";
import { getDeliberationTargets } from "@/lib/deliberation-targets";
import { postDeliberationEntryAction, resolveDeliberationEntryAction, returnProposalToDraftAction, submitProposalAction, updateProposalAction } from "../actions";
import { getTranslations } from "next-intl/server";

export const dynamic = "force-dynamic";

export default async function ProposalDetailPage({
  params,
}: {
  params: Promise<{ workspaceId: string; proposalId: string }>;
}) {
  const { workspaceId, proposalId } = await params;
  const actor = await requirePageActor();
  const t = await getTranslations("proposals");

  const proposal = await getProposal(actor, { workspaceId, proposalId });
  if (!proposal) notFound();
  const membership = await requireWorkspaceMembership({ actor, workspaceId });

  const deliberationEntries = await listDeliberationEntries(actor, {
    workspaceId,
    parentType: "PROPOSAL",
    parentId: proposalId,
  });
  const deliberationTargets = await getDeliberationTargets({ actor, workspaceId, parentCircleId: proposal.circleId });
  const targetOptions = deliberationTargets.options;

  const htmlContent = renderMarkdown(proposal.bodyMd);

  const ageText = (date: Date) => {
    const days = Math.floor((Date.now() - new Date(date).getTime()) / (1000 * 60 * 60 * 24));
    if (days === 0) return t("ageToday");
    if (days === 1) return t("ageYesterday");
    return t("ageDaysAgo", { count: days });
  };

  const statusClass = (() => {
    if (proposal.status === "DRAFT") return "info";
    if (proposal.status === "OPEN") return "warning";
    if (proposal.resolutionOutcome === "ADOPTED") return "success";
    if (proposal.status === "RESOLVED") return "info";
    return "";
  })();

  const isAuthor = proposal.authorUserId === (actor.kind === "user" ? actor.user.id : "");
  const canManage = actor.kind === "agent" || membership?.role === "ADMIN" || isAuthor;

  return (
    <>
      <div className="nr-masthead" style={{ textAlign: "left", marginBottom: 32 }}>
        <p className="nr-meta" style={{ marginBottom: "12px", display: "flex", gap: "12px" }}>
          <span><Link href={`/workspaces/${workspaceId}/proposals`} style={{ color: "inherit", textDecoration: "none" }}>{t("backToProposals")}</Link></span>
          <span>·</span>
          <span>{proposal.author.displayName || proposal.author.email}</span>
          <span>·</span>
          <span className={`tag ${statusClass}`}>
            {proposal.status === "RESOLVED" && proposal.resolutionOutcome ? `${proposal.status} · ${proposal.resolutionOutcome.replace("_", " ")}` : proposal.status}
          </span>
        </p>
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline", borderBottom: "1px solid var(--line)", paddingBottom: 16 }}>
          <h1 style={{ border: "none", padding: 0, margin: 0, fontSize: "2.5rem", maxWidth: "800px" }}>{proposal.title}</h1>
          <span style={{ fontSize: "0.85rem", color: "var(--muted)", textTransform: "uppercase", letterSpacing: "0.05em" }}>
            {t("updatedAt", { date: ageText(proposal.updatedAt) })}
          </span>
        </div>
      </div>

      <div style={{ display: "grid", gridTemplateColumns: "3fr 1fr", gap: "64px" }}>
        {/* Main Article Body */}
        <article style={{ fontSize: "1.1rem", lineHeight: 1.8, color: "var(--text)" }}>
          <div 
            className="nr-markdown" 
            dangerouslySetInnerHTML={{ __html: htmlContent }} 
            style={{ marginBottom: "48px" }}
          />

          <hr className="nr-divider" style={{ margin: "48px 0" }} />

          <h3 className="font-playfair font-semibold mb-6 text-[1.4rem]">{t("sectionDeliberation")}</h3>
          <DeliberationThread
            entries={deliberationEntries.map((e) => ({
              id: e.id,
              entryType: e.entryType,
              authorName: e.author?.displayName || t("authorUnknown"),
              authorInitials: (e.author?.displayName || "U").substring(0, 2).toUpperCase(),
              bodyMd: e.bodyMd,
              createdAt: e.createdAt,
              resolvedAt: e.resolvedAt,
              resolvedNote: e.resolvedNote,
              targetLabel: e.targetCircle
                ? t("targetCircle", { name: e.targetCircle.name })
                : e.targetMember
                  ? t("targetPerson", { name: e.targetMember.user.displayName || e.targetMember.user.email })
                  : null,
            }))}
            canResolve={isAuthor || actor.kind === "agent"}
            resolveAction={resolveDeliberationEntryAction}
            hiddenFields={{ workspaceId, proposalId }}
          />

          {proposal.status === "OPEN" && (
            <DeliberationComposer
              postAction={postDeliberationEntryAction}
              hiddenFields={{ workspaceId, proposalId }}
              title={t("sectionDeliberation")}
              targetOptions={targetOptions}
              entryTypes={[
                { value: "REACTION", label: t("entryReaction"), variant: "secondary" },
                { value: "OBJECTION", label: t("entryObjection"), variant: "danger" },
              ]}
            />
          )}
        </article>

        {/* Sidebar */}
        <aside style={{ borderLeft: "1px solid var(--line)", paddingLeft: "32px", paddingRight: "16px" }}>
          {canManage && proposal.status === "DRAFT" && (
            <div className="stack mb-8">
              <form action={submitProposalAction} style={{ display: "flex", flexDirection: "column", gap: "12px" }}>
                <input type="hidden" name="workspaceId" value={workspaceId} />
                <input type="hidden" name="proposalId" value={proposal.id} />
                <button className="w-full">{t("btnOpen")}</button>
              </form>
            </div>
          )}
          {canManage && proposal.status === "OPEN" && (
            <div className="stack mb-8">
              <form action={returnProposalToDraftAction} style={{ display: "flex", flexDirection: "column", gap: "12px" }}>
                <input type="hidden" name="workspaceId" value={workspaceId} />
                <input type="hidden" name="proposalId" value={proposal.id} />
                <button className="secondary w-full">{t("btnReturnToDraft")}</button>
              </form>
            </div>
          )}
          {canManage && proposal.status === "DRAFT" && (
            <details className="stack mb-8">
              <summary className="secondary small nr-hide-marker" style={{ cursor: "pointer" }}>{t("btnEdit")}</summary>
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
          
          <h3 style={{ fontSize: "0.85rem", textTransform: "uppercase", letterSpacing: "0.05em", color: "var(--text)", marginBottom: "16px" }}>{t("aboutTitle")}</h3>
          <div className="nr-meta mb-4">
            <strong>{t("aboutCreated")}</strong> {new Date(proposal.createdAt).toLocaleDateString()}
          </div>
          {proposal.summary && (
            <div className="nr-meta mb-4">
              <strong>{t("aboutSummary")}</strong> {proposal.summary}
            </div>
          )}
        </aside>
      </div>
    </>
  );
}
