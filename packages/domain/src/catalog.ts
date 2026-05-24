import type {
  CatalogAccessMode,
  CatalogItemStatus,
  CatalogItemType,
  CatalogRequestStatus,
  CatalogRequestType,
  CatalogSourceType,
  Prisma,
} from "@prisma/client";
import { prisma, randomOpaqueToken, sha256, toInputJson } from "@corgtex/shared";
import type { AppActor, MembershipSummary } from "@corgtex/shared";
import { AGENT_REGISTRY } from "./agent-registry";
import { ALL_SCOPES } from "./agent-auth";
import { actorUserIdForWorkspace, requireWorkspaceMembership } from "./auth";
import { recordAudit } from "./audit-trail";
import { AppError, invariant } from "./errors";

const CREDENTIAL_PREFIX = "agentc-";
const CATALOG_ADMIN_ROLES = new Set(["ADMIN"]);
const CATALOG_FEATURE_DEFAULTS = {
  AGENT_GOVERNANCE: true,
  BUILD_ARTIFACTS: false,
  MEETING_RECORDERS: false,
  SETTINGS_GENERAL: true,
} as const;

type CatalogFeatureFlag = keyof typeof CATALOG_FEATURE_DEFAULTS;
type CatalogFeatureFlags = Record<CatalogFeatureFlag, boolean>;

type CatalogSourceInput = {
  type: CatalogItemType;
  sourceType: CatalogSourceType;
  sourceId: string;
  title: string;
  outcome?: string | null;
  descriptionMd?: string | null;
  accessNotesMd?: string | null;
  url?: string | null;
  category?: string | null;
  status?: CatalogItemStatus;
  accessMode?: CatalogAccessMode;
  requestedScopes?: string[];
  createdByUserId?: string | null;
  ownerUserId?: string | null;
  featured?: boolean;
};

type CatalogItemRecord = Prisma.CatalogItemGetPayload<{
  include: {
    createdBy: { select: { id: true; email: true; displayName: true } };
    owner: { select: { id: true; email: true; displayName: true } };
  };
}>;

function normalizeString(value: string | null | undefined) {
  const trimmed = value?.trim();
  return trimmed && trimmed.length > 0 ? trimmed : null;
}

function slugPart(value: string) {
  return value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "")
    .slice(0, 72) || "item";
}

function sourceSlug(input: Pick<CatalogSourceInput, "sourceType" | "sourceId" | "title">) {
  return `${slugPart(input.sourceType)}-${slugPart(input.sourceId || input.title)}`.slice(0, 96);
}

function normalizeScopes(scopes: string[] | undefined) {
  return [...new Set((scopes ?? []).map((scope) => scope.trim()).filter(Boolean))];
}

function validateCatalogScopes(scopes: string[] | undefined) {
  const normalized = normalizeScopes(scopes);
  const unknown = normalized.filter((scope) => !ALL_SCOPES.includes(scope as typeof ALL_SCOPES[number]));
  invariant(unknown.length === 0, 400, "INVALID_INPUT", `Unknown scope(s): ${unknown.join(", ")}.`);
  return normalized;
}

function centsOrNull(value: number | null | undefined, label: string) {
  if (value == null) return null;
  invariant(Number.isInteger(value) && value >= 0, 400, "INVALID_INPUT", `${label} must be a non-negative integer.`);
  return value;
}

function canManageCatalog(membership: MembershipSummary | null | undefined) {
  return Boolean(membership && CATALOG_ADMIN_ROLES.has(membership.role));
}

async function getCatalogFeatureFlags(workspaceId: string): Promise<CatalogFeatureFlags> {
  const records = await prisma.workspaceFeatureFlag.findMany({
    where: {
      workspaceId,
      flag: { in: Object.keys(CATALOG_FEATURE_DEFAULTS) },
    },
    select: {
      flag: true,
      enabled: true,
    },
  });
  const flags: CatalogFeatureFlags = { ...CATALOG_FEATURE_DEFAULTS };
  for (const record of records) {
    if (record.flag in flags) {
      flags[record.flag as CatalogFeatureFlag] = record.enabled;
    }
  }
  return flags;
}

