import { randomUUID } from "node:crypto";
import { prisma } from "@corgtex/shared";
import { defaultModelGateway, resolveModel } from "@corgtex/models";
import { AGENT_REGISTRY } from "@corgtex/domain";
import {
  createArticle,
  assertArtifactInputWriteFence,
  sealArtifactInputActor,
  prepareArtifactCommitPreflight,
  withArtifactCommitPreflight,
  lockArtifactReadAuthorityRows,
  markSourceAbsorbed,
  rebuildBacklinks,
  lockWorkspaceArchiveArtifact,
  brainSourceRecoveryIdentity,
  brainSourceContentFingerprint,
  readableBrainSourceIds,
  resolveKnowledgeAccessDomains,
  scanSourceReadableRecords,
  captureArtifactInputProof,
  captureImmutableArtifactInputProof,
  isArtifactInputProofReadable,
  isArtifactInputProofPubliclyShareable,
  isLegacyRecoveryProofWorkspaceShareable,
  isBrainExportProofWorkspaceShareable,
  getBrainExportWorkerPurpose,
  assertBrainExportWorkerCurrent,
  invariant,
  type LineageRoot,
} from "@corgtex/domain";
import { syncBrainArticleKnowledge } from "@corgtex/knowledge";
import type { AppActor } from "@corgtex/shared";
import type { BrainArticleAuthority, BrainArticleType, Prisma } from "@prisma/client";
import { assertLegacyRecoveryProjection, withLegacyRecoveryDerivation } from "../../domain/src/legacy-recovery";
import { getMcpToolInputRoots } from "../../domain/src/mcp-tool-input-context";

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


function sourceSkipReason(source: {
  workspaceId: string;
  absorbedAt: Date | null;
  archivedAt: Date | null;
} | null, workspaceId: string, recoveredAbsorbedAt?: string | null) {
  if (!source || source.workspaceId !== workspaceId) return "not_found";
  if (source.archivedAt) return "archived";
  if (source.absorbedAt && source.absorbedAt.toISOString() !== recoveredAbsorbedAt) return "already_absorbed";
  return null;
}

type SourceSkipResult = { skipped: true; reason: string; sourceId: string };

function isSourceSkipResult(value: unknown): value is SourceSkipResult {
  return typeof value === "object"
    && value !== null
    && "skipped" in value
    && (value as { skipped?: unknown }).skipped === true;
}

type InitialArticleWritePlan = {
  slug: string;
  title: string;
  type: BrainArticleType;
  authority: BrainArticleAuthority;
  bodyMd: string;
  sourceIds: string[];
};

/**
 * Core absorption logic — called by the agent runtime.
 *
 * Given a BrainSource, this function:
 * 1. Classifies what type of knowledge the source contains
 * 2. Matches against existing articles (by title/slug/alias)
 * 3. Creates proposed articles while preserving every existing article
 * 4. Syncs proposed articles to the knowledge pipeline
 * 5. Rebuilds backlinks
 * 6. Marks the source as absorbed
 */
