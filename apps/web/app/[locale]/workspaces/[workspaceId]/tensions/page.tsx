import { listAdviceRequests, listCircles, listHumanMembers, listTensions, requireWorkspaceMembership } from "@corgtex/domain";
import type { ReactNode } from "react";
import { requirePageActor } from "@/lib/auth";
import {
  createTensionAction,
  updateTensionAction,
  upvoteTensionAction,
  deleteTensionAction,
  publishTensionAction,
  returnTensionToDraftAction,
  createProposalFromTensionAction,
} from "../actions";
import { MarkdownEditor } from "@/lib/components/MarkdownEditor";
import { MarkdownExcerpt } from "@/lib/components/MarkdownRenderer";
import { ItemActions } from "@/lib/components/ui/ItemActions";
import { WorkItemMemberSelect, type WorkItemMemberOption } from "@/lib/components/WorkItemMemberSelect";
import {
  WorkItemAttentionBadge,
  WorkItemCard,
  WorkItemFilterControls,
  WorkItemLifecycleBadge,
  WorkItemRelationshipTag,
  WorkItemToolbar,
} from "@/lib/components/WorkItemControls";
import { WorkItemKanbanBoard, type WorkItemKanbanColumn } from "@/lib/components/WorkItemKanbanBoard";
import { WorkItemPrioritySelect } from "@/lib/components/WorkItemPrioritySelect";
import { WorkItemResolutionDialog } from "@/lib/components/WorkItemResolutionDialog";
import { WorkItemTable, type WorkItemTableColumn, type WorkItemTableRow } from "@/lib/components/WorkItemTable";
import { formatWorkItemPriority, type WorkItemPriorityLabels } from "@/lib/work-item-priority";
import {
  buildWorkItemQuery,
  normalizeVisibleWorkItemColumns,
  normalizeWorkItemView,
  resolveWorkItemFilters,
  endOfUtcDate,
  startOfUtcDate,
  toggleWorkItemColumnVisibility,
} from "@/lib/work-item-view";
import { getTranslations } from "next-intl/server";
import {
  TENSION_STATUS_FILTERS,
  type TensionStatusQuery,
  type TensionStatusFilter,
  groupTensionsByStatus,
  resolveTensionSearch,
  tensionMatchesStatusFilters,
} from "./view-model";

export const dynamic = "force-dynamic";

