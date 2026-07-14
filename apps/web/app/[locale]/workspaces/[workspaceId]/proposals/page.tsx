import { listAdviceRequests, listCircles, listHumanMembers, listProposals, requireWorkspaceMembership } from "@corgtex/domain";
import type { ReactNode } from "react";
import { requirePageActor } from "@/lib/auth";
import { MarkdownExcerpt } from "@/lib/components/MarkdownRenderer";
import { WorkItemFilterControls, WorkItemToolbar } from "@/lib/components/WorkItemControls";
import { WorkItemKanbanBoard, type WorkItemKanbanColumn } from "@/lib/components/WorkItemKanbanBoard";
import { WorkItemResolutionDialog } from "@/lib/components/WorkItemResolutionDialog";
import { WorkItemTable, type WorkItemTableColumn, type WorkItemTableRow } from "@/lib/components/WorkItemTable";
import { formatWorkItemPriority, type WorkItemPriorityLabels } from "@/lib/work-item-priority";
import {
  buildWorkItemQuery,
  normalizeVisibleWorkItemColumns,
  normalizeWorkItemView,
  resolveWorkItemFilters,
  toggleWorkItemColumnVisibility,
} from "@/lib/work-item-view";
import { CreateProposalForm } from "./CreateProposalForm";
import { ProposalDraftFields } from "./ProposalDraftFields";
import {
  archiveProposalAction,
  resolveProposalAction,
  reopenProposalAction,
  submitProposalAction,
  returnProposalToDraftAction,
  updateProposalAction,
} from "../actions";
import { ItemActions } from "@/lib/components/ui/ItemActions";
import { getTranslations } from "next-intl/server";
import { prisma } from "@corgtex/shared";
import {
  PROPOSAL_COLUMN_STATUSES,
  PROPOSAL_STATUS_FILTERS,
  type ProposalColumnStatus,
  type ProposalStatusFilter,
  type ProposalStatusQuery,
  resolveProposalStatusSearch,
} from "./view-model";

export const dynamic = "force-dynamic";

