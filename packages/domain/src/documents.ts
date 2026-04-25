import type { Prisma } from "@prisma/client";
import { prisma } from "@corgtex/shared";
import type { AppActor } from "@corgtex/shared";
import { appendEvents } from "./events";
import { requireWorkspaceMembership } from "./auth";
import { archiveFilterWhere, archiveWorkspaceArtifact, type ArchiveFilter } from "./archive";
import { invariant } from "./errors";

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
  await requireWorkspaceMembership({
    actor,
    workspaceId: params.workspaceId,
  });

  const title = params.title.trim();
  const source = params.source.trim();
  const storageKey = params.storageKey.trim();

  invariant(title.length > 0, 400, "INVALID_INPUT", "Document title is required.");
  invariant(source.length > 0, 400, "INVALID_INPUT", "Document source is required.");
  invariant(storageKey.length > 0, 400, "INVALID_INPUT", "storageKey is required.");

  return prisma.$transaction(async (tx) => {
    const document = await tx.document.create({
      data: {
        workspaceId: params.workspaceId,
        title,
        source,
        storageKey,
        mimeType: params.mimeType?.trim() || null,
        textContent: params.textContent?.trim() || null,
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

    await appendEvents(tx, [
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
    ]);

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
