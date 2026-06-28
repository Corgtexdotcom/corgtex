import { createHash } from "node:crypto";
import type { Prisma } from "@prisma/client";
import type { AppActor } from "@corgtex/shared";
import { prisma } from "@corgtex/shared";
import { recordAudit } from "./audit-trail";
import { requireWorkspaceMembership } from "./auth";
import { AppError, invariant } from "./errors";
import { callBoxExternalMcpReadTool, getExternalMcpConnectionAccessToken } from "./external-mcp";

export const WORKSPACE_EXTERNAL_RESOURCE_ENTITY_TYPES = ["Action", "Tension", "Proposal", "Meeting", "BrainSource"] as const;
export const WORKSPACE_EXTERNAL_RESOURCE_PURPOSES = ["reference", "completion_evidence", "resolution_evidence", "feedback_context"] as const;

export type WorkspaceExternalResourceEntityType = (typeof WORKSPACE_EXTERNAL_RESOURCE_ENTITY_TYPES)[number];
export type WorkspaceExternalResourcePurpose = (typeof WORKSPACE_EXTERNAL_RESOURCE_PURPOSES)[number];

const externalResourceSelect = {
  id: true,
  workspaceId: true,
  createdByUserId: true,
  providerKey: true,
  externalId: true,
  resourceType: true,
  title: true,
  url: true,
  sharedLinkUrl: true,
  mimeType: true,
  descriptionMd: true,
  summaryMd: true,
  metadata: true,
  lastEnrichedAt: true,
  lastEnrichmentError: true,
  archivedAt: true,
  archiveReason: true,
  createdAt: true,
  updatedAt: true,
} satisfies Prisma.WorkspaceExternalResourceSelect;

const externalResourceAttachmentSelect = {
  id: true,
  workspaceId: true,
  resourceId: true,
  entityType: true,
  entityId: true,
  purpose: true,
  createdByUserId: true,
  createdAt: true,
  resource: { select: externalResourceSelect },
} satisfies Prisma.WorkspaceExternalResourceAttachmentSelect;

type ExternalResourceRecord = Prisma.WorkspaceExternalResourceGetPayload<{ select: typeof externalResourceSelect }>;

