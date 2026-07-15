import { describe, expect, it } from "vitest";

import { getDashboardAttentionCounts } from "./dashboard-attention";

describe("getDashboardAttentionCounts", () => {
  it("counts unread notifications and proposal reviews", () => {
    expect(getDashboardAttentionCounts({
      unreadNotificationsCount: 2,
      proposalReviewRequestsCount: 3,
    })).toEqual({
      totalAttentionItems: 5,
    });
  });

  it("returns zero when there are no unread notifications", () => {
    expect(getDashboardAttentionCounts({
      unreadNotificationsCount: 0,
    })).toEqual({
      totalAttentionItems: 0,
    });
  });
});
