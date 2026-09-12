import { WorkItemKanbanBoard, type WorkItemKanbanColumn } from "@/lib/components/WorkItemKanbanBoard";
import { archiveDealAction, updateDealAction } from "./actions";
import { DealStageSelect } from "./DealStageSelect";
import {
  dealPipelineSort,
  dealStageAgeDays,
  dealTransitionKey,
  dealsGroupedByStage,
  nextDealFollowUp,
  type DealPipelineDeal,
} from "./deal-pipeline";
import { CRM_CREATABLE_DEAL_STAGES, CRM_DEAL_STAGES, accountNavigationState, labelFromCrmCode } from "./view-model";
import { ConfirmSubmitButton } from "@/lib/components/ConfirmSubmitButton";

type PipelineMember = {
  user: {
    id: string;
    email: string;
    displayName?: string | null;
  };
};

type PipelineAccount = {
  id: string;
  name: string;
  archivedAt?: Date | string | null;
};

type PipelineDeal = DealPipelineDeal & {
  accountId?: string | null;
  account?: PipelineAccount | null;
  contact: { id: string; name?: string | null; email: string };
  ownerUserId?: string | null;
};

type WorkItemLabels = {
  settingsLabel: string;
  resetLabel: string;
  hideLabel: string;
  moveUpLabel: string;
  moveDownLabel: string;
  hideShortLabel: string;
  moveUpShortLabel: string;
  moveDownShortLabel: string;
  sortLabel: string;
  sortPriorityLabel: string;
  sortDateLabel: string;
  sortAlphaLabel: string;
  dragUnavailableLabel: string;
};

