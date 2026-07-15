import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  calculateApprovalOutcome,
  finalizeExpiredApprovalFlows,
  listActionableApprovalFlows,
  listProposalDecisionStates,
  recordApprovalDecision,
  withdrawActiveApprovalFlowForSubject,
} from "./approvals";

const prismaMock = vi.hoisted(() => {
  const mock: any = {
    approvalDecision: {
      upsert: vi.fn(),
    },
    approvalFlow: {
      findMany: vi.fn(),
      findFirst: vi.fn(),
      findUnique: vi.fn(),
      update: vi.fn(),
      updateMany: vi.fn(),
    },
    auditLog: {
      create: vi.fn(),
    },
    member: {
      findMany: vi.fn(),
    },
    policyCorpus: {
      upsert: vi.fn(),
    },
    proposal: {
      findMany: vi.fn(),
      update: vi.fn(),
    },
  };
  mock.$queryRaw = vi.fn();
  mock.$transaction = vi.fn(async (cb) => cb(mock));
  return mock;
});

const requireWorkspaceMembershipMock = vi.hoisted(() => vi.fn());
const appendEventsMock = vi.hoisted(() => vi.fn());

vi.mock("@corgtex/shared", () => ({
  prisma: prismaMock,
}));

vi.mock("./auth", () => ({
  requireWorkspaceMembership: requireWorkspaceMembershipMock,
}));

vi.mock("./events", () => ({
  appendEvents: appendEventsMock,
}));

beforeEach(() => {
  vi.clearAllMocks();
  requireWorkspaceMembershipMock.mockResolvedValue({
    id: "member-1",
    workspaceId: "ws-1",
    userId: "u-1",
    role: "MEMBER",
    isActive: true,
  });
  prismaMock.member.findMany.mockResolvedValue([{ id: "member-1" }]);
  prismaMock.approvalDecision.upsert.mockResolvedValue({});
  prismaMock.approvalFlow.update.mockResolvedValue({});
  prismaMock.auditLog.create.mockResolvedValue({});
  prismaMock.approvalFlow.findMany.mockResolvedValue([]);
  prismaMock.approvalFlow.findFirst.mockResolvedValue(null);
  prismaMock.approvalFlow.updateMany.mockResolvedValue({ count: 1 });
  prismaMock.proposal.findMany.mockResolvedValue([]);
  prismaMock.proposal.update.mockResolvedValue({ id: "p-1" });
  prismaMock.policyCorpus.upsert.mockResolvedValue({});
  appendEventsMock.mockResolvedValue(undefined);
});

describe("calculateApprovalOutcome", () => {
  it("passes majority when approvals beat rejections and quorum is met", () => {
    const outcome = calculateApprovalOutcome({
      mode: "MAJORITY",
      quorumPercent: 50,
      minApproverCount: 1,
      eligibleApprovers: 4,
      openObjections: 0,
      decisions: [{ choice: "APPROVE" }, { choice: "APPROVE" }, { choice: "REJECT" }],
    });

    expect(outcome.approved).toBe(true);
    expect(outcome.quorumMet).toBe(true);
    expect(outcome.summary.approve).toBe(2);
    expect(outcome.summary.reject).toBe(1);
  });

  it("requires all agree for consensus", () => {
    const outcome = calculateApprovalOutcome({
      mode: "CONSENSUS",
      quorumPercent: 50,
      minApproverCount: 1,
      eligibleApprovers: 2,
      openObjections: 0,
      decisions: [{ choice: "AGREE" }, { choice: "ABSTAIN" }],
    });

    expect(outcome.approved).toBe(false);
    expect(outcome.quorumMet).toBe(true);
  });

  it("passes consent only when no objections remain open", () => {
    const approved = calculateApprovalOutcome({
      mode: "CONSENT",
      quorumPercent: 0,
      minApproverCount: 1,
      eligibleApprovers: 10,
      openObjections: 0,
      decisions: [],
    });
    const rejected = calculateApprovalOutcome({
      mode: "CONSENT",
      quorumPercent: 0,
      minApproverCount: 1,
      eligibleApprovers: 10,
      openObjections: 1,
      decisions: [],
    });

    expect(approved.approved).toBe(true);
    expect(rejected.approved).toBe(false);
  });
});

