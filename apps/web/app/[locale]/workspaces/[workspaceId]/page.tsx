import {
  listActions, listMembers, listNotifications, listTensions,
  listAuditLogs, listArticles, listMeetings
} from "@corgtex/domain";
import { prisma, workspaceBranding } from "@corgtex/shared";
import { requirePageActor } from "@/lib/auth";
import {
  decideApprovalAction,
  markAllNotificationsReadAction,
} from "./actions";
import Link from "next/link";
import { GoalProgress } from "./goals/GoalProgress";
import { RecognitionCard } from "./goals/RecognitionCard";
import { getTranslations, getFormatter } from "next-intl/server";

export const dynamic = "force-dynamic";

function resolveEntityUrl(
  workspaceId: string,
  entityType: string | null,
  entityId: string | null
): string | null {
  if (!entityType || !entityId) return null;
  const t = entityType.toLowerCase();
  if (t === "proposal") return `/workspaces/${workspaceId}/proposals`;
  if (t === "tension") return `/workspaces/${workspaceId}/tensions`;
  if (t === "action") return `/workspaces/${workspaceId}/actions`;
  if (t === "meeting") return `/workspaces/${workspaceId}/meetings`;
  if (t === "adviceprocess") return `/workspaces/${workspaceId}/proposals?status=ADVICE_GATHERING`;
  if (t === "advicerecord") return `/workspaces/${workspaceId}/proposals?status=ADVICE_GATHERING`;
  if (t === "spend" || t === "spendrequest") return `/workspaces/${workspaceId}/finance`;
  return null;
}

