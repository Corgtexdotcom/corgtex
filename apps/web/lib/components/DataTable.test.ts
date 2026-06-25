import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { DataTable, type DataTableColumn, type DataTableRow } from "./DataTable";

const columns: DataTableColumn[] = [
  { id: "title", label: "Title" },
  { id: "actions", label: "Actions", cellClassName: "nr-table-action-cell" },
];

describe("DataTable", () => {
  it("renders shared table surface classes and mobile labels", () => {
    const rows: DataTableRow[] = [
      { id: "row-1", cells: { title: "First item", actions: "Edit" } },
    ];

    const html = renderToStaticMarkup(createElement(DataTable, { columns, rows }));

    expect(html).toContain("nr-workspace-table-surface");
    expect(html).toContain("nr-data-table");
    expect(html).toContain("data-label=\"Title\"");
    expect(html).toContain("nr-table-action-cell");
  });

  it("renders empty states without a table", () => {
    const html = renderToStaticMarkup(createElement(DataTable, {
      columns,
      rows: [],
      empty: "No rows",
    }));

    expect(html).toContain("nr-table-empty");
    expect(html).toContain("No rows");
    expect(html).not.toContain("<table");
  });
});
