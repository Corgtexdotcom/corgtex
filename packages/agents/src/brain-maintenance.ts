import { prisma } from "@corgtex/shared";
import type { AppActor } from "@corgtex/shared";
import { rebuildBacklinks, markThreadAbsorbed, WIKILINK_RE } from "@corgtex/domain";

const STALE_THREAD_DAYS = 30;
const TIER3_MAX_AGE_MS = 6 * 30 * 24 * 60 * 60 * 1000; // ~6 months

/**
 * Weekly maintenance agent for the Brain.
 *
 * Steps:
 * 1. Freshness scan — flag stale articles
 * 2. Dead link scan — find broken [[wikilinks]]
 * 3. Orphan detection — articles with no inbound backlinks
 * 4. Tier 3 cleanup — old external context not actively referenced
 * 5. Backlink rebuild — full rebuild
 * 6. Discussion maintenance — surface stale threads, absorb resolved ones
 */
export async function runBrainMaintenance(params: {
  workspaceId: string;
  agentRunId: string;
}) {
  const agentActor: AppActor = {
    kind: "agent",
    authProvider: "bootstrap",
    label: "brain-maintenance",
  };

  const articles = await prisma.brainArticle.findMany({
    where: { workspaceId: params.workspaceId },
    select: {
      id: true,
      slug: true,
      title: true,
      type: true,
      authority: true,
      bodyMd: true,
      ownerMemberId: true,
      lastVerifiedAt: true,
      staleAfterDays: true,
      createdAt: true,
      frontmatterJson: true,
    },
  });

  // --- Step 1: Freshness scan ---
  const now = Date.now();
  const staleArticleIds: string[] = [];

  for (const article of articles) {
    const staleMs = article.staleAfterDays * 24 * 60 * 60 * 1000;
    const baseDate = article.lastVerifiedAt
      ? new Date(article.lastVerifiedAt).getTime()
      : new Date(article.createdAt).getTime();

    if (now - baseDate > staleMs) {
      staleArticleIds.push(article.id);
    }
  }

  // --- Step 2: Dead link scan ---
  const slugSet = new Set(articles.map((a) => a.slug));
  const titleToSlug = new Map<string, string>();
  for (const article of articles) {
    titleToSlug.set(article.title.toLowerCase(), article.slug);
    const frontmatter = article.frontmatterJson as Record<string, unknown> | null;
    const aliases = Array.isArray(frontmatter?.also) ? (frontmatter.also as string[]) : [];
    for (const alias of aliases) {
      titleToSlug.set(alias.toLowerCase(), article.slug);
    }
  }

  const deadLinks: Array<{ articleSlug: string; brokenRef: string }> = [];

  for (const article of articles) {
    const matches = article.bodyMd.matchAll(WIKILINK_RE);
    for (const match of matches) {
      const ref = match[1].trim();
      const targetSlug = ref.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
      const resolved = slugSet.has(targetSlug) || slugSet.has(ref) || titleToSlug.has(ref.toLowerCase());
      if (!resolved) {
        deadLinks.push({ articleSlug: article.slug, brokenRef: ref });
      }
    }
  }

  // --- Step 3: Orphan detection ---
  const backlinks = await prisma.brainBacklink.findMany({
    where: { workspaceId: params.workspaceId },
    select: { toArticleId: true },
  });
  const linkedIds = new Set(backlinks.map((b) => b.toArticleId));
  const orphanArticles = articles.filter((a) => !linkedIds.has(a.id)).map((a) => a.slug);

  // --- Step 4: Tier 3 cleanup ---
  const oldTier3Sources = await prisma.brainSource.findMany({
    where: {
      workspaceId: params.workspaceId,
      tier: 3,
      createdAt: { lt: new Date(now - TIER3_MAX_AGE_MS) },
    },
    select: { id: true, title: true },
  });

  // --- Step 5: Backlink rebuild ---
  const { linkCount } = await rebuildBacklinks(agentActor, {
    workspaceId: params.workspaceId,
  });

  // --- Step 6: Discussion maintenance ---
  const staleThreshold = new Date(now - STALE_THREAD_DAYS * 24 * 60 * 60 * 1000);

  const staleOpenThreads = await prisma.brainDiscussionThread.findMany({
    where: {
      article: { workspaceId: params.workspaceId },
      status: "OPEN",
      createdAt: { lt: staleThreshold },
    },
    include: {
      comments: {
        orderBy: { createdAt: "desc" },
        take: 1,
        select: { createdAt: true },
      },
    },
  });

  const staleThreadIds = staleOpenThreads
    .filter((t) => {
      const lastActivity = t.comments[0]?.createdAt ?? t.createdAt;
      return new Date(lastActivity).getTime() < staleThreshold.getTime();
    })
    .map((t) => t.id);

  // Auto-absorb resolved threads
  const resolvedThreads = await prisma.brainDiscussionThread.findMany({
    where: {
      article: { workspaceId: params.workspaceId },
      status: "RESOLVED",
    },
    select: { id: true },
  });

  for (const thread of resolvedThreads) {
    try {
      await markThreadAbsorbed(agentActor, {
        workspaceId: params.workspaceId,
        threadId: thread.id,
      });
    } catch {
      // Skip threads that fail absorption (e.g. race condition)
    }
  }

  // --- Step 7: Event retention cleanup ---
  const retentionThreshold = new Date(now - 15 * 24 * 60 * 60 * 1000);
  const deletedEvents = await prisma.knowledgeChunk.deleteMany({
    where: {
      workspaceId: params.workspaceId,
      sourceType: "EVENT",
      createdAt: { lt: retentionThreshold },
    },
  });

  return {
    staleArticleCount: staleArticleIds.length,
    deadLinkCount: deadLinks.length,
    deadLinks: deadLinks.slice(0, 20),
    orphanCount: orphanArticles.length,
    orphans: orphanArticles.slice(0, 20),
    tier3CleanupCandidates: oldTier3Sources.length,
    backlinkCount: linkCount,
    staleThreadCount: staleThreadIds.length,
    absorbedThreadCount: resolvedThreads.length,
    prunedEventsCount: deletedEvents.count,
  };
}
