import Link from "next/link";

import { WorkItemKanbanBoard, type WorkItemKanbanColumn } from "@/lib/components/WorkItemKanbanBoard";
import {
  flattenRoleStaffingCards,
  ROLE_STAFFING_COLUMN_IDS,
  roleStaffingSort,
  type RoleStaffingCircle,
  type RoleStaffingColumnId,
} from "./role-staffing";

type WorkItemLabels = {
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
};

type StaffingLabels = {
  accountabilityCount: (count: number) => string;
  columns: Record<RoleStaffingColumnId, string>;
  empty: Record<RoleStaffingColumnId, string>;
  holders: string;
  holderCount: (count: number) => string;
  manageRole: string;
  noPurpose: string;
  unassigned: string;
};

function circleHref(workspaceId: string, circleId: string) {
  return `/workspaces/${workspaceId}/circles/${circleId}`;
}

function roleHref(workspaceId: string, roleId: string) {
  return `/workspaces/${workspaceId}/roles/${roleId}`;
}

export function RoleStaffingBoard({
  workspaceId,
  circles,
  storageKey,
  labels,
  workItemLabels,
}: {
  workspaceId: string;
  circles: readonly RoleStaffingCircle[];
  storageKey: string;
  labels: StaffingLabels;
  workItemLabels: WorkItemLabels;
}) {
  const cards = flattenRoleStaffingCards(circles);
  const cardsByStatus = new Map<RoleStaffingColumnId, typeof cards>(
    ROLE_STAFFING_COLUMN_IDS.map((status) => [status, []]),
  );
  for (const card of cards) {
    cardsByStatus.get(card.status)?.push(card);
  }

  const columns: WorkItemKanbanColumn[] = ROLE_STAFFING_COLUMN_IDS.map((status) => {
    const columnCards = cardsByStatus.get(status) ?? [];
    return {
      id: status,
      label: labels.columns[status],
      count: columnCards.length,
      empty: <p className="muted">{labels.empty[status]}</p>,
      items: columnCards.map((card) => ({
        id: card.id,
        status,
        sort: roleStaffingSort(card),
        node: (
          <div className="nr-kanban-card">
            <div className="row" style={{ alignItems: "flex-start", gap: 8 }}>
              <strong style={{ fontSize: "0.95rem", lineHeight: 1.3 }}>
                <Link href={roleHref(workspaceId, card.role.id)} style={{ color: "inherit", textDecoration: "none" }}>
                  {card.role.name}
                </Link>
              </strong>
              <span className="tag" style={{ marginLeft: "auto", whiteSpace: "nowrap" }}>
                {labels.holderCount(card.holderCount)}
              </span>
            </div>
            <div className="nr-item-meta" style={{ marginTop: 8 }}>
              <Link href={circleHref(workspaceId, card.circle.id)} style={{ color: "var(--accent)", textDecoration: "none" }}>
                {card.circle.name}
              </Link>
            </div>
            <div className="nr-excerpt" style={{ marginTop: 10 }}>
              {card.role.purposeMd || labels.noPurpose}
            </div>
            <div className="nr-tag-group" style={{ marginTop: 10 }}>
              <span className="tag-sm">{labels.accountabilityCount(card.accountabilityCount)}</span>
            </div>
            <div style={{ display: "grid", gap: 6, marginTop: 12 }}>
              <span className="nr-item-meta">{labels.holders}</span>
              {card.holderNames.length > 0 ? (
                <div className="nr-tag-group">
                  {card.holderNames.map((name) => (
                    <span key={`${card.id}-${name}`} className="tag-sm">{name}</span>
                  ))}
                </div>
              ) : (
                <span className="muted" style={{ fontSize: "0.82rem" }}>{labels.unassigned}</span>
              )}
            </div>
            <div style={{ marginTop: 12 }}>
              <Link href={circleHref(workspaceId, card.circle.id)} className="secondary small">
                {labels.manageRole}
              </Link>
            </div>
          </div>
        ),
      })),
    };
  });

  return (
    <WorkItemKanbanBoard
      columns={columns}
      storageKey={storageKey}
      settingsLabel={workItemLabels.settingsLabel}
      resetLabel={workItemLabels.resetLabel}
      hideLabel={workItemLabels.hideLabel}
      moveUpLabel={workItemLabels.moveUpLabel}
      moveDownLabel={workItemLabels.moveDownLabel}
      hideShortLabel={workItemLabels.hideShortLabel}
      moveUpShortLabel={workItemLabels.moveUpShortLabel}
      moveDownShortLabel={workItemLabels.moveDownShortLabel}
      sortLabel={workItemLabels.sortLabel}
      sortPriorityLabel={workItemLabels.sortPriorityLabel}
      sortDateLabel={workItemLabels.sortDateLabel}
      sortAlphaLabel={workItemLabels.sortAlphaLabel}
      dragUnavailableLabel={workItemLabels.dragUnavailableLabel}
    />
  );
}
