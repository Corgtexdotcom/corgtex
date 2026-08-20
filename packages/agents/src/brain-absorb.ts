import { prisma } from "@corgtex/shared";
import { defaultModelGateway, resolveModel } from "@corgtex/models";
import { AGENT_REGISTRY } from "@corgtex/domain";
import {
  createArticle,
  updateArticle,
  markSourceAbsorbed,
  rebuildBacklinks,
  lockWorkspaceArchiveArtifact,
} from "@corgtex/domain";
import { syncBrainArticleKnowledge } from "@corgtex/knowledge";
import type { AppActor } from "@corgtex/shared";
import type { BrainArticleType } from "@prisma/client";

function isDocumentLikeSource(sourceType: string) {
  return sourceType === "DOC" || sourceType === "FILE_UPLOAD";
}

function slugify(value: string, fallback: string) {
  const slug = value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 72);
  return slug || fallback;
}

function uniqueSlug(base: string, existingSlugs: Set<string>) {
  if (!existingSlugs.has(base)) return base;
  for (let index = 2; index < 100; index += 1) {
    const candidate = `${base}-${index}`;
    if (!existingSlugs.has(candidate)) return candidate;
  }
  return `${base}-${Date.now()}`;
}

function sourceSkipReason(source: {
  workspaceId: string;
  absorbedAt: Date | null;
  archivedAt: Date | null;
} | null, workspaceId: string) {
  if (!source || source.workspaceId !== workspaceId) return "not_found";
  if (source.archivedAt) return "archived";
  if (source.absorbedAt) return "already_absorbed";
  return null;
}

type SourceSkipResult = { skipped: true; reason: string; sourceId: string };

function isSourceSkipResult(value: unknown): value is SourceSkipResult {
  return typeof value === "object"
    && value !== null
    && "skipped" in value
    && (value as { skipped?: unknown }).skipped === true;
}

/**
 * Core absorption logic — called by the agent runtime.
 *
 * Given a BrainSource, this function:
 * 1. Classifies what type of knowledge the source contains
 * 2. Matches against existing articles (by title/slug/alias)
 * 3. Updates existing articles or creates new ones
 * 4. Syncs updated articles to the knowledge pipeline
 * 5. Rebuilds backlinks
 * 6. Marks the source as absorbed
 */
