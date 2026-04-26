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
    },
    proposalReaction: {
      count: vi.fn(),
    },
    $transaction: vi.fn(async (cb) => cb(prisma)),
  },
}));

vi.mock("./auth", () => ({
  requireWorkspaceMembership: vi.fn().mockResolvedValue({ id: "mem-1" }),
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
          { isPrivate: true, authorUserId: "u-1" },
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

  it("does not let workspace admins bypass private proposal ownership", async () => {
    const { getProposal } = await import("./proposals");
    const { requireWorkspaceMembership } = await import("./auth");

    vi.mocked(requireWorkspaceMembership).mockResolvedValueOnce({
      id: "mem-admin",
      workspaceId: "ws-1",
      userId: "u-admin",
      role: "ADMIN",
      isActive: true,
    } as any);
    vi.mocked(prisma.proposal.findFirst).mockResolvedValueOnce(null);

    const actor = { kind: "user", user: { id: "u-admin", globalRole: "USER" } } as any;
    await expect(getProposal(actor, { workspaceId: "ws-1", proposalId: "p-private" })).rejects.toThrow("Proposal not found.");

    expect(prisma.proposal.findFirst).toHaveBeenCalledWith(expect.objectContaining({
      where: {
        id: "p-private",
        workspaceId: "ws-1",
        archivedAt: null,
        OR: [
          { isPrivate: false },
          { isPrivate: true, authorUserId: "u-admin" },
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
      status: "DRAFT",
    });

    // Mock the update and approvalFlow.update
    (prisma.proposal as any).update = vi.fn().mockResolvedValue({
      id: "p-1",
      status: "OPEN",
    });
    (prisma as any).approvalFlow = {
      update: vi.fn().mockResolvedValue({}),
    };

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
});
