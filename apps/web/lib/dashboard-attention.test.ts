import { describe, expect, it } from "vitest";

import {
  getDashboardAttentionCounts,
  getDashboardWorkAttentionCounts,
  getDashboardWorkAttentionCountsFromMetrics,
} from "./dashboard-attention";

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

describe("getDashboardWorkAttentionCounts", () => {
  it("computes personal and total counts for actions, proposals, and tensions", () => {
    expect(getDashboardWorkAttentionCounts({
      currentMemberId: "member-1",
      actions: [
        { status: "OPEN", assigneeMemberId: "member-1" },
        { status: "IN_PROGRESS", assigneeMemberId: "member-2" },
        { status: "COMPLETED", assigneeMemberId: "member-1" },
      ],
      proposals: [
        { id: "proposal-owned", status: "OPEN", ownerMemberId: "member-1" },
        { id: "proposal-requested", status: "OPEN", ownerMemberId: "member-2" },
        { id: "proposal-team", status: "OPEN", ownerMemberId: "member-3" },
      ],
      proposalAdviceRequestSubjectIds: ["proposal-requested", "proposal-owned", "proposal-requested"],
      tensions: [
        { status: "OPEN", assigneeMemberId: "member-1" },
        { status: "OPEN", assigneeMemberId: "member-2" },
        { status: "RESOLVED", assigneeMemberId: "member-1" },
      ],
    })).toEqual({
      actions: { personalCount: 1, totalCount: 2 },
      proposals: { personalCount: 2, totalCount: 3 },
      tensions: { personalCount: 1, totalCount: 2 },
    });
  });

  it("omits personal counts when no current member exists", () => {
    expect(getDashboardWorkAttentionCounts({
      currentMemberId: null,
      actions: [{ status: "OPEN", assigneeMemberId: "member-1" }],
      proposals: [{ id: "proposal-1", status: "OPEN", ownerMemberId: "member-1" }],
      proposalAdviceRequestSubjectIds: ["proposal-1"],
      tensions: [{ status: "OPEN", assigneeMemberId: "member-1" }],
    })).toEqual({
      actions: { personalCount: null, totalCount: 1 },
      proposals: { personalCount: null, totalCount: 1 },
      tensions: { personalCount: null, totalCount: 1 },
    });
  });

  it("normalizes precomputed work attention metrics", () => {
    expect(getDashboardWorkAttentionCountsFromMetrics({
      currentMemberId: "member-1",
      actionPersonalCount: 2,
      actionTotalCount: 5,
      proposalPersonalCount: 1,
      proposalTotalCount: 3,
      tensionPersonalCount: 4,
      tensionTotalCount: 6,
    })).toEqual({
      actions: { personalCount: 2, totalCount: 5 },
      proposals: { personalCount: 1, totalCount: 3 },
      tensions: { personalCount: 4, totalCount: 6 },
    });

    expect(getDashboardWorkAttentionCountsFromMetrics({
      currentMemberId: null,
      actionPersonalCount: 2,
      actionTotalCount: 5,
      proposalPersonalCount: 1,
      proposalTotalCount: 3,
      tensionPersonalCount: 4,
      tensionTotalCount: 6,
    })).toEqual({
      actions: { personalCount: null, totalCount: 5 },
      proposals: { personalCount: null, totalCount: 3 },
      tensions: { personalCount: null, totalCount: 6 },
    });
  });

  it("does not count archived, completed, resolved, or private records", () => {
    const archivedAt = new Date("2026-07-21T12:00:00.000Z");

    expect(getDashboardWorkAttentionCounts({
      currentMemberId: "member-1",
      actions: [
        { status: "OPEN", assigneeMemberId: "member-1", archivedAt },
        { status: "IN_PROGRESS", assigneeMemberId: "member-1", isPrivate: true },
        { status: "COMPLETED", assigneeMemberId: "member-1" },
      ],
      proposals: [
        { id: "archived", status: "OPEN", ownerMemberId: "member-1", archivedAt },
        { id: "private", status: "OPEN", ownerMemberId: "member-1", isPrivate: true },
        { id: "resolved", status: "RESOLVED", ownerMemberId: "member-1" },
      ],
      proposalAdviceRequestSubjectIds: ["private", "resolved"],
      tensions: [
        { status: "OPEN", assigneeMemberId: "member-1", archivedAt },
        { status: "OPEN", assigneeMemberId: "member-1", isPrivate: true },
        { status: "RESOLVED", assigneeMemberId: "member-1" },
      ],
    })).toEqual({
      actions: { personalCount: 0, totalCount: 0 },
      proposals: { personalCount: 0, totalCount: 0 },
      tensions: { personalCount: 0, totalCount: 0 },
    });
  });
});
