export const WORK_ITEM_PRIORITY_OPTIONS = [
  { value: 3, labelKey: "priorityUrgent", fallbackLabel: "Urgent" },
  { value: 2, labelKey: "priorityImportant", fallbackLabel: "Important" },
  { value: 1, labelKey: "priorityMedium", fallbackLabel: "Medium" },
  { value: 0, labelKey: "priorityLow", fallbackLabel: "Low" },
] as const;

export type WorkItemPriorityValue = typeof WORK_ITEM_PRIORITY_OPTIONS[number]["value"];
export type WorkItemPriorityLabel = typeof WORK_ITEM_PRIORITY_OPTIONS[number]["fallbackLabel"];
export type WorkItemPriorityLabels = Record<WorkItemPriorityValue, string>;

export const DEFAULT_WORK_ITEM_PRIORITY_LABELS: WorkItemPriorityLabels = {
  3: "Urgent",
  2: "Important",
  1: "Medium",
  0: "Low",
};

const PRIORITY_LABELS = new Map<string, WorkItemPriorityValue>(
  WORK_ITEM_PRIORITY_OPTIONS.map((option) => [option.fallbackLabel.toLowerCase(), option.value]),
);

export function normalizeWorkItemPriority(priority: number | null | undefined): WorkItemPriorityValue {
  if (priority === null || priority === undefined || Number.isNaN(priority)) return 0;
  if (priority >= 3) return 3;
  if (priority >= 2) return 2;
  if (priority >= 1) return 1;
  return 0;
}

export function formatWorkItemPriority(
  priority: number | null | undefined,
  labels: WorkItemPriorityLabels = DEFAULT_WORK_ITEM_PRIORITY_LABELS,
) {
  return labels[normalizeWorkItemPriority(priority)];
}

export function parseWorkItemPriorityInput(input: unknown): WorkItemPriorityValue | undefined {
  if (input === undefined || input === null) return undefined;
  if (typeof input === "number" && Number.isFinite(input)) return normalizeWorkItemPriority(input);
  if (typeof input !== "string") return undefined;

  const normalized = input.trim().toLowerCase();
  if (!normalized) return undefined;
  const labelValue = PRIORITY_LABELS.get(normalized);
  if (labelValue !== undefined) return labelValue;

  const numericValue = Number(normalized);
  if (Number.isFinite(numericValue)) return normalizeWorkItemPriority(numericValue);
  return undefined;
}

export function coerceWorkItemPriorityInput(input: unknown, fieldName = "priority") {
  const parsed = parseWorkItemPriorityInput(input);
  if (parsed !== undefined) return parsed;
  if (input === undefined || input === null || input === "") return undefined;
  throw new Error(`${fieldName} must be Urgent, Important, Medium, Low, or an integer priority.`);
}
