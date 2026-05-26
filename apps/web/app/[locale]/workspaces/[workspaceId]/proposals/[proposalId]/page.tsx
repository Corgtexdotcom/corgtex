import { notFound } from "next/navigation";
import Link from "next/link";
import { getProposal, listDeliberationEntries, requireWorkspaceMembership } from "@corgtex/domain";
import { requirePageActor } from "@/lib/auth";
import { MarkdownEditor } from "@/lib/components/MarkdownEditor";
import { MarkdownRenderer } from "@/lib/components/MarkdownRenderer";
import { DeliberationThread } from "@/lib/components/DeliberationThread";
import { DeliberationComposer } from "@/lib/components/DeliberationComposer";
import { getDeliberationTargets } from "@/lib/deliberation-targets";
import { canOpenPrivateDraft } from "@/lib/governance-open-guards";
import { postDeliberationEntryAction, resolveDeliberationEntryAction, resolveProposalAction, returnProposalToDraftAction, submitProposalAction, updateProposalAction } from "../actions";
import { ProposalDraftFields } from "../ProposalDraftFields";
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
  const targetOptions = deliberationTargets.options.map((option) => ({
    ...option,
    label: option.kind === "circle"
      ? t("targetCircle", { name: option.name })
      : t("targetPerson", { name: option.name }),
  }));

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
  const canResolve = actor.kind === "agent" || Boolean(membership);

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
          <h1 style={{ border: "none", padding: 0, margin: 0, fontSize: "2rem", maxWidth: "800px" }}>{proposal.title}</h1>
          <span style={{ fontSize: "0.85rem", color: "var(--muted)", textTransform: "uppercase", letterSpacing: "0.05em" }}>
            {t("updatedAt", { date: ageText(proposal.updatedAt) })}
          </span>
        </div>
      </div>

      <div style={{ display: "grid", gridTemplateColumns: "3fr 1fr", gap: "64px" }}>
        {/* Main Article Body */}
        <article style={{ fontSize: "1.1rem", lineHeight: 1.8, color: "var(--text)" }}>
          {proposal.summary && (
            <section
              aria-label={t("summaryTitle")}
              style={{
                borderLeft: "3px solid var(--accent)",
                marginBottom: "32px",
                paddingLeft: "20px",
              }}
            >
              <h2 style={{ fontSize: "0.85rem", textTransform: "uppercase", letterSpacing: "0.05em", margin: "0 0 8px", color: "var(--muted)" }}>
                {t("summaryTitle")}
              </h2>
              <p style={{ margin: 0, fontSize: "1rem", lineHeight: 1.6, color: "var(--text)" }}>{proposal.summary}</p>
            </section>
          )}
          <MarkdownRenderer markdown={proposal.bodyMd} variant="document" className="nr-markdown" />

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
          {canManage && canOpenPrivateDraft(proposal) && (
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
                <ProposalDraftFields defaultTitle={proposal.title} defaultBodyMd={proposal.bodyMd} />
                <button type="submit" className="secondary small">{t("btnSaveDraft")}</button>
              </form>
            </details>
          )}

          {canResolve && proposal.status === "OPEN" && (
            <div className="stack mb-8">
              <h3 style={{ fontSize: "0.85rem", textTransform: "uppercase", letterSpacing: "0.05em", color: "var(--text)", marginBottom: "16px" }}>{t("resolveProposalTitle")}</h3>
              <form action={resolveProposalAction} className="stack nr-form-section">
                <input type="hidden" name="workspaceId" value={workspaceId} />
                <input type="hidden" name="proposalId" value={proposal.id} />
                <label>
                  {t("formResolutionOutcome")}
                  <select name="outcome" defaultValue="ADOPTED" required>
                    <option value="ADOPTED">{t("outcomeAdopted")}</option>
                    <option value="NOT_ADOPTED">{t("outcomeNotAdopted")}</option>
                    <option value="WITHDRAWN">{t("outcomeWithdrawn")}</option>
                  </select>
                </label>
                <label>
                  {t("formDecisionNote")}
                  <MarkdownEditor name="decisionMd" placeholder={t("placeholderDecisionMd")} required rows={4} />
                </label>
                <button type="submit" className="secondary small">{t("btnResolve")}</button>
              </form>
            </div>
          )}
          
          <h3 style={{ fontSize: "0.85rem", textTransform: "uppercase", letterSpacing: "0.05em", color: "var(--text)", marginBottom: "16px" }}>{t("aboutTitle")}</h3>
          <div className="nr-meta mb-4">
            <strong>{t("aboutCreated")}</strong> {new Date(proposal.createdAt).toLocaleDateString()}
          </div>
          {(proposal.tensions.length > 0 || proposal.actions.length > 0) && (
            <div className="nr-meta mb-4">
              <strong>{t("aboutRelated")}</strong>
              <div style={{ display: "flex", flexWrap: "wrap", gap: 6, marginTop: 8 }}>
                {proposal.tensions.map((tension) => (
                  <Link key={tension.id} href={`/workspaces/${workspaceId}/tensions/${tension.id}`} className="tag info" style={{ textDecoration: "none" }}>
                    {t("tensionTag", { title: tension.title })}
                  </Link>
                ))}
                {proposal.actions.map((action) => (
                  <span key={action.id} className="tag info">
                    {t("actionTag", { title: action.title })}
                  </span>
                ))}
              </div>
            </div>
          )}
        </aside>
      </div>
    </>
  );
}
