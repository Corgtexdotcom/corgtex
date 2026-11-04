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
      findMany: vi.fn().mockResolvedValue([]),
      upsert: vi.fn(),
    },
    approvalFlow: {
      create: vi.fn(),
      findMany: vi.fn(),
      findFirst: vi.fn(),
      findUnique: vi.fn(),
      update: vi.fn(),
      updateMany: vi.fn(),
    },
    user: { findMany: vi.fn() },
    objection: { findMany: vi.fn().mockResolvedValue([]) },
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
      findFirst: vi.fn().mockResolvedValue({ id: "proposal-finalize", workspaceId: "ws-1" }),
      findMany: vi.fn(),
      update: vi.fn(),
    },
  };
  mock.$executeRaw = vi.fn();
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

const lineage = vi.hoisted(() => ({
  readable: vi.fn(async (_actor, _workspaceId, _kind, records) => new Set(records.map((row: { id: string }) => row.id))),
  capture: vi.fn().mockResolvedValue([]),
  snapshot: vi.fn().mockResolvedValue([]),
  roots: vi.fn().mockResolvedValue([]),
  record: vi.fn(),
  invalidate: vi.fn(),
  advance: vi.fn(),
}));
vi.mock("./source-lineage", () => ({
  readableArtifactIds: lineage.readable,
  captureArtifactPermissionEpochs: vi.fn().mockResolvedValue({version: 1, entries: []}),
  captureArtifactReadHeadObservation: async (read: () => Promise<unknown>) => ({value: await read(), heads: new Map()}),
  captureReadableWorkItemInputs: async (actor: unknown, workspaceId: string, kind: string, rows: Array<{id: string}>) => ({
    ids: await lineage.readable(actor, workspaceId, kind, rows), roots: [], heads: new Map(),
  }),
  mergeLineageInputRoot: (_prior: unknown, root: unknown) => root,
  withArtifactCountReleaseSnapshot: async (_actor: unknown, _workspaceId: string, _roots: unknown,
    remote: () => Promise<void>, finish: (tx: unknown) => Promise<unknown>) => { await remote(); return finish(prismaMock); },
  captureArtifactInputProof: lineage.capture,
  captureArtifactInputSnapshotProof: lineage.snapshot,
  currentArtifactInputRoots: lineage.roots,
  recordArtifactInputLineage: lineage.record,
  invalidateArtifactInputLineage: lineage.invalidate,
  advanceHumanArtifactInputLineage: lineage.advance,
  lineageContentFingerprint: vi.fn().mockReturnValue("a".repeat(64)),
  preserveUnknownArtifactInputSnapshot: vi.fn(),
}));

