"use client";

import type { ReactNode } from "react";
import { useEffect, useMemo, useState } from "react";
import { ArrowDownAZ, ArrowDownWideNarrow, ArrowUpDown, EyeOff, MoveDown, MoveUp, RotateCcw, Settings2 } from "lucide-react";
import type { WorkItemSort, WorkItemSortable } from "@/lib/work-item-view";
import { compareWorkItemSortValues, normalizeWorkItemSort } from "@/lib/work-item-view";

export type WorkItemKanbanItem = {
  id: string;
  status: string;
  sort: WorkItemSortable;
  node: ReactNode;
};

export type WorkItemKanbanColumn = {
  id: string;
  label: string;
  count: number;
  empty?: ReactNode;
  addCard?: ReactNode;
  items: WorkItemKanbanItem[];
};

type StoredColumnPrefs = {
  order?: string[];
  sorts?: Record<string, WorkItemSort>;
};

const DEFAULT_COLUMN_SORT: WorkItemSort = "priority";

function normalizeOrder(columns: WorkItemKanbanColumn[], stored?: string[]) {
  const ids = columns.map((column) => column.id);
  const knownStored = (stored ?? []).filter((id) => ids.includes(id));
  return [...knownStored, ...ids.filter((id) => !knownStored.includes(id))];
}

function transitionKey(itemId: string, targetStatus: string) {
  return `${itemId}:${targetStatus}`;
}

function normalizeColumnSorts(columns: WorkItemKanbanColumn[], stored?: Record<string, WorkItemSort>) {
  const sorts: Record<string, WorkItemSort> = {};
  for (const column of columns) {
    sorts[column.id] = normalizeWorkItemSort(stored?.[column.id]);
  }
  return sorts;
}

function sortIcon(sort: WorkItemSort, size = 15) {
  if (sort === "alpha") return <ArrowDownAZ size={size} aria-hidden="true" />;
  if (sort === "date") return <ArrowUpDown size={size} aria-hidden="true" />;
  return <ArrowDownWideNarrow size={size} aria-hidden="true" />;
}

