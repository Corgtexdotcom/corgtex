import { describe, expect, it } from "vitest";
import {
  isActiveDashboardDeal,
  sortDashboardDeals,
  summarizeDashboardAccounts,
} from "./dashboard-view-model";
import { normalizeRelationshipView } from "./view-model";

describe("relationship dashboard view model", () => {
  it("makes the dashboard the default relationship view", () => {
    expect(normalizeRelationshipView(undefined)).toBe("dashboard");
    expect(normalizeRelationshipView("accounts")).toBe("accounts");
    expect(normalizeRelationshipView("unknown")).toBe("dashboard");
  });

  it("sorts active dashboard deals by value before recency", () => {
    const deals = [
      {
        id: "closed",
        stage: "CLOSED_WON",
        valueCents: 9000000,
        updatedAt: "2026-06-18T00:00:00.000Z",
      },
      {
        id: "recent-small",
        stage: "PROPOSAL",
        valueCents: 100000,
        updatedAt: "2026-06-18T00:00:00.000Z",
      },
      {
        id: "large",
        stage: "NEGOTIATION",
        valueCents: 500000,
        updatedAt: "2026-06-10T00:00:00.000Z",
      },
    ];

    expect(isActiveDashboardDeal(deals[0])).toBe(false);
    expect(sortDashboardDeals(deals).map((deal) => deal.id)).toEqual(["large", "recent-small"]);
  });

  it("summarizes accounts by active pipeline value and recent relationship activity", () => {
    const accounts = [
      { id: "quiet", updatedAt: "2026-06-01T00:00:00.000Z" },
      { id: "active", updatedAt: "2026-06-01T00:00:00.000Z" },
      { id: "fresh", updatedAt: "2026-06-17T00:00:00.000Z" },
    ];
    const deals = [
      { id: "won", accountId: "quiet", stage: "CLOSED_WON", valueCents: 1000000 },
      { id: "pilot", accountId: "active", stage: "PROPOSAL", valueCents: 450000 },
      { id: "discovery", accountId: "active", stage: "LEAD", valueCents: 50000 },
    ];
    const activities = [
      { accountId: "active", createdAt: "2026-06-10T00:00:00.000Z" },
      { accountId: "quiet", createdAt: "2026-06-18T00:00:00.000Z" },
    ];

    const result = summarizeDashboardAccounts(accounts, deals, activities);

    expect(result.map((summary) => summary.account.id)).toEqual(["active", "quiet", "fresh"]);
    expect(result[0]).toMatchObject({
      activeDealCount: 2,
      pipelineValueCents: 500000,
    });
    expect(result[1].lastTouchedAt).toBe("2026-06-18T00:00:00.000Z");
  });
});
