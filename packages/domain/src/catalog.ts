import type {
  AppCategory,
  AppHostingMode,
  AppInstallationStatus,
  AppIntegrationDepth,
  AppVisibility,
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
import { listAiWorkspaceToolProviders, listEnterpriseServices } from "./ai-workspaces";
import { actorUserIdForWorkspace, requireWorkspaceMembership } from "./auth";
import { connectorReadinessManifest, listConnectorReadinessProfiles } from "./connector-readiness";
import { recordAudit } from "./audit-trail";
import { AppError, invariant } from "./errors";

const CREDENTIAL_PREFIX = "agentc-";
const CATALOG_ADMIN_ROLES = new Set(["ADMIN"]);
const CATALOG_FEATURE_DEFAULTS = {
  AGENT_GOVERNANCE: true,
  APP_MARKETPLACE: true,
  BUILD_ARTIFACTS: false,
  MEETING_RECORDERS: false,
  SETTINGS_GENERAL: true,
  MEETING_TRANSCRIPT_SOURCES: false,
  FINANCE: true,
  AI_WORKSPACES: true,
  OPENWORK_DEFAULT: false,
  EXECUTION_PACKETS: false,
  MANAGED_ENTERPRISE_SERVICES: false,
} as const;

const APP_CATEGORIES: AppCategory[] = ["FINANCE", "KNOWLEDGE", "COMMUNICATION", "AI", "OPERATIONS", "GOVERNANCE", "DATA", "OTHER"];
const APP_VISIBILITIES: AppVisibility[] = ["PUBLIC_MARKETPLACE", "UNLISTED", "WORKSPACE_PRIVATE", "CORGTEX_MANAGED"];
const HOSTING_MODES: AppHostingMode[] = ["EXTERNAL_URL", "CORGTEX_MANAGED_EXTERNAL", "CORGTEX_HOSTED_STATIC", "CORGTEX_HOSTED_CONTAINER", "MCP_SERVER"];
const INTEGRATION_DEPTHS: AppIntegrationDepth[] = ["CATALOG_ONLY", "LAUNCHABLE", "MCP_ACTIONABLE", "KNOWLEDGE_SYNCED", "WORKFLOW_NATIVE"];
const INSTALLATION_STATUSES: AppInstallationStatus[] = ["REQUESTED", "APPROVED", "INSTALLED", "NEEDS_SETUP", "UNHEALTHY", "DISABLED"];
const RETIRED_MARKETPLACE_APP_KEYS = new Set(["practice-ledger"]);

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
  appCategory?: AppCategory;
  appVisibility?: AppVisibility;
  hostingMode?: AppHostingMode;
  integrationDepth?: AppIntegrationDepth;
  installationStatus?: AppInstallationStatus;
  supportUrl?: string | null;
  appMcpUrl?: string | null;
  dataClassification?: string | null;
  proofUrl?: string | null;
  reviewUrl?: string | null;
  manifestJson?: Record<string, unknown> | null;
  capabilitiesJson?: Record<string, unknown>[] | null;
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

function normalizeDataClassification(value: string | null | undefined) {
  return normalizeString(value)?.toUpperCase().replace(/[^A-Z0-9_]/g, "_").slice(0, 64) ?? "INTERNAL";
}

function enumOrDefault<T extends string>(value: string | null | undefined, allowed: readonly T[], fallback: T) {
  return allowed.includes(value as T) ? value as T : fallback;
}

function normalizeAppCategory(value: string | null | undefined): AppCategory {
  return enumOrDefault(value, APP_CATEGORIES, "OTHER");
}

function normalizeAppVisibility(value: string | null | undefined): AppVisibility {
  return enumOrDefault(value, APP_VISIBILITIES, "WORKSPACE_PRIVATE");
}

function normalizeHostingMode(value: string | null | undefined): AppHostingMode {
  return enumOrDefault(value, HOSTING_MODES, "EXTERNAL_URL");
}

function normalizeIntegrationDepth(value: string | null | undefined): AppIntegrationDepth {
  return enumOrDefault(value, INTEGRATION_DEPTHS, "CATALOG_ONLY");
}

function normalizeInstallationStatus(value: string | null | undefined): AppInstallationStatus {
  return enumOrDefault(value, INSTALLATION_STATUSES, "NEEDS_SETUP");
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
      accessNotesMd: "Workspace-admin installation only. Slack private channels and DMs are not ingested; public-channel context can be archived, summarized, and indexed.",
      url: `/api/integrations/slack/install?workspaceId=${workspaceId}`,
      category: "COMMUNICATION",
      accessMode: "ADMIN_ONLY",
      requestedScopes: ["integrations:read"],
      featured: true,
      manifestJson: connectorReadinessManifest("slack"),
    });
  }
  if (process.env.GOOGLE_CLIENT_ID && process.env.GOOGLE_CLIENT_SECRET) {
    sources.push({
      type: "CONNECTOR",
      sourceType: "OAUTH_CONNECTION",
      sourceId: "google",
      title: "Google Workspace",
      outcome: "Connect Google Calendar and selected Drive documents for meetings, docs, and follow-up work.",
      descriptionMd: "Connect a Google account for supported workspace integrations. Calendar sync is live; Drive document access should stay selected-file and least-privilege.",
      accessNotesMd: "User OAuth. Use selected Drive file access where possible instead of broad Drive scopes.",
      url: `/api/integrations/google/connect?workspaceId=${workspaceId}`,
      category: "CONNECTOR",
      accessMode: "OPEN",
      requestedScopes: ["meetings:read", "documents:write"],
      featured: true,
      manifestJson: connectorReadinessManifest("google"),
    });
  }
  if (process.env.MICROSOFT_CLIENT_ID && process.env.MICROSOFT_CLIENT_SECRET) {
    sources.push({
      type: "CONNECTOR",
      sourceType: "OAUTH_CONNECTION",
      sourceId: "microsoft",
      title: "Microsoft 365",
      outcome: "Connect Outlook calendar and selected OneDrive or SharePoint files where supported.",
      descriptionMd: "Connect a Microsoft account for supported workspace integrations. Outlook calendar sync is live; OneDrive and SharePoint document access should stay selected-source.",
      accessNotesMd: "User OAuth. Some tenants require publisher verification or admin consent before connection.",
      url: `/api/integrations/microsoft/connect?workspaceId=${workspaceId}`,
      category: "CONNECTOR",
      accessMode: "OPEN",
      requestedScopes: ["meetings:read", "documents:write"],
      featured: true,
      manifestJson: connectorReadinessManifest("microsoft"),
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
      url: null,
      category: "AI",
      accessMode: "OPEN",
      requestedScopes: ["workspace:read", "brain:read", "conversations:write"],
      featured: true,
      manifestJson: connectorReadinessManifest("corgtex-mcp"),
    });
  }
  if (flags.SETTINGS_GENERAL) {
    sources.push({
      type: "DATA_SOURCE",
      sourceType: "DATA_SOURCE",
      sourceId: "external-databases",
      title: "External databases",
      outcome: "Connect external PostgreSQL data for Corgtex search and automation.",
      descriptionMd: "Add and manage workspace-scoped external database feeds from the Tools catalog.",
      url: null,
      category: "DATA",
      accessMode: "ADMIN_ONLY",
      requestedScopes: ["data-sources:read"],
      featured: false,
    });

    sources.push({
      type: "TOOL",
      sourceType: "MANUAL",
      sourceId: "webhooks",
      title: "Webhooks",
      outcome: "Send and inspect workspace integration events for external systems.",
      descriptionMd: "Create signed outbound webhooks and inspect recent inbound webhook deliveries from the Tools catalog.",
      url: null,
      category: "OPERATIONS",
      accessMode: "ADMIN_ONLY",
      requestedScopes: ["integrations:read"],
      featured: false,
    });

    const meetingTranscriptSourcesEnabled = flags.MEETING_TRANSCRIPT_SOURCES || flags.MEETING_RECORDERS;
    sources.push({
      type: "TOOL",
      sourceType: "MEETING_RECORDER",
      sourceId: "meeting-recorder",
      title: "Meeting transcripts",
      outcome: "Import transcripts from existing recorders so Corgtex extracts proposals, action items, and Brain context.",
      descriptionMd: meetingTranscriptSourcesEnabled
        ? "Connect Read.ai, Fathom, or Fireflies, or upload transcript exports so Corgtex can process meeting evidence from the start."
        : "Initialize transcript import access, then connect Read.ai, Fathom, Fireflies, or upload transcript exports as the first onboarding context source.",
      url: null,
      category: "MEETINGS",
      accessMode: meetingTranscriptSourcesEnabled ? "OPEN" : "REQUEST",
      requestedScopes: ["meetings:read", "meetings:write", "brain:read"],
      featured: true,
      manifestJson: connectorReadinessManifest("meeting-recorder"),
    });
  }
  return sources;
}

