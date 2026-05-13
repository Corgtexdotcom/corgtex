import { getMeetingRecorderConfig, listMeetingRecordings, listMeetings } from "@corgtex/domain";
import { requirePageActor } from "@/lib/auth";
import {
  archiveMeetingAction,
  cancelMeetingRecordingAction,
  createMeetingSeriesAction,
  importMeetingInviteAction,
  scheduleManualMeetingRecordingAction,
  scheduleMeetingRecordingAction,
  uploadMeetingTranscriptAction,
} from "../actions";
import { getTranslations } from "next-intl/server";
import Link from "next/link";
import { getWorkspaceFeatureFlags } from "@/lib/workspace-feature-flags";
import { MarkdownEditor } from "@/lib/components/MarkdownEditor";
import { MarkdownExcerpt } from "@/lib/components/MarkdownRenderer";

export const dynamic = "force-dynamic";

function dateTimeLocalValue(value: Date | string) {
  return new Date(value).toISOString().slice(0, 16);
}

export default async function MeetingsPage({
  params,
}: {
  params: Promise<{ workspaceId: string }>;
}) {
  const { workspaceId } = await params;
  const actor = await requirePageActor();
  const [completedMeetings, upcomingMeetings, featureFlags, recorderConfig] = await Promise.all([
    listMeetings(workspaceId, { status: "COMPLETED" }),
    listMeetings(workspaceId, { status: "SCHEDULED" }),
    getWorkspaceFeatureFlags(workspaceId),
    getMeetingRecorderConfig(actor, workspaceId).catch(() => null),
  ]);
  const recorderEnabled = Boolean(featureFlags.MEETING_RECORDERS && recorderConfig?.featureEnabled && recorderConfig.config.enabled);
  const recordings = recorderEnabled
    ? await listMeetingRecordings(workspaceId, upcomingMeetings.map((meeting) => meeting.id))
    : [];
  const latestRecordingByMeeting = new Map(recordings.map((recording) => [recording.meetingId, recording]));
  const t = await getTranslations("meetings");

  return (
    <>
      <header className="nr-masthead" style={{ textAlign: "left", marginBottom: 32 }}>
        <h1 style={{ border: "none", padding: 0, margin: 0, fontSize: "2rem" }}>{t("pageTitle")}</h1>
        <div className="nr-masthead-meta">
          <span>{t("meetingsRecorded", { count: completedMeetings.length })}</span>
          <span>{t("meetingsScheduled", { count: upcomingMeetings.length })}</span>
        </div>
      </header>

      {/* ── OUTPUT SECTIONS (primary content) ────────────────────── */}

      {recorderEnabled && (
        <section className="ws-section" style={{ marginBottom: 48 }}>
          <details open>
            <summary className="nr-hide-marker" style={{ cursor: "pointer", fontWeight: 600, color: "var(--accent)" }}>
              <span className="nr-section-header" style={{ borderTop: "none", display: "inline-block", padding: 0, margin: 0 }}>{t("manualRecorderTitle")}</span>
            </summary>
            <form action={scheduleManualMeetingRecordingAction} className="stack panel" style={{ marginTop: 16 }}>
              <input type="hidden" name="workspaceId" value={workspaceId} />
              <label>
                {t("formTitle")}
                <input name="title" required />
              </label>
              <label>
                {t("formMeetingUrl")}
                <input name="meetingUrl" type="url" placeholder="https://teams.microsoft.com/l/meetup-join/..." required />
              </label>
              <div className="actions-inline">
                <label style={{ flex: 1 }}>
                  {t("formJoinAt")}
                  <input name="joinAt" type="datetime-local" required />
                </label>
                <label style={{ flex: 1 }}>
                  {t("formScheduledEndAt")}
                  <input name="scheduledEndAt" type="datetime-local" />
                </label>
              </div>
              <input name="joinAtTimezoneOffsetMinutes" type="hidden" value="0" />
              <input name="scheduledEndAtTimezoneOffsetMinutes" type="hidden" value="0" />
              <script
                dangerouslySetInnerHTML={{
                  __html: "(() => { const script = document.currentScript; const form = script?.closest('form'); const pairs = [[form?.querySelector('input[name=\"joinAt\"]'), form?.querySelector('input[name=\"joinAtTimezoneOffsetMinutes\"]')], [form?.querySelector('input[name=\"scheduledEndAt\"]'), form?.querySelector('input[name=\"scheduledEndAtTimezoneOffsetMinutes\"]')]]; const sync = (input, offset) => { if (!(input instanceof HTMLInputElement) || !(offset instanceof HTMLInputElement)) return; offset.value = input.value ? String(new Date(input.value).getTimezoneOffset()) : String(new Date().getTimezoneOffset()); }; for (const [input, offset] of pairs) { if (!(input instanceof HTMLInputElement) || !(offset instanceof HTMLInputElement)) continue; const update = () => sync(input, offset); input.addEventListener('input', update); input.addEventListener('change', update); update(); } })();",
                }}
              />
              <label>
                {t("formParticipantEmails")}
                <input name="participantEmails" placeholder={t("formParticipantEmailsPlaceholder")} />
              </label>
              <button type="submit">{t("btnRecordMeeting")}</button>
            </form>
          </details>
        </section>
      )}

      <section className="ws-section" style={{ marginBottom: 48 }}>
        <h2 className="nr-section-header">{t("completedMeetings")}</h2>
        {completedMeetings.length === 0 && <p className="nr-meta">{t("noMeetings")}</p>}
        {completedMeetings.length > 0 && (
          <div style={{ display: "flex", flexDirection: "column", gap: "16px" }}>
            {/* Featured latest meeting */}
            <div style={{ borderBottom: "1px solid var(--line)", paddingBottom: "24px", marginBottom: "8px" }}>
              <Link href={`/workspaces/${workspaceId}/meetings/${completedMeetings[0].id}`} style={{ textDecoration: "none", color: "inherit", display: "block" }}>
                <div className="nr-meta" style={{ marginBottom: "8px" }}>{completedMeetings[0].source}</div>
                <h2 className="nr-lead-headline" style={{ fontSize: "1.8rem" }}>{completedMeetings[0].title ?? t("untitledMeeting")}</h2>
                <div className="nr-item-meta" style={{ marginBottom: "12px" }}>{new Date(completedMeetings[0].recordedAt).toLocaleString()}</div>
                {completedMeetings[0].summaryMd && <MarkdownExcerpt markdown={completedMeetings[0].summaryMd} maxLength={520} as="p" className="nr-excerpt" />}
              </Link>
              <form action={archiveMeetingAction} style={{ marginTop: 12 }}>
                <input type="hidden" name="workspaceId" value={workspaceId} />
                <input type="hidden" name="meetingId" value={completedMeetings[0].id} />
                <button type="submit" className="danger small">{t("btnArchiveMeeting")}</button>
              </form>
            </div>

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
                <form action={archiveMeetingAction} style={{ marginTop: 8 }}>
                  <input type="hidden" name="workspaceId" value={workspaceId} />
                  <input type="hidden" name="meetingId" value={meeting.id} />
                  <button type="submit" className="danger small">{t("btnArchive")}</button>
                </form>
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
                {(() => {
                  const recording = latestRecordingByMeeting.get(meeting.id);
                  return recorderEnabled ? (
                    <div className="row" style={{ alignItems: "flex-start", gap: 12, marginBottom: 8 }}>
                      <div>
                        <span className="tag">{recording ? `Recorder ${recording.status}` : meeting.meetingUrl ? "Recorder ready" : "No meeting link"}</span>
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
                      {recording && ["PENDING", "SCHEDULED", "JOINING", "RECORDING"].includes(recording.status) ? (
                        <form action={cancelMeetingRecordingAction}>
                          <input type="hidden" name="workspaceId" value={workspaceId} />
                          <input type="hidden" name="meetingId" value={meeting.id} />
                          <button type="submit" className="secondary small">Cancel recorder</button>
                        </form>
                      ) : meeting.meetingUrl ? (
                        <form action={scheduleMeetingRecordingAction}>
                          <input type="hidden" name="workspaceId" value={workspaceId} />
                          <input type="hidden" name="meetingId" value={meeting.id} />
                          <button type="submit" className="secondary small">Record with Corgtex</button>
                        </form>
                      ) : null}
                    </div>
                  ) : null;
                })()}
                <Link href={`/workspaces/${workspaceId}/meetings/${meeting.id}`} style={{ textDecoration: "none", color: "inherit" }}>
                  <div className="nr-item-title">{meeting.title ?? t("untitledMeeting")}</div>
                  <div className="nr-item-meta">
                    {new Date(meeting.recordedAt).toLocaleString()} • {meeting.source}
                    {meeting.agendaPostedAt ? ` • ${t("agendaPosted")}` : ""}
                  </div>
                </Link>
                <details style={{ marginTop: 12 }}>
                  <summary className="nr-hide-marker" style={{ cursor: "pointer", color: "var(--accent)", fontWeight: 600 }}>
                    {t("uploadTranscriptForMeeting")}
                  </summary>
                  <form action={uploadMeetingTranscriptAction} className="stack" style={{ marginTop: 12 }}>
                    <input type="hidden" name="workspaceId" value={workspaceId} />
                    <input type="hidden" name="meetingId" value={meeting.id} />
                    <input type="hidden" name="title" value={meeting.title ?? ""} />
                    <input type="hidden" name="recordedAt" value={dateTimeLocalValue(meeting.recordedAt)} />
                    <label>
                      {t("formTranscriptFile")}
                      <input name="file" type="file" accept=".txt,.md,.csv,.json,.pdf,.docx" />
                    </label>
                    <label>
                      {t("formTranscript")}
                      <textarea name="transcript" />
                    </label>
                    <label>
                      {t("formIngestionGuidance")}
                      <MarkdownEditor name="ingestionGuidanceMd" rows={3} />
                      <span className="nr-item-meta" style={{ display: "block", marginTop: 4 }}>{t("helpIngestionGuidance")}</span>
                    </label>
                    <button type="submit">{t("btnUploadTranscript")}</button>
                  </form>
                </details>
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
                  {t("formScheduledEndAt")}
                  <input name="scheduledEndAt" type="datetime-local" />
                </label>
              </div>
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
            <form action={uploadMeetingTranscriptAction} className="stack panel">
              <input type="hidden" name="workspaceId" value={workspaceId} />
              <label>
                {t("formTitle")}
                <input name="title" />
              </label>
              <div className="actions-inline">
                <label style={{ flex: 1 }}>
                  {t("formSource")}
                  <input name="source" defaultValue="transcript-upload" required />
                </label>
                <label style={{ flex: 1 }}>
                  {t("formRecordedAt")}
                  <input name="recordedAt" type="datetime-local" required />
                </label>
              </div>
              <label>
                {t("formParticipantEmails")}
                <input name="participantEmails" placeholder={t("formParticipantEmailsPlaceholder")} />
              </label>
              <label>
                {t("formIngestionGuidance")}
                <MarkdownEditor name="ingestionGuidanceMd" rows={3} />
                <span className="nr-item-meta" style={{ display: "block", marginTop: 4 }}>{t("helpIngestionGuidance")}</span>
              </label>
              <label>
                {t("formTranscriptFile")}
                <input name="file" type="file" accept=".txt,.md,.csv,.json,.pdf,.docx" />
              </label>
              <label>
                {t("formTranscript")}
                <textarea name="transcript" />
              </label>
              <button type="submit">{t("btnUploadTranscript")}</button>
            </form>
          </div>
        </details>
      </div>
    </>
  );
}
