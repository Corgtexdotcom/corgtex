import { describe, expect, it, vi, beforeEach } from "vitest";
import { autoApproveProposals } from "./proposals";
import { prisma } from "@corgtex/shared";

vi.mock("@corgtex/shared", () => ({
  logger: {
    error: vi.fn(),
  },
  prisma: {
    proposal: {
      findMany: vi.fn(),
      findFirst: vi.fn(),
      update: vi.fn(),
      findUniqueOrThrow: vi.fn(),
    },
    auditLog: {
      create: vi.fn(),
    },
    event: {
      createMany: vi.fn(),
    },
    deliberationEntry: {
      count: vi.fn(),
      updateMany: vi.fn(),
    },
    proposalReaction: {
      count: vi.fn(),
      updateMany: vi.fn(),
    },
    approvalFlow: {
      findUnique: vi.fn(),
      update: vi.fn(),
    },
    approvalDecision: {
      deleteMany: vi.fn(),
    },
    objection: {
      deleteMany: vi.fn(),
    },
    $transaction: vi.fn(async (cb) => cb(prisma)),
  },
}));

vi.mock("./auth", () => ({
  requireWorkspaceMembership: vi.fn().mockResolvedValue({
    id: "mem-1",
    workspaceId: "ws-1",
    userId: "u-1",
    role: "MEMBER",
    isActive: true,
  }),
  actorUserIdForWorkspace: vi.fn().mockResolvedValue("u-1"),
}));

