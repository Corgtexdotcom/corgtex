import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { CheckboxFilter, FilterField, FilterToolbar, TableActionGroup } from "./ControlPrimitives";

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
});
