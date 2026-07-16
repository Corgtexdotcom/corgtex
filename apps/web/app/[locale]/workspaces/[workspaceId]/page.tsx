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
import {
  capDashboardUnreadNotificationCount,
  isDashboardUnreadNotificationCountCapped,
} from "@/lib/dashboard-briefing";

export const dynamic = "force-dynamic";

function isExternalHref(href: string) {
  return href.startsWith("http://") || href.startsWith("https://");
}

function legacyEditionNarrative(editionDigest: ReturnType<typeof normalizeNewspaperEditionDigest> | null) {
  if (!editionDigest) return null;
  const items = editionDigest.sections.flatMap((section) => section.items).filter(Boolean);
  return {
    introMd: editionDigest.intro ?? "This edition was generated before the narrative briefing format. The source items are shown as one readable update.",
    leadMd: items[0] ?? null,
    bodyMd: items.slice(1, 5).join("\n\n") || null,
    closingMd: "Open the full edition if you need the older sectioned source view.",
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
    latestWorkspaceBriefing,
    newspaperEditions,
    meetings,
    chunksCount,
    workspaceData,
  ] = await Promise.all([
    listMembers(workspaceId),
    actor.kind === "user" ? countUnreadNotifications(actor.user.id, workspaceId) : Promise.resolve(0),
    listArticles(actor, { workspaceId, take: 50 }),
    getLatestWorkspaceBriefing({ actor, workspaceId, period: "DAILY" }),
    listNewspaperEditions(actor, workspaceId, { take: 1 }),
    listMeetings(workspaceId, { status: "COMPLETED" }),
    prisma.knowledgeChunk.count({ where: { workspaceId } }),
    prisma.workspace.findUnique({ where: { id: workspaceId }, select: { slug: true, name: true } }),
  ]);

  const branding = workspaceData
    ? workspaceBranding(workspaceData)
    : { primaryName: "Corgtex", secondaryLabel: "powered by Corgtex" };
  const currentMember = actor.kind === "user" ? members.find((member) => member.userId === actor.user.id) : undefined;
  const latestNewspaperEdition = newspaperEditions[0] ?? null;
  const latestEditionDigest = latestNewspaperEdition
    ? normalizeNewspaperEditionDigest(latestNewspaperEdition)
    : null;
  const latestBriefing = latestWorkspaceBriefing
    ? normalizeWorkspaceBriefingPayload(latestWorkspaceBriefing.briefingJson)
    : null;
  const fallbackNarrative = latestBriefing ? null : legacyEditionNarrative(latestEditionDigest);
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
  const hasArticle = !!latestBriefing || !!fallbackNarrative;

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
            <MarkdownRenderer markdown={latestBriefing.introMd} variant="document" />
            <MarkdownRenderer markdown={latestBriefing.leadMd} variant="document" className="nr-newspaper-lead" />
            <MarkdownRenderer markdown={latestBriefing.bodyMd} variant="document" />
            <MarkdownRenderer markdown={latestBriefing.attentionMd} variant="document" />
            <MarkdownRenderer markdown={latestBriefing.continuingContextMd} variant="document" />
            <MarkdownRenderer markdown={latestBriefing.closingMd} variant="document" className="nr-newspaper-closing" />
          </div>
        ) : fallbackNarrative ? (
          <div className="nr-newspaper-body">
            <MarkdownRenderer markdown={fallbackNarrative.introMd} variant="document" />
            <MarkdownRenderer markdown={fallbackNarrative.leadMd} variant="document" className="nr-newspaper-lead" />
            <MarkdownRenderer markdown={fallbackNarrative.bodyMd} variant="document" />
            <MarkdownRenderer markdown={fallbackNarrative.closingMd} variant="document" className="nr-newspaper-closing" />
            {latestNewspaperEdition && (
              <p>
                <Link href={`/workspaces/${workspaceId}/brain/${latestNewspaperEdition.slug}`} className="nr-link">
                  {t("readFullEdition")}
                </Link>
              </p>
            )}
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
