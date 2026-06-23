import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@corgtex/shared", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@corgtex/shared")>();
  return {
    ...actual,
    prisma: {
      member: { findMany: vi.fn(), findUnique: vi.fn() },
      proposal: { count: vi.fn(), findMany: vi.fn() },
      adviceProcess: { count: vi.fn() },
      adviceRequest: { count: vi.fn() },
      deliberationEntry: { count: vi.fn() },
      tension: { count: vi.fn() },
      action: { count: vi.fn() },
      meeting: { count: vi.fn() },
      memberExpertise: { aggregate: vi.fn() },
      impactFootprint: { upsert: vi.fn() },
    },
  };
});

import { prisma } from "@corgtex/shared";
import { calculateImpactFootprint, refreshImpactFootprints } from "./impact-footprint";

const periodStart = new Date("2026-01-01T00:00:00.000Z");
const periodEnd = new Date("2026-01-31T23:59:59.000Z");

function mockCalculateQueries() {
  (prisma.member.findUnique as ReturnType<typeof vi.fn>).mockResolvedValue({ userId: "user-1" });
  (prisma.proposal.count as ReturnType<typeof vi.fn>).mockResolvedValue(3);
  (prisma.adviceProcess.count as ReturnType<typeof vi.fn>).mockResolvedValue(1);
  (prisma.adviceRequest.count as ReturnType<typeof vi.fn>).mockResolvedValue(8);
  (prisma.deliberationEntry.count as ReturnType<typeof vi.fn>).mockImplementation((args: { where: { entryType?: string } }) => {
    if (args.where.entryType === "REACTION") return Promise.resolve(4);
    if (args.where.entryType === "OBJECTION") return Promise.resolve(1);
    return Promise.resolve(2); // adviceGiven (no type filter)
  });
  (prisma.tension.count as ReturnType<typeof vi.fn>).mockResolvedValue(5);
  (prisma.action.count as ReturnType<typeof vi.fn>).mockResolvedValue(6);
  (prisma.meeting.count as ReturnType<typeof vi.fn>).mockResolvedValue(7);
  (prisma.memberExpertise.aggregate as ReturnType<typeof vi.fn>).mockResolvedValue({ _sum: { endorsedCount: 9 } });
  (prisma.proposal.findMany as ReturnType<typeof vi.fn>).mockResolvedValue([{ id: "proposal-1" }]);
}

describe("impact-footprint", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockCalculateQueries();
    (prisma.impactFootprint.upsert as ReturnType<typeof vi.fn>).mockImplementation(
      (args: { create: { memberId: string } }) => Promise.resolve({ id: `fp-${args.create.memberId}`, ...args.create }),
    );
  });

  describe("calculateImpactFootprint", () => {
    it("aggregates the member's metrics into the footprint shape", async () => {
      const data = await calculateImpactFootprint("ws-1", "member-1", periodStart, periodEnd);

      expect(data).toEqual({
        proposalsAuthored: 3,
        proposalsExecuted: 1,
        adviceGiven: 2,
        adviceSoughtCount: 8,
        tensionsResolved: 5,
        actionsCompleted: 6,
        endorsementsReceived: 4,
        concernsRaised: 1,
        meetingsParticipated: 7,
        detailJson: { expertiseEndorsementsCount: 9 },
      });
    });

    it("defaults the expertise endorsement detail to 0 when the aggregate is null", async () => {
      (prisma.memberExpertise.aggregate as ReturnType<typeof vi.fn>).mockResolvedValue({ _sum: { endorsedCount: null } });

      const data = await calculateImpactFootprint("ws-1", "member-1", periodStart, periodEnd);

      expect(data.detailJson).toEqual({ expertiseEndorsementsCount: 0 });
    });
  });

  describe("refreshImpactFootprints", () => {
    it("upserts one footprint per active member and returns them in member order", async () => {
      (prisma.member.findMany as ReturnType<typeof vi.fn>).mockResolvedValue([
        { id: "member-a" },
        { id: "member-b" },
        { id: "member-c" },
      ]);

      const result = await refreshImpactFootprints("ws-1", periodStart, periodEnd);

      expect(prisma.impactFootprint.upsert).toHaveBeenCalledTimes(3);
      expect(result.map((f) => (f as { memberId: string }).memberId)).toEqual(["member-a", "member-b", "member-c"]);

      const upsertedMemberIds = (prisma.impactFootprint.upsert as ReturnType<typeof vi.fn>).mock.calls.map(
        (call) => call[0].where.workspaceId_memberId_periodStart_periodEnd.memberId,
      );
      expect(new Set(upsertedMemberIds)).toEqual(new Set(["member-a", "member-b", "member-c"]));
    });

    it("returns an empty list when there are no active members", async () => {
      (prisma.member.findMany as ReturnType<typeof vi.fn>).mockResolvedValue([]);

      const result = await refreshImpactFootprints("ws-1", periodStart, periodEnd);

      expect(result).toEqual([]);
      expect(prisma.impactFootprint.upsert).not.toHaveBeenCalled();
    });
  });
});
