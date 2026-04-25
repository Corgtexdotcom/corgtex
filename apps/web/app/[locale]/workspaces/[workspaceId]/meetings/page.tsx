import { listMeetings } from "@corgtex/domain";
import { requirePageActor } from "@/lib/auth";
import { archiveMeetingAction, createMeetingAction } from "../actions";
import { getTranslations } from "next-intl/server";
import Link from "next/link";

export const dynamic = "force-dynamic";



export default async function MeetingsPage({
  params,
}: {
  params: Promise<{ workspaceId: string }>;
}) {
  const { workspaceId } = await params;
  await requirePageActor();
  const meetings = await listMeetings(workspaceId);
  const t = await getTranslations("meetings");

  return (
    <>
      <header className="nr-masthead" style={{ textAlign: "left", marginBottom: 32 }}>
        <h1 style={{ border: "none", padding: 0, margin: 0, fontSize: "2.5rem" }}>{t("pageTitle")}</h1>
        <div className="nr-masthead-meta">
          <span>{t("meetingsRecorded", { count: meetings.length })}</span>
        </div>
      </header>

      <section className="ws-section">
        {meetings.length === 0 && <p className="nr-meta">{t("noMeetings")}</p>}
        {meetings.length > 0 && (
          <div style={{ display: "flex", flexDirection: "column", gap: "16px" }}>
            {/* Featured latest meeting */}
            <div style={{ borderBottom: "1px solid var(--line)", paddingBottom: "24px", marginBottom: "8px" }}>
              <Link href={`/workspaces/${workspaceId}/meetings/${meetings[0].id}`} style={{ textDecoration: "none", color: "inherit", display: "block" }}>
                <div className="nr-meta" style={{ marginBottom: "8px" }}>{meetings[0].source}</div>
                <h2 className="nr-lead-headline" style={{ fontSize: "1.8rem" }}>{meetings[0].title ?? t("untitledMeeting")}</h2>
                <div className="nr-item-meta" style={{ marginBottom: "12px" }}>{new Date(meetings[0].recordedAt).toLocaleString()}</div>
                {meetings[0].summaryMd && <p className="nr-excerpt">{meetings[0].summaryMd}</p>}
              </Link>
              <form action={archiveMeetingAction} style={{ marginTop: 12 }}>
                <input type="hidden" name="workspaceId" value={workspaceId} />
                <input type="hidden" name="meetingId" value={meetings[0].id} />
                <button type="submit" className="danger small">{t("btnArchiveMeeting")}</button>
              </form>
            </div>

            {/* Other meetings list */}
            {meetings.slice(1).map((meeting) => (
              <div className="nr-item" key={meeting.id}>
                <Link href={`/workspaces/${workspaceId}/meetings/${meeting.id}`} style={{ textDecoration: "none", color: "inherit" }}>
                  <div className="nr-item-title">{meeting.title ?? t("untitledMeeting")}</div>
                  <div className="nr-item-meta">
                    {new Date(meeting.recordedAt).toLocaleString()} • {meeting.source}
                  </div>
                  {meeting.summaryMd && (
                    <div className="nr-excerpt" style={{ fontSize: "0.85rem", marginTop: "6px" }}>
                      {meeting.summaryMd}
                    </div>
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

      <div style={{ marginTop: "48px", borderTop: "2px solid var(--line)", paddingTop: "32px" }}>
        <details>
          <summary className="nr-hide-marker" style={{ cursor: "pointer", fontWeight: 600, color: "var(--accent)" }}>
            <span className="nr-section-header" style={{ borderTop: "none", display: "inline-block", padding: 0, margin: 0 }}>{t("newMeetingTitle")}</span>
          </summary>
          <div style={{ marginTop: "24px" }}>
            <form action={createMeetingAction} className="stack panel">
              <input type="hidden" name="workspaceId" value={workspaceId} />
              <label>
                {t("formTitle")}
                <input name="title" />
              </label>
              <div className="actions-inline">
                <label style={{ flex: 1 }}>
                  {t("formSource")}
                  <input name="source" defaultValue="manual" required />
                </label>
                <label style={{ flex: 1 }}>
                  {t("formRecordedAt")}
                  <input name="recordedAt" type="datetime-local" required />
                </label>
              </div>
              <label>
                {t("formParticipantIds")}
                <input name="participantIds" placeholder={t("formParticipantIdsPlaceholder")} />
              </label>
              <label>
                {t("formSummary")}
                <textarea name="summaryMd" />
              </label>
              <label>
                {t("formTranscript")}
                <textarea name="transcript" />
              </label>
              <button type="submit">{t("btnIngest")}</button>
            </form>
          </div>
        </details>
      </div>
    </>
  );
}
