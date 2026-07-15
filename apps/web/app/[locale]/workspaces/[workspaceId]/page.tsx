import {
  computeNewspaperLayout,
  countUnreadNotifications,
  getLatestWorkspaceBriefing,
  listNewspaperEditions,
  listMembers, listNotifications, listTensions,
  listArticles, listMeetings,
  listProposalDecisionStates,
  normalizeNewspaperEditionDigest,
  normalizeWorkspaceBriefingPayload,
  workspaceBriefingSourceLabel
} from "@corgtex/domain";
import { prisma, workspaceBranding } from "@corgtex/shared";
import { requirePageActor } from "@/lib/auth";
import {
  markAllNotificationsReadAction,
} from "./actions";
import Link from "next/link";
import { GoalProgress } from "./goals/GoalProgress";
import { RecognitionCard } from "./goals/RecognitionCard";
import { getTranslations, getFormatter } from "next-intl/server";
import { getDashboardAttentionCounts } from "@/lib/dashboard-attention";
import { MarkdownExcerpt } from "@/lib/components/MarkdownRenderer";
import { resolveWorkspaceEntityUrl } from "@/lib/workspace-entity-url";
import {
  capDashboardUnreadNotificationCount,
  isDashboardUnreadNotificationCountCapped,
  selectDashboardActionItems,
  selectDashboardFeedItems,
  selectDashboardNotificationPreviewLimit,
  selectDashboardOpenProposals,
} from "@/lib/dashboard-briefing";