function requireUser(actor: AppActor) {
  if (actor.kind !== "user") {
    throw new AppError(403, "FORBIDDEN", "Only signed-in workspace members can use this catalog action.");
  }
  return actor.user;
}

function connectorSources(workspaceId: string, flags: CatalogFeatureFlags): CatalogSourceInput[] {
  const sources: CatalogSourceInput[] = [];
  if (process.env.SLACK_CLIENT_ID && process.env.SLACK_CLIENT_SECRET) {
    sources.push({
      type: "CONNECTOR",
      sourceType: "COMMUNICATION_INSTALLATION",
      sourceId: "slack",
      title: "Slack",
      outcome: "Bring public-channel work into Corgtex briefings, actions, and knowledge.",
      descriptionMd: "Connect a Slack workspace so Corgtex can capture public-channel context and power workspace automation.",
      url: `/api/integrations/slack/install?workspaceId=${workspaceId}`,
      category: "COMMUNICATION",
      accessMode: "ADMIN_ONLY",
      requestedScopes: ["integrations:read"],
      featured: true,
    });
  }
  if (process.env.GOOGLE_CLIENT_ID && process.env.GOOGLE_CLIENT_SECRET) {
    sources.push({
      type: "CONNECTOR",
      sourceType: "OAUTH_CONNECTION",
      sourceId: "google",
      title: "Google",
      outcome: "Connect calendar and document context for meetings, docs, and follow-up work.",
      descriptionMd: "Connect a Google account so Corgtex can use supported Google integrations for this workspace.",
      url: `/api/integrations/google/connect?workspaceId=${workspaceId}`,
      category: "CONNECTOR",
      accessMode: "OPEN",
      requestedScopes: ["meetings:read", "documents:write"],
      featured: true,
    });
  }
  if (process.env.MICROSOFT_CLIENT_ID && process.env.MICROSOFT_CLIENT_SECRET) {
    sources.push({
      type: "CONNECTOR",
      sourceType: "OAUTH_CONNECTION",
      sourceId: "microsoft",
      title: "Microsoft",
      outcome: "Connect Microsoft calendar and document context where supported.",
      descriptionMd: "Connect a Microsoft account so Corgtex can use supported Microsoft integrations for this workspace.",
      url: `/api/integrations/microsoft/connect?workspaceId=${workspaceId}`,
      category: "CONNECTOR",
      accessMode: "OPEN",
      requestedScopes: ["meetings:read", "documents:write"],
      featured: true,
    });
  }
  if (flags.SETTINGS_GENERAL) {
    sources.push({
      type: "CONNECTOR",
      sourceType: "MCP_CONNECTOR",
      sourceId: "corgtex-mcp",
      title: "Corgtex MCP",
      outcome: "Use Corgtex from ChatGPT, Claude, Cursor, Claude Code, and other MCP clients.",
      descriptionMd: "Connect external AI clients to Corgtex with workspace-scoped OAuth access.",
      url: `/workspaces/${workspaceId}/settings?tab=general`,
      category: "AI",
      accessMode: "OPEN",
      requestedScopes: ["workspace:read", "brain:read", "conversations:write"],
      featured: true,
    });
  }
  if (flags.MEETING_RECORDERS && flags.SETTINGS_GENERAL) {
    sources.push({
      type: "AUTOMATION",
      sourceType: "MEETING_RECORDER",
      sourceId: "meeting-recorder",
      title: "Meeting recorder",
      outcome: "Record meetings and turn transcripts into summaries, actions, tensions, and proposals.",
      descriptionMd: "Corgtex-managed meeting recording for calendar meetings when the workspace has recorders enabled.",
      url: `/workspaces/${workspaceId}/settings?tab=general`,
      category: "MEETINGS",
      accessMode: "ADMIN_ONLY",
      requestedScopes: ["meetings:read", "meetings:write"],
    });
  }
  return sources;
}

