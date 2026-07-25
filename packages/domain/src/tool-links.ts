import type { Prisma } from "@prisma/client";
import { decryptSecret, encryptSecret, prisma } from "@corgtex/shared";
import type { AppActor, MembershipSummary } from "@corgtex/shared";
import { actorUserIdForWorkspace, requireWorkspaceMembership } from "./auth";
import { recordAudit } from "./audit-trail";
import { archiveFilterWhere, archiveWorkspaceArtifact, type ArchiveFilter } from "./archive";
import { AppError, invariant } from "./errors";
import {
  canEditToolLinkMetadata,
  canManageToolLinkCredential,
  requireToolLinkCredentialManager,
  requireToolLinkMetadataEditor,
} from "./collaborative-permissions";

const toolLinkSelect = {
  id: true,
  workspaceId: true,
  createdByUserId: true,
  title: true,
  url: true,
  category: true,
  descriptionMd: true,
  accessNotesMd: true,
  previewTitle: true,
  previewDescription: true,
  previewImageUrl: true,
  previewFaviconUrl: true,
  credentialLabel: true,
  archivedAt: true,
  archiveReason: true,
  createdAt: true,
  updatedAt: true,
  createdBy: {
    select: {
      id: true,
      email: true,
      displayName: true,
    },
  },
  circleTags: {
    include: {
      circle: {
        select: {
          id: true,
          name: true,
          archivedAt: true,
        },
      },
    },
    orderBy: {
      createdAt: "asc",
    },
  },
} satisfies Prisma.WorkspaceToolLinkSelect;

type ToolLinkRecord = Prisma.WorkspaceToolLinkGetPayload<{ select: typeof toolLinkSelect }> & {
  credentialSecretEnc?: string | null;
};

function normalizeString(value: string | null | undefined) {
  const trimmed = value?.trim();
  return trimmed && trimmed.length > 0 ? trimmed : null;
}

function normalizeTitle(value: string) {
  const title = value.trim();
  invariant(title.length > 0, 400, "INVALID_INPUT", "Tool title is required.");
  invariant(title.length <= 160, 400, "INVALID_INPUT", "Tool title must be 160 characters or fewer.");
  return title;
}

function normalizeCategory(value: string | null | undefined) {
  return normalizeString(value)?.toUpperCase().replace(/[^A-Z0-9_]/g, "_").slice(0, 64) || "OTHER";
}

function normalizeUrl(value: string) {
  const raw = value.trim();
  invariant(raw.length > 0, 400, "INVALID_INPUT", "Tool URL is required.");
  const candidate = /^[a-z][a-z0-9+.-]*:\/\//i.test(raw) ? raw : `https://${raw}`;

  let parsed: URL;
  try {
    parsed = new URL(candidate);
  } catch {
    throw new AppError(400, "INVALID_INPUT", "Tool URL must be a valid URL.");
  }

  invariant(parsed.protocol === "https:" || parsed.protocol === "http:", 400, "INVALID_INPUT", "Tool URL must use http or https.");
  parsed.hash = "";
  return parsed.toString();
}

function normalizeSecret(value: string | null | undefined) {
  if (value === undefined) return undefined;
  const trimmed = value?.trim();
  return trimmed && trimmed.length > 0 ? trimmed : null;
}

function serializeToolLink(
  actor: AppActor,
  membership: MembershipSummary | null | undefined,
  link: ToolLinkRecord,
) {
  return {
    id: link.id,
    workspaceId: link.workspaceId,
    title: link.title,
    url: link.url,
    category: link.category,
    descriptionMd: link.descriptionMd,
    accessNotesMd: link.accessNotesMd,
    previewTitle: link.previewTitle,
    previewDescription: link.previewDescription,
    previewImageUrl: link.previewImageUrl,
    previewFaviconUrl: link.previewFaviconUrl,
    credentialLabel: link.credentialLabel,
    hasCredential: Boolean(link.credentialSecretEnc),
    createdAt: link.createdAt,
    updatedAt: link.updatedAt,
    archivedAt: link.archivedAt,
    archiveReason: link.archiveReason,
    createdBy: link.createdBy,
    circles: link.circleTags
      .map((tag) => tag.circle)
      .filter((circle) => !circle.archivedAt)
      .map((circle) => ({ id: circle.id, name: circle.name })),
    canManage: canEditToolLinkMetadata(actor, membership),
    canManageCredentials: canManageToolLinkCredential(actor, membership, link),
    canArchive: canManageToolLinkCredential(actor, membership, link),
  };
}

async function validateCircleIds(tx: Prisma.TransactionClient, workspaceId: string, circleIds: string[] | undefined) {
  const normalized = [...new Set((circleIds ?? []).map((id) => id.trim()).filter(Boolean))];
  if (normalized.length === 0) return [];

  const circles = await tx.circle.findMany({
    where: {
      id: { in: normalized },
      workspaceId,
      archivedAt: null,
    },
    select: { id: true },
  });
  invariant(circles.length === normalized.length, 400, "INVALID_INPUT", "One or more circle tags are invalid.");
  return normalized;
}

