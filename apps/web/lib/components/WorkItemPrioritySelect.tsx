import type { CSSProperties } from "react";
import {
  normalizeWorkItemPriority,
  WORK_ITEM_PRIORITY_OPTIONS,
  type WorkItemPriorityLabels,
} from "@/lib/work-item-priority";

export function WorkItemPrioritySelect({
  label,
  labels,
  defaultValue,
  name = "priority",
  className,
  style,
}: {
  label: string;
  labels: WorkItemPriorityLabels;
  defaultValue?: number | null;
  name?: string;
  className?: string;
  style?: CSSProperties;
}) {
  return (
    <label className={className} style={style}>
      {label}
      <select name={name} defaultValue={String(normalizeWorkItemPriority(defaultValue))}>
        {WORK_ITEM_PRIORITY_OPTIONS.map((option) => (
          <option value={option.value} key={option.value}>
            {labels[option.value]}
          </option>
        ))}
      </select>
    </label>
  );
}
