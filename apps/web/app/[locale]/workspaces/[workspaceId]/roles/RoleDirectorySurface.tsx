import type { ReactNode } from "react";
import { getTranslations } from "next-intl/server";
import { MarkdownExcerpt } from "@/lib/components/MarkdownRenderer";
import { ItemActions } from "@/lib/components/ui/ItemActions";
import { WorkItemFilterControls, WorkItemToolbar } from "@/lib/components/WorkItemControls";
import { WorkItemKanbanBoard, type WorkItemKanbanColumn } from "@/lib/components/WorkItemKanbanBoard";
import { WorkItemTable, type WorkItemTableColumn, type WorkItemTableRow } from "@/lib/components/WorkItemTable";
import { ConfirmSubmitButton } from "../circles/ConfirmSubmitButton";
import {
  buildWorkItemQuery,
  normalizeVisibleWorkItemColumns,
  normalizeWorkItemView,
  resolveWorkItemFilters,
  toggleWorkItemColumnVisibility,
} from "@/lib/work-item-view";
import {
  activeHumanRoleAssignments,
  normalizeRoleStaffingFilter,
  ROLE_KANBAN_COLUMN_IDS,
  ROLE_STAFFING_FILTERS,
  roleDirectorySort,
  roleKanbanColumnId,
  roleMatchesCircleFilter,
  roleMatchesMemberFilter,
  roleMatchesStaffingFilter,
  roleMemberName,
  roleOnboardingKey,
  sortRoleDirectoryRoles,
  type RoleDirectoryCircle,
  type RoleDirectoryData,
  type RoleDirectoryMember,
  type RoleDirectoryRole,
  type RoleKanbanColumnId,
  type RoleStaffingFilter,
} from "./role-directory";
import {
  assignRoleAction,
  deleteRoleAction,
  reassignRoleAction,
  unassignRoleAction,
  updateRoleAction,
} from "../circles/actions";

type SearchParams = Record<string, string | string[] | undefined>;

type RoleDirectorySurfaceProps = RoleDirectoryData & {
  workspaceId: string;
  baseHref: string;
  searchParams?: SearchParams;
  currentMemberId?: string | null;
  currentUserId?: string | null;
  canManageStructure: boolean;
  isDemo?: boolean;
  lockedCircleId?: string;
  lockedMemberId?: string;
  showToolbar?: boolean;
  showFilters?: boolean;
};

function hiddenWorkspace(workspaceId: string) {
  return <input type="hidden" name="workspaceId" value={workspaceId} />;
}

function formatDate(value: Date) {
  return value.toISOString().slice(0, 10);
}

function assignmentExpiryState(value?: Date | string | number | null, now: Date = new Date()) {
  if (!value) return null;
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) return null;
  return {
    date: formatDate(date),
    expired: date.getTime() <= now.getTime(),
  };
}

function activeAssignmentDateValue(value?: Date | string | number | null, now: Date = new Date()) {
  const state = assignmentExpiryState(value, now);
  return state && !state.expired ? state.date : "";
}

function memberOptionLabel(member: RoleDirectoryMember) {
  return member.email ? `${member.name} (${member.email})` : member.name;
}

function circleHref(workspaceId: string, circleId: string) {
  return `/workspaces/${workspaceId}/circles/${circleId}`;
}

function roleHref(workspaceId: string, roleId: string) {
  return `/workspaces/${workspaceId}/roles/${roleId}`;
}

function memberHref(workspaceId: string, memberId: string) {
  return `/workspaces/${workspaceId}/members/${memberId}`;
}

function selectedOptionIds(options: readonly { id: string }[], selectedIds: readonly string[]) {
  const validIds = new Set(options.map((option) => option.id));
  return selectedIds.filter((id) => validIds.has(id));
}

function roleTableText(value: string | null | undefined, fallback: string) {
  return value?.trim() || fallback;
}

