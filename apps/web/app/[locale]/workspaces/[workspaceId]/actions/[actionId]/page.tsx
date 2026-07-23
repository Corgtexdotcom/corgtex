import Link from "next/link";
import { AppError, getAction, getWorkspaceArchiveRecord, listActionChecklistItems, listAdviceRequests, listDeliberationEntries, listExternalResourceAttachments, listHumanMembers, listWorkItemEvidence, listWorkItemVersions, requireWorkspaceMembership } from "@corgtex/domain";
import { requirePageActor } from "@/lib/auth";
import { ConfirmSubmitButton } from "@/lib/components/ConfirmSubmitButton";
import { MarkdownRenderer } from "@/lib/components/MarkdownRenderer";
import { WorkItemResolutionDialog } from "@/lib/components/WorkItemResolutionDialog";
import { ArchivedItemBanner } from "@/lib/components/ArchivedItemBanner";
import { UnavailableItemStatus } from "@/lib/components/UnavailableItemStatus";
import { ExternalResourceAttachForm, ExternalResourceCards } from "@/lib/components/ExternalResourceCards";
import { AdviceRequestForm } from "@/lib/components/AdviceRequestForm";
import { DeliberationComposer } from "@/lib/components/DeliberationComposer";
import { DeliberationThread } from "@/lib/components/DeliberationThread";
import { WorkItemConversationSurface, WorkItemRequestList } from "@/lib/components/WorkItemConversation";
import { getDeliberationTargets } from "@/lib/deliberation-targets";
import { canOpenPrivateDraft } from "@/lib/governance-open-guards";
import { attachActionExternalResourceAction, createActionChecklistItemAction, deleteActionAction, deleteActionChecklistItemAction, postActionDeliberationAction, publishActionAction, requestActionInputAction, resolveActionDeliberationAction, returnActionToDraftAction, updateActionAction, updateActionChecklistItemAction, updateActionDeliberationAction } from "../../actions";
import { getFormatter, getTranslations } from "next-intl/server";
import { formatWorkItemPriority, type WorkItemPriorityLabels } from "@/lib/work-item-priority";

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
  const format = await getFormatter();
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
  const [versionHistory, evidence, checklistItems, externalResourceAttachments, deliberationEntries, inputRequests, archiveRecord, members] = await Promise.all([
    archivedSafeRead(isArchived, listWorkItemVersions(actor, { workspaceId, entityType: "ACTION", entityId: actionId }), {
      entityType: "Action" as const,
      entityId: actionId,
      currentVersion: action.version,
      versions: [],
    }),
    archivedSafeRead(isArchived, listWorkItemEvidence(actor, { workspaceId, entityType: "Action", entityId: actionId }), []),
    archivedSafeRead(isArchived, listActionChecklistItems(actor, { workspaceId, actionId }), []),
    archivedSafeRead(isArchived, listExternalResourceAttachments(actor, { workspaceId, entityType: "Action", entityId: actionId }), []),
    archivedSafeRead(isArchived, listDeliberationEntries(actor, { workspaceId, parentType: "ACTION", parentId: actionId }), []),
    isArchived ? Promise.resolve([]) : listAdviceRequests(actor, { workspaceId, subjectType: "ACTION", subjectId: actionId }),
    isArchived
      ? archivedSafeRead(true, getWorkspaceArchiveRecord(actor, { workspaceId, entityType: "Action", entityId: action.id }), null)
      : Promise.resolve(null),
    isArchived ? Promise.resolve([]) : listHumanMembers(workspaceId),
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
  const mappedEntries = deliberationEntries.map((entry) => ({
    ...entry,
    authorName: entry.author?.displayName || entry.author?.email || "Unknown",
    authorInitials: (entry.author?.displayName || entry.author?.email || "?").substring(0, 2).toUpperCase(),
    targetLabel: entry.targetCircle
      ? t("targetCircle", { name: entry.targetCircle.name })
      : entry.targetMember
        ? t("targetPerson", { name: entry.targetMember.user.displayName || entry.targetMember.user.email })
        : null,
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
  const priorityLabels = {
    3: tWork("priorityUrgent"),
    2: tWork("priorityImportant"),
    1: tWork("priorityMedium"),
    0: tWork("priorityLow"),
  } satisfies WorkItemPriorityLabels;
  const priorityText = formatWorkItemPriority(action.priority, priorityLabels);
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
  const canRequestInput = !isArchived
    && (action.status === "OPEN" || action.status === "IN_PROGRESS")
    && !action.isPrivate
    && (canManage || isParentResponsible);
  const memberName = (member: { user: { displayName: string | null; email: string } }) => member.user.displayName || member.user.email;
  const memberRequestOptions = members.map((member) => ({ value: member.id, label: memberName(member) }));
  const circleRequestOptions = targetOptions
    .filter((option) => option.kind === "circle")
    .map((option) => ({ value: option.value.slice("circle:".length), label: option.name }));
  const defaultCircleValue = action.circleId && circleRequestOptions.some((option) => option.value === action.circleId)
    ? action.circleId
    : circleRequestOptions[0]?.value ?? "";
  const dateTimeLabel = (value: Date | string | null | undefined) => value
    ? format.dateTime(new Date(value), { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" })
    : null;
  const channelLabel = (channel: string) => {
    const labels: Record<string, string> = {
      IN_APP: t("inputChannelInApp"),
      SLACK: t("inputChannelSlack"),
      EMAIL: t("inputChannelEmail"),
      COPY: t("inputChannelCopy"),
    };
    return labels[channel] ?? channel;
  };
  const requestStatusLabel = (requestStatus: string) => {
    const labels: Record<string, string> = {
      ACTIVE: t("inputStatusActive"),
      COMPLETED: t("inputStatusCompleted"),
      CANCELED: t("inputStatusCanceled"),
    };
    return labels[requestStatus] ?? requestStatus;
  };
  const requestStatusClass = (requestStatus: string) => {
    if (requestStatus === "ACTIVE") return "warning";
    if (requestStatus === "COMPLETED") return "success";
    return "";
  };
  const actionPath = `/workspaces/${workspaceId}/actions/${action.id}`;
  const appBaseUrl = process.env.NEXT_PUBLIC_APP_URL?.replace(/\/$/, "") ?? "";
  const actionUrl = `${appBaseUrl}${actionPath}`;
  const requestAudienceLabel = (request: (typeof inputRequests)[number]) => {
    if (request.audienceType === "WORKSPACE") return t("inputAudienceWorkspace");
    if (request.audienceType === "CIRCLE") return request.targetCircle ? t("targetCircle", { name: request.targetCircle.name }) : t("inputAudienceCircle");
    const names = request.recipients.map((recipient) => recipient.member.user.displayName || recipient.member.user.email);
    return names.length > 0 ? names.join(", ") : t("inputAudienceMembers");
  };
  const copyableRequestMessage = (request: (typeof inputRequests)[number]) => [
    t("inputCopyableSubject", { title: action.title }),
    request.messageMd,
    request.deadlineAt ? t("inputCopyableDeadline", { date: dateTimeLabel(request.deadlineAt) ?? "" }) : null,
    t("inputCopyableLink", { url: actionUrl }),
  ].filter(Boolean).join("\n\n");
  const requestIds = new Set(inputRequests.map((request) => request.id));
  const discussionEntries = mappedEntries.filter((entry) => !entry.adviceRequestId || !requestIds.has(entry.adviceRequestId));
  const inputRequestCards = inputRequests.map((request) => {
    const linkedReplies = mappedEntries.filter((entry) => entry.adviceRequestId === request.id);
    return {
      id: request.id,
      audienceLabel: requestAudienceLabel(request),
      channelLabel: channelLabel(request.preferredChannel),
      statusLabel: requestStatusLabel(request.status),
      statusClass: requestStatusClass(request.status),
      deadlineLabel: request.deadlineAt ? t("inputDeadlineTag", { date: dateTimeLabel(request.deadlineAt) ?? "" }) : null,
      reminderLabel: request.reminderAt ? t("inputReminderMeta", { date: dateTimeLabel(request.reminderAt) ?? "" }) : null,
      requestedByLabel: t("inputRequestedByMeta", { name: request.requestedBy.displayName || request.requestedBy.email }),
      messageMd: request.messageMd,
      copyableMessage: copyableRequestMessage(request),
      linkedRepliesCount: linkedReplies.length,
      replyThread: linkedReplies.length > 0 ? (
        <DeliberationThread
          entries={linkedReplies.map((entry) => ({
            ...entry,
            canEdit: canManageEntry(entry),
            canResolve: canManageEntry(entry),
          }))}
          canResolve={false}
          resolveAction={resolveActionDeliberationAction}
          updateAction={updateActionDeliberationAction}
          hiddenFields={{ workspaceId, parentId: actionId }}
        />
      ) : null,
      replyForm: !isArchived && (action.status === "OPEN" || action.status === "IN_PROGRESS") && request.status === "ACTIVE" ? (
        <DeliberationComposer
          postAction={postActionDeliberationAction}
          hiddenFields={{ workspaceId, parentId: actionId, adviceRequestId: request.id }}
          targetOptions={targetOptions}
          entryTypes={[
            { value: "REACTION", label: t("entryReaction"), variant: "secondary" },
            { value: "OBJECTION", label: t("entryObjection"), variant: "danger" },
          ]}
        />
      ) : null,
    };
  });

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
          <span>{priorityText}</span>
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
            {canEditContent && (
              <Link href={`/workspaces/${workspaceId}/actions/${action.id}/edit`} className="secondary small">
                {t("btnEdit")}
              </Link>
            )}
            <form action={deleteActionAction}>
              <input type="hidden" name="workspaceId" value={workspaceId} />
              <input type="hidden" name="actionId" value={action.id} />
              <ConfirmSubmitButton className="secondary small danger" confirmMessage={t("confirmArchive")}>
                {t("btnDelete")}
              </ConfirmSubmitButton>
            </form>
          </div>
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

      {(checklistItems.length > 0 || canEditContent) && (
        <section className="ws-section" id="checklist" style={{ marginBottom: 48 }}>
          <h2 className="nr-section-header">{t("sectionChecklist")}</h2>
          <div className="nr-item nr-action-checklist">
            {checklistItems.length > 0 ? (
              <div className="nr-action-checklist-list">
                {checklistItems.map((item) => (
                  <div className="nr-action-checklist-row" key={item.id}>
                    {canEditContent ? (
                      <form action={updateActionChecklistItemAction}>
                        <input type="hidden" name="workspaceId" value={workspaceId} />
                        <input type="hidden" name="checklistItemId" value={item.id} />
                        <input type="hidden" name="completed" value={item.completedAt ? "false" : "true"} />
                        <button
                          type="submit"
                          className={`nr-action-checklist-toggle ${item.completedAt ? "nr-action-checklist-toggle-done" : ""}`}
                          aria-label={item.completedAt ? t("checklistMarkOpen") : t("checklistMarkDone")}
                        >
                          {item.completedAt ? "✓" : ""}
                        </button>
                      </form>
                    ) : (
                      <span
                        className={`nr-action-checklist-toggle ${item.completedAt ? "nr-action-checklist-toggle-done" : ""}`}
                        aria-hidden="true"
                      >
                        {item.completedAt ? "✓" : ""}
                      </span>
                    )}
                    {canEditContent ? (
                      <details className="nr-action-checklist-title-editor">
                        <summary className={`nr-hide-marker nr-action-checklist-title ${item.completedAt ? "nr-action-checklist-title-done" : ""}`}>
                          {item.title}
                        </summary>
                        <div className="nr-action-checklist-edit-panel">
                          <form action={updateActionChecklistItemAction} className="nr-action-checklist-title-form">
                            <input type="hidden" name="workspaceId" value={workspaceId} />
                            <input type="hidden" name="checklistItemId" value={item.id} />
                            <input name="title" defaultValue={item.title} aria-label={t("checklistItemTitle")} />
                            <button type="submit" className="secondary small">{tCommon("save")}</button>
                          </form>
                          <form action={deleteActionChecklistItemAction}>
                            <input type="hidden" name="workspaceId" value={workspaceId} />
                            <input type="hidden" name="checklistItemId" value={item.id} />
                            <button type="submit" className="secondary small danger">{t("checklistDelete")}</button>
                          </form>
                        </div>
                      </details>
                    ) : (
                      <span className={`nr-action-checklist-title ${item.completedAt ? "nr-action-checklist-title-done" : ""}`}>{item.title}</span>
                    )}
                  </div>
                ))}
              </div>
            ) : (
              <p className="muted">{t("checklistEmpty")}</p>
            )}
            {canEditContent && (
              <form action={createActionChecklistItemAction} className="nr-action-checklist-add">
                <input type="hidden" name="workspaceId" value={workspaceId} />
                <input type="hidden" name="actionId" value={action.id} />
                <label>
                  {t("checklistAddItem")}
                  <input name="title" required />
                </label>
                <button type="submit" className="secondary small">{t("checklistAdd")}</button>
              </form>
            )}
          </div>
        </section>
      )}

      <section className="ws-section" style={{ marginBottom: 48 }}>
        <h2 className="nr-section-header">References</h2>
        <ExternalResourceCards attachments={externalResourceAttachments} />
        {!isArchived && (
          <ExternalResourceAttachForm
            action={attachActionExternalResourceAction}
            hiddenFields={{ workspaceId, actionId: action.id }}
          />
        )}
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

      {(canRequestInput || inputRequests.length > 0) && (
        <WorkItemConversationSurface title={t("sectionInputRequests")} className="work-request-surface">
          <WorkItemRequestList
            requests={inputRequestCards}
            labels={{
              copyableMessage: t("inputCopyableMessage"),
              linkedReplies: (count) => t("inputLinkedReplies", { count }),
              replyToRequest: t("btnReplyToInputRequest"),
            }}
          />
          {canRequestInput && (
            <details>
              <summary className="work-request-action nr-hide-marker">{t("btnRequestInput")}</summary>
              <AdviceRequestForm
                action={requestActionInputAction}
                hiddenFields={{ workspaceId, actionId: action.id }}
                memberOptions={memberRequestOptions}
                circleOptions={circleRequestOptions}
                defaultAudienceType={defaultCircleValue ? "CIRCLE" : "WORKSPACE"}
                defaultCircleId={defaultCircleValue}
                labels={{
                  audience: t("inputAudience"),
                  audienceMembers: t("inputAudienceMembers"),
                  audienceCircle: t("inputAudienceCircle"),
                  audienceWorkspace: t("inputAudienceWorkspace"),
                  people: t("inputPeople"),
                  choosePeople: t("inputChoosePeople"),
                  circle: t("inputCircle"),
                  membersAudienceNote: t("inputMembersAudienceNote"),
                  circleAudienceNote: t("inputCircleAudienceNote"),
                  workspaceAudienceNote: t("inputWorkspaceAudienceNote"),
                  message: t("inputMessage"),
                  deadline: t("inputDeadline"),
                  reminder: t("inputReminder"),
                  preferredChannel: t("inputPreferredChannel"),
                  channelInApp: t("inputChannelInApp"),
                  channelSlack: t("inputChannelSlack"),
                  channelEmail: t("inputChannelEmail"),
                  channelCopy: t("inputChannelCopy"),
                  selectAll: tWork("selectAll"),
                  unselectAll: tWork("unselectAll"),
                  selectedCount: tWork("selectedCount", { count: "{count}" }),
                  submit: t("btnSendInputRequest"),
                  sending: t("btnSendingInputRequest"),
                  sent: t("inputRequestSent"),
                  submitError: t("inputRequestSubmitError"),
                  choosePeopleError: t("inputChoosePeopleError"),
                  messageRequiredError: t("inputMessageRequiredError"),
                  deadlineInvalidError: t("inputDeadlineInvalidError"),
                  deadlineFutureError: t("inputDeadlineFutureError"),
                  reminderInvalidError: t("inputReminderInvalidError"),
                  reminderFutureError: t("inputReminderFutureError"),
                  reminderBeforeDeadlineError: t("inputReminderBeforeDeadlineError"),
                }}
              />
            </details>
          )}
        </WorkItemConversationSurface>
      )}

      <WorkItemConversationSurface title={t("sectionDiscussion")}>
        <DeliberationThread
          entries={discussionEntries.map((entry) => ({
            ...entry,
            canEdit: canManageEntry(entry),
            canResolve: canManageEntry(entry),
          }))}
          canResolve={false}
          resolveAction={resolveActionDeliberationAction}
          updateAction={updateActionDeliberationAction}
          hiddenFields={{ workspaceId, parentId: actionId }}
          emptyMessage={t("discussionEmpty")}
        />
        {!isArchived && (action.status === "OPEN" || action.status === "IN_PROGRESS") && (
          <DeliberationComposer
            postAction={postActionDeliberationAction}
            hiddenFields={{ workspaceId, parentId: actionId }}
            targetOptions={targetOptions}
            entryTypes={[
              { value: "REACTION", label: t("entryReaction"), variant: "secondary" },
              { value: "OBJECTION", label: t("entryObjection"), variant: "danger" },
            ]}
          />
        )}
      </WorkItemConversationSurface>

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
