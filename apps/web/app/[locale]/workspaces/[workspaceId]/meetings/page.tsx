import { listMeetings } from "@corgtex/domain";
import { requirePageActor } from "@/lib/auth";
import { createMeetingAction } from "../actions";
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
        {meetings.length === 0 && <p className="nr-meta">No meetings ingested yet.</p>}
        {meetings.length > 0 && (
          <div style={{ display: "flex", flexDirection: "column", gap: "16px" }}>
            {/* Featured latest meeting */}
            <Link href={`/workspaces/${workspaceId}/meetings/${meetings[0].id}`} style={{ textDecoration: "none", color: "inherit", display: "block" }}>
              <div style={{ borderBottom: "1px solid var(--line)", paddingBottom: "24px", marginBottom: "8px" }}>
                <div className="nr-meta" style={{ marginBottom: "8px" }}>{meetings[0].source}</div>
                <h2 className="nr-lead-headline" style={{ fontSize: "1.8rem" }}>{meetings[0].title ?? "Untitled meeting"}</h2>
                <div className="nr-item-meta" style={{ marginBottom: "12px" }}>{new Date(meetings[0].recordedAt).toLocaleString()}</div>
                {meetings[0].summaryMd && (
                  <p className="nr-excerpt">{meetings[0].summaryMd}</p>
                )}
              </div>
            </Link>

            {/* Other meetings list */}
            {meetings.slice(1).map((meeting) => (
              <Link href={`/workspaces/${workspaceId}/meetings/${meeting.id}`} key={meeting.id} style={{ textDecoration: "none", color: "inherit" }}>
                <div className="nr-item">
                  <div className="nr-item-title">{meeting.title ?? "Untitled meeting"}</div>
                  <div className="nr-item-meta">
                    {new Date(meeting.recordedAt).toLocaleString()} • {meeting.source}
                  </div>
                  {meeting.summaryMd && (
                    <div className="nr-excerpt" style={{ fontSize: "0.85rem", marginTop: "6px" }}>
                      {meeting.summaryMd}
                    </div>
                  )}
                </div>
              </Link>
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
                Title
                <input name="title" />
              </label>
              <div className="actions-inline">
                <label style={{ flex: 1 }}>
                  Source
                  <input name="source" defaultValue="manual" required />
                </label>
                <label style={{ flex: 1 }}>
                  Recorded at
                  <input name="recordedAt" type="datetime-local" required />
                </label>
              </div>
              <label>
                Participant IDs
                <input name="participantIds" placeholder={t("formParticipantIdsPlaceholder")} />
              </label>
              <label>
                Summary
                <textarea name="summaryMd" />
              </label>
              <label>
                Transcript
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
