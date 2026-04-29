import { getTension, listDeliberationEntries, requireWorkspaceMembership } from "@corgtex/domain";
import { requirePageActor } from "@/lib/auth";
import { DeliberationThread } from "@/lib/components/DeliberationThread";
import { DeliberationComposer } from "@/lib/components/DeliberationComposer";
import { getDeliberationTargets } from "@/lib/deliberation-targets";
import { postTensionDeliberationAction, publishTensionAction, returnTensionToDraftAction, resolveTensionDeliberationAction, updateTensionAction } from "../actions";
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
  const tension = await getTension(actor, { workspaceId, tensionId });
  const membership = await requireWorkspaceMembership({ actor, workspaceId });
  const entries = await listDeliberationEntries(actor, { workspaceId, parentType: "TENSION", parentId: tensionId });
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

  return (
    <>
      <header className="nr-masthead" style={{ textAlign: "left", marginBottom: 32 }}>
        <div style={{ marginBottom: 16 }}>
          <a href={`/workspaces/${workspaceId}/tensions`} style={{ textDecoration: "none", color: "var(--muted)" }}>
            {t("backToTensions")}
          </a>
        </div>
        <h1 style={{ border: "none", padding: 0, margin: 0, fontSize: "2.5rem" }}>
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
        </div>
      </header>

      {canManage && (
        <section className="ws-section" style={{ marginBottom: 24 }}>
          <div className="actions-inline">
            {tension.status === "DRAFT" && (
              <form action={publishTensionAction}>
                <input type="hidden" name="workspaceId" value={workspaceId} />
                <input type="hidden" name="tensionId" value={tension.id} />
                <button type="submit" className="primary small">{t("btnOpen")}</button>
              </form>
            )}
            {tension.status === "OPEN" && (
              <form action={returnTensionToDraftAction}>
                <input type="hidden" name="workspaceId" value={workspaceId} />
                <input type="hidden" name="tensionId" value={tension.id} />
                <button type="submit" className="secondary small">{t("btnReturnToDraft")}</button>
              </form>
            )}
          </div>
          {tension.status === "DRAFT" && (
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
                  <textarea name="bodyMd" defaultValue={tension.bodyMd ?? ""} />
                </label>
                <label>
                  {t("formPriority")}
                  <input name="priority" type="number" min={0} defaultValue={tension.priority} />
                </label>
                <button type="submit" className="secondary small">{t("btnSaveDraft")}</button>
              </form>
            </details>
          )}
        </section>
      )}

      <section className="ws-section" style={{ marginBottom: 48 }}>
        <h2 className="nr-section-header">{t("sectionDescription")}</h2>
        <div className="nr-item">
          {tension.bodyMd ? (
            <div style={{ whiteSpace: "pre-wrap" }}>{tension.bodyMd}</div>
          ) : (
            <em className="muted">{t("noDescription")}</em>
          )}
        </div>
      </section>

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
