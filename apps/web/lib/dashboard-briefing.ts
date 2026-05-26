const FRESH_KNOWLEDGE_WINDOW_DAYS = 14;

type DashboardBrainArticle = {
  id: string;
  authority: string;
  isPrivate: boolean;
  createdAt: Date;
  updatedAt: Date;
};

type DashboardMeeting = {
  id: string;
  recordedAt: Date;
  summaryMd?: string | null;
};

function articleActivityTime(article: DashboardBrainArticle) {
  return Math.max(article.createdAt.getTime(), article.updatedAt.getTime());
}

export function selectDashboardKnowledgeArticles<T extends DashboardBrainArticle>(
  articles: T[],
  now = new Date(),
  limit = 4,
) {
  const cutoff = now.getTime() - FRESH_KNOWLEDGE_WINDOW_DAYS * 24 * 60 * 60 * 1000;
  const publicArticles = articles.filter((article) => !article.isPrivate);
  const freshArticles = publicArticles.filter((article) => articleActivityTime(article) >= cutoff);
  const stableArticles = publicArticles.filter((article) => (
    article.authority === "AUTHORITATIVE" || article.authority === "REFERENCE"
  ));
  const selectedById = new Map<string, T>();
  for (const group of [freshArticles, stableArticles, publicArticles]) {
    for (const article of [...group].sort((a, b) => articleActivityTime(b) - articleActivityTime(a))) {
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
