export type CatalogItemType = "APP" | "AGENT" | "TOOL" | "AUTOMATION" | "CONNECTOR" | "DATA_SOURCE";
export type CatalogAccessMode = "OPEN" | "REQUEST" | "ADMIN_ONLY" | "DISABLED";
export type CatalogRequestType = "ACCESS" | "API_KEY" | "BUDGET_INCREASE" | "PUBLISH";

export type CatalogItemForUi = {
  id: string;
  type: CatalogItemType;
  title: string;
  outcome: string | null;
  descriptionMd: string | null;
  url: string | null;
  category: string;
  status: "DRAFT" | "PUBLISHED" | "REQUEST_ONLY" | "DISABLED" | "ARCHIVED";
  accessMode: CatalogAccessMode;
  featured: boolean;
  isFavorite: boolean;
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

  if (item.type === "CONNECTOR") {
    if (disabled) return [{ kind: "status", label: "Disabled" }, details];
    if (item.accessMode === "ADMIN_ONLY" && !canManageCatalog) {
      return [{ kind: "status", label: "Admin setup required" }, details];
    }
    return item.url
      ? [{ kind: "link", label: "Connect", href: item.url, variant: "primary" }, details]
      : [details];
  }

  if (item.type === "APP" || item.type === "TOOL") {
    if (disabled) return [details];
    if (item.accessMode === "OPEN" && item.url) {
      return [{ kind: "link", label: "Open", href: item.url, variant: "primary" }, details];
    }
    return [{ kind: "request", label: "Request access", requestType: "ACCESS", variant: "primary" }, details];
  }

  if (disabled) return [details];
  if (item.url && (item.accessMode !== "ADMIN_ONLY" || canManageCatalog)) {
    const label = item.type === "AGENT" ? "Manage" : "Open settings";
    return [{ kind: "link", label, href: item.url, variant: "primary" }, details];
  }
  return [details];
}
