import type { Prisma } from "@prisma/client";
import { prisma } from "@corgtex/shared";
import type { AppActor } from "@corgtex/shared";
import { appendEvents } from "./events";
import { requireWorkspaceMembership } from "./auth";
import { archiveFilterWhere, archiveWorkspaceArtifact, type ArchiveFilter } from "./archive";
import { invariant } from "./errors";
import { persistedMemberId } from "./membership";
import { assertTrialStorageCapacity } from "./trial-entitlements";
import {
  checkWorkspaceDuplicateGuard,
  duplicateGuardAuditMeta,
  duplicateGuardContentHash,
  duplicateGuardMergeText,
  type DuplicateGuardOptions,
} from "./duplicate-guard";

export async function listDocuments(workspaceId: string, opts?: { archiveFilter?: ArchiveFilter }) {
  return prisma.document.findMany({
    where: { workspaceId, ...archiveFilterWhere(opts?.archiveFilter) },
    orderBy: { createdAt: "desc" },
  });
}

type CreateDocumentParams = {
  workspaceId: string;
  title: string;
  source: string;
  storageKey: string;
  mimeType?: string | null;
  textContent?: string | null;
  metadata?: Prisma.InputJsonValue;
  duplicateGuard?: DuplicateGuardOptions | null;
};

