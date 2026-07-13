export type CatalogItemType = "APP" | "AGENT" | "TOOL" | "AUTOMATION" | "CONNECTOR" | "DATA_SOURCE";
type CatalogAccessMode = "OPEN" | "REQUEST" | "ADMIN_ONLY" | "DISABLED";
export type CatalogRequestType = "ACCESS" | "API_KEY" | "BUDGET_INCREASE" | "PUBLISH";
export type AppCategory = "FINANCE" | "KNOWLEDGE" | "COMMUNICATION" | "AI" | "OPERATIONS" | "GOVERNANCE" | "DATA" | "OTHER";
export type AppInstallationStatus = "REQUESTED" | "APPROVED" | "INSTALLED" | "NEEDS_SETUP" | "UNHEALTHY" | "DISABLED";
export type AppIntegrationDepth = "CATALOG_ONLY" | "LAUNCHABLE" | "MCP_ACTIONABLE" | "KNOWLEDGE_SYNCED" | "WORKFLOW_NATIVE";
type CatalogConnectorAvailability = "LIVE" | "PILOT_READY" | "ON_REQUEST" | "MANUAL_ONLY" | "RESEARCH";
export type ToolsSurface = "LINKS" | "APPS" | "ALL";

export type CatalogConnectorReadiness = {
  key: string;
  title: string;
  availability: CatalogConnectorAvailability;
  connectMethod: string;
  connectorRole: string;
  connectedBy: string;
  supportedOperations: string[];
  storagePolicy: string;
  sourceUrl: string;
  adminNotes: string;
  recommended: boolean;
  recommendationRank: number;
};

export type CatalogItemForUi = {
  id: string;
  type: CatalogItemType;
  sourceType?: string;
  sourceId?: string | null;
  title: string;
  outcome: string | null;
  descriptionMd: string | null;
  url: string | null;
  category: string;
  status: "DRAFT" | "PUBLISHED" | "REQUEST_ONLY" | "DISABLED" | "ARCHIVED";
  accessMode: CatalogAccessMode;
  featured: boolean;
  isFavorite: boolean;
  appCategory: AppCategory;
  installationStatus: AppInstallationStatus;
  integrationDepth: AppIntegrationDepth;
  appMcpUrl: string | null;
  manifestJson?: unknown;
  capabilitiesJson?: unknown;
  pendingRequestCount?: number;
};

export type CatalogFilterState = {
  activeType: CatalogItemType | "ALL";
  query: string;
};

export type CatalogSearchParamValue = string | string[] | undefined;

export type CatalogCardAction =
  | {
      kind: "link";
      label: string;
      href: string;
      variant: "primary" | "secondary";
    }
  | {
      kind: "request";
      label: string;
      requestType: CatalogRequestType;
      variant: "primary" | "secondary";
    }
  | {
      kind: "status";
      label: string;
    };

export const TYPE_ORDER: CatalogItemType[] = ["APP", "CONNECTOR", "AGENT", "TOOL", "AUTOMATION", "DATA_SOURCE"];

const TYPE_RANK = new Map(TYPE_ORDER.map((type, index) => [type, index]));

function firstSearchParam(value: CatalogSearchParamValue) {
  return Array.isArray(value) ? value[0] : value;
}

export function normalizeCatalogType(value: CatalogSearchParamValue): CatalogItemType | "ALL" {
  const type = firstSearchParam(value);
  return TYPE_ORDER.includes(type as CatalogItemType) ? type as CatalogItemType : "ALL";
}

export function normalizeCatalogQuery(value: CatalogSearchParamValue) {
  return firstSearchParam(value)?.slice(0, 120) ?? "";
}

export function normalizeToolsSurface(value: CatalogSearchParamValue): ToolsSurface {
  const surface = firstSearchParam(value)?.toLowerCase();
  if (surface === "apps") return "APPS";
  if (surface === "all") return "ALL";
  return "LINKS";
}

export function hasCatalogFilter({ activeType, query }: CatalogFilterState) {
  return activeType !== "ALL" || query.trim().length > 0;
}

export function catalogItemComparator(a: CatalogItemForUi, b: CatalogItemForUi) {
  return (TYPE_RANK.get(a.type) ?? TYPE_ORDER.length) - (TYPE_RANK.get(b.type) ?? TYPE_ORDER.length)
    || Number(b.featured) - Number(a.featured)
    || Number(b.isFavorite) - Number(a.isFavorite)
    || a.title.localeCompare(b.title);
}

