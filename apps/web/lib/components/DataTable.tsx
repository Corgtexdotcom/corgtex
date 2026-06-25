import React, { type ReactNode } from "react";
import { cn } from "@/lib/utils";

export type DataTableColumn = {
  id: string;
  label: ReactNode;
  mobileLabel?: string;
  align?: "left" | "center" | "right";
  className?: string;
  headerClassName?: string;
  cellClassName?: string;
};

export type DataTableRow = {
  id: string;
  cells: Record<string, ReactNode>;
  className?: string;
};

function alignClass(align: DataTableColumn["align"]) {
  if (align === "center") return "nr-table-cell-center";
  if (align === "right") return "nr-table-cell-right";
  return undefined;
}

function mobileLabel(column: DataTableColumn) {
  return column.mobileLabel ?? (typeof column.label === "string" ? column.label : column.id);
}

export function DataTable({
  columns,
  rows,
  empty,
  surfaceClassName,
  tableClassName,
}: {
  columns: DataTableColumn[];
  rows: DataTableRow[];
  empty?: ReactNode;
  surfaceClassName?: string;
  tableClassName?: string;
}) {
  const surfaceClasses = cn("nr-table-wrap nr-workspace-table-surface", surfaceClassName);

  if (rows.length === 0) {
    return empty ? <div className={cn(surfaceClasses, "nr-table-empty")}>{empty}</div> : null;
  }

  return (
    <div className={surfaceClasses}>
      <table className={cn("nr-table nr-data-table", tableClassName)}>
        <thead>
          <tr>
            {columns.map((column) => (
              <th
                key={column.id}
                className={cn(alignClass(column.align), column.className, column.headerClassName)}
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
                  data-label={mobileLabel(column)}
                  className={cn(alignClass(column.align), column.className, column.cellClassName)}
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