describe("recordApprovalDecision", () => {
  it("keeps proposal approval decisions advisory instead of resolving the proposal", async () => {
    const currentFlow = {
      id: "flow-proposal",
      workspaceId: "ws-1",
      subjectType: "PROPOSAL",
      subjectId: "p-1",
      status: "ACTIVE",
      mode: "MAJORITY",
      quorumPercent: 0,
      minApproverCount: 1,
      closesAt: null,
      decisions: [],
      objections: [],
    };
    prismaMock.approvalFlow.findUnique
      .mockResolvedValueOnce(currentFlow)
      .mockResolvedValueOnce({
        ...currentFlow,
        decisions: [{ choice: "APPROVE" }],
      });

    await expect(recordApprovalDecision(
      { kind: "user", user: { id: "u-1" } } as any,
      { workspaceId: "ws-1", flowId: "flow-proposal", choice: "APPROVE" },
    )).resolves.toMatchObject({
      flowId: "flow-proposal",
      status: "ACTIVE",
    });

    expect(prismaMock.proposal.update).not.toHaveBeenCalled();
    expect(prismaMock.policyCorpus.upsert).not.toHaveBeenCalled();
    expect(prismaMock.approvalFlow.update).toHaveBeenCalledWith({
      where: { id: "flow-proposal" },
      data: {
        resultJson: expect.objectContaining({ approved: true }),
      },
    });
  });
});

describe("listActionableApprovalFlows", () => {
  it("only returns active approval flows whose subjects are still actionable", async () => {
    prismaMock.approvalFlow.findMany.mockResolvedValue([
      {
        id: "flow-open-proposal",
        workspaceId: "ws-1",
        subjectType: "PROPOSAL",
        subjectId: "proposal-open",
        status: "ACTIVE",
        createdAt: new Date("2026-05-26T12:00:00.000Z"),
        decisions: [],
      },
      {
        id: "flow-archived-proposal",
        workspaceId: "ws-1",
        subjectType: "PROPOSAL",
        subjectId: "proposal-archived",
        status: "ACTIVE",
        createdAt: new Date("2026-05-26T11:00:00.000Z"),
        decisions: [],
      },
      {
        id: "flow-private-proposal",
        workspaceId: "ws-1",
        subjectType: "PROPOSAL",
        subjectId: "proposal-private",
        status: "ACTIVE",
        createdAt: new Date("2026-05-26T10:00:00.000Z"),
        decisions: [],
      },
      {
        id: "flow-missing-proposal",
        workspaceId: "ws-1",
        subjectType: "PROPOSAL",
        subjectId: "proposal-missing",
        status: "ACTIVE",
        createdAt: new Date("2026-05-26T07:00:00.000Z"),
        decisions: [],
      },
    ]);
    prismaMock.proposal.findMany.mockResolvedValue([
      { id: "proposal-open", title: "Open proposal", status: "OPEN", isPrivate: false, archivedAt: null },
      { id: "proposal-archived", title: "Archived proposal", status: "OPEN", isPrivate: false, archivedAt: new Date() },
      { id: "proposal-private", title: "Private proposal", status: "OPEN", isPrivate: true, archivedAt: null },
    ]);
    await expect(listActionableApprovalFlows({ kind: "user", user: { id: "u-1" } } as any, "ws-1")).resolves.toMatchObject({
      total: 1,
      items: [
        { id: "flow-open-proposal", subjectLabel: "Open proposal" },
      ],
    });
    expect(prismaMock.approvalFlow.findMany).toHaveBeenCalledWith(expect.not.objectContaining({ take: expect.any(Number) }));
  });
});

