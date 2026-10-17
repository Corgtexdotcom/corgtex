import { WorkItemReadRelease, readWorkItemListSnapshot } from "./work-item-readable-page";
import { getReadableBrainArticleVariant, requestBrainArticleVariant } from "./brain-article-variants";
import { prepareProducerLineage, finishProducerLineage, type ProducerLineageParams } from "./producer-lineage";
import { captureReadableDigestInputs, DigestReadRelease, mergeArtifactInputProofs } from "./digest-lineage";
import { visitSourceReadableRecords } from "./source-scoped-read";
import type { BrainArticle, BrainArticleAuthority, BrainArticleType, BrainDiscussionTargetType, BrainSource, BrainSourceType } from "@prisma/client";
import { Prisma } from "@prisma/client";
import { isDeepStrictEqual } from "node:util";
import { prisma } from "@corgtex/shared";
import type { AppActor } from "@corgtex/shared";
import { appendEvents } from "./events";
import { requireWorkspaceMembership } from "./auth";
import { archiveFilterWhere, archiveWorkspaceArtifact, getWorkspaceArchiveRecord, ArchiveMetadataReadRelease, type ArchiveFilter } from "./archive";
import { resolveKnowledgeAccessDomains } from "./brain-access";
import { lockActiveArticleSources, lockBrainSourceLink } from "./brain-source-links";
import { requestBrainSourceRemoval } from "./brain-source-removal";
import { brainSourceContentFingerprint, type BrainArticleDerivationV1 } from "./brain-derivation";
import { readBrainArticleDerivation, sourceIdsInDerivation } from "./brain-source-impact";
import { createBrainArticleHistoryVersion, currentArtifactInputRoots, lineageContentFingerprint, readableArtifactIds, readableBrainSourceIds,
  assertArtifactInputWriteFence, isArtifactInputProofReadable, captureArtifactInputProof, captureArtifactReadHeadObservation,
  isArtifactInputProofReadableAtObservedHeads, withArtifactCountReleaseSnapshot,
  recordArtifactInputLineage, type LineageRoot } from "./source-lineage";
import { AppError, invariant } from "./errors";
import { persistedMemberId } from "./membership";
import { requireDraftManager, requireCreationInputRoots } from "./draft-permissions";
import { prepareArtifactCommitPreflight, withArtifactCommitPreflight } from "./artifact-commit-preflight";
import { ensureWorkspacePermalink, workspaceEntityCanonicalPath } from "./permalinks";
import {
  checkWorkspaceDuplicateGuard,
  duplicateGuardAuditMeta,
  duplicateGuardMergeText,
  type DuplicateGuardOptions,
} from "./duplicate-guard";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

async function readableDiscussionAuthor<T extends { id: string; userId: string; user: { displayName: string | null; email: string } }>(
  actor: AppActor, workspaceId: string, member: T | null, release?: DigestReadRelease | WorkItemReadRelease,
) {
  if (!member) return null;
  // Member admission uses its canonical minimal relation; retain the separately
  // serialized full profile as its own User input.
  const input = { ...member, user: { id: member.userId, displayName: member.user.displayName, email: member.user.email } };
  const capture = () => captureReadableDigestInputs({ actor, workspaceId, kind: "Member", records: [input],
    db: release && "db" in release ? release.db : undefined,
    additionalInputs: (row) => [{ kind: "User", id: row.userId, snapshot: { ...member.user, id: row.userId } }] });
  const admitted = release ? await release.observeRead(capture) : await capture();
  release?.add(admitted.roots);
  return admitted.records.length ? member : null;
}

async function readableDiscussionRows<T extends { id: string; comments: Array<{ id: string }> }>(actor: AppActor, workspaceId: string,
  rows: T[], release?: DigestReadRelease) {
  const threadIds = release
    ? new Set((await release.capture("BrainDiscussionThread", rows)).records.map(row => row.id))
    : await readableArtifactIds(actor, workspaceId, "BrainDiscussionThread", rows);
  const threads = rows.filter((thread) => threadIds.has(thread.id));
  const comments = threads.flatMap(thread => thread.comments);
  const commentIds = release
    ? new Set((await release.capture("BrainDiscussionComment", comments)).records.map(row => row.id))
    : await readableArtifactIds(actor, workspaceId, "BrainDiscussionComment", comments);
  return threads.map((thread) => ({ ...thread, comments: thread.comments.filter((comment) => commentIds.has(comment.id)) as T["comments"] }));
}

function slugify(input: string) {
  return input
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 120);
}

function metadataString(value: Prisma.InputJsonValue | undefined, key: string) {
  const metadata = typeof value === "object" && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
  const metadataValue = metadata?.[key];
  return typeof metadataValue === "string" && metadataValue.trim() ? metadataValue.trim() : null;
}

export const WIKILINK_RE = /\[\[([^\]]+)\]\]/g;

function normalizedMemberId(value: string | null | undefined) {
  const trimmed = value?.trim();
  return trimmed ? trimmed : null;
}

async function nextAvailableArticleSlug(tx: Prisma.TransactionClient, workspaceId: string, baseSlug: string) {
  let candidate = baseSlug;
  for (let suffix = 2; suffix < 1000; suffix += 1) {
    const existing = await tx.brainArticle.findUnique({
      where: {
        workspaceId_slug: {
          workspaceId,
          slug: candidate,
        },
      },
      select: { id: true },
    });
    if (!existing) return candidate;
    candidate = `${baseSlug}-${suffix}`;
  }
  throw new Error("Unable to generate a unique article slug.");
}

// ---------------------------------------------------------------------------
// Articles
// ---------------------------------------------------------------------------

