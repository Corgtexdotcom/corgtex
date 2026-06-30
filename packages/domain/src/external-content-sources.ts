import { createHash } from "node:crypto";
import { Prisma, type ExternalContentSourceKind, type ExternalContentSourceStatus, type KnowledgeSourceType } from "@prisma/client";
import type { AppActor } from "@corgtex/shared";
import { prisma } from "@corgtex/shared";
import { recordAudit } from "./audit-trail";
import { requireWorkspaceMembership } from "./auth";
import { appendEvents } from "./events";
import { callBoxExternalMcpReadToolForConnection, type ExternalMcpProviderKey } from "./external-mcp";
import { AppError, invariant } from "./errors";

export const EXTERNAL_CONTENT_SOURCE_KINDS = ["HUB", "FOLDER", "FILE"] as const;
export const EXTERNAL_CONTENT_SOURCE_STATUSES = ["ACTIVE", "SYNCING", "ERROR", "ARCHIVED"] as const;
export const EXTERNAL_CONTENT_SYNC_JOB_TYPE = "knowledge.sync.external-content";

export type ExternalContentSourceKindValue = typeof EXTERNAL_CONTENT_SOURCE_KINDS[number];
export type ExternalContentSourceStatusValue = typeof EXTERNAL_CONTENT_SOURCE_STATUSES[number];

export type ExternalContentKnowledgeInput = {
  workspaceId: string;
  sourceType: KnowledgeSourceType;
  sourceId: string;
  sourceTitle: string;
  content: string;
  metadata: Record<string, unknown>;
  workflowJobId?: string;
};

const MAX_SYNC_CONTENT_CHARS = 500_000;
const BOX_FOLDER_ITEM_LIMIT = 100;
const BOX_HUB_ITEM_LIMIT = 100;

const externalContentSyncLogSelect = {
  id: true,
  status: true,
  remoteVersion: true,
  chunksCreated: true,
  brainSourceId: true,
  error: true,
  startedAt: true,
  completedAt: true,
} satisfies Prisma.ExternalContentSyncLogSelect;

const externalContentSourceSelect = {
  id: true,
  workspaceId: true,
  connectionId: true,
  selectedByUserId: true,
  providerKey: true,
  sourceKind: true,
  externalId: true,
  title: true,
  externalUrl: true,
  syncMode: true,
  status: true,
  lastRemoteVersion: true,
  lastSyncedAt: true,
  lastSyncError: true,
  metadata: true,
  archivedAt: true,
  archiveReason: true,
  createdAt: true,
  updatedAt: true,
} satisfies Prisma.ExternalContentSourceSelect;

const externalContentSourceListSelect = {
  ...externalContentSourceSelect,
  selectedByUser: {
    select: {
      id: true,
      email: true,
      displayName: true,
    },
  },
  syncLogs: {
    orderBy: { startedAt: "desc" as const },
    take: 3,
    select: externalContentSyncLogSelect,
  },
} satisfies Prisma.ExternalContentSourceSelect;

const externalContentSyncSourceSelect = {
  id: true,
  workspaceId: true,
  connectionId: true,
  providerKey: true,
  sourceKind: true,
  externalId: true,
  title: true,
  externalUrl: true,
  lastRemoteVersion: true,
  metadata: true,
} satisfies Prisma.ExternalContentSourceSelect;

type ExternalContentSourceRecord = Prisma.ExternalContentSourceGetPayload<{ select: typeof externalContentSourceSelect }>;
type ExternalContentSourceListRecord = Prisma.ExternalContentSourceGetPayload<{ select: typeof externalContentSourceListSelect }>;
type ExternalContentSyncSourceRecord = Prisma.ExternalContentSourceGetPayload<{ select: typeof externalContentSyncSourceSelect }>;

type MaterializedExternalContent = {
  title: string;
  externalUrl: string | null;
  remoteVersion: string;
  content: string;
  metadata: Record<string, unknown>;
};

function actorUserId(actor: AppActor) {
  return actor.kind === "user" ? actor.user.id : null;
}

