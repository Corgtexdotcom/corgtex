import type { WorkItemSortable } from "@/lib/work-item-view";
import { CRM_DEAL_STAGES } from "./view-model";

export type CrmDealStageCode = (typeof CRM_DEAL_STAGES)[number];

export type DealPipelineActivity = {
  id: string;
  title: string;
  type?: string;
  createdAt: Date | string;
};

export type DealPipelineTransition = {
  id: string;
  fromStage?: string | null;
  toStage: string;
  createdAt: Date | string;
};

export type DealPipelineDeal = {
  id: string;
  title: string;
  stage: string;
  valueCents?: number | null;
  updatedAt?: Date | string;
  createdAt: Date | string;
  activities?: DealPipelineActivity[];
  stageTransitions?: DealPipelineTransition[];
};

export function dealTransitionKey(dealId: string, targetStage: string) {
  return `${dealId}:${targetStage}`;
}

export function dealsGroupedByStage<T extends { stage: string }>(
  deals: readonly T[],
  stages: readonly string[] = CRM_DEAL_STAGES,
) {
  const grouped = Object.fromEntries(stages.map((stage) => [stage, []])) as Record<string, T[]>;
  for (const deal of deals) {
    if (!grouped[deal.stage]) grouped[deal.stage] = [];
    grouped[deal.stage].push(deal);
  }
  return grouped;
}

export function latestDealStageTransition(deal: DealPipelineDeal) {
  return deal.stageTransitions?.[0] ?? null;
}

export function dealStageStartedAt(deal: DealPipelineDeal) {
  return latestDealStageTransition(deal)?.createdAt ?? deal.createdAt;
}

export function dealStageAgeDays(deal: DealPipelineDeal, now: Date | number = Date.now()) {
  const nowMs = now instanceof Date ? now.getTime() : now;
  const startedMs = new Date(dealStageStartedAt(deal)).getTime();
  if (!Number.isFinite(startedMs)) return 0;
  return Math.max(0, Math.floor((nowMs - startedMs) / (1000 * 60 * 60 * 24)));
}

export function nextDealFollowUp(deal: DealPipelineDeal) {
  return deal.activities?.[0] ?? null;
}

export function dealPipelineSort(deal: DealPipelineDeal): WorkItemSortable {
  return {
    priority: deal.valueCents ?? 0,
    date: nextDealFollowUp(deal)?.createdAt ?? dealStageStartedAt(deal),
    alpha: deal.title,
  };
}