export async function listWorkspaceToolLinks(actor: AppActor, params: {
  workspaceId: string;
  archiveFilter?: ArchiveFilter;
}) {
  const membership = await requireWorkspaceMembership({ actor, workspaceId: params.workspaceId });
  const links = await prisma.workspaceToolLink.findMany({
    where: {
      workspaceId: params.workspaceId,
      ...archiveFilterWhere(params.archiveFilter),
    },
    orderBy: [{ category: "asc" }, { title: "asc" }],
    select: {
      ...toolLinkSelect,
      credentialSecretEnc: true,
    },
  });

  return links.map((link) => serializeToolLink(actor, membership, link));
}

export async function getWorkspaceToolLink(actor: AppActor, params: {
  workspaceId: string;
  toolLinkId: string;
}) {
  const membership = await requireWorkspaceMembership({ actor, workspaceId: params.workspaceId });
  const link = await prisma.workspaceToolLink.findFirst({
    where: {
      id: params.toolLinkId,
      workspaceId: params.workspaceId,
      archivedAt: null,
    },
    select: {
      ...toolLinkSelect,
      credentialSecretEnc: true,
    },
  });
  invariant(link, 404, "NOT_FOUND", "Tool link not found.");
  return serializeToolLink(actor, membership, link);
}

export async function createWorkspaceToolLink(actor: AppActor, params: {
  workspaceId: string;
  title: string;
  url: string;
  category?: string | null;
  descriptionMd?: string | null;
  accessNotesMd?: string | null;
  previewTitle?: string | null;
  previewDescription?: string | null;
  previewImageUrl?: string | null;
  previewFaviconUrl?: string | null;
  credentialLabel?: string | null;
  credentialSecret?: string | null;
  circleIds?: string[];
}) {
  const membership = await requireWorkspaceMembership({ actor, workspaceId: params.workspaceId });
  const createdByUserId = actor.kind === "user" ? actor.user.id : await actorUserIdForWorkspace(actor, params.workspaceId);
  const secret = normalizeSecret(params.credentialSecret);

  return prisma.$transaction(async (tx) => {
    const circleIds = await validateCircleIds(tx, params.workspaceId, params.circleIds);
    const link = await tx.workspaceToolLink.create({
      data: {
        workspaceId: params.workspaceId,
        createdByUserId,
        title: normalizeTitle(params.title),
        url: normalizeUrl(params.url),
        category: normalizeCategory(params.category),
        descriptionMd: normalizeString(params.descriptionMd),
        accessNotesMd: normalizeString(params.accessNotesMd),
        previewTitle: normalizeString(params.previewTitle),
        previewDescription: normalizeString(params.previewDescription),
        previewImageUrl: normalizeString(params.previewImageUrl),
        previewFaviconUrl: normalizeString(params.previewFaviconUrl),
        credentialLabel: normalizeString(params.credentialLabel),
        credentialSecretEnc: secret ? encryptSecret(secret) : null,
        circleTags: {
          create: circleIds.map((circleId) => ({ circleId })),
        },
      },
      select: {
        ...toolLinkSelect,
        credentialSecretEnc: true,
      },
    });

    await recordAudit(tx, actor, {
      workspaceId: params.workspaceId,
      action: "tool_link.created",
      entityType: "WorkspaceToolLink",
      entityId: link.id,
      meta: {
        title: link.title,
        category: link.category,
        hasCredential: Boolean(link.credentialSecretEnc),
        circleIds,
      },
    });

    return serializeToolLink(actor, membership, link);
  });
}