function isCatalogItemAvailable(item: Pick<CatalogItemRecord, "sourceType" | "sourceId">, flags: CatalogFeatureFlags) {
  if (item.sourceType === "AGENT_CONFIG" || item.sourceType === "AGENT_IDENTITY") {
    return flags.AGENT_GOVERNANCE;
  }
  if (item.sourceType === "BUILD_ARTIFACT") {
    return flags.BUILD_ARTIFACTS;
  }
  if (item.sourceType === "MEETING_RECORDER") {
    return flags.MEETING_RECORDERS && flags.SETTINGS_GENERAL;
  }
  if (item.sourceType === "DATA_SOURCE") {
    return flags.SETTINGS_GENERAL;
  }
  if (item.sourceType === "MCP_CONNECTOR") {
    return flags.SETTINGS_GENERAL;
  }
  if (item.sourceType === "COMMUNICATION_INSTALLATION" && item.sourceId === "slack") {
    return Boolean(process.env.SLACK_CLIENT_ID && process.env.SLACK_CLIENT_SECRET);
  }
  if (item.sourceType === "OAUTH_CONNECTION" && item.sourceId === "google") {
    return Boolean(process.env.GOOGLE_CLIENT_ID && process.env.GOOGLE_CLIENT_SECRET);
  }
  if (item.sourceType === "OAUTH_CONNECTION" && item.sourceId === "microsoft") {
    return Boolean(process.env.MICROSOFT_CLIENT_ID && process.env.MICROSOFT_CLIENT_SECRET);
  }
  return true;
}

async function requireAvailableCatalogItem(workspaceId: string, catalogItemId: string) {
  await ensureDerivedCatalogItems(workspaceId);
  const [item, featureFlags] = await Promise.all([
    prisma.catalogItem.findFirst({
      where: {
        id: catalogItemId,
        workspaceId,
        archivedAt: null,
      },
      select: {
        id: true,
        sourceType: true,
        sourceId: true,
      },
    }),
    getCatalogFeatureFlags(workspaceId),
  ]);
  invariant(item && isCatalogItemAvailable(item, featureFlags), 404, "NOT_FOUND", "Catalog item not found.");
  return item;
}

