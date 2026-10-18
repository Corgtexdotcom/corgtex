import type { KnowledgeAccessDomain, Prisma } from "@prisma/client";
import { prisma } from "@corgtex/shared";
import type { AppActor } from "@corgtex/shared";
import { appendEvents } from "./events";
import { requireWorkspaceMembership } from "./auth";
import { archiveFilterWhere, archiveWorkspaceArtifact, type ArchiveFilter } from "./archive";
import { invariant } from "./errors";
import { persistedMemberId } from "./membership";
import {
  assertTrialStorageCapacity,
  lockAndAssertTrialStorageCapacity,
} from "./trial-entitlements";
import {
  checkWorkspaceDuplicateGuard,
  duplicateGuardAuditMeta,
  duplicateGuardContentHash,
  duplicateGuardMergeText,
  type DuplicateGuardOptions,
} from "./duplicate-guard";
import { resolveKnowledgeAccessDomains } from "./brain-access";
import { scanSourceReadableRecords } from "./source-scoped-read";
import { finishProducerLineage, prepareProducerLineage, type ProducerLineageParams } from "./producer-lineage";
import { captureArtifactInputProof, captureImmutableArtifactInputProof,
  preserveUnknownArtifactInputSnapshot, readableArtifactIds } from "./source-lineage";
import { lockWorkspaceArchiveArtifact } from "./archive";

export async function listDocuments(actor: AppActor, workspaceId: string, opts?: {
  archiveFilter?: ArchiveFilter;
}) {
  const accessDomains: KnowledgeAccessDomain[] = await resolveKnowledgeAccessDomains(actor, workspaceId);

  const documents = await scanSourceReadableRecords({ actor, workspaceId, kind: "Document", load: (afterId, take) => prisma.document.findMany({
    where: { workspaceId, accessDomain: { in: accessDomains }, ...archiveFilterWhere(opts?.archiveFilter),
      ...(afterId ? { id: { gt: afterId } } : {}) }, orderBy: { id: "asc" }, take,
  }) });
  return documents.sort((left, right) => right.createdAt.getTime() - left.createdAt.getTime() || left.id.localeCompare(right.id));
}

