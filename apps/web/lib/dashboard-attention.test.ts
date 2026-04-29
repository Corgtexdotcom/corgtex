import { describe, expect, it } from "vitest";

import { getDashboardAttentionCounts } from "./dashboard-attention";

describe("getDashboardAttentionCounts", () => {
  it("omits pending agent approvals when the user cannot review agent runs", () => {
    expect(getDashboardAttentionCounts({
      pendingFlowsCount: 1,
      pendingAgentApprovalsCount: 3,
      unreadNotificationsCount: 2,
      advisoryRequestsCount: 1,
      canReviewAgentRuns: false,
    })).toEqual({
      pendingAgentApprovalsCount: 0,
      totalAttentionItems: 4,
    });
  });

  it("includes pending agent approvals when the user can review agent runs", () => {
    expect(getDashboardAttentionCounts({
      pendingFlowsCount: 1,
      pendingAgentApprovalsCount: 3,
      unreadNotificationsCount: 2,
      advisoryRequestsCount: 1,
      canReviewAgentRuns: true,
    })).toEqual({
      pendingAgentApprovalsCount: 3,
      totalAttentionItems: 7,
    });
  });
});
