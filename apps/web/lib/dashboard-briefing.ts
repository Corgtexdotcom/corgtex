const FRESH_KNOWLEDGE_WINDOW_DAYS = 14;

type DashboardBrainArticle = {
  id: string;
  authority: string;
  isPrivate: boolean;
  createdAt: Date;
  updatedAt: Date;
};

type DashboardFeedBrainArticle = DashboardBrainArticle & {
  title: string;
  slug: string;
  type: string;
  bodyMd: string;
};

type DashboardMeeting = {
  id: string;
  recordedAt: Date;
  title?: string | null;
  source?: string | null;
  summaryMd?: string | null;
};

type DashboardProposal = {
  id: string;
  status: string;
  isPrivate: boolean;
  archivedAt?: Date | null;
  createdAt: Date;
};

type DashboardAction = {
  id: string;
  status: string;
  isPrivate: boolean;
  archivedAt?: Date | null;
  dueAt?: Date | null;
  createdAt: Date;
};

export type DashboardFeedItem<TArticle extends DashboardFeedBrainArticle = DashboardFeedBrainArticle, TMeeting extends DashboardMeeting = DashboardMeeting> =
  | {
    kind: "ARTICLE";
    id: string;
    label: string;
    title: string;
    bodyMd: string;
    slug: string;
    freshnessAt: Date;
    createdAt: Date;
    updatedAt: Date;
    source: TArticle;
  }
  | {
    kind: "MEETING";
    id: string;
    label: "MEETING";
    title: string | null;
    summaryMd: string | null;
    freshnessAt: Date;
    recordedAt: Date;
    source: TMeeting;
  };

function articleActivityTime(article: DashboardBrainArticle) {
  return Math.max(article.createdAt.getTime(), article.updatedAt.getTime());
}

function articleCreatedTime(article: DashboardBrainArticle) {
  return article.createdAt.getTime();
}

function articleUpdatedTime(article: DashboardBrainArticle) {
  return article.updatedAt.getTime();
}

function freshnessCutoff(now: Date) {
  return now.getTime() - FRESH_KNOWLEDGE_WINDOW_DAYS * 24 * 60 * 60 * 1000;
}

function articleRank(article: DashboardBrainArticle, now: Date) {
  const cutoff = freshnessCutoff(now);
  const createdAt = articleCreatedTime(article);
  const updatedAt = articleUpdatedTime(article);

  if (createdAt >= cutoff) {
    return { tier: 0, timestamp: createdAt };
  }

  if (updatedAt >= cutoff) {
    return { tier: 1, timestamp: updatedAt };
  }

  return { tier: 2, timestamp: createdAt };
}

export function selectDashboardKnowledgeArticles<T extends DashboardBrainArticle>(
  articles: T[],
  now = new Date(),
  limit = 4,
) {
  const cutoff = freshnessCutoff(now);
  const publicArticles = articles.filter((article) => !article.isPrivate);
  const newArticles = publicArticles.filter((article) => articleCreatedTime(article) >= cutoff);
  const recentlyUpdatedArticles = publicArticles.filter((article) => (
    articleCreatedTime(article) < cutoff
    && articleUpdatedTime(article) >= cutoff
  ));
  const stableArticles = publicArticles.filter((article) => (
    article.authority === "AUTHORITATIVE" || article.authority === "REFERENCE"
  ));
  const selectedById = new Map<string, T>();

  const groups = [
    [...newArticles].sort((a, b) => articleCreatedTime(b) - articleCreatedTime(a)),
    [...recentlyUpdatedArticles].sort((a, b) => articleUpdatedTime(b) - articleUpdatedTime(a)),
    [...stableArticles].sort((a, b) => articleCreatedTime(b) - articleCreatedTime(a)),
    [...publicArticles].sort((a, b) => articleCreatedTime(b) - articleCreatedTime(a)),
  ];

  for (const group of groups) {
    for (const article of group) {
      selectedById.set(article.id, article);
      if (selectedById.size >= limit) break;
    }
    if (selectedById.size >= limit) break;
  }

  return [...selectedById.values()];
}

