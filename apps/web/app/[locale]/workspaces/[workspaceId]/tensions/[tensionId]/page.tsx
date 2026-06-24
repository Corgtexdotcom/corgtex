import Link from "next/link";
import { AppError, getTension, getWorkspaceArchiveRecord, listAdviceRequests, listDeliberationEntries, listWorkItemEvidence, listWorkItemVersions, requireWorkspaceMembership } from "@corgtex/domain";
import { requirePageActor } from "@/lib/auth";
import { MarkdownEditor } from "@/lib/components/MarkdownEditor";
import { MarkdownRenderer } from "@/lib/components/MarkdownRenderer";
import { WorkItemResolutionDialog } from "@/lib/components/WorkItemResolutionDialog";
import { ArchivedItemBanner } from "@/lib/components/ArchivedItemBanner";
import { UnavailableItemStatus } from "@/lib/components/UnavailableItemStatus";
import { DeliberationThread } from "@/lib/components/DeliberationThread";
import { DeliberationComposer } from "@/lib/components/DeliberationComposer";
import { getDeliberationTargets } from "@/lib/deliberation-targets";
import { canOpenPrivateDraft } from "@/lib/governance-open-guards";
import { createProposalFromTensionAction, postTensionDeliberationAction, publishTensionAction, requestTensionInputAction, returnTensionToDraftAction, resolveTensionDeliberationAction, updateTensionAction, updateTensionDeliberationAction } from "../../actions";
import { getFormatter, getTranslations } from "next-intl/server";

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
  const [entries, versionHistory, evidence, inputRequests, archiveRecord] = await Promise.all([
    listDeliberationEntries(actor, { workspaceId, parentType: "TENSION", parentId: tensionId }),
    listWorkItemVersions(actor, { workspaceId, entityType: "TENSION", entityId: tensionId }),
    listWorkItemEvidence(actor, { workspaceId, entityType: "Tension", entityId: tensionId }),
    isArchived ? Promise.resolve([]) : listAdviceRequests(actor, { workspaceId, subjectType: "TENSION", subjectId: tensionId, status: "ACTIVE" }),
    isArchived
      ? getWorkspaceArchiveRecord(actor, { workspaceId, entityType: "Tension", entityId: tension.id })
      : Promise.resolve(null),
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
  const memberRequestOptions = targetOptions.filter((option) => option.kind === "member");
  const circleRequestOptions = targetOptions.filter((option) => option.kind === "circle");
  const defaultCircleValue = tension.circleId && circleRequestOptions.some((option) => option.value === `circle:${tension.circleId}`)
    ? tension.circleId
    : circleRequestOptions[0]?.value.slice("circle:".length) ?? "";
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

      {(canRequestInput || inputRequests.length > 0) && (
        <section className="ws-section" style={{ marginBottom: 48 }}>
          <h2 className="nr-section-header">{t("sectionInputRequests")}</h2>
          {inputRequests.length > 0 && (
            <div className="stack" style={{ marginBottom: canRequestInput ? 24 : 0 }}>
              {inputRequests.map((request) => {
                const linkedReplies = mappedEntries.filter((entry) => entry.adviceRequestId === request.id);
                return (
                  <div key={request.id} className="nr-item">
                    <div className="row" style={{ alignItems: "center", gap: 8, marginBottom: 8 }}>
                      <strong>{requestAudienceLabel(request)}</strong>
                      <span className="tag info">{channelLabel(request.preferredChannel)}</span>
                      {request.deadlineAt && <span className="tag warning">{t("inputDeadlineTag", { date: dateTimeLabel(request.deadlineAt) ?? "" })}</span>}
                    </div>
                    <div className="nr-item-meta" style={{ marginBottom: 12 }}>
                      {t("inputRequestedByMeta", { name: request.requestedBy.displayName || request.requestedBy.email })}
                      {request.reminderAt ? ` · ${t("inputReminderMeta", { date: dateTimeLabel(request.reminderAt) ?? "" })}` : ""}
                    </div>
                    <MarkdownRenderer markdown={request.messageMd} variant="document" />
                    <details style={{ marginTop: 16 }}>
                      <summary className="secondary small nr-hide-marker" style={{ cursor: "pointer", display: "inline-block" }}>{t("inputCopyableMessage")}</summary>
                      <textarea
                        readOnly
                        rows={6}
                        value={copyableRequestMessage(request)}
                        style={{ marginTop: 8, width: "100%" }}
                      />
                    </details>
                    {linkedReplies.length > 0 && (
                      <div style={{ marginTop: 16 }}>
                        <strong>{t("inputLinkedReplies", { count: linkedReplies.length })}</strong>
                        <div className="stack" style={{ marginTop: 8, gap: 0 }}>
                          {linkedReplies.map((reply) => (
                            <div key={reply.id} style={{ borderTop: "1px solid var(--line)", padding: "10px 0" }}>
                              <div className="nr-item-meta" style={{ marginBottom: 6 }}>
                                {reply.authorName} · {dateTimeLabel(reply.createdAt)}
                              </div>
                              {reply.bodyMd && <MarkdownRenderer markdown={reply.bodyMd} variant="document" />}
                            </div>
                          ))}
                        </div>
                      </div>
                    )}
                    {!isArchived && tension.status === "OPEN" && (
                      <details style={{ marginTop: 16 }}>
                        <summary className="secondary small nr-hide-marker" style={{ cursor: "pointer", display: "inline-block" }}>{t("btnReplyToInputRequest")}</summary>
                        <div style={{ marginTop: 12 }}>
                          <DeliberationComposer
                            postAction={postTensionDeliberationAction}
                            hiddenFields={{ workspaceId, parentId: tensionId, adviceRequestId: request.id }}
                            targetOptions={targetOptions}
                            entryTypes={[
                              { value: "REACTION", label: t("entryReaction"), variant: "secondary" },
                              { value: "OBJECTION", label: t("entryObjection"), variant: "danger" },
                            ]}
                          />
                        </div>
                      </details>
                    )}
                  </div>
                );
              })}
            </div>
          )}
          {canRequestInput && (
            <details open={inputRequests.length === 0}>
              <summary className="secondary small nr-hide-marker" style={{ cursor: "pointer", display: "inline-block" }}>{t("btnRequestInput")}</summary>
              <form action={requestTensionInputAction} className="stack nr-form-section" style={{ marginTop: 12 }}>
                <input type="hidden" name="workspaceId" value={workspaceId} />
                <input type="hidden" name="tensionId" value={tension.id} />
                <label>
                  {t("inputAudience")}
                  <select name="audienceType" defaultValue={defaultCircleValue ? "CIRCLE" : "WORKSPACE"}>
                    <option value="MEMBERS">{t("inputAudienceMembers")}</option>
                    <option value="CIRCLE">{t("inputAudienceCircle")}</option>
                    <option value="WORKSPACE">{t("inputAudienceWorkspace")}</option>
                  </select>
                </label>
                <label>
                  {t("inputPeople")}
                  <select name="memberIds" multiple size={Math.min(Math.max(memberRequestOptions.length, 2), 6)}>
                    {memberRequestOptions.map((option) => (
                      <option key={option.value} value={option.value.slice("member:".length)}>{option.name}</option>
                    ))}
                  </select>
                </label>
                <label>
                  {t("inputCircle")}
                  <select name="targetCircleId" defaultValue={defaultCircleValue}>
                    {circleRequestOptions.map((option) => (
                      <option key={option.value} value={option.value.slice("circle:".length)}>{option.name}</option>
                    ))}
                  </select>
                </label>
                <label>
                  {t("inputMessage")}
                  <MarkdownEditor name="messageMd" rows={4} required />
                </label>
                <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(220px, 1fr))", gap: 12 }}>
                  <label>
                    {t("inputDeadline")}
                    <input name="deadlineAt" type="datetime-local" />
                  </label>
                  <label>
                    {t("inputReminder")}
                    <input name="reminderAt" type="datetime-local" />
                  </label>
                </div>
                <label>
                  {t("inputPreferredChannel")}
                  <select name="preferredChannel" defaultValue="IN_APP">
                    <option value="IN_APP">{t("inputChannelInApp")}</option>
                    <option value="SLACK">{t("inputChannelSlack")}</option>
                    <option value="EMAIL">{t("inputChannelEmail")}</option>
                    <option value="COPY">{t("inputChannelCopy")}</option>
                  </select>
                </label>
                <button type="submit" className="secondary small" style={{ alignSelf: "flex-start" }}>{t("btnSendInputRequest")}</button>
              </form>
            </details>
          )}
        </section>
      )}

      <section className="ws-section" style={{ marginBottom: 48 }}>
        <h2 className="nr-section-header">{t("sectionDiscussion")}</h2>
        <DeliberationThread
          entries={mappedEntries.map((entry) => ({
            ...entry,
            canEdit: canManageEntry(entry),
            canResolve: canManageEntry(entry),
          }))}
          canResolve={!isArchived}
          resolveAction={resolveTensionDeliberationAction}
          updateAction={updateTensionDeliberationAction}
          hiddenFields={{ workspaceId, parentId: tensionId }}
        />
        {!isArchived && tension.status === "OPEN" && (
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
