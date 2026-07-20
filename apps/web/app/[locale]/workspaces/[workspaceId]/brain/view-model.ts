export const BRAIN_ARTICLE_TYPES = [
  "PRODUCT",
  "ARCHITECTURE",
  "PROCESS",
  "RUNBOOK",
  "DECISION",
  "TEAM",
  "PERSON",
  "CUSTOMER",
  "INCIDENT",
  "PROJECT",
  "INTEGRATION",
  "PATTERN",
  "STRATEGY",
  "CULTURE",
  "GLOSSARY",
  "DIGEST",
] as const;

export type BrainArticleTypeValue = typeof BRAIN_ARTICLE_TYPES[number];
export type BrainRange = "30d" | "90d" | "all";

export type BrainSearchParams = Record<string, string | string[] | undefined>;

export type BrainActorSummary = {
  kind: "agent" | "user";
};

export type BrainMembershipSummary = {
  id?: string | null;
  role?: string | null;
} | null | undefined;

export type BrainArticleDirectoryItem = {
  id: string;
  slug: string;
  title: string;
  type: string;
  authority: string;
  bodyMd: string;
  ownerMemberId?: string | null;
  ownerMember?: {
    user: {
      displayName?: string | null;
      email: string;
    };
  } | null;
  isPrivate?: boolean;
  createdAt?: Date | string;
  updatedAt: Date | string;
  _count?: {
    backlinksTo?: number;
    discussions?: number;
  };
};

export type BrainTimedRecord = {
  recordedAt?: Date | string;
  createdAt?: Date | string;
};

export type BrainSearchResultLike = {
  sourceId: string;
  sourceType: string;
};

export type ResolvedBrainSearchResult<T extends BrainSearchResultLike> = T & {
  articleSlug: string | null;
};

export type BrainTypeCount = {
  type: string;
  count: number;
};

export type BrainTypeSummary<T extends BrainArticleDirectoryItem> = BrainTypeCount & {
  sampleArticles: T[];
  remainingCount: number;
};

export type BrainIndexState<TArticle extends BrainArticleDirectoryItem, TMeeting extends BrainTimedRecord, TDocument extends BrainTimedRecord> = {
  query: string;
  question: string;
  range: BrainRange;
  selectedType: BrainArticleTypeValue | null;
  typeCounts: BrainTypeCount[];
  visibleArticles: TArticle[];
  typeSummaries: Array<BrainTypeSummary<TArticle>>;
  meetings: TMeeting[];
  documents: TDocument[];
};

const TYPE_ORDER = new Map<string, number>(BRAIN_ARTICLE_TYPES.map((type, index) => [type, index]));

export function firstSearchParam(value: string | string[] | undefined) {
  return Array.isArray(value) ? value[0] : value;
}

export function normalizeBrainRange(value: string | string[] | undefined): BrainRange {
  const candidate = firstSearchParam(value);
  if (candidate === "90d" || candidate === "all") return candidate;
  return "30d";
}

export function normalizeBrainArticleType(value: string | string[] | undefined): BrainArticleTypeValue | null {
  const candidate = firstSearchParam(value);
  return BRAIN_ARTICLE_TYPES.includes(candidate as BrainArticleTypeValue)
    ? candidate as BrainArticleTypeValue
    : null;
}

export function normalizeBrainIndexSearch(searchParams: BrainSearchParams) {
  return {
    query: firstSearchParam(searchParams.q) ?? "",
    question: firstSearchParam(searchParams.question) ?? "",
    range: normalizeBrainRange(searchParams.range),
    selectedType: normalizeBrainArticleType(searchParams.type),
  };
}

export function getBrainRangeCutoff(range: BrainRange, now = new Date()) {
  if (range === "all") return null;

  const cutoff = new Date(now);
  cutoff.setDate(cutoff.getDate() - (range === "90d" ? 90 : 30));
  return cutoff;
}

export function filterBrainRecordsByRange<T extends BrainTimedRecord>(
  records: T[],
  range: BrainRange,
  key: "recordedAt" | "createdAt",
  now = new Date(),
) {
  const cutoff = getBrainRangeCutoff(range, now);
  if (!cutoff) return records;

  return records.filter((record) => {
    const value = record[key];
    if (!value) return false;
    return new Date(value).getTime() >= cutoff.getTime();
  });
}