function syncActor(workspaceId: string): AppActor {
  return {
    kind: "agent",
    authProvider: "bootstrap",
    label: "external-content-sync",
    workspaceIds: [workspaceId],
  };
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function asString(value: unknown) {
  return typeof value === "string" ? value : "";
}

function cleanText(value?: string | null, maxLength = 4000) {
  const trimmed = value?.replace(/\s+/g, " ").trim() ?? "";
  return trimmed ? trimmed.slice(0, maxLength) : "";
}

function sourceKindLabel(sourceKind: ExternalContentSourceKindValue) {
  return sourceKind.toLowerCase().replace(/\b\w/g, (letter) => letter.toUpperCase());
}

function validateProviderKey(providerKey: string): ExternalMcpProviderKey {
  invariant(providerKey === "box", 400, "UNSUPPORTED_PROVIDER", "Box is the only external content provider enabled in this phase.");
  return "box";
}

function validateSourceKind(sourceKind: string): ExternalContentSourceKindValue {
  invariant((EXTERNAL_CONTENT_SOURCE_KINDS as readonly string[]).includes(sourceKind), 400, "INVALID_INPUT", "Unsupported external content source kind.");
  return sourceKind as ExternalContentSourceKindValue;
}

function boxExternalContentUrl(sourceKind: ExternalContentSourceKindValue, externalId: string) {
  const id = encodeURIComponent(externalId);
  if (sourceKind === "FOLDER") return `https://app.box.com/folder/${id}`;
  if (sourceKind === "HUB") return `https://app.box.com/hubs/${id}`;
  return `https://app.box.com/file/${id}`;
}

function toJsonObject(value: Record<string, unknown>): Prisma.InputJsonObject {
  return JSON.parse(JSON.stringify(value)) as Prisma.InputJsonObject;
}

function existingMetadata(value: Prisma.JsonValue | null): Record<string, unknown> {
  return asRecord(value);
}

function stableValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stableValue);
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .filter(([, entry]) => entry !== undefined)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, entry]) => [key, stableValue(entry)]),
    );
  }
  return value;
}

function stableJson(value: unknown) {
  return JSON.stringify(stableValue(value));
}

function hashPayload(value: unknown) {
  return createHash("sha256").update(stableJson(value)).digest("hex");
}

function findRemoteVersion(value: unknown): string | null {
  const record = asRecord(value);
  const direct = asString(record.etag)
    || asString(record.sequence_id)
    || asString(record.modified_at)
    || asString(record.modifiedAt)
    || asString(record.updated_at)
    || asString(record.updatedAt);
  if (direct) return direct;
  const fileVersion = asRecord(record.file_version);
  const fileVersionId = asString(fileVersion.id);
  return fileVersionId || null;
}

function remoteVersionFor(payload: unknown) {
  const explicit = Array.isArray(payload)
    ? payload.map(findRemoteVersion).find(Boolean)
    : findRemoteVersion(payload);
  return explicit ?? `sha256:${hashPayload(payload)}`;
}

function payloadText(value: unknown, fallbackLabel: string) {
  if (typeof value === "string") return value.trim();
  const record = asRecord(value);
  const text = asString(record.text)
    || asString(record.content)
    || asString(record.markdown)
    || asString(record.answer)
    || asString(record.description);
  if (text) return text.trim();
  const content = Array.isArray(record.content) ? record.content : [];
  const contentText = content
    .map((entry) => asString(asRecord(entry).text))
    .filter(Boolean)
    .join("\n\n")
    .trim();
  if (contentText) return contentText;
  return `${fallbackLabel}:\n${JSON.stringify(stableValue(value), null, 2)}`;
}

function itemName(value: unknown) {
  const record = asRecord(value);
  const item = asRecord(record.item);
  return asString(record.name)
    || asString(record.title)
    || asString(item.name)
    || asString(item.title)
    || asString(record.id)
    || asString(item.id)
    || "Untitled";
}

function itemType(value: unknown) {
  const record = asRecord(value);
  const item = asRecord(record.item);
  return asString(record.type) || asString(item.type) || "item";
}

function itemId(value: unknown) {
  const record = asRecord(value);
  const item = asRecord(record.item);
  return asString(record.id) || asString(item.id) || "";
}

function payloadEntries(value: unknown) {
  const record = asRecord(value);
  return Array.isArray(record.entries)
    ? record.entries
    : Array.isArray(record.items)
      ? record.items
      : Array.isArray(record.results)
        ? record.results
        : [];
}

function itemListText(value: unknown) {
  const entries = payloadEntries(value);
  if (entries.length === 0) return payloadText(value, "Items");
  return entries.map((entry) => {
    const id = itemId(entry);
    return `- ${itemName(entry)} (${itemType(entry)}${id ? ` ${id}` : ""})`;
  }).join("\n");
}

