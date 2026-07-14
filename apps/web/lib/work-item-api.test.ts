import { describe, expect, it } from "vitest";
import {
  serializeActionWorkItem,
  serializeGoalWorkItem,
  serializeProposalWorkItem,
  serializeTensionWorkItem,
  workItemPriorityFromBody,
} from "./work-item-api";

describe("work item API helpers", () => {
  it("accepts priority labels or numeric priority values from request bodies", () => {
    expect(workItemPriorityFromBody({ priorityLabel: "Important" })).toBe(2);
    expect(workItemPriorityFromBody({ priority: "Urgent" })).toBe(3);
    expect(workItemPriorityFromBody({ priority: 1 })).toBe(1);
    expect(workItemPriorityFromBody({})).toBeUndefined();
  });

  it("serializes action responsibility and labeled priority", () => {
    expect(serializeActionWorkItem({
      id: "action-1",
      priority: 3,
      assigneeMemberId: "member-1",
      assigneeMember: { id: "member-1", user: { displayName: "Alex", email: "alex@example.test" } },
    })).toMatchObject({
      priority: 3,
      priorityLabel: "Urgent",
      assigneeMemberId: "member-1",
      assigneeMemberName: "Alex",
      assignee: "Alex",
    });
  });

  it("serializes tension responsibility separately from raised-by", () => {
    expect(serializeTensionWorkItem({
      id: "tension-1",
      priority: 2,
      assigneeMemberId: "member-1",
      raisedByMemberId: "member-2",
      assigneeMember: { id: "member-1", user: { displayName: "Responsible", email: "responsible@example.test" } },
      raisedByMember: { id: "member-2", user: { displayName: "Raiser", email: "raiser@example.test" } },
    })).toMatchObject({
      priorityLabel: "Important",
      responsibleMemberId: "member-1",
      responsibleMemberName: "Responsible",
      raisedByMemberId: "member-2",
      raisedByMemberName: "Raiser",
    });
  });

  it("serializes proposal and goal owners", () => {
    expect(serializeProposalWorkItem({
      id: "proposal-1",
      priority: 1,
      ownerMemberId: "member-1",
      ownerMember: { id: "member-1", user: { displayName: null, email: "owner@example.test" } },
    })).toMatchObject({
      priorityLabel: "Medium",
      ownerMemberId: "member-1",
      ownerMemberName: "owner@example.test",
    });
    expect(serializeGoalWorkItem({
      id: "goal-1",
      priority: 0,
      ownerMemberId: "member-2",
      ownerMember: { id: "member-2", user: { displayName: "Goal Owner", email: "goal@example.test" } },
    })).toMatchObject({
      priorityLabel: "Low",
      ownerMemberId: "member-2",
      ownerMemberName: "Goal Owner",
    });
  });
});
