import { notFound } from "next/navigation";
import Link from "next/link";
import { getProposal, listDeliberationEntries, listWorkItemVersions, requireWorkspaceMembership } from "@corgtex/domain";
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
  const tCommon = await getTranslations("common");

  const proposal = await getProposal(actor, { workspaceId, proposalId });
  if (!proposal) notFound();
  const membership = await requireWorkspaceMembership({ actor, workspaceId });

  const [deliberationEntries, versionHistory] = await Promise.all([
    listDeliberationEntries(actor, {
      workspaceId,
      parentType: "PROPOSAL",
      parentId: proposalId,
    }),
    listWorkItemVersions(actor, { workspaceId, entityType: "PROPOSAL", entityId: proposalId }),
  ]);
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
  const canEditContent = proposal.status === "DRAFT" ? canManage : proposal.status === "OPEN" && isAuthor;
  const canResolve = actor.kind === "agent" || Boolean(membership);

  return (
    <>
      <div className="nr-masthead nr-masthead-left mb-8">
        <p className="nr-meta nr-meta-flex mb-3">
          <span><Link href={`/workspaces/${workspaceId}/proposals`} className="nr-link-inherit">{t("backToProposals")}</Link></span>
          <span>·</span>
          <span>{proposal.author.displayName || proposal.author.email}</span>
          <span>·</span>
          <span className={`tag ${statusClass}`}>
            {proposal.status === "RESOLVED" && proposal.resolutionOutcome ? `${proposal.status} · ${proposal.resolutionOutcome.replace("_", " ")}` : proposal.status}
          </span>
          <span>·</span>
          <span>
            {versionHistory.versions.length > 0 ? (
              <Link href={`/workspaces/${workspaceId}/versions?entityType=PROPOSAL&entityId=${encodeURIComponent(proposal.id)}`} className="nr-link-inherit">v{proposal.version}</Link>
            ) : (
              <>v{proposal.version}</>
            )}
          </span>
        </p>
        <div className="nr-page-header">
          <h1 className="nr-page-title">{proposal.title}</h1>
          <span className="nr-page-date">
            {t("updatedAt", { date: ageText(proposal.updatedAt) })}
          </span>
        </div>
      </div>

      <div className="nr-detail-grid">
        {/* Main Article Body */}
        <article className="nr-article">
          {proposal.summary && (
            <section
              aria-label={t("summaryTitle")}
              className="nr-summary-section"
            >
              <h2 className="nr-summary-title">
                {t("summaryTitle")}
              </h2>
              <p className="nr-summary-body">{proposal.summary}</p>
            </section>
          )}
          <MarkdownRenderer markdown={proposal.bodyMd} variant="document" className="nr-markdown" />

          <hr className="nr-divider nr-divider-lg" />

          <h3 className="font-playfair font-semibold mb-6 text-[1.4rem]">{t("sectionDeliberation")}</h3>
          <DeliberationThread
            entries={deliberationEntries.map((e) => ({
              id: e.id,
              entryType: e.entryType,
              authorName: e.author?.displayName || t("authorUnknown"),
              authorInitials: (e.author?.displayName || "U").substring(0, 2).toUpperCase(),
              bodyMd: e.bodyMd,
              createdAt: e.createdAt,
              parentVersion: e.parentVersion,
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
        <aside className="nr-sidebar">
          {canManage && canOpenPrivateDraft(proposal) && (
            <div className="stack mb-8">
              <form action={submitProposalAction} className="nr-form-stack">
                <input type="hidden" name="workspaceId" value={workspaceId} />
                <input type="hidden" name="proposalId" value={proposal.id} />
                <button className="w-full">{t("btnOpen")}</button>
              </form>
            </div>
          )}
          {canManage && proposal.status === "OPEN" && (
            <div className="stack mb-8">
              <form action={returnProposalToDraftAction} className="nr-form-stack">
                <input type="hidden" name="workspaceId" value={workspaceId} />
                <input type="hidden" name="proposalId" value={proposal.id} />
                <button className="secondary w-full">{t("btnReturnToDraft")}</button>
              </form>
            </div>
          )}
          {canEditContent && (
            <details className="stack mb-8">
              <summary className="secondary small nr-hide-marker cursor-pointer">{t("btnEdit")}</summary>
              <form action={updateProposalAction} className="stack nr-form-section mt-3">
                <input type="hidden" name="workspaceId" value={workspaceId} />
                <input type="hidden" name="proposalId" value={proposal.id} />
                <ProposalDraftFields defaultTitle={proposal.title} defaultBodyMd={proposal.bodyMd} />
                <button type="submit" className="secondary small">{proposal.status === "DRAFT" ? t("btnSaveDraft") : tCommon("save")}</button>
              </form>
            </details>
          )}

          {canResolve && proposal.status === "OPEN" && (
            <div className="stack mb-8">
              <h3 className="nr-sidebar-title">{t("resolveProposalTitle")}</h3>
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
          
          <h3 className="nr-sidebar-title">{t("aboutTitle")}</h3>
          <div className="nr-meta mb-4">
            <strong>{t("aboutCreated")}</strong> {new Date(proposal.createdAt).toLocaleDateString()}
          </div>
          {(proposal.tensions.length > 0 || proposal.actions.length > 0) && (
            <div className="nr-meta mb-4">
              <strong>{t("aboutRelated")}</strong>
              <div className="nr-tag-group mt-2">
                {proposal.tensions.map((tension) => (
                  <Link key={tension.id} href={`/workspaces/${workspaceId}/tensions/${tension.id}`} className="tag info no-underline">
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
