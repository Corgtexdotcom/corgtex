import { createHash, randomUUID } from "node:crypto";
import { Prisma, type ExternalContentSourceStatus, type KnowledgeSourceType } from "@prisma/client";
import type { AppActor } from "@corgtex/shared";
import { prisma } from "@corgtex/shared";
import { recordAudit } from "./audit-trail";
import { requireWorkspaceMembership } from "./auth";
import { appendEvents } from "./events";
import { type ExternalMcpProviderKey } from "./external-mcp";
import { AppError, invariant } from "./errors";
import { assertArtifactInputWriteFence, captureArtifactInputProof, captureImmutableArtifactInputProof,
  isArtifactInputProofReadable, preserveUnknownArtifactInputSnapshot, recordArtifactInputLineage,
  lineageContentFingerprint, type LineageRoot } from "./source-lineage";
import { DigestReadRelease } from "./digest-lineage";
import { scanSourceReadableRecords } from "./source-scoped-read";
import { captureExternalProviderFetchInput, createExternalProviderSyncActor, assertExternalProviderActorCurrent,
  getExternalProviderPrincipalUserId, isExternalProviderSelectionCurrent, registerExternalProviderRefetchCallback,
  assertExternalProviderCapturedResponseCurrent, prepareExternalProviderCommitPreflight, withExternalProviderCommitPreflight,
  type ExternalProviderCapturedResponse } from "./external-provider-authority";

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
  lineageActor: AppActor;
};

const MAX_SYNC_CONTENT_CHARS = 500_000;
const BOX_FOLDER_ITEM_LIMIT = 100;
const BOX_HUB_ITEM_LIMIT = 100;

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
  archivedByUserId: true,
  archiveReason: true,
  createdAt: true,
  updatedAt: true,
} satisfies Prisma.ExternalContentSourceSelect;

type ExternalContentSourceRecord = Prisma.ExternalContentSourceGetPayload<{ select: typeof externalContentSourceSelect }>;
type ExternalContentSourceListRecord = ExternalContentSourceRecord & { selectedByUser: { id: string; email: string; displayName: string | null } | null; syncLogs: Array<{ id: string; status: string; remoteVersion: string | null; chunksCreated: number; brainSourceId: string | null; error: string | null; startedAt: Date; completedAt: Date | null }> };
type ExternalContentSyncSourceRecord = Prisma.ExternalContentSourceGetPayload<object>;

type MaterializedExternalContent = {
  title: string;
  externalUrl: string | null;
  remoteVersion: string;
  content: string;
  metadata: Record<string, unknown>;
  receipts: ExternalProviderCapturedResponse[];
};

function actorUserId(actor: AppActor) {
  return actor.kind === "user" ? actor.user.id : null;
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
  const receipts: ExternalProviderCapturedResponse[] = [];
  const callBox = async (toolName: string, args: Record<string, unknown>) => {
    const receipt = await captureExternalProviderFetchInput(actor, { workspaceId: source.workspaceId,
      externalContentSourceId: source.id, connectionId: source.connectionId!, sourceKind,
      externalId: source.externalId, toolName, arguments: args });
    await assertExternalProviderCapturedResponseCurrent(receipt);
    receipts.push(receipt);
    return receipt.payload;
  };

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
      title, receipts,
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
      title, receipts,
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
    title, receipts,
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
  await prisma.$transaction(async (tx) => {
    if (params.syncLogId) await tx.externalContentSyncLog.update({ where: { id: params.syncLogId },
      data: { status: "ERROR", error: "External content synchronization failed.", completedAt: new Date() } });
  });
}

