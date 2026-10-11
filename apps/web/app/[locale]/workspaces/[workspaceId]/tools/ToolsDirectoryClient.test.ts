import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { NextIntlClientProvider } from "next-intl";
import { describe, expect, it, vi } from "vitest";
import messages from "@/messages/en.json";
import { ToolsDirectoryClient } from "./ToolsDirectoryClient";
import { ToolsViewSwitch } from "./ToolsViewSwitch";

Object.assign(globalThis, { React });

const route = vi.hoisted(() => ({ search: "", pathname: "/en/workspaces/synthetic-workspace/tools" }));

vi.mock("next/navigation", () => ({
  useRouter: () => ({ refresh: vi.fn() }),
  usePathname: () => route.pathname,
  useSearchParams: () => new URLSearchParams(route.search),
}));

const date = "2026-01-01T12:00:00.000Z";
const dataSource = {
  id: "data-source",
  type: "DATA_SOURCE",
  sourceType: "DATA_SOURCE",
  sourceId: "source-1",
  title: "Synthetic warehouse source",
  outcome: "Search synthetic warehouse data.",
  descriptionMd: "Database source.",
  url: "/workspaces/synthetic-workspace/settings?tab=data-sources",
  category: "DATA",
  status: "PUBLISHED",
  accessMode: "ADMIN_ONLY",
  featured: false,
  isFavorite: false,
  appCategory: "DATA",
  installationStatus: "INSTALLED",
  integrationDepth: "KNOWLEDGE_SYNCED",
  appMcpUrl: null,
  manifestJson: null,
  capabilitiesJson: null,
  pendingRequestCount: 0,
  accessNotesMd: null,
  requestedScopes: [],
  monthlyBudgetCents: null,
  dailyCallLimit: null,
  createdAt: date,
  updatedAt: date,
  createdBy: null,
  owner: null,
  isUploaded: false,
  appVisibility: "WORKSPACE_PRIVATE",
  hostingMode: "EXTERNAL_URL",
  supportUrl: null,
  dataClassification: null,
  proofUrl: null,
  reviewUrl: null,
};

const capturedLink = {
  id: "captured-link",
  providerKey: "generic_url",
  externalId: "captured-1",
  resourceType: "WEB_PAGE",
  category: "OTHER",
  priority: 0,
  title: "Generic captured link",
  url: "https://example.test/ordinary-link",
  sharedLinkUrl: null,
  mimeType: null,
  descriptionMd: null,
  summaryMd: null,
  lastEnrichedAt: null,
  lastEnrichmentError: null,
  archivedAt: null,
  archiveReason: null,
  createdAt: date,
  updatedAt: date,
  createdBy: null,
  mentions: [],
};

function renderDirectory(search: string, items: Array<typeof dataSource> = [dataSource]) {
  route.search = search;
  const props = {
    workspaceId: "synthetic-workspace",
    initialLinks: [],
    initialCatalogItems: items,
    initialRequests: [],
    canManageCatalog: false,
    circles: [],
    initialView: "list",
    initialExternalResources: [capturedLink],
  } as unknown as Parameters<typeof ToolsDirectoryClient>[0];
  return renderToStaticMarkup(React.createElement(
    NextIntlClientProvider,
    { locale: "en", messages, timeZone: "UTC" } as unknown as React.ComponentProps<typeof NextIntlClientProvider>,
    React.createElement(ToolsDirectoryClient, props),
  ));
}

describe("Tools data-source route", () => {
  it.each(["type=DATA_SOURCE", "surface=apps&type=DATA_SOURCE"])("shows only data-source cards for %s", (search) => {
    const html = renderDirectory(search);
    expect(html).toContain("Synthetic warehouse source");
    expect(html).toContain("Data (1)");
    expect(html).toContain("1 items");
    expect(html).toMatch(/class="nr-filter-item nr-filter-active"[^>]*>Apps \(1\)/);
    expect(html).toMatch(/class="nr-filter-item nr-filter-active"[^>]*>Data \(1\)/);
    expect(html).not.toContain("Generic captured link");
    expect(html).not.toContain("Manual shared-link management");
    expect(html).not.toContain("Add manual link");
  });

  it("shows disabled data-source entries in the selected filter", () => {
    const html = renderDirectory("surface=apps&type=DATA_SOURCE", [{ ...dataSource, status: "DISABLED" }]);
    expect(html).toContain("Synthetic warehouse source");
    expect(html).toContain("Data (1)");
    expect(html).toContain(">Disabled</span>");
  });

  it("shows a data-source empty state without generic link content", () => {
    const html = renderDirectory("surface=apps&type=DATA_SOURCE", []);
    expect(html).toContain("Data (0)");
    expect(html).toContain("No data sources found.");
    expect(html).toContain("No data sources are available in this workspace.");
    expect(html).not.toContain("Generic captured link");
  });

  it("keeps ordinary captured links on the Links surface", () => {
    const html = renderDirectory("surface=links&type=DATA_SOURCE");
    expect(html).toContain("Generic captured link");
    expect(html).toContain("Manual shared-link management");
    expect(html).not.toContain("Synthetic warehouse source");
  });

  it("keeps the locale, workspace, and filter when changing view", () => {
    route.search = "surface=apps&type=DATA_SOURCE&q=warehouse&view=list";
    const html = renderToStaticMarkup(React.createElement(ToolsViewSwitch, { listLabel: "List", gridLabel: "Grid" }));
    expect(html).toContain("href=\"/en/workspaces/synthetic-workspace/tools?surface=apps&amp;type=DATA_SOURCE&amp;q=warehouse&amp;view=grid\"");
  });
});
