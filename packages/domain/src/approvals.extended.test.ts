import { describe, expect, it } from "vitest";
import { buildDecisionSummary, calculateApprovalOutcome } from "./approvals";

describe("buildDecisionSummary", () => {
  it("counts decisions by type", () => {
    const summary = buildDecisionSummary([
      { choice: "APPROVE" },
      { choice: "APPROVE" },
      { choice: "REJECT" },
      { choice: "ABSTAIN" },
      { choice: "AGREE" },
      { choice: "BLOCK" },
    ]);
    expect(summary).toEqual({
      approve: 2,
      reject: 1,
      abstain: 1,
      agree: 1,
      block: 1,
    });
  });

  it("returns zeros for empty decisions", () => {
    const summary = buildDecisionSummary([]);
    expect(summary).toEqual({
      approve: 0,
      reject: 0,
      abstain: 0,
      agree: 0,
      block: 0,
    });
  });
});

describe("calculateApprovalOutcome - SINGLE mode", () => {
  it("approves with one APPROVE", () => {
    const outcome = calculateApprovalOutcome({
      mode: "SINGLE",
      quorumPercent: 0,
      minApproverCount: 1,
      eligibleApprovers: 5,
      openObjections: 0,
      decisions: [{ choice: "APPROVE" }],
    });
    expect(outcome.approved).toBe(true);
  });

  it("approves with one AGREE", () => {
    const outcome = calculateApprovalOutcome({
      mode: "SINGLE",
      quorumPercent: 0,
      minApproverCount: 1,
      eligibleApprovers: 5,
      openObjections: 0,
      decisions: [{ choice: "AGREE" }],
    });
    expect(outcome.approved).toBe(true);
  });

  it("does not approve with only rejections", () => {
    const outcome = calculateApprovalOutcome({
      mode: "SINGLE",
      quorumPercent: 0,
      minApproverCount: 1,
      eligibleApprovers: 5,
      openObjections: 0,
      decisions: [{ choice: "REJECT" }],
    });
    expect(outcome.approved).toBe(false);
  });

  it("does not approve with no decisions", () => {
    const outcome = calculateApprovalOutcome({
      mode: "SINGLE",
      quorumPercent: 0,
      minApproverCount: 1,
      eligibleApprovers: 5,
      openObjections: 0,
      decisions: [],
    });
    expect(outcome.approved).toBe(false);
  });
});

describe("calculateApprovalOutcome - MAJORITY mode", () => {
  it("rejects when quorum not met", () => {
    const outcome = calculateApprovalOutcome({
      mode: "MAJORITY",
      quorumPercent: 80,
      minApproverCount: 1,
      eligibleApprovers: 10,
      openObjections: 0,
      decisions: [{ choice: "APPROVE" }],
    });
    expect(outcome.approved).toBe(false);
    expect(outcome.quorumMet).toBe(false);
  });

  it("rejects when approvals equal rejections", () => {
    const outcome = calculateApprovalOutcome({
      mode: "MAJORITY",
      quorumPercent: 0,
      minApproverCount: 1,
      eligibleApprovers: 2,
      openObjections: 0,
      decisions: [{ choice: "APPROVE" }, { choice: "REJECT" }],
    });
    expect(outcome.approved).toBe(false);
  });

  it("calculates participation percent correctly", () => {
    const outcome = calculateApprovalOutcome({
      mode: "MAJORITY",
      quorumPercent: 50,
      minApproverCount: 1,
      eligibleApprovers: 4,
      openObjections: 0,
      decisions: [{ choice: "APPROVE" }, { choice: "APPROVE" }],
    });
    expect(outcome.participationPercent).toBe(50);
    expect(outcome.quorumMet).toBe(true);
    expect(outcome.approved).toBe(true);
  });
});

describe("calculateApprovalOutcome - CONSENSUS mode", () => {
  it("requires all to agree (no abstains)", () => {
    const outcome = calculateApprovalOutcome({
      mode: "CONSENSUS",
      quorumPercent: 50,
      minApproverCount: 1,
      eligibleApprovers: 3,
      openObjections: 0,
      decisions: [{ choice: "AGREE" }, { choice: "AGREE" }, { choice: "AGREE" }],
    });
    expect(outcome.approved).toBe(true);
  });

  it("rejects when any decision is not AGREE", () => {
    const outcome = calculateApprovalOutcome({
      mode: "CONSENSUS",
      quorumPercent: 50,
      minApproverCount: 1,
      eligibleApprovers: 3,
      openObjections: 0,
      decisions: [{ choice: "AGREE" }, { choice: "APPROVE" }],
    });
    expect(outcome.approved).toBe(false);
  });

  it("rejects when any decision is BLOCK", () => {
    const outcome = calculateApprovalOutcome({
      mode: "CONSENSUS",
      quorumPercent: 50,
      minApproverCount: 1,
      eligibleApprovers: 3,
      openObjections: 0,
      decisions: [{ choice: "AGREE" }, { choice: "BLOCK" }],
    });
    expect(outcome.approved).toBe(false);
  });

  it("rejects with no decisions even when quorum is 0", () => {
    const outcome = calculateApprovalOutcome({
      mode: "CONSENSUS",
      quorumPercent: 0,
      minApproverCount: 1,
      eligibleApprovers: 3,
      openObjections: 0,
      decisions: [],
    });
    expect(outcome.approved).toBe(false);
  });
});

describe("calculateApprovalOutcome - CONSENT mode", () => {
  it("approves when no open objections (ignoring decisions)", () => {
    const outcome = calculateApprovalOutcome({
      mode: "CONSENT",
      quorumPercent: 0,
      minApproverCount: 1,
      eligibleApprovers: 10,
      openObjections: 0,
      decisions: [],
    });
    expect(outcome.approved).toBe(true);
  });

  it("rejects when open objections exist", () => {
    const outcome = calculateApprovalOutcome({
      mode: "CONSENT",
      quorumPercent: 0,
      minApproverCount: 1,
      eligibleApprovers: 10,
      openObjections: 3,
      decisions: [{ choice: "AGREE" }, { choice: "AGREE" }],
    });
    expect(outcome.approved).toBe(false);
  });
});

describe("calculateApprovalOutcome - edge cases", () => {
  it("handles zero eligible approvers", () => {
    const outcome = calculateApprovalOutcome({
      mode: "MAJORITY",
      quorumPercent: 50,
      minApproverCount: 1,
      eligibleApprovers: 0,
      openObjections: 0,
      decisions: [],
    });
    expect(outcome.participationPercent).toBe(0);
    expect(outcome.quorumMet).toBe(false);
    expect(outcome.approved).toBe(false);
  });

  it("requires the minimum approver count before majority can pass", () => {
    const outcome = calculateApprovalOutcome({
      mode: "MAJORITY",
      quorumPercent: 0,
      minApproverCount: 2,
      eligibleApprovers: 4,
      openObjections: 0,
      decisions: [{ choice: "APPROVE" }],
    });

    expect(outcome.minApproverCountMet).toBe(false);
    expect(outcome.approved).toBe(false);
  });
});
