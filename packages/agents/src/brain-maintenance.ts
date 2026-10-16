import { prisma } from "@corgtex/shared";
import type { AppActor } from "@corgtex/shared";
import { rebuildBacklinks, markThreadAbsorbed, readableArtifactIds, captureArtifactInputProof, captureImmutableArtifactInputProof, isArtifactInputProofReadable, withArtifactInputReadCapture, invariant, WIKILINK_RE, type LineageInput } from "@corgtex/domain";

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
  actor?: AppActor;
}) {
  const agentActor: AppActor = params.actor ?? {
    kind: "agent",
    authProvider: "bootstrap",
    label: "brain-maintenance",
    workspaceIds: [params.workspaceId],
  };

  const candidates = await prisma.brainArticle.findMany({
    where: { workspaceId: params.workspaceId, archivedAt: null }, take: 5001,
  });
  invariant(candidates.length <= 5000, 503, "SOURCE_READ_SCAN_LIMIT", "Maintenance article scan exceeds its supported size.");
  const inputs: Array<LineageInput & { snapshot?: Record<string, unknown> }> = [{kind: "Workspace", id: params.workspaceId}];
  const readableIds = await readableArtifactIds(agentActor, params.workspaceId, "BrainArticle", candidates);
  const articles = candidates.filter((article) => readableIds.has(article.id));
  inputs.push(...articles.map(snapshot => ({kind: "BrainArticle" as const, id: snapshot.id, snapshot})));

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
  // Derive link existence only from the same admitted article revisions.
  const slugToId = new Map(articles.map(article => [article.slug, article.id]));
  const linkedIds = new Set<string>();
  for (const article of articles) for (const match of article.bodyMd.matchAll(WIKILINK_RE)) {
    const ref = match[1].trim();
    const slug = ref.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
    const target = slugToId.get(slug) ?? slugToId.get(ref) ?? slugToId.get(titleToSlug.get(ref.toLowerCase()) ?? "");
    if (target && target !== article.id) linkedIds.add(target);
  }
  const orphanArticles = articles.filter((a) => !linkedIds.has(a.id)).map((a) => a.slug);

  // --- Step 4: Tier 3 cleanup ---
  const oldSourceCandidates = await prisma.brainSource.findMany({
    where: {
      workspaceId: params.workspaceId,
      tier: 3,
      createdAt: { lt: new Date(now - TIER3_MAX_AGE_MS) },
    },
    take: 5001,
  });

  invariant(oldSourceCandidates.length <= 5000, 503, "SOURCE_READ_SCAN_LIMIT", "Maintenance source scan exceeds its supported size.");
  const oldSourceIds = await readableArtifactIds(agentActor, params.workspaceId, "BrainSource", oldSourceCandidates);
  const oldTier3Sources = oldSourceCandidates.filter(row => oldSourceIds.has(row.id));
  inputs.push(...oldTier3Sources.map(snapshot => ({kind: "BrainSource" as const, id: snapshot.id, snapshot})));

  // --- Step 6: Discussion maintenance ---
  const staleThreshold = new Date(now - STALE_THREAD_DAYS * 24 * 60 * 60 * 1000);

  const threadCandidates = await prisma.brainDiscussionThread.findMany({
    where: { article: { workspaceId: params.workspaceId }, status: { in: ["OPEN", "RESOLVED"] } },
    include: { comments: { orderBy: {createdAt: "desc"}, take: 5001 } }, take: 5001,
  });
  invariant(threadCandidates.length <= 5000, 503, "SOURCE_READ_SCAN_LIMIT", "Maintenance discussion scan exceeds its supported size.");
  const threadIds = await readableArtifactIds(agentActor, params.workspaceId, "BrainDiscussionThread", threadCandidates);
  const threads = threadCandidates.filter(row => threadIds.has(row.id));
  invariant(threads.every(thread => thread.comments.length <= 5000), 503, "SOURCE_READ_SCAN_LIMIT", "Maintenance comment scan exceeds its supported size.");
  const commentIds = await readableArtifactIds(agentActor, params.workspaceId, "BrainDiscussionComment", threads.flatMap(thread => thread.comments));
  const comments = threads.flatMap(thread => thread.comments).filter(row => commentIds.has(row.id));
  inputs.push(...threads.map(snapshot => ({kind: "BrainDiscussionThread" as const, id: snapshot.id, snapshot})),
    ...comments.map(snapshot => ({kind: "BrainDiscussionComment" as const, id: snapshot.id, snapshot})));
  const staleThreadIds = threads.filter(thread => thread.status === "OPEN"
    && (thread.comments.find(comment => commentIds.has(comment.id))?.createdAt ?? thread.createdAt) < staleThreshold).map(thread => thread.id);
  const resolvedThreads = threads.filter(thread => thread.status === "RESOLVED");

  const retentionThreshold = new Date(now - 15 * 24 * 60 * 60 * 1000);
  const chunkCandidates = await prisma.knowledgeChunk.findMany({
    where: {workspaceId: params.workspaceId, sourceType: "EVENT", createdAt: {lt: retentionThreshold}}, take: 5001,
  });
  invariant(chunkCandidates.length <= 5000, 503, "SOURCE_READ_SCAN_LIMIT", "Maintenance retention scan exceeds its supported size.");
  const chunkIds = await readableArtifactIds(agentActor, params.workspaceId, "KnowledgeChunk", chunkCandidates);
  const chunks = chunkCandidates.filter(row => chunkIds.has(row.id));
  inputs.push(...chunks.map(snapshot => ({kind: "KnowledgeChunk" as const, id: snapshot.id, snapshot})));

  // Preserve all consumed revisions before any status or retention mutation.
  const threadProofs = new Map<string, Awaited<ReturnType<typeof captureArtifactInputProof>>>();
  for (const thread of resolvedThreads) threadProofs.set(thread.id, await captureArtifactInputProof(agentActor, params.workspaceId,
    [{kind: "BrainDiscussionThread", id: thread.id, snapshot: thread}, ...thread.comments.filter(comment => commentIds.has(comment.id))
      .map(snapshot => ({kind: "BrainDiscussionComment" as const, id: snapshot.id, snapshot}))]));
  const roots = await captureArtifactInputProof(agentActor, params.workspaceId, inputs);
  const lineageRoots = await prisma.$transaction(tx => captureImmutableArtifactInputProof(agentActor, params.workspaceId, roots, tx));
  const backlinkResult = await prisma.$transaction(async tx => {
    invariant(await isArtifactInputProofReadable(agentActor, params.workspaceId, roots, tx), 409, "SOURCE_CHANGED", "Maintenance inputs changed.");
    const observed = await withArtifactInputReadCapture(agentActor, params.workspaceId, async () => {
      await captureArtifactInputProof(agentActor, params.workspaceId, [{kind: "Workspace", id: params.workspaceId}], tx);
      return rebuildBacklinks(agentActor, {workspaceId: params.workspaceId, tx});
    });
    invariant(await isArtifactInputProofReadable(agentActor, params.workspaceId, roots, tx), 409, "SOURCE_CHANGED", "Maintenance inputs changed.");
    return {linkCount: observed.value.linkCount,
      roots: await captureImmutableArtifactInputProof(agentActor, params.workspaceId, observed.roots, tx)};
  });
  lineageRoots.push(...backlinkResult.roots);
  let absorbedThreadCount = 0;
  for (const thread of resolvedThreads) {
    await markThreadAbsorbed(agentActor, {workspaceId: params.workspaceId, threadId: thread.id,
      expectedInputRoots: threadProofs.get(thread.id)});
    absorbedThreadCount += 1;
  }
  const deletedEvents = chunks.length ? await prisma.$transaction(async tx => {
    const chunkRoots = roots.filter(root => root.kind === "KnowledgeChunk" && chunkIds.has(root.id));
    invariant(await isArtifactInputProofReadable(agentActor, params.workspaceId, chunkRoots, tx), 409, "SOURCE_CHANGED", "Retention inputs changed.");
    return tx.knowledgeChunk.deleteMany({where: {workspaceId: params.workspaceId, id: {in: chunks.map(row => row.id)}}});
  }) : {count: 0};

  return {
    staleArticleCount: staleArticleIds.length,
    deadLinkCount: deadLinks.length,
    deadLinks: deadLinks.slice(0, 20),
    orphanCount: orphanArticles.length,
    orphans: orphanArticles.slice(0, 20),
    tier3CleanupCandidates: oldTier3Sources.length,
    backlinkCount: backlinkResult.linkCount,
    staleThreadCount: staleThreadIds.length,
    absorbedThreadCount,
    prunedEventsCount: deletedEvents.count,
    lineageRoots,
  };
}
