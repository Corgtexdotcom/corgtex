export type CatalogItemType = "APP" | "AGENT" | "TOOL" | "AUTOMATION" | "CONNECTOR" | "DATA_SOURCE";
type CatalogAccessMode = "OPEN" | "REQUEST" | "ADMIN_ONLY" | "DISABLED";
export type CatalogRequestType = "ACCESS" | "API_KEY" | "BUDGET_INCREASE" | "PUBLISH";
export type AppCategory = "FINANCE" | "KNOWLEDGE" | "COMMUNICATION" | "AI" | "OPERATIONS" | "GOVERNANCE" | "DATA" | "OTHER";
export type AppInstallationStatus = "REQUESTED" | "APPROVED" | "INSTALLED" | "NEEDS_SETUP" | "UNHEALTHY" | "DISABLED";
export type AppIntegrationDepth = "CATALOG_ONLY" | "LAUNCHABLE" | "MCP_ACTIONABLE" | "KNOWLEDGE_SYNCED" | "WORKFLOW_NATIVE";
type CatalogConnectorAvailability = "LIVE" | "PILOT_READY" | "ON_REQUEST" | "MANUAL_ONLY" | "RESEARCH";
export type ToolsSurface = "LINKS" | "APPS" | "ALL";

export type LinkLibraryTypeInput = {
  resourceType?: string | null;
  mimeType?: string | null;
  category?: string | null;
  title?: string | null;
  descriptionMd?: string | null;
  url: string;
};

export type CapturedLinkDisplayInput = LinkLibraryTypeInput & {
  providerKey: string;
  providerLabel: string;
  resourceTitle?: string | null;
  manualTitle?: string | null;
  manualPreviewTitle?: string | null;
  sourceLabel?: string | null;
  sourceText?: string | null;
  summaryMd?: string | null;
  resourceDescriptionMd?: string | null;
  manualDescriptionMd?: string | null;
  manualPreviewDescription?: string | null;
  manualAccessNotesMd?: string | null;
};

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

function displayEnumValue(value: string) {
  return value.replace(/_/g, " ").toLowerCase().replace(/\b\w/g, (letter) => letter.toUpperCase());
}

function cleanDisplayText(value?: string | null, maxLength = 4000) {
  const trimmed = value?.replace(/\s+/g, " ").trim() ?? "";
  return trimmed ? trimmed.slice(0, maxLength) : null;
}

function normalizedDisplayText(value?: string | null) {
  return cleanDisplayText(value)
    ?.toLowerCase()
    .replace(/[_-]+/g, " ")
    .replace(/[^a-z0-9]+/g, " ")
    .replace(/\s+/g, " ")
    .trim() ?? "";
}

function pathSegments(url: string) {
  try {
    return new URL(url).pathname.split("/").filter(Boolean).map((segment) => {
      try {
        return decodeURIComponent(segment);
      } catch {
        return segment;
      }
    });
  } catch {
    return [];
  }
}

function lastUrlSegment(url: string) {
  return pathSegments(url).at(-1) ?? null;
}

function isUrlLike(value: string) {
  return value.startsWith("http://") || value.startsWith("https://");
}

function isOpaqueToken(value?: string | null) {
  const normalized = value?.trim() ?? "";
  return /^[a-z0-9]{16,}$/i.test(normalized) || /^[a-f0-9]{12,}$/i.test(normalized);
}

function isUsefulDisplayTitle(
  value: string | null | undefined,
  input: CapturedLinkDisplayInput,
  { rejectOpaqueToken = false }: { rejectOpaqueToken?: boolean } = {},
) {
  const title = cleanDisplayText(value, 160);
  if (!title || isUrlLike(title)) return false;
  const normalizedTitle = normalizedDisplayText(title);
  if (!normalizedTitle) return false;
  const lastSegment = lastUrlSegment(input.url);
  if (input.providerKey === "box" && (
    (rejectOpaqueToken && isOpaqueToken(title))
    || normalizedTitle === normalizedDisplayText(lastSegment)
    || /^Box (document|file|folder|link|presentation|spreadsheet)$/i.test(title)
  )) {
    return false;
  }
  return true;
}

