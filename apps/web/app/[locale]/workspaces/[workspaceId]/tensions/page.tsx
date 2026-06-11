import { listCircles, listMembers, listProposals, listTensions, requireWorkspaceMembership } from "@corgtex/domain";
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
import { WorkItemFilterControls, WorkItemViewToggle } from "@/lib/components/WorkItemControls";
import { WorkItemResolutionDialog } from "@/lib/components/WorkItemResolutionDialog";
import { canOpenPrivateDraft } from "@/lib/governance-open-guards";
import { buildWorkItemQuery, normalizeWorkItemView, resolveWorkItemScope } from "@/lib/work-item-view";
import { getTranslations } from "next-intl/server";
import {
  TENSION_STATUS_FILTERS,
  groupTensionsByStatus,
  resolveTensionSearch,
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
  const { statusFilter, dateValues, dateFilters } = resolveTensionSearch(resolvedSearch);
  const view = normalizeWorkItemView(resolvedSearch.view);
  const { scope, circleId, memberId } = resolveWorkItemScope(resolvedSearch);
  const [{ items: tensions }, { items: proposals }, circles, members] = await Promise.all([
    listTensions(actor, workspaceId, { take: 200, ...dateFilters, circleId, memberId }),
    listProposals(actor, workspaceId, { take: 50 }),
    listCircles(workspaceId),
    listMembers(workspaceId),
  ]);

  const activeProposals = proposals.filter((p) => p.status === "DRAFT" || p.status === "OPEN");
  const groupedTensions = groupTensionsByStatus(tensions);
  const displayTensions = statusFilter === "ALL"
    ? groupedTensions.ALL
    : groupedTensions[statusFilter as keyof typeof groupedTensions] || groupedTensions.OPEN;
  const filterState = { view, scope, circleId, memberId, dates: dateValues };
  type TensionListItem = (typeof tensions)[number];

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
  const canManageTension = (tension: { authorUserId: string }) => actor.kind === "agent"
    || membership?.role === "ADMIN"
    || (actor.kind === "user" && tension.authorUserId === actor.user.id);

  function renderTensionCard(tension: TensionListItem, compact = false) {
    const authorName = tension.author.displayName || tension.author.email || t("authorUnknown");
    const raisedByName = tension.raisedByMember ? memberName(tension.raisedByMember) : null;
    const canManage = canManageTension(tension);
    const canSubmittedAuthorEdit = actor.kind === "user" && tension.authorUserId === actor.user.id;
    const canEditContent = tension.status === "DRAFT" ? canManage : tension.status === "OPEN" && canSubmittedAuthorEdit;
    const canDraftProposal = !tension.proposal && (canManage || !tension.isPrivate);
    const openedDate = tension.publishedAt ? new Date(tension.publishedAt).toLocaleDateString() : null;
    const closedDate = tension.resolvedAt ? new Date(tension.resolvedAt).toLocaleDateString() : null;
    const primary = canManage && canOpenPrivateDraft(tension) ? (
      <form action={publishTensionAction}>
        <input type="hidden" name="workspaceId" value={workspaceId} />
        <input type="hidden" name="tensionId" value={tension.id} />
        <button type="submit" className="primary small">{t("btnOpen")}</button>
      </form>
    ) : !tension.isPrivate && tension.status === "OPEN" ? (
      <form action={upvoteTensionAction}>
        <input type="hidden" name="workspaceId" value={workspaceId} />
        <input type="hidden" name="tensionId" value={tension.id} />
        <button type="submit" className="primary small">{t("btnUpvote")}</button>
      </form>
    ) : null;
    const moreItems: React.ReactNode[] = [];

    if (!tension.isPrivate && tension.status === "OPEN") {
      moreItems.push(
        <WorkItemResolutionDialog
          key="resolve"
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
        />,
      );
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
    if (canManage && tension.status === "OPEN") {
      moreItems.push(
        <form key="return-to-draft" action={returnTensionToDraftAction}>
          <input type="hidden" name="workspaceId" value={workspaceId} />
          <input type="hidden" name="tensionId" value={tension.id} />
          <button type="submit">{t("btnReturnToDraft")}</button>
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
            {members.map((member) => (
              <option value={member.id} key={member.id}>{memberName(member)}</option>
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
            <label>
              {t("formPriority")}
              <input name="priority" type="number" min={0} defaultValue={tension.priority} />
            </label>
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

    return (
      <div className={compact ? "nr-kanban-card" : "nr-item"} key={tension.id}>
        <div className="row" style={{ alignItems: "center" }}>
          <strong className="nr-item-title">
            {tension.isPrivate && <span title={t("privateInboxTooltip")} style={{ marginRight: 6 }}>◆</span>}
            <a href={`/workspaces/${workspaceId}/tensions/${tension.id}`} style={{ color: "inherit" }}>
              {tension.title}
            </a>
          </strong>
          <span className={`tag ${tension.status === "DRAFT" ? "info" : tension.status === "OPEN" ? "neutral" : "success"}`}>
            {statusLabel(tension.status)}
          </span>
        </div>
        {tension.bodyMd && <MarkdownExcerpt markdown={tension.bodyMd} maxLength={compact ? 120 : 220} as="div" className="nr-excerpt" />}
        <div className="nr-item-meta" style={{ marginTop: 8 }}>
          {t("createdByMeta", { name: authorName })}
          {raisedByName ? ` · ${t("raisedByMeta", { name: raisedByName })}` : ""}
          {` · ${ageText(tension.createdAt)} · ${t("upvotes", { count: tension.upvotes.length })} · ${t("priorityN", { priority: tension.priority })}`}
          {tension.circle ? ` · ${tension.circle.name}` : ""}
          {openedDate ? ` · ${t("openedOnMeta", { date: openedDate })}` : ""}
          {closedDate ? ` · ${t("closedOnMeta", { date: closedDate })}` : ""}
          {" · "}
          {tension.version > 1 ? (
            <a href={`/workspaces/${workspaceId}/versions?entityType=TENSION&entityId=${encodeURIComponent(tension.id)}`}>v{tension.version}</a>
          ) : (
            <>v{tension.version}</>
          )}
          {tension.proposal && (
            <>
              {" · "}
              <a href={`/workspaces/${workspaceId}/proposals/${tension.proposal.id}`}>{t("linkedProposalMeta", { title: tension.proposal.title })}</a>
            </>
          )}
        </div>
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
        <h1>{t("pageTitle")}</h1>
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
          {TENSION_STATUS_FILTERS.map((status) => (
            <a
              key={status}
              href={buildWorkItemQuery({ ...filterState, status })}
              className={`nr-filter-item ${statusFilter === status ? "nr-filter-active" : ""}`}
            >
              {t("filterWithCount", { label: statusLabel(status), count: groupedTensions[status].length })}
            </a>
          ))}
        </div>

        <WorkItemFilterControls
          action={`/workspaces/${workspaceId}/tensions`}
          status={statusFilter}
          view={view}
          scope={scope}
          circleId={circleId}
          memberId={memberId}
          circles={circles.map((circle) => ({ id: circle.id, label: circle.name }))}
          members={members.map((member) => ({ id: member.id, label: memberName(member) }))}
          dates={[
            { name: "openedFrom", label: t("filterOpenedFrom"), value: dateValues.openedFrom },
            { name: "openedTo", label: t("filterOpenedTo"), value: dateValues.openedTo },
            { name: "closedFrom", label: t("filterClosedFrom"), value: dateValues.closedFrom },
            { name: "closedTo", label: t("filterClosedTo"), value: dateValues.closedTo },
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
            {(["DRAFT", "OPEN", "RESOLVED"] as const).map((status) => (
              <section className="nr-kanban-column" key={status}>
                <div className="nr-kanban-heading">
                  <span>{statusLabel(status)}</span>
                  <span>{groupedTensions[status].length}</span>
                </div>
                {groupedTensions[status].length === 0 && <p className="muted">{t("noTensions")}</p>}
                {groupedTensions[status].map((tension) => renderTensionCard(tension, true))}
              </section>
            ))}
          </div>
        ) : (
          <div>
            {(!displayTensions || displayTensions.length === 0) && (
              <div className="nr-item nr-empty-state">
                <h3 className="nr-empty-title">{t("whatIsTensionTitle")}</h3>
                <p className="muted nr-empty-desc">
                  {t("whatIsTensionDesc")}
                </p>
              </div>
            )}
            {displayTensions.map((tension) => renderTensionCard(tension))}
          </div>
        )}
      </section>

      <section className="ws-section">
        <details open={resolvedSearch.open === "new"}>
          <summary className="nr-hide-marker nr-section-toggle">
            <span className="nr-section-header nr-section-header-inline">{t("newTensionTitle")}</span>
          </summary>
          <form action={createTensionAction} className="stack nr-form-section">
            <input type="hidden" name="workspaceId" value={workspaceId} />
            <label>
              {t("formTitle")}
              <input name="title" required />
            </label>
            <label>
              {t("formDescription")}
              <MarkdownEditor name="bodyMd" rows={5} />
            </label>
            <label>
              {t("formRaisedBy")}
              <select name="raisedByMemberId" defaultValue="">
                <option value="">{t("formRaisedByNone")}</option>
                {members.map((member) => (
                  <option value={member.id} key={member.id}>{memberName(member)}</option>
                ))}
              </select>
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
            <label style={{ display: "flex", alignItems: "center", gap: "8px", fontWeight: "normal", cursor: "pointer" }}>
              <input type="checkbox" name="isPrivate" defaultChecked />
              <span>{t("formPrivateInbox")}</span>
            </label>
            <button type="submit">{t("btnCreateTension")}</button>
          </form>
        </details>
      </section>
    </>
  );
}