export async function listExternalContentSources(actor: AppActor, params: {
  workspaceId: string;
  providerKey?: string | null;
  includeArchived?: boolean;
}): Promise<ExternalContentSourceListRecord[]> {
  await requireWorkspaceMembership({ actor, workspaceId: params.workspaceId });
  const providerKey = params.providerKey ? validateProviderKey(params.providerKey) : undefined;
  const userId = getExternalProviderPrincipalUserId(actor, params.workspaceId);
  if (!userId) return [];
  const release = new DigestReadRelease(actor, params.workspaceId);
  const rows = await scanSourceReadableRecords({ actor, workspaceId: params.workspaceId, kind: "ExternalContentSource", release,
    load: (afterId, take) => prisma.externalContentSource.findMany({
      where: { workspaceId: params.workspaceId, selectedByUserId: userId, ...(providerKey ? { providerKey } : {}),
        ...(params.includeArchived ? {} : { archivedAt: null, status: { not: "ARCHIVED" as ExternalContentSourceStatus } }),
        ...(afterId ? { id: { gt: afterId } } : {}) }, orderBy: { id: "asc" }, take,
    }) });
  if (!rows.length) return release.finish([]);
  const safe: ExternalContentSourceListRecord[] = [];
  // The selection is bound to one current user; read and retain that label once.
  const labels = await prisma.user.findFirst({ where: { id: userId }, select: { id: true, email: true, displayName: true } });
  const capturedLabels = await release.capture("User", labels ? [labels] : []);
  const selectedByUser = capturedLabels.records[0] ?? null;
  for (const row of rows) safe.push({ ...row, lastSyncError: row.lastSyncError ? "Synchronization failed." : null, selectedByUser, syncLogs: [] });
  return release.finish(safe.sort((left, right) => left.status.localeCompare(right.status) || right.updatedAt.getTime() - left.updatedAt.getTime()));
}

function selectionRoot(source: { metadata?: unknown }): LineageRoot | null {
  const value = asRecord(asRecord(source.metadata).selectionInputRoot);
  return value.kind === "ArtifactInputSnapshot" && typeof value.id === "string" && typeof value.fingerprint === "string"
    ? { kind: "ArtifactInputSnapshot", id: value.id, fingerprint: value.fingerprint } : null;
}
async function originalSelectionRoot(db: Prisma.TransactionClient | typeof prisma, source: { id: string; workspaceId: string; metadata?: unknown;
  connectionId?: string | null; selectedByUserId?: string | null; providerKey?: string; sourceKind?: string; externalId?: string }) {
  const root = selectionRoot(source);
  if (!root) return null;
  const snapshot = await db.artifactInputSnapshot.findFirst({ where: { id: root.id, workspaceId: source.workspaceId,
    sourceKind: "ExternalContentSource", sourceId: source.id } });
  const original = asRecord(snapshot?.contentJson);
  if (!snapshot || ["connectionId", "selectedByUserId", "providerKey", "sourceKind", "externalId"].some(key => original[key] !== (source as Record<string, unknown>)[key])) return null;
  return root;
}
async function enqueueScopedSync(tx: Prisma.TransactionClient, actor: AppActor, source: ExternalContentSourceRecord, root: LineageRoot) {
  const job = await tx.workflowJob.create({ data: { workspaceId: source.workspaceId, type: EXTERNAL_CONTENT_SYNC_JOB_TYPE,
    payload: { sourceId: source.id } } });
  await recordArtifactInputLineage({ tx, actor, workspaceId: source.workspaceId, artifact: { kind: "WorkflowJobInput", id: job.id },
    content: job, origin: "DERIVED", inputs: [], inheritedRoots: [root] });
}