export async function createArticle(actor: AppActor, params: {
  workspaceId: string;
  slug?: string;
  title: string;
  type: BrainArticleType;
  authority?: BrainArticleAuthority;
  bodyMd: string;
  frontmatterJson?: Prisma.InputJsonValue;
  ownerMemberId?: string | null;
  staleAfterDays?: number;
  sourceIds?: string[];
  isPrivate?: boolean;
  duplicateGuard?: DuplicateGuardOptions | null;
  // Supplied only by the source absorption agent for a newly generated article.
  derivation?: { sourceId: string; sourceFingerprint: string; agentRunId: string };
  /** Trusted, complete prompt receipt captured by an internal producer. */
  completeInputRoots?: LineageRoot[];
  tx?: Prisma.TransactionClient;
}) {
  const membership = await requireWorkspaceMembership({
    actor,
    workspaceId: params.workspaceId,
    tx: params.tx,
  });
  const isPrivate = params.isPrivate ?? ((params.authority ?? "DRAFT") === "DRAFT");
  params = { ...params, completeInputRoots: await requireCreationInputRoots({ actor, workspaceId: params.workspaceId,
    isPrivate, roots: params.completeInputRoots, tx: params.tx }) };

  const title = params.title.trim();
  invariant(title.length > 0, 400, "INVALID_INPUT", "Article title is required.");

  const requestedSlug = slugify(params.slug?.trim() || title);
  invariant(requestedSlug.length > 0, 400, "INVALID_INPUT", "Article slug is required.");
  const duplicateDecision = await checkWorkspaceDuplicateGuard({
    workspaceId: params.workspaceId,
    entityType: "BrainArticle",
    title,
    body: params.bodyMd,
    slug: requestedSlug,
    articleType: params.type,
    sourceIds: params.sourceIds,
    actorUserId: actor.kind === "user" ? actor.user.id : null,
    membershipId: membership?.id ?? null,
    includePrivate: actor.kind === "user" && membership?.role === "ADMIN",
  }, params.duplicateGuard, params.tx, async (rows) => {
    const candidates = rows as Array<{ id: string; [key: string]: unknown }>;
    const readable = await readableArtifactIds(actor, params.workspaceId, "BrainArticle", candidates, params.tx ?? prisma);
    return candidates.filter((candidate) => readable.has(candidate.id));
  });
  if (duplicateDecision?.resolution === "use_existing") {
    const article = await (params.tx ?? prisma).brainArticle.findFirst({
      where: { id: duplicateDecision.match.entityId, workspaceId: params.workspaceId, archivedAt: null },
    });
    invariant(article, 404, "NOT_FOUND", "Article not found.");
    invariant((await readableArtifactIds(actor, params.workspaceId, "BrainArticle", [article], params.tx ?? prisma)).has(article.id),
      404, "NOT_FOUND", "Article not found.");
    return article;
  }
  if (duplicateDecision?.resolution === "update_existing") {
    const article = await (params.tx ?? prisma).brainArticle.findFirst({
      where: { id: duplicateDecision.match.entityId, workspaceId: params.workspaceId, archivedAt: null },
    });
    invariant(article, 404, "NOT_FOUND", "Article not found.");
    invariant((await readableArtifactIds(actor, params.workspaceId, "BrainArticle", [article], params.tx ?? prisma)).has(article.id),
      404, "NOT_FOUND", "Article not found.");
    return updateArticle(actor, {
      workspaceId: params.workspaceId,
      slug: article.slug,
      bodyMd: duplicateGuardMergeText(article.bodyMd, params.bodyMd) ?? article.bodyMd,
      ownerMemberId: article.ownerMemberId || params.ownerMemberId || undefined,
      sourceIds: Array.from(new Set([...(article.sourceIds ?? []), ...(params.sourceIds ?? [])])),
      changeSummary: "Merged duplicate upload context.",
      additionalInputRoots: params.completeInputRoots,
      tx: params.tx,
    });
  }


  const membershipId = persistedMemberId(membership);

  const run = async (tx: Prisma.TransactionClient) => {
    await requireCreationInputRoots({ actor, workspaceId: params.workspaceId, isPrivate, roots: params.completeInputRoots, tx });
    let derivation: BrainArticleDerivationV1 | null = null;
    await lockActiveArticleSources(tx, params.workspaceId, params.sourceIds ?? []);
    if (params.derivation) {
      invariant(actor.kind === "agent" && actor.label === "brain-absorb"
        || await (await import("./legacy-recovery")).isLegacyRecoveryDerivationCurrent(actor,params.workspaceId,params.derivation,tx),
      403,"FORBIDDEN","Only source absorption can record article derivation.");
      invariant(params.sourceIds?.includes(params.derivation.sourceId), 400, "INVALID_INPUT", "Derived source must be linked to the article.");
      await tx.$queryRaw`SELECT id FROM "BrainSource" WHERE id = ${params.derivation.sourceId} AND "workspaceId" = ${params.workspaceId} FOR UPDATE`;
      const source = await tx.brainSource.findFirst({
        where: { id: params.derivation.sourceId, workspaceId: params.workspaceId, archivedAt: null },
      });
      invariant(source, 404, "NOT_FOUND", "Derivation source not found.");
      invariant(brainSourceContentFingerprint(source) === params.derivation.sourceFingerprint, 409, "SOURCE_CHANGED", "Source changed during article generation.");
      derivation = {
        version: 1,
        origin: "brain-absorb",
        agentRunId: params.derivation.agentRunId,
        sources: [{ sourceId: source.id, fingerprint: params.derivation.sourceFingerprint }],
      };
    }
    const slug = await nextAvailableArticleSlug(tx, params.workspaceId, requestedSlug);
    const article = await tx.brainArticle.create({
      data: {
        workspaceId: params.workspaceId,
        slug,
        title,
        type: params.type,
        authority: params.authority ?? "DRAFT",
        bodyMd: params.bodyMd,
        frontmatterJson: params.frontmatterJson ?? Prisma.JsonNull,
        ownerMemberId: isPrivate ? (membershipId ?? params.ownerMemberId ?? null) : (params.ownerMemberId ?? null),
        staleAfterDays: params.staleAfterDays ?? 90,
        sourceIds: params.sourceIds ?? [],
        ...(derivation ? { derivationJson: derivation } : {}),
        isPrivate,
        publishedAt: isPrivate ? null : new Date(),
        lastVerifiedAt: new Date(),
      },
    });

    await recordArtifactInputLineage({
      tx, actor, workspaceId: params.workspaceId,
      artifact: { kind: "BrainArticle", id: article.id }, content: article,
      origin: actor.kind === "user" && !(params.sourceIds?.length) && !params.completeInputRoots?.length ? "HUMAN_ORIGINAL" : "DERIVED",
      inputs: (params.sourceIds ?? []).map((id) => ({ kind: "BrainSource", id })),
      inheritedRoots: params.completeInputRoots,
    });

    await ensureWorkspacePermalink(tx, actor, {
      workspaceId: params.workspaceId,
      entityType: "BrainArticle",
      entityId: article.id,
      canonicalPath: workspaceEntityCanonicalPath(params.workspaceId, "BrainArticle", article),
    });

    await tx.auditLog.create({
      data: {
        workspaceId: params.workspaceId,
        actorUserId: actor.kind === "user" ? actor.user.id : null,
        action: "brain-article.created",
        entityType: "BrainArticle",
        entityId: article.id,
        meta: { title: article.title, slug: article.slug, type: article.type, ...duplicateGuardAuditMeta(duplicateDecision) },
      },
    });

    await appendEvents(tx, [
      {
        workspaceId: params.workspaceId,
        type: "brain-article.created",
        aggregateType: "BrainArticle",
        aggregateId: article.id,
        payload: { articleId: article.id },
      },
    ]);

    return article;
  };

  if (params.tx) return run(params.tx);
  // Native contributors must be replayed before opening the writer transaction.
  // The one-use receipt then makes their exact original proof readable within
  // that transaction without permitting provider I/O there.
  const roots = params.completeInputRoots;
  const commitPreflight = roots?.length
    ? await prepareArtifactCommitPreflight(actor, params.workspaceId, roots) : undefined;
  return prisma.$transaction(tx => commitPreflight
    ? withArtifactCommitPreflight(actor, params.workspaceId, tx, roots!, commitPreflight, () => run(tx))
    : run(tx));
}

