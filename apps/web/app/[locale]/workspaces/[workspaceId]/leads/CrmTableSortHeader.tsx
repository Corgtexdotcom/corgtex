import type { ReactNode } from "react";
import { ArrowDown, ArrowUp, ArrowUpDown } from "lucide-react";

import {
  crmSortHref,
  type CrmSortDirection,
  type SearchParamsRecord,
} from "./full-page-utils";

export function CrmTableSortHeader({
  label,
  sortKey,
  activeSort,
  direction,
  defaultDirection = "asc",
  path,
  current,
}: {
  label: ReactNode;
  sortKey: string;
  activeSort?: string;
  direction: CrmSortDirection;
  defaultDirection?: CrmSortDirection;
  path: string;
  current: SearchParamsRecord;
}) {
  const isActive = activeSort === sortKey;
  const icon = isActive
    ? direction === "asc"
      ? <ArrowUp size={13} aria-hidden="true" />
      : <ArrowDown size={13} aria-hidden="true" />
    : <ArrowUpDown size={13} aria-hidden="true" />;

  return (
    <a
      href={crmSortHref(path, current, sortKey, activeSort, direction, defaultDirection)}
      className={`nr-sort-header ${isActive ? "nr-sort-header-active" : ""}`}
      aria-current={isActive ? "true" : undefined}
    >
      <span>{label}</span>
      <span className="nr-sort-indicator">{icon}</span>
    </a>
  );
}
