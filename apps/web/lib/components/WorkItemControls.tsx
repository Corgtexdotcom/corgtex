import React, { type ReactNode } from "react";
import { ArrowDownAZ, ArrowDownWideNarrow, ArrowUpDown, Columns3, List, Table2 } from "lucide-react";
import type { WorkItemScope, WorkItemSort, WorkItemViewMode } from "@/lib/work-item-view";
import { MultiSelectFilter } from "@/lib/components/MultiSelectFilter";
import { SegmentedControl } from "@/lib/components/ControlPrimitives";
import { cn } from "@/lib/utils";

type Option = {
  id: string;
  label: string;
};

type DateFilter = {
  name: string;
  label: string;
  value?: string;
};

type WorkItemBadgeTone = "neutral" | "info" | "warning" | "success" | "danger" | "muted";
type WorkItemBadgeKind = "lifecycle" | "attention" | "relationship" | "metadata";

export function WorkItemBadge({
  children,
  tone = "neutral",
  kind = "metadata",
  className,
}: {
  children?: ReactNode;
  tone?: WorkItemBadgeTone;
  kind?: WorkItemBadgeKind;
  className?: string;
}) {
  return (
    <span
      className={cn(
        "tag",
        tone !== "muted" && tone,
        "nr-work-item-badge",
        `nr-work-item-badge-${kind}`,
        tone === "muted" && "nr-work-item-badge-muted",
        className,
      )}
    >
      {children}
    </span>
  );
}

export function WorkItemBadgeGroup({
  children,
  className,
}: {
  children?: ReactNode;
  className?: string;
}) {
  if (!children) return null;
  return <div className={cn("nr-work-item-badge-group", className)}>{children}</div>;
}

export function workItemLifecycleTone(status: string): WorkItemBadgeTone {
  if (status === "DRAFT" || status === "IN_PROGRESS" || status === "RESOLVED") return "info";
  if (status === "COMPLETED" || status === "ADOPTED") return "success";
  if (status === "ARCHIVED") return "muted";
  return "neutral";
}

export function WorkItemLifecycleBadge({
  status,
  label,
}: {
  status: string;
  label: ReactNode;
}) {
  return (
    <WorkItemBadge kind="lifecycle" tone={workItemLifecycleTone(status)}>
      {label}
    </WorkItemBadge>
  );
}

export function WorkItemAttentionBadge({ children, tone = "warning" }: { children?: ReactNode; tone?: WorkItemBadgeTone }) {
  return (
    <WorkItemBadge kind="attention" tone={tone}>
      {children}
    </WorkItemBadge>
  );
}

export function WorkItemRelationshipTag({
  href,
  children,
}: {
  href: string;
  children?: ReactNode;
}) {
  return (
    <a href={href} className="tag tag-sm no-underline nr-work-item-badge nr-work-item-badge-relationship" draggable={false}>
      {children}
    </a>
  );
}

export function WorkItemCard({
  compact = false,
  href,
  title,
  titlePrefix,
  ariaLabel,
  badges,
  body,
  actions,
  hiddenTransitions,
}: {
  compact?: boolean;
  href: string;
  title: ReactNode;
  titlePrefix?: ReactNode;
  ariaLabel: string;
  badges?: ReactNode;
  body?: ReactNode;
  actions?: ReactNode;
  hiddenTransitions?: ReactNode;
}) {
  return (
    <div className={cn(compact ? "nr-kanban-card" : "nr-item nr-list-card", "nr-work-item-card nr-clickable-card")}>
      <a href={href} className="nr-card-hitbox" aria-label={ariaLabel} draggable={false} />
      <div className="nr-card-content nr-work-item-card-header">
        <strong className="nr-item-title nr-work-item-card-title">
          {titlePrefix}
          {title}
        </strong>
        <WorkItemBadgeGroup className="nr-work-item-card-badges">
          {badges}
        </WorkItemBadgeGroup>
      </div>
      {body && <div className="nr-card-content nr-work-item-card-body">{body}</div>}
      {actions}
      {hiddenTransitions}
    </div>
  );
}