export default async function ProposalsPage({
  params,
  searchParams,
}: {
  params: Promise<{ workspaceId: string }>;
  searchParams?: Promise<Record<string, string | string[] | undefined>>;
}) {
  const { workspaceId } = await params;
  const actor = await requirePageActor();
  const t = await getTranslations("proposals");
  const tCommon = await getTranslations("common");
  const tWork = await getTranslations("workItems");
  const resolvedSearch = searchParams ? await searchParams : {};
  const view = normalizeWorkItemView(resolvedSearch.view);
  const { statusFilters, statusQuery } = resolveProposalStatusSearch(
    resolvedSearch.status,
    view === "kanban" ? null : "OPEN",
  );
  const { circleIds, memberIds, sort } = resolveWorkItemFilters(resolvedSearch);
  const membership = await requireWorkspaceMembership({ actor, workspaceId });

  const [{ items: proposals }, currentWorkspace, circles, members, activeAdviceRequests] = await Promise.all([
    listProposals(actor, workspaceId, { take: 200, circleIds, memberIds, sort }),
    prisma.workspace.findUnique({ where: { id: workspaceId }, select: { slug: true } }),
    listCircles(workspaceId),
    listHumanMembers(workspaceId),
    listAdviceRequests(actor, { workspaceId, subjectType: "PROPOSAL", status: "ACTIVE", take: 500 }),
  ]);
  const isDemo = currentWorkspace?.slug === "jnj-demo";
  const canManageProposal = (proposal: { authorUserId: string }) => actor.kind === "agent"
    || membership?.role === "ADMIN"
    || (actor.kind === "user" && proposal.authorUserId === actor.user.id);
  const canResolveProposal = actor.kind === "agent" || Boolean(membership);
  const priorityLabels = {
    3: tWork("priorityUrgent"),
    2: tWork("priorityImportant"),
    1: tWork("priorityMedium"),
    0: tWork("priorityLow"),
  } satisfies WorkItemPriorityLabels;
  const priorityText = (priority: number | null | undefined) => formatWorkItemPriority(priority, priorityLabels);
  const activeProposals = proposals.filter((proposal) => !proposal.archivedAt);

  const groupedProposals = {
    DRAFT: activeProposals.filter((p) => p.status === "DRAFT"),
    OPEN: activeProposals.filter((p) => p.status === "OPEN" && !p.isPrivate),
    RESOLVED: activeProposals.filter((p) => p.status === "RESOLVED" && !p.isPrivate),
    ARCHIVED: proposals.filter((p) => Boolean(p.archivedAt)),
    ALL: proposals,
  };

  const displayProposals = statusFilters.length === 0
    ? proposals
    : statusFilters.flatMap((filter) => groupedProposals[filter]);
  const activeAdviceRequestCounts = activeAdviceRequests.reduce((counts, request) => {
    const proposalId = request.process.subjectId;
    counts.set(proposalId, (counts.get(proposalId) ?? 0) + 1);
    return counts;
  }, new Map<string, number>());
  type ProposalListItem = (typeof proposals)[number];
  type ProposalMoveStatus = "DRAFT" | "OPEN" | "RESOLVED";
  const proposalMoveStatuses: ProposalMoveStatus[] = ["DRAFT", "OPEN", "RESOLVED"];
  const visibleProposalColumnIds = normalizeVisibleWorkItemColumns(resolvedSearch.columns, PROPOSAL_COLUMN_STATUSES);
  const allProposalColumnsVisible = visibleProposalColumnIds.length === PROPOSAL_COLUMN_STATUSES.length;
  const buildProposalColumnHref = (status: ProposalColumnStatus, queryStatus: ProposalStatusQuery = statusQuery) => buildWorkItemQuery({
    view: "kanban",
    status: queryStatus,
    circleIds,
    memberIds,
    columns: toggleWorkItemColumnVisibility(visibleProposalColumnIds, status, PROPOSAL_COLUMN_STATUSES),
  });
  const proposalColumnHideHrefs = Object.fromEntries(
    PROPOSAL_COLUMN_STATUSES.map((status) => [status, buildProposalColumnHref(status)]),
  );
  const proposalFilterHref = (status: ProposalStatusFilter) => view === "kanban"
    ? status === "ALL"
      ? buildWorkItemQuery({ view: "kanban", status: "ALL", circleIds, memberIds })
      : buildProposalColumnHref(status)
    : buildWorkItemQuery({ view, sort, circleIds, memberIds, status });
  const proposalFilterActive = (status: ProposalStatusFilter) => view === "kanban"
    ? status === "ALL"
      ? allProposalColumnsVisible
      : visibleProposalColumnIds.includes(status)
    : status === "ALL"
      ? statusFilters.length === 0
      : statusFilters.includes(status);

  function proposalStatusLabel(status: ProposalStatusFilter) {
    if (status === "DRAFT") return t("statusDraft");
    if (status === "OPEN") return t("statusOpen");
    if (status === "RESOLVED") return t("statusResolved");
    if (status === "ALL") return tWork("statusAll");
    return t("statusArchived");
  }

  function proposalMoveLabel(status: ProposalMoveStatus) {
    if (status === "DRAFT") return t("btnReturnToDraft");
    if (status === "OPEN") return t("btnOpen");
    return t("btnResolve");
  }

  function renderProposalMove(proposal: ProposalListItem, targetStatus: ProposalMoveStatus, options: { hidden?: boolean; primary?: boolean } = {}) {
    const key = `${options.hidden ? "hidden-" : ""}move-${targetStatus.toLowerCase()}`;
    const transition = `${proposal.id}:${targetStatus}`;
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
            action={resolveProposalAction}
            buttonLabel={t("btnResolve")}
            title={tWork("resolveProposalTitle")}
            noteName="decisionMd"
            noteLabel={tWork("resolutionNote")}
            notePlaceholder={t("placeholderDecisionMd")}
            hiddenFields={{ workspaceId, proposalId: proposal.id }}
            outcomeName="outcome"
            outcomeLabel={t("formResolutionOutcome")}
            outcomeOptions={[
              { value: "ADOPTED", label: t("outcomeAdopted") },
              { value: "NOT_ADOPTED", label: t("outcomeNotAdopted") },
              { value: "WITHDRAWN", label: t("outcomeWithdrawn") },
            ]}
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
          action={returnProposalToDraftAction}
          data-work-item-transition={transition}
          className={options.hidden ? "nr-hidden-transition-form" : undefined}
        >
          <input type="hidden" name="workspaceId" value={workspaceId} />
          <input type="hidden" name="proposalId" value={proposal.id} />
          <button type="submit" className={buttonClass} {...buttonProps}>{proposalMoveLabel(targetStatus)}</button>
        </form>
      );
    }

    const actionHandler = proposal.status === "DRAFT" ? submitProposalAction : reopenProposalAction;
    return (
      <form
        key={key}
        action={actionHandler}
        data-work-item-transition={transition}
        className={options.hidden ? "nr-hidden-transition-form" : undefined}
      >
        <input type="hidden" name="workspaceId" value={workspaceId} />
        <input type="hidden" name="proposalId" value={proposal.id} />
        <button type="submit" className={buttonClass} {...buttonProps}>{proposalMoveLabel(targetStatus)}</button>
      </form>
    );
  }

  function proposalControls(proposal: ProposalListItem) {
    const isAuthor = actor.kind === "user" && proposal.authorUserId === actor.user.id;
    const canManage = canManageProposal(proposal);
    const canEditContent = proposal.status === "DRAFT" ? canManage : proposal.status === "OPEN" && isAuthor;
    const moreItems: ReactNode[] = [];
    const primaryMoveTarget: ProposalMoveStatus | null = canManage && proposal.status === "DRAFT"
      ? "OPEN"
      : canResolveProposal && proposal.status === "OPEN"
        ? "RESOLVED"
        : null;
    const canMoveToStatus = (targetStatus: ProposalMoveStatus) => {
      if (proposal.archivedAt || targetStatus === proposal.status) return false;
      if (proposal.status === "DRAFT" || targetStatus === "DRAFT") return canManage;
      if (targetStatus === "RESOLVED" || targetStatus === "OPEN") return canResolveProposal;
      return true;
    };
    const hiddenTransitions = proposalMoveStatuses
      .filter((targetStatus) => canMoveToStatus(targetStatus) && targetStatus !== primaryMoveTarget)
      .map((targetStatus) => renderProposalMove(proposal, targetStatus, { hidden: true }));
    for (const targetStatus of proposalMoveStatuses) {
      if (!canMoveToStatus(targetStatus) || targetStatus === primaryMoveTarget) continue;
      moreItems.push(renderProposalMove(proposal, targetStatus));
    }
    if (canEditContent) {
      moreItems.push(
        <details key="edit">
          <summary className="nr-hide-marker nr-action-summary">
            {t("btnEdit")}
          </summary>
          <form action={updateProposalAction} className="action-menu-form">
            <input type="hidden" name="workspaceId" value={workspaceId} />
            <input type="hidden" name="proposalId" value={proposal.id} />
            <ProposalDraftFields defaultTitle={proposal.title} defaultBodyMd={proposal.bodyMd} defaultPriority={proposal.priority} />
            <button type="submit" className="secondary small">{proposal.status === "DRAFT" ? t("btnSaveDraft") : tCommon("save")}</button>
          </form>
        </details>,
      );
    }
    if (canManage && !proposal.archivedAt && (proposal.status === "DRAFT" || proposal.status === "RESOLVED")) {
      moreItems.push(<div key="divider" className="action-menu-divider" />);
      moreItems.push(
        <form key="archive" action={archiveProposalAction}>
          <input type="hidden" name="workspaceId" value={workspaceId} />
          <input type="hidden" name="proposalId" value={proposal.id} />
          <button type="submit" className="danger">{t("btnArchive")}</button>
        </form>,
      );
    }

    const primaryAction = primaryMoveTarget ? renderProposalMove(proposal, primaryMoveTarget, { primary: true }) : null;

    return { hiddenTransitions, moreItems, primaryAction };
  }

  function renderProposalCard(proposal: ProposalListItem, compact = false) {
    const detailHref = `/workspaces/${workspaceId}/proposals/${proposal.id}`;
    const { hiddenTransitions, moreItems, primaryAction } = proposalControls(proposal);
    const adviceRequestCount = activeAdviceRequestCounts.get(proposal.id) ?? 0;

    return (
      <div className={`${compact ? "nr-kanban-card" : "nr-item nr-list-card"} nr-clickable-card`} key={proposal.id}>
        <a href={detailHref} className="nr-card-hitbox" aria-label={tWork("openItem", { title: proposal.title })} draggable={false} />
        <div className="nr-list-link nr-card-content">
          <div className="row items-center">
            <strong className="nr-item-title">
              {!compact && proposal.status === "DRAFT" && <span title={t("privateDraftTooltip")} className="tag info mr-1">{t("statusDraft")}</span>}
              {proposal.title}
            </strong>
            {!compact && (
              <span className={`tag ${proposal.status === "DRAFT" ? "info" : proposal.status === "OPEN" ? "warning" : proposal.resolutionOutcome === "ADOPTED" ? "success" : proposal.status === "RESOLVED" ? "info" : ""}`}>
                {proposal.status === "RESOLVED" && proposal.resolutionOutcome ? `${proposal.status} · ${proposal.resolutionOutcome.replace("_", " ")}` : proposal.status}
              </span>
            )}
            {adviceRequestCount > 0 && (
              <span className="tag warning">{t("adviceRequestedCount", { count: adviceRequestCount })}</span>
            )}
          </div>
          <MarkdownExcerpt markdown={proposal.summary ?? proposal.bodyMd} maxLength={compact ? 120 : 180} as="div" className="nr-excerpt" />
          <div className="nr-item-meta mt-2">
            {proposal.author.displayName || proposal.author.email} · {new Date(proposal.createdAt).toLocaleDateString()} · {priorityText(proposal.priority)}
            {proposal.circle ? ` · ${proposal.circle.name}` : ""}
            {" · "}
            {proposal.version > 1 ? (
              <a href={`/workspaces/${workspaceId}/versions?entityType=PROPOSAL&entityId=${encodeURIComponent(proposal.id)}`} draggable={false}>v{proposal.version}</a>
            ) : (
              <>v{proposal.version}</>
            )}
          </div>
          {(proposal.tensions?.length > 0 || proposal.actions?.length > 0) && (
            <div className="nr-tag-group">
              {proposal.tensions?.map((linkedTension) => (
                <a key={linkedTension.id} href={`/workspaces/${workspaceId}/tensions/${linkedTension.id}`} className="tag info tag-sm no-underline" draggable={false}>
                  {t("tensionTag", { title: linkedTension.title })}
                </a>
              ))}
              {proposal.actions?.map((action) => (
                <a key={action.id} href={`/workspaces/${workspaceId}/actions/${action.id}`} className="tag info tag-sm no-underline" draggable={false}>
                  {t("actionTag", { title: action.title })}
                </a>
              ))}
            </div>
          )}
        </div>
        {!isDemo && (
          <ItemActions
            moreLabel={tCommon("moreActions")}
            primary={primaryAction}
            more={moreItems.length > 0 ? moreItems : null}
          />
        )}
        {!isDemo && hiddenTransitions.length > 0 && (
          <div className="nr-transition-controls">
            {hiddenTransitions}
          </div>
        )}
      </div>
    );
  }

  function renderEmptyProposalState() {
    return (
      <div className="nr-item nr-empty-state">
        <h3 className="nr-empty-title">{t("whatIsProposalTitle")}</h3>
        <p className="muted nr-empty-desc">
          {t("whatIsProposalDesc")}
        </p>
      </div>
    );
  }

  const proposalTableColumns: WorkItemTableColumn[] = [
    { id: "item", label: tWork("tableItem"), cellClassName: "nr-work-item-table-main" },
    { id: "status", label: tWork("tableStatus") },
    { id: "owner", label: tWork("tableOwner") },
    { id: "created", label: tWork("tableCreated") },
    { id: "priority", label: t("formPriority"), align: "right" },
    { id: "links", label: tWork("tableLinks") },
    { id: "actions", label: tWork("tableActions"), cellClassName: "nr-work-item-table-actions" },
  ];

  function proposalTableRow(proposal: ProposalListItem): WorkItemTableRow {
    const detailHref = `/workspaces/${workspaceId}/proposals/${proposal.id}`;
    const { hiddenTransitions, moreItems, primaryAction } = proposalControls(proposal);
    const adviceRequestCount = activeAdviceRequestCounts.get(proposal.id) ?? 0;
    const statusText = proposal.status === "RESOLVED" && proposal.resolutionOutcome
      ? `${proposalStatusLabel("RESOLVED")} · ${proposal.resolutionOutcome.replace("_", " ")}`
      : proposalStatusLabel(proposal.archivedAt ? "ARCHIVED" : proposal.status as ProposalColumnStatus);

    return {
      id: proposal.id,
      cells: {
        item: (
          <>
            <a href={detailHref} className="nr-work-item-table-title">
              {proposal.status === "DRAFT" && <span title={t("privateDraftTooltip")} style={{ marginRight: 6 }}>◆</span>}
              {proposal.title}
            </a>
            <MarkdownExcerpt markdown={proposal.summary ?? proposal.bodyMd} maxLength={140} as="div" className="nr-work-item-table-meta" />
          </>
        ),
        status: (
          <span className={`tag ${proposal.status === "DRAFT" ? "info" : proposal.status === "OPEN" ? "warning" : proposal.resolutionOutcome === "ADOPTED" ? "success" : proposal.status === "RESOLVED" ? "info" : ""}`}>
            {statusText}
          </span>
        ),
        owner: (
          <div className="nr-work-item-table-meta">
            <div>{proposal.author.displayName || proposal.author.email}</div>
            {proposal.circle && <div>{proposal.circle.name}</div>}
          </div>
        ),
        created: <span className="nr-work-item-table-meta">{new Date(proposal.createdAt).toLocaleDateString()}</span>,
        priority: priorityText(proposal.priority),
        links: (
          <div className="nr-work-item-table-meta nr-work-item-table-tags">
            {proposal.version > 1 ? (
              <a href={`/workspaces/${workspaceId}/versions?entityType=PROPOSAL&entityId=${encodeURIComponent(proposal.id)}`}>v{proposal.version}</a>
            ) : (
              <span>v{proposal.version}</span>
            )}
            {proposal.tensions?.map((linkedTension) => (
              <a key={linkedTension.id} href={`/workspaces/${workspaceId}/tensions/${linkedTension.id}`} className="tag info tag-sm no-underline">
                {t("tensionTag", { title: linkedTension.title })}
              </a>
            ))}
            {proposal.actions?.map((action) => (
              <a key={action.id} href={`/workspaces/${workspaceId}/actions/${action.id}`} className="tag info tag-sm no-underline">
                {t("actionTag", { title: action.title })}
              </a>
            ))}
            {adviceRequestCount > 0 && (
              <span className="tag warning">{t("adviceRequestedCount", { count: adviceRequestCount })}</span>
            )}
          </div>
        ),
        actions: !isDemo ? (
          <>
            <ItemActions
              moreLabel={tCommon("moreActions")}
              primary={primaryAction}
              more={moreItems.length > 0 ? moreItems : null}
            />
            {hiddenTransitions.length > 0 && (
              <div className="nr-transition-controls">
                {hiddenTransitions}
              </div>
            )}
          </>
        ) : null,
      },
    };
  }

  function proposalAddCard() {
    if (isDemo) return null;
    return (
      <details className="nr-kanban-add-card">
        <summary className="nr-hide-marker nr-kanban-add-trigger">
          {tWork("newDraftCard")}
        </summary>
        <CreateProposalForm workspaceId={workspaceId} compact />
      </details>
    );
  }

  const proposalColumns: WorkItemKanbanColumn[] = PROPOSAL_COLUMN_STATUSES.map((status) => ({
    id: status,
    label: proposalStatusLabel(status),
    count: groupedProposals[status].length,
    empty: <p className="muted">{t("whatIsProposalDesc")}</p>,
    addCard: status === "DRAFT" ? proposalAddCard() : null,
    items: groupedProposals[status].map((proposal) => ({
      id: proposal.id,
      status,
      sort: {
        priority: proposal.priority,
        date: proposal.createdAt,
        alpha: proposal.title,
      },
      node: renderProposalCard(proposal, true),
    })),
  }));

  return (
    <>
      <header className="nr-masthead nr-masthead-left">
        <h1 className="nr-masthead-title">{t("pageTitle")}</h1>
        <div className="nr-masthead-meta">
          <span>{t("pageDescription")}</span>
        </div>
      </header>

      <section className="ws-section">
        <div className="nr-work-board-header">
          <div className="nr-filter-bar">
            {PROPOSAL_STATUS_FILTERS.map((status) => (
              <a
                key={status}
                href={proposalFilterHref(status)}
                className={`nr-filter-item ${proposalFilterActive(status) ? "nr-filter-active" : ""}`}
              >
                {proposalStatusLabel(status)} ({groupedProposals[status].length})
              </a>
            ))}
          </div>
          <WorkItemToolbar
            currentView={view}
            currentSort={sort}
            listHref={buildWorkItemQuery({ sort, circleIds, memberIds, status: statusQuery, view: "list" })}
            kanbanHref={buildWorkItemQuery({ circleIds, memberIds, view: "kanban" })}
            tableHref={buildWorkItemQuery({ sort, circleIds, memberIds, status: statusQuery, view: "table" })}
            sortLinks={{
              priority: buildWorkItemQuery({ view: view === "table" ? "table" : "list", circleIds, memberIds, status: statusQuery, sort: "priority" }),
              date: buildWorkItemQuery({ view: view === "table" ? "table" : "list", circleIds, memberIds, status: statusQuery, sort: "date" }),
              alpha: buildWorkItemQuery({ view: view === "table" ? "table" : "list", circleIds, memberIds, status: statusQuery, sort: "alpha" }),
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
          action={`/workspaces/${workspaceId}/proposals`}
          view={view}
          sort={view !== "kanban" ? sort : undefined}
          columns={view === "kanban" && !allProposalColumnsVisible ? visibleProposalColumnIds : undefined}
          statusOptions={PROPOSAL_STATUS_FILTERS.map((filter) => ({ id: filter, label: proposalStatusLabel(filter) }))}
          statusValues={statusFilters}
          circleIds={circleIds}
          memberIds={memberIds}
          circles={circles.map((circle) => ({ id: circle.id, label: circle.name }))}
          members={members.map((member) => ({ id: member.id, label: member.user.displayName || member.user.email }))}
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
            columns={proposalColumns}
            storageKey={`work-items:${workspaceId}:proposals`}
            visibleColumnIds={visibleProposalColumnIds}
            hideColumnHrefs={proposalColumnHideHrefs}
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
            columns={proposalTableColumns}
            rows={displayProposals.map((proposal) => proposalTableRow(proposal))}
            empty={renderEmptyProposalState()}
          />
        ) : (
          <div>
            {(!displayProposals || displayProposals.length === 0) && (
              renderEmptyProposalState()
            )}
            {displayProposals.map((proposal) => renderProposalCard(proposal))}
          </div>
        )}
      </section>
    </>
  );
}
