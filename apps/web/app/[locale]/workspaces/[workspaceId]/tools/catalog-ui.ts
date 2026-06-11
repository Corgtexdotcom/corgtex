export type CatalogItemType = "APP" | "AGENT" | "TOOL" | "AUTOMATION" | "CONNECTOR" | "DATA_SOURCE";
export type CatalogAccessMode = "OPEN" | "REQUEST" | "ADMIN_ONLY" | "DISABLED";
export type CatalogRequestType = "ACCESS" | "API_KEY" | "BUDGET_INCREASE" | "PUBLISH";
export type AppCategory = "FINANCE" | "KNOWLEDGE" | "COMMUNICATION" | "AI" | "OPERATIONS" | "GOVERNANCE" | "DATA" | "OTHER";
export type AppInstallationStatus = "REQUESTED" | "APPROVED" | "INSTALLED" | "NEEDS_SETUP" | "UNHEALTHY" | "DISABLED";
export type AppIntegrationDepth = "CATALOG_ONLY" | "LAUNCHABLE" | "MCP_ACTIONABLE" | "KNOWLEDGE_SYNCED" | "WORKFLOW_NATIVE";

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

export const TYPE_ORDER: CatalogItemType[] = ["CONNECTOR", "APP", "AGENT", "TOOL", "AUTOMATION", "DATA_SOURCE"];

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
        item.type,
      ].some((value) => value?.toLowerCase().includes(normalizedQuery));
    })
    .sort(catalogItemComparator);
}

export function splitDefaultCatalogSections<T extends CatalogItemForUi>(items: T[]) {
  const sorted = [...items].sort(catalogItemComparator);
  return {
    connectors: sorted.filter((item) => item.type === "CONNECTOR"),
    catalog: sorted.filter((item) => item.type !== "CONNECTOR"),
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
    if (disabled) return [{ kind: "status", label: "Disabled" }, details];
    if (item.accessMode === "ADMIN_ONLY" && !canManageCatalog) {
      return [{ kind: "status", label: "Admin setup required" }, details];
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