function externalConnectorSources(): CatalogSourceInput[] {
  return listConnectorReadinessProfiles()
    .filter((profile) => ["box", "notion", "atlassian", "miro", "dropbox", "linear", "hubspot", "figma", "salesforce"].includes(profile.key))
    .map((profile) => {
      const featured = profile.recommended && profile.availability !== "ON_REQUEST" && profile.availability !== "RESEARCH";
      return {
        type: "CONNECTOR" as const,
        sourceType: "MCP_CONNECTOR" as const,
        sourceId: profile.key,
        title: profile.title,
        outcome: profile.key === "box"
          ? "Pilot Box as the priority client-file connector for read, search, and fetch workflows."
          : profile.key === "miro"
            ? "Request Miro board context and diagram workflows when a customer has Enterprise MCP enabled."
            : `Request ${profile.title} setup when this workspace already depends on it.`,
        descriptionMd: profile.key === "box"
          ? "Connect Box through hosted MCP and OAuth so Corgtex can save file references, summaries, and work-item links while Box remains the source of truth."
          : `${profile.title} has an official MCP or API path, but Corgtex has not enabled one-click connection for this workspace yet. ${profile.adminNotes}`,
        accessNotesMd: `${profile.connectedBy}. ${profile.storagePolicy}`,
        url: null,
        category: profile.connectorRole === "documents"
          ? "FILES"
          : profile.connectorRole === "whiteboard"
            ? "WHITEBOARD"
            : profile.connectorRole === "crm"
              ? "CRM"
              : profile.connectorRole === "design"
                ? "DESIGN"
                : "CONNECTOR",
        accessMode: profile.key === "box" && process.env.BOX_CLIENT_ID && process.env.BOX_CLIENT_SECRET ? "OPEN" as const : "REQUEST" as const,
        requestedScopes: ["integrations:read"],
        featured,
        manifestJson: connectorReadinessManifest(profile.key),
      };
    });
}