export async function RoleDirectorySurface({
  workspaceId,
  baseHref,
  searchParams = {},
  roles,
  circles,
  members,
  onboardingByRoleMember,
  currentMemberId,
  currentUserId,
  canManageStructure,
  isDemo = false,
  lockedCircleId,
  lockedMemberId,
  showToolbar = true,
  showFilters = true,
}: RoleDirectorySurfaceProps) {
  const t = await getTranslations("roles");
  const tCommon = await getTranslations("common");
  const tWork = await getTranslations("workItems");
  const view = showToolbar ? normalizeWorkItemView(searchParams.view) : "list";
  const staffingFilter = normalizeRoleStaffingFilter(searchParams.status);
  const { circleIds: searchCircleIds, memberIds: searchMemberIds, sort } = resolveWorkItemFilters(searchParams);
  const unlockedCircleIds = lockedCircleId ? [] : selectedOptionIds(circles, searchCircleIds);
  const unlockedMemberIds = lockedMemberId ? [] : selectedOptionIds(members, searchMemberIds);
  const activeCircleIds = lockedCircleId ? [lockedCircleId] : unlockedCircleIds;
  const activeMemberIds = lockedMemberId ? [lockedMemberId] : unlockedMemberIds;
  const visibleColumnIds = normalizeVisibleWorkItemColumns(searchParams.columns, ROLE_KANBAN_COLUMN_IDS);
  const allColumnsVisible = visibleColumnIds.length === ROLE_KANBAN_COLUMN_IDS.length;
  const statusQuery = staffingFilter === "ALL" ? undefined : staffingFilter;
  const now = new Date();

  const scopedRoles = roles.filter((role) => (
    roleMatchesCircleFilter(role, activeCircleIds)
      && roleMatchesMemberFilter(role, activeMemberIds, now)
  ));
  const displayRoles = sortRoleDirectoryRoles(
    scopedRoles.filter((role) => roleMatchesStaffingFilter({
      role,
      filter: staffingFilter,
      currentMemberId,
      onboardingByRoleMember,
      now,
    })),
    sort,
    onboardingByRoleMember,
    now,
  );

  function filterCount(filter: RoleStaffingFilter) {
    return scopedRoles.filter((role) => roleMatchesStaffingFilter({
      role,
      filter,
      currentMemberId,
      onboardingByRoleMember,
      now,
    })).length;
  }

  const filterCounts = Object.fromEntries(
    ROLE_STAFFING_FILTERS.map((filter) => [filter, filterCount(filter)]),
  ) as Record<RoleStaffingFilter, number>;

  function staffingFilterLabel(filter: RoleStaffingFilter) {
    if (filter === "ALL") return tWork("statusAll");
    if (filter === "OPEN") return t("staffingOpen");
    if (filter === "STAFFED") return t("staffingStaffed");
    if (filter === "MULTI_HOLDER") return t("staffingMultiHolder");
    if (filter === "NEEDS_ONBOARDING") return t("staffingNeedsOnboarding");
    return t("staffingMine");
  }

  function columnLabel(columnId: RoleKanbanColumnId) {
    if (columnId === "OPEN") return t("staffingOpen");
    if (columnId === "STAFFED") return t("staffingStaffed");
    if (columnId === "MULTI_HOLDER") return t("staffingMultiHolder");
    return t("staffingNeedsOnboarding");
  }

  function emptyColumnLabel(columnId: RoleKanbanColumnId) {
    if (columnId === "OPEN") return t("emptyOpenRoles");
    if (columnId === "STAFFED") return t("emptyStaffedRoles");
    if (columnId === "MULTI_HOLDER") return t("emptyMultiHolderRoles");
    return t("emptyOnboardingRoles");
  }

  function statusTagClass(role: RoleDirectoryRole) {
    const columnId = roleKanbanColumnId(role, onboardingByRoleMember, now);
    if (columnId === "OPEN") return "warning";
    if (columnId === "NEEDS_ONBOARDING") return "info";
    if (columnId === "MULTI_HOLDER") return "neutral";
    return "success";
  }

  function roleStatusLabel(role: RoleDirectoryRole) {
    return columnLabel(roleKanbanColumnId(role, onboardingByRoleMember, now));
  }

  function roleQuery(overrides: {
    view?: "list" | "kanban" | "table";
    sort?: typeof sort;
    status?: RoleStaffingFilter;
    columns?: readonly RoleKanbanColumnId[];
  }) {
    const nextView = overrides.view ?? view;
    const nextStatus = overrides.status ?? staffingFilter;
    return buildWorkItemQuery({
      view: nextView,
      sort: nextView === "kanban" ? undefined : overrides.sort ?? sort,
      status: nextStatus === "ALL" ? undefined : nextStatus,
      circleIds: unlockedCircleIds,
      memberIds: unlockedMemberIds,
      columns: overrides.columns,
    });
  }

  function staffingFilterHref(filter: RoleStaffingFilter) {
    return roleQuery({
      status: filter,
      columns: view === "kanban" && !allColumnsVisible ? visibleColumnIds : undefined,
    });
  }

  const columnHideHrefs = Object.fromEntries(
    ROLE_KANBAN_COLUMN_IDS.map((columnId) => [columnId, roleQuery({
      view: "kanban",
      status: staffingFilter,
      columns: toggleWorkItemColumnVisibility(visibleColumnIds, columnId, ROLE_KANBAN_COLUMN_IDS),
    })]),
  );

  function onboardingTags(role: RoleDirectoryRole) {
    return activeHumanRoleAssignments(role, now).flatMap((assignment) => {
      const onboarding = onboardingByRoleMember.get(roleOnboardingKey(role.id, assignment.memberId));
      if (!onboarding) return [];
      const label = t("onboardingStatus", { status: String(onboarding.status).toLowerCase() });
      const canOpen = Boolean(onboarding.conversationId && assignment.member.user?.id === currentUserId);
      return canOpen ? [
        <a
          key={`${assignment.id}-onboarding`}
          href={`/workspaces/${workspaceId}/chat?session=${onboarding.conversationId}`}
          className="tag info"
          draggable={false}
        >
          {label}
        </a>,
      ] : [
        <span key={`${assignment.id}-onboarding`} className="tag info">
          {label}
        </span>,
      ];
    });
  }

  function holderLinks(role: RoleDirectoryRole, compact = false) {
    const activeAssignments = activeHumanRoleAssignments(role, now);
    if (activeAssignments.length === 0) {
      return <span className={compact ? "nr-card-chip nr-card-chip-muted" : "muted"}>{t("unassigned")}</span>;
    }
    return activeAssignments.map((assignment) => (
      <a
        key={assignment.id}
        href={memberHref(workspaceId, assignment.memberId)}
        className={compact ? "nr-card-chip" : "tag-sm no-underline"}
        draggable={false}
      >
        {roleMemberName(assignment.member, t("unknownHolder"))}
      </a>
    ));
  }

  function renderAssignmentDateTags(role: RoleDirectoryRole) {
    return activeHumanRoleAssignments(role, now).flatMap((assignment) => {
      const expiryState = assignmentExpiryState(assignment.expiresAt, now);
      if (!expiryState) return [];
      return [
        <span key={`${assignment.id}-expiry`} className={expiryState.expired ? "tag warning" : "tag info"}>
          {expiryState.expired
            ? t("temporaryExpired", { date: expiryState.date })
            : t("temporaryActive", { date: expiryState.date })}
        </span>,
      ];
    });
  }

  function roleActionMenu(role: RoleDirectoryRole) {
    if (isDemo || !canManageStructure) return null;

    const activeAssignments = activeHumanRoleAssignments(role, now);
    const assignedMemberIds = new Set(activeAssignments.map((assignment) => assignment.memberId));
    const addableMembers = members.filter((member) => !assignedMemberIds.has(member.id));
    const movableCircles = circles.filter((circle) => circle.id !== role.circle.id);
    const moreItems: ReactNode[] = [];

    moreItems.push(
      <details key="assign">
        <summary className="nr-hide-marker nr-action-summary">{t("actionAssign")}</summary>
        <form action={assignRoleAction} className="action-menu-form">
          {hiddenWorkspace(workspaceId)}
          <input type="hidden" name="roleId" value={role.id} />
          <label>
            {t("formMember")}
            <select name="memberId" required defaultValue="" disabled={addableMembers.length === 0}>
              <option value="">{t("selectMember")}</option>
              {addableMembers.map((member) => (
                <option key={member.id} value={member.id}>{memberOptionLabel(member)}</option>
              ))}
            </select>
          </label>
          <label>
            {t("formExpiresAt")}
            <input name="expiresAt" type="date" min={formatDate(now)} />
          </label>
          <label>
            {t("formTransferReason")}
            <input name="transferReason" placeholder={t("formTransferReasonPlaceholder")} />
          </label>
          {addableMembers.length === 0 && <span className="action-menu-label">{t("noAvailableMembers")}</span>}
          <button type="submit" className="secondary small" disabled={addableMembers.length === 0}>
            {t("actionAssign")}
          </button>
        </form>
      </details>,
    );

    moreItems.push(
      <details key="reassign">
        <summary className="nr-hide-marker nr-action-summary">{t("actionReassign")}</summary>
        <div className="action-menu-form">
          {activeAssignments.length === 0 && <span className="action-menu-label">{t("noActiveHolders")}</span>}
          {activeAssignments.map((assignment) => {
            const replacementMembers = members.filter((member) => member.id !== assignment.memberId && !assignedMemberIds.has(member.id));
            return (
              <form key={assignment.id} action={reassignRoleAction} className="action-menu-form">
                {hiddenWorkspace(workspaceId)}
                <input type="hidden" name="roleId" value={role.id} />
                <input type="hidden" name="fromMemberId" value={assignment.memberId} />
                <span className="action-menu-label">
                  {t("fromHolder", { name: roleMemberName(assignment.member, t("unknownHolder")) })}
                </span>
                <label>
                  {t("reassignTo")}
                  <select name="toMemberId" required defaultValue="" disabled={replacementMembers.length === 0}>
                    <option value="">{t("selectMember")}</option>
                    {replacementMembers.map((member) => (
                      <option key={member.id} value={member.id}>{memberOptionLabel(member)}</option>
                    ))}
                  </select>
                </label>
                <label>
                  {t("formExpiresAt")}
                  <input name="expiresAt" type="date" min={formatDate(now)} />
                </label>
                <label>
                  {t("formTransferReason")}
                  <input name="transferReason" placeholder={t("formTransferReasonPlaceholder")} />
                </label>
                <button type="submit" className="secondary small" disabled={replacementMembers.length === 0}>
                  {t("actionReassign")}
                </button>
              </form>
            );
          })}
        </div>
      </details>,
    );

    moreItems.push(
      <details key="remove-holder">
        <summary className="nr-hide-marker nr-action-summary">{t("actionRemoveHolder")}</summary>
        <div className="action-menu-form">
          {activeAssignments.length === 0 && <span className="action-menu-label">{t("noActiveHolders")}</span>}
          {activeAssignments.map((assignment) => (
            <form key={assignment.id} action={unassignRoleAction}>
              {hiddenWorkspace(workspaceId)}
              <input type="hidden" name="roleId" value={role.id} />
              <input type="hidden" name="memberId" value={assignment.memberId} />
              <button type="submit" className="danger">
                {t("removeHolder", { name: roleMemberName(assignment.member, t("unknownHolder")) })}
              </button>
            </form>
          ))}
        </div>
      </details>,
    );

    moreItems.push(
      <details key="edit-holder">
        <summary className="nr-hide-marker nr-action-summary">{t("actionEditHolder")}</summary>
        <div className="action-menu-form">
          {activeAssignments.length === 0 && <span className="action-menu-label">{t("noActiveHolders")}</span>}
          {activeAssignments.map((assignment) => (
            <form key={assignment.id} action={assignRoleAction} className="action-menu-form">
              {hiddenWorkspace(workspaceId)}
              <input type="hidden" name="roleId" value={role.id} />
              <input type="hidden" name="memberId" value={assignment.memberId} />
              <span className="action-menu-label">
                {roleMemberName(assignment.member, t("unknownHolder"))}
              </span>
              <label>
                {t("formExpiresAt")}
                <input name="expiresAt" type="date" min={formatDate(now)} defaultValue={activeAssignmentDateValue(assignment.expiresAt, now)} />
              </label>
              <label>
                {t("formTransferReason")}
                <input name="transferReason" placeholder={t("formTransferReasonPlaceholder")} defaultValue={assignment.transferReason ?? ""} />
              </label>
              <button type="submit" className="secondary small">{tCommon("save")}</button>
            </form>
          ))}
        </div>
      </details>,
    );

    moreItems.push(
      <details key="move-circle">
        <summary className="nr-hide-marker nr-action-summary">{t("actionMoveCircle")}</summary>
        <form action={updateRoleAction} className="action-menu-form">
          {hiddenWorkspace(workspaceId)}
          <input type="hidden" name="roleId" value={role.id} />
          <label>
            {t("formCircle")}
            <select name="circleId" required defaultValue={role.circle.id} disabled={movableCircles.length === 0}>
              <option value={role.circle.id}>{role.circle.name}</option>
              {movableCircles.map((circle) => (
                <option key={circle.id} value={circle.id}>{circle.name}</option>
              ))}
            </select>
          </label>
          <button type="submit" className="secondary small" disabled={movableCircles.length === 0}>
            {t("actionMoveCircle")}
          </button>
        </form>
      </details>,
    );

    moreItems.push(
      <details key="edit">
        <summary className="nr-hide-marker nr-action-summary">{t("actionEdit")}</summary>
        <form action={updateRoleAction} className="action-menu-form">
          {hiddenWorkspace(workspaceId)}
          <input type="hidden" name="roleId" value={role.id} />
          <label>
            {t("formName")}
            <input name="name" defaultValue={role.name} required />
          </label>
          <label>
            {t("formPurpose")}
            <textarea name="purposeMd" defaultValue={role.purposeMd ?? ""} />
          </label>
          <label>
            {t("formAccountabilities")}
            <textarea name="accountabilities" defaultValue={role.accountabilities.join("\n")} placeholder={t("formAccountabilitiesPlaceholder")} />
          </label>
          <label>
            {t("formArtifacts")}
            <textarea name="artifacts" defaultValue={role.artifacts.join("\n")} placeholder={t("formArtifactsPlaceholder")} />
          </label>
          <label>
            {t("formCoreRoleType")}
            <input name="coreRoleType" defaultValue={role.coreRoleType ?? ""} />
          </label>
          <button type="submit" className="secondary small">{tCommon("save")}</button>
        </form>
      </details>,
    );

    moreItems.push(
      <details key="archive">
        <summary className="nr-hide-marker nr-action-summary">{t("actionArchive")}</summary>
        <form action={deleteRoleAction} className="action-menu-form">
          {hiddenWorkspace(workspaceId)}
          <input type="hidden" name="roleId" value={role.id} />
          <ConfirmSubmitButton className="danger" message={t("confirmArchiveRole")}>
            {t("actionArchive")}
          </ConfirmSubmitButton>
        </form>
      </details>,
    );

    return (
      <ItemActions
        moreLabel={tCommon("moreActions")}
        more={moreItems}
      />
    );
  }

  function renderRoleCard(role: RoleDirectoryRole, compact = false) {
    const detailHref = roleHref(workspaceId, role.id);
    const activeAssignments = activeHumanRoleAssignments(role, now);
    const actionMenu = roleActionMenu(role);
    const holderCount = activeAssignments.length;

    return (
      <div className={`${compact ? "nr-kanban-card" : "nr-item nr-list-card"} nr-clickable-card`} key={role.id}>
        <a href={detailHref} className="nr-card-hitbox" aria-label={tWork("openItem", { title: role.name })} draggable={false} />
        <div className="row nr-card-content" style={{ alignItems: "center", gap: 8 }}>
          <strong className="nr-item-title">{role.name}</strong>
          <span className={`tag ${statusTagClass(role)}`}>{roleStatusLabel(role)}</span>
        </div>
        <div className="nr-card-content">
          {role.purposeMd ? (
            <MarkdownExcerpt markdown={role.purposeMd} maxLength={compact ? 120 : 220} as="div" className="nr-excerpt" />
          ) : (
            <div className="nr-excerpt">{t("noPurpose")}</div>
          )}
          {compact ? (
            <div className="nr-card-chip-row">
              <a href={circleHref(workspaceId, role.circle.id)} className="nr-card-chip" draggable={false}>{role.circle.name}</a>
              <span className="nr-card-chip">{t("holderCount", { count: holderCount })}</span>
              <span className="nr-card-chip">{t("accountabilityCount", { count: role.accountabilities.length })}</span>
              {holderLinks(role, true)}
            </div>
          ) : (
            <>
              <div className="nr-item-meta" style={{ marginTop: 8 }}>
                <a href={circleHref(workspaceId, role.circle.id)} draggable={false}>{role.circle.name}</a>
                {" · "}
                {t("holderCount", { count: holderCount })}
                {" · "}
                {t("accountabilityCount", { count: role.accountabilities.length })}
                {role.coreRoleType ? ` · ${t("coreRoleMeta", { type: role.coreRoleType })}` : ""}
                {" · "}
                {new Date(role.updatedAt).toLocaleDateString()}
              </div>
              <div className="nr-tag-group" style={{ marginTop: 10 }}>
                {holderLinks(role)}
                {onboardingTags(role)}
                {renderAssignmentDateTags(role)}
              </div>
              {role.accountabilities.length > 0 && (
                <div className="nr-tag-group" style={{ marginTop: 10 }}>
                  {role.accountabilities.slice(0, 4).map((accountability, index) => (
                    <span key={`${role.id}-accountability-${index}`} className="tag-sm">{accountability}</span>
                  ))}
                  {role.accountabilities.length > 4 && (
                    <span className="tag-sm">{t("moreAccountabilities", { count: role.accountabilities.length - 4 })}</span>
                  )}
                </div>
              )}
            </>
          )}
        </div>
        {actionMenu}
      </div>
    );
  }

  const tableColumns: WorkItemTableColumn[] = [
    { id: "item", label: tWork("tableItem"), cellClassName: "nr-work-item-table-main" },
    { id: "staffing", label: tWork("tableStatus") },
    { id: "holders", label: t("tableHolders") },
    { id: "circle", label: tWork("circle") },
    { id: "definition", label: t("tableDefinition") },
    { id: "actions", label: tWork("tableActions"), cellClassName: "nr-work-item-table-actions" },
  ];

  function tableRow(role: RoleDirectoryRole): WorkItemTableRow {
    const detailHref = roleHref(workspaceId, role.id);
    const activeAssignments = activeHumanRoleAssignments(role, now);
    const actionMenu = roleActionMenu(role);

    return {
      id: role.id,
      cells: {
        item: (
          <>
            <a href={detailHref} className="nr-work-item-table-title">{role.name}</a>
            {role.purposeMd ? (
              <MarkdownExcerpt markdown={role.purposeMd} maxLength={140} as="div" className="nr-work-item-table-meta" />
            ) : (
              <div className="nr-work-item-table-meta">{t("noPurpose")}</div>
            )}
          </>
        ),
        staffing: (
          <div className="nr-work-item-table-tags">
            <span className={`tag ${statusTagClass(role)}`}>{roleStatusLabel(role)}</span>
            {onboardingTags(role)}
            {renderAssignmentDateTags(role)}
          </div>
        ),
        holders: (
          <div className="nr-work-item-table-tags">
            {activeAssignments.length > 0 ? holderLinks(role) : roleTableText(null, t("unassigned"))}
          </div>
        ),
        circle: (
          <a href={circleHref(workspaceId, role.circle.id)} className="nr-work-item-table-title">
            {role.circle.name}
          </a>
        ),
        definition: (
          <div className="nr-work-item-table-meta">
            <div>{t("accountabilityCount", { count: role.accountabilities.length })}</div>
            <div>{t("artifactCount", { count: role.artifacts.length })}</div>
            {role.coreRoleType && <div>{t("coreRoleMeta", { type: role.coreRoleType })}</div>}
          </div>
        ),
        actions: actionMenu,
      },
    };
  }

  const rolesByColumn = new Map<RoleKanbanColumnId, RoleDirectoryRole[]>(
    ROLE_KANBAN_COLUMN_IDS.map((columnId) => [columnId, []]),
  );
  for (const role of displayRoles) {
    rolesByColumn.get(roleKanbanColumnId(role, onboardingByRoleMember, now))?.push(role);
  }

  const columns: WorkItemKanbanColumn[] = ROLE_KANBAN_COLUMN_IDS.map((columnId) => {
    const columnRoles = rolesByColumn.get(columnId) ?? [];
    return {
      id: columnId,
      label: columnLabel(columnId),
      count: columnRoles.length,
      empty: <p className="muted">{emptyColumnLabel(columnId)}</p>,
      items: columnRoles.map((role) => ({
        id: role.id,
        status: columnId,
        sort: roleDirectorySort(role, onboardingByRoleMember, now),
        node: renderRoleCard(role, true),
      })),
    };
  });

  function renderEmptyState() {
    return (
      <div className="nr-item nr-empty-state">
        <h3 className="nr-empty-title">{t("emptyTitle")}</h3>
        <p className="muted nr-empty-desc">{t("emptyDescription")}</p>
      </div>
    );
  }

  return (
    <div>
      {showToolbar && (
        <div className="nr-work-board-header">
          <div className="nr-filter-bar nr-filter-bar-wrap">
            {ROLE_STAFFING_FILTERS.map((filter) => (
              <a
                key={filter}
                href={staffingFilterHref(filter)}
                className={`nr-filter-item ${staffingFilter === filter ? "nr-filter-active" : ""}`}
              >
                {staffingFilterLabel(filter)} ({filterCounts[filter]})
              </a>
            ))}
          </div>
          <WorkItemToolbar
            currentView={view}
            currentSort={sort}
            listHref={roleQuery({ view: "list" })}
            kanbanHref={roleQuery({ view: "kanban" })}
            tableHref={roleQuery({ view: "table" })}
            sortLinks={{
              priority: roleQuery({ view: view === "table" ? "table" : "list", sort: "priority" }),
              date: roleQuery({ view: view === "table" ? "table" : "list", sort: "date" }),
              alpha: roleQuery({ view: view === "table" ? "table" : "list", sort: "alpha" }),
            }}
            listLabel={tWork("listView")}
            kanbanLabel={tWork("kanbanView")}
            tableLabel={tWork("tableView")}
            sortLabel={tWork("sort")}
            sortPriorityLabel={tWork("sortPriority")}
            sortDateLabel={tWork("sortDate")}
            sortAlphaLabel={tWork("sortAlpha")}
            label={tWork("viewMode")}
          />
        </div>
      )}

      {showFilters && (
        <WorkItemFilterControls
          action={baseHref}
          status={statusQuery}
          view={view}
          sort={view !== "kanban" ? sort : undefined}
          columns={view === "kanban" && !allColumnsVisible ? visibleColumnIds : undefined}
          circleIds={unlockedCircleIds}
          memberIds={unlockedMemberIds}
          circles={circles.map((circle) => ({ id: circle.id, label: circle.name }))}
          members={members.map((member) => ({ id: member.id, label: member.name }))}
          showCircle={!lockedCircleId}
          showMember={!lockedMemberId}
          clearHref={baseHref}
          labels={{
            circle: tWork("circle"),
            person: tWork("person"),
            allCircles: tWork("allCircles"),
            allPeople: tWork("allPeople"),
            selectAll: tWork("selectAll"),
            unselectAll: tWork("unselectAll"),
            selectedCount: tWork("selectedCount", { count: "{count}" }),
            apply: tWork("applyFilters"),
            clear: tWork("clearFilters"),
          }}
        />
      )}

      {view === "kanban" ? (
        <WorkItemKanbanBoard
          columns={columns}
          storageKey={`work-items:${workspaceId}:roles`}
          visibleColumnIds={visibleColumnIds}
          hideColumnHrefs={columnHideHrefs}
          settingsLabel={tWork("columnSettings")}
          resetLabel={tWork("resetColumns")}
          hideLabel={tWork("hideColumn")}
          moveUpLabel={tWork("moveColumnLeft")}
          moveDownLabel={tWork("moveColumnRight")}
          hideShortLabel={tWork("hideColumnShort")}
          moveUpShortLabel={tWork("moveColumnLeftShort")}
          moveDownShortLabel={tWork("moveColumnRightShort")}
          sortLabel={tWork("sort")}
          sortPriorityLabel={tWork("sortPriority")}
          sortDateLabel={tWork("sortDate")}
          sortAlphaLabel={tWork("sortAlpha")}
          dragUnavailableLabel={tWork("dragUnavailable")}
        />
      ) : view === "table" ? (
        <WorkItemTable
          columns={tableColumns}
          rows={displayRoles.map((role) => tableRow(role))}
          empty={renderEmptyState()}
        />
      ) : (
        <div>
          {displayRoles.length === 0 && renderEmptyState()}
          {displayRoles.map((role) => renderRoleCard(role))}
        </div>
      )}
    </div>
  );
}
