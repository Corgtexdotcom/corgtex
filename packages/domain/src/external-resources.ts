import { createHash } from "node:crypto";
import type { CommunicationProvider, Prisma } from "@prisma/client";
import type { AppActor } from "@corgtex/shared";
import { prisma } from "@corgtex/shared";
import { recordAudit } from "./audit-trail";
import { requireWorkspaceMembership } from "./auth";
import { AppError, invariant } from "./errors";

export const WORKSPACE_EXTERNAL_RESOURCE_ENTITY_TYPES = ["Action", "Tension", "Proposal", "Meeting", "BrainSource"] as const;
export const WORKSPACE_EXTERNAL_RESOURCE_PURPOSES = ["reference", "completion_evidence", "resolution_evidence", "feedback_context"] as const;
export const EXTERNAL_RESOURCE_SOURCE_TYPES = ["SLACK_MESSAGE"] as const;

export type WorkspaceExternalResourceEntityType = (typeof WORKSPACE_EXTERNAL_RESOURCE_ENTITY_TYPES)[number];
export type WorkspaceExternalResourcePurpose = (typeof WORKSPACE_EXTERNAL_RESOURCE_PURPOSES)[number];
export type ExternalResourceSourceType = (typeof EXTERNAL_RESOURCE_SOURCE_TYPES)[number];
export type ExternalResourceProviderKey = "box" | "dropbox" | "google_drive" | "notion" | "generic_url";
export type ExternalResourceCategory = "FILES" | "KNOWLEDGE" | "LINK";

type NormalizedUrl = {
  url: URL;
  canonicalUrl: string;
  host: string;
};

export type ExtractedExternalReference = {
  url: string;
  label: string | null;
  sourceText: string | null;
};

export type ExternalResourceClassification = {
  providerKey: ExternalResourceProviderKey;
  externalId: string;
  resourceType: string;
  category: ExternalResourceCategory;
  priority: number;
  title: string;
  url: string;
  sharedLinkUrl: string | null;
  mimeType: string | null;
  metadata: Prisma.InputJsonObject;
};

type ResourceProviderAdapter = {
  providerKey: ExternalResourceProviderKey;
  matches: (url: URL) => boolean;
  classify: (input: NormalizedUrl, label: string | null) => Omit<ExternalResourceClassification, "providerKey" | "url" | "metadata">;
};

