import { describe, expect, it } from "vitest";
import {
  assertFields,
  workItemExpectations,
  workItemParityHealthReleaseBlocker,
} from "./work-item-parity-production-smoke.mjs";

describe("work-item parity production smoke helpers", () => {
  const member = {
    id: "member-1",
    displayName: "Validation User",
    email: "validation@example.test",
  };

  it("builds action field expectations with owner and responsibility aliases", () => {
    expect(workItemExpectations(member, { type: "action", priority: 2, priorityLabel: "Important" })).toMatchObject({
      priority: 2,
      priorityLabel: "Important",
      assigneeMemberId: "member-1",
      assigneeMemberName: "Validation User",
      responsibleMemberId: "member-1",
      responsibleMemberName: "Validation User",
      ownerMemberId: "member-1",
      ownerMemberName: "Validation User",
    });
  });

  it("builds tension field expectations for responsible and raised-by labels", () => {
    expect(workItemExpectations(member, { type: "tension", priority: 3, priorityLabel: "Urgent" })).toMatchObject({
      priority: 3,
      priorityLabel: "Urgent",
      responsiblePerson: "Validation User",
      raisedBy: "Validation User",
      owner: "Validation User",
    });
  });

  it("builds proposal field expectations with owner and responsibility aliases", () => {
    expect(workItemExpectations(member, { type: "proposal", priority: 1, priorityLabel: "Medium" })).toMatchObject({
      priority: 1,
      priorityLabel: "Medium",
      ownerMemberId: "member-1",
      ownerMemberName: "Validation User",
      responsibleMemberId: "member-1",
      responsibleMemberName: "Validation User",
    });
  });

  it("fails with the exact mismatched field when parity drifts", () => {
    expect(() => assertFields(
      { priority: 1, priorityLabel: "Low" },
      { priority: 2, priorityLabel: "Important" },
      "REST action list",
    )).toThrow("REST action list priority mismatch");
  });

  it("returns null when health release metadata matches", () => {
    expect(workItemParityHealthReleaseBlocker({
      release: {
        gitSha: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
        configuredGitSha: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
      },
    }, "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa")).toBeNull();
  });
});