export function filterCatalogItems<T extends CatalogItemForUi>(items: T[], { activeType, query }: CatalogFilterState) {
  const normalizedQuery = query.trim().toLowerCase();
  return [...items]
    .filter((item) => activeType === "ALL" || item.type === activeType)
    .filter((item) => {
      if (!normalizedQuery) return true;
      return [
        item.title,
        item.outcome,
        item.descriptionMd,
        item.category,
        item.appCategory,
        item.integrationDepth,
        item.installationStatus,
        connectorReadinessForItem(item)?.availability,
        connectorReadinessForItem(item)?.connectorRole,
        connectorReadinessForItem(item)?.connectedBy,
        item.type,
      ].some((value) => value?.toLowerCase().includes(normalizedQuery));
    })
    .sort(catalogItemComparator);
}

function recordValue(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : null;
}

function stringListValue(value: unknown) {
  return Array.isArray(value) ? value.filter((entry): entry is string => typeof entry === "string") : [];
}

function stringValue(value: unknown) {
  return typeof value === "string" ? value : "";
}

function booleanValue(value: unknown) {
  return value === true;
}

function numberValue(value: unknown) {
  return typeof value === "number" && Number.isFinite(value) ? value : 999;
}

export function connectorReadinessForItem(item: CatalogItemForUi): CatalogConnectorReadiness | null {
  const manifest = recordValue(item.manifestJson);
  const readiness = recordValue(manifest?.connectorReadiness);
  const availability = stringValue(readiness?.availability);
  if (!readiness || !["LIVE", "PILOT_READY", "ON_REQUEST", "MANUAL_ONLY", "RESEARCH"].includes(availability)) return null;

  return {
    key: stringValue(readiness.key) || item.sourceId || item.id,
    title: stringValue(readiness.title) || item.title,
    availability: availability as CatalogConnectorAvailability,
    connectMethod: stringValue(readiness.connectMethod),
    connectorRole: stringValue(readiness.connectorRole),
    connectedBy: stringValue(readiness.connectedBy),
    supportedOperations: stringListValue(readiness.supportedOperations),
    storagePolicy: stringValue(readiness.storagePolicy),
    sourceUrl: stringValue(readiness.sourceUrl),
    adminNotes: stringValue(readiness.adminNotes),
    recommended: booleanValue(readiness.recommended),
    recommendationRank: numberValue(readiness.recommendationRank),
  };
}

function readinessSort<T extends CatalogItemForUi>(a: T, b: T) {
  const left = connectorReadinessForItem(a);
  const right = connectorReadinessForItem(b);
  return (left?.recommendationRank ?? 999) - (right?.recommendationRank ?? 999)
    || catalogItemComparator(a, b);
}

function isLiveSetupItem(item: CatalogItemForUi) {
  const readiness = connectorReadinessForItem(item);
  return readiness?.availability === "LIVE";
}

function isRecommendedSetupItem(item: CatalogItemForUi) {
  const readiness = connectorReadinessForItem(item);
  return Boolean(readiness?.recommended && readiness.availability !== "LIVE" && readiness.connectMethod !== "external_mcp");
}

function isAvailableOnRequestItem(item: CatalogItemForUi) {
  const readiness = connectorReadinessForItem(item);
  return Boolean(readiness && readiness.availability !== "LIVE" && (!readiness.recommended || readiness.connectMethod === "external_mcp"));
}

function isAppsAndSharedLinksItem(item: CatalogItemForUi) {
  return item.type !== "CONNECTOR" && !isLiveSetupItem(item) && !isRecommendedSetupItem(item) && !isAvailableOnRequestItem(item);
}

export function splitDefaultCatalogSections<T extends CatalogItemForUi>(items: T[]) {
  const sorted = [...items].sort(readinessSort);
  const liveSetup = sorted.filter(isLiveSetupItem);
  const recommendedSetup = sorted.filter(isRecommendedSetupItem).slice(0, 6);
  const used = new Set([...liveSetup, ...recommendedSetup].map((item) => item.id));
  const availableOnRequest = sorted.filter((item) => isAvailableOnRequestItem(item) && !used.has(item.id));
  const appsAndLinks = sorted.filter((item) => isAppsAndSharedLinksItem(item) && !used.has(item.id));
  return {
    liveSetup,
    recommendedSetup,
    availableOnRequest,
    appsAndLinks,
    connectors: liveSetup,
    catalog: sorted.filter((item) => !used.has(item.id) && !availableOnRequest.some((entry) => entry.id === item.id)),
  };
}

function isAiWorkspaceItem(item: CatalogItemForUi) {
  return item.category === "AI_DEFAULT" || item.category === "AI_BYO" || item.category === "AI_ADVANCED";
}

function isEnterpriseServiceItem(item: CatalogItemForUi) {
  return item.category === "ENTERPRISE_SERVICES";
}