function aiWorkspaceSources(workspaceId: string, flags: CatalogFeatureFlags): CatalogSourceInput[] {
  if (!flags.AI_WORKSPACES) return [];

  return listAiWorkspaceToolProviders().map((provider) => {
    const isOpenWorkDefault = provider.key === "openwork" && flags.OPENWORK_DEFAULT;
    const category = provider.category === "DEFAULT"
      ? "AI_DEFAULT"
      : provider.category === "BYO"
        ? "AI_BYO"
        : "AI_ADVANCED";
    return {
      type: "CONNECTOR",
      sourceType: "AI_WORKSPACE",
      sourceId: provider.key,
      title: provider.label,
      outcome: provider.outcome,
      descriptionMd: provider.description,
      url: `/workspaces/${workspaceId}/settings?tab=ai-workspaces&provider=${provider.key}`,
      category,
      accessMode: provider.setupPath === "request" ? "REQUEST" : "OPEN",
      requestedScopes: ["workspace:read", "brain:read", "conversations:write"],
      featured: isOpenWorkDefault,
    };
  });
}

function managedEnterpriseServiceSources(workspaceId: string, flags: CatalogFeatureFlags): CatalogSourceInput[] {
  if (!flags.MANAGED_ENTERPRISE_SERVICES || !flags.AI_WORKSPACES) return [];

  return listEnterpriseServices()
    .filter((service) => service.key !== "meeting_recorder")
    .map((service) => ({
      type: "TOOL",
      sourceType: "ENTERPRISE_SERVICE",
      sourceId: service.key,
      title: service.label,
      outcome: service.outcome,
      descriptionMd: service.description,
      url: `/workspaces/${workspaceId}/settings?tab=ai-workspaces&service=${service.key}`,
      category: "ENTERPRISE_SERVICES",
      accessMode: "REQUEST",
      requestedScopes: ["workspace:read", "integrations:read", "runtime:read"],
      featured: false,
    }));
}