export async function updateWorkspaceToolLink(actor: AppActor, params: {
  workspaceId: string;
  toolLinkId: string;
  title?: string;
  url?: string;
  category?: string | null;
  descriptionMd?: string | null;
  accessNotesMd?: string | null;
  previewTitle?: string | null;
  previewDescription?: string | null;
  previewImageUrl?: string | null;
  previewFaviconUrl?: string | null;
  credentialLabel?: string | null;
  credentialSecret?: string | null;
  circleIds?: string[];
}) {
  const membership = await requireWorkspaceMembership({ actor, workspaceId: params.workspaceId });

  return prisma.$transaction(async (tx) => {
    const existing = await tx.workspaceToolLink.findFirst({
      where: {
        id: params.toolLinkId,
        workspaceId: params.workspaceId,
        archivedAt: null,
      },
      select: {
        id: true,
        createdByUserId: true,
      },
    });
    invariant(existing, 404, "NOT_FOUND", "Tool link not found.");
    requireToolLinkMetadataEditor(actor, membership);
    const editsCredential = params.credentialLabel !== undefined || params.credentialSecret !== undefined;
    if (editsCredential) {
      requireToolLinkCredentialManager(actor, membership, existing);
    }

    const data: Prisma.WorkspaceToolLinkUpdateInput = {};
    if (params.title !== undefined) data.title = normalizeTitle(params.title);
    if (params.url !== undefined) data.url = normalizeUrl(params.url);
    if (params.category !== undefined) data.category = normalizeCategory(params.category);
    if (params.descriptionMd !== undefined) data.descriptionMd = normalizeString(params.descriptionMd);
    if (params.accessNotesMd !== undefined) data.accessNotesMd = normalizeString(params.accessNotesMd);
    if (params.previewTitle !== undefined) data.previewTitle = normalizeString(params.previewTitle);
    if (params.previewDescription !== undefined) data.previewDescription = normalizeString(params.previewDescription);
    if (params.previewImageUrl !== undefined) data.previewImageUrl = normalizeString(params.previewImageUrl);
    if (params.previewFaviconUrl !== undefined) data.previewFaviconUrl = normalizeString(params.previewFaviconUrl);
    if (params.credentialLabel !== undefined) data.credentialLabel = normalizeString(params.credentialLabel);
    if (params.credentialSecret !== undefined) {
      const secret = normalizeSecret(params.credentialSecret);
      data.credentialSecretEnc = secret ? encryptSecret(secret) : null;
    }

    if (params.circleIds !== undefined) {
      const circleIds = await validateCircleIds(tx, params.workspaceId, params.circleIds);
      await tx.workspaceToolLinkCircleTag.deleteMany({
        where: { toolLinkId: existing.id },
      });
      if (circleIds.length > 0) {
        await tx.workspaceToolLinkCircleTag.createMany({
          data: circleIds.map((circleId) => ({
            toolLinkId: existing.id,
            circleId,
          })),
          skipDuplicates: true,
        });
      }
    }

    const updated = await tx.workspaceToolLink.update({
      where: { id: existing.id },
      data,
      select: {
        ...toolLinkSelect,
        credentialSecretEnc: true,
      },
    });

    await recordAudit(tx, actor, {
      workspaceId: params.workspaceId,
      action: "tool_link.updated",
      entityType: "WorkspaceToolLink",
      entityId: updated.id,
      meta: {
        fields: [
          ...Object.keys(data),
          ...(params.circleIds !== undefined ? ["circleIds"] : []),
        ],
        hasCredential: Boolean(updated.credentialSecretEnc),
      },
    });

    return serializeToolLink(actor, membership, updated);
  });
}

export async function upsertWorkspaceToolLink(actor: AppActor, params: Omit<Parameters<typeof createWorkspaceToolLink>[1], "workspaceId"> & {
  workspaceId: string;
  toolLinkId?: string | null;
}) {
  if (params.toolLinkId) {
    return updateWorkspaceToolLink(actor, {
      ...params,
      toolLinkId: params.toolLinkId,
    });
  }

  return createWorkspaceToolLink(actor, params);
}

export async function archiveWorkspaceToolLink(actor: AppActor, params: {
  workspaceId: string;
  toolLinkId: string;
  reason?: string | null;
}) {
  await archiveWorkspaceArtifact(actor, {
    workspaceId: params.workspaceId,
    entityType: "WorkspaceToolLink",
    entityId: params.toolLinkId,
    reason: params.reason ?? "Archived from tool links directory.",
  });

  return { id: params.toolLinkId };
}

export async function revealWorkspaceToolLinkCredential(actor: AppActor, params: {
  workspaceId: string;
  toolLinkId: string;
}) {
  const membership = await requireWorkspaceMembership({ actor, workspaceId: params.workspaceId });

  return prisma.$transaction(async (tx) => {
    const link = await tx.workspaceToolLink.findFirst({
      where: {
        id: params.toolLinkId,
        workspaceId: params.workspaceId,
        archivedAt: null,
      },
      select: {
        id: true,
        title: true,
        createdByUserId: true,
        credentialLabel: true,
        credentialSecretEnc: true,
      },
    });
    invariant(link, 404, "NOT_FOUND", "Tool link not found.");
    requireToolLinkCredentialManager(actor, membership, link);

    await recordAudit(tx, actor, {
      workspaceId: params.workspaceId,
      action: "tool_link.credential_revealed",
      entityType: "WorkspaceToolLink",
      entityId: link.id,
      meta: {
        title: link.title,
        credentialLabel: link.credentialLabel,
        hasCredential: Boolean(link.credentialSecretEnc),
      },
    });

    return {
      credentialLabel: link.credentialLabel,
      credentialSecret: link.credentialSecretEnc ? decryptSecret(link.credentialSecretEnc) : null,
    };
  });
}
