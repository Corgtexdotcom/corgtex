import { describe, expect, it, vi } from "vitest";
import { getOverwhelmSignals } from "./check-ins";
import { prisma } from "@corgtex/shared";

vi.mock("@corgtex/shared", () => ({
  prisma: {
    checkIn: {
      findMany: vi.fn(),
    },
  },
  AppActor: {},
}));

vi.mock("./auth", () => ({
  requireWorkspaceMembership: vi.fn().mockResolvedValue({ id: "member-1" }),
}));

describe("getOverwhelmSignals", () => {
  const workspaceId = "ws-1";
  const memberId = "member-1";

  it("getOverwhelmSignals flags member with 3+ negative responses in 7 days", async () => {
    vi.mocked(prisma.checkIn.findMany).mockResolvedValueOnce([
      { sentiment: "NEGATIVE" } as any,
      { sentiment: "NEGATIVE" } as any,
      { sentiment: "NEGATIVE" } as any,
    ]);

    const result = await getOverwhelmSignals(workspaceId, memberId);

    expect(result.isOverwhelmed).toBe(true);
    expect(result.recentNegativeCount).toBe(3);
  });

  it("getOverwhelmSignals flags member with 1 OVERWHELMED response", async () => {
    vi.mocked(prisma.checkIn.findMany).mockResolvedValueOnce([
      { sentiment: "OVERWHELMED" } as any,
    ]);

    const result = await getOverwhelmSignals(workspaceId, memberId);

    expect(result.isOverwhelmed).toBe(true);
    expect(result.recentNegativeCount).toBe(1);
  });

  it("getOverwhelmSignals returns clean for member with positive history", async () => {
    vi.mocked(prisma.checkIn.findMany).mockResolvedValueOnce([]);

    const result = await getOverwhelmSignals(workspaceId, memberId);

    expect(result.isOverwhelmed).toBe(false);
    expect(result.recentNegativeCount).toBe(0);
  });
});
