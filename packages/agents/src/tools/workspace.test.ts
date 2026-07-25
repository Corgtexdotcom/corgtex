import { beforeEach, describe, expect, it, vi } from "vitest";
import type { AppActor } from "@corgtex/shared";

const { listGoalsMock } = vi.hoisted(() => ({
  listGoalsMock: vi.fn(),
}));

vi.mock("@corgtex/shared", () => ({
  prisma: {},
}));

vi.mock("@corgtex/domain", () => ({
  listGoals: listGoalsMock,
}));

const actor: AppActor = {
  kind: "user",
  user: {
    id: "user-1",
    email: "user@example.com",
    displayName: "User",
    globalRole: "USER",
  },
};

describe("workspace agent tools", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    listGoalsMock.mockResolvedValue([
      {
        id: "goal-1",
        title: "Launch goal",
        descriptionMd: "Launch safely.",
        cadence: "QUARTERLY",
        level: "COMPANY",
        status: "ACTIVE",
        progressPercent: 25,
        targetDate: null,
        startDate: null,
        circle: { name: "General" },
        ownerMember: { user: { displayName: "Owner" } },
        keyResults: [
          {
            title: "Ship the rollout",
            currentValue: 1,
            targetValue: 4,
            unit: "milestones",
            progressPercent: 25,
          },
        ],
      },
    ]);
  });

  it("queries goals through the actor-aware domain list", async () => {
    const { queryGoals } = await import("./workspace");

    const result = await queryGoals(actor, "ws-1", "QUARTERLY", "COMPANY", "ACTIVE");

    expect(listGoalsMock).toHaveBeenCalledWith(actor, {
      workspaceId: "ws-1",
      cadence: "QUARTERLY",
      level: "COMPANY",
      status: "ACTIVE",
      take: 20,
    });
    expect(result).toEqual([
      expect.objectContaining({
        id: "goal-1",
        title: "Launch goal",
        owner: "Owner",
        keyResults: [
          expect.objectContaining({
            title: "Ship the rollout",
            progressPercent: 25,
          }),
        ],
      }),
    ]);
  });
});