export async function absorbSource(params: {
  workspaceId: string;
  sourceId: string;
  agentRunId: string;
  model?: string;
}) {
  const source = await prisma.brainSource.findUnique({
    where: { id: params.sourceId },
  });

  if (!source) {
    return { skipped: true, reason: "not_found" };
  }

  const initialSkipReason = sourceSkipReason(source, params.workspaceId);
  if (initialSkipReason) {
    return { skipped: true, reason: initialSkipReason };
  }
  const sourceId = source.id;

  async function currentSkipReason(client: Pick<typeof prisma, "brainSource"> = prisma) {
    const current = await client.brainSource.findUnique({
      where: { id: params.sourceId },
      select: { workspaceId: true, absorbedAt: true, archivedAt: true },
    });
    return sourceSkipReason(current, params.workspaceId);
  }

  async function skippedIfSourceInactive() {
    const reason = await currentSkipReason();
    return reason ? { skipped: true, reason, sourceId } : null;
  }

  async function withSourceArchiveLock<T>(operation: () => Promise<T>): Promise<T | SourceSkipResult> {
    return prisma.$transaction(async (tx) => {
      await lockWorkspaceArchiveArtifact(tx, "BrainSource", sourceId);
      const reason = await currentSkipReason(tx);
      if (reason) return { skipped: true, reason, sourceId };
      return operation();
    }, { maxWait: 5_000, timeout: 120_000 });
  }

  // Build an agent actor for domain service calls
  const agentActor: AppActor = {
    kind: "agent",
    authProvider: "bootstrap",
    label: "brain-absorb",
    workspaceIds: [params.workspaceId],
  };

  // Load the article index for matching
  const articles = await prisma.brainArticle.findMany({
    where: { workspaceId: params.workspaceId },
    select: {
      id: true,
      slug: true,
      title: true,
      type: true,
      authority: true,
      bodyMd: true,
      sourceIds: true,
      frontmatterJson: true,
    },
  });

  const articleIndex = articles.map((a) => ({
    slug: a.slug,
    title: a.title,
    type: a.type,
    authority: a.authority,
    aliases: Array.isArray((a.frontmatterJson as Record<string, unknown> | null)?.also)
      ? ((a.frontmatterJson as Record<string, unknown>).also as string[])
      : [],
  }));

  // Step 1: Classify source and match to articles
  const model = params.model ?? resolveModel(AGENT_REGISTRY["brain-absorb"].defaultModelTier);
  const analysis = await defaultModelGateway.extract({
    model,
    workspaceId: params.workspaceId,
    agentRunId: params.agentRunId,
    instruction: `Analyze this source and determine how it should be absorbed into a knowledge wiki.

Source type: ${source.sourceType} (tier ${source.tier})
Source title: ${source.title ?? "untitled"}
Source channel: ${source.channel ?? "unknown"}
${source.ingestionGuidanceMd ? `User ingestion guidance:\n${source.ingestionGuidanceMd}` : "User ingestion guidance: none"}

Existing articles in the wiki:
${articleIndex.map((a) => `- "${a.title}" (${a.type}, ${a.authority}) [slug: ${a.slug}]${a.aliases.length > 0 ? ` aliases: ${a.aliases.join(", ")}` : ""}`).join("\n")}

Determine:
1. What type of knowledge this source contains (one of: PRODUCT, ARCHITECTURE, PROCESS, RUNBOOK, DECISION, TEAM, PERSON, CUSTOMER, INCIDENT, PROJECT, INTEGRATION, PATTERN, STRATEGY, CULTURE, GLOSSARY)
2. Which existing articles should be updated (list their slugs), if any
3. Whether a new article should be created, and if so, suggest a title and slug
4. A brief summary of what this source adds to the wiki`,
    schemaHint: `{
  articleType: string,
  updateSlugs: string[],
  createNew: { title: string, slug: string } | null,
  summary: string
}`,
    input: JSON.stringify({
      sourceContent: source.content.slice(0, 4000),
      ingestionGuidanceMd: source.ingestionGuidanceMd,
    }),
  });

  const result = analysis.output as {
    articleType?: string;
    updateSlugs?: string[];
    createNew?: { title: string; slug: string } | null;
    summary?: string;
  };

  const articleType = (result.articleType ?? "GLOSSARY") as BrainArticleType;
  const updateSlugs = Array.isArray(result.updateSlugs) ? result.updateSlugs : [];
  const createNew = result.createNew && typeof result.createNew === "object" ? result.createNew : null;
  const documentLikeSource = isDocumentLikeSource(source.sourceType);

  const postAnalysisSkip = await skippedIfSourceInactive();
  if (postAnalysisSkip) return postAnalysisSkip;

  const touchedArticleIds: string[] = [];
  const skippedNonDraftSlugs: string[] = [];
  let createdArticleSlug: string | null = null;

  // Step 2: Update existing articles
  for (const slug of updateSlugs) {
    const existing = articles.find((a) => a.slug === slug);
    if (!existing) continue;
    if (existing.authority !== "DRAFT") {
      skippedNonDraftSlugs.push(existing.slug);
      continue;
    }

    const synthesized = await defaultModelGateway.chat({
      model,
      workspaceId: params.workspaceId,
      agentRunId: params.agentRunId,
      taskType: "AGENT",
      messages: [
        {
          role: "system",
          content: `You are updating a wiki article with new information from a source.

Rules:
- Weave the new information into the existing article naturally
- Do NOT just append to the bottom — integrate so the article reads as a coherent whole
- If the source is Tier 1 and contradicts existing content, replace the old content
- If the source is Tier 2 or 3, add it as context without overwriting
- Maintain Wikipedia-style tone: flat, factual, neutral
- Keep the article focused — if a subtopic deserves its own page, note it but don't expand
- Use [[wikilinks]] to reference other articles when relevant
- Source tier: ${source.tier}`,
        },
        {
          role: "user",
          content: JSON.stringify({
            currentArticle: existing.bodyMd.slice(0, 3000),
            newSource: source.content.slice(0, 3000),
            ingestionGuidanceMd: source.ingestionGuidanceMd,
            sourceType: source.sourceType,
            sourceTier: source.tier,
          }),
        },
      ],
    });

    const updateResult = await withSourceArchiveLock(() => updateArticle(agentActor, {
      workspaceId: params.workspaceId,
      slug: existing.slug,
      bodyMd: synthesized.content,
      sourceIds: [...new Set([...(existing.sourceIds ?? []), source.id])],
      changeSummary: `Absorbed ${source.sourceType} source: ${result.summary ?? "new information"}`,
      agentRunId: params.agentRunId,
    }));
    if (isSourceSkipResult(updateResult)) return updateResult;

    touchedArticleIds.push(existing.id);
  }

  // Step 3: Create new article if needed
  if (createNew && createNew.title && createNew.slug) {
    // Check it doesn't already exist
    const existingSlug = articles.find((a) => a.slug === createNew.slug);
    if (!existingSlug) {
      const drafted = await defaultModelGateway.chat({
        model,
        workspaceId: params.workspaceId,
        agentRunId: params.agentRunId,
        taskType: "AGENT",
        messages: [
          {
            role: "system",
            content: `You are creating a new wiki article from source material.

Rules:
- Write in Wikipedia style: flat, factual, neutral
- Organize by theme, not chronology
- Use [[wikilinks]] to reference related topics
- Include only what the source material supports — don't speculate
- The article should be about this topic's role in the organization, not a general description
- Aim for 30-80 lines depending on content density`,
          },
          {
            role: "user",
            content: JSON.stringify({
              title: createNew.title,
              sourceContent: source.content.slice(0, 4000),
              ingestionGuidanceMd: source.ingestionGuidanceMd,
              sourceType: source.sourceType,
            }),
          },
        ],
      });

      const article = await withSourceArchiveLock(() => createArticle(agentActor, {
        workspaceId: params.workspaceId,
        slug: createNew.slug,
        title: createNew.title,
        type: articleType,
        authority: source.tier === 1 || documentLikeSource ? "REFERENCE" : "DRAFT",
        bodyMd: drafted.content,
        sourceIds: [source.id],
      }));
      if (isSourceSkipResult(article)) return article;

      touchedArticleIds.push(article.id);
      createdArticleSlug = createNew.slug;
    }
  }

  if (documentLikeSource && touchedArticleIds.length === 0) {
    const fallbackTitle = source.title?.trim() || createNew?.title?.trim() || "Uploaded knowledge source";
    const existingSlugs = new Set(articles.map((article) => article.slug));
    const baseSlug = slugify(createNew?.slug || fallbackTitle, "uploaded-knowledge-source");
    const slug = uniqueSlug(baseSlug, existingSlugs);
    const drafted = await defaultModelGateway.chat({
      model,
      workspaceId: params.workspaceId,
      agentRunId: params.agentRunId,
      taskType: "AGENT",
      messages: [
        {
          role: "system",
          content: `Create a concise public reference article from an uploaded source.

Rules:
- Keep authoritative existing articles unchanged
- Summarize only what the source supports
- Use a neutral wiki style
- Include why this source matters to the organization when the source makes that clear
- Keep it short enough to be useful on a dashboard excerpt`,
        },
        {
          role: "user",
          content: JSON.stringify({
            title: fallbackTitle,
            sourceContent: source.content.slice(0, 4000),
            ingestionGuidanceMd: source.ingestionGuidanceMd,
            skippedExistingArticles: skippedNonDraftSlugs,
            summary: result.summary ?? null,
          }),
        },
      ],
    });

    const article = await withSourceArchiveLock(() => createArticle(agentActor, {
      workspaceId: params.workspaceId,
      slug,
      title: fallbackTitle,
      type: articleType,
      authority: "REFERENCE",
      bodyMd: drafted.content,
      sourceIds: [source.id],
    }));
    if (isSourceSkipResult(article)) return article;

    touchedArticleIds.push(article.id);
    createdArticleSlug = slug;
  }

  if (touchedArticleIds.length === 0 && skippedNonDraftSlugs.length > 0) {
    return {
      skipped: true,
      reason: "non_draft_article",
      sourceId: source.id,
      skippedSlugs: skippedNonDraftSlugs,
      summary: result.summary ?? null,
    };
  }

  // --- Cascading updates ---
  // Check if articles linking to updated articles need changes too
  const MAX_CASCADE_BREADTH = 5;
  const cascadedSlugs: string[] = [];
  const errors: string[] = [];

  if (touchedArticleIds.length > 0) {
    // Find articles with inbound backlinks to any touched article
    const inboundBacklinks = await prisma.brainBacklink.findMany({
      where: {
        workspaceId: params.workspaceId,
        toArticleId: { in: touchedArticleIds },
      },
      include: {
        fromArticle: {
          select: { id: true, slug: true, title: true, type: true, authority: true, bodyMd: true },
        },
      },
    });

    // Deduplicate and exclude already-touched articles. Agents may only edit draft articles.
    const candidateArticles = new Map<string, typeof inboundBacklinks[0]["fromArticle"]>();
    for (const bl of inboundBacklinks) {
      if (
        !touchedArticleIds.includes(bl.fromArticle.id) &&
        bl.fromArticle.authority === "DRAFT" &&
        !candidateArticles.has(bl.fromArticle.id)
      ) {
        candidateArticles.set(bl.fromArticle.id, bl.fromArticle);
      }
    }

    // Limit cascade breadth
    const candidates = [...candidateArticles.values()].slice(0, MAX_CASCADE_BREADTH);

    for (const candidate of candidates) {
      try {
        // Build a summary of what changed in the touched articles
        const changedSummaries = touchedArticleIds
          .map((id) => {
            const a = articles.find((x) => x.id === id);
            return a ? `"${a.title}" was updated` : null;
          })
          .filter(Boolean)
          .join("; ");

        const cascadeCheck = await defaultModelGateway.chat({
          model,
          workspaceId: params.workspaceId,
          agentRunId: params.agentRunId,
          taskType: "AGENT",
          messages: [
            {
              role: "system",
              content: `You are checking if a wiki article needs updating after related articles changed.

Changes made: ${changedSummaries}
Source that triggered changes: ${source.sourceType} — "${source.title ?? "untitled"}"

Review the article below. If it references information that may now be outdated due to the above changes, produce an updated version. If it does NOT need changes, respond with exactly: NO_UPDATE_NEEDED

Rules:
- Only update if the article contains substantive references to the changed topics (not just see-also links)
- Maintain the article's existing style and structure
- Use [[wikilinks]] where appropriate
- Keep updates minimal — only change what's affected`,
            },
            {
              role: "user",
              content: `Article: "${candidate.title}" (${candidate.type})\n\n${candidate.bodyMd.slice(0, 3000)}`,
            },
          ],
        });

        if (cascadeCheck.content.trim() !== "NO_UPDATE_NEEDED" && cascadeCheck.content.length > 50) {
          const cascadeUpdateResult = await withSourceArchiveLock(() => updateArticle(agentActor, {
            workspaceId: params.workspaceId,
            slug: candidate.slug,
            bodyMd: cascadeCheck.content,
            changeSummary: `Cascading update: ${changedSummaries}`,
            agentRunId: params.agentRunId,
          }));
          if (isSourceSkipResult(cascadeUpdateResult)) return cascadeUpdateResult;
          touchedArticleIds.push(candidate.id);
          cascadedSlugs.push(candidate.slug);
        }
      } catch (err) {
        // Don't fail the whole absorption for cascade failures
        errors.push(`Cascade check failed for "${candidate.slug}": ${err}`);
      }
    }
  }

  // Step 4: Sync knowledge chunks for all touched articles
  for (const articleId of touchedArticleIds) {
    const syncResult = await withSourceArchiveLock(() => syncBrainArticleKnowledge({
      workspaceId: params.workspaceId,
      articleId,
    }));
    if (isSourceSkipResult(syncResult)) return syncResult;
  }

  // Step 5: Rebuild backlinks
  const backlinksResult = await withSourceArchiveLock(() => rebuildBacklinks(agentActor, { workspaceId: params.workspaceId }));
  if (isSourceSkipResult(backlinksResult)) return backlinksResult;

  // Step 6: Mark source absorbed
  const markResult = await withSourceArchiveLock(() => markSourceAbsorbed(agentActor, { sourceId: source.id }));
  if (isSourceSkipResult(markResult)) return markResult;

  return {
    absorbed: true,
    sourceId: source.id,
    updatedSlugs: updateSlugs,
    createdSlug: createdArticleSlug,
    touchedArticleCount: touchedArticleIds.length,
    skippedSlugs: skippedNonDraftSlugs,
    summary: result.summary ?? null,
  };
}