export default async function TensionsPage({
  params,
  searchParams,
}: {
  params: Promise<{ workspaceId: string }>;
  searchParams?: Promise<Record<string, string | string[] | undefined>>;
}) {
  const { workspaceId } = await params;
  const actor = await requirePageActor();
  const t = await getTranslations("tensions");
  const tCommon = await getTranslations("common");
  const tWork = await getTranslations("workItems");
  const membership = await requireWorkspaceMembership({ actor, workspaceId });
  const resolvedSearch = searchParams ? await searchParams : {};
  const view = normalizeWorkItemView(resolvedSearch.view);
  const { statusFilter, statusFilters, statusQuery, dateFilters } = resolveTensionSearch(resolvedSearch, view === "kanban" ? null : "OPEN");
  const { circleIds, memberIds, sort } = resolveWorkItemFilters(resolvedSearch);
  const listDateFilters = {
    openedFrom: dateFilters.openedFrom ? startOfUtcDate(dateFilters.openedFrom) : undefined,
    openedTo: dateFilters.openedTo ? endOfUtcDate(dateFilters.openedTo) : undefined,
    closedFrom: dateFilters.closedFrom ? startOfUtcDate(dateFilters.closedFrom) : undefined,
    closedTo: dateFilters.closedTo ? endOfUtcDate(dateFilters.closedTo) : undefined,
  };
  const [{ items: tensions }, circles, members, activeInputRequests] = await Promise.all([
    listTensions(actor, workspaceId, { take: 200, circleIds, memberIds, sort, ...listDateFilters }),
    listCircles(workspaceId),
    listHumanMembers(workspaceId),
    listAdviceRequests(actor, { workspaceId, subjectType: "TENSION", status: "ACTIVE", take: 500 }),
  ]);

  const groupedTensions = groupTensionsByStatus(tensions);
  const displayTensions = tensions.filter((tension) => tensionMatchesStatusFilters(tension, statusFilters));
  const activeInputRequestCounts = activeInputRequests.reduce((counts, request) => {
    const tensionId = request.process.subjectId;
    counts.set(tensionId, (counts.get(tensionId) ?? 0) + 1);
    return counts;
  }, new Map<string, number>());
  type TensionListItem = (typeof tensions)[number];
  type TensionColumnStatus = "DRAFT" | "OPEN" | "RESOLVED";
  const tensionColumnStatuses: TensionColumnStatus[] = ["DRAFT", "OPEN", "RESOLVED"];
  const visibleTensionColumnIds = normalizeVisibleWorkItemColumns(resolvedSearch.columns, tensionColumnStatuses);
  const allTensionColumnsVisible = visibleTensionColumnIds.length === tensionColumnStatuses.length;
  const buildTensionColumnHref = (status: TensionColumnStatus, queryStatus: TensionStatusQuery = statusQuery) => buildWorkItemQuery({
    view: "kanban",
    status: queryStatus,
    circleIds,
    memberIds,
    dates: dateFilters,
    columns: toggleWorkItemColumnVisibility(visibleTensionColumnIds, status, tensionColumnStatuses),
  });
  const tensionColumnHideHrefs = Object.fromEntries(
    tensionColumnStatuses.map((status) => [status, buildTensionColumnHref(status)]),
  );
  const tensionFilterHref = (filter: TensionStatusFilter) => view === "kanban"
    ? buildWorkItemQuery({
      view: "kanban",
      status: filter === "ALL" ? "ALL" : statusQuery,
      circleIds,
      memberIds,
      dates: dateFilters,
      columns: filter === "ALL" ? undefined : toggleWorkItemColumnVisibility(visibleTensionColumnIds, filter, tensionColumnStatuses),
    })
    : buildWorkItemQuery({ view, sort, circleIds, memberIds, dates: dateFilters, status: filter });
  const tensionFilterActive = (filter: TensionStatusFilter) => view === "kanban"
    ? filter === "ALL"
      ? allTensionColumnsVisible
      : visibleTensionColumnIds.includes(filter)
    : filter === "ALL"
      ? statusFilters.length === 0
      : statusFilters.includes(filter);

  const ageText = (date: Date) => {
    const days = Math.floor((Date.now() - new Date(date).getTime()) / (1000 * 60 * 60 * 24));
    return days === 0 ? t("ageToday") : t("ageDaysAgo", { days });
  };

  const statusLabel = (status: string) => {
    const labels: Record<string, string> = {
      DRAFT: t("statusDraft"),
      OPEN: t("statusOpen"),
      RESOLVED: t("statusResolved"),
      ALL: t("statusAll"),
    };
    return labels[status] ?? status;
  };

  const memberName = (member: { user: { displayName: string | null; email: string } }) => member.user.displayName || member.user.email;
  const memberOptions: WorkItemMemberOption[] = members.map((member) => ({ id: member.id, label: memberName(member) }));
  const priorityLabels = {
    3: tWork("priorityUrgent"),
    2: tWork("priorityImportant"),
    1: tWork("priorityMedium"),
    0: tWork("priorityLow"),
  } satisfies WorkItemPriorityLabels;
  const priorityText = (priority: number | null | undefined) => formatWorkItemPriority(priority, priorityLabels);
  const canManageTension = (tension: { authorUserId: string }) => actor.kind === "agent"
    || membership?.role === "ADMIN"
    || (actor.kind === "user" && tension.authorUserId === actor.user.id);

  function tensionMoveLabel(status: TensionColumnStatus) {
    if (status === "DRAFT") return t("btnReturnToDraft");
    if (status === "OPEN") return t("btnOpen");
    return t("btnResolve");
  }

  function renderTensionMove(tension: TensionListItem, targetStatus: TensionColumnStatus, options: { hidden?: boolean; primary?: boolean } = {}) {
    const key = `${options.hidden ? "hidden-" : ""}move-${targetStatus.toLowerCase()}`;
    const transition = `${tension.id}:${targetStatus}`;
    const buttonClass = options.primary ? "primary small" : undefined;
    const buttonProps = options.hidden ? { "aria-hidden": true, tabIndex: -1 } : {};

    if (targetStatus === "RESOLVED") {
      return (
        <span
          key={key}
          data-work-item-dialog={transition}
          className={options.hidden ? "nr-hidden-transition-trigger" : undefined}
        >
          <WorkItemResolutionDialog
            action={updateTensionAction}
            buttonLabel={t("btnResolve")}
            title={tWork("resolveTensionTitle")}
            noteName="resolvedVia"
            noteLabel={tWork("resolutionNote")}
            notePlaceholder={t("placeholderResolvedVia")}
            hiddenFields={{ workspaceId, tensionId: tension.id, status: "RESOLVED" }}
            submitLabel={t("btnResolve")}
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
          action={returnTensionToDraftAction}
          data-work-item-transition={transition}
          className={options.hidden ? "nr-hidden-transition-form" : undefined}
        >
          <input type="hidden" name="workspaceId" value={workspaceId} />
          <input type="hidden" name="tensionId" value={tension.id} />
          <button type="submit" className={buttonClass} {...buttonProps}>{tensionMoveLabel(targetStatus)}</button>
        </form>
      );
    }

    const actionHandler = tension.status === "DRAFT" ? publishTensionAction : updateTensionAction;
    return (
      <form
        key={key}
        action={actionHandler}
        data-work-item-transition={transition}
        className={options.hidden ? "nr-hidden-transition-form" : undefined}
      >
        <input type="hidden" name="workspaceId" value={workspaceId} />
        <input type="hidden" name="tensionId" value={tension.id} />
        {actionHandler === updateTensionAction && <input type="hidden" name="status" value={targetStatus} />}
        <button type="submit" className={buttonClass} {...buttonProps}>{tensionMoveLabel(targetStatus)}</button>
      </form>
    );
  }

  function tensionControls(tension: TensionListItem) {
    const canManage = canManageTension(tension);
    const canCollaborateOnSubmittedTension = !tension.isPrivate && (actor.kind === "agent" || Boolean(membership?.isActive));
    const canEditContent = tension.status === "DRAFT" ? canManage : tension.status === "OPEN" && canCollaborateOnSubmittedTension;
    const canDraftProposal = !tension.proposal && (canManage || !tension.isPrivate);
    const primary = canManage && tension.status === "DRAFT" ? renderTensionMove(tension, "OPEN", { primary: true }) : !tension.isPrivate && tension.status === "OPEN" ? (
      <form action={upvoteTensionAction}>
        <input type="hidden" name="workspaceId" value={workspaceId} />
        <input type="hidden" name="tensionId" value={tension.id} />
        <button type="submit" className="primary small">{t("btnUpvote")}</button>
      </form>
    ) : null;
    const moreItems: ReactNode[] = [];
    const primaryMoveTarget = canManage && tension.status === "DRAFT" ? "OPEN" : null;
    const canMoveToStatus = (targetStatus: TensionColumnStatus) => {
      if (targetStatus === tension.status) return false;
      if (tension.status === "DRAFT" || targetStatus === "DRAFT") return canManage;
      if (targetStatus === "RESOLVED") return !tension.isPrivate;
      return true;
    };
    const hiddenTransitions = tensionColumnStatuses
      .filter((targetStatus) => canMoveToStatus(targetStatus) && targetStatus !== primaryMoveTarget)
      .map((targetStatus) => renderTensionMove(tension, targetStatus, { hidden: true }));
    for (const targetStatus of tensionColumnStatuses) {
      if (!canMoveToStatus(targetStatus) || targetStatus === primaryMoveTarget) continue;
      moreItems.push(renderTensionMove(tension, targetStatus));
    }
    if (canDraftProposal) {
      moreItems.push(
        <form key="draft-proposal" action={createProposalFromTensionAction}>
          <input type="hidden" name="workspaceId" value={workspaceId} />
          <input type="hidden" name="sourceTensionId" value={tension.id} />
          <button type="submit">{t("btnDraftProposal")}</button>
        </form>,
      );
    }
    if (canEditContent) {
      moreItems.push(
        <form key="edit-raised-by" action={updateTensionAction} className="action-menu-form">
          <input type="hidden" name="workspaceId" value={workspaceId} />
          <input type="hidden" name="tensionId" value={tension.id} />
          <span className="action-menu-label">{t("btnEditRaisedBy")}</span>
          <select name="raisedByMemberId" defaultValue={tension.raisedByMemberId || ""} aria-label={t("formRaisedBy")}>
            <option value="">{t("formRaisedByNone")}</option>
            {memberOptions.map((member) => (
              <option value={member.id} key={member.id}>{member.label}</option>
            ))}
          </select>
          <button type="submit" className="secondary small">{t("btnSaveRaisedBy")}</button>
        </form>,
      );
      moreItems.push(
        <details key="edit">
          <summary className="nr-hide-marker nr-action-summary">
            {t("btnEdit")}
          </summary>
          <form action={updateTensionAction} className="action-menu-form">
            <input type="hidden" name="workspaceId" value={workspaceId} />
            <input type="hidden" name="tensionId" value={tension.id} />
            <label>
              {t("formTitle")}
              <input name="title" defaultValue={tension.title} required />
            </label>
            <label>
              {t("formDescription")}
              <MarkdownEditor name="bodyMd" defaultValue={tension.bodyMd ?? ""} rows={5} />
            </label>
            <WorkItemMemberSelect
              name="assigneeMemberId"
              label={t("formResponsiblePerson")}
              noneLabel={t("formResponsiblePersonNone")}
              members={memberOptions}
              defaultValue={tension.assigneeMemberId}
            />
            <WorkItemPrioritySelect label={t("formPriority")} labels={priorityLabels} defaultValue={tension.priority} />
            <button type="submit" className="secondary small">{tension.status === "DRAFT" ? t("btnSaveDraft") : tCommon("save")}</button>
          </form>
        </details>,
      );
    }
    if (moreItems.length > 0) moreItems.push(<div key="divider" className="action-menu-divider" />);
    moreItems.push(
      <form key="delete" action={deleteTensionAction}>
        <input type="hidden" name="workspaceId" value={workspaceId} />
        <input type="hidden" name="tensionId" value={tension.id} />
        <button type="submit" className="danger">{t("btnDelete")}</button>
      </form>,
    );

    return { hiddenTransitions, moreItems, primary };
  }

  function renderTensionCard(tension: TensionListItem, compact = false) {
    const detailHref = `/workspaces/${workspaceId}/tensions/${tension.id}`;
    const authorName = tension.author.displayName || tension.author.email || t("authorUnknown");
    const raisedByName = tension.raisedByMember ? memberName(tension.raisedByMember) : null;
    const responsibleName = tension.assigneeMember ? memberName(tension.assigneeMember) : null;
    const openedDate = tension.publishedAt ? new Date(tension.publishedAt).toLocaleDateString() : null;
    const closedDate = tension.resolvedAt ? new Date(tension.resolvedAt).toLocaleDateString() : null;
    const inputRequestCount = activeInputRequestCounts.get(tension.id) ?? 0;
    const { hiddenTransitions, moreItems, primary } = tensionControls(tension);
    const cardBadges: ReactNode[] = [];
    if (!compact) {
      cardBadges.push(
        <WorkItemLifecycleBadge key="lifecycle" status={tension.status} label={statusLabel(tension.status)} />,
      );
    }
    if (inputRequestCount > 0) {
      cardBadges.push(
        <WorkItemAttentionBadge key="input-request">{t("inputRequestedCount", { count: inputRequestCount })}</WorkItemAttentionBadge>,
      );
    }

    return (
      <WorkItemCard
        key={tension.id}
        compact={compact}
        href={detailHref}
        title={tension.title}
        titlePrefix={tension.isPrivate ? <span title={t("privateInboxTooltip")} style={{ marginRight: 6 }}>◆</span> : null}
        ariaLabel={tWork("openItem", { title: tension.title })}
        badges={cardBadges.length > 0 ? cardBadges : null}
        body={(
          <>
            {tension.bodyMd && <MarkdownExcerpt markdown={tension.bodyMd} maxLength={compact ? 120 : 220} as="div" className="nr-excerpt" />}
            <div className="nr-item-meta" style={{ marginTop: 8 }}>
              {t("createdByMeta", { name: authorName })}
              {raisedByName ? ` · ${t("raisedByMeta", { name: raisedByName })}` : ""}
              {responsibleName ? ` · ${t("responsiblePersonMeta", { name: responsibleName })}` : ""}
              {` · ${ageText(tension.createdAt)} · ${t("upvotes", { count: tension.upvotes.length })} · ${priorityText(tension.priority)}`}
              {tension.circle ? ` · ${tension.circle.name}` : ""}
              {openedDate ? ` · ${t("openedOnMeta", { date: openedDate })}` : ""}
              {closedDate ? ` · ${t("closedOnMeta", { date: closedDate })}` : ""}
              {" · "}
              {tension.version > 1 ? (
                <a href={`/workspaces/${workspaceId}/versions?entityType=TENSION&entityId=${encodeURIComponent(tension.id)}`} draggable={false}>v{tension.version}</a>
              ) : (
                <>v{tension.version}</>
              )}
            </div>
            {tension.proposal && (
              <div className="nr-tag-group">
                <WorkItemRelationshipTag href={`/workspaces/${workspaceId}/proposals/${tension.proposal.id}`}>
                  {t("linkedProposalMeta", { title: tension.proposal.title })}
                </WorkItemRelationshipTag>
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

  function renderEmptyTensionState() {
    return (
      <div className="nr-item nr-empty-state">
        <h3 className="nr-empty-title">{t("whatIsTensionTitle")}</h3>
        <p className="muted nr-empty-desc">
          {t("whatIsTensionDesc")}
        </p>
      </div>
    );
  }

  const tensionTableColumns: WorkItemTableColumn[] = [
    { id: "item", label: tWork("tableItem"), cellClassName: "nr-work-item-table-main" },
    { id: "status", label: tWork("tableStatus") },
    { id: "owner", label: t("formResponsiblePerson") },
    { id: "dates", label: tWork("tableDates") },
    { id: "priority", label: t("formPriority"), align: "right" },
    { id: "links", label: tWork("tableLinks") },
    { id: "actions", label: tWork("tableActions"), cellClassName: "nr-work-item-table-actions" },
  ];

  function tensionTableRow(tension: TensionListItem): WorkItemTableRow {
    const detailHref = `/workspaces/${workspaceId}/tensions/${tension.id}`;
    const authorName = tension.author.displayName || tension.author.email || t("authorUnknown");
    const raisedByName = tension.raisedByMember ? memberName(tension.raisedByMember) : null;
    const responsibleName = tension.assigneeMember ? memberName(tension.assigneeMember) : null;
    const openedDate = tension.publishedAt ? new Date(tension.publishedAt).toLocaleDateString() : null;
    const closedDate = tension.resolvedAt ? new Date(tension.resolvedAt).toLocaleDateString() : null;
    const inputRequestCount = activeInputRequestCounts.get(tension.id) ?? 0;
    const { hiddenTransitions, moreItems, primary } = tensionControls(tension);

    return {
      id: tension.id,
      cells: {
        item: (
          <>
            <a href={detailHref} className="nr-work-item-table-title">
              {tension.isPrivate && <span title={t("privateInboxTooltip")} style={{ marginRight: 6 }}>◆</span>}
              {tension.title}
            </a>
            {tension.bodyMd && <MarkdownExcerpt markdown={tension.bodyMd} maxLength={140} as="div" className="nr-work-item-table-meta" />}
            <div className="nr-work-item-table-meta">{t("upvotes", { count: tension.upvotes.length })}</div>
          </>
        ),
        status: <WorkItemLifecycleBadge status={tension.status} label={statusLabel(tension.status)} />,
        owner: (
          <div className="nr-work-item-table-meta">
            <div>{t("createdByMeta", { name: authorName })}</div>
            {raisedByName && <div>{t("raisedByMeta", { name: raisedByName })}</div>}
            {responsibleName && <div>{t("responsiblePersonMeta", { name: responsibleName })}</div>}
            {tension.circle && <div>{tension.circle.name}</div>}
          </div>
        ),
        dates: (
          <div className="nr-work-item-table-meta">
            <div>{ageText(tension.createdAt)}</div>
            {openedDate && <div>{t("openedOnMeta", { date: openedDate })}</div>}
            {closedDate && <div>{t("closedOnMeta", { date: closedDate })}</div>}
          </div>
        ),
        priority: priorityText(tension.priority),
        links: (
          <div className="nr-work-item-table-meta nr-work-item-table-tags">
            {tension.version > 1 ? (
              <a href={`/workspaces/${workspaceId}/versions?entityType=TENSION&entityId=${encodeURIComponent(tension.id)}`}>v{tension.version}</a>
            ) : (
              <span>v{tension.version}</span>
            )}
            {tension.proposal && (
              <WorkItemRelationshipTag href={`/workspaces/${workspaceId}/proposals/${tension.proposal.id}`}>
                {t("linkedProposalMeta", { title: tension.proposal.title })}
              </WorkItemRelationshipTag>
            )}
            {inputRequestCount > 0 && (
              <WorkItemAttentionBadge>{t("inputRequestedCount", { count: inputRequestCount })}</WorkItemAttentionBadge>
            )}
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

  function renderCompactCreateTensionForm() {
    return (
      <details className="nr-kanban-add-card">
        <summary className="nr-hide-marker nr-kanban-add-trigger">
          {tWork("newDraftCard")}
        </summary>
        <form action={createTensionAction} className="stack nr-form-section nr-inline-draft-form">
          <input type="hidden" name="workspaceId" value={workspaceId} />
          <input type="hidden" name="isPrivate" value="on" />
          <label>
            {t("formTitle")}
            <input name="title" required />
          </label>
          <label>
            {t("formDescription")}
            <MarkdownEditor name="bodyMd" rows={4} />
          </label>
          <WorkItemMemberSelect
            name="assigneeMemberId"
            label={t("formResponsiblePerson")}
            noneLabel={t("formResponsiblePersonNone")}
            members={memberOptions}
          />
          <WorkItemPrioritySelect label={t("formPriority")} labels={priorityLabels} defaultValue={0} />
          <button type="submit">{t("btnCreateTension")}</button>
        </form>
      </details>
    );
  }

  const tensionColumns: WorkItemKanbanColumn[] = (["DRAFT", "OPEN", "RESOLVED"] as const).map((status: TensionColumnStatus) => ({
    id: status,
    label: statusLabel(status),
    count: groupedTensions[status].length,
    empty: <p className="muted">{t("noTensions")}</p>,
    addCard: status === "DRAFT" ? renderCompactCreateTensionForm() : null,
    items: groupedTensions[status].map((tension) => ({
      id: tension.id,
      status,
      sort: {
        priority: tension.priority,
        date: tension.createdAt,
        alpha: tension.title,
      },
      node: renderTensionCard(tension, true),
    })),
  }));

  return (
    <>
      <header className="nr-masthead" style={{ textAlign: "left", marginBottom: 32 }}>
        <h1>{t("pageTitle")}</h1>
        <div className="nr-masthead-meta">
          <span>{t("pageDescription")}</span>
        </div>
      </header>

      <section className="ws-section">
        <div className="nr-work-board-header">
          <div className="nr-filter-bar nr-filter-bar-wrap">
            {TENSION_STATUS_FILTERS.map((status) => (
              <a
                key={status}
                href={tensionFilterHref(status)}
                className={`nr-filter-item ${tensionFilterActive(status) ? "nr-filter-active" : ""}`}
              >
                {t("filterWithCount", { label: statusLabel(status), count: groupedTensions[status].length })}
              </a>
            ))}
          </div>
          <WorkItemToolbar
            currentView={view}
            currentSort={sort}
            listHref={buildWorkItemQuery({ sort, circleIds, memberIds, dates: dateFilters, status: statusQuery, view: "list" })}
            kanbanHref={buildWorkItemQuery({ circleIds, memberIds, dates: dateFilters, view: "kanban" })}
            tableHref={buildWorkItemQuery({ sort, circleIds, memberIds, dates: dateFilters, status: statusQuery, view: "table" })}
            sortLinks={{
              priority: buildWorkItemQuery({ view: view === "table" ? "table" : "list", circleIds, memberIds, dates: dateFilters, status: statusQuery, sort: "priority" }),
              date: buildWorkItemQuery({ view: view === "table" ? "table" : "list", circleIds, memberIds, dates: dateFilters, status: statusQuery, sort: "date" }),
              alpha: buildWorkItemQuery({ view: view === "table" ? "table" : "list", circleIds, memberIds, dates: dateFilters, status: statusQuery, sort: "alpha" }),
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
          action={`/workspaces/${workspaceId}/tensions`}
          view={view}
          sort={view !== "kanban" ? sort : undefined}
          columns={view === "kanban" && !allTensionColumnsVisible ? visibleTensionColumnIds : undefined}
          status={statusFilter}
          statusOptions={TENSION_STATUS_FILTERS.map((filter) => ({ id: filter, label: statusLabel(filter) }))}
          statusValues={statusFilters}
          showStatusFilter={false}
          summaryLabel={tWork("advancedFilters")}
          circleIds={circleIds}
          memberIds={memberIds}
          circles={circles.map((circle) => ({ id: circle.id, label: circle.name }))}
          members={members.map((member) => ({ id: member.id, label: memberName(member) }))}
          dates={[
            { name: "openedFrom", label: t("filterOpenedFrom"), value: dateFilters.openedFrom },
            { name: "openedTo", label: t("filterOpenedTo"), value: dateFilters.openedTo },
            { name: "closedFrom", label: t("filterClosedFrom"), value: dateFilters.closedFrom },
            { name: "closedTo", label: t("filterClosedTo"), value: dateFilters.closedTo },
          ]}
          labels={{
            status: tWork("status"),
            allStatuses: tWork("allStatuses"),
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

        {view === "kanban" ? (
          <WorkItemKanbanBoard
            columns={tensionColumns}
            storageKey={`work-items:${workspaceId}:tensions`}
            visibleColumnIds={visibleTensionColumnIds}
            hideColumnHrefs={tensionColumnHideHrefs}
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
            columns={tensionTableColumns}
            rows={displayTensions.map((tension) => tensionTableRow(tension))}
            empty={renderEmptyTensionState()}
          />
        ) : (
          <div>
            {(!displayTensions || displayTensions.length === 0) && (
              renderEmptyTensionState()
            )}
            {displayTensions.map((tension) => renderTensionCard(tension))}
          </div>
        )}
      </section>
    </>
  );
}
