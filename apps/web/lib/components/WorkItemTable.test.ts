import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { WorkItemTable, type WorkItemTableColumn, type WorkItemTableRow } from "./WorkItemTable";

const columns: WorkItemTableColumn[] = [
  { id: "title", label: "Title" },
];

describe("WorkItemTable", () => {
  it("marks populated tables as workspace table surfaces", () => {
    const rows: WorkItemTableRow[] = [
      { id: "row-1", cells: { title: "First item" } },
    ];

    const html = renderToStaticMarkup(createElement(WorkItemTable, { columns, rows }));

    expect(html).toContain("nr-workspace-table-surface");
    expect(html).toContain("nr-work-item-table-wrap");
    expect(html).toContain("<table");
  });

  it("marks empty table states as workspace table surfaces", () => {
    const html = renderToStaticMarkup(createElement(WorkItemTable, {
      columns,
      rows: [],
      empty: createElement("p", null, "No rows"),
    }));

    expect(html).toContain("nr-workspace-table-surface");
    expect(html).toContain("No rows");
    expect(html).not.toContain("<table");
  });
});