async function ensureDerivedCatalogItems(workspaceId: string) {
  const [toolLinks, agentConfigs, buildArtifacts, dataSources, featureFlags] = await Promise.all([
    prisma.workspaceToolLink.findMany({
      where: { workspaceId, archivedAt: null },
      select: {
        id: true,
        title: true,
        url: true,
        category: true,
        descriptionMd: true,
        accessNotesMd: true,
        createdByUserId: true,
      },
    }),
    prisma.workspaceAgentConfig.findMany({
      where: { workspaceId },
      select: { agentKey: true, enabled: true },
    }),
    prisma.buildArtifact.findMany({
      where: { workspaceId, visibility: { not: "REVOKED" } },
      select: {
        id: true,
        title: true,
        summaryMd: true,
        pullRequestUrl: true,
        repositoryOwner: true,
        repositoryName: true,
        createdByUserId: true,
        status: true,
      },
      orderBy: { updatedAt: "desc" },
      take: 50,
    }),
    prisma.externalDataSource.findMany({
      where: { workspaceId, archivedAt: null },
      select: {
        id: true,
        label: true,
        driverType: true,
        selectedTables: true,
        isActive: true,
        lastSyncError: true,
      },
    }),
    getCatalogFeatureFlags(workspaceId),
  ]);

  const configMap = new Map(agentConfigs.map((config) => [config.agentKey, config]));
  const sources: CatalogSourceInput[] = [
    ...toolLinks.map((link) => ({
      type: "TOOL" as const,
      sourceType: "TOOL_LINK" as const,
      sourceId: link.id,
      title: link.title,
      outcome: link.descriptionMd ?? `Open ${link.title} for shared workspace work.`,
      descriptionMd: link.descriptionMd,
      accessNotesMd: link.accessNotesMd,
      url: link.url,
      category: link.category,
      accessMode: link.accessNotesMd ? "REQUEST" as const : "OPEN" as const,
      createdByUserId: link.createdByUserId,
      ownerUserId: link.createdByUserId,
    })),
    ...(featureFlags.AGENT_GOVERNANCE ? Object.entries(AGENT_REGISTRY).map(([agentKey, meta]) => {
      const config = configMap.get(agentKey);
      return {
        type: "AGENT" as const,
        sourceType: "AGENT_CONFIG" as const,
        sourceId: agentKey,
        title: meta.label,
        outcome: meta.outputs.join(", "),
        descriptionMd: meta.description,
        url: `/workspaces/${workspaceId}/agents?tab=registry`,
        category: meta.category.toUpperCase(),
        status: config?.enabled === false ? "DISABLED" as const : "PUBLISHED" as const,
        accessMode: "ADMIN_ONLY" as const,
        requestedScopes: ["agents:read"],
        featured: meta.costTier === "free" || meta.costTier === "low",
      };
    }) : []),
    ...(featureFlags.BUILD_ARTIFACTS ? buildArtifacts.map((artifact) => ({
      type: "APP" as const,
      sourceType: "BUILD_ARTIFACT" as const,
      sourceId: artifact.id,
      title: artifact.title,
      outcome: "Review, reuse, or publish this employee-created build artifact.",
      descriptionMd: artifact.summaryMd,
      url: artifact.pullRequestUrl ?? `/workspaces/${workspaceId}/built`,
      category: "VIBE_CODED",
      status: artifact.status === "CLOSED" ? "DISABLED" as const : "PUBLISHED" as const,
      accessMode: "REQUEST" as const,
      createdByUserId: artifact.createdByUserId,
      ownerUserId: artifact.createdByUserId,
    })) : []),
    ...(featureFlags.SETTINGS_GENERAL ? dataSources.map((source) => ({
      type: "DATA_SOURCE" as const,
      sourceType: "DATA_SOURCE" as const,
      sourceId: source.id,
      title: source.label,
      outcome: `Use ${source.label} as connected data for Corgtex search and automation.`,
      descriptionMd: `${source.driverType} data source${source.selectedTables.length > 0 ? ` with ${source.selectedTables.length} selected tables` : ""}.`,
      url: `/workspaces/${workspaceId}/settings?tab=data-sources`,
      category: "DATA",
      status: source.isActive ? "PUBLISHED" as const : "DISABLED" as const,
      accessMode: "ADMIN_ONLY" as const,
      requestedScopes: ["data-sources:read"],
    })) : []),
    ...connectorSources(workspaceId, featureFlags),
  ];

  await Promise.all(sources.map((source) => prisma.catalogItem.upsert({
    where: {
      workspaceId_sourceType_sourceId: {
        workspaceId,
        sourceType: source.sourceType,
        sourceId: source.sourceId,
      },
    },
    create: {
      workspaceId,
      createdByUserId: source.createdByUserId ?? null,
      ownerUserId: source.ownerUserId ?? null,
      type: source.type,
      sourceType: source.sourceType,
      sourceId: source.sourceId,
      title: source.title,
      slug: sourceSlug(source),
      outcome: normalizeString(source.outcome),
      descriptionMd: normalizeString(source.descriptionMd),
      accessNotesMd: normalizeString(source.accessNotesMd),
      url: normalizeString(source.url),
      category: normalizeString(source.category) ?? "OTHER",
      status: source.status ?? "PUBLISHED",
      accessMode: source.accessMode ?? "OPEN",
      requestedScopes: validateCatalogScopes(source.requestedScopes),
      featured: source.featured ?? false,
    },
    update: {
      createdByUserId: source.createdByUserId ?? undefined,
      ownerUserId: source.ownerUserId ?? undefined,
      title: source.title,
      outcome: normalizeString(source.outcome),
      descriptionMd: normalizeString(source.descriptionMd),
      accessNotesMd: normalizeString(source.accessNotesMd),
      url: normalizeString(source.url),
      category: normalizeString(source.category) ?? "OTHER",
      status: source.status ?? "PUBLISHED",
      accessMode: source.accessMode ?? "OPEN",
      requestedScopes: validateCatalogScopes(source.requestedScopes),
      featured: source.featured ?? false,
      archivedAt: null,
      archivedByUserId: null,
      archiveReason: null,
    },
  })));
}