describe("listProposalDecisionStates", () => {
  it("summarizes majority decisions and current member review state", async () => {
    const updatedAt = new Date("2026-05-26T12:15:00.000Z");
    prismaMock.member.findMany.mockResolvedValue([{ id: "member-1" }, { id: "member-2" }, { id: "member-3" }]);
    prismaMock.approvalFlow.findMany.mockResolvedValue([
      {
        id: "flow-majority",
        workspaceId: "ws-1",
        subjectType: "PROPOSAL",
        subjectId: "proposal-1",
        status: "ACTIVE",
        mode: "MAJORITY",
        openedAt: new Date("2026-05-26T12:00:00.000Z"),
        closesAt: null,
        quorumPercent: 50,
        minApproverCount: 2,
        decisions: [
          { memberId: "member-1", choice: "APPROVE", rationale: "Works", updatedAt },
          { memberId: "member-2", choice: "REJECT", rationale: null, updatedAt },
        ],
        objections: [],
      },
    ]);

    const states = await listProposalDecisionStates(
      { kind: "user", user: { id: "u-1" } } as any,
      { workspaceId: "ws-1", proposalIds: ["proposal-1"] },
    );

    expect(states.get("proposal-1")).toMatchObject({
      proposalId: "proposal-1",
      flowId: "flow-majority",
      mode: "MAJORITY",
      eligibleApprovers: 3,
      currentMemberDecision: { choice: "APPROVE", rationale: "Works" },
      needsReview: false,
      outcome: {
        quorumMet: true,
        minApproverCountMet: true,
        summary: {
          approve: 1,
          reject: 1,
          abstain: 0,
        },
      },
    });
  });

  it("marks consent review needed until the user reviews or has an open objection", async () => {
    prismaMock.member.findMany.mockResolvedValue([{ id: "member-1" }, { id: "member-2" }]);
    prismaMock.approvalFlow.findMany.mockResolvedValue([
      {
        id: "flow-needs-review",
        workspaceId: "ws-1",
        subjectType: "PROPOSAL",
        subjectId: "proposal-review",
        status: "ACTIVE",
        mode: "CONSENT",
        openedAt: new Date("2026-05-26T12:00:00.000Z"),
        closesAt: new Date("2026-05-29T12:00:00.000Z"),
        quorumPercent: 0,
        minApproverCount: 1,
        decisions: [],
        objections: [],
      },
      {
        id: "flow-objected",
        workspaceId: "ws-1",
        subjectType: "PROPOSAL",
        subjectId: "proposal-objected",
        status: "ACTIVE",
        mode: "CONSENT",
        openedAt: new Date("2026-05-26T12:00:00.000Z"),
        closesAt: new Date("2026-05-29T12:00:00.000Z"),
        quorumPercent: 0,
        minApproverCount: 1,
        decisions: [],
        objections: [
          {
            id: "objection-1",
            userId: "u-1",
            bodyMd: "This creates risk.",
            createdAt: new Date("2026-05-26T13:00:00.000Z"),
            user: { displayName: "Reviewer", email: "reviewer@example.com" },
          },
        ],
      },
    ]);

    const states = await listProposalDecisionStates(
      { kind: "user", user: { id: "u-1" } } as any,
      { workspaceId: "ws-1", proposalIds: ["proposal-review", "proposal-objected"] },
    );

    expect(states.get("proposal-review")).toMatchObject({
      needsReview: true,
      currentMemberDecision: null,
      currentUserOpenObjectionId: null,
    });
    expect(states.get("proposal-objected")).toMatchObject({
      needsReview: false,
      currentUserOpenObjectionId: "objection-1",
      openObjections: [
        expect.objectContaining({ bodyMd: "This creates risk." }),
      ],
    });
  });

  it("does not mark synthetic operator memberships as proposal reviewers", async () => {
    requireWorkspaceMembershipMock.mockResolvedValueOnce({
      id: "global-operator",
      workspaceId: "ws-1",
      userId: "operator-user",
      role: "ADMIN",
      isActive: true,
    });
    prismaMock.member.findMany.mockResolvedValue([{ id: "member-1" }, { id: "member-2" }]);
    prismaMock.approvalFlow.findMany.mockResolvedValue([
      {
        id: "flow-operator",
        workspaceId: "ws-1",
        subjectType: "PROPOSAL",
        subjectId: "proposal-operator",
        status: "ACTIVE",
        mode: "MAJORITY",
        openedAt: new Date("2026-05-26T12:00:00.000Z"),
        closesAt: null,
        quorumPercent: 50,
        minApproverCount: 1,
        decisions: [],
        objections: [],
      },
    ]);

    const states = await listProposalDecisionStates(
      { kind: "user", user: { id: "operator-user", globalRole: "OPERATOR" } } as any,
      { workspaceId: "ws-1", proposalIds: ["proposal-operator"] },
    );

    expect(states.get("proposal-operator")).toMatchObject({
      currentMemberDecision: null,
      currentUserOpenObjectionId: null,
      needsReview: false,
    });
  });
});

