import Link from "next/link";
import { AppError, getTension, getWorkspaceArchiveRecord, listAdviceRequests, listDeliberationEntries, listExternalResourceAttachments, listHumanMembers, listWorkItemEvidence, listWorkItemVersions, requireWorkspaceMembership } from "@corgtex/domain";
import { requirePageActor } from "@/lib/auth";
import { MarkdownEditor } from "@/lib/components/MarkdownEditor";
import { MarkdownRenderer } from "@/lib/components/MarkdownRenderer";
import { WorkItemMemberSelect, type WorkItemMemberOption } from "@/lib/components/WorkItemMemberSelect";
import { WorkItemPrioritySelect } from "@/lib/components/WorkItemPrioritySelect";
import { WorkItemResolutionDialog } from "@/lib/components/WorkItemResolutionDialog";
import { ArchivedItemBanner } from "@/lib/components/ArchivedItemBanner";
import { UnavailableItemStatus } from "@/lib/components/UnavailableItemStatus";
import { ExternalResourceAttachForm, ExternalResourceCards } from "@/lib/components/ExternalResourceCards";
import { DeliberationThread } from "@/lib/components/DeliberationThread";
import { DeliberationComposer } from "@/lib/components/DeliberationComposer";
import { AdviceRequestForm } from "@/lib/components/AdviceRequestForm";
import { WorkItemConversationSurface, WorkItemRequestList } from "@/lib/components/WorkItemConversation";
import { getDeliberationTargets } from "@/lib/deliberation-targets";
import { canOpenPrivateDraft } from "@/lib/governance-open-guards";
import { attachTensionExternalResourceAction, createProposalFromTensionAction, postTensionDeliberationAction, publishTensionAction, requestTensionInputAction, returnTensionToDraftAction, resolveTensionDeliberationAction, updateTensionAction, updateTensionDeliberationAction } from "../../actions";
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
  const format = await getFormatter();
  let tension: Awaited<ReturnType<typeof getTension>>;
  try {
    tension = await getTension(actor, { workspaceId, tensionId });
  } catch (error) {
    if (error instanceof AppError && error.code === "NOT_FOUND") {
      const membership = await requireWorkspaceMembership({ actor, workspaceId });
      const archiveRecord = await getWorkspaceArchiveRecord(actor, {
        workspaceId,
        entityType: "Tension",
        entityId: tensionId,
        includePurged: true,
      });
      const canShowArchiveRecord = actor.kind === "agent" || membership?.role === "ADMIN";
      return (
        <UnavailableItemStatus
          workspaceId={workspaceId}
          entityType="Tension"
          entityId={tensionId}
          archiveRecord={canShowArchiveRecord ? archiveRecord : null}
          backHref={`/workspaces/${workspaceId}/tensions`}
          backLabel={t("backToTensions")}
        />
      );
    }
    throw error;
  }
  const isArchived = Boolean(tension.archivedAt);
  const membership = await requireWorkspaceMembership({ actor, workspaceId });
  const [entries, versionHistory, evidence, externalResourceAttachments, inputRequests, archiveRecord, members] = await Promise.all([
    archivedSafeRead(isArchived, listDeliberationEntries(actor, { workspaceId, parentType: "TENSION", parentId: tensionId }), []),
    archivedSafeRead(isArchived, listWorkItemVersions(actor, { workspaceId, entityType: "TENSION", entityId: tensionId }), {
      entityType: "Tension" as const,
      entityId: tensionId,
      currentVersion: tension.version,
      versions: [],
    }),
    archivedSafeRead(isArchived, listWorkItemEvidence(actor, { workspaceId, entityType: "Tension", entityId: tensionId }), []),
    archivedSafeRead(isArchived, listExternalResourceAttachments(actor, { workspaceId, entityType: "Tension", entityId: tensionId }), []),
    isArchived ? Promise.resolve([]) : listAdviceRequests(actor, { workspaceId, subjectType: "TENSION", subjectId: tensionId, status: "ACTIVE" }),
    isArchived
      ? archivedSafeRead(true, getWorkspaceArchiveRecord(actor, { workspaceId, entityType: "Tension", entityId: tension.id }), null)
      : Promise.resolve(null),
    isArchived ? Promise.resolve([]) : listHumanMembers(workspaceId),
  ]);
  const deliberationTargets = isArchived
    ? { options: [], defaultValue: "", actorMemberId: null, actorCircleIds: [] }
    : await getDeliberationTargets({ actor, workspaceId, parentCircleId: tension.circleId });
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

  const priorityLabels = {
    3: tWork("priorityUrgent"),
    2: tWork("priorityImportant"),
    1: tWork("priorityMedium"),
    0: tWork("priorityLow"),
  } satisfies WorkItemPriorityLabels;
  const priorityText = formatWorkItemPriority(tension.priority, priorityLabels);
  const authorName = tension.author?.displayName || tension.author?.email || t("authorUnknown");
  const raisedByName = tension.raisedByMember?.user?.displayName || tension.raisedByMember?.user?.email || null;
  const responsibleName = tension.assigneeMember?.user?.displayName || tension.assigneeMember?.user?.email || null;
  const memberName = (member: { user: { displayName: string | null; email: string } }) => member.user.displayName || member.user.email;
  const memberOptions: WorkItemMemberOption[] = members.map((member) => ({ id: member.id, label: memberName(member) }));
  const canManage = !isArchived && (actor.kind === "agent" || membership?.role === "ADMIN" || (actor.kind === "user" && tension.authorUserId === actor.user.id));
  const isAdmin = actor.kind === "agent" || membership?.role === "ADMIN";
  const actorUserId = actor.kind === "user" ? actor.user.id : null;
  const actorMemberId = deliberationTargets.actorMemberId;
  const actorCircleIds = new Set(deliberationTargets.actorCircleIds);
  const isParentResponsible = Boolean(
    actorUserId && tension.authorUserId === actorUserId
      || actorMemberId && tension.assigneeMemberId === actorMemberId,
  );
  const canManageEntry = (entry: (typeof entries)[number]) => !isArchived && Boolean(
    isAdmin
      || (actorUserId && entry.authorUserId === actorUserId)
      || isParentResponsible
      || (actorMemberId && entry.targetMemberId === actorMemberId)
      || (entry.targetCircleId && actorCircleIds.has(entry.targetCircleId)),
  );
  const canSubmittedEditorEdit = actor.kind === "user"
    && (tension.authorUserId === actor.user.id || tension.assigneeMemberId === membership?.id);
  const canEditContent = !isArchived && tension.status === "DRAFT" ? canManage : !isArchived && tension.status === "OPEN" && canSubmittedEditorEdit;
  const canDraftProposal = !isArchived && !tension.proposal && (canManage || !tension.isPrivate);
  const canResolve = !isArchived && !tension.isPrivate && tension.status === "OPEN";
  const canRequestInput = !isArchived && tension.status === "OPEN" && !tension.isPrivate && (canManage || isParentResponsible);
  const memberRequestOptions = targetOptions
    .filter((option) => option.kind === "member")
    .map((option) => ({ value: option.value.slice("member:".length), label: option.name }));
  const circleRequestOptions = targetOptions
    .filter((option) => option.kind === "circle")
    .map((option) => ({ value: option.value.slice("circle:".length), label: option.name }));
  const defaultCircleValue = tension.circleId && circleRequestOptions.some((option) => option.value === tension.circleId)
    ? tension.circleId
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
  const tensionPath = `/workspaces/${workspaceId}/tensions/${tension.id}`;
  const appBaseUrl = process.env.NEXT_PUBLIC_APP_URL?.replace(/\/$/, "") ?? "";
  const tensionUrl = `${appBaseUrl}${tensionPath}`;
  const requestAudienceLabel = (request: (typeof inputRequests)[number]) => {
    if (request.audienceType === "WORKSPACE") return t("inputAudienceWorkspace");
    if (request.audienceType === "CIRCLE") return request.targetCircle ? t("targetCircle", { name: request.targetCircle.name }) : t("inputAudienceCircle");
    const names = request.recipients.map((recipient) => recipient.member.user.displayName || recipient.member.user.email);
    return names.length > 0 ? names.join(", ") : t("inputAudienceMembers");
  };
  const copyableRequestMessage = (request: (typeof inputRequests)[number]) => [
    t("inputCopyableSubject", { title: tension.title }),
    request.messageMd,
    request.deadlineAt ? t("inputCopyableDeadline", { date: dateTimeLabel(request.deadlineAt) ?? "" }) : null,
    t("inputCopyableLink", { url: tensionUrl }),
  ].filter(Boolean).join("\n\n");
  const discussionEntries = mappedEntries.filter((entry) => !entry.adviceRequestId);
  const inputRequestCards = inputRequests.map((request) => {
    const linkedReplies = mappedEntries.filter((entry) => entry.adviceRequestId === request.id);
    return {
      id: request.id,
      audienceLabel: requestAudienceLabel(request),
      channelLabel: channelLabel(request.preferredChannel),
      deadlineLabel: request.deadlineAt ? t("inputDeadlineTag", { date: dateTimeLabel(request.deadlineAt) ?? "" }) : null,
      reminderLabel: request.reminderAt ? t("inputReminderMeta", { date: dateTimeLabel(request.reminderAt) ?? "" }) : null,
      requestedByLabel: t("inputRequestedByMeta", { name: request.requestedBy.displayName || request.requestedBy.email }),
      messageMd: request.messageMd,
      copyableMessage: copyableRequestMessage(request),
      linkedReplies: linkedReplies.map((reply) => ({
        id: reply.id,
        authorName: reply.authorName,
        createdAtLabel: dateTimeLabel(reply.createdAt),
        bodyMd: reply.bodyMd,
      })),
      replyForm: !isArchived && tension.status === "OPEN" ? (
        <DeliberationComposer
          postAction={postTensionDeliberationAction}
          hiddenFields={{ workspaceId, parentId: tensionId, adviceRequestId: request.id }}
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
          <span>{t("detailAuthorMeta", { author: authorName })}</span>
          {raisedByName && <span>{t("detailRaisedByMeta", { name: raisedByName })}</span>}
          {responsibleName && <span>{t("detailResponsiblePersonMeta", { name: responsibleName })}</span>}
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

      {isArchived && (
        <ArchivedItemBanner
          archivedAt={tension.archivedAt}
          archivedBy={archiveRecord?.archivedByLabel ?? archiveRecord?.archivedByUserId}
          archiveReason={tension.archiveReason}
          restoreHref={isAdmin ? `/workspaces/${workspaceId}/audit?tab=archive&archiveEntityType=Tension` : null}
        />
      )}

      {!isArchived && (canManage || canDraftProposal || canResolve) && (
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
                <WorkItemMemberSelect
                  name="assigneeMemberId"
                  label={t("formResponsiblePerson")}
                  noneLabel={t("formResponsiblePersonNone")}
                  members={memberOptions}
                  defaultValue={tension.assigneeMemberId}
                />
                <WorkItemMemberSelect
                  name="raisedByMemberId"
                  label={t("formRaisedBy")}
                  noneLabel={t("formRaisedByNone")}
                  members={memberOptions}
                  defaultValue={tension.raisedByMemberId}
                />
                <WorkItemPrioritySelect label={t("formPriority")} labels={priorityLabels} defaultValue={tension.priority} />
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

      <section className="ws-section" style={{ marginBottom: 48 }}>
        <h2 className="nr-section-header">Box files</h2>
        <ExternalResourceCards attachments={externalResourceAttachments} />
        {!isArchived && (
          <ExternalResourceAttachForm
            action={attachTensionExternalResourceAction}
            hiddenFields={{ workspaceId, tensionId: tension.id }}
          />
        )}
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
            <details open={inputRequests.length === 0}>
              <summary className="work-request-action nr-hide-marker">{t("btnRequestInput")}</summary>
              <AdviceRequestForm
                action={requestTensionInputAction}
                hiddenFields={{ workspaceId, tensionId: tension.id }}
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
          canResolve={!isArchived}
          resolveAction={resolveTensionDeliberationAction}
          updateAction={updateTensionDeliberationAction}
          hiddenFields={{ workspaceId, parentId: tensionId }}
          emptyMessage={t("discussionEmpty")}
        />
        {!isArchived && tension.status === "OPEN" && (
          <DeliberationComposer
            postAction={postTensionDeliberationAction}
            hiddenFields={{ workspaceId, parentId: tensionId }}
            targetOptions={targetOptions}
            entryTypes={[
              { value: "REACTION", label: t("entryReaction"), variant: "secondary" },
              { value: "OBJECTION", label: t("entryObjection"), variant: "danger" },
            ]}
          />
        )}
      </WorkItemConversationSurface>
    </>
  );
}