vi.mock("./source-permission-epochs", () => ({
  capturePermissionEpochs: vi.fn().mockResolvedValue({version: 1, entries: []}),
  isArtifactPermissionEpochProofCurrent: vi.fn().mockResolvedValue(true),
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
  prismaMock.$queryRaw.mockResolvedValue([]);
  prismaMock.user.findMany.mockImplementation(async () => {
    const members = await prismaMock.member.findMany.mock.results[0]?.value ?? [];
    const flows = await prismaMock.approvalFlow.findMany.mock.results[0]?.value ?? [];
    const users = new Map(members.filter((member: any) => member.user).map((member: any) =>
      [member.user.id, {id: member.user.id, displayName: member.user.displayName, email: member.user.email}]));
    for (const flow of flows) for (const objection of flow.objections ?? []) if (objection.user) users.set(objection.userId,
      {id: objection.userId, displayName: objection.user.displayName, email: objection.user.email});
    return [...users.values()];
  });
  prismaMock.approvalDecision.upsert.mockResolvedValue({});
  prismaMock.approvalFlow.update.mockResolvedValue({});
  prismaMock.auditLog.create.mockResolvedValue({});
  prismaMock.approvalFlow.findMany.mockResolvedValue([]);
  prismaMock.approvalFlow.findFirst.mockResolvedValue(null);
  prismaMock.approvalFlow.updateMany.mockResolvedValue({ count: 1 });
  prismaMock.proposal.findMany.mockImplementation(async ({ where }: any) => (where?.id?.in ?? []).map((id: string) => ({ id, workspaceId: "ws-1", title: "Proposal", authorUserId: "author" })));
  prismaMock.proposal.update.mockResolvedValue({ id: "p-1" });
  prismaMock.policyCorpus.upsert.mockResolvedValue({});
  prismaMock.$executeRaw.mockResolvedValue(1);
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
        decisions: [{ memberId: "member-1", choice: "APPROVE" }],
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

  it("rejects proposal author approval decisions", async () => {
    const currentFlow = {
      id: "flow-proposal",
      workspaceId: "ws-1",
      subjectType: "PROPOSAL",
      subjectId: "p-1",
      status: "ACTIVE",
      mode: "CONSENT",
      quorumPercent: 0,
      minApproverCount: 1,
      closesAt: null,
      decisions: [],
      objections: [],
    };
    prismaMock.approvalFlow.findUnique.mockResolvedValueOnce(currentFlow);
    prismaMock.proposal.findMany.mockResolvedValueOnce([{ id: "p-1", authorUserId: "u-1" }]);

    await expect(recordApprovalDecision(
      { kind: "user", user: { id: "u-1" } } as any,
      { workspaceId: "ws-1", flowId: "flow-proposal", choice: "AGREE" },
    )).rejects.toThrow(/Proposal authors cannot review their own proposal/);

    expect(prismaMock.approvalDecision.upsert).not.toHaveBeenCalled();
    expect(prismaMock.approvalFlow.update).not.toHaveBeenCalled();
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
        objections: [],
      },
      {
        id: "flow-archived-proposal",
        workspaceId: "ws-1",
        subjectType: "PROPOSAL",
        subjectId: "proposal-archived",
        status: "ACTIVE",
        createdAt: new Date("2026-05-26T11:00:00.000Z"),
        decisions: [],
        objections: [],
      },
      {
        id: "flow-private-proposal",
        workspaceId: "ws-1",
        subjectType: "PROPOSAL",
        subjectId: "proposal-private",
        status: "ACTIVE",
        createdAt: new Date("2026-05-26T10:00:00.000Z"),
        decisions: [],
        objections: [],
      },
      {
        id: "flow-missing-proposal",
        workspaceId: "ws-1",
        subjectType: "PROPOSAL",
        subjectId: "proposal-missing",
        status: "ACTIVE",
        createdAt: new Date("2026-05-26T07:00:00.000Z"),
        decisions: [],
        objections: [],
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
  it("excludes the author from the roster and shows who still owes a review", async () => {
    requireWorkspaceMembershipMock.mockResolvedValueOnce({
      id: "reviewer-1", workspaceId: "ws-1", userId: "u-1", role: "MEMBER", isActive: true,
    });
    prismaMock.member.findMany.mockResolvedValue([
      { id: "author-member", userId: "author", user: { id: "author", displayName: "Author", email: "author@example.com" } },
      { id: "reviewer-1", userId: "u-1", user: { id: "u-1", displayName: "Reviewer One", email: "one@example.com" } },
      { id: "reviewer-2", userId: "u-2", user: { id: "u-2", displayName: "Reviewer Two", email: "two@example.com" } },
    ]);
    prismaMock.proposal.findMany.mockResolvedValue([{ id: "p-1", authorUserId: "author" }]);
    prismaMock.approvalFlow.findMany.mockResolvedValue([{
      id: "flow-1", subjectId: "p-1", mode: "CONSENT", openedAt: new Date(), closesAt: null,
      quorumPercent: 0, minApproverCount: 1,
      decisions: [{ memberId: "reviewer-1", choice: "AGREE", rationale: null, updatedAt: new Date() }],
      objections: [],
    }]);

    const states = await listProposalDecisionStates(
      { kind: "user", user: { id: "u-1" } } as any,
      { workspaceId: "ws-1", proposalIds: ["p-1"] },
    );
    expect(states.get("p-1")).toMatchObject({
      eligibleApprovers: 2,
      canReview: true,
      needsReview: false,
      reviewers: [
        { name: "Reviewer One", choice: "AGREE" },
        { name: "Reviewer Two", choice: null },
      ],
    });
  });

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
      canReview: true,
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
      canReview: true,
      needsReview: true,
      currentMemberDecision: null,
      currentUserOpenObjectionId: null,
    });
    expect(states.get("proposal-objected")).toMatchObject({
      canReview: true,
      needsReview: false,
      currentUserOpenObjectionId: "objection-1",
      openObjections: [
        expect.objectContaining({ bodyMd: "This creates risk." }),
      ],
    });
  });

  it("does not mark proposal authors as needing to review their own proposal", async () => {
    prismaMock.member.findMany.mockResolvedValue([{ id: "member-1" }, { id: "member-2" }]);
    prismaMock.proposal.findMany.mockResolvedValueOnce([{ id: "proposal-authored", authorUserId: "u-1" }]);
    prismaMock.approvalFlow.findMany.mockResolvedValue([
      {
        id: "flow-authored",
        workspaceId: "ws-1",
        subjectType: "PROPOSAL",
        subjectId: "proposal-authored",
        status: "ACTIVE",
        mode: "CONSENT",
        openedAt: new Date("2026-05-26T12:00:00.000Z"),
        closesAt: new Date("2026-05-29T12:00:00.000Z"),
        quorumPercent: 0,
        minApproverCount: 1,
        decisions: [],
        objections: [],
      },
    ]);

    const states = await listProposalDecisionStates(
      { kind: "user", user: { id: "u-1" } } as any,
      { workspaceId: "ws-1", proposalIds: ["proposal-authored"] },
    );

    expect(states.get("proposal-authored")).toMatchObject({
      canReview: false,
      needsReview: false,
      currentMemberDecision: null,
      currentUserOpenObjectionId: null,
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
      canReview: false,
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

  it("takes the Proposal advisory lock before approval-flow and Proposal finalization writes", async () => {
    const expiredAt = new Date("2026-05-01T12:00:00.000Z");
    let subjectTypeReadCount = 0;
    // This mutable seam reaches the guarded internal Proposal outcome branch only;
    // public expiry behavior still excludes Proposal flows and is not represented here.
    const flow = {
      id: "flow-proposal-finalize",
      workspaceId: "ws-1",
      subjectId: "proposal-finalize",
      status: "ACTIVE",
      mode: "CONSENT",
      quorumPercent: 0,
      minApproverCount: 1,
      closesAt: expiredAt,
      decisions: [],
      objections: [],
      get subjectType() {
        subjectTypeReadCount += 1;
        return subjectTypeReadCount === 1 ? "ACTION" : "PROPOSAL";
      },
    };
    prismaMock.$queryRaw.mockResolvedValueOnce([{ id: flow.id }]);
    prismaMock.approvalFlow.findUnique.mockResolvedValueOnce(flow);
    prismaMock.proposal.update.mockResolvedValueOnce({
      id: "proposal-finalize",
      workspaceId: "ws-1",
      title: "Proposal",
      bodyMd: "Body",
      circleId: null,
      decidedAt: new Date(),
    });

    await expect(finalizeExpiredApprovalFlows()).resolves.toBe(1);

    expect(prismaMock.$executeRaw).toHaveBeenCalledWith(expect.anything(), "Proposal:proposal-finalize");
    expect(prismaMock.$executeRaw).toHaveBeenCalledTimes(2);
    const proposalLockOrder = prismaMock.$executeRaw.mock.invocationCallOrder[0];
    const corpusLockOrder = prismaMock.$executeRaw.mock.invocationCallOrder[1];
    expect(proposalLockOrder).toBeLessThan(corpusLockOrder);
    expect(corpusLockOrder).toBeLessThan(prismaMock.approvalFlow.update.mock.invocationCallOrder[0]);
    expect(corpusLockOrder).toBeLessThan(prismaMock.proposal.update.mock.invocationCallOrder[0]);
    expect(corpusLockOrder).toBeLessThan(prismaMock.policyCorpus.upsert.mock.invocationCallOrder[0]);
  });
});


describe("approval lineage boundaries", () => {
  const actor = { kind: "user", user: { id: "u-1" } } as any;
  const current = { id: "flow-safe", workspaceId: "ws-1", subjectType: "PROPOSAL", subjectId: "p-1",
    status: "ACTIVE", mode: "CONSENT", quorumPercent: 0, minApproverCount: 1,
    closesAt: new Date("2030-01-01"), decisions: [], objections: [] };

  it("rejects an unknown or revoked flow before saving a decision or calculating a reply", async () => {
    prismaMock.approvalFlow.findUnique.mockResolvedValueOnce(current);
    lineage.readable.mockImplementationOnce(async () => new Set());
    await expect(recordApprovalDecision(actor, { workspaceId: "ws-1", flowId: current.id, choice: "AGREE" }))
      .rejects.toMatchObject({ code: "UNKNOWN_LINEAGE" });
    expect(prismaMock.approvalDecision.upsert).not.toHaveBeenCalled();
    expect(prismaMock.approvalFlow.update).not.toHaveBeenCalled();
  });

  it("saves the human decision proof before the complete driver proof is used for the generated flow outcome", async () => {
    const subjectRoot = { kind: "ArtifactInputSnapshot", id: "subject-snapshot", fingerprint: "a".repeat(64) };
    const storedDecision = { id: "decision-1", flowId: current.id, memberId: "member-1", choice: "AGREE", rationale: "Safe to try", createdAt: new Date(), updatedAt: new Date() };
    const member = { id: "member-1", workspaceId: "ws-1", userId: "u-1", isActive: true, memberType: "HUMAN", role: "MEMBER", joinedAt: new Date(), user: { id: "u-1", displayName: "Reviewer", email: "reviewer@example.com" } };
    prismaMock.member.findMany.mockResolvedValue([member]);
    prismaMock.approvalFlow.findUnique.mockResolvedValueOnce(current).mockResolvedValueOnce({ ...current, decisions: [storedDecision] });
    prismaMock.approvalDecision.upsert.mockResolvedValueOnce(storedDecision);
    lineage.snapshot.mockResolvedValueOnce([subjectRoot]);
    const decisionRoot = { kind: "ApprovalDecision", id: storedDecision.id, fingerprint: "b".repeat(64) };
    lineage.capture.mockResolvedValueOnce([decisionRoot]);
    await recordApprovalDecision(actor, { workspaceId: "ws-1", flowId: current.id, choice: "AGREE", rationale: "Safe to try" });
    expect(lineage.record).toHaveBeenNthCalledWith(1, expect.objectContaining({
      tx: prismaMock, actor, artifact: { kind: "ApprovalDecision", id: storedDecision.id }, content: storedDecision,
      inheritedRoots: [subjectRoot], origin: "DERIVED",
    }));
    expect(lineage.capture).toHaveBeenCalledWith(actor, "ws-1", [
      { kind: "Member", id: member.id, snapshot: member },
      { kind: "ApprovalDecision", id: storedDecision.id, snapshot: storedDecision },
    ], prismaMock);
    expect(lineage.record).toHaveBeenNthCalledWith(2, expect.objectContaining({ artifact: { kind: "ApprovalFlow", id: current.id }, inheritedRoots: [decisionRoot] }));
    expect(lineage.record.mock.invocationCallOrder[0]).toBeLessThan(lineage.capture.mock.invocationCallOrder[0]);
  });

  it("replaces prior outcome drivers with current choices and preserves the previous human choice as history", async () => {
    const oldDecision = { id: "changed-decision", flowId: current.id, memberId: "member-1", choice: "AGREE", rationale: "First rationale" };
    const newDecision = { ...oldDecision, choice: "ABSTAIN", rationale: "Changed rationale" };
    const configRoot = { kind: "ApprovalPolicy", id: "config-policy", fingerprint: "a".repeat(64) };
    const oldDecisionRoot = { kind: "ApprovalDecision", id: oldDecision.id, fingerprint: "b".repeat(64) };
    const newDecisionRoot = { kind: "ApprovalDecision", id: newDecision.id, fingerprint: "c".repeat(64) };
    lineage.roots.mockResolvedValueOnce([configRoot, oldDecisionRoot]);
    lineage.capture.mockResolvedValueOnce([newDecisionRoot]);
    prismaMock.approvalFlow.findUnique.mockResolvedValueOnce({ ...current, decisions: [oldDecision] }).mockResolvedValueOnce({ ...current, decisions: [newDecision] });
    prismaMock.approvalDecision.upsert.mockResolvedValueOnce(newDecision);
    await recordApprovalDecision(actor, { workspaceId: "ws-1", flowId: current.id, choice: "ABSTAIN", rationale: "Changed rationale" });
    expect(lineage.snapshot).toHaveBeenCalledWith(actor, "ws-1", expect.objectContaining({ kind: "ApprovalDecision", id: oldDecision.id, fingerprint: expect.any(String) }), prismaMock);
    expect(lineage.snapshot.mock.invocationCallOrder.at(-1)).toBeLessThan(prismaMock.approvalDecision.upsert.mock.invocationCallOrder[0]);
    expect(lineage.record).toHaveBeenLastCalledWith(expect.objectContaining({ artifact: { kind: "ApprovalFlow", id: current.id }, inheritedRoots: [configRoot, newDecisionRoot] }));
  });

  it("omits an entire decision state when a current child proof is restricted", async () => {
    prismaMock.proposal.findMany.mockResolvedValueOnce([{ id: "p-1", authorUserId: "author" }]);
    prismaMock.approvalFlow.findMany.mockResolvedValueOnce([{ ...current, decisions: [{ id: "private-decision", memberId: "member-1", choice: "AGREE", rationale: "Hidden rationale" }] }]);
    lineage.readable.mockImplementation(async (_actor, _workspace, kind, rows) => new Set(kind === "ApprovalDecision" ? [] : rows.map((row: { id: string }) => row.id)));
    try {
      const result = await listProposalDecisionStates(actor, { workspaceId: "ws-1", proposalIds: ["p-1"] });
      expect(result.size).toBe(0);
      expect(JSON.stringify([...result])).not.toContain("Hidden rationale");
    } finally {
      lineage.readable.mockImplementation(async (_actor, _workspace, _kind, rows) => new Set(rows.map((row: { id: string }) => row.id)));
    }
  });

  it("skips unknown expiry flows with the explicit workspace-scoped actor", async () => {
    prismaMock.$queryRaw.mockResolvedValueOnce([{ id: "flow-unknown" }]);
    prismaMock.approvalFlow.findUnique.mockResolvedValueOnce({ ...current, id: "flow-unknown", subjectType: "ACTION" });
    lineage.readable.mockImplementationOnce(async () => new Set());
    await expect(finalizeExpiredApprovalFlows()).resolves.toBe(0);
    expect(lineage.readable).toHaveBeenCalledWith(expect.objectContaining({ kind: "agent", authProvider: "bootstrap", workspaceIds: ["ws-1"] }), "ws-1", "ApprovalFlow", expect.any(Array), prismaMock);
    expect(prismaMock.approvalFlow.update).not.toHaveBeenCalled();
  });

  it("does not manufacture a proof when a flow producer provides no actor", async () => {
    const { ensureApprovalFlow } = await import("./approvals");
    prismaMock.approvalFlow.findUnique.mockResolvedValueOnce(null);
    const stored = { ...current, id: "flow-created" };
    prismaMock.approvalFlow.create.mockResolvedValueOnce(stored);
    await ensureApprovalFlow(prismaMock, { workspaceId: "ws-1", subjectType: "PROPOSAL", subjectId: "p-1", policy: { id: "policy-1", mode: "CONSENT", quorumPercent: 0, minApproverCount: 1 } as any });
    expect(lineage.invalidate).toHaveBeenCalledWith({ tx: prismaMock, workspaceId: "ws-1", artifact: { kind: "ApprovalFlow", id: stored.id }, content: stored });
    expect(lineage.record).not.toHaveBeenCalled();
  });
});


it("preserves unknown approval child bodies as history without creating a readable receipt", async () => {
  const { preserveApprovalFlowHistory } = await import("./approvals");
  const { preserveUnknownArtifactInputSnapshot } = await import("./source-lineage");
  const { AppError } = await import("./errors");
  const actor = { kind: "user", user: { id: "u-1" } } as any;
  const flow = { id: "history-flow", workspaceId: "ws-1", subjectType: "PROPOSAL", subjectId: "p-1", status: "ACTIVE" };
  const decision = { id: "history-decision", flowId: flow.id, choice: "AGREE", rationale: "Original human rationale", memberId: "member-1" };
  const objection = { id: "history-objection", flowId: flow.id, userId: "u-1", bodyMd: "Original objection body", resolvedAt: null };
  prismaMock.approvalDecision.findMany.mockResolvedValueOnce([decision]);
  prismaMock.objection.findMany.mockResolvedValueOnce([objection]);
  lineage.snapshot.mockRejectedValueOnce(new AppError(409, "UNKNOWN_LINEAGE", "Legacy flow"))
    .mockRejectedValueOnce(new AppError(409, "UNKNOWN_LINEAGE", "Legacy decision"))
    .mockRejectedValueOnce(new AppError(409, "SOURCE_RESTRICTED", "Legacy objection"));
  await preserveApprovalFlowHistory(prismaMock, actor, "ws-1", flow as any);
  expect(preserveUnknownArtifactInputSnapshot).toHaveBeenCalledWith(prismaMock, "ws-1", { kind: "ApprovalDecision", id: decision.id }, decision);
  expect(preserveUnknownArtifactInputSnapshot).toHaveBeenCalledWith(prismaMock, "ws-1", { kind: "Objection", id: objection.id }, objection);
  expect(lineage.record).not.toHaveBeenCalled();
});