export function WorkItemKanbanBoard({
  columns,
  storageKey,
  visibleColumnIds,
  hideColumnHrefs,
  settingsLabel,
  resetLabel,
  hideLabel,
  moveUpLabel,
  moveDownLabel,
  hideShortLabel,
  moveUpShortLabel,
  moveDownShortLabel,
  sortLabel,
  sortPriorityLabel,
  sortDateLabel,
  sortAlphaLabel,
  dragUnavailableLabel,
}: {
  columns: WorkItemKanbanColumn[];
  storageKey: string;
  visibleColumnIds?: readonly string[];
  hideColumnHrefs?: Record<string, string>;
  settingsLabel: string;
  resetLabel: string;
  hideLabel: string;
  moveUpLabel: string;
  moveDownLabel: string;
  hideShortLabel: string;
  moveUpShortLabel: string;
  moveDownShortLabel: string;
  sortLabel: string;
  sortPriorityLabel: string;
  sortDateLabel: string;
  sortAlphaLabel: string;
  dragUnavailableLabel: string;
}) {
  const defaultOrder = useMemo(() => columns.map((column) => column.id), [columns]);
  const [columnOrder, setColumnOrder] = useState(defaultOrder);
  const [columnSorts, setColumnSorts] = useState<Record<string, WorkItemSort>>({});
  const [draggedItem, setDraggedItem] = useState<{ id: string; status: string } | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [hydrated, setHydrated] = useState(false);

  const columnsById = useMemo(() => new Map(columns.map((column) => [column.id, column])), [columns]);
  const visibleColumnSet = useMemo(() => new Set(visibleColumnIds ?? defaultOrder), [defaultOrder, visibleColumnIds]);

  useEffect(() => {
    setColumnOrder((current) => normalizeOrder(columns, current.length > 0 ? current : defaultOrder));
    setColumnSorts((current) => normalizeColumnSorts(columns, current));
  }, [columns, defaultOrder]);

  useEffect(() => {
    try {
      const raw = window.localStorage.getItem(storageKey);
      if (raw) {
        const parsed = JSON.parse(raw) as StoredColumnPrefs;
        setColumnOrder(normalizeOrder(columns, parsed.order));
        setColumnSorts(normalizeColumnSorts(columns, parsed.sorts));
      } else {
        setColumnOrder(defaultOrder);
        setColumnSorts(normalizeColumnSorts(columns));
      }
    } catch {
      setColumnOrder(defaultOrder);
      setColumnSorts(normalizeColumnSorts(columns));
    } finally {
      setHydrated(true);
    }
  }, [columns, defaultOrder, storageKey]);

  useEffect(() => {
    if (!hydrated) return;
    window.localStorage.setItem(storageKey, JSON.stringify({ order: columnOrder, sorts: columnSorts }));
  }, [columnOrder, columnSorts, hydrated, storageKey]);

  const orderedColumns = columnOrder
    .map((id) => columnsById.get(id))
    .filter((column): column is WorkItemKanbanColumn => Boolean(column));
  const visibleColumns = orderedColumns.filter((column) => visibleColumnSet.has(column.id));

  function moveColumn(columnId: string, direction: -1 | 1) {
    setColumnOrder((current) => {
      const index = current.indexOf(columnId);
      const target = index + direction;
      if (index < 0 || target < 0 || target >= current.length) return current;
      const next = [...current];
      [next[index], next[target]] = [next[target], next[index]];
      return next;
    });
  }

  function resetColumns() {
    setColumnOrder(defaultOrder);
    setColumnSorts(normalizeColumnSorts(columns));
    setMessage(null);
  }

  function setColumnSort(columnId: string, sort: WorkItemSort) {
    setColumnSorts((current) => ({ ...current, [columnId]: sort }));
  }

  function sortedItems(column: WorkItemKanbanColumn) {
    const sort = columnSorts[column.id] ?? DEFAULT_COLUMN_SORT;
    return [...column.items].sort((left, right) => compareWorkItemSortValues(left.sort, right.sort, sort));
  }

  function handleDrop(targetStatus: string) {
    if (!draggedItem || draggedItem.status === targetStatus) {
      setDraggedItem(null);
      return;
    }

    const key = transitionKey(draggedItem.id, targetStatus);
    const dialogTrigger = document.querySelector<HTMLElement>(`[data-work-item-dialog="${key}"] button`);
    if (dialogTrigger) {
      dialogTrigger.click();
      setDraggedItem(null);
      setMessage(null);
      return;
    }

    const form = document.querySelector<HTMLFormElement>(`form[data-work-item-transition="${key}"]`);
    if (form) {
      form.requestSubmit();
      setDraggedItem(null);
      setMessage(null);
      return;
    }

    setDraggedItem(null);
    setMessage(dragUnavailableLabel);
  }

  return (
    <div className="nr-kanban-shell">
      {message && <p className="nr-kanban-message">{message}</p>}
      <div className="nr-kanban">
        {visibleColumns.map((column) => {
          const orderedIndex = orderedColumns.findIndex((orderedColumn) => orderedColumn.id === column.id);
          const currentSort = columnSorts[column.id] ?? DEFAULT_COLUMN_SORT;
          const sortOptions: Array<{ value: WorkItemSort; label: string }> = [
            { value: "priority", label: sortPriorityLabel },
            { value: "date", label: sortDateLabel },
            { value: "alpha", label: sortAlphaLabel },
          ];
          const hideHref = hideColumnHrefs?.[column.id];
          const canHideColumn = visibleColumns.length > 1 && Boolean(hideHref);
          return (
            <section
              className={`nr-kanban-column ${draggedItem && draggedItem.status !== column.id ? "nr-kanban-column-drop" : ""}`}
              key={column.id}
              onDragOver={(event) => {
                event.preventDefault();
              }}
              onDrop={(event) => {
                event.preventDefault();
                handleDrop(column.id);
              }}
            >
              <div className="nr-kanban-heading">
                <span className="nr-kanban-heading-label">
                  <span>{column.label}</span>
                  <span>{column.count}</span>
                </span>
                <details className="nr-icon-menu nr-kanban-sort-menu">
                  <summary
                    className="nr-kanban-sort-trigger"
                    aria-label={`${settingsLabel}: ${column.label}`}
                    title={settingsLabel}
                  >
                    <Settings2 size={15} aria-hidden="true" />
                  </summary>
                  <div className="nr-icon-menu-popover nr-column-menu">
                    {sortOptions.map((option) => (
                      <button
                        type="button"
                        key={option.value}
                        className={`nr-icon-menu-item ${currentSort === option.value ? "nr-icon-menu-item-active" : ""}`}
                        onClick={() => setColumnSort(column.id, option.value)}
                      >
                        {sortIcon(option.value)}
                        <span>{option.label}</span>
                      </button>
                    ))}
                    <div className="nr-icon-menu-separator" />
                    <button type="button" className="nr-icon-menu-item" onClick={() => moveColumn(column.id, -1)} disabled={orderedIndex === 0} aria-label={moveUpLabel}>
                      <MoveUp size={15} aria-hidden="true" />
                      <span>{moveUpShortLabel}</span>
                    </button>
                    <button type="button" className="nr-icon-menu-item" onClick={() => moveColumn(column.id, 1)} disabled={orderedIndex === orderedColumns.length - 1} aria-label={moveDownLabel}>
                      <MoveDown size={15} aria-hidden="true" />
                      <span>{moveDownShortLabel}</span>
                    </button>
                    {canHideColumn ? (
                      <a className="nr-icon-menu-item" href={hideHref} aria-label={hideLabel}>
                        <EyeOff size={15} aria-hidden="true" />
                        <span>{hideShortLabel}</span>
                      </a>
                    ) : (
                      <button type="button" className="nr-icon-menu-item" disabled aria-label={hideLabel}>
                        <EyeOff size={15} aria-hidden="true" />
                        <span>{hideShortLabel}</span>
                      </button>
                    )}
                    <div className="nr-icon-menu-separator" />
                    <button type="button" className="nr-icon-menu-item" onClick={resetColumns}>
                      <RotateCcw size={15} aria-hidden="true" />
                      <span>{resetLabel}</span>
                    </button>
                  </div>
                </details>
              </div>
              {column.items.length === 0 && column.empty && (
                <div key={`${column.id}-empty`}>
                  {column.empty}
                </div>
              )}
              {sortedItems(column).map((item) => (
                <div
                  className="nr-kanban-draggable"
                  draggable
                  key={item.id}
                  onDragStart={(event) => {
                    event.dataTransfer.effectAllowed = "move";
                    event.dataTransfer.setData("text/plain", item.id);
                    const rect = event.currentTarget.getBoundingClientRect();
                    event.dataTransfer.setDragImage(event.currentTarget, Math.min(rect.width / 2, 180), Math.min(rect.height / 2, 80));
                    setDraggedItem({ id: item.id, status: item.status });
                    setMessage(null);
                  }}
                  onDragEnd={() => setDraggedItem(null)}
                >
                  {item.node}
                </div>
              ))}
              {column.addCard && (
                <div key={`${column.id}-add`}>
                  {column.addCard}
                </div>
              )}
            </section>
          );
        })}
      </div>
    </div>
  );
}