export async function absorbSource(params: {
  workspaceId: string;
  sourceId: string;
  agentRunId: string;
  model?: string;
  expectedSourceIdentity?: string;
  /** Current human recovery only; validated against the immutable exact source receipt. */
  recoveryReceiptId?: string;
  /** Trusted server principal; never reconstructed from a source's author. */
  actor?: AppActor;
}) {
  params = {...params};
  const agentActor = sealArtifactInputActor(params.actor ?? {
    kind: "agent", authProvider: "bootstrap", label: "brain-absorb", workspaceIds: [params.workspaceId],
  });
  const submissionRoots = getMcpToolInputRoots(agentActor, params.workspaceId);
  const loadedSource = await prisma.brainSource.findUnique({
    where: { id: params.sourceId },
  });
  const source = loadedSource ? structuredClone(loadedSource) : null;

  function assertRecoveryIdentity(current: typeof source) {
    if (params.expectedSourceIdentity && (!current || brainSourceRecoveryIdentity(current) !== params.expectedSourceIdentity)) {
      throw new Error("SOURCE_CHANGED: Refresh source recovery evidence before processing.");
    }
  }
  assertRecoveryIdentity(source);

  if (!source) {
    return { skipped: true, reason: "not_found" };
  }

  const recovery = params.recoveryReceiptId ? await assertLegacyRecoveryProjection(agentActor,params.workspaceId,
    params.recoveryReceiptId,"BrainSource",source.id) : null;
  const recoveredAbsorbedAt = recovery ? typeof recovery.content.absorbedAt === "string" ? recovery.content.absorbedAt : null : undefined;
  const initialSkipReason = sourceSkipReason(source, params.workspaceId,recoveredAbsorbedAt);
  if (initialSkipReason) {
    return { skipped: true, reason: initialSkipReason };
  }
  const sourceId = source.id;
  const initialSourceIdentity = brainSourceRecoveryIdentity(source);

  let liveRoots: LineageRoot[] = [];
  let immutableRoots: LineageRoot[] = [];
  async function assertInputsCurrent(client: Prisma.TransactionClient = prisma) {
    invariant(await isArtifactInputProofReadable(agentActor, params.workspaceId, liveRoots, client),
      409, "SOURCE_CHANGED", "Absorption inputs changed before publication.");
    await assertBrainExportWorkerCurrent(agentActor, params.workspaceId, client);
    if (params.recoveryReceiptId) await assertLegacyRecoveryProjection(agentActor,params.workspaceId,params.recoveryReceiptId,"BrainSource",sourceId,client);
    invariant(await (getBrainExportWorkerPurpose(agentActor, params.workspaceId)
      ? isBrainExportProofWorkspaceShareable(agentActor, params.workspaceId, immutableRoots, client)
      : isArtifactInputProofPubliclyShareable(agentActor, params.workspaceId, immutableRoots, client)
        .then(async publicProof => publicProof || await isLegacyRecoveryProofWorkspaceShareable(agentActor,params.workspaceId,immutableRoots,client))),
      409, "SOURCE_RESTRICTED", "Absorption inputs cannot be published to the workspace.");
  }
  // Fresh opaque suffixes avoid probing private article names to choose the output slug.
  function proposedSlug(base: string) {
    const suffix = randomUUID().replaceAll("-", "").slice(0, 16);
    return `${slugify(base, "source").slice(0, 54)}-${suffix}`;
  }

  async function currentSkipReason(client: Pick<typeof prisma, "brainSource"> = prisma) {
    const current = await client.brainSource.findUnique({ where: { id: params.sourceId } });
    assertRecoveryIdentity(current);
    const reason = sourceSkipReason(current, params.workspaceId,recoveredAbsorbedAt);
    if (reason) return reason;
    if (!(await readableBrainSourceIds(agentActor, params.workspaceId, [current!], client as typeof prisma)).has(sourceId)) {
      return "source_restricted";
    }
    return brainSourceRecoveryIdentity(current!) === initialSourceIdentity ? null : "source_changed";
  }

  async function skippedIfSourceInactive() {
    const reason = await currentSkipReason();
    return reason ? { skipped: true, reason, sourceId } : null;
  }

  async function lockSource(tx: Prisma.TransactionClient) {
    await assertBrainExportWorkerCurrent(agentActor, params.workspaceId, tx);
    await lockWorkspaceArchiveArtifact(tx, "BrainSource", sourceId);
    await tx.$queryRaw`SELECT id FROM "BrainSource" WHERE id = ${sourceId} AND "workspaceId" = ${params.workspaceId} FOR UPDATE`;
  }

  async function runSourceWritePhase<T>(operation: (tx: Prisma.TransactionClient) => Promise<T>): Promise<T | SourceSkipResult> {
    const preflight = await prepareArtifactCommitPreflight(agentActor, params.workspaceId, immutableRoots);
    return prisma.$transaction(async (tx) => {
      await assertArtifactInputWriteFence(tx);
      await lockArtifactReadAuthorityRows(agentActor, params.workspaceId, tx);
      return withArtifactCommitPreflight(agentActor, params.workspaceId, tx, immutableRoots, preflight, async () => {
        const reason = await currentSkipReason(tx);
        if (reason) return { skipped: true, reason, sourceId };
        await assertInputsCurrent(tx);
        const value = await operation(tx);
        await assertInputsCurrent(tx);
        await assertArtifactInputWriteFence(tx);
        return value;
      }, { beforeSourceEpochs: () => lockSource(tx) });
    }, { maxWait: 5_000, timeout: 120_000 });
  }

  const accessibleDomains = await resolveKnowledgeAccessDomains(agentActor, params.workspaceId);
  if (!accessibleDomains.includes(source.accessDomain)) {
    return { skipped: true, reason: "source_restricted", sourceId };
  }
  if (!(await readableBrainSourceIds(agentActor, params.workspaceId, [source])).has(sourceId)) {
    return { skipped: true, reason: "source_restricted", sourceId };
  }

  // Matching and output metadata use only complete, currently readable public revisions.
  // Private originals and unknown legacy rows never influence model inputs or samples.
  const activeArticles = await scanSourceReadableRecords({ actor: agentActor, workspaceId: params.workspaceId,
    kind: "BrainArticle", load: (afterId, take) => prisma.brainArticle.findMany({
      where: { workspaceId: params.workspaceId, archivedAt: null, variantOfArticleId: null, isPrivate: false,
        ...(afterId ? {id: {gt: afterId}} : {}) }, orderBy: {id: "asc"}, take,
    }) });
  liveRoots = [...submissionRoots, ...await captureArtifactInputProof(agentActor, params.workspaceId, [
    {kind: "BrainSource", id: sourceId, snapshot: source},
    ...activeArticles.map(snapshot => ({kind: "BrainArticle" as const, id: snapshot.id, snapshot})),
  ])];
  const preparation = await prepareArtifactCommitPreflight(agentActor, params.workspaceId, liveRoots);
  immutableRoots = await prisma.$transaction(async tx => {
    await assertArtifactInputWriteFence(tx);
    await lockArtifactReadAuthorityRows(agentActor, params.workspaceId, tx);
    return withArtifactCommitPreflight(agentActor, params.workspaceId, tx, liveRoots, preparation, async () => {
      invariant(await currentSkipReason(tx) === null, 409, "SOURCE_CHANGED", "Absorption source changed before input capture.");
      const roots = await captureImmutableArtifactInputProof(agentActor, params.workspaceId, liveRoots, tx);
      await assertArtifactInputWriteFence(tx);
      return roots;
    }, { beforeSourceEpochs: () => lockSource(tx) });
  }, { maxWait: 5_000, timeout: 120_000 });
  await assertInputsCurrent();
  const articleIndex = activeArticles.map((a) => ({
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

Determine:
1. What type of knowledge this source contains (one of: PRODUCT, ARCHITECTURE, PROCESS, RUNBOOK, DECISION, TEAM, PERSON, CUSTOMER, INCIDENT, PROJECT, INTEGRATION, PATTERN, STRATEGY, CULTURE, GLOSSARY)
2. Suggest a title and slug for the most specific article supported by this source
3. A brief summary of what this source adds to the wiki. Do not use other wiki articles.`,
    schemaHint: `{
  articleType: string,
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
    createNew?: { title: string; slug: string } | null;
    summary?: string;
  };

  const articleType = (result.articleType ?? "GLOSSARY") as BrainArticleType;
  const createNew = result.createNew && typeof result.createNew === "object" ? result.createNew : null;
  const suggestedSlug = createNew?.slug ? slugify(createNew.slug, "source") : "";
  const suggestedTitle = createNew?.title?.trim().toLowerCase() ?? "";
  const updateSlugs = articleIndex
    .filter((article) => article.slug === suggestedSlug || article.title.trim().toLowerCase() === suggestedTitle
      || article.aliases.some((alias) => alias.trim().toLowerCase() === suggestedTitle))
    .map((article) => article.slug);
  const documentLikeSource = isDocumentLikeSource(source.sourceType);

  const postAnalysisSkip = await skippedIfSourceInactive();
  if (postAnalysisSkip) return postAnalysisSkip;
  await assertInputsCurrent();

  const initialWritePlans: InitialArticleWritePlan[] = [];
  const skippedNonDraftSlugs: string[] = [];

  // Step 2: Propose a separate revision; automatic actors cannot edit existing drafts.
  for (const slug of updateSlugs) {
    const existing = activeArticles.find((a) => a.slug === slug);
    if (!existing) continue;
    if (existing.authority !== "DRAFT") {
      skippedNonDraftSlugs.push(existing.slug);
      continue;
    }

    await assertInputsCurrent();
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

    await assertInputsCurrent();
    initialWritePlans.push({
      slug: proposedSlug(existing.slug), title: existing.title, type: existing.type, authority: "DRAFT",
      bodyMd: synthesized.content, sourceIds: [...new Set([...existing.sourceIds, source.id])],
    });
  }

  // Step 3: Create new article if needed
  if (createNew && createNew.title && createNew.slug) {
    // Check it doesn't already exist
    const existingSlug = activeArticles.find((a) => a.slug === createNew.slug);
    if (!existingSlug && updateSlugs.length === 0) {
      await assertInputsCurrent();
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

      await assertInputsCurrent();
      initialWritePlans.push({
        slug: proposedSlug(createNew.slug),
        title: createNew.title,
        type: articleType,
        authority: source.tier === 1 || documentLikeSource ? "REFERENCE" : "DRAFT",
        bodyMd: drafted.content,
        sourceIds: [source.id],
      });
    }
  }

  if (documentLikeSource && initialWritePlans.length === 0) {
    const fallbackTitle = source.title?.trim() || createNew?.title?.trim() || "Uploaded knowledge source";
    const baseSlug = slugify(createNew?.slug || fallbackTitle, "uploaded-knowledge-source");
    const slug = proposedSlug(baseSlug);
    await assertInputsCurrent();
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
            summary: result.summary ?? null,
          }),
        },
      ],
    });

    await assertInputsCurrent();
    initialWritePlans.push({
      slug,
      title: fallbackTitle,
      type: articleType,
      authority: "REFERENCE",
      bodyMd: drafted.content,
      sourceIds: [source.id],
    });
  }

  if (initialWritePlans.length === 0 && skippedNonDraftSlugs.length > 0) {
    return {
      skipped: true,
      reason: "non_draft_article",
      sourceId: source.id,
      skippedSlugs: skippedNonDraftSlugs.filter((slug) => !activeArticles.find((article) => article.slug === slug)?.isPrivate),
      summary: result.summary ?? null,
      lineageRoots: immutableRoots,
    };
  }

  // Proposed revisions leave their referenced originals unchanged, so no downstream
  // article needs an automatic cascade edit.
  const writeResult = await runSourceWritePhase(async (tx) => {
    const touchedArticleIds: string[] = [];
    let createdArticleSlug: string | null = null;
    let publicTouchedArticleCount = 0;

    for (const plan of initialWritePlans) {
      const create = () => createArticle(agentActor, {
        workspaceId: params.workspaceId,
        slug: plan.slug,
        title: plan.title,
        type: plan.type,
        authority: plan.authority,
        isPrivate: false,
        completeInputRoots: immutableRoots,
        bodyMd: plan.bodyMd,
        sourceIds: plan.sourceIds,
        derivation: {
          sourceId: source.id,
          sourceFingerprint: brainSourceContentFingerprint(source),
          agentRunId: params.agentRunId,
        },
        tx,
      });
      const article = params.recoveryReceiptId ? await withLegacyRecoveryDerivation({actor:agentActor,workspaceId:params.workspaceId,
        sourceId:source.id,sourceFingerprint:brainSourceContentFingerprint(source),receiptId:params.recoveryReceiptId,agentRunId:params.agentRunId},tx,create) : await create();
      touchedArticleIds.push(article.id);
      if (!article.isPrivate) publicTouchedArticleCount += 1;
      createdArticleSlug = article.isPrivate ? null : article.slug;
    }

    // Step 5: Rebuild backlinks
    await rebuildBacklinks(agentActor, { workspaceId: params.workspaceId, tx });

    // Step 6: Mark source absorbed before releasing the archive lock.
    await markSourceAbsorbed(agentActor, { sourceId: source.id, tx });

    return { touchedArticleIds, createdArticleSlug, publicTouchedArticleCount };
  });
  if (isSourceSkipResult(writeResult)) return writeResult;

  // Step 4: Sync knowledge chunks after the source write phase commits. At this
  // point a concurrent archive is no longer racing a pending source absorption.
  for (const articleId of writeResult.touchedArticleIds) {
    await syncBrainArticleKnowledge({
      workspaceId: params.workspaceId,
      articleId,
      lineageActor: agentActor,
    });
  }

  await assertInputsCurrent();
  return {
    absorbed: true,
    sourceId: source.id,
    updatedSlugs: [],
    createdSlug: writeResult.createdArticleSlug,
    touchedArticleCount: writeResult.publicTouchedArticleCount,
    skippedSlugs: skippedNonDraftSlugs.filter((slug) => !activeArticles.find((article) => article.slug === slug)?.isPrivate),
    summary: result.summary ?? null,
    lineageRoots: immutableRoots,
  };
}
