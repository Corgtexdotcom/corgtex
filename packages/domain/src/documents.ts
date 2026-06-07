import type { Prisma } from "@prisma/client";
import { prisma } from "@corgtex/shared";
import type { AppActor } from "@corgtex/shared";
import { appendEvents } from "./events";
import { persistedMemberId, requireWorkspaceMembership } from "./auth";
import { archiveFilterWhere, archiveWorkspaceArtifact, type ArchiveFilter } from "./archive";
import { invariant } from "./errors";
import { assertTrialStorageCapacity } from "./trial-entitlements";

export async function listDocuments(workspaceId: string, opts?: { archiveFilter?: ArchiveFilter }) {
  return prisma.document.findMany({
    where: { workspaceId, ...archiveFilterWhere(opts?.archiveFilter) },
    orderBy: { createdAt: "desc" },
  });
}

export async function createDocument(actor: AppActor, params: {
  workspaceId: string;
  title: string;
  source: string;
  storageKey: string;
  mimeType?: string | null;
  textContent?: string | null;
  metadata?: Prisma.InputJsonValue;
}) {
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
  const metadata = params.metadata;
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
        ...(params.metadata === undefined ? {} : { metadata: params.metadata }),
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