function actorUserId(actor: AppActor) {
  return actor.kind === "user" ? actor.user.id : null;
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function asString(value: unknown) {
  return typeof value === "string" ? value : "";
}

function validatePurpose(value?: string | null): WorkspaceExternalResourcePurpose {
  const purpose = value?.trim() || "reference";
  invariant((WORKSPACE_EXTERNAL_RESOURCE_PURPOSES as readonly string[]).includes(purpose), 400, "INVALID_INPUT", "Unsupported external resource purpose.");
  return purpose as WorkspaceExternalResourcePurpose;
}

function validateEntityType(value: string): WorkspaceExternalResourceEntityType {
  invariant((WORKSPACE_EXTERNAL_RESOURCE_ENTITY_TYPES as readonly string[]).includes(value), 400, "INVALID_INPUT", "Unsupported external resource target.");
  return value as WorkspaceExternalResourceEntityType;
}

function normalizeBoxUrl(rawUrl: string) {
  const trimmed = rawUrl.trim();
  invariant(trimmed.length > 0, 400, "INVALID_INPUT", "Box URL is required.");
  let url: URL;
  try {
    url = new URL(trimmed);
  } catch {
    throw new AppError(400, "INVALID_INPUT", "Box URL is not valid.");
  }
  const host = url.hostname.toLowerCase();
  invariant(host === "box.com" || host.endsWith(".box.com"), 400, "INVALID_INPUT", "Only Box links can be saved as Box resources.");
  url.hash = "";
  return url.toString();
}

function fallbackExternalId(url: string) {
  return `url:${createHash("sha256").update(url).digest("hex").slice(0, 32)}`;
}

function parseBoxAppItem(url: string) {
  const parsed = new URL(url);
  const segments = parsed.pathname.split("/").filter(Boolean);
  const fileIndex = segments.findIndex((segment) => segment === "file" || segment === "files");
  if (fileIndex >= 0 && segments[fileIndex + 1]) {
    return { type: "file", id: segments[fileIndex + 1] };
  }
  const folderIndex = segments.findIndex((segment) => segment === "folder" || segment === "folders");
  if (folderIndex >= 0 && segments[folderIndex + 1]) {
    return { type: "folder", id: segments[folderIndex + 1] };
  }
  return null;
}

function boxFields() {
  return [
    "id",
    "type",
    "name",
    "description",
    "modified_at",
    "size",
    "extension",
    "sha1",
    "shared_link",
    "permissions",
    "parent",
    "path_collection",
    "owned_by",
    "file_version",
    "etag",
  ].join(",");
}

async function boxApiJson(accessToken: string, url: string, headers?: Record<string, string>) {
  const response = await fetch(url, {
    headers: {
      Authorization: `Bearer ${accessToken}`,
      ...(headers ?? {}),
    },
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) {
    const message = asString(asRecord(data).message) || asString(asRecord(data).error) || `Box API returned HTTP ${response.status}.`;
    throw new AppError(response.status, "BOX_API_ERROR", message);
  }
  return data;
}

async function resolveBoxItem(accessToken: string, url: string) {
  const fields = boxFields();
  try {
    return await boxApiJson(
      accessToken,
      `https://api.box.com/2.0/shared_items?fields=${encodeURIComponent(fields)}`,
      { boxapi: `shared_link=${url}` },
    );
  } catch (error) {
    const direct = parseBoxAppItem(url);
    if (!direct) throw error;
    const endpoint = direct.type === "folder" ? "folders" : "files";
    return boxApiJson(accessToken, `https://api.box.com/2.0/${endpoint}/${encodeURIComponent(direct.id)}?fields=${encodeURIComponent(fields)}`);
  }
}

function itemUrl(item: Record<string, unknown>, originalUrl: string) {
  const sharedLink = asRecord(item.shared_link);
  const sharedUrl = asString(sharedLink.url);
  if (sharedUrl) return sharedUrl;
  const type = asString(item.type);
  const id = asString(item.id);
  if (type === "folder" && id) return `https://app.box.com/folder/${encodeURIComponent(id)}`;
  if (type === "web_link" && id) return `https://app.box.com/web_link/${encodeURIComponent(id)}`;
  if (id) return `https://app.box.com/file/${encodeURIComponent(id)}`;
  return originalUrl;
}

function itemMimeType(item: Record<string, unknown>) {
  const extension = asString(item.extension);
  if (!extension) return null;
  return `application/x-box-${extension.toLowerCase()}`;
}

function summaryFromPayload(payload: unknown) {
  const record = asRecord(payload);
  const candidates = [
    record.answer,
    record.text,
    record.content,
    record.result,
    record.response,
    record.message,
  ];
  for (const candidate of candidates) {
    const text = asString(candidate).trim();
    if (text) return text.slice(0, 4000);
  }
  return null;
}

async function summarizeBoxItem(actor: AppActor, workspaceId: string, item: Record<string, unknown>) {
  if (asString(item.type) !== "file" || !asString(item.id)) {
    return { summaryMd: null, error: null };
  }
  try {
    const payload = await callBoxExternalMcpReadTool(actor, {
      workspaceId,
      toolName: "ai_qa_single_file",
      arguments: {
        file_id: asString(item.id),
        question: "Summarize this file for a workspace knowledge index in 3 concise sentences. Include what the file is for and when someone should open it in Box.",
      },
    });
    return { summaryMd: summaryFromPayload(payload), error: null };
  } catch (error) {
    return {
      summaryMd: null,
      error: error instanceof Error ? error.message : "Box AI summary failed.",
    };
  }
}

async function assertAttachTarget(tx: Prisma.TransactionClient, workspaceId: string, entityType: WorkspaceExternalResourceEntityType, entityId: string) {
  let found: { id: string } | null = null;
  if (entityType === "Action") {
    found = await tx.action.findFirst({ where: { id: entityId, workspaceId, archivedAt: null }, select: { id: true } });
  } else if (entityType === "Tension") {
    found = await tx.tension.findFirst({ where: { id: entityId, workspaceId, archivedAt: null }, select: { id: true } });
  } else if (entityType === "Proposal") {
    found = await tx.proposal.findFirst({ where: { id: entityId, workspaceId, archivedAt: null }, select: { id: true } });
  } else if (entityType === "Meeting") {
    found = await tx.meeting.findFirst({ where: { id: entityId, workspaceId, archivedAt: null }, select: { id: true } });
  } else if (entityType === "BrainSource") {
    found = await tx.brainSource.findFirst({ where: { id: entityId, workspaceId, archivedAt: null }, select: { id: true } });
  }
  invariant(found, 404, "NOT_FOUND", "External resource target not found.");
}

function resourceKnowledgeContent(resource: ExternalResourceRecord) {
  return [
    resource.title,
    `Provider: ${resource.providerKey}`,
    `Type: ${resource.resourceType}`,
    resource.summaryMd ? `Summary:\n${resource.summaryMd}` : null,
    resource.descriptionMd ? `Description:\n${resource.descriptionMd}` : null,
    `Open in Box: ${resource.url}`,
  ].filter(Boolean).join("\n\n");
}

async function enqueueExternalResourceKnowledgeSync(tx: Prisma.TransactionClient, resource: ExternalResourceRecord) {
  if (!resource.summaryMd?.trim() && !resource.descriptionMd?.trim()) return;
  const dedupeKey = `external-resource:${resource.id}:knowledge:${Date.now()}`;
  await tx.workflowJob.upsert({
    where: { dedupeKey },
    update: {},
    create: {
      workspaceId: resource.workspaceId,
      eventId: null,
      type: "knowledge.sync.external-resource",
      payload: { resourceId: resource.id },
      dedupeKey,
    },
  });
}

export async function externalResourceKnowledgeInput(resourceId: string, workspaceId: string) {
  const resource = await prisma.workspaceExternalResource.findFirst({
    where: { id: resourceId, workspaceId, archivedAt: null },
    select: externalResourceSelect,
  });
  if (!resource) return null;
  const content = resourceKnowledgeContent(resource);
  if (!content.trim()) return null;
  return {
    workspaceId,
    sourceType: "EXTERNAL_RESOURCE" as const,
    sourceId: resource.id,
    sourceTitle: resource.title,
    content,
    metadata: {
      providerKey: resource.providerKey,
      externalId: resource.externalId,
      resourceType: resource.resourceType,
      url: resource.url,
      sharedLinkUrl: resource.sharedLinkUrl,
    },
  };
}

export async function upsertWorkspaceExternalResourceFromUrl(actor: AppActor, params: {
  workspaceId: string;
  url: string;
  descriptionMd?: string | null;
  summaryMd?: string | null;
  entityType?: WorkspaceExternalResourceEntityType | null;
  entityId?: string | null;
  purpose?: WorkspaceExternalResourcePurpose | string | null;
}) {
  await requireWorkspaceMembership({ actor, workspaceId: params.workspaceId });
  invariant(actor.kind === "user", 403, "FORBIDDEN", "Box resources use same-user delegated OAuth. Sign in as a user to save Box links.");
  const normalizedUrl = normalizeBoxUrl(params.url);
  const { accessToken } = await getExternalMcpConnectionAccessToken(actor, {
    workspaceId: params.workspaceId,
    providerKey: "box",
  });
  const item = asRecord(await resolveBoxItem(accessToken, normalizedUrl));
  const resourceType = asString(item.type) || parseBoxAppItem(normalizedUrl)?.type || "link";
  const boxId = asString(item.id);
  const externalId = boxId ? `${resourceType}:${boxId}` : fallbackExternalId(normalizedUrl);
  const sharedLink = asRecord(item.shared_link);
  const sharedLinkUrl = asString(sharedLink.url) || normalizedUrl;
  const explicitSummary = params.summaryMd?.trim() || null;
  const summary = explicitSummary ? { summaryMd: explicitSummary, error: null } : await summarizeBoxItem(actor, params.workspaceId, item);
  const descriptionMd = params.descriptionMd?.trim() || asString(item.description).trim() || null;
  const title = asString(item.name) || normalizedUrl;
  const url = itemUrl(item, normalizedUrl);
  const purpose = validatePurpose(params.purpose);
  const entityType = params.entityType ? validateEntityType(params.entityType) : null;
  const entityId = params.entityId?.trim() || null;
  invariant(!entityType || entityId, 400, "INVALID_INPUT", "External resource target ID is required.");

  return prisma.$transaction(async (tx) => {
    if (entityType && entityId) {
      await assertAttachTarget(tx, params.workspaceId, entityType, entityId);
    }

    const resource = await tx.workspaceExternalResource.upsert({
      where: {
        workspaceId_providerKey_externalId: {
          workspaceId: params.workspaceId,
          providerKey: "box",
          externalId,
        },
      },
      update: {
        title,
        resourceType,
        url,
        sharedLinkUrl,
        mimeType: itemMimeType(item),
        descriptionMd,
        summaryMd: summary.summaryMd,
        metadata: {
          box: {
            id: boxId || null,
            type: resourceType,
            etag: asString(item.etag) || null,
            modifiedAt: asString(item.modified_at) || null,
            size: typeof item.size === "number" ? item.size : null,
            extension: asString(item.extension) || null,
            owner: asString(asRecord(item.owned_by).login) || asString(asRecord(item.owned_by).name) || null,
          },
          sourceUrl: normalizedUrl,
        } satisfies Prisma.InputJsonObject,
        lastEnrichedAt: new Date(),
        lastEnrichmentError: summary.error,
        archivedAt: null,
        archiveReason: null,
      },
      create: {
        workspaceId: params.workspaceId,
        createdByUserId: actor.user.id,
        providerKey: "box",
        externalId,
        resourceType,
        title,
        url,
        sharedLinkUrl,
        mimeType: itemMimeType(item),
        descriptionMd,
        summaryMd: summary.summaryMd,
        metadata: {
          box: {
            id: boxId || null,
            type: resourceType,
            etag: asString(item.etag) || null,
            modifiedAt: asString(item.modified_at) || null,
            size: typeof item.size === "number" ? item.size : null,
            extension: asString(item.extension) || null,
            owner: asString(asRecord(item.owned_by).login) || asString(asRecord(item.owned_by).name) || null,
          },
          sourceUrl: normalizedUrl,
        } satisfies Prisma.InputJsonObject,
        lastEnrichedAt: new Date(),
        lastEnrichmentError: summary.error,
      },
      select: externalResourceSelect,
    });

    if (entityType && entityId) {
      await tx.workspaceExternalResourceAttachment.createMany({
        data: [{
          workspaceId: params.workspaceId,
          resourceId: resource.id,
          entityType,
          entityId,
          purpose,
          createdByUserId: actor.user.id,
        }],
        skipDuplicates: true,
      });
      await recordAudit(tx, actor, {
        workspaceId: params.workspaceId,
        action: "external-resource.attached",
        entityType: "WorkspaceExternalResource",
        entityId: resource.id,
        meta: { providerKey: "box", targetType: entityType, targetId: entityId, purpose },
      });
    }

    await recordAudit(tx, actor, {
      workspaceId: params.workspaceId,
      action: "external-resource.saved",
      entityType: "WorkspaceExternalResource",
      entityId: resource.id,
      meta: { providerKey: "box", externalId: resource.externalId, resourceType: resource.resourceType },
    });
    await enqueueExternalResourceKnowledgeSync(tx, resource);
    return resource;
  });
}

export async function listWorkspaceExternalResources(actor: AppActor, params: {
  workspaceId: string;
  providerKey?: string | null;
  query?: string | null;
  take?: number;
}) {
  await requireWorkspaceMembership({ actor, workspaceId: params.workspaceId });
  const query = params.query?.trim();
  return prisma.workspaceExternalResource.findMany({
    where: {
      workspaceId: params.workspaceId,
      archivedAt: null,
      ...(params.providerKey ? { providerKey: params.providerKey } : {}),
      ...(query ? {
        OR: [
          { title: { contains: query, mode: "insensitive" } },
          { descriptionMd: { contains: query, mode: "insensitive" } },
          { summaryMd: { contains: query, mode: "insensitive" } },
          { url: { contains: query, mode: "insensitive" } },
        ],
      } : {}),
    },
    orderBy: [{ updatedAt: "desc" }, { createdAt: "desc" }],
    take: Math.max(1, Math.min(params.take ?? 50, 100)),
    select: externalResourceSelect,
  });
}

export async function listExternalResourceAttachments(actor: AppActor, params: {
  workspaceId: string;
  entityType: WorkspaceExternalResourceEntityType;
  entityId: string;
}) {
  await requireWorkspaceMembership({ actor, workspaceId: params.workspaceId });
  const entityType = validateEntityType(params.entityType);
  return prisma.workspaceExternalResourceAttachment.findMany({
    where: {
      workspaceId: params.workspaceId,
      entityType,
      entityId: params.entityId,
      resource: { archivedAt: null },
    },
    orderBy: { createdAt: "desc" },
    select: externalResourceAttachmentSelect,
  });
}

export async function archiveWorkspaceExternalResource(actor: AppActor, params: {
  workspaceId: string;
  resourceId: string;
  reason?: string | null;
}) {
  await requireWorkspaceMembership({ actor, workspaceId: params.workspaceId });
  const resource = await prisma.workspaceExternalResource.findFirst({
    where: { id: params.resourceId, workspaceId: params.workspaceId, archivedAt: null },
    select: { id: true },
  });
  invariant(resource, 404, "NOT_FOUND", "External resource not found.");
  await prisma.$transaction(async (tx) => {
    await tx.workspaceExternalResource.update({
      where: { id: params.resourceId },
      data: {
        archivedAt: new Date(),
        archivedByUserId: actorUserId(actor),
        archiveReason: params.reason?.trim() || "Archived from external resource library.",
      },
    });
    await tx.knowledgeChunk.deleteMany({
      where: { workspaceId: params.workspaceId, sourceType: "EXTERNAL_RESOURCE", sourceId: params.resourceId },
    });
    await recordAudit(tx, actor, {
      workspaceId: params.workspaceId,
      action: "external-resource.archived",
      entityType: "WorkspaceExternalResource",
      entityId: params.resourceId,
      meta: { reason: params.reason ?? null },
    });
  });
  return { id: params.resourceId };
}
