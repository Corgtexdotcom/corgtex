import { createHash } from "node:crypto";
import { Prisma } from "@prisma/client";
import { prisma, type AppActor } from "@corgtex/shared";
import { archiveWorkspaceArtifact } from "./archive";
import { requireWorkspaceMembership } from "./auth";
import { brainSourceContentFingerprint } from "./brain-derivation";
import { isBrainSourceRemovalEnabled, requireBrainSourceRemovalEnabled } from "./brain-removal-gate";
import { findSourceArticleImpacts, readBrainArticleDerivation, sourceIdsInDerivation } from "./brain-source-impact";
import { lockBrainSourceLink } from "./brain-source-links";
import { continueBrainSourceRemovals } from "./brain-source-removal";
import { invariant } from "./errors";

function documentId(metadata: Prisma.JsonValue | null) {
  return metadata && typeof metadata === "object" && !Array.isArray(metadata)
    && typeof metadata.documentId === "string" ? metadata.documentId : null;
}

type RemovalMode = "keep_sources" | "remove_sources";

async function buildPreview(tx: Prisma.TransactionClient, actor: AppActor, workspaceId: string, slug: string) {
  const membership = await requireWorkspaceMembership({ actor, workspaceId });
  const article = await tx.brainArticle.findFirst({ where: {
    workspaceId, OR: [{ id: slug }, { slug }],
  } });
  invariant(article, 404, "NOT_FOUND", "Article not found.");
  invariant(!article.archivedAt, 409, "ALREADY_ARCHIVED", "This article is already archived.");
  const canRemoveSources = actor.kind === "agent" || membership?.role === "ADMIN";
  invariant(canRemoveSources || (article.ownerMemberId !== null && article.ownerMemberId === membership?.id),
    403, "FORBIDDEN", "Only the article owner or a workspace admin can remove this article.");

  const directIds = [...new Set([...article.sourceIds, ...sourceIdsInDerivation(article.derivationJson)])].sort();
  const directSources = await tx.brainSource.findMany({ where: { workspaceId, id: { in: directIds } } });
  const documentIds = [...new Set(directSources.map((source) => documentId(source.metadata)).filter((id): id is string => !!id))].sort();
  const documents = await tx.document.findMany({ where: { workspaceId, id: { in: documentIds } },
    select: { id: true, title: true, updatedAt: true, archivedAt: true } });
  const documentSources = documentIds.length ? await tx.brainSource.findMany({ where: {
    workspaceId, archivedAt: null,
    OR: documentIds.map((id) => ({ metadata: { path: ["documentId"], equals: id } })),
  } }) : [];
  const sources = [...new Map([...directSources, ...documentSources].map((source) => [source.id, source])).values()]
    .sort((a, b) => a.id.localeCompare(b.id));
  const activeIds = sources.filter((source) => !source.archivedAt).map((source) => source.id);
  const impacts = await findSourceArticleImpacts(tx, workspaceId, activeIds);
  const impactedIds = [...new Set(activeIds.flatMap((id) => impacts.get(id)?.articles.map((item) => item.id) ?? []))]
    .filter((id) => id !== article.id).sort();
  const impactedArticles = await tx.brainArticle.findMany({ where: { workspaceId, id: { in: impactedIds }, archivedAt: null },
    select: { id: true, title: true, updatedAt: true, bodyMd: true, sourceIds: true, derivationJson: true } });
  const relatedIds = [...new Set(impactedArticles.flatMap((item) => [
    ...item.sourceIds, ...sourceIdsInDerivation(item.derivationJson),
  ]))].filter((id) => !activeIds.includes(id)).sort();
  const relatedSources = await tx.brainSource.findMany({ where: { workspaceId, id: { in: relatedIds } } });
  const relatedDocumentIds = [...new Set(relatedSources.map((source) => documentId(source.metadata)).filter((id): id is string => !!id))]
    .filter((id) => !documentIds.includes(id)).sort();
  const relatedDocuments = await tx.document.findMany({ where: { workspaceId, id: { in: relatedDocumentIds } },
    select: { id: true, updatedAt: true, archivedAt: true } });
  const byArticleId = new Map(impactedArticles.map((item) => [item.id, item]));
  const byDocumentId = new Map(documents.map((item) => [item.id, item]));
  const blockReasons: Array<"source_missing" | "document_missing" | "restricted" | "unclassified" | "feature_disabled"> = [];
  if (directIds.length > 0 && !await isBrainSourceRemovalEnabled(tx, workspaceId)) blockReasons.push("feature_disabled");
  if (directIds.length !== directSources.length || directSources.some((source) => source.archivedAt)) {
    blockReasons.push("source_missing");
  }
  if (documentIds.length !== documents.length || documents.some((item) => item.archivedAt)) {
    blockReasons.push("document_missing");
  }
  if (sources.some((source) => source.accessDomain !== "WORKSPACE")) {
    blockReasons.push("restricted");
  }
  if (relatedIds.length !== relatedSources.length || relatedSources.some((source) => source.archivedAt)) {
    blockReasons.push("source_missing");
  }
  if (relatedSources.some((source) => source.accessDomain !== "WORKSPACE")) {
    blockReasons.push("restricted");
  }
  if (relatedDocumentIds.length !== relatedDocuments.length || relatedDocuments.some((item) => item.archivedAt)) {
    blockReasons.push("document_missing");
  }
  const sourceDetails = sources.map((source) => {
    const related = (impacts.get(source.id)?.articles ?? []).filter((item) => item.id !== article.id);
    const sharedArticles = related.map((item) => {
      const record = byArticleId.get(item.id);
      const lineage = record ? readBrainArticleDerivation(record.derivationJson) : null;
      const explicitIds = new Set(lineage?.sources.map((entry) => entry.sourceId) ?? []);
      const classified = !!record && !!lineage && record.sourceIds.every((id) => explicitIds.has(id))
        && lineage.sources.every((entry) => record.sourceIds.includes(entry.sourceId));
      const action = item.kind === "unclassified" || !lineage || !classified ? "manual_review"
        : lineage.sources.some((entry) => !activeIds.includes(entry.sourceId)) ? "regenerate" : "archive";
      if (action === "manual_review") blockReasons.push("unclassified");
      return { id: item.id, title: item.title, action };
    });
    const linkedDocumentId = documentId(source.metadata);
    return {
      id: source.id, title: source.title ?? source.id.slice(0, 8), linkedDocumentId,
      documentTitle: linkedDocumentId ? byDocumentId.get(linkedDocumentId)?.title ?? null : null,
      sharedArticles,
    };
  });
  const token = createHash("sha256").update(JSON.stringify([
    article.id, article.updatedAt, article.bodyMd, article.sourceIds, article.derivationJson, article.humanEditedAt,
    directIds, sources.map((source) => [source.id, source.archivedAt, source.accessDomain,
      documentId(source.metadata), brainSourceContentFingerprint(source)]),
    documents.map((item) => [item.id, item.updatedAt, item.archivedAt]),
    relatedSources.sort((a, b) => a.id.localeCompare(b.id)).map((source) => [source.id, source.archivedAt,
      source.accessDomain, documentId(source.metadata), brainSourceContentFingerprint(source)]),
    relatedDocuments.sort((a, b) => a.id.localeCompare(b.id)).map((item) => [item.id, item.updatedAt, item.archivedAt]),
    impactedArticles.sort((a, b) => a.id.localeCompare(b.id)).map((item) => [item.id, item.updatedAt, item.bodyMd,
      item.sourceIds, item.derivationJson]),
  ])).digest("hex");
  const lockIds = [...new Set([...sources.map((source) => source.id), ...impactedArticles.flatMap((item) => [
    ...item.sourceIds, ...sourceIdsInDerivation(item.derivationJson),
  ])])].sort();
  return {
    article: { id: article.id, slug: article.slug, title: article.title }, token,
    hasSources: directIds.length > 0,
    canRemoveSources: canRemoveSources && blockReasons.length === 0 && directIds.length > 0,
    blockReasons: [...new Set(blockReasons)],
    sources: canRemoveSources ? sourceDetails : [],
    documents: canRemoveSources ? documents.map((item) => ({ id: item.id, title: item.title })) : [],
    sourceIds: activeIds, lockIds, documentIds, lockDocumentIds: [...new Set([...documentIds, ...relatedDocumentIds])].sort(),
  };
}

