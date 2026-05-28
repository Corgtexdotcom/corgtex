import { describe, expect, it } from "vitest";

import { getDashboardAttentionCounts } from "./dashboard-attention";

describe("getDashboardAttentionCounts", () => {
  it("counts only unread notifications", () => {
    expect(getDashboardAttentionCounts({
      unreadNotificationsCount: 2,
    })).toEqual({
      totalAttentionItems: 2,
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
