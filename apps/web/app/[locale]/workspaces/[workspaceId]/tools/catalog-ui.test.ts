import { describe, expect, it } from "vitest";
import {
  filterCatalogItems,
  getCatalogCardActions,
  splitDefaultCatalogSections,
  type CatalogItemForUi,
} from "./catalog-ui";

function item(overrides: Partial<CatalogItemForUi>): CatalogItemForUi {
  return {
    id: overrides.id ?? "item-1",
    type: overrides.type ?? "TOOL",
    title: overrides.title ?? "Shared tool",
    outcome: overrides.outcome ?? null,
    descriptionMd: overrides.descriptionMd ?? null,
    url: overrides.url ?? "https://example.com",
    category: overrides.category ?? "OTHER",
    status: overrides.status ?? "PUBLISHED",
    accessMode: overrides.accessMode ?? "OPEN",
    featured: overrides.featured ?? false,
    isFavorite: overrides.isFavorite ?? false,
  };
}

describe("Tools catalog UI helpers", () => {
  it("sorts connectors before the rest of the catalog", () => {
    const result = filterCatalogItems([
      item({ id: "tool", type: "TOOL", title: "Tool" }),
      item({ id: "agent", type: "AGENT", title: "Agent" }),
      item({ id: "connector", type: "CONNECTOR", title: "Google" }),
    ], { activeType: "ALL", query: "" });

    expect(result.map((entry) => entry.id)).toEqual(["connector", "agent", "tool"]);
  });

  it("filters by selected item type", () => {
    const result = filterCatalogItems([
      item({ id: "google", type: "CONNECTOR", title: "Google" }),
      item({ id: "app", type: "APP", title: "Estimator" }),
    ], { activeType: "CONNECTOR", query: "" });

    expect(result.map((entry) => entry.id)).toEqual(["google"]);
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

  it("keeps connectors in a dedicated default section", () => {
    const sections = splitDefaultCatalogSections([
      item({ id: "tool", type: "TOOL" }),
      item({ id: "connector", type: "CONNECTOR" }),
    ]);

    expect(sections.connectors.map((entry) => entry.id)).toEqual(["connector"]);
    expect(sections.catalog.map((entry) => entry.id)).toEqual(["tool"]);
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
      { kind: "link", label: "Connect", href: "/api/integrations/google/connect", variant: "primary" },
      { kind: "link", label: "Details", href: "/workspaces/workspace-1/tools/google", variant: "secondary" },
    ]);
    expect(actions.map((action) => action.label)).not.toContain("API key");
    expect(actions.map((action) => action.label)).not.toContain("Budget");
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

  it("lets users request meeting recorder access before the recorder is enabled", () => {
    const actions = getCatalogCardActions(item({
      id: "meeting-recorder",
      type: "TOOL",
      title: "Meeting recorder",
      url: null,
      accessMode: "REQUEST",
    }), { workspaceId: "workspace-1", canManageCatalog: false });

    expect(actions).toEqual([
      { kind: "request", label: "Request access", requestType: "ACCESS", variant: "primary" },
      { kind: "link", label: "Details", href: "/workspaces/workspace-1/tools/meeting-recorder", variant: "secondary" },
    ]);
  });

  it("opens meeting recorder setup when the recorder is enabled", () => {
    const actions = getCatalogCardActions(item({
      id: "meeting-recorder",
      type: "TOOL",
      title: "Meeting recorder",
      url: "/workspaces/workspace-1/settings?tab=general",
      accessMode: "OPEN",
    }), { workspaceId: "workspace-1", canManageCatalog: false });

    expect(actions).toEqual([
      { kind: "link", label: "Open", href: "/workspaces/workspace-1/settings?tab=general", variant: "primary" },
      { kind: "link", label: "Details", href: "/workspaces/workspace-1/tools/meeting-recorder", variant: "secondary" },
    ]);
  });
});