describe("withdrawActiveApprovalFlowForSubject", () => {
  it("marks an active flow withdrawn with cleanup metadata", async () => {
    const now = new Date("2026-05-26T12:00:00.000Z");
    prismaMock.approvalFlow.findFirst.mockResolvedValue({
      id: "flow-1",
      workspaceId: "ws-1",
      subjectType: "PROPOSAL",
      subjectId: "proposal-1",
    });

    await expect(withdrawActiveApprovalFlowForSubject(prismaMock, {
      workspaceId: "ws-1",
      subjectType: "PROPOSAL",
      subjectId: "proposal-1",
      cleanupReason: "Proposal archived",
      actorUserId: "u-1",
      now,
    })).resolves.toMatchObject({ id: "flow-1" });

    expect(prismaMock.approvalFlow.updateMany).toHaveBeenCalledWith({
      where: { id: "flow-1", status: "ACTIVE" },
      data: expect.objectContaining({
        status: "WITHDRAWN",
        closedAt: now,
        resultJson: expect.objectContaining({ cleanupReason: "Proposal archived" }),
      }),
    });
    expect(prismaMock.auditLog.create).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({
        action: "approval.withdrawn",
        entityId: "flow-1",
      }),
    }));
  });

  it("does not overwrite a flow that is no longer active", async () => {
    prismaMock.approvalFlow.findFirst.mockResolvedValue({
      id: "flow-1",
      workspaceId: "ws-1",
      subjectType: "PROPOSAL",
      subjectId: "proposal-1",
    });
    prismaMock.approvalFlow.updateMany.mockResolvedValue({ count: 0 });

    await expect(withdrawActiveApprovalFlowForSubject(prismaMock, {
      workspaceId: "ws-1",
      subjectType: "PROPOSAL",
      subjectId: "proposal-1",
      cleanupReason: "Proposal archived",
    })).resolves.toBeNull();

    expect(prismaMock.auditLog.create).not.toHaveBeenCalled();
  });
});

describe("finalizeExpiredApprovalFlows", () => {
  it("skips expired proposal flows", async () => {
    const expiredAt = new Date("2026-05-01T12:00:00.000Z");
    prismaMock.$queryRaw.mockResolvedValueOnce([
      { id: "flow-proposal" },
    ]);
    prismaMock.approvalFlow.findUnique.mockResolvedValue({
        id: "flow-proposal",
        workspaceId: "ws-1",
        subjectType: "PROPOSAL",
        subjectId: "p-1",
        status: "ACTIVE",
        mode: "CONSENT",
        quorumPercent: 0,
        minApproverCount: 1,
        closesAt: expiredAt,
        decisions: [],
        objections: [],
      });

    await expect(finalizeExpiredApprovalFlows()).resolves.toBe(0);

    expect(prismaMock.proposal.update).not.toHaveBeenCalled();
    expect(prismaMock.approvalFlow.update).not.toHaveBeenCalled();
  });
});
