import Link from "next/link";
import { AppError, getAction, getWorkspaceArchiveRecord, listDeliberationEntries, listWorkItemEvidence, listWorkItemVersions, requireWorkspaceMembership } from "@corgtex/domain";
import { requirePageActor } from "@/lib/auth";
import { MarkdownEditor } from "@/lib/components/MarkdownEditor";
import { MarkdownRenderer } from "@/lib/components/MarkdownRenderer";
import { WorkItemResolutionDialog } from "@/lib/components/WorkItemResolutionDialog";
import { ArchivedItemBanner } from "@/lib/components/ArchivedItemBanner";
import { UnavailableItemStatus } from "@/lib/components/UnavailableItemStatus";
import { DeliberationComposer } from "@/lib/components/DeliberationComposer";
import { DeliberationThread } from "@/lib/components/DeliberationThread";
import { getDeliberationTargets } from "@/lib/deliberation-targets";
import { canOpenPrivateDraft } from "@/lib/governance-open-guards";
import { deleteActionAction, postActionDeliberationAction, publishActionAction, resolveActionDeliberationAction, returnActionToDraftAction, updateActionAction, updateActionDeliberationAction } from "../../actions";
import { getTranslations } from "next-intl/server";

export const dynamic = "force-dynamic";

async function archivedSafeRead<T>(isArchived: boolean, read: Promise<T>, fallback: T): Promise<T> {
  if (!isArchived) return read;
  try {
    return await read;
  } catch {
    return fallback;
  }
}

