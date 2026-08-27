import { describe, expect, it } from "vitest";
import {
  assertFields,
  assertVersionedConflictPair,
  cleanupFailureMessage,
  isHumanValidationMember,
  WorkItemParitySmoke,
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

  it("records one validation result per covered PR", () => {
    const smoke = new WorkItemParitySmoke({
      baseUrl: "https://app.corgtex.com",
      outDir: ".artifacts/work-item-parity-test",
      workspaceSelector: { workspaceSlug: "corgtex-validation" },
      prNumbers: [722, 723],
    });
    smoke.created = {
      action: { id: "action-1", cleanupActionId: "archive:Action:action-1" },
      tension: { id: "tension-1", cleanupActionId: "archive:Tension:tension-1" },
      proposal: { id: "proposal-1", cleanupActionId: "archive:Proposal:proposal-1" },
      goal: { id: "goal-1", cleanupActionId: "archive:Goal:goal-1" },
    };

    smoke.recordValidationPass();

    expect(smoke.validationRun.results).toHaveLength(2);
    expect(smoke.validationRun.results.map((result) => result.prNumber)).toEqual([722, 723]);
    expect(smoke.validationRun.results[0]).toMatchObject({
      result: "pass",
      createdRecordIds: ["action-1", "tension-1", "proposal-1", "goal-1"],
    });
  });

  it("returns null when health release metadata matches", () => {
    expect(workItemParityHealthReleaseBlocker({
      status: "ok",
      release: {
        gitSha: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
        runtime: {
          gitSha: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
          source: "railway",
        },
        configured: {
          gitSha: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
        },
      },
    }, "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa")).toBeNull();
  });

  it("rejects aggregate-only release SHA proof", () => {
    expect(workItemParityHealthReleaseBlocker({
      status: "ok",
      release: {
        gitSha: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
        source: { gitSha: "configured" },
        runtime: {
          gitSha: null,
          source: "missing",
        },
      },
    }, "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa")).toContain("release.runtime.gitSha was missing");
  });

  it("rejects configured-only runtime provenance", () => {
    expect(workItemParityHealthReleaseBlocker({
      status: "ok",
      release: {
        gitSha: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
        runtime: {
          gitSha: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
          source: "configured",
        },
      },
    }, "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa")).toContain("was not provider-backed runtime provenance");
  });

  it("rejects runtime SHA drift even when aggregate SHA matches", () => {
    expect(workItemParityHealthReleaseBlocker({
      status: "ok",
      release: {
        gitSha: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
        runtime: {
          gitSha: "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
          source: "railway",
        },
      },
    }, "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa")).toContain("release.runtime.gitSha bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb did not match expected");
  });

  it("rejects degraded health even when release metadata matches", () => {
    expect(workItemParityHealthReleaseBlocker({
      status: "degraded",
      release: {
        gitSha: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
        runtime: {
          gitSha: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
          source: "railway",
        },
      },
    }, "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa")).toContain("status degraded was not ok");
  });

  it("accepts exactly one optimistic-concurrency winner and one version conflict", () => {
    const result = assertVersionedConflictPair({
      entity: "Action",
      baselineVersion: 3,
      attempts: [
        { label: "first", title: "Accepted title" },
        { label: "second", title: "Rejected title" },
      ],
      settlements: [
        { status: "fulfilled", value: { id: "action-1", version: 4 } },
        { status: "fulfilled", value: { status: "VERSION_CONFLICT" } },
      ],
      finalRecord: { id: "action-1", version: 4, title: "Accepted title" },
      field: "title",
      expectedValues: ["Accepted title", "Rejected title"],
    });

    expect(result).toMatchObject({
      winner: "first",
      conflict: "second",
      baselineVersion: 3,
      finalVersion: 4,
      winningValue: "Accepted title",
      losingValue: "Rejected title",
    });
  });

  it("rejects a conflict pair when the losing value takes effect", () => {
    expect(() => assertVersionedConflictPair({
      entity: "Goal",
      baselineVersion: 1,
      attempts: [
        { label: "first", progressPercent: 41 },
        { label: "second", progressPercent: 73 },
      ],
      settlements: [
        { status: "fulfilled", value: { id: "goal-1", version: 2 } },
        { status: "fulfilled", value: { status: "VERSION_CONFLICT" } },
      ],
      finalRecord: { id: "goal-1", version: 2, progressPercent: 73 },
      field: "progressPercent",
      expectedValues: [41, 73],
    })).toThrow("Goal final progressPercent did not match the winning update");
  });
});
