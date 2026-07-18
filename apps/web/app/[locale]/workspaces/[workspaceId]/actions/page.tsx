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
import { ItemActions } from "@/lib/components/ui/ItemActions";
import { WorkItemFilterControls, WorkItemToolbar } from "@/lib/components/WorkItemControls";
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
import { formatWorkItemPriority, type WorkItemPriorityLabels } from "@/lib/work-item-priority";

export const dynamic = "force-dynamic";

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
    columns: toggleWorkItemColumnVisibility(visibleActionColumnIds, status, actionColumnStatuses),
  });
  const actionColumnHideHrefs = Object.fromEntries(
    actionColumnStatuses.map((status) => [status, buildActionColumnHref(status)]),
  );
  const actionFilterHref = (filter: ActionStatusFilter) => view === "kanban"
    ? buildWorkItemQuery({
      view: "kanban",
      status: filter === "ALL" ? "ALL" : statusQuery,
      circleIds,
      assigneeMemberIds,
      memberIds,
      columns: filter === "ALL" ? undefined : toggleWorkItemColumnVisibility(visibleActionColumnIds, filter, actionColumnStatuses),
    })
    : buildWorkItemQuery({ view, sort, circleIds, assigneeMemberIds, memberIds, status: filter });
  const actionFilterActive = (filter: ActionStatusFilter) => view === "kanban"
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
    columns: view === "kanban" && !allActionColumnsVisible ? visibleActionColumnIds : undefined,
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

    return { hiddenTransitions, moreItems, primary };
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
    const { hiddenTransitions, moreItems, primary } = actionControls(action);

    return (
      <div className={`${compact ? "nr-kanban-card" : "nr-item nr-list-card"} nr-clickable-card`} key={action.id}>
        <a href={detailHref} className="nr-card-hitbox" aria-label={tWork("openItem", { title: action.title })} draggable={false} />
        <div className="row nr-card-content" style={{ alignItems: "center" }}>
          <strong className="nr-item-title">
            {!compact && action.status === "DRAFT" && <span title={t("statusDraft")} style={{ marginRight: 6 }}>◆</span>}
            {action.title}
          </strong>
          {!compact && <span className={`tag ${statusMeta.tagClass}`}>{t(statusMeta.labelKey)}</span>}
          {activeRequestCount > 0 && <span className="tag warning">{t("inputRequestCount", { count: activeRequestCount })}</span>}
        </div>
        <div className="nr-card-content">
          {action.bodyMd && <MarkdownExcerpt markdown={action.bodyMd} maxLength={compact ? 120 : 220} as="div" className="nr-excerpt" />}
          <div className="nr-item-meta" style={{ marginTop: 8 }}>
            {t("metaCreator", { name: authorName })}
            {createdAge ? ` · ${createdAge}` : ""}
            {assigneeName ? ` · ${t("metaAssignee", { name: assigneeName })}` : ""}
            {` · ${priorityText(action.priority)}`}
            {action.circle ? ` · ${action.circle.name}` : ""}
            {dueDate ? ` · ${t("metaDue", { date: dueDate })}` : ""}
            {action.proposal?.title ? ` · ${t("metaLinkedToProposal", { title: action.proposal.title })}` : ""}
            {" · "}
            {action.version > 1 ? (
              <a href={`/workspaces/${workspaceId}/versions?entityType=ACTION&entityId=${encodeURIComponent(action.id)}`} draggable={false}>v{action.version}</a>
            ) : (
              <>v{action.version}</>
            )}
          </div>
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
        </div>
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
      </div>
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
                <span className="tag warning">{t("inputRequestCount", { count: activeRequestCount })}</span>
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
        status: <span className={`tag ${statusMeta.tagClass}`}>{t(statusMeta.labelKey)}</span>,
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
              <a href={`/workspaces/${workspaceId}/proposals/${action.proposal.id}`}>
                {t("metaLinkedToProposal", { title: action.proposal.title })}
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

  const actionColumns: WorkItemKanbanColumn[] = (["DRAFT", "OPEN", "IN_PROGRESS", "COMPLETED"] as const).map((status: ActionColumnStatus) => ({
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

  return (
    <>
      <header className="nr-masthead" style={{ textAlign: "left", marginBottom: 32 }}>
        <h1 style={{ border: "none", padding: 0, margin: 0, fontSize: "2rem" }}>{t("pageTitle")}</h1>
        <div className="nr-masthead-meta">
          <span>{t("pageDescription")}</span>
        </div>
      </header>

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
            kanbanHref={buildWorkItemQuery({ circleIds, assigneeMemberIds, memberIds, view: "kanban" })}
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

        <WorkItemFilterControls
          action={`/workspaces/${workspaceId}/actions`}
          status={statusFilter}
          view={view}
          sort={view !== "kanban" ? sort : undefined}
          columns={view === "kanban" && !allActionColumnsVisible ? visibleActionColumnIds : undefined}
          statusOptions={ACTION_STATUS_FILTERS.map((filter) => ({ id: filter, label: ACTION_STATUS_META[filter].labelKey ? t(ACTION_STATUS_META[filter].labelKey) : filter }))}
          statusValues={statusFilters}
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
            visibleColumnIds={visibleActionColumnIds}
            hideColumnHrefs={actionColumnHideHrefs}
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
