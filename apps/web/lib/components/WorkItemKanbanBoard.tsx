"use client";

import type { ReactNode } from "react";
import { useEffect, useMemo, useState } from "react";
import { createPortal } from "react-dom";
import { Eye, EyeOff, GripVertical, MoveDown, MoveUp, RotateCcw, Settings2 } from "lucide-react";

export type WorkItemKanbanItem = {
  id: string;
  status: string;
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
  hidden?: string[];
};

function normalizeOrder(columns: WorkItemKanbanColumn[], stored?: string[]) {
  const ids = columns.map((column) => column.id);
  const knownStored = (stored ?? []).filter((id) => ids.includes(id));
  return [...knownStored, ...ids.filter((id) => !knownStored.includes(id))];
}

function transitionKey(itemId: string, targetStatus: string) {
  return `${itemId}:${targetStatus}`;
}

export function WorkItemKanbanBoard({
  columns,
  storageKey,
  settingsPortalId,
  settingsLabel,
  resetLabel,
  hideLabel,
  showLabel,
  moveUpLabel,
  moveDownLabel,
  hideShortLabel,
  showShortLabel,
  moveUpShortLabel,
  moveDownShortLabel,
  dragUnavailableLabel,
}: {
  columns: WorkItemKanbanColumn[];
  storageKey: string;
  settingsPortalId?: string;
  settingsLabel: string;
  resetLabel: string;
  hideLabel: string;
  showLabel: string;
  moveUpLabel: string;
  moveDownLabel: string;
  hideShortLabel: string;
  showShortLabel: string;
  moveUpShortLabel: string;
  moveDownShortLabel: string;
  dragUnavailableLabel: string;
}) {
  const defaultOrder = useMemo(() => columns.map((column) => column.id), [columns]);
  const [columnOrder, setColumnOrder] = useState(defaultOrder);
  const [hiddenColumns, setHiddenColumns] = useState<string[]>([]);
  const [draggedItem, setDraggedItem] = useState<{ id: string; status: string } | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [hydrated, setHydrated] = useState(false);
  const [settingsTarget, setSettingsTarget] = useState<HTMLElement | null>(null);

  const columnsById = useMemo(() => new Map(columns.map((column) => [column.id, column])), [columns]);

  useEffect(() => {
    setColumnOrder((current) => normalizeOrder(columns, current.length > 0 ? current : defaultOrder));
  }, [columns, defaultOrder]);

  useEffect(() => {
    try {
      const raw = window.localStorage.getItem(storageKey);
      if (raw) {
        const parsed = JSON.parse(raw) as StoredColumnPrefs;
        setColumnOrder(normalizeOrder(columns, parsed.order));
        setHiddenColumns((parsed.hidden ?? []).filter((id) => columnsById.has(id)));
      } else {
        setColumnOrder(defaultOrder);
        setHiddenColumns([]);
      }
    } catch {
      setColumnOrder(defaultOrder);
      setHiddenColumns([]);
    } finally {
      setHydrated(true);
    }
  }, [columns, columnsById, defaultOrder, storageKey]);

  useEffect(() => {
    if (!hydrated) return;
    window.localStorage.setItem(storageKey, JSON.stringify({ order: columnOrder, hidden: hiddenColumns }));
  }, [columnOrder, hiddenColumns, hydrated, storageKey]);

  useEffect(() => {
    if (!settingsPortalId) {
      setSettingsTarget(null);
      return;
    }
    setSettingsTarget(document.getElementById(settingsPortalId));
  }, [settingsPortalId]);

  const orderedColumns = columnOrder
    .map((id) => columnsById.get(id))
    .filter((column): column is WorkItemKanbanColumn => Boolean(column));
  const visibleColumns = orderedColumns.filter((column) => !hiddenColumns.includes(column.id));

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

  function toggleColumn(columnId: string) {
    setHiddenColumns((current) => (
      current.includes(columnId)
        ? current.filter((id) => id !== columnId)
        : [...current, columnId]
    ));
  }

  function resetColumns() {
    setColumnOrder(defaultOrder);
    setHiddenColumns([]);
    setMessage(null);
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

  const settingsControl = (
    <details className="nr-icon-menu">
      <summary className="nr-icon-link" aria-label={settingsLabel} title={settingsLabel}>
        <Settings2 size={17} aria-hidden="true" />
      </summary>
      <div className="nr-icon-menu-popover nr-column-menu">
        {orderedColumns.map((column, index) => {
          const hidden = hiddenColumns.includes(column.id);
          return (
            <div className="nr-column-menu-row" key={column.id}>
              <span className="nr-column-menu-label">
                <GripVertical size={14} aria-hidden="true" />
                {column.label}
              </span>
              <div className="nr-column-menu-actions">
                <button type="button" className="nr-column-menu-action" onClick={() => moveColumn(column.id, -1)} disabled={index === 0} aria-label={moveUpLabel}>
                  <MoveUp size={14} aria-hidden="true" />
                  <span>{moveUpShortLabel}</span>
                </button>
                <button type="button" className="nr-column-menu-action" onClick={() => moveColumn(column.id, 1)} disabled={index === orderedColumns.length - 1} aria-label={moveDownLabel}>
                  <MoveDown size={14} aria-hidden="true" />
                  <span>{moveDownShortLabel}</span>
                </button>
                <button type="button" className="nr-column-menu-action" onClick={() => toggleColumn(column.id)} aria-label={hidden ? showLabel : hideLabel}>
                  {hidden ? <Eye size={14} aria-hidden="true" /> : <EyeOff size={14} aria-hidden="true" />}
                  <span>{hidden ? showShortLabel : hideShortLabel}</span>
                </button>
              </div>
            </div>
          );
        })}
        <button type="button" className="nr-icon-menu-item" onClick={resetColumns}>
          <RotateCcw size={15} aria-hidden="true" />
          <span>{resetLabel}</span>
        </button>
      </div>
    </details>
  );

  return (
    <div className="nr-kanban-shell">
      {settingsPortalId ? (
        settingsTarget ? createPortal(settingsControl, settingsTarget) : null
      ) : (
        <div className="nr-kanban-tools">
          {settingsControl}
        </div>
      )}
      {message && <p className="nr-kanban-message">{message}</p>}
      <div className="nr-kanban">
        {visibleColumns.map((column) => (
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
              <span>{column.label}</span>
              <span>{column.count}</span>
            </div>
            {column.items.length === 0 && column.empty && (
              <div key={`${column.id}-empty`}>
                {column.empty}
              </div>
            )}
            {column.items.map((item) => (
              <div
                className="nr-kanban-draggable"
                draggable
                key={item.id}
                onDragStart={(event) => {
                  event.dataTransfer.effectAllowed = "move";
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
        ))}
      </div>
    </div>
  );
}
