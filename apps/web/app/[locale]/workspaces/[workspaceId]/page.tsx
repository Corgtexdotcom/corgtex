import type { Prisma } from "@prisma/client";
import {
  normalizeNewspaperEditionDigest,
  normalizeWorkspaceBriefingPayload,
  privacyFilter,
  requireWorkspaceMembership,
} from "@corgtex/domain";
import { prisma, workspaceBranding } from "@corgtex/shared";
import { requirePageActor } from "@/lib/auth";
import Link from "next/link";
import { getFormatter, getTranslations } from "next-intl/server";
import { MarkdownRenderer } from "@/lib/components/MarkdownRenderer";
import { markdownToPlainText } from "@/lib/markdown";
import {
  capDashboardUnreadNotificationCount,
  isDashboardUnreadNotificationCountCapped,
} from "@/lib/dashboard-briefing";
import { getDashboardWorkAttentionCountsFromMetrics } from "@/lib/dashboard-attention";

export const dynamic = "force-dynamic";

function isExternalHref(href: string) {
  return href.startsWith("http://") || href.startsWith("https://");
}

function compactNarrativeText(markdown: string | null | undefined, maxLength = 520) {
  if (!markdown?.trim()) return null;
  const text = markdownToPlainText(markdown, 2000)
    .replace(/\s*(?:\.{3}|…)\s*$/u, "")
    .replace(/\s+/g, " ")
    .trim();
  if (!text) return null;
  if (text.length <= maxLength) return text;

  const slice = text.slice(0, maxLength).trimEnd();
  const sentenceBoundary = lastSentenceBoundary(slice);
  if (sentenceBoundary > Math.floor(maxLength * 0.55)) {
    return slice.slice(0, sentenceBoundary + 1).trim();
  }

  const wordBoundary = slice.lastIndexOf(" ");
  const trimmed = wordBoundary > Math.floor(maxLength * 0.55)
    ? slice.slice(0, wordBoundary).trim()
    : slice;
  return /[.!?]$/.test(trimmed) ? trimmed : `${trimmed}.`;
}