function titleFromRemote(source: ExternalContentSyncSourceRecord, payload: unknown) {
  const record = asRecord(payload);
  return cleanText(asString(record.name) || asString(record.title) || source.title, 240)
    || `${sourceKindLabel(source.sourceKind as ExternalContentSourceKindValue)} ${source.externalId}`;
}

function truncateContent(content: string) {
  if (content.length <= MAX_SYNC_CONTENT_CHARS) return content;
  return `${content.slice(0, MAX_SYNC_CONTENT_CHARS)}\n\n[Truncated by Corgtex at ${MAX_SYNC_CONTENT_CHARS} characters for reliable indexing.]`;
}

async function requireSelectableBoxConnection(actor: AppActor, workspaceId: string, connectionId?: string | null) {
  invariant(actor.kind === "user", 403, "FORBIDDEN", "Select Box content as the user whose Box connection should be used.");
  const connection = await prisma.externalMcpConnection.findFirst({
    where: {
      ...(connectionId ? { id: connectionId } : {}),
      workspaceId,
      userId: actor.user.id,
      providerKey: "box",
      status: "ACTIVE",
    },
    orderBy: { updatedAt: "desc" },
    select: {
      id: true,
      providerEmail: true,
      providerAccountId: true,
    },
  });
  invariant(connection, 404, "NOT_CONNECTED", "Connect Box before selecting Box content for sync.");
  return connection;
}

async function fetchBoxMaterializedContent(actor: AppActor, source: ExternalContentSyncSourceRecord): Promise<MaterializedExternalContent> {
  invariant(source.providerKey === "box", 400, "UNSUPPORTED_PROVIDER", "Only Box external content sources can be synced in this phase.");
  invariant(source.connectionId, 404, "NOT_CONNECTED", "Selected Box source is missing a Box connection.");
  const sourceKind = source.sourceKind as ExternalContentSourceKindValue;
  const callBox = (toolName: string, args: Record<string, unknown>) => callBoxExternalMcpReadToolForConnection(actor, {
    workspaceId: source.workspaceId,
    connectionId: source.connectionId as string,
    toolName,
    arguments: args,
  });

  if (sourceKind === "FILE") {
    const details = await callBox("get_file_details", {
      file_id: source.externalId,
      fields: ["id", "type", "name", "description", "modified_at", "size", "extension", "shared_link", "file_version", "etag"],
    });
    const fileContent = await callBox("get_file_content", { file_id: source.externalId });
    const title = titleFromRemote(source, details);
    const remoteVersion = remoteVersionFor([details, fileContent]);
    const content = truncateContent([
      `# ${title}`,
      "Source: live Box file snapshot synced into Corgtex.",
      `Box file ID: ${source.externalId}`,
      source.externalUrl ? `Box URL: ${source.externalUrl}` : null,
      `Remote version: ${remoteVersion}`,
      "Details:",
      payloadText(details, "File details"),
      "File content:",
      payloadText(fileContent, "File content"),
    ].filter(Boolean).join("\n\n"));
    return {
      title,
      externalUrl: source.externalUrl || boxExternalContentUrl(sourceKind, source.externalId),
      remoteVersion,
      content,
      metadata: {
        detailSummary: stableValue(details),
      },
    };
  }

  if (sourceKind === "FOLDER") {
    const details = await callBox("get_folder_details", {
      folder_id: source.externalId,
      fields: ["id", "type", "name", "description", "modified_at", "shared_link", "etag"],
    });
    const items = await callBox("list_folder_content_by_folder_id", {
      folder_id: source.externalId,
      limit: BOX_FOLDER_ITEM_LIMIT,
    });
    const title = titleFromRemote(source, details);
    const remoteVersion = remoteVersionFor([details, items]);
    const content = truncateContent([
      `# ${title}`,
      "Source: selected Box folder listing synced into Corgtex. This is not a recursive folder crawl.",
      `Box folder ID: ${source.externalId}`,
      source.externalUrl ? `Box URL: ${source.externalUrl}` : null,
      `Remote version: ${remoteVersion}`,
      "Folder details:",
      payloadText(details, "Folder details"),
      "Top-level selected folder items:",
      itemListText(items),
    ].filter(Boolean).join("\n\n"));
    return {
      title,
      externalUrl: source.externalUrl || boxExternalContentUrl(sourceKind, source.externalId),
      remoteVersion,
      content,
      metadata: {
        detailSummary: stableValue(details),
        itemCount: payloadEntries(items).length,
        itemLimit: BOX_FOLDER_ITEM_LIMIT,
      },
    };
  }

  const details = await callBox("get_hub_details", { hub_id: source.externalId });
  const items = await callBox("get_hub_items", {
    hub_id: source.externalId,
    limit: BOX_HUB_ITEM_LIMIT,
  });
  const title = titleFromRemote(source, details);
  const remoteVersion = remoteVersionFor([details, items]);
  const content = truncateContent([
    `# ${title}`,
    "Source: selected Box Hub snapshot synced into Corgtex. Box remains the canonical system of record.",
    `Box Hub ID: ${source.externalId}`,
    source.externalUrl ? `Box URL: ${source.externalUrl}` : null,
    `Remote version: ${remoteVersion}`,
    "Hub details:",
    payloadText(details, "Hub details"),
    "Hub items:",
    itemListText(items),
  ].filter(Boolean).join("\n\n"));
  return {
    title,
    externalUrl: source.externalUrl || boxExternalContentUrl(sourceKind, source.externalId),
    remoteVersion,
    content,
    metadata: {
      detailSummary: stableValue(details),
      itemCount: payloadEntries(items).length,
      itemLimit: BOX_HUB_ITEM_LIMIT,
    },
  };
}

