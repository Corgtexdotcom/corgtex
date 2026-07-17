import { describe, expect, it } from "vitest";
import {
  normalizeActionWorkItem,
  normalizeGoalWorkItem,
  normalizeProposalWorkItem,
  normalizeTensionWorkItem,
} from "./work-item-normalization";

describe("work item normalization", () => {
  it("normalizes action assignee, responsible, owner, priority, and request counts", () => {
    const action = normalizeActionWorkItem({
      id: "action-1",
      priority: 5,
      assigneeMemberId: "member-1",
      assigneeMember: { id: "member-1", user: { displayName: "Action Owner", email: "owner@example.test" } },
      inputRequests: [{ status: "ACTIVE" }, { status: "COMPLETED" }],
    });

    expect(action).toMatchObject({
      priority: 5,
      priorityLabel: "Urgent",
      assigneeMemberId: "member-1",
      assigneeMemberName: "Action Owner",
      assignee: "Action Owner",
      responsibleMemberId: "member-1",
      responsibleMemberName: "Action Owner",
      responsiblePerson: "Action Owner",
      ownerMemberId: "member-1",
      ownerMemberName: "Action Owner",
      owner: "Action Owner",
      adviceRequestCount: 2,
      activeAdviceRequestCount: 1,
      inputRequestCount: 2,
      activeInputRequestCount: 1,
    });
  });

  it("normalizes tension responsibility, raised-by fallback owner, votes, priority, and requests", () => {
    const tension = normalizeTensionWorkItem({
      id: "tension-1",
      priority: 2,
      assigneeMemberId: null,
      raisedByMemberId: "member-2",
      assigneeMember: null,
      raisedByMember: { id: "member-2", user: { displayName: null, email: "raiser@example.test" } },
      upvotes: [{ id: "vote-1" }, { id: "vote-2" }],
      activeInputRequestCount: 3,
    });

    expect(tension).toMatchObject({
      priority: 2,
      priorityLabel: "Important",
      upvoteCount: 2,
      responsibleMemberId: null,
      responsibleMemberName: null,
      raisedByMemberId: "member-2",
      raisedByMemberName: "raiser@example.test",
      raisedBy: "raiser@example.test",
      ownerMemberId: "member-2",
      ownerMemberName: "raiser@example.test",
      owner: "raiser@example.test",
      adviceRequestCount: null,
      activeAdviceRequestCount: 3,
      inputRequestCount: null,
      activeInputRequestCount: 3,
    });
  });

  it("normalizes proposal owner, priority, and advice-process requests", () => {
    const proposal = normalizeProposalWorkItem({
      id: "proposal-1",
      priority: 1,
      ownerMemberId: "member-3",
      ownerMember: { id: "member-3", user: { displayName: "Proposal Owner", email: "proposal@example.test" } },
      adviceProcess: {
        requests: [{ status: "ACTIVE" }, { status: "CANCELED" }],
      },
    });

    expect(proposal).toMatchObject({
      priority: 1,
      priorityLabel: "Medium",
      ownerMemberId: "member-3",
      ownerMemberName: "Proposal Owner",
      owner: "Proposal Owner",
      responsibleMemberId: "member-3",
      responsibleMemberName: "Proposal Owner",
      responsiblePerson: "Proposal Owner",
      adviceRequestCount: 2,
      activeAdviceRequestCount: 1,
    });
  });

  it("does not add synthetic priority fields to goals", () => {
    const goal = normalizeGoalWorkItem({
      id: "goal-1",
      ownerMemberId: "member-4",
      ownerMember: { id: "member-4", user: { displayName: "Goal Owner", email: "goal@example.test" } },
    });

    expect(goal).toMatchObject({
      ownerMemberId: "member-4",
      ownerMemberName: "Goal Owner",
      owner: "Goal Owner",
    });
    expect(goal).not.toHaveProperty("priorityLabel");
  });
});