function serializeCatalogItem(params: {
  item: CatalogItemRecord;
  userId: string | null;
  favoriteIds: Set<string>;
  pendingByItem: Map<string, number>;
}) {
  const isUploaded = Boolean(params.userId && (
    params.item.createdByUserId === params.userId || params.item.ownerUserId === params.userId
  ));

  return {
    id: params.item.id,
    workspaceId: params.item.workspaceId,
    type: params.item.type,
    sourceType: params.item.sourceType,
    sourceId: params.item.sourceId,
    title: params.item.title,
    slug: params.item.slug,
    outcome: params.item.outcome,
    descriptionMd: params.item.descriptionMd,
    accessNotesMd: params.item.accessNotesMd,
    url: params.item.url,
    category: params.item.category,
    status: params.item.status,
    accessMode: params.item.accessMode,
    requestedScopes: params.item.requestedScopes,
    monthlyBudgetCents: params.item.monthlyBudgetCents,
    dailyCallLimit: params.item.dailyCallLimit,
    featured: params.item.featured,
    createdAt: params.item.createdAt,
    updatedAt: params.item.updatedAt,
    createdBy: params.item.createdBy,
    owner: params.item.owner,
    isFavorite: params.favoriteIds.has(params.item.id),
    isUploaded,
    pendingRequestCount: params.pendingByItem.get(params.item.id) ?? 0,
  };
}

export async function listCatalogItems(actor: AppActor, workspaceId: string) {
  const membership = await requireWorkspaceMembership({ actor, workspaceId });
  await ensureDerivedCatalogItems(workspaceId);
  const featureFlags = await getCatalogFeatureFlags(workspaceId);

  const userId = actor.kind === "user" ? actor.user.id : null;
  const [items, favorites, pendingRequests, settings] = await Promise.all([
    prisma.catalogItem.findMany({
      where: {
        workspaceId,
        archivedAt: null,
        status: { not: "ARCHIVED" },
      },
      include: {
        createdBy: { select: { id: true, email: true, displayName: true } },
        owner: { select: { id: true, email: true, displayName: true } },
      },
      orderBy: [{ featured: "desc" }, { type: "asc" }, { title: "asc" }],
    }),
    userId
      ? prisma.catalogFavorite.findMany({
          where: { workspaceId, userId },
          select: { catalogItemId: true },
        })
      : Promise.resolve([]),
    prisma.catalogRequest.findMany({
      where: { workspaceId, status: "PENDING" },
      select: { catalogItemId: true },
    }),
    prisma.catalogSettings.upsert({
      where: { workspaceId },
      create: { workspaceId, approvalMode: "ADMIN" },
      update: {},
    }),
  ]);

  const favoriteIds = new Set(favorites.map((favorite) => favorite.catalogItemId));
  const pendingByItem = new Map<string, number>();
  for (const request of pendingRequests) {
    if (request.catalogItemId) {
      pendingByItem.set(request.catalogItemId, (pendingByItem.get(request.catalogItemId) ?? 0) + 1);
    }
  }

  const serialized = items
    .filter((item) => isCatalogItemAvailable(item, featureFlags))
    .map((item) => serializeCatalogItem({
      item,
      userId,
      favoriteIds,
      pendingByItem,
    }));

  return {
    items: serialized,
    canManage: canManageCatalog(membership),
    settings,
  };
}