async function failExternalContentSync(params: {
  workspaceId: string;
  sourceId: string;
  syncLogId?: string | null;
  error: unknown;
}) {
  const message = params.error instanceof Error ? params.error.message : String(params.error);
  await prisma.$transaction(async (tx) => {
    await tx.externalContentSource.updateMany({
      where: { id: params.sourceId, workspaceId: params.workspaceId },
      data: {
        status: "ERROR",
        lastSyncError: message,
      },
    });
    if (params.syncLogId) {
      await tx.externalContentSyncLog.update({
        where: { id: params.syncLogId },
        data: {
          status: "ERROR",
          error: message,
          completedAt: new Date(),
        },
      });
    }
  });
}

export async function listExternalContentSources(actor: AppActor, params: {
  workspaceId: string;
  providerKey?: string | null;
  includeArchived?: boolean;
}): Promise<ExternalContentSourceListRecord[]> {
  await requireWorkspaceMembership({ actor, workspaceId: params.workspaceId });
  const providerKey = params.providerKey ? validateProviderKey(params.providerKey) : undefined;
  return prisma.externalContentSource.findMany({
    where: {
      workspaceId: params.workspaceId,
      ...(providerKey ? { providerKey } : {}),
      ...(params.includeArchived ? {} : { archivedAt: null, status: { not: "ARCHIVED" as ExternalContentSourceStatus } }),
    },
    orderBy: [{ status: "asc" }, { updatedAt: "desc" }],
    select: externalContentSourceListSelect,
  });
}