export default async function ActionDetailPage({
  params,
}: {
  params: Promise<{ workspaceId: string; actionId: string }>;
}) {
  const { workspaceId, actionId } = await params;
  const actor = await requirePageActor();
  const t = await getTranslations("actions");
  const tCommon = await getTranslations("common");
  const tWork = await getTranslations("workItems");
  const membership = await requireWorkspaceMembership({ actor, workspaceId });
  let action: Awaited<ReturnType<typeof getAction>>;
  try {
    action = await getAction(actor, { workspaceId, actionId, includeArchived: true });
  } catch (error) {
    if (error instanceof AppError && error.code === "NOT_FOUND") {
      const archiveRecord = await getWorkspaceArchiveRecord(actor, {
        workspaceId,
        entityType: "Action",
        entityId: actionId,
        includePurged: true,
      });
      const canShowArchiveRecord = actor.kind === "agent" || membership?.role === "ADMIN";
      return (
        <UnavailableItemStatus
          workspaceId={workspaceId}
          entityType="Action"
          entityId={actionId}
          archiveRecord={canShowArchiveRecord ? archiveRecord : null}
          backHref={`/workspaces/${workspaceId}/actions`}
          backLabel={t("backToActions")}
        />
      );
    }
    throw error;
  }
  const isArchived = Boolean(action.archivedAt);
  const [versionHistory, evidence, deliberationEntries, archiveRecord] = await Promise.all([
    archivedSafeRead(isArchived, listWorkItemVersions(actor, { workspaceId, entityType: "ACTION", entityId: actionId }), {
      entityType: "Action" as const,
      entityId: actionId,
      currentVersion: action.version,
      versions: [],
    }),
    archivedSafeRead(isArchived, listWorkItemEvidence(actor, { workspaceId, entityType: "Action", entityId: actionId }), []),
    archivedSafeRead(isArchived, listDeliberationEntries(actor, { workspaceId, parentType: "ACTION", parentId: actionId }), []),
    isArchived
      ? archivedSafeRead(true, getWorkspaceArchiveRecord(actor, { workspaceId, entityType: "Action", entityId: action.id }), null)
      : Promise.resolve(null),
  ]);
  const completionEvidence = evidence.filter((row) => row.purpose === "completion_evidence");
  const feedbackContextEvidence = evidence.filter((row) => row.purpose === "feedback_context");
  const deliberationTargets = isArchived
    ? { options: [], defaultValue: "", actorMemberId: null, actorCircleIds: [] }
    : await getDeliberationTargets({ actor, workspaceId, parentCircleId: action.circleId });
  const targetOptions = deliberationTargets.options.map((option) => ({
    ...option,
    label: option.kind === "circle"
      ? t("targetCircle", { name: option.name })
      : t("targetPerson", { name: option.name }),
  }));

  const statusClass = action.status === "DRAFT"
    ? "info"
    : action.status === "COMPLETED"
      ? "success"
      : action.status === "IN_PROGRESS"
        ? "info"
        : "neutral";
  const statusLabel = {
    DRAFT: t("statusDraft"),
    OPEN: t("statusOpen"),
    IN_PROGRESS: t("statusInProgress"),
    COMPLETED: t("statusCompleted"),
  }[action.status];
  const authorName = action.author?.displayName || action.author?.email || "Unknown";
  const assigneeName = action.assigneeMember?.user?.displayName || action.assigneeMember?.user?.email || null;
  const canManage = !isArchived && (actor.kind === "agent"
    || membership?.role === "ADMIN"
    || (actor.kind === "user" && action.authorUserId === actor.user.id));
  const isAdmin = actor.kind === "agent" || membership?.role === "ADMIN";
  const actorUserId = actor.kind === "user" ? actor.user.id : null;
  const actorMemberId = deliberationTargets.actorMemberId;
  const actorCircleIds = new Set(deliberationTargets.actorCircleIds);
  const isParentResponsible = Boolean(
    actorUserId && action.authorUserId === actorUserId
      || actorMemberId && action.assigneeMemberId === actorMemberId,
  );
  const canManageEntry = (entry: (typeof deliberationEntries)[number]) => !isArchived && Boolean(
    isAdmin
      || (actorUserId && entry.authorUserId === actorUserId)
      || isParentResponsible
      || (actorMemberId && entry.targetMemberId === actorMemberId)
      || (entry.targetCircleId && actorCircleIds.has(entry.targetCircleId)),
  );
  const canSubmittedEditorEdit = actor.kind === "user"
    && (action.authorUserId === actor.user.id || action.assigneeMemberId === membership?.id);
  const canEditContent = !isArchived && action.status === "DRAFT"
    ? canManage
    : !isArchived && (action.status === "OPEN" || action.status === "IN_PROGRESS") && canSubmittedEditorEdit;

  return (
    <>
      <header className="nr-masthead" style={{ textAlign: "left", marginBottom: 32 }}>
        <div style={{ marginBottom: 16 }}>
          <Link href={`/workspaces/${workspaceId}/actions`} style={{ textDecoration: "none", color: "var(--muted)" }}>
            {t("backToActions")}
          </Link>
        </div>
        <h1 style={{ border: "none", padding: 0, margin: 0, fontSize: "2rem" }}>
          {action.title}
        </h1>
        <div className="nr-masthead-meta" style={{ marginTop: 12 }}>
          <span className={`tag ${statusClass}`}>{statusLabel}</span>
          <span>{t("metaCreator", { name: authorName })}</span>
          {assigneeName && <span>{t("metaAssignee", { name: assigneeName })}</span>}
          <span>{tWork("priorityN", { priority: action.priority })}</span>
          <span>{new Date(action.createdAt).toLocaleDateString()}</span>
          <span>
            {versionHistory.versions.length > 0 ? (
              <Link href={`/workspaces/${workspaceId}/versions?entityType=ACTION&entityId=${encodeURIComponent(action.id)}`}>v{action.version}</Link>
            ) : (
              <>v{action.version}</>
            )}
          </span>
          {action.proposal && (
            <span>
              <Link href={`/workspaces/${workspaceId}/proposals/${action.proposal.id}`}>{t("metaLinkedToProposal", { title: action.proposal.title })}</Link>
            </span>
          )}
        </div>
      </header>

      {isArchived && (
        <ArchivedItemBanner
          archivedAt={action.archivedAt}
          archivedBy={archiveRecord?.archivedByLabel ?? archiveRecord?.archivedByUserId}
          archiveReason={action.archiveReason}
          restoreHref={isAdmin ? `/workspaces/${workspaceId}/audit?tab=archive&archiveEntityType=Action` : null}
        />
      )}

      {!isArchived && (canManage || canEditContent || action.status === "OPEN" || action.status === "IN_PROGRESS") && (
        <section className="ws-section" style={{ marginBottom: 24 }}>
          <div className="actions-inline">
            {canManage && canOpenPrivateDraft(action) && (
              <form action={publishActionAction}>
                <input type="hidden" name="workspaceId" value={workspaceId} />
                <input type="hidden" name="actionId" value={action.id} />
                <button type="submit" className="primary small">{t("btnOpen")}</button>
              </form>
            )}
            {action.status === "OPEN" && (
              <form action={updateActionAction}>
                <input type="hidden" name="workspaceId" value={workspaceId} />
                <input type="hidden" name="actionId" value={action.id} />
                <input type="hidden" name="status" value="IN_PROGRESS" />
                <button type="submit" className="primary small">{t("btnStart")}</button>
              </form>
            )}
            {(action.status === "OPEN" || action.status === "IN_PROGRESS") && (
              <WorkItemResolutionDialog
                action={updateActionAction}
                buttonLabel={t("btnComplete")}
                title={tWork("completeActionTitle")}
                noteName="completedVia"
                noteLabel={tWork("completionNote")}
                notePlaceholder={tWork("completionPlaceholder")}
                hiddenFields={{ workspaceId, actionId: action.id, status: "COMPLETED" }}
                submitLabel={t("btnComplete")}
                cancelLabel={tCommon("cancel")}
                fileLabel={tWork("evidence")}
              />
            )}
            {canManage && (action.status === "OPEN" || action.status === "IN_PROGRESS") && (
              <form action={returnActionToDraftAction}>
                <input type="hidden" name="workspaceId" value={workspaceId} />
                <input type="hidden" name="actionId" value={action.id} />
                <button type="submit" className="secondary small">{t("btnReturnToDraft")}</button>
              </form>
            )}
            <form action={deleteActionAction}>
              <input type="hidden" name="workspaceId" value={workspaceId} />
              <input type="hidden" name="actionId" value={action.id} />
              <button type="submit" className="secondary small danger">{t("btnDelete")}</button>
            </form>
          </div>
          {canEditContent && (
            <details style={{ marginTop: 12 }}>
              <summary className="secondary small nr-hide-marker" style={{ cursor: "pointer", display: "inline-block" }}>{t("btnEdit")}</summary>
              <form action={updateActionAction} className="stack nr-form-section" style={{ marginTop: 12 }}>
                <input type="hidden" name="workspaceId" value={workspaceId} />
                <input type="hidden" name="actionId" value={action.id} />
                <label>
                  {t("formTitle")}
                  <input name="title" defaultValue={action.title} required />
                </label>
                <label>
                  {t("formNotes")}
                  <MarkdownEditor name="bodyMd" defaultValue={action.bodyMd ?? ""} rows={6} />
                </label>
                <label>
                  {t("formPriority")}
                  <input name="priority" type="number" min={0} defaultValue={action.priority} />
                </label>
                <button type="submit" className="secondary small">{action.status === "DRAFT" ? t("btnSaveDraft") : tCommon("save")}</button>
              </form>
            </details>
          )}
        </section>
      )}

      <section className="ws-section" style={{ marginBottom: 48 }}>
        <h2 className="nr-section-header">{t("sectionNotes")}</h2>
        <div className="nr-item">
          {action.bodyMd ? (
            <MarkdownRenderer markdown={action.bodyMd} variant="document" />
          ) : (
            <em className="muted">{t("noNotes")}</em>
          )}
        </div>
      </section>

      {feedbackContextEvidence.length > 0 && (
        <section className="ws-section" style={{ marginBottom: 48 }}>
          <h2 className="nr-section-header">{tWork("feedbackContext")}</h2>
          <div className="nr-item">
            <div className="nr-evidence-list">
              {feedbackContextEvidence.map((row) => (
                <Link key={row.id} href={`/workspaces/${workspaceId}/brain/sources`}>
                  {row.document.title}
                </Link>
              ))}
            </div>
          </div>
        </section>
      )}

      <section className="ws-section" style={{ marginBottom: 48 }}>
        <h2 className="nr-section-header">{t("sectionDiscussion")}</h2>
        <DeliberationThread
          entries={deliberationEntries.map((entry) => ({
            id: entry.id,
            entryType: entry.entryType,
            authorName: entry.author?.displayName || entry.author?.email || "Unknown",
            authorInitials: (entry.author?.displayName || entry.author?.email || "?").substring(0, 2).toUpperCase(),
            bodyMd: entry.bodyMd,
            createdAt: entry.createdAt,
            parentVersion: entry.parentVersion,
            resolvedAt: entry.resolvedAt,
            resolvedNote: entry.resolvedNote,
            targetLabel: entry.targetCircle
              ? t("targetCircle", { name: entry.targetCircle.name })
              : entry.targetMember
                ? t("targetPerson", { name: entry.targetMember.user.displayName || entry.targetMember.user.email })
                : null,
            canEdit: canManageEntry(entry),
            canResolve: canManageEntry(entry),
          }))}
          canResolve={false}
          resolveAction={resolveActionDeliberationAction}
          updateAction={updateActionDeliberationAction}
          hiddenFields={{ workspaceId, parentId: actionId }}
        />
        {!isArchived && (action.status === "OPEN" || action.status === "IN_PROGRESS") && (
          <div style={{ marginTop: 24 }}>
            <DeliberationComposer
              postAction={postActionDeliberationAction}
              hiddenFields={{ workspaceId, parentId: actionId }}
              targetOptions={targetOptions}
              entryTypes={[
                { value: "REACTION", label: t("entryReaction"), variant: "secondary" },
                { value: "OBJECTION", label: t("entryObjection"), variant: "danger" },
              ]}
            />
          </div>
        )}
      </section>

      {action.status === "COMPLETED" && action.completedVia && (
        <section className="ws-section" style={{ marginBottom: 48 }}>
          <h2 className="nr-section-header">{t("sectionCompletion")}</h2>
          <div className="nr-item">
            <MarkdownRenderer markdown={action.completedVia} variant="document" />
            {completionEvidence.length > 0 && (
              <div className="nr-evidence-list">
                <strong>{tWork("completionEvidence")}</strong>
                {completionEvidence.map((row) => (
                  <Link key={row.id} href={`/workspaces/${workspaceId}/brain/sources`}>
                    {row.document.title}
                  </Link>
                ))}
              </div>
            )}
          </div>
        </section>
      )}
    </>
  );
}
