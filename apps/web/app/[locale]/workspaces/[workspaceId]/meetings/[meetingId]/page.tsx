import {
  getMeeting,
  getMeetingParticipants,
  getMeetingTranscriptProcessingState,
  getWorkspaceArchiveRecord,
  meetingAgendaSections,
  normalizeMeetingAgendaForDisplay,
  privacyFilter,
  requireWorkspaceMembership,
  type MeetingAgendaGroup,
  type MeetingAgendaItem,
  type MeetingAgendaSection,
} from "@corgtex/domain";
import { requirePageActor } from "@/lib/auth";
import { getFormatter, getTranslations } from "next-intl/server";
import { prisma } from "@corgtex/shared";
import Link from "next/link";
import { MarkdownExcerpt, MarkdownRenderer } from "@/lib/components/MarkdownRenderer";
import { ArchivedItemBanner } from "@/lib/components/ArchivedItemBanner";
import { UnavailableItemStatus } from "@/lib/components/UnavailableItemStatus";
import { DeliberationThread } from "@/lib/components/DeliberationThread";
import { DeliberationComposer } from "@/lib/components/DeliberationComposer";
import { getDeliberationTargets } from "@/lib/deliberation-targets";
import { listDeliberationEntries } from "@corgtex/domain";
import { postMeetingDeliberationAction, resolveMeetingDeliberationAction, retryMeetingProcessingJobAction } from "../actions";
import MeetingIntelligence, { MeetingRegenerationPanel, type InsightTargetMetadata } from "./MeetingIntelligence";
import {
  agendaItemHref,
  hasMeetingAgendaTab,
  meetingTabHref,
  normalizeMeetingTab,
  type MeetingTab,
} from "./meetingAgendaView";
import { buildMeetingProcessingView } from "./meetingProcessingView";

export const dynamic = "force-dynamic";

type MeetingInsightSummary = {
  status: string;
  type: string;
  operation: string;
  title: string;
  confidence: number | null;
  sourceQuote: string | null;
  appliedEntityType: string | null;
  appliedEntityId: string | null;
  targetEntityType: string | null;
  targetEntityId: string | null;
  supersededAt?: Date | string | null;
};

function statusTagClass(status: string, resolutionOutcome?: string | null) {
  if (status === "DRAFT") return "info";
  if (status === "OPEN") return "warning";
  if (resolutionOutcome === "ADOPTED") return "success";
  if (status === "RESOLVED") return "info";
  return "";
}

function AgendaItemView({ item, workspaceId }: { item: MeetingAgendaItem; workspaceId: string }) {
  const href = agendaItemHref(workspaceId, item);
  const body = (
    <>
      <div className="meeting-agenda-item-title">{item.text}</div>
      <div className="nr-item-meta">
        {[item.owner, item.circle, item.status].filter(Boolean).join(" · ")}
      </div>
      {item.tags && item.tags.length > 0 && (
        <div className="meeting-raised-tags">
          {item.tags.map((tag) => <span className="tag info" key={tag.key}>{tag.label}</span>)}
        </div>
      )}
      {item.bodyMd && (
        <MarkdownExcerpt markdown={item.bodyMd} maxLength={220} as="div" className="nr-excerpt" />
      )}
    </>
  );

  return href ? (
    <Link href={href} className="meeting-agenda-item">
      {body}
    </Link>
  ) : (
    <div className="meeting-agenda-item">
      {body}
    </div>
  );
}

function AgendaGroupView({ group, workspaceId }: { group: MeetingAgendaGroup; workspaceId: string }) {
  const items = (
    <div className="meeting-agenda-list">
      {group.items.map((item) => <AgendaItemView item={item} workspaceId={workspaceId} key={item.id} />)}
    </div>
  );

  if (group.collapsedByDefault) {
    return (
      <details className="meeting-agenda-group">
        <summary>{group.title}</summary>
        {items}
      </details>
    );
  }

  return (
    <div className="meeting-agenda-group">
      <h3>{group.title}</h3>
      {items}
    </div>
  );
}

function AgendaSectionView({ section, workspaceId }: { section: MeetingAgendaSection; workspaceId: string }) {
  return (
    <section className="meeting-agenda-section">
      <div>
        <h2 className="nr-section-header">{section.title}</h2>
        {section.description && <p className="nr-item-meta">{section.description}</p>}
      </div>
      {section.groups && section.groups.length > 0 ? (
        <div className="meeting-agenda-groups">
          {section.groups.map((group) => <AgendaGroupView group={group} workspaceId={workspaceId} key={group.key} />)}
        </div>
      ) : (
        <div className="meeting-agenda-list">
          {(section.items ?? []).map((item) => <AgendaItemView item={item} workspaceId={workspaceId} key={item.id} />)}
        </div>
      )}
    </section>
  );
}