vi.mock("./events", () => ({
  appendEvents: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("./approvals", () => ({
  ensureApprovalFlow: vi.fn().mockResolvedValue({ id: "flow-1" }),
  getApprovalPolicy: vi.fn().mockResolvedValue({
    mode: "CONSENT",
    decisionWindowHours: 168,
    requireProposalLink: false,
  }),
}));

describe("autoApproveProposals", () => {
  beforeEach(() => { vi.clearAllMocks(); });

  it("approves proposals that are past their autoApproveAt date with no unresolved objections", async () => {
    vi.mocked(prisma.proposal.findMany).mockResolvedValueOnce([
      { id: "p1", workspaceId: "ws1", autoApproveAt: new Date(Date.now() - 1000) } as any,
    ]);
    vi.mocked(prisma.deliberationEntry.count).mockResolvedValueOnce(0 as any);
    vi.mocked(prisma.proposalReaction.count).mockResolvedValueOnce(0 as any);
    vi.mocked(prisma.proposal.update).mockResolvedValueOnce({ id: "p1", status: "RESOLVED", resolutionOutcome: "ADOPTED" } as any);

    await autoApproveProposals();

    expect(prisma.proposal.update).toHaveBeenCalledWith(expect.objectContaining({
      where: { id: "p1" },
      data: expect.objectContaining({ status: "RESOLVED", resolutionOutcome: "ADOPTED" }),
    }));
  });

  it("does not approve proposals if they have unresolved objections", async () => {
    vi.mocked(prisma.proposal.findMany).mockResolvedValueOnce([
      { id: "p1", workspaceId: "ws1", autoApproveAt: new Date(Date.now() - 1000) } as any,
    ]);
    vi.mocked(prisma.deliberationEntry.count).mockResolvedValueOnce(1 as any);
    vi.mocked(prisma.proposalReaction.count).mockResolvedValueOnce(0 as any);

    await autoApproveProposals();

    expect(prisma.proposal.update).not.toHaveBeenCalled();
  });

  it("does not approve proposals if they have unresolved legacy reaction objections", async () => {
    vi.mocked(prisma.proposal.findMany).mockResolvedValueOnce([
      { id: "p1", workspaceId: "ws1", autoApproveAt: new Date(Date.now() - 1000) } as any,
    ]);
    vi.mocked(prisma.deliberationEntry.count).mockResolvedValueOnce(0 as any);
    vi.mocked(prisma.proposalReaction.count).mockResolvedValueOnce(1 as any);

    await autoApproveProposals();

    expect(prisma.proposal.update).not.toHaveBeenCalled();
  });
});

describe("getProposal", () => {
  beforeEach(() => { vi.clearAllMocks(); });

  it("applies the privacy filter to direct proposal lookups", async () => {
    const { getProposal } = await import("./proposals");
    const { requireWorkspaceMembership } = await import("./auth");

    vi.mocked(prisma.proposal.findFirst).mockResolvedValueOnce({
      id: "p-private",
      workspaceId: "ws-1",
      authorUserId: "u-1",
      title: "Private proposal",
      bodyMd: "Body",
      isPrivate: true,
    } as any);

    const actor = { kind: "user", user: { id: "u-1" } } as any;
    await getProposal(actor, { workspaceId: "ws-1", proposalId: "p-private" });

    expect(requireWorkspaceMembership).toHaveBeenCalledWith({
      actor,
      workspaceId: "ws-1",
    });
    expect(prisma.proposal.findFirst).toHaveBeenCalledWith(expect.objectContaining({
      where: {
        id: "p-private",
        workspaceId: "ws-1",
        archivedAt: null,
        OR: [
          { isPrivate: false },
          { isPrivate: true, status: "DRAFT", authorUserId: "u-1" },
        ],
      },
    }));
  });

  it("does not expose private proposals to non-authors by direct id", async () => {
    const { getProposal } = await import("./proposals");

    vi.mocked(prisma.proposal.findFirst).mockResolvedValueOnce(null);

    const actor = { kind: "user", user: { id: "u-2" } } as any;
    await expect(getProposal(actor, { workspaceId: "ws-1", proposalId: "p-private" })).rejects.toThrow("Proposal not found.");
  });

  it("lets workspace admins see private proposal drafts", async () => {
    const { getProposal } = await import("./proposals");
    const { requireWorkspaceMembership } = await import("./auth");

    vi.mocked(requireWorkspaceMembership).mockResolvedValueOnce({
      id: "mem-admin",
      workspaceId: "ws-1",
      userId: "u-admin",
      role: "ADMIN",
      isActive: true,
    } as any);
    vi.mocked(prisma.proposal.findFirst).mockResolvedValueOnce({
      id: "p-private",
      workspaceId: "ws-1",
      authorUserId: "u-1",
      title: "Private proposal",
      bodyMd: "Body",
      isPrivate: true,
      status: "DRAFT",
    } as any);

    const actor = { kind: "user", user: { id: "u-admin", globalRole: "USER" } } as any;
    await expect(getProposal(actor, { workspaceId: "ws-1", proposalId: "p-private" })).resolves.toMatchObject({
      id: "p-private",
    });

    expect(prisma.proposal.findFirst).toHaveBeenCalledWith(expect.objectContaining({
      where: {
        id: "p-private",
        workspaceId: "ws-1",
        archivedAt: null,
        OR: [
          { isPrivate: false },
          { isPrivate: true, status: "DRAFT" },
        ],
      },
    }));
  });
});

describe("submitProposal event payload", () => {
  beforeEach(() => { vi.clearAllMocks(); });

  it("emits proposal.opened event with title in the payload", async () => {
    const { appendEvents } = await import("./events");

    // Mock findUnique used inside submitProposal to fetch the draft
    (prisma.proposal as any).findUnique = vi.fn().mockResolvedValue({
      id: "p-1",
      workspaceId: "ws-1",
      title: "Adopt async standup policy",
      authorUserId: "u-1",
      status: "DRAFT",
      archivedAt: null,
    });

    (prisma.proposal as any).update = vi.fn().mockResolvedValue({
      id: "p-1",
      status: "OPEN",
    });
    vi.mocked((prisma as any).approvalFlow.update).mockResolvedValue({});

    const { submitProposal } = await import("./proposals");
    const actor = { kind: "user", user: { id: "u-1" } } as any;

    await submitProposal(actor, {
      workspaceId: "ws-1",
      proposalId: "p-1",
    });

    expect(appendEvents).toHaveBeenCalledWith(
      expect.anything(),
      expect.arrayContaining([
        expect.objectContaining({
          type: "proposal.opened",
          payload: expect.objectContaining({
            title: "Adopt async standup policy",
          }),
        }),
      ]),
    );
  });

  it("returns an open proposal to draft and clears stale approval state", async () => {
    const { appendEvents } = await import("./events");
    const { returnProposalToDraft } = await import("./proposals");

    (prisma.proposal as any).findUnique = vi.fn().mockResolvedValue({
      id: "p-1",
      workspaceId: "ws-1",
      title: "Adopt async standup policy",
      authorUserId: "u-1",
      status: "OPEN",
      archivedAt: null,
    });
    vi.mocked((prisma as any).approvalFlow.findUnique).mockResolvedValue({ id: "flow-1" });
    vi.mocked((prisma as any).approvalDecision.deleteMany).mockResolvedValue({ count: 2 });
    vi.mocked((prisma as any).objection.deleteMany).mockResolvedValue({ count: 1 });
    vi.mocked((prisma as any).approvalFlow.update).mockResolvedValue({});
    vi.mocked((prisma as any).deliberationEntry.updateMany).mockResolvedValue({ count: 1 });
    vi.mocked((prisma as any).proposalReaction.updateMany).mockResolvedValue({ count: 1 });
    vi.mocked((prisma.proposal as any).update).mockResolvedValue({
      id: "p-1",
      status: "DRAFT",
      isPrivate: true,
      publishedAt: null,
      autoApproveAt: null,
    });

    const actor = { kind: "user", user: { id: "u-1" } } as any;
    await expect(returnProposalToDraft(actor, {
      workspaceId: "ws-1",
      proposalId: "p-1",
    })).resolves.toMatchObject({
      id: "p-1",
      status: "DRAFT",
      isPrivate: true,
    });

    expect((prisma as any).approvalDecision.deleteMany).toHaveBeenCalledWith({ where: { flowId: "flow-1" } });
    expect((prisma as any).objection.deleteMany).toHaveBeenCalledWith({ where: { flowId: "flow-1" } });
    expect((prisma as any).approvalFlow.update).toHaveBeenCalledWith(expect.objectContaining({
      where: { id: "flow-1" },
      data: expect.objectContaining({
        status: "DRAFT",
        openedAt: null,
        closesAt: null,
        closedAt: null,
      }),
    }));
    expect((prisma.proposal as any).update).toHaveBeenCalledWith(expect.objectContaining({
      where: { id: "p-1" },
      data: expect.objectContaining({
        status: "DRAFT",
        isPrivate: true,
        publishedAt: null,
        autoApproveAt: null,
      }),
    }));
    expect(appendEvents).toHaveBeenCalledWith(
      expect.anything(),
      expect.arrayContaining([
        expect.objectContaining({ type: "proposal.returned_to_draft" }),
      ]),
    );
  });
});