registerExternalProviderRefetchCallback(async ({ actor, workspaceId, sourceId, consumedResponseHash }) => {
  await prisma.$transaction(async tx => {
    const source = await tx.externalContentSource.findFirst({ where: { id: sourceId, workspaceId, archivedAt: null } });
    if (!source || !await isExternalProviderSelectionCurrent(actor, workspaceId, source, tx)) return;
    const root = await originalSelectionRoot(tx, source);
    if (!root || !await isArtifactInputProofReadable(actor, workspaceId, [root], tx)) return;
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${`external_refetch_source:${workspaceId}:${sourceId}`}, 0))`;
    const active = await tx.workflowJob.findFirst({ where: { workspaceId, type: EXTERNAL_CONTENT_SYNC_JOB_TYPE,
      status: { in: ["PENDING", "RUNNING"] }, payload: { path: ["sourceId"], equals: sourceId } } });
    if (active) {
      try { await captureArtifactInputProof(actor, workspaceId, [{ kind: "WorkflowJobInput", id: active.id }], tx); return; }
      catch { /* An unproven legacy job cannot substitute for this exact recipe. */ }
    }
    const dedupeKey = `external-refetch:${source.id}:${hashPayload([consumedResponseHash, root.fingerprint])}`;
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${dedupeKey}, 0))`;
    if (await tx.workflowJob.findFirst({ where: { dedupeKey } })) return;
    const job = await tx.workflowJob.create({ data: { workspaceId, type: EXTERNAL_CONTENT_SYNC_JOB_TYPE, dedupeKey, payload: { sourceId } } });
    await recordArtifactInputLineage({ tx, actor, workspaceId, artifact: { kind: "WorkflowJobInput", id: job.id }, content: job,
      origin: "DERIVED", inputs: [], inheritedRoots: [root] });
  });
});

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
  invariant(actor.kind === "user", 403, "SOURCE_RESTRICTED", "External provider selection requires its native owner.");
  await requireWorkspaceMembership({ actor, workspaceId: params.workspaceId });
  const providerKey = validateProviderKey(params.providerKey);
  const sourceKind = validateSourceKind(params.sourceKind);
  const externalId = cleanText(params.externalId, 240);
  invariant(externalId, 400, "INVALID_INPUT", "External source ID is required.");
  const connection = await requireSelectableBoxConnection(actor, params.workspaceId, params.connectionId);
  const title = cleanText(params.title, 240) || `${sourceKindLabel(sourceKind)} ${externalId}`;
  const externalUrl = cleanText(params.externalUrl, 2000) || boxExternalContentUrl(sourceKind, externalId);

  return prisma.$transaction(async (tx) => {
    const prior = await tx.externalContentSource.findUnique({ where: { workspaceId_providerKey_sourceKind_externalId: {
      workspaceId: params.workspaceId, providerKey, sourceKind, externalId } } });
    if (prior) {
      invariant(prior.selectedByUserId === actor.user.id, 403, "SOURCE_RESTRICTED", "This selection belongs to another provider principal.");
      await tx.$queryRaw`SELECT "id" FROM "ExternalContentSource" WHERE "id" = ${prior.id} AND "workspaceId" = ${params.workspaceId} FOR UPDATE`;
      await preserveUnknownArtifactInputSnapshot(tx, params.workspaceId, { kind: "ExternalContentSource", id: prior.id }, prior);
    }
    const data = { connectionId: connection.id, selectedByUserId: actorUserId(actor), title, externalUrl, syncMode: "SELECTED",
      status: "SYNCING" as const, lastRemoteVersion: null, lastSyncedAt: null, lastSyncError: null, archivedAt: null, archivedByUserId: null, archiveReason: null,
      metadata: params.metadata ? toJsonObject(params.metadata) : Prisma.DbNull };
    const created = prior ? await tx.externalContentSource.update({ where: { id: prior.id }, data })
      : await tx.externalContentSource.create({ data: { id: randomUUID(), workspaceId: params.workspaceId, providerKey, sourceKind, externalId, ...data } });
    await assertExternalProviderActorCurrent(actor, params.workspaceId, connection.id, tx);
    await recordArtifactInputLineage({ tx, actor, workspaceId: params.workspaceId, artifact: { kind: "ExternalContentSource", id: created.id },
      content: created, origin: "HUMAN_ORIGINAL", inputs: [] });
    const recipe = await captureImmutableArtifactInputProof(actor, params.workspaceId,
      await captureArtifactInputProof(actor, params.workspaceId, [{ kind: "ExternalContentSource", id: created.id, snapshot: created }], tx), tx);
    invariant(recipe.length === 1, 409, "UNKNOWN_LINEAGE", "External content selection needs one complete immutable recipe.");
    const source = await tx.externalContentSource.update({ where: { id: created.id }, data: {
      metadata: toJsonObject({ ...existingMetadata(created.metadata), selectionInputRoot: recipe[0] }) }, select: externalContentSourceSelect });
    await recordArtifactInputLineage({ tx, actor, workspaceId: params.workspaceId, artifact: { kind: "ExternalContentSource", id: source.id },
      content: source, origin: "DERIVED", inputs: [], inheritedRoots: recipe });
    await enqueueScopedSync(tx, actor, source, recipe[0]);
    await recordAudit(tx, actor, { workspaceId: params.workspaceId, action: "external-content-source.selected",
      entityType: "ExternalContentSource", entityId: source.id, meta: { providerKey, sourceKind, externalId, connectionId: connection.id } });
    return source;
  });
}