export const dynamic = "force-dynamic";

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
    unreadNotificationsCount,
    articlesResult,
    latestWorkspaceBriefing,
    newspaperEditions,
    meetings,
    openProposalCandidates,
    proposalReviewCandidates,
    teamActionCandidates,
    chunksCount,
    workspaceData,
    recentPublishedBase,
    strategicGoals,
    recentRecognition
  ] = await Promise.all([
    listTensions(actor, workspaceId, { take: 10 }),
    listMembers(workspaceId),
    listNotifications(actor, workspaceId, { take: 5, unreadOnly: true }),
    actor.kind === "user" ? countUnreadNotifications(actor.user.id, workspaceId) : Promise.resolve(0),
    listArticles(actor, { workspaceId, take: 50 }),
    getLatestWorkspaceBriefing({ actor, workspaceId, period: "DAILY" }),
    listNewspaperEditions(actor, workspaceId, { take: 1 }),
    listMeetings(workspaceId, { status: "COMPLETED" }),
    prisma.proposal.findMany({
      where: {
        workspaceId,
        status: "OPEN",
        isPrivate: false,
        archivedAt: null,
      },
      select: {
        id: true,
        authorUserId: true,
        title: true,
        summary: true,
        status: true,
        isPrivate: true,
        archivedAt: true,
        createdAt: true,
      },
      orderBy: { createdAt: "desc" },
      take: 20,
    }),
    prisma.proposal.findMany({
      where: {
        workspaceId,
        status: "OPEN",
        isPrivate: false,
        archivedAt: null,
      },
      select: {
        id: true,
        title: true,
        status: true,
        isPrivate: true,
        archivedAt: true,
        createdAt: true,
      },
      orderBy: { createdAt: "desc" },
    }),
    prisma.action.findMany({
      where: {
        workspaceId,
        status: { in: ["OPEN", "IN_PROGRESS"] },
        isPrivate: false,
        archivedAt: null,
      },
      select: {
        id: true,
        authorUserId: true,
        assigneeMemberId: true,
        title: true,
        bodyMd: true,
        status: true,
        isPrivate: true,
        archivedAt: true,
        dueAt: true,
        createdAt: true,
        assigneeMember: {
          include: {
            user: {
              select: {
                displayName: true,
              },
            },
          },
        },
      },
      orderBy: [
        { dueAt: "asc" },
        { createdAt: "desc" },
      ],
      take: 50,
    }),
    prisma.knowledgeChunk.count({ where: { workspaceId } }),
    prisma.workspace.findUnique({ where: { id: workspaceId }, select: { slug: true, name: true } }),
    Promise.all([
      prisma.action.findMany({ where: { workspaceId, isPrivate: false, publishedAt: { not: null } }, select: { id: true, title: true, publishedAt: true, author: { select: { displayName: true } } }, orderBy: { publishedAt: "desc" }, take: 10 }),
      prisma.tension.findMany({ where: { workspaceId, isPrivate: false, publishedAt: { not: null } }, select: { id: true, title: true, publishedAt: true, author: { select: { displayName: true } } }, orderBy: { publishedAt: "desc" }, take: 10 }),
      prisma.proposal.findMany({ where: { workspaceId, isPrivate: false, publishedAt: { not: null } }, select: { id: true, title: true, publishedAt: true, author: { select: { displayName: true } } }, orderBy: { publishedAt: "desc" }, take: 10 }),
      prisma.brainArticle.findMany({ where: { workspaceId, isPrivate: false, publishedAt: { not: null } }, select: { id: true, slug: true, title: true, publishedAt: true, ownerMember: { select: { user: { select: { displayName: true } } } } }, orderBy: { publishedAt: "desc" }, take: 10 }),
    ]),
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

  const currentMember = actor.kind === 'user' ? members.find(m => m.userId === actor.user.id) : undefined;
  const currentMemberUrl = currentMember?.id;

  const unreadNotifications = notifications;
  const unreadNotificationsDisplayCount = capDashboardUnreadNotificationCount(unreadNotificationsCount);
  const isUnreadNotificationsCountCapped = isDashboardUnreadNotificationCountCapped(unreadNotificationsCount);
  const notificationPreviewLimit = selectDashboardNotificationPreviewLimit(unreadNotificationsCount);
  const openProposalItems = selectDashboardOpenProposals(openProposalCandidates);
  const proposalReviewCandidatesForDecision = selectDashboardOpenProposals(
    proposalReviewCandidates,
    proposalReviewCandidates.length,
  );
  const proposalDecisionStates = await listProposalDecisionStates(actor, {
    workspaceId,
    proposalIds: proposalReviewCandidatesForDecision.map((proposal) => proposal.id),
  });
  const proposalReviewItems = proposalReviewCandidatesForDecision.filter((proposal) => proposalDecisionStates.get(proposal.id)?.needsReview);
  const teamActionItems = selectDashboardActionItems(teamActionCandidates);
  const openTensionItems = tensions.filter((tension) => tension.status === "OPEN");
  const currentUserId = actor.kind === "user" ? actor.user.id : null;
  const ageText = (date: Date) => format.relativeTime(date);
  const myWorkItems = currentMember && currentUserId ? [
    ...openProposalItems
      .filter((proposal) => proposal.authorUserId === currentUserId)
      .map((proposal) => ({
        id: `proposal-${proposal.id}`,
        title: proposal.title,
        href: `/workspaces/${workspaceId}/proposals/${proposal.id}`,
        typeLabel: t("proposal"),
        meta: ageText(proposal.createdAt),
        createdAt: proposal.createdAt,
      })),
    ...teamActionItems
      .filter((action) => action.assigneeMemberId === currentMember.id || action.authorUserId === currentUserId)
      .map((action) => ({
        id: `action-${action.id}`,
        title: action.title,
        href: `/workspaces/${workspaceId}/actions?scope=member&memberId=${currentMember.id}`,
        typeLabel: t("action"),
        meta: action.dueAt
          ? t("dueDate", { date: format.dateTime(action.dueAt, { month: "short", day: "numeric" }) })
          : ageText(action.createdAt),
        createdAt: action.createdAt,
      })),
    ...openTensionItems
      .filter((tension) => (
        tension.authorUserId === currentUserId
        || tension.assigneeMemberId === currentMember.id
        || tension.raisedByMemberId === currentMember.id
      ))
      .map((tension) => ({
        id: `tension-${tension.id}`,
        title: tension.title,
        href: `/workspaces/${workspaceId}/tensions/${tension.id}`,
        typeLabel: t("tension"),
        meta: ageText(tension.createdAt),
        createdAt: tension.createdAt,
      })),
  ]
    .sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime())
    .slice(0, 4) : [];
  
  const attentionCounts = getDashboardAttentionCounts({
    unreadNotificationsCount,
    proposalReviewRequestsCount: proposalReviewItems.length,
  });
  const totalAttentionItems = attentionCounts.totalAttentionItems;

  const d = new Date();
  const freshKnowledgeWindowMs = 14 * 24 * 60 * 60 * 1000;
  const dateString = format.dateTime(d, { weekday: 'long', year: 'numeric', month: 'long', day: 'numeric' });

  const allArticles = articlesResult.items;
  const latestNewspaperEdition = newspaperEditions[0] ?? null;
  const latestEditionDigest = latestNewspaperEdition
    ? normalizeNewspaperEditionDigest(latestNewspaperEdition)
    : null;
  const latestEditionSections = latestEditionDigest?.sections ?? [];
  const latestBriefing = latestWorkspaceBriefing
    ? normalizeWorkspaceBriefingPayload(latestWorkspaceBriefing.briefingJson)
    : null;
  const briefingItems = latestBriefing?.items ?? [];
  const dashboardFeedItems = selectDashboardFeedItems({
    articles: allArticles,
    meetings,
    limit: 6,
  });

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
    ...recentPublishedBase[0].map(i => ({ ...i, kind: "Action", link: `/workspaces/${workspaceId}/actions/${i.id}` })),
    ...recentPublishedBase[1].map(i => ({ ...i, kind: "Tension", link: `/workspaces/${workspaceId}/tensions/${i.id}` })),
    ...recentPublishedBase[2].map(i => ({ ...i, kind: "Proposal", link: `/workspaces/${workspaceId}/proposals/${i.id}` })),
    ...recentPublishedBase[3].map(i => ({ ...i, kind: "Brain Article", link: `/workspaces/${workspaceId}/brain/${i.slug}`, author: i.ownerMember?.user })),
  ]
    .sort((a, b) => b.publishedAt!.getTime() - a.publishedAt!.getTime())
    .slice(0, 10);

  const dashboardLayout = computeNewspaperLayout([
    {
      id: "knowledgeFeed",
      priority: 1,
      itemCount: dashboardFeedItems.length,
      estimatedTextLength: dashboardFeedItems.reduce((sum, item) => (
        sum
        + (item.title?.length ?? 0)
        + (item.kind === "MEETING" ? (item.summaryMd?.length ?? 0) : item.bodyMd.length)
      ), 0),
    },
    {
      id: "attention",
      priority: 2,
      itemCount: totalAttentionItems > 0 ? 1 : 0,
      estimatedTextLength: 80,
    },
    {
      id: "proposals",
      priority: 3,
      itemCount: openProposalItems.length,
      estimatedTextLength: openProposalItems.reduce((sum, proposal) => sum + proposal.title.length + (proposal.summary?.length ?? 0), 0),
    },
    {
      id: "actionItems",
      priority: 4,
      itemCount: teamActionItems.length,
      estimatedTextLength: teamActionItems.reduce((sum, action) => sum + action.title.length + (action.bodyMd?.length ?? 0), 0),
    },
    {
      id: "tensions",
      priority: 5,
      itemCount: openTensionItems.length,
      estimatedTextLength: openTensionItems.reduce((sum, tension) => sum + tension.title.length + (tension.bodyMd?.length ?? 0), 0),
    },
  ]);
  const dashboardSectionLayout = (id: string) => dashboardLayout.sectionCaps[id] ?? {
    itemCap: 4,
    excerptMaxLength: 140,
    placement: "standard" as const,
  };
  const editionLayout = computeNewspaperLayout(latestEditionSections.map((section, index) => ({
    id: section.id,
    priority: index + 1,
    itemCount: section.items.length,
    estimatedTextLength: section.items.reduce((sum, item) => sum + item.length, 0),
    surface: "dashboard" as const,
  })));
  const latestEditionSectionById = new Map(latestEditionSections.map((section) => [section.id, section]));
  const cappedEditionSections = editionLayout.visibleSections.flatMap((layoutSection) => {
    const section = latestEditionSectionById.get(layoutSection.id);
    if (!section) return [];
    return [{
      ...section,
      items: section.items.slice(0, layoutSection.itemCap),
      excerptMaxLength: layoutSection.excerptMaxLength,
    }];
  });
  const cappedBriefingItems = briefingItems
    .filter((item) => item.prominence !== "reference")
    .slice(0, 8);
  const referenceBriefingItems = briefingItems
    .filter((item) => item.prominence === "reference")
    .slice(0, 4);
  const hasWorkspaceBriefing = !!latestWorkspaceBriefing && cappedBriefingItems.length > 0;
  const hasStoredEdition = !!latestNewspaperEdition && cappedEditionSections.length > 0;
  const knowledgeFeedLayout = dashboardSectionLayout("knowledgeFeed");
  const proposalLayout = dashboardSectionLayout("proposals");
  const actionLayout = dashboardSectionLayout("actionItems");
  const tensionLayout = dashboardSectionLayout("tensions");
  const cappedFeedItems = dashboardFeedItems.slice(0, knowledgeFeedLayout.itemCap);
  const cappedOpenProposalItems = openProposalItems.slice(0, proposalLayout.itemCap);
  const cappedTeamActionItems = teamActionItems.slice(0, actionLayout.itemCap);
  const cappedOpenTensionItems = openTensionItems.slice(0, tensionLayout.itemCap);
  const hasWorkRail = totalAttentionItems > 0
    || openProposalItems.length > 0
    || teamActionItems.length > 0
    || openTensionItems.length > 0
    || myWorkItems.length > 0;
  const hasDashboardContent = hasWorkspaceBriefing || hasStoredEdition || cappedFeedItems.length > 0 || hasWorkRail;
  const hasStrategicDirection = strategicGoals.length > 0 || !!recentRecognition;
  const attentionSummary = [
    unreadNotificationsCount > 0
      ? t(isUnreadNotificationsCountCapped ? "unreadNotificationsSummaryCapped" : "unreadNotificationsSummary", {
        count: unreadNotificationsDisplayCount,
      })
      : null,
    proposalReviewItems.length > 0 ? t("proposalReviewsSummary", { count: proposalReviewItems.length }) : null,
  ].filter(Boolean).join(" · ");
  const attentionPanel = totalAttentionItems > 0 ? (
    <section className="nr-rail-section nr-rail-section-attention">
      <h2 className="nr-section-header">{t("attention")}</h2>
      <div className="nr-attention nr-attention-rail">
        <div className="nr-attention-summary">
          {attentionSummary}
        </div>

        <div className="nr-attention-body">
          {proposalReviewItems.length > 0 && (
            <div className="nr-attention-block">
              <div className="nr-attention-block-header">
                <strong>
                  <Link href={`/workspaces/${workspaceId}/proposals?status=OPEN`} className="nr-attention-heading-link">
                    {t("proposalReviews")}
                  </Link>
                </strong>
              </div>
              {proposalReviewItems.slice(0, 3).map((proposal) => (
                <div key={proposal.id} className="nr-attention-item">
                  <div className="nr-attention-item-main">
                    <Link href={`/workspaces/${workspaceId}/proposals/${proposal.id}`} className="nr-attention-title nr-attention-title-truncate">
                      {proposal.title}
                    </Link>
                    <span className="nr-attention-copy" suppressHydrationWarning>{ageText(proposal.createdAt)}</span>
                  </div>
                  <span className="tag warning tag-sm">{t("proposalReviewRequestedTag")}</span>
                </div>
              ))}
              {proposalReviewItems.length > 3 && (
                <Link href={`/workspaces/${workspaceId}/proposals?status=OPEN`} className="nr-attention-inline-link">{t("viewAllProposals")}</Link>
              )}
            </div>
          )}
          {unreadNotificationsCount > 0 && (
            <div className="nr-attention-block">
              <div className="nr-attention-block-header">
                <strong>
                  <Link href={`/workspaces/${workspaceId}/notifications`} className="nr-attention-heading-link">
                    {t("notifications")}
                  </Link>
                </strong>
                <form action={markAllNotificationsReadAction} className="nr-attention-mark-read">
                  <input type="hidden" name="workspaceId" value={workspaceId} />
                  <button type="submit" className="nr-attention-mark-read-button">{t("markRead")}</button>
                </form>
              </div>
              {unreadNotifications.slice(0, notificationPreviewLimit).map((n) => {
                const href = resolveWorkspaceEntityUrl(workspaceId, n.entityType, n.entityId);
                return (
                  <div key={n.id} className="nr-attention-notification">
                    <div className="nr-attention-notification-head">
                      {href ? (
                        <Link href={href} className="nr-attention-title nr-attention-title-truncate">
                          {n.title}
                        </Link>
                      ) : (
                        <span className="nr-attention-title nr-attention-title-truncate">{n.title}</span>
                      )}
                      <span className="nr-attention-time" suppressHydrationWarning>{ageText(n.createdAt)}</span>
                    </div>
                    {n.bodyMd && (
                      <div className="nr-attention-copy">
                        <MarkdownExcerpt markdown={n.bodyMd} maxLength={100} />
                      </div>
                    )}
                  </div>
                );
              })}
              <Link href={`/workspaces/${workspaceId}/notifications`} className="nr-attention-inline-link">{t("viewAll")}</Link>
            </div>
          )}
        </div>
      </div>
    </section>
  ) : null;

  return (
    <>
      <header className="nr-masthead">
        <h1>{branding.primaryName}</h1>
        <div className="nr-masthead-meta">
          <span suppressHydrationWarning>{dateString}</span>
          <form action={`/workspaces/${workspaceId}/brain`} method="GET" className="nr-masthead-search">
            <span>{t("searchLabel")}</span>
            <input 
              name="q"
              type="text" 
              placeholder={t("searchPlaceholder")} 
            />
          </form>
        </div>
      </header>

      {currentMemberUrl && (
        <div className="nr-profile-link-row">
          <Link href={`/workspaces/${workspaceId}/members/${currentMemberUrl}`} className="nr-link">
            {t("viewFullProfile")}
          </Link>
        </div>
      )}

      {hasDashboardContent && (
      <section className={`nr-dashboard-grid${hasWorkRail ? "" : " nr-dashboard-grid-single"}`}>
        {hasWorkspaceBriefing && latestWorkspaceBriefing && latestBriefing ? (
          <div className="nr-knowledge-feed nr-workspace-briefing">
            <div className="nr-section-heading-row">
              <div>
                <h2 className="nr-section-header">{t("latestWorkspaceBriefing")}</h2>
                <div className="nr-feed-meta">
                  <span>{latestBriefing.period === "DAILY" ? t("dailyEdition") : t("weeklyEdition")}</span>
                  <span>·</span>
                  <span suppressHydrationWarning>
                    {t("generatedOn", {
                      date: format.dateTime(latestWorkspaceBriefing.generatedAt, {
                        month: "short",
                        day: "numeric",
                        hour: "numeric",
                        minute: "2-digit",
                      }),
                    })}
                  </span>
                </div>
              </div>
            </div>
            {latestBriefing.introMd && (
              <MarkdownExcerpt markdown={latestBriefing.introMd} maxLength={360} as="p" className="nr-excerpt nr-edition-intro" />
            )}
            <div className="nr-briefing-list">
              {cappedBriefingItems.map((item, index) => {
                const occurredAt = new Date(item.occurredAt);
                const isExternalHref = item.href?.startsWith("http://") || item.href?.startsWith("https://");
                const sourceLink = item.href
                  ? isExternalHref
                    ? <a href={item.href} className="nr-link" target="_blank" rel="noopener noreferrer">{t("openSource")}</a>
                    : <Link href={item.href} className="nr-link">{t("openSource")}</Link>
                  : null;

                return (
                  <article
                    key={`${item.kind}-${index}-${item.title}`}
                    className={`nr-briefing-item nr-briefing-item-${item.prominence}`}
                  >
                    <div className="nr-feed-meta">
                      <span>{workspaceBriefingSourceLabel(item.kind)}</span>
                      <span>·</span>
                      <span suppressHydrationWarning>
                        {Number.isNaN(occurredAt.getTime()) ? latestBriefing.dateKey : ageText(occurredAt)}
                      </span>
                    </div>
                    <h3 className="nr-feed-title">{item.title}</h3>
                    <MarkdownExcerpt
                      markdown={item.summaryMd}
                      maxLength={item.prominence === "lead" ? 520 : item.prominence === "standard" ? 320 : 180}
                      as="p"
                      className="nr-excerpt"
                    />
                    {item.prominence !== "compact" && item.whyItMattersMd && (
                      <p className="nr-briefing-why">
                        <span>{t("whyItMatters")}:</span>{" "}
                        <MarkdownExcerpt markdown={item.whyItMattersMd} maxLength={220} as="span" />
                      </p>
                    )}
                    {sourceLink && (
                      <div className="nr-briefing-actions">
                        {sourceLink}
                      </div>
                    )}
                  </article>
                );
              })}
            </div>
            {referenceBriefingItems.length > 0 && (
              <div className="nr-briefing-reference">
                {referenceBriefingItems.map((item) => {
                  const isExternalHref = item.href?.startsWith("http://") || item.href?.startsWith("https://");
                  const content = (
                    <>
                      <span>{workspaceBriefingSourceLabel(item.kind)}</span>
                      <strong>{item.title}</strong>
                    </>
                  );
                  if (!item.href) {
                    return (
                    <div key={`${item.kind}-${item.title}`} className="nr-briefing-reference-item">
                      {content}
                    </div>
                    );
                  }
                  return isExternalHref ? (
                    <a key={`${item.kind}-${item.title}`} href={item.href} className="nr-briefing-reference-item" target="_blank" rel="noopener noreferrer">
                      {content}
                    </a>
                  ) : (
                    <Link key={`${item.kind}-${item.title}`} href={item.href} className="nr-briefing-reference-item">
                      {content}
                    </Link>
                  );
                })}
              </div>
            )}
          </div>
        ) : hasStoredEdition && latestNewspaperEdition && latestEditionDigest ? (
          <div className="nr-knowledge-feed">
            <div className="nr-section-heading-row">
              <div>
                <h2 className="nr-section-header">{t("latestNewspaper")}</h2>
                <div className="nr-feed-meta">
                  <span>{latestNewspaperEdition.cadence === "DAILY" ? t("dailyEdition") : t("weeklyEdition")}</span>
                  <span>·</span>
                  <span suppressHydrationWarning>
                    {t("generatedOn", {
                      date: format.dateTime(latestNewspaperEdition.generatedAt, {
                        month: "short",
                        day: "numeric",
                        hour: "numeric",
                        minute: "2-digit",
                      }),
                    })}
                  </span>
                </div>
              </div>
              <Link href={`/workspaces/${workspaceId}/brain/${latestNewspaperEdition.slug}`} className="nr-link">
                {t("readFullEdition")}
              </Link>
            </div>
            {latestEditionDigest.intro && (
              <MarkdownExcerpt markdown={latestEditionDigest.intro} maxLength={280} as="p" className="nr-excerpt nr-edition-intro" />
            )}
            <div className="nr-feed-list nr-edition-section-list">
              {cappedEditionSections.map((section, index) => (
                <article key={section.id} className={index === 0 ? "nr-feed-item nr-feed-item-lead" : "nr-feed-item"}>
                  <h3 className="nr-feed-title">{section.title}</h3>
                  <ul className="nr-edition-items">
                    {section.items.map((item, itemIndex) => (
                      <li key={`${section.id}-${itemIndex}`}>
                        <MarkdownExcerpt
                          markdown={item}
                          maxLength={itemIndex === 0 ? section.excerptMaxLength : Math.min(160, section.excerptMaxLength)}
                          as="span"
                        />
                      </li>
                    ))}
                  </ul>
                </article>
              ))}
            </div>
          </div>
        ) : cappedFeedItems.length > 0 && (
          <div className="nr-knowledge-feed">
            <h2 className="nr-section-header">{t("freshKnowledge")}</h2>
            <div className="nr-feed-list">
              {cappedFeedItems.map((item, index) => {
                const href = item.kind === "MEETING"
                  ? `/workspaces/${workspaceId}/meetings/${item.id}`
                  : `/workspaces/${workspaceId}/brain/${item.slug}`;
                const title = item.kind === "MEETING"
                  ? (item.title || t("meeting"))
                  : item.title;
                const excerpt = item.kind === "MEETING" ? item.summaryMd : item.bodyMd;
                const excerptMaxLength = index === 0
                  ? knowledgeFeedLayout.excerptMaxLength
                  : Math.min(170, knowledgeFeedLayout.excerptMaxLength);

                return (
                  <article key={`${item.kind}-${item.id}`} className={index === 0 ? "nr-feed-item nr-feed-item-lead" : "nr-feed-item"}>
                    <div className="nr-feed-meta">
                      <span>{item.label}</span>
                      <span>·</span>
                      <span suppressHydrationWarning>
                        {item.kind === "MEETING"
                          ? format.dateTime(item.recordedAt, { month: "short", day: "numeric", year: "numeric" })
                          : item.createdAt.getTime() >= d.getTime() - freshKnowledgeWindowMs
                            ? `${t("added")} ${ageText(item.createdAt)}`
                            : `${t("updated")} ${ageText(item.updatedAt)}`}
                      </span>
                    </div>
                    <Link href={href} className="nr-feed-link">
                      <h3 className="nr-feed-title">{title}</h3>
                      {excerpt && (
                        <MarkdownExcerpt markdown={excerpt} maxLength={excerptMaxLength} as="p" className="nr-excerpt" />
                      )}
                      <span className="nr-link">
                        {item.kind === "MEETING" ? t("viewMeetingTranscript") : t("readFullArticle")}
                      </span>
                    </Link>
                  </article>
                );
              })}
            </div>
          </div>
        )}

        {hasWorkRail && (
          <aside className="nr-work-rail">
            {attentionPanel}

            {myWorkItems.length > 0 && (
              <section className="nr-rail-section">
                <h2 className="nr-section-header">{t("myWork")}</h2>
                <div className="nr-rail-list">
                  {myWorkItems.map((item) => (
                    <Link key={item.id} href={item.href} className="nr-rail-item">
                      <span className="nr-rail-meta">{item.typeLabel}</span>
                      <span className="nr-rail-title">{item.title}</span>
                      <span className="nr-rail-meta" suppressHydrationWarning>{item.meta}</span>
                    </Link>
                  ))}
                </div>
                {currentMemberUrl && (
                  <Link href={`/workspaces/${workspaceId}/members/${currentMemberUrl}`} className="nr-link">{t("viewFullProfile")}</Link>
                )}
              </section>
            )}

            {openProposalItems.length > 0 && (
              <section className="nr-rail-section">
                <h2 className="nr-section-header">{t("openProposals")}</h2>
                <div className="nr-rail-list">
                  {cappedOpenProposalItems.map((proposal) => (
                    <Link key={proposal.id} href={`/workspaces/${workspaceId}/proposals/${proposal.id}`} className="nr-rail-item">
                      <span className="nr-rail-title">{proposal.title}</span>
                      {proposal.summary && <span className="nr-rail-copy">{proposal.summary}</span>}
                      <span className="nr-rail-meta" suppressHydrationWarning>{ageText(proposal.createdAt)}</span>
                    </Link>
                  ))}
                </div>
                {openProposalItems.length > cappedOpenProposalItems.length && (
                  <Link href={`/workspaces/${workspaceId}/proposals?status=OPEN`} className="nr-link">{t("viewAllProposals")}</Link>
                )}
              </section>
            )}

            {teamActionItems.length > 0 && (
              <section className="nr-rail-section">
                <h2 className="nr-section-header">{t("actionItems")}</h2>
                <div className="nr-rail-list">
                  {cappedTeamActionItems.map((action) => {
                    const assigneeName = action.assigneeMember?.user?.displayName;
                    return (
                      <Link key={action.id} href={`/workspaces/${workspaceId}/actions/${action.id}`} className="nr-rail-item">
                        <span className="nr-rail-title">{action.title}</span>
                        {action.bodyMd && <MarkdownExcerpt markdown={action.bodyMd} maxLength={110} as="span" className="nr-rail-copy" />}
                        {(action.dueAt || assigneeName) && (
                          <span className="nr-rail-meta">
                            {action.dueAt && (
                              <span suppressHydrationWarning>{t("dueDate", { date: format.dateTime(action.dueAt, { month: "short", day: "numeric" }) })}</span>
                            )}
                            {action.dueAt && assigneeName && <span> · </span>}
                            {assigneeName && <span>{t("assignedTo", { name: assigneeName })}</span>}
                          </span>
                        )}
                      </Link>
                    );
                  })}
                </div>
                {teamActionItems.length > cappedTeamActionItems.length && (
                  <Link href={`/workspaces/${workspaceId}/actions`} className="nr-link">{t("viewAllActions")}</Link>
                )}
              </section>
            )}

            {openTensionItems.length > 0 && (
              <section className="nr-rail-section">
                <h2 className="nr-section-header">{t("activeTensions")}</h2>
                <div className="nr-rail-list">
                  {cappedOpenTensionItems.map((tension) => (
                    <Link key={tension.id} href={`/workspaces/${workspaceId}/tensions/${tension.id}`} className="nr-rail-item">
                      <span className="nr-rail-title">{tension.title}</span>
                      <span className="nr-rail-meta" suppressHydrationWarning>{ageText(tension.createdAt)}</span>
                    </Link>
                  ))}
                </div>
                {openTensionItems.length > cappedOpenTensionItems.length && (
                  <Link href={`/workspaces/${workspaceId}/tensions`} className="nr-link">{t("viewAllTensions")}</Link>
                )}
              </section>
            )}
          </aside>
        )}
      </section>
      )}

      {hasDashboardContent && hasStrategicDirection && <hr className="nr-divider" />}

      {hasStrategicDirection && (
      <>
      <h2 className="nr-section-header" style={{ borderTop: "none", fontSize: "1.2rem", marginBottom: "24px" }}>
        {t("strategicDirection")}
        <Link href={`/workspaces/${workspaceId}/goals`} className="nr-link" style={{ float: "right", fontSize: "0.85rem", marginTop: "4px" }}>{t("viewAll")}</Link>
      </h2>
      <div style={{ display: "flex", gap: "24px", flexWrap: "wrap", marginBottom: "32px" }}>
        {strategicGoals.length > 0 && (
        <div style={{ flex: "2 1 400px" }}>
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
        )}
        
        {recentRecognition && (
          <div style={{ flex: "1 1 300px" }}>
            <h3 style={{ fontSize: "0.9rem", color: "var(--muted)", textTransform: "uppercase", letterSpacing: "0.05em", marginBottom: "12px" }}>{t("recentRecognition")}</h3>
            <RecognitionCard recognition={recentRecognition} />
          </div>
        )}
      </div>
      </>
      )}

      {(hasStrategicDirection || hasDashboardContent) && recentlyPublished.length > 0 && <hr className="nr-divider" />}

      {recentlyPublished.length > 0 && (
      <>
      <h2 className="nr-section-header" style={{ borderTop: "none", fontSize: "1.2rem", marginBottom: "24px" }}>{t("recentlyPublished")}</h2>
      <div style={{ display: "flex", gap: "16px", overflowX: "auto", paddingBottom: "16px", marginBottom: "32px", WebkitOverflowScrolling: "touch" }}>
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
      </>
      )}

      {(recentlyPublished.length > 0 || hasStrategicDirection || hasDashboardContent) && sortedCategories.length > 0 && <hr className="nr-divider" />}

      {sortedCategories.length > 0 && (
      <>
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
      </>
      )}

      <div className="nr-footer">
        {t("footerStats", { articles: allArticles.length, meetings: meetings.length, chunks: chunksCount, members: members.length })}
      </div>
    </>
  );
}
