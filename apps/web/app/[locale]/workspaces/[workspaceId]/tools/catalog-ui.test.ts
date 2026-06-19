import { describe, expect, it } from "vitest";
import {
  connectorReadinessForItem,
  filterCatalogItems,
  getCatalogCardActions,
  normalizeCatalogQuery,
  normalizeCatalogType,
  splitDefaultCatalogSections,
  type CatalogItemForUi,
} from "./catalog-ui";

function item(overrides: Partial<CatalogItemForUi>): CatalogItemForUi {
  return {
    id: overrides.id ?? "item-1",
    type: overrides.type ?? "TOOL",
    sourceType: overrides.sourceType,
    sourceId: overrides.sourceId ?? null,
    title: overrides.title ?? "Shared tool",
    outcome: overrides.outcome ?? null,
    descriptionMd: overrides.descriptionMd ?? null,
    url: overrides.url ?? "https://example.com",
    category: overrides.category ?? "OTHER",
    status: overrides.status ?? "PUBLISHED",
    accessMode: overrides.accessMode ?? "OPEN",
    featured: overrides.featured ?? false,
    isFavorite: overrides.isFavorite ?? false,
    appCategory: overrides.appCategory ?? "OTHER",
    installationStatus: overrides.installationStatus ?? "INSTALLED",
    integrationDepth: overrides.integrationDepth ?? "CATALOG_ONLY",
    appMcpUrl: overrides.appMcpUrl ?? null,
    manifestJson: overrides.manifestJson,
    capabilitiesJson: overrides.capabilitiesJson,
    pendingRequestCount: overrides.pendingRequestCount ?? 0,
  };
}

function readiness(overrides: Record<string, unknown> = {}) {
  return {
    connectorReadiness: {
      key: "box",
      title: "Box",
      availability: "PILOT_READY",
      connectMethod: "external_mcp",
      connectorRole: "documents",
      connectedBy: "Admin enables, users connect",
      supportedOperations: ["Search", "Fetch file context"],
      storagePolicy: "Read/search/fetch first.",
      sourceUrl: "https://developer.box.com/guides/box-mcp/",
      adminNotes: "Official hosted MCP exists; Corgtex setup is request-only.",
      recommended: true,
      recommendationRank: 70,
      ...overrides,
    },
  };
}

