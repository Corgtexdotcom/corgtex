type DateValue = Date | string | null | undefined;

export const CRM_DASHBOARD_LIST_LIMIT = 5;

export type DashboardAccountLike = {
  id: string;
  createdAt?: DateValue;
  updatedAt?: DateValue;
};

export type DashboardDealLike = {
  accountId?: string | null;
  createdAt?: DateValue;
  id: string;
  stage: string;
  updatedAt?: DateValue;
  valueCents?: number | null;
};

export type DashboardActivityLike = {
  accountId?: string | null;
  createdAt?: DateValue;
};

export type DashboardAccountSummary<TAccount extends DashboardAccountLike> = {
  account: TAccount;
  activeDealCount: number;
  lastTouchedAt?: DateValue;
  pipelineValueCents: number;
};

function timestamp(value: DateValue) {
  return value ? new Date(value).getTime() : 0;
}

export function isActiveDashboardDeal(deal: DashboardDealLike) {
  return deal.stage !== "CLOSED_WON" && deal.stage !== "CLOSED_LOST";
}

export function sortDashboardDeals<TDeal extends DashboardDealLike>(
  deals: readonly TDeal[],
  limit = CRM_DASHBOARD_LIST_LIMIT,
) {
  return deals
    .filter(isActiveDashboardDeal)
    .sort((a, b) => {
      const valueDelta = (b.valueCents ?? 0) - (a.valueCents ?? 0);
      if (valueDelta !== 0) return valueDelta;
      return timestamp(b.updatedAt ?? b.createdAt) - timestamp(a.updatedAt ?? a.createdAt);
    })
    .slice(0, limit);
}

export function summarizeDashboardAccounts<
  TAccount extends DashboardAccountLike,
  TDeal extends DashboardDealLike,
  TActivity extends DashboardActivityLike,
>(
  accounts: readonly TAccount[],
  deals: readonly TDeal[],
  activities: readonly TActivity[],
  limit = CRM_DASHBOARD_LIST_LIMIT,
): Array<DashboardAccountSummary<TAccount>> {
  const activeDealsByAccountId = new Map<string, TDeal[]>();
  for (const deal of deals) {
    if (!deal.accountId || !isActiveDashboardDeal(deal)) continue;
    activeDealsByAccountId.set(deal.accountId, [...(activeDealsByAccountId.get(deal.accountId) ?? []), deal]);
  }

  const latestActivityByAccountId = new Map<string, TActivity>();
  for (const activity of activities) {
    if (!activity.accountId) continue;
    const previous = latestActivityByAccountId.get(activity.accountId);
    if (!previous || timestamp(activity.createdAt) > timestamp(previous.createdAt)) {
      latestActivityByAccountId.set(activity.accountId, activity);
    }
  }

  return accounts
    .map((account) => {
      const activeDeals = activeDealsByAccountId.get(account.id) ?? [];
      const latestActivity = latestActivityByAccountId.get(account.id);
      return {
        account,
        activeDealCount: activeDeals.length,
        lastTouchedAt: latestActivity?.createdAt ?? account.updatedAt ?? account.createdAt,
        pipelineValueCents: activeDeals.reduce((sum, deal) => sum + (deal.valueCents ?? 0), 0),
      };
    })
    .sort((a, b) => {
      const valueDelta = b.pipelineValueCents - a.pipelineValueCents;
      if (valueDelta !== 0) return valueDelta;
      return timestamp(b.lastTouchedAt) - timestamp(a.lastTouchedAt);
    })
    .slice(0, limit);
}