export function selectLatestMeetingRecap<T extends DashboardMeeting>(meetings: T[]) {
  const sorted = [...meetings].sort((a, b) => b.recordedAt.getTime() - a.recordedAt.getTime());
  return sorted.find((meeting) => Boolean(meeting.summaryMd?.trim())) ?? sorted[0] ?? null;
}

export function selectDashboardFeedItems<
  TArticle extends DashboardFeedBrainArticle,
  TMeeting extends DashboardMeeting,
>({
  articles,
  meetings,
  now = new Date(),
  limit = 6,
}: {
  articles: TArticle[];
  meetings: TMeeting[];
  now?: Date;
  limit?: number;
}): Array<DashboardFeedItem<TArticle, TMeeting>> {
  const safeLimit = Math.max(0, Math.floor(limit));
  if (safeLimit === 0) return [];

  const articleItems: Array<DashboardFeedItem<TArticle, TMeeting>> = selectDashboardKnowledgeArticles(
    articles,
    now,
    safeLimit,
  ).map((article) => ({
    kind: "ARTICLE",
    id: article.id,
    label: article.type,
    title: article.title,
    bodyMd: article.bodyMd,
    slug: article.slug,
    freshnessAt: new Date(articleActivityTime(article)),
    createdAt: article.createdAt,
    updatedAt: article.updatedAt,
    source: article,
  }));

  const latestMeeting = selectLatestMeetingRecap(meetings);
  const meetingItem: DashboardFeedItem<TArticle, TMeeting> | null = latestMeeting
    ? {
      kind: "MEETING",
      id: latestMeeting.id,
      label: "MEETING",
      title: latestMeeting.title ?? null,
      summaryMd: latestMeeting.summaryMd ?? null,
      freshnessAt: latestMeeting.recordedAt,
      recordedAt: latestMeeting.recordedAt,
      source: latestMeeting,
    }
    : null;

  const ranked = [...articleItems, ...(meetingItem ? [meetingItem] : [])]
    .sort((a, b) => {
      const aRank = a.kind === "MEETING"
        ? { tier: 0, timestamp: a.recordedAt.getTime() }
        : articleRank(a.source, now);
      const bRank = b.kind === "MEETING"
        ? { tier: 0, timestamp: b.recordedAt.getTime() }
        : articleRank(b.source, now);

      if (aRank.tier !== bRank.tier) return aRank.tier - bRank.tier;
      return bRank.timestamp - aRank.timestamp;
    });

  if (meetingItem) {
    const currentIndex = ranked.findIndex((item) => item.kind === "MEETING" && item.id === meetingItem.id);
    const latestAllowedIndex = Math.min(1, safeLimit - 1);
    if (currentIndex > latestAllowedIndex) {
      ranked.splice(currentIndex, 1);
      ranked.splice(latestAllowedIndex, 0, meetingItem);
    }
  }

  return ranked.slice(0, safeLimit);
}

export function selectDashboardOpenProposals<T extends DashboardProposal>(proposals: T[], limit = 5) {
  return proposals
    .filter((proposal) => (
      proposal.status === "OPEN"
      && !proposal.isPrivate
      && proposal.archivedAt == null
    ))
    .sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime())
    .slice(0, Math.max(0, Math.floor(limit)));
}

export function selectDashboardActionItems<T extends DashboardAction>(actions: T[], limit = 6) {
  return actions
    .filter((action) => (
      (action.status === "OPEN" || action.status === "IN_PROGRESS")
      && !action.isPrivate
      && action.archivedAt == null
    ))
    .sort((a, b) => {
      const aDue = a.dueAt?.getTime() ?? null;
      const bDue = b.dueAt?.getTime() ?? null;
      if (aDue !== null && bDue !== null && aDue !== bDue) return aDue - bDue;
      if (aDue !== null && bDue === null) return -1;
      if (aDue === null && bDue !== null) return 1;
      return b.createdAt.getTime() - a.createdAt.getTime();
    })
    .slice(0, Math.max(0, Math.floor(limit)));
}

export function capDashboardUnreadNotificationCount(count: number) {
  return Math.min(99, Math.max(0, Math.floor(count)));
}

export function isDashboardUnreadNotificationCountCapped(count: number) {
  return Math.floor(count) > 99;
}

export function selectDashboardNotificationPreviewLimit(unreadCount: number) {
  return unreadCount > 20 ? 2 : 3;
}
