import { notFound } from "next/navigation";
import Link from "next/link";
import { AppError, getProposal, getWorkspaceArchiveRecord, listAdviceRequests, listDeliberationEntries, listExternalResourceAttachments, listHumanMembers, listWorkItemEvidence, listWorkItemVersions, requireWorkspaceMembership } from "@corgtex/domain";
import { requirePageActor } from "@/lib/auth";
import { MarkdownRenderer } from "@/lib/components/MarkdownRenderer";
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
import { attachProposalExternalResourceAction, postDeliberationEntryAction, requestProposalAdviceAction, resolveDeliberationEntryAction, resolveProposalAction, returnProposalToDraftAction, submitProposalAction, updateDeliberationEntryAction, updateProposalAction } from "../actions";
import { ProposalDraftFields } from "../ProposalDraftFields";
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

export default async function ProposalDetailPage({
  params,
}: {
  params: Promise<{ workspaceId: string; proposalId: string }>;
}) {
  const { workspaceId, proposalId } = await params;
  const actor = await requirePageActor();
  const t = await getTranslations("proposals");
  const tCommon = await getTranslations("common");
  const tWork = await getTranslations("workItems");
  const format = await getFormatter();

  const membership = await requireWorkspaceMembership({ actor, workspaceId });
  let proposal: Awaited<ReturnType<typeof getProposal>>;
  try {
    proposal = await getProposal(actor, { workspaceId, proposalId, includeArchived: true });
  } catch (error) {
    if (error instanceof AppError && error.code === "NOT_FOUND") {
      const archiveRecord = await getWorkspaceArchiveRecord(actor, {
        workspaceId,
        entityType: "Proposal",
        entityId: proposalId,
        includePurged: true,
      });
      const canShowArchiveRecord = actor.kind === "agent" || membership?.role === "ADMIN";
      return (
        <UnavailableItemStatus
          workspaceId={workspaceId}
          entityType="Proposal"
          entityId={proposalId}
          archiveRecord={canShowArchiveRecord ? archiveRecord : null}
          backHref={`/workspaces/${workspaceId}/proposals`}
          backLabel={t("backToProposals")}
        />
      );
    }
    throw error;
  }
  if (!proposal) notFound();
  const isArchived = Boolean(proposal.archivedAt);

  const [deliberationEntries, versionHistory, evidence, externalResourceAttachments, adviceRequests, archiveRecord, members] = await Promise.all([
    archivedSafeRead(isArchived, listDeliberationEntries(actor, {
      workspaceId,
      parentType: "PROPOSAL",
      parentId: proposalId,
    }), []),
    archivedSafeRead(isArchived, listWorkItemVersions(actor, { workspaceId, entityType: "PROPOSAL", entityId: proposalId }), {
      entityType: "Proposal" as const,
      entityId: proposalId,
      currentVersion: proposal.version,
      versions: [],
    }),
    archivedSafeRead(isArchived, listWorkItemEvidence(actor, { workspaceId, entityType: "Proposal", entityId: proposalId }), []),
    archivedSafeRead(isArchived, listExternalResourceAttachments(actor, { workspaceId, entityType: "Proposal", entityId: proposalId }), []),
    isArchived ? Promise.resolve([]) : listAdviceRequests(actor, { workspaceId, subjectType: "PROPOSAL", subjectId: proposalId }),
    isArchived
      ? archivedSafeRead(true, getWorkspaceArchiveRecord(actor, { workspaceId, entityType: "Proposal", entityId: proposal.id }), null)
      : Promise.resolve(null),
    isArchived ? Promise.resolve([]) : listHumanMembers(workspaceId),
  ]);
  const deliberationTargets = isArchived
    ? { options: [], defaultValue: "", actorMemberId: null, actorCircleIds: [] }
    : await getDeliberationTargets({ actor, workspaceId, parentCircleId: proposal.circleId });
  const targetOptions = deliberationTargets.options.map((option) => ({
    ...option,
    label: option.kind === "circle"
      ? t("targetCircle", { name: option.name })
      : t("targetPerson", { name: option.name }),
  }));
  const mappedEntries = deliberationEntries.map((e) => ({
    ...e,
    authorName: e.author?.displayName || e.author?.email || t("authorUnknown"),
    authorInitials: (e.author?.displayName || e.author?.email || "U").substring(0, 2).toUpperCase(),
    targetLabel: e.targetCircle
      ? t("targetCircle", { name: e.targetCircle.name })
      : e.targetMember
        ? t("targetPerson", { name: e.targetMember.user.displayName || e.targetMember.user.email })
        : null,
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

  const authorName = proposal.author?.displayName || proposal.author?.email || t("authorUnknown");
  const memberName = (member: { user: { displayName: string | null; email: string } }) => member.user.displayName || member.user.email;
  const memberOptions = members.map((member) => ({ id: member.id, label: memberName(member) }));
  const ownerName = proposal.ownerMember ? memberName(proposal.ownerMember) : null;
  const ownerText = ownerName ? t("ownerMeta", { name: ownerName }) : t("formOwnerNone");
  const priorityLabels = {
    3: tWork("priorityUrgent"),
    2: tWork("priorityImportant"),
    1: tWork("priorityMedium"),
    0: tWork("priorityLow"),
  } satisfies WorkItemPriorityLabels;
  const priorityText = formatWorkItemPriority(proposal.priority, priorityLabels);
  const isAuthor = proposal.authorUserId === (actor.kind === "user" ? actor.user.id : "");
  const isOwner = Boolean(membership?.id) && proposal.ownerMemberId === membership?.id;
  const isAdmin = actor.kind === "agent" || membership?.role === "ADMIN";
  const actorUserId = actor.kind === "user" ? actor.user.id : null;
  const actorMemberId = deliberationTargets.actorMemberId;
  const actorCircleIds = new Set(deliberationTargets.actorCircleIds);
  const canManage = !isArchived && (actor.kind === "agent" || membership?.role === "ADMIN" || isAuthor || isOwner);
  const canEditContent = !isArchived && proposal.status === "DRAFT" ? canManage : !isArchived && proposal.status === "OPEN" && (isAuthor || isOwner);
  const canResolve = !isArchived && (actor.kind === "agent" || Boolean(membership));
  const canRequestAdvice = !isArchived && actor.kind === "user" && proposal.status === "OPEN" && !proposal.isPrivate && (isAuthor || membership?.role === "ADMIN");
  const canManageEntry = (entry: (typeof deliberationEntries)[number]) => !isArchived && Boolean(
    isAdmin
      || (actorUserId && entry.authorUserId === actorUserId)
      || isAuthor
      || (actorMemberId && entry.targetMemberId === actorMemberId)
      || (entry.targetCircleId && actorCircleIds.has(entry.targetCircleId)),
  );
  const memberRequestOptions = targetOptions
    .filter((option) => option.kind === "member")
    .map((option) => ({ value: option.value.slice("member:".length), label: option.name }));
  const circleRequestOptions = targetOptions
    .filter((option) => option.kind === "circle")
    .map((option) => ({ value: option.value.slice("circle:".length), label: option.name }));
  const defaultCircleValue = proposal.circleId && circleRequestOptions.some((option) => option.value === proposal.circleId)
    ? proposal.circleId
    : circleRequestOptions[0]?.value ?? "";
  const dateTimeLabel = (value: Date | string | null | undefined) => value
    ? format.dateTime(new Date(value), { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" })
    : null;
  const channelLabel = (channel: string) => {
    const labels: Record<string, string> = {
      IN_APP: t("adviceChannelInApp"),
      SLACK: t("adviceChannelSlack"),
      EMAIL: t("adviceChannelEmail"),
      COPY: t("adviceChannelCopy"),
    };
    return labels[channel] ?? channel;
  };
  const requestStatusLabel = (status: string) => {
    const labels: Record<string, string> = {
      ACTIVE: t("adviceStatusActive"),
      COMPLETED: t("adviceStatusCompleted"),
      CANCELED: t("adviceStatusCanceled"),
    };
    return labels[status] ?? status;
  };
  const requestStatusClass = (status: string) => {
    if (status === "ACTIVE") return "warning";
    if (status === "COMPLETED") return "success";
    return "";
  };
  const requestAudienceLabel = (request: (typeof adviceRequests)[number]) => {
    if (request.audienceType === "WORKSPACE") return t("adviceAudienceWorkspace");
    if (request.audienceType === "CIRCLE") return request.targetCircle ? t("targetCircle", { name: request.targetCircle.name }) : t("adviceAudienceCircle");
    const names = request.recipients.map((recipient) => recipient.member.user.displayName || recipient.member.user.email);
    return names.length > 0 ? names.join(", ") : t("adviceAudienceMembers");
  };
  const proposalPath = `/workspaces/${workspaceId}/proposals/${proposal.id}`;
  const appBaseUrl = process.env.NEXT_PUBLIC_APP_URL?.replace(/\/$/, "") ?? "";
  const proposalUrl = `${appBaseUrl}${proposalPath}`;
  const copyableRequestMessage = (request: (typeof adviceRequests)[number]) => [
    t("adviceCopyableSubject", { title: proposal.title }),
    request.messageMd,
    request.deadlineAt ? t("adviceCopyableDeadline", { date: dateTimeLabel(request.deadlineAt) ?? "" }) : null,
    t("adviceCopyableLink", { url: proposalUrl }),
  ].filter(Boolean).join("\n\n");
  const requestIds = new Set(adviceRequests.map((request) => request.id));
  const discussionEntries = mappedEntries.filter((entry) => !entry.adviceRequestId || !requestIds.has(entry.adviceRequestId));
  const adviceRequestCards = adviceRequests.map((request) => {
    const linkedReplies = mappedEntries.filter((entry) => entry.adviceRequestId === request.id);
    return {
      id: request.id,
      audienceLabel: requestAudienceLabel(request),
      channelLabel: channelLabel(request.preferredChannel),
      statusLabel: requestStatusLabel(request.status),
      statusClass: requestStatusClass(request.status),
      deadlineLabel: request.deadlineAt ? t("adviceDeadlineTag", { date: dateTimeLabel(request.deadlineAt) ?? "" }) : null,
      reminderLabel: request.reminderAt ? t("adviceReminderMeta", { date: dateTimeLabel(request.reminderAt) ?? "" }) : null,
      requestedByLabel: t("adviceRequestedByMeta", { name: request.requestedBy.displayName || request.requestedBy.email }),
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
          canResolve={!isArchived && (isAuthor || actor.kind === "agent")}
          resolveAction={resolveDeliberationEntryAction}
          updateAction={updateDeliberationEntryAction}
          hiddenFields={{ workspaceId, proposalId }}
        />
      ) : null,
      replyForm: !isArchived && proposal.status === "OPEN" && request.status === "ACTIVE" ? (
        <DeliberationComposer
          postAction={postDeliberationEntryAction}
          hiddenFields={{ workspaceId, proposalId, adviceRequestId: request.id }}
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
      <div className="nr-masthead nr-masthead-left mb-8">
        <p className="nr-meta nr-meta-flex mb-3">
          <span><Link href={`/workspaces/${workspaceId}/proposals`} className="nr-link-inherit">{t("backToProposals")}</Link></span>
          <span>·</span>
          <span>{authorName}</span>
          <span>·</span>
          <span>{ownerText}</span>
          <span>·</span>
          <span className={`tag ${statusClass}`}>
            {proposal.status === "RESOLVED" && proposal.resolutionOutcome ? `${proposal.status} · ${proposal.resolutionOutcome.replace("_", " ")}` : proposal.status}
          </span>
          <span>·</span>
          <span>{priorityText}</span>
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

      {isArchived && (
        <ArchivedItemBanner
          archivedAt={proposal.archivedAt}
          archivedBy={archiveRecord?.archivedByLabel ?? archiveRecord?.archivedByUserId}
          archiveReason={proposal.archiveReason}
          restoreHref={isAdmin ? `/workspaces/${workspaceId}/audit?tab=archive&archiveEntityType=Proposal` : null}
        />
      )}

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

          <section className="nr-summary-section" style={{ marginTop: 24 }}>
            <h2 className="nr-summary-title">Box files</h2>
            <ExternalResourceCards attachments={externalResourceAttachments} />
            {!isArchived && (
              <ExternalResourceAttachForm
                action={attachProposalExternalResourceAction}
                hiddenFields={{ workspaceId, proposalId: proposal.id }}
              />
            )}
          </section>

          {proposal.status === "RESOLVED" && proposal.decisionMd && (
            <section className="nr-summary-section" style={{ marginTop: 24 }}>
              <h2 className="nr-summary-title">
                {t("formDecisionNote")}
              </h2>
              <MarkdownRenderer markdown={proposal.decisionMd} variant="document" className="nr-markdown" />
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
            </section>
          )}

          <hr className="nr-divider nr-divider-lg" />

          {(canRequestAdvice || adviceRequests.length > 0) && (
            <WorkItemConversationSurface title={t("sectionAdviceRequests")} className="work-request-surface">
              <WorkItemRequestList
                requests={adviceRequestCards}
                labels={{
                  copyableMessage: t("adviceCopyableMessage"),
                  linkedReplies: (count) => t("adviceLinkedReplies", { count }),
                  replyToRequest: t("btnReplyToAdviceRequest"),
                }}
              />
              {canRequestAdvice && (
                <details open={!adviceRequests.some((request) => request.status === "ACTIVE")}>
                  <summary className="work-request-action nr-hide-marker">{t("btnRequestAdvice")}</summary>
                  <AdviceRequestForm
                    action={requestProposalAdviceAction}
                    hiddenFields={{ workspaceId, proposalId: proposal.id }}
                    memberOptions={memberRequestOptions}
                    circleOptions={circleRequestOptions}
                    defaultAudienceType={defaultCircleValue ? "CIRCLE" : "WORKSPACE"}
                    defaultCircleId={defaultCircleValue}
                    labels={{
                      audience: t("adviceAudience"),
                      audienceMembers: t("adviceAudienceMembers"),
                      audienceCircle: t("adviceAudienceCircle"),
                      audienceWorkspace: t("adviceAudienceWorkspace"),
                      people: t("advicePeople"),
                      choosePeople: t("adviceChoosePeople"),
                      circle: t("adviceCircle"),
                      membersAudienceNote: t("adviceMembersAudienceNote"),
                      circleAudienceNote: t("adviceCircleAudienceNote"),
                      workspaceAudienceNote: t("adviceWorkspaceAudienceNote"),
                      message: t("adviceMessage"),
                      deadline: t("adviceDeadline"),
                      reminder: t("adviceReminder"),
                      preferredChannel: t("advicePreferredChannel"),
                      channelInApp: t("adviceChannelInApp"),
                      channelSlack: t("adviceChannelSlack"),
                      channelEmail: t("adviceChannelEmail"),
                      channelCopy: t("adviceChannelCopy"),
                      selectAll: tWork("selectAll"),
                      unselectAll: tWork("unselectAll"),
                      selectedCount: tWork("selectedCount", { count: "{count}" }),
                      submit: t("btnSendAdviceRequest"),
                      sending: t("btnSendingAdviceRequest"),
                      sent: t("adviceRequestSent"),
                      submitError: t("adviceRequestSubmitError"),
                      choosePeopleError: t("adviceChoosePeopleError"),
                      messageRequiredError: t("adviceMessageRequiredError"),
                      deadlineInvalidError: t("adviceDeadlineInvalidError"),
                      deadlineFutureError: t("adviceDeadlineFutureError"),
                      reminderInvalidError: t("adviceReminderInvalidError"),
                      reminderFutureError: t("adviceReminderFutureError"),
                      reminderBeforeDeadlineError: t("adviceReminderBeforeDeadlineError"),
                    }}
                  />
                </details>
              )}
            </WorkItemConversationSurface>
          )}

          <WorkItemConversationSurface title={t("sectionDeliberation")}>
            <DeliberationThread
              entries={discussionEntries.map((entry) => ({
                ...entry,
                canEdit: canManageEntry(entry),
                canResolve: canManageEntry(entry),
              }))}
              canResolve={!isArchived && (isAuthor || actor.kind === "agent")}
              resolveAction={resolveDeliberationEntryAction}
              updateAction={updateDeliberationEntryAction}
              hiddenFields={{ workspaceId, proposalId }}
              emptyMessage={t("discussionEmpty")}
            />

            {!isArchived && proposal.status === "OPEN" && (
              <DeliberationComposer
                postAction={postDeliberationEntryAction}
                hiddenFields={{ workspaceId, proposalId }}
                targetOptions={targetOptions}
                entryTypes={[
                  { value: "REACTION", label: t("entryReaction"), variant: "secondary" },
                  { value: "OBJECTION", label: t("entryObjection"), variant: "danger" },
                ]}
              />
            )}
          </WorkItemConversationSurface>
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
                <ProposalDraftFields
                  defaultTitle={proposal.title}
                  defaultBodyMd={proposal.bodyMd}
                  defaultPriority={proposal.priority}
                  defaultOwnerMemberId={proposal.ownerMemberId}
                  members={memberOptions}
                />
                <button type="submit" className="secondary small">{proposal.status === "DRAFT" ? t("btnSaveDraft") : tCommon("save")}</button>
              </form>
            </details>
          )}

          {canResolve && proposal.status === "OPEN" && (
            <div className="stack mb-8">
              <h3 className="nr-sidebar-title">{t("resolveProposalTitle")}</h3>
              <WorkItemResolutionDialog
                action={resolveProposalAction}
                buttonLabel={t("btnResolve")}
                title={tWork("resolveProposalTitle")}
                noteName="decisionMd"
                noteLabel={tWork("resolutionNote")}
                notePlaceholder={t("placeholderDecisionMd")}
                hiddenFields={{ workspaceId, proposalId: proposal.id }}
                outcomeName="outcome"
                outcomeLabel={t("formResolutionOutcome")}
                outcomeOptions={[
                  { value: "ADOPTED", label: t("outcomeAdopted") },
                  { value: "NOT_ADOPTED", label: t("outcomeNotAdopted") },
                  { value: "WITHDRAWN", label: t("outcomeWithdrawn") },
                ]}
                submitLabel={t("btnResolve")}
                cancelLabel={tCommon("cancel")}
                fileLabel={tWork("evidence")}
                className="secondary small"
              />
            </div>
          )}
          
          <h3 className="nr-sidebar-title">{t("aboutTitle")}</h3>
          <div className="nr-meta mb-4">
            <strong>{t("aboutCreated")}</strong> {new Date(proposal.createdAt).toLocaleDateString()}
          </div>
          <div className="nr-meta mb-4">
            <strong>{t("formOwner")}</strong> {ownerName ?? t("formOwnerNone")}
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
                  <Link key={action.id} href={`/workspaces/${workspaceId}/actions/${action.id}`} className="tag info no-underline">
                    {t("actionTag", { title: action.title })}
                  </Link>
                ))}
              </div>
            </div>
          )}
        </aside>
      </div>
    </>
  );
}
