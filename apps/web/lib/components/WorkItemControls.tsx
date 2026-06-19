import type { ReactNode } from "react";
import { ArrowDownAZ, ArrowDownWideNarrow, ArrowUpDown, Columns3, List, Table2 } from "lucide-react";
import type { WorkItemScope, WorkItemSort, WorkItemViewMode } from "@/lib/work-item-view";

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
  const sortOptions: Array<{ value: WorkItemSort; label: string; icon: ReactNode }> = [
    { value: "priority", label: sortPriorityLabel, icon: <ArrowDownWideNarrow size={15} aria-hidden="true" /> },
    { value: "date", label: sortDateLabel, icon: <ArrowUpDown size={15} aria-hidden="true" /> },
    { value: "alpha", label: sortAlphaLabel, icon: <ArrowDownAZ size={15} aria-hidden="true" /> },
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
                key={option.value}
                href={sortLinks[option.value]}
                className={`nr-icon-menu-item ${currentSort === option.value ? "nr-icon-menu-item-active" : ""}`}
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
  memberId,
  circles,
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
  memberId?: string;
  circles: Option[];
  members: Option[];
  dates?: DateFilter[];
  clearHref?: string;
  showCircle?: boolean;
  showMember?: boolean;
  labels: {
    scope?: string;
    company?: string;
    circle: string;
    person: string;
    allCircles: string;
    allPeople: string;
    apply: string;
    clear: string;
  };
}) {
  return (
    <form className="nr-filter-panel" action={action}>
      {status && <input type="hidden" name="status" value={status} />}
      {view && view !== "list" && <input type="hidden" name="view" value={view} />}
      {sort && sort !== "priority" && <input type="hidden" name="sort" value={sort} />}
      {columns && columns.length > 0 && <input type="hidden" name="columns" value={columns.join(",")} />}
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
        <label>
          <span className="nr-item-meta">{labels.circle}</span>
          <select name="circleId" defaultValue={circleId ?? ""}>
            <option value="">{labels.allCircles}</option>
            {circles.map((circle) => (
              <option key={circle.id} value={circle.id}>{circle.label}</option>
            ))}
          </select>
        </label>
      )}
      {showMember && (
        <label>
          <span className="nr-item-meta">{labels.person}</span>
          <select name="memberId" defaultValue={memberId ?? ""}>
            <option value="">{labels.allPeople}</option>
            {members.map((member) => (
              <option key={member.id} value={member.id}>{member.label}</option>
            ))}
          </select>
        </label>
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
