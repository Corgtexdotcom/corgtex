"use client";

import { useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import { useTranslations } from "next-intl";
import { CheckboxFilter, TableActionGroup } from "@/lib/components/ControlPrimitives";
import { MarkdownEditor } from "@/lib/components/MarkdownEditor";
import { MarkdownExcerpt, MarkdownRenderer } from "@/lib/components/MarkdownRenderer";
import {
  TYPE_ORDER,
  catalogItemComparator,
  connectorReadinessForItem,
  filterCatalogItems,
  getCatalogCardActions,
  hasCatalogFilter,
  splitDefaultCatalogSections,
  type CatalogCardAction,
  type AppCategory,
  type AppInstallationStatus,
  type AppIntegrationDepth,
  type CatalogItemForUi,
  type CatalogItemType,
  type CatalogRequestType,
} from "./catalog-ui";

type CircleOption = {
  id: string;
  name: string;
};

type PersonSummary = {
  id: string;
  email: string;
  displayName: string | null;
};

type ToolLink = {
  id: string;
  title: string;
  url: string;
  category: string;
  descriptionMd: string | null;
  accessNotesMd: string | null;
  previewTitle: string | null;
  previewDescription: string | null;
  previewImageUrl: string | null;
  previewFaviconUrl: string | null;
  credentialLabel: string | null;
  hasCredential: boolean;
  createdAt: string;
  updatedAt: string;
  archivedAt: string | null;
  createdBy: PersonSummary | null;
  circles: CircleOption[];
  canManage: boolean;
};

type CatalogRequestStatus = "PENDING" | "APPROVED" | "REJECTED" | "CANCELLED";

type CatalogItem = CatalogItemForUi & {
  sourceType: string;
  accessNotesMd: string | null;
  requestedScopes: string[];
  monthlyBudgetCents: number | null;
  dailyCallLimit: number | null;
  createdAt: string;
  updatedAt: string;
  createdBy: PersonSummary | null;
  owner: PersonSummary | null;
  isUploaded: boolean;
  pendingRequestCount: number;
  appCategory: AppCategory;
  appVisibility: "PUBLIC_MARKETPLACE" | "UNLISTED" | "WORKSPACE_PRIVATE" | "CORGTEX_MANAGED";
  hostingMode: "EXTERNAL_URL" | "CORGTEX_MANAGED_EXTERNAL" | "CORGTEX_HOSTED_STATIC" | "CORGTEX_HOSTED_CONTAINER" | "MCP_SERVER";
  integrationDepth: AppIntegrationDepth;
  installationStatus: AppInstallationStatus;
  supportUrl: string | null;
  appMcpUrl: string | null;
  dataClassification: string | null;
  proofUrl: string | null;
  reviewUrl: string | null;
  manifestJson: unknown;
  capabilitiesJson: unknown;
};

type CatalogRequest = {
  id: string;
  catalogItemId: string | null;
  type: CatalogRequestType;
  status: CatalogRequestStatus;
  reasonMd: string;
  requestedScopes: string[];
  requestedBudgetCents: number | null;
  requestedDailyCallLimit: number | null;
  title: string | null;
  createdAt: string;
  catalogItem: { id: string; title: string; type: CatalogItemType } | null;
  requester: PersonSummary;
};

type FormState = {
  title: string;
  url: string;
  category: string;
  descriptionMd: string;
  accessNotesMd: string;
  previewTitle: string;
  previewDescription: string;
  previewImageUrl: string;
  credentialLabel: string;
  credentialSecret: string;
  circleIds: string[];
};

type RequestDraft = {
  item: CatalogItem | null;
  type: CatalogRequestType;
  reasonMd: string;
  requestedBudgetCents: string;
  requestedDailyCallLimit: string;
};

type PublishDraft = {
  title: string;
  url: string;
  outcome: string;
  descriptionMd: string;
  requestedScopes: string;
  requestedBudgetCents: string;
  requestedDailyCallLimit: string;
  proofUrl: string;
  appCategory: AppCategory;
  appVisibility: CatalogItem["appVisibility"];
  hostingMode: CatalogItem["hostingMode"];
  integrationDepth: AppIntegrationDepth;
  appMcpUrl: string;
  supportUrl: string;
  dataClassification: string;
  capabilities: string;
};

const EMPTY_FORM: FormState = {
  title: "",
  url: "",
  category: "OTHER",
  descriptionMd: "",
  accessNotesMd: "",
  previewTitle: "",
  previewDescription: "",
  previewImageUrl: "",
  credentialLabel: "",
  credentialSecret: "",
  circleIds: [],
};

const EMPTY_REQUEST: RequestDraft = {
  item: null,
  type: "ACCESS",
  reasonMd: "",
  requestedBudgetCents: "",
  requestedDailyCallLimit: "",
};

const EMPTY_PUBLISH: PublishDraft = {
  title: "",
  url: "",
  outcome: "",
  descriptionMd: "",
  requestedScopes: "",
  requestedBudgetCents: "",
  requestedDailyCallLimit: "",
  proofUrl: "",
  appCategory: "OPERATIONS",
  appVisibility: "WORKSPACE_PRIVATE",
  hostingMode: "EXTERNAL_URL",
  integrationDepth: "LAUNCHABLE",
  appMcpUrl: "",
  supportUrl: "",
  dataClassification: "INTERNAL",
  capabilities: "",
};

const CATEGORIES = [
  ["FINANCE", "Finance"],
  ["KNOWLEDGE", "Knowledge"],
  ["AI", "AI"],
  ["WHITEBOARD", "categoryWhiteboard"],
  ["FILES", "categoryFiles"],
  ["COMMUNICATION", "categoryCommunication"],
  ["OPERATIONS", "categoryOperations"],
  ["OTHER", "categoryOther"],
] as const;

const APP_CATEGORY_OPTIONS: AppCategory[] = ["FINANCE", "KNOWLEDGE", "COMMUNICATION", "AI", "OPERATIONS", "GOVERNANCE", "DATA", "OTHER"];
const APP_VISIBILITY_OPTIONS: CatalogItem["appVisibility"][] = ["PUBLIC_MARKETPLACE", "UNLISTED", "WORKSPACE_PRIVATE", "CORGTEX_MANAGED"];
const HOSTING_MODE_OPTIONS: CatalogItem["hostingMode"][] = ["EXTERNAL_URL", "CORGTEX_MANAGED_EXTERNAL", "CORGTEX_HOSTED_STATIC", "CORGTEX_HOSTED_CONTAINER", "MCP_SERVER"];
const INTEGRATION_DEPTH_OPTIONS: AppIntegrationDepth[] = ["CATALOG_ONLY", "LAUNCHABLE", "MCP_ACTIONABLE", "KNOWLEDGE_SYNCED", "WORKFLOW_NATIVE"];

const TYPE_LABELS: Record<CatalogItemType, string> = {
  APP: "Apps",
  AGENT: "Agents",
  TOOL: "Tools",
  AUTOMATION: "Automations",
  CONNECTOR: "Connectors",
  DATA_SOURCE: "Data",
};

function domainFor(url: string) {
  try {
    return new URL(url, "https://corgtex.local").hostname.replace(/^www\./, "") || url;
  } catch {
    return url;
  }
}

function displayDate(value: string) {
  return new Date(value).toLocaleDateString(undefined, {
    month: "short",
    day: "numeric",
    year: "numeric",
  });
}

function formatCents(cents: number | null) {
  if (cents == null) return "No cap";
  return `$${(cents / 100).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

function displayEnum(value: string) {
  return value.replace(/_/g, " ").toLowerCase().replace(/\b\w/g, (letter) => letter.toUpperCase());
}

function personName(person: PersonSummary | null) {
  return person?.displayName ?? person?.email ?? "Workspace";
}

function linkToForm(link: ToolLink): FormState {
  return {
    title: link.title,
    url: link.url,
    category: link.category,
    descriptionMd: link.descriptionMd ?? "",
    accessNotesMd: link.accessNotesMd ?? "",
    previewTitle: link.previewTitle ?? "",
    previewDescription: link.previewDescription ?? "",
    previewImageUrl: link.previewImageUrl ?? "",
    credentialLabel: link.credentialLabel ?? "",
    credentialSecret: "",
    circleIds: link.circles.map((circle) => circle.id),
  };
}

export function ToolsDirectoryClient({
  workspaceId,
  initialLinks,
  initialCatalogItems,
  initialRequests,
  canManageCatalog,
  circles,
  initialView,
  initialType,
  initialQuery,
}: {
  workspaceId: string;
  initialLinks: ToolLink[];
  initialCatalogItems: CatalogItem[];
  initialRequests: CatalogRequest[];
  canManageCatalog: boolean;
  circles: CircleOption[];
  initialView: "list" | "grid";
  initialType: CatalogItemType | "ALL";
  initialQuery: string;
}) {
  const router = useRouter();
  const t = useTranslations("tools");
  const [links, setLinks] = useState(initialLinks);
  const [items, setItems] = useState(initialCatalogItems);
  const [requests, setRequests] = useState(initialRequests);
  const [form, setForm] = useState<FormState>(EMPTY_FORM);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [isFormOpen, setIsFormOpen] = useState(false);
  const [activeType, setActiveType] = useState<CatalogItemType | "ALL">(initialType);
  const [query, setQuery] = useState(initialQuery);
  const [requestDraft, setRequestDraft] = useState<RequestDraft>(EMPTY_REQUEST);
  const [publishDraft, setPublishDraft] = useState<PublishDraft>(EMPTY_PUBLISH);
  const [isPublishOpen, setIsPublishOpen] = useState(false);
  const [issuedToken, setIssuedToken] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [revealed, setRevealed] = useState<Record<string, string | null>>({});
  const [copiedId, setCopiedId] = useState<string | null>(null);
  const isEditing = Boolean(editingId);

  const groupedLinks = useMemo(() => {
    return [...links].sort((a, b) => a.title.localeCompare(b.title));
  }, [links]);

  const visibleItems = useMemo(() => {
    return filterCatalogItems(items, { activeType, query });
  }, [activeType, items, query]);

  const hasActiveCatalogFilter = hasCatalogFilter({ activeType, query });
  const defaultCatalogSections = useMemo(() => splitDefaultCatalogSections(visibleItems), [visibleItems]);

  const recommendedItems = useMemo(() => (
    [...defaultCatalogSections.recommendedSetup, ...items.filter((item) => (
      item.type !== "CONNECTOR"
      && item.status === "PUBLISHED"
      && (item.featured || item.isFavorite)
      && !defaultCatalogSections.liveSetup.some((entry) => entry.id === item.id)
      && !defaultCatalogSections.recommendedSetup.some((entry) => entry.id === item.id)
    ))]
      .sort(catalogItemComparator)
      .slice(0, 6)
  ), [defaultCatalogSections.liveSetup, defaultCatalogSections.recommendedSetup, items]);

  const pendingRequests = requests.filter((request) => request.status === "PENDING");
  const summary = useMemo(() => {
    const activeConnectors = items.filter((item) => item.type === "CONNECTOR" && item.status !== "DISABLED").length;
    const installedApps = items.filter((item) => item.type === "APP" && (item.installationStatus === "INSTALLED" || item.installationStatus === "APPROVED")).length;
    const budgetCents = items.reduce((sum, item) => sum + (item.monthlyBudgetCents ?? 0), 0);
    return {
      total: items.length,
      activeConnectors,
      installedApps,
      budgetCents,
    };
  }, [items]);

  function setField<K extends keyof FormState>(key: K, value: FormState[K]) {
    setForm((current) => ({ ...current, [key]: value }));
  }

  function setPublishField<K extends keyof PublishDraft>(key: K, value: PublishDraft[K]) {
    setPublishDraft((current) => ({ ...current, [key]: value }));
  }

  function toggleCircle(circleId: string) {
    setForm((current) => ({
      ...current,
      circleIds: current.circleIds.includes(circleId)
        ? current.circleIds.filter((id) => id !== circleId)
        : [...current.circleIds, circleId],
    }));
  }

  function resetForm() {
    setForm(EMPTY_FORM);
    setEditingId(null);
    setIsFormOpen(false);
    setError(null);
  }

  function resetPublishForm() {
    setPublishDraft(EMPTY_PUBLISH);
    setIsPublishOpen(false);
    setError(null);
  }

  function startEdit(link: ToolLink) {
    setForm(linkToForm(link));
    setEditingId(link.id);
    setIsFormOpen(true);
    setError(null);
  }

  async function refreshCatalog() {
    const res = await fetch(`/api/workspaces/${workspaceId}/catalog`);
    const data = await res.json().catch(() => null);
    if (res.ok && Array.isArray(data?.items)) {
      setItems(data.items);
    }
  }

  async function submitForm(event: React.FormEvent) {
    event.preventDefault();
    setError(null);

    const payload: Record<string, unknown> = {
      title: form.title,
      url: form.url,
      category: form.category,
      descriptionMd: form.descriptionMd,
      accessNotesMd: form.accessNotesMd,
      previewTitle: form.previewTitle,
      previewDescription: form.previewDescription,
      previewImageUrl: form.previewImageUrl,
      credentialLabel: form.credentialLabel,
      circleIds: form.circleIds,
    };
    if (form.credentialSecret.trim()) {
      payload.credentialSecret = form.credentialSecret;
    }

    const res = await fetch(
      editingId
        ? `/api/workspaces/${workspaceId}/tool-links/${editingId}`
        : `/api/workspaces/${workspaceId}/tool-links`,
      {
        method: editingId ? "PATCH" : "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      },
    );
    const data = await res.json().catch(() => null);
    if (!res.ok) {
      setError(data?.error?.message ?? t("errorGeneric"));
      return;
    }

    setLinks((current) => (
      editingId
        ? current.map((link) => (link.id === editingId ? data : link))
        : [data, ...current]
    ));
    resetForm();
    await refreshCatalog();
    router.refresh();
  }

  async function archiveLink(link: ToolLink) {
    if (!window.confirm(t("confirmArchive"))) return;
    const res = await fetch(`/api/workspaces/${workspaceId}/tool-links/${link.id}`, {
      method: "DELETE",
    });
    if (!res.ok) {
      const data = await res.json().catch(() => null);
      setError(data?.error?.message ?? t("errorGeneric"));
      return;
    }
    setLinks((current) => current.filter((item) => item.id !== link.id));
    await refreshCatalog();
    router.refresh();
  }

  async function toggleFavorite(item: CatalogItem) {
    const res = await fetch(`/api/workspaces/${workspaceId}/catalog/${item.id}/favorite`, {
      method: item.isFavorite ? "DELETE" : "POST",
    });
    const data = await res.json().catch(() => null);
    if (!res.ok) {
      setError(data?.error?.message ?? "Could not update favorite.");
      return;
    }
    setItems((current) => current.map((entry) => (
      entry.id === item.id ? { ...entry, isFavorite: !item.isFavorite } : entry
    )));
  }

  function openRequest(item: CatalogItem | null, type: CatalogRequestType) {
    setIssuedToken(null);
    setRequestDraft({
      item,
      type,
      reasonMd: "",
      requestedBudgetCents: item?.monthlyBudgetCents != null ? String(item.monthlyBudgetCents) : "",
      requestedDailyCallLimit: item?.dailyCallLimit != null ? String(item.dailyCallLimit) : "",
    });
  }

  async function submitRequest(event: React.FormEvent) {
    event.preventDefault();
    setError(null);
    const budget = requestDraft.requestedBudgetCents.trim();
    const daily = requestDraft.requestedDailyCallLimit.trim();
    const payload: Record<string, unknown> = {
      catalogItemId: requestDraft.item?.id ?? null,
      type: requestDraft.type,
      reasonMd: requestDraft.reasonMd,
      requestedScopes: requestDraft.item?.requestedScopes ?? [],
    };
    if (budget) payload.requestedBudgetCents = Number(budget);
    if (daily) payload.requestedDailyCallLimit = Number(daily);

    const res = await fetch(`/api/workspaces/${workspaceId}/catalog/requests`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });
    const data = await res.json().catch(() => null);
    if (!res.ok) {
      setError(data?.error?.message ?? "Could not create request.");
      return;
    }
    setRequests((current) => [data, ...current]);
    setItems((current) => current.map((item) => (
      item.id === requestDraft.item?.id
        ? { ...item, pendingRequestCount: item.pendingRequestCount + 1 }
        : item
    )));
    setRequestDraft(EMPTY_REQUEST);
    router.refresh();
  }

  async function submitPublishRequest(event: React.FormEvent) {
    event.preventDefault();
    setError(null);
    const scopes = publishDraft.requestedScopes
      .split(/[\s,]+/)
      .map((scope) => scope.trim())
      .filter(Boolean);
    const budget = publishDraft.requestedBudgetCents.trim();
    const daily = publishDraft.requestedDailyCallLimit.trim();
    const payload: Record<string, unknown> = {
      type: "PUBLISH",
      title: publishDraft.title,
      reasonMd: publishDraft.outcome || publishDraft.descriptionMd,
      requestedScopes: scopes,
      payloadJson: {
        type: "APP",
        title: publishDraft.title,
        url: publishDraft.url,
        outcome: publishDraft.outcome,
        descriptionMd: publishDraft.descriptionMd,
        category: publishDraft.appCategory,
        appCategory: publishDraft.appCategory,
        appVisibility: publishDraft.appVisibility,
        hostingMode: publishDraft.hostingMode,
        integrationDepth: publishDraft.integrationDepth,
        appMcpUrl: publishDraft.appMcpUrl,
        supportUrl: publishDraft.supportUrl,
        dataClassification: publishDraft.dataClassification,
        proofUrl: publishDraft.proofUrl,
        capabilities: publishDraft.capabilities
          .split(/[\n,]+/)
          .map((capability) => capability.trim())
          .filter(Boolean)
          .map((key) => ({ key })),
      },
    };
    if (budget) payload.requestedBudgetCents = Number(budget);
    if (daily) payload.requestedDailyCallLimit = Number(daily);

    const res = await fetch(`/api/workspaces/${workspaceId}/catalog/requests`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });
    const data = await res.json().catch(() => null);
    if (!res.ok) {
      setError(data?.error?.message ?? "Could not submit app.");
      return;
    }
    setRequests((current) => [data, ...current]);
    resetPublishForm();
    router.refresh();
  }

  async function decideRequest(request: CatalogRequest, action: "approve" | "reject") {
    const res = await fetch(`/api/workspaces/${workspaceId}/catalog/requests/${request.id}/${action}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ decisionNoteMd: `${action === "approve" ? "Approved" : "Rejected"} from Tools admin queue.` }),
    });
    const data = await res.json().catch(() => null);
    if (!res.ok) {
      setError(data?.error?.message ?? "Could not update request.");
      return;
    }
    setRequests((current) => current.map((entry) => (
      entry.id === request.id ? { ...entry, status: data.request.status } : entry
    )));
    if (data.token) {
      setIssuedToken(data.token);
    }
    await refreshCatalog();
    router.refresh();
  }

  async function revealCredential(link: ToolLink) {
    const res = await fetch(`/api/workspaces/${workspaceId}/tool-links/${link.id}/reveal`, {
      method: "POST",
    });
    const data = await res.json().catch(() => null);
    if (!res.ok) {
      setError(data?.error?.message ?? t("errorGeneric"));
      return;
    }
    setRevealed((current) => ({ ...current, [link.id]: data.credentialSecret ?? null }));
  }

  async function copyCredential(linkId: string) {
    const secret = revealed[linkId];
    if (!secret) return;
    await navigator.clipboard.writeText(secret);
    setCopiedId(linkId);
    window.setTimeout(() => setCopiedId(null), 1800);
  }

  async function copyToken() {
    if (!issuedToken) return;
    await navigator.clipboard.writeText(issuedToken);
    setCopiedId("issued-token");
    window.setTimeout(() => setCopiedId(null), 1800);
  }

  function renderCatalogAction(action: CatalogCardAction, item: CatalogItem) {
    if (action.kind === "status") {
      return <span key={action.label} className="tag info">{action.label}</span>;
    }
    if (action.kind === "request") {
      return (
        <button
          key={`${action.kind}-${action.requestType}`}
          type="button"
          className={action.variant === "primary" ? "small" : "secondary small"}
          onClick={() => openRequest(item, action.requestType)}
        >
          {action.label}
        </button>
      );
    }
    return (
      <a
        key={`${action.kind}-${action.href}-${action.label}`}
        className={action.variant === "primary" ? "link-button small" : "link-button secondary small"}
        href={action.href}
        target={action.href.startsWith("/") ? undefined : "_blank"}
        rel="noreferrer"
      >
        {action.label}
      </a>
    );
  }

  function renderCatalogCard(item: CatalogItem, compact = false) {
    const actions = getCatalogCardActions(item, { workspaceId, canManageCatalog });
    const readiness = connectorReadinessForItem(item);
    const availabilityLabel = readiness?.availability.replace(/_/g, " ").toLowerCase().replace(/\b\w/g, (letter) => letter.toUpperCase());
    return (
      <article
        key={item.id}
        style={{
          border: "1px solid var(--line)",
          borderRadius: 8,
          padding: compact ? 12 : 16,
          background: "var(--surface-strong)",
          display: "grid",
          gap: 12,
          minHeight: compact ? 0 : 220,
        }}
      >
        <div style={{ display: "flex", justifyContent: "space-between", gap: 12, alignItems: "flex-start" }}>
          <div style={{ minWidth: 0 }}>
            <div className="actions-inline" style={{ gap: 6, marginBottom: 8 }}>
              <span className="tag">{TYPE_LABELS[item.type]}</span>
              <span className={`tag ${item.accessMode === "OPEN" ? "success" : "info"}`}>
                {item.accessMode === "OPEN" ? "Open" : item.accessMode === "ADMIN_ONLY" ? "Admin" : item.accessMode === "REQUEST" ? "Request" : "Disabled"}
              </span>
              {availabilityLabel && <span className={`tag ${readiness?.availability === "LIVE" ? "success" : "info"}`}>{availabilityLabel}</span>}
              {item.type === "APP" && <span className="tag">{displayEnum(item.appCategory)}</span>}
              {item.type === "APP" && <span className={`tag ${item.installationStatus === "INSTALLED" || item.installationStatus === "APPROVED" ? "success" : "info"}`}>
                {displayEnum(item.installationStatus)}
              </span>}
              {item.pendingRequestCount > 0 && <span className="tag info">{item.pendingRequestCount} pending</span>}
            </div>
            <h2 style={{ fontSize: compact ? "0.98rem" : "1.1rem", margin: 0, wordBreak: "break-word" }}>
              {item.title}
            </h2>
          </div>
          <button
            type="button"
            className="secondary small nr-compact-square-button"
            aria-label={item.isFavorite ? "Remove favorite" : "Add favorite"}
            onClick={() => toggleFavorite(item)}
          >
            {item.isFavorite ? "★" : "☆"}
          </button>
        </div>

        <p style={{ margin: 0, color: "var(--muted)", lineHeight: 1.45, fontSize: "0.9rem" }}>
          {item.outcome || item.descriptionMd || "Shared workspace capability."}
        </p>

        {item.descriptionMd && item.outcome !== item.descriptionMd && !compact && (
          <MarkdownRenderer markdown={item.descriptionMd} variant="compact" className="muted" />
        )}

        {readiness && (
          <div
            style={{
              display: "grid",
              gridTemplateColumns: "repeat(auto-fit, minmax(150px, 1fr))",
              gap: 8,
            }}
          >
            <div className="nr-item-meta" style={{ margin: 0 }}>
              <strong style={{ color: "var(--text)" }}>Who connects</strong><br />
              {readiness.connectedBy}
            </div>
            <div className="nr-item-meta" style={{ margin: 0 }}>
              <strong style={{ color: "var(--text)" }}>Access</strong><br />
              {readiness.supportedOperations.slice(0, 2).join(", ") || displayEnum(readiness.connectorRole)}
            </div>
            <div className="nr-item-meta" style={{ margin: 0 }}>
              <strong style={{ color: "var(--text)" }}>Storage</strong><br />
              {readiness.storagePolicy}
            </div>
          </div>
        )}

        <div className="nr-item-meta" style={{ margin: 0 }}>
          Owner: {personName(item.owner ?? item.createdBy)} · Budget: {formatCents(item.monthlyBudgetCents)}
          {item.dailyCallLimit != null ? ` · ${item.dailyCallLimit} calls/day` : ""}
          {item.type === "APP" ? ` · ${displayEnum(item.integrationDepth)}` : ""}
        </div>

        <TableActionGroup className="nr-tools-card-actions">
          {actions.map((action) => renderCatalogAction(action, item))}
        </TableActionGroup>
      </article>
    );
  }

  function renderSection(title: string, sectionItems: CatalogItem[], empty: string, compact = false, description?: string) {
    return (
      <section className="stack" style={{ gap: 12 }}>
        <div style={{ display: "flex", justifyContent: "space-between", gap: 12, alignItems: "baseline" }}>
          <h2 className="nr-section-header" style={{ margin: 0 }}>{title}</h2>
          <span className="nr-item-meta">{sectionItems.length}</span>
        </div>
        {description && <p className="nr-item-meta" style={{ margin: 0 }}>{description}</p>}
        {sectionItems.length === 0 ? (
          <p className="muted" style={{ margin: 0, fontSize: "0.9rem" }}>{empty}</p>
        ) : (
          <div style={{ display: "grid", gridTemplateColumns: compact ? "repeat(auto-fit, minmax(240px, 1fr))" : "repeat(auto-fit, minmax(280px, 1fr))", gap: 14 }}>
            {sectionItems.map((item) => renderCatalogCard(item, compact))}
          </div>
        )}
      </section>
    );
  }

  function renderCredential(link: ToolLink) {
    if (!link.hasCredential) {
      return <span className="muted" style={{ fontSize: "0.82rem" }}>{t("hasNoCredential")}</span>;
    }

    const secret = revealed[link.id];
    return (
      <div className="stack" style={{ gap: 8 }}>
        <div className="nr-item-meta" style={{ margin: 0 }}>
          {link.credentialLabel || t("credential")}
        </div>
        {secret === undefined ? (
          <button type="button" className="secondary small" onClick={() => revealCredential(link)}>
            {t("btnReveal")}
          </button>
        ) : (
          <TableActionGroup className="nr-token-copy-row">
            <input
              readOnly
              value={secret ?? ""}
              className="nr-token-copy-input"
              aria-label={link.credentialLabel || t("credential")}
            />
            <button type="button" className="secondary small" onClick={() => copyCredential(link.id)}>
              {copiedId === link.id ? t("btnCopied") : t("btnCopy")}
            </button>
          </TableActionGroup>
        )}
      </div>
    );
  }

  function renderTags(link: ToolLink) {
    return (
      <div className="actions-inline" style={{ gap: 6 }}>
        <span className="tag">{categoryLabel(link.category)}</span>
        {link.circles.map((circle) => (
          <span className="tag info" key={circle.id}>{circle.name}</span>
        ))}
        {link.hasCredential && <span className="tag success">{t("credentialConfigured")}</span>}
      </div>
    );
  }

  function categoryLabel(category: string) {
    const match = CATEGORIES.find(([value]) => value === category);
    if (!match) return category;
    return match[1].startsWith("category") ? t(match[1]) : match[1];
  }

  function renderPreview(link: ToolLink) {
    const host = domainFor(link.url);
    return (
      <div
        style={{
          border: "1px solid var(--line)",
          borderRadius: 8,
          overflow: "hidden",
          background: "var(--surface-strong)",
          minHeight: 154,
        }}
      >
        {link.previewImageUrl ? (
          <div
            aria-hidden="true"
            style={{
              height: 96,
              backgroundImage: `url("${link.previewImageUrl.replace(/"/g, "%22")}")`,
              backgroundPosition: "center",
              backgroundSize: "cover",
              backgroundColor: "var(--bg-alt)",
            }}
          />
        ) : (
          <div
            style={{
              height: 96,
              display: "flex",
              alignItems: "center",
              justifyContent: "center",
              background: "var(--bg-alt)",
              fontSize: "2rem",
              fontWeight: 700,
            }}
          >
            {link.title.slice(0, 1).toUpperCase()}
          </div>
        )}
        <div style={{ padding: 12 }}>
          <strong style={{ display: "block", fontSize: "0.95rem" }}>
            {link.previewTitle || link.title}
          </strong>
          <div className="nr-item-meta" style={{ marginTop: 4 }}>{host}</div>
          {(link.previewDescription || link.descriptionMd) && (
            <div style={{ margin: "8px 0 0", color: "var(--muted)", fontSize: "0.82rem", lineHeight: 1.45 }}>
              {link.previewDescription || <MarkdownExcerpt markdown={link.descriptionMd} maxLength={130} />}
            </div>
          )}
        </div>
      </div>
    );
  }

  function renderListView() {
    return (
      <div className="nr-table-wrap">
        <table className="nr-table">
          <thead>
            <tr>
              <th>{t("formTitle")}</th>
              <th>{t("formCategory")}</th>
              <th>{t("accessNotes")}</th>
              <th>{t("credential")}</th>
              <th>{t("updatedAt", { date: "" }).trim()}</th>
              <th>{t("btnOpen")}</th>
            </tr>
          </thead>
          <tbody>
            {groupedLinks.map((link) => (
              <tr key={link.id}>
                <td style={{ minWidth: 220, verticalAlign: "top" }}>
                  <strong>{link.title}</strong>
                  <div className="nr-item-meta">{domainFor(link.url)}</div>
                  {link.descriptionMd && (
                    <MarkdownRenderer markdown={link.descriptionMd} variant="compact" className="mt-2" />
                  )}
                  <div style={{ marginTop: 8 }}>{renderTags(link)}</div>
                </td>
                <td style={{ verticalAlign: "top" }}>{categoryLabel(link.category)}</td>
                <td style={{ minWidth: 220, verticalAlign: "top" }}>
                  {link.accessNotesMd ? <MarkdownRenderer markdown={link.accessNotesMd} variant="compact" /> : <span className="muted">-</span>}
                </td>
                <td style={{ minWidth: 240, verticalAlign: "top" }}>{renderCredential(link)}</td>
                <td style={{ minWidth: 150, verticalAlign: "top" }}>
                  <div>{displayDate(link.updatedAt)}</div>
                  <div className="nr-item-meta">
                    {link.createdBy
                      ? t("addedBy", { name: link.createdBy.displayName ?? link.createdBy.email })
                      : t("createdAt", { date: displayDate(link.createdAt) })}
                  </div>
                </td>
                <td className="nr-table-action-cell nr-tools-table-cell-top">
                  <TableActionGroup>
                    <a className="link-button small" href={link.url} target="_blank" rel="noreferrer">
                      {t("btnOpen")}
                    </a>
                    {link.canManage && (
                      <>
                        <button type="button" className="secondary small" onClick={() => startEdit(link)}>
                          {t("btnEdit")}
                        </button>
                        <button type="button" className="danger small" onClick={() => archiveLink(link)}>
                          {t("btnArchive")}
                        </button>
                      </>
                    )}
                  </TableActionGroup>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    );
  }

  function renderGridView() {
    return (
      <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(260px, 1fr))", gap: 16 }}>
        {groupedLinks.map((link) => (
          <article
            key={link.id}
            style={{
              border: "1px solid var(--line)",
              borderRadius: 8,
              padding: 14,
              background: "var(--surface-strong)",
              display: "grid",
              gap: 12,
            }}
          >
            {renderPreview(link)}
            <div>
              <h2 style={{ fontSize: "1rem", margin: "0 0 6px" }}>{link.title}</h2>
              {renderTags(link)}
            </div>
            {link.accessNotesMd && (
              <MarkdownRenderer markdown={link.accessNotesMd} variant="compact" className="muted" />
            )}
            {renderCredential(link)}
            <TableActionGroup>
              <a className="link-button small" href={link.url} target="_blank" rel="noreferrer">
                {t("btnOpen")}
              </a>
              {link.canManage && (
                <>
                  <button type="button" className="secondary small" onClick={() => startEdit(link)}>
                    {t("btnEdit")}
                  </button>
                  <button type="button" className="danger small" onClick={() => archiveLink(link)}>
                    {t("btnArchive")}
                  </button>
                </>
              )}
            </TableActionGroup>
          </article>
        ))}
      </div>
    );
  }

  return (
    <section className="ws-section stack" style={{ gap: 28 }}>
      <div className="stack" style={{ gap: 16 }}>
        <div style={{ display: "grid", gridTemplateColumns: "minmax(0, 1fr) auto", gap: 12, alignItems: "center" }}>
          <input
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            placeholder="Find an app, agent, connector, tool, or data source"
            aria-label="Search tools catalog"
          />
          <TableActionGroup className="nr-toolbar-action-group">
            <button type="button" className="small" onClick={() => setIsPublishOpen((open) => !open)}>
              {isPublishOpen ? t("btnCancel") : "Submit app for review"}
            </button>
            <a className="link-button secondary small" href={`/workspaces/${workspaceId}/brain`}>
              Add reference to Brain
            </a>
            <button type="button" className="secondary small" onClick={() => setIsFormOpen((open) => !open)}>
              {isFormOpen ? t("btnCancel") : "Add protected tool link"}
            </button>
          </TableActionGroup>
        </div>

        <div className="ws-stat-row" style={{ marginTop: 0 }}>
          <div className="ws-stat-card">
            <span>Catalog items</span>
            <strong>{summary.total}</strong>
          </div>
          <div className="ws-stat-card">
            <span>Connectors</span>
            <strong>{summary.activeConnectors}</strong>
          </div>
          <div className="ws-stat-card">
            <span>Installed apps</span>
            <strong>{summary.installedApps}</strong>
          </div>
          <div className="ws-stat-card">
            <span>Pending</span>
            <strong>{pendingRequests.length}</strong>
          </div>
        </div>

        <div className="nr-filter-bar">
          <button type="button" className={`nr-filter-item ${activeType === "ALL" ? "nr-filter-active" : ""}`} onClick={() => setActiveType("ALL")}>
            All ({items.length})
          </button>
          {TYPE_ORDER.map((type) => (
            <button
              type="button"
              key={type}
              className={`nr-filter-item ${activeType === type ? "nr-filter-active" : ""}`}
              onClick={() => setActiveType(type)}
            >
              {TYPE_LABELS[type]} ({items.filter((item) => item.type === type).length})
            </button>
          ))}
        </div>
      </div>

      {error && <div className="form-message form-message-error">{error}</div>}

      {issuedToken && (
        <div className="form-message form-message-success">
          <strong>API key issued.</strong>
          <TableActionGroup className="nr-token-copy-row">
            <input readOnly value={issuedToken} aria-label="Issued API key" className="nr-token-copy-input" />
            <button type="button" className="secondary small" onClick={copyToken}>
              {copiedId === "issued-token" ? t("btnCopied") : t("btnCopy")}
            </button>
          </TableActionGroup>
        </div>
      )}

      {isPublishOpen && (
        <form
          onSubmit={submitPublishRequest}
          className="nr-form-section stack"
          style={{ border: "1px solid var(--line)", borderRadius: 8, padding: 20, marginBottom: 8 }}
        >
          <div style={{ display: "flex", justifyContent: "space-between", gap: 12, alignItems: "flex-start" }}>
            <div>
              <h2 style={{ margin: 0, fontSize: "1.1rem" }}>Submit app for review</h2>
              <p className="nr-item-meta" style={{ margin: "4px 0 0" }}>Employee-made apps go to workspace admins before they appear in Tools.</p>
            </div>
            <button type="button" className="secondary small" onClick={resetPublishForm}>{t("btnCancel")}</button>
          </div>
          <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(240px, 1fr))", gap: 14 }}>
            <label>
              App name
              <input required value={publishDraft.title} onChange={(event) => setPublishField("title", event.target.value)} />
            </label>
            <label>
              App URL
              <input required value={publishDraft.url} onChange={(event) => setPublishField("url", event.target.value)} placeholder="https://example.com/app" />
            </label>
            <label>
              Proof link
              <input value={publishDraft.proofUrl} onChange={(event) => setPublishField("proofUrl", event.target.value)} placeholder="Build, demo, or artifact link" />
            </label>
          </div>
          <label>
            Outcome
            <input
              required
              value={publishDraft.outcome}
              onChange={(event) => setPublishField("outcome", event.target.value)}
              placeholder="What business outcome does this app produce?"
            />
          </label>
          <label>
            Description
            <MarkdownEditor
              name="publishDescription"
              value={publishDraft.descriptionMd}
              onValueChange={(descriptionMd) => setPublishField("descriptionMd", descriptionMd)}
              placeholder="What it does, who should use it, and what data it needs."
              rows={4}
            />
          </label>
          <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(200px, 1fr))", gap: 14 }}>
            <label>
              App category
              <select value={publishDraft.appCategory} onChange={(event) => setPublishField("appCategory", event.target.value as AppCategory)}>
                {APP_CATEGORY_OPTIONS.map((option) => <option key={option} value={option}>{displayEnum(option)}</option>)}
              </select>
            </label>
            <label>
              Visibility
              <select value={publishDraft.appVisibility} onChange={(event) => setPublishField("appVisibility", event.target.value as CatalogItem["appVisibility"])}>
                {APP_VISIBILITY_OPTIONS.map((option) => <option key={option} value={option}>{displayEnum(option)}</option>)}
              </select>
            </label>
            <label>
              Hosting mode
              <select value={publishDraft.hostingMode} onChange={(event) => setPublishField("hostingMode", event.target.value as CatalogItem["hostingMode"])}>
                {HOSTING_MODE_OPTIONS.map((option) => <option key={option} value={option}>{displayEnum(option)}</option>)}
              </select>
            </label>
            <label>
              Integration depth
              <select value={publishDraft.integrationDepth} onChange={(event) => setPublishField("integrationDepth", event.target.value as AppIntegrationDepth)}>
                {INTEGRATION_DEPTH_OPTIONS.map((option) => <option key={option} value={option}>{displayEnum(option)}</option>)}
              </select>
            </label>
          </div>
          <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(240px, 1fr))", gap: 14 }}>
            <label>
              App MCP URL
              <input value={publishDraft.appMcpUrl} onChange={(event) => setPublishField("appMcpUrl", event.target.value)} placeholder="https://example.com/mcp" />
            </label>
            <label>
              Support URL
              <input value={publishDraft.supportUrl} onChange={(event) => setPublishField("supportUrl", event.target.value)} placeholder="https://example.com/support" />
            </label>
            <label>
              Data classification
              <input value={publishDraft.dataClassification} onChange={(event) => setPublishField("dataClassification", event.target.value)} placeholder="INTERNAL" />
            </label>
          </div>
          <label>
            Capability keys
            <textarea
              value={publishDraft.capabilities}
              onChange={(event) => setPublishField("capabilities", event.target.value)}
              placeholder="expenses.create_draft, budgets.read_status"
              rows={2}
            />
          </label>
          <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(200px, 1fr))", gap: 14 }}>
            <label>
              Requested scopes
              <input
                value={publishDraft.requestedScopes}
                onChange={(event) => setPublishField("requestedScopes", event.target.value)}
                placeholder="tools:read runtime:write"
              />
            </label>
            <label>
              Initial monthly budget cents
              <input
                type="number"
                min="0"
                value={publishDraft.requestedBudgetCents}
                onChange={(event) => setPublishField("requestedBudgetCents", event.target.value)}
              />
            </label>
            <label>
              Daily call limit
              <input
                type="number"
                min="0"
                value={publishDraft.requestedDailyCallLimit}
                onChange={(event) => setPublishField("requestedDailyCallLimit", event.target.value)}
              />
            </label>
          </div>
          <TableActionGroup>
            <button type="submit" className="small">Submit to admins</button>
          </TableActionGroup>
        </form>
      )}

      {isFormOpen && (
        <form
          onSubmit={submitForm}
          className="nr-form-section stack"
          style={{ border: "1px solid var(--line)", borderRadius: 8, padding: 20, marginBottom: 8 }}
        >
          <div>
            <h2 style={{ margin: 0, fontSize: "1.1rem" }}>{isEditing ? t("editTitle") : "Add protected tool link"}</h2>
            <p className="nr-item-meta" style={{ margin: "4px 0 0" }}>
              Keep credentials, launch URLs, installed tools, and access notes here. Put plain reference links and vendor notes in Brain.
            </p>
          </div>
          <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(240px, 1fr))", gap: 14 }}>
            <label>
              {t("formTitle")}
              <input required value={form.title} onChange={(event) => setField("title", event.target.value)} />
            </label>
            <label>
              {t("formUrl")}
              <input required value={form.url} onChange={(event) => setField("url", event.target.value)} placeholder="https://example.com" />
            </label>
            <label>
              {t("formCategory")}
              <select value={form.category} onChange={(event) => setField("category", event.target.value)}>
                {CATEGORIES.map(([value, labelKey]) => (
                  <option key={value} value={value}>{labelKey.startsWith("category") ? t(labelKey) : labelKey}</option>
                ))}
              </select>
            </label>
          </div>
          <label>
            {t("formDescription")}
            <MarkdownEditor
              name="descriptionMd"
              value={form.descriptionMd}
              onValueChange={(descriptionMd) => setField("descriptionMd", descriptionMd)}
              placeholder={t("placeholderDescription")}
              rows={4}
            />
          </label>
          <label>
            {t("formAccessNotes")}
            <MarkdownEditor
              name="accessNotesMd"
              value={form.accessNotesMd}
              onValueChange={(accessNotesMd) => setField("accessNotesMd", accessNotesMd)}
              placeholder={t("placeholderAccessNotes")}
              rows={4}
            />
          </label>
          <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(240px, 1fr))", gap: 14 }}>
            <label>
              {t("formPreviewTitle")}
              <input value={form.previewTitle} onChange={(event) => setField("previewTitle", event.target.value)} placeholder={t("placeholderPreviewTitle")} />
            </label>
            <label>
              {t("formPreviewImageUrl")}
              <input value={form.previewImageUrl} onChange={(event) => setField("previewImageUrl", event.target.value)} />
            </label>
          </div>
          <label>
            {t("formPreviewDescription")}
            <input value={form.previewDescription} onChange={(event) => setField("previewDescription", event.target.value)} placeholder={t("placeholderPreviewDescription")} />
          </label>
          <fieldset style={{ border: "1px solid var(--line)", borderRadius: 8, padding: 14 }}>
            <legend style={{ padding: "0 6px", fontWeight: 600 }}>{t("credentialOptional")}</legend>
            <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(240px, 1fr))", gap: 14 }}>
              <label>
                {t("formCredentialLabel")}
                <input value={form.credentialLabel} onChange={(event) => setField("credentialLabel", event.target.value)} placeholder={t("placeholderCredentialLabel")} />
              </label>
              <label>
                {t("formCredentialSecret")}
                <input type="password" value={form.credentialSecret} onChange={(event) => setField("credentialSecret", event.target.value)} placeholder={t("placeholderCredentialSecret")} />
              </label>
            </div>
          </fieldset>
          <fieldset style={{ border: "1px solid var(--line)", borderRadius: 8, padding: 14 }}>
            <legend style={{ padding: "0 6px", fontWeight: 600 }}>{t("formCircles")}</legend>
            {circles.length === 0 ? (
              <p className="nr-item-meta">{t("noCircles")}</p>
            ) : (
              <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(180px, 1fr))", gap: 8 }}>
                {circles.map((circle) => (
                  <CheckboxFilter
                    key={circle.id}
                    checked={form.circleIds.includes(circle.id)}
                    onChange={() => toggleCircle(circle.id)}
                  >
                    {circle.name}
                  </CheckboxFilter>
                ))}
              </div>
            )}
          </fieldset>
          <TableActionGroup>
            <button type="submit" className="small">{isEditing ? t("btnUpdateTool") : "Add link"}</button>
            <button type="button" className="secondary small" onClick={resetForm}>{t("btnCancel")}</button>
          </TableActionGroup>
        </form>
      )}

      {requestDraft.item && (
        <form
          onSubmit={submitRequest}
          className="nr-form-section stack"
          style={{ border: "1px solid var(--line)", borderRadius: 8, padding: 18 }}
        >
          <div style={{ display: "flex", justifyContent: "space-between", gap: 12 }}>
            <div>
              <h2 style={{ margin: 0, fontSize: "1.05rem" }}>
                {requestDraft.type === "ACCESS" ? "Request access" : requestDraft.type === "API_KEY" ? "Request API key" : "Request budget"}: {requestDraft.item.title}
              </h2>
              <p className="nr-item-meta" style={{ margin: "4px 0 0" }}>Requests route to workspace admins.</p>
            </div>
            <button type="button" className="secondary small" onClick={() => setRequestDraft(EMPTY_REQUEST)}>
              {t("btnCancel")}
            </button>
          </div>
          <label>
            Reason
            <MarkdownEditor
              name="reasonMd"
              value={requestDraft.reasonMd}
              onValueChange={(reasonMd) => setRequestDraft((current) => ({ ...current, reasonMd }))}
              placeholder="What outcome are you trying to produce?"
              rows={3}
            />
          </label>
          {requestDraft.type !== "ACCESS" && (
            <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(180px, 1fr))", gap: 12 }}>
              <label>
                Monthly budget cents
                <input
                  type="number"
                  min="0"
                  value={requestDraft.requestedBudgetCents}
                  onChange={(event) => setRequestDraft((current) => ({ ...current, requestedBudgetCents: event.target.value }))}
                />
              </label>
              <label>
                Daily call limit
                <input
                  type="number"
                  min="0"
                  value={requestDraft.requestedDailyCallLimit}
                  onChange={(event) => setRequestDraft((current) => ({ ...current, requestedDailyCallLimit: event.target.value }))}
                />
              </label>
            </div>
          )}
          <TableActionGroup>
            <button type="submit" className="small">Submit request</button>
          </TableActionGroup>
        </form>
      )}

      {canManageCatalog && pendingRequests.length > 0 && (
        <section className="stack" style={{ gap: 12 }}>
          <h2 className="nr-section-header" style={{ margin: 0 }}>Admin queue</h2>
          <div className="nr-table-wrap">
            <table className="nr-table">
              <thead>
                <tr>
                  <th>Request</th>
                  <th>Reason</th>
                  <th>Requester</th>
                  <th>Action</th>
                </tr>
              </thead>
              <tbody>
                {pendingRequests.map((request) => (
                  <tr key={request.id}>
                    <td>
                      <strong>{request.catalogItem?.title ?? request.title ?? "Catalog publish request"}</strong>
                      <div className="nr-item-meta">{request.type} · {displayDate(request.createdAt)}</div>
                    </td>
                    <td className="nr-tools-request-reason-cell">
                      <MarkdownRenderer markdown={request.reasonMd} variant="compact" />
                      {(request.requestedBudgetCents != null || request.requestedDailyCallLimit != null) && (
                        <div className="nr-item-meta" style={{ marginTop: 6 }}>
                          {formatCents(request.requestedBudgetCents)} · {request.requestedDailyCallLimit ?? "No"} calls/day
                        </div>
                      )}
                    </td>
                    <td>{personName(request.requester)}</td>
                    <td className="nr-table-action-cell">
                      <TableActionGroup>
                        <button type="button" className="secondary small" onClick={() => decideRequest(request, "approve")}>Approve</button>
                        <button type="button" className="danger small" onClick={() => decideRequest(request, "reject")}>Reject</button>
                      </TableActionGroup>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </section>
      )}

      {!hasActiveCatalogFilter && (
        <>
          {renderSection(
            "Connected now",
            defaultCatalogSections.liveSetup,
            "No live connector setup is available yet.",
            true,
            "Implemented Corgtex paths only. Some entries still require an admin or user to complete setup on the detail page.",
          )}
          {renderSection(
            "Recommended setup",
            recommendedItems,
            "No recommendations yet.",
            true,
            "Highest-priority setup paths, capped so the page stays realistic.",
          )}
          {renderSection(
            "Available on request",
            defaultCatalogSections.availableOnRequest,
            "No request-only connectors are listed yet.",
            true,
            "Providers with a real MCP/API path but no one-click Corgtex connection in this workspace.",
          )}
          {renderSection(
            "Apps and shared links",
            defaultCatalogSections.appsAndLinks,
            "Apps, agents, protected links, and data tools will appear here.",
            true,
          )}
        </>
      )}

      {hasActiveCatalogFilter && (
        <section className="stack" style={{ gap: 16 }}>
          <div style={{ display: "flex", justifyContent: "space-between", gap: 12, alignItems: "baseline" }}>
            <h2 className="nr-section-header" style={{ margin: 0 }}>
              {activeType === "ALL" ? "Search results" : TYPE_LABELS[activeType]}
            </h2>
            <span className="nr-item-meta">
              {visibleItems.length} items
            </span>
          </div>
          {visibleItems.length === 0 ? (
            <div className="nr-item" style={{ textAlign: "center", padding: "48px 24px" }}>
              <h2 style={{ margin: "0 0 8px", fontSize: "1.1rem" }}>No catalog items found.</h2>
              <p className="muted" style={{ margin: 0 }}>Try another search, add a protected tool link, or put reference material in Brain.</p>
            </div>
          ) : (
            <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(300px, 1fr))", gap: 16 }}>
              {visibleItems.map((item) => renderCatalogCard(item))}
            </div>
          )}
        </section>
      )}

      <details>
        <summary className="nr-section-header" style={{ cursor: "pointer", margin: 0 }}>
          Shared link management
        </summary>
        <div style={{ marginTop: 16 }}>
          {groupedLinks.length === 0 ? (
            <div className="nr-item" style={{ textAlign: "center", padding: "32px 24px" }}>
              <h2 style={{ margin: "0 0 8px", fontSize: "1.1rem" }}>{t("emptyTitle")}</h2>
              <p className="muted" style={{ margin: 0 }}>{t("emptyDescription")}</p>
            </div>
          ) : initialView === "grid" ? renderGridView() : renderListView()}
        </div>
      </details>
    </section>
  );
}
