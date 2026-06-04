import { beforeEach, describe, expect, it, vi } from "vitest";

const { prismaMock } = vi.hoisted(() => ({
  prismaMock: {
    procurementTrial: {
      findUnique: vi.fn(),
    },
    member: {
      count: vi.fn(),
    },
  },
}));

vi.mock("@corgtex/shared", () => ({
  prisma: prismaMock,
  checkRateLimit: vi.fn(),
}));

describe("trial entitlements", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    prismaMock.procurementTrial.findUnique.mockResolvedValue({
      id: "trial-1",
      workspaceId: "workspace-1",
      agentCredentialId: null,
      status: "ACTIVE",
      trialExpiresAt: new Date(Date.now() + 60_000),
      memberLimit: 5,
      storageLimitMb: 100,
      mcpDailyCallLimit: 100,
    });
    prismaMock.member.count.mockResolvedValue(4);
  });

  it("excludes internal support members from trial member capacity", async () => {
    const { assertTrialMemberCapacity } = await import("./trial-entitlements");

    await expect(assertTrialMemberCapacity("workspace-1")).resolves.toBeUndefined();

    expect(prismaMock.member.count).toHaveBeenCalledWith({
      where: {
        workspaceId: "workspace-1",
        isActive: true,
        NOT: {
          user: {
            email: {
              startsWith: "support+",
              endsWith: "@corgtex.local",
            },
          },
        },
      },
    });
  });
});
