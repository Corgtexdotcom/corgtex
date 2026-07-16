import { deriveMeetingEvidenceState, getMeetingRecorderConfig, listHumanMembers, listMeetingRecordings, listMeetings } from "@corgtex/domain";
import { requirePageActor } from "@/lib/auth";
import {
  archiveMeetingAction,
  cancelMeetingRecordingAction,
  createMeetingSeriesAction,
  importMeetingInviteAction,
  scheduleMeetingRecordingAction,
} from "../actions";
import { getTranslations } from "next-intl/server";
import Link from "next/link";
import { getWorkspaceFeatureFlags } from "@/lib/workspace-feature-flags";
import { MarkdownExcerpt } from "@/lib/components/MarkdownRenderer";
import { TimeZoneSelect } from "@/lib/components/TimeZoneSelect";
import { ItemActions } from "@/lib/components/ui/ItemActions";
import { MeetingTranscriptUploadForm } from "./MeetingTranscriptUploadForm";
import { WorkItemFilterControls } from "@/lib/components/WorkItemControls";
import {
  DEFAULT_MEETING_DURATION_MINUTES,
  MAX_MEETING_DURATION_MINUTES,
  MIN_MEETING_DURATION_MINUTES,
} from "@/lib/meeting-timezone";
import {
  buildWorkItemQuery,
  normalizeDateOnly,
  resolveWorkItemFilters,
  startOfUtcDate,
  endOfUtcDate,
} from "@/lib/work-item-view";
import {
  buildMeetingListView,
  filterMeetingRecordingForEvidenceState,
  MEETING_STATUS_FILTERS,
  normalizeMeetingStatusFilters,
} from "./meetingListView";

export const dynamic = "force-dynamic";

