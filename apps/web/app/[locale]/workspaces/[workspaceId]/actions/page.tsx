import { listActions, listCircles, listMembers, listProposals, requireWorkspaceMembership } from "@corgtex/domain";
import { prisma } from "@corgtex/shared";
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
  groupActionsByStatus,
  normalizeActionStatusFilter,
} from "./view-model";
import { MarkdownEditor } from "@/lib/components/MarkdownEditor";
import { MarkdownExcerpt } from "@/lib/components/MarkdownRenderer";
import { ItemActions } from "@/lib/components/ui/ItemActions";
import { WorkItemFilterControls, WorkItemViewToggle } from "@/lib/components/WorkItemControls";
import { WorkItemResolutionDialog } from "@/lib/components/WorkItemResolutionDialog";
import { canOpenPrivateDraft } from "@/lib/governance-open-guards";
import {
  buildWorkItemQuery,
  normalizeDateOnly,
  normalizeWorkItemView,
  resolveWorkItemScope,
  startOfUtcDate,
  endOfUtcDate,
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
  const { scope, circleId, memberId } = resolveWorkItemScope(resolvedSearch);
  const dateValues = {
    createdFrom: normalizeDateOnly(resolvedSearch.createdFrom),
    createdTo: normalizeDateOnly(resolvedSearch.createdTo),
    dueFrom: normalizeDateOnly(resolvedSearch.dueFrom),
    dueTo: normalizeDateOnly(resolvedSearch.dueTo),
  };
  const [{ items: actions }, { items: proposals }, circles, members] = await Promise.all([
    listActions(actor, workspaceId, {
      take: 200,
      circleId,
      memberId,
      createdFrom: dateValues.createdFrom ? startOfUtcDate(dateValues.createdFrom) : undefined,
      createdTo: dateValues.createdTo ? endOfUtcDate(dateValues.createdTo) : undefined,
      dueFrom: dateValues.dueFrom ? startOfUtcDate(dateValues.dueFrom) : undefined,
      dueTo: dateValues.dueTo ? endOfUtcDate(dateValues.dueTo) : undefined,
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
  const filterState = { view, scope, circleId, memberId, dates: dateValues };
  type ActionListItem = (typeof actions)[number];

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

  function renderActionCard(action: ActionListItem, compact = false) {
    const statusMeta = ACTION_STATUS_META[action.status as keyof typeof ACTION_STATUS_META] ?? ACTION_STATUS_META.OPEN;
    const authorName = action.author?.displayName || action.author?.email || "Unknown";
    const assigneeName = action.assigneeMember?.user?.displayName || action.assigneeMember?.user?.email;
    const createdAge = ageText(action.createdAt);
    const dueDate = action.dueAt ? new Date(action.dueAt).toLocaleDateString() : null;
    const canManage = canManageAction(action);
    const canSubmittedAuthorEdit = actor.kind === "user" && action.authorUserId === actor.user.id;
    const canEditContent = action.status === "DRAFT"
      ? canManage
      : (action.status === "OPEN" || action.status === "IN_PROGRESS") && canSubmittedAuthorEdit;
    const evidence = evidenceByActionId.get(action.id) ?? [];

    const completeDialog = (
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
        className="primary small"
      />
    );

    let primary: React.ReactNode = null;
    if (canManage && canOpenPrivateDraft(action)) {
      primary = (
        <form action={publishActionAction}>
          <input type="hidden" name="workspaceId" value={workspaceId} />
          <input type="hidden" name="actionId" value={action.id} />
          <button type="submit" className="primary small">{t("btnOpen")}</button>
        </form>
      );
    } else if (action.status === "OPEN") {
      primary = (
        <form action={updateActionAction}>
          <input type="hidden" name="workspaceId" value={workspaceId} />
          <input type="hidden" name="actionId" value={action.id} />
          <input type="hidden" name="status" value="IN_PROGRESS" />
          <button type="submit" className="primary small">{t("btnStart")}</button>
        </form>
      );
    } else if (action.status === "IN_PROGRESS") {
      primary = completeDialog;
    }

    const moreItems: React.ReactNode[] = [];
    if (action.status === "OPEN") {
      moreItems.push(
        <WorkItemResolutionDialog
          key="complete"
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
        />,
      );
    }
    if (canManage && (action.status === "OPEN" || action.status === "IN_PROGRESS")) {
      moreItems.push(
        <form key="return-to-draft" action={returnActionToDraftAction}>
          <input type="hidden" name="workspaceId" value={workspaceId} />
          <input type="hidden" name="actionId" value={action.id} />
          <button type="submit">{t("btnReturnToDraft")}</button>
        </form>,
      );
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
      <div className={compact ? "nr-kanban-card" : "nr-item"} key={action.id}>
        <div className="row" style={{ alignItems: "center" }}>
          <strong className="nr-item-title">
            {action.status === "DRAFT" && <span title={t("statusDraft")} style={{ marginRight: 6 }}>◆</span>}
            {action.title}
          </strong>
          <span className={`tag ${statusMeta.tagClass}`}>{t(statusMeta.labelKey)}</span>
        </div>
        {action.bodyMd && <MarkdownExcerpt markdown={action.bodyMd} maxLength={compact ? 120 : 220} as="div" className="nr-excerpt" />}
        <div className="nr-item-meta" style={{ marginTop: 8 }}>
          {t("metaCreator", { name: authorName })}
          {createdAge ? ` · ${createdAge}` : ""}
          {assigneeName ? ` · ${t("metaAssignee", { name: assigneeName })}` : ""}
          {action.circle ? ` · ${action.circle.name}` : ""}
          {dueDate ? ` · ${t("metaDue", { date: dueDate })}` : ""}
          {action.proposal?.title ? ` · ${t("metaLinkedToProposal", { title: action.proposal.title })}` : ""}
          {" · "}
          {action.version > 1 ? (
            <a href={`/workspaces/${workspaceId}/versions?entityType=ACTION&entityId=${encodeURIComponent(action.id)}`}>v{action.version}</a>
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
              <a key={row.id} href={`/workspaces/${workspaceId}/brain/sources`}>
                {row.document.title}
              </a>
            ))}
          </div>
        )}
        <ItemActions
          moreLabel={tCommon("moreActions")}
          primary={primary}
          more={moreItems.length > 0 ? moreItems : null}
        />
      </div>
    );
  }

  return (
    <>
      <header className="nr-masthead" style={{ textAlign: "left", marginBottom: 32 }}>
        <h1 style={{ border: "none", padding: 0, margin: 0, fontSize: "2rem" }}>{t("pageTitle")}</h1>
        <div className="nr-masthead-meta">
          <span>{t("pageDescription")}</span>
        </div>
      </header>

      <section className="ws-section">
        <WorkItemViewToggle
          currentView={view}
          listHref={buildWorkItemQuery({ ...filterState, status: statusFilter, view: "list" })}
          kanbanHref={buildWorkItemQuery({ ...filterState, status: statusFilter, view: "kanban" })}
          listLabel={tWork("listView")}
          kanbanLabel={tWork("kanbanView")}
          label={tWork("viewMode")}
        />
        <div className="nr-filter-bar nr-filter-bar-wrap">
          {ACTION_STATUS_FILTERS.map((s) => (
            <a
              key={s}
              href={buildWorkItemQuery({ ...filterState, status: s })}
              className={`nr-filter-item ${statusFilter === s ? "nr-filter-active" : ""}`}
            >
              {t(ACTION_STATUS_META[s].labelKey)} ({groupedActions[s].length})
            </a>
          ))}
        </div>

        <WorkItemFilterControls
          action={`/workspaces/${workspaceId}/actions`}
          status={statusFilter}
          view={view}
          scope={scope}
          circleId={circleId}
          memberId={memberId}
          circles={circles.map((circle) => ({ id: circle.id, label: circle.name }))}
          members={members.map((member) => ({ id: member.id, label: memberName(member) }))}
          dates={[
            { name: "createdFrom", label: tWork("createdFrom"), value: dateValues.createdFrom },
            { name: "createdTo", label: tWork("createdTo"), value: dateValues.createdTo },
            { name: "dueFrom", label: tWork("dueFrom"), value: dateValues.dueFrom },
            { name: "dueTo", label: tWork("dueTo"), value: dateValues.dueTo },
          ]}
          labels={{
            scope: tWork("scope"),
            company: tWork("companyScope"),
            circle: tWork("circle"),
            person: tWork("person"),
            allCircles: tWork("allCircles"),
            allPeople: tWork("allPeople"),
            apply: tWork("applyFilters"),
            clear: tWork("clearFilters"),
          }}
        />

        {view === "kanban" ? (
          <div className="nr-kanban">
            {(["DRAFT", "OPEN", "IN_PROGRESS", "COMPLETED"] as const).map((status) => (
              <section className="nr-kanban-column" key={status}>
                <div className="nr-kanban-heading">
                  <span>{t(ACTION_STATUS_META[status].labelKey)}</span>
                  <span>{groupedActions[status].length}</span>
                </div>
                {groupedActions[status].length === 0 && <p className="muted">{t("noActionsFound")}</p>}
                {groupedActions[status].map((action) => renderActionCard(action, true))}
              </section>
            ))}
          </div>
        ) : (
          <div>
            {displayActions.length === 0 && <p className="muted">{t("noActionsFound")}</p>}
            {displayActions.map((action) => renderActionCard(action))}
          </div>
        )}
      </section>

      <section className="ws-section">
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