export async function updateArticle(actor: AppActor, params: {
  workspaceId: string;
  slug: string;
  title?: string;
  type?: BrainArticleType;
  authority?: BrainArticleAuthority;
  bodyMd?: string;
  frontmatterJson?: Prisma.InputJsonValue;
  ownerMemberId?: string | null;
  staleAfterDays?: number;
  sourceIds?: string[];
  changeSummary?: string;
  agentRunId?: string | null;
  expectedUpdatedAt?: Date;
  // Only the absorption agent can append verified generation lineage.
  absorbedSource?: { sourceId: string; sourceFingerprint: string; agentRunId: string };
  /** A full regeneration uses no old body, title, aliases or linked sources. */
  completeInputRoots?: LineageRoot[];
  additionalInputRoots?: LineageRoot[];
  tx?: Prisma.TransactionClient;
}) {
  const membership = await requireWorkspaceMembership({
    actor,
    workspaceId: params.workspaceId,
    tx: params.tx,
  });

  const run = async (tx: Prisma.TransactionClient) => {
    const preliminary = await tx.brainArticle.findUnique({
      where: {
        workspaceId_slug: {
          workspaceId: params.workspaceId,
          slug: params.slug,
        },
      },
    });
    invariant(preliminary, 404, "NOT_FOUND", "Article not found.");
    invariant(!preliminary.variantOfArticleId, 409, "IMMUTABLE_VARIANT", "A permitted-source variant is immutable.");
    const sourceIdsToLock = [...new Set([
      ...preliminary.sourceIds, ...sourceIdsInDerivation(preliminary.derivationJson),
      ...(params.sourceIds ?? []), ...(params.absorbedSource ? [params.absorbedSource.sourceId] : []),
    ])].sort();
    for (const id of sourceIdsToLock) await lockBrainSourceLink(tx, id);
    await tx.$queryRaw`SELECT id FROM "BrainArticle" WHERE id = ${preliminary.id} AND "workspaceId" = ${params.workspaceId} FOR UPDATE`;
    const article = await tx.brainArticle.findUnique({ where: { id: preliminary.id } });
    invariant(article && !article.archivedAt, 409, "ARTICLE_CHANGED", "Article was archived or changed. Refresh and try again.");
    let rebuildingGeneratedDigest = false;
    if (params.completeInputRoots?.length && actor.kind === "agent" && actor.authProvider === "bootstrap" && actor.label === "daily-digest-agent"
      && article.type === "DIGEST" && article.authority === "DRAFT" && article.ownerMemberId === null && article.humanEditedAt === null
      && (article.frontmatterJson as Record<string, unknown> | null)?.generatedBy === "daily-digest") {
      const [manifest, creation] = await Promise.all([
        tx.artifactInputLineage.findFirst({ where: { workspaceId: params.workspaceId, artifactType: "BrainArticle", artifactId: article.id }, orderBy: { revision: "desc" } }),
        tx.auditLog.findFirst({ where: { workspaceId: params.workspaceId, entityType: "BrainArticle", entityId: article.id,
          action: "brain-article.created" }, orderBy: { createdAt: "asc" }, select: { actorUserId: true } }),
      ]);
      rebuildingGeneratedDigest = manifest?.origin === "DERIVED" && Boolean(creation && creation.actorUserId === null)
        && await currentArtifactInputRoots(tx, params.workspaceId, { kind: "BrainArticle", id: article.id }, article) !== null;
    }
    invariant(!params.completeInputRoots || rebuildingGeneratedDigest, 409, "MANUAL_REBUILD_REQUIRED",
      "Automatic regeneration cannot replace an original or human-edited article.");
    invariant(rebuildingGeneratedDigest || (await readableArtifactIds(actor, params.workspaceId, "BrainArticle", [article], tx)).has(article.id),
      404, "NOT_FOUND", "Article not found.");
    invariant(article.updatedAt.getTime() === preliminary.updatedAt.getTime()
      && JSON.stringify(article) === JSON.stringify(preliminary)
      && (!params.expectedUpdatedAt || article.updatedAt.getTime() === params.expectedUpdatedAt.getTime()),
    409, "ARTICLE_CHANGED", "Article changed. Refresh and try again.");
    invariant(sourceIdsInDerivation(article.derivationJson).every((id) => sourceIdsToLock.includes(id))
      && article.sourceIds.every((id) => sourceIdsToLock.includes(id)),
    409, "ARTICLE_CHANGED", "Article sources changed. Refresh and try again.");
    invariant(!params.absorbedSource || (actor.kind === "agent" && params.sourceIds === undefined),
      403, "FORBIDDEN", "Only the absorption agent can append verified source lineage.");

    const editsDraftContent = params.title !== undefined
      || params.type !== undefined
      || params.authority !== undefined
      || params.bodyMd !== undefined
      || params.frontmatterJson !== undefined
      || params.ownerMemberId !== undefined
      || params.staleAfterDays !== undefined
      || params.sourceIds !== undefined
      || params.absorbedSource !== undefined;
    invariant(editsDraftContent, 400, "INVALID_INPUT", "An article change is required.");
    if (editsDraftContent) {
      invariant(article.authority === "DRAFT", 400, "INVALID_STATE", "Only draft Brain articles can be edited.");
      if (!rebuildingGeneratedDigest) await requireDraftManager({ actor, workspaceId: params.workspaceId, record: article, resolvedMembership: membership, tx });
    }
    if (params.type !== undefined && params.type !== article.type) {
      invariant(article.type !== "DIGEST" && params.type !== "DIGEST", 400, "INVALID_INPUT", "Digest article type cannot be changed.");
    }

    const nextSourceIds = params.absorbedSource
      ? [...new Set([...article.sourceIds, params.absorbedSource.sourceId])]
      : params.sourceIds;
    if (nextSourceIds !== undefined) await lockActiveArticleSources(tx, params.workspaceId, nextSourceIds);
    const priorRoots = await currentArtifactInputRoots(tx, params.workspaceId,
      { kind: "BrainArticle", id: article.id }, article);
    if (params.completeInputRoots) invariant(actor.kind === "agent" && params.completeInputRoots.length > 0
      && params.title !== undefined && params.bodyMd !== undefined && params.type !== undefined
      && params.frontmatterJson !== undefined && params.sourceIds !== undefined,
    409, "UNKNOWN_LINEAGE", "A complete regeneration must replace all article content inputs.");
    invariant(actor.kind !== "agent" || priorRoots !== null || Boolean(params.completeInputRoots?.length), 409, "UNKNOWN_LINEAGE",
      "An agent cannot reuse an article whose inputs are unknown.");

    // Create version snapshot of previous body before updating
    let previousVersionId: string | null = null;
    if (params.bodyMd !== undefined && params.bodyMd !== article.bodyMd) {
      const canPreserveKnownHistory = priorRoots !== null && (!params.completeInputRoots
        || await isArtifactInputProofReadable(actor, params.workspaceId, [{ kind: "BrainArticle", id: article.id,
          fingerprint: lineageContentFingerprint("BrainArticle", article) }], tx));
      const lastVersion = await tx.brainArticleVersion.findFirst({
        where: { articleId: article.id },
        orderBy: { version: "desc" },
        select: { version: true },
      });

      const history = await createBrainArticleHistoryVersion({tx, workspaceId: params.workspaceId,
        article, version: (lastVersion?.version ?? 0) + 1, reason: "BODY_EDIT",
        preserveKnownHistory: canPreserveKnownHistory});
      if (history.preserved) previousVersionId = history.version.id;
    }

    const data: Record<string, unknown> = {};
    if (params.title !== undefined) {
      const title = params.title.trim();
      invariant(title.length > 0, 400, "INVALID_INPUT", "Article title is required.");
      data.title = title;
    }
    if (params.type !== undefined) data.type = params.type;
    if (params.authority !== undefined) data.authority = params.authority;
    if (params.bodyMd !== undefined) data.bodyMd = params.bodyMd;
    if (params.frontmatterJson !== undefined) data.frontmatterJson = params.frontmatterJson;
    if (params.ownerMemberId !== undefined) data.ownerMemberId = params.ownerMemberId;
    if (params.staleAfterDays !== undefined) data.staleAfterDays = params.staleAfterDays;
    if (nextSourceIds !== undefined) data.sourceIds = nextSourceIds;
    if (params.completeInputRoots) data.derivationJson = Prisma.JsonNull;
    if (params.absorbedSource) {
      const source = await tx.brainSource.findFirst({ where: {
        id: params.absorbedSource.sourceId, workspaceId: params.workspaceId, archivedAt: null,
      } });
      invariant(source && brainSourceContentFingerprint(source) === params.absorbedSource.sourceFingerprint,
        409, "SOURCE_CHANGED", "Absorbed source changed before article update.");
      const prior = readBrainArticleDerivation(article.derivationJson);
      const priorIds = new Set(prior?.sources.map((entry) => entry.sourceId) ?? []);
      if (prior && article.sourceIds.length === priorIds.size && article.sourceIds.every((id) => priorIds.has(id))) {
        data.derivationJson = { ...prior, agentRunId: params.absorbedSource.agentRunId,
          sources: [...prior.sources.filter((entry) => entry.sourceId !== source.id),
            { sourceId: source.id, fingerprint: params.absorbedSource.sourceFingerprint }],
        };
      }
    }
    const changesDraftContent = Object.entries(data).some(([field, value]) =>
      !isDeepStrictEqual(article[field as keyof typeof article], value));
    if (actor.kind === "user" && (article.derivationJson || priorRoots?.length) && changesDraftContent) {
      data.humanEditedAt = new Date();
    }

    const updated = await tx.brainArticle.update({
      where: { id: article.id },
      data,
    });
    if (params.completeInputRoots) {
      await recordArtifactInputLineage({ tx, actor, workspaceId: params.workspaceId,
        artifact: { kind: "BrainArticle", id: updated.id }, content: updated, origin: "DERIVED",
        inputs: (nextSourceIds ?? []).map((id) => ({ kind: "BrainSource", id })), inheritedRoots: params.completeInputRoots });
    } else if (priorRoots) {
      const inputs = [
        // History storage is not an additional input for a direct human original.
        // Model updates and edits to derived bodies retain their consumed history.
        ...(previousVersionId && (actor.kind === "agent" || priorRoots.length > 0)
          ? [{ kind: "BrainArticleVersion" as const, id: previousVersionId }] : []),
        ...(nextSourceIds ?? []).map((id) => ({ kind: "BrainSource" as const, id })),
      ];
      await recordArtifactInputLineage({
        tx, actor, workspaceId: params.workspaceId,
        artifact: { kind: "BrainArticle", id: updated.id }, content: updated,
        origin: inputs.length || priorRoots.length ? "DERIVED" : "HUMAN_ORIGINAL",
        inputs,
        inheritedRoots: [...priorRoots, ...(params.additionalInputRoots ?? [])],
      });
    }
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${`brain_article_index:${params.workspaceId}:${article.id}`}, 0))`;

    await tx.auditLog.create({
      data: {
        workspaceId: params.workspaceId,
        actorUserId: actor.kind === "user" ? actor.user.id : null,
        action: "brain-article.updated",
        entityType: "BrainArticle",
        entityId: updated.id,
        meta: { fields: Object.keys(data), slug: updated.slug },
      },
    });

    await appendEvents(tx, [
      ...(actor.kind === "user" ? [{ workspaceId: params.workspaceId, type: "source-lineage.changed", aggregateType: "BrainArticle", aggregateId: updated.id, payload: { entityType: "BrainArticle", entityId: updated.id } }] : []),
      {
        workspaceId: params.workspaceId,
        type: "brain-article.updated",
        aggregateType: "BrainArticle",
        aggregateId: updated.id,
        payload: { articleId: updated.id },
      },
    ]);

    return updated;
  };

  return params.tx ? run(params.tx) : prisma.$transaction(run);
}

export async function getArticle(actor: AppActor, params: {
  workspaceId: string;
  slug: string;
  includeArchived?: boolean;
}) {
  const release = new DigestReadRelease(actor, params.workspaceId);
  return release.finish(await readArticle(actor, params, release));
}

async function readArticle(actor: AppActor, params: {
  workspaceId: string; slug: string; includeArchived?: boolean;
}, release: DigestReadRelease) {
  const membership = await requireWorkspaceMembership({
    actor,
    workspaceId: params.workspaceId,
  });

  const article = await prisma.brainArticle.findFirst({
    where: {
      workspaceId: params.workspaceId,
      slug: params.slug,
      ...(params.includeArchived ? {} : { archivedAt: null }),
    },
    include: {
      ownerMember: {
        include: {
          user: { select: { displayName: true, email: true } },
        },
      },
      backlinksTo: {
        include: {
          fromArticle: { select: { slug: true, title: true, type: true } },
        },
      },
      backlinksFrom: {
        include: {
          toArticle: { select: { slug: true, title: true, type: true } },
        },
      },
      discussions: {
        where: { status: "OPEN" },
        include: {
          authorMember: {
            include: {
              user: { select: { displayName: true, email: true } },
            },
          },
          comments: {
            include: {
              authorMember: {
                include: {
                  user: { select: { displayName: true, email: true } },
                },
              },
            },
            orderBy: { createdAt: "asc" },
          },
        },
        orderBy: { createdAt: "desc" },
      },
    },
  });

  invariant(article, 404, "NOT_FOUND", "Article not found.");

  if (article.isPrivate) {
    const canReadPrivateDraft = actor.kind === "agent"
      || membership?.role === "ADMIN"
      || (actor.kind === "user" && article.ownerMember?.userId === actor.user.id);
    invariant(canReadPrivateDraft, 404, "NOT_FOUND", "Article not found.");
  }

  // Preserve the original admitted article before backlinks and author reads.
  // Every returned contributor is released together after those later awaits.
  const readable = new Set((await release.capture("BrainArticle", [article])).records.map(row => row.id));
  if (!readable.has(article.id) && !article.variantOfArticleId && !article.archivedAt && actor.kind === "user") {
    const variant = await getReadableBrainArticleVariant(actor, { workspaceId: params.workspaceId, articleId: article.id });
    if (variant) return readArticle(actor, { workspaceId: params.workspaceId, slug: variant.slug }, release);
    await requestBrainArticleVariant(actor, { workspaceId: params.workspaceId, articleId: article.id });
  }
  invariant(readable.has(article.id), 404, "NOT_FOUND", "Article not found.");
  const ownerMember = await readableDiscussionAuthor(actor, params.workspaceId, article.ownerMember, release);
  const linkedIds = [...new Set([
    ...article.backlinksTo.map((link) => link.fromArticleId),
    ...article.backlinksFrom.map((link) => link.toArticleId),
  ])];
  const linked = linkedIds.length ? await prisma.brainArticle.findMany({
    where: { workspaceId: params.workspaceId, id: { in: linkedIds }, archivedAt: null },
  }) : [];
  const readableLinked = new Map((await release.capture("BrainArticle", linked)).records.map(row => [row.id, row]));
  const linkedLabel = (id: string) => {
    const row = readableLinked.get(id)!;
    return {slug: row.slug, title: row.title, type: row.type};
  };
  const discussions = await Promise.all((await readableDiscussionRows(actor, params.workspaceId, article.discussions, release)).map(async (thread) => {
    const authorMember = await readableDiscussionAuthor(actor, params.workspaceId, thread.authorMember, release);
    return { ...thread, authorMember, authorMemberId: authorMember?.id ?? null,
      comments: await Promise.all(thread.comments.map(async (comment) => {
        const authorMember = await readableDiscussionAuthor(actor, params.workspaceId, comment.authorMember, release);
        return { ...comment, authorMember, authorMemberId: authorMember?.id ?? null, agentRunId: null };
      })) };
  }));

  return {
    ...article,
    ownerMember,
    isPermissionVariant: Boolean(article.variantOfArticleId),
    variantOfArticleId: null, variantTargetFingerprint: null, variantInputSetHash: null,
    variantSourceStateJson: null, variantGenerationJobId: null,
    backlinksTo: article.backlinksTo.filter((link) => readableLinked.has(link.fromArticleId))
      .map(link => ({...link, fromArticle: linkedLabel(link.fromArticleId)})),
    backlinksFrom: article.backlinksFrom.filter((link) => readableLinked.has(link.toArticleId))
      .map(link => ({...link, toArticle: linkedLabel(link.toArticleId)})),
    discussions,
  };
}

/** Retain the main article's original proof through every later page read. */
export async function getArticlePageData(actor: AppActor, params: {workspaceId: string; slug: string}) {
  const archiveRelease = new ArchiveMetadataReadRelease(actor, params.workspaceId);
  const release = new DigestReadRelease(actor, params.workspaceId);
  const membership = await requireWorkspaceMembership({actor, workspaceId: params.workspaceId});
  if (membership) invariant((await release.capture("Member", [membership])).records.length === 1,
    409, "SOURCE_CHANGED", "Article page membership changed during collection.");
  const article = await readArticle(actor, {...params, includeArchived: true}, release);
  const isArchived = Boolean(article.archivedAt);
  const isAdmin = actor.kind === "agent" || membership?.role === "ADMIN";
  const archiveRecord = isArchived
    ? await getWorkspaceArchiveRecord(actor, {workspaceId: params.workspaceId, entityType: "BrainArticle", entityId: article.id}, archiveRelease)
    : null;
  const canManage = !isArchived && !article.isPermissionVariant && (isAdmin
    || (Boolean(article.ownerMemberId) && article.ownerMemberId === membership?.id));
  const {items} = await listArticles(actor, {workspaceId: params.workspaceId, take: 50}, release);
  const otherArticles = items.filter(row => row.id !== article.id).slice(0, 5)
    .map(({id, slug, title, type}) => ({id, slug, title, type}));
  const candidates = article.sourceIds.length ? await prisma.brainSource.findMany({where: {
    workspaceId: params.workspaceId, id: {in: article.sourceIds},
  }}) : [];
  const sources = (await release.capture("BrainSource", candidates)).records;
  return archiveRelease.finish({article, otherArticles, sources, isArchived, isAdmin, canManage, archiveRecord}, release);
}

export async function listArticles(actor: AppActor, params: {
  workspaceId: string;
  type?: BrainArticleType;
  authority?: BrainArticleAuthority;
  stale?: boolean;
  take?: number;
  skip?: number;
  archiveFilter?: ArchiveFilter;
}, release?: DigestReadRelease) {
  const membership = await requireWorkspaceMembership({
    actor,
    workspaceId: params.workspaceId,
  });

  const relationRelease = release ?? new DigestReadRelease(actor, params.workspaceId);
  const take = params.take ?? 50;
  const skip = params.skip ?? 0;

  const privacyFilter = actor.kind === "user" && membership?.role === "ADMIN"
    ? [{ isPrivate: false }, { isPrivate: true, authority: "DRAFT" as const }]
    : actor.kind === "user" && membership
      ? [{ isPrivate: false }, { isPrivate: true, ownerMemberId: membership.id }]
      : [{ isPrivate: false }];

  // List filters select target articles; incoming sources retain the same
  // workspace/archive/privacy scope without inheriting type, authority or age.
  const backlinkSourceWhere: Prisma.BrainArticleWhereInput = {
    workspaceId: params.workspaceId,
    ...archiveFilterWhere(params.archiveFilter),
    OR: privacyFilter,
  };

  const baseWhere = {
    workspaceId: params.workspaceId,
    ...(params.type ? { type: params.type } : {}),
    ...(params.authority ? { authority: params.authority } : {}),
    ...archiveFilterWhere(params.archiveFilter),
  };

  const where: Prisma.BrainArticleWhereInput = {
    AND: [
      baseWhere,
      { OR: privacyFilter }
    ]
  };

  if (params.stale) {
    where.AND = [
      ...(where.AND ? (where.AND as any) : []),
      {
        OR: [
          {
            lastVerifiedAt: null,
            createdAt: { lt: new Date(Date.now() - 90 * 24 * 60 * 60 * 1000) },
          },
          {
            lastVerifiedAt: { lt: new Date(Date.now() - 90 * 24 * 60 * 60 * 1000) },
          },
        ]
      }
    ];
  }

  type ListedArticle = Omit<BrainArticle, keyof Awaited<ReturnType<typeof articleListRelations>>>
    & Awaited<ReturnType<typeof articleListRelations>>;
  const items: ListedArticle[] = [];
  const selected: BrainArticle[] = [];
  let total = 0;
  let variantRequests = 0;
  let after: { id: string; updatedAt: Date } | undefined;
  while (true) {
    // Full canonical rows are needed for fingerprint validation; relations are
    // loaded only for the requested visible page, never for the scanned corpus.
    const candidates: BrainArticle[] = await prisma.brainArticle.findMany({
      where: after ? { AND: [where, { OR: [{ updatedAt: { lt: after.updatedAt } },
        { updatedAt: after.updatedAt, id: { lt: after.id } }] }] } : where,
      orderBy: [{ updatedAt: "desc" }, { id: "desc" }], take: 100,
    });
    const last = candidates.at(-1);
    const next = last ? { id: last.id, updatedAt: last.updatedAt } : undefined;
    const initial = release
      ? new Set((await release.capture("BrainArticle", candidates)).records.map(row => row.id))
      : await readableArtifactIds(actor, params.workspaceId, "BrainArticle", candidates);
    if (actor.kind === "user" && variantRequests < take) for (const candidate of candidates) {
      if (variantRequests >= take) break;
      if (!initial.has(candidate.id) && !candidate.variantOfArticleId && !candidate.archivedAt) {
        variantRequests++;
        await requestBrainArticleVariant(actor, { workspaceId: params.workspaceId, articleId: candidate.id });
      }
    }
    const current = await readableArtifactIds(actor, params.workspaceId, "BrainArticle", candidates);
    for (const article of candidates) {
      if (!initial.has(article.id) || !current.has(article.id)) continue;
      if (total >= skip && items.length < take) {
        const related = await articleListRelations(actor, params.workspaceId, article, backlinkSourceWhere, relationRelease);
        // Related reads may have awaited a policy/content change. Never return
        // a new row using an old receipt or count a now-withheld selected row.
        if (!(await readableArtifactIds(actor, params.workspaceId, "BrainArticle", [article])).has(article.id)) continue;
        items.push({ ...article, ...related });
        selected.push(article);
      }
      total++;
    }
    if (candidates.length < 100) break;
    after = next;
  }
  const finalIds = await readableArtifactIds(actor, params.workspaceId, "BrainArticle", selected);
  const admitted = items.filter(article => finalIds.has(article.id));
  const retainedIds = release ? finalIds : new Set((await relationRelease.capture("BrainArticle",
    selected.filter(article => finalIds.has(article.id)))).records.map(article => article.id));
  const retained = admitted.filter(article => retainedIds.has(article.id));
  const result = { items: retained, total: total - (items.length - retained.length), take, skip };
  return release ? result : relationRelease.finish(result);
}

async function articleListRelations(actor: AppActor, workspaceId: string, article: BrainArticle,
  articleWhere: Prisma.BrainArticleWhereInput, release: DigestReadRelease) {
  const member = article.ownerMemberId ? await prisma.member.findFirst({ where: { id: article.ownerMemberId, workspaceId },
    include: { user: { select: { id: true, displayName: true, email: true, bio: true,
      avatarUrl: true, linkedinUrl: true, websiteUrl: true, createdAt: true, updatedAt: true } } },
  }) : null;
  const ownerMember = await readableDiscussionAuthor(actor, workspaceId, member, release);
  let discussions = 0;
  let afterThread: string | undefined;
  while (true) {
    const rows = await prisma.brainDiscussionThread.findMany({ where: { articleId: article.id,
      ...(afterThread ? { id: { gt: afterThread } } : {}) }, orderBy: { id: "asc" }, take: 100 });
    discussions += (await readableArtifactIds(actor, workspaceId, "BrainDiscussionThread", rows)).size;
    if (rows.length < 100) break;
    afterThread = rows.at(-1)!.id;
  }
  let backlinksTo = 0;
  let afterLink: string | undefined;
  while (true) {
    const links = await prisma.brainBacklink.findMany({ where: { workspaceId, toArticleId: article.id,
      fromArticle: articleWhere, ...(afterLink ? { id: { gt: afterLink } } : {}) },
      include: { fromArticle: true }, orderBy: { id: "asc" }, take: 100 });
    const readable = await readableArtifactIds(actor, workspaceId, "BrainArticle", links.map(link => link.fromArticle));
    backlinksTo += links.filter(link => readable.has(link.fromArticleId)).length;
    if (links.length < 100) break;
    afterLink = links.at(-1)!.id;
  }
  return { ownerMember, isPermissionVariant: Boolean(article.variantOfArticleId),
    variantOfArticleId: null, variantTargetFingerprint: null, variantInputSetHash: null,
    variantSourceStateJson: null, variantGenerationJobId: null, discussions: undefined,
    _count: { discussions, backlinksTo } };
}

export async function deleteArticle(actor: AppActor, params: {
  workspaceId: string;
  slug: string;
}) {
  await requireWorkspaceMembership({
    actor,
    workspaceId: params.workspaceId,
  });

  const archived = await archiveWorkspaceArtifact(actor, {
    workspaceId: params.workspaceId,
    entityType: "BrainArticle",
    entityId: params.slug,
    reason: "Archived from Brain article delete path.",
  });
  return { id: archived.id };
}

export async function listArticleVersions(actor: AppActor, params: {
  workspaceId: string;
  slug: string;
}) {
  await requireWorkspaceMembership({
    actor,
    workspaceId: params.workspaceId,
  });

  const article = await prisma.brainArticle.findUnique({
    where: {
      workspaceId_slug: {
        workspaceId: params.workspaceId,
        slug: params.slug,
      },
    },
  });

  invariant(article, 404, "NOT_FOUND", "Article not found.");

  const release = new DigestReadRelease(actor, params.workspaceId);
  invariant((await release.capture("BrainArticle", [article])).records.length, 404, "NOT_FOUND", "Article not found.");

  const versions = await prisma.brainArticleVersion.findMany({
    where: { articleId: article.id },
    orderBy: { version: "desc" },
  });
  const readableVersions = await release.capture("BrainArticleVersion", versions);
  return release.finish(readableVersions.records);
}

// ---------------------------------------------------------------------------
// Sources
// ---------------------------------------------------------------------------

export async function ingestSource(actor: AppActor, params: {
  workspaceId: string;
  sourceType: BrainSourceType;
  tier: number;
  content: string;
  title?: string | null;
  externalId?: string | null;
  channel?: string | null;
  authorMemberId?: string | null;
  ingestionGuidanceMd?: string | null;
  metadata?: Prisma.InputJsonValue;
  duplicateGuard?: DuplicateGuardOptions | null;
  /** Complete server-captured inputs when content was copied or generated. */
  lineageRoots?: LineageRoot[];
}) {
  const membership = await requireWorkspaceMembership({
    actor,
    workspaceId: params.workspaceId,
  });

  if (params.lineageRoots) invariant(params.lineageRoots.length > 0
    && await isArtifactInputProofReadable(actor, params.workspaceId, params.lineageRoots),
  409, "SOURCE_CHANGED", "Source inputs are no longer available.");

  invariant(params.content.trim().length > 0, 400, "INVALID_INPUT", "Source content is required.");
  invariant(params.tier >= 1 && params.tier <= 3, 400, "INVALID_INPUT", "Tier must be 1, 2, or 3.");
  const title = params.title?.trim() || null;
  const content = params.content.trim();
  const authorMemberId = normalizedMemberId(params.authorMemberId);
  const duplicateDecision = await checkWorkspaceDuplicateGuard({
    workspaceId: params.workspaceId,
    entityType: "BrainSource",
    title,
    body: content,
    content,
    sourceType: params.sourceType,
    source: params.channel,
    externalId: params.externalId,
    sourceUrl: metadataString(params.metadata, "sourceUrl")
      ?? metadataString(params.metadata, "url")
      ?? metadataString(params.metadata, "externalUrl"),
  }, params.duplicateGuard, undefined, async (rows) => {
    const sources = rows as BrainSource[];
    const readable = await readableBrainSourceIds(actor, params.workspaceId, sources);
    return sources.filter((source) => readable.has(source.id));
  });
  if (duplicateDecision?.resolution === "use_existing") {
    const source = await prisma.brainSource.findFirst({
      where: { id: duplicateDecision.match.entityId, workspaceId: params.workspaceId, archivedAt: null },
    });
    invariant(source, 404, "NOT_FOUND", "Source not found.");
    invariant((await readableBrainSourceIds(actor, params.workspaceId, [source])).has(source.id),
      404, "NOT_FOUND", "Source not found.");
    return source;
  }
  if (duplicateDecision?.resolution === "update_existing") {
    return prisma.$transaction(async (tx) => {
      await assertArtifactInputWriteFence(tx);
      const existing = await tx.brainSource.findFirst({
        where: { id: duplicateDecision.match.entityId, workspaceId: params.workspaceId, archivedAt: null },
      });
      invariant(existing, 404, "NOT_FOUND", "Source not found.");
      invariant((await readableBrainSourceIds(actor, params.workspaceId, [existing], tx)).has(existing.id),
        404, "NOT_FOUND", "Source not found.");
      const mergedMetadata: Record<string, unknown> = {
        ...(typeof existing.metadata === "object" && existing.metadata !== null && !Array.isArray(existing.metadata) ? existing.metadata : {}),
        ...(typeof params.metadata === "object" && params.metadata !== null && !Array.isArray(params.metadata) ? params.metadata : {}),
      };
      const documentId = ["DOC", "FILE_UPLOAD"].includes(existing.sourceType) && typeof mergedMetadata.documentId === "string"
        ? mergedMetadata.documentId : null;
      const receipt = await prepareProducerLineage({ tx, actor, workspaceId: params.workspaceId,
        artifact: { kind: "BrainSource", id: existing.id }, before: existing, capture: params,
        copied: Boolean(params.lineageRoots),
        ...(documentId ? { copied: true, completeCopy: true, dependencies: [{ kind: "Document" as const, id: documentId }] } : {}) });
      invariant(receipt.mode !== "UNKNOWN", 409, "UNKNOWN_LINEAGE", "Source input lineage is incomplete.");
      if (receipt.mode === "ADVANCE") invariant(await tx.artifactInputLineage.findFirst({ where: {
        workspaceId: params.workspaceId, artifactType: "BrainSource", artifactId: existing.id }, orderBy: { revision: "desc" } }),
      409, "SOURCE_REBUILD_REQUIRED", "This legacy source needs a verified input receipt before it can be edited.");
      const mergedContent = duplicateGuardMergeText(existing.content, content) ?? existing.content;
      const source = await tx.brainSource.update({
        where: { id: existing.id },
        data: {
          content: mergedContent,
          title: existing.title || title,
          externalId: existing.externalId || params.externalId?.trim() || null,
          ingestionGuidanceMd: duplicateGuardMergeText(existing.ingestionGuidanceMd, params.ingestionGuidanceMd),
          absorbedAt: null,
          metadata: {
            ...mergedMetadata,
            duplicateGuardUpdatedAt: new Date().toISOString(),
          } as Prisma.InputJsonValue,
        },
      });
      await finishProducerLineage({ tx, actor, workspaceId: params.workspaceId,
        artifact: { kind: "BrainSource", id: source.id }, content: source, receipt });
      await tx.auditLog.create({
        data: {
          workspaceId: params.workspaceId,
          actorUserId: actor.kind === "user" ? actor.user.id : null,
          action: "brain-source.updated",
          entityType: "BrainSource",
          entityId: source.id,
          meta: { reason: "duplicate_guard_update" },
        },
      });
      await appendEvents(tx, [
        {
          workspaceId: params.workspaceId,
          type: "brain-source.created",
          aggregateType: "BrainSource",
          aggregateId: source.id,
          payload: { sourceId: source.id },
        },
      ]);
      return source;
    });
  }

  return prisma.$transaction(async (tx) => {
    await assertArtifactInputWriteFence(tx);
    const metadata = typeof params.metadata === "object" && params.metadata !== null && !Array.isArray(params.metadata)
      ? params.metadata as Record<string, unknown> : null;
    const documentId = ["DOC", "FILE_UPLOAD"].includes(params.sourceType) && typeof metadata?.documentId === "string"
      ? metadata.documentId : null;
    const receipt = await prepareProducerLineage({ tx, actor, workspaceId: params.workspaceId, capture: params,
      copied: Boolean(params.lineageRoots) || ["CONVERSATION", "CONVERSATION_INSIGHT"].includes(params.sourceType),
      ...(documentId ? { copied: true, completeCopy: true, dependencies: [{ kind: "Document" as const, id: documentId }] } : {}) });
    invariant(receipt.mode !== "UNKNOWN", 409, "UNKNOWN_LINEAGE", "Source input lineage is incomplete.");
    const source = await tx.brainSource.create({
      data: {
        workspaceId: params.workspaceId,
        sourceType: params.sourceType,
        tier: params.tier,
        content,
        title,
        externalId: params.externalId || null,
        channel: params.channel?.trim() || null,
        authorMemberId: actor.kind === "user" ? persistedMemberId(membership) : authorMemberId,
        ingestionGuidanceMd: params.ingestionGuidanceMd?.trim() || null,
        ...(params.metadata === undefined ? {} : { metadata: params.metadata }),
      },
    });

    await finishProducerLineage({ tx, actor, workspaceId: params.workspaceId,
      artifact: { kind: "BrainSource", id: source.id }, content: source, receipt });

    await tx.auditLog.create({
      data: {
        workspaceId: params.workspaceId,
        actorUserId: actor.kind === "user" ? actor.user.id : null,
        action: "brain-source.created",
        entityType: "BrainSource",
        entityId: source.id,
        meta: { sourceType: source.sourceType, tier: source.tier, hasIngestionGuidance: Boolean(source.ingestionGuidanceMd), ...duplicateGuardAuditMeta(duplicateDecision) },
      },
    });

    await appendEvents(tx, [
      {
        workspaceId: params.workspaceId,
        type: "brain-source.created",
        aggregateType: "BrainSource",
        aggregateId: source.id,
        payload: { sourceId: source.id },
      },
    ]);

    return source;
  });
}

export async function listSources(actor: AppActor, params: {
  workspaceId: string;
  sourceId?: string;
  absorbed?: boolean;
  take?: number;
  skip?: number;
  archiveFilter?: ArchiveFilter;
}) {
  params = Object.freeze({ ...params });
  return readWorkItemListSnapshot(actor, params.workspaceId, async release => {
    const accessDomains = await resolveKnowledgeAccessDomains(actor, params.workspaceId, release.db);

    const take = params.take ?? 50;
    const skip = params.skip ?? 0;

    const where: Prisma.BrainSourceWhereInput = {
      workspaceId: params.workspaceId,
      ...(params.sourceId ? { id: params.sourceId } : {}),
      accessDomain: { in: accessDomains },
      ...archiveFilterWhere(params.archiveFilter),
    };

    if (params.absorbed === true) {
      where.absorbedAt = { not: null };
    } else if (params.absorbed === false) {
      where.absorbedAt = null;
    }

    const batchSize = 100;
    let cursor: string | undefined;
    let total = 0;
    const items: Prisma.BrainSourceGetPayload<{ include: {
      authorMember: { include: { user: { select: { displayName: true; email: true } } } };
    } }>[] = [];
    for (;;) {
      const candidates = await release.db.brainSource.findMany({
        where,
        include: {
          authorMember: {
            include: {
              user: { select: { displayName: true, email: true } },
            },
          },
        },
        orderBy: [{ createdAt: "desc" }, { id: "desc" }],
        take: batchSize,
        ...(cursor ? { cursor: { id: cursor }, skip: 1 } : {}),
      });
      if (candidates.length === 0) break;
      const admitted = (await release.capture("BrainSource", candidates)).records;
      for (const source of admitted) {
        if (total >= skip && items.length < take) {
          const authorMember = await readableDiscussionAuthor(actor, params.workspaceId, source.authorMember, release);
          items.push({...source, authorMember: authorMember ? {...authorMember,
            user: {displayName: authorMember.user.displayName, email: authorMember.user.email}} : null,
            authorMemberId: authorMember?.id ?? null});
        }
        total++;
      }
      if (candidates.length < batchSize) break;
      cursor = candidates[candidates.length - 1].id;
    }
    return { items, total, take, skip };
  });
}

export async function markSourceAbsorbed(_actor: AppActor, params: {
  sourceId: string;
  tx?: Prisma.TransactionClient;
}) {
  await (params.tx ?? prisma).brainSource.update({
    where: { id: params.sourceId },
    data: { absorbedAt: new Date() },
  });
}

export async function deleteSource(actor: AppActor, params: {
  workspaceId: string;
  sourceId: string;
}) {
  return requestBrainSourceRemoval(actor, params);
}

// ---------------------------------------------------------------------------
// Backlinks
// ---------------------------------------------------------------------------

export async function rebuildBacklinks(actor: AppActor, params: {
  workspaceId: string;
  tx?: Prisma.TransactionClient;
}) {
  await requireWorkspaceMembership({
    actor,
    workspaceId: params.workspaceId,
    tx: params.tx,
  });

  const db = params.tx ?? prisma;
  const candidates = await db.brainArticle.findMany({ where: { workspaceId: params.workspaceId, archivedAt: null } });
  const observed = await captureArtifactReadHeadObservation(async () => {
    const articles: BrainArticle[] = [];
    const proofs: LineageRoot[][] = [];
    for (const article of candidates) {
      try {
        const proof = await captureArtifactInputProof(actor, params.workspaceId,
          [{kind: "BrainArticle", id: article.id, snapshot: article}], db);
        articles.push(article);
        proofs.push(proof);
      } catch (error) {
        if (!(error instanceof AppError) || !["UNKNOWN_LINEAGE", "SOURCE_CHANGED", "SOURCE_RESTRICTED"].includes(error.code)) throw error;
      }
    }
    return {articles, roots: mergeArtifactInputProofs(...proofs)};
  });
  const {articles, roots} = observed.value;

  const slugToId = new Map<string, string>();
  const titleToId = new Map<string, string>();
  for (const article of articles) {
    slugToId.set(article.slug, article.id);
    titleToId.set(article.title.toLowerCase(), article.id);

    const frontmatter = article.frontmatterJson as Record<string, unknown> | null;
    const aliases = Array.isArray(frontmatter?.also) ? (frontmatter.also as string[]) : [];
    for (const alias of aliases) {
      titleToId.set(alias.toLowerCase(), article.id);
    }
  }

  const links: Array<{ fromArticleId: string; toArticleId: string }> = [];

  for (const article of articles) {
    const matches = article.bodyMd.matchAll(WIKILINK_RE);
    const seen = new Set<string>();

    for (const match of matches) {
      const ref = match[1].trim();
      const targetId =
        slugToId.get(slugify(ref)) ??
        slugToId.get(ref) ??
        titleToId.get(ref.toLowerCase());

      if (targetId && targetId !== article.id && !seen.has(targetId)) {
        seen.add(targetId);
        links.push({ fromArticleId: article.id, toArticleId: targetId });
      }
    }
  }

  const run = async (tx: Prisma.TransactionClient) => {
    const assertCurrent = async () => {
      await requireWorkspaceMembership({actor, workspaceId: params.workspaceId, tx});
      await assertArtifactInputWriteFence(tx);
      for (let offset = 0; offset < roots.length; offset += 100) invariant(
        await isArtifactInputProofReadableAtObservedHeads(actor, params.workspaceId, roots.slice(offset, offset + 100), observed.heads, tx),
        409, "SOURCE_CHANGED", "Backlink inputs changed before replacement.");
    };
    await assertCurrent();
    if (articles.length > 0) {
      await tx.brainBacklink.deleteMany({
        where: { workspaceId: params.workspaceId, fromArticleId: { in: articles.map((article) => article.id) },
          toArticleId: { in: articles.map(article => article.id) } },
      });
    }

    if (links.length > 0) {
      await tx.brainBacklink.createMany({
        data: links.map((link) => ({
          workspaceId: params.workspaceId,
          ...link,
        })),
        skipDuplicates: true,
      });
    }
    await assertCurrent();
  };

  if (params.tx) await run(params.tx);
  else await withArtifactCountReleaseSnapshot(actor, params.workspaceId, roots, async () => {}, run, observed.heads);

  return { linkCount: links.length };
}

// ---------------------------------------------------------------------------
// Discussions
// ---------------------------------------------------------------------------

export async function createDiscussionThread(actor: AppActor, params: ProducerLineageParams & {
  workspaceId: string;
  slug: string;
  targetType: BrainDiscussionTargetType;
  targetRef?: string | null;
  bodyMd: string;
  copied?: boolean;
}) {
  const membership = await requireWorkspaceMembership({
    actor,
    workspaceId: params.workspaceId,
  });

  invariant(membership, 403, "FORBIDDEN", "Agent cannot create discussion threads.");

  const article = await prisma.brainArticle.findUnique({
    where: {
      workspaceId_slug: {
        workspaceId: params.workspaceId,
        slug: params.slug,
      },
    },
  });

  invariant(article, 404, "NOT_FOUND", "Article not found.");
  invariant(params.bodyMd.trim().length > 0, 400, "INVALID_INPUT", "Comment body is required.");

  return prisma.$transaction(async (tx) => {
    invariant((await readableArtifactIds(actor, params.workspaceId, "BrainArticle", [article], tx)).has(article.id), 404, "NOT_FOUND", "Article not found.");
    const receipt = await prepareProducerLineage({ tx, actor, workspaceId: params.workspaceId,
      capture: params, copied: params.copied || actor.kind !== "user" });
    const thread = await tx.brainDiscussionThread.create({
      data: {
        articleId: article.id,
        authorMemberId: membership.id,
        targetType: params.targetType,
        targetRef: params.targetRef?.trim() || null,
      },
    });
    await finishProducerLineage({ tx, actor, workspaceId: params.workspaceId,
      artifact: { kind: "BrainDiscussionThread", id: thread.id }, content: thread, receipt });
    const comment = await tx.brainDiscussionComment.create({
      data: {
        threadId: thread.id,
        authorMemberId: membership.id,
        bodyMd: params.bodyMd.trim(),
      },
    });
    await finishProducerLineage({ tx, actor, workspaceId: params.workspaceId,
      artifact: { kind: "BrainDiscussionComment", id: comment.id }, content: comment, receipt });
    return receipt.mode === "UNKNOWN" ? { id: thread.id, articleId: thread.articleId, contentWithheld: true } : thread;
  });
}

export async function addDiscussionComment(actor: AppActor, params: ProducerLineageParams & {
  workspaceId: string;
  threadId: string;
  bodyMd: string;
  agentRunId?: string | null;
  copied?: boolean;
}) {
  const membership = await requireWorkspaceMembership({
    actor,
    workspaceId: params.workspaceId,
  });

  invariant(params.bodyMd.trim().length > 0, 400, "INVALID_INPUT", "Comment body is required.");

  const thread = await prisma.brainDiscussionThread.findUnique({
    where: { id: params.threadId },
    include: {
      article: { select: { workspaceId: true } },
    },
  });

  invariant(thread && thread.article.workspaceId === params.workspaceId, 404, "NOT_FOUND", "Thread not found.");

  return prisma.$transaction(async (tx) => {
    invariant((await readableArtifactIds(actor, params.workspaceId, "BrainDiscussionThread", [thread], tx)).has(thread.id),
      404, "NOT_FOUND", "Thread not found.");
    const receipt = await prepareProducerLineage({ tx, actor, workspaceId: params.workspaceId,
      capture: params, copied: params.copied || actor.kind !== "user" });
    const comment = await tx.brainDiscussionComment.create({ data: {
      threadId: params.threadId, authorMemberId: membership?.id ?? null,
      agentRunId: params.agentRunId ?? null, bodyMd: params.bodyMd.trim(),
    } });
    await finishProducerLineage({ tx, actor, workspaceId: params.workspaceId,
      artifact: { kind: "BrainDiscussionComment", id: comment.id }, content: comment, receipt });
    return receipt.mode === "UNKNOWN" ? { id: comment.id, threadId: comment.threadId, contentWithheld: true } : comment;
  });
}

export async function resolveDiscussionThread(actor: AppActor, params: {
  workspaceId: string;
  threadId: string;
}) {
  await requireWorkspaceMembership({
    actor,
    workspaceId: params.workspaceId,
  });

  const thread = await prisma.brainDiscussionThread.findUnique({
    where: { id: params.threadId },
    include: {
      article: { select: { workspaceId: true } },
    },
  });

  invariant(thread && thread.article.workspaceId === params.workspaceId, 404, "NOT_FOUND", "Thread not found.");
  invariant(thread.status === "OPEN", 400, "INVALID_STATE", "Thread is not open.");

  return prisma.$transaction(async (tx) => {
    const receipt = await prepareProducerLineage({ tx, actor, workspaceId: params.workspaceId,
      artifact: { kind: "BrainDiscussionThread", id: thread.id }, before: thread, allowSystemTransition: true });
    const updated = await tx.brainDiscussionThread.update({ where: { id: thread.id }, data: { status: "RESOLVED", resolvedAt: new Date() } });
    await finishProducerLineage({ tx, actor, workspaceId: params.workspaceId,
      artifact: { kind: "BrainDiscussionThread", id: updated.id }, content: updated, receipt });
    return (await readableArtifactIds(actor, params.workspaceId, "BrainDiscussionThread", [updated], tx)).has(updated.id)
      ? updated : { id: updated.id, contentWithheld: true };
  });
}

export async function markThreadAbsorbed(actor: AppActor, params: {
  workspaceId: string;
  threadId: string;
  expectedInputRoots?: LineageRoot[];
  tx?: Prisma.TransactionClient;
}) {
  await requireWorkspaceMembership({
    actor,
    workspaceId: params.workspaceId,
    tx: params.tx,
  });

  const run = async (tx: Prisma.TransactionClient) => {
    await tx.$queryRaw`SELECT id FROM "BrainDiscussionThread" WHERE id = ${params.threadId} FOR UPDATE`;
    const thread = await tx.brainDiscussionThread.findUnique({
      where: { id: params.threadId },
      include: {
        article: { select: { workspaceId: true } },
      },
    });

    invariant(thread && thread.article.workspaceId === params.workspaceId, 404, "NOT_FOUND", "Thread not found.");
    invariant(thread.status === "RESOLVED", 400, "INVALID_STATE", "Thread must be resolved before absorbing.");

    invariant((await readableArtifactIds(actor, params.workspaceId, "BrainDiscussionThread", [thread], tx)).has(thread.id),
      409, "UNKNOWN_LINEAGE", "Discussion inputs are unavailable.");
    if (params.expectedInputRoots) invariant(await isArtifactInputProofReadable(actor, params.workspaceId, params.expectedInputRoots, tx),
      409, "SOURCE_CHANGED", "Discussion inputs changed before absorption.");
    const receipt = await prepareProducerLineage({ tx, actor, workspaceId: params.workspaceId,
      artifact: { kind: "BrainDiscussionThread", id: thread.id }, before: thread, allowSystemTransition: true });
    const updated = await tx.brainDiscussionThread.update({ where: { id: thread.id }, data: { status: "ABSORBED", absorbedAt: new Date() } });
    await finishProducerLineage({ tx, actor, workspaceId: params.workspaceId,
      artifact: { kind: "BrainDiscussionThread", id: updated.id }, content: updated, receipt });
    return (await readableArtifactIds(actor, params.workspaceId, "BrainDiscussionThread", [updated], tx)).has(updated.id)
      ? updated : { id: updated.id, contentWithheld: true };
  };
  return params.tx ? run(params.tx) : prisma.$transaction(run);
}

// ---------------------------------------------------------------------------
// Status
// ---------------------------------------------------------------------------

export type BrainStatus = {
  articleCountByType: Record<string, number>;
  articleCountByAuthority: Record<string, number>;
  totalArticles: number;
  staleArticles: number;
  unabsorbedSources: number;
  openDiscussionThreads: number;
  orphanArticles: number;
  unownedArticles: number;
};

export async function getBrainStatus(actor: AppActor, params: {
  workspaceId: string;
}): Promise<BrainStatus> {
  await requireWorkspaceMembership({
    actor,
    workspaceId: params.workspaceId,
  });
  const accessDomains = await resolveKnowledgeAccessDomains(actor, params.workspaceId);

  const release = new WorkItemReadRelease(actor,params.workspaceId);
  const status: BrainStatus = {articleCountByType:{},articleCountByAuthority:{},totalArticles:0,
    staleArticles:0,unabsorbedSources:0,openDiscussionThreads:0,orphanArticles:0,unownedArticles:0};
  const staleBefore=Date.now()-90*24*60*60*1000;
  await visitSourceReadableRecords({actor,workspaceId:params.workspaceId,kind:"BrainArticle",
    load:(afterId,take)=>prisma.brainArticle.findMany({where:{workspaceId:params.workspaceId,...(afterId?{id:{gt:afterId}}:{})},orderBy:{id:"asc"},take}),
    visit:async articles=>{
      const ids=articles.map(article=>article.id),linked=new Set<string>();
      let afterLink:string|undefined;
      if(ids.length) for(;;) {
        const links=await prisma.brainBacklink.findMany({where:{workspaceId:params.workspaceId,toArticleId:{in:ids},
          ...(afterLink?{id:{gt:afterLink}}:{})},include:{fromArticle:true},orderBy:{id:"asc"},take:100});
        const readable=await readableArtifactIds(actor,params.workspaceId,"BrainArticle",links.map(link=>link.fromArticle));
        await release.observe("BrainArticle",links.map(link=>link.fromArticle).filter(row=>readable.has(row.id)));
        for(const link of links) if(readable.has(link.fromArticleId)) linked.add(link.toArticleId);
        if(links.length<100) break;
        afterLink=links.at(-1)!.id;
      }
      const current=await readableArtifactIds(actor,params.workspaceId,"BrainArticle",articles);
      await release.observe("BrainArticle",articles.filter(row=>current.has(row.id)));
      for(const article of articles) if(current.has(article.id)) {
        status.totalArticles++;
        status.articleCountByType[article.type]=(status.articleCountByType[article.type]??0)+1;
        status.articleCountByAuthority[article.authority]=(status.articleCountByAuthority[article.authority]??0)+1;
        if((article.lastVerifiedAt??article.createdAt).getTime()<staleBefore) status.staleArticles++;
        if(article.ownerMemberId===null) status.unownedArticles++;
        if(!linked.has(article.id)) status.orphanArticles++;
      }
    }});
  await visitSourceReadableRecords({actor,workspaceId:params.workspaceId,kind:"BrainSource",
    visit:async rows=>{ await release.observe("BrainSource",rows);status.unabsorbedSources+=rows.length; },
    load:(afterId,take)=>prisma.brainSource.findMany({where:{workspaceId:params.workspaceId,accessDomain:{in:accessDomains},
      archivedAt:null,absorbedAt:null,...(afterId?{id:{gt:afterId}}:{})},orderBy:{id:"asc"},take})});
  // Thread proof includes its current parent Article; comments never affect this count.
  await visitSourceReadableRecords({actor,workspaceId:params.workspaceId,kind:"BrainDiscussionThread",
    visit:async rows=>{ await release.observe("BrainDiscussionThread",rows);status.openDiscussionThreads+=rows.length; },
    load:(afterId,take)=>prisma.brainDiscussionThread.findMany({where:{article:{workspaceId:params.workspaceId},status:"OPEN",
      ...(afterId?{id:{gt:afterId}}:{})},orderBy:{id:"asc"},take})});
  return release.finish(status);
}

export async function publishArticle(actor: AppActor, params: {
  workspaceId: string;
  slug: string;
}) {
  const membership = await requireWorkspaceMembership({
    actor,
    workspaceId: params.workspaceId,
  });

  return prisma.$transaction(async (tx) => {
    await tx.$queryRaw`SELECT id FROM "BrainArticle" WHERE "workspaceId" = ${params.workspaceId} AND slug = ${params.slug} FOR UPDATE`;
    const article = await tx.brainArticle.findUnique({
      where: {
        workspaceId_slug: {
          workspaceId: params.workspaceId,
          slug: params.slug,
        },
      },
      include: { ownerMember: true }
    });

    invariant(article && !article.archivedAt, 404, "NOT_FOUND", "Active article not found.");
    invariant(!article.variantOfArticleId, 409, "IMMUTABLE_VARIANT", "A permitted-source variant is immutable.");
    invariant((await readableArtifactIds(actor, params.workspaceId, "BrainArticle", [article], tx)).has(article.id),
      404, "NOT_FOUND", "Active article not found.");
    invariant(article.isPrivate, 400, "INVALID_STATE", "Article is already public.");
    invariant(article.authority === "DRAFT", 400, "INVALID_STATE", "Only draft Brain articles can be opened.");
    await requireDraftManager({ actor, workspaceId: params.workspaceId, record: article, resolvedMembership: membership });
    const priorRoots = await currentArtifactInputRoots(tx, params.workspaceId,
      { kind: "BrainArticle", id: article.id }, article);

    const updated = await tx.brainArticle.update({
      where: { id: article.id },
      data: { isPrivate: false, publishedAt: new Date() },
    });
    if (priorRoots) await recordArtifactInputLineage({
      tx, actor, workspaceId: params.workspaceId,
      artifact: { kind: "BrainArticle", id: updated.id }, content: updated,
      origin: priorRoots.length ? "DERIVED" : "HUMAN_ORIGINAL", inputs: [], inheritedRoots: priorRoots,
    });

    await tx.auditLog.create({
      data: {
        workspaceId: params.workspaceId,
        actorUserId: actor.kind === "user" ? actor.user.id : null,
        action: "brain-article.published",
        entityType: "BrainArticle",
        entityId: updated.id,
        meta: { title: updated.title },
      },
    });

    await appendEvents(tx, [
      { workspaceId: params.workspaceId, type: "source-lineage.changed", aggregateType: "BrainArticle", aggregateId: updated.id, payload: { entityType: "BrainArticle", entityId: updated.id } },
      {
        workspaceId: params.workspaceId,
        type: "brain-article.published",
        aggregateType: "BrainArticle",
        aggregateId: updated.id,
        payload: { articleId: updated.id },
      },
      {
        workspaceId: params.workspaceId,
        type: "job.enqueue",
        aggregateType: "Job",
        aggregateId: "publish-article",
        payload: {
          handler: "syncBrainArticle",
          workspaceId: params.workspaceId,
          articleId: updated.id,
        },
      },
    ]);

    return updated;
  });
}

export async function returnArticleToDraft(actor: AppActor, params: {
  workspaceId: string;
  slug: string;
}) {
  const membership = await requireWorkspaceMembership({
    actor,
    workspaceId: params.workspaceId,
  });

  return prisma.$transaction(async (tx) => {
    await tx.$queryRaw`SELECT id FROM "BrainArticle" WHERE "workspaceId" = ${params.workspaceId} AND slug = ${params.slug} FOR UPDATE`;
    const article = await tx.brainArticle.findUnique({
      where: {
        workspaceId_slug: {
          workspaceId: params.workspaceId,
          slug: params.slug,
        },
      },
      include: { ownerMember: true },
    });

    invariant(article && !article.archivedAt, 404, "NOT_FOUND", "Article not found.");
    invariant((await readableArtifactIds(actor, params.workspaceId, "BrainArticle", [article], tx)).has(article.id),
      404, "NOT_FOUND", "Article not found.");
    invariant(!article.isPrivate, 400, "INVALID_STATE", "Only public Brain articles can be returned to draft.");
    await requireDraftManager({ actor, workspaceId: params.workspaceId, record: article, resolvedMembership: membership });
    const priorRoots = await currentArtifactInputRoots(tx, params.workspaceId,
      { kind: "BrainArticle", id: article.id }, article);

    const updated = await tx.brainArticle.update({
      where: { id: article.id },
      data: {
        authority: "DRAFT",
        isPrivate: true,
        publishedAt: null,
      },
    });
    if (priorRoots) await recordArtifactInputLineage({
      tx, actor, workspaceId: params.workspaceId,
      artifact: { kind: "BrainArticle", id: updated.id }, content: updated,
      origin: priorRoots.length ? "DERIVED" : "HUMAN_ORIGINAL", inputs: [], inheritedRoots: priorRoots,
    });

    await tx.auditLog.create({
      data: {
        workspaceId: params.workspaceId,
        actorUserId: actor.kind === "user" ? actor.user.id : null,
        action: "brain-article.returned_to_draft",
        entityType: "BrainArticle",
        entityId: updated.id,
        meta: { slug: updated.slug },
      },
    });

    await appendEvents(tx, [
      { workspaceId: params.workspaceId, type: "source-lineage.changed", aggregateType: "BrainArticle", aggregateId: updated.id, payload: { entityType: "BrainArticle", entityId: updated.id } },
      {
        workspaceId: params.workspaceId,
        type: "brain-article.returned_to_draft",
        aggregateType: "BrainArticle",
        aggregateId: updated.id,
        payload: { articleId: updated.id },
      },
    ]);

    return updated;
  });
}