export function DealPipelineBoard({
  workspaceId,
  deals,
  members,
  locale,
  stageLabels,
  visibleColumnIds,
  hideColumnHrefs,
  storageKey,
  labels,
  workItemLabels,
  accountFallback,
  addStageHrefs,
}: {
  workspaceId: string;
  deals: PipelineDeal[];
  members: PipelineMember[];
  locale: string;
  stageLabels: Record<string, string>;
  visibleColumnIds: readonly string[];
  hideColumnHrefs: Record<string, string>;
  storageKey: string;
  labels: {
    account: string;
    contact: string;
    emptyStage: string;
    noAccount: string;
    nextFollowUp: string;
    noNextFollowUp: string;
    owner: string;
    noOwner: string;
    stageAgeToday: string;
    stageAgeYesterday: string;
    stageAgeDays: (days: number) => string;
    archiveDeal: string;
    confirmArchiveDeal: string;
  };
  workItemLabels: WorkItemLabels;
  accountFallback?: PipelineAccount | null;
  addStageHrefs?: Partial<Record<string, string>>;
}) {
  const groupedDeals = dealsGroupedByStage(deals);
  const ownerNames = new Map(
    members.map((member) => [
      member.user.id,
      member.user.displayName || member.user.email,
    ]),
  );
  const formatCurrency = (cents: number) => {
    return new Intl.NumberFormat(locale, {
      style: "currency",
      currency: "USD",
      maximumFractionDigits: 0,
    }).format(cents / 100);
  };
  const formatDate = (value: Date | string) => {
    return new Intl.DateTimeFormat(locale, {
      month: "short",
      day: "numeric",
      year: "numeric",
    }).format(new Date(value));
  };
  const formatStageAge = (deal: PipelineDeal) => {
    const days = dealStageAgeDays(deal);
    if (days <= 0) return labels.stageAgeToday;
    if (days === 1) return labels.stageAgeYesterday;
    return labels.stageAgeDays(days);
  };
  const accountForDeal = (deal: PipelineDeal) => deal.account ?? accountFallback ?? null;
  const creatableStageSet = new Set<string>(CRM_CREATABLE_DEAL_STAGES);
  const columns: WorkItemKanbanColumn[] = CRM_DEAL_STAGES.map((stage) => {
    const stageDeals = groupedDeals[stage] ?? [];
    const addHref = creatableStageSet.has(stage) ? addStageHrefs?.[stage] : undefined;
    return {
      id: stage,
      label: stageLabels[stage] ?? labelFromCrmCode(stage),
      count: stageDeals.length,
      empty: <p className="muted">{labels.emptyStage}</p>,
      addCard: addHref ? (
        <a
          className="nr-kanban-add-trigger nr-kanban-add-link"
          href={addHref}
          aria-label={`Add deal to ${stageLabels[stage] ?? labelFromCrmCode(stage)}`}
          title={`Add deal to ${stageLabels[stage] ?? labelFromCrmCode(stage)}`}
        >
          +
        </a>
      ) : null,
      items: stageDeals.map((deal) => {
        const followUp = nextDealFollowUp(deal);
        const account = accountForDeal(deal);
        const owner = deal.ownerUserId ? ownerNames.get(deal.ownerUserId) : null;
        return {
          id: deal.id,
          status: deal.stage,
          sort: dealPipelineSort(deal),
          node: (
            <div className="nr-kanban-card">
              <div className="row" style={{ alignItems: "flex-start", gap: 8 }}>
                <strong style={{ fontSize: "0.95rem", lineHeight: 1.3 }}>{deal.title}</strong>
                {deal.valueCents != null && (
                  <span className="tag" style={{ marginLeft: "auto" }}>{formatCurrency(deal.valueCents)}</span>
                )}
              </div>
              <div style={{ display: "grid", gap: 6, marginTop: 10, fontSize: "0.82rem" }}>
                <div>
                  <span className="muted">{labels.account}: </span>
                  {(() => {
                    const nav = accountNavigationState(workspaceId, account);
                    if (nav.isMissing) return <span className="muted">{labels.noAccount}</span>;
                    if (nav.isArchived) return <span className="muted">{account?.name}</span>;
                    return <a href={nav.href ?? nav.fallbackHref}>{account?.name}</a>;
                  })()}
                </div>
                <div>
                  <span className="muted">{labels.contact}: </span>
                  <span>{deal.contact.name || deal.contact.email}</span>
                </div>
              </div>
              <div className="nr-tag-group" style={{ marginTop: 10 }}>
                <span className="tag-sm">{formatStageAge(deal)}</span>
                <span className="tag-sm">{labels.owner}: {owner ?? labels.noOwner}</span>
              </div>
              <div className="muted" style={{ fontSize: "0.8rem", marginTop: 10 }}>
                {labels.nextFollowUp}: {followUp
                  ? `${followUp.title}${followUp.dueAt ? ` (${formatDate(followUp.dueAt)})` : ""}`
                  : labels.noNextFollowUp}
              </div>
              <div style={{ marginTop: 12, display: "flex", gap: 4, alignItems: "center" }}>
                <DealStageSelect workspaceId={workspaceId} dealId={deal.id} currentStage={deal.stage} />
                <form action={archiveDealAction}>
                  <input type="hidden" name="workspaceId" value={workspaceId} />
                  <input type="hidden" name="dealId" value={deal.id} />
                  <ConfirmSubmitButton className="danger small" confirmMessage={labels.confirmArchiveDeal}>
                    {labels.archiveDeal}
                  </ConfirmSubmitButton>
                </form>
              </div>
              <div aria-hidden="true" style={{ display: "none" }}>
                {CRM_DEAL_STAGES.filter((targetStage) => targetStage !== deal.stage).map((targetStage) => (
                  <form
                    action={updateDealAction}
                    data-work-item-transition={dealTransitionKey(deal.id, targetStage)}
                    key={targetStage}
                  >
                    <input type="hidden" name="workspaceId" value={workspaceId} />
                    <input type="hidden" name="dealId" value={deal.id} />
                    <input type="hidden" name="stage" value={targetStage} />
                    <button type="submit">{stageLabels[targetStage] ?? labelFromCrmCode(targetStage)}</button>
                  </form>
                ))}
              </div>
            </div>
          ),
        };
      }),
    };
  });

  return (
    <WorkItemKanbanBoard
      columns={columns}
      storageKey={storageKey}
      visibleColumnIds={visibleColumnIds}
      hideColumnHrefs={hideColumnHrefs}
      settingsLabel={workItemLabels.settingsLabel}
      resetLabel={workItemLabels.resetLabel}
      hideLabel={workItemLabels.hideLabel}
      moveUpLabel={workItemLabels.moveUpLabel}
      moveDownLabel={workItemLabels.moveDownLabel}
      hideShortLabel={workItemLabels.hideShortLabel}
      moveUpShortLabel={workItemLabels.moveUpShortLabel}
      moveDownShortLabel={workItemLabels.moveDownShortLabel}
      sortLabel={workItemLabels.sortLabel}
      sortPriorityLabel={workItemLabels.sortPriorityLabel}
      sortDateLabel={workItemLabels.sortDateLabel}
      sortAlphaLabel={workItemLabels.sortAlphaLabel}
      dragUnavailableLabel={workItemLabels.dragUnavailableLabel}
    />
  );
}
