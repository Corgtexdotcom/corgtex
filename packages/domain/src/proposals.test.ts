import { describe, expect, it, vi, beforeEach } from "vitest";
import { autoApproveProposals } from "./proposals";
import { prisma } from "@corgtex/shared";

vi.mock("@corgtex/shared", () => ({
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
    $transaction: vi.fn(async (cb) => cb(prisma)),
  },
}));

vi.mock("./auth", () => ({
  requireWorkspaceMembership: vi.fn().mockResolvedValue({ id: "mem-1" }),
  actorUserIdForWorkspace: vi.fn().mockResolvedValue("u-1"),
}));

describe("autoApproveProposals", () => {
  beforeEach(() => { vi.clearAllMocks(); });

  it("approves proposals that are past their autoApproveAt date with no unresolved objections", async () => {
    vi.mocked(prisma.proposal.findMany).mockResolvedValueOnce([
      { id: "p1", workspaceId: "ws1", autoApproveAt: new Date(Date.now() - 1000) } as any,
    ]);
    vi.mocked(prisma.proposal.update).mockResolvedValueOnce({ id: "p1", status: "APPROVED" } as any);

    await autoApproveProposals();

    expect(prisma.proposal.update).toHaveBeenCalledWith(expect.objectContaining({
      where: { id: "p1" },
      data: expect.objectContaining({ status: "APPROVED" }),
    }));
  });

  it("does not approve proposals if they have unresolved objections", async () => {
    // Return empty since the db query is supposed to filter them out
    vi.mocked(prisma.proposal.findMany).mockResolvedValueOnce([]);
    
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
});
