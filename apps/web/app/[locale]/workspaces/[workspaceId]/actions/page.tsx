import { listActions, listAdviceRequests, listCircles, listHumanMembers, requireWorkspaceMembership } from "@corgtex/domain";
import { prisma } from "@corgtex/shared";
import type { ReactNode } from "react";
import { requirePageActor } from "@/lib/auth";
import {
  createActionAction,
  updateActionAction,
  deleteActionAction,
  publishActionAction,
  returnActionToDraftAction,
} from "../actions";
import { getTranslations } from "next-intl/server";
import { ActionEditorForm } from "@/lib/components/ActionEditorForm";
import { ConfirmSubmitButton } from "@/lib/components/ConfirmSubmitButton";
import {
  ACTION_STATUS_FILTERS,
  ACTION_STATUS_META,
  type ActionStatusFilter,
  type ActionStatusQuery,
  actionMatchesStatusFilters,
  groupActionsByStatus,
  resolveActionStatusSearch,
} from "./view-model";
import { MarkdownExcerpt } from "@/lib/components/MarkdownRenderer";
import { WorkspacePageHeader } from "@/lib/components/ControlPrimitives";
import { ItemActions } from "@/lib/components/ui/ItemActions";
import {
  WorkItemAttentionBadge,
  WorkItemCard,
  WorkItemFilterControls,
  WorkItemLifecycleBadge,
  WorkItemRelationshipTag,
  WorkItemToolbar,
} from "@/lib/components/WorkItemControls";
import { WorkItemKanbanBoard, type WorkItemKanbanColumn } from "@/lib/components/WorkItemKanbanBoard";
import { WorkItemResolutionDialog } from "@/lib/components/WorkItemResolutionDialog";
import { WorkItemTable, type WorkItemTableColumn, type WorkItemTableRow } from "@/lib/components/WorkItemTable";
import {
  buildWorkItemQuery,
  normalizeVisibleWorkItemColumns,
  normalizeWorkItemView,
  resolveWorkItemFilters,
  toggleWorkItemColumnVisibility,
} from "@/lib/work-item-view";
import { formatWorkItemPriority, normalizeWorkItemPriority, type WorkItemPriorityLabels } from "@/lib/work-item-priority";

export const dynamic = "force-dynamic";

type ActionBoardGroup = "status" | "due" | "priority";
type ActionDueColumnId = "DUE_OVERDUE" | "DUE_TODAY" | "DUE_TOMORROW" | "DUE_REST_WEEK" | "DUE_NEXT_WEEK" | "DUE_FUTURE" | "DUE_NONE";
type ActionPriorityColumnId = "PRIORITY_3" | "PRIORITY_2" | "PRIORITY_1" | "PRIORITY_0";

const ACTION_BOARD_GROUPS: ActionBoardGroup[] = ["status", "due", "priority"];
const ACTION_PRIORITY_COLUMNS: Array<{ id: ActionPriorityColumnId; priority: 0 | 1 | 2 | 3 }> = [
  { id: "PRIORITY_3", priority: 3 },
  { id: "PRIORITY_2", priority: 2 },
  { id: "PRIORITY_1", priority: 1 },
  { id: "PRIORITY_0", priority: 0 },
];
const ACTION_DUE_COLUMNS: ActionDueColumnId[] = ["DUE_OVERDUE", "DUE_TODAY", "DUE_TOMORROW", "DUE_REST_WEEK", "DUE_NEXT_WEEK", "DUE_FUTURE", "DUE_NONE"];
const UTC_DAY_MS = 24 * 60 * 60 * 1000;

function firstSearchValue(value: string | string[] | undefined) {
  return Array.isArray(value) ? value[0] : value;
}

function normalizeActionBoardGroup(value: string | string[] | undefined): ActionBoardGroup {
  const candidate = firstSearchValue(value);
  return ACTION_BOARD_GROUPS.includes(candidate as ActionBoardGroup) ? candidate as ActionBoardGroup : "status";
}

function dateInputValue(value?: Date | string | null) {
  if (!value) return "";
  const date = value instanceof Date ? value : new Date(value);
  return Number.isFinite(date.getTime()) ? date.toISOString().slice(0, 10) : "";
}

function startOfUtcDay(value: Date) {
  return Date.UTC(value.getUTCFullYear(), value.getUTCMonth(), value.getUTCDate());
}

function utcDateInputFromMs(value: number) {
  return new Date(value).toISOString().slice(0, 10);
}

function nextUtcMondayStart(todayMs: number) {
  const today = new Date(todayMs);
  const day = today.getUTCDay();
  const daysUntilMonday = day === 0 ? 1 : 8 - day;
  return todayMs + daysUntilMonday * UTC_DAY_MS;
}