function isCatalogItemAvailable(item: Pick<CatalogItemRecord, "sourceType" | "sourceId">, flags: CatalogFeatureFlags) {
  if (item.sourceType === "AGENT_CONFIG" || item.sourceType === "AGENT_IDENTITY") {
    return flags.AGENT_GOVERNANCE;
  }
  if (item.sourceType === "BUILD_ARTIFACT") {
    return flags.BUILD_ARTIFACTS;
  }
  if (item.sourceType === "MEETING_RECORDER") {
    return flags.SETTINGS_GENERAL;
  }
  if (item.sourceType === "DATA_SOURCE") {
    return flags.SETTINGS_GENERAL;
  }
  if (item.sourceType === "MCP_CONNECTOR") {
    return flags.SETTINGS_GENERAL;
  }
  if (item.sourceType === "AI_WORKSPACE") {
    return flags.AI_WORKSPACES;
  }
  if (item.sourceType === "ENTERPRISE_SERVICE") {
    return flags.MANAGED_ENTERPRISE_SERVICES && flags.AI_WORKSPACES;
  }
  if (item.sourceType === "MARKETPLACE_APP") {
    return flags.APP_MARKETPLACE;
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
        status: (config?.enabled ?? ("defaultEnabled" in meta ? meta.defaultEnabled : true))
          ? "PUBLISHED" as const : "DISABLED" as const,
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
    ...externalConnectorSources(),
    ...aiWorkspaceSources(workspaceId, featureFlags),
    ...managedEnterpriseServiceSources(workspaceId, featureFlags),
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
      appCategory: source.appCategory ?? "OTHER",
      appVisibility: source.appVisibility ?? "WORKSPACE_PRIVATE",
      hostingMode: source.hostingMode ?? "EXTERNAL_URL",
      integrationDepth: source.integrationDepth ?? "CATALOG_ONLY",
      installationStatus: source.installationStatus ?? "INSTALLED",
      supportUrl: normalizeString(source.supportUrl),
      appMcpUrl: normalizeString(source.appMcpUrl),
      dataClassification: normalizeDataClassification(source.dataClassification),
      proofUrl: normalizeString(source.proofUrl),
      reviewUrl: normalizeString(source.reviewUrl),
      manifestJson: source.manifestJson ? toInputJson(source.manifestJson) : undefined,
      capabilitiesJson: source.capabilitiesJson ? toInputJson(source.capabilitiesJson) : undefined,
    },
    update: {
      createdByUserId: source.createdByUserId ?? undefined,
      ownerUserId: source.ownerUserId ?? undefined,
      type: source.type,
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
      appCategory: source.appCategory ?? "OTHER",
      appVisibility: source.appVisibility ?? "WORKSPACE_PRIVATE",
      hostingMode: source.hostingMode ?? "EXTERNAL_URL",
      integrationDepth: source.integrationDepth ?? "CATALOG_ONLY",
      supportUrl: normalizeString(source.supportUrl),
      appMcpUrl: normalizeString(source.appMcpUrl),
      dataClassification: normalizeDataClassification(source.dataClassification),
      proofUrl: normalizeString(source.proofUrl),
      reviewUrl: normalizeString(source.reviewUrl),
      manifestJson: source.manifestJson ? toInputJson(source.manifestJson) : undefined,
      capabilitiesJson: source.capabilitiesJson ? toInputJson(source.capabilitiesJson) : undefined,
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
    appCategory: params.item.appCategory,
    appVisibility: params.item.appVisibility,
    hostingMode: params.item.hostingMode,
    integrationDepth: params.item.integrationDepth,
    installationStatus: params.item.installationStatus,
    supportUrl: params.item.supportUrl,
    appMcpUrl: params.item.appMcpUrl,
    dataClassification: params.item.dataClassification,
    proofUrl: params.item.proofUrl,
    reviewUrl: params.item.reviewUrl,
    manifestJson: params.item.manifestJson,
    capabilitiesJson: params.item.capabilitiesJson,
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

function payloadRecordArray(payload: Record<string, unknown>, key: string) {
  const value = payload[key];
  return Array.isArray(value)
    ? value.filter((entry): entry is Record<string, unknown> => Boolean(entry) && typeof entry === "object" && !Array.isArray(entry))
    : null;
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
      const capabilities = payloadRecordArray(payload, "capabilities");
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
          category: payloadString(payload, "category") ?? payloadString(payload, "appCategory") ?? "VIBE_CODED",
          status: "PUBLISHED",
          accessMode: "REQUEST",
          requestedScopes: request.requestedScopes,
          monthlyBudgetCents: request.requestedBudgetCents,
          dailyCallLimit: request.requestedDailyCallLimit,
          appCategory: normalizeAppCategory(payloadString(payload, "appCategory") ?? payloadString(payload, "category")),
          appVisibility: normalizeAppVisibility(payloadString(payload, "appVisibility")),
          hostingMode: normalizeHostingMode(payloadString(payload, "hostingMode")),
          integrationDepth: normalizeIntegrationDepth(payloadString(payload, "integrationDepth")),
          installationStatus: normalizeInstallationStatus(payloadString(payload, "installationStatus")),
          supportUrl: payloadString(payload, "supportUrl"),
          appMcpUrl: payloadString(payload, "appMcpUrl"),
          dataClassification: normalizeDataClassification(payloadString(payload, "dataClassification")),
          proofUrl,
          reviewUrl: payloadString(payload, "reviewUrl"),
          manifestJson: payload.manifestJson ? toInputJson(payloadRecord(payload.manifestJson as Prisma.JsonValue)) : undefined,
          capabilitiesJson: capabilities ? toInputJson(capabilities) : undefined,
        },
        select: { id: true },
      });
      catalogItemId = item.id;
    }

    if (params.status === "APPROVED" && request.type === "ACCESS" && request.catalogItemId) {
      await tx.catalogItem.update({
        where: { id: request.catalogItemId },
        data: {
          installationStatus: request.catalogItem?.url || request.catalogItem?.appMcpUrl ? "INSTALLED" : "APPROVED",
        },
      });
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

type SerializedCatalogItem = ReturnType<typeof serializeCatalogItem>;

function isMarketplaceApp(item: SerializedCatalogItem) {
  return item.type === "APP";
}

function isInstalledAppStatus(status: AppInstallationStatus) {
  return status === "APPROVED" || status === "INSTALLED";
}

function appKey(item: SerializedCatalogItem) {
  return item.sourceId ?? item.slug;
}

function capabilityKeys(item: SerializedCatalogItem) {
  const value = item.capabilitiesJson;
  return Array.isArray(value)
    ? value.map((entry) => {
        const record = entry && typeof entry === "object" && !Array.isArray(entry)
          ? entry as Record<string, unknown>
          : null;
        return typeof record?.key === "string" ? record.key : null;
      }).filter((key): key is string => Boolean(key))
    : [];
}

function appSummary(item: SerializedCatalogItem) {
  return {
    id: item.id,
    appKey: appKey(item),
    title: item.title,
    category: item.appCategory,
    visibility: item.appVisibility,
    hostingMode: item.hostingMode,
    integrationDepth: item.integrationDepth,
    installationStatus: item.installationStatus,
    launchUrl: item.url,
    appMcpUrl: item.appMcpUrl,
    supportUrl: item.supportUrl,
    dataClassification: item.dataClassification,
    requestedScopes: item.requestedScopes,
    capabilities: capabilityKeys(item),
    webCategory: item.category,
  };
}

function appMatches(item: SerializedCatalogItem, value: string) {
  const normalized = value.trim().toLowerCase();
  return item.id === value ||
    appKey(item).toLowerCase() === normalized ||
    item.slug.toLowerCase() === normalized ||
    item.title.toLowerCase() === normalized;
}

function activeMarketplaceApps(items: SerializedCatalogItem[]) {
  return items.filter((item) => isMarketplaceApp(item) && !RETIRED_MARKETPLACE_APP_KEYS.has(appKey(item).toLowerCase()));
}

function financeIntent(intent: string, recordType?: string | null) {
  const text = `${intent} ${recordType ?? ""}`.toLowerCase();
  return /\b(expense|expenses|receipt|receipts|invoice|invoices|statement|statements|budget|budgets|billing|billable|time entr|timesheet|hours|margin|burn|purchase order|po)\b/.test(text);
}

function corgtexNativeIntent(intent: string, recordType?: string | null) {
  const text = `${intent} ${recordType ?? ""}`.toLowerCase();
  return /\b(proposal|proposals|action|actions|tension|tensions|brain|knowledge|policy|governance|decision|decisions|meeting|meetings|role|roles|circle|circles)\b/.test(text);
}

function findApp(items: SerializedCatalogItem[], params: { catalogItemId?: string | null; appKey?: string | null }) {
  if (params.catalogItemId) {
    return items.find((item) => item.id === params.catalogItemId) ?? null;
  }
  if (params.appKey) {
    return items.find((item) => appMatches(item, params.appKey ?? "")) ?? null;
  }
  return null;
}

export async function listInstalledApps(actor: AppActor, params: {
  workspaceId: string;
}) {
  const catalog = await listCatalogItems(actor, params.workspaceId);
  const apps = activeMarketplaceApps(catalog.items);
  const installed = apps.filter((item) => isInstalledAppStatus(item.installationStatus)).map(appSummary);
  const available = apps.filter((item) => !isInstalledAppStatus(item.installationStatus) && item.installationStatus !== "DISABLED").map(appSummary);
  return {
    installed,
    available,
    webUrl: `/workspaces/${params.workspaceId}/tools?type=APP`,
  };
}

export async function getAppRoutingGuidance(actor: AppActor, params: {
  workspaceId: string;
  intent: string;
  recordType?: string | null;
}) {
  const catalog = await listCatalogItems(actor, params.workspaceId);
  const apps = activeMarketplaceApps(catalog.items);
  const installed = apps.filter((item) => isInstalledAppStatus(item.installationStatus));
  const available = apps.filter((item) => !isInstalledAppStatus(item.installationStatus) && item.installationStatus !== "DISABLED");

  if (financeIntent(params.intent, params.recordType)) {
    return {
      routing: "CORGTEX_MCP",
      target: {
        appKey: "corgtex",
        title: "Corgtex Finance",
      },
      guidance: "Use the native Corgtex Finance shell for Finance navigation. Do not route finance writes to the retired Practice Ledger app runtime.",
      corgtexDoesNotProxyWrites: false,
    };
  }

  if (corgtexNativeIntent(params.intent, params.recordType)) {
    return {
      routing: "CORGTEX_MCP",
      target: {
        appKey: "corgtex",
        title: "Corgtex",
      },
      guidance: "Use Corgtex MCP for Brain, proposals, actions, tensions, governance, meetings, roles, circles, and company context.",
      corgtexDoesNotProxyWrites: false,
    };
  }

  return {
    routing: "AGENT_DECIDES",
    guidance: "Choose between Corgtex MCP and installed app MCPs based on the record owner. Corgtex owns company context, Brain, governance, and routing guidance; deep apps own their own structured records.",
    installedApps: installed.map(appSummary),
    availableApps: available.map(appSummary),
  };
}

export async function getAppConnectionInstructions(actor: AppActor, params: {
  workspaceId: string;
  catalogItemId?: string | null;
  appKey?: string | null;
}) {
  const catalog = await listCatalogItems(actor, params.workspaceId);
  const app = findApp(activeMarketplaceApps(catalog.items), params);
  invariant(app, 404, "NOT_FOUND", "App not found.");
  const summary = appSummary(app);
  return {
    app: summary,
    instructions: [
      "Install or approve the app in Corgtex Tools for this workspace.",
      "Connect the app's MCP/server in the user's agent environment when structured app writes are needed.",
      "Keep Corgtex MCP connected for company context, Brain, governance, routing guidance, and audit context.",
      "Do not write structured app records into Corgtex Brain as the canonical database; let the app own those records and sync Brain context back to Corgtex.",
    ],
    connectionReady: isInstalledAppStatus(app.installationStatus) && Boolean(app.appMcpUrl || app.url),
    webUrl: `/workspaces/${params.workspaceId}/tools/${app.id}`,
  };
}

export async function requestAppInstall(actor: AppActor, params: {
  workspaceId: string;
  catalogItemId?: string | null;
  appKey?: string | null;
  reasonMd?: string | null;
}) {
  const catalog = await listCatalogItems(actor, params.workspaceId);
  const app = findApp(activeMarketplaceApps(catalog.items), params);
  invariant(app, 404, "NOT_FOUND", "App not found.");
  const request = await createCatalogRequest(actor, {
    workspaceId: params.workspaceId,
    catalogItemId: app.id,
    type: "ACCESS",
    reasonMd: params.reasonMd ?? `Install ${app.title} for this workspace.`,
    requestedScopes: app.requestedScopes,
  });
  return {
    request,
    app: appSummary(app),
    webUrl: `/workspaces/${params.workspaceId}/tools/${app.id}`,
  };
}