const externalResourceSelect = {
  id: true,
  workspaceId: true,
  createdByUserId: true,
  providerKey: true,
  externalId: true,
  resourceType: true,
  category: true,
  priority: true,
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

const externalResourceMentionListSelect = {
  id: true,
  sourceType: true,
  sourceProvider: true,
  sourceExternalId: true,
  sourcePermalink: true,
  sourceLabel: true,
  sourceText: true,
  mentionedAt: true,
  redactedAt: true,
  createdAt: true,
  communicationMessage: {
    select: {
      installationId: true,
      provider: true,
      externalUserId: true,
      externalChannelId: true,
      messageTs: true,
    },
  },
} satisfies Prisma.WorkspaceExternalResourceMentionSelect;

const externalResourceListSelect = {
  ...externalResourceSelect,
  createdBy: {
    select: {
      id: true,
      email: true,
      displayName: true,
    },
  },
  mentions: {
    where: { redactedAt: null },
    orderBy: [{ mentionedAt: "desc" as const }, { createdAt: "desc" as const }],
    take: 5,
    select: externalResourceMentionListSelect,
  },
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
type ExternalResourceListRecord = Prisma.WorkspaceExternalResourceGetPayload<{ select: typeof externalResourceListSelect }>;
type ExternalResourceKnowledgeRecord = ExternalResourceRecord & {
  mentions?: Array<{
    sourceType: string;
    sourceProvider: string | null;
    sourceLabel: string | null;
    sourceText: string | null;
    mentionedAt: Date | null;
    redactedAt: Date | null;
  }>;
};

const TRACKING_PARAMS = new Set([
  "utm_source",
  "utm_medium",
  "utm_campaign",
  "utm_term",
  "utm_content",
  "fbclid",
  "gclid",
  "msclkid",
]);

function actorUserId(actor: AppActor) {
  return actor.kind === "user" ? actor.user.id : null;
}

function cleanText(value?: string | null, maxLength = 4000) {
  const trimmed = value?.replace(/\s+/g, " ").trim() ?? "";
  return trimmed ? trimmed.slice(0, maxLength) : null;
}

function hashValue(value: string) {
  return createHash("sha256").update(value).digest("hex").slice(0, 32);
}

function communicationUserKey(installationId: string, externalUserId: string) {
  return `${installationId}:${externalUserId}`;
}

function communicationChannelKey(installationId: string, externalChannelId: string) {
  return `${installationId}:${externalChannelId}`;
}

function fallbackExternalId(url: string) {
  return `url:${hashValue(url)}`;
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

function normalizeExternalUrl(rawUrl: string): NormalizedUrl {
  const trimmed = rawUrl.trim().replace(/&amp;/g, "&");
  invariant(trimmed.length > 0, 400, "INVALID_INPUT", "External resource URL is required.");

  let url: URL;
  try {
    url = new URL(trimmed);
  } catch {
    throw new AppError(400, "INVALID_INPUT", "External resource URL is not valid.");
  }

  invariant(url.protocol === "https:" || url.protocol === "http:", 400, "INVALID_INPUT", "External resource URL must use HTTP or HTTPS.");
  url.protocol = url.protocol.toLowerCase();
  url.hostname = url.hostname.toLowerCase();
  url.hash = "";

  for (const key of [...url.searchParams.keys()]) {
    if (TRACKING_PARAMS.has(key.toLowerCase())) {
      url.searchParams.delete(key);
    }
  }

  if (url.pathname.length > 1) {
    url.pathname = url.pathname.replace(/\/+$/, "");
  }

  return {
    url,
    canonicalUrl: url.toString(),
    host: url.hostname,
  };
}

function hostMatches(url: URL, domains: string[]) {
  const host = url.hostname.toLowerCase();
  return domains.some((domain) => host === domain || host.endsWith(`.${domain}`));
}

function lastPathLabel(url: URL) {
  const segment = url.pathname.split("/").filter(Boolean).at(-1);
  if (!segment) return null;
  try {
    return decodeURIComponent(segment).replace(/[-_]+/g, " ").trim() || null;
  } catch {
    return segment.replace(/[-_]+/g, " ").trim() || null;
  }
}

function displayHost(host: string) {
  return host.replace(/^www\./, "");
}

function titleFromLabelOrUrl(label: string | null, input: NormalizedUrl, fallback: string, options: { usePathLabel?: boolean } = {}) {
  const cleanedLabel = cleanText(label, 160);
  if (cleanedLabel && !cleanedLabel.startsWith("http://") && !cleanedLabel.startsWith("https://")) return cleanedLabel;
  if (options.usePathLabel === false) return fallback || displayHost(input.host);
  return lastPathLabel(input.url) || fallback || displayHost(input.host);
}

function parseBoxAppItem(url: URL) {
  const segments = url.pathname.split("/").filter(Boolean);
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

const providerAdapters: ResourceProviderAdapter[] = [
  {
    providerKey: "box",
    matches: (url) => hostMatches(url, ["box.com"]),
    classify: (input, label) => {
      const item = parseBoxAppItem(input.url);
      const resourceType = item?.type ?? "link";
      return {
        externalId: item ? `${item.type}:${item.id}` : fallbackExternalId(input.canonicalUrl),
        resourceType,
        category: "FILES",
        priority: 100,
        title: titleFromLabelOrUrl(label, input, resourceType === "folder" ? "Box folder" : resourceType === "file" ? "Box document" : "Box link", { usePathLabel: false }),
        sharedLinkUrl: input.canonicalUrl,
        mimeType: null,
      };
    },
  },
  {
    providerKey: "dropbox",
    matches: (url) => hostMatches(url, ["dropbox.com"]),
    classify: (input, label) => ({
      externalId: fallbackExternalId(input.canonicalUrl),
      resourceType: "link",
      category: "FILES",
      priority: 50,
      title: titleFromLabelOrUrl(label, input, "Dropbox link"),
      sharedLinkUrl: input.canonicalUrl,
      mimeType: null,
    }),
  },
  {
    providerKey: "google_drive",
    matches: (url) => hostMatches(url, ["drive.google.com", "docs.google.com"]),
    classify: (input, label) => ({
      externalId: fallbackExternalId(input.canonicalUrl),
      resourceType: "link",
      category: "FILES",
      priority: 50,
      title: titleFromLabelOrUrl(label, input, "Google Drive link"),
      sharedLinkUrl: input.canonicalUrl,
      mimeType: null,
    }),
  },
  {
    providerKey: "notion",
    matches: (url) => hostMatches(url, ["notion.so", "notion.site"]),
    classify: (input, label) => ({
      externalId: fallbackExternalId(input.canonicalUrl),
      resourceType: "page",
      category: "KNOWLEDGE",
      priority: 30,
      title: titleFromLabelOrUrl(label, input, "Notion page"),
      sharedLinkUrl: input.canonicalUrl,
      mimeType: null,
    }),
  },
  {
    providerKey: "generic_url",
    matches: () => true,
    classify: (input, label) => ({
      externalId: fallbackExternalId(input.canonicalUrl),
      resourceType: "link",
      category: "LINK",
      priority: 0,
      title: titleFromLabelOrUrl(label, input, displayHost(input.host)),
      sharedLinkUrl: input.canonicalUrl,
      mimeType: null,
    }),
  },
];

export function classifyExternalResourceUrl(rawUrl: string, label?: string | null): ExternalResourceClassification {
  const input = normalizeExternalUrl(rawUrl);
  const adapter = providerAdapters.find((candidate) => candidate.matches(input.url)) ?? providerAdapters[providerAdapters.length - 1];
  const classified = adapter.classify(input, label ?? null);
  return {
    providerKey: adapter.providerKey,
    ...classified,
    url: input.canonicalUrl,
    metadata: {
      canonicalUrl: input.canonicalUrl,
      host: input.host,
      providerKey: adapter.providerKey,
      category: classified.category,
      priority: classified.priority,
    },
  };
}

function trimBareUrl(rawUrl: string) {
  let value = rawUrl.trim();
  while (/[),.;!?]+$/.test(value)) {
    const next = value.slice(0, -1);
    if (value.endsWith(")") && (next.match(/\(/g)?.length ?? 0) > (next.match(/\)/g)?.length ?? 0)) break;
    value = next;
  }
  return value;
}

export function extractExternalResourceReferencesFromText(text?: string | null): ExtractedExternalReference[] {
  const sourceText = cleanText(text, 1200);
  if (!sourceText) return [];

  const references: ExtractedExternalReference[] = [];
  const seen = new Set<string>();
  const addReference = (url: string, label?: string | null) => {
    const trimmedUrl = trimBareUrl(url.replace(/&amp;/g, "&"));
    if (!trimmedUrl) return;
    try {
      const classified = classifyExternalResourceUrl(trimmedUrl, label ?? null);
      if (seen.has(classified.url)) return;
      seen.add(classified.url);
      references.push({
        url: classified.url,
        label: cleanText(label, 160),
        sourceText,
      });
    } catch {
      // Ignore malformed URLs during free-text extraction. Manual saves still validate strictly.
    }
  };

  const slackLinkPattern = /<((?:https?:\/\/)[^>|]+)(?:\|([^>]*))?>/g;
  const textWithoutSlackLinks = (text ?? "").replace(slackLinkPattern, (_match, url: string, label?: string) => {
    addReference(url, label);
    return " ";
  });

  const bareUrlPattern = /\bhttps?:\/\/[^\s<>"']+/g;
  for (const match of textWithoutSlackLinks.matchAll(bareUrlPattern)) {
    addReference(match[0], null);
  }

  return references;
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

function resourceKnowledgeContent(resource: ExternalResourceKnowledgeRecord) {
  const mentionLines = (resource.mentions ?? [])
    .filter((mention) => !mention.redactedAt)
    .map((mention) => [
      mention.sourceType,
      mention.sourceProvider ? `via ${mention.sourceProvider}` : null,
      mention.mentionedAt ? mention.mentionedAt.toISOString() : null,
      mention.sourceLabel ? `Label: ${mention.sourceLabel}` : null,
      mention.sourceText,
    ].filter(Boolean).join(" | "))
    .filter(Boolean);

  return [
    resource.title,
    `Provider: ${resource.providerKey}`,
    `Category: ${resource.category}`,
    `Type: ${resource.resourceType}`,
    `Priority: ${resource.priority}`,
    resource.summaryMd ? `Summary:\n${resource.summaryMd}` : null,
    resource.descriptionMd ? `Description:\n${resource.descriptionMd}` : null,
    mentionLines.length > 0 ? `Seen in:\n${mentionLines.map((line) => `- ${line}`).join("\n")}` : null,
    `Open resource: ${resource.url}`,
  ].filter(Boolean).join("\n\n");
}

async function enqueueExternalResourceKnowledgeSync(tx: Prisma.TransactionClient, resource: Pick<ExternalResourceRecord, "id" | "workspaceId" | "updatedAt">, options?: {
  dedupeKeySuffix?: string;
}) {
  const dedupeKey = `external-resource:${resource.id}:knowledge:${options?.dedupeKeySuffix ?? resource.updatedAt.getTime()}`;
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

async function upsertExternalResource(tx: Prisma.TransactionClient, params: {
  workspaceId: string;
  actor: AppActor | null;
  url: string;
  label?: string | null;
  descriptionMd?: string | null;
  summaryMd?: string | null;
  sourceType?: string | null;
}) {
  const classification = classifyExternalResourceUrl(params.url, params.label);
  const descriptionMd = cleanText(params.descriptionMd, 4000);
  const summaryMd = cleanText(params.summaryMd, 4000);
  const metadata = {
    ...classification.metadata,
    capturedFrom: params.sourceType ?? "manual",
  } satisfies Prisma.InputJsonObject;

  return tx.workspaceExternalResource.upsert({
    where: {
      workspaceId_providerKey_externalId: {
        workspaceId: params.workspaceId,
        providerKey: classification.providerKey,
        externalId: classification.externalId,
      },
    },
    update: {
      title: classification.title,
      resourceType: classification.resourceType,
      category: classification.category,
      priority: classification.priority,
      url: classification.url,
      sharedLinkUrl: classification.sharedLinkUrl,
      mimeType: classification.mimeType,
      ...(descriptionMd !== null ? { descriptionMd } : {}),
      ...(summaryMd !== null ? { summaryMd } : {}),
      metadata,
      lastEnrichedAt: new Date(),
      lastEnrichmentError: null,
      archivedAt: null,
      archiveReason: null,
    },
    create: {
      workspaceId: params.workspaceId,
      createdByUserId: params.actor ? actorUserId(params.actor) : null,
      providerKey: classification.providerKey,
      externalId: classification.externalId,
      resourceType: classification.resourceType,
      category: classification.category,
      priority: classification.priority,
      title: classification.title,
      url: classification.url,
      sharedLinkUrl: classification.sharedLinkUrl,
      mimeType: classification.mimeType,
      descriptionMd,
      summaryMd,
      metadata,
      lastEnrichedAt: new Date(),
      lastEnrichmentError: null,
    },
    select: externalResourceSelect,
  });
}

async function upsertExternalResourceMention(tx: Prisma.TransactionClient, params: {
  workspaceId: string;
  resourceId: string;
  sourceType: ExternalResourceSourceType;
  sourceId: string;
  sourceProvider?: CommunicationProvider | string | null;
  sourceExternalId?: string | null;
  sourcePermalink?: string | null;
  sourceLabel?: string | null;
  sourceText?: string | null;
  mentionedAt?: Date | null;
  communicationMessageId?: string | null;
}) {
  return tx.workspaceExternalResourceMention.upsert({
    where: {
      resourceId_sourceType_sourceId: {
        resourceId: params.resourceId,
        sourceType: params.sourceType,
        sourceId: params.sourceId,
      },
    },
    update: {
      workspaceId: params.workspaceId,
      sourceProvider: params.sourceProvider ? String(params.sourceProvider) : null,
      sourceExternalId: params.sourceExternalId ?? null,
      sourcePermalink: params.sourcePermalink ?? null,
      sourceLabel: cleanText(params.sourceLabel, 160),
      sourceText: cleanText(params.sourceText, 1200),
      mentionedAt: params.mentionedAt ?? null,
      redactedAt: null,
      communicationMessageId: params.communicationMessageId ?? null,
    },
    create: {
      workspaceId: params.workspaceId,
      resourceId: params.resourceId,
      sourceType: params.sourceType,
      sourceId: params.sourceId,
      sourceProvider: params.sourceProvider ? String(params.sourceProvider) : null,
      sourceExternalId: params.sourceExternalId ?? null,
      sourcePermalink: params.sourcePermalink ?? null,
      sourceLabel: cleanText(params.sourceLabel, 160),
      sourceText: cleanText(params.sourceText, 1200),
      mentionedAt: params.mentionedAt ?? null,
      communicationMessageId: params.communicationMessageId ?? null,
    },
  });
}

export async function externalResourceKnowledgeInput(resourceId: string, workspaceId: string) {
  const resource = await prisma.workspaceExternalResource.findFirst({
    where: { id: resourceId, workspaceId, archivedAt: null },
    select: {
      ...externalResourceSelect,
      mentions: {
        where: { redactedAt: null },
        orderBy: [{ mentionedAt: "desc" }, { createdAt: "desc" }],
        take: 5,
        select: {
          sourceType: true,
          sourceProvider: true,
          sourceLabel: true,
          sourceText: true,
          mentionedAt: true,
          redactedAt: true,
        },
      },
    },
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
      category: resource.category,
      priority: resource.priority,
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
  const purpose = validatePurpose(params.purpose);
  const entityType = params.entityType ? validateEntityType(params.entityType) : null;
  const entityId = params.entityId?.trim() || null;
  invariant(!entityType || entityId, 400, "INVALID_INPUT", "External resource target ID is required.");

  return prisma.$transaction(async (tx) => {
    if (entityType && entityId) {
      await assertAttachTarget(tx, params.workspaceId, entityType, entityId);
    }

    const resource = await upsertExternalResource(tx, {
      workspaceId: params.workspaceId,
      actor,
      url: params.url,
      descriptionMd: params.descriptionMd,
      summaryMd: params.summaryMd,
      sourceType: "manual",
    });

    if (entityType && entityId) {
      await tx.workspaceExternalResourceAttachment.createMany({
        data: [{
          workspaceId: params.workspaceId,
          resourceId: resource.id,
          entityType,
          entityId,
          purpose,
          createdByUserId: actorUserId(actor),
        }],
        skipDuplicates: true,
      });
      await recordAudit(tx, actor, {
        workspaceId: params.workspaceId,
        action: "external-resource.attached",
        entityType: "WorkspaceExternalResource",
        entityId: resource.id,
        meta: { providerKey: resource.providerKey, targetType: entityType, targetId: entityId, purpose },
      });
    }

    await recordAudit(tx, actor, {
      workspaceId: params.workspaceId,
      action: "external-resource.saved",
      entityType: "WorkspaceExternalResource",
      entityId: resource.id,
      meta: {
        providerKey: resource.providerKey,
        externalId: resource.externalId,
        resourceType: resource.resourceType,
      },
    });
    await enqueueExternalResourceKnowledgeSync(tx, resource);
    return resource;
  });
}

async function redactMentionsForSource(tx: Prisma.TransactionClient, params: {
  workspaceId: string;
  sourceType: ExternalResourceSourceType;
  sourceId: string;
  keepResourceIds?: string[];
}) {
  const mentions = await tx.workspaceExternalResourceMention.findMany({
    where: {
      workspaceId: params.workspaceId,
      sourceType: params.sourceType,
      sourceId: params.sourceId,
      redactedAt: null,
      ...(params.keepResourceIds ? { resourceId: { notIn: params.keepResourceIds } } : {}),
    },
    select: { resourceId: true, resource: { select: { id: true, workspaceId: true, updatedAt: true } } },
  });
  if (mentions.length === 0) return { redacted: 0, resourceIds: [] as string[] };

  const now = new Date();
  await tx.workspaceExternalResourceMention.updateMany({
    where: {
      workspaceId: params.workspaceId,
      sourceType: params.sourceType,
      sourceId: params.sourceId,
      redactedAt: null,
      ...(params.keepResourceIds ? { resourceId: { notIn: params.keepResourceIds } } : {}),
    },
    data: {
      sourceLabel: null,
      sourceText: null,
      redactedAt: now,
    },
  });

  const resources = new Map(mentions.map((mention) => [mention.resource.id, mention.resource]));
  for (const resource of resources.values()) {
    await enqueueExternalResourceKnowledgeSync(tx, resource, { dedupeKeySuffix: `redaction:${now.getTime()}` });
  }
  return { redacted: mentions.length, resourceIds: [...resources.keys()] };
}

async function captureSlackMessageReferences(sourceId: string) {
  const message = await prisma.communicationMessage.findUnique({
    where: { id: sourceId },
  });
  if (!message || message.provider !== "SLACK") {
    return { sourceType: "SLACK_MESSAGE" as const, sourceId, scanned: 0, captured: 0, redacted: 0, providerCounts: {} as Record<string, number> };
  }

  const channel = await prisma.communicationChannel.findUnique({
    where: {
      installationId_externalChannelId: {
        installationId: message.installationId,
        externalChannelId: message.externalChannelId,
      },
    },
    select: { kind: true, name: true },
  });

  if (channel?.kind !== "PUBLIC" || !message.text || message.textRedactedAt || message.isBot || message.isHidden || message.isDeleted) {
    return prisma.$transaction((tx) => redactMentionsForSource(tx, {
      workspaceId: message.workspaceId,
      sourceType: "SLACK_MESSAGE",
      sourceId: message.id,
    }).then((result) => ({
      sourceType: "SLACK_MESSAGE" as const,
      sourceId: message.id,
      scanned: 0,
      captured: 0,
      redacted: result.redacted,
      providerCounts: {} as Record<string, number>,
    })));
  }

  const references = extractExternalResourceReferencesFromText(message.text);
  const providerCounts: Record<string, number> = {};

  return prisma.$transaction(async (tx) => {
    const resourceIds: string[] = [];

    for (const reference of references) {
      const classification = classifyExternalResourceUrl(reference.url, reference.label);
      providerCounts[classification.providerKey] = (providerCounts[classification.providerKey] ?? 0) + 1;
      const resource = await upsertExternalResource(tx, {
        workspaceId: message.workspaceId,
        actor: null,
        url: reference.url,
        label: reference.label,
        descriptionMd: reference.sourceText,
        sourceType: "SLACK_MESSAGE",
      });
      resourceIds.push(resource.id);
      await upsertExternalResourceMention(tx, {
        workspaceId: message.workspaceId,
        resourceId: resource.id,
        sourceType: "SLACK_MESSAGE",
        sourceId: message.id,
        sourceProvider: message.provider,
        sourceExternalId: message.externalMessageId,
        sourcePermalink: message.permalink,
        sourceLabel: reference.label,
        sourceText: reference.sourceText,
        mentionedAt: message.messageTs ?? message.receivedAt,
        communicationMessageId: message.id,
      });
      await enqueueExternalResourceKnowledgeSync(tx, resource);
    }

    const redacted = await redactMentionsForSource(tx, {
      workspaceId: message.workspaceId,
      sourceType: "SLACK_MESSAGE",
      sourceId: message.id,
      keepResourceIds: resourceIds,
    });

    return {
      sourceType: "SLACK_MESSAGE" as const,
      sourceId: message.id,
      scanned: references.length,
      captured: resourceIds.length,
      redacted: redacted.redacted,
      providerCounts,
    };
  });
}

export async function captureReferencesForSource(sourceType: ExternalResourceSourceType | string, sourceId: string) {
  invariant(sourceId.trim().length > 0, 400, "INVALID_INPUT", "External resource source ID is required.");
  if (sourceType === "SLACK_MESSAGE") {
    return captureSlackMessageReferences(sourceId);
  }
  throw new AppError(400, "INVALID_INPUT", "Unsupported external resource source type.");
}

export async function backfillExternalResourceReferencesForWorkspace(actor: AppActor, params: {
  workspaceId: string;
  dryRun?: boolean;
  take?: number;
}) {
  await requireWorkspaceMembership({ actor, workspaceId: params.workspaceId });
  const take = Math.max(1, Math.min(params.take ?? 500, 5000));
  const dryRun = params.dryRun !== false;
  const publicChannels = await prisma.communicationChannel.findMany({
    where: {
      workspaceId: params.workspaceId,
      provider: "SLACK",
      kind: "PUBLIC",
      isIngestEnabled: true,
      isArchived: false,
    },
    select: { installationId: true, externalChannelId: true },
  });

  if (publicChannels.length === 0) {
    return {
      workspaceId: params.workspaceId,
      dryRun,
      scannedMessages: 0,
      candidateMessages: 0,
      references: 0,
      providerCounts: {},
      enqueued: 0,
    };
  }

  const messages = await prisma.communicationMessage.findMany({
    where: {
      workspaceId: params.workspaceId,
      provider: "SLACK",
      OR: publicChannels.map((channel) => ({
        installationId: channel.installationId,
        externalChannelId: channel.externalChannelId,
      })),
      text: { contains: "http" },
      textRedactedAt: null,
      isBot: false,
      isHidden: false,
      isDeleted: false,
    },
    orderBy: [{ messageTs: "asc" }, { receivedAt: "asc" }],
    take,
    select: {
      id: true,
      text: true,
      updatedAt: true,
    },
  });

  const providerCounts: Record<string, number> = {};
  let references = 0;
  let candidateMessages = 0;

  for (const message of messages) {
    const extracted = extractExternalResourceReferencesFromText(message.text);
    if (extracted.length === 0) continue;
    candidateMessages += 1;
    references += extracted.length;
    for (const reference of extracted) {
      const providerKey = classifyExternalResourceUrl(reference.url, reference.label).providerKey;
      providerCounts[providerKey] = (providerCounts[providerKey] ?? 0) + 1;
    }
  }

  let enqueued = 0;
  if (!dryRun) {
    for (const message of messages) {
      if (extractExternalResourceReferencesFromText(message.text).length === 0) continue;
      await prisma.workflowJob.upsert({
        where: { dedupeKey: `external-resource:SLACK_MESSAGE:${message.id}:capture:${message.updatedAt.getTime()}` },
        update: {},
        create: {
          workspaceId: params.workspaceId,
          type: "external-resource.capture-source",
          payload: {
            sourceType: "SLACK_MESSAGE",
            sourceId: message.id,
          },
          dedupeKey: `external-resource:SLACK_MESSAGE:${message.id}:capture:${message.updatedAt.getTime()}`,
        },
      });
      enqueued += 1;
    }
  }

  return {
    workspaceId: params.workspaceId,
    dryRun,
    scannedMessages: messages.length,
    candidateMessages,
    references,
    providerCounts,
    enqueued,
  };
}

export async function listWorkspaceExternalResources(actor: AppActor, params: {
  workspaceId: string;
  providerKey?: string | null;
  query?: string | null;
  take?: number;
}) {
  await requireWorkspaceMembership({ actor, workspaceId: params.workspaceId });
  const query = params.query?.trim();
  const resources = await prisma.workspaceExternalResource.findMany({
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
          { mentions: { some: { sourceLabel: { contains: query, mode: "insensitive" }, redactedAt: null } } },
          { mentions: { some: { sourceText: { contains: query, mode: "insensitive" }, redactedAt: null } } },
        ],
      } : {}),
    },
    orderBy: [{ priority: "desc" }, { updatedAt: "desc" }, { createdAt: "desc" }],
    take: Math.max(1, Math.min(params.take ?? 50, 100)),
    select: externalResourceListSelect,
  });
  return enrichExternalResourceList(params.workspaceId, resources);
}

async function enrichExternalResourceList(workspaceId: string, resources: ExternalResourceListRecord[]) {
  const userPairs = new Map<string, { installationId: string; externalUserId: string }>();
  const channelPairs = new Map<string, { installationId: string; externalChannelId: string }>();

  for (const resource of resources) {
    for (const mention of resource.mentions) {
      const message = mention.communicationMessage;
      if (!message) continue;
      if (message.externalUserId) {
        userPairs.set(communicationUserKey(message.installationId, message.externalUserId), {
          installationId: message.installationId,
          externalUserId: message.externalUserId,
        });
      }
      if (message.externalChannelId) {
        channelPairs.set(communicationChannelKey(message.installationId, message.externalChannelId), {
          installationId: message.installationId,
          externalChannelId: message.externalChannelId,
        });
      }
    }
  }

  const [users, channels] = await Promise.all([
    userPairs.size > 0
      ? prisma.communicationExternalUser.findMany({
        where: {
          workspaceId,
          OR: [...userPairs.values()].map((pair) => ({
            installationId: pair.installationId,
            externalUserId: pair.externalUserId,
          })),
        },
        select: {
          installationId: true,
          externalUserId: true,
          email: true,
          displayName: true,
        },
      })
      : Promise.resolve([]),
    channelPairs.size > 0
      ? prisma.communicationChannel.findMany({
        where: {
          workspaceId,
          OR: [...channelPairs.values()].map((pair) => ({
            installationId: pair.installationId,
            externalChannelId: pair.externalChannelId,
          })),
        },
        select: {
          installationId: true,
          externalChannelId: true,
          name: true,
        },
      })
      : Promise.resolve([]),
  ]);

  const usersByKey = new Map(users.map((user) => [communicationUserKey(user.installationId, user.externalUserId), user]));
  const channelsByKey = new Map(channels.map((channel) => [communicationChannelKey(channel.installationId, channel.externalChannelId), channel]));

  return resources.map(({ mentions, ...resource }) => ({
    ...resource,
    mentions: mentions.map(({ communicationMessage, ...mention }) => {
      const user = communicationMessage?.externalUserId
        ? usersByKey.get(communicationUserKey(communicationMessage.installationId, communicationMessage.externalUserId))
        : null;
      const channel = communicationMessage?.externalChannelId
        ? channelsByKey.get(communicationChannelKey(communicationMessage.installationId, communicationMessage.externalChannelId))
        : null;
      return {
        ...mention,
        sharedByName: user?.displayName || user?.email || communicationMessage?.externalUserId || null,
        sourceChannelName: channel?.name || null,
        sourceChannelExternalId: communicationMessage?.externalChannelId ?? null,
      };
    }),
  }));
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