function actionDueColumnId(dueAt: Date | string | null | undefined, now = new Date()): ActionDueColumnId {
  if (!dueAt) return "DUE_NONE";
  const due = dueAt instanceof Date ? dueAt : new Date(dueAt);
  if (!Number.isFinite(due.getTime())) return "DUE_NONE";
  const todayMs = startOfUtcDay(now);
  const dueMs = startOfUtcDay(due);
  if (dueMs < todayMs) return "DUE_OVERDUE";
  if (dueMs === todayMs) return "DUE_TODAY";
  if (dueMs === todayMs + UTC_DAY_MS) return "DUE_TOMORROW";
  const nextWeekStart = nextUtcMondayStart(todayMs);
  if (dueMs < nextWeekStart) return "DUE_REST_WEEK";
  if (dueMs < nextWeekStart + 7 * UTC_DAY_MS) return "DUE_NEXT_WEEK";
  return "DUE_FUTURE";
}

function dueColumnTargetDate(columnId: ActionDueColumnId, now = new Date()) {
  const todayMs = startOfUtcDay(now);
  if (columnId === "DUE_TODAY") return utcDateInputFromMs(todayMs);
  if (columnId === "DUE_TOMORROW") return utcDateInputFromMs(todayMs + UTC_DAY_MS);
  if (columnId === "DUE_NONE") return "";
  return null;
}