export async function getCatalogItem(actor: AppActor, params: {
  workspaceId: string;
  catalogItemId: string;
}) {
  await requireWorkspaceMembership({ actor, workspaceId: params.workspaceId });
  await ensureDerivedCatalogItems(params.workspaceId);
  const featureFlags = await getCatalogFeatureFlags(params.workspaceId);
  const userId = actor.kind === "user" ? actor.user.id : null;

  const [item, favorite, requests, usageRows, credentialCount] = await Promise.all([
    prisma.catalogItem.findFirst({
      where: {
        id: params.catalogItemId,
        workspaceId: params.workspaceId,
        archivedAt: null,
      },
      include: {
        createdBy: { select: { id: true, email: true, displayName: true } },
        owner: { select: { id: true, email: true, displayName: true } },
      },
    }),
    userId
      ? prisma.catalogFavorite.findUnique({
          where: { catalogItemId_userId: { catalogItemId: params.catalogItemId, userId } },
          select: { id: true },
        })
      : Promise.resolve(null),
    prisma.catalogRequest.findMany({
      where: { workspaceId: params.workspaceId, catalogItemId: params.catalogItemId },
      include: {
        requester: { select: { id: true, email: true, displayName: true } },
        decidedBy: { select: { id: true, email: true, displayName: true } },
      },
      orderBy: { createdAt: "desc" },
      take: 20,
    }),
    prisma.modelUsage.findMany({
      where: {
        workspaceId: params.workspaceId,
        catalogItemId: params.catalogItemId,
        createdAt: { gte: new Date(Date.now() - 30 * 24 * 60 * 60 * 1000) },
      },
      select: {
        inputTokens: true,
        outputTokens: true,
        estimatedCostUsd: true,
        billableCostUsd: true,
      },
    }),
    prisma.agentCredential.count({
      where: {
        workspaceId: params.workspaceId,
        catalogItemId: params.catalogItemId,
        isActive: true,
      },
    }),
  ]);

  invariant(item && isCatalogItemAvailable(item, featureFlags), 404, "NOT_FOUND", "Catalog item not found.");
  const totalCostUsd = usageRows.reduce((sum, row) => sum + Number(row.billableCostUsd ?? row.estimatedCostUsd ?? 0), 0);
  const totalTokens = usageRows.reduce((sum, row) => sum + row.inputTokens + row.outputTokens, 0);

  return {
    item: serializeCatalogItem({
      item,
      userId,
      favoriteIds: new Set(favorite ? [params.catalogItemId] : []),
      pendingByItem: new Map([[params.catalogItemId, requests.filter((request) => request.status === "PENDING").length]]),
    }),
    requests,
    usage: {
      totalCalls: usageRows.length,
      totalTokens,
      totalCostUsd,
      activeCredentialCount: credentialCount,
    },
  };
}

export async function setCatalogFavorite(actor: AppActor, params: {
  workspaceId: string;
  catalogItemId: string;
  favorite: boolean;
}) {
  const user = requireUser(actor);
  await requireWorkspaceMembership({ actor, workspaceId: params.workspaceId });
  await requireAvailableCatalogItem(params.workspaceId, params.catalogItemId);

  if (params.favorite) {
    await prisma.catalogFavorite.upsert({
      where: { catalogItemId_userId: { catalogItemId: params.catalogItemId, userId: user.id } },
      create: {
        workspaceId: params.workspaceId,
        catalogItemId: params.catalogItemId,
        userId: user.id,
      },
      update: {},
    });
  } else {
    await prisma.catalogFavorite.deleteMany({
      where: {
        workspaceId: params.workspaceId,
        catalogItemId: params.catalogItemId,
        userId: user.id,
      },
    });
  }

  return { catalogItemId: params.catalogItemId, isFavorite: params.favorite };
}

