import React, { type ReactNode } from "react";
import { DataTable, type DataTableColumn, type DataTableRow } from "@/lib/components/DataTable";

export type WorkItemTableColumn = DataTableColumn;

export type WorkItemTableRow = DataTableRow;

export function WorkItemTable({
  columns,
  rows,
  empty,
}: {
  columns: WorkItemTableColumn[];
  rows: WorkItemTableRow[];
  empty?: ReactNode;
}) {
  return <DataTable columns={columns} rows={rows} empty={empty} surfaceClassName="nr-work-item-table-wrap" tableClassName="nr-work-item-table" />;
}