export async function enqueueExternalContentSourceSync(actor: AppActor, params: {
  workspaceId: string;
  sourceId: string;
}) {
  await requireWorkspaceMembership({ actor, workspaceId: params.workspaceId });
  return prisma.$transaction(async (tx) => {
    const source = await tx.externalContentSource.findFirst({ where: { id: params.sourceId, workspaceId: params.workspaceId,
      archivedAt: null, status: { not: "ARCHIVED" } }, select: externalContentSourceSelect });
    invariant(source && await isExternalProviderSelectionCurrent(actor, params.workspaceId, source, tx),
      404, "NOT_FOUND", "External content source not found.");
    const root = await originalSelectionRoot(tx, source);
    invariant(root && await isArtifactInputProofReadable(actor, params.workspaceId, [root], tx),
      409, "UNKNOWN_LINEAGE", "External content selection has no complete original recipe.");
    await enqueueScopedSync(tx, actor, source, root);
    await recordAudit(tx, actor, { workspaceId: params.workspaceId, action: "external-content-source.sync_requested",
      entityType: "ExternalContentSource", entityId: source.id, meta: { providerKey: source.providerKey, sourceKind: source.sourceKind, externalId: source.externalId } });
    return { sourceId: source.id, status: "QUEUED" as const };
  });
}

async function hasCompletedExternalContentCopy(source: ExternalContentSyncSourceRecord, recipe: LineageRoot, hashes: string[]) {
  const syncLogId = asString(asRecord(source.metadata).externalContentSyncLogId);
  if (!syncLogId) return false;
  const completed = await prisma.externalContentSyncLog.findFirst({ where: {
    id: syncLogId, workspaceId: source.workspaceId, sourceId: source.id, status: "SYNCED", completedAt: { not: null },
  }, select: { brainSourceId: true } });
  if (!completed?.brainSourceId) return false;
  const copy = await prisma.brainSource.findFirst({ where: { id: completed.brainSourceId, workspaceId: source.workspaceId,
    sourceType: "EXTERNAL_CONTENT", archivedAt: null }, select: { metadata: true } });
  const metadata = asRecord(copy?.metadata);
  return metadata.externalContentSyncLogId === syncLogId
    && stableJson(metadata.fetchResponseHashes) === stableJson(hashes)
    && stableJson(metadata.selectionInputRoot) === stableJson(recipe);
}

