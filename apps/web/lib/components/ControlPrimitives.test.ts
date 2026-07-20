import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import {
  CheckboxFilter,
  FilterField,
  FilterToolbar,
  SegmentedControl,
  TableActionGroup,
  WorkspaceEmptyState,
  WorkspacePageHeader,
  WorkspaceSubnav,
} from "./ControlPrimitives";

describe("ControlPrimitives", () => {
  it("renders filter toolbars and fields with shared classes", () => {
    const html = renderToStaticMarkup(createElement(
      FilterToolbar,
      { as: "form", className: "custom-filter" },
      createElement(
        FilterField,
        { label: "Search" },
        createElement("input", { name: "query" }),
      ),
    ));

    expect(html).toContain("<form");
    expect(html).toContain("nr-filter-panel");
    expect(html).toContain("custom-filter");
    expect(html).toContain("nr-filter-field");
  });

  it("renders inline checkbox filters without relying on global label layout", () => {
    const html = renderToStaticMarkup(createElement(
      CheckboxFilter,
      { defaultChecked: true },
      "Show archived",
    ));

    expect(html).toContain("nr-checkbox-filter");
    expect(html).toContain("type=\"checkbox\"");
    expect(html).toContain("Show archived");
  });

  it("renders table action groups with shared stack sizing", () => {
    const html = renderToStaticMarkup(createElement(
      TableActionGroup,
      { direction: "stack" },
      createElement("button", { type: "button", className: "secondary small" }, "Edit"),
      createElement("button", { type: "button", className: "secondary small" }, "Resend"),
    ));

    expect(html).toContain("nr-table-action-group");
    expect(html).toContain("nr-table-action-group-stack");
    expect(html).toContain("Edit");
    expect(html).toContain("Resend");
  });

  it("renders workspace page headers with actions and subnav slots", () => {
    const html = renderToStaticMarkup(createElement(
      WorkspacePageHeader,
      {
        title: "Actions",
        description: "Track the work.",
        actions: createElement("a", { href: "/new" }, "New action"),
        subnav: createElement("nav", { "aria-label": "Sections" }, "Subnav"),
      },
    ));

    expect(html).toContain("nr-workspace-page-header");
    expect(html).toContain("Actions");
    expect(html).toContain("Track the work.");
    expect(html).toContain("New action");
    expect(html).toContain("Subnav");
  });

  it("renders workspace subnav links with active page state", () => {
    const html = renderToStaticMarkup(createElement(WorkspaceSubnav, {
      label: "Practice Ledger sections",
      items: [
        { key: "overview", label: "Overview", href: "/finance" },
        { key: "clients", label: "Clients", href: "/finance/clients", active: true },
      ],
    }));

    expect(html).toContain("aria-label=\"Practice Ledger sections\"");
    expect(html).toContain("nr-workspace-subnav-link-active");
    expect(html).toContain("aria-current=\"page\"");
  });

  it("renders segmented controls with active state and accessible labels", () => {
    const html = renderToStaticMarkup(createElement(SegmentedControl, {
      label: "View mode",
      showLabels: "sr-only",
      density: "icon",
      items: [
        { key: "list", label: "List", href: "?view=list", active: true, ariaLabel: "List view" },
        { key: "table", label: "Table", href: "?view=table", ariaLabel: "Table view" },
      ],
    }));

    expect(html).toContain("nr-segmented-control-icon");
    expect(html).toContain("nr-segmented-item-active");
    expect(html).toContain("aria-label=\"List view\"");
    expect(html).toContain("class=\"sr-only\"");
  });

  it("renders workspace empty states with optional action", () => {
    const html = renderToStaticMarkup(createElement(
      WorkspaceEmptyState,
      {
        title: "No clients",
        description: "Create work to populate the table.",
        action: createElement("a", { href: "/add" }, "Add client"),
      },
    ));

    expect(html).toContain("nr-empty-state");
    expect(html).toContain("No clients");
    expect(html).toContain("Create work to populate the table.");
    expect(html).toContain("Add client");
  });
});
