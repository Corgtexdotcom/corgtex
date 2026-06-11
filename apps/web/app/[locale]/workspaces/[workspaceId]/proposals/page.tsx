import { listCircles, listMembers, listProposals, requireWorkspaceMembership } from "@corgtex/domain";
import type { ReactNode } from "react";
import { requirePageActor } from "@/lib/auth";
import { MarkdownExcerpt } from "@/lib/components/MarkdownRenderer";
import { WorkItemFilterControls, WorkItemToolbar } from "@/lib/components/WorkItemControls";
import { WorkItemKanbanBoard, type WorkItemKanbanColumn } from "@/lib/components/WorkItemKanbanBoard";
import { WorkItemResolutionDialog } from "@/lib/components/WorkItemResolutionDialog";
import { buildWorkItemQuery, normalizeWorkItemView, resolveWorkItemFilters } from "@/lib/work-item-view";
import { CreateProposalForm } from "./CreateProposalForm";
import { ProposalDraftFields } from "./ProposalDraftFields";
import {
  archiveProposalAction,
  resolveProposalAction,
  submitProposalAction,
  returnProposalToDraftAction,
  updateProposalAction,
} from "../actions";
import { ItemActions } from "@/lib/components/ui/ItemActions";
import { canOpenPrivateDraft } from "@/lib/governance-open-guards";
import { getTranslations } from "next-intl/server";
import { prisma } from "@corgtex/shared";

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
  const statusFilter = typeof resolvedSearch.status === "string" ? resolvedSearch.status : "OPEN";
  const view = normalizeWorkItemView(resolvedSearch.view);
  const { circleId, memberId, sort } = resolveWorkItemFilters(resolvedSearch);
  const membership = await requireWorkspaceMembership({ actor, workspaceId });

  const [{ items: proposals }, currentWorkspace, circles, members] = await Promise.all([
    listProposals(actor, workspaceId, { take: 200, circleId, memberId, sort }),
    prisma.workspace.findUnique({ where: { id: workspaceId }, select: { slug: true } }),
    listCircles(workspaceId),
    listMembers(workspaceId),
  ]);
  const isDemo = currentWorkspace?.slug === "jnj-demo";
  const canManageProposal = (proposal: { authorUserId: string }) => actor.kind === "agent"
    || membership?.role === "ADMIN"
    || (actor.kind === "user" && proposal.authorUserId === actor.user.id);
  const canResolveProposal = actor.kind === "agent" || Boolean(membership);
  const activeProposals = proposals.filter((proposal) => !proposal.archivedAt);

  const groupedProposals = {
    DRAFT: activeProposals.filter((p) => p.status === "DRAFT"),
    OPEN: activeProposals.filter((p) => p.status === "OPEN" && !p.isPrivate),
    RESOLVED: activeProposals.filter((p) => p.status === "RESOLVED" && !p.isPrivate),
    ARCHIVED: proposals.filter((p) => Boolean(p.archivedAt)),
  };

  const displayProposals = groupedProposals[statusFilter as keyof typeof groupedProposals] || groupedProposals.OPEN;
  const filterState = { view, sort, circleId, memberId };
  const columnSettingsPortalId = "work-item-proposals-column-settings";
  type ProposalListItem = (typeof proposals)[number];
  type ProposalColumnStatus = "DRAFT" | "OPEN" | "RESOLVED" | "ARCHIVED";

  function proposalStatusLabel(status: "DRAFT" | "OPEN" | "RESOLVED" | "ARCHIVED") {
    if (status === "DRAFT") return t("statusDraft");
    if (status === "OPEN") return t("statusOpen");
    if (status === "RESOLVED") return t("statusResolved");
    return t("statusArchived");
  }

  function renderProposalCard(proposal: ProposalListItem, compact = false) {
    const detailHref = `/workspaces/${workspaceId}/proposals/${proposal.id}`;
    const isAuthor = actor.kind === "user" && proposal.authorUserId === actor.user.id;
    const canManage = canManageProposal(proposal);
    const canEditContent = proposal.status === "DRAFT" ? canManage : proposal.status === "OPEN" && isAuthor;
    const moreItems: ReactNode[] = [];
    if (canManage && proposal.status === "OPEN") {
      moreItems.push(
        <form key="return-to-draft" action={returnProposalToDraftAction}>
          <input type="hidden" name="workspaceId" value={workspaceId} />
          <input type="hidden" name="proposalId" value={proposal.id} />
          <button type="submit">{t("btnReturnToDraft")}</button>
        </form>,
      );
      moreItems.push(
        <form key="return-to-draft-drag" action={returnProposalToDraftAction} data-work-item-transition={`${proposal.id}:DRAFT`} className="nr-hidden-transition-form">
          <input type="hidden" name="workspaceId" value={workspaceId} />
          <input type="hidden" name="proposalId" value={proposal.id} />
          <button type="submit" aria-hidden="true" tabIndex={-1}>{t("btnReturnToDraft")}</button>
        </form>,
      );
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
    if (canManage && (proposal.status === "DRAFT" || proposal.status === "RESOLVED")) {
      moreItems.push(<div key="divider" className="action-menu-divider" />);
      moreItems.push(
        <form key="archive" action={archiveProposalAction}>
          <input type="hidden" name="workspaceId" value={workspaceId} />
          <input type="hidden" name="proposalId" value={proposal.id} />
          <button type="submit" className="danger">{t("btnArchive")}</button>
        </form>,
      );
    }

    const primaryAction = canManage && canOpenPrivateDraft(proposal) ? (
      <form action={submitProposalAction} data-work-item-transition={`${proposal.id}:OPEN`}>
        <input type="hidden" name="workspaceId" value={workspaceId} />
        <input type="hidden" name="proposalId" value={proposal.id} />
        <button type="submit" className="primary small">{t("btnOpen")}</button>
      </form>
    ) : canResolveProposal && proposal.status === "OPEN" ? (
      <span data-work-item-dialog={`${proposal.id}:RESOLVED`}>
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
          className="primary small"
        />
      </span>
    ) : null;

    return (
      <div className={`${compact ? "nr-kanban-card" : "nr-item nr-list-card"} nr-clickable-card`} key={proposal.id}>
        <a href={detailHref} className="nr-card-hitbox" aria-label={tWork("openItem", { title: proposal.title })} />
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
          </div>
          <MarkdownExcerpt markdown={proposal.summary ?? proposal.bodyMd} maxLength={compact ? 120 : 180} as="div" className="nr-excerpt" />
          <div className="nr-item-meta mt-2">
            {proposal.author.displayName || proposal.author.email} · {new Date(proposal.createdAt).toLocaleDateString()} · {tWork("priorityN", { priority: proposal.priority })}
            {proposal.circle ? ` · ${proposal.circle.name}` : ""}
            {" · "}
            {proposal.version > 1 ? (
              <a href={`/workspaces/${workspaceId}/versions?entityType=PROPOSAL&entityId=${encodeURIComponent(proposal.id)}`}>v{proposal.version}</a>
            ) : (
              <>v{proposal.version}</>
            )}
          </div>
          {(proposal.tensions?.length > 0 || proposal.actions?.length > 0) && (
            <div className="nr-tag-group">
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
      </div>
    );
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

  const proposalColumns: WorkItemKanbanColumn[] = (["DRAFT", "OPEN", "RESOLVED", "ARCHIVED"] as const).map((status: ProposalColumnStatus) => ({
    id: status,
    label: proposalStatusLabel(status),
    count: groupedProposals[status].length,
    empty: <p className="muted">{t("whatIsProposalDesc")}</p>,
    addCard: status === "DRAFT" ? proposalAddCard() : null,
    items: groupedProposals[status].map((proposal) => ({
      id: proposal.id,
      status,
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
            {(["DRAFT", "OPEN", "RESOLVED", "ARCHIVED"] as const).map((status) => (
              <a
                key={status}
                href={buildWorkItemQuery({ ...filterState, status })}
                className={`nr-filter-item ${statusFilter === status ? "nr-filter-active" : ""}`}
              >
                {proposalStatusLabel(status)} ({groupedProposals[status].length})
              </a>
            ))}
          </div>
          <WorkItemToolbar
            currentView={view}
            currentSort={sort}
            listHref={buildWorkItemQuery({ ...filterState, status: statusFilter, view: "list" })}
            kanbanHref={buildWorkItemQuery({ ...filterState, status: statusFilter, view: "kanban" })}
            sortLinks={{
              priority: buildWorkItemQuery({ ...filterState, status: statusFilter, sort: "priority" }),
              date: buildWorkItemQuery({ ...filterState, status: statusFilter, sort: "date" }),
              alpha: buildWorkItemQuery({ ...filterState, status: statusFilter, sort: "alpha" }),
            }}
            listLabel={tWork("listView")}
            kanbanLabel={tWork("kanbanView")}
            sortLabel={tWork("sort")}
            sortPriorityLabel={tWork("sortPriority")}
            sortDateLabel={tWork("sortDate")}
            sortAlphaLabel={tWork("sortAlpha")}
            columnSettingsLabel={tWork("columnSettings")}
            columnSettingsPortalId={view === "kanban" ? columnSettingsPortalId : undefined}
            label={tWork("viewMode")}
          />
        </div>
        <WorkItemFilterControls
          action={`/workspaces/${workspaceId}/proposals`}
          status={statusFilter}
          view={view}
          sort={sort}
          circleId={circleId}
          memberId={memberId}
          circles={circles.map((circle) => ({ id: circle.id, label: circle.name }))}
          members={members.map((member) => ({ id: member.id, label: member.user.displayName || member.user.email }))}
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
            columns={proposalColumns}
            storageKey={`work-items:${workspaceId}:proposals`}
            settingsPortalId={columnSettingsPortalId}
            settingsLabel={tWork("columnSettings")}
            resetLabel={tWork("resetColumns")}
            hideLabel={tWork("hideColumn")}
            showLabel={tWork("showColumn")}
            moveUpLabel={tWork("moveColumnLeft")}
            moveDownLabel={tWork("moveColumnRight")}
            hideShortLabel={tWork("hideColumnShort")}
            showShortLabel={tWork("showColumnShort")}
            moveUpShortLabel={tWork("moveColumnLeftShort")}
            moveDownShortLabel={tWork("moveColumnRightShort")}
            dragUnavailableLabel={tWork("dragUnavailable")}
          />
        ) : (
          <div>
            {(!displayProposals || displayProposals.length === 0) && (
              <div className="nr-item nr-empty-state">
                <h3 className="nr-empty-title">{t("whatIsProposalTitle")}</h3>
                <p className="muted nr-empty-desc">
                  {t("whatIsProposalDesc")}
                </p>
              </div>
            )}
            {displayProposals.map((proposal) => renderProposalCard(proposal))}
          </div>
        )}
      </section>

      {!isDemo && (
        <section className={`ws-section ${view === "kanban" ? "nr-list-only-create" : ""}`}>
          <details open={resolvedSearch.open === "new"}>
            <summary className="nr-hide-marker nr-section-toggle">
              <span className="nr-section-header nr-section-header-inline">{t("newProposalTitle")}</span>
            </summary>
            <CreateProposalForm workspaceId={workspaceId} />
          </details>
        </section>
      )}
    </>
  );
}