export default async function MeetingsPage({
  params,
  searchParams,
}: {
  params: Promise<{ workspaceId: string }>;
  searchParams?: Promise<Record<string, string | string[] | undefined>>;
}) {
  const { workspaceId } = await params;
  const actor = await requirePageActor();
  const resolvedSearch = searchParams ? await searchParams : {};
  const statusFilters = normalizeMeetingStatusFilters(resolvedSearch.status);
  const { memberIds } = resolveWorkItemFilters(resolvedSearch);
  const dateValues = {
    recordedFrom: normalizeDateOnly(resolvedSearch.recordedFrom),
    recordedTo: normalizeDateOnly(resolvedSearch.recordedTo),
  };
  const meetingFilters = {
    memberIds,
    recordedFrom: dateValues.recordedFrom ? startOfUtcDate(dateValues.recordedFrom) : undefined,
    recordedTo: dateValues.recordedTo ? endOfUtcDate(dateValues.recordedTo) : undefined,
  };
  const [filteredCompletedMeetings, filteredUpcomingMeetings, featureFlags, recorderConfig, members] = await Promise.all([
    listMeetings(workspaceId, { status: "COMPLETED", ...meetingFilters }),
    listMeetings(workspaceId, { status: "SCHEDULED", ...meetingFilters }),
    getWorkspaceFeatureFlags(workspaceId),
    getMeetingRecorderConfig(actor, workspaceId).catch(() => null),
    listHumanMembers(workspaceId),
  ]);
  const scheduledMeetings = filteredUpcomingMeetings;
  const now = new Date();
  const recorderEnabled = Boolean(featureFlags.MEETING_RECORDERS && recorderConfig?.featureEnabled && recorderConfig.config.enabled);
  const recordings = await listMeetingRecordings(workspaceId, scheduledMeetings.map((meeting) => meeting.id));
  const latestRecordingByMeeting = new Map(recordings.map((recording) => [recording.meetingId, recording]));
  const meetingEvidenceStateById = new Map(scheduledMeetings.map((meeting) => [
    meeting.id,
    deriveMeetingEvidenceState({
      now,
      recorderEnabled,
      meeting,
      latestRecording: filterMeetingRecordingForEvidenceState(latestRecordingByMeeting.get(meeting.id), { recorderEnabled }),
    }),
  ] as const));
  const meetingListView = buildMeetingListView({
    completedMeetings: filteredCompletedMeetings,
    scheduledMeetings,
    evidenceStateByMeetingId: meetingEvidenceStateById,
    statusFilters,
  });
  const completedMeetings = meetingListView.completedMeetings;
  const actionNeededMeetings = meetingListView.actionNeededMeetings;
  const upcomingMeetings = meetingListView.upcomingMeetings;
  const recorderSentMeetingId = Array.isArray(resolvedSearch.recorderSent)
    ? resolvedSearch.recorderSent[0] ?? null
    : resolvedSearch.recorderSent ?? null;
  const recorderSentMeeting = recorderSentMeetingId
    ? scheduledMeetings.find((meeting) => meeting.id === recorderSentMeetingId) ?? null
    : null;
  const recorderSentRecording = recorderSentMeeting
    ? latestRecordingByMeeting.get(recorderSentMeeting.id) ?? null
    : null;
  const t = await getTranslations("meetings");
  const tCommon = await getTranslations("common");
  const tWork = await getTranslations("workItems");
  const filterState = { memberIds, dates: dateValues, status: statusFilters };
  const memberName = (member: { user: { displayName: string | null; email: string } }) => member.user.displayName || member.user.email;
  const completedDisplayCount = completedMeetings.length + actionNeededMeetings.length;
  const renderRecorderControls = (meeting: (typeof scheduledMeetings)[number]) => {
    const recording = filterMeetingRecordingForEvidenceState(latestRecordingByMeeting.get(meeting.id), { recorderEnabled });
    const evidenceState = meetingEvidenceStateById.get(meeting.id) ?? deriveMeetingEvidenceState({
      now,
      recorderEnabled,
      meeting,
      latestRecording: recording ?? null,
    });
    const statusLabel = evidenceState.state === "provider_recovery_pending"
      ? t("recorderRecoveryPending")
      : evidenceState.state === "needs_transcript"
        ? t("meetingEvidenceNeedsTranscript")
        : recording
          ? `Recorder ${recording.status}`
          : evidenceState.state === "missing_meeting_link"
            ? t("recorderNoMeetingLink")
            : t("recorderReady");
    const isWarning = evidenceState.state === "needs_transcript"
      || evidenceState.state === "provider_recovery_pending"
      || recording?.status === "FAILED";
    const shouldRenderStatus = recorderEnabled || isWarning;

    return shouldRenderStatus ? (
      <div className="row" style={{ alignItems: "flex-start", gap: 12, marginBottom: 8 }}>
        <div>
          <span className={`tag ${isWarning ? "warning" : ""}`}>{statusLabel}</span>
          {recording?.failureMessage ? (
            <div className="nr-item-meta" style={{ fontSize: "0.82rem", marginTop: 4 }}>
              {recording.provider}: {recording.failureMessage}
            </div>
          ) : recording ? (
            <div className="nr-item-meta" style={{ fontSize: "0.82rem", marginTop: 4 }}>
              {recording.provider}
            </div>
          ) : null}
        </div>
        {recorderEnabled && evidenceState.action === "cancel_recorder" ? (
          <form action={cancelMeetingRecordingAction}>
            <input type="hidden" name="workspaceId" value={workspaceId} />
            <input type="hidden" name="meetingId" value={meeting.id} />
            <button type="submit" className="secondary small">{t("btnCancelRecorder")}</button>
          </form>
        ) : recorderEnabled && evidenceState.action === "schedule_recorder" ? (
          <form action={scheduleMeetingRecordingAction}>
            <input type="hidden" name="workspaceId" value={workspaceId} />
            <input type="hidden" name="meetingId" value={meeting.id} />
            <button type="submit" className="secondary small">{t("btnRecordWithCorgtex")}</button>
          </form>
        ) : null}
      </div>
    ) : null;
  };
  const renderTranscriptUploadMenu = (meeting: (typeof scheduledMeetings)[number]) => (
    <details>
      <summary className="nr-hide-marker nr-action-summary">
        {t("uploadTranscriptForMeeting")}
      </summary>
      <MeetingTranscriptUploadForm
        workspaceId={workspaceId}
        className="action-menu-form"
        hiddenFields={[
          { name: "meetingId", value: meeting.id },
          { name: "title", value: meeting.title ?? "" },
          { name: "recordedAt", value: new Date(meeting.recordedAt).toISOString() },
        ]}
        labels={{
          file: t("formTranscriptFile"),
          transcript: t("formTranscript"),
          ingestionGuidance: t("formIngestionGuidance"),
          ingestionGuidanceHelp: t("helpIngestionGuidance"),
          submit: t("btnUploadTranscript"),
          retrySubmit: t("btnUploadTranscript"),
          chooseMeeting: t("chooseTranscriptMeeting"),
          createNewMeeting: t("createNewTranscriptMeeting"),
          retryUpload: t("retryTranscriptUpload"),
        }}
      />
    </details>
  );

  return (
    <>
      <header className="nr-masthead" style={{ textAlign: "left", marginBottom: 32 }}>
        <h1 style={{ border: "none", padding: 0, margin: 0, fontSize: "2rem" }}>{t("pageTitle")}</h1>
        <div className="nr-masthead-meta">
          <span>{t("meetingsRecorded", { count: completedMeetings.length })}</span>
          <span>{t("meetingsScheduled", { count: upcomingMeetings.length })}</span>
          <span>{t("meetingsNeedTranscript", { count: actionNeededMeetings.length })}</span>
        </div>
      </header>

      {recorderSentMeeting ? (
        <div className="form-message form-message-success" role="status" style={{ marginBottom: 24 }}>
          <strong>{t("recorderSentTitle")}</strong>{" "}
          {t("recorderSentDescription", { status: recorderSentRecording?.status ?? t("recorderStatusPending") })}{" "}
          <Link href={`/workspaces/${workspaceId}/meetings/${recorderSentMeeting.id}`}>
            {t("recorderSentViewMeeting")}
          </Link>
        </div>
      ) : null}

      {/* ── OUTPUT SECTIONS (primary content) ────────────────────── */}

      <section className="ws-section" style={{ marginBottom: 48 }}>
        <div className="nr-filter-bar nr-filter-bar-wrap">
          {([
            { status: "ALL", label: tWork("statusAll"), count: meetingListView.counts.all },
            { status: "COMPLETED", label: t("completedMeetings"), count: meetingListView.counts.completed },
            { status: "SCHEDULED", label: t("scheduledMeetings"), count: meetingListView.counts.scheduled },
          ] as const).map((item) => {
            const isActive = item.status === "ALL" ? statusFilters.length === 0 : statusFilters.includes(item.status);
            return (
              <a
                key={item.status}
                href={buildWorkItemQuery({ ...filterState, status: item.status })}
                className={`nr-filter-item ${isActive ? "nr-filter-active" : ""}`}
              >
                {item.label} ({item.count})
              </a>
            );
          })}
        </div>
        <WorkItemFilterControls
          action={`/workspaces/${workspaceId}/meetings`}
          statusOptions={MEETING_STATUS_FILTERS.map((status) => ({
            id: status,
            label: status === "COMPLETED" ? t("completedMeetings") : t("scheduledMeetings"),
          }))}
          statusValues={statusFilters}
          memberIds={memberIds}
          circles={[]}
          members={members.map((member) => ({ id: member.id, label: memberName(member) }))}
          dates={[
            { name: "recordedFrom", label: tWork("dateFrom"), value: dateValues.recordedFrom },
            { name: "recordedTo", label: tWork("dateTo"), value: dateValues.recordedTo },
          ]}
          showCircle={false}
          labels={{
            scope: tWork("scope"),
            company: tWork("companyScope"),
            status: tWork("status"),
            allStatuses: tWork("allStatuses"),
            circle: tWork("circle"),
            person: tWork("person"),
            allCircles: tWork("allCircles"),
            allPeople: tWork("allPeople"),
            selectAll: tWork("selectAll"),
            unselectAll: tWork("unselectAll"),
            selectedCount: tWork("selectedCount", { count: "{count}" }),
            apply: tWork("applyFilters"),
            clear: tWork("clearFilters"),
          }}
        />

        <h2 className="nr-section-header">{t("completedMeetings")}</h2>
        {completedDisplayCount === 0 && <p className="nr-meta">{t("noMeetings")}</p>}
        {completedDisplayCount > 0 && (
          <div style={{ display: "flex", flexDirection: "column", gap: "16px" }}>
            {actionNeededMeetings.map((meeting) => (
              <div className="nr-item" key={meeting.id}>
                {renderRecorderControls(meeting)}
                <Link href={`/workspaces/${workspaceId}/meetings/${meeting.id}`} style={{ textDecoration: "none", color: "inherit" }}>
                  <div className="nr-item-title">{meeting.title ?? t("untitledMeeting")}</div>
                  <div className="nr-item-meta">
                    {new Date(meeting.recordedAt).toLocaleString()} • {meeting.source}
                    {meeting.agendaPostedAt ? ` • ${t("agendaPosted")}` : ""}
                  </div>
                </Link>
                <ItemActions
                  moreLabel={tCommon("moreActions")}
                  primary={
                    <>
                      <Link className="link-button small" href={`/workspaces/${workspaceId}/meetings/${meeting.id}`}>
                        {tCommon("btnView")}
                      </Link>
                      {renderTranscriptUploadMenu(meeting)}
                    </>
                  }
                />
              </div>
            ))}
            {/* Featured latest meeting */}
            {completedMeetings.length > 0 && (
              <div style={{ borderBottom: "1px solid var(--line)", paddingBottom: "24px", marginBottom: "8px" }}>
                <Link href={`/workspaces/${workspaceId}/meetings/${completedMeetings[0].id}`} style={{ textDecoration: "none", color: "inherit", display: "block" }}>
                  <div className="nr-meta" style={{ marginBottom: "8px" }}>{completedMeetings[0].source}</div>
                  <h2 className="nr-lead-headline" style={{ fontSize: "1.8rem" }}>{completedMeetings[0].title ?? t("untitledMeeting")}</h2>
                  <div className="nr-item-meta" style={{ marginBottom: "12px" }}>{new Date(completedMeetings[0].recordedAt).toLocaleString()}</div>
                  {completedMeetings[0].summaryMd && <MarkdownExcerpt markdown={completedMeetings[0].summaryMd} maxLength={520} as="p" className="nr-excerpt" />}
                </Link>
                <ItemActions
                  moreLabel={tCommon("moreActions")}
                  primary={
                    <Link className="link-button small" href={`/workspaces/${workspaceId}/meetings/${completedMeetings[0].id}`}>
                      {tCommon("btnView")}
                    </Link>
                  }
                  more={
                    <form action={archiveMeetingAction}>
                      <input type="hidden" name="workspaceId" value={workspaceId} />
                      <input type="hidden" name="meetingId" value={completedMeetings[0].id} />
                      <button type="submit" className="danger">{t("btnArchiveMeeting")}</button>
                    </form>
                  }
                />
              </div>
            )}

            {/* Other meetings list */}
            {completedMeetings.slice(1).map((meeting) => (
              <div className="nr-item" key={meeting.id}>
                <Link href={`/workspaces/${workspaceId}/meetings/${meeting.id}`} style={{ textDecoration: "none", color: "inherit" }}>
                  <div className="nr-item-title">{meeting.title ?? t("untitledMeeting")}</div>
                  <div className="nr-item-meta">
                    {new Date(meeting.recordedAt).toLocaleString()} • {meeting.source}
                  </div>
                  {meeting.summaryMd && (
                    <MarkdownExcerpt markdown={meeting.summaryMd} maxLength={320} as="div" className="nr-excerpt" />
                  )}
                </Link>
                <ItemActions
                  moreLabel={tCommon("moreActions")}
                  primary={
                    <Link className="link-button small" href={`/workspaces/${workspaceId}/meetings/${meeting.id}`}>
                      {tCommon("btnView")}
                    </Link>
                  }
                  more={
                    <form action={archiveMeetingAction}>
                      <input type="hidden" name="workspaceId" value={workspaceId} />
                      <input type="hidden" name="meetingId" value={meeting.id} />
                      <button type="submit" className="danger">{t("btnArchive")}</button>
                    </form>
                  }
                />
              </div>
            ))}
          </div>
        )}
      </section>

      <section className="ws-section" style={{ marginBottom: 48 }}>
        <h2 className="nr-section-header">{t("upcomingMeetings")}</h2>
        {upcomingMeetings.length === 0 && <p className="nr-meta">{t("noUpcomingMeetings")}</p>}
        {upcomingMeetings.length > 0 && (
          <div style={{ display: "flex", flexDirection: "column", gap: 16 }}>
            {upcomingMeetings.map((meeting) => (
              <div className="nr-item" key={meeting.id}>
                {renderRecorderControls(meeting)}
                <Link href={`/workspaces/${workspaceId}/meetings/${meeting.id}`} style={{ textDecoration: "none", color: "inherit" }}>
                  <div className="nr-item-title">{meeting.title ?? t("untitledMeeting")}</div>
                  <div className="nr-item-meta">
                    {new Date(meeting.recordedAt).toLocaleString()} • {meeting.source}
                    {meeting.agendaPostedAt ? ` • ${t("agendaPosted")}` : ""}
                  </div>
                </Link>
                <ItemActions
                  moreLabel={tCommon("moreActions")}
                  primary={
                    <>
                      <Link className="link-button small" href={`/workspaces/${workspaceId}/meetings/${meeting.id}`}>
                        {tCommon("btnView")}
                      </Link>
                      {renderTranscriptUploadMenu(meeting)}
                    </>
                  }
                />
              </div>
            ))}
          </div>
        )}
      </section>

      {/* ── INPUT SECTIONS (collapsed by default) ────────────────── */}

      <div style={{ marginTop: "32px", borderTop: "1px solid var(--line)", paddingTop: "32px" }}>
        <details>
          <summary className="nr-hide-marker" style={{ cursor: "pointer", fontWeight: 600, color: "var(--accent)" }}>
            <span className="nr-section-header" style={{ borderTop: "none", display: "inline-block", padding: 0, margin: 0 }}>{t("newScheduledMeetingTitle")}</span>
          </summary>
          <div style={{ marginTop: "24px" }}>
            <form action={createMeetingSeriesAction} className="stack panel">
              <input type="hidden" name="workspaceId" value={workspaceId} />
              <label>
                {t("formTitle")}
                <input name="title" required />
              </label>
              <label>
                {t("formDescription")}
                <textarea name="description" />
              </label>
              <div className="actions-inline">
                <label style={{ flex: 1 }}>
                  {t("formStartsAt")}
                  <input name="startsAt" type="datetime-local" required />
                </label>
                <label style={{ flex: 1 }}>
                  {t("formDurationMinutes")}
                  <input name="durationMinutes" type="number" min={MIN_MEETING_DURATION_MINUTES} max={MAX_MEETING_DURATION_MINUTES} step={1} defaultValue={DEFAULT_MEETING_DURATION_MINUTES} />
                </label>
              </div>
              <TimeZoneSelect />
              <label>
                {t("formRecurrenceRule")}
                <select name="recurrenceRule" defaultValue="">
                  <option value="">{t("recurrenceNone")}</option>
                  <option value="FREQ=DAILY">{t("recurrenceDaily")}</option>
                  <option value="FREQ=WEEKLY">{t("recurrenceWeekly")}</option>
                  <option value="FREQ=MONTHLY">{t("recurrenceMonthly")}</option>
                </select>
              </label>
              <label>
                Meeting URL
                <input name="meetingUrl" type="url" placeholder="https://teams.microsoft.com/meet/..." />
              </label>
              <label>
                {t("formParticipantEmails")}
                <input name="participantEmails" placeholder={t("formParticipantEmailsPlaceholder")} />
              </label>
              <label>
                {t("formParticipantIds")}
                <input name="participantIds" placeholder={t("formParticipantIdsPlaceholder")} />
              </label>
              <button type="submit">{t("btnScheduleMeeting")}</button>
            </form>
          </div>
        </details>
      </div>

      <div style={{ marginTop: "32px", borderTop: "1px solid var(--line)", paddingTop: "32px" }}>
        <details>
          <summary className="nr-hide-marker" style={{ cursor: "pointer", fontWeight: 600, color: "var(--accent)" }}>
            <span className="nr-section-header" style={{ borderTop: "none", display: "inline-block", padding: 0, margin: 0 }}>{t("importInviteTitle")}</span>
          </summary>
          <div style={{ marginTop: "24px" }}>
            <form action={importMeetingInviteAction} className="stack panel">
              <input type="hidden" name="workspaceId" value={workspaceId} />
              <label>
                {t("formInviteFile")}
                <input name="invite" type="file" accept=".ics,text/calendar" required />
              </label>
              <button type="submit">{t("btnImportInvite")}</button>
            </form>
          </div>
        </details>
      </div>

      <div style={{ marginTop: "32px", borderTop: "1px solid var(--line)", paddingTop: "32px" }}>
        <details>
          <summary className="nr-hide-marker" style={{ cursor: "pointer", fontWeight: 600, color: "var(--accent)" }}>
            <span className="nr-section-header" style={{ borderTop: "none", display: "inline-block", padding: 0, margin: 0 }}>{t("newMeetingTitle")}</span>
          </summary>
          <div style={{ marginTop: "24px" }}>
            <MeetingTranscriptUploadForm
              workspaceId={workspaceId}
              showTitle
              showSource
              showRecordedAt
              requireRecordedAt
              showTimeZone
              showParticipants
              labels={{
                title: t("formTitle"),
                source: t("formSource"),
                recordedAt: t("formRecordedAt"),
                participantEmails: t("formParticipantEmails"),
                participantEmailsPlaceholder: t("formParticipantEmailsPlaceholder"),
                file: t("formTranscriptFile"),
                transcript: t("formTranscript"),
                ingestionGuidance: t("formIngestionGuidance"),
                ingestionGuidanceHelp: t("helpIngestionGuidance"),
                submit: t("btnUploadTranscript"),
                retrySubmit: t("btnUploadTranscript"),
                chooseMeeting: t("chooseTranscriptMeeting"),
                createNewMeeting: t("createNewTranscriptMeeting"),
                retryUpload: t("retryTranscriptUpload"),
              }}
            />
          </div>
        </details>
      </div>
    </>
  );
}
