import type { WorkItemScope, WorkItemViewMode } from "@/lib/work-item-view";

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
  listLabel,
  kanbanLabel,
  label,
}: {
  currentView: WorkItemViewMode;
  listHref: string;
  kanbanHref: string;
  listLabel: string;
  kanbanLabel: string;
  label: string;
}) {
  return (
    <div className="nr-view-toggle" aria-label={label}>
      <a href={listHref} className={`nr-filter-item ${currentView === "list" ? "nr-filter-active" : ""}`}>
        {listLabel}
      </a>
      <a href={kanbanHref} className={`nr-filter-item ${currentView === "kanban" ? "nr-filter-active" : ""}`}>
        {kanbanLabel}
      </a>
    </div>
  );
}

export function WorkItemFilterControls({
  action,
  status,
  view,
  scope,
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
  scope: WorkItemScope;
  circleId?: string;
  memberId?: string;
  circles: Option[];
  members: Option[];
  dates?: DateFilter[];
  clearHref?: string;
  showCircle?: boolean;
  showMember?: boolean;
  labels: {
    scope: string;
    company: string;
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
      <label>
        <span className="nr-item-meta">{labels.scope}</span>
        <select name="scope" defaultValue={scope}>
          <option value="company">{labels.company}</option>
          {showCircle && <option value="circle">{labels.circle}</option>}
          {showMember && <option value="member">{labels.person}</option>}
        </select>
      </label>
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