type CreateDocumentParams = ProducerLineageParams & {
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

function metadataString(metadata: Record<string, unknown>, key: string) {
  const value = metadata[key];
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function metadataSize(value: Prisma.InputJsonValue | Prisma.JsonValue | null | undefined) {
  const size = metadataObject(value).size;
  return typeof size === "number" && Number.isFinite(size) && size > 0 ? size : 0;
}

export async function filterReadableDocuments(actor: AppActor, workspaceId: string, rows: unknown[]) {
  const candidates = rows.filter((row): row is { id: string; [key: string]: unknown } => typeof row === "object" && row !== null && "id" in row && typeof row.id === "string");
  const ids = await readableArtifactIds(actor, workspaceId, "Document", candidates);
  return candidates.filter(row => ids.has(row.id));
}

export async function getDocument(actor: AppActor, workspaceId: string, documentId: string) {
  await requireWorkspaceMembership({ actor, workspaceId });
  const document = await prisma.document.findFirst({ where: { id: documentId, workspaceId, archivedAt: null } });
  invariant(document, 404, "NOT_FOUND", "Document not found.");
  await captureArtifactInputProof(actor, workspaceId, [{ kind: "Document", id: documentId, snapshot: document }]);
  return document;
}

async function applyDocumentDuplicateUpdate(actor: AppActor, params: CreateDocumentParams, documentId: string) {
  return prisma.$transaction(async (tx) => {
    const sourceWhere = { workspaceId: params.workspaceId, sourceType: { in: ["DOC", "FILE_UPLOAD"] as ("DOC" | "FILE_UPLOAD")[] },
      metadata: { path: ["documentId"], equals: documentId } };
    const sourceRows = await tx.brainSource.findMany({ where: sourceWhere });
    for (const source of [...sourceRows].sort((left, right) => left.id.localeCompare(right.id))) {
      await lockWorkspaceArchiveArtifact(tx, "BrainSource", source.id);
      await tx.$queryRaw`SELECT id FROM "BrainSource" WHERE id = ${source.id} AND "workspaceId" = ${params.workspaceId} FOR UPDATE`;
    }
    await tx.$queryRaw`SELECT id FROM "Document" WHERE id = ${documentId} AND "workspaceId" = ${params.workspaceId} FOR UPDATE`;
    const existing = await tx.document.findFirst({
      where: { id: documentId, workspaceId: params.workspaceId, archivedAt: null },
    });
    invariant(existing, 404, "NOT_FOUND", "Document not found.");
    const prior = await captureArtifactInputProof(actor, params.workspaceId, [{ kind: "Document", id: existing.id, snapshot: existing }], tx);
    const priorRoots = await captureImmutableArtifactInputProof(actor, params.workspaceId, prior, tx);
    const incoming = await prepareProducerLineage({ tx, actor, workspaceId: params.workspaceId, capture: params });
    invariant(incoming.mode !== "UNKNOWN", 409, "UNKNOWN_LINEAGE", "Document inputs need a complete producer receipt.");
    const receipt = await prepareProducerLineage({ tx, actor, workspaceId: params.workspaceId,
      capture: { lineageRoots: [...priorRoots, ...(incoming.mode === "DERIVED" || incoming.mode === "HUMAN_ORIGINAL" ? incoming.roots : [])] }, copied: true });
    const currentSources = await tx.brainSource.findMany({ where: sourceWhere });
    invariant(currentSources.every(source => sourceRows.some(priorSource => priorSource.id === source.id)),
      409, "SOURCE_CHANGED", "Document source links changed before the update.");
    const priorSources = new Map<string, { roots: Awaited<ReturnType<typeof captureArtifactInputProof>>; row: typeof currentSources[number] }>();
    const readableSources = await readableArtifactIds(actor, params.workspaceId, "BrainSource", currentSources, tx);
    for (const source of currentSources) {
      if (readableSources.has(source.id)) {
        const roots = await captureImmutableArtifactInputProof(actor, params.workspaceId, await captureArtifactInputProof(actor, params.workspaceId,
          [{ kind: "BrainSource", id: source.id, snapshot: source }], tx), tx);
        priorSources.set(source.id, { roots, row: source });
      } else await preserveUnknownArtifactInputSnapshot(tx, params.workspaceId, { kind: "BrainSource", id: source.id }, source);
    }
    const mergedText = duplicateGuardMergeText(existing.textContent, params.textContent);
    const metadata = {
      ...metadataObject(existing.metadata),
      ...metadataObject(params.metadata),
      ...(params.textContent ? { contentHash: duplicateGuardContentHash(params.textContent) } : {}),
      duplicateGuardUpdatedAt: new Date().toISOString(),
      duplicateGuardStorageKey: params.storageKey,
    } as Prisma.InputJsonValue;
    const incomingSize = metadataSize(params.metadata);
    if (incomingSize > 0) {
      await lockAndAssertTrialStorageCapacity(tx, params.workspaceId, incomingSize, {
        replacingDocumentId: existing.id,
      });
    }
    const updated = await tx.document.update({
      where: { id: existing.id },
      data: {
        textContent: mergedText,
        metadata,
      },
    });

    await finishProducerLineage({ tx, actor, workspaceId: params.workspaceId, artifact: { kind: "Document", id: updated.id }, content: updated, receipt });
    const sourceRequeueRows = mergedText ? currentSources : [];
    if (mergedText) {
      for (const sourceRow of sourceRequeueRows) {
        const priorSource = priorSources.get(sourceRow.id);
        const sourceReceipt = await prepareProducerLineage({ tx, actor, workspaceId: params.workspaceId, completeCopy: true, copied: true,
          capture: { lineageRoots: priorSource?.roots ?? [] },
          dependencies: [{ kind: "Document", id: updated.id, snapshot: updated }] });
        const source = await tx.brainSource.update({ where: { id: sourceRow.id }, data: {
          content: [updated.title, mergedText].join("\n\n"), title: updated.title, channel: updated.source,
          ingestionGuidanceMd: metadataString(metadataObject(updated.metadata), "ingestionGuidanceMd"),
          fileStorageKey: priorSource?.row.fileStorageKey ?? null, fileMimeType: priorSource?.row.fileMimeType ?? null,
          fileName: priorSource?.row.fileName ?? null, fileSizeBytes: priorSource?.row.fileSizeBytes ?? null,
          authorMemberId: metadataString(metadataObject(updated.metadata), "authorMemberId"), absorbedAt: null,
          metadata: { documentId: updated.id, storageKey: updated.storageKey, mimeType: updated.mimeType,
            ...(priorSource && metadataString(metadataObject(priorSource.row.metadata), "fileContentHash")
              ? { fileContentHash: metadataString(metadataObject(priorSource.row.metadata), "fileContentHash") } : {}),
            duplicateGuardUpdatedAt: new Date().toISOString() } as Prisma.InputJsonValue,
        } });
        await finishProducerLineage({ tx, actor, workspaceId: params.workspaceId, artifact: { kind: "BrainSource", id: source.id }, content: source, receipt: sourceReceipt });
      }
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
      ...sourceRequeueRows.map((sourceRow) => ({
        workspaceId: params.workspaceId,
        type: "brain-source.created" as const,
        aggregateType: "BrainSource",
        aggregateId: sourceRow.id,
        payload: { sourceId: sourceRow.id },
      })),
    ]);

    return updated;
  });
}

export async function createDocument(actor: AppActor, params: CreateDocumentParams) {
  params = { ...params, metadata: params.metadata === undefined ? undefined : structuredClone(params.metadata),
    lineageInputs: params.lineageInputs?.map(input => ({ ...input })), lineageRoots: params.lineageRoots?.map(root => ({ ...root })) };
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
  const sourceUrl = metadataString(documentMetadata, "sourceUrl")
    ?? metadataString(documentMetadata, "url")
    ?? metadataString(documentMetadata, "externalUrl");
  const contentHash = metadataString(documentMetadata, "contentHash") ?? duplicateGuardContentHash(textContent);
  const duplicateDecision = await checkWorkspaceDuplicateGuard({
    workspaceId: params.workspaceId,
    entityType: "Document",
    title,
    body: textContent,
    source,
    sourceUrl,
    contentHash,
    content: textContent,
  }, params.duplicateGuard, undefined, rows => filterReadableDocuments(actor, params.workspaceId, rows));
  if (duplicateDecision?.resolution === "use_existing") {
    return getDocument(actor, params.workspaceId, duplicateDecision.match.entityId);
  }
  if (duplicateDecision?.resolution === "update_existing") {
    return applyDocumentDuplicateUpdate(actor, params, duplicateDecision.match.entityId);
  }
  const metadata = params.metadata;
  const createMetadata = {
    ...metadataObject(metadata),
    authorMemberId: actor.kind === "user" ? persistedMemberId(membership) : null,
    ...(contentHash ? { contentHash } : {}),
  };
  const size = metadataSize(metadata);
  await assertTrialStorageCapacity(params.workspaceId, size);

  return prisma.$transaction(async (tx) => {
    await lockAndAssertTrialStorageCapacity(tx, params.workspaceId, size);
    const receipt = await prepareProducerLineage({ tx, actor, workspaceId: params.workspaceId, capture: params });
    invariant(receipt.mode !== "UNKNOWN", 409, "UNKNOWN_LINEAGE", "Document inputs need a complete producer receipt.");
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

    await finishProducerLineage({ tx, actor, workspaceId: params.workspaceId, artifact: { kind: "Document", id: document.id }, content: document, receipt });
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
      const sourceReceipt = await prepareProducerLineage({ tx, actor, workspaceId: params.workspaceId, copied: true, completeCopy: true,
        dependencies: [{ kind: "Document", id: document.id, snapshot: document }] });
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

      await finishProducerLineage({ tx, actor, workspaceId: params.workspaceId, artifact: { kind: "BrainSource", id: brainSource.id }, content: brainSource, receipt: sourceReceipt });
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