export async function selectExternalContentSource(actor: AppActor, params: {
  workspaceId: string;
  providerKey: string;
  sourceKind: string;
  externalId: string;
  title?: string | null;
  externalUrl?: string | null;
  connectionId?: string | null;
  metadata?: Record<string, unknown> | null;
}): Promise<ExternalContentSourceRecord> {
  await requireWorkspaceMembership({ actor, workspaceId: params.workspaceId });
  const providerKey = validateProviderKey(params.providerKey);
  const sourceKind = validateSourceKind(params.sourceKind);
  const externalId = cleanText(params.externalId, 240);
  invariant(externalId, 400, "INVALID_INPUT", "External source ID is required.");
  const connection = await requireSelectableBoxConnection(actor, params.workspaceId, params.connectionId);
  const title = cleanText(params.title, 240) || `${sourceKindLabel(sourceKind)} ${externalId}`;
  const externalUrl = cleanText(params.externalUrl, 2000) || boxExternalContentUrl(sourceKind, externalId);

  return prisma.$transaction(async (tx) => {
    const source = await tx.externalContentSource.upsert({
      where: {
        workspaceId_providerKey_sourceKind_externalId: {
          workspaceId: params.workspaceId,
          providerKey,
          sourceKind: sourceKind as ExternalContentSourceKind,
          externalId,
        },
      },
      update: {
        connectionId: connection.id,
        selectedByUserId: actorUserId(actor),
        title,
        externalUrl,
        syncMode: "SELECTED",
        status: "SYNCING",
        lastSyncError: null,
        archivedAt: null,
        archiveReason: null,
        ...(params.metadata ? { metadata: toJsonObject(params.metadata) } : {}),
      },
      create: {
        workspaceId: params.workspaceId,
        connectionId: connection.id,
        selectedByUserId: actorUserId(actor),
        providerKey,
        sourceKind: sourceKind as ExternalContentSourceKind,
        externalId,
        title,
        externalUrl,
        syncMode: "SELECTED",
        status: "SYNCING",
        metadata: params.metadata ? toJsonObject(params.metadata) : Prisma.DbNull,
      },
      select: externalContentSourceSelect,
    });

    await tx.workflowJob.create({
      data: {
        workspaceId: params.workspaceId,
        type: EXTERNAL_CONTENT_SYNC_JOB_TYPE,
        payload: { sourceId: source.id },
      },
    });

    await recordAudit(tx, actor, {
      workspaceId: params.workspaceId,
      action: "external-content-source.selected",
      entityType: "ExternalContentSource",
      entityId: source.id,
      meta: {
        providerKey,
        sourceKind,
        externalId,
        connectionId: connection.id,
      },
    });

    return source;
  });
}

export async function enqueueExternalContentSourceSync(actor: AppActor, params: {
  workspaceId: string;
  sourceId: string;
}): Promise<ExternalContentSourceRecord> {
  await requireWorkspaceMembership({ actor, workspaceId: params.workspaceId });
  return prisma.$transaction(async (tx) => {
    const source = await tx.externalContentSource.findFirst({
      where: {
        id: params.sourceId,
        workspaceId: params.workspaceId,
        archivedAt: null,
        status: { not: "ARCHIVED" },
      },
      select: externalContentSourceSelect,
    });
    invariant(source, 404, "NOT_FOUND", "External content source not found.");

    const updated = await tx.externalContentSource.update({
      where: { id: source.id },
      data: {
        status: "SYNCING",
        lastSyncError: null,
      },
      select: externalContentSourceSelect,
    });

    await tx.workflowJob.create({
      data: {
        workspaceId: params.workspaceId,
        type: EXTERNAL_CONTENT_SYNC_JOB_TYPE,
        payload: { sourceId: source.id },
      },
    });

    await recordAudit(tx, actor, {
      workspaceId: params.workspaceId,
      action: "external-content-source.sync_requested",
      entityType: "ExternalContentSource",
      entityId: source.id,
      meta: {
        providerKey: source.providerKey,
        sourceKind: source.sourceKind,
        externalId: source.externalId,
      },
    });

    return updated;
  });
}

