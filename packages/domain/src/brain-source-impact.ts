import { Prisma } from "@prisma/client";
import { prisma, type AppActor } from "@corgtex/shared";
import { requireWorkspaceMembership } from "./auth";
import { resolveKnowledgeAccessDomains } from "./brain-access";
import { invariant } from "./errors";
import type { BrainArticleDerivationV1 } from "./brain-derivation";
import { currentArtifactInputRoots, readableArtifactIds } from "./source-lineage";

type ImpactClient = Pick<Prisma.TransactionClient, "brainArticle" | "artifactInputLineage">;

type ArticleLink = {
  id: string;
  slug: string;
  title: string;
  isPrivate: boolean;
  ownerMemberId: string | null;
  kind: "derived" | "unclassified";
};

export type SourceArticleImpact = { sourceId: string; articles: ArticleLink[] };

export function sourceIdsInDerivation(value: Prisma.JsonValue | null) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return [];
  const sources = value.sources;
  if (!Array.isArray(sources)) return [];
  return sources.flatMap((source) => source && typeof source === "object" && !Array.isArray(source)
    && typeof source.sourceId === "string" ? [source.sourceId] : []);
}

export function readBrainArticleDerivation(value: Prisma.JsonValue | null): BrainArticleDerivationV1 | null {
  if (!value || typeof value !== "object" || Array.isArray(value)
    || value.version !== 1 || value.origin !== "brain-absorb"
    || typeof value.agentRunId !== "string" || !value.agentRunId.trim()
    || !Array.isArray(value.sources) || value.sources.length === 0) return null;
  const valid = value.sources.every((source) => source && typeof source === "object" && !Array.isArray(source)
    && typeof source.sourceId === "string" && source.sourceId.trim()
    && typeof source.fingerprint === "string" && /^[a-f0-9]{64}$/.test(source.fingerprint));
  if (!valid || new Set(sourceIdsInDerivation(value)).size !== value.sources.length) return null;
  return value as BrainArticleDerivationV1;
}

/** This classifies only explicit lineage. A legacy sourceIds link stays unclassified. */
export async function findSourceArticleImpacts(
  tx: ImpactClient,
  workspaceId: string,
  sourceIds: readonly string[],
) {
  const uniqueIds = [...new Set(sourceIds.filter(Boolean))];
  const impacts = new Map(uniqueIds.map((sourceId) => [sourceId, { sourceId, articles: [] as ArticleLink[] }]));
  if (uniqueIds.length === 0) return impacts;

  const articles = await tx.brainArticle.findMany({
    where: { workspaceId, archivedAt: null },
  });
  for (const article of articles) {
    const roots = await currentArtifactInputRoots(tx as Prisma.TransactionClient, workspaceId,
      { kind: "BrainArticle", id: article.id }, article);
    const provenSources = new Set(roots?.filter((root) => root.kind === "BrainSource").map((root) => root.id) ?? []);
    const explicit = new Set(readBrainArticleDerivation(article.derivationJson)?.sources.map((source) => source.sourceId) ?? []);
    const linked = new Set([...article.sourceIds, ...sourceIdsInDerivation(article.derivationJson), ...provenSources]);
    for (const sourceId of linked) {
      const impact = impacts.get(sourceId);
      if (!impact) continue;
      impact.articles.push({
        id: article.id,
        slug: article.slug,
        title: article.title,
        isPrivate: article.isPrivate,
        ownerMemberId: article.ownerMemberId,
        kind: provenSources.has(sourceId) || explicit.has(sourceId) ? "derived" : "unclassified",
      });
    }
  }
  return impacts;
}

export async function listBrainSourceArchiveImpacts(actor: AppActor, params: {
  workspaceId: string;
  sourceIds: string[];
}) {
  const membership = await requireWorkspaceMembership({ actor, workspaceId: params.workspaceId });
  const domains = await resolveKnowledgeAccessDomains(actor, params.workspaceId);
  const sourceIds = [...new Set(params.sourceIds.filter(Boolean))];
  if (sourceIds.length === 0) return [];
  const sources = await prisma.brainSource.findMany({
    where: { id: { in: sourceIds }, workspaceId: params.workspaceId, accessDomain: { in: domains }, archivedAt: null },
    select: { id: true },
  });
  invariant(sources.length === sourceIds.length, 404, "NOT_FOUND", "Source not found.");
  const impacts = await findSourceArticleImpacts(prisma, params.workspaceId, sourceIds);
  const impactedIds = [...new Set([...impacts.values()].flatMap((impact) => impact.articles.map((article) => article.id)))];
  const impactedArticles = await prisma.brainArticle.findMany({ where: {
    workspaceId: params.workspaceId, id: { in: impactedIds }, archivedAt: null,
  } });
  const readableIds = await readableArtifactIds(actor, params.workspaceId, "BrainArticle", impactedArticles);
  return sourceIds.map((sourceId) => {
    const articles = impacts.get(sourceId)?.articles ?? [];
    const canView = (article: ArticleLink) => readableIds.has(article.id)
      && (actor.kind === "agent" || membership?.role === "ADMIN"
        || !article.isPrivate || article.ownerMemberId === membership?.id);
    return {
      sourceId,
      blocked: articles.length > 0,
      visibleArticles: articles.filter(canView).map(({ id, slug, title, kind }) => ({ id, slug, title, kind })),
      hasHiddenArticles: articles.some((article) => !canView(article)),
    };
  });
}
