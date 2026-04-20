import { prisma } from "@corgtex/shared";
import { defaultModelGateway, resolveModel } from "@corgtex/models";
import { AGENT_REGISTRY } from "@corgtex/domain";
import {
  createArticle,
  updateArticle,
  markSourceAbsorbed,
  rebuildBacklinks,
} from "@corgtex/domain";
import { syncBrainArticleKnowledge } from "@corgtex/knowledge";
import type { AppActor } from "@corgtex/shared";
import type { BrainArticleType } from "@prisma/client";

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

  if (!source || source.workspaceId !== params.workspaceId || source.absorbedAt) {
    return { skipped: true, reason: source?.absorbedAt ? "already_absorbed" : "not_found" };
  }

  // Build an agent actor for domain service calls
  const agentActor: AppActor = {
    kind: "agent",
    authProvider: "bootstrap",
    label: "brain-absorb",
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
    input: source.content.slice(0, 4000),
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

  const touchedArticleIds: string[] = [];

  // Step 2: Update existing articles
  for (const slug of updateSlugs) {
    const existing = articles.find((a) => a.slug === slug);
    if (!existing) continue;

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
            sourceType: source.sourceType,
            sourceTier: source.tier,
          }),
        },
      ],
    });

    await updateArticle(agentActor, {
      workspaceId: params.workspaceId,
      slug: existing.slug,
      bodyMd: synthesized.content,
      sourceIds: [...new Set([...(existing.sourceIds ?? []), source.id])],
      changeSummary: `Absorbed ${source.sourceType} source: ${result.summary ?? "new information"}`,
      agentRunId: params.agentRunId,
    });

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
              sourceType: source.sourceType,
            }),
          },
        ],
      });

      const article = await createArticle(agentActor, {
        workspaceId: params.workspaceId,
        slug: createNew.slug,
        title: createNew.title,
        type: articleType,
        authority: source.tier === 1 ? "REFERENCE" : "DRAFT",
        bodyMd: drafted.content,
        sourceIds: [source.id],
      });

      touchedArticleIds.push(article.id);
    }
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

    // Deduplicate and exclude already-touched articles, skip HISTORICAL
    const candidateArticles = new Map<string, typeof inboundBacklinks[0]["fromArticle"]>();
    for (const bl of inboundBacklinks) {
      if (
        !touchedArticleIds.includes(bl.fromArticle.id) &&
        bl.fromArticle.authority !== "HISTORICAL" &&
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
          await updateArticle(agentActor, {
            workspaceId: params.workspaceId,
            slug: candidate.slug,
            bodyMd: cascadeCheck.content,
            changeSummary: `Cascading update: ${changedSummaries}`,
            agentRunId: params.agentRunId,
          });
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
    await syncBrainArticleKnowledge({
      workspaceId: params.workspaceId,
      articleId,
    });
  }

  // Step 5: Rebuild backlinks
  await rebuildBacklinks(agentActor, { workspaceId: params.workspaceId });

  // Step 6: Mark source absorbed
  await markSourceAbsorbed(agentActor, { sourceId: source.id });

  return {
    absorbed: true,
    sourceId: source.id,
    updatedSlugs: updateSlugs,
    createdSlug: createNew?.slug ?? null,
    touchedArticleCount: touchedArticleIds.length,
    summary: result.summary ?? null,
  };
}