export async function previewBrainArticleRemoval(actor: AppActor, params: { workspaceId: string; slug: string }) {
  const { sourceIds: _sourceIds, lockIds: _lockIds, documentIds: _documentIds, lockDocumentIds: _lockDocumentIds, ...preview } =
    await buildPreview(prisma, actor, params.workspaceId, params.slug);
  return preview;
}

export async function confirmBrainArticleRemoval(actor: AppActor, params: {
  workspaceId: string; slug: string; mode: RemovalMode; expectedToken: string; confirmation: string;
}) {
  invariant(params.confirmation === "archive_article" && ["keep_sources", "remove_sources"].includes(params.mode)
    && /^[a-f0-9]{64}$/.test(params.expectedToken), 400, "INVALID_CONFIRMATION", "Choose and confirm an article removal option.");
  return prisma.$transaction(async (tx) => {
    const initial = await buildPreview(tx, actor, params.workspaceId, params.slug);
    for (const id of initial.lockIds) {
      await lockBrainSourceLink(tx, id);
      await tx.$queryRaw`SELECT id FROM "BrainSource" WHERE id = ${id} AND "workspaceId" = ${params.workspaceId} FOR UPDATE`;
    }
    for (const id of initial.lockDocumentIds) {
      await tx.$queryRaw`SELECT id FROM "Document" WHERE id = ${id} AND "workspaceId" = ${params.workspaceId} FOR UPDATE`;
    }
    await tx.$queryRaw`SELECT id FROM "BrainArticle" WHERE id = ${initial.article.id} AND "workspaceId" = ${params.workspaceId} FOR UPDATE`;
    const current = await buildPreview(tx, actor, params.workspaceId, params.slug);
    invariant(current.token === params.expectedToken, 409, "REMOVAL_PREVIEW_CHANGED", "Article or source impact changed. Review again.");
    if (params.mode === "remove_sources") {
      await requireBrainSourceRemovalEnabled(tx, params.workspaceId);
      invariant(current.canRemoveSources, 409, "SOURCE_ARTICLE_IMPACT_REVIEW_REQUIRED",
        "These sources need separate review before they can be removed.");
    }
    await archiveWorkspaceArtifact(actor, { workspaceId: params.workspaceId, entityType: "BrainArticle",
      entityId: current.article.id, reason: "Archived through confirmed article removal.", _tx: tx });
    const continued = params.mode === "remove_sources"
      ? await continueBrainSourceRemovals(tx, actor, params.workspaceId, current.sourceIds)
      : { pendingJobId: null, pendingSourceId: null };
    return { id: current.article.id, pendingJobId: continued.pendingJobId, pendingSourceId: continued.pendingSourceId };
  }, { maxWait: 5_000, timeout: 120_000 });
}