export function WorkItemViewToggle({
  currentView,
  listHref,
  kanbanHref,
  tableHref,
  listLabel,
  kanbanLabel,
  tableLabel,
  label,
  availableViews = ["list", "kanban", "table"],
}: {
  currentView: WorkItemViewMode;
  listHref?: string;
  kanbanHref?: string;
  tableHref?: string;
  listLabel: string;
  kanbanLabel: string;
  tableLabel: string;
  label: string;
  availableViews?: WorkItemViewMode[];
}) {
  const viewItems = [
    { id: "list" as const, href: listHref, label: listLabel, icon: <List size={17} aria-hidden="true" /> },
    { id: "kanban" as const, href: kanbanHref, label: kanbanLabel, icon: <Columns3 size={17} aria-hidden="true" /> },
    { id: "table" as const, href: tableHref, label: tableLabel, icon: <Table2 size={17} aria-hidden="true" /> },
  ].filter((item) => availableViews.includes(item.id) && item.href);

  return (
    <SegmentedControl
      label={label}
      density="icon"
      showLabels="sr-only"
      className="nr-view-toggle"
      items={viewItems.map((item) => ({
        key: item.id,
        href: item.href!,
        label: item.label,
        icon: item.icon,
        active: currentView === item.id,
        ariaLabel: item.label,
        title: item.label,
      }))}
    />
  );
}

export function WorkItemToolbar({
  currentView,
  currentSort,
  listHref,
  kanbanHref,
  tableHref,
  sortLinks,
  listLabel,
  kanbanLabel,
  tableLabel,
  sortLabel,
  sortPriorityLabel,
  sortDateLabel,
  sortAlphaLabel,
  label,
  availableViews,
  showSort = true,
}: {
  currentView: WorkItemViewMode;
  currentSort: WorkItemSort;
  listHref?: string;
  kanbanHref?: string;
  tableHref?: string;
  sortLinks: Record<WorkItemSort, string>;
  listLabel: string;
  kanbanLabel: string;
  tableLabel: string;
  sortLabel: string;
  sortPriorityLabel: string;
  sortDateLabel: string;
  sortAlphaLabel: string;
  label: string;
  availableViews?: WorkItemViewMode[];
  showSort?: boolean;
}) {
  const sortOptions: Array<{ id: WorkItemSort; label: string; icon: ReactNode }> = [
    { id: "priority", label: sortPriorityLabel, icon: <ArrowDownWideNarrow size={15} aria-hidden="true" /> },
    { id: "date", label: sortDateLabel, icon: <ArrowUpDown size={15} aria-hidden="true" /> },
    { id: "alpha", label: sortAlphaLabel, icon: <ArrowDownAZ size={15} aria-hidden="true" /> },
  ];

  return (
    <div className="nr-work-toolbar" aria-label={label}>
      <WorkItemViewToggle
        currentView={currentView}
        listHref={listHref}
        kanbanHref={kanbanHref}
        tableHref={tableHref}
        listLabel={listLabel}
        kanbanLabel={kanbanLabel}
        tableLabel={tableLabel}
        label={label}
        availableViews={availableViews}
      />
      {showSort && (currentView === "list" || currentView === "table") && (
        <details className="nr-icon-menu">
          <summary className="nr-icon-link" aria-label={sortLabel} title={sortLabel}>
            <ArrowUpDown size={17} aria-hidden="true" />
          </summary>
          <div className="nr-icon-menu-popover">
            {sortOptions.map((option) => (
              <a
                key={option.id}
                href={sortLinks[option.id]}
                className={`nr-icon-menu-item ${currentSort === option.id ? "nr-icon-menu-item-active" : ""}`}
              >
                {option.icon}
                <span>{option.label}</span>
              </a>
            ))}
          </div>
        </details>
      )}
    </div>
  );
}