export default async function MeetingDetailPage({
  params,
  searchParams,
}: {
  params: Promise<{ workspaceId: string; meetingId: string }>;
  searchParams?: Promise<Record<string, string | string[] | undefined>>;
}) {
  const { workspaceId, meetingId } = await params;
  const resolvedSearch = searchParams ? await searchParams : {};
  const actor = await requirePageActor();
  const t = await getTranslations("meetings");
  const tActions = await getTranslations("actions");
  const format = await getFormatter();
  const membership = await requireWorkspaceMembership({ actor, workspaceId });

  const meeting = await getMeeting(workspaceId, meetingId, { includeArchived: true });
  if (!meeting) {
    const archiveRecord = await getWorkspaceArchiveRecord(actor, {
      workspaceId,
      entityType: "Meeting",
      entityId: meetingId,
      includePurged: true,
    });
    const canShowArchiveRecord = actor.kind === "agent" || membership?.role === "ADMIN";
    return (
      <UnavailableItemStatus
        workspaceId={workspaceId}
        entityType="Meeting"
        entityId={meetingId}
        archiveRecord={canShowArchiveRecord ? archiveRecord : null}
        backHref={`/workspaces/${workspaceId}/meetings`}
        backLabel={t("backToMeetings")}
      />
    );
  }
  const meetingEntries = await listDeliberationEntries(actor, { workspaceId, parentType: "MEETING", parentId: meetingId });
  const deliberationTargets = await getDeliberationTargets({ actor, workspaceId });
  const targetOptions = deliberationTargets.options.map((option) => ({
    ...option,
    label: option.kind === "circle"
      ? t("targetCircle", { name: option.name })
      : t("targetPerson", { name: option.name }),
  }));
  const mappedEntries = meetingEntries.map((e: any) => ({
    ...e,
    authorName: e.author?.displayName || e.author?.email || t("unknownAuthor"),
    authorInitials: (e.author?.displayName || e.author?.email || "?").substring(0, 2).toUpperCase(),
    targetLabel: e.targetCircle
      ? t("targetCircle", { name: e.targetCircle.name })
      : e.targetMember
        ? t("targetPerson", { name: e.targetMember.user.displayName || e.targetMember.user.email })
        : null,
  }));

  const isArchived = Boolean(meeting.archivedAt);
  const isAdmin = actor.kind === "agent" || membership?.role === "ADMIN";
  const archiveRecord = isArchived
    ? await getWorkspaceArchiveRecord(actor, { workspaceId, entityType: "Meeting", entityId: meeting.id })
    : null;
  
  const agenda = normalizeMeetingAgendaForDisplay(meeting.agendaJson, meeting.title || t("untitledMeeting"));
  const hasAgendaTab = hasMeetingAgendaTab({
    agendaExists: Boolean(agenda),
    status: meeting.status,
    recurrenceRule: meeting.series?.recurrenceRule,
  });
  const participants = meeting.participantIds?.length > 0 
    ? await getMeetingParticipants(workspaceId, meeting.participantIds)
    : [];
  const activeTab = normalizeMeetingTab(resolvedSearch.tab, hasAgendaTab ? "agenda" : "summary", hasAgendaTab);
  const meetingHref = `/workspaces/${workspaceId}/meetings/${meetingId}`;
  const processingState = await getMeetingTranscriptProcessingState(actor, { workspaceId, meetingId });
  const processingView = buildMeetingProcessingView(processingState);
  const insightTargetProposalIds = [...new Set((meeting.insights as MeetingInsightSummary[])
    .filter((insight: MeetingInsightSummary) => insight.targetEntityType === "Proposal" && insight.targetEntityId)
    .map((insight: MeetingInsightSummary) => insight.targetEntityId as string))];
  const insightTargetTensionIds = [...new Set((meeting.insights as MeetingInsightSummary[])
    .filter((insight: MeetingInsightSummary) => insight.targetEntityType === "Tension" && insight.targetEntityId)
    .map((insight: MeetingInsightSummary) => insight.targetEntityId as string))];
  const [insightTargetProposals, insightTargetTensions] = await Promise.all([
    insightTargetProposalIds.length > 0
      ? prisma.proposal.findMany({
        where: { workspaceId, id: { in: insightTargetProposalIds }, archivedAt: null, ...privacyFilter(actor, membership) },
        select: { id: true, title: true },
      })
      : Promise.resolve([]),
    insightTargetTensionIds.length > 0
      ? prisma.tension.findMany({
        where: { workspaceId, id: { in: insightTargetTensionIds }, archivedAt: null, ...privacyFilter(actor, membership) },
        select: { id: true, title: true },
      })
      : Promise.resolve([]),
  ]);
  const insightTargets: Record<string, InsightTargetMetadata> = Object.fromEntries([
    ...insightTargetProposals.map((proposal: { id: string; title: string }) => [`Proposal:${proposal.id}`, {
      label: t("insightTargetProposal", { title: proposal.title }),
      href: `/workspaces/${workspaceId}/proposals/${proposal.id}`,
    }]),
    ...insightTargetTensions.map((tension: { id: string; title: string }) => [`Tension:${tension.id}`, {
      label: t("insightTargetTension", { title: tension.title }),
      href: `/workspaces/${workspaceId}/tensions/${tension.id}`,
    }]),
  ]);
  const raisedActions = meeting.raisedActions ?? [];
  const raisedEvidenceByEntity = new Map<string, MeetingInsightSummary[]>();
  for (const insight of meeting.insights as MeetingInsightSummary[]) {
    if (insight.status !== "APPLIED" || !insight.appliedEntityType || !insight.appliedEntityId) continue;
    if (insight.appliedEntityType !== "Proposal" && insight.appliedEntityType !== "Tension" && insight.appliedEntityType !== "Action") continue;
    const key = `${insight.appliedEntityType}:${insight.appliedEntityId}`;
    raisedEvidenceByEntity.set(key, [...(raisedEvidenceByEntity.get(key) ?? []), insight]);
  }
  const raisedItemCount = meeting.tensions.length + meeting.proposals.length + raisedActions.length;
  const tabs: Array<{ key: MeetingTab; label: string }> = [
    ...(hasAgendaTab ? [{ key: "agenda" as const, label: t("tabAgenda") }] : []),
    { key: "summary", label: t("tabSummary") },
    { key: "raised", label: t("tabRaised", { count: raisedItemCount }) },
    { key: "evidence", label: t("tabEvidence") },
  ];
  const evidenceFor = (entityType: "Proposal" | "Tension" | "Action", entityId: string) => (
    raisedEvidenceByEntity.get(`${entityType}:${entityId}`) ?? []
  );
  const renderRaisedEvidence = (evidence: MeetingInsightSummary[]) => {
    if (evidence.length === 0) return null;
    const primaryEvidence = evidence[0];
    const targetKey = primaryEvidence.targetEntityType && primaryEvidence.targetEntityId
      ? `${primaryEvidence.targetEntityType}:${primaryEvidence.targetEntityId}`
      : null;
    const target = targetKey ? insightTargets[targetKey] : null;

    return (
      <div className="meeting-raised-evidence">
        <div className="meeting-raised-evidence-meta">
          <span>{t("raisedEvidenceTitle")}</span>
          {typeof primaryEvidence.confidence === "number" && (
            <span>{t("confidencePercent", { percent: Math.round(primaryEvidence.confidence * 100) })}</span>
          )}
          {target && <span>{t("raisedEvidenceTarget", { target: target.label })}</span>}
        </div>
        {primaryEvidence.sourceQuote && (
          <blockquote>{primaryEvidence.sourceQuote}</blockquote>
        )}
      </div>
    );
  };

  return (
    <>
      <div style={{ marginBottom: "32px" }}>
        <Link href={`/workspaces/${workspaceId}/meetings`} className="nr-meta" style={{ textDecoration: "none" }}>
          {t("backToBoardMeetings")}
        </Link>
      </div>

      <header className="nr-masthead" style={{ textAlign: "left", marginBottom: 32 }}>
        <div className="nr-meta" style={{ marginBottom: "8px" }}>{meeting.source}</div>
        <h1 style={{ border: "none", padding: 0, margin: 0, fontSize: "2rem" }}>
          {meeting.title || t("untitledMeeting")}
        </h1>
        <div className="nr-masthead-meta">
          <span>{format.dateTime(meeting.recordedAt, { dateStyle: "medium", timeStyle: "short" })}</span>
        </div>
      </header>

      {isArchived && (
        <ArchivedItemBanner
          archivedAt={meeting.archivedAt}
          archivedBy={archiveRecord?.archivedByLabel ?? archiveRecord?.archivedByUserId}
          archiveReason={meeting.archiveReason}
          restoreHref={isAdmin ? `/workspaces/${workspaceId}/audit?tab=archive&archiveEntityType=Meeting` : null}
        />
      )}

      {processingView && (
        <section className={`meeting-processing-stepper ${processingView.overallClass}`} style={{ marginBottom: 32 }}>
          <div className="meeting-processing-stepper-header">
            <div>
              <span className="meeting-processing-status-label">
                <span className="meeting-processing-status-dot" aria-hidden="true" />
                {t(processingView.titleKey)}
              </span>
              <p>
                {processingView.activeStageLabelKey
                  ? t("processingOverallActiveDescription", { step: t(processingView.activeStageLabelKey) })
                  : t("processingOverallIdleDescription")}
              </p>
            </div>
          </div>
          <ol className="meeting-processing-steps">
            {processingView.steps.map((step) => (
              <li className={`meeting-processing-step ${step.className}`} key={step.stage}>
                <span className="meeting-processing-step-marker" aria-hidden="true" />
                <div>
                  <strong>{t(step.labelKey)}</strong>
                  <span>{t(step.statusKey)}</span>
                  {step.chunkIndex && step.chunkCount && step.chunkCount > 1 && (
                    <em>{t("processingSectionProgress", { current: step.chunkIndex, total: step.chunkCount })}</em>
                  )}
                </div>
              </li>
            ))}
          </ol>
          {isAdmin && processingView.diagnostics.length > 0 && (
            <details className="meeting-processing-diagnostics">
              <summary>{t("processingDiagnosticsTitle")}</summary>
              <div className="meeting-processing-diagnostics-list">
                {processingView.diagnostics.map((diagnostic) => (
                  <div className="meeting-processing-diagnostic" key={diagnostic.workflowJobId}>
                    <div className="row">
                      <strong>{diagnostic.workflowJobType}</strong>
                      <span className={`tag ${diagnostic.status === "FAILED" ? "warning" : "info"}`}>{diagnostic.status}</span>
                    </div>
                    <p className="nr-item-meta">
                      {t("processingDiagnosticsMeta", {
                        attempts: diagnostic.attempts,
                        date: diagnostic.updatedAt ? format.dateTime(new Date(diagnostic.updatedAt), { dateStyle: "medium", timeStyle: "short" }) : t("processingDiagnosticsNoDate"),
                      })}
                    </p>
                    {diagnostic.safeErrorMessage && (
                      <p className="meeting-processing-diagnostic-error">{diagnostic.safeErrorMessage}</p>
                    )}
                    {diagnostic.retrySupported && (
                      <form action={retryMeetingProcessingJobAction}>
                        <input type="hidden" name="workspaceId" value={workspaceId} />
                        <input type="hidden" name="workflowJobId" value={diagnostic.workflowJobId} />
                        <button type="submit" className="secondary small">{t("processingRetryFailedJob")}</button>
                      </form>
                    )}
                  </div>
                ))}
              </div>
            </details>
          )}
        </section>
      )}
      
      <nav className="nr-tab-bar meeting-detail-tabs" aria-label={t("meetingDetailTabsLabel")}>
        {tabs.map((tab) => (
          <Link
            key={tab.key}
            href={meetingTabHref(meetingHref, tab.key)}
            className={`nr-tab ${activeTab === tab.key ? "nr-tab-active" : ""}`}
            aria-current={activeTab === tab.key ? "page" : undefined}
          >
            {tab.label}
          </Link>
        ))}
      </nav>

      <div className="meeting-tab-panel">
        {activeTab === "agenda" && (
          <section className="ws-section meeting-agenda-stack" style={{ marginBottom: 48 }}>
            {agenda ? (
              meetingAgendaSections(agenda).map((section) => (
                <AgendaSectionView section={section} workspaceId={workspaceId} key={section.key} />
              ))
            ) : (
              <p className="meeting-empty-state">{t("agendaPreparing")}</p>
            )}
          </section>
        )}

        {activeTab === "summary" && (
          <>
            {participants.length > 0 && (
              <section className="ws-section" style={{ marginBottom: 32 }}>
                <h2 className="nr-section-header">{t("participants")}</h2>
                <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
                  {participants.map((p: any) => (
                    <Link
                      key={p.id}
                      href={`/workspaces/${workspaceId}/members/${p.id}`}
                      className="flex items-center gap-3 p-3 rounded-xl border bg-card hover:border-primary/50 transition-colors shadow-sm"
                      style={{ textDecoration: "none", color: "inherit" }}
                    >
                      <div className="flex-shrink-0 flex items-center justify-center w-10 h-10 rounded-full bg-primary/10 text-primary font-bold">
                        {(p.user?.displayName || p.user?.email || "?").slice(0, 2).toUpperCase()}
                      </div>
                      <div>
                        <div className="font-semibold text-sm">
                          {p.user?.displayName || p.user?.email}
                        </div>
                        <div className="text-xs text-muted-foreground line-clamp-1">
                          {p.roleAssignments[0]?.role.name || t("participant")}
                          {p.roleAssignments.length > 1 && t("moreRoles", { count: p.roleAssignments.length - 1 })}
                        </div>
                      </div>
                    </Link>
                  ))}
                </div>
              </section>
            )}

            {meeting.ingestionGuidanceMd && (
              <section className="ws-section" style={{ marginBottom: 32 }}>
                <h2 className="nr-section-header">{t("userGuidance")}</h2>
                <MarkdownRenderer markdown={meeting.ingestionGuidanceMd} variant="document" />
              </section>
            )}

            <section className="ws-section" style={{ marginBottom: 32 }}>
              <h2 className="nr-section-header">{t("summary")}</h2>
              {meeting.summaryMd ? (
                <MarkdownRenderer markdown={meeting.summaryMd} variant="document" />
              ) : (
                <p className="meeting-empty-state">{t("summaryEmpty")}</p>
              )}
            </section>

            {!isArchived && <MeetingRegenerationPanel
              workspaceId={workspaceId}
              meetingId={meetingId}
              hasTranscript={Boolean(meeting.transcript)}
            />}
          </>
        )}

        {activeTab === "raised" && (
          <section className="ws-section meeting-raised-section" style={{ marginBottom: 48 }}>
            <div className="meeting-raised-header">
              <h2 className="nr-section-header">{t("raisedItemsTitle")}</h2>
              <p className="nr-item-meta">{t("raisedItemsDescription")}</p>
            </div>

            {raisedItemCount === 0 ? (
              <p className="meeting-empty-state">{t("raisedItemsEmpty")}</p>
            ) : (
              <div className="meeting-raised-groups">
                {meeting.tensions.length > 0 && (
                  <div>
                    <h3 className="meeting-raised-group-title">{t("tensionsRaised")}</h3>
                    <div className="meeting-raised-grid">
                      {meeting.tensions.map((tension: any) => (
                        <Link
                          href={`/workspaces/${workspaceId}/tensions/${tension.id}`}
                          className="meeting-raised-card"
                          key={tension.id}
                        >
                          <div className="meeting-raised-card-head">
                            <span className="tag info">{t("raisedTypeTension")}</span>
                            <span className={`tag ${statusTagClass(tension.status)}`}>
                              {tension.status}
                            </span>
                          </div>
                          <h3>{tension.title}</h3>
                          <MarkdownExcerpt markdown={tension.bodyMd} maxLength={240} as="div" className="nr-excerpt" />
                          <div className="nr-item-meta">
                            {tension.author?.displayName || tension.author?.email}
                          </div>
                          {renderRaisedEvidence(evidenceFor("Tension", tension.id))}
                        </Link>
                      ))}
                    </div>
                  </div>
                )}

                {raisedActions.length > 0 && (
                  <div>
                    <h3 className="meeting-raised-group-title">{t("insightType.action_item")}</h3>
                    <div className="meeting-raised-grid">
                      {raisedActions.map((action: any) => {
                        const assigneeName = action.assigneeMember?.user?.displayName || action.assigneeMember?.user?.email || null;
                        const dueDate = action.dueAt ? new Date(action.dueAt).toLocaleDateString() : null;

                        return (
                          <Link
                            href={`/workspaces/${workspaceId}/actions/${action.id}`}
                            className="meeting-raised-card"
                            key={action.id}
                          >
                            <div className="meeting-raised-card-head">
                              <span className="tag info">{t("insightType.action_item")}</span>
                              <span className={`tag ${statusTagClass(action.status)}`}>
                                {action.status}
                              </span>
                            </div>
                            <h3>{action.title}</h3>
                            <MarkdownExcerpt markdown={action.bodyMd} maxLength={240} as="div" className="nr-excerpt" />
                            <div className="nr-item-meta">
                              {action.author?.displayName || action.author?.email}
                              {assigneeName ? ` · ${tActions("metaAssignee", { name: assigneeName })}` : ""}
                              {dueDate ? ` · ${tActions("metaDue", { date: dueDate })}` : ""}
                            </div>
                            {renderRaisedEvidence(evidenceFor("Action", action.id))}
                          </Link>
                        );
                      })}
                    </div>
                  </div>
                )}

                {meeting.proposals.length > 0 && (
                  <div>
                    <h3 className="meeting-raised-group-title">{t("proposalsCreated")}</h3>
                    <div className="meeting-raised-grid">
                      {meeting.proposals.map((proposal: any) => (
                        <Link
                          href={`/workspaces/${workspaceId}/proposals/${proposal.id}`}
                          className="meeting-raised-card"
                          key={proposal.id}
                        >
                          <div className="meeting-raised-card-head">
                            <span className="tag info">{t("raisedTypeProposal")}</span>
                            <span className={`tag ${statusTagClass(proposal.status, proposal.resolutionOutcome)}`}>
                              {proposal.status === "RESOLVED" && proposal.resolutionOutcome ? `${proposal.status} · ${proposal.resolutionOutcome.replace("_", " ")}` : proposal.status}
                            </span>
                          </div>
                          <h3>{proposal.title}</h3>
                          <MarkdownExcerpt markdown={proposal.summary ?? proposal.bodyMd} maxLength={240} as="div" className="nr-excerpt" />
                          <div className="nr-item-meta">
                            {proposal.author?.displayName || proposal.author?.email} · {format.dateTime(proposal.createdAt, { dateStyle: "medium" })}
                          </div>
                          {(proposal.tensions?.length > 0 || proposal.actions?.length > 0) && (
                            <div className="meeting-raised-tags">
                              {proposal.tensions?.map((linkedTension: any) => (
                                <span key={linkedTension.id} className="tag info">
                                  {t("tensionTag", { title: linkedTension.title })}
                                </span>
                              ))}
                              {proposal.actions?.map((a: any) => (
                                <span key={a.id} className="tag info">
                                  {t("actionTag", { title: a.title })}
                                </span>
                              ))}
                            </div>
                          )}
                          {renderRaisedEvidence(evidenceFor("Proposal", proposal.id))}
                        </Link>
                      ))}
                    </div>
                  </div>
                )}
              </div>
            )}
          </section>
        )}

        {activeTab === "evidence" && (
          <section className="ws-section meeting-evidence-stack" style={{ marginBottom: 48 }}>
            <MeetingIntelligence
              workspaceId={workspaceId}
              insights={meeting.insights}
              insightTargets={insightTargets}
              hasTranscript={Boolean(meeting.transcript)}
            />

            {meeting.transcript && (
              <details className="meeting-evidence-drawer">
                <summary className="meeting-evidence-summary">
                  <div>
                    <span className="nr-section-header" style={{ borderTop: "none", margin: 0, padding: 0 }}>{t("btnViewTranscript")}</span>
                    <p className="nr-item-meta" style={{ marginTop: 6 }}>{t("transcriptEvidenceDescription")}</p>
                  </div>
                </summary>
                <div className="meeting-transcript-block">
                  {meeting.transcript}
                </div>
              </details>
            )}
          </section>
        )}
      </div>

      <section className="ws-section" style={{ marginBottom: 48 }}>
        <h2 className="nr-section-header">{t("discussion")}</h2>
        <DeliberationThread entries={mappedEntries} canResolve={!isArchived} resolveAction={resolveMeetingDeliberationAction} hiddenFields={{ workspaceId, parentId: meetingId }} />
        {!isArchived && <div style={{ marginTop: 24 }}>
          <DeliberationComposer 
            postAction={postMeetingDeliberationAction} 
            hiddenFields={{ workspaceId, parentId: meetingId }}
            targetOptions={targetOptions}
            entryTypes={[
              { value: "REACTION", label: t("entryReaction"), variant: "secondary" },
              { value: "OBJECTION", label: t("entryObjection"), variant: "danger" },
            ]}
          />
        </div>}
      </section>
    </>
  );
}
