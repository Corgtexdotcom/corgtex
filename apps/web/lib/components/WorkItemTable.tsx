import type { ReactNode } from "react";

export type WorkItemTableColumn = {
  id: string;
  label: ReactNode;
  mobileLabel?: string;
  align?: "left" | "center" | "right";
  className?: string;
  headerClassName?: string;
  cellClassName?: string;
};

export type WorkItemTableRow = {
  id: string;
  cells: Record<string, ReactNode>;
  className?: string;
};

function classes(...values: Array<string | false | null | undefined>) {
  return values.filter(Boolean).join(" ");
}

function alignClass(align: WorkItemTableColumn["align"]) {
  if (align === "center") return "nr-table-cell-center";
  if (align === "right") return "nr-table-cell-right";
  return undefined;
}

export function WorkItemTable({
  columns,
  rows,
  empty,
}: {
  columns: WorkItemTableColumn[];
  rows: WorkItemTableRow[];
  empty?: ReactNode;
}) {
  if (rows.length === 0) {
    return empty ? <>{empty}</> : null;
  }

  return (
    <div className="nr-table-wrap nr-work-item-table-wrap">
      <table className="nr-table nr-work-item-table">
        <thead>
          <tr>
            {columns.map((column) => (
              <th
                key={column.id}
                className={classes(alignClass(column.align), column.className, column.headerClassName)}
              >
                {column.label}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map((row) => (
            <tr key={row.id} className={row.className}>
              {columns.map((column) => (
                <td
                  key={column.id}
                  data-label={column.mobileLabel ?? (typeof column.label === "string" ? column.label : column.id)}
                  className={classes(alignClass(column.align), column.className, column.cellClassName)}
                >
                  {row.cells[column.id] ?? null}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
