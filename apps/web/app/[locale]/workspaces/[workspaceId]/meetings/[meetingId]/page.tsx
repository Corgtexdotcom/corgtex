import { getMeeting, getMeetingParticipants } from "@corgtex/domain";
import { requirePageActor } from "@/lib/auth";
import { getFormatter, getTranslations } from "next-intl/server";
import Link from "next/link";
import { renderMarkdown } from "@/lib/markdown";
import { DeliberationThread } from "@/lib/components/DeliberationThread";
import { DeliberationComposer } from "@/lib/components/DeliberationComposer";
import { getDeliberationTargets } from "@/lib/deliberation-targets";
import { listDeliberationEntries } from "@corgtex/domain";
import { postMeetingDeliberationAction, resolveMeetingDeliberationAction } from "../actions";

export const dynamic = "force-dynamic";


export default async function MeetingDetailPage({
  params,
}: {
  params: Promise<{ workspaceId: string; meetingId: string }>;
}) {
  const { workspaceId, meetingId } = await params;
  const actor = await requirePageActor();
  const t = await getTranslations("meetings");
  const format = await getFormatter();

  const meeting = await getMeeting(workspaceId, meetingId);
  const meetingEntries = await listDeliberationEntries(actor, { workspaceId, parentType: "MEETING", parentId: meetingId });
  const deliberationTargets = await getDeliberationTargets({ actor, workspaceId });
  const targetOptions = deliberationTargets.options.map((option) => ({
    ...option,
    label: option.value.startsWith("circle:")
      ? t("targetCircle", { name: option.label.replace(/^Circle: /, "") })
      : option.value.startsWith("member:")
        ? t("targetPerson", { name: option.label.replace(/^Person: /, "") })
        : option.label,
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

  if (!meeting) {
    return (
      <div className="ws-page-header">
        <h1>{t("meetingNotFound")}</h1>
        <Link href={`/workspaces/${workspaceId}/meetings`} className="nr-meta" style={{ textDecoration: "underline" }}>
          {t("backToMeetings")}
        </Link>
      </div>
    );
  }
  
  const participants = meeting.participantIds?.length > 0 
    ? await getMeetingParticipants(workspaceId, meeting.participantIds)
    : [];

  return (
    <>
      <div style={{ marginBottom: "32px" }}>
        <Link href={`/workspaces/${workspaceId}/meetings`} className="nr-meta" style={{ textDecoration: "none" }}>
          {t("backToBoardMeetings")}
        </Link>
      </div>

      <header className="nr-masthead" style={{ textAlign: "left", marginBottom: 32 }}>
        <div className="nr-meta" style={{ marginBottom: "8px" }}>{meeting.source}</div>
        <h1 style={{ border: "none", padding: 0, margin: 0, fontSize: "2.5rem" }}>
          {meeting.title || t("untitledMeeting")}
        </h1>
        <div className="nr-masthead-meta">
          <span>{format.dateTime(meeting.recordedAt, { dateStyle: "medium", timeStyle: "short" })}</span>
        </div>
      </header>
      
      {participants.length > 0 && (
        <section className="ws-section" style={{ marginBottom: 48 }}>
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

      {meeting.summaryMd && (
        <section className="ws-section" style={{ marginBottom: 48 }}>
          <h2 className="nr-section-header">{t("summary")}</h2>
          <div 
            className="nr-excerpt" 
            style={{ fontSize: "1rem", lineHeight: 1.6 }}
            dangerouslySetInnerHTML={{ __html: renderMarkdown(meeting.summaryMd) }}
          />
        </section>
      )}

      {meeting.tensions.length > 0 && (
        <section className="ws-section" style={{ marginBottom: 48 }}>
          <h2 className="nr-section-header">{t("tensionsRaised")}</h2>
          <div className="list">
            {meeting.tensions.map(tension => (
              <div className="item" key={tension.id}>
                <div className="row">
                  <strong>{tension.title}</strong>
                  <span className={`tag ${tension.status === "DRAFT" ? "info" : tension.status === "OPEN" ? "warning" : "success"}`}>
                    {tension.status}
                  </span>
                </div>
                <div className="muted">{tension.bodyMd}</div>
                <div className="muted" style={{ fontSize: "0.82rem", marginTop: 8 }}>
                  {tension.author?.displayName || tension.author?.email}
                </div>
              </div>
            ))}
          </div>
        </section>
      )}

      {meeting.proposals.length > 0 && (
        <section className="ws-section" style={{ marginBottom: 48 }}>
          <h2 className="nr-section-header">{t("proposalsCreated")}</h2>
          <div className="list">
            {meeting.proposals.map(proposal => (
              <div className="item" key={proposal.id}>
                <div className="row">
                  <strong>{proposal.title}</strong>
                  <span className={`tag ${proposal.status === "DRAFT" ? "info" : proposal.status === "OPEN" ? "warning" : proposal.resolutionOutcome === "ADOPTED" ? "success" : proposal.status === "RESOLVED" ? "info" : ""}`}>
                    {proposal.status === "RESOLVED" && proposal.resolutionOutcome ? `${proposal.status} · ${proposal.resolutionOutcome.replace("_", " ")}` : proposal.status}
                  </span>
                </div>
                <div className="muted">{proposal.summary ?? proposal.bodyMd.slice(0, 150) + "..."}</div>
                
                <div className="muted" style={{ fontSize: "0.82rem", marginTop: 8 }}>
                   {proposal.author?.displayName || proposal.author?.email} · {format.dateTime(proposal.createdAt, { dateStyle: "medium" })}
                </div>

                {(proposal.tensions?.length > 0 || proposal.actions?.length > 0) && (
                  <div style={{ marginTop: 8, fontSize: "0.82rem", display: "flex", gap: "8px", flexWrap: "wrap" }}>
                    {proposal.tensions?.map((linkedTension: any) => (
                      <span key={linkedTension.id} className="tag info" style={{ padding: "2px 6px", fontSize: "0.75rem" }}>
                        {t("tensionTag", { title: linkedTension.title })}
                      </span>
                    ))}
                    {proposal.actions?.map((a: any) => (
                      <span key={a.id} className="tag info" style={{ padding: "2px 6px", fontSize: "0.75rem" }}>
                        {t("actionTag", { title: a.title })}
                      </span>
                    ))}
                  </div>
                )}
              </div>
            ))}
          </div>
        </section>
      )}

      {meeting.transcript && (
        <section className="ws-section" style={{ marginBottom: 48 }}>
          <details>
            <summary style={{ cursor: "pointer", fontWeight: 600, color: "var(--accent)" }}>
              <span className="nr-section-header" style={{ borderTop: "none", display: "inline-block", padding: 0, margin: 0 }}>{t("btnViewTranscript")}</span>
            </summary>
            <div style={{ marginTop: "24px", whiteSpace: "pre-wrap", fontSize: "0.9rem", color: "var(--text)" }}>
              {meeting.transcript}
            </div>
          </details>
        </section>
      )}

      <section className="ws-section" style={{ marginBottom: 48 }}>
        <h2 className="nr-section-header">{t("discussion")}</h2>
        <DeliberationThread entries={mappedEntries} canResolve={true} resolveAction={resolveMeetingDeliberationAction} hiddenFields={{ workspaceId, parentId: meetingId }} />
        <div style={{ marginTop: 24 }}>
          <DeliberationComposer 
            postAction={postMeetingDeliberationAction} 
            hiddenFields={{ workspaceId, parentId: meetingId }}
            targetOptions={targetOptions}
            defaultTargetValue={deliberationTargets.defaultValue}
            entryTypes={[
              { value: "REACTION", label: t("entryReaction"), variant: "secondary" },
              { value: "OBJECTION", label: t("entryObjection"), variant: "danger" },
            ]}
          />
        </div>
      </section>
    </>
  );
}
