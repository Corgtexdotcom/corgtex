import { describe, expect, it, vi } from "vitest";
import { suggestMaturityUpgrade } from "./circles";
import { prisma } from "@corgtex/shared";

vi.mock("@corgtex/shared", () => ({
  prisma: {
    circle: {
      findUnique: vi.fn(),
    },
  },
}));

describe("suggestMaturityUpgrade", () => {
  const workspaceId = "ws-1";
  const circleId = "circle-1";

  it("suggestMaturityUpgrade returns ready after 5 weeks of consistent tension processing (GETTING_STARTED)", async () => {
    vi.mocked(prisma.circle.findUnique).mockResolvedValueOnce({
      id: circleId,
      workspaceId,
      maturityStage: "GETTING_STARTED",
      tensions: Array(5).fill({}),
    } as any);

    const result = await suggestMaturityUpgrade(workspaceId, circleId);

    expect(result.ready).toBe(true);
    expect(result.reason).toContain("Ready to practice proposals");
  });

  it("suggestMaturityUpgrade returns not ready for new circle", async () => {
    vi.mocked(prisma.circle.findUnique).mockResolvedValueOnce({
      id: circleId,
      workspaceId,
      maturityStage: "GETTING_STARTED",
      tensions: Array(2).fill({}),
    } as any);

    const result = await suggestMaturityUpgrade(workspaceId, circleId);

    expect(result.ready).toBe(false);
  });

  it("suggestMaturityUpgrade returns ready for FULL_O2 after high volume tension processing", async () => {
    vi.mocked(prisma.circle.findUnique).mockResolvedValueOnce({
      id: circleId,
      workspaceId,
      maturityStage: "BUILDING_MUSCLE",
      tensions: Array(20).fill({}),
    } as any);

    const result = await suggestMaturityUpgrade(workspaceId, circleId);

    expect(result.ready).toBe(true);
    expect(result.reason).toContain("Ready for full O2");
  });

  it("suggestMaturityUpgrade returns false if already FULL_O2", async () => {
    vi.mocked(prisma.circle.findUnique).mockResolvedValueOnce({
      id: circleId,
      workspaceId,
      maturityStage: "FULL_O2",
      tensions: Array(50).fill({}),
    } as any);

    const result = await suggestMaturityUpgrade(workspaceId, circleId);

    expect(result.ready).toBe(false);
  });
});
