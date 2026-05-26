import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  calculateApprovalOutcome,
  finalizeExpiredApprovalFlows,
  listActionableApprovalFlows,
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
    spendRequest: {
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
  prismaMock.proposal.findMany.mockResolvedValue([]);
  prismaMock.proposal.update.mockResolvedValue({ id: "p-1" });
  prismaMock.policyCorpus.upsert.mockResolvedValue({});
  prismaMock.spendRequest.findMany.mockResolvedValue([]);
  prismaMock.spendRequest.update.mockResolvedValue({ id: "spend-1" });
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
        id: "flow-resolved-spend",
        workspaceId: "ws-1",
        subjectType: "SPEND",
        subjectId: "spend-resolved",
        status: "ACTIVE",
        createdAt: new Date("2026-05-26T09:00:00.000Z"),
        decisions: [],
      },
      {
        id: "flow-open-spend",
        workspaceId: "ws-1",
        subjectType: "SPEND",
        subjectId: "spend-open",
        status: "ACTIVE",
        createdAt: new Date("2026-05-26T08:00:00.000Z"),
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
    prismaMock.spendRequest.findMany.mockResolvedValue([
      { id: "spend-resolved", description: "Resolved spend", status: "RESOLVED", archivedAt: null },
      { id: "spend-open", description: "Open spend", status: "OPEN", archivedAt: null },
    ]);

    await expect(listActionableApprovalFlows({ kind: "user", user: { id: "u-1" } } as any, "ws-1")).resolves.toMatchObject({
      total: 2,
      items: [
        { id: "flow-open-proposal", subjectLabel: "Open proposal" },
        { id: "flow-open-spend", subjectLabel: "Open spend" },
      ],
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

    expect(prismaMock.approvalFlow.update).toHaveBeenCalledWith({
      where: { id: "flow-1" },
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
});

describe("finalizeExpiredApprovalFlows", () => {
  it("skips expired proposal flows but still finalizes expired spend flows", async () => {
    const expiredAt = new Date("2026-05-01T12:00:00.000Z");
    prismaMock.$queryRaw.mockResolvedValueOnce([
      { id: "flow-proposal" },
      { id: "flow-spend" },
    ]);
    prismaMock.approvalFlow.findUnique.mockImplementation(({ where }: any) => {
      if (where.id === "flow-proposal") {
        return Promise.resolve({
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
      }
      return Promise.resolve({
        id: "flow-spend",
        workspaceId: "ws-1",
        subjectType: "SPEND",
        subjectId: "spend-1",
        status: "ACTIVE",
        mode: "CONSENT",
        quorumPercent: 0,
        minApproverCount: 1,
        closesAt: expiredAt,
        decisions: [],
        objections: [],
      });
    });

    await expect(finalizeExpiredApprovalFlows()).resolves.toBe(1);

    expect(prismaMock.proposal.update).not.toHaveBeenCalled();
    expect(prismaMock.spendRequest.update).toHaveBeenCalledWith({
      where: { id: "spend-1" },
      data: { status: "RESOLVED", resolutionOutcome: "APPROVED" },
    });
    expect(prismaMock.approvalFlow.update).toHaveBeenCalledWith(expect.objectContaining({
      where: { id: "flow-spend" },
      data: expect.objectContaining({ status: "APPROVED" }),
    }));
  });
});
