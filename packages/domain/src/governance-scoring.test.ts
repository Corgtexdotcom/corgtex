import { beforeEach, describe, expect, it, vi } from "vitest";

const { prismaMock, requireWorkspaceMembershipMock, refreshImpactFootprintsMock } = vi.hoisted(() => ({
  prismaMock: {
    approvalFlow: {
      findMany: vi.fn(),
    },
    member: {
      count: vi.fn(),
    },
    proposal: {
      count: vi.fn(),
    },
    policyCorpus: {
      count: vi.fn(),
    },
    tension: {
      findMany: vi.fn(),
    },
    constitution: {
      findFirst: vi.fn(),
    },
    governanceScore: {
      create: vi.fn(),
    },
  },
  requireWorkspaceMembershipMock: vi.fn(),
  refreshImpactFootprintsMock: vi.fn(),
}));

vi.mock("@corgtex/shared", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@corgtex/shared")>();
  return {
    ...actual,
    prisma: prismaMock,
    toInputJson: (v: any) => JSON.parse(JSON.stringify(v ?? null)),
  };
});

vi.mock("./auth", () => ({
  requireWorkspaceMembership: requireWorkspaceMembershipMock,
}));

vi.mock("./impact-footprint", () => ({
  refreshImpactFootprints: refreshImpactFootprintsMock,
}));

import { recalculateGovernanceScore } from "./governance-scoring";

describe("recalculateGovernanceScore", () => {
  beforeEach(() => {
    requireWorkspaceMembershipMock.mockReset().mockResolvedValue({
      workspaceId: "ws-1",
      userId: "user-1",
      role: "ADMIN",
      isActive: true,
    });
    prismaMock.approvalFlow.findMany.mockReset().mockResolvedValue([]);
    prismaMock.member.count.mockReset().mockResolvedValue(3);
    prismaMock.proposal.count.mockReset().mockResolvedValue(0);
    prismaMock.policyCorpus.count.mockReset().mockResolvedValue(0);
    prismaMock.tension.findMany.mockReset().mockResolvedValue([]);
    prismaMock.constitution.findFirst.mockReset().mockResolvedValue(null);
    prismaMock.governanceScore.create.mockReset().mockResolvedValue({
      id: "score-1",
      overallScore: 0,
    });
    refreshImpactFootprintsMock.mockReset().mockResolvedValue([]);
  });

  it("requires facilitator or admin membership before recording a score", async () => {
    const actor = {
      kind: "user" as const,
      user: {
        id: "user-1",
        email: "facilitator@example.com",
        displayName: "Facilitator",
      },
    };
    const periodStart = new Date("2026-03-01T00:00:00.000Z");
    const periodEnd = new Date("2026-03-31T00:00:00.000Z");

    await recalculateGovernanceScore(actor, "ws-1", periodStart, periodEnd);

    expect(requireWorkspaceMembershipMock).toHaveBeenCalledWith({
      actor,
      workspaceId: "ws-1",
      allowedRoles: ["FACILITATOR", "ADMIN"],
    });
    expect(prismaMock.governanceScore.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        workspaceId: "ws-1",
        periodStart,
        periodEnd,
      }),
    });
    expect(refreshImpactFootprintsMock).toHaveBeenCalledWith("ws-1", periodStart, periodEnd);
  });
});