export async function syncExternalContentSource(params: {
  workspaceId: string;
  sourceId: string;
  workflowJobId?: string | null;
  syncKnowledge: (input: ExternalContentKnowledgeInput) => Promise<number | void>;
}) {
  const actor = syncActor(params.workspaceId);
  let syncLogId: string | null = null;

  const source = await prisma.$transaction(async (tx) => {
    const found = await tx.externalContentSource.findFirst({
      where: {
        id: params.sourceId,
        workspaceId: params.workspaceId,
        archivedAt: null,
        status: { not: "ARCHIVED" },
      },
      select: externalContentSyncSourceSelect,
    });
    if (!found) return null;
    await tx.externalContentSource.update({
      where: { id: found.id },
      data: {
        status: "SYNCING",
        lastSyncError: null,
      },
    });
    const log = await tx.externalContentSyncLog.create({
      data: {
        workspaceId: params.workspaceId,
        sourceId: found.id,
        workflowJobId: params.workflowJobId ?? null,
        status: "RUNNING",
      },
      select: { id: true },
    });
    syncLogId = log.id;
    return found;
  });

  if (!source) {
    return { status: "SKIPPED", reason: "missing_source" as const };
  }

  try {
    const materialized = await fetchBoxMaterializedContent(actor, source);
    const existing = existingMetadata(source.metadata);
    const knowledgeMetadata = {
      ...existing,
      ...materialized.metadata,
      providerKey: source.providerKey,
      sourceKind: source.sourceKind,
      externalId: source.externalId,
      externalUrl: materialized.externalUrl,
      remoteVersion: materialized.remoteVersion,
      externalContentSourceId: source.id,
      snapshotType: "box_synced_snapshot",
      liveContextAvailable: true,
      workflowJobId: params.workflowJobId ?? null,
    };

    if (source.lastRemoteVersion === materialized.remoteVersion) {
      await prisma.$transaction(async (tx) => {
        await tx.externalContentSource.update({
          where: { id: source.id },
          data: {
            status: "ACTIVE",
            title: materialized.title,
            externalUrl: materialized.externalUrl,
            lastSyncedAt: new Date(),
            lastSyncError: null,
            metadata: toJsonObject({
              ...existing,
              providerKey: source.providerKey,
              sourceKind: source.sourceKind,
              externalId: source.externalId,
              externalUrl: materialized.externalUrl,
              lastRemoteVersion: materialized.remoteVersion,
              lastNoopSyncAt: new Date().toISOString(),
            }),
          },
        });
        await tx.externalContentSyncLog.update({
          where: { id: syncLogId as string },
          data: {
            status: "UNCHANGED",
            remoteVersion: materialized.remoteVersion,
            chunksCreated: 0,
            completedAt: new Date(),
          },
        });
      });
      return { status: "UNCHANGED", sourceId: source.id, remoteVersion: materialized.remoteVersion, chunksCreated: 0 };
    }

    const knowledgeInput: ExternalContentKnowledgeInput = {
      workspaceId: params.workspaceId,
      sourceType: "EXTERNAL_CONTENT",
      sourceId: source.id,
      sourceTitle: materialized.title,
      content: materialized.content,
      metadata: knowledgeMetadata,
      workflowJobId: params.workflowJobId ?? undefined,
    };
    const chunksCreated = await params.syncKnowledge(knowledgeInput) ?? 0;

    const brainSource = await prisma.$transaction(async (tx) => {
      const created = await tx.brainSource.create({
        data: {
          workspaceId: params.workspaceId,
          sourceType: "EXTERNAL_CONTENT",
          tier: 2,
          title: materialized.title,
          content: materialized.content,
          externalId: `box:${String(source.sourceKind).toLowerCase()}:${source.externalId}:${materialized.remoteVersion}`,
          channel: "box",
          metadata: toJsonObject(knowledgeMetadata),
        },
        select: { id: true },
      });

      await recordAudit(tx, actor, {
        workspaceId: params.workspaceId,
        action: "brain-source.created",
        entityType: "BrainSource",
        entityId: created.id,
        meta: {
          sourceType: "EXTERNAL_CONTENT",
          tier: 2,
          externalContentSourceId: source.id,
          providerKey: source.providerKey,
        },
      });

      await appendEvents(tx, [{
        workspaceId: params.workspaceId,
        type: "brain-source.created",
        aggregateType: "BrainSource",
        aggregateId: created.id,
        payload: { sourceId: created.id },
      }]);

      await tx.externalContentSource.update({
        where: { id: source.id },
        data: {
          status: "ACTIVE",
          title: materialized.title,
          externalUrl: materialized.externalUrl,
          lastRemoteVersion: materialized.remoteVersion,
          lastSyncedAt: new Date(),
          lastSyncError: null,
          metadata: toJsonObject({
            ...existing,
            providerKey: source.providerKey,
            sourceKind: source.sourceKind,
            externalId: source.externalId,
            externalUrl: materialized.externalUrl,
            lastRemoteVersion: materialized.remoteVersion,
            lastBrainSourceId: created.id,
          }),
        },
      });

      await tx.externalContentSyncLog.update({
        where: { id: syncLogId as string },
        data: {
          status: "SYNCED",
          remoteVersion: materialized.remoteVersion,
          chunksCreated,
          brainSourceId: created.id,
          completedAt: new Date(),
        },
      });

      return created;
    });

    return {
      status: "SYNCED",
      sourceId: source.id,
      remoteVersion: materialized.remoteVersion,
      chunksCreated,
      brainSourceId: brainSource.id,
    };
  } catch (error) {
    await failExternalContentSync({
      workspaceId: params.workspaceId,
      sourceId: source.id,
      syncLogId,
      error,
    });
    if (error instanceof AppError) throw error;
    throw new AppError(502, "EXTERNAL_CONTENT_SYNC_FAILED", error instanceof Error ? error.message : "External content sync failed.");
  }
}