function lastSentenceBoundary(value: string) {
  let boundary = -1;
  const sentenceBoundaryPattern = /[.!?](?=(?:["')\]]?\s|["')\]]?$|$))/g;
  for (const match of value.matchAll(sentenceBoundaryPattern)) {
    boundary = match.index ?? boundary;
  }
  return boundary;
}

function narrativeLine(title: string | null | undefined, summary: string | null | undefined) {
  const normalizedTitle = title?.replace(/\s+/g, " ").trim() || "Workspace update";
  return summary && summary !== normalizedTitle
    ? `**${normalizedTitle}**: ${summary}`
    : `**${normalizedTitle}**`;
}

function latestActivityTimeBefore(until: Date, ...values: Array<Date | string | null | undefined>) {
  const cutoff = until.getTime();
  const times = values
    .map((value) => value ? new Date(value).getTime() : Number.NaN)
    .filter((time) => Number.isFinite(time) && time <= cutoff);
  return times.length > 0 ? Math.max(...times) : 0;
}

type DisplayedEditionPeriod = "DAILY" | "WEEKLY" | null;

function NewspaperSection({
  title,
  markdown,
  className,
}: {
  title: string;
  markdown: string | null | undefined;
  className?: string;
}) {
  if (!markdown?.trim()) return null;
  return (
    <section className="nr-newspaper-section">
      <h3>{title}</h3>
      <MarkdownRenderer markdown={markdown} variant="document" className={className} allowImages={false} />
    </section>
  );
}

function legacyEditionNarrative(
  editionDigest: ReturnType<typeof normalizeNewspaperEditionDigest> | null,
  labels: { intro: string; closing: string },
) {
  if (!editionDigest) return null;
  const items = editionDigest.sections.flatMap((section) => section.items).filter(Boolean);
  return {
    introMd: editionDigest.intro ?? labels.intro,
    leadMd: items[0] ?? null,
    bodyMd: items.slice(1, 5).join("\n\n") || null,
    closingMd: labels.closing,
  };
}

function liveWorkspaceNarrative(params: {
  workspaceId: string;
  articles: Array<{
    id: string;
    slug: string;
    title: string;
    bodyMd?: string | null;
    type?: string | null;
    isPrivate?: boolean | null;
    updatedAt?: Date | string | null;
    publishedAt?: Date | string | null;
    createdAt?: Date | string | null;
  }>;
  meetings: Array<{
    id: string;
    title?: string | null;
    summaryMd?: string | null;
    recordedAt?: Date | string | null;
    updatedAt?: Date | string | null;
    createdAt?: Date | string | null;
  }>;
  labels: { intro: string; closing: string };
}) {
  const now = new Date();
  const entries = [
    ...params.meetings.map((meeting) => {
      const title = meeting.title || "Meeting recap";
      return {
        occurredAt: latestActivityTimeBefore(now, meeting.updatedAt, meeting.recordedAt, meeting.createdAt),
        line: narrativeLine(title, compactNarrativeText(meeting.summaryMd, 620)),
        sourceRef: {
          type: "MEETING",
          id: meeting.id,
          label: title,
          href: `/workspaces/${params.workspaceId}/meetings/${meeting.id}`,
        },
      };
    }),
    ...params.articles
      .filter((article) => article.type !== "DIGEST" && !article.isPrivate)
      .map((article) => ({
        occurredAt: latestActivityTimeBefore(now, article.updatedAt, article.publishedAt, article.createdAt),
        line: narrativeLine(article.title, compactNarrativeText(article.bodyMd, 560)),
        sourceRef: {
          type: "BRAIN_ARTICLE",
          id: article.id,
          label: article.title,
          href: `/workspaces/${params.workspaceId}/brain/${article.slug}`,
        },
      })),
  ]
    .filter((entry) => entry.occurredAt > 0 && entry.line.trim())
    .sort((left, right) => right.occurredAt - left.occurredAt)
    .slice(0, 5);

  if (entries.length === 0) return null;
  return {
    introMd: params.labels.intro,
    leadMd: entries[0]?.line ?? null,
    bodyMd: entries.slice(1).map((entry) => entry.line).join("\n\n") || null,
    closingMd: params.labels.closing,
    sourceRefs: entries.map((entry) => entry.sourceRef),
    latestActivityAt: entries[0]?.occurredAt ?? 0,
  };
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
  const membership = await requireWorkspaceMembership({ actor, workspaceId });
  const currentMember = actor.kind === "user" && actor.user.globalRole !== "OPERATOR"
    ? membership
    : actor.kind === "user"
      ? await prisma.member.findFirst({
        where: {
          workspaceId,
          userId: actor.user.id,
          isActive: true,
        },
        select: {
          id: true,
          workspaceId: true,
          userId: true,
          role: true,
          isActive: true,
        },
      })
      : null;

  const workItemVisibilityWhere = privacyFilter(actor, membership ?? null);
  const visibleOpenActionWhere = {
    AND: [
      workItemVisibilityWhere,
      {
        workspaceId,
        archivedAt: null,
        isPrivate: false,
        status: { in: ["OPEN", "IN_PROGRESS"] },
      },
    ],
  } satisfies Prisma.ActionWhereInput;
  const visibleOpenProposalWhere = {
    AND: [
      workItemVisibilityWhere,
      {
        workspaceId,
        archivedAt: null,
        isPrivate: false,
        status: "OPEN",
      },
    ],
  } satisfies Prisma.ProposalWhereInput;
  const visibleOpenTensionWhere = {
    AND: [
      workItemVisibilityWhere,
      {
        workspaceId,
        archivedAt: null,
        isPrivate: false,
        status: "OPEN",
      },
    ],
  } satisfies Prisma.TensionWhereInput;
  const personalProposalConditions: Prisma.ProposalWhereInput[] = currentMember?.id
    ? [
      { ownerMemberId: currentMember.id },
      {
        adviceProcess: {
          is: {
            requests: {
              some: {
                workspaceId,
                status: "ACTIVE",
                recipients: {
                  some: { memberId: currentMember.id },
                },
              },
            },
          },
        },
      },
    ]
    : [];
  const visiblePersonalOpenProposalWhere = currentMember?.id
    ? {
      AND: [
        visibleOpenProposalWhere,
        { OR: personalProposalConditions },
      ],
    } satisfies Prisma.ProposalWhereInput
    : null;
  const [
    unreadNotificationsCount,
    articles,
    latestDailyWorkspaceBriefing,
    latestWeeklyWorkspaceBriefing,
    newspaperEditions,
    meetings,
    chunksCount,
    workspaceData,
    membersCount,
    actionTotalCount,
    actionPersonalCount,
    proposalTotalCount,
    proposalPersonalCount,
    tensionTotalCount,
    tensionPersonalCount,
  ] = await prisma.$transaction([
    prisma.notification.count({
      where: {
        workspaceId,
        userId: actor.kind === "user" ? actor.user.id : "__agent_actor__",
        readAt: null,
      },
    }),
    prisma.brainArticle.findMany({
      where: {
        workspaceId,
        archivedAt: null,
        isPrivate: false,
        type: { not: "DIGEST" },
      },
      select: {
        id: true,
        slug: true,
        title: true,
        bodyMd: true,
        type: true,
        isPrivate: true,
        updatedAt: true,
        publishedAt: true,
        createdAt: true,
      },
      orderBy: { updatedAt: "desc" },
      take: 50,
    }),
    prisma.workspaceBriefing.findFirst({
      where: {
        workspaceId,
        status: "GENERATED",
        period: "DAILY",
      },
      orderBy: { generatedAt: "desc" },
      select: {
        id: true,
        workflowJobId: true,
        period: true,
        dateKey: true,
        runKey: true,
        title: true,
        status: true,
        modelUsed: true,
        introMd: true,
        bodyMd: true,
        briefingJson: true,
        sourceRefsJson: true,
        sourceCounts: true,
        generatedAt: true,
        createdAt: true,
        updatedAt: true,
      },
    }),
    prisma.workspaceBriefing.findFirst({
      where: {
        workspaceId,
        status: "GENERATED",
        period: "WEEKLY",
      },
      orderBy: { generatedAt: "desc" },
      select: {
        id: true,
        workflowJobId: true,
        period: true,
        dateKey: true,
        runKey: true,
        title: true,
        status: true,
        modelUsed: true,
        introMd: true,
        bodyMd: true,
        briefingJson: true,
        sourceRefsJson: true,
        sourceCounts: true,
        generatedAt: true,
        createdAt: true,
        updatedAt: true,
      },
    }),
    prisma.newspaperEdition.findMany({
      where: { workspaceId },
      orderBy: { generatedAt: "desc" },
      take: 1,
      select: {
        id: true,
        workflowJobId: true,
        cadence: true,
        dateKey: true,
        runKey: true,
        title: true,
        slug: true,
        digestJson: true,
        bodyMd: true,
        sourceCounts: true,
        generatedAt: true,
        createdAt: true,
        updatedAt: true,
      },
    }),
    prisma.meeting.findMany({
      where: {
        workspaceId,
        status: "COMPLETED",
        archivedAt: null,
      },
      select: {
        id: true,
        title: true,
        summaryMd: true,
        recordedAt: true,
        updatedAt: true,
        createdAt: true,
      },
      orderBy: { recordedAt: "desc" },
    }),
    prisma.knowledgeChunk.count({ where: { workspaceId } }),
    prisma.workspace.findUnique({ where: { id: workspaceId }, select: { slug: true, name: true } }),
    prisma.member.count({ where: { workspaceId, isActive: true } }),
    prisma.action.count({ where: visibleOpenActionWhere }),
    currentMember?.id
      ? prisma.action.count({ where: { AND: [visibleOpenActionWhere, { assigneeMemberId: currentMember.id }] } })
      : prisma.action.count({ where: { id: "__no_current_member__" } }),
    prisma.proposal.count({ where: visibleOpenProposalWhere }),
    visiblePersonalOpenProposalWhere
      ? prisma.proposal.count({ where: visiblePersonalOpenProposalWhere })
      : prisma.proposal.count({ where: { id: "__no_current_member__" } }),
    prisma.tension.count({ where: visibleOpenTensionWhere }),
    currentMember?.id
      ? prisma.tension.count({ where: { AND: [visibleOpenTensionWhere, { assigneeMemberId: currentMember.id }] } })
      : prisma.tension.count({ where: { id: "__no_current_member__" } }),
  ]);
  const branding = workspaceData
    ? workspaceBranding(workspaceData)
    : { primaryName: "Corgtex", secondaryLabel: "powered by Corgtex" };
  const workAttentionCounts = getDashboardWorkAttentionCountsFromMetrics({
    currentMemberId: currentMember?.id ?? null,
    actionPersonalCount,
    actionTotalCount,
    proposalPersonalCount,
    proposalTotalCount,
    tensionPersonalCount,
    tensionTotalCount,
  });
  const latestWorkspaceBriefing = [latestDailyWorkspaceBriefing, latestWeeklyWorkspaceBriefing]
    .filter((briefing): briefing is NonNullable<typeof latestDailyWorkspaceBriefing> => Boolean(briefing))
    .sort((left, right) => right.generatedAt.getTime() - left.generatedAt.getTime())[0] ?? null;
  const latestNewspaperEdition = newspaperEditions[0] ?? null;
  const latestEditionDigest = latestNewspaperEdition
    ? normalizeNewspaperEditionDigest(latestNewspaperEdition)
    : null;
  const latestBriefing = latestWorkspaceBriefing
    ? normalizeWorkspaceBriefingPayload(latestWorkspaceBriefing.briefingJson)
    : null;
  const storedGeneratedAt = latestWorkspaceBriefing?.generatedAt ?? latestNewspaperEdition?.generatedAt ?? null;
  const legacyNarrative = latestBriefing ? null : legacyEditionNarrative(latestEditionDigest, {
    intro: t("newspaperLegacyIntro"),
    closing: t("newspaperLegacyClosing"),
  });
  const liveNarrativeCandidate = liveWorkspaceNarrative({
    workspaceId,
    articles,
    meetings,
    labels: {
      intro: storedGeneratedAt ? t("newspaperLiveUpdatedIntro") : t("newspaperLiveIntro"),
      closing: t("newspaperLiveClosing"),
    },
  });
  const liveNarrativeIsNewer = !!liveNarrativeCandidate
    && (!storedGeneratedAt || liveNarrativeCandidate.latestActivityAt > storedGeneratedAt.getTime());
  const useLiveNarrative = !!liveNarrativeCandidate
    && ((!latestBriefing && !legacyNarrative) || liveNarrativeIsNewer);
  const displayedBriefing = useLiveNarrative ? null : latestBriefing;
  const fallbackNarrative = useLiveNarrative ? null : legacyNarrative;
  const liveNarrative = useLiveNarrative ? liveNarrativeCandidate : null;
  const generatedAt = useLiveNarrative ? null : storedGeneratedAt;
  const displayedEditionPeriod: DisplayedEditionPeriod = displayedBriefing?.period
    ?? (fallbackNarrative ? (latestNewspaperEdition?.cadence === "WEEKLY" ? "WEEKLY" : "DAILY") : null);
  const displayedEditionLabel = displayedEditionPeriod === "WEEKLY"
    ? t("weeklyEdition")
    : displayedEditionPeriod === "DAILY"
      ? t("dailyEdition")
      : t("workspaceEdition");
  const unreadNotificationsDisplayCount = capDashboardUnreadNotificationCount(unreadNotificationsCount);
  const isUnreadNotificationsCountCapped = isDashboardUnreadNotificationCountCapped(unreadNotificationsCount);
  const notificationLabel = unreadNotificationsCount > 0
    ? t(isUnreadNotificationsCountCapped ? "unreadNotificationsSummaryCapped" : "unreadNotificationsSummary", {
      count: unreadNotificationsDisplayCount,
    })
    : t("notifications");
  const now = new Date();
  const dateString = format.dateTime(now, {
    weekday: "long",
    year: "numeric",
    month: "long",
    day: "numeric",
  });
  const timeString = format.dateTime(now, {
    hour: "numeric",
    minute: "2-digit",
    timeZoneName: "short",
  });
  const articleTitle = displayedBriefing?.title ?? (fallbackNarrative ? latestNewspaperEdition?.title : null) ?? t("latestWorkspaceBriefing");
  const hasArticle = !!displayedBriefing || !!fallbackNarrative || !!liveNarrative;
  const sourceRefs = displayedBriefing?.sourceRefs ?? liveNarrative?.sourceRefs ?? [];
  const attentionTiles = [
    {
      href: `/workspaces/${workspaceId}/actions?status=OPEN&status=IN_PROGRESS`,
      label: t("attentionActions"),
      counts: workAttentionCounts.actions,
    },
    {
      href: `/workspaces/${workspaceId}/proposals?status=OPEN`,
      label: t("attentionProposals"),
      counts: workAttentionCounts.proposals,
    },
    {
      href: `/workspaces/${workspaceId}/tensions?status=OPEN`,
      label: t("attentionTensions"),
      counts: workAttentionCounts.tensions,
    },
  ];

  return (
    <>
      <header className="nr-masthead nr-newspaper-masthead">
        <div className="nr-newspaper-masthead-main">
          <div>
            <h1>{branding.primaryName}</h1>
            <div className="nr-newspaper-date" suppressHydrationWarning>
              <span>{dateString}</span>
              <span>{timeString}</span>
            </div>
          </div>
          <form action={`/workspaces/${workspaceId}/brain`} method="GET" className="nr-masthead-search nr-newspaper-search">
            <label htmlFor="workspace-newspaper-search">{t("searchLabel")}</label>
            <input
              id="workspace-newspaper-search"
              name="q"
              type="text"
              placeholder={t("searchPlaceholder")}
            />
          </form>
        </div>
      </header>

      <div className="nr-newspaper-actions">
        <Link href={`/workspaces/${workspaceId}/notifications`} className="nr-newspaper-action-button nr-newspaper-notification-pill">
          {notificationLabel}
        </Link>
      </div>

      <section className="nr-home-attention-strip" aria-label={t("attentionStripLabel")}>
        {attentionTiles.map((tile) => {
          const hasPersonalCount = tile.counts.personalCount !== null;
          return (
            <Link
              key={tile.href}
              href={tile.href}
              className="nr-home-attention-tile"
              aria-label={hasPersonalCount
                ? t("attentionTileAria", {
                  label: tile.label,
                  personal: tile.counts.personalCount ?? 0,
                  total: tile.counts.totalCount,
                })
                : t("attentionTileTotalAria", {
                  label: tile.label,
                  total: tile.counts.totalCount,
                })}
            >
              <span className="nr-home-attention-title">{tile.label}</span>
              <span className={`nr-home-attention-metrics ${hasPersonalCount ? "" : "nr-home-attention-metrics-single"}`}>
                {hasPersonalCount && (
                  <span className="nr-home-attention-metric">
                    <strong>{tile.counts.personalCount}</strong>
                    <span>{t("attentionForYou")}</span>
                  </span>
                )}
                <span className="nr-home-attention-metric">
                  <strong>{tile.counts.totalCount}</strong>
                  <span>{t("attentionTotalOpen")}</span>
                </span>
              </span>
            </Link>
          );
        })}
      </section>

      <article className="nr-newspaper-page">
        <header className="nr-newspaper-header">
          <p className="nr-newspaper-kicker">
            {displayedEditionLabel}
            {generatedAt && (
              <>
                <span> · </span>
                <span suppressHydrationWarning>
                  {t("generatedOn", {
                    date: format.dateTime(generatedAt, {
                      month: "short",
                      day: "numeric",
                      hour: "numeric",
                      minute: "2-digit",
                    }),
                  })}
                </span>
              </>
            )}
          </p>
          <h2>{articleTitle}</h2>
        </header>

        {displayedBriefing ? (
          <div className="nr-newspaper-body">
            <NewspaperSection title={t("newspaperSectionOverview")} markdown={displayedBriefing.introMd} />
            <NewspaperSection title={t("newspaperSectionLead")} markdown={displayedBriefing.leadMd} className="nr-newspaper-lead" />
            <NewspaperSection title={t("newspaperSectionMore")} markdown={displayedBriefing.bodyMd} />
            <NewspaperSection title={t("newspaperSectionAttention")} markdown={displayedBriefing.attentionMd} />
            <NewspaperSection title={t("newspaperSectionContinuing")} markdown={displayedBriefing.continuingContextMd} />
            <NewspaperSection title={t("newspaperSectionEditorNote")} markdown={displayedBriefing.closingMd} className="nr-newspaper-closing" />
          </div>
        ) : fallbackNarrative ? (
          <div className="nr-newspaper-body">
            <NewspaperSection title={t("newspaperSectionOverview")} markdown={fallbackNarrative.introMd} />
            <NewspaperSection title={t("newspaperSectionLead")} markdown={fallbackNarrative.leadMd} className="nr-newspaper-lead" />
            <NewspaperSection title={t("newspaperSectionMore")} markdown={fallbackNarrative.bodyMd} />
            <NewspaperSection title={t("newspaperSectionEditorNote")} markdown={fallbackNarrative.closingMd} className="nr-newspaper-closing" />
            {latestNewspaperEdition && (
              <p>
                <Link href={`/workspaces/${workspaceId}/brain/${latestNewspaperEdition.slug}`} className="nr-newspaper-action-button nr-newspaper-inline-button">
                  {t("readFullEdition")}
                </Link>
              </p>
            )}
          </div>
        ) : liveNarrative ? (
          <div className="nr-newspaper-body">
            <NewspaperSection title={t("newspaperSectionOverview")} markdown={liveNarrative.introMd} />
            <NewspaperSection title={t("newspaperSectionLead")} markdown={liveNarrative.leadMd} className="nr-newspaper-lead" />
            <NewspaperSection title={t("newspaperSectionMore")} markdown={liveNarrative.bodyMd} />
            <NewspaperSection title={t("newspaperSectionEditorNote")} markdown={liveNarrative.closingMd} className="nr-newspaper-closing" />
          </div>
        ) : (
          <div className="nr-newspaper-body">
            <p>{t("newspaperEmptyBody")}</p>
          </div>
        )}

        {sourceRefs.length ? (
          <footer className="nr-newspaper-sources">
            <span>{t("sourceTrail")}</span>
            <div>
              {sourceRefs.slice(0, 12).map((ref) => {
                if (!ref.href) return <span key={`${ref.type}-${ref.id}`}>{ref.label}</span>;
                return isExternalHref(ref.href) ? (
                  <a key={`${ref.type}-${ref.id}`} href={ref.href} target="_blank" rel="noopener noreferrer">
                    {ref.label}
                  </a>
                ) : (
                  <Link key={`${ref.type}-${ref.id}`} href={ref.href}>
                    {ref.label}
                  </Link>
                );
              })}
            </div>
          </footer>
        ) : null}
      </article>

      {!hasArticle && (
        <p className="nr-newspaper-empty">
          {t("newspaperWaiting")}
        </p>
      )}

      <div className="nr-footer">
        {t("footerStats", {
          articles: articles.length,
          meetings: meetings.length,
          chunks: chunksCount,
          members: membersCount,
        })}
      </div>
    </>
  );
}