export default async function WorkspaceDashboard({
  params,
}: {
  params: Promise<{ workspaceId: string }>;
}) {
  const { workspaceId } = await params;
  const actor = await requirePageActor();
  const t = await getTranslations("dashboard");
  const format = await getFormatter();

  const [
    { items: tensions },
    members,
    notifications,
    pendingFlows,
    openActionsResult,
    activeTensionsResult,
    pendingAgentApprovals,
    auditLogs,
    articlesResult,
    meetings,
    chunksCount,
    workspaceData,
    recentPublishedBase,
    activeAdviceProcesses,
    strategicGoals,
    recentRecognition
  ] = await Promise.all([
    listTensions(actor, workspaceId, { take: 10 }),
    listMembers(workspaceId),
    listNotifications(actor, workspaceId, { take: 5 }),
    prisma.approvalFlow.findMany({
      where: { workspaceId, status: "ACTIVE" },
      include: { decisions: true },
      orderBy: { createdAt: "desc" },
      take: 5,
    }),
    listActions(actor, workspaceId, { take: 10 }),
    prisma.tension.count({ where: { workspaceId, status: { in: ["OPEN", "IN_PROGRESS"] }, OR: [{ isPrivate: false }, { authorUserId: actor.kind === 'user' ? actor.user.id : '' }] } }),
    prisma.agentRun.count({ where: { workspaceId, status: "WAITING_APPROVAL" } }),
    listAuditLogs(actor, workspaceId, { take: 10 }),
    listArticles(actor, { workspaceId, take: 50 }),
    listMeetings(workspaceId),
    prisma.knowledgeChunk.count({ where: { workspaceId } }),
    prisma.workspace.findUnique({ where: { id: workspaceId }, select: { slug: true, name: true } }),
    Promise.all([
      prisma.action.findMany({ where: { workspaceId, isPrivate: false, publishedAt: { not: null } }, select: { id: true, title: true, publishedAt: true, author: { select: { displayName: true } } }, orderBy: { publishedAt: "desc" }, take: 10 }),
      prisma.tension.findMany({ where: { workspaceId, isPrivate: false, publishedAt: { not: null } }, select: { id: true, title: true, publishedAt: true, author: { select: { displayName: true } } }, orderBy: { publishedAt: "desc" }, take: 10 }),
      prisma.proposal.findMany({ where: { workspaceId, isPrivate: false, publishedAt: { not: null } }, select: { id: true, title: true, publishedAt: true, author: { select: { displayName: true } } }, orderBy: { publishedAt: "desc" }, take: 10 }),
      prisma.brainArticle.findMany({ where: { workspaceId, isPrivate: false, publishedAt: { not: null } }, select: { id: true, slug: true, title: true, publishedAt: true, ownerMember: { select: { user: { select: { displayName: true } } } } }, orderBy: { publishedAt: "desc" }, take: 10 }),
    ]),
    prisma.adviceProcess.findMany({
      where: { workspaceId, status: { in: ["GATHERING", "READY"] } },
      include: { proposal: { select: { id: true, title: true } } },
      orderBy: { createdAt: "desc" },
    }),
    prisma.goal.findMany({
      where: { workspaceId, level: "COMPANY", status: { notIn: ["DRAFT", "ABANDONED"] } },
      orderBy: [{ sortOrder: "asc" }, { createdAt: "desc" }],
      take: 4,
    }),
    prisma.recognition.findFirst({
      where: { workspaceId },
      include: { author: { include: { user: true } }, recipient: { include: { user: true } } },
      orderBy: { createdAt: "desc" },
    })
  ]);

  const branding = workspaceData ? workspaceBranding(workspaceData) : { primaryName: "Corgtex", secondaryLabel: "powered by Corgtex" };

  // Filter advice processes where there is a suggestion for the current user
  let advisoryRequests: any[] = [];
  const currentMember = actor.kind === 'user' ? members.find(m => m.userId === actor.user.id) : undefined;
  const currentMemberUrl = currentMember?.id;
  if (currentMemberUrl) {
    advisoryRequests = activeAdviceProcesses.filter(ap => {
      if (!ap.advisorySuggestionsJson || !Array.isArray((ap.advisorySuggestionsJson as any).advisors)) return false;
      return (ap.advisorySuggestionsJson as any).advisors.some((a: any) => a.memberId === currentMemberUrl);
    });
  }

  const recentMeetings = meetings
    .filter(m => actor.kind === 'user' ? m.participantIds?.includes(actor.user.id) : true)
    .slice(0, 5);
  const unreadNotifications = notifications.filter(n => !n.readAt);
  const openActions = openActionsResult.items.filter(a => a.status === "OPEN" || a.status === "IN_PROGRESS");
  
  const totalAttentionItems = pendingFlows.length + pendingAgentApprovals + unreadNotifications.length + advisoryRequests.length;

  const ageText = (date: Date) => format.relativeTime(date);

  const d = new Date();
  const dateString = format.dateTime(d, { weekday: 'long', year: 'numeric', month: 'long', day: 'numeric' });

  // Separate latest authoritative articles
  const allArticles = articlesResult.items;
  const featuredArticle = allArticles.find(a => a.authority === "AUTHORITATIVE") || allArticles[0];
  const otherRecentArticles = allArticles.filter(a => a.id !== featuredArticle?.id).slice(0, 3);

  // Group by category for below the fold
  const articlesByCategory = allArticles.reduce((acc, a) => {
    acc[a.type] = acc[a.type] || [];
    acc[a.type].push(a);
    return acc;
  }, {} as Record<string, typeof allArticles>);

  const sortedCategories = Object.entries(articlesByCategory)
    .sort((a, b) => b[1].length - a[1].length)
    .slice(0, 8); // top 8 categories

  const recentlyPublished = [
    ...recentPublishedBase[0].map(i => ({ ...i, kind: "Action", link: `/workspaces/${workspaceId}/actions` })),
    ...recentPublishedBase[1].map(i => ({ ...i, kind: "Tension", link: `/workspaces/${workspaceId}/tensions` })),
    ...recentPublishedBase[2].map(i => ({ ...i, kind: "Proposal", link: `/workspaces/${workspaceId}/proposals` })),
    ...recentPublishedBase[3].map(i => ({ ...i, kind: "Brain Article", link: `/workspaces/${workspaceId}/brain/${i.slug}`, author: i.ownerMember?.user })),
  ]
    .sort((a, b) => b.publishedAt!.getTime() - a.publishedAt!.getTime())
    .slice(0, 10);

  return (
    <>
      <header className="nr-masthead">
        <h1>{branding.primaryName}</h1>
        <div className="nr-masthead-meta">
          <span suppressHydrationWarning>{dateString}</span>
          <form action={`/workspaces/${workspaceId}/brain`} method="GET" style={{ display: "flex", gap: "8px", alignItems: "center", marginLeft: "16px" }}>
            <span style={{ fontSize: "0.75rem", color: "var(--muted)", textTransform: "none" }}>{t("searchLabel")}</span>
            <input 
              name="q"
              type="text" 
              placeholder={t("searchPlaceholder")} 
              style={{ padding: "4px 8px", fontSize: "0.85rem", border: "1px solid var(--line)", borderRadius: "4px" }}
            />
          </form>
        </div>
      </header>

      {totalAttentionItems > 0 && (
        <div className="nr-attention">
          <div style={{ paddingRight: "16px", minWidth: "180px", fontWeight: 600, color: "var(--warning)" }}>
            {t("itemsNeedAttention", { count: totalAttentionItems })}
          </div>
          
          <div style={{ display: "flex", flex: 1, gap: "16px", flexWrap: "wrap" }}>
            {pendingFlows.length > 0 && (
              <div className="nr-attention-block">
                <strong>{t("approvalsPending", { count: pendingFlows.length })}</strong>
                {pendingFlows.slice(0, 2).map((flow) => (
                  <div key={flow.id} style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 4 }}>
                    {(() => {
                      const href = resolveEntityUrl(workspaceId, flow.subjectType, flow.subjectId);
                      return href ? (
                        <Link href={href} style={{ fontSize: "0.8rem", color: "inherit", textDecoration: "underline dotted" }}>
                          {flow.subjectType}
                        </Link>
                      ) : (
                        <span style={{ fontSize: "0.8rem" }}>{flow.subjectType}</span>
                      );
                    })()}
                    <form action={decideApprovalAction} className="actions-inline" style={{ display: "inline-flex" }}>
                      <input type="hidden" name="workspaceId" value={workspaceId} />
                      <input type="hidden" name="flowId" value={flow.id} />
                      <button type="submit" name="choice" value={flow.mode === "CONSENT" ? "AGREE" : "APPROVE"} style={{ padding: "2px 6px", fontSize: "0.7rem", minHeight: 0 }}>{t("approve")}</button>
                    </form>
                  </div>
                ))}
              </div>
            )}
            
            {pendingAgentApprovals > 0 && (
              <div className="nr-attention-block">
                <strong>{t("agentRuns")}</strong>
                <span style={{ fontSize: "0.8rem" }}>{t("runsWaitingReview", { count: pendingAgentApprovals })}</span>
                <Link href={`/workspaces/${workspaceId}/operator`} style={{ display: "block", fontSize: "0.8rem", marginTop: 4, textDecoration: "underline" }}>{t("review")}</Link>
              </div>
            )}

            {unreadNotifications.length > 0 && (
              <div className="nr-attention-block">
                <div style={{ display: "flex", justifyContent: "space-between" }}>
                  <strong>{t("notifications")}</strong>
                  <form action={markAllNotificationsReadAction}>
                    <input type="hidden" name="workspaceId" value={workspaceId} />
                    <button type="submit" style={{ padding: "0 6px", fontSize: "0.7rem", minHeight: 0, background: "transparent", color: "var(--warning)"}}>{t("markRead")}</button>
                  </form>
                </div>
                {unreadNotifications.slice(0, 2).map((n) => {
                  const href = resolveEntityUrl(workspaceId, n.entityType, n.entityId);
                  return (
                    <div key={n.id} style={{ fontSize: "0.8rem", marginBottom: 2 }}>
                      {href ? (
                        <Link href={href} style={{ color: "inherit", textDecoration: "underline dotted" }}>
                          {n.title}
                        </Link>
                      ) : n.title}
                    </div>
                  );
                })}
              </div>
            )}

            {advisoryRequests.length > 0 && (
              <div className="nr-attention-block" style={{ borderLeft: "3px solid var(--info)" }}>
                <strong>{t("advisoryRequests", { count: advisoryRequests.length })}</strong>
                {advisoryRequests.slice(0, 2).map((ap: any) => (
                  <div key={ap.id} style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 4 }}>
                    <Link href={`/workspaces/${workspaceId}/proposals?status=ADVICE_GATHERING`} style={{ fontSize: "0.8rem", textDecoration: "none", color: "inherit" }}>
                      {ap.proposal.title}
                    </Link>
                  </div>
                ))}
                {advisoryRequests.length > 2 && <div style={{ fontSize: "0.7rem", color: "var(--muted)" }}>{t("more", { count: advisoryRequests.length - 2 })}</div>}
              </div>
            )}
          </div>
        </div>
      )}

      {/* HERO SECTION */}
      <section className="nr-hero">
        {/* LEFT COLUMN: FEATURED */}
        <div>
          <h2 className="nr-section-header">{t("featuredKnowledge")}</h2>
          {featuredArticle && (
            <div style={{ marginBottom: "24px" }}>
              <div className="nr-meta">{featuredArticle.type} · {t("updated")} <span suppressHydrationWarning>{ageText(featuredArticle.updatedAt)}</span></div>
              <Link href={`/workspaces/${workspaceId}/brain/${featuredArticle.slug}`} style={{ textDecoration: "none" }}>
                <h3 className="nr-lead-headline">{featuredArticle.title}</h3>
                <p className="nr-excerpt">{featuredArticle.bodyMd.replace(/[#*`_]/g, '').slice(0, 200)}...</p>
                <span className="nr-link">{t("readFullArticle")}</span>
              </Link>
            </div>
          )}
          <div style={{ borderTop: "1px solid var(--line)", paddingTop: "16px" }}>
            {otherRecentArticles.map(a => (
              <div key={a.id} className="nr-item" style={{ borderBottom: "1px solid var(--line)", paddingBottom: "16px", marginBottom: "16px" }}>
                <div className="nr-meta" style={{ marginBottom: "4px" }}>{a.type}</div>
                <Link href={`/workspaces/${workspaceId}/brain/${a.slug}`} style={{ textDecoration: "none" }}>
                  <h4 className="nr-secondary-headline" style={{ fontSize: "1.2rem", marginBottom: "6px" }}>{a.title}</h4>
                  <p className="nr-excerpt" style={{ fontSize: "0.9rem", margin: 0 }}>{a.bodyMd.replace(/[#*]/g, '').slice(0, 120)}...</p>
                </Link>
              </div>
            ))}
          </div>
        </div>

        {/* CENTER COLUMN: MEETINGS */}
        <div>
           <h2 className="nr-section-header">{t("yourMeetings")}</h2>
           {recentMeetings.length === 0 ? <p className="nr-meta">{t("noRecentMeetings")}</p> : null}
           {recentMeetings.map((meeting) => (
             <div key={meeting.id} className="nr-item">
               <div className="nr-item-title">{meeting.title || `${meeting.source} ${t("meeting")}`}</div>
               <div className="nr-item-meta" suppressHydrationWarning>{format.dateTime(new Date(meeting.recordedAt), { month: "short", day: "numeric", year: "numeric" })}</div>
               {meeting.summaryMd && <div style={{ fontSize: "0.85rem", marginTop: "6px", lineHeight: 1.4, color: "var(--text-muted)" }}>{meeting.summaryMd.slice(0, 100)}...</div>}
             </div>
           ))}
           <div style={{ marginTop: "16px" }}>
             <Link href={`/workspaces/${workspaceId}/meetings`} className="nr-link">{t("viewAllTranscripts")}</Link>
           </div>
        </div>

        {/* RIGHT COLUMN: TODOS & TENSIONS */}
        <div>
           <h2 className="nr-section-header" style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
             {t("yourToDos")}
             {currentMemberUrl && (
               <Link href={`/workspaces/${workspaceId}/members/${currentMemberUrl}`} style={{ fontSize: "0.75rem", textTransform: "none", color: "var(--accent)" }}>
                 {t("viewFullProfile")}
               </Link>
             )}
           </h2>
           {openActions.length === 0 ? <p className="nr-meta" style={{ marginBottom: "32px"}}>{t("zeroInbox")}</p> : null}
           <div style={{ marginBottom: "32px"}}>
             {openActions.slice(0, 6).map((action) => (
               <div key={action.id} className="nr-item" style={{ display: "flex", gap: "8px", alignItems: "baseline", borderBottom: "none", padding: "6px 0" }}>
                 <input type="checkbox" disabled style={{ margin: 0 }} />
                 <Link href={`/workspaces/${workspaceId}/actions`} style={{ fontSize: "0.85rem", lineHeight: 1.4, textDecoration: "none", color: "var(--text)" }}>{action.title}</Link>
               </div>
             ))}
           </div>

           <h2 className="nr-section-header">{t("activeTensions")}</h2>
           <div style={{ marginBottom: "16px" }}>
             {tensions.filter(t => t.status === "OPEN" || t.status === "IN_PROGRESS").slice(0, 4).map((tension) => (
               <div key={tension.id} className="nr-item" style={{ padding: "8px 0" }}>
                 <Link href={`/workspaces/${workspaceId}/tensions`} style={{ display: "block", textDecoration: "none" }}>
                   <div style={{ fontSize: "0.85rem", fontWeight: 600, color: "var(--text)", marginBottom: "2px" }}>{tension.title}</div>
                   <div className="nr-item-meta" suppressHydrationWarning>{ageText(tension.createdAt)}</div>
                 </Link>
               </div>
             ))}
           </div>
           
           <h2 className="nr-section-header" style={{ marginTop: "32px"}}>{t("liveActivity")}</h2>
           <div className="nr-activity">
             {auditLogs.slice(0, 5).map(log => (
               <div key={log.id} style={{ fontSize: "0.85rem", padding: "8px 0", borderBottom: "1px solid var(--line)" }}>
                 <span style={{ color: "var(--muted)", marginRight: "6px" }} suppressHydrationWarning>{ageText(log.createdAt)}</span>
                 <span>{log.actorUserId ? t("someone") : t("system")} {log.action.replace(/\./g, " ")} {t("activityOn")} {log.entityType}</span>
               </div>
             ))}
           </div>
        </div>
      </section>

      <hr className="nr-divider" />

      <h2 className="nr-section-header" style={{ borderTop: "none", fontSize: "1.2rem", marginBottom: "24px" }}>
        {t("strategicDirection")}
        <Link href={`/workspaces/${workspaceId}/goals`} className="nr-link" style={{ float: "right", fontSize: "0.85rem", marginTop: "4px" }}>{t("viewAll")}</Link>
      </h2>
      <div style={{ display: "flex", gap: "24px", flexWrap: "wrap", marginBottom: "32px" }}>
        <div style={{ flex: "2 1 400px" }}>
          {strategicGoals.length === 0 ? <p className="nr-meta">{t("noActiveGoals")}</p> : null}
          {strategicGoals.map(goal => (
            <div key={goal.id} className="nr-item" style={{ border: "1px solid var(--line)", borderRadius: "8px", padding: "16px", marginBottom: "12px", backgroundColor: "var(--surface)" }}>
              <div style={{ display: "flex", justifyContent: "space-between", marginBottom: "8px" }}>
                <h4 style={{ margin: 0, fontSize: "1.05rem", fontWeight: 600 }}>{goal.title}</h4>
                <div className="nr-meta">{goal.cadence.replace("_", " ")}</div>
              </div>
              <div style={{ marginBottom: "8px" }}>
                <GoalProgress percent={goal.progressPercent} />
              </div>
              <div style={{ display: "flex", justifyContent: "space-between", fontSize: "0.8rem", color: "var(--muted)" }}>
                <span>{t("achieved", { percent: goal.progressPercent })}</span>
                {goal.targetDate && (
                  <span suppressHydrationWarning>{t("daysRemaining", { count: Math.max(0, Math.ceil((new Date(goal.targetDate).getTime() - Date.now()) / (1000 * 60 * 60 * 24))) })}</span>
                )}
              </div>
            </div>
          ))}
        </div>
        
        {recentRecognition && (
          <div style={{ flex: "1 1 300px" }}>
            <h3 style={{ fontSize: "0.9rem", color: "var(--muted)", textTransform: "uppercase", letterSpacing: "0.05em", marginBottom: "12px" }}>{t("recentRecognition")}</h3>
            <RecognitionCard recognition={recentRecognition} />
          </div>
        )}
      </div>

      <hr className="nr-divider" />

      <h2 className="nr-section-header" style={{ borderTop: "none", fontSize: "1.2rem", marginBottom: "24px" }}>{t("recentlyPublished")}</h2>
      <div style={{ display: "flex", gap: "16px", overflowX: "auto", paddingBottom: "16px", marginBottom: "32px", WebkitOverflowScrolling: "touch" }}>
        {recentlyPublished.length === 0 ? <p className="nr-meta">{t("noItemsPublished")}</p> : null}
        {recentlyPublished.map(item => (
          <Link key={item.kind + item.id} href={item.link} style={{ display: "block", flex: "0 0 280px", border: "1px solid var(--line)", borderRadius: "8px", padding: "16px", textDecoration: "none", color: "inherit", backgroundColor: "var(--surface)" }}>
            <div style={{ fontSize: "0.75rem", textTransform: "uppercase", letterSpacing: "0.05em", color: "var(--muted)", marginBottom: "8px", fontWeight: "bold" }}>{item.kind}</div>
            <div style={{ fontSize: "1rem", fontWeight: 600, marginBottom: "8px", lineHeight: "1.3" }}>{item.title}</div>
            <div style={{ fontSize: "0.8rem", color: "var(--muted)" }}>
              {t("by")} {item.author?.displayName || t("system")} · {ageText(item.publishedAt!)}
            </div>
          </Link>
        ))}
      </div>

      <hr className="nr-divider" />

      <h2 className="nr-section-header" style={{ borderTop: "none", fontSize: "1.2rem", marginBottom: "24px" }}>{t("wikiIndex")}</h2>
      <div className="nr-category-grid">
        {sortedCategories.map(([category, items]) => (
          <div key={category} className="nr-category">
            <h3>{category}</h3>
            <ul>
              {items.slice(0, 4).map(item => (
                <li key={item.id}><Link href={`/workspaces/${workspaceId}/brain/${item.slug}`}>{item.title}</Link></li>
              ))}
              {items.length > 4 && (
                <li><Link href={`/workspaces/${workspaceId}/brain`} style={{ color: "var(--muted)", fontStyle: "italic", fontSize: "0.8rem" }}>{t("more", { count: items.length - 4 })}</Link></li>
              )}
            </ul>
          </div>
        ))}
      </div>

      <div className="nr-footer">
        {t("footerStats", { articles: allArticles.length, meetings: meetings.length, chunks: chunksCount, members: members.length })}
      </div>
    </>
  );
}
