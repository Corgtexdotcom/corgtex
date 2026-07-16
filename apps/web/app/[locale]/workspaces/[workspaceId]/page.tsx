import {
  countUnreadNotifications,
  getLatestWorkspaceBriefing,
  listArticles,
  listMeetings,
  listMembers,
  listNewspaperEditions,
  normalizeNewspaperEditionDigest,
  normalizeWorkspaceBriefingPayload,
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
  articles: Array<{
    title: string;
    bodyMd?: string | null;
    type?: string | null;
    updatedAt?: Date | string | null;
    publishedAt?: Date | string | null;
    createdAt?: Date | string | null;
  }>;
  meetings: Array<{
    title?: string | null;
    summaryMd?: string | null;
    recordedAt?: Date | string | null;
    updatedAt?: Date | string | null;
    createdAt?: Date | string | null;
  }>;
  labels: { intro: string; closing: string };
}) {
  const entries = [
    ...params.meetings.slice(0, 4).map((meeting) => ({
      occurredAt: new Date(meeting.updatedAt ?? meeting.recordedAt ?? meeting.createdAt ?? 0).getTime(),
      line: narrativeLine(meeting.title || "Meeting recap", compactNarrativeText(meeting.summaryMd, 620)),
    })),
    ...params.articles
      .filter((article) => article.type !== "DIGEST")
      .slice(0, 4)
      .map((article) => ({
        occurredAt: new Date(article.publishedAt ?? article.updatedAt ?? article.createdAt ?? 0).getTime(),
        line: narrativeLine(article.title, compactNarrativeText(article.bodyMd, 560)),
      })),
  ]
    .filter((entry) => entry.line.trim())
    .sort((left, right) => right.occurredAt - left.occurredAt)
    .slice(0, 5);

  if (entries.length === 0) return null;
  return {
    introMd: params.labels.intro,
    leadMd: entries[0]?.line ?? null,
    bodyMd: entries.slice(1).map((entry) => entry.line).join("\n\n") || null,
    closingMd: params.labels.closing,
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

  const [
    members,
    unreadNotificationsCount,
    articlesResult,
    latestDailyWorkspaceBriefing,
    latestWeeklyWorkspaceBriefing,
    newspaperEditions,
    meetings,
    chunksCount,
    workspaceData,
  ] = await Promise.all([
    listMembers(workspaceId),
    actor.kind === "user" ? countUnreadNotifications(actor.user.id, workspaceId) : Promise.resolve(0),
    listArticles(actor, { workspaceId, take: 50 }),
    getLatestWorkspaceBriefing({ actor, workspaceId, period: "DAILY" }),
    getLatestWorkspaceBriefing({ actor, workspaceId, period: "WEEKLY" }),
    listNewspaperEditions(actor, workspaceId, { take: 1 }),
    listMeetings(workspaceId, { status: "COMPLETED" }),
    prisma.knowledgeChunk.count({ where: { workspaceId } }),
    prisma.workspace.findUnique({ where: { id: workspaceId }, select: { slug: true, name: true } }),
  ]);

  const branding = workspaceData
    ? workspaceBranding(workspaceData)
    : { primaryName: "Corgtex", secondaryLabel: "powered by Corgtex" };
  const currentMember = actor.kind === "user" ? members.find((member) => member.userId === actor.user.id) : undefined;
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
  const fallbackNarrative = latestBriefing ? null : legacyEditionNarrative(latestEditionDigest, {
    intro: t("newspaperLegacyIntro"),
    closing: t("newspaperLegacyClosing"),
  });
  const liveNarrative = latestBriefing || fallbackNarrative ? null : liveWorkspaceNarrative({
    articles: articlesResult.items,
    meetings,
    labels: {
      intro: t("newspaperLiveIntro"),
      closing: t("newspaperLiveClosing"),
    },
  });
  const generatedAt = latestWorkspaceBriefing?.generatedAt ?? latestNewspaperEdition?.generatedAt ?? null;
  const displayedEditionPeriod = latestBriefing?.period ?? (latestNewspaperEdition?.cadence === "WEEKLY" ? "WEEKLY" : "DAILY");
  const unreadNotificationsDisplayCount = capDashboardUnreadNotificationCount(unreadNotificationsCount);
  const isUnreadNotificationsCountCapped = isDashboardUnreadNotificationCountCapped(unreadNotificationsCount);
  const notificationLabel = unreadNotificationsCount > 0
    ? t(isUnreadNotificationsCountCapped ? "unreadNotificationsSummaryCapped" : "unreadNotificationsSummary", {
      count: unreadNotificationsDisplayCount,
    })
    : t("notifications");
  const dateString = format.dateTime(new Date(), {
    weekday: "long",
    year: "numeric",
    month: "long",
    day: "numeric",
  });
  const articleTitle = latestBriefing?.title ?? latestNewspaperEdition?.title ?? t("latestWorkspaceBriefing");
  const hasArticle = !!latestBriefing || !!fallbackNarrative || !!liveNarrative;

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

      <div className="nr-newspaper-actions">
        {currentMember?.id && (
          <Link href={`/workspaces/${workspaceId}/members/${currentMember.id}`} className="nr-link">
            {t("viewFullProfile")}
          </Link>
        )}
        <Link href={`/workspaces/${workspaceId}/chat`} className="nr-newspaper-assistant-pill ws-assistant-launch">
          {t("askAgent")}
        </Link>
        <Link href={`/workspaces/${workspaceId}/notifications`} className="nr-newspaper-notification-pill">
          {notificationLabel}
        </Link>
      </div>

      <article className="nr-newspaper-page">
        <header className="nr-newspaper-header">
          <p className="nr-newspaper-kicker">
            {displayedEditionPeriod === "WEEKLY" ? t("weeklyEdition") : t("dailyEdition")}
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

        {latestBriefing ? (
          <div className="nr-newspaper-body">
            <MarkdownRenderer markdown={latestBriefing.introMd} variant="document" allowImages={false} />
            <MarkdownRenderer markdown={latestBriefing.leadMd} variant="document" className="nr-newspaper-lead" allowImages={false} />
            <MarkdownRenderer markdown={latestBriefing.bodyMd} variant="document" allowImages={false} />
            <MarkdownRenderer markdown={latestBriefing.attentionMd} variant="document" allowImages={false} />
            <MarkdownRenderer markdown={latestBriefing.continuingContextMd} variant="document" allowImages={false} />
            <MarkdownRenderer markdown={latestBriefing.closingMd} variant="document" className="nr-newspaper-closing" allowImages={false} />
          </div>
        ) : fallbackNarrative ? (
          <div className="nr-newspaper-body">
            <MarkdownRenderer markdown={fallbackNarrative.introMd} variant="document" allowImages={false} />
            <MarkdownRenderer markdown={fallbackNarrative.leadMd} variant="document" className="nr-newspaper-lead" allowImages={false} />
            <MarkdownRenderer markdown={fallbackNarrative.bodyMd} variant="document" allowImages={false} />
            <MarkdownRenderer markdown={fallbackNarrative.closingMd} variant="document" className="nr-newspaper-closing" allowImages={false} />
            {latestNewspaperEdition && (
              <p>
                <Link href={`/workspaces/${workspaceId}/brain/${latestNewspaperEdition.slug}`} className="nr-link">
                  {t("readFullEdition")}
                </Link>
              </p>
            )}
          </div>
        ) : liveNarrative ? (
          <div className="nr-newspaper-body">
            <MarkdownRenderer markdown={liveNarrative.introMd} variant="document" allowImages={false} />
            <MarkdownRenderer markdown={liveNarrative.leadMd} variant="document" className="nr-newspaper-lead" allowImages={false} />
            <MarkdownRenderer markdown={liveNarrative.bodyMd} variant="document" allowImages={false} />
            <MarkdownRenderer markdown={liveNarrative.closingMd} variant="document" className="nr-newspaper-closing" allowImages={false} />
          </div>
        ) : (
          <div className="nr-newspaper-body">
            <p>{t("newspaperEmptyBody")}</p>
          </div>
        )}

        {latestBriefing?.sourceRefs.length ? (
          <footer className="nr-newspaper-sources">
            <span>{t("sourceTrail")}</span>
            <div>
              {latestBriefing.sourceRefs.slice(0, 12).map((ref) => {
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
          articles: articlesResult.items.length,
          meetings: meetings.length,
          chunks: chunksCount,
          members: members.length,
        })}
      </div>
    </>
  );
}
