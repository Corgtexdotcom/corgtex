import Link from "next/link";
import { getTranslations } from "next-intl/server";
import { getDecisionRecord, listDecisionLinkOptions, requireWorkspaceMembership } from "@corgtex/domain";
import { requirePageActor } from "@/lib/auth";
import { MarkdownRenderer } from "@/lib/components/MarkdownRenderer";
import { ConfirmSubmitButton } from "../../circles/ConfirmSubmitButton";
import { archiveDecisionAction, restoreDecisionAction, updateDecisionAction } from "../actions";
import { DecisionFields } from "../DecisionFields";

export const dynamic = "force-dynamic";

export default async function DecisionPage({ params }: { params: Promise<{ workspaceId: string; decisionId: string }> }) {
  const { workspaceId, decisionId } = await params;
  const actor = await requirePageActor();
  const t = await getTranslations("decisions");
  const [decision, membership, options] = await Promise.all([
    getDecisionRecord(actor, { workspaceId, decisionId }),
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
          {new Intl.DateTimeFormat(undefined, { dateStyle: "medium", timeZone: "UTC" }).format(decision.decidedAt)}
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
        <form action={updateDecisionAction} className="stack">
          <DecisionFields workspaceId={workspaceId} proposals={options.proposals} tensions={options.tensions} decision={decision} />
          <div><button type="submit">{t("update")}</button></div>
        </form>
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
