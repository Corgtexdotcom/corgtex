import React, { type ReactNode } from "react";
import { ArrowDownAZ, ArrowDownWideNarrow, ArrowUpDown, Columns3, List, Table2 } from "lucide-react";
import type { WorkItemScope, WorkItemSort, WorkItemViewMode } from "@/lib/work-item-view";
import { MultiSelectFilter } from "@/lib/components/MultiSelectFilter";

type Option = {
  id: string;
  label: string;
};

type DateFilter = {
  name: string;
  label: string;
  value?: string;
};

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
    <div className="nr-view-toggle" aria-label={label}>
      {viewItems.map((item) => (
        <a
          key={item.id}
          href={item.href}
          className={`nr-icon-link ${currentView === item.id ? "nr-icon-link-active" : ""}`}
          aria-label={item.label}
          title={item.label}
        >
          {item.icon}
        </a>
      ))}
    </div>
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
  statusOptions,
  statusValues,
  circles,
  assigneeMembers,
  members,
  dates = [],
  clearHref,
  showCircle = true,
  showMember = true,
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
  statusOptions?: Option[];
  statusValues?: readonly string[];
  circles: Option[];
  assigneeMembers?: Option[];
  members: Option[];
  dates?: DateFilter[];
  clearHref?: string;
  showCircle?: boolean;
  showMember?: boolean;
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

  return (
    <form className="nr-filter-panel" action={action}>
      {status && !statusOptions && <input type="hidden" name="status" value={status} />}
      {view && view !== "list" && <input type="hidden" name="view" value={view} />}
      {sort && sort !== "priority" && <input type="hidden" name="sort" value={sort} />}
      {columns && columns.length > 0 && <input type="hidden" name="columns" value={columns.join(",")} />}
      {statusOptions && (
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
}