function metadataObject(value: Prisma.InputJsonValue | Prisma.JsonValue | null | undefined) {
  return typeof value === "object" && value !== null && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

async function getActiveDocument(workspaceId: string, documentId: string) {
  const document = await prisma.document.findFirst({
    where: { id: documentId, workspaceId, archivedAt: null },
  });
  invariant(document, 404, "NOT_FOUND", "Document not found.");
  return document;
}

async function applyDocumentDuplicateUpdate(actor: AppActor, params: CreateDocumentParams, documentId: string) {
  return prisma.$transaction(async (tx) => {
    const existing = await tx.document.findFirst({
      where: { id: documentId, workspaceId: params.workspaceId, archivedAt: null },
    });
    invariant(existing, 404, "NOT_FOUND", "Document not found.");
    const mergedText = duplicateGuardMergeText(existing.textContent, params.textContent);
    const metadata = {
      ...metadataObject(existing.metadata),
      ...metadataObject(params.metadata),
      ...(params.textContent ? { contentHash: duplicateGuardContentHash(params.textContent) } : {}),
      duplicateGuardUpdatedAt: new Date().toISOString(),
      duplicateGuardStorageKey: params.storageKey,
    } as Prisma.InputJsonValue;
    const updated = await tx.document.update({
      where: { id: existing.id },
      data: {
        textContent: mergedText,
        metadata,
      },
    });

    if (mergedText) {
      await tx.brainSource.updateMany({
        where: {
          workspaceId: params.workspaceId,
          sourceType: { in: ["DOC", "FILE_UPLOAD"] },
          metadata: { path: ["documentId"], equals: existing.id },
        },
        data: {
          content: [updated.title, mergedText].join("\n\n"),
          metadata: {
            documentId: updated.id,
            storageKey: updated.storageKey,
            mimeType: updated.mimeType,
            duplicateGuardUpdatedAt: new Date().toISOString(),
          } as Prisma.InputJsonValue,
        },
      });
    }

    await tx.auditLog.create({
      data: {
        workspaceId: params.workspaceId,
        actorUserId: actor.kind === "user" ? actor.user.id : null,
        action: "document.updated",
        entityType: "Document",
        entityId: updated.id,
        meta: { reason: "duplicate_guard_update" },
      },
    });

    await appendEvents(tx, [
      {
        workspaceId: params.workspaceId,
        type: "document.updated",
        aggregateType: "Document",
        aggregateId: updated.id,
        payload: { documentId: updated.id, title: updated.title, source: updated.source },
      },
    ]);

    return updated;
  });
}

export async function createDocument(actor: AppActor, params: CreateDocumentParams) {
  const membership = await requireWorkspaceMembership({
    actor,
    workspaceId: params.workspaceId,
  });

  const title = params.title.trim();
  const source = params.source.trim();
  const storageKey = params.storageKey.trim();
  const textContent = params.textContent?.trim() || null;

  invariant(title.length > 0, 400, "INVALID_INPUT", "Document title is required.");
  invariant(source.length > 0, 400, "INVALID_INPUT", "Document source is required.");
  invariant(storageKey.length > 0, 400, "INVALID_INPUT", "storageKey is required.");
  const documentMetadata = metadataObject(params.metadata);
  const sourceUrl = typeof documentMetadata.sourceUrl === "string" ? documentMetadata.sourceUrl : null;
  const contentHash = duplicateGuardContentHash(textContent);
  const duplicateDecision = await checkWorkspaceDuplicateGuard({
    workspaceId: params.workspaceId,
    entityType: "Document",
    title,
    body: textContent,
    source,
    sourceUrl,
    contentHash,
    content: textContent,
  }, params.duplicateGuard);
  if (duplicateDecision?.resolution === "use_existing") {
    return getActiveDocument(params.workspaceId, duplicateDecision.match.entityId);
  }
  if (duplicateDecision?.resolution === "update_existing") {
    return applyDocumentDuplicateUpdate(actor, params, duplicateDecision.match.entityId);
  }
  const metadata = params.metadata;
  const createMetadata = {
    ...metadataObject(metadata),
    ...(contentHash ? { contentHash } : {}),
  };
  const size = metadata && typeof metadata === "object" && !Array.isArray(metadata)
    ? (metadata as Record<string, unknown>).size
    : null;
  await assertTrialStorageCapacity(params.workspaceId, typeof size === "number" ? size : 0);

  return prisma.$transaction(async (tx) => {
    const document = await tx.document.create({
      data: {
        workspaceId: params.workspaceId,
        title,
        source,
        storageKey,
        mimeType: params.mimeType?.trim() || null,
        textContent,
        ...(params.metadata === undefined && !contentHash ? {} : { metadata: createMetadata as Prisma.InputJsonValue }),
      },
    });

    await tx.auditLog.create({
      data: {
        workspaceId: params.workspaceId,
        actorUserId: actor.kind === "user" ? actor.user.id : null,
        action: "document.created",
        entityType: "Document",
        entityId: document.id,
        meta: {
          source: document.source,
          storageKey: document.storageKey,
          ...duplicateGuardAuditMeta(duplicateDecision),
        },
      },
    });

    const events: Parameters<typeof appendEvents>[1] = [
      {
        workspaceId: params.workspaceId,
        type: "document.created",
        aggregateType: "Document",
        aggregateId: document.id,
        payload: {
          documentId: document.id,
          title: document.title,
          source: document.source,
        },
      },
    ];

    if (textContent) {
      const brainSource = await tx.brainSource.create({
        data: {
          workspaceId: params.workspaceId,
          sourceType: "DOC",
          tier: 2,
          title,
          content: [title, textContent].join("\n\n"),
          authorMemberId: actor.kind === "user" ? persistedMemberId(membership) : null,
          channel: source,
          metadata: {
            documentId: document.id,
            storageKey,
            mimeType: params.mimeType?.trim() || null,
            ...(sourceUrl ? { sourceUrl } : {}),
            ...(contentHash ? { contentHash } : {}),
          } as Prisma.InputJsonValue,
        },
      });

      await tx.auditLog.create({
        data: {
          workspaceId: params.workspaceId,
          actorUserId: actor.kind === "user" ? actor.user.id : null,
          action: "brain-source.created",
          entityType: "BrainSource",
          entityId: brainSource.id,
          meta: {
            sourceType: brainSource.sourceType,
            tier: brainSource.tier,
            documentId: document.id,
          },
        },
      });

      events.push({
        workspaceId: params.workspaceId,
        type: "brain-source.created",
        aggregateType: "BrainSource",
        aggregateId: brainSource.id,
        payload: { sourceId: brainSource.id },
      });
    }

    await appendEvents(tx, events);

    return document;
  });
}

export async function deleteDocument(actor: AppActor, params: {
  workspaceId: string;
  documentId: string;
}) {
  await requireWorkspaceMembership({
    actor,
    workspaceId: params.workspaceId,
    allowedRoles: ["ADMIN"],
  });

  await archiveWorkspaceArtifact(actor, {
    workspaceId: params.workspaceId,
    entityType: "Document",
    entityId: params.documentId,
    reason: "Archived from document delete path.",
  });

  return { id: params.documentId };
}
