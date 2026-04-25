import type { BrainArticleAuthority, BrainArticleType, BrainDiscussionTargetType, BrainSourceType } from "@prisma/client";
import { Prisma } from "@prisma/client";
import { prisma } from "@corgtex/shared";
import type { AppActor } from "@corgtex/shared";
import { appendEvents } from "./events";
import { requireWorkspaceMembership } from "./auth";
import { archiveFilterWhere, archiveWorkspaceArtifact, type ArchiveFilter } from "./archive";
import { invariant } from "./errors";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function slugify(input: string) {
  return input
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 120);
}

export const WIKILINK_RE = /\[\[([^\]]+)\]\]/g;

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
}) {
  const membership = await requireWorkspaceMembership({
    actor,
    workspaceId: params.workspaceId,
  });

  const title = params.title.trim();
  invariant(title.length > 0, 400, "INVALID_INPUT", "Article title is required.");

  const slug = params.slug?.trim() || slugify(title);
  invariant(slug.length > 0, 400, "INVALID_INPUT", "Article slug is required.");

  return prisma.$transaction(async (tx) => {
    const article = await tx.brainArticle.create({
      data: {
        workspaceId: params.workspaceId,
        slug,
        title,
        type: params.type,
        authority: params.authority ?? "DRAFT",
        bodyMd: params.bodyMd,
        frontmatterJson: params.frontmatterJson ?? Prisma.JsonNull,
        ownerMemberId: (params.isPrivate && membership) ? membership.id : (params.ownerMemberId ?? null),
        staleAfterDays: params.staleAfterDays ?? 90,
        sourceIds: params.sourceIds ?? [],
        isPrivate: params.isPrivate ?? false,
        publishedAt: params.isPrivate ? null : new Date(),
        lastVerifiedAt: new Date(),
      },
    });

    await tx.auditLog.create({
      data: {
        workspaceId: params.workspaceId,
        actorUserId: actor.kind === "user" ? actor.user.id : null,
        action: "brain-article.created",
        entityType: "BrainArticle",
        entityId: article.id,
        meta: { title: article.title, slug: article.slug, type: article.type },
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
  });
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
}) {
  await requireWorkspaceMembership({
    actor,
    workspaceId: params.workspaceId,
  });

  return prisma.$transaction(async (tx) => {
    const article = await tx.brainArticle.findUnique({
      where: {
        workspaceId_slug: {
          workspaceId: params.workspaceId,
          slug: params.slug,
        },
      },
    });

    invariant(article, 404, "NOT_FOUND", "Article not found.");

    // Create version snapshot of previous body before updating
    if (params.bodyMd !== undefined && params.bodyMd !== article.bodyMd) {
      const lastVersion = await tx.brainArticleVersion.findFirst({
        where: { articleId: article.id },
        orderBy: { version: "desc" },
        select: { version: true },
      });

      await tx.brainArticleVersion.create({
        data: {
          articleId: article.id,
          version: (lastVersion?.version ?? 0) + 1,
          bodyMd: article.bodyMd,
          changeSummary: params.changeSummary ?? null,
          agentRunId: params.agentRunId ?? null,
        },
      });
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
    if (params.sourceIds !== undefined) data.sourceIds = params.sourceIds;

    const updated = await tx.brainArticle.update({
      where: { id: article.id },
      data,
    });

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
      {
        workspaceId: params.workspaceId,
        type: "brain-article.updated",
        aggregateType: "BrainArticle",
        aggregateId: updated.id,
        payload: { articleId: updated.id },
      },
    ]);

    return updated;
  });
}

export async function getArticle(actor: AppActor, params: {
  workspaceId: string;
  slug: string;
}) {
  await requireWorkspaceMembership({
    actor,
    workspaceId: params.workspaceId,
  });

  const article = await prisma.brainArticle.findFirst({
    where: {
      workspaceId: params.workspaceId,
      slug: params.slug,
      archivedAt: null,
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
    invariant(actor.kind === "user" && article.ownerMember?.userId === actor.user.id, 404, "NOT_FOUND", "Article not found.");
  }

  return article;
}

export async function listArticles(actor: AppActor, params: {
  workspaceId: string;
  type?: BrainArticleType;
  authority?: BrainArticleAuthority;
  stale?: boolean;
  take?: number;
  skip?: number;
  archiveFilter?: ArchiveFilter;
}) {
  const membership = await requireWorkspaceMembership({
    actor,
    workspaceId: params.workspaceId,
  });

  const take = params.take ?? 50;
  const skip = params.skip ?? 0;

  const privacyFilter = actor.kind === "user" && membership
    ? [{ isPrivate: false }, { isPrivate: true, ownerMemberId: membership.id }]
    : [{ isPrivate: false }];

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

  const [items, total] = await Promise.all([
    prisma.brainArticle.findMany({
      where,
      include: {
        ownerMember: {
          include: {
            user: { select: { displayName: true, email: true } },
          },
        },
        _count: {
          select: { backlinksTo: true, discussions: true },
        },
      },
      orderBy: { updatedAt: "desc" },
      take,
      skip,
    }),
    prisma.brainArticle.count({ where }),
  ]);

  return { items, total, take, skip };
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
    select: { id: true },
  });

  invariant(article, 404, "NOT_FOUND", "Article not found.");

  return prisma.brainArticleVersion.findMany({
    where: { articleId: article.id },
    orderBy: { version: "desc" },
  });
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
  metadata?: Prisma.InputJsonValue;
}) {
  await requireWorkspaceMembership({
    actor,
    workspaceId: params.workspaceId,
  });

  invariant(params.content.trim().length > 0, 400, "INVALID_INPUT", "Source content is required.");
  invariant(params.tier >= 1 && params.tier <= 3, 400, "INVALID_INPUT", "Tier must be 1, 2, or 3.");

  return prisma.$transaction(async (tx) => {
    const source = await tx.brainSource.create({
      data: {
        workspaceId: params.workspaceId,
        sourceType: params.sourceType,
        tier: params.tier,
        content: params.content.trim(),
        title: params.title?.trim() || null,
        externalId: params.externalId || null,
        channel: params.channel?.trim() || null,
        authorMemberId: params.authorMemberId || null,
        ...(params.metadata === undefined ? {} : { metadata: params.metadata }),
      },
    });

    await tx.auditLog.create({
      data: {
        workspaceId: params.workspaceId,
        actorUserId: actor.kind === "user" ? actor.user.id : null,
        action: "brain-source.created",
        entityType: "BrainSource",
        entityId: source.id,
        meta: { sourceType: source.sourceType, tier: source.tier },
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
  absorbed?: boolean;
  take?: number;
  skip?: number;
  archiveFilter?: ArchiveFilter;
}) {
  await requireWorkspaceMembership({
    actor,
    workspaceId: params.workspaceId,
  });

  const take = params.take ?? 50;
  const skip = params.skip ?? 0;

  const where: Prisma.BrainSourceWhereInput = {
    workspaceId: params.workspaceId,
    ...archiveFilterWhere(params.archiveFilter),
  };

  if (params.absorbed === true) {
    where.absorbedAt = { not: null };
  } else if (params.absorbed === false) {
    where.absorbedAt = null;
  }

  const [items, total] = await Promise.all([
    prisma.brainSource.findMany({
      where,
      include: {
        authorMember: {
          include: {
            user: { select: { displayName: true, email: true } },
          },
        },
      },
      orderBy: { createdAt: "desc" },
      take,
      skip,
    }),
    prisma.brainSource.count({ where }),
  ]);

  return { items, total, take, skip };
}

export async function markSourceAbsorbed(_actor: AppActor, params: {
  sourceId: string;
}) {
  await prisma.brainSource.update({
    where: { id: params.sourceId },
    data: { absorbedAt: new Date() },
  });
}

export async function deleteSource(actor: AppActor, params: {
  workspaceId: string;
  sourceId: string;
}) {
  await requireWorkspaceMembership({
    actor,
    workspaceId: params.workspaceId,
    allowedRoles: ["ADMIN"],
  });

  await archiveWorkspaceArtifact(actor, {
    workspaceId: params.workspaceId,
    entityType: "BrainSource",
    entityId: params.sourceId,
    reason: "Archived from Brain source delete path.",
  });

  return { id: params.sourceId };
}

// ---------------------------------------------------------------------------
// Backlinks
// ---------------------------------------------------------------------------

export async function rebuildBacklinks(actor: AppActor, params: {
  workspaceId: string;
}) {
  await requireWorkspaceMembership({
    actor,
    workspaceId: params.workspaceId,
  });

  const articles = await prisma.brainArticle.findMany({
    where: { workspaceId: params.workspaceId },
    select: { id: true, slug: true, title: true, bodyMd: true, frontmatterJson: true },
  });

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

  await prisma.$transaction(async (tx) => {
    await tx.brainBacklink.deleteMany({
      where: { workspaceId: params.workspaceId },
    });

    if (links.length > 0) {
      await tx.brainBacklink.createMany({
        data: links.map((link) => ({
          workspaceId: params.workspaceId,
          ...link,
        })),
        skipDuplicates: true,
      });
    }
  });

  return { linkCount: links.length };
}

// ---------------------------------------------------------------------------
// Discussions
// ---------------------------------------------------------------------------

export async function createDiscussionThread(actor: AppActor, params: {
  workspaceId: string;
  slug: string;
  targetType: BrainDiscussionTargetType;
  targetRef?: string | null;
  bodyMd: string;
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
    select: { id: true },
  });

  invariant(article, 404, "NOT_FOUND", "Article not found.");
  invariant(params.bodyMd.trim().length > 0, 400, "INVALID_INPUT", "Comment body is required.");

  return prisma.$transaction(async (tx) => {
    const thread = await tx.brainDiscussionThread.create({
      data: {
        articleId: article.id,
        authorMemberId: membership.id,
        targetType: params.targetType,
        targetRef: params.targetRef?.trim() || null,
      },
    });

    await tx.brainDiscussionComment.create({
      data: {
        threadId: thread.id,
        authorMemberId: membership.id,
        bodyMd: params.bodyMd.trim(),
      },
    });

    return thread;
  });
}

export async function addDiscussionComment(actor: AppActor, params: {
  workspaceId: string;
  threadId: string;
  bodyMd: string;
  agentRunId?: string | null;
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

  return prisma.brainDiscussionComment.create({
    data: {
      threadId: params.threadId,
      authorMemberId: membership?.id ?? null,
      agentRunId: params.agentRunId ?? null,
      bodyMd: params.bodyMd.trim(),
    },
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

  return prisma.brainDiscussionThread.update({
    where: { id: params.threadId },
    data: { status: "RESOLVED", resolvedAt: new Date() },
  });
}

export async function markThreadAbsorbed(actor: AppActor, params: {
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
  invariant(thread.status === "RESOLVED", 400, "INVALID_STATE", "Thread must be resolved before absorbing.");

  return prisma.brainDiscussionThread.update({
    where: { id: params.threadId },
    data: { status: "ABSORBED", absorbedAt: new Date() },
  });
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

  const [
    articles,
    staleArticles,
    unabsorbedSources,
    openDiscussionThreads,
    unownedArticles,
    articlesWithBacklinks,
  ] = await Promise.all([
    prisma.brainArticle.findMany({
      where: { workspaceId: params.workspaceId },
      select: { id: true, type: true, authority: true },
    }),
    prisma.brainArticle.count({
      where: {
        workspaceId: params.workspaceId,
        OR: [
          {
            lastVerifiedAt: null,
            createdAt: { lt: new Date(Date.now() - 90 * 24 * 60 * 60 * 1000) },
          },
          {
            lastVerifiedAt: { lt: new Date(Date.now() - 90 * 24 * 60 * 60 * 1000) },
          },
        ],
      },
    }),
    prisma.brainSource.count({
      where: { workspaceId: params.workspaceId, absorbedAt: null },
    }),
    prisma.brainDiscussionThread.count({
      where: {
        article: { workspaceId: params.workspaceId },
        status: "OPEN",
      },
    }),
    prisma.brainArticle.count({
      where: { workspaceId: params.workspaceId, ownerMemberId: null },
    }),
    prisma.brainBacklink.findMany({
      where: { workspaceId: params.workspaceId },
      select: { toArticleId: true },
      distinct: ["toArticleId"],
    }),
  ]);

  const linkedIds = new Set(articlesWithBacklinks.map((b) => b.toArticleId));
  const orphanArticles = articles.filter((a) => !linkedIds.has(a.id)).length;

  const articleCountByType: Record<string, number> = {};
  const articleCountByAuthority: Record<string, number> = {};
  for (const article of articles) {
    articleCountByType[article.type] = (articleCountByType[article.type] ?? 0) + 1;
    articleCountByAuthority[article.authority] = (articleCountByAuthority[article.authority] ?? 0) + 1;
  }

  return {
    articleCountByType,
    articleCountByAuthority,
    totalArticles: articles.length,
    staleArticles,
    unabsorbedSources,
    openDiscussionThreads,
    orphanArticles,
    unownedArticles,
  };
}

export async function publishArticle(actor: AppActor, params: {
  workspaceId: string;
  slug: string;
}) {
  await requireWorkspaceMembership({
    actor,
    workspaceId: params.workspaceId,
  });

  return prisma.$transaction(async (tx) => {
    const article = await tx.brainArticle.findUnique({
      where: {
        workspaceId_slug: {
          workspaceId: params.workspaceId,
          slug: params.slug,
        },
      },
      include: { ownerMember: true }
    });

    invariant(article, 404, "NOT_FOUND", "Article not found.");
    invariant(article.isPrivate, 400, "INVALID_STATE", "Article is already public.");
    invariant(actor.kind === "user" && article.ownerMember?.userId === actor.user.id, 403, "FORBIDDEN", "Only the author can publish this article.");

    const updated = await tx.brainArticle.update({
      where: { id: article.id },
      data: { isPrivate: false, publishedAt: new Date() },
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
