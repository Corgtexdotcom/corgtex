import { beforeEach, describe, expect, it, vi } from "vitest";
import type { AppActor } from "@corgtex/shared";

const { listGoalsMock, findManyTensionsMock, findManyActionsMock } = vi.hoisted(() => ({
  listGoalsMock: vi.fn(),
  findManyTensionsMock: vi.fn(),
  findManyActionsMock: vi.fn(),
}));

vi.mock("@corgtex/shared", () => ({
  prisma: {
    tension: { findMany: findManyTensionsMock },
    action: { findMany: findManyActionsMock },
  },
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

describe("agent query tools version requirements", () => {
  it("query tools include version and instruction in description", async () => {
    const { queryTensionsTool, queryActionsTool } = await import("./workspace");
    expect(queryTensionsTool.function.description).toContain("version");
    expect(queryTensionsTool.function.description).toContain("update_tension");
    expect(queryActionsTool.function.description).toContain("version");
    expect(queryActionsTool.function.description).toContain("update_action");
  });

  it("queryTensions and queryActions return versions from database", async () => {
    const { queryTensions, queryActions } = await import("./workspace");

    findManyTensionsMock.mockResolvedValue([
      { id: "t-1", title: "Tension 1", status: "OPEN", priority: "HIGH", author: { displayName: "Author" }, version: 4 }
    ]);

    const tensions = await queryTensions("ws-1");
    expect(tensions[0]).toEqual(expect.objectContaining({ id: "t-1", version: 4 }));

    findManyActionsMock.mockResolvedValue([
      { id: "a-1", title: "Action 1", status: "OPEN", author: { displayName: "Author" }, version: 5 }
    ]);

    const actions = await queryActions("ws-1");
    expect(actions[0]).toEqual(expect.objectContaining({ id: "a-1", version: 5 }));
  });
});
