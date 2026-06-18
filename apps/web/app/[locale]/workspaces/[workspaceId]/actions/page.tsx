import { listActions, listCircles, listMembers, listProposals, requireWorkspaceMembership } from "@corgtex/domain";
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
import {
  ACTION_STATUS_FILTERS,
  ACTION_STATUS_META,
  type ActionStatusFilter,
  groupActionsByStatus,
  normalizeActionStatusFilter,
} from "./view-model";
import { MarkdownEditor } from "@/lib/components/MarkdownEditor";
import { MarkdownExcerpt } from "@/lib/components/MarkdownRenderer";
import { ItemActions } from "@/lib/components/ui/ItemActions";
import { WorkItemFilterControls, WorkItemToolbar } from "@/lib/components/WorkItemControls";
import { WorkItemKanbanBoard, type WorkItemKanbanColumn } from "@/lib/components/WorkItemKanbanBoard";
import { WorkItemResolutionDialog } from "@/lib/components/WorkItemResolutionDialog";
import {
  buildWorkItemQuery,
  normalizeVisibleWorkItemColumns,
  normalizeWorkItemView,
  resolveWorkItemFilters,
  toggleWorkItemColumnVisibility,
} from "@/lib/work-item-view";

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
  const statusFilter = normalizeActionStatusFilter(resolvedSearch.status);
  const view = normalizeWorkItemView(resolvedSearch.view);
  const { circleId, memberId, sort } = resolveWorkItemFilters(resolvedSearch);
  const [{ items: actions }, { items: proposals }, circles, members] = await Promise.all([
    listActions(actor, workspaceId, {
      take: 200,
      circleId,
      memberId,
      sort,
    }),
    listProposals(actor, workspaceId, { take: 50 }),
    listCircles(workspaceId),
    listMembers(workspaceId),
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

  const activeProposals = proposals.filter((p) => p.status === "DRAFT" || p.status === "OPEN");
  const groupedActions = groupActionsByStatus(actions);
  const displayActions = groupedActions[statusFilter];
  type ActionListItem = (typeof actions)[number];
  type ActionColumnStatus = "DRAFT" | "OPEN" | "IN_PROGRESS" | "COMPLETED";
  const actionColumnStatuses: ActionColumnStatus[] = ["DRAFT", "OPEN", "IN_PROGRESS", "COMPLETED"];
  const visibleActionColumnIds = normalizeVisibleWorkItemColumns(resolvedSearch.columns, actionColumnStatuses);
  const allActionColumnsVisible = visibleActionColumnIds.length === actionColumnStatuses.length;
  const buildActionColumnHref = (status: ActionColumnStatus) => buildWorkItemQuery({
    view: "kanban",
    status: statusFilter,
    circleId,
    memberId,
    columns: toggleWorkItemColumnVisibility(visibleActionColumnIds, status, actionColumnStatuses),
  });
  const actionColumnHideHrefs = Object.fromEntries(
    actionColumnStatuses.map((status) => [status, buildActionColumnHref(status)]),
  );
  const actionFilterHref = (filter: ActionStatusFilter) => view === "kanban"
    ? buildWorkItemQuery({
      view: "kanban",
      status: statusFilter,
      circleId,
      memberId,
      columns: filter === "ALL" ? undefined : toggleWorkItemColumnVisibility(visibleActionColumnIds, filter, actionColumnStatuses),
    })
    : buildWorkItemQuery({ view, sort: view === "list" ? sort : undefined, circleId, memberId, status: filter });
  const actionFilterActive = (filter: ActionStatusFilter) => view === "kanban"
    ? filter === "ALL"
      ? allActionColumnsVisible
      : visibleActionColumnIds.includes(filter)
    : statusFilter === filter;

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

  function actionMoveLabel(status: ActionColumnStatus) {
    if (status === "DRAFT") return t("btnReturnToDraft");
    if (status === "OPEN") return t("btnOpen");
    if (status === "IN_PROGRESS") return t("btnStart");
    return t("btnComplete");
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

  function renderActionCard(action: ActionListItem, compact = false) {
    const detailHref = `/workspaces/${workspaceId}/actions/${action.id}`;
    const statusMeta = ACTION_STATUS_META[action.status as keyof typeof ACTION_STATUS_META] ?? ACTION_STATUS_META.OPEN;
    const authorName = action.author?.displayName || action.author?.email || "Unknown";
    const assigneeName = action.assigneeMember?.user?.displayName || action.assigneeMember?.user?.email;
    const createdAge = ageText(action.createdAt);
    const dueDate = action.dueAt ? new Date(action.dueAt).toLocaleDateString() : null;
    const canManage = canManageAction(action);
    const canSubmittedEditorEdit = actor.kind === "user"
      && (action.authorUserId === actor.user.id || action.assigneeMemberId === membership?.id);
    const canEditContent = action.status === "DRAFT"
      ? canManage
      : (action.status === "OPEN" || action.status === "IN_PROGRESS") && canSubmittedEditorEdit;
    const evidence = evidenceByActionId.get(action.id) ?? [];
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
        <details key="edit">
          <summary className="nr-hide-marker nr-action-summary">
            {t("btnEdit")}
          </summary>
          <form action={updateActionAction} className="action-menu-form">
            <input type="hidden" name="workspaceId" value={workspaceId} />
            <input type="hidden" name="actionId" value={action.id} />
            <label>
              {t("formTitle")}
              <input name="title" defaultValue={action.title} required />
            </label>
            <label>
              {t("formNotes")}
              <MarkdownEditor name="bodyMd" defaultValue={action.bodyMd ?? ""} rows={5} />
            </label>
            <label>
              {t("formPriority")}
              <input name="priority" type="number" min={0} defaultValue={action.priority} />
            </label>
            <button type="submit" className="secondary small">{action.status === "DRAFT" ? t("btnSaveDraft") : tCommon("save")}</button>
          </form>
        </details>,
      );
    }
    if (moreItems.length > 0) moreItems.push(<div key="divider" className="action-menu-divider" />);
    moreItems.push(
      <form key="delete" action={deleteActionAction}>
        <input type="hidden" name="workspaceId" value={workspaceId} />
        <input type="hidden" name="actionId" value={action.id} />
        <button type="submit" className="danger">{t("btnDelete")}</button>
      </form>,
    );

    return (
      <div className={`${compact ? "nr-kanban-card" : "nr-item nr-list-card"} nr-clickable-card`} key={action.id}>
        <a href={detailHref} className="nr-card-hitbox" aria-label={tWork("openItem", { title: action.title })} draggable={false} />
        <div className="row nr-card-content" style={{ alignItems: "center" }}>
          <strong className="nr-item-title">
            {!compact && action.status === "DRAFT" && <span title={t("statusDraft")} style={{ marginRight: 6 }}>◆</span>}
            {action.title}
          </strong>
          {!compact && <span className={`tag ${statusMeta.tagClass}`}>{t(statusMeta.labelKey)}</span>}
        </div>
        <div className="nr-card-content">
          {action.bodyMd && <MarkdownExcerpt markdown={action.bodyMd} maxLength={compact ? 120 : 220} as="div" className="nr-excerpt" />}
          <div className="nr-item-meta" style={{ marginTop: 8 }}>
            {t("metaCreator", { name: authorName })}
            {createdAge ? ` · ${createdAge}` : ""}
            {assigneeName ? ` · ${t("metaAssignee", { name: assigneeName })}` : ""}
            {` · ${tWork("priorityN", { priority: action.priority })}`}
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

  function renderCompactCreateActionForm() {
    return (
      <details className="nr-kanban-add-card">
        <summary className="nr-hide-marker nr-kanban-add-trigger">
          {tWork("newDraftCard")}
        </summary>
        <form action={createActionAction} className="stack nr-form-section nr-inline-draft-form">
          <input type="hidden" name="workspaceId" value={workspaceId} />
          <input type="hidden" name="isPrivate" value="on" />
          <label>
            {t("formTitle")}
            <input name="title" required />
          </label>
          <label>
            {t("formNotes")}
            <MarkdownEditor name="bodyMd" rows={4} />
          </label>
          <label>
            {t("formPriority")}
            <input name="priority" type="number" min={0} defaultValue={0} />
          </label>
          <button type="submit">{t("btnCreateAction")}</button>
        </form>
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
          </div>
          <WorkItemToolbar
            currentView={view}
            currentSort={sort}
            listHref={buildWorkItemQuery({ sort, circleId, memberId, status: statusFilter, view: "list" })}
            kanbanHref={buildWorkItemQuery({ circleId, memberId, status: statusFilter, view: "kanban" })}
            sortLinks={{
              priority: buildWorkItemQuery({ view: "list", circleId, memberId, status: statusFilter, sort: "priority" }),
              date: buildWorkItemQuery({ view: "list", circleId, memberId, status: statusFilter, sort: "date" }),
              alpha: buildWorkItemQuery({ view: "list", circleId, memberId, status: statusFilter, sort: "alpha" }),
            }}
            listLabel={tWork("listView")}
            kanbanLabel={tWork("kanbanView")}
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
          sort={view === "list" ? sort : undefined}
          columns={view === "kanban" && !allActionColumnsVisible ? visibleActionColumnIds : undefined}
          circleId={circleId}
          memberId={memberId}
          circles={circles.map((circle) => ({ id: circle.id, label: circle.name }))}
          members={members.map((member) => ({ id: member.id, label: memberName(member) }))}
          labels={{
            circle: tWork("circle"),
            person: tWork("person"),
            allCircles: tWork("allCircles"),
            allPeople: tWork("allPeople"),
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
        ) : (
          <div>
            {displayActions.length === 0 && <p className="muted">{t("noActionsFound")}</p>}
            {displayActions.map((action) => renderActionCard(action))}
          </div>
        )}
      </section>

      <section className={`ws-section ${view === "kanban" ? "nr-list-only-create" : ""}`}>
        <details open={resolvedSearch.open === "new"}>
          <summary className="nr-hide-marker nr-section-toggle">
            <span className="nr-section-header nr-section-header-inline">{t("newActionTitle")}</span>
          </summary>
          <form action={createActionAction} className="stack nr-form-section">
            <input type="hidden" name="workspaceId" value={workspaceId} />
            <label>
              {t("formTitle")}
              <input name="title" required />
            </label>
            <label>
              {t("formNotes")}
              <MarkdownEditor name="bodyMd" rows={5} />
            </label>
            <label>
              {t("formPriority")}
              <input name="priority" type="number" min={0} defaultValue={0} />
            </label>
            <details>
              <summary className="secondary small nr-hide-marker" style={{ cursor: "pointer", display: "inline-block" }}>{t("formOptionalMetadata")}</summary>
              <label style={{ marginTop: 12 }}>
                {t("formLinkToProposal")}
                <select name="proposalId" defaultValue="">
                  <option value="">{t("formNone")}</option>
                  {activeProposals.map((p) => (
                    <option value={p.id} key={p.id}>{p.title}</option>
                  ))}
                </select>
              </label>
            </details>
            <button type="submit">{t("btnCreateAction")}</button>
          </form>
        </details>
      </section>
    </>
  );
}