export default async function ActionsPage({
  params,
  searchParams,
}: {
  params: Promise<{ workspaceId: string }>;
  searchParams?: Promise<Record<string, string | string[] | undefined>>;
}) {
  const { workspaceId } = await params;
  const actor = await requirePageActor();
  const t = await getTranslations("actions");
  const tCommon = await getTranslations("common");
  const tWork = await getTranslations("workItems");
  const membership = await requireWorkspaceMembership({ actor, workspaceId });
  const resolvedSearch = searchParams ? await searchParams : {};
  const view = normalizeWorkItemView(resolvedSearch.view);
  const boardGroup = normalizeActionBoardGroup(resolvedSearch.group);
  const boardGroupQuery = view === "kanban" && boardGroup !== "status" ? boardGroup : undefined;
  const { statusFilter, statusFilters, statusQuery } = resolveActionStatusSearch(
    resolvedSearch.status,
    view === "kanban" ? null : "OPEN",
  );
  const { circleIds, assigneeMemberIds, memberIds, sort } = resolveWorkItemFilters(resolvedSearch);
  const [{ items: actions }, circles, members, activeInputRequests] = await Promise.all([
    listActions(actor, workspaceId, {
      take: 200,
      circleIds,
      assigneeMemberIds,
      memberIds,
      sort,
    }),
    listCircles(workspaceId),
    listHumanMembers(workspaceId),
    listAdviceRequests(actor, { workspaceId, subjectType: "ACTION", status: "ACTIVE", take: 500 }),
  ]);

  const actionIds = actions.map((action) => action.id);
  const evidenceRows = actionIds.length > 0
    ? await prisma.workItemEvidence.findMany({
      where: {
        workspaceId,
        entityType: "Action",
        entityId: { in: actionIds },
        purpose: "completion_evidence",
      },
      include: {
        document: {
          select: {
            id: true,
            title: true,
            source: true,
            createdAt: true,
          },
        },
      },
      orderBy: { createdAt: "desc" },
    })
    : [];
  const evidenceByActionId = new Map<string, typeof evidenceRows>();
  for (const row of evidenceRows) {
    evidenceByActionId.set(row.entityId, [...(evidenceByActionId.get(row.entityId) ?? []), row]);
  }
  const activeRequestCountByActionId = new Map<string, number>();
  for (const request of activeInputRequests) {
    const subjectId = request.process.subjectId;
    activeRequestCountByActionId.set(subjectId, (activeRequestCountByActionId.get(subjectId) ?? 0) + 1);
  }

  const groupedActions = groupActionsByStatus(actions);
  const displayActions = actions.filter((action) => actionMatchesStatusFilters(action, statusFilters));
  type ActionListItem = (typeof actions)[number];
  type ActionColumnStatus = "DRAFT" | "OPEN" | "IN_PROGRESS" | "COMPLETED";
  const actionColumnStatuses: ActionColumnStatus[] = ["DRAFT", "OPEN", "IN_PROGRESS", "COMPLETED"];
  const visibleActionColumnIds = normalizeVisibleWorkItemColumns(resolvedSearch.columns, actionColumnStatuses);
  const allActionColumnsVisible = visibleActionColumnIds.length === actionColumnStatuses.length;
  const buildActionColumnHref = (status: ActionColumnStatus, queryStatus: ActionStatusQuery = statusQuery) => buildWorkItemQuery({
    view: "kanban",
    status: queryStatus,
    circleIds,
    assigneeMemberIds,
    memberIds,
    group: boardGroupQuery,
    columns: toggleWorkItemColumnVisibility(visibleActionColumnIds, status, actionColumnStatuses),
  });
  const actionColumnHideHrefs = Object.fromEntries(
    actionColumnStatuses.map((status) => [status, buildActionColumnHref(status)]),
  );
  const actionFilterHref = (filter: ActionStatusFilter) => view === "kanban" && boardGroup === "status"
    ? buildWorkItemQuery({
      view: "kanban",
      status: filter === "ALL" ? "ALL" : statusQuery,
      circleIds,
      assigneeMemberIds,
      memberIds,
      group: boardGroupQuery,
      columns: filter === "ALL" ? undefined : toggleWorkItemColumnVisibility(visibleActionColumnIds, filter, actionColumnStatuses),
    })
    : buildWorkItemQuery({
      view,
      sort: view !== "kanban" ? sort : undefined,
      circleIds,
      assigneeMemberIds,
      memberIds,
      status: filter,
      group: boardGroupQuery,
    });
  const actionFilterActive = (filter: ActionStatusFilter) => view === "kanban" && boardGroup === "status"
    ? filter === "ALL"
      ? allActionColumnsVisible
      : visibleActionColumnIds.includes(filter)
    : filter === "ALL"
      ? statusFilters.length === 0
      : statusFilters.includes(filter);
  const currentMemberId = membership?.id && membership.id !== "global-operator" ? membership.id : null;
  const assignedToMeActive = !!currentMemberId && assigneeMemberIds.includes(currentMemberId);
  const assignedToMeHref = buildWorkItemQuery({
    view,
    status: statusQuery,
    sort: view !== "kanban" ? sort : undefined,
    circleIds,
    assigneeMemberIds: assignedToMeActive || !currentMemberId ? [] : [currentMemberId],
    memberIds,
    group: boardGroupQuery,
    columns: view === "kanban" && !allActionColumnsVisible ? visibleActionColumnIds : undefined,
  });
  const boardGroupHref = (group: ActionBoardGroup) => buildWorkItemQuery({
    view: "kanban",
    status: statusQuery,
    circleIds,
    assigneeMemberIds,
    memberIds,
    group: group === "status" ? undefined : group,
    columns: group === "status" && !allActionColumnsVisible ? visibleActionColumnIds : undefined,
  });

  const canManageAction = (action: { authorUserId: string }) => actor.kind === "agent"
    || membership?.role === "ADMIN"
    || (actor.kind === "user" && action.authorUserId === actor.user.id);

  const ageText = (date: Date) => {
    const timestamp = new Date(date).getTime();
    if (Number.isNaN(timestamp)) return "";
    const days = Math.floor((Date.now() - timestamp) / (1000 * 60 * 60 * 24));
    if (days === 0) return t("ageToday");
    if (days === 1) return t("ageYesterday");
    return t("ageDaysAgo", { count: days });
  };

  const memberName = (member: { user: { displayName: string | null; email: string } }) => member.user.displayName || member.user.email;
  const actionMembers = members.map((member) => ({ id: member.id, label: memberName(member) }));
  const currentActorMember = currentMemberId && actor.kind === "user"
    ? { id: currentMemberId, label: actor.user.displayName || actor.user.email }
    : null;
  const filterMembers = currentActorMember && !actionMembers.some((member) => member.id === currentActorMember.id)
    ? [currentActorMember, ...actionMembers]
    : actionMembers;
  const priorityLabels = {
    3: tWork("priorityUrgent"),
    2: tWork("priorityImportant"),
    1: tWork("priorityMedium"),
    0: tWork("priorityLow"),
  } satisfies WorkItemPriorityLabels;
  const priorityText = (priority: number | null | undefined) => formatWorkItemPriority(priority, priorityLabels);
  const actionEditorLabels = {
    title: t("formTitle"),
    notes: t("formNotes"),
    assignee: t("formAssignee"),
    assigneeNone: t("formAssigneeNone"),
    submit: t("btnCreateAction"),
    cancel: tCommon("cancel"),
    dueDate: t("formDueDate"),
    priorityLabel: t("formPriority"),
    priority: priorityLabels,
  };

  function actionMoveLabel(status: ActionColumnStatus) {
    if (status === "DRAFT") return t("btnReturnToDraft");
    if (status === "OPEN") return t("btnOpen");
    if (status === "IN_PROGRESS") return t("btnStart");
    return t("btnComplete");
  }

  function renderEmptyActionState() {
    return <p className="muted">{t("noActionsFound")}</p>;
  }

  function renderActionMove(action: ActionListItem, targetStatus: ActionColumnStatus, options: { hidden?: boolean; primary?: boolean } = {}) {
    const key = `${options.hidden ? "hidden-" : ""}move-${targetStatus.toLowerCase()}`;
    const transition = `${action.id}:${targetStatus}`;
    const buttonClass = options.primary ? "primary small" : undefined;
    const buttonProps = options.hidden ? { "aria-hidden": true, tabIndex: -1 } : {};

    if (targetStatus === "COMPLETED") {
      return (
        <span
          key={key}
          data-work-item-dialog={transition}
          className={options.hidden ? "nr-hidden-transition-trigger" : undefined}
        >
          <WorkItemResolutionDialog
            action={updateActionAction}
            buttonLabel={t("btnComplete")}
            title={tWork("completeActionTitle")}
            noteName="completedVia"
            noteLabel={tWork("completionNote")}
            notePlaceholder={tWork("completionPlaceholder")}
            hiddenFields={{ workspaceId, actionId: action.id, status: "COMPLETED" }}
            submitLabel={t("btnComplete")}
            cancelLabel={tCommon("cancel")}
            fileLabel={tWork("evidence")}
            className={options.primary ? "primary small" : undefined}
          />
        </span>
      );
    }

    if (targetStatus === "DRAFT") {
      return (
        <form
          key={key}
          action={returnActionToDraftAction}
          data-work-item-transition={transition}
          className={options.hidden ? "nr-hidden-transition-form" : undefined}
        >
          <input type="hidden" name="workspaceId" value={workspaceId} />
          <input type="hidden" name="actionId" value={action.id} />
          <button type="submit" className={buttonClass} {...buttonProps}>{actionMoveLabel(targetStatus)}</button>
        </form>
      );
    }

    const actionHandler = action.status === "DRAFT" && targetStatus === "OPEN" ? publishActionAction : updateActionAction;
    return (
      <form
        key={key}
        action={actionHandler}
        data-work-item-transition={transition}
        className={options.hidden ? "nr-hidden-transition-form" : undefined}
      >
        <input type="hidden" name="workspaceId" value={workspaceId} />
        <input type="hidden" name="actionId" value={action.id} />
        {actionHandler === updateActionAction && <input type="hidden" name="status" value={targetStatus} />}
        <button type="submit" className={buttonClass} {...buttonProps}>{actionMoveLabel(targetStatus)}</button>
      </form>
    );
  }

  function renderPriorityTransition(action: ActionListItem, target: typeof ACTION_PRIORITY_COLUMNS[number], hidden = false) {
    const key = `${hidden ? "hidden-" : ""}priority-${target.priority}`;
    return (
      <form
        key={key}
        action={updateActionAction}
        data-work-item-transition={`${action.id}:${target.id}`}
        className={hidden ? "nr-hidden-transition-form" : undefined}
      >
        <input type="hidden" name="workspaceId" value={workspaceId} />
        <input type="hidden" name="actionId" value={action.id} />
        <input type="hidden" name="priority" value={target.priority} />
        <button type="submit" aria-hidden={hidden} tabIndex={hidden ? -1 : undefined}>{priorityText(target.priority)}</button>
      </form>
    );
  }

  function renderDueTransition(action: ActionListItem, target: ActionDueColumnId, hidden = false) {
    const dueAt = dueColumnTargetDate(target);
    if (dueAt === null) return null;
    return (
      <form
        key={`${hidden ? "hidden-" : ""}due-${target}`}
        action={updateActionAction}
        data-work-item-transition={`${action.id}:${target}`}
        className={hidden ? "nr-hidden-transition-form" : undefined}
      >
        <input type="hidden" name="workspaceId" value={workspaceId} />
        <input type="hidden" name="actionId" value={action.id} />
        <input type="hidden" name="dueAt" value={dueAt} />
        <button type="submit" aria-hidden={hidden} tabIndex={hidden ? -1 : undefined}>{tCommon("save")}</button>
      </form>
    );
  }

  function actionControls(action: ActionListItem) {
    const canManage = canManageAction(action);
    const canSubmittedEditorEdit = actor.kind === "user"
      && (action.authorUserId === actor.user.id || action.assigneeMemberId === membership?.id);
    const canEditContent = action.status === "DRAFT"
      ? canManage
      : (action.status === "OPEN" || action.status === "IN_PROGRESS") && canSubmittedEditorEdit;
    const primaryTarget: ActionColumnStatus | null = action.status === "DRAFT" && canManage
      ? "OPEN"
      : action.status === "OPEN"
        ? "IN_PROGRESS"
        : action.status === "IN_PROGRESS"
          ? "COMPLETED"
          : null;
    const canMoveToStatus = (targetStatus: ActionColumnStatus) => {
      if (targetStatus === action.status) return false;
      if (action.status === "DRAFT" || targetStatus === "DRAFT") return canManage;
      return true;
    };

    const primary = primaryTarget ? renderActionMove(action, primaryTarget, { primary: true }) : null;
    const moreItems: ReactNode[] = [];
    const hiddenTransitions = actionColumnStatuses
      .filter((targetStatus) => canMoveToStatus(targetStatus) && targetStatus !== primaryTarget)
      .map((targetStatus) => renderActionMove(action, targetStatus, { hidden: true }));
    for (const targetStatus of actionColumnStatuses) {
      if (!canMoveToStatus(targetStatus) || targetStatus === primaryTarget) continue;
      moreItems.push(renderActionMove(action, targetStatus));
    }
    if (canEditContent) {
      moreItems.push(
        <a key="edit" className="secondary small" href={`/workspaces/${workspaceId}/actions/${action.id}/edit`}>
          {t("btnEdit")}
        </a>,
      );
    }
    if (moreItems.length > 0) moreItems.push(<div key="divider" className="action-menu-divider" />);
    moreItems.push(
      <form key="delete" action={deleteActionAction}>
        <input type="hidden" name="workspaceId" value={workspaceId} />
        <input type="hidden" name="actionId" value={action.id} />
        <ConfirmSubmitButton className="danger" confirmMessage={t("confirmArchive")}>
          {t("btnDelete")}
        </ConfirmSubmitButton>
      </form>,
    );

    const hiddenPriorityTransitions = ACTION_PRIORITY_COLUMNS
      .filter((target) => normalizeWorkItemPriority(action.priority) !== target.priority)
      .map((target) => renderPriorityTransition(action, target, true));
    const hiddenDueTransitions: ReactNode[] = [];
    for (const target of ACTION_DUE_COLUMNS) {
      const transition = renderDueTransition(action, target, true);
      if (transition) hiddenDueTransitions.push(transition);
    }

    return {
      canEditContent,
      hiddenTransitions: [...hiddenTransitions, ...hiddenPriorityTransitions, ...hiddenDueTransitions],
      moreItems,
      primary,
    };
  }

  function renderPriorityChip(action: ActionListItem, canEditContent: boolean) {
    const currentPriority = normalizeWorkItemPriority(action.priority);
    if (!canEditContent) {
      return <span className="nr-card-chip">{priorityText(currentPriority)}</span>;
    }

    return (
      <details className="nr-card-chip-editor">
        <summary className="nr-hide-marker nr-card-chip" title={t("quickEditPriority")}>
          {priorityText(currentPriority)}
        </summary>
        <form action={updateActionAction} className="nr-card-chip-form">
          <input type="hidden" name="workspaceId" value={workspaceId} />
          <input type="hidden" name="actionId" value={action.id} />
          <label>
            <span className="nr-item-meta">{t("formPriority")}</span>
            <select name="priority" defaultValue={String(currentPriority)}>
              {ACTION_PRIORITY_COLUMNS.map((option) => (
                <option key={option.id} value={option.priority}>{priorityText(option.priority)}</option>
              ))}
            </select>
          </label>
          <button type="submit" className="secondary small">{tCommon("save")}</button>
        </form>
      </details>
    );
  }

  function renderDueChip(action: ActionListItem, canEditContent: boolean, dueDate: string | null) {
    if (!canEditContent && !dueDate) return null;
    if (!canEditContent) return <span className="nr-card-chip">{dueDate}</span>;

    return (
      <details className="nr-card-chip-editor">
        <summary className={`nr-hide-marker nr-card-chip ${dueDate ? "" : "nr-card-chip-muted"}`} title={t("quickEditDueDate")}>
          {dueDate ?? t("dueDateUnset")}
        </summary>
        <form action={updateActionAction} className="nr-card-chip-form">
          <input type="hidden" name="workspaceId" value={workspaceId} />
          <input type="hidden" name="actionId" value={action.id} />
          <label>
            <span className="nr-item-meta">{t("formDueDate")}</span>
            <input name="dueAt" type="date" defaultValue={dateInputValue(action.dueAt)} />
          </label>
          <button type="submit" className="secondary small">{tCommon("save")}</button>
        </form>
      </details>
    );
  }

  function renderChecklistProgress(action: ActionListItem, detailHref: string) {
    const total = action.checklistItemCount ?? 0;
    if (total <= 0) return null;
    const completed = action.checklistCompletedCount ?? 0;
    return (
      <a
        className="nr-card-chip"
        href={`${detailHref}#checklist`}
        title={t("checklistProgress", { completed, total })}
        aria-label={t("checklistProgress", { completed, total })}
        draggable={false}
      >
        {t("checklistProgressShort", { completed, total })}
      </a>
    );
  }

  function renderActionCard(action: ActionListItem, compact = false) {
    const detailHref = `/workspaces/${workspaceId}/actions/${action.id}`;
    const statusMeta = ACTION_STATUS_META[action.status as keyof typeof ACTION_STATUS_META] ?? ACTION_STATUS_META.OPEN;
    const authorName = action.author?.displayName || action.author?.email || "Unknown";
    const assigneeName = action.assigneeMember?.user?.displayName || action.assigneeMember?.user?.email;
    const createdAge = ageText(action.createdAt);
    const dueDate = action.dueAt ? new Date(action.dueAt).toLocaleDateString() : null;
    const evidence = evidenceByActionId.get(action.id) ?? [];
    const activeRequestCount = activeRequestCountByActionId.get(action.id) ?? 0;
    const { canEditContent, hiddenTransitions, moreItems, primary } = actionControls(action);
    const cardBadges: ReactNode[] = [];
    if (!compact) {
      cardBadges.push(
        <WorkItemLifecycleBadge key="lifecycle" status={action.status} label={t(statusMeta.labelKey)} />,
      );
    }
    if (activeRequestCount > 0) {
      cardBadges.push(
        <WorkItemAttentionBadge key="input-request">{t("inputRequestCount", { count: activeRequestCount })}</WorkItemAttentionBadge>,
      );
    }

    return (
      <WorkItemCard
        key={action.id}
        compact={compact}
        href={detailHref}
        title={action.title}
        titlePrefix={!compact && action.status === "DRAFT" ? <span title={t("statusDraft")} style={{ marginRight: 6 }}>◆</span> : null}
        ariaLabel={tWork("openItem", { title: action.title })}
        badges={cardBadges.length > 0 ? cardBadges : null}
        body={(
          <>
            {action.bodyMd && <MarkdownExcerpt markdown={action.bodyMd} maxLength={compact ? 120 : 220} as="div" className="nr-excerpt" />}
            {compact ? (
              <div className="nr-card-chip-row">
                {assigneeName && <span className="nr-card-chip">{assigneeName}</span>}
                {renderPriorityChip(action, canEditContent)}
                {renderDueChip(action, canEditContent, dueDate)}
                {renderChecklistProgress(action, detailHref)}
              </div>
            ) : (
              <>
                <div className="nr-item-meta" style={{ marginTop: 8 }}>
                  {t("metaCreator", { name: authorName })}
                  {createdAge ? ` · ${createdAge}` : ""}
                  {assigneeName ? ` · ${t("metaAssignee", { name: assigneeName })}` : ""}
                  {` · ${priorityText(action.priority)}`}
                  {action.circle ? ` · ${action.circle.name}` : ""}
                  {dueDate ? ` · ${t("metaDue", { date: dueDate })}` : ""}
                  {(action.checklistItemCount ?? 0) > 0 ? ` · ${t("checklistProgressShort", { completed: action.checklistCompletedCount ?? 0, total: action.checklistItemCount ?? 0 })}` : ""}
                  {" · "}
                  {action.version > 1 ? (
                    <a href={`/workspaces/${workspaceId}/versions?entityType=ACTION&entityId=${encodeURIComponent(action.id)}`} draggable={false}>v{action.version}</a>
                  ) : (
                    <>v{action.version}</>
                  )}
                </div>
                {action.proposal?.title && (
                  <div className="nr-tag-group">
                    <WorkItemRelationshipTag href={`/workspaces/${workspaceId}/proposals/${action.proposal.id}`}>
                      {t("metaLinkedToProposal", { title: action.proposal.title })}
                    </WorkItemRelationshipTag>
                  </div>
                )}
              </>
            )}
            {action.status === "COMPLETED" && action.completedVia && (
              <div className="nr-item-meta" style={{ marginTop: 10 }}>
                <strong>{tWork("completionNote")}</strong>
                <MarkdownExcerpt markdown={action.completedVia} maxLength={compact ? 120 : 220} as="div" className="nr-excerpt" />
              </div>
            )}
            {evidence.length > 0 && (
              <div className="nr-evidence-list">
                <strong>{tWork("completionEvidence")}</strong>
                {evidence.map((row) => (
                  <a key={row.id} href={`/workspaces/${workspaceId}/brain/sources`} draggable={false}>
                    {row.document.title}
                  </a>
                ))}
              </div>
            )}
          </>
        )}
        actions={(
          <ItemActions
            moreLabel={tCommon("moreActions")}
            primary={primary}
            more={moreItems.length > 0 ? moreItems : null}
          />
        )}
        hiddenTransitions={hiddenTransitions.length > 0 ? (
          <div className="nr-transition-controls">
            {hiddenTransitions}
          </div>
        ) : null}
      />
    );
  }

  const actionTableColumns: WorkItemTableColumn[] = [
    { id: "item", label: tWork("tableItem"), cellClassName: "nr-work-item-table-main" },
    { id: "status", label: tWork("tableStatus") },
    { id: "owner", label: t("formAssignee") },
    { id: "dates", label: tWork("tableDates") },
    { id: "priority", label: t("formPriority"), align: "right" },
    { id: "links", label: tWork("tableLinks") },
    { id: "actions", label: tWork("tableActions"), cellClassName: "nr-work-item-table-actions" },
  ];

  function actionTableRow(action: ActionListItem): WorkItemTableRow {
    const detailHref = `/workspaces/${workspaceId}/actions/${action.id}`;
    const statusMeta = ACTION_STATUS_META[action.status as keyof typeof ACTION_STATUS_META] ?? ACTION_STATUS_META.OPEN;
    const authorName = action.author?.displayName || action.author?.email || "Unknown";
    const assigneeName = action.assigneeMember?.user?.displayName || action.assigneeMember?.user?.email;
    const createdAge = ageText(action.createdAt);
    const dueDate = action.dueAt ? new Date(action.dueAt).toLocaleDateString() : null;
    const evidence = evidenceByActionId.get(action.id) ?? [];
    const activeRequestCount = activeRequestCountByActionId.get(action.id) ?? 0;
    const { hiddenTransitions, moreItems, primary } = actionControls(action);

    return {
      id: action.id,
      cells: {
        item: (
          <>
            <a href={detailHref} className="nr-work-item-table-title">
              {action.status === "DRAFT" && <span title={t("statusDraft")} style={{ marginRight: 6 }}>◆</span>}
              {action.title}
            </a>
            {activeRequestCount > 0 && (
              <div className="nr-work-item-table-meta nr-work-item-table-tags">
                <WorkItemAttentionBadge>{t("inputRequestCount", { count: activeRequestCount })}</WorkItemAttentionBadge>
              </div>
            )}
            {action.bodyMd && <MarkdownExcerpt markdown={action.bodyMd} maxLength={140} as="div" className="nr-work-item-table-meta" />}
            {action.status === "COMPLETED" && action.completedVia && (
              <div className="nr-work-item-table-meta">
                <strong>{tWork("completionNote")}</strong>{" "}
                <MarkdownExcerpt markdown={action.completedVia} maxLength={120} as="span" />
              </div>
            )}
            {evidence.length > 0 && (
              <div className="nr-work-item-table-meta nr-work-item-table-tags">
                <strong>{tWork("completionEvidence")}</strong>
                {evidence.map((row) => (
                  <a key={row.id} href={`/workspaces/${workspaceId}/brain/sources`}>
                    {row.document.title}
                  </a>
                ))}
              </div>
            )}
          </>
        ),
        status: <WorkItemLifecycleBadge status={action.status} label={t(statusMeta.labelKey)} />,
        owner: (
          <div className="nr-work-item-table-meta">
            <div>{t("metaCreator", { name: authorName })}</div>
            {assigneeName && <div>{t("metaAssignee", { name: assigneeName })}</div>}
            {action.circle && <div>{action.circle.name}</div>}
          </div>
        ),
        dates: (
          <div className="nr-work-item-table-meta">
            {createdAge && <div>{createdAge}</div>}
            {dueDate && <div>{t("metaDue", { date: dueDate })}</div>}
          </div>
        ),
        priority: priorityText(action.priority),
        links: (
          <div className="nr-work-item-table-meta nr-work-item-table-tags">
            {action.version > 1 ? (
              <a href={`/workspaces/${workspaceId}/versions?entityType=ACTION&entityId=${encodeURIComponent(action.id)}`}>v{action.version}</a>
            ) : (
              <span>v{action.version}</span>
            )}
            {action.proposal?.title ? (
              <WorkItemRelationshipTag href={`/workspaces/${workspaceId}/proposals/${action.proposal.id}`}>
                {t("metaLinkedToProposal", { title: action.proposal.title })}
              </WorkItemRelationshipTag>
            ) : null}
            {(action.checklistItemCount ?? 0) > 0 ? (
              <a href={`${detailHref}#checklist`}>
                {t("checklistProgressShort", { completed: action.checklistCompletedCount ?? 0, total: action.checklistItemCount ?? 0 })}
              </a>
            ) : null}
          </div>
        ),
        actions: (
          <>
            <ItemActions
              moreLabel={tCommon("moreActions")}
              primary={primary}
              more={moreItems.length > 0 ? moreItems : null}
            />
            {hiddenTransitions.length > 0 && (
              <div className="nr-transition-controls">
                {hiddenTransitions}
              </div>
            )}
          </>
        ),
      },
    };
  }

  function renderCompactCreateActionForm() {
    return (
      <details className="nr-kanban-add-card">
        <summary className="nr-hide-marker nr-kanban-add-trigger">
          {tWork("newDraftCard")}
        </summary>
        <ActionEditorForm
          action={createActionAction}
          workspaceId={workspaceId}
          priority={1}
          members={actionMembers}
          labels={actionEditorLabels}
        >
          <input type="hidden" name="isPrivate" value="on" />
        </ActionEditorForm>
      </details>
    );
  }

  const statusActionColumns: WorkItemKanbanColumn[] = (["DRAFT", "OPEN", "IN_PROGRESS", "COMPLETED"] as const).map((status: ActionColumnStatus) => ({
    id: status,
    label: t(ACTION_STATUS_META[status].labelKey),
    count: groupedActions[status].length,
    empty: <p className="muted">{t("noActionsFound")}</p>,
    addCard: status === "DRAFT" ? renderCompactCreateActionForm() : null,
    items: groupedActions[status].map((action) => ({
      id: action.id,
      status,
      sort: {
        priority: action.priority,
        date: action.createdAt,
        alpha: action.title,
      },
      node: renderActionCard(action, true),
    })),
  }));
  const priorityActionColumns: WorkItemKanbanColumn[] = ACTION_PRIORITY_COLUMNS.map((column) => {
    const items = displayActions.filter((action) => normalizeWorkItemPriority(action.priority) === column.priority);
    return {
      id: column.id,
      label: priorityText(column.priority),
      count: items.length,
      empty: <p className="muted">{t("noActionsFound")}</p>,
      items: items.map((action) => ({
        id: action.id,
        status: column.id,
        sort: {
          priority: action.priority,
          date: action.dueAt ?? action.createdAt,
          alpha: action.title,
        },
        node: renderActionCard(action, true),
      })),
    };
  });
  const dueColumnLabel = (column: ActionDueColumnId) => ({
    DUE_OVERDUE: tWork("dueOverdue"),
    DUE_TODAY: tWork("dueToday"),
    DUE_TOMORROW: tWork("dueTomorrow"),
    DUE_REST_WEEK: tWork("dueRestOfWeek"),
    DUE_NEXT_WEEK: tWork("dueNextWeek"),
    DUE_FUTURE: tWork("dueFuture"),
    DUE_NONE: tWork("dueNoDate"),
  })[column];
  const dueActionColumns: WorkItemKanbanColumn[] = ACTION_DUE_COLUMNS.map((column) => {
    const items = displayActions.filter((action) => actionDueColumnId(action.dueAt) === column);
    return {
      id: column,
      label: dueColumnLabel(column),
      count: items.length,
      empty: <p className="muted">{t("noActionsFound")}</p>,
      items: items.map((action) => ({
        id: action.id,
        status: column,
        sort: {
          priority: action.priority,
          date: action.dueAt ?? action.createdAt,
          alpha: action.title,
        },
        node: renderActionCard(action, true),
      })),
    };
  });
  const actionColumns = boardGroup === "priority"
    ? priorityActionColumns
    : boardGroup === "due"
      ? dueActionColumns
      : statusActionColumns;

  return (
    <>
      <WorkspacePageHeader title={t("pageTitle")} description={t("pageDescription")} />

      <section className="ws-section">
        <div className="nr-work-board-header">
          <div className="nr-filter-bar nr-filter-bar-wrap">
            {ACTION_STATUS_FILTERS.map((s) => (
              <a
                key={s}
                href={actionFilterHref(s)}
                className={`nr-filter-item ${actionFilterActive(s) ? "nr-filter-active" : ""}`}
              >
                {t(ACTION_STATUS_META[s].labelKey)} ({groupedActions[s].length})
              </a>
            ))}
            {currentMemberId && (
              <a
                href={assignedToMeHref}
                className={`nr-filter-item ${assignedToMeActive ? "nr-filter-active" : ""}`}
              >
                {tWork("assignedToMe")}
              </a>
            )}
          </div>
          <WorkItemToolbar
            currentView={view}
            currentSort={sort}
            listHref={buildWorkItemQuery({ sort, circleIds, assigneeMemberIds, memberIds, status: statusQuery, view: "list" })}
            kanbanHref={buildWorkItemQuery({ circleIds, assigneeMemberIds, memberIds, view: "kanban", status: statusQuery, group: boardGroupQuery })}
            tableHref={buildWorkItemQuery({ sort, circleIds, assigneeMemberIds, memberIds, status: statusQuery, view: "table" })}
            sortLinks={{
              priority: buildWorkItemQuery({ view: view === "table" ? "table" : "list", circleIds, assigneeMemberIds, memberIds, status: statusQuery, sort: "priority" }),
              date: buildWorkItemQuery({ view: view === "table" ? "table" : "list", circleIds, assigneeMemberIds, memberIds, status: statusQuery, sort: "date" }),
              alpha: buildWorkItemQuery({ view: view === "table" ? "table" : "list", circleIds, assigneeMemberIds, memberIds, status: statusQuery, sort: "alpha" }),
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

        {view === "kanban" && (
          <div className="nr-filter-bar nr-filter-bar-wrap nr-board-group-bar" aria-label={tWork("groupBy")}>
            {ACTION_BOARD_GROUPS.map((group) => (
              <a
                key={group}
                href={boardGroupHref(group)}
                className={`nr-filter-item ${boardGroup === group ? "nr-filter-active" : ""}`}
              >
                {group === "status"
                  ? tWork("groupByStatus")
                  : group === "due"
                    ? tWork("groupByDue")
                    : tWork("groupByPriority")}
              </a>
            ))}
          </div>
        )}

        <WorkItemFilterControls
          action={`/workspaces/${workspaceId}/actions`}
          status={statusFilter}
          view={view}
          sort={view !== "kanban" ? sort : undefined}
          columns={view === "kanban" && boardGroup === "status" && !allActionColumnsVisible ? visibleActionColumnIds : undefined}
          group={boardGroupQuery}
          statusOptions={ACTION_STATUS_FILTERS.map((filter) => ({ id: filter, label: ACTION_STATUS_META[filter].labelKey ? t(ACTION_STATUS_META[filter].labelKey) : filter }))}
          statusValues={statusFilters}
          showStatusFilter={false}
          summaryLabel={tWork("advancedFilters")}
          circleIds={circleIds}
          assigneeMemberIds={assigneeMemberIds}
          memberIds={memberIds}
          circles={circles.map((circle) => ({ id: circle.id, label: circle.name }))}
          assigneeMembers={filterMembers}
          members={filterMembers}
          labels={{
            status: tWork("status"),
            allStatuses: tWork("allStatuses"),
            circle: tWork("circle"),
            assignee: tWork("assignedTo"),
            person: tWork("personInvolved"),
            allCircles: tWork("allCircles"),
            allAssignees: tWork("allAssignees"),
            allPeople: tWork("allPeopleInvolved"),
            selectAll: tWork("selectAll"),
            unselectAll: tWork("unselectAll"),
            selectedCount: tWork("selectedCount", { count: "{count}" }),
            apply: tWork("applyFilters"),
            clear: tWork("clearFilters"),
          }}
        />

        {view === "kanban" ? (
          <WorkItemKanbanBoard
            columns={actionColumns}
            storageKey={`work-items:${workspaceId}:actions`}
            visibleColumnIds={boardGroup === "status" ? visibleActionColumnIds : undefined}
            hideColumnHrefs={boardGroup === "status" ? actionColumnHideHrefs : undefined}
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
            columns={actionTableColumns}
            rows={displayActions.map((action) => actionTableRow(action))}
            empty={renderEmptyActionState()}
          />
        ) : (
          <div>
            {displayActions.length === 0 && renderEmptyActionState()}
            {displayActions.map((action) => renderActionCard(action))}
          </div>
        )}
      </section>
    </>
  );
}