export async function createCatalogRequest(actor: AppActor, params: {
  workspaceId: string;
  catalogItemId?: string | null;
  type: CatalogRequestType;
  reasonMd: string;
  requestedScopes?: string[];
  requestedBudgetCents?: number | null;
  requestedDailyCallLimit?: number | null;
  title?: string | null;
  payloadJson?: Record<string, unknown> | null;
}) {
  const user = requireUser(actor);
  await requireWorkspaceMembership({ actor, workspaceId: params.workspaceId });
  const reasonMd = params.reasonMd.trim();
  invariant(reasonMd.length > 0, 400, "INVALID_INPUT", "Request reason is required.");

  if (params.type !== "PUBLISH") {
    invariant(params.catalogItemId, 400, "INVALID_INPUT", "Catalog item is required for this request type.");
    await requireAvailableCatalogItem(params.workspaceId, params.catalogItemId);
  }

  const request = await prisma.catalogRequest.create({
    data: {
      workspaceId: params.workspaceId,
      catalogItemId: params.catalogItemId ?? null,
      requesterUserId: user.id,
      type: params.type,
      reasonMd,
      requestedScopes: validateCatalogScopes(params.requestedScopes),
      requestedBudgetCents: centsOrNull(params.requestedBudgetCents, "Requested budget"),
      requestedDailyCallLimit: centsOrNull(params.requestedDailyCallLimit, "Requested daily call limit"),
      title: normalizeString(params.title),
      payloadJson: params.payloadJson ? toInputJson(params.payloadJson) : undefined,
    },
  });

  await prisma.auditLog.create({
    data: {
      workspaceId: params.workspaceId,
      actorUserId: user.id,
      action: "catalog.request_created",
      entityType: "CatalogRequest",
      entityId: request.id,
      meta: {
        catalogItemId: params.catalogItemId ?? null,
        type: params.type,
      },
    },
  });

  return request;
}

async function findAvailableCatalogSlug(tx: Prisma.TransactionClient, workspaceId: string, title: string) {
  const base = slugPart(title);
  for (let attempt = 0; attempt < 20; attempt += 1) {
    const suffix = attempt === 0 ? "" : `-${attempt + 1}`;
    const slug = `${base}${suffix}`.slice(0, 96);
    const existing = await tx.catalogItem.findUnique({
      where: { workspaceId_slug: { workspaceId, slug } },
      select: { id: true },
    });
    if (!existing) return slug;
  }
  throw new AppError(409, "SLUG_UNAVAILABLE", "Could not allocate a catalog slug.");
}

