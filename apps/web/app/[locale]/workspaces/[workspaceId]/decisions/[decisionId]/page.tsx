import Link from "next/link";
import { notFound } from "next/navigation";
import { getFormatter, getTranslations } from "next-intl/server";
import { AppError, getDecisionRecord, listDecisionLinkOptions, requireWorkspaceMembership } from "@corgtex/domain";
import { requirePageActor } from "@/lib/auth";
import { MarkdownRenderer } from "@/lib/components/MarkdownRenderer";
import { WorkItemEditForm } from "@/lib/components/WorkItemEditForm";
import { ConfirmSubmitButton } from "../../circles/ConfirmSubmitButton";
import { archiveDecisionAction, restoreDecisionAction, updateDecisionAction } from "../actions";
import { DecisionFields } from "../DecisionFields";

export const dynamic = "force-dynamic";

export default async function DecisionPage({ params }: { params: Promise<{ workspaceId: string; decisionId: string }> }) {
  const { workspaceId, decisionId } = await params;
  const actor = await requirePageActor();
  const t = await getTranslations("decisions");
  const format = await getFormatter();
  let decision;
  try {
    decision = await getDecisionRecord(actor, { workspaceId, decisionId });
  } catch (error) {
    if (error instanceof AppError && error.code === "NOT_FOUND") notFound();
    throw error;
  }
  const [membership, options] = await Promise.all([
    requireWorkspaceMembership({ actor, workspaceId }),
    listDecisionLinkOptions(actor, workspaceId),
  ]);
  const canEdit = actor.kind === "agent" || membership?.role === "ADMIN" || decision.createdByUserId === actor.user.id;

  return (
    <div className="stack">
      <Link href={`/workspaces/${workspaceId}/decisions`}>{t("back")}</Link>
      <header className="nr-masthead nr-masthead-left">
        <h1 className="nr-masthead-title">{decision.title}</h1>
        <div className="nr-masthead-meta">
          {format.dateTime(decision.decidedAt, { dateStyle: "medium", timeZone: "UTC" })}
          {decision.archivedAt && ` · ${t("archived")}`}
        </div>
      </header>
      <section className="panel stack">
        <MarkdownRenderer markdown={decision.bodyMd} />
        <div className="actions-inline">{decision.tags.map((tag) => <span key={tag} className="tag">{tag}</span>)}</div>
        {(decision.proposal || decision.tension) && <>
          <h2>{t("related")}</h2>
          <div className="actions-inline">
            {decision.proposal && <Link style={{ textDecoration: "underline" }} href={`/workspaces/${workspaceId}/proposals/${decision.proposal.id}`}>{t("proposal")}: {decision.proposal.title}</Link>}
            {decision.tension && <Link style={{ textDecoration: "underline" }} href={`/workspaces/${workspaceId}/tensions/${decision.tension.id}`}>{t("tension")}: {decision.tension.title}</Link>}
          </div>
        </>}
      </section>
      {canEdit && !decision.archivedAt && <section className="panel stack">
        <h2>{t("edit")}</h2>
        <WorkItemEditForm action={updateDecisionAction} expectedVersion={decision.version}
          currentHref={`/workspaces/${workspaceId}/decisions/${decision.id}`} submitLabel={t("update")} className="stack">
          <DecisionFields workspaceId={workspaceId} proposals={options.proposals} tensions={options.tensions} decision={decision} />
        </WorkItemEditForm>
        <form action={archiveDecisionAction}>
          <input type="hidden" name="workspaceId" value={workspaceId} />
          <input type="hidden" name="decisionId" value={decision.id} />
          <input type="hidden" name="expectedVersion" value={decision.version} />
          <ConfirmSubmitButton className="secondary" message={t("archiveConfirm")}>{t("archive")}</ConfirmSubmitButton>
        </form>
      </section>}
      {canEdit && decision.archivedAt && <form action={restoreDecisionAction}>
        <input type="hidden" name="workspaceId" value={workspaceId} />
        <input type="hidden" name="decisionId" value={decision.id} />
        <input type="hidden" name="expectedVersion" value={decision.version} />
        <button type="submit">{t("restore")}</button>
      </form>}
    </div>
  );
}
