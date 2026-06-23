import { notFound } from "next/navigation";
import Link from "next/link";
import { getProposal, listAdviceRequests, listDeliberationEntries, listWorkItemEvidence, listWorkItemVersions, requireWorkspaceMembership } from "@corgtex/domain";
import { requirePageActor } from "@/lib/auth";
import { MarkdownEditor } from "@/lib/components/MarkdownEditor";
import { MarkdownRenderer } from "@/lib/components/MarkdownRenderer";
import { WorkItemResolutionDialog } from "@/lib/components/WorkItemResolutionDialog";
import { DeliberationThread } from "@/lib/components/DeliberationThread";
import { DeliberationComposer } from "@/lib/components/DeliberationComposer";
import { getDeliberationTargets } from "@/lib/deliberation-targets";
import { canOpenPrivateDraft } from "@/lib/governance-open-guards";
import { postDeliberationEntryAction, requestProposalAdviceAction, resolveDeliberationEntryAction, resolveProposalAction, returnProposalToDraftAction, submitProposalAction, updateDeliberationEntryAction, updateProposalAction } from "../actions";
import { ProposalDraftFields } from "../ProposalDraftFields";
import { getFormatter, getTranslations } from "next-intl/server";

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
  const tWork = await getTranslations("workItems");
  const format = await getFormatter();

  const proposal = await getProposal(actor, { workspaceId, proposalId });
  if (!proposal) notFound();
  const membership = await requireWorkspaceMembership({ actor, workspaceId });

  const [deliberationEntries, versionHistory, evidence, adviceRequests] = await Promise.all([
    listDeliberationEntries(actor, {
      workspaceId,
      parentType: "PROPOSAL",
      parentId: proposalId,
    }),
    listWorkItemVersions(actor, { workspaceId, entityType: "PROPOSAL", entityId: proposalId }),
    listWorkItemEvidence(actor, { workspaceId, entityType: "Proposal", entityId: proposalId }),
    listAdviceRequests(actor, { workspaceId, subjectType: "PROPOSAL", subjectId: proposalId, status: "ACTIVE" }),
  ]);
  const deliberationTargets = await getDeliberationTargets({ actor, workspaceId, parentCircleId: proposal.circleId });
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

  const isAuthor = proposal.authorUserId === (actor.kind === "user" ? actor.user.id : "");
  const isAdmin = actor.kind === "agent" || membership?.role === "ADMIN";
  const actorUserId = actor.kind === "user" ? actor.user.id : null;
  const actorMemberId = deliberationTargets.actorMemberId;
  const actorCircleIds = new Set(deliberationTargets.actorCircleIds);
  const canManage = actor.kind === "agent" || membership?.role === "ADMIN" || isAuthor;
  const canEditContent = proposal.status === "DRAFT" ? canManage : proposal.status === "OPEN" && isAuthor;
  const canResolve = actor.kind === "agent" || Boolean(membership);
  const canRequestAdvice = actor.kind === "user" && proposal.status === "OPEN" && !proposal.isPrivate && (isAuthor || membership?.role === "ADMIN");
  const canManageEntry = (entry: (typeof deliberationEntries)[number]) => Boolean(
    isAdmin
      || (actorUserId && entry.authorUserId === actorUserId)
      || isAuthor
      || (actorMemberId && entry.targetMemberId === actorMemberId)
      || (entry.targetCircleId && actorCircleIds.has(entry.targetCircleId)),
  );
  const memberRequestOptions = targetOptions.filter((option) => option.kind === "member");
  const circleRequestOptions = targetOptions.filter((option) => option.kind === "circle");
  const defaultCircleValue = proposal.circleId && circleRequestOptions.some((option) => option.value === `circle:${proposal.circleId}`)
    ? proposal.circleId
    : circleRequestOptions[0]?.value.slice("circle:".length) ?? "";
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
          <span>{tWork("priorityN", { priority: proposal.priority })}</span>
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
            <section style={{ marginBottom: 40 }}>
              <h3 className="font-playfair font-semibold mb-6 text-[1.4rem]">{t("sectionAdviceRequests")}</h3>
              {adviceRequests.length > 0 && (
                <div className="stack" style={{ marginBottom: canRequestAdvice ? 24 : 0 }}>
                  {adviceRequests.map((request) => {
                    const linkedReplies = mappedEntries.filter((entry) => entry.adviceRequestId === request.id);
                    return (
                      <div key={request.id} className="nr-item">
                        <div className="row" style={{ alignItems: "center", gap: 8, marginBottom: 8 }}>
                          <strong>{requestAudienceLabel(request)}</strong>
                          <span className="tag info">{channelLabel(request.preferredChannel)}</span>
                          {request.deadlineAt && <span className="tag warning">{t("adviceDeadlineTag", { date: dateTimeLabel(request.deadlineAt) ?? "" })}</span>}
                        </div>
                        <div className="nr-item-meta" style={{ marginBottom: 12 }}>
                          {t("adviceRequestedByMeta", { name: request.requestedBy.displayName || request.requestedBy.email })}
                          {request.reminderAt ? ` · ${t("adviceReminderMeta", { date: dateTimeLabel(request.reminderAt) ?? "" })}` : ""}
                        </div>
                        <MarkdownRenderer markdown={request.messageMd} variant="document" />
                        <details style={{ marginTop: 16 }}>
                          <summary className="secondary small nr-hide-marker" style={{ cursor: "pointer", display: "inline-block" }}>{t("adviceCopyableMessage")}</summary>
                          <textarea
                            readOnly
                            rows={6}
                            value={copyableRequestMessage(request)}
                            style={{ marginTop: 8, width: "100%" }}
                          />
                        </details>
                        {linkedReplies.length > 0 && (
                          <div style={{ marginTop: 16 }}>
                            <strong>{t("adviceLinkedReplies", { count: linkedReplies.length })}</strong>
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
                        {proposal.status === "OPEN" && (
                          <details style={{ marginTop: 16 }}>
                            <summary className="secondary small nr-hide-marker" style={{ cursor: "pointer", display: "inline-block" }}>{t("btnReplyToAdviceRequest")}</summary>
                            <div style={{ marginTop: 12 }}>
                              <DeliberationComposer
                                postAction={postDeliberationEntryAction}
                                hiddenFields={{ workspaceId, proposalId, adviceRequestId: request.id }}
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
              {canRequestAdvice && (
                <details open={adviceRequests.length === 0}>
                  <summary className="secondary small nr-hide-marker" style={{ cursor: "pointer", display: "inline-block" }}>{t("btnRequestAdvice")}</summary>
                  <form action={requestProposalAdviceAction} className="stack nr-form-section" style={{ marginTop: 12 }}>
                    <input type="hidden" name="workspaceId" value={workspaceId} />
                    <input type="hidden" name="proposalId" value={proposal.id} />
                    <label>
                      {t("adviceAudience")}
                      <select name="audienceType" defaultValue={defaultCircleValue ? "CIRCLE" : "WORKSPACE"}>
                        <option value="MEMBERS">{t("adviceAudienceMembers")}</option>
                        <option value="CIRCLE">{t("adviceAudienceCircle")}</option>
                        <option value="WORKSPACE">{t("adviceAudienceWorkspace")}</option>
                      </select>
                    </label>
                    <label>
                      {t("advicePeople")}
                      <select name="memberIds" multiple size={Math.min(Math.max(memberRequestOptions.length, 2), 6)}>
                        {memberRequestOptions.map((option) => (
                          <option key={option.value} value={option.value.slice("member:".length)}>{option.name}</option>
                        ))}
                      </select>
                    </label>
                    <label>
                      {t("adviceCircle")}
                      <select name="targetCircleId" defaultValue={defaultCircleValue}>
                        {circleRequestOptions.map((option) => (
                          <option key={option.value} value={option.value.slice("circle:".length)}>{option.name}</option>
                        ))}
                      </select>
                    </label>
                    <label>
                      {t("adviceMessage")}
                      <MarkdownEditor name="messageMd" rows={4} required />
                    </label>
                    <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(220px, 1fr))", gap: 12 }}>
                      <label>
                        {t("adviceDeadline")}
                        <input name="deadlineAt" type="datetime-local" />
                      </label>
                      <label>
                        {t("adviceReminder")}
                        <input name="reminderAt" type="datetime-local" />
                      </label>
                    </div>
                    <label>
                      {t("advicePreferredChannel")}
                      <select name="preferredChannel" defaultValue="IN_APP">
                        <option value="IN_APP">{t("adviceChannelInApp")}</option>
                        <option value="SLACK">{t("adviceChannelSlack")}</option>
                        <option value="EMAIL">{t("adviceChannelEmail")}</option>
                        <option value="COPY">{t("adviceChannelCopy")}</option>
                      </select>
                    </label>
                    <button type="submit" className="secondary small" style={{ alignSelf: "flex-start" }}>{t("btnSendAdviceRequest")}</button>
                  </form>
                </details>
              )}
            </section>
          )}

          <h3 className="font-playfair font-semibold mb-6 text-[1.4rem]">{t("sectionDeliberation")}</h3>
          <DeliberationThread
            entries={mappedEntries.map((entry) => ({
              ...entry,
              canEdit: canManageEntry(entry),
              canResolve: canManageEntry(entry),
            }))}
            canResolve={isAuthor || actor.kind === "agent"}
            resolveAction={resolveDeliberationEntryAction}
            updateAction={updateDeliberationEntryAction}
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
                <ProposalDraftFields defaultTitle={proposal.title} defaultBodyMd={proposal.bodyMd} defaultPriority={proposal.priority} />
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
