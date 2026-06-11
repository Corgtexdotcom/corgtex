import Link from "next/link";
import { getTension, listDeliberationEntries, listWorkItemEvidence, listWorkItemVersions, requireWorkspaceMembership } from "@corgtex/domain";
import { requirePageActor } from "@/lib/auth";
import { MarkdownEditor } from "@/lib/components/MarkdownEditor";
import { MarkdownRenderer } from "@/lib/components/MarkdownRenderer";
import { WorkItemResolutionDialog } from "@/lib/components/WorkItemResolutionDialog";
import { DeliberationThread } from "@/lib/components/DeliberationThread";
import { DeliberationComposer } from "@/lib/components/DeliberationComposer";
import { getDeliberationTargets } from "@/lib/deliberation-targets";
import { canOpenPrivateDraft } from "@/lib/governance-open-guards";
import { createProposalFromTensionAction, postTensionDeliberationAction, publishTensionAction, returnTensionToDraftAction, resolveTensionDeliberationAction, updateTensionAction } from "../../actions";
import { getTranslations } from "next-intl/server";

export const dynamic = "force-dynamic";

export default async function TensionDetailPage({
  params,
}: {
  params: Promise<{ workspaceId: string; tensionId: string }>;
}) {
  const { workspaceId, tensionId } = await params;
  const actor = await requirePageActor();
  const t = await getTranslations("tensions");
  const tCommon = await getTranslations("common");
  const tWork = await getTranslations("workItems");
  const tension = await getTension(actor, { workspaceId, tensionId });
  const membership = await requireWorkspaceMembership({ actor, workspaceId });
  const [entries, versionHistory, evidence] = await Promise.all([
    listDeliberationEntries(actor, { workspaceId, parentType: "TENSION", parentId: tensionId }),
    listWorkItemVersions(actor, { workspaceId, entityType: "TENSION", entityId: tensionId }),
    listWorkItemEvidence(actor, { workspaceId, entityType: "Tension", entityId: tensionId }),
  ]);
  const deliberationTargets = await getDeliberationTargets({ actor, workspaceId, parentCircleId: tension.circleId });
  const targetOptions = deliberationTargets.options.map((option) => ({
    ...option,
    label: option.kind === "circle"
      ? t("targetCircle", { name: option.name })
      : t("targetPerson", { name: option.name }),
  }));
  const mappedEntries = entries.map((e: any) => ({
    ...e,
    authorName: e.author?.displayName || e.author?.email || t("authorUnknown"),
    authorInitials: (e.author?.displayName || e.author?.email || t("authorInitialsUnknown")).substring(0, 2).toUpperCase(),
    targetLabel: e.targetCircle
      ? t("targetCircle", { name: e.targetCircle.name })
      : e.targetMember
        ? t("targetPerson", { name: e.targetMember.user.displayName || e.targetMember.user.email })
        : null,
  }));

  const statusLabel = (status: string) => {
    const labels: Record<string, string> = {
      DRAFT: t("statusDraft"),
      OPEN: t("statusOpen"),
      RESOLVED: t("statusResolved"),
    };
    return labels[status] ?? status;
  };

  const priorityText = tension.priority > 0 ? t("priorityN", { priority: tension.priority }) : t("noPriority");
  const raisedByName = tension.raisedByMember?.user.displayName || tension.raisedByMember?.user.email || null;
  const canManage = actor.kind === "agent" || membership?.role === "ADMIN" || (actor.kind === "user" && tension.authorUserId === actor.user.id);
  const canSubmittedAuthorEdit = actor.kind === "user" && tension.authorUserId === actor.user.id;
  const canEditContent = tension.status === "DRAFT" ? canManage : tension.status === "OPEN" && canSubmittedAuthorEdit;
  const canDraftProposal = !tension.proposal && (canManage || !tension.isPrivate);
  const canResolve = !tension.isPrivate && tension.status === "OPEN";

  return (
    <>
      <header className="nr-masthead" style={{ textAlign: "left", marginBottom: 32 }}>
        <div style={{ marginBottom: 16 }}>
          <a href={`/workspaces/${workspaceId}/tensions`} style={{ textDecoration: "none", color: "var(--muted)" }}>
            {t("backToTensions")}
          </a>
        </div>
        <h1 style={{ border: "none", padding: 0, margin: 0, fontSize: "2rem" }}>
          {tension.isPrivate && <span title={t("privateInboxTooltip")} style={{ marginRight: 6 }}>◆</span>}
          {tension.title}
        </h1>
        <div className="nr-masthead-meta" style={{ marginTop: 12 }}>
          <span className={`tag ${tension.status === "DRAFT" ? "info" : tension.status === "OPEN" ? "warning" : "success"}`}>
            {statusLabel(tension.status)}
          </span>
          <span>{t("detailAuthorMeta", { author: tension.author.displayName || tension.author.email || t("authorUnknown") })}</span>
          {raisedByName && <span>{t("detailRaisedByMeta", { name: raisedByName })}</span>}
          <span>{t("detailPriorityMeta", { priority: priorityText })}</span>
          <span>{t("detailCreatedMeta", { date: new Date(tension.createdAt).toLocaleDateString() })}</span>
          <span>
            {versionHistory.versions.length > 0 ? (
              <a href={`/workspaces/${workspaceId}/versions?entityType=TENSION&entityId=${encodeURIComponent(tension.id)}`}>v{tension.version}</a>
            ) : (
              <>v{tension.version}</>
            )}
          </span>
          {tension.proposal && (
            <span>
              <a href={`/workspaces/${workspaceId}/proposals/${tension.proposal.id}`}>{t("linkedProposalMeta", { title: tension.proposal.title })}</a>
            </span>
          )}
        </div>
      </header>

      {(canManage || canDraftProposal || canResolve) && (
        <section className="ws-section" style={{ marginBottom: 24 }}>
          <div className="actions-inline">
            {canManage && canOpenPrivateDraft(tension) && (
              <form action={publishTensionAction}>
                <input type="hidden" name="workspaceId" value={workspaceId} />
                <input type="hidden" name="tensionId" value={tension.id} />
                <button type="submit" className="primary small">{t("btnOpen")}</button>
              </form>
            )}
            {canManage && tension.status === "OPEN" && (
              <form action={returnTensionToDraftAction}>
                <input type="hidden" name="workspaceId" value={workspaceId} />
                <input type="hidden" name="tensionId" value={tension.id} />
                <button type="submit" className="secondary small">{t("btnReturnToDraft")}</button>
              </form>
            )}
            {canResolve && (
              <WorkItemResolutionDialog
                action={updateTensionAction}
                buttonLabel={t("btnResolve")}
                title={tWork("resolveTensionTitle")}
                noteName="resolvedVia"
                noteLabel={tWork("resolutionNote")}
                notePlaceholder={t("placeholderResolvedVia")}
                hiddenFields={{ workspaceId, tensionId: tension.id, status: "RESOLVED" }}
                submitLabel={t("btnResolve")}
                cancelLabel={tCommon("cancel")}
                fileLabel={tWork("evidence")}
              />
            )}
            {canDraftProposal && (
              <form action={createProposalFromTensionAction}>
                <input type="hidden" name="workspaceId" value={workspaceId} />
                <input type="hidden" name="sourceTensionId" value={tension.id} />
                <button type="submit" className="secondary small">{t("btnDraftProposal")}</button>
              </form>
            )}
          </div>
          {canEditContent && (
            <details style={{ marginTop: 12 }}>
              <summary className="secondary small nr-hide-marker" style={{ cursor: "pointer", display: "inline-block" }}>{t("btnEdit")}</summary>
              <form action={updateTensionAction} className="stack nr-form-section" style={{ marginTop: 12 }}>
                <input type="hidden" name="workspaceId" value={workspaceId} />
                <input type="hidden" name="tensionId" value={tension.id} />
                <label>
                  {t("formTitle")}
                  <input name="title" defaultValue={tension.title} required />
                </label>
                <label>
                  {t("formDescription")}
                  <MarkdownEditor name="bodyMd" defaultValue={tension.bodyMd ?? ""} rows={6} />
                </label>
                <label>
                  {t("formPriority")}
                  <input name="priority" type="number" min={0} defaultValue={tension.priority} />
                </label>
                <button type="submit" className="secondary small">{tension.status === "DRAFT" ? t("btnSaveDraft") : tCommon("save")}</button>
              </form>
            </details>
          )}
        </section>
      )}

      <section className="ws-section" style={{ marginBottom: 48 }}>
        <h2 className="nr-section-header">{t("sectionDescription")}</h2>
        <div className="nr-item">
          {tension.bodyMd ? (
            <MarkdownRenderer markdown={tension.bodyMd} variant="document" />
          ) : (
            <em className="muted">{t("noDescription")}</em>
          )}
        </div>
      </section>

      {tension.status === "RESOLVED" && tension.resolvedVia && (
        <section className="ws-section" style={{ marginBottom: 48 }}>
          <h2 className="nr-section-header">{t("sectionResolution")}</h2>
          <div className="nr-item">
            <MarkdownRenderer markdown={tension.resolvedVia} variant="document" />
            {evidence.length > 0 && (
              <div className="nr-evidence-list">
                <strong>{tWork("resolutionEvidence")}</strong>
                {evidence.map((row) => (
                  <Link key={row.id} href={`/workspaces/${workspaceId}/brain/sources`}>
                    {row.document.title}
                  </Link>
                ))}
              </div>
            )}
          </div>
        </section>
      )}

      <section className="ws-section" style={{ marginBottom: 48 }}>
        <h2 className="nr-section-header">{t("sectionDiscussion")}</h2>
        <DeliberationThread entries={mappedEntries} canResolve={true} resolveAction={resolveTensionDeliberationAction} hiddenFields={{ workspaceId, parentId: tensionId }} />
        {tension.status === "OPEN" && (
        <div style={{ marginTop: 24 }}>
          <DeliberationComposer
            postAction={postTensionDeliberationAction}
            hiddenFields={{ workspaceId, parentId: tensionId }}
            targetOptions={targetOptions}
            entryTypes={[
              { value: "REACTION", label: t("entryReaction"), variant: "secondary" },
              { value: "OBJECTION", label: t("entryObjection"), variant: "danger" },
            ]}
          />
        </div>
        )}
      </section>
    </>
  );
}