export function canManageBrainArticle(
  actor: BrainActorSummary,
  membership: BrainMembershipSummary,
  article: { ownerMemberId?: string | null },
) {
  return actor.kind === "agent"
    || membership?.role === "ADMIN"
    || (Boolean(article.ownerMemberId) && article.ownerMemberId === membership?.id);
}

export function buildBrainTypeCounts<T extends { type: string }>(articles: T[]): BrainTypeCount[] {
  const counts = new Map<string, number>();

  for (const article of articles) {
    counts.set(article.type, (counts.get(article.type) ?? 0) + 1);
  }

  return [...counts.entries()]
    .map(([type, count]) => ({ type, count }))
    .sort(compareBrainTypeCounts);
}

export function filterBrainArticlesByType<T extends { type: string }>(
  articles: T[],
  selectedType: string | null | undefined,
) {
  if (!selectedType) return articles;
  return articles.filter((article) => article.type === selectedType);
}

export function buildBrainTypeSummaries<T extends BrainArticleDirectoryItem>(
  articles: T[],
  sampleSize = 3,
): Array<BrainTypeSummary<T>> {
  const grouped = new Map<string, T[]>();

  for (const article of articles) {
    const group = grouped.get(article.type) ?? [];
    group.push(article);
    grouped.set(article.type, group);
  }

  return [...grouped.entries()]
    .map(([type, typeArticles]) => ({
      type,
      count: typeArticles.length,
      sampleArticles: typeArticles.slice(0, sampleSize),
      remainingCount: Math.max(0, typeArticles.length - sampleSize),
    }))
    .sort(compareBrainTypeCounts);
}

export function resolveBrainSearchResults<T extends BrainSearchResultLike>(
  results: T[],
  articles: Array<{ id: string; slug: string }>,
): Array<ResolvedBrainSearchResult<T>> {
  const slugById = new Map(articles.map((article) => [article.id, article.slug]));
  const slugSet = new Set(articles.map((article) => article.slug));

  return results.map((result) => ({
    ...result,
    articleSlug: slugById.get(result.sourceId) ?? (slugSet.has(result.sourceId) ? result.sourceId : null),
  }));
}

export function buildBrainIndexHref(params: {
  query?: string;
  question?: string;
  range?: BrainRange;
  type?: string | null;
}) {
  const query = new URLSearchParams();

  if (params.query?.trim()) query.set("q", params.query.trim());
  if (params.question?.trim()) query.set("question", params.question.trim());
  if (params.range && params.range !== "30d") query.set("range", params.range);
  if (params.type) query.set("type", params.type);

  const serialized = query.toString();
  return serialized ? `?${serialized}` : "?";
}

export function buildBrainIndexState<
  TArticle extends BrainArticleDirectoryItem,
  TMeeting extends BrainTimedRecord,
  TDocument extends BrainTimedRecord,
>(params: {
  articles: TArticle[];
  meetings: TMeeting[];
  documents: TDocument[];
  searchParams: BrainSearchParams;
  now?: Date;
}): BrainIndexState<TArticle, TMeeting, TDocument> {
  const normalized = normalizeBrainIndexSearch(params.searchParams);

  return {
    ...normalized,
    typeCounts: buildBrainTypeCounts(params.articles),
    visibleArticles: filterBrainArticlesByType(params.articles, normalized.selectedType),
    typeSummaries: buildBrainTypeSummaries(params.articles),
    meetings: filterBrainRecordsByRange(params.meetings, normalized.range, "recordedAt", params.now),
    documents: filterBrainRecordsByRange(params.documents, normalized.range, "createdAt", params.now),
  };
}

function compareBrainTypeCounts(left: BrainTypeCount, right: BrainTypeCount) {
  const countDelta = right.count - left.count;
  if (countDelta !== 0) return countDelta;

  const leftOrder = TYPE_ORDER.get(left.type) ?? Number.MAX_SAFE_INTEGER;
  const rightOrder = TYPE_ORDER.get(right.type) ?? Number.MAX_SAFE_INTEGER;
  if (leftOrder !== rightOrder) return leftOrder - rightOrder;

  return left.type.localeCompare(right.type);
}
