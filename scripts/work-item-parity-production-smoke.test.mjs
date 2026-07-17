import { describe, expect, it } from "vitest";
import {
  assertFields,
  cleanupFailureMessage,
  isHumanValidationMember,
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

  it("selects only write-safe human validation members", () => {
    expect(isHumanValidationMember({ id: "system", isActive: true, kind: "SYSTEM", email: "human@example.test" })).toBe(false);
    expect(isHumanValidationMember({ id: "system-email", isActive: true, email: "system+corgtex@example.test" })).toBe(false);
    expect(isHumanValidationMember({ id: "support", isActive: true, displayName: "Corgtex Support", email: "support@example.test" })).toBe(false);
    expect(isHumanValidationMember({ id: "human", isActive: true, displayName: "Validation User", email: "human@example.test" })).toBe(true);
  });

  it("describes cleanup failures so the smoke can fail instead of passing", () => {
    expect(cleanupFailureMessage({
      failed: [
        { entry: { id: "archive:Action:action-1" } },
        { entry: { id: "revoke:AgentCredential:credential-1" } },
      ],
    })).toBe("Validation cleanup failed for archive:Action:action-1, revoke:AgentCredential:credential-1");
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