function payloadRecord(value: Prisma.JsonValue | null | undefined) {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

function payloadString(payload: Record<string, unknown>, key: string) {
  const value = payload[key];
  return typeof value === "string" ? normalizeString(value) : null;
}

function payloadType(payload: Record<string, unknown>): CatalogItemType {
  const value = payloadString(payload, "type");
  return value === "APP" || value === "AGENT" || value === "TOOL" || value === "AUTOMATION" || value === "CONNECTOR" || value === "DATA_SOURCE"
    ? value
    : "APP";
}

export async function decideCatalogRequest(actor: AppActor, params: {
  workspaceId: string;
  requestId: string;
  status: Extract<CatalogRequestStatus, "APPROVED" | "REJECTED">;
  decisionNoteMd?: string | null;
}) {
  await requireWorkspaceMembership({ actor, workspaceId: params.workspaceId, allowedRoles: ["ADMIN"] });
  const actorUserId = await actorUserIdForWorkspace(actor, params.workspaceId);
  let issuedToken: string | null = null;

  const updated = await prisma.$transaction(async (tx) => {
    const request = await tx.catalogRequest.findFirst({
      where: {
        id: params.requestId,
        workspaceId: params.workspaceId,
      },
      include: { catalogItem: true },
    });
    invariant(request, 404, "NOT_FOUND", "Catalog request not found.");
    invariant(request.status === "PENDING", 400, "INVALID_STATE", "Catalog request has already been decided.");

    let catalogItemId = request.catalogItemId;
    if (params.status === "APPROVED" && request.type === "PUBLISH") {
      const payload = payloadRecord(request.payloadJson);
      const title = request.title ?? payloadString(payload, "title") ?? "Untitled app";
      const proofUrl = payloadString(payload, "proofUrl");
      const slug = await findAvailableCatalogSlug(tx, params.workspaceId, title);
      const item = await tx.catalogItem.create({
        data: {
          workspaceId: params.workspaceId,
          createdByUserId: request.requesterUserId,
          ownerUserId: request.requesterUserId,
          type: payloadType(payload),
          sourceType: "MANUAL",
          sourceId: request.id,
          title,
          slug,
          outcome: payloadString(payload, "outcome"),
          descriptionMd: payloadString(payload, "descriptionMd") ?? request.reasonMd,
          accessNotesMd: payloadString(payload, "accessNotesMd") ?? (proofUrl ? `Proof link: ${proofUrl}` : null),
          url: payloadString(payload, "url"),
          category: payloadString(payload, "category") ?? "VIBE_CODED",
          status: "PUBLISHED",
          accessMode: "REQUEST",
          requestedScopes: request.requestedScopes,
          monthlyBudgetCents: request.requestedBudgetCents,
          dailyCallLimit: request.requestedDailyCallLimit,
        },
        select: { id: true },
      });
      catalogItemId = item.id;
    }

    if (params.status === "APPROVED" && request.type === "API_KEY") {
      invariant(request.catalogItem, 400, "INVALID_INPUT", "API key requests require a catalog item.");
      const secret = randomOpaqueToken();
      issuedToken = `${CREDENTIAL_PREFIX}${secret}`;
      await tx.agentCredential.create({
        data: {
          workspaceId: params.workspaceId,
          createdByUserId: request.requesterUserId,
          catalogItemId: request.catalogItem.id,
          label: `${request.catalogItem.title} API key`,
          tokenHash: sha256(secret),
          scopes: validateCatalogScopes(request.requestedScopes.length > 0 ? request.requestedScopes : request.catalogItem.requestedScopes),
          reasonMd: request.reasonMd,
          monthlyBudgetCents: request.requestedBudgetCents ?? request.catalogItem.monthlyBudgetCents,
          dailyCallLimit: request.requestedDailyCallLimit ?? request.catalogItem.dailyCallLimit,
          isActive: true,
        },
      });
    }

    if (params.status === "APPROVED" && request.type === "BUDGET_INCREASE") {
      invariant(request.catalogItemId, 400, "INVALID_INPUT", "Budget requests require a catalog item.");
      await tx.catalogItem.update({
        where: { id: request.catalogItemId },
        data: {
          monthlyBudgetCents: request.requestedBudgetCents ?? undefined,
          dailyCallLimit: request.requestedDailyCallLimit ?? undefined,
        },
      });
    }

    const decided = await tx.catalogRequest.update({
      where: { id: request.id },
      data: {
        catalogItemId,
        status: params.status,
        decidedByUserId: actorUserId,
        decidedAt: new Date(),
        decisionNoteMd: normalizeString(params.decisionNoteMd),
      },
    });

    await recordAudit(tx, actor, {
      workspaceId: params.workspaceId,
      action: params.status === "APPROVED" ? "catalog.request_approved" : "catalog.request_rejected",
      entityType: "CatalogRequest",
      entityId: request.id,
      meta: {
        requestType: request.type,
        catalogItemId,
        issuedCredential: Boolean(issuedToken),
      },
    });

    return decided;
  });

  return {
    request: updated,
    token: issuedToken,
  };
}

export async function listCatalogRequests(actor: AppActor, params: {
  workspaceId: string;
  status?: CatalogRequestStatus;
}) {
  const membership = await requireWorkspaceMembership({ actor, workspaceId: params.workspaceId });
  const userId = actor.kind === "user" ? actor.user.id : null;
  const where: Prisma.CatalogRequestWhereInput = {
    workspaceId: params.workspaceId,
    ...(params.status ? { status: params.status } : {}),
    ...(canManageCatalog(membership) ? {} : { requesterUserId: userId ?? "" }),
  };

  return prisma.catalogRequest.findMany({
    where,
    include: {
      catalogItem: {
        select: { id: true, title: true, type: true },
      },
      requester: {
        select: { id: true, email: true, displayName: true },
      },
      decidedBy: {
        select: { id: true, email: true, displayName: true },
      },
    },
    orderBy: { createdAt: "desc" },
    take: 100,
  });
}