function isToolSetupItem(item: CatalogItemForUi) {
  return item.sourceType === "MEETING_RECORDER"
    || item.sourceType === "DATA_SOURCE"
    || (item.sourceType === "MANUAL" && item.sourceId === "webhooks")
    || item.sourceType === "AI_WORKSPACE"
    || item.sourceType === "ENTERPRISE_SERVICE";
}

function isRequestOnlyExternalMcpConnector(item: CatalogItemForUi) {
  const readiness = connectorReadinessForItem(item);
  return Boolean(item.type === "CONNECTOR" && readiness?.connectMethod === "external_mcp" && readiness.availability !== "LIVE");
}

export function getCatalogCardActions(
  item: CatalogItemForUi,
  { workspaceId, canManageCatalog }: { workspaceId: string; canManageCatalog: boolean },
): CatalogCardAction[] {
  const disabled = item.status === "DISABLED" || item.accessMode === "DISABLED";
  const details: CatalogCardAction = {
    kind: "link",
    label: "Details",
    href: `/workspaces/${workspaceId}/tools/${item.id}`,
    variant: "secondary",
  };

  if (!disabled && isToolSetupItem(item) && item.accessMode === "ADMIN_ONLY" && !canManageCatalog) {
    return [{ kind: "status", label: "Admin setup required" }, details];
  }

  if (item.type === "CONNECTOR") {
    const readiness = connectorReadinessForItem(item);
    if (disabled) return [{ kind: "status", label: "Disabled" }, details];
    if (item.accessMode === "ADMIN_ONLY" && !canManageCatalog) {
      return [{ kind: "status", label: "Admin setup required" }, details];
    }
    if (isRequestOnlyExternalMcpConnector(item)) {
      return [{ kind: "status", label: "Request-only connector" }, details];
    }
    if (item.accessMode === "REQUEST" || (readiness && readiness.availability !== "LIVE")) {
      return [
        { kind: "request", label: readiness?.availability === "RESEARCH" ? "Request review" : "Request setup", requestType: "ACCESS", variant: "primary" },
        details,
      ];
    }
    return [{
      kind: "link",
      label: isAiWorkspaceItem(item) ? "Set up" : "Connect",
      href: details.href,
      variant: "primary",
    }];
  }

  if (item.type === "APP" || item.type === "TOOL") {
    if (disabled) return [details];
    if (isToolSetupItem(item)) {
      const actions: CatalogCardAction[] = [{
        kind: "link",
        label: item.accessMode === "REQUEST" ? "View setup" : "Manage",
        href: details.href,
        variant: "primary",
      }];
      if (item.accessMode === "REQUEST") {
        actions.push({ kind: "request", label: "Request access", requestType: "ACCESS", variant: "secondary" });
      }
      return actions;
    }
    if (item.type === "APP") {
      if (item.installationStatus === "INSTALLED" && item.url) {
        return [{ kind: "link", label: "Open app", href: item.url, variant: "primary" }, details];
      }
      if (item.installationStatus === "APPROVED") {
        return item.url
          ? [{ kind: "link", label: "Open setup", href: item.url, variant: "primary" }, details]
          : [{ kind: "status", label: "Approved" }, details];
      }
      if (item.installationStatus === "REQUESTED" || (item.pendingRequestCount ?? 0) > 0) {
        return [{ kind: "status", label: "Requested" }, details];
      }
      return [{ kind: "request", label: "Request install", requestType: "ACCESS", variant: "primary" }, details];
    }
    if (isEnterpriseServiceItem(item)) {
      const actions: CatalogCardAction[] = [];
      if (item.url) {
        actions.push({ kind: "link", label: "Open setup", href: item.url, variant: "primary" });
      }
      if (item.accessMode === "REQUEST") {
        actions.push({ kind: "request", label: "Request managed service", requestType: "ACCESS", variant: item.url ? "secondary" : "primary" });
      }
      return [...actions, details];
    }
    if (item.accessMode === "OPEN" && item.url) {
      return [{ kind: "link", label: "Open", href: item.url, variant: "primary" }, details];
    }
    return [{ kind: "request", label: "Request access", requestType: "ACCESS", variant: "primary" }, details];
  }

  if (disabled) return [details];
  if (item.type === "DATA_SOURCE" || isToolSetupItem(item)) {
    return [{ kind: "link", label: "Manage", href: details.href, variant: "primary" }];
  }
  if (item.url && (item.accessMode !== "ADMIN_ONLY" || canManageCatalog)) {
    const label = item.type === "AGENT" ? "Manage" : "Open settings";
    return [{ kind: "link", label, href: item.url, variant: "primary" }, details];
  }
  return [details];
}