export function inferLinkLibraryType(input: LinkLibraryTypeInput) {
  const haystack = `${input.resourceType ?? ""} ${input.mimeType ?? ""} ${input.category ?? ""} ${input.title ?? ""} ${input.descriptionMd ?? ""} ${input.url}`.toLowerCase();
  if (haystack.includes("folder") || haystack.includes("/folder/") || haystack.includes("/folders/")) return "Folder";
  if (haystack.includes("spreadsheet") || haystack.includes("sheet") || haystack.includes("tracker") || haystack.includes("workbook")) return "Spreadsheet";
  if (haystack.includes("presentation") || haystack.includes("powerpoint") || haystack.includes("slide") || haystack.includes("pptx")) return "Presentation";
  if (haystack.includes("pdf") || haystack.includes("document") || haystack.includes("docx") || haystack.includes("file")) return "Document";
  if (input.resourceType && input.resourceType.toLowerCase() !== "link") return displayEnumValue(input.resourceType);
  if (input.category === "FILES" || input.category === "DOCUMENTS") return "Document";
  return "Link";
}

function stripUrls(value: string) {
  return value
    .replace(/<((?:https?:\/\/)[^>|]+)(?:\|([^>]*))?>/g, (_match, _url: string, label?: string) => label ? ` ${label} ` : " ")
    .replace(/\bhttps?:\/\/[^\s<>"']+/g, " ");
}

function firstSentence(value: string) {
  return value.split(/(?<=[.!?])\s+/)[0]?.trim() ?? value.trim();
}

function trimTitleCandidate(value: string) {
  return cleanDisplayText(value.replace(/^[-:;,\s]+|[-:;,\s]+$/g, ""), 96);
}

const DOCUMENT_TERM_PATTERN = "powerpoint|presentation|pptx|spreadsheet|tracker|workbook|document|docx?|pdf|file|folder|model|report|deck|slides?|sheet";

function containsDocumentTerm(value: string) {
  return new RegExp(`\\b(${DOCUMENT_TERM_PATTERN})\\b`, "i").test(value.replace(/[_-]+/g, " "));
}

function sourceTextUrlCount(sourceText?: string | null) {
  return sourceText?.match(/<https?:\/\/[^>|]+(?:\|[^>]*)?>|\bhttps?:\/\/[^\s<>"']+/g)?.length ?? 0;
}

function hasAdjacentDocumentTermForQuote(cleaned: string, index: number, length: number) {
  const before = cleaned.slice(0, index).replace(/[_-]+/g, " ").trim();
  const after = cleaned.slice(index + length).replace(/[_-]+/g, " ").trim();
  return new RegExp(`\\b(${DOCUMENT_TERM_PATTERN})\\s*[-:(]?$`, "i").test(before)
    || new RegExp(`^[-:)]?\\s*\\b(${DOCUMENT_TERM_PATTERN})\\b`, "i").test(after);
}

function inferTitleFromSourceText(sourceText?: string | null) {
  if (sourceTextUrlCount(sourceText) > 1) return null;
  const cleaned = cleanDisplayText(stripUrls(sourceText ?? ""), 1200);
  if (!cleaned) return null;

  for (const match of cleaned.matchAll(/["'“”]([^"'“”]{3,96})["'“”]/g)) {
    const quoted = trimTitleCandidate(match[1] ?? "");
    if (
      quoted
      && !isUrlLike(quoted)
      && (containsDocumentTerm(quoted) || hasAdjacentDocumentTermForQuote(cleaned, match.index ?? 0, match[0].length))
    ) {
      return quoted;
    }
  }

  const thisIsMatch = cleaned.match(/^this is (?:the )?(.+?)(?:[.!?]|$)/i);
  const thisIsCandidate = trimTitleCandidate(thisIsMatch?.[1] ?? "");
  if (thisIsCandidate && containsDocumentTerm(thisIsCandidate)) return thisIsCandidate;

  const firstClause = trimTitleCandidate(firstSentence(cleaned).split(/\b(?:includes?|contains?|covers?|has|with|for)\b/i)[0] ?? "");
  if (!firstClause || !containsDocumentTerm(firstClause)) return null;
  if (/^(add|open|use|please|see|review|check|look|click)\b/i.test(firstClause)) return null;
  return firstClause;
}

function fallbackCapturedTitle(input: CapturedLinkDisplayInput, typeLabel: string) {
  if (input.providerKey === "box") {
    if (typeLabel === "Spreadsheet") return "Box spreadsheet";
    if (typeLabel === "Presentation") return "Box presentation";
    if (typeLabel === "Folder") return "Box folder";
    if (typeLabel === "Document") return "Box document";
    return "Box link";
  }
  return `${input.providerLabel} ${typeLabel.toLowerCase()}`;
}

function escapeRegExp(value: string) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function titlePrefixPattern(title: string) {
  const tokens = cleanDisplayText(title, 160)?.split(/[\s_-]+/).filter(Boolean) ?? [];
  if (tokens.length === 0) return null;
  return tokens.map(escapeRegExp).join("[\\s_-]+");
}

function stripDuplicateTitlePrefix(description: string, title: string) {
  const pattern = titlePrefixPattern(title);
  if (!pattern) return description;
  const match = description.match(new RegExp(`^\\s*["'“”]?${pattern}["'“”]?(?=$|[-_:;,!?\\s.])\\s*`, "i"));
  if (!match) return description;
  const remainder = description.slice(match[0].length).replace(/^[-:;,\s]+/, "");
  if (!remainder) return "";
  return remainder.replace(/^(includes?|contains?|covers?|has|with)\b/i, (match) => match[0].toUpperCase() + match.slice(1).toLowerCase());
}

function stripDuplicateTitleReferences(description: string, title: string) {
  const normalizedTitle = normalizedDisplayText(title);
  if (!normalizedTitle || !normalizedDisplayText(description).includes(normalizedTitle)) return description;
  const pattern = titlePrefixPattern(title);
  if (!pattern) return description;
  const withoutTitle = description
    .replace(new RegExp(`[\\s"'“”]*${pattern}[\\s"'“”]*`, "i"), " ")
    .replace(/\s+([.,;:!?])/g, "$1")
    .replace(/\s+/g, " ")
    .trim();
  return isLowInformationDescription(withoutTitle) ? withoutTitle : description;
}

function isLowInformationDescription(description: string) {
  const normalized = normalizedDisplayText(description);
  if (!normalized) return true;
  if (/^(?:this is|this is the|this is a|this is an|the|a|an)? ?(?:box )?(?:spreadsheet|document|presentation|powerpoint|file|folder|link|tracker|workbook|sheet|deck|slides?)$/.test(normalized)) return true;
  if (/^(?:shared in slack for reference|shared for reference|for reference)$/.test(normalized)) return true;
  return false;
}

function compactDescription(rawDescription: string | null, title: string, labels: string[]) {
  let description = cleanDisplayText(stripUrls(rawDescription ?? ""), 400);
  if (!description) return null;
  description = stripDuplicateTitlePrefix(description, title);
  description = stripDuplicateTitleReferences(description, title);
  description = cleanDisplayText(description, 220);
  if (!description) return null;
  if (isLowInformationDescription(description)) return null;

  const normalizedDescription = normalizedDisplayText(description);
  const duplicateLabels = [title, ...labels].map((label) => normalizedDisplayText(label)).filter(Boolean);
  if (duplicateLabels.some((label) => label === normalizedDescription)) return null;
  return description;
}

export function deriveCapturedLinkDisplay(input: CapturedLinkDisplayInput) {
  const rawDescription = input.summaryMd
    ?? input.resourceDescriptionMd
    ?? input.sourceText
    ?? input.manualDescriptionMd
    ?? input.manualPreviewDescription
    ?? input.manualAccessNotesMd
    ?? null;
  const titleCandidates = [
    { value: input.sourceLabel, rejectOpaqueToken: false },
    { value: input.manualPreviewTitle, rejectOpaqueToken: false },
    { value: input.manualTitle, rejectOpaqueToken: false },
    { value: input.resourceTitle, rejectOpaqueToken: true },
    { value: inferTitleFromSourceText(input.sourceText), rejectOpaqueToken: false },
  ];
  const selectedTitle = titleCandidates.find((candidate) => (
    isUsefulDisplayTitle(candidate.value, input, { rejectOpaqueToken: candidate.rejectOpaqueToken })
  ));
  const selectedTitleText = cleanDisplayText(selectedTitle?.value, 160);
  const typeLabel = inferLinkLibraryType({
    ...input,
    title: selectedTitleText ?? input.resourceTitle ?? input.title,
    descriptionMd: rawDescription,
  });
  const title = selectedTitleText ?? fallbackCapturedTitle(input, typeLabel);
  const descriptionMd = compactDescription(rawDescription, title, [input.providerLabel, typeLabel, input.sourceLabel ?? ""]);

  return { title, descriptionMd, typeLabel };
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
