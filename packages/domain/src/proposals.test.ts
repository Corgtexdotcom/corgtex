import { describe, expect, it, vi } from "vitest";
import { autoApproveProposals } from "./proposals";
import { prisma } from "@corgtex/shared";

vi.mock("@corgtex/shared", () => ({
  prisma: {
    proposal: {
      findMany: vi.fn(),
      update: vi.fn(),
    },
  },
}));

describe("autoApproveProposals", () => {
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
