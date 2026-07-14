import React from "react";

export type ActionPriorityLabels = {
  label: string;
  help: string;
  none: string;
  low: string;
  normal: string;
  high: string;
  urgent: string;
  legacy: string;
};

const ACTION_PRIORITY_OPTIONS = [
  { value: 0, key: "none" },
  { value: 1, key: "low" },
  { value: 2, key: "normal" },
  { value: 3, key: "high" },
  { value: 4, key: "urgent" },
] as const;

export function ActionPrioritySelect({
  name = "priority",
  defaultValue = 2,
  labels,
}: {
  name?: string;
  defaultValue?: number | null;
  labels: ActionPriorityLabels;
}) {
  const priority = Number.isFinite(defaultValue) ? Number(defaultValue) : 2;
  const hasKnownPriority = ACTION_PRIORITY_OPTIONS.some((option) => option.value === priority);

  return (
    <label>
      {labels.label}
      <select name={name} defaultValue={String(priority)}>
        {!hasKnownPriority && (
          <option value={priority}>
            {labels.legacy.replace("{priority}", String(priority))}
          </option>
        )}
        {ACTION_PRIORITY_OPTIONS.map((option) => (
          <option key={option.value} value={option.value}>
            {labels[option.key]}
          </option>
        ))}
      </select>
      <span className="nr-item-meta">{labels.help}</span>
    </label>
  );
}