export async function syncExternalContentSource(params: {
  workspaceId: string;
  sourceId: string;
  workflowJobId?: string | null;
  syncKnowledge: (input: ExternalContentKnowledgeInput) => Promise<number | void>;
}) {
  invariant(params.workflowJobId, 409, "UNKNOWN_LINEAGE", "External content sync requires its scoped workflow job.");
  let recipe!: LineageRoot;
  let jobRoots: LineageRoot[] = [];
  const actor = await createExternalProviderSyncActor({ workspaceId: params.workspaceId, sourceId: params.sourceId,
    workflowJobId: params.workflowJobId, validateInputs: async (purposeActor, db, selected, job) => {
      const root = await originalSelectionRoot(db, selected);
      if (!root) return false;
      recipe = root;
      if (!await isArtifactInputProofReadable(purposeActor, params.workspaceId, [root], db)) return false;
      jobRoots = await captureArtifactInputProof(purposeActor, params.workspaceId, [{ kind: "WorkflowJobInput", id: String(job.id), snapshot: job }], db);
      return true;
    } });
  const source = await prisma.externalContentSource.findFirst({ where: { id: params.sourceId, workspaceId: params.workspaceId, archivedAt: null } });
  invariant(source && source.connectionId, 404, "NOT_FOUND", "External content selection not found.");
  const original = await prisma.artifactInputSnapshot.findFirst({ where: { id: recipe.id, workspaceId: params.workspaceId } });
  invariant(original, 409, "UNKNOWN_LINEAGE", "External content recipe is missing.");
  const originalContent = asRecord(original.contentJson);
  const sourceRecipe = { ...source, title: asString(originalContent.title), externalUrl: asString(originalContent.externalUrl) || null,
    metadata: originalContent.metadata as Prisma.JsonValue | null };
  const log = await prisma.externalContentSyncLog.create({ data: { workspaceId: params.workspaceId, sourceId: source.id,
    workflowJobId: params.workflowJobId, status: "RUNNING" } });
  try {
    const materialized = await fetchBoxMaterializedContent(actor, sourceRecipe);
    await Promise.all(materialized.receipts.map(assertExternalProviderCapturedResponseCurrent));
    const fetchRoots = await captureArtifactInputProof(actor, params.workspaceId,
      materialized.receipts.map(receipt => ({ kind: "ExternalProviderFetchInput", id: receipt.input.id, snapshot: receipt.input })));
    const roots = [recipe, ...jobRoots, ...fetchRoots];
    const hashes = materialized.receipts.map(receipt => receipt.input.responseHash);
    // Matching copied bytes are not proof of completed indexing. Bind the shortcut
    // to this copy's successful log, never an older success for the same source.
    if (stableJson(asRecord(source.metadata).fetchResponseHashes) === stableJson(hashes)
      && await hasCompletedExternalContentCopy(source, recipe, hashes)
      && await isArtifactInputProofReadable(actor, params.workspaceId, [
        { kind: "ExternalContentSource", id: source.id, fingerprint: lineageContentFingerprint("ExternalContentSource", source) }, ...roots])) {
      await assertExternalProviderActorCurrent(actor, params.workspaceId, source.connectionId);
      await prisma.externalContentSyncLog.update({ where: { id: log.id }, data: { status: "UNCHANGED",
        remoteVersion: materialized.remoteVersion, chunksCreated: 0, completedAt: new Date() } });
      return { status: "UNCHANGED", sourceId: source.id, remoteVersion: materialized.remoteVersion, chunksCreated: 0 };
    }
    const metadata = { ...asRecord(originalContent.metadata), ...materialized.metadata, providerKey: source.providerKey,
      sourceKind: source.sourceKind, externalId: source.externalId, externalUrl: materialized.externalUrl,
      remoteVersion: materialized.remoteVersion, externalContentSourceId: source.id, snapshotType: "box_synced_snapshot",
      selectionInputRoot: recipe, fetchResponseHashes: hashes, materializedContent: materialized.content,
      externalContentSyncLogId: log.id };
    const preflight = await prepareExternalProviderCommitPreflight(actor, params.workspaceId, { roots, receipts: materialized.receipts });
    const written = await prisma.$transaction(async tx => withExternalProviderCommitPreflight(actor, params.workspaceId, tx, preflight, async () => {
      await tx.$queryRaw`SELECT "id" FROM "ExternalContentSource" WHERE "id" = ${source.id} AND "workspaceId" = ${params.workspaceId} FOR UPDATE`;
      await assertArtifactInputWriteFence(tx);
      await assertExternalProviderActorCurrent(actor, params.workspaceId, source.connectionId!, tx);
      invariant(await isArtifactInputProofReadable(actor, params.workspaceId, roots, tx),
        409, "SOURCE_CHANGED", "External provider inputs changed before copying.");
      const prior = await tx.externalContentSource.findFirst({ where: { id: source.id, workspaceId: params.workspaceId } });
      invariant(prior && lineageContentFingerprint("ExternalContentSource", prior) === lineageContentFingerprint("ExternalContentSource", source),
        409, "SOURCE_CHANGED", "External content selection changed before copying.");
      await preserveUnknownArtifactInputSnapshot(tx, params.workspaceId, { kind: "ExternalContentSource", id: prior.id }, prior);
      const current = await tx.externalContentSource.update({ where: { id: source.id }, data: { status: "ACTIVE", title: materialized.title,
        externalUrl: materialized.externalUrl, lastRemoteVersion: materialized.remoteVersion, lastSyncedAt: new Date(),
        lastSyncError: null, metadata: toJsonObject(metadata) } });
      await recordArtifactInputLineage({ tx, actor, workspaceId: params.workspaceId, artifact: { kind: "ExternalContentSource", id: current.id },
        content: current, origin: "DERIVED", inputs: [], inheritedRoots: roots });
      const brainSource = await tx.brainSource.create({ data: { workspaceId: params.workspaceId, sourceType: "EXTERNAL_CONTENT", tier: 2,
        title: materialized.title, content: materialized.content,
        externalId: `box:${source.sourceKind.toLowerCase()}:${source.externalId}:${hashPayload(hashes)}`, channel: "box", metadata: toJsonObject(metadata) } });
      await recordArtifactInputLineage({ tx, actor, workspaceId: params.workspaceId, artifact: { kind: "BrainSource", id: brainSource.id },
        content: brainSource, origin: "DERIVED", inputs: [{ kind: "ExternalContentSource", id: current.id }], inheritedRoots: roots });
      await recordAudit(tx, actor, { workspaceId: params.workspaceId, action: "brain-source.created", entityType: "BrainSource", entityId: brainSource.id,
        meta: { sourceType: "EXTERNAL_CONTENT", tier: 2, externalContentSourceId: source.id, providerKey: source.providerKey } });
      await appendEvents(tx, [{ workspaceId: params.workspaceId, type: "brain-source.created", aggregateType: "BrainSource", aggregateId: brainSource.id,
        payload: { sourceId: brainSource.id } }]);
      await tx.externalContentSyncLog.update({ where: { id: log.id }, data: { status: "COPIED", remoteVersion: materialized.remoteVersion, brainSourceId: brainSource.id } });
      return { current, brainSource };
    }));
    invariant(await isArtifactInputProofReadable(actor, params.workspaceId, [{ kind: "ExternalContentSource", id: written.current.id,
      fingerprint: lineageContentFingerprint("ExternalContentSource", written.current) }]),
    409, "SOURCE_CHANGED", "External provider inputs changed before indexing.");
    const chunksCreated = await params.syncKnowledge({ workspaceId: params.workspaceId, sourceType: "EXTERNAL_CONTENT", sourceId: written.current.id,
      sourceTitle: written.current.title, content: materialized.content, metadata, lineageActor: actor, workflowJobId: params.workflowJobId }) ?? 0;
    invariant(await isArtifactInputProofReadable(actor, params.workspaceId, [{ kind: "ExternalContentSource", id: written.current.id,
      fingerprint: lineageContentFingerprint("ExternalContentSource", written.current) }]), 409, "SOURCE_CHANGED", "External provider inputs changed during indexing.");
    await assertExternalProviderActorCurrent(actor, params.workspaceId, source.connectionId);
    await prisma.externalContentSyncLog.update({ where: { id: log.id }, data: { status: "SYNCED", chunksCreated, completedAt: new Date() } });
    return { status: "SYNCED", sourceId: source.id, remoteVersion: materialized.remoteVersion, chunksCreated, brainSourceId: written.brainSource.id };
  } catch (error) {
    await failExternalContentSync({ workspaceId: params.workspaceId, sourceId: source.id, syncLogId: log.id, error });
    if (error instanceof AppError) throw error;
    throw new AppError(502, "EXTERNAL_CONTENT_SYNC_FAILED", "External content synchronization failed.");
  }
}