export function WorkItemFilterControls({
  action,
  status,
  view,
  scope,
  sort,
  columns,
  circleId,
  circleIds,
  assigneeMemberId,
  assigneeMemberIds,
  memberId,
  memberIds,
  group,
  statusOptions,
  statusValues,
  circles,
  assigneeMembers,
  members,
  dates = [],
  clearHref,
  showCircle = true,
  showMember = true,
  showStatusFilter = true,
  summaryLabel,
  labels,
}: {
  action: string;
  status?: string;
  view?: WorkItemViewMode;
  scope?: WorkItemScope;
  sort?: WorkItemSort;
  columns?: readonly string[];
  circleId?: string;
  circleIds?: readonly string[];
  assigneeMemberId?: string;
  assigneeMemberIds?: readonly string[];
  memberId?: string;
  memberIds?: readonly string[];
  group?: string;
  statusOptions?: Option[];
  statusValues?: readonly string[];
  circles: Option[];
  assigneeMembers?: Option[];
  members: Option[];
  dates?: DateFilter[];
  clearHref?: string;
  showCircle?: boolean;
  showMember?: boolean;
  showStatusFilter?: boolean;
  summaryLabel?: string;
  labels: {
    scope?: string;
    company?: string;
    circle: string;
    assignee?: string;
    person: string;
    allCircles: string;
    allAssignees?: string;
    allPeople: string;
    status?: string;
    allStatuses?: string;
    selectAll?: string;
    unselectAll?: string;
    selectedCount?: string;
    apply: string;
    clear: string;
  };
}) {
  const selectedCircleIds = circleIds ?? (circleId ? [circleId] : []);
  const selectedAssigneeMemberIds = assigneeMemberIds ?? (assigneeMemberId ? [assigneeMemberId] : []);
  const selectedMemberIds = memberIds ?? (memberId ? [memberId] : []);
  const hiddenStatusValues = statusValues && statusValues.length > 0
    ? statusValues
    : status
      ? [status]
      : [];
  const hasActiveAdvancedFilters = Boolean(
    selectedCircleIds.length > 0
      || selectedAssigneeMemberIds.length > 0
      || selectedMemberIds.length > 0
      || dates.some((date) => Boolean(date.value))
      || Boolean(scope && scope !== "company"),
  );

  const form = (
    <form className="nr-filter-panel" action={action}>
      {status && !statusOptions && <input type="hidden" name="status" value={status} />}
      {view && view !== "list" && <input type="hidden" name="view" value={view} />}
      {sort && sort !== "priority" && <input type="hidden" name="sort" value={sort} />}
      {columns && columns.length > 0 && <input type="hidden" name="columns" value={columns.join(",")} />}
      {group && <input type="hidden" name="group" value={group} />}
      {statusOptions && showStatusFilter && (
        <MultiSelectFilter
          name="status"
          label={labels.status ?? "Status"}
          options={statusOptions.map((option) => ({ value: option.id, label: option.label }))}
          selectedValues={statusValues}
          allLabel={labels.allStatuses ?? labels.status ?? "All statuses"}
          selectAllLabel={labels.selectAll}
          unselectAllLabel={labels.unselectAll}
          selectedCountLabel={labels.selectedCount}
        />
      )}
      {statusOptions && !showStatusFilter && hiddenStatusValues.map((value) => (
        <input key={value} type="hidden" name="status" value={value} />
      ))}
      {scope && (
        <label>
          <span className="nr-item-meta">{labels.scope}</span>
          <select name="scope" defaultValue={scope}>
            <option value="company">{labels.company}</option>
            {showCircle && <option value="circle">{labels.circle}</option>}
            {showMember && <option value="member">{labels.person}</option>}
          </select>
        </label>
      )}
      {showCircle && (
        <MultiSelectFilter
          name="circleId"
          label={labels.circle}
          options={circles.map((circle) => ({ value: circle.id, label: circle.label }))}
          selectedValues={selectedCircleIds}
          allLabel={labels.allCircles}
          selectAllLabel={labels.selectAll}
          unselectAllLabel={labels.unselectAll}
          selectedCountLabel={labels.selectedCount}
        />
      )}
      {assigneeMembers && assigneeMembers.length > 0 && (
        <MultiSelectFilter
          name="assigneeMemberId"
          label={labels.assignee ?? "Assigned to"}
          options={assigneeMembers.map((member) => ({ value: member.id, label: member.label }))}
          selectedValues={selectedAssigneeMemberIds}
          allLabel={labels.allAssignees ?? "All assignees"}
          selectAllLabel={labels.selectAll}
          unselectAllLabel={labels.unselectAll}
          selectedCountLabel={labels.selectedCount}
          collapseAllToEmpty={false}
        />
      )}
      {showMember && (
        <MultiSelectFilter
          name="memberId"
          label={labels.person}
          options={members.map((member) => ({ value: member.id, label: member.label }))}
          selectedValues={selectedMemberIds}
          allLabel={labels.allPeople}
          selectAllLabel={labels.selectAll}
          unselectAllLabel={labels.unselectAll}
          selectedCountLabel={labels.selectedCount}
        />
      )}
      {dates.map((date) => (
        <label key={date.name}>
          <span className="nr-item-meta">{date.label}</span>
          <input name={date.name} type="date" defaultValue={date.value ?? ""} />
        </label>
      ))}
      <div className="actions-inline">
        <button type="submit" className="secondary small">{labels.apply}</button>
        <a className="link-button small" href={clearHref ?? action}>{labels.clear}</a>
      </div>
    </form>
  );

  if (!summaryLabel) return form;

  return (
    <details className="nr-work-item-advanced-filters" open={hasActiveAdvancedFilters}>
      <summary className="nr-hide-marker nr-work-item-advanced-filters-summary">
        {summaryLabel}
      </summary>
      {form}
    </details>
  );
}