describe("Tools catalog UI helpers", () => {
  it("sorts apps before connectors in the raw catalog order", () => {
    const result = filterCatalogItems([
      item({ id: "tool", type: "TOOL", title: "Tool" }),
      item({ id: "agent", type: "AGENT", title: "Agent" }),
      item({ id: "connector", type: "CONNECTOR", title: "Google" }),
      item({ id: "app", type: "APP", title: "App" }),
    ], { activeType: "ALL", query: "" });

    expect(result.map((entry) => entry.id)).toEqual(["app", "connector", "agent", "tool"]);
  });

  it("filters by selected item type", () => {
    const result = filterCatalogItems([
      item({ id: "google", type: "CONNECTOR", title: "Google" }),
      item({ id: "app", type: "APP", title: "Estimator" }),
    ], { activeType: "CONNECTOR", query: "" });

    expect(result.map((entry) => entry.id)).toEqual(["google"]);
  });

  it("normalizes repeated URL filter parameters", () => {
    expect(normalizeCatalogType(["TOOL", "AGENT"])).toBe("TOOL");
    expect(normalizeCatalogType(["BAD", "TOOL"])).toBe("ALL");
    expect(normalizeCatalogQuery(["meeting", "recorder"])).toBe("meeting");
    expect(normalizeCatalogQuery("x".repeat(140))).toHaveLength(120);
  });

  it("matches search across title, outcome, description, category, and type", () => {
    const items = [
      item({ id: "title", title: "Slack" }),
      item({ id: "outcome", title: "Calendar", outcome: "Prepare meeting briefings" }),
      item({ id: "description", title: "Docs", descriptionMd: "Shared playbooks and operating notes" }),
      item({ id: "category", title: "Warehouse", category: "DATA" }),
      item({ id: "type", type: "CONNECTOR", title: "Microsoft" }),
    ];

    expect(filterCatalogItems(items, { activeType: "ALL", query: "slack" }).map((entry) => entry.id)).toEqual(["title"]);
    expect(filterCatalogItems(items, { activeType: "ALL", query: "briefings" }).map((entry) => entry.id)).toEqual(["outcome"]);
    expect(filterCatalogItems(items, { activeType: "ALL", query: "playbooks" }).map((entry) => entry.id)).toEqual(["description"]);
    expect(filterCatalogItems(items, { activeType: "ALL", query: "data" }).map((entry) => entry.id)).toEqual(["category"]);
    expect(filterCatalogItems(items, { activeType: "ALL", query: "connector" }).map((entry) => entry.id)).toEqual(["type"]);
  });

  it("splits the default directory into realistic readiness sections", () => {
    const sections = splitDefaultCatalogSections([
      item({ id: "tool", type: "TOOL", sourceType: "TOOL_LINK" }),
      item({
        id: "slack",
        type: "CONNECTOR",
        manifestJson: readiness({ key: "slack", title: "Slack", availability: "LIVE", recommended: true, recommendationRank: 10 }),
      }),
      item({
        id: "box",
        type: "CONNECTOR",
        accessMode: "REQUEST",
        manifestJson: readiness(),
      }),
      item({
        id: "miro",
        type: "CONNECTOR",
        accessMode: "REQUEST",
        manifestJson: readiness({ key: "miro", title: "Miro", availability: "ON_REQUEST", recommended: false, recommendationRank: 110 }),
      }),
    ]);

    expect(sections.liveSetup.map((entry) => entry.id)).toEqual(["slack"]);
    expect(sections.recommendedSetup.map((entry) => entry.id)).toEqual(["box"]);
    expect(sections.availableOnRequest.map((entry) => entry.id)).toEqual(["miro"]);
    expect(sections.appsAndLinks.map((entry) => entry.id)).toEqual(["tool"]);
  });

  it("parses connector readiness metadata from catalog manifests", () => {
    expect(connectorReadinessForItem(item({
      type: "CONNECTOR",
      manifestJson: readiness({ key: "box", availability: "PILOT_READY" }),
    }))).toEqual(expect.objectContaining({
      key: "box",
      availability: "PILOT_READY",
      connectedBy: "Admin enables, users connect",
      supportedOperations: ["Search", "Fetch file context"],
    }));
  });

  it("does not offer API key or budget actions on connector cards", () => {
    const actions = getCatalogCardActions(item({
      id: "google",
      type: "CONNECTOR",
      title: "Google",
      url: "/api/integrations/google/connect",
      accessMode: "OPEN",
    }), { workspaceId: "workspace-1", canManageCatalog: false });

    expect(actions).toEqual([
      { kind: "link", label: "Connect", href: "/workspaces/workspace-1/tools/google", variant: "primary" },
    ]);
    expect(actions.map((action) => action.label)).not.toContain("API key");
    expect(actions.map((action) => action.label)).not.toContain("Budget");
  });

  it("does not offer Connect on pilot-ready external MCP connectors", () => {
    const actions = getCatalogCardActions(item({
      id: "box",
      type: "CONNECTOR",
      title: "Box",
      url: null,
      accessMode: "REQUEST",
      manifestJson: readiness({ key: "box", availability: "PILOT_READY" }),
    }), { workspaceId: "workspace-1", canManageCatalog: true });

    expect(actions).toEqual([
      { kind: "request", label: "Request setup", requestType: "ACCESS", variant: "primary" },
      { kind: "link", label: "Details", href: "/workspaces/workspace-1/tools/box", variant: "secondary" },
    ]);
  });

  it("shows admin setup state for admin-only connectors when the user cannot manage catalog", () => {
    const actions = getCatalogCardActions(item({
      id: "slack",
      type: "CONNECTOR",
      title: "Slack",
      url: "/api/integrations/slack/install",
      accessMode: "ADMIN_ONLY",
    }), { workspaceId: "workspace-1", canManageCatalog: false });

    expect(actions).toEqual([
      { kind: "status", label: "Admin setup required" },
      { kind: "link", label: "Details", href: "/workspaces/workspace-1/tools/slack", variant: "secondary" },
    ]);
  });

  it("lets users request meeting transcript access before transcript import is enabled", () => {
    const actions = getCatalogCardActions(item({
      id: "meeting-recorder",
      type: "TOOL",
      sourceType: "MEETING_RECORDER",
      title: "Meeting transcripts",
      url: null,
      accessMode: "REQUEST",
    }), { workspaceId: "workspace-1", canManageCatalog: false });

    expect(actions).toEqual([
      { kind: "link", label: "View setup", href: "/workspaces/workspace-1/tools/meeting-recorder", variant: "primary" },
      { kind: "request", label: "Request access", requestType: "ACCESS", variant: "secondary" },
    ]);
  });

  it("opens meeting transcript setup when transcript import is enabled", () => {
    const actions = getCatalogCardActions(item({
      id: "meeting-recorder",
      type: "TOOL",
      sourceType: "MEETING_RECORDER",
      title: "Meeting transcripts",
      url: null,
      accessMode: "OPEN",
    }), { workspaceId: "workspace-1", canManageCatalog: false });

    expect(actions).toEqual([
      { kind: "link", label: "Manage", href: "/workspaces/workspace-1/tools/meeting-recorder", variant: "primary" },
    ]);
  });

  it("uses setup language for AI workspace catalog connectors", () => {
    const actions = getCatalogCardActions(item({
      id: "openwork",
      type: "CONNECTOR",
      sourceType: "AI_WORKSPACE",
      title: "OpenWork Free",
      url: "/workspaces/workspace-1/settings?tab=ai-workspaces&provider=openwork",
      category: "AI_DEFAULT",
      accessMode: "OPEN",
    }), { workspaceId: "workspace-1", canManageCatalog: false });

    expect(actions).toEqual([
      {
        kind: "link",
        label: "Set up",
        href: "/workspaces/workspace-1/tools/openwork",
        variant: "primary",
      },
    ]);
  });

  it("links managed enterprise services to setup while allowing a request", () => {
    const actions = getCatalogCardActions(item({
      id: "managed-ai-workspace",
      type: "TOOL",
      sourceType: "ENTERPRISE_SERVICE",
      title: "Managed AI workspace",
      url: "/workspaces/workspace-1/settings?tab=ai-workspaces&service=ai_workspace",
      category: "ENTERPRISE_SERVICES",
      accessMode: "REQUEST",
    }), { workspaceId: "workspace-1", canManageCatalog: false });

    expect(actions).toEqual([
      {
        kind: "link",
        label: "View setup",
        href: "/workspaces/workspace-1/tools/managed-ai-workspace",
        variant: "primary",
      },
      {
        kind: "request",
        label: "Request access",
        requestType: "ACCESS",
        variant: "secondary",
      },
    ]);
  });

  it("treats marketplace apps as installable rather than generic tool links", () => {
    const actions = getCatalogCardActions(item({
      id: "finance-suite",
      type: "APP",
      title: "Finance Suite",
      url: null,
      accessMode: "REQUEST",
      appCategory: "FINANCE",
      installationStatus: "NEEDS_SETUP",
      integrationDepth: "KNOWLEDGE_SYNCED",
    }), { workspaceId: "workspace-1", canManageCatalog: false });

    expect(actions).toEqual([
      { kind: "request", label: "Request install", requestType: "ACCESS", variant: "primary" },
      { kind: "link", label: "Details", href: "/workspaces/workspace-1/tools/finance-suite", variant: "secondary" },
    ]);
  });
});
